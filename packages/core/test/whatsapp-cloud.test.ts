import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * WhatsApp Business (Cloud API) bağlayıcısı: sahte Graph + sahte aktarıcı (fetch yaması). Gerçek Meta yok.
 * Giriş akışı (Embedded Signup → belirteç → hesap yapılandırması) da sahte aracıyla sınanır.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-wacloud-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_OAUTH_REMOTE = '0';
process.env.MIVELO_OAUTH_CONFIG = JSON.stringify({ whatsapp: { clientId: '123456', configId: '9876543210', graphVersion: 'v23.0' } });
process.env.MIVELO_OAUTH_BROKER = 'https://broker.test/oauth.php';
process.env.MIVELO_WA_RELAY = 'https://relay.test/wa-webhook.php';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { sessionDir } = await import('../src/config.js');
const { WhatsAppCloudConnector, WA_WINDOW_TEXT, WaCloudError, formatWaId, splitWaText, waErrorText, waNeedsRefresh, waTime } = await import('../src/connectors/whatsapp-cloud.js');
const { resolveOAuth } = await import('../src/oauth/callback.js');
const flows = await import('../src/oauth/flows.js');
const { bus } = await import('../src/bus.js');

type Req = { url: URL; method: string; auth?: string; key?: string; body?: Record<string, unknown>; form?: FormData };
type Handler = (r: Req) => { status?: number; body: unknown } | undefined;
const realFetch = globalThis.fetch;
after(() => (globalThis.fetch = realFetch));
let calls: Req[] = [];
let handler: Handler = () => undefined;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const h = (init?.headers ?? {}) as Record<string, string>;
  const r: Req = {
    url,
    method: init?.method ?? 'GET',
    auth: h.authorization,
    key: h['x-mivelo-key'],
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    form: init?.body instanceof FormData ? init.body : undefined,
  };
  calls.push(r);
  const out = handler(r) ?? { status: 404, body: { error: { message: `bilinmeyen ${url.pathname}`, code: 803 } } };
  if (out.body instanceof Buffer) return new Response(out.body, { status: out.status ?? 200, headers: { 'content-type': 'image/jpeg' } });
  return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const store = new Store(path.join(tmp, 'w.db'));
type Conn = InstanceType<typeof WhatsAppCloudConnector>;
const priv = (c: Conn) => c as unknown as { firstSync?: Promise<void>; poll: () => Promise<void>; dead: boolean; lastSeq: number };
const PN = '111222333444';
const CUST = '905000000099';
const token = { official: 'whatsapp', accessToken: 'EAAB-test-token', phoneNumberId: PN, wabaId: '555666', displayPhone: '+90 500 000 00 01', pullKey: 'a'.repeat(48), graphVersion: 'v23.0' };

