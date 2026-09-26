import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { instagram, pickCursor } from '../src/connectors/browser/instagram.js';
import { linkedin, conversationsPageUrl, liReactions } from '../src/connectors/browser/linkedin.js';
import { messenger, SITES, siteOfUrl, threadUrl, THREAD_HREF } from '../src/connectors/browser/messenger.js';
import { mergeLegacyGroups, applyReadMark } from '../src/connectors/browser/x.js';
import type { Thread } from '../src/connectors/browser/bridge.js';

// ───────────── Instagram ─────────────

/** Instagram sahte sayfası: ig() çağrılarını (args.path) yanıtlar, istenen yolları kaydeder */
function igPage(handler: (path: string) => unknown, paths: string[] = []): Page {
  // ig() sayfa açıkken page.request.fetch ile ister (tarayıcı bağlamının çerezleri); yanıt JSON metni
  return {
    request: {
      fetch: async (url: string) => {
        const path = url.replace('https://www.instagram.com', '');
        paths.push(path);
        const body = JSON.stringify(await handler(path));
        return { ok: () => true, status: () => 200, text: async () => body };
      },
    },
    context: () => ({ cookies: async () => [] }),
  } as unknown as Page;
}

const us = (ms: number) => String(ms * 1000); // Instagram zamanları µs
const item = (id: string, ms: number, user: string, extra: Record<string, unknown> = {}) => ({ item_id: id, timestamp: us(ms), user_id: user, item_type: 'text', text: 'm' + id, ...extra });

test('instagram messages: eskiden yeniye, en çok limit, tepki kaydı (action_log / hide_in_thread) mesaj sayılmaz', async () => {
  const T = 1_790_000_000_000;
  // API yeniden eskiye ve limit+1 öğe döndürür
  const items = [
    item('5', T + 5000, '42'),
    item('4', T + 4000, '1', { item_type: 'action_log', action_log: { description: 'Bir mesajı beğendi' }, hide_in_thread: 1 }),
    item('3', T + 3000, '1'),
    item('2', T + 2000, '42'),
    item('1', T + 1000, '1'),
  ];
  const page = igPage((p) => (p.startsWith('/api/v1/direct_v2/inbox') ? { viewer: { pk: 42, username: 'ben' }, inbox: { threads: [] } } : { thread: { items, users: [{ pk: 1, full_name: 'Ayşe' }], oldest_cursor: 'C-OLD', has_older: true } }));
  await instagram.me(page, { ds_user_id: '42' });
  const msgs = await instagram.messages(page, {}, 'T-ORDER', 3);
  assert.deepEqual(
    msgs.map((m) => [m.id, m.fromMe, m.senderName]),
    [
      ['2', true, 'Instagram kullanıcısı'],
      ['3', false, 'Ayşe'],
      ['5', true, 'Instagram kullanıcısı'],
    ],
  );
  assert.ok(msgs.every((m, i) => !i || msgs[i - 1].ts <= m.ts));
});

test('instagram messages(before): boşluk bırakmayan imleç seçilir', async () => {
  const T = 1_790_000_000_000;
  const paths: string[] = [];
  const page = igPage((p) => {
    if (p.includes('cursor=C1')) return { thread: { items: [item('b1', T - 5000, '1')], oldest_cursor: 'C2', has_older: false } };
    return { thread: { items: [item('a2', T + 1000, '1'), item('a1', T, '1')], oldest_cursor: 'C1', has_older: true } };
  }, paths);
  await instagram.messages(page, {}, 'T-CUR', 20); // en yeni sayfa: C1 imleci, en eski T
  paths.length = 0;
  const older = await instagram.messages(page, {}, 'T-CUR', 20, T);
  assert.ok(paths[0].includes('cursor=C1'), 'before = sayfanın en eskisi: imleçten devam');
  assert.deepEqual(older.map((m) => m.id), ['b1']);
  // before, bilinen imlecin en eskisinden YENİ ise o imleç [T, before) aralığını atlardı → imleçsiz baştan
  assert.equal(pickCursor([{ cursor: 'C1', oldestTs: T }], T + 500), undefined);
  assert.equal(pickCursor([{ cursor: 'C1', oldestTs: T }, { cursor: 'C0', oldestTs: T + 900 }], T + 500), 'C0');
  assert.equal(pickCursor([{ cursor: 'C1', oldestTs: T }, { cursor: 'C0', oldestTs: T + 900 }], T), 'C1');
});

