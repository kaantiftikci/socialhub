import type { Page } from 'playwright';
import type { Attachment, Reaction } from '../../model.js';
import type { SendOptions } from '../base.js';
import { apiOf, needsPage, type Msg, type Strategy, type Thread } from './bridge.js';

/**
 * Slack (tarayıcı oturumu): Slack'e bir kez giriş yapılır; web istemcisinin
 * localStorage'da tuttuğu xoxc- oturum anahtarı + "d" çerezi ile Slack Web API'si
 * sayfa bağlamından çağrılır. Uygulama oluşturmak / token üretmek gerekmez.
 *
 * Giriş akışı (gözlemlenen): app.slack.com/client oturum yokken "workspace-signin" (çalışma alanı URL'si sor)
 * sayfasına düşer; oradaki "Find your workspaces" bağlantısı get-started (KAYIT) akışına gider — Google ile
 * girildiğinde e-postaya bağlı çalışma alanı yoksa "yeni çalışma alanı oluştur" ekranında kalır, "d" çerezi
 * hiç oluşmaz. Bu yüzden giriş penceresi slack.com/signin (GİRİŞ akışı: e-posta kodu / Google / Apple →
 * çalışma alanı listesi → Aç) ile açılır. Bir çalışma alanı açılınca .slack.com'a "d" çerezi yazılır;
 * app.slack.com/client → gantry/auth bu çerezden oturumu alıp localConfig_v2'yi (xoxc token) doldurur.
 *
 * Veri akışı: client.counts (okunmamış/son etkinlik) + conversations.list (adlar, tek çağrı) → sohbet listesi;
 * conversations.history → mesajlar (before ile eski sayfalar); conversations.mark → okundu.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Web istemcisi: localConfig_v2 yalnızca bu origin'in localStorage'ında bulunur. */
const CLIENT = 'https://app.slack.com/client';
/** Giriş sayfası; redir → gantry/auth: çalışma alanı seçilince doğrudan web istemcisine geçer ("uygulamada aç" ara sayfası atlanır). */
const SIGNIN = 'https://slack.com/signin?redir=%2Fgantry%2Fauth%3Fapp%3Dclient%26return_to%3D%252Fclient';

interface TeamCfg {
  token: string;
  domain: string;
  name: string;
  userId: string;
  /** Çalışma alanı adresi (https://<ws>.slack.com/) — web istemcisi API'yi buradan çağırır */
  url: string;
}

/**
 * Web istemcisinin kendi API isteklerinden öğrenilen host ve sabit sorgu parametreleri.
 * Neden gerekli: slack.com/api ve <ws>.slack.com/api, `_x_gantry=true` işareti olmayan isteklere
 * `Access-Control-Allow-Origin: *` döner; `credentials: 'include'` (d çerezi şart) ile joker kaynak
 * tarayıcıda CORS hatasına düşer → "TypeError: Failed to fetch". Web istemcisi (app.slack.com) istekleri
 * https://<ws>.slack.com/api/<method>?_x_id=…&_x_gantry=true&… ile yapar; sunucu o zaman kaynağı
 * (https://app.slack.com) + Allow-Credentials: true yansıtır.
 */
const KEEP_QUERY = ['_x_version_ts', '_x_frontend_build_type', '_x_desktop_ia', '_x_gantry', 'fp'];
const learned = { base: '', query: {} as Record<string, string> };
const watched = new WeakSet<Page>();
/** app.slack.com'un aynı-kaynak /api/ ucu çalıştıysa (çapraz kaynak başarısız) doğrudan onu kullan */
let sameOriginOnly = false;

function watchClientRequests(page: Page): void {
  if (watched.has(page) || typeof (page as { on?: unknown }).on !== 'function') return;
  watched.add(page);
  page.on('request', (req) => {
    const m = req.url().match(/^(https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/api\/)[\w.]+\?(.*)$/);
    if (!m || !m[2].includes('_x_id=')) return;
    learned.base = m[1];
    const q = new URLSearchParams(m[2]);
    const keep: Record<string, string> = {};
    for (const k of KEEP_QUERY) {
      const v = q.get(k);
      if (v) keep[k] = v;
    }
    learned.query = keep;
  });
}