function account(id: string) {
  const a = { id, platform: 'whatsapp' as const, label: 'WhatsApp', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(a);
  return a;
}
function writeToken(id: string, tok: unknown) {
  fs.writeFileSync(path.join(sessionDir(id), 'token'), JSON.stringify(tok), { mode: 0o600 });
}

/** Aktarıcı kuyruğu (sahte): pull → after'dan sonrakiler */
let queue: Array<{ seq: number; t: number; field: string; value: unknown }> = [];
let sent: Array<Record<string, unknown>> = [];
function routes(extra: Handler = () => undefined): Handler {
  return (r) => {
    const e = extra(r);
    if (e) return e;
    const p = r.url.pathname;
    if (r.url.hostname === 'relay.test') {
      const action = r.url.searchParams.get('action');
      if (action === 'pull') {
        if (r.key !== token.pullKey) return { status: 401, body: { error: 'unauthorized' } };
        const after = Number(r.url.searchParams.get('after') ?? 0);
        return { body: { events: queue.filter((q) => q.seq > after).slice(0, 100), last: queue.at(-1)?.seq ?? 0 } };
      }
      if (action === 'register') return { body: { ok: true, pullKey: 'b'.repeat(48), last: 0 } };
      if (action === 'unregister') return { body: { ok: true } };
    }
    if (r.url.hostname === 'graph.facebook.com') {
      if (!r.auth?.startsWith('Bearer ')) return { status: 401, body: { error: { message: 'no token', code: 190 } } };
      if (p === `/v23.0/${PN}` && r.method === 'GET') return { body: { id: PN, display_phone_number: '+90 500 000 00 01', verified_name: 'Örnek Mağaza' } };
      if (p === '/v23.0/555666/subscribed_apps' && r.method === 'POST') return { body: { success: true } };
      if (p === `/v23.0/${PN}/messages` && r.method === 'POST') {
        sent.push(r.body ?? {});
        if (r.body?.status === 'read') return { body: { success: true } };
        return { body: { messaging_product: 'whatsapp', contacts: [{ wa_id: CUST }], messages: [{ id: `wamid.out${sent.length}` }] } };
      }
      if (p === `/v23.0/${PN}/media` && r.method === 'POST') return { body: { id: 'media-77' } };
      if (p === '/v23.0/media-55' && r.method === 'GET') return { body: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=55', mime_type: 'image/jpeg', file_size: 3 } };
    }
    if (r.url.hostname === 'lookaside.fbsbx.com') return { body: Buffer.from('JPG') };
    return undefined;
  };
}

async function startConn(id: string): Promise<Conn> {
  const c = new WhatsAppCloudConnector(account(id), store);
  await c.start();
  await priv(c).firstSync;
  return c;
}
const sec = (ms: number) => String(Math.floor(ms / 1000));
const NOW = Date.now();

function incoming(seq: number, m: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { seq, t: Math.floor(NOW / 1000), field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PN }, contacts: [{ wa_id: CUST, profile: { name: 'Ayşe' } }], messages: [m], ...extra } };
}

test('saf yardımcılar: zaman, numara biçimi, metin bölme, hata metinleri', () => {
  assert.equal(waTime('1760000000'), 1760000000000);
  assert.equal(waTime(1760000000000), 1760000000000);
  assert.equal(waTime('x'), undefined);
  assert.equal(formatWaId('905000000099'), '+90 500 000 00 99');
  assert.equal(formatWaId('14155550100'), '+14155550100');
  const parts = splitWaText('a'.repeat(5000) + ' ' + 'b'.repeat(10), 4096);
  assert.equal(parts.length, 2);
  assert.equal(waErrorText(new WaCloudError('Re-engagement message', 131047)), WA_WINDOW_TEXT);
  assert.match(waErrorText(new WaCloudError('x', 190)), /oturumu sona erdi/);
  assert.match(waErrorText(new WaCloudError('x', 131026)), /engellemiş|WhatsApp’ta değil/);
  assert.match(waErrorText(new WaCloudError('x', 131042)), /ödeme/);
  assert.match(waErrorText(new WaCloudError('x', 130429)), /sınır/);
  assert.equal(waNeedsRefresh(undefined), false);
  assert.equal(waNeedsRefresh(NOW + 5 * 86_400_000, NOW), true);
  assert.equal(waNeedsRefresh(NOW + 40 * 86_400_000, NOW), false);
});

test('başlat: numara doğrulanır, etiket telefon, eşitleme hemen biter, abonelik tazelenir', async () => {
  calls = [];
  queue = [];
  handler = routes();
  writeToken('whatsapp:t1', token);
  const c = await startConn('whatsapp:t1');
  assert.equal(c.account.status, 'connected');
  assert.equal(c.account.label, '+90 500 000 00 01');
  assert.ok(calls.some((r) => r.url.pathname === '/v23.0/555666/subscribed_apps'));
  const pull = calls.find((r) => r.url.hostname === 'relay.test');
  assert.ok(pull, 'aktarıcı yoklandı');
  assert.equal(pull!.url.searchParams.get('phone_number_id'), PN);
  assert.equal(pull!.key, token.pullKey);
  await c.stop();
});

