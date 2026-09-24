import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { parseGmailPager, gmailPageOf, gmailRowToThread } from '../src/connectors/browser/gmail.js';
import { instagram, _resetInboxCursors } from '../src/connectors/browser/instagram.js';
import { linkedin, conversationToThread, _seedLinkedinForTests } from '../src/connectors/browser/linkedin.js';
import { x, legacyThreadsOf, _resetLegacyInbox } from '../src/connectors/browser/x.js';

// ───────────── Gmail: sayfa aralığı metni ─────────────

test('gmail parseGmailPager: Türkçe/İngilizce araç çubuğu metni, binlik ayırıcılar, tarih olmayan metin', () => {
  assert.deepEqual(parseGmailPager('2.631 satırdan 1–50 arası'), { from: 1, to: 50, total: 2631 });
  assert.deepEqual(parseGmailPager('2.631 satırdan 51–100 arası'), { from: 51, to: 100, total: 2631 });
  assert.deepEqual(parseGmailPager('51–100 of 2,631'), { from: 51, to: 100, total: 2631 });
  assert.deepEqual(parseGmailPager('1-25 / 25'), { from: 1, to: 25, total: 25 });
  assert.deepEqual(parseGmailPager('‎2.601–2.631 / 2.631‏'), { from: 2601, to: 2631, total: 2631 });
  assert.equal(parseGmailPager(''), undefined);
  assert.equal(parseGmailPager('Gelen Kutusu'), undefined);
  assert.equal(parseGmailPager('100–51 arası'), undefined); // ters aralık
});

test('gmail gmailPageOf: aralığın başından sayfa numarası (25/50/100 satır)', () => {
  assert.equal(gmailPageOf(1, 50), 1);
  assert.equal(gmailPageOf(51, 50), 2);
  assert.equal(gmailPageOf(101, 50), 3);
  assert.equal(gmailPageOf(26, 25), 2);
  assert.equal(gmailPageOf(2601, 100), 27);
  assert.equal(gmailPageOf(51, 0), 1);
});

test('gmail gmailRowToThread: gönderen ben isem "Ben", karşı taraf katılımcı olur', () => {
  const row = { id: '1a0d', name: 'Shopier', email: 'noreply@shopier.com', subject: 'Sipariş', snippet: 'Merhaba', time: '24 Eyl 2026 Per 13:08', unread: true, count: 2 };
  const t = gmailRowToThread(row, 'ben@gmail.com');
  assert.equal(t.id, '1a0d');
  assert.equal(t.name, 'Sipariş');
  assert.equal(t.preview, 'Shopier: Merhaba');
  assert.equal(t.unread, 1);
  assert.equal(t.handle, 'noreply@shopier.com');
  assert.equal(t.lastTs, new Date(2026, 8, 24, 13, 8).getTime());
  const mine = gmailRowToThread({ ...row, name: 'Kaan', email: 'ben@gmail.com', unread: false }, 'ben@gmail.com');
  assert.equal(mine.preview, 'Kaan: Merhaba');
  assert.equal(mine.unread, 0);
});

// ───────────── Instagram: gelen kutusu imleç zinciri ─────────────

function igPage(handler: (path: string) => unknown, paths: string[] = []): Page {
  return {
    evaluate: async (_fn: unknown, args: { path: string }) => {
      paths.push(args.path);
      return handler(args.path);
    },
  } as unknown as Page;
}
const igThread = (id: string, name: string) => ({ thread_id: id, thread_title: name, users: [{ pk: 1, username: 'u' + id }], items: [], last_activity_at: '1790000000000000' });

