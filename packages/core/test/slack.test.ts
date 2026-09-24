import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { slackStrategy, formatSlackText, fileToAttachment, _resetSlackState } from '../src/connectors/browser/slack.js';

/** Sahte sayfa: slack() çağrılarını (args.method) sabit yanıtlarla karşılar, team() için localConfig döner. */
function fakePage(handlers: Record<string, (params: Record<string, unknown>) => unknown>, calls: Array<{ method: string; params: Record<string, unknown> }> = []): Page {
  return {
    isClosed: () => false,
    url: () => 'https://app.slack.com/client/T1/C1',
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, args?: { method?: string; params?: Record<string, unknown> }) => {
      if (!args?.method) return { token: 'xoxc-test', domain: 'ws', name: 'Test WS', userId: 'U_ME' };
      calls.push({ method: args.method, params: args.params ?? {} });
      const h = handlers[args.method];
      if (!h) throw new Error(`Slack ${args.method}: beklenmeyen çağrı`);
      return { ok: true, ...(h(args.params ?? {}) as object) };
    },
  } as unknown as Page;
}

const USERS: Record<string, unknown> = {
  U_ME: { user: { id: 'U_ME', name: 'kaan', real_name: 'Kaan Tiftikçi', profile: { image_72: 'https://avatars.slack-edge.com/me.png' } } },
  U_AYSE: { user: { id: 'U_AYSE', name: 'ayse', real_name: 'Ayşe Yılmaz', profile: { image_72: 'https://avatars.slack-edge.com/ayse.png' } } },
};

test('formatSlackText: mention, kanal, bağlantı ve HTML kaçışları', () => {
  const names = new Map([['U_AYSE', { name: 'Ayşe Yılmaz', handle: '@ayse' }]]);
  assert.equal(formatSlackText('Selam <@U_AYSE>, <#C1|genel> kanalına bak: <https://x.com/a|şu bağlantı> &amp; <https://y.com>', names), 'Selam @ayse, #genel kanalına bak: şu bağlantı (https://x.com/a) & https://y.com');
  assert.equal(formatSlackText('<!channel> toplantı <@U_BILINMEYEN>', names), '@channel toplantı @U_BILINMEYEN');
});

test('fileToAttachment: görsel/ses/dosya türleri ve bağlantılar', () => {
  const img = fileToAttachment({ mimetype: 'image/png', title: 'ekran.png', size: 1234, url_private: 'https://files.slack.com/a.png', url_private_download: 'https://files.slack.com/a.png?download', permalink: 'https://ws.slack.com/files/x' });
  assert.equal(img.kind, 'image');
  assert.equal(img.url, 'https://files.slack.com/a.png');
  assert.equal(img.link, 'https://files.slack.com/a.png?download');
  const voice = fileToAttachment({ mimetype: 'audio/webm', subtype: 'slack_audio', aac: 'https://files.slack.com/v.aac' });
  assert.equal(voice.kind, 'audio');
  assert.equal(voice.link, 'https://files.slack.com/v.aac');
  assert.equal(voice.name, 'Sesli mesaj');
  assert.equal(fileToAttachment({ mimetype: 'application/pdf', name: 'rapor.pdf' }).kind, 'file');
});