test('instagram threads: son öğe tepki kaydıysa önizleme bir önceki mesaj; okunmamış last_seen_at sonrası', async () => {
  const T = 1_790_000_000_000;
  const page = igPage(() => ({
    viewer: { pk: 42 },
    inbox: {
      threads: [
        {
          thread_id: 'T1',
          users: [{ pk: 1, username: 'ayse', full_name: 'Ayşe' }],
          read_state: 1,
          last_seen_at: { '42': { timestamp: us(T) } },
          last_activity_at: us(T + 3000),
          items: [
            item('3', T + 3000, '1', { item_type: 'action_log', action_log: { description: 'Bir mesajı beğendi' }, hide_in_thread: 1 }),
            item('2', T + 2000, '1', { text: 'selam' }),
            item('1', T - 1000, '1'),
          ],
        },
      ],
    },
  }));
  const [t] = await instagram.threads(page, {});
  assert.equal(t.preview, 'selam');
  assert.equal(t.unread, 1);
  assert.equal(t.lastTs, T + 3000);
});

// ───────────── LinkedIn ─────────────

test('linkedin: sohbet listesi sayfa URL\'si (PRIMARY_INBOX + nextCursor), yakalanan sorgu kimliği tercih edilir', () => {
  const base = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AME)';
  const u = conversationsPageUrl(base, 'urn:li:fsd_profile:ME', 'REVT==');
  assert.ok(u.startsWith('https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf&variables=('));
  assert.ok(u.includes('category:PRIMARY_INBOX'));
  assert.ok(u.includes('mailboxUrn:urn%3Ali%3Afsd_profile%3AME'));
  assert.ok(u.endsWith(',nextCursor:REVT%3D%3D)'));
  const captured = conversationsPageUrl(base, 'urn:li:fsd_profile:ME', undefined, 'https://x/graphql?queryId=messengerConversations.NEW&variables=(x)');
  assert.ok(captured.includes('queryId=messengerConversations.NEW&'));
  assert.ok(!captured.includes('nextCursor'));
});

test('linkedin markRead: istemcinin okundu isteği (read:true yaması)', async () => {
  const calls: Array<{ url: string; init?: { method?: string; body?: unknown } }> = [];
  const page = { evaluate: async (_fn: unknown, args: { url: string; init?: { method?: string; body?: unknown } }) => (calls.push(args), {}) } as unknown as Page;
  const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-ABC==)';
  await linkedin.markRead!(page, { JSESSIONID: '"ajax:1"' }, urn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AME%2C2-ABC%3D%3D%29)');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.body, { entities: { [urn]: { patch: { $set: { read: true } } } } });
});

// ───────────── X ─────────────

test('x: 1.1 grubu "<id>" ile XChat grubu "g<id>" tek sohbet olur (XChat kimliği kalır)', () => {
  const th = (id: string, lastTs: number, preview: string, kind: Thread['kind'] = 'group'): Thread => ({ id, name: 'just kings', kind, lastTs, preview, unread: 0 });
  const byId = new Map<string, Thread>([
    ['1933635359679680751', th('1933635359679680751', 2000, 'eski arşiv')],
    ['g1933635359679680751', th('g1933635359679680751', 5000, 'yeni')],
    ['1494587279163207684', th('1494587279163207684', 3000, 'arşiv önizleme')],
    ['g1494587279163207684', th('g1494587279163207684', 0, '')],
    ['550911115-1923510781', th('550911115-1923510781', 1000, 'birebir', 'direct')],
    ['1671968645667487744', th('1671968645667487744', 900, 'yalnızca arşiv')],
  ]);
  mergeLegacyGroups(byId);
  assert.deepEqual([...byId.keys()].sort(), ['1671968645667487744', '550911115-1923510781', 'g1494587279163207684', 'g1933635359679680751']);
  assert.equal(byId.get('g1933635359679680751')!.preview, 'yeni');
  assert.equal(byId.get('g1494587279163207684')!.lastTs, 3000);
  assert.equal(byId.get('g1494587279163207684')!.preview, 'arşiv önizleme');
});

test('x: okundu işareti yedekteki eski okunmamışı sıfırlar, işaretten sonra gelen mesaj varsa korunur', () => {
  assert.equal(applyReadMark(2, 1000, 5000), 0);
  assert.equal(applyReadMark(2, 6000, 5000), 2);
  assert.equal(applyReadMark(2, 1000, undefined), 2);
  assert.equal(applyReadMark(0, 9000, 5000), 0);
});

// ───────────── Messenger ─────────────