/** Denenecek API adresleri (sırayla): web istemcisinin host'u + _x_ parametreleri, sonra app.slack.com aynı-kaynak /api/ */
export function apiUrls(t: Pick<TeamCfg, 'domain' | 'url'>, method: string, learnedCfg: { base: string; query: Record<string, string> } = learned, now = Date.now()): string[] {
  const sameOrigin = `https://app.slack.com/api/${method}`;
  const teamBase = t.url ? t.url.replace(/\/?$/, '/') + 'api/' : t.domain ? `https://${t.domain}.slack.com/api/` : '';
  // öğrenilen host yalnızca bu çalışma alanınınsa (çoklu çalışma alanında başka takımın host'u değil)
  const base = learnedCfg.base && (!teamBase || learnedCfg.base === teamBase) ? learnedCfg.base : teamBase;
  if (!base || sameOriginOnly) return [sameOrigin];
  const q = new URLSearchParams({ _x_id: `kavsak-${(now / 1000).toFixed(3)}`, ...learnedCfg.query, _x_gantry: 'true' });
  return [`${base}${method}?${q}`, sameOrigin];
}

/** localStorage'daki localConfig_v2 → etkin çalışma alanı (sayfada ve sayfasız modda ortak) */
export function parseTeam(raw: string | null | undefined): TeamCfg | undefined {
  try {
    if (!raw) return undefined;
    const cfg = JSON.parse(raw) as { teams?: Record<string, { token?: string; domain?: string; name?: string; user_id?: string; url?: string }>; lastActiveTeamId?: string };
    const teams = Object.values(cfg.teams ?? {});
    const t = (cfg.lastActiveTeamId && cfg.teams?.[cfg.lastActiveTeamId]) || teams.find((x) => x.token?.startsWith('xoxc'));
    if (!t?.token) return undefined;
    return { token: t.token, domain: t.domain ?? '', name: t.name ?? 'Slack', userId: t.user_id ?? '', url: t.url ?? '' };
  } catch {
    return undefined;
  }
}

async function team(page: Page): Promise<TeamCfg | undefined> {
  const h = apiOf(page);
  if (h) {
    const o = h.state.origins.find((x) => x.origin === 'https://app.slack.com');
    return parseTeam(o?.localStorage.find((e) => e.name === 'localConfig_v2')?.value);
  }
  if (page.isClosed() || !page.url().startsWith('https://app.slack.com/')) return undefined;
  watchClientRequests(page);
  const raw = await page.evaluate(() => {
    try {
      return localStorage.getItem('localConfig_v2');
    } catch {
      return null;
    }
  });
  // testlerdeki sahte sayfa doğrudan ayrıştırılmış nesne döndürür
  return typeof raw === 'string' || raw == null ? parseTeam(raw) : (raw as TeamCfg);
}

/**
 * Web istemcisini yükle: app.slack.com/client → gantry/auth, "d" çerezindeki oturumu alıp localConfig_v2'yi
 * doldurur ve /client/T… adresine geçer. Çalışma alanı alt alanında (<ws>.slack.com, "uygulamada aç" ekranı)
 * ya da slack.com/signin'de kalınmışsa oturum bilgisi ancak böyle okunur.
 */