test('aktarıcı olayları: gelen metin → sohbet + mesaj (canlı, okunmamış), yanıt bağlamı, durum güncellemesi, telefondan yankı', async () => {
  queue = [];
  sent = [];
  handler = routes();
  writeToken('whatsapp:t2', token);
  const events: string[] = [];
  const off = bus.on((e) => {
    if (e.type === 'message.upsert' && e.live) events.push(e.message.text);
  });
  const c = await startConn('whatsapp:t2');
  queue.push(incoming(1, { from: CUST, id: 'wamid.in1', timestamp: sec(NOW - 60_000), type: 'text', text: { body: 'Merhaba, sipariş ne zaman gelir?' } }));
  await priv(c).poll();
  const chats = store.listChatsOf('whatsapp:t2');
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.name, 'Ayşe');
  assert.equal(chats[0]!.remoteId, CUST);
  assert.equal(chats[0]!.unread, 1);
  assert.deepEqual(events, ['Merhaba, sipariş ne zaman gelir?']);
  assert.equal(priv(c).lastSeq, 1);
  // gönderim: yanıt bağlamıyla
  const r = await c.sendText(CUST, 'Yarın kargoda', { replyTo: 'wamid.in1' });
  assert.equal(r.remoteId, 'wamid.out1');
  assert.equal(sent[0]!.to, CUST);
  assert.deepEqual(sent[0]!.context, { message_id: 'wamid.in1' });
  assert.deepEqual(sent[0]!.text, { preview_url: true, body: 'Yarın kargoda' });
  const mine = store.listMessages(chats[0]!.id, 10).find((m) => m.fromMe)!;
  assert.equal(mine.status, 'sent');
  assert.equal(mine.replyTo?.text, 'Merhaba, sipariş ne zaman gelir?');
  // durumlar: delivered → read; geri gitmez
  queue.push({ seq: 2, t: 0, field: 'messages', value: { metadata: { phone_number_id: PN }, statuses: [{ id: 'wamid.out1', status: 'read', timestamp: sec(NOW), recipient_id: CUST }] } });
  queue.push({ seq: 3, t: 0, field: 'messages', value: { metadata: { phone_number_id: PN }, statuses: [{ id: 'wamid.out1', status: 'delivered', timestamp: sec(NOW), recipient_id: CUST }] } });
  await priv(c).poll();
  assert.equal(store.getMessage(mine.id)!.status, 'read');
  // telefondaki WhatsApp Business uygulamasından gönderilen: benden, bildirim yok
  queue.push({ seq: 4, t: 0, field: 'smb_message_echoes', value: { metadata: { phone_number_id: PN }, message_echoes: [{ from: PN, to: CUST, id: 'wamid.echo1', timestamp: sec(NOW), type: 'text', text: { body: 'Telefondan yazdım' } }] } });
  await priv(c).poll();
  const echo = store.listMessages(chats[0]!.id, 10).find((m) => m.remoteId === 'wamid.echo1')!;
  assert.equal(echo.fromMe, true);
  assert.deepEqual(events, ['Merhaba, sipariş ne zaman gelir?']);
  off();
  await c.stop();
});