test('instagram moreThreads: oldest_cursor ile sonraki sayfa; has_older=false sonrası boş ve istek yok', async () => {
  _resetInboxCursors();
  const paths: string[] = [];
  const page = igPage((p) => {
    const cursor = decodeURIComponent(p.match(/cursor=([^&]+)/)?.[1] ?? '');
    if (!cursor) return { viewer: { pk: 42 }, inbox: { threads: [igThread('T1', 'Bir')], has_older: true, oldest_cursor: '{"cursor_timestamp_seconds": 1, "cursor_thread_v2_id": 1}' } };
    if (cursor.includes('"cursor_thread_v2_id": 1')) return { inbox: { threads: [igThread('T2', 'İki')], has_older: true, oldest_cursor: 'C2' } };
    if (cursor === 'C2') return { inbox: { threads: [igThread('T3', 'Üç')], has_older: false, oldest_cursor: 'C3' } };
    throw new Error('beklenmeyen imleç ' + cursor);
  }, paths);
  const first = await instagram.threads(page, {});
  assert.deepEqual(first.map((t) => t.id), ['T1']);
  const p1 = await instagram.moreThreads!(page, {}, 1);
  assert.deepEqual(p1.map((t) => [t.id, t.name]), [['T2', 'İki']]);
  assert.ok(paths[1].includes('cursor=%7B%22cursor_timestamp_seconds%22'), 'imleç URL-kodlanmış dizge olarak gider');
  const p2 = await instagram.moreThreads!(page, {}, 2);
  assert.deepEqual(p2.map((t) => t.id), ['T3']);
  const n = paths.length;
  assert.deepEqual(await instagram.moreThreads!(page, {}, 3), []);
  assert.equal(paths.length, n, 'has_older=false: sonraki sayfa istenmez');
});

test('instagram moreThreads: threads() çağrılmadan istenirse zincir ilk sayfadan kurulur', async () => {
  _resetInboxCursors();
  const paths: string[] = [];
  const page = igPage((p) => (p.includes('cursor=') ? { inbox: { threads: [igThread('T9', 'Dokuz')], has_older: false } } : { inbox: { threads: [igThread('T1', 'Bir')], has_older: true, oldest_cursor: 'C1' } }), paths);
  const p1 = await instagram.moreThreads!(page, {}, 1);
  assert.deepEqual(p1.map((t) => t.id), ['T9']);
  assert.equal(paths.length, 2);
  assert.ok(paths[1].endsWith('cursor=C1'));
});

// ───────────── LinkedIn: PRIMARY_INBOX nextCursor zinciri ─────────────

