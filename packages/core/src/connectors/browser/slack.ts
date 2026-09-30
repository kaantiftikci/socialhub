import type { Page } from 'playwright';
import type { Attachment, Reaction } from '../../model.js';
import type { SendOptions } from '../base.js';
import { bus } from '../../bus.js';
import { apiOf, needsPage, RATE_RE, safeUrl, type Msg, type Strategy, type Thread } from './bridge.js';

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
  /** Tanı: anahtar nereden bulundu (localConfig_v2 teams / web istemcisinin kendi isteği) */
  source?: 'localConfig' | 'istek';
}

/* ---------- tanı günlüğü: yalnız hata kodu/sayılar, asla mesaj içeriği ya da anahtar ---------- */
const warned = new Map<string, number>();
/** Aynı anahtarla en çok `everyMs`'de bir satır (her sohbet/tur için aynı hata günlüğü doldurmasın) */
function logOnce(level: 'info' | 'warn', key: string, text: string, everyMs = 10 * 60_000): void {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < everyMs) return;
  warned.set(key, now);
  bus.log(level, `slack: ${text}`);
}
/** Hata iletisinden Slack hata kodu ("Slack conversations.history: invalid_auth (HTTP 200, …)" → invalid_auth); içerik taşımaz */
export function slackErrCode(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  return msg.match(/Slack [\w.]+: ([\w-]+)/)?.[1] ?? msg.split('\n')[0].replace(/xox[a-z]-[\w-]+/g, 'xox?-…').slice(0, 80);
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
const learned = { base: '', query: {} as Record<string, string>, xid: '' };
/**
 * Web istemcisinin KENDİ isteklerinin gövdesindeki xoxc anahtarı (çalışma alanı adresiyle). 2026'dan beri Slack web istemcisi
 * anahtarı localConfig_v2'de tutmayabiliyor ("teams": {} — çalışma alanı bilgisi prevTeams'e taşınıyor); o zaman oturum anahtarı
 * yalnız istemcinin bellek içi isteklerinde görünür. Değer asla günlüğe yazılmaz.
 */
interface Captured {
  token: string;
  /** https://<ws>.slack.com/api/ */
  base: string;
  /** slack_route sorgu parametresi (T…/E…:T…), yoksa '' */
  teamId: string;
}
const captured: Captured[] = [];
const watched = new WeakSet<Page>();
/**
 * Çalışma alanı adresine ağ hatasıyla ulaşılamayıp app.slack.com aynı-kaynak ucu çalıştıysa bu zamana dek önce o denenir.
 * Eskiden kalıcı bir bayraktı (sameOriginOnly): tek bir geçici ağ hatası (Mac uykudan uyanırken DNS) süreç boyunca TÜM
 * çağrıları yalnız app.slack.com/api'ye kilitliyordu; orada çalışmayan yöntemler (ör. geçmiş) bir daha asla çalışma alanı
 * adresinden denenmiyordu. Artık süreli ve her iki adres de sırayla denenir.
 */
let sameOriginUntil = 0;

/** multipart/form-data ya da urlencoded gövdeden xoxc anahtarı */
export function tokenFromBody(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const mp = body.match(/name="token"\r?\n\r?\n(xoxc-[A-Za-z0-9-]+)/)?.[1];
  if (mp) return mp;
  const ue = body.match(/(?:^|&)token=(xoxc-[A-Za-z0-9%-]+)/)?.[1];
  return ue ? decodeURIComponent(ue) : undefined;
}

/** Web istemcisinin bir API isteğini işle: host + sabit parametreleri ve (gövdede varsa) oturum anahtarını öğren */
export function learnFromRequest(url: string, postData: string | null | undefined): void {
  const m = url.match(/^(https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/api\/)[\w.]+\?(.*)$/);
  if (!m || !m[2].includes('_x_id=')) return;
  const q = new URLSearchParams(m[2]);
  // bizim kendi isteklerimiz de buradan geçer (aynı sayfa): parametre/host öğrenimi zararsız, anahtar zaten bizimki
  const token = tokenFromBody(postData);
  if (token) {
    const teamId = q.get('slack_route') ?? '';
    const i = captured.findIndex((c) => c.base === m[1]);
    if (i >= 0) captured.splice(i, 1);
    captured.push({ token, base: m[1], teamId });
    if (captured.length > 8) captured.shift();
  }
  if (m[1] === 'https://app.slack.com/api/') return; // aynı-kaynak uç: çalışma alanı adresi değil
  learned.base = m[1];
  const keep: Record<string, string> = {};
  for (const k of KEEP_QUERY) {
    const v = q.get(k);
    if (v) keep[k] = v;
  }
  learned.query = keep;
  // _x_id önekini web istemcisinden öğren (ör. "noversion" ya da sürüm karması); uygulama adı asla gönderilmez
  const xid = q.get('_x_id')?.match(/^([\w]+)-\d/)?.[1];
  if (xid) learned.xid = xid;
}

function watchClientRequests(page: Page): void {
  if (watched.has(page) || typeof (page as { on?: unknown }).on !== 'function') return;
  watched.add(page);
  page.on('request', (req) => {
    try {
      if (!/\.slack\.com\/api\//.test(req.url())) return;
      learnFromRequest(req.url(), req.method() === 'POST' ? req.postData() : undefined);
    } catch {
      /* gövde okunamadı */
    }
  });
}

/** Denenecek API adresleri (sırayla): web istemcisinin host'u + _x_ parametreleri, sonra app.slack.com aynı-kaynak /api/ */
export function apiUrls(t: Pick<TeamCfg, 'domain' | 'url'>, method: string, learnedCfg: { base: string; query: Record<string, string>; xid?: string } = learned, now = Date.now()): string[] {
  const sameOrigin = `https://app.slack.com/api/${method}`;
  const teamBase = t.url ? t.url.replace(/\/?$/, '/') + 'api/' : t.domain ? `https://${t.domain}.slack.com/api/` : '';
  // öğrenilen host yalnızca bu çalışma alanınınsa (çoklu çalışma alanında başka takımın host'u değil)
  const base = learnedCfg.base && (!teamBase || learnedCfg.base === teamBase) ? learnedCfg.base : teamBase;
  if (!base) return [sameOrigin];
  const q = new URLSearchParams({ _x_id: `${learnedCfg.xid || 'noversion'}-${(now / 1000).toFixed(3)}`, ...learnedCfg.query, _x_gantry: 'true' });
  const team = `${base}${method}?${q}`;
  return now < sameOriginUntil ? [sameOrigin, team] : [team, sameOrigin];
}

type TeamEntry = { token?: string; domain?: string; name?: string; user_id?: string; url?: string; id?: string; team_id?: string };

/**
 * localStorage'daki localConfig_v2 → etkin çalışma alanı (sayfada ve sayfasız modda ortak). Anahtar `teams` içinde yoksa
 * (2026 web istemcisi: "teams": {}, bilgi prevTeams'te) web istemcisinin kendi isteklerinden yakalanan anahtar kullanılır.
 */
export function parseTeam(raw: string | null | undefined, caps: Captured[] = captured): TeamCfg | undefined {
  let cfg: { teams?: Record<string, TeamEntry>; prevTeams?: Record<string, TeamEntry> | TeamEntry[]; lastActiveTeamId?: string } = {};
  try {
    if (raw) cfg = JSON.parse(raw) ?? {};
  } catch {
    cfg = {};
  }
  const teams = Object.values(cfg.teams ?? {});
  const t = (cfg.lastActiveTeamId && cfg.teams?.[cfg.lastActiveTeamId]) || teams.find((x) => x.token?.startsWith('xoxc'));
  if (t?.token) return { token: t.token, domain: t.domain ?? '', name: t.name ?? 'Slack', userId: t.user_id ?? '', url: t.url ?? '', source: 'localConfig' };
  if (!caps.length) return undefined;
  // anahtarsız çalışma alanı bilgisi (ad/adres/kullanıcı): teams ya da prevTeams
  const prev = Object.values(cfg.prevTeams ?? {}) as TeamEntry[];
  const byId = (id?: string) => (id ? cfg.teams?.[id] ?? prev.find((x) => x.id === id || x.team_id === id) ?? (Array.isArray(cfg.prevTeams) ? undefined : cfg.prevTeams?.[id]) : undefined);
  const baseOf = (e?: TeamEntry) => (e?.url ? e.url.replace(/\/?$/, '/') + 'api/' : e?.domain ? `https://${e.domain}.slack.com/api/` : '');
  const meta = byId(cfg.lastActiveTeamId) ?? teams[0] ?? prev[0];
  const cap = caps.find((c) => baseOf(meta) && c.base === baseOf(meta)) ?? caps[caps.length - 1];
  // yakalanan anahtar başka çalışma alanınınsa o alanın bilgisi (yoksa yalnız adres)
  const info = baseOf(meta) === cap.base ? meta : [...teams, ...prev].find((e) => baseOf(e) === cap.base);
  const host = cap.base.match(/^https:\/\/([a-z0-9-]+)\./)?.[1] ?? '';
  return { token: cap.token, domain: info?.domain ?? host, name: info?.name ?? 'Slack', userId: info?.user_id ?? '', url: info?.url ?? cap.base.replace(/api\/$/, ''), source: 'istek' };
}

async function team(page: Page): Promise<TeamCfg | undefined> {
  const h = apiOf(page);
  if (h) {
    const o = h.state.origins.find((x) => x.origin === 'https://app.slack.com');
    return parseTeam(o?.localStorage.find((e) => e.name === 'localConfig_v2')?.value);
  }
  if (page.isClosed()) return undefined;
  // web istemcisinin isteklerini sayfa hangi adreste olursa olsun erkenden izle (açılış istekleri anahtarı taşır)
  watchClientRequests(page);
  if (!page.url().startsWith('https://app.slack.com/')) return undefined;
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
  watchClientRequests(page);
  lastNav = Date.now();
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForURL(/^https:\/\/app\.slack\.com\/client\/[A-Z]/, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  let t = await team(page);
  // localConfig_v2'de anahtar yok: istemcinin ilk API isteği (anahtarı taşır) birkaç saniye içinde gelir
  for (let i = 0; !t && i < 8 && !page.isClosed() && page.url().startsWith('https://app.slack.com/'); i++) {
    await page.waitForTimeout(750);
    t = await team(page);
  }
  if (!t) logOnce('warn', 'no-token', `oturum anahtarı bulunamadı (localConfig_v2'de takım yok, istemci isteği yakalanmadı; sayfa: ${safeUrl(page.url())})`);
  return t;
}

/** Sonucu bu kodlarla dönen çağrıda sıradaki adres de denenir (adres/yönlendirme sorunu olabilir); ikisi de olmazsa ilk hata */
const RETRY_NEXT = ['not_authed', 'invalid_auth', 'team_not_found', 'enterprise_is_restricted', 'non_json', 'team_access_not_granted'];

interface CallResult {
  j: J;
  idx: number;
  status?: number;
  retryAfter?: string;
  netErr?: string;
}

function callError(method: string, r: CallResult, urls: string[]): Error {
  if (r.idx < 0) return new Error(`Slack ${method}: ağ hatası (${(r.netErr ?? '').split('\n')[0].slice(0, 120)})`);
  const where = urls[r.idx]?.startsWith('https://app.slack.com/') ? 'app.slack.com' : 'çalışma alanı adresi';
  const e = new Error(`Slack ${method}: ${String(r.j?.error ?? 'bilinmeyen_hata')} (HTTP ${r.status ?? '?'}, ${where})`) as Error & { retryAfter?: number };
  const ra = Number(r.retryAfter);
  if (ra > 0) e.retryAfter = ra;
  return e;
}

async function slack(page: Page, method: string, params: Record<string, string | number | boolean> = {}): Promise<J> {
  const t = (await team(page)) ?? (Date.now() - lastNav > 8000 ? await openClient(page) : undefined);
  if (!t) throw new Error('Slack oturumu bulunamadı');
  const urls = apiUrls(t, method);
  const h = apiOf(page);
  let r: CallResult;
  if (h) {
    // Sayfasız: aynı çok parçalı POST Node'dan (profil kopyasıyla doğrulandı: client.counts ok)
    let netErr = '';
    let firstFail: CallResult | undefined;
    let got: CallResult | undefined;
    for (let i = 0; i < urls.length && !got; i++) {
      const multipart: Record<string, string> = { token: t.token };
      for (const [k, v] of Object.entries(params)) multipart[k] = String(v);
      let res: Awaited<ReturnType<typeof h.api.post>>;
      try {
        res = await h.api.post(urls[i], { multipart, timeout: 45_000 });
      } catch (e) {
        netErr = (e as Error).message;
        continue;
      }
      const j = (await res.json().catch(() => ({ ok: false, error: 'non_json' }))) as J;
      const out: CallResult = { j, idx: i, status: res.status(), retryAfter: res.headers()['retry-after'], netErr };
      if (j.ok || i === urls.length - 1 || !RETRY_NEXT.includes(String(j.error))) got = j.ok ? out : (firstFail ?? out);
      else firstFail ??= out;
    }
    r = got ?? firstFail ?? { j: { ok: false }, idx: -1, netErr };
  } else {
    r = (await page.evaluate(
      // method: sayfada kullanılmaz; testlerdeki sahte sayfa çağrıyı onunla tanır
      async ({ params, token, urls, retryNext }) => {
        let netErr = '';
        let firstFail: { j: Record<string, unknown>; idx: number; status: number; retryAfter: string; netErr: string } | undefined;
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
          const j = (await res.json().catch(() => ({ ok: false, error: 'non_json' }))) as Record<string, unknown>;
          const out = { j, idx: i, status: res.status, retryAfter: res.headers.get('retry-after') ?? '', netErr };
          if (j.ok) return out;
          if (i < urls.length - 1 && retryNext.includes(String(j.error))) {
            firstFail ??= out;
            continue;
          }
          return firstFail ?? out;
        }
        return firstFail ?? { j: { ok: false }, idx: -1, status: 0, retryAfter: '', netErr };
      },
      { method, params, token: t.token, urls, retryNext: RETRY_NEXT },
    )) as CallResult;
  }
  if (!r.j?.ok) throw callError(method, r, urls);
  // çalışma alanı adresine ağ/CORS hatasıyla ulaşılamadı, aynı-kaynak uç çalıştı: 10 dk önce o denensin (sonra yine çalışma alanı)
  if (r.idx > 0 && r.netErr && urls[r.idx].startsWith('https://app.slack.com/')) {
    sameOriginUntil = Date.now() + 10 * 60_000;
    logOnce('info', 'same-origin', `çalışma alanı adresine ulaşılamadı (${r.netErr.split('\n')[0].slice(0, 80)}); 10 dk app.slack.com/api kullanılacak`);
  }
  return r.j;
}

export interface UserInfo {
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

/** Adı alınamayan kimlikler → son deneme zamanı: her mesaj/turda yeniden users.info istenmesin (10 dk) */
const userMiss = new Map<string, number>();

async function userInfo(page: Page, id: string): Promise<UserInfo> {
  const c = users.get(id);
  if (c) return c;
  if (!id) return { name: 'Slack' };
  if (Date.now() - (userMiss.get(id) ?? 0) < 10 * 60_000) return { name: id };
  try {
    // Botlar users.info'da yok: bots.info ile ad
    const r = id.startsWith('B') ? await slack(page, 'bots.info', { bot: id }) : await slack(page, 'users.info', { user: id });
    const u = r.user ?? r.bot ?? {};
    const v: UserInfo = { name: u.real_name || u.profile?.display_name || u.name || id, avatar: u.profile?.image_72 ?? u.icons?.image_72, handle: u.name && !id.startsWith('B') ? '@' + u.name : undefined };
    users.set(id, v);
    userMiss.delete(id);
    return v;
  } catch (e) {
    userMiss.set(id, Date.now());
    const code = slackErrCode(e);
    logOnce('warn', `user:${code}`, `${id.startsWith('B') ? 'bots.info' : 'users.info'} başarısız (${code}); ad yerine kimlik gösterilecek`);
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
export const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive', 'pinned_item', 'unpinned_item', 'tombstone', 'joiner_notification', 'reminder_add', 'bot_add', 'bot_remove', 'huddle_thread']);

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
const threadsSeen = new Map<string, { latest: string; newest: string }>();
/** Çağrı başına en çok bu kadar iş parçacığının yanıtı, dizi başına en çok REPLY_PAGES sayfa (xoxp yolundaki tur başına ≤5 gibi;
 *  eskiden sınırsızdı → iş parçacığı yoğun çalışma alanında dakikada 50+ istek, Slack "ratelimited") */
const REPLIES_PER_CALL = 3;
const REPLY_PAGES = 2;
/** Yanıtları bütçe yüzünden sonraya kalan kanallar → son döndürülen lastTs (threads() bunu 1 ms artırır: köprü sohbeti yine "değişmiş" sayar) */
const pendingReplies = new Set<string>();
const lastThreadTs = new Map<string, number>();
/** conversations.replies hız sınırına takıldı: bu zamana dek yanıt istenmez (geçmiş yine alınır; kanal "değişmiş" kalır) */
let repliesPausedUntil = 0;
/** messages() tek çağrısı köprünün 60 sn sınırına yaklaşmasın: yanıt/ad aramaları bu süreden sonra sonraki tura kalır */
const CALL_BUDGET_MS = 25_000;
/**
 * Sohbetin son (üst düzey) mesajının önizlemesi: client.counts önizleme vermez; `latest` gizli bir iletiye (kanala katılma,
 * iş parçacığı yanıtı, silinen mesaj) aitse depo önizlemeyi hiç yazmıyordu (mesaj zamanı sohbetin son zamanından eski) →
 * listede boş önizleme. threads() bunu döndürür; köprü önizlemesi boş sohbete yazar.
 */
const lastSeen = new Map<string, { ts: number; body: string; fromMe: boolean; sender: string }>();
/** Tanı: ilk çağrıların özeti bir kez */
let historyLogged = 0;

/**
 * Metni boş mesajın okunur metni: Slack blokları (rich_text: bölüm/liste/alıntı/kod; section/header/context) ve eski tip
 * ekler (attachments: pretext/title/text/fallback). Uygulama/iş akışı mesajları ve bazı istemciler `text`'i boş bırakıp
 * içeriği yalnız bloklarda taşıyor → eskiden bu mesajlar tamamen atılıyordu.
 */
export function blocksText(blocks: J[] | undefined, attachments?: J[]): string {
  const inline = (els: J[] | undefined): string =>
    (els ?? [])
      .map((e) => {
        switch (e?.type) {
          case 'text':
            return String(e.text ?? '');
          case 'link':
            return e.text && e.text !== e.url ? `${e.text} (${e.url})` : String(e.url ?? '');
          case 'user':
            return `<@${e.user_id}>`;
          case 'channel':
            return `#${e.channel_id}`;
          case 'usergroup':
            return '@grup';
          case 'broadcast':
            return `@${e.range ?? 'here'}`;
          case 'emoji':
            try {
              return e.unicode ? String.fromCodePoint(...String(e.unicode).split('-').map((h: string) => parseInt(h, 16))) : SLACK_EMOJI[e.name] ?? `:${e.name}:`;
            } catch {
              return `:${e.name}:`;
            }
          case 'date':
            return String(e.fallback ?? '');
          case 'rich_text_list':
            return (e.elements ?? []).map((x: J) => '• ' + inline(x.elements)).join('\n');
          default:
            return e?.elements ? inline(e.elements) : typeof e?.text === 'string' ? e.text : e?.text?.text ?? '';
        }
      })
      .join('');
  const out: string[] = [];
  for (const b of blocks ?? []) {
    if (b?.type === 'rich_text') out.push((b.elements ?? []).map((sec: J) => inline([sec])).join('\n'));
    else if (b?.type === 'section' || b?.type === 'header') out.push([b.text?.text, ...((b.fields ?? []) as J[]).map((f) => f?.text)].filter(Boolean).join('\n'));
    else if (b?.type === 'context') out.push(((b.elements ?? []) as J[]).map((x) => x?.text ?? '').filter(Boolean).join(' '));
  }
  let text = out.filter((x) => x.trim()).join('\n');
  if (!text.trim()) text = ((attachments ?? []) as J[]).map((x) => [x.pretext, x.title, x.text].filter(Boolean).join('\n') || x.fallback || '').filter(Boolean).join('\n');
  return text;
}

/** Mesajın ham metni: `text`, boşsa bloklar/ekler (Slack biçimi — formatSlackText ile çözülür) */
export function rawSlackText(m: J): string {
  const t = String(m.text ?? '');
  return t.trim() ? t : blocksText(m.blocks as J[] | undefined, m.attachments as J[] | undefined);
}

async function toMsg(page: Page, m: J): Promise<Msg | undefined> {
  if (m.subtype && SKIP_SUBTYPES.has(String(m.subtype))) return undefined;
  const files = ((m.files ?? []) as J[]).filter((f) => f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
  const raw = rawSlackText(m);
  // boş mesaj için ad araması yapma (her biri bir users.info isteği)
  if (!raw.trim() && !files.length) return undefined;
  const uid = String(m.user ?? m.bot_id ?? '');
  const u = m.subtype === 'bot_message' && m.username ? { name: String(m.username), avatar: m.icons?.image_64 } : await userInfo(page, uid);
  const text = formatSlackText(raw, users);
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
    edited: m.edited ? true : undefined,
  };
}

/** Deponun yazdığı önizlemeyle aynı biçim (birebirde yalnız metin, grup/kanalda "Ad: metin" / "Sen: metin") */
function previewOf(kind: Thread['kind'], p: { body: string; fromMe: boolean; sender: string } | undefined): string {
  if (!p?.body) return '';
  return kind !== 'direct' ? `${p.fromMe ? 'Sen' : p.sender.split(/\s+/)[0] || '?'}: ${p.body}` : p.body;
}

export const slackStrategy: Strategy = {
  home: SIGNIN,
  loginHint: 'Açılan pencerede Slack\'e giriş yap (e-posta kodu / Google), listeden çalışma alanını AÇ — giriş ancak çalışma alanı açılınca tamamlanır',
  parallel: true,

  pageless: true,

  /**
   * Anlık sinyal: web istemcisinin KENDİ gerçek zamanlı soketi (wss-primary/backup.slack.com, RTM JSON çerçeveleri) pasif
   * dinlenir — soket açılmaz/yazılmaz, ek istek yok. Yeni mesaj / okundu / tepki olayı → yoklama öne çekilir; presence,
   * yazıyor, ping çerçeveleri yalnız "canlı" sayılır. Sayfa yalnız Mivelo öndeyken açık (registry keepOpen: whileActive).
   */
  watchSockets: [{ url: /wss(-primary|-backup|-mobile)?\.slack\.com/, event: /"type":"(message|im_marked|channel_marked|group_marked|mpim_marked|reaction_added|reaction_removed)"/ }],

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
    let listErr = '';
    await loadConversationList(page).catch((e) => {
      listErr = slackErrCode(e);
      logOnce('warn', `list:${listErr}`, `conversations.list başarısız (${listErr}); adlar tek tek conversations.info ile alınacak`);
    });
    const out: Thread[] = [];
    const infoErr = (e: unknown) => {
      const code = slackErrCode(e);
      logOnce('warn', `info:${code}`, `conversations.info başarısız (${code})`);
    };
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
        const uid =
          meta?.user ??
          (await slack(page, 'conversations.info', { channel: id })
            .then((r) => {
              const u = String(r.channel?.user ?? '');
              // tek tek alınan DM de önbelleğe (her turda yeniden istenmesin)
              if (u) chans.set(id, { name: '', kind: 'direct', user: u });
              return u;
            })
            .catch((e) => (infoErr(e), '')));
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
        } catch (e) {
          infoErr(e);
          name = id;
        }
      }
      // Okunmamış: DM/grup DM'de her mesaj sayılır (mention_count); kanalda mention yoksa has_unreads → 1
      const unread = Number(c.mention_count ?? 0) || (c.has_unreads ? (kind === 'channel' ? 1 : Number(c.unread_count ?? 1)) : 0);
      let lastTs = Math.floor(Number(c.latest ?? 0) * 1000);
      // yanıtları sonraya kalan kanal: zaman 1 ms ileri (köprü "değişti" sayıp messages()'ı yeniden çağırsın; sıra neredeyse hiç kaymaz)
      if (pendingReplies.has(id)) lastTs = Math.max(lastTs, (lastThreadTs.get(id) ?? 0) + 1);
      lastThreadTs.set(id, lastTs);
      out.push({ id, name: name || id, kind, lastTs, preview: previewOf(kind, lastSeen.get(id)), unread, avatarUrl: avatar, handle, participants });
    };
    for (const c of counts.ims ?? []) await push(c, 'direct');
    for (const c of counts.mpims ?? []) await push(c, 'group');
    for (const c of counts.channels ?? []) if (c.is_member !== false) await push(c, 'channel');
    // Tanı (yarım saatte bir): sayılar, adı çözülen sohbetler, anahtarın kaynağı, adres ve mod — içerik yok
    if (Date.now() - (warned.get('threads-diag') ?? 0) < 30 * 60_000) return out;
    const t = await team(page).catch(() => undefined);
    const named = out.filter((x) => x.name !== x.id).length;
    logOnce(
      'info',
      'threads-diag',
      `tanı: ${(counts.ims ?? []).length} birebir, ${(counts.mpims ?? []).length} grup, ${(counts.channels ?? []).length} kanal (listede ${out.length}); adı çözülen ${named}/${out.length}; ` +
        `conversations.list ${listErr || 'ok'}; anahtar ${t?.source ?? '?'}; adres ${apiOf(page) ? 'sayfasız' : 'sayfa'}→${apiUrls(t ?? { domain: '', url: '' }, 'x')[0].startsWith('https://app.slack.com/') ? 'app.slack.com' : 'çalışma alanı'}`,
      30 * 60_000,
    );
    return out;
  },

  async messages(page, _cookies, threadId, limit, before): Promise<Msg[]> {
    const started = Date.now();
    const params: Record<string, string | number | boolean> = { channel: threadId, limit };
    if (before) {
      // Slack ts saniye.mikrosaniye; before ms → saniye, inclusive=false → kesinlikle daha eski
      params.latest = (before / 1000).toFixed(6);
      params.inclusive = false;
    }
    let r: J;
    try {
      r = await slack(page, 'conversations.history', params);
    } catch (e) {
      // köprü de özet yazar; burada kod + sohbet türü (D/C/G) — bir sonraki günlük kararı versin
      const code = slackErrCode(e);
      logOnce('warn', `history:${code}`, `conversations.history başarısız (${code}; ${threadId.slice(0, 1)}…; ${String((e as Error).message).match(/\(HTTP [^)]*\)/)?.[0] ?? ''})`, 5 * 60_000);
      throw e;
    }
    const rawMsgs = (r.messages ?? []) as J[];
    const msgs: Msg[] = [];
    for (const m of rawMsgs) {
      const msg = await toMsg(page, m);
      if (msg) msgs.push(msg);
    }
    // Tanı: ham mesaj vardı ama hepsi elendi ya da hiç mesaj dönmedi (ücretsiz planda 90 günden eskiler gizli: is_limited)
    if (!before && rawMsgs.length && !msgs.length)
      logOnce('warn', 'history-filtered', `conversations.history ${rawMsgs.length} ham mesaj döndü ama hiçbiri okunamadı (alt türler: ${[...new Set(rawMsgs.map((m) => String(m.subtype ?? 'yok')))].slice(0, 5).join(',')}; metin alanı boş: ${rawMsgs.filter((m) => !String(m.text ?? '').trim()).length})`);
    if (!before && !rawMsgs.length && r.is_limited) logOnce('warn', 'history-limited', 'conversations.history boş ve is_limited: Slack ücretsiz planı eski mesajları gizliyor');
    if (!before && historyLogged < 1) {
      historyLogged++;
      bus.log('info', `slack: tanı: ilk conversations.history → ${rawMsgs.length} ham, ${msgs.length} mesaj${r.has_more ? ', has_more' : ''}${r.is_limited ? ', is_limited' : ''} (${Date.now() - started} ms)`);
    }
    // İş parçacığı yanıtları history'de görünmez: reply_count'lu üst mesajların yanıtları (yeni yanıt geldiyse) ayrıca çekilir
    // yanıtı değişmiş diziler, en yeni yanıtlı önce; çağrı başına bütçe, kalanlar sonraki turlara (pendingReplies)
    const due = rawMsgs
      .filter((m) => m.reply_count && m.ts && threadsSeen.get(`${threadId}/${m.ts}`)?.latest !== String(m.latest_reply ?? m.reply_count))
      .sort((a, b) => Number(b.latest_reply ?? b.ts) - Number(a.latest_reply ?? a.ts));
    let left = due.length > REPLIES_PER_CALL;
    for (const m of due.slice(0, REPLIES_PER_CALL)) {
      // Yanıtlar ikincil: hız sınırı beklemesinde ya da çağrı süresi dolmuşsa sonraki tura (geçmiş yine döner). Eskiden yanıttaki
      // hız sınırı tüm çağrıyı fırlatıyordu → aynı sohbetin zaten alınmış geçmişi de atılıyor, iş parçacığı yoğun kanal hiç dolmuyordu.
      if (Date.now() < repliesPausedUntil || Date.now() - started > CALL_BUDGET_MS) {
        left = true;
        break;
      }
      const key = `${threadId}/${m.ts}`;
      const latest = String(m.latest_reply ?? m.reply_count);
      const prev = threadsSeen.get(key);
      try {
        // conversations.replies eskiden yeniye döner: sabit limitle uzun dizilerde yeni yanıtlar hiç gelmiyordu.
        // Son alınan yanıttan sonrası (oldest) istenir ve imleçle sayfalanır (çağrı başına en çok REPLY_PAGES × 200; kalan sonraki turda).
        let newest = prev?.newest ?? '';
        let cursor = '';
        let more = false;
        for (let page_ = 0; page_ < REPLY_PAGES; page_++) {
          const rep = await slack(page, 'conversations.replies', {
            channel: threadId,
            ts: String(m.ts),
            limit: 200,
            ...(prev?.newest ? { oldest: prev.newest, inclusive: false } : {}),
            ...(cursor ? { cursor } : {}),
          });
          for (const x of (rep.messages ?? []) as J[]) {
            if (String(x.ts) === String(m.ts)) continue;
            if (!newest || Number(x.ts) > Number(newest)) newest = String(x.ts);
            const msg = await toMsg(page, x);
            if (msg) msgs.push({ ...msg, threadId: String(m.ts) });
          }
          cursor = String(rep.response_metadata?.next_cursor ?? '');
          more = !!cursor && !!rep.has_more;
          if (!more) break;
        }
        // sayfalar bitmediyse dizi "görüldü" sayılmaz: sonraki çağrı `newest`ten devam eder
        threadsSeen.set(key, { latest: more ? '' : latest, newest });
        if (more) left = true;
      } catch (e) {
        const code = slackErrCode(e);
        if (RATE_RE.test((e as Error).message)) {
          // hız sınırı: dizi "görüldü" sayılmaz, yanıtlar Retry-After (yoksa 60 sn) boyunca istenmez; kanal değişmiş kalır
          repliesPausedUntil = Date.now() + Math.min(Math.max((e as { retryAfter?: number }).retryAfter ?? 60, 10), 600) * 1000;
          logOnce('warn', 'replies-rate', `conversations.replies hız sınırı; yanıtlar ${Math.round((repliesPausedUntil - Date.now()) / 1000)} sn sonra, geçmiş alınmaya devam ediyor`);
          left = true;
          break;
        }
        // Diğer hatada (dizi silinmiş vb.) bu latest_reply atlanır: her turda yeniden denenip sohbeti sürekli "değişmiş" tutmasın
        logOnce('warn', `replies:${code}`, `conversations.replies başarısız (${code})`);
        threadsSeen.set(key, { latest, newest: prev?.newest ?? '' });
      }
    }
    if (left) pendingReplies.add(threadId);
    else if (!before) pendingReplies.delete(threadId);
    msgs.sort((a, b) => a.ts - b.ts);
    // son üst düzey mesaj → listedeki önizleme (threads())
    if (!before) {
      const last = [...msgs].reverse().find((m) => !m.threadId);
      if (last && (lastSeen.get(threadId)?.ts ?? 0) <= last.ts)
        lastSeen.set(threadId, { ts: last.ts, body: last.text || (last.attachments?.length ? `[${last.attachments[0].name ?? last.attachments[0].kind}]` : ''), fromMe: last.fromMe, sender: last.senderName });
    }
    return msgs;
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

  /** Herkesten sil (chat.delete; yalnız kendi mesajım) */
  async unsend(page, _cookies, threadId, msgId) {
    await slack(page, 'chat.delete', { channel: threadId, ts: msgId });
  },

  /** Metni düzenle (chat.update) */
  async edit(page, _cookies, threadId, msgId, text) {
    await slack(page, 'chat.update', { channel: threadId, ts: msgId, text, as_user: true });
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
  threadsSeen.clear();
  pendingReplies.clear();
  lastThreadTs.clear();
  meId = '';
  listLoadedAt = 0;
  learned.base = '';
  learned.query = {};
  learned.xid = '';
  captured.length = 0;
  sameOriginUntil = 0;
  userMiss.clear();
  warned.clear();
  lastSeen.clear();
  repliesPausedUntil = 0;
  historyLogged = 0;
  lastNav = 0;
}