/** Messenger sahte sayfası: sohbet zaten açık, satırlar sabit (readRows'un döndürdüğü ham satırlar) */
function messengerPage(threadId: string, rows: Array<{ aria: string; text: string }>): Page {
  return {
    url: () => `https://www.messenger.com/t/${threadId}/`,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: () => ({ count: async () => rows.length }),
    evaluate: async (_fn: unknown, arg?: unknown) => (typeof arg === 'string' && arg.includes('messages_table') ? rows.map((r) => ({ ...r, isDateBreak: false, me: undefined, attachments: [] })) : false),
  } as unknown as Page;
}

test('messenger: aynı mesaj ertesi gün ("Bugün" → "Dün") aynı kimliği alır; sıra ve gönderen doğru', async () => {
  const day1 = new Date(2026, 8, 24, 15, 0).getTime();
  const day2 = new Date(2026, 8, 25, 10, 0).getTime();
  mock.timers.enable({ apis: ['Date'], now: day1 });
  try {
    const a = await messenger.messages(
      messengerPage('77', [
        { aria: 'Bugün 14:32, Sen: selam', text: 'selam' },
        { aria: 'Bugün 14:33, Ali Veli: naber', text: 'naber' },
        { aria: 'Bugün 14:33, Ali Veli: naber', text: 'naber' },
      ]),
      {},
      '77',
      20,
    );
    mock.timers.setTime(day2);
    const b = await messenger.messages(
      messengerPage('77', [
        { aria: 'Dün 14:32, Sen: selam', text: 'selam' },
        { aria: 'Dün 14:33, Ali Veli: naber', text: 'naber' },
        { aria: 'Dün 14:33, Ali Veli: naber', text: 'naber' },
      ]),
      {},
      '77',
      20,
    );
    assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
    assert.equal(new Set(a.map((m) => m.id)).size, 3, 'aynı dakikadaki iki özdeş mesaj ayrı kimlik alır');
    assert.deepEqual(a.map((m) => [m.fromMe, m.senderName, m.ts]), [
      [true, 'Ben', new Date(2026, 8, 24, 14, 32).getTime()],
      [false, 'Ali Veli', new Date(2026, 8, 24, 14, 33).getTime()],
      [false, 'Ali Veli', new Date(2026, 8, 24, 14, 33).getTime()],
    ]);
  } finally {
    mock.timers.reset();
  }
});

test('messenger: iki adres — bağlantı biçimleri, adres tanıma ve sohbet adresi', () => {
  for (const h of ['/t/123/', '/t/123', '/e2ee/t/123/', '/messages/t/123/', '/messages/e2ee/t/123']) assert.equal(h.match(THREAD_HREF)?.[1], '123', h);
  for (const h of ['/t/abc/', '/messages/', '/marketplace/t/123/', '/messages/t/123/?focus_target=x']) assert.equal(THREAD_HREF.test(h), false, h);
  assert.equal(siteOfUrl('https://www.facebook.com/messages/t/1/')?.key, 'facebook');
  assert.equal(siteOfUrl('https://web.facebook.com/messages/')?.key, 'facebook');
  assert.equal(siteOfUrl('https://www.messenger.com/t/1/')?.key, 'messenger');
  assert.equal(siteOfUrl('https://notfacebook.com/')?.key, undefined);
  const [fb, ms] = SITES;
  assert.equal(threadUrl('9', fb, undefined), 'https://www.facebook.com/messages/t/9/');
  assert.equal(threadUrl('9', ms, undefined), 'https://www.messenger.com/t/9/');
  assert.equal(threadUrl('9', fb, '/messages/e2ee/t/9'), 'https://www.facebook.com/messages/e2ee/t/9/');
  // başka adreste görülmüş yol kullanılmaz
  assert.equal(threadUrl('9', fb, '/e2ee/t/9/'), 'https://www.facebook.com/messages/t/9/');
  assert.equal(threadUrl('9', ms, '/messages/e2ee/t/9/'), 'https://www.messenger.com/t/9/');
  assert.equal(threadUrl('9', ms, '/e2ee/t/9/'), 'https://www.messenger.com/e2ee/t/9/');
  assert.equal(messenger.home, 'https://www.facebook.com/messages/');
});

