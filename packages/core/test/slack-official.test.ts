import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-slackx-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { SlackConnector, parseSlackToken } = await import('../src/connectors/slack.js');
const { OAuthError } = await import('../src/oauth/index.js');
const { sessionDir } = await import('../src/config.js');

/** Resmi (xoxp) Slack connector'ı sahte WebClient ile: biçimlendirme, dosya vekili, tepkiler, iş parçacığı, eski mesaj, okundu */
test('slack xoxp: mesaj/iş parçacığı/tepki/okundu/eski mesaj', async () => {
  const store = new Store(path.join(tmp, 's.db'));
  const account = { id: 'slack:1', platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new SlackConnector(account, store, 'xoxp-test');
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rec = (name: string, out: unknown = { ok: true }) => async (a: Record<string, unknown>) => (calls.push([name, a]), out);
  (c as unknown as { meId: string }).meId = 'UME';
  (c as unknown as { web: unknown }).web = {
    users: { info: async ({ user }: { user: string }) => ({ user: { real_name: user === 'U1' ? 'Ayşe' : 'Kaan', name: user.toLowerCase() } }) },
    bots: { info: async () => ({ bot: { name: 'bot' } }) },
    conversations: {
      history: async (a: Record<string, unknown>) => (
        calls.push(['history', a]),
        {
          messages: [
            { ts: '1700000002.000200', user: 'U1', text: 'Selam <@UME> bak <https://x.com|burası>', reply_count: 1, latest_reply: '1700000003.0', reactions: [{ name: 'thumbsup', users: ['UME'], count: 2 }], files: [{ mimetype: 'image/png', name: 'a.png', url_private: 'https://files.slack.com/a.png' }] },
            { ts: '1700000001.000100', subtype: 'channel_join', user: 'U1', text: 'katıldı' },
          ],
        }
      ),
      replies: rec('replies', { messages: [{ ts: '1700000002.000200', latest_reply: '1700000003.0' }, { ts: '1700000003.000000', user: 'UME', text: 'tamam' }] }),
      mark: rec('mark'),
      open: rec('open', { channel: { id: 'D9' } }),
    },
    reactions: { add: rec('reactions.add'), remove: rec('reactions.remove') },
    chat: { postMessage: rec('postMessage', { ts: '1700000009.000000' }) },
  };
  await (c as unknown as { fetchHistory: (x: { id: string }, first: boolean) => Promise<void> }).fetchHistory({ id: 'C1' }, true);
  const msgs = store.listMessages('slack:1/C1', 50);
  const parent = msgs.find((m) => m.remoteId === '1700000002.000200')!;
  assert.equal(parent.text, 'Selam @ume bak burası (https://x.com)');
  assert.ok(parent.attachments?.[0].url?.startsWith('/api/media/slack%3A1?u=https%3A%2F%2Ffiles.slack.com'), 'dosya vekilden');
  assert.deepEqual(parent.reactions?.map((r) => [r.emoji, r.fromMe]), [['👍', true], ['👍', false]]);
  assert.equal(parent.replyCount, 1);
  assert.ok(!msgs.some((m) => m.text === 'katıldı'), 'sistem alt türü atlanır');
  const reply = msgs.find((m) => m.remoteId === '1700000003.000000')!;
  assert.equal(reply.threadId, '1700000002.000200');
  assert.equal(reply.fromMe, true);

  await c.sendText('C1', 'yanıt', { threadId: '1700000002.000200' });
  assert.deepEqual(calls.find((x) => x[0] === 'postMessage')![1], { channel: 'C1', text: 'yanıt', thread_ts: '1700000002.000200' });
  await c.react('C1', '1700000002.000200', '❤️', false);
  assert.deepEqual(calls.find((x) => x[0] === 'reactions.add')![1], { channel: 'C1', timestamp: '1700000002.000200', name: 'heart' });
  await c.markRead('C1');
  assert.equal(calls.find((x) => x[0] === 'mark')![1].channel, 'C1');
  await c.loadHistory('C1', 50, 1700000002000);
  assert.equal(calls.filter((x) => x[0] === 'history').at(-1)![1].latest, '1700000002.000000');
  assert.equal(await c.openDirect({ id: 'U1', name: 'Ayşe' }), 'D9');
});

// ───────────── Resmi giriş (Mivelo Slack uygulaması, OAuth) ─────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Priv = Record<string, any>;
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const slackAccount = (id: string) => ({ id, platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 }) as { id: string; platform: 'slack'; label: string; status: string; detail?: string; createdAt: number };

test('parseSlackToken: resmi giriş alanları; eski biçimler aynen', () => {
  const j = { token: 'xoxe.xoxp-1-a', oauth: 'slack', teamId: 'T1', team: 'Ekip', userId: 'U1', refreshToken: 'xoxe-1-r', expiresAt: 1_800_000_000_000, historyLimited: true };
  assert.deepEqual(parseSlackToken(JSON.stringify(j)), { ...j, appToken: undefined });
  // resmi girişte historyLimited yazılmamışsa sınırlı sayılır; açıkça false ise sınırsız
  assert.equal(parseSlackToken(JSON.stringify({ token: 'xoxp-1', oauth: 'slack' }))!.historyLimited, true);
  assert.equal(parseSlackToken(JSON.stringify({ token: 'xoxp-1', oauth: 'slack', historyLimited: false }))!.historyLimited, false);
  assert.deepEqual(parseSlackToken('xoxp-1-abc'), { token: 'xoxp-1-abc' });
  assert.deepEqual(parseSlackToken(JSON.stringify({ token: 'xoxp-1', appToken: 'xapp-1-A' })), { token: 'xoxp-1', appToken: 'xapp-1-A' });
});

/**
 * Marketplace dışı dağıtılan uygulama: conversations.history/replies dakikada 1 istek, ≤15 mesaj. Tek kuyruk: okunmamış birebir >
 * birebir > kanal > iş parçacığı; aralar ≥61 sn; 429'da Retry-After kadar beklenir.
 */
test('slack resmi (sınırlı): history/replies tek kuyrukta ≥61 sn arayla, ≤15 mesaj; 429 → Retry-After; yanıtlar en sonda', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  try {
    const store = new Store(path.join(tmp, 'lim.db'));
    const account = slackAccount('slack:lim');
    store.upsertAccount(account as never);
    const c = new SlackConnector(account as never, store, 'xoxp-test', undefined, { historyLimited: true, official: true }) as unknown as Priv;
    const t0 = Date.now() / 1000;
    const calls: Array<{ m: string; at: number; ch: string; limit: number }> = [];
    let hist = 0;
    const fake = {
      users: {
        info: async () => ({ user: { real_name: 'Ayşe', name: 'ayse' } }),
        conversations: async () => ({ channels: [{ id: 'C1', is_channel: true, name: 'genel' }, { id: 'D1', is_im: true, user: 'U1' }, { id: 'D2', is_im: true, user: 'U2' }] }),
      },
      conversations: {
        info: async ({ channel }: { channel: string }) => ({
          channel: { id: channel, num_members: 40, latest: { ts: (t0 + 5).toFixed(6), user: 'U1', text: `son ${channel}` }, unread_count_display: channel === 'D2' ? 2 : 0 },
        }),
        history: async (a: { channel: string; limit: number }) => {
          calls.push({ m: 'history', at: Date.now(), ch: a.channel, limit: a.limit });
          if (++hist === 2) throw Object.assign(new Error('rate'), { code: 'slack_webapi_rate_limited_error', retryAfter: 120 });
          return {
            messages: [
              { ts: (t0 + 5).toFixed(6), user: 'U1', text: `son ${a.channel}`, ...(a.channel === 'D2' ? { reply_count: 1, latest_reply: (t0 + 6).toFixed(6) } : {}) },
              { ts: (t0 - 50).toFixed(6), user: 'U1', text: 'önceki' },
            ],
          };
        },
        replies: async (a: { channel: string; ts: string; limit: number }) => (
          calls.push({ m: 'replies', at: Date.now(), ch: a.channel, limit: a.limit }), { messages: [{ ts: a.ts }, { ts: (t0 + 6).toFixed(6), user: 'U2', text: 'yanıt' }] }
        ),
      },
    };
    c.web = fake;
    c.poller = fake;
    c.meId = 'UME';
    await c.poll(true);
    for (let i = 0; i < 900 && calls.length < 5; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.deepEqual(
      calls.map((x) => `${x.m}:${x.ch}`),
      ['history:D2', 'history:D1', 'history:D1', 'history:C1', 'replies:D2'],
      'okunmamış birebir önce, 429 alan yeniden, kanal sonra, iş parçacığı en sonda',
    );
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 61_000, `istekler arası ≥61 sn (${i}: ${calls[i].at - calls[i - 1].at} ms)`);
    assert.ok(calls[2].at - calls[1].at >= 120_000, '429 → Retry-After (120 sn)');
    assert.ok(calls.every((x) => x.limit === 15), 'istek başına ≤15 mesaj');
    assert.deepEqual(store.listMessages('slack:lim/D1', 10).map((m) => m.text), ['önceki', 'son D1']);
    assert.ok(store.listMessages('slack:lim/D2', 10).some((m) => m.text === 'yanıt' && m.threadId === (t0 + 5).toFixed(6)));
    await c.stop();
  } finally {
    mock.timers.reset();
  }
});

