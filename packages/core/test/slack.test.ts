import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { slackStrategy, formatSlackText, fileToAttachment, apiUrls, _resetSlackState } from '../src/connectors/browser/slack.js';

/** Sahte sayfa: slack() çağrılarını (args.method) sabit yanıtlarla karşılar, team() için localConfig döner. */
function fakePage(handlers: Record<string, (params: Record<string, unknown>) => unknown>, calls: Array<{ method: string; params: Record<string, unknown> }> = []): Page {
  return {
    isClosed: () => false,
    url: () => 'https://app.slack.com/client/T1/C1',
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, args?: { method?: string; params?: Record<string, unknown>; urls?: string[] }) => {
      if (!args?.method) return { token: 'xoxc-test', domain: 'ws', name: 'Test WS', userId: 'U_ME', url: 'https://ws.slack.com/' };
      calls.push({ method: args.method, params: args.params ?? {} });
      const h = handlers[args.method];
      if (!h) throw new Error(`Slack ${args.method}: beklenmeyen çağrı`);
      return { j: { ok: true, ...(h(args.params ?? {}) as object) }, idx: 0 };
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

test('apiUrls: web istemcisinin host\'u + _x_gantry (CORS: kaynak yansıtılır), yedek app.slack.com aynı-kaynak', () => {
  _resetSlackState();
  const now = 1790246809465;
  // öğrenilmiş parametre yok: çalışma alanı adresi + _x_id + _x_gantry=true
  assert.deepEqual(apiUrls({ domain: 'ws', url: 'https://ws.slack.com/' }, 'client.counts', { base: '', query: {} }, now), [
    'https://ws.slack.com/api/client.counts?_x_id=noversion-1790246809.465&_x_gantry=true',
    'https://app.slack.com/api/client.counts',
  ]);
  // url yoksa domain'den; web istemcisinden öğrenilen sabit parametreler eklenir
  const [u] = apiUrls({ domain: 'ws', url: '' }, 'auth.test', { base: 'https://ws.slack.com/api/', query: { _x_version_ts: '1790232454', fp: 'ef' } }, now);
  assert.equal(u, 'https://ws.slack.com/api/auth.test?_x_id=noversion-1790246809.465&_x_version_ts=1790232454&fp=ef&_x_gantry=true');
  // başka çalışma alanından öğrenilmiş host kullanılmaz
  assert.ok(apiUrls({ domain: 'ws', url: 'https://ws.slack.com/' }, 'auth.test', { base: 'https://baska.slack.com/api/', query: {} }, now)[0].startsWith('https://ws.slack.com/api/'));
  // hiç bilgi yoksa yalnız aynı-kaynak
  assert.deepEqual(apiUrls({ domain: '', url: '' }, 'auth.test', { base: '', query: {} }, now), ['https://app.slack.com/api/auth.test']);
});

test('oturum anahtarı: localConfig_v2 "teams": {} (2026 web istemcisi) → web istemcisinin kendi isteğinden yakalanır', async () => {
  const { parseTeam, learnFromRequest, tokenFromBody } = await import('../src/connectors/browser/slack.js');
  _resetSlackState();
  const cfg = JSON.stringify({ teams: {}, prevTeams: { T1: { id: 'T1', name: 'Test WS', domain: 'ws', url: 'https://ws.slack.com/', user_id: 'U_ME' } }, lastActiveTeamId: 'T1' });
  // eskiden: anahtar yok → "Slack oturumu bulunamadı"
  assert.equal(parseTeam(cfg), undefined);
  const body = '------B\r\nContent-Disposition: form-data; name="token"\r\n\r\nxoxc-111-222-333-abc\r\n------B--\r\n';
  assert.equal(tokenFromBody(body), 'xoxc-111-222-333-abc');
  assert.equal(tokenFromBody('channel=C1&token=xoxc-9-8-7&limit=1'), 'xoxc-9-8-7');
  // kendi _x_id'li olmayan istek (ör. statik dosya) öğrenilmez
  learnFromRequest('https://ws.slack.com/api/client.counts', body);
  assert.equal(parseTeam(cfg), undefined);
  learnFromRequest('https://ws.slack.com/api/client.counts?_x_id=abc12345-1790000000.100&slack_route=T1&_x_gantry=true', body);
  assert.deepEqual(parseTeam(cfg), { token: 'xoxc-111-222-333-abc', domain: 'ws', name: 'Test WS', userId: 'U_ME', url: 'https://ws.slack.com/', source: 'istek' });
  // anahtar localConfig'te varsa o kullanılır
  const full = JSON.stringify({ teams: { T1: { token: 'xoxc-local', domain: 'ws', name: 'WS', user_id: 'U1', url: 'https://ws.slack.com/' } }, lastActiveTeamId: 'T1' });
  assert.equal(parseTeam(full)?.token, 'xoxc-local');
  // hiç localConfig yok: yakalanan istek adresinden
  assert.equal(parseTeam(null)?.url, 'https://ws.slack.com/');
  _resetSlackState();
});

test('messages: metni boş, içeriği yalnız bloklarda/eklerde olan mesajlar eskiden atılıyordu', async () => {
  _resetSlackState();
  const page = fakePage({
    'users.info': (p) => USERS[String(p.user)] ?? { user: { id: p.user, name: String(p.user) } },
    'conversations.history': () => ({
      messages: [
        {
          ts: '1700000002.000000',
          user: 'U_AYSE',
          text: '',
          blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Toplantı ' }, { type: 'user', user_id: 'U_ME' }, { type: 'emoji', name: 'tada', unicode: '1f389' }] }] }],
        },
        { ts: '1700000001.000000', bot_id: 'B1', subtype: 'bot_message', username: 'CI', text: '', attachments: [{ fallback: 'Derleme başarılı' }] },
      ],
    }),
  });
  await slackStrategy.me(page, {});
  const msgs = await slackStrategy.messages(page, {}, 'D1', 20);
  assert.deepEqual(
    msgs.map((m) => [m.senderName, m.text]),
    [
      ['CI', 'Derleme başarılı'],
      ['Ayşe Yılmaz', 'Toplantı @kaan🎉'],
    ],
  );
});

test('threads: önizleme son alınan üst düzey mesajdan (client.counts önizleme vermez); kanalda "Ad: metin"', async () => {
  _resetSlackState();
  const page = fakePage({
    'client.counts': () => ({ ims: [{ id: 'D1', latest: '1700000010.000000' }], mpims: [], channels: [{ id: 'C1', latest: '1700000099.000000' }] }),
    'conversations.list': () => ({ channels: [{ id: 'D1', is_im: true, user: 'U_AYSE' }, { id: 'C1', name: 'genel' }] }),
    'users.info': (p) => USERS[String(p.user)] ?? { user: { id: p.user, name: String(p.user) } },
    'conversations.history': (p) =>
      p.channel === 'D1'
        ? { messages: [{ ts: '1700000010.000000', user: 'U_AYSE', text: 'selam' }] }
        : // kanalın son etkinliği (latest) bir katılma iletisi: depo önizlemeyi mesaj zamanından eski diye hiç yazmıyordu
          { messages: [{ ts: '1700000099.000000', subtype: 'channel_join', user: 'U_X', text: 'katıldı' }, { ts: '1700000050.000000', user: 'U_AYSE', text: 'duyuru var' }] },
  });
  await slackStrategy.me(page, {});
  assert.deepEqual((await slackStrategy.threads(page, {})).map((t) => t.preview), ['', '']);
  await slackStrategy.messages(page, {}, 'D1', 25);
  await slackStrategy.messages(page, {}, 'C1', 25);
  assert.deepEqual((await slackStrategy.threads(page, {})).map((t) => t.preview), ['selam', 'Ayşe: duyuru var']);
});

test('sayfasız: tek ağ hatası app.slack.com\'a kalıcı kilitlemez; aynı-kaynak uç reddederse çalışma alanı adresi denenir; ad hatası önbelleğe', async () => {
  _resetSlackState();
  const cfg = JSON.stringify({ teams: { T1: { token: 'xoxc-t', domain: 'ws', name: 'WS', user_id: 'U_ME', url: 'https://ws.slack.com/' } }, lastActiveTeamId: 'T1' });
  const hits: string[] = [];
  let netDown = true;
  const post = async (url: string, o: { multipart: Record<string, string> }) => {
    const m = url.match(/^https:\/\/([a-z.]+)\/api\/([\w.]+)/)!;
    hits.push(`${m[1]} ${m[2]}`);
    if (m[1] === 'ws.slack.com' && netDown) throw new Error('getaddrinfo ENOTFOUND ws.slack.com');
    const json = (j: object, status = 200) => ({ status: () => status, headers: () => ({}), json: async () => j });
    if (m[2] === 'users.info') return json({ ok: false, error: 'user_not_found' });
    // app.slack.com sayaçları verir ama geçmişi vermez (yönlendirme yok)
    if (m[1] === 'app.slack.com' && m[2] === 'conversations.history') return json({ ok: false, error: 'invalid_auth' });
    if (m[2] === 'conversations.history') return json({ ok: true, messages: [{ ts: '1700000001.000000', user: 'U_EXT', text: `merhaba ${o.multipart.channel}` }] });
    return json({ ok: true, ims: [], mpims: [], channels: [] });
  };
  const page = { __api: { api: { post }, state: { cookies: [], origins: [{ origin: 'https://app.slack.com', localStorage: [{ name: 'localConfig_v2', value: cfg }] }] } } } as unknown as Page;
  await slackStrategy.threads(page, {}); // ws.slack.com'a ulaşılamadı → app.slack.com çalıştı
  netDown = false;
  hits.length = 0;
  const msgs = await slackStrategy.messages(page, {}, 'D1', 25);
  assert.equal(msgs[0]?.text, 'merhaba D1', 'geçmiş çalışma alanı adresinden alındı');
  assert.deepEqual(hits.filter((h) => h.endsWith('conversations.history')), ['app.slack.com conversations.history', 'ws.slack.com conversations.history']);
  // adı alınamayan kullanıcı her mesajda/turda yeniden istenmez
  await slackStrategy.messages(page, {}, 'D1', 25);
  assert.equal(hits.filter((h) => h.endsWith('users.info')).length, 1);
  _resetSlackState();
});
