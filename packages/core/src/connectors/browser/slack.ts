import type { Page } from 'playwright';
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

const users = new Map<string, { name: string; avatar?: string; handle?: string }>();
const chanNames = new Map<string, string>();
let meId = '';

async function userInfo(page: Page, id: string): Promise<{ name: string; avatar?: string; handle?: string }> {
  const c = users.get(id);
  if (c) return c;
  try {
    const r = await slack(page, 'users.info', { user: id });
    const u = r.user ?? {};
    const v = { name: u.real_name || u.profile?.display_name || u.name || id, avatar: u.profile?.image_72, handle: u.name ? '@' + u.name : undefined };
    users.set(id, v);
    return v;
  } catch {
    return { name: id };
  }
}

export const slackStrategy: Strategy = {
  home: SIGNIN,
  loginHint: 'Açılan pencerede Slack\'e giriş yap (e-posta kodu / Google), listeden çalışma alanını AÇ — giriş ancak çalışma alanı açılınca tamamlanır',

  async loggedIn(page, cookies) {
    // "d": .slack.com oturum çerezi; yalnızca bir çalışma alanı gerçekten açıldığında yazılır.
    // Google/e-posta doğrulaması bitmiş ama çalışma alanı seçilmemişse yoktur → giriş tamamlanmamıştır.
    if (!cookies.d) return false;
    if (await team(page)) return true;
    // "d" var ama bu sayfa (slack.com/signin listesi, <ws>.slack.com "uygulamada aç" ekranı) oturum bilgisini
    // taşımıyor: web istemcisini yükle; localConfig_v2 orada oluşur (görünür pencerede en çok 8 sn'de bir)
    if (Date.now() - lastNav < 8000) return false;
    return !!(await openClient(page));
  },

  async me(page) {
    const t = (await team(page)) ?? (await openClient(page));
    meId = t?.userId ?? '';
    if (t && meId) {
      const u = await userInfo(page, meId);
      return { id: meId, label: `${t.name}${u.handle ? ' · ' + u.handle : ''}` };
    }
    return { id: meId, label: t?.name ?? 'Slack' };
  },

  async threads(page): Promise<Thread[]> {
    // client.counts: web istemcisinin kullandığı özet uç — kanal/DM listesi, son mesaj zamanı, okunmamış
    const counts = await slack(page, 'client.counts', {});
    const out: Thread[] = [];
    const push = async (c: J, kind: Thread['kind'], nameHint?: string) => {
      const id = String(c.id);
      let name = nameHint ?? chanNames.get(id) ?? '';
      let avatar: string | undefined;
      let handle: string | undefined;
      let participants: Thread['participants'];
      if (!name) {
        try {
          const info = await slack(page, 'conversations.info', { channel: id });
          const ch = info.channel ?? {};
          if (ch.is_im && ch.user) {
            const u = await userInfo(page, ch.user);
            name = u.name;
            avatar = u.avatar;
            handle = u.handle;
            participants = [{ id: ch.user, name: u.name, avatarUrl: u.avatar, handle: u.handle }];
          } else name = ch.name ? '#' + ch.name : ch.is_mpim ? 'Grup DM' : id;
          chanNames.set(id, name);
        } catch {
          name = id;
        }
      }
      out.push({ id, name, kind, lastTs: Math.floor(Number(c.latest ?? 0) * 1000), preview: '', unread: Number(c.mention_count ?? 0) || (c.has_unreads ? 1 : 0), avatarUrl: avatar, handle, participants });
    };
    for (const c of counts.ims ?? []) await push(c, 'direct');
    for (const c of counts.mpims ?? []) await push(c, 'group');
    for (const c of counts.channels ?? []) if (c.is_member !== false) await push(c, 'channel');
    return out;
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    const r = await slack(page, 'conversations.history', { channel: threadId, limit });
    const msgs: Msg[] = [];
    for (const m of (r.messages ?? []) as J[]) {
      if (m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast') continue;
      const uid = String(m.user ?? m.bot_id ?? '');
      const u = uid ? await userInfo(page, uid) : { name: 'Slack' };
      const files = (m.files ?? []) as J[];
      msgs.push({
        id: String(m.ts),
        text: String(m.text ?? ''),
        ts: Math.floor(Number(m.ts) * 1000),
        fromMe: uid === meId,
        senderId: uid,
        senderName: u.name,
        senderAvatarUrl: u.avatar,
        attachments: files.length
          ? files.map((f) => ({
              kind: f.mimetype?.startsWith('image/') ? 'image' : f.mimetype?.startsWith('video/') ? 'video' : f.mimetype?.startsWith('audio/') ? 'audio' : 'file',
              name: f.title ?? f.name,
              mime: f.mimetype,
              size: f.size,
              url: f.mimetype?.startsWith('image/') ? f.url_private : f.thumb_360,
              link: f.url_private_download ?? f.url_private,
              page: f.permalink,
            }))
          : undefined,
      });
    }
    return msgs.reverse();
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