let lastNav = 0;
async function openClient(page: Page): Promise<TeamCfg | undefined> {
  needsPage(page);
  lastNav = Date.now();
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForURL(/^https:\/\/app\.slack\.com\/client\/[A-Z]/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  return team(page);
}

async function slack(page: Page, method: string, params: Record<string, string | number | boolean> = {}): Promise<J> {
  const t = (await team(page)) ?? (Date.now() - lastNav > 8000 ? await openClient(page) : undefined);
  if (!t) throw new Error('Slack oturumu bulunamadı');
  const urls = apiUrls(t, method);
  const h = apiOf(page);
  if (h) {
    // Sayfasız: aynı çok parçalı POST Node'dan (profil kopyasıyla doğrulandı: client.counts ok)
    let netErr = '';
    for (let i = 0; i < urls.length; i++) {
      const multipart: Record<string, string> = { token: t.token };
      for (const [k, v] of Object.entries(params)) multipart[k] = String(v);
      let res: Awaited<ReturnType<typeof h.api.post>>;
      try {
        res = await h.api.post(urls[i], { multipart, timeout: 45_000 });
      } catch (e) {
        netErr = (e as Error).message;
        continue;
      }
      const j = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status()}` }))) as J;
      if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? res.status()}`);
      if (i > 0 && urls.length > 1) sameOriginOnly = true;
      return j;
    }
    throw new Error(`Slack ${method}: ağ hatası (${netErr})`);
  }
  const r = await page.evaluate(
    async ({ method, params, token, urls }) => {
      let netErr = '';
      for (let i = 0; i < urls.length; i++) {
        const body = new FormData();
        body.append('token', token);
        for (const [k, v] of Object.entries(params)) body.append(k, String(v));
        let res: Response;
        try {
          res = await fetch(urls[i], { method: 'POST', body, credentials: 'include' });
        } catch (e) {
          // CORS/ağ hatası: sıradaki adresi dene
          netErr = (e as Error).message;
          continue;
        }
        const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? res.status}`);
        return { j, idx: i };
      }
      throw new Error(`Slack ${method}: ağ/CORS hatası (${netErr})`);
    },
    { method, params, token: t.token, urls },
  );
  // yalnızca aynı-kaynak uç çalıştıysa sonraki çağrılarda boşuna çapraz kaynak deneme
  if (r.idx > 0 && urls.length > 1) sameOriginOnly = true;
  return r.j;
}

interface UserInfo {
  name: string;
  avatar?: string;
  handle?: string;
}
const users = new Map<string, UserInfo>();
/** conversations.list'ten: kanal kimliği → ad/tür/üye bilgisi */
const chans = new Map<string, { name: string; kind: Thread['kind']; user?: string; members?: string[] }>();
/** client.counts'tan sohbet başına son okunan ts (okunmamış sayısı hesabı ve conversations.mark için) */
const lastRead = new Map<string, string>();
let meId = '';
let listLoadedAt = 0;

async function userInfo(page: Page, id: string): Promise<UserInfo> {
  const c = users.get(id);
  if (c) return c;
  if (!id) return { name: 'Slack' };
  try {
    // Botlar users.info'da yok: bots.info ile ad
    const r = id.startsWith('B') ? await slack(page, 'bots.info', { bot: id }) : await slack(page, 'users.info', { user: id });
    const u = r.user ?? r.bot ?? {};
    const v: UserInfo = { name: u.real_name || u.profile?.display_name || u.name || id, avatar: u.profile?.image_72 ?? u.icons?.image_72, handle: u.name && !id.startsWith('B') ? '@' + u.name : undefined };
    users.set(id, v);
    return v;
  } catch {
    return { name: id };
  }
}

/** Tek çağrıyla kanal/DM listesi (adlar): her sohbet için ayrı conversations.info yerine. 10 dk önbellek. */
async function loadConversationList(page: Page): Promise<void> {
  if (Date.now() - listLoadedAt < 10 * 60_000 && chans.size) return;
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const r = await slack(page, 'conversations.list', { types: 'im,mpim,public_channel,private_channel', limit: 1000, exclude_archived: true, ...(cursor ? { cursor } : {}) });
    for (const ch of (r.channels ?? []) as J[]) {
      const id = String(ch.id);
      if (ch.is_im) chans.set(id, { name: '', kind: 'direct', user: String(ch.user ?? '') });
      else if (ch.is_mpim) chans.set(id, { name: ch.name ? String(ch.name).replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').map((n) => '@' + n).join(', ') : 'Grup DM', kind: 'group', members: ch.members });
      else chans.set(id, { name: '#' + (ch.name ?? id), kind: 'channel' });
    }
    cursor = String(r.response_metadata?.next_cursor ?? '');
    if (!cursor) break;
  }
  listLoadedAt = Date.now();
}

/**
 * Slack metin biçimi → okunur metin: <@U123> → @ad, <#C1|genel> → #genel, <https://x|etiket> → etiket (https://x),
 * &amp;/&lt;/&gt; çözülür. Kullanıcı adı önbellekte yoksa kimlik kalır (bir sonraki yoklamada dolar).
 */
export function formatSlackText(text: string, names: Map<string, UserInfo>): string {
  return (text ?? '')
    .replace(/<@([A-Z0-9_]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => '@' + (label ?? names.get(id)?.handle?.slice(1) ?? names.get(id)?.name ?? id))
    .replace(/<#([A-Z0-9_]+)\|([^>]*)>/g, (_m, _id: string, name: string) => '#' + name)
    .replace(/<!(channel|here|everyone)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Slack dosyası → Attachment (url_private çerez ister; köprü vekilden geçirir; files.slack.com / slack-files.com izinli) */
export function fileToAttachment(f: J): Attachment {
  const mime = String(f.mimetype ?? '');
  const kind: Attachment['kind'] = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') || f.subtype === 'slack_audio' ? 'audio' : 'file';
  return {
    kind,
    name: f.title ?? f.name ?? (kind === 'audio' ? 'Sesli mesaj' : undefined),
    mime: mime || undefined,
    size: typeof f.size === 'number' ? f.size : undefined,
    url: kind === 'image' ? (f.url_private ?? f.thumb_720 ?? f.thumb_360) : f.thumb_720 ?? f.thumb_360 ?? f.thumb_video,
    link: f.aac ?? f.url_private_download ?? f.url_private,
    page: f.permalink,
  };
}

/** Sistem alt türleri (katılma/ayrılma/başlık) mesaj değildir; bot, dosya, düzenlenmiş vb. mesajlardır */
const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive', 'pinned_item', 'unpinned_item', 'tombstone', 'joiner_notification', 'reminder_add', 'bot_add', 'bot_remove', 'huddle_thread']);

/** Slack emoji adı ↔ karakter (tepki çipleri ve reactions.add için; bilinmeyen adlar :ad: olarak gösterilir) */
export const SLACK_EMOJI: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', heart: '❤️', joy: '😂', fire: '🔥', clap: '👏', open_mouth: '😮', white_check_mark: '✅',
  eyes: '👀', tada: '🎉', pray: '🙏', 100: '💯', rocket: '🚀', raised_hands: '🙌', heart_eyes: '😍', smile: '😄', sob: '😭',
  thinking_face: '🤔', ok_hand: '👌', wave: '👋', cry: '😢', grinning: '😀', laughing: '😆', sunglasses: '😎', star: '⭐',
  muscle: '💪', partying_face: '🥳', hugging_face: '🤗', sweat_smile: '😅', rolling_on_the_floor_laughing: '🤣', x: '❌',
  warning: '⚠️', point_up: '☝️', heavy_check_mark: '✔️', bulb: '💡', coffee: '☕', sparkles: '✨',
};
const EMOJI_NAME: Record<string, string> = {};
for (const [n, e] of Object.entries(SLACK_EMOJI)) if (!EMOJI_NAME[e]) EMOJI_NAME[e] = n; // ilk tanım kazanır (+1)
export function slackEmojiName(emoji: string): string {
  return EMOJI_NAME[emoji] ?? EMOJI_NAME[emoji.replace(/\uFE0F/g, '')] ?? emoji.replace(/^:|:$/g, '');
}
function slackReactions(list: J[] | undefined): Reaction[] | undefined {
  if (!list?.length) return undefined;
  const out: Reaction[] = [];
  for (const r of list) {
    const name = String(r.name ?? '').split('::')[0];
    const emoji = SLACK_EMOJI[name] ?? `:${name}:`;
    const ids = ((r.users ?? []) as string[]).slice(0, 50);
    for (const uid of ids) out.push({ emoji, senderId: uid, senderName: users.get(uid)?.name ?? uid, fromMe: !!meId && uid === meId });
    // users listesi kırpılmışsa kalan sayı kimliksiz
    for (let i = ids.length; i < Number(r.count ?? ids.length); i++) out.push({ emoji, senderId: `${name}#${i}`, senderName: '', fromMe: false });
  }
  return out.length ? out : undefined;
}
/** Yanıtları çekilen iş parçacıkları: üst ts → latest_reply (değişmediyse yeniden istenmez) */
const threadsSeen = new Map<string, string>();