test('instagram gönderim: sayfa açıkken de doğrulanmış başlıklarla (x-asbd-id, referer, origin, csrf) istek bağlamından', async () => {
  let seen: { url: string; opts: { method?: string; headers?: Record<string, string>; data?: string } } | undefined;
  const page = {
    request: {
      fetch: async (url: string, opts: { method?: string; headers?: Record<string, string>; data?: string }) => {
        seen = { url, opts };
        return { ok: () => true, status: () => 200, text: async () => JSON.stringify({ payload: { item_id: '777' } }) };
      },
    },
    context: () => ({ cookies: async () => [{ name: 'csrftoken', value: 'CSRF1' }] }),
  } as unknown as Page;
  const id = await instagram.send(page, {}, '340282366841710300949128', 'selam');
  assert.equal(id, '777');
  assert.equal(seen?.url, 'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/');
  assert.equal(seen?.opts.method, 'POST');
  const h = seen!.opts.headers!;
  assert.equal(h['x-csrftoken'], 'CSRF1', 'çerez sözlüğünde yoksa tarayıcı bağlamından');
  assert.equal(h['x-asbd-id'], '129477');
  assert.equal(h.origin, 'https://www.instagram.com');
  assert.match(String(seen?.opts.data), /text=selam/);
  // HTML yanıt anlaşılır hata verir
  const htmlPage = { request: { fetch: async () => ({ ok: () => true, status: () => 200, text: async () => '<!DOCTYPE html><html lang="tr">' }) }, context: () => ({ cookies: async () => [] }) } as unknown as Page;
  await assert.rejects(instagram.send(htmlPage, { csrftoken: 'x' }, '1', 'a'), /JSON yerine sayfa/);
});

test('instagram tepki: broadcast/reaction ucu, created/deleted', async () => {
  const seen: string[] = [];
  const page = {
    request: {
      fetch: async (url: string, opts: { data?: string }) => {
        seen.push(url + ' ' + String(opts.data));
        return { ok: () => true, status: () => 200, text: async () => '{"status":"ok"}' };
      },
    },
    context: () => ({ cookies: async () => [{ name: 'csrftoken', value: 'C' }] }),
  } as unknown as Page;
  await instagram.react!(page, {}, '123', 'itm9', '❤️', false);
  await instagram.react!(page, {}, '123', 'itm9', '❤️', true);
  assert.match(seen[0], /\/api\/v1\/direct_v2\/threads\/broadcast\/reaction\//);
  assert.match(seen[0], /reaction_status=created/);
  assert.match(seen[0], /item_id=itm9/);
  assert.match(seen[0], /thread_ids=%5B%22123%22%5D/);
  assert.match(seen[1], /reaction_status=deleted/);
});

test('linkedin tepki: reactWithEmoji/unreactWithEmoji {messageUrn, emoji}; reactionSummaries → reactions', async () => {
  const calls: Array<{ url: string; init?: { method?: string; body?: unknown } }> = [];
  const page = { evaluate: async (_fn: unknown, a: { url: string; init?: { method?: string; body?: unknown } }) => (calls.push(a), {}) } as unknown as Page;
  const urn = 'urn:li:msg_message:(urn:li:fsd_profile:A,2-XYZ)';
  await linkedin.react!(page, { JSESSIONID: '"ajax:1"' }, 't', urn, '👍', false);
  await linkedin.react!(page, { JSESSIONID: '"ajax:1"' }, 't', urn, '👍', true);
  assert.match(calls[0].url, /voyagerMessagingDashMessengerMessages\?action=reactWithEmoji$/);
  assert.match(calls[1].url, /action=unreactWithEmoji$/);
  assert.deepEqual(calls[0].init, { method: 'POST', body: { messageUrn: urn, emoji: '👍' } });
  await assert.rejects(linkedin.react!(page, {}, 't', '1790000000000', '👍', false), /uygun değil/);

  const r = liReactions({ reactionSummaries: [{ emoji: '👍', count: 2, viewerReacted: true }, { emoji: '😂', count: 1, viewerReacted: false }] })!;
  assert.deepEqual(r.map((x) => [x.emoji, x.fromMe]), [['👍', true], ['👍', false], ['😂', false]]);
  assert.equal(liReactions({}), undefined);
});

test('instagram: HTML yanıtında kök neden yönlendirmeden — doğrulama (checkpoint → köprü yoklamayı durdurur) / oturum kapandı', async () => {
  const pageTo = (url: string, body = '<!DOCTYPE html><html>') =>
    ({ request: { fetch: async () => ({ ok: () => true, status: () => 200, url: () => url, text: async () => body }) }, context: () => ({ cookies: async () => [] }) }) as unknown as Page;
  await assert.rejects(instagram.send(pageTo('https://www.instagram.com/challenge/AbC/'), { csrftoken: 'x' }, '1', 'a'), /checkpoint/);
  await assert.rejects(instagram.send(pageTo('https://www.instagram.com/accounts/login/?next=%2F'), { csrftoken: 'x' }, '1', 'a'), /oturumu kapattı/);
  await assert.rejects(instagram.send(pageTo('https://www.instagram.com/direct/inbox/'), { csrftoken: 'x' }, '1', 'a'), /JSON yerine sayfa/);
});