test('medya, konum, tepki, rehber adı (state sync), geçmiş aktarımı', async () => {
  queue = [];
  sent = [];
  handler = routes();
  writeToken('whatsapp:t3', token);
  const c = await startConn('whatsapp:t3');
  queue.push(incoming(1, { from: CUST, id: 'wamid.img', timestamp: sec(NOW), type: 'image', image: { id: 'media-55', mime_type: 'image/jpeg', caption: 'bak' } }));
  queue.push(incoming(2, { from: CUST, id: 'wamid.loc', timestamp: sec(NOW), type: 'location', location: { latitude: 41.01, longitude: 28.97, name: 'Taksim' } }));
  queue.push(incoming(3, { from: CUST, id: 'wamid.react', timestamp: sec(NOW), type: 'reaction', reaction: { message_id: 'wamid.img', emoji: '❤️' } }));
  queue.push({ seq: 4, t: 0, field: 'smb_app_state_sync', value: { metadata: { phone_number_id: PN }, state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Ayşe Yılmaz', phone_number: '+905000000099' } }] } });
  queue.push({
    seq: 5,
    t: 0,
    field: 'history',
    value: { metadata: { phone_number_id: PN }, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: CUST, messages: [{ id: 'wamid.old1', from: CUST, timestamp: sec(NOW - 86_400_000), type: 'text', text: { body: 'Dünkü mesaj' }, history_context: { from_me: false, status: 'delivered' } }, { id: 'wamid.old2', timestamp: sec(NOW - 80_000_000), type: 'text', text: { body: 'Dünkü yanıtım' }, history_context: { from_me: true, status: 'read' } }] }] }] },
  });
  await priv(c).poll();
  const chat = store.listChatsOf('whatsapp:t3')[0]!;
  assert.equal(chat.name, 'Ayşe Yılmaz', 'rehber adı profil adının önüne geçer');
  const msgs = store.listMessages(chat.id, 20);
  const img = msgs.find((m) => m.remoteId === 'wamid.img')!;
  assert.equal(img.text, 'bak');
  assert.equal(img.attachments?.[0]?.kind, 'image');
  assert.match(img.attachments![0]!.url!, /u=wamedia:media-55/);
  assert.deepEqual(img.reactions?.map((x) => x.emoji), ['❤️']);
  const loc = msgs.find((m) => m.remoteId === 'wamid.loc')!;
  assert.match(loc.text, /Taksim/);
  assert.match(loc.attachments![0]!.link!, /maps\.google\.com/);
  const old2 = msgs.find((m) => m.remoteId === 'wamid.old2')!;
  assert.equal(old2.fromMe, true);
  assert.equal(old2.status, 'read');
  assert.equal(msgs.find((m) => m.remoteId === 'wamid.old1')!.fromMe, false);
  assert.equal(chat.unread, 2, 'geçmiş aktarımı okunmamış saymaz (görsel + konum)');
  // medya: GET /{id} → imzalı adres → Bearer ile indir, önbellek
  const m = await c.fetchMedia('wamedia:media-55');
  assert.equal(m?.type, 'image/jpeg');
  assert.equal(m?.body.toString(), 'JPG');
  const dl = calls.find((r) => r.url.hostname === 'lookaside.fbsbx.com');
  assert.equal(dl?.auth, 'Bearer EAAB-test-token');
  // tepki gönder / okundu
  await c.react(CUST, 'wamid.img', '👍', false);
  assert.deepEqual(sent.at(-1)!.reaction, { message_id: 'wamid.img', emoji: '👍' });
  await c.markRead(CUST);
  assert.equal(sent.at(-1)!.status, 'read');
  assert.equal(sent.at(-1)!.message_id, 'wamid.loc', 'son gelen mesaj okundu bildirilir');
  // dosya gönder: multipart yükleme + kimlikle mesaj
  const f = path.join(tmp, 'foto.jpg');
  fs.writeFileSync(f, 'x'.repeat(10));
  const r = await c.sendMedia(CUST, { path: f, name: 'foto.jpg', mime: 'image/jpeg', size: 10 }, 'açıklama');
  assert.equal(r.remoteId, `wamid.out${sent.length}`);
  const up = calls.find((x) => x.url.pathname === `/v23.0/${PN}/media`);
  assert.ok(up?.form, 'multipart yükleme');
  assert.equal(up!.form!.get('messaging_product'), 'whatsapp');
  assert.deepEqual(sent.at(-1)!.image, { id: 'media-77', caption: 'açıklama' });
  await c.stop();
});

