import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { toMessages, toThreads, type RawItem } from '../src/connectors/browser/tiktok.js';
import { rowToThread } from '../src/connectors/browser/messenger.js';
import { isSeenRequest } from '../src/connectors/browser/instagram.js';
import { slackStrategy, _resetSlackState } from '../src/connectors/browser/slack.js';

const NOW = new Date(2026, 8, 29, 12, 0).getTime();

test('TikTok: göreli liste zamanı ("1 g") önizleme değişmedikçe kaymaz; değişim anı sonraki turlarda korunur', () => {
  const row = (preview: string) => [{ name: 'Göreli Kişi', preview, time: '1 g', unread: 0 }];
  const a = toThreads(row('selam'), NOW)[0].lastTs;
  const b = toThreads(row('selam'), NOW + 180_000)[0].lastTs;
  assert.equal(b, a, 'aynı önizleme: 3 dk sonra da aynı zaman (eskiden +180000 ms)');
  const c = toThreads(row('yeni mesaj'), NOW + 240_000)[0].lastTs;
  assert.equal(c, NOW + 240_000, 'önizleme değişti: şimdi');
  const d = toThreads(row('yeni mesaj'), NOW + 300_000)[0].lastTs;
  assert.equal(d, c, 'değişim anı bir tur sonra 0/göreli değere dönmez');
});

test('TikTok: ilk ayırıcıdan önceki (bloğu yüklenmemiş) mesajlar atlanır; ayırıcısızda zaman sohbet zamanını aşmaz', () => {
  const now = new Date(NOW);
  const items: RawItem[] = [{ text: 'eski 1', me: false }, { text: 'eski 2', me: false }, { sep: '22 Eylül 18:20' }, { text: 'yeni', me: true }];
  const out = toMessages('t1', 'Ayşe', items, now);
  assert.deepEqual(out.map((m) => m.text), ['yeni']);
  assert.ok(out[0].ts < NOW - 86_400_000, 'ayırıcı zamanı taban');
  // ayırıcı yüklenince 'yeni' kimliği değişmez
  const later = toMessages('t1', 'Ayşe', [{ sep: '22 Eylül 17:00' }, { text: 'eski 1', me: false }, { text: 'eski 2', me: false }, { sep: '22 Eylül 18:20' }, { text: 'yeni', me: true }], now);
  assert.equal(later.at(-1)!.id, out[0].id);
  assert.equal(later.length, 3);
  const fallback = NOW - 3_600_000;
  const noSep = toMessages('t2', 'Mert', [{ text: 'a', me: false }, { text: 'b', me: true }], now, fallback);
  assert.equal(noSep.length, 2);
  assert.ok(noSep.every((m) => m.ts <= fallback), 'ayırıcısız mesaj sohbet zamanından ileri gitmez');
  assert.ok(noSep[0].ts < noSep[1].ts);
});

test('Messenger: önizleme değişim anı ertelenen sohbet için sonraki turlarda da döner', () => {
  const r = (preview: string) => ({ id: 'strat-m1', name: 'Ali', preview, unread: false });
  assert.equal(rowToThread(r('selam')).lastTs, 0, 'ilk görüş 0');
  assert.equal(rowToThread(r('selam')).lastTs, 0, 'değişmedi: 0');
  const t = rowToThread(r('yeni')).lastTs;
  assert.ok(t > 0);
  assert.equal(rowToThread(r('yeni')).lastTs, t, 'bir tur sonra da değişim anı (eskiden 0 → mesajlar hiç çekilmiyordu)');
});

test('Instagram isSeenRequest: yalnız okundu istekleri; "thread" içeren sıradan sorgular değil', () => {
  assert.equal(isSeenRequest('https://www.instagram.com/api/v1/direct_v2/threads/1/items/2/seen/', ''), true);
  assert.equal(isSeenRequest('https://www.instagram.com/api/graphql', 'av=1&fb_api_req_friendly_name=IGDMarkThreadAsReadMutation&x=1'), true);
  assert.equal(isSeenRequest('https://www.instagram.com/api/graphql', 'fb_api_req_friendly_name=IGDThreadListQuery&variables=%7B%22thread%22%7D'), false);
  assert.equal(isSeenRequest('https://www.instagram.com/api/v1/direct_v2/inbox/', 'read'), false);
});