const conv = (n: number) => ({
  entityUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-C${n}==)`,
  conversationParticipants: [
    { hostIdentityUrn: 'urn:li:fsd_profile:ME', participantType: { member: { firstName: { text: 'Ben' } } } },
    { hostIdentityUrn: `urn:li:fsd_profile:P${n}`, participantType: { member: { firstName: { text: 'Kişi' }, lastName: { text: String(n) }, publicIdentifier: `kisi-${n}` } } },
  ],
  lastActivityAt: 1_790_000_000_000 + n,
  unreadCount: 0,
  read: true,
  messages: { elements: [{ body: { text: 'selam ' + n }, deliveredAt: 1_790_000_000_000 + n }] },
});

test('linkedin conversationToThread: katılımcılar, tek kişide profil bağlantısı, önizleme', () => {
  const t = conversationToThread(conv(7), 'ME');
  assert.equal(t.name, 'Kişi 7');
  assert.equal(t.kind, 'direct');
  assert.equal(t.handle, 'kisi-7');
  assert.equal(t.link, 'https://www.linkedin.com/in/kisi-7/');
  assert.equal(t.preview, 'selam 7');
  assert.equal(t.participants?.length, 2);
});

test('linkedin moreThreads: threads() sayfalarının ötesindeki sayfa imleç zinciriyle; zincir bitince boş', async () => {
  const base = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc&variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AME)';
  _seedLinkedinForTests(base, 'ME');
  const urls: string[] = [];
  let lastPage = 8; // 0..8 arası sayfa var; 8'in nextCursor'ı yok
  const page = {
    on: () => undefined,
    url: () => 'https://www.linkedin.com/messaging/',
    evaluate: async (_fn: unknown, args: { url: string }) => {
      urls.push(args.url);
      const cursor = decodeURIComponent(args.url).match(/nextCursor:([^,)]+)/)?.[1];
      const n = cursor ? Number(cursor.replace('C', '')) : 0;
      return { data: { messengerConversationsByCategoryQuery: { elements: [conv(n)], metadata: n < lastPage ? { nextCursor: `C${n + 1}` } : {} } } };
    },
  } as unknown as Page;
  // threads() 0..5 sayfalarını okur (MAX_CONV_PAGES=5) → moreThreads(1) 6. sayfa
  const p1 = await linkedin.moreThreads!(page, { JSESSIONID: '"ajax:1"' }, 1);
  assert.deepEqual(p1.map((t) => t.name), ['Kişi 6']);
  assert.ok(urls[urls.length - 1].includes('nextCursor:C6'), urls[urls.length - 1]);
  assert.ok(urls[0].includes('category:PRIMARY_INBOX') && !urls[0].includes('nextCursor'), 'zincir imleçsiz ilk sayfadan kurulur');
  const p2 = await linkedin.moreThreads!(page, { JSESSIONID: '"ajax:1"' }, 2);
  assert.deepEqual(p2.map((t) => t.name), ['Kişi 7']);
  await linkedin.moreThreads!(page, { JSESSIONID: '"ajax:1"' }, 3); // 8: son sayfa (nextCursor yok)
  const n = urls.length;
  assert.deepEqual(await linkedin.moreThreads!(page, { JSESSIONID: '"ajax:1"' }, 4), []);
  assert.equal(urls.length, n, 'zincir bitti: istek yapılmaz');
  lastPage = 0;
});

// ───────────── X: 1.1 inbox_timeline max_id zinciri ─────────────

test('x legacyThreadsOf: birebir ve grup sohbetleri, son mesaj önizlemesi', () => {
  const state = {
    users: { '1': { name: 'Ayşe', screen_name: 'ayse' }, '2': { name: 'Ben', screen_name: 'ben' } },
    conversations: {
      '1-2': { conversation_id: '1-2', type: 'ONE_TO_ONE', participants: [{ user_id: '1' }, { user_id: '2' }], sort_timestamp: '1700000000000' },
      '99': { conversation_id: '99', type: 'GROUP_DM', name: 'Grup', participants: [{ user_id: '1' }, { user_id: '2' }], sort_timestamp: '1700000001000' },
    },
    entries: [{ message: { conversation_id: '1-2', time: '1700000000000', message_data: { text: 'merhaba', sender_id: '1' } } }],
  };
  const th = legacyThreadsOf(state);
  assert.equal(th.length, 2);
  const dm = th.find((t) => t.id === '1-2')!;
  assert.equal(dm.kind, 'direct');
  assert.equal(dm.preview, 'merhaba');
  assert.equal(dm.lastTs, 1700000000000);
  const g = th.find((t) => t.id === '99')!;
  assert.equal(g.kind, 'group');
  assert.equal(g.name, 'Grup');
});

test('x moreThreads: inbox_timeline/trusted.json?max_id=<min_entry_id>; AT_END sonrası boş', async () => {
  _resetLegacyInbox();
  const paths: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, args: { path: string }) => {
      paths.push(args.path);
      if (args.path.startsWith('/1.1/dm/inbox_initial_state.json')) {
        return { inbox_initial_state: { users: {}, conversations: { 'a-b': { type: 'ONE_TO_ONE', participants: [{ user_id: 'a' }, { user_id: 'b' }] } }, entries: [], inbox_timelines: { trusted: { status: 'HAS_MORE', min_entry_id: 'M0' } } } };
      }
      const maxId = args.path.match(/max_id=([^&]+)/)?.[1];
      if (maxId === 'M0') return { inbox_timeline: { status: 'HAS_MORE', min_entry_id: 'M1', users: {}, conversations: { 'c-d': { type: 'ONE_TO_ONE', participants: [{ user_id: 'c' }, { user_id: 'd' }] } }, entries: [] } };
      if (maxId === 'M1') return { inbox_timeline: { status: 'AT_END', users: {}, conversations: { 'e-f': { type: 'ONE_TO_ONE', participants: [{ user_id: 'e' }, { user_id: 'f' }] } }, entries: [] } };
      throw new Error('beklenmeyen ' + args.path);
    },
  } as unknown as Page;
  const p1 = await x.moreThreads!(page, { twid: 'u%3Da' }, 1);
  assert.deepEqual(p1.map((t) => t.id), ['c-d']);
  assert.ok(paths[1].startsWith('/1.1/dm/inbox_timeline/trusted.json?max_id=M0&'));
  const p2 = await x.moreThreads!(page, { twid: 'u%3Da' }, 2);
  assert.deepEqual(p2.map((t) => t.id), ['e-f']);
  const n = paths.length;
  assert.deepEqual(await x.moreThreads!(page, { twid: 'u%3Da' }, 3), []);
  assert.equal(paths.length, n, 'AT_END: istek yok');
  _resetLegacyInbox();
});