test('24 saat penceresi, belirteç bitti, aktarıcı kaydı düşünce yeniden kayıt', async () => {
  queue = [];
  sent = [];
  let regs = 0;
  let lost = true;
  handler = routes((r) => {
    if (r.url.hostname === 'relay.test' && r.url.searchParams.get('action') === 'pull' && lost) return { status: 404, body: { error: 'not_registered' } };
    if (r.url.hostname === 'relay.test' && r.url.searchParams.get('action') === 'register') {
      regs++;
      lost = false;
      return { body: { ok: true, pullKey: 'c'.repeat(48), last: 0 } };
    }
    if (r.url.pathname === `/v23.0/${PN}/messages` && r.method === 'POST' && (r.body?.text as { body?: string } | undefined)?.body === 'pencere') return { status: 400, body: { error: { message: '(#131047) Re-engagement message', code: 131047 } } };
    if (r.url.pathname === `/v23.0/${PN}/messages` && r.method === 'POST' && (r.body?.text as { body?: string } | undefined)?.body === 'bitti') return { status: 400, body: { error: { message: 'Error validating access token', code: 190 } } };
    return undefined;
  });
  writeToken('whatsapp:t4', token);
  const c = await startConn('whatsapp:t4');
  assert.equal(regs, 1, 'kayıt düşmüşse belirteçle bir kez yeniden kayıt');
  const tok = JSON.parse(fs.readFileSync(path.join(sessionDir('whatsapp:t4'), 'token'), 'utf8')) as { pullKey: string };
  assert.equal(tok.pullKey, 'c'.repeat(48));
  await assert.rejects(c.sendText(CUST, 'pencere'), (e: Error) => e.message === WA_WINDOW_TEXT);
  assert.equal(priv(c).dead, false);
  await assert.rejects(c.sendText(CUST, 'bitti'), /oturumu sona erdi/);
  assert.equal(priv(c).dead, true);
  assert.equal(c.account.status, 'error');
  await c.stop();
});

test('giriş akışı: Embedded Signup geri dönüşü (kod + numara) → aracı değişimi → numara doğrulama + abonelik + aktarıcı kaydı → hesap', async () => {
  calls = [];
  let brokerBody: Record<string, unknown> | undefined;
  handler = routes((r) => {
    if (r.url.hostname === 'broker.test' && r.url.searchParams.get('action') === 'token') {
      brokerBody = r.body;
      return { body: { access_token: 'EAAB-new', token_type: 'bearer' } };
    }
    return undefined;
  });
  const added: Array<{ platform: string; token: string; label?: string }> = [];
  const f = await flows.startFlow('whatsapp', { add: async (platform, o) => {
    added.push({ platform, ...o });
    return { id: 'whatsapp:new', platform, label: o.label ?? '', status: 'connecting' as const, createdAt: 1 };
  }, noBrowser: true });
  assert.equal(f.state, 'waiting');
  assert.match(f.url!, /^https:\/\/mivelo\.app\/api\/wa-signup\.php\?state=[A-Za-z0-9_-]+\.\d+$/);
  const state = new URL(f.url!).searchParams.get('state')!;
  assert.equal(resolveOAuth(state, { code: 'AQ-code', extra: { phone_number_id: PN, waba_id: '555666' } }), true);
  for (let i = 0; i < 50 && flows.getFlow(f.id)!.state !== 'done' && flows.getFlow(f.id)!.state !== 'error'; i++) await new Promise((r) => setTimeout(r, 20));
  const v = flows.getFlow(f.id)!;
  assert.equal(v.state, 'done', v.error);
  assert.equal(brokerBody?.provider, 'whatsapp');
  assert.equal(brokerBody?.code, 'AQ-code');
  const tok = JSON.parse(added[0]!.token) as Record<string, unknown>;
  assert.equal(tok.official, 'whatsapp');
  assert.equal(tok.phoneNumberId, PN);
  assert.equal(tok.wabaId, '555666');
  assert.equal(tok.pullKey, 'b'.repeat(48));
  assert.equal(tok.accessToken, 'EAAB-new');
  assert.equal(added[0]!.label, '+90 500 000 00 01');
  assert.ok(calls.some((r) => r.url.pathname === '/v23.0/555666/subscribed_apps' && r.method === 'POST'));
  const reg = calls.find((r) => r.url.hostname === 'relay.test' && r.url.searchParams.get('action') === 'register');
  assert.equal(reg?.body?.phone_number_id, PN);
  assert.equal(reg?.body?.access_token, 'EAAB-new');
  assert.equal(flows.officialKind(added[0]!.token), 'whatsapp');
});