test('threads: DM/grup/kanal adları tek listeden, okunmamış sayısı ve son okunan ts', async () => {
  _resetSlackState();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const page = fakePage(
    {
      'client.counts': () => ({
        ims: [{ id: 'D1', latest: '1700000010.000100', last_read: '1700000000.000000', has_unreads: true, mention_count: 3 }],
        mpims: [{ id: 'G1', latest: '1700000020.000100', has_unreads: true, mention_count: 0 }],
        channels: [
          { id: 'C1', latest: '1700000030.000100', has_unreads: true, mention_count: 0 },
          { id: 'C2', latest: '1700000040.000100', has_unreads: false, mention_count: 0, is_member: false },
        ],
      }),
      'conversations.list': () => ({
        channels: [
          { id: 'D1', is_im: true, user: 'U_AYSE' },
          { id: 'G1', is_mpim: true, name: 'mpdm-kaan--ayse--ali-1', members: ['U_ME', 'U_AYSE', 'U_ALI'] },
          { id: 'C1', name: 'genel' },
          { id: 'C2', name: 'duyurular' },
        ],
        response_metadata: { next_cursor: '' },
      }),
      'users.info': (p) => USERS[String(p.user)] ?? { user: { id: p.user, name: String(p.user) } },
    },
    calls,
  );
  await slackStrategy.me(page, {});
  const threads = await slackStrategy.threads(page, {});
  assert.deepEqual(
    threads.map((t) => [t.id, t.name, t.kind, t.unread, t.lastTs]),
    [
      ['D1', 'Ayşe Yılmaz', 'direct', 3, 1700000010000],
      ['G1', '@kaan, @ayse, @ali', 'group', 1, 1700000020000],
      ['C1', '#genel', 'channel', 1, 1700000030000],
    ],
  );
  assert.equal(threads[0].handle, '@ayse');
  assert.equal(threads[0].participants?.[0].id, 'U_AYSE');
  // conversations.info hiç çağrılmadı (adlar listeden geldi)
  assert.equal(calls.filter((c) => c.method === 'conversations.info').length, 0);
});

test('messages: biçimlendirme, bot mesajı, dosya eki, sistem alt türleri elenir, fromMe', async () => {
  _resetSlackState();
  const page = fakePage({
    'users.info': (p) => USERS[String(p.user)] ?? { user: { id: p.user, name: String(p.user) } },
    'conversations.history': () => ({
      messages: [
        { ts: '1700000003.000000', user: 'U_AYSE', text: 'Şunu gördün mü <@U_ME>?', files: [{ mimetype: 'image/jpeg', name: 'foto.jpg', url_private: 'https://files.slack.com/f.jpg' }] },
        { ts: '1700000002.000000', subtype: 'bot_message', bot_id: 'B1', username: 'Deploy Bot', text: 'Yayın tamam' },
        { ts: '1700000001.500000', subtype: 'channel_join', user: 'U_AYSE', text: 'Ayşe kanala katıldı' },
        { ts: '1700000001.000000', user: 'U_ME', text: 'merhaba &lt;3' },
      ],
    }),
  });
  await slackStrategy.me(page, {});
  const msgs = await slackStrategy.messages(page, {}, 'C1', 20);
  assert.deepEqual(
    msgs.map((m) => [m.id, m.fromMe, m.senderName, m.text, m.attachments?.[0]?.kind]),
    [
      ['1700000001.000000', true, 'Kaan Tiftikçi', 'merhaba <3', undefined],
      ['1700000002.000000', false, 'Deploy Bot', 'Yayın tamam', undefined],
      ['1700000003.000000', false, 'Ayşe Yılmaz', 'Şunu gördün mü @kaan?', 'image'],
    ],
  );
  assert.equal(msgs[2].ts, 1700000003000);
});

test('messages(before): latest=before saniye, inclusive=false; markRead → conversations.mark', async () => {
  _resetSlackState();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const page = fakePage(
    {
      'conversations.history': () => ({ messages: [] }),
      'conversations.mark': () => ({}),
    },
    calls,
  );
  await slackStrategy.messages(page, {}, 'D1', 50, 1700000003000);
  const hist = calls.find((c) => c.method === 'conversations.history')!;
  assert.equal(hist.params.latest, '1700000003.000000');
  assert.equal(hist.params.inclusive, false);
  await slackStrategy.markRead!(page, {}, 'D1', '1700000009.000100');
  const mark = calls.find((c) => c.method === 'conversations.mark')!;
  assert.deepEqual(mark.params, { channel: 'D1', ts: '1700000009.000100' });
});
