import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-metagraph-'));
process.env.KAVSAK_DATA_DIR = tmp;
// resmi giriş yapılandırması uzaktan okunmasın; Instagram istemcisi ortamdan (yer tutucu)
process.env.MIVELO_OAUTH_REMOTE = '0';
process.env.MIVELO_OAUTH_INSTAGRAM_ID = 'test-instagram-app';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { sessionDir } = await import('../src/config.js');
const { MetaGraphConnector, MetaError, WINDOW_TEXT, igNeedsRefresh, metaError, parseMetaTime, sendErrorText, splitText } = await import('../src/connectors/meta-graph.js');

type Req = { url: URL; method: string; auth?: string; body?: Record<string, unknown> };
type Handler = (r: Req) => { status?: number; body: unknown } | undefined;

const realFetch = globalThis.fetch;
after(() => (globalThis.fetch = realFetch));
let calls: Req[] = [];
let handler: Handler = () => undefined;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const h = (init?.headers ?? {}) as Record<string, string>;
  const r: Req = { url, method: init?.method ?? 'GET', auth: h.authorization, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
  calls.push(r);
  const out = handler(r) ?? { status: 404, body: { error: { message: `bilinmeyen ${url.pathname}`, code: 803 } } };
  return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const store = new Store(path.join(tmp, 'm.db'));
type Conn = InstanceType<typeof MetaGraphConnector>;
const priv = (c: Conn) => c as unknown as { gapMs: number; firstSync?: Promise<void>; poll: () => Promise<void>; dead: boolean; timer?: unknown };

function account(id: string, platform: 'instagram' | 'messenger') {
  const a = { id, platform, label: platform, status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(a);
  return a;
}
function writeToken(id: string, tok: unknown) {
  fs.writeFileSync(path.join(sessionDir(id), 'token'), JSON.stringify(tok), { mode: 0o600 });
}
async function startConn(id: string, platform: 'instagram' | 'messenger', kind: 'instagram' | 'facebook'): Promise<Conn> {
  const c = new MetaGraphConnector(account(id, platform), store, kind);
  priv(c).gapMs = 0;
  await c.start();
  await priv(c).firstSync;
  return c;
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
const NOW = Date.now();
const T1 = NOW - 3 * 60_000;
const T2 = NOW - 2 * 60_000;
const T3 = NOW - 60_000;

/** Instagram profesyonel hesabı: /me, tek konuşma, iç içe mesaj alanları, profil */
function igRoutes(extra: Handler = () => undefined): Handler {
  return (r) => {
    const x = extra(r);
    if (x) return x;
    const p = r.url.pathname;
    if (r.url.hostname !== 'graph.instagram.com') return undefined;
    if (p === '/v23.0/me') return { body: { id: 'APP1', user_id: '17890001', username: 'ornek_magaza', name: 'Örnek Mağaza' } };
    if (p === '/v23.0/me/conversations') {
      assert.equal(r.url.searchParams.get('platform'), 'instagram');
      return {
        body: {
          data: [{ id: 'C1', updated_time: iso(T3), participants: { data: [{ username: 'ornek_magaza', id: '17890001' }, { username: 'ayse_ornek', id: 'IGSID1' }] } }],
        },
      };
    }
    if (p === '/v23.0/C1') {
      assert.match(r.url.searchParams.get('fields') ?? '', /^messages\.limit\(25\)\{id,created_time,from,to,message,attachments/);
      return {
        body: {
          id: 'C1',
          messages: {
            data: [
              { id: 'm3', created_time: iso(T3), from: { username: 'ornek_magaza', id: '17890001' }, to: { data: [{ username: 'ayse_ornek', id: 'IGSID1' }] }, message: 'Merhaba, nasıl yardımcı olabilirim?' },
              {
                id: 'm2',
                created_time: iso(T2),
                from: { username: 'ayse_ornek', id: 'IGSID1' },
                to: { data: [{ username: 'ornek_magaza', id: '17890001' }] },
                attachments: { data: [{ image_data: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', preview_url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&p=1' } }] },
              },
              { id: 'm1', created_time: iso(T1), from: { username: 'ayse_ornek', id: 'IGSID1' }, to: { data: [{ username: 'ornek_magaza', id: '17890001' }] }, message: 'Selam 👋 ürün var mı?' },
            ],
            paging: { cursors: { after: 'CUR1' }, next: 'https://graph.instagram.com/v23.0/C1/messages?after=CUR1' },
          },
        },
      };
    }
    if (p === '/v23.0/IGSID1') return { body: { name: 'Ayşe Örnek', username: 'ayse_ornek', profile_pic: 'https://scontent-ist1-1.cdninstagram.com/v/p.jpg' } };
    return undefined;
  };
}

test('Instagram: konuşma/mesaj eşleme, benden, ek vekili, profil ve gönderim', async () => {
  calls = [];
  writeToken('instagram:ig1', { official: 'instagram', accessToken: 'IG-TEST-TOKEN', expiresAt: NOW + 50 * 86_400_000, userId: '17890001', username: 'ornek_magaza', graphVersion: 'v23.0' });
  handler = igRoutes();
  const c = await startConn('instagram:ig1', 'instagram', 'instagram');
  assert.equal(c.account.status, 'connected');
  assert.equal(c.account.label, '@ornek_magaza');
  // belirteç başlıkta, adreste değil
  assert.ok(calls.every((r) => r.auth === 'Bearer IG-TEST-TOKEN' && !r.url.search.includes('access_token')));

  const chat = store.getChat('instagram:ig1/C1')!;
  assert.equal(chat.name, 'Ayşe Örnek');
  assert.equal(chat.handle, '@ayse_ornek');
  assert.equal(chat.kind, 'direct');
  assert.equal(chat.meta?.recipientId, 'IGSID1');
  assert.equal(chat.unread, 0, 'ilk eşitleme okunmamış saymaz');
  assert.ok(chat.avatarUrl?.startsWith('/api/media/instagram%3Aig1?u='));
  const msgs = store.listMessages('instagram:ig1/C1', 10);
  assert.deepEqual(msgs.map((m) => m.remoteId), ['m1', 'm2', 'm3']);
  assert.deepEqual(msgs.map((m) => m.fromMe), [false, false, true]);
  assert.equal(msgs[0]!.text, 'Selam 👋 ürün var mı?');
  assert.equal(msgs[0]!.senderId, 'IGSID1');
  assert.equal(msgs[0]!.ts, Math.floor(T1 / 1000) * 1000);
  const att = msgs[1]!.attachments![0]!;
  assert.equal(att.kind, 'image');
  assert.equal(decodeURIComponent(att.link!.split('?u=')[1]!), 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1');
  assert.equal(chat.lastPreview, 'Merhaba, nasıl yardımcı olabilirim?');

  // gönderim: me/messages, alıcı IGSID, hemen "benden" yazılır
  handler = igRoutes((r) => {
    if (r.method === 'POST' && r.url.pathname === '/v23.0/me/messages') {
      assert.deepEqual(r.body, { recipient: { id: 'IGSID1' }, message: { text: 'Evet, stokta var' } });
      return { body: { recipient_id: 'IGSID1', message_id: 'm4' } };
    }
    return undefined;
  });
  const sent = await c.sendText('C1', 'Evet, stokta var');
  assert.equal(sent.remoteId, 'm4');
  const mine = store.getMessage('instagram:ig1/C1#m4')!;
  assert.equal(mine.fromMe, true);
  assert.equal(mine.text, 'Evet, stokta var');

  // 24 saat penceresi: Meta 10 / 2534022 → kullanıcı dili
  handler = igRoutes((r) =>
    r.method === 'POST' && r.url.pathname === '/v23.0/me/messages'
      ? { status: 400, body: { error: { message: 'This message is sent outside of allowed window.', type: 'IGApiException', code: 10, error_subcode: 2534022 } } }
      : undefined,
  );
  await assert.rejects(c.sendText('C1', 'geç kalan yanıt'), (e: Error) => e.message === WINDOW_TEXT);
  assert.equal(WINDOW_TEXT, 'Meta kuralı: kişi son 24 saatte yazmadıysa yanıt gönderilemez');

  // sonraki tur: yalnız değişen konuşma; yeni gelen mesaj okunmamış olur
  calls = [];
  const T4 = Date.now();
  handler = (r) => {
    if (r.url.pathname === '/v23.0/me/conversations') return { body: { data: [{ id: 'C1', updated_time: iso(T4), participants: { data: [{ username: 'ayse_ornek', id: 'IGSID1' }] } }] } };
    if (r.url.pathname === '/v23.0/C1') {
      assert.match(r.url.searchParams.get('fields') ?? '', /^messages\.limit\(10\)/);
      return { body: { id: 'C1', messages: { data: [{ id: 'm5', created_time: iso(T4), from: { username: 'ayse_ornek', id: 'IGSID1' }, message: 'Teşekkürler' }] } } };
    }
    return undefined;
  };
  await priv(c).poll();
  assert.equal(store.getChat('instagram:ig1/C1')!.unread, 1);
  // değişmeyen konuşma yeniden çekilmez
  calls = [];
  handler = (r) => (r.url.pathname === '/v23.0/me/conversations' ? { body: { data: [{ id: 'C1', updated_time: iso(T4) }] } } : undefined);
  await priv(c).poll();
  assert.deepEqual(calls.map((r) => r.url.pathname), ['/v23.0/me/conversations']);
  await c.stop();
});

test('Facebook: çoklu Sayfa → ayrı sohbetler, remoteId sayfa:konuşma, doğru sayfa belirteciyle gönderim', async () => {
  calls = [];
  writeToken('messenger:fb1', {
    official: 'facebook',
    userToken: 'FB-USER',
    pages: [
      { id: 'P1', name: 'Örnek Kahve', token: 'PT-1' },
      { id: 'P2', name: 'Örnek Kitap', token: 'PT-2' },
    ],
    graphVersion: 'v23.0',
  });
  const pageOf = (auth?: string) => (auth === 'Bearer PT-1' ? 'P1' : auth === 'Bearer PT-2' ? 'P2' : '');
  const routes: Handler = (r) => {
    const p = r.url.pathname;
    if (r.url.hostname !== 'graph.facebook.com') return undefined;
    if (p === '/v23.0/me') return pageOf(r.auth) === 'P1' ? { body: { id: 'P1', name: 'Örnek Kahve' } } : { body: { id: 'P2', name: 'Örnek Kitap' } };
    if (p === '/v23.0/P1/conversations' || p === '/v23.0/P2/conversations') {
      assert.equal(r.url.searchParams.get('platform'), 'messenger');
      assert.equal(`/v23.0/${pageOf(r.auth)}/conversations`, p, 'her sayfa kendi belirteciyle');
      return p.includes('P1')
        ? { body: { data: [{ id: 't_1', updated_time: iso(T2), unread_count: 2, participants: { data: [{ name: 'Ali Örnek', email: 'PSID1@facebook.com', id: 'PSID1' }, { name: 'Örnek Kahve', id: 'P1' }] } }] } }
        : { body: { data: [{ id: 't_2', updated_time: iso(T3), unread_count: 0, participants: { data: [{ name: 'Zeynep Örnek', id: 'PSID2' }, { name: 'Örnek Kitap', id: 'P2' }] } }] } };
    }
    if (p === '/v23.0/t_1/messages') return { body: { data: [{ id: 'm_a', created_time: iso(T2), from: { name: 'Ali Örnek', id: 'PSID1' }, to: { data: [{ name: 'Örnek Kahve', id: 'P1' }] }, message: 'Siparişim nerede?' }] } };
    if (p === '/v23.0/t_2/messages')
      return {
        body: {
          data: [
            { id: 'm_c', created_time: iso(T3), from: { name: 'Örnek Kitap', id: 'P2' }, to: { data: [{ name: 'Zeynep Örnek', id: 'PSID2' }] }, message: 'Kitabınız hazır' },
            { id: 'm_b', created_time: iso(T2), from: { name: 'Zeynep Örnek', id: 'PSID2' }, message: '', attachments: { data: [{ mime_type: 'audio/mpeg', file_url: 'https://cdn.fbsbx.com/v/ses.mp3' }] } },
          ],
        },
      };
    if (p === '/v23.0/PSID1') return { body: { name: 'Ali Örnek', profile_pic: 'https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=PSID1' } };
    if (p === '/v23.0/PSID2') return { status: 400, body: { error: { message: 'User consent is required', code: 230 } } };
    return undefined;
  };
  handler = routes;
  const c = await startConn('messenger:fb1', 'messenger', 'facebook');
  assert.equal(c.account.status, 'connected');
  assert.equal(c.account.label, 'Örnek Kahve, Örnek Kitap');

  const a = store.getChat('messenger:fb1/P1:t_1')!;
  const b = store.getChat('messenger:fb1/P2:t_2')!;
  assert.equal(a.name, 'Ali Örnek');
  assert.equal(a.handle, 'Örnek Kahve');
  assert.equal(a.unread, 2, 'Messenger okunmamışı sayfadan');
  assert.equal(a.meta?.pageId, 'P1');
  assert.ok(a.avatarUrl?.startsWith('/api/media/'));
  assert.equal(b.handle, 'Örnek Kitap');
  assert.equal(b.avatarUrl, undefined, 'rıza yoksa fotoğrafsız');
  const bm = store.listMessages('messenger:fb1/P2:t_2', 10);
  assert.deepEqual(bm.map((m) => [m.remoteId, m.fromMe]), [['m_b', false], ['m_c', true]]);
  assert.equal(bm[0]!.attachments![0]!.kind, 'audio');

  handler = (r) => {
    if (r.method === 'POST' && r.url.pathname === '/v23.0/P2/messages') {
      assert.equal(r.auth, 'Bearer PT-2');
      assert.deepEqual(r.body, { recipient: { id: 'PSID2' }, messaging_type: 'RESPONSE', message: { text: 'Yarın kargoda' } });
      return { body: { recipient_id: 'PSID2', message_id: 'm_d' } };
    }
    return routes(r);
  };
  assert.equal((await c.sendText('P2:t_2', 'Yarın kargoda')).remoteId, 'm_d');
  assert.equal(store.getMessage('messenger:fb1/P2:t_2#m_d')!.fromMe, true);

  // Messenger'ın eski pencere alt kodu da aynı metin
  handler = (r) =>
    r.method === 'POST' ? { status: 400, body: { error: { message: '(#10) This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } } } : routes(r);
  await assert.rejects(c.sendText('P1:t_1', 'geç'), (e: Error) => e.message === WINDOW_TEXT);

  // yoklamada 190 → oturum sona erdi, yoklama durur
  handler = (r) => (r.url.pathname.endsWith('/conversations') ? { status: 400, body: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } } } : routes(r));
  await priv(c).poll();
  assert.equal(c.account.status, 'error');
  assert.equal(c.account.detail, 'Facebook oturumu sona erdi — yeniden giriş yap');
  assert.equal(priv(c).dead, true);
  calls = [];
  await priv(c).poll();
  assert.equal(calls.length, 0, 'durdu: istek yok');
  await assert.rejects(c.sendText('P1:t_1', 'x'), /oturumu sona erdi/);
  await c.stop();
  assert.equal(c.account.status, 'error', 'durdurma uyarıyı silmez');
});

test('Instagram: açılışta 190 → "Instagram oturumu sona erdi"', async () => {
  writeToken('instagram:ig2', { official: 'instagram', accessToken: 'IG-OLD', expiresAt: NOW + 30 * 86_400_000, userId: '1', username: 'x', graphVersion: 'v23.0' });
  handler = () => ({ status: 400, body: { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } } });
  const c = await startConn('instagram:ig2', 'instagram', 'instagram');
  assert.equal(c.account.status, 'error');
  assert.equal(c.account.detail, 'Instagram oturumu sona erdi — yeniden giriş yap');
  await c.stop();
});

test('Instagram: belirteç 10 günden az kaldıysa yenilenir ve dosyaya 0600 yazılır', async () => {
  const d = 86_400_000;
  assert.equal(igNeedsRefresh(undefined, NOW), false);
  assert.equal(igNeedsRefresh(NOW + 5 * d, NOW), true);
  assert.equal(igNeedsRefresh(NOW + 20 * d, NOW), false);
  assert.equal(igNeedsRefresh(NOW - 1000, NOW), false, 'süresi dolan yenilenemez');

  writeToken('instagram:ig3', { official: 'instagram', accessToken: 'IG-SOON', expiresAt: NOW + 3 * d, userId: '17890001', username: 'ornek_magaza', graphVersion: 'v23.0' });
  let refreshed = 0;
  handler = igRoutes((r) => {
    if (r.url.pathname === '/refresh_access_token') {
      refreshed++;
      assert.equal(r.url.searchParams.get('grant_type'), 'ig_refresh_token');
      assert.equal(r.url.searchParams.get('access_token'), 'IG-SOON');
      return { body: { access_token: 'IG-NEW', token_type: 'bearer', expires_in: 5_184_000 } };
    }
    if (r.url.hostname === 'graph.instagram.com') assert.equal(r.auth, 'Bearer IG-NEW', 'yenilenen belirteç kullanılır');
    return undefined;
  });
  const c = await startConn('instagram:ig3', 'instagram', 'instagram');
  assert.equal(refreshed, 1);
  assert.equal(c.account.status, 'connected');
  const file = path.join(sessionDir('instagram:ig3'), 'token');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { accessToken: string; expiresAt: number; userId: string };
  assert.equal(saved.accessToken, 'IG-NEW');
  assert.equal(saved.userId, '17890001');
  assert.ok(saved.expiresAt > NOW + 55 * d);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await c.stop();
});

test('Instagram: tanınmayan alanda daraltılır; yalnız kimlik dönerse mesaj ayrıntısı tek tek', async () => {
  writeToken('instagram:ig4', { official: 'instagram', accessToken: 'IG-4', expiresAt: NOW + 40 * 86_400_000, userId: '17890001', username: 'ornek_magaza', graphVersion: 'v23.0' });
  const bad = (f: string) => ({ status: 400, body: { error: { message: `(#100) Tried accessing nonexisting field (${f}) on node type (X)`, type: 'IGApiException', code: 100 } } });
  const asked: string[] = [];
  handler = (r) => {
    const p = r.url.pathname;
    const fields = r.url.searchParams.get('fields') ?? '';
    if (p === '/v23.0/me') return { body: { user_id: '17890001', username: 'ornek_magaza' } };
    if (p === '/v23.0/me/conversations') return fields.includes('participants') ? bad('participants') : { body: { data: [{ id: 'C9', updated_time: iso(T3) }] } };
    if (p === '/v23.0/C9') {
      asked.push(fields);
      return fields.includes('{') ? bad('from') : { body: { id: 'C9', messages: { data: [{ id: 'x2', created_time: iso(T3) }, { id: 'x1', created_time: iso(T2) }] } } };
    }
    if (p === '/v23.0/x1' || p === '/v23.0/x2') {
      if (fields.includes('shares')) return bad('shares');
      return p.endsWith('x1')
        ? { body: { id: 'x1', created_time: iso(T2), from: { username: 'mehmet_ornek', id: 'IGSID9' }, to: { data: [{ username: 'ornek_magaza', id: '17890001' }] }, message: 'Fiyat nedir?' } }
        : { body: { id: 'x2', created_time: iso(T3), from: { username: 'ornek_magaza', id: '17890001' }, to: { data: [{ username: 'mehmet_ornek', id: 'IGSID9' }] }, message: '250 TL' } };
    }
    if (p === '/v23.0/IGSID9') return { body: { username: 'mehmet_ornek' } };
    return undefined;
  };
  const c = await startConn('instagram:ig4', 'instagram', 'instagram');
  assert.equal(c.account.status, 'connected');
  assert.equal(asked.length, 4, 'üç alan düzeyi + yalnız kimlik');
  const chat = store.getChat('instagram:ig4/C9')!;
  assert.equal(chat.name, 'mehmet_ornek');
  assert.equal(chat.handle, '@mehmet_ornek');
  assert.equal(chat.meta?.recipientId, 'IGSID9');
  assert.deepEqual(store.listMessages('instagram:ig4/C9', 10).map((m) => [m.remoteId, m.fromMe, m.text]), [['x1', false, 'Fiyat nedir?'], ['x2', true, '250 TL']]);
  await c.stop();
});

test('yardımcılar: hata sınıfları, zaman, metin bölme', () => {
  const rate = metaError({ error: { code: 613, error_subcode: 2534040, message: 'Calls to this api have exceeded the rate limit.' } }, 400);
  assert.equal(rate.rateLimited, true);
  assert.equal(rate.retryAfter, 300);
  assert.equal(metaError({}, 429).rateLimited, true);
  assert.equal(new MetaError('x', 190).expired, true);
  assert.equal(sendErrorText(new MetaError('x', 551, 1545041), 'instagram'), 'Bu kişiye şu an mesaj gönderilemiyor (Meta: alıcıya ulaşılamıyor)');
  assert.equal(sendErrorText(new MetaError('x', 190), 'instagram'), 'Instagram oturumu sona erdi — yeniden giriş yap');
  assert.equal(new MetaError('(#100) Tried accessing nonexisting field (sticker)', 100).badField, true);
  assert.equal(new MetaError('(#10) Application does not have permission', 10).permission, true);
  assert.equal(new MetaError('outside', 10, 2534022).permission, false);
  assert.equal(parseMetaTime('2026-10-08T10:00:00+0000'), Date.UTC(2026, 9, 8, 10));
  assert.equal(parseMetaTime(1_700_000_000), 1_700_000_000_000);
  const parts = splitText('a'.repeat(900) + ' ' + 'b'.repeat(500), 1000);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.deepEqual(splitText('kısa', 1000), ['kısa']);
});