/** Sahte Slack sayfası (slack.test.ts'teki gibi): yöntem → yanıt */
function fakeSlack(handlers: Record<string, (p: Record<string, unknown>) => unknown>, calls: Array<{ method: string; params: Record<string, unknown> }>): Page {
  return {
    isClosed: () => false,
    url: () => 'https://app.slack.com/client/T1/C1',
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, args?: { method?: string; params?: Record<string, unknown> }) => {
      if (!args?.method) return { token: 'xoxc-test', domain: 'ws', name: 'Test WS', userId: 'U_ME', url: 'https://ws.slack.com/' };
      calls.push({ method: args.method, params: args.params ?? {} });
      const h = handlers[args.method];
      if (!h) throw new Error(`Slack ${args.method}: beklenmeyen çağrı`);
      const j = { ok: true, ...(h(args.params ?? {}) as object) } as { ok: boolean; error?: string };
      if (!j.ok) throw new Error(`Slack ${args.method}: ${j.error}`); // sayfadaki fetch gibi
      return { j, idx: 0 };
    },
  } as unknown as Page;
}

test('Slack (tarayıcı): çağrı başına ≤3 iş parçacığı, kalanlar sonraki turda; kanal "değişmiş" kalır; yanıt hız sınırı geçmişi atmaz, geçmiş hız sınırı köprüye fırlar', async () => {
  _resetSlackState();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const parents = Array.from({ length: 5 }, (_, i) => ({ ts: `17000000${i}0.000100`, user: 'U_A', text: `üst ${i}`, reply_count: 1, latest_reply: `17000001${i}0.000100` }));
  let rateLimit = false;
  const page = fakeSlack(
    {
      'client.counts': () => ({ ims: [], mpims: [], channels: [{ id: 'C9', latest: '1700000400.000100', has_unreads: false }] }),
      'conversations.list': () => ({ channels: [{ id: 'C9', name: 'genel' }], response_metadata: { next_cursor: '' } }),
      'conversations.history': () => ({ messages: parents }),
      'conversations.replies': (p) => (rateLimit ? { ok: false, error: 'ratelimited' } : { messages: [{ ts: String(p.ts), user: 'U_A', text: 'üst' }, { ts: `${String(p.ts).slice(0, 10)}9.000100`, user: 'U_A', text: 'yanıt' }] }),
      'users.info': (p) => ({ user: { id: p.user, name: String(p.user) } }),
    },
    calls,
  );
  await slackStrategy.me(page, {});
  const t1 = (await slackStrategy.threads(page, {}))[0].lastTs;
  await slackStrategy.messages(page, {}, 'C9', 25);
  const first = calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params.ts);
  assert.equal(first.length, 3, 'ilk çağrıda yalnız 3 dizi');
  assert.deepEqual(first, [parents[4].ts, parents[3].ts, parents[2].ts], 'en yeni yanıtlı önce');
  const t2 = (await slackStrategy.threads(page, {}))[0].lastTs;
  assert.equal(t2, t1 + 1, 'kalan diziler için kanal bir sonraki turda yine "değişmiş"');
  calls.length = 0;
  await slackStrategy.messages(page, {}, 'C9', 15);
  assert.deepEqual(calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params.ts), [parents[1].ts, parents[0].ts]);
  const t3 = (await slackStrategy.threads(page, {}))[0].lastTs;
  assert.equal(t3, t1, 'hepsi alındı: gerçek zaman');
  // yanıtlardaki hız sınırı zaten alınmış geçmişi ATMAZ (eskiden tüm çağrı fırlıyordu → iş parçacığı yoğun kanal hiç dolmuyordu):
  // geçmiş döner, yanıtlar beklemeye alınır, kanal sonraki turda yine "değişmiş"
  _resetSlackState();
  await slackStrategy.me(page, {});
  const t4 = (await slackStrategy.threads(page, {}))[0].lastTs;
  rateLimit = true;
  calls.length = 0;
  const got = await slackStrategy.messages(page, {}, 'C9', 25);
  assert.equal(got.filter((m) => !m.threadId).length, 5, 'üst mesajlar döndü');
  assert.equal(calls.filter((c) => c.method === 'conversations.replies').length, 1, 'hız sınırından sonra başka yanıt istenmedi');
  assert.equal((await slackStrategy.threads(page, {}))[0].lastTs, t4 + 1, 'yanıtlar sonraki tura kaldı');
  calls.length = 0;
  await slackStrategy.messages(page, {}, 'C9', 25);
  assert.equal(calls.filter((c) => c.method === 'conversations.replies').length, 0, 'bekleme süresince yanıt istenmez');
  // birincil çağrıdaki (geçmiş) hız sınırı köprüye fırlar (üstel geri çekilme)
  _resetSlackState();
  const limited = fakeSlack({ 'conversations.history': () => ({ ok: false, error: 'ratelimited' }), 'users.info': () => ({ user: {} }) }, []);
  await assert.rejects(slackStrategy.messages(limited, {}, 'C9', 25), /ratelimited/);
});
