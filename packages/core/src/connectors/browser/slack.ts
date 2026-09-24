import type { Page } from 'playwright';
import type { Attachment } from '../../model.js';
import type { Msg, Strategy, Thread } from './bridge.js';

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
}

async function team(page: Page): Promise<TeamCfg | undefined> {
  if (page.isClosed() || !page.url().startsWith('https://app.slack.com/')) return undefined;
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('localConfig_v2');
      if (!raw) return undefined;
      const cfg = JSON.parse(raw) as { teams?: Record<string, { token?: string; domain?: string; name?: string; user_id?: string }>; lastActiveTeamId?: string };
      const teams = Object.values(cfg.teams ?? {});
      const t = (cfg.lastActiveTeamId && cfg.teams?.[cfg.lastActiveTeamId]) || teams.find((x) => x.token?.startsWith('xoxc'));
      if (!t?.token) return undefined;
      return { token: t.token, domain: t.domain ?? '', name: t.name ?? 'Slack', userId: t.user_id ?? '' };
    } catch {
      return undefined;
    }
  });
}

/**
 * Web istemcisini yükle: app.slack.com/client → gantry/auth, "d" çerezindeki oturumu alıp localConfig_v2'yi
 * doldurur ve /client/T… adresine geçer. Çalışma alanı alt alanında (<ws>.slack.com, "uygulamada aç" ekranı)
 * ya da slack.com/signin'de kalınmışsa oturum bilgisi ancak böyle okunur.
 */
let lastNav = 0;
async function openClient(page: Page): Promise<TeamCfg | undefined> {
  lastNav = Date.now();
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForURL(/^https:\/\/app\.slack\.com\/client\/[A-Z]/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  return team(page);
}

async function slack(page: Page, method: string, params: Record<string, string | number | boolean> = {}): Promise<J> {
  const t = (await team(page)) ?? (Date.now() - lastNav > 8000 ? await openClient(page) : undefined);
  if (!t) throw new Error('Slack oturumu bulunamadı');
  return page.evaluate(
    async ({ method, params, token }) => {
      const body = new FormData();
      body.append('token', token);
      for (const [k, v] of Object.entries(params)) body.append(k, String(v));
      const r = await fetch(`https://slack.com/api/${method}`, { method: 'POST', body, credentials: 'include' });
      const j = await r.json();
      if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? r.status}`);
      return j;
    },
    { method, params, token: t.token },
  );
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
  };
}

export const slackStrategy: Strategy = {
  home: SIGNIN,
  loginHint: 'Açılan pencerede Slack\'e giriş yap (e-posta kodu / Google), listeden çalışma alanını AÇ — giriş ancak çalışma alanı açılınca tamamlanır',
  parallel: true,

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
    return msgs.reverse();
  },

  async markRead(page, _cookies, threadId, lastIncomingId) {
    // conversations.mark: bu ts'ye kadar okundu (Slack istemcilerinde okunmamış rozeti düşer)
    const ts = lastIncomingId ?? (await slack(page, 'conversations.history', { channel: threadId, limit: 1 })).messages?.[0]?.ts;
    if (!ts) return;
    await slack(page, 'conversations.mark', { channel: threadId, ts: String(ts) });
    lastRead.set(threadId, String(ts));
  },

  async send(page, _cookies, threadId, text) {
    const r = await slack(page, 'chat.postMessage', { channel: threadId, text, as_user: true });
    return r?.ts ? String(r.ts) : undefined;
  },

  async openDirect(page, _cookies, p) {
    const r = await slack(page, 'conversations.open', { users: p.id });
    return String(r.channel?.id ?? '');
  },
};

/** Testler için: iç önbellekleri sıfırla */
export function _resetSlackState(): void {
  users.clear();
  chans.clear();
  lastRead.clear();
  meId = '';
  listLoadedAt = 0;
}