test('slack resmi (sınırlı): conversations.info latest önizlemeye hemen yazılır; başka cihazda okunan sıfırlanır; eski mesaj isteği sırayı beklerse timedOut', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_500_000 });
  try {
    const store = new Store(path.join(tmp, 'info.db'));
    const account = slackAccount('slack:info');
    store.upsertAccount(account as never);
    const c = new SlackConnector(account as never, store, 'xoxp-test', undefined, { historyLimited: true, official: true }) as unknown as Priv;
    const t0 = Date.now() / 1000;
    // başka cihazda okunacak sohbet: Mivelo'da 3 okunmamış
    c.upsertChat({ remoteId: 'D2', name: 'Can', kind: 'direct', unread: 3, lastMessageAt: Math.floor((t0 - 100) * 1000), lastPreview: 'eski' });
    const info: Record<string, object> = {
      D1: { latest: { ts: (t0 - 30).toFixed(6), user: 'U1', text: 'merhaba' }, unread_count_display: 1, last_read: (t0 - 60).toFixed(6) },
      D2: { latest: { ts: (t0 - 100).toFixed(6), user: 'U2', text: 'eski' }, unread_count_display: 0, last_read: (t0 - 100).toFixed(6) },
      C1: { num_members: 30, latest: { ts: (t0 - 20).toFixed(6), user: 'U1', text: 'duyuru' }, unread_count_display: 0, last_read: (t0 - 20).toFixed(6) },
    };
    const hist: Array<{ channel: string; limit: number; latest?: string }> = [];
    const fake = {
      users: {
        info: async ({ user }: { user: string }) => ({ user: { real_name: user === 'U1' ? 'Ayşe' : 'Can', name: user.toLowerCase() } }),
        conversations: async () => ({ channels: [{ id: 'D1', is_im: true, user: 'U1' }, { id: 'D2', is_im: true, user: 'U2' }, { id: 'C1', is_channel: true, name: 'genel' }] }),
      },
      conversations: {
        info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, ...info[channel] } }),
        history: async (a: { channel: string; limit: number; latest?: string }) => (hist.push(a), { messages: [] }),
      },
    };
    c.web = fake;
    c.poller = fake;
    c.meId = 'UME';
    await c.poll(true);
    assert.equal(hist.length, 0, 'önizleme history beklemeden');
    const d1 = store.getChat('slack:info/D1')!;
    assert.equal(d1.lastPreview, 'merhaba');
    assert.equal(d1.lastMessageAt, Math.floor((t0 - 30) * 1000));
    assert.equal(store.getChat('slack:info/C1')!.lastPreview, 'Ayşe: duyuru');
    assert.equal(store.getChat('slack:info/D2')!.unread, 0, 'Slack: başka cihazda okundu');
    assert.equal(c.nextJob().key, 'h:D1', 'okunmamış birebir kuyruğun başında');

    mock.timers.tick(1);
    await flush();
    assert.deepEqual(hist.map((h) => h.channel), ['D1']);
    // sıra dolu (≥61 sn): yukarı kaydırma isteği öne geçer ama 20 sn'de gelmezse arayüze timedOut
    const p = c.loadHistory('C1', 50, (t0 - 20) * 1000);
    for (let i = 0; i < 21; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.deepEqual(await p, { timedOut: true });
    for (let i = 0; i < 60 && hist.length < 2; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.equal(hist[1].channel, 'C1');
    assert.equal(hist[1].latest, (t0 - 20).toFixed(6), 'eski mesaj isteği diğer sohbetlerin önünde');
    assert.equal(hist[1].limit, 15);
    await c.stop();
  } finally {
    mock.timers.reset();
  }
});