async function toMsg(page: Page, m: J): Promise<Msg | undefined> {
  if (m.subtype && SKIP_SUBTYPES.has(String(m.subtype))) return undefined;
  const uid = String(m.user ?? m.bot_id ?? '');
  const u = m.subtype === 'bot_message' && m.username ? { name: String(m.username), avatar: m.icons?.image_64 } : await userInfo(page, uid);
  const files = ((m.files ?? []) as J[]).filter((f) => f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
  const text = formatSlackText(String(m.text ?? ''), users);
  if (!text && !files.length) return undefined;
  return {
    id: String(m.ts),
    text,
    ts: Math.floor(Number(m.ts) * 1000),
    fromMe: !!meId && uid === meId,
    senderId: uid || 'bot',
    senderName: u.name,
    senderAvatarUrl: u.avatar,
    attachments: files.length ? files.map(fileToAttachment) : undefined,
    reactions: slackReactions(m.reactions as J[] | undefined),
    threadId: m.thread_ts && String(m.thread_ts) !== String(m.ts) ? String(m.thread_ts) : undefined,
    replyCount: m.reply_count ? Number(m.reply_count) : undefined,
  };
}

export const slackStrategy: Strategy = {
  home: SIGNIN,
  loginHint: 'Açılan pencerede Slack\'e giriş yap (e-posta kodu / Google), listeden çalışma alanını AÇ — giriş ancak çalışma alanı açılınca tamamlanır',
  parallel: true,

  pageless: true,

  async loggedIn(page, cookies, passive) {
    // "d": .slack.com oturum çerezi; yalnızca bir çalışma alanı gerçekten açıldığında yazılır.
    // Google/e-posta doğrulaması bitmiş ama çalışma alanı seçilmemişse yoktur → giriş tamamlanmamıştır.
    if (!cookies.d) return false;
    if (await team(page)) return true;
    // görünür pencerede yönlendirme yapma (kullanıcı çalışma alanı seçiyor olabilir): web istemcisi yüklendiyse giriş tamam
    if (passive) return /^https:\/\/app\.slack\.com\/client\/[A-Z]/.test(page.url());
    // "d" var ama bu sayfa (slack.com/signin listesi, <ws>.slack.com "uygulamada aç" ekranı) oturum bilgisini
    // taşımıyor: web istemcisini yükle; localConfig_v2 orada oluşur (görünür pencerede en çok 8 sn'de bir)
    if (Date.now() - lastNav < 8000) return false;
    return !!(await openClient(page));
  },

  async me(page) {
    const t = (await team(page)) ?? (await openClient(page));
    meId = t?.userId ?? '';
    if (!meId) {
      try {
        meId = String((await slack(page, 'auth.test')).user_id ?? '');
      } catch {
        /* auth.test başarısız */
      }
    }
    if (t && meId) {
      const u = await userInfo(page, meId);
      return { id: meId, label: `${t.name}${u.handle ? ' · ' + u.handle : ''}` };
    }
    return { id: meId, label: t?.name ?? 'Slack' };
  },

  async threads(page): Promise<Thread[]> {
    // client.counts: web istemcisinin kullandığı özet uç — kanal/DM listesi, son mesaj zamanı, okunmamış
    const counts = await slack(page, 'client.counts', {});
    await loadConversationList(page).catch(() => undefined);
    const out: Thread[] = [];
    const push = async (c: J, kindHint: Thread['kind']) => {
      const id = String(c.id);
      if (c.last_read) lastRead.set(id, String(c.last_read));
      const meta = chans.get(id);
      const kind = meta?.kind ?? kindHint;
      let name = meta?.name ?? '';
      let avatar: string | undefined;
      let handle: string | undefined;
      let participants: Thread['participants'];
      if (kind === 'direct') {
        const uid = meta?.user ?? (await slack(page, 'conversations.info', { channel: id }).then((r) => String(r.channel?.user ?? '')).catch(() => ''));
        if (uid) {
          const u = await userInfo(page, uid);
          name = u.name;
          avatar = u.avatar;
          handle = u.handle;
          participants = [{ id: uid, name: u.name, avatarUrl: u.avatar, handle: u.handle }];
        }
      } else if (!name) {
        try {
          const ch = (await slack(page, 'conversations.info', { channel: id })).channel ?? {};
          name = ch.name ? '#' + ch.name : ch.is_mpim ? 'Grup DM' : id;
          chans.set(id, { name, kind });
        } catch {
          name = id;
        }
      }
      // Okunmamış: DM/grup DM'de her mesaj sayılır (mention_count); kanalda mention yoksa has_unreads → 1
      const unread = Number(c.mention_count ?? 0) || (c.has_unreads ? (kind === 'channel' ? 1 : Number(c.unread_count ?? 1)) : 0);
      out.push({ id, name: name || id, kind, lastTs: Math.floor(Number(c.latest ?? 0) * 1000), preview: '', unread, avatarUrl: avatar, handle, participants });
    };
    for (const c of counts.ims ?? []) await push(c, 'direct');
    for (const c of counts.mpims ?? []) await push(c, 'group');
    for (const c of counts.channels ?? []) if (c.is_member !== false) await push(c, 'channel');
    return out;
  },

  async messages(page, _cookies, threadId, limit, before): Promise<Msg[]> {
    const params: Record<string, string | number | boolean> = { channel: threadId, limit };
    if (before) {
      // Slack ts saniye.mikrosaniye; before ms → saniye, inclusive=false → kesinlikle daha eski
      params.latest = (before / 1000).toFixed(6);
      params.inclusive = false;
    }
    const r = await slack(page, 'conversations.history', params);
    const msgs: Msg[] = [];
    for (const m of (r.messages ?? []) as J[]) {
      const msg = await toMsg(page, m);
      if (msg) msgs.push(msg);
    }
    // İş parçacığı yanıtları history'de görünmez: reply_count'lu üst mesajların yanıtları (yeni yanıt geldiyse) ayrıca çekilir
    for (const m of (r.messages ?? []) as J[]) {
      if (!m.reply_count || !m.ts) continue;
      const key = `${threadId}/${m.ts}`;
      const latest = String(m.latest_reply ?? m.reply_count);
      if (threadsSeen.get(key) === latest) continue;
      try {
        const rep = await slack(page, 'conversations.replies', { channel: threadId, ts: String(m.ts), limit: 40 });
        for (const x of (rep.messages ?? []) as J[]) {
          if (String(x.ts) === String(m.ts)) continue;
          const msg = await toMsg(page, x);
          if (msg) msgs.push({ ...msg, threadId: String(m.ts) });
        }
        threadsSeen.set(key, latest);
      } catch {
        /* yanıtlar alınamadı; sonraki yoklamada yeniden denenir */
      }
    }
    return msgs.sort((a, b) => a.ts - b.ts);
  },

  async markRead(page, _cookies, threadId, lastIncomingId) {
    // conversations.mark: bu ts'ye kadar okundu (Slack istemcilerinde okunmamış rozeti düşer)
    const ts = lastIncomingId ?? (await slack(page, 'conversations.history', { channel: threadId, limit: 1 })).messages?.[0]?.ts;
    if (!ts) return;
    await slack(page, 'conversations.mark', { channel: threadId, ts: String(ts) });
    lastRead.set(threadId, String(ts));
  },

  async send(page, _cookies, threadId, text, opts?: SendOptions) {
    const params: Record<string, string | boolean> = { channel: threadId, text, as_user: true };
    if (opts?.threadId) params.thread_ts = opts.threadId;
    const r = await slack(page, 'chat.postMessage', params);
    return r?.ts ? String(r.ts) : undefined;
  },

  async react(page, _cookies, threadId, msgId, emoji, remove) {
    await slack(page, remove ? 'reactions.remove' : 'reactions.add', { channel: threadId, timestamp: msgId, name: slackEmojiName(emoji) });
  },

  async openDirect(page, _cookies, p) {
    const r = await slack(page, 'conversations.open', { users: p.id });
    return String(r.channel?.id ?? '');
  },

  /**
   * Dosya: iki adımlı yükleme (files.upload kapalı). 1) files.getUploadURLExternal {filename, length} → upload_url + file_id;
   * 2) dosya baytları upload_url'ye POST (Node tarafı context.request; olmazsa sayfa fetch'i — her ikisi de profil
   * kopyasıyla 200 döndü); 3) files.completeUploadExternal {files:[{id,title}], channel_id, initial_comment} mesajı
   * kanala paylaşır. Dönen kimlik: paylaşımın ts'si (yoksa dosya kimliği).
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    needsPage(page);
    const r = await slack(page, 'files.getUploadURLExternal', { filename: file.name, length: file.size });
    const uploadUrl = String(r.upload_url ?? '');
    const fileId = String(r.file_id ?? '');
    if (!uploadUrl || !fileId) throw new Error('Slack: yükleme adresi alınamadı');
    await uploadToSlack(page, uploadUrl, file);
    const done = await slack(page, 'files.completeUploadExternal', {
      files: JSON.stringify([{ id: fileId, title: file.name }]),
      channel_id: threadId,
      ...(caption ? { initial_comment: caption } : {}),
    });
    return completedShareTs(done, threadId) ?? fileId;
  },
};

/** completeUploadExternal yanıtındaki paylaşımın mesaj ts'si (files[].shares.public|private[channel][0].ts) */
export function completedShareTs(r: J, channel: string): string | undefined {
  for (const f of (r?.files ?? []) as J[]) {
    for (const scope of ['public', 'private']) {
      const s = f.shares?.[scope]?.[channel];
      if (Array.isArray(s) && s[0]?.ts) return String(s[0].ts);
    }
  }
  return undefined;
}

/** Dosya baytlarını Slack'in yükleme adresine gönder: önce Node tarafı (büyük dosyada base64 gerekmez), olmazsa sayfa fetch'i */
async function uploadToSlack(page: Page, uploadUrl: string, file: { path: string; name: string; mime: string; size: number }): Promise<void> {
  const fs = await import('node:fs');
  const body = fs.readFileSync(file.path);
  const mime = file.mime || 'application/octet-stream';
  const ctx = typeof (page as { context?: unknown }).context === 'function' ? page.context() : undefined;
  if (ctx?.request) {
    try {
      const res = await ctx.request.post(uploadUrl, { data: body, headers: { 'content-type': mime }, timeout: Math.max(60_000, file.size / 20) });
      if (res.ok()) return;
      throw new Error(`HTTP ${res.status()}`);
    } catch (e) {
      // sayfa bağlamından dene (CORS: files.slack.com app.slack.com kaynağına izin veriyor)
      const first = (e as Error).message;
      const r = await page.evaluate(
        async ({ url, b64, mime }) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const res = await fetch(url, { method: 'POST', body: new Blob([bytes], { type: mime }) });
          return { ok: res.ok, status: res.status };
        },
        { url: uploadUrl, b64: body.toString('base64'), mime },
      );
      if (!r.ok) throw new Error(`Slack yükleme başarısız: ${first}; sayfa: HTTP ${r.status}`);
      return;
    }
  }
  const r = await page.evaluate(
    async ({ url, b64, mime }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const res = await fetch(url, { method: 'POST', body: new Blob([bytes], { type: mime }) });
      return { ok: res.ok, status: res.status };
    },
    { url: uploadUrl, b64: body.toString('base64'), mime },
  );
  if (!r.ok) throw new Error(`Slack yükleme başarısız: HTTP ${r.status}`);
}

/** Testler için: iç önbellekleri sıfırla */
export function _resetSlackState(): void {
  users.clear();
  chans.clear();
  lastRead.clear();
  meId = '';
  listLoadedAt = 0;
  learned.base = '';
  learned.query = {};
  sameOriginOnly = false;
}