test('slack resmi: belirteç döndürme dosyaya yazılır, etiket "Slack · <ekip>"; yenileme reddedilince / belirteç iptal olunca oturum sona erdi', async () => {
  const store = new Store(path.join(tmp, 'rot.db'));

  // 1) süresi dolmak üzere: açılışta yenilenir, yeni belirteç dosyaya (0600) ve istemcilere
  const a1 = slackAccount('slack:rot');
  store.upsertAccount(a1 as never);
  const file = path.join(sessionDir(a1.id), 'token');
  fs.writeFileSync(file, JSON.stringify({ token: 'xoxe.xoxp-eski', oauth: 'slack', teamId: 'T1', team: 'Ekip', refreshToken: 'xoxe-1-eski', expiresAt: Date.now() + 60_000, historyLimited: false }), { mode: 0o600 });
  const tok = parseSlackToken(fs.readFileSync(file, 'utf8'))!;
  const fake = {
    auth: { test: async () => ({ user_id: 'UME', user: 'kaan', team: 'Ekip' }) },
    users: { conversations: async () => ({ channels: [] }) },
    conversations: { history: async () => ({ messages: [] }) },
  };
  const c1 = new SlackConnector(a1 as never, store, tok.token, undefined, { historyLimited: tok.historyLimited, official: tok.oauth === 'slack', team: tok.team, refresh: { token: tok.refreshToken!, expiresAt: tok.expiresAt } }) as unknown as Priv;
  const made: string[] = [];
  const asked: string[] = [];
  c1.web = fake;
  c1.makeClient = (t: string) => (made.push(t), fake);
  c1.renewToken = async (r: string) => (asked.push(r), { accessToken: 'xoxe.xoxp-yeni', refreshToken: 'xoxe-1-yeni', expiresAt: Date.now() + 12 * 3600_000, raw: {} });
  await c1.start();
  assert.deepEqual(asked, ['xoxe-1-eski']);
  assert.deepEqual(made, ['xoxe.xoxp-yeni'], 'sınırsız kip: yalnız ana istemci yeniden kurulur');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.token, 'xoxe.xoxp-yeni');
  assert.equal(saved.refreshToken, 'xoxe-1-yeni');
  assert.ok(Number(saved.expiresAt) > Date.now() + 11 * 3600_000);
  assert.equal(saved.team, 'Ekip', 'diğer alanlar korunur');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(a1.status, 'connected');
  assert.equal(a1.label, 'Slack · Ekip');
  assert.ok(c1.refreshTimer, 'sonraki yenileme zamanlandı');
  await c1.stop();

  // 2) yenileme belirteci de reddedildi: oturum sona erdi, yoklama başlamaz
  const a2 = slackAccount('slack:rev');
  store.upsertAccount(a2 as never);
  let authCalls = 0;
  const c2 = new SlackConnector(a2 as never, store, 'xoxe.xoxp-x', undefined, { historyLimited: true, official: true, refresh: { token: 'xoxe-1-x', expiresAt: Date.now() - 1000 } }) as unknown as Priv;
  c2.web = c2.poller = { auth: { test: async () => (authCalls++, { user_id: 'U' }) } };
  c2.renewToken = async () => {
    throw new OAuthError('invalid_refresh_token', 'invalid_refresh_token');
  };
  await c2.start();
  assert.equal(a2.status, 'error');
  assert.equal(a2.detail, 'Slack oturumu sona erdi — yeniden giriş yap');
  assert.equal(store.getAccount('slack:rev')!.detail, 'Slack oturumu sona erdi — yeniden giriş yap');
  assert.equal(authCalls, 0);
  assert.equal(c2.timer, undefined, 'yoklama yok');
  assert.equal(c2.stopped, true);

  // 3) çalışırken belirteç iptal (token_revoked), yenileme belirteci yok: oturum sona erdi
  const revoked = async () => {
    throw Object.assign(new Error('An API error occurred: token_revoked'), { data: { error: 'token_revoked' } });
  };
  const f3 = { auth: { test: async () => ({ user_id: 'U', team: 'Ekip' }) }, users: { conversations: revoked }, conversations: { history: revoked } };
  const a3 = slackAccount('slack:iptal');
  store.upsertAccount(a3 as never);
  const c3 = new SlackConnector(a3 as never, store, 'xoxp-y', undefined, { historyLimited: true, official: true }) as unknown as Priv;
  c3.web = c3.poller = f3;
  await c3.start();
  assert.equal(a3.detail, 'Slack oturumu sona erdi — yeniden giriş yap');
  assert.equal(c3.timer, undefined);

  // 4) eski (kendi uygulaması) belirteci: aynı hata durumu değiştirmez (davranış aynı)
  const a4 = slackAccount('slack:eski');
  store.upsertAccount(a4 as never);
  const c4 = new SlackConnector(a4 as never, store, 'xoxp-z') as unknown as Priv;
  c4.web = f3;
  await c4.start();
  assert.equal(a4.status, 'connected');
  assert.equal(a4.label, 'slack @ Ekip');
  await c4.stop();
});
