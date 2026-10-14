import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR, PORT } from '../config.js';
import { bus } from '../bus.js';
import { openExternal } from '../platform.js';
import { takeOAuthExtra, waitOAuth } from './callback.js';

/**
 * Resmi giriş (OAuth 2.0): hesaplar sağlayıcının KENDİ giriş sayfasıyla, kullanıcının varsayılan tarayıcısında bağlanır
 * (RFC 8252 "yerel uygulamalar için OAuth": gömülü/otomasyonlu tarayıcı yok, şifre Mivelo'ya hiç girilmez).
 *
 * İstemci kimlikleri (client_id) Mivelo'nun sağlayıcılarda açtığı uygulamalara aittir ve mivelo.app'ten okunur
 * (`oauth.php?action=config`; depoda gizli yok). İstemci gizi (client_secret) gereken sağlayıcılarda kod → belirteç
 * değişimi mivelo.app aracısında yapılır (gizi sunucuda, ~/mivelo-data); belirteçler orada SAKLANMAZ, yalnız geçer.
 * Microsoft gizisiz (genel istemci + PKCE) → değişim doğrudan bu bilgisayardan. Instagram uzun ömürlü belirteç yenilemesi de gizisiz.
 *
 * Geri dönüş: Google/Microsoft doğrudan yerel adrese (127.0.0.1 / localhost geri döngüsü); HTTPS isteyen sağlayıcılar
 * (Slack, Meta, Yahoo, Yandex) önce `https://mivelo.app/api/oauth-cb.php`'ye döner, o sayfa kodu yerel `/oauth/callback`'e
 * yönlendirir (state'in sonundaki port ile). Kod tek başına işe yaramaz (gizi/PKCE gerekir).
 */
export type OAuthProvider = 'google' | 'microsoft' | 'yahoo' | 'yandex' | 'slack' | 'instagram' | 'facebook' | 'whatsapp';
export const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'microsoft', 'yahoo', 'yandex', 'slack', 'instagram', 'facebook', 'whatsapp'];

export const OAUTH_BROKER = process.env.MIVELO_OAUTH_BROKER ?? 'https://mivelo.app/api/oauth.php';
export const OAUTH_BOUNCE = process.env.MIVELO_OAUTH_BOUNCE ?? 'https://mivelo.app/api/oauth-cb.php';
/**
 * WhatsApp Business (Cloud API) girişi = Meta "Embedded Signup": Facebook JS SDK'sı ister → mivelo.app'teki sayfa açılır; sayfa numara
 * seçimini (phone_number_id, waba_id) ve yetki kodunu yerel /oauth/callback'e taşır (state'teki port). Belirteç değişimi aracıda.
 */
export const WA_SIGNUP = process.env.MIVELO_WA_SIGNUP ?? 'https://mivelo.app/api/wa-signup.php';
/** Meta Graph API sürümü (yapılandırmadan değiştirilebilir) */
export const DEFAULT_GRAPH_VERSION = 'v23.0';

/** Sağlayıcıların arayüzdeki adı (durum metinlerinde) */
export const PROVIDER_NAME: Record<OAuthProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  yahoo: 'Yahoo',
  yandex: 'Yandex',
  slack: 'Slack',
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
};

export interface ProviderSpec {
  authUrl: string;
  /** yerel değişim (gizisiz) için belirteç adresi */
  tokenUrl?: string;
  scopes: string[];
  /** kapsam ayırıcı (Meta: virgül) */
  scopeSep?: string;
  /** kapsam parametresinin adı (Slack kullanıcı belirteci: user_scope) */
  scopeParam?: string;
  redirect: 'loopback-127' | 'loopback-localhost' | 'bounce';
  exchange: 'local' | 'broker';
  pkce: boolean;
  extra?: Record<string, string>;
  loginHintParam?: string;
}

export const SPECS: Record<OAuthProvider, ProviderSpec> = {
  // Gmail: IMAP/SMTP XOAUTH2 (https://mail.google.com/ kısıtlı kapsam: herkese açık uygulama için Google doğrulaması gerekir)
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['openid', 'email', 'https://mail.google.com/'],
    redirect: 'loopback-127',
    exchange: 'broker',
    pkce: true,
    extra: { access_type: 'offline', prompt: 'consent' },
    loginHintParam: 'login_hint',
  },
  // Outlook.com / Hotmail / Microsoft 365: IMAP + SMTP XOAUTH2, genel istemci (gizisiz) + PKCE
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'profile', 'offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
    redirect: 'loopback-localhost',
    exchange: 'local',
    pkce: true,
    extra: { prompt: 'select_account' },
    loginHintParam: 'login_hint',
  },
  // Yahoo Mail: IMAP/SMTP XOAUTH2 (mail-w: Yahoo'nun Mail API erişim onayı gerekir)
  yahoo: {
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    scopes: ['openid', 'email', 'mail-w'],
    redirect: 'bounce',
    exchange: 'broker',
    pkce: false,
    loginHintParam: 'login_hint',
  },
  // Yandex Mail: IMAP/SMTP XOAUTH2
  yandex: {
    authUrl: 'https://oauth.yandex.com/authorize',
    scopes: ['login:email', 'login:info', 'mail:imap_full', 'mail:smtp'],
    redirect: 'bounce',
    exchange: 'broker',
    pkce: true,
    extra: { force_confirm: 'yes' },
    loginHintParam: 'login_hint',
  },
  // Slack: OAuth v2, kullanıcı belirteci (xoxp) — mesajlar kullanıcının kendi adıyla
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    scopes: [
      'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write',
      'reactions:read', 'reactions:write', 'files:read', 'files:write', 'channels:write', 'groups:write', 'im:write', 'mpim:write',
    ],
    scopeSep: ',',
    scopeParam: 'user_scope',
    redirect: 'bounce',
    exchange: 'broker',
    pkce: false,
  },
  // Instagram API with Instagram Login: yalnız profesyonel (işletme/içerik üretici) hesaplar
  instagram: {
    authUrl: 'https://www.instagram.com/oauth/authorize',
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    scopeSep: ',',
    redirect: 'bounce',
    exchange: 'broker',
    pkce: false,
    extra: { enable_fb_login: '0', force_authentication: '1' },
  },
  // Messenger Platform: Facebook Sayfası mesajları (kişisel Messenger değil)
  facebook: {
    authUrl: `https://www.facebook.com/${DEFAULT_GRAPH_VERSION}/dialog/oauth`,
    scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'],
    scopeSep: ',',
    redirect: 'bounce',
    exchange: 'broker',
    pkce: false,
  },
  // WhatsApp Business Platform (Cloud API): Embedded Signup sayfası mivelo.app'te (kapsamlar Meta'daki yapılandırmada, config_id)
  whatsapp: {
    authUrl: WA_SIGNUP,
    scopes: [],
    redirect: 'bounce',
    exchange: 'broker',
    pkce: false,
  },
};

// ───────────── Yapılandırma (mivelo.app) ─────────────

export interface ProviderConfig {
  clientId: string;
  /** isteğe bağlı: sağlayıcıda onaylanan kapsamlar varsayılandan farklıysa */
  scopes?: string[];
  /** Meta Graph API sürümü */
  graphVersion?: string;
  /** Slack: uygulama Slack Marketplace'te değil → conversations.history/replies dakikada 1 istek, ≤15 mesaj */
  historyLimited?: boolean;
  /** Facebook: "İşletmeler için Facebook Girişi" yapılandırma kimliği (varsa kapsam yerine config_id gönderilir); WhatsApp: Embedded Signup yapılandırması */
  configId?: string;
}
export type OAuthConfig = Partial<Record<OAuthProvider, ProviderConfig>>;

const CACHE_FILE = path.join(DATA_DIR, 'oauth-config.json');
const TTL_MS = 6 * 3600_000;
let cache: { at: number; cfg: OAuthConfig } | undefined;
let inflight: Promise<OAuthConfig> | undefined;

function validConfig(v: unknown): OAuthConfig {
  const out: OAuthConfig = {};
  if (!v || typeof v !== 'object') return out;
  const src = ((v as { providers?: unknown }).providers ?? v) as Record<string, unknown>;
  for (const p of OAUTH_PROVIDERS) {
    const c = src?.[p] as Record<string, unknown> | undefined;
    const id = typeof c?.clientId === 'string' ? c.clientId.trim() : '';
    if (!id || id.length > 300 || /\s/.test(id)) continue;
    const pc: ProviderConfig = { clientId: id };
    if (Array.isArray(c?.scopes) && c.scopes.every((s) => typeof s === 'string' && s.length < 120)) pc.scopes = c.scopes as string[];
    if (typeof c?.graphVersion === 'string' && /^v\d{1,2}\.\d$/.test(c.graphVersion)) pc.graphVersion = c.graphVersion;
    if (typeof c?.historyLimited === 'boolean') pc.historyLimited = c.historyLimited;
    if (typeof c?.configId === 'string' && /^\d{5,30}$/.test(c.configId)) pc.configId = c.configId;
    out[p] = pc;
  }
  return out;
}

/** Ortam: MIVELO_OAUTH_CONFIG (JSON ya da dosya yolu) ve MIVELO_OAUTH_<SAĞLAYICI>_ID — geliştirme/test için */
function envConfig(): OAuthConfig {
  let out: OAuthConfig = {};
  const raw = process.env.MIVELO_OAUTH_CONFIG?.trim();
  if (raw) {
    try {
      out = validConfig(JSON.parse(raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')));
    } catch {
      bus.log('warn', 'MIVELO_OAUTH_CONFIG okunamadı');
    }
  }
  for (const p of OAUTH_PROVIDERS) {
    const id = process.env[`MIVELO_OAUTH_${p.toUpperCase()}_ID`]?.trim();
    if (id) out[p] = { ...(out[p] ?? {}), clientId: id };
  }
  return out;
}

async function fetchRemote(): Promise<OAuthConfig | undefined> {
  if (process.env.MIVELO_OAUTH_REMOTE === '0') return undefined;
  try {
    const r = await fetch(`${OAUTH_BROKER}?action=config`, { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } });
    if (!r.ok) return undefined;
    const j = (await r.json()) as unknown;
    const cfg = validConfig(j);
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), providers: cfg }), { mode: 0o600 });
    } catch {
      /* önbellek yazılamadı */
    }
    return cfg;
  } catch {
    return undefined;
  }
}

function diskCache(): OAuthConfig | undefined {
  try {
    return validConfig(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Etkin sağlayıcılar ve istemci kimlikleri. Sıra: ortam değişkeni > mivelo.app (6 sa bellek önbelleği) > son kayıtlı kopya.
 * force: önbelleği atla (Bağlan penceresi açılınca).
 */
export async function oauthConfig(force = false): Promise<OAuthConfig> {
  const env = envConfig();
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { ...cache.cfg, ...env };
  inflight ??= (async () => {
    const remote = await fetchRemote();
    const cfg = remote ?? diskCache() ?? cache?.cfg ?? {};
    // uzak yanıt yoksa kısa süre sonra yeniden denensin (6 sa değil 5 dk)
    cache = { at: remote ? Date.now() : Date.now() - TTL_MS + 5 * 60_000, cfg };
    return cfg;
  })().finally(() => (inflight = undefined));
  return { ...(await inflight), ...env };
}

export async function providerConfig(p: OAuthProvider): Promise<ProviderConfig | undefined> {
  return (await oauthConfig())[p];
}

/** Testler: önbelleği sıfırla */
export function resetOAuthConfigCache(): void {
  cache = undefined;
}

// ───────────── Yardımcılar ─────────────

export function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair(verifier = base64url(randomBytes(32))): { verifier: string; challenge: string } {
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function redirectUri(p: OAuthProvider, port = PORT): string {
  const r = SPECS[p].redirect;
  if (r === 'bounce') return OAUTH_BOUNCE;
  return `http://${r === 'loopback-localhost' ? 'localhost' : '127.0.0.1'}:${port}/oauth/callback`;
}

/** Aracı geri dönüşü için state: rastgele + "." + yerel port (oauth-cb.php kullanıcıyı bu porta yönlendirir) */
export function makeState(p: OAuthProvider, port = PORT): string {
  const nonce = base64url(randomBytes(18));
  return SPECS[p].redirect === 'bounce' ? `${nonce}.${port}` : nonce;
}

export function buildAuthUrl(p: OAuthProvider, cfg: ProviderConfig, o: { state: string; challenge?: string; loginHint?: string; port?: number }): string {
  const s = SPECS[p];
  const scopes = cfg.scopes?.length ? cfg.scopes : s.scopes;
  const base = p === 'facebook' && cfg.graphVersion ? s.authUrl.replace(DEFAULT_GRAPH_VERSION, cfg.graphVersion) : s.authUrl;
  // WhatsApp: Embedded Signup sayfası uygulama kimliği/yapılandırmayı sunucudan okur; yalnız state (içinde yerel port) taşınır
  if (p === 'whatsapp') return `${base}?${new URLSearchParams({ state: o.state }).toString()}`;
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri(p, o.port), response_type: 'code', state: o.state });
  // İşletmeler için Facebook Girişi: izinler Meta'daki yapılandırmada; kapsam yerine config_id
  if (p === 'facebook' && cfg.configId) q.set('config_id', cfg.configId);
  else q.set(s.scopeParam ?? 'scope', scopes.join(s.scopeSep ?? ' '));
  if (s.pkce && o.challenge) {
    q.set('code_challenge', o.challenge);
    q.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(s.extra ?? {})) q.set(k, v);
  if (o.loginHint && s.loginHintParam) q.set(s.loginHintParam, o.loginHint);
  return `${base}?${q.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ms */
  expiresAt?: number;
  idToken?: string;
  /** sağlayıcının ham yanıtı (Slack authed_user/team, Instagram user_id, Facebook sayfaları…) */
  raw: Record<string, unknown>;
}

function toTokenSet(j: Record<string, unknown>, prev?: { refreshToken?: string }): TokenSet {
  // Slack yalnız kullanıcı kapsamı istenince belirteç authed_user içinde gelir (üst düzeyde access_token yok)
  const au = (j.authed_user ?? {}) as Record<string, unknown>;
  const access = typeof j.access_token === 'string' ? j.access_token : typeof au.access_token === 'string' ? au.access_token : '';
  if (!access) {
    const err = (j.error_description ?? j.error_message ?? (typeof j.error === 'object' ? (j.error as { message?: string }).message : j.error) ?? 'belirteç alınamadı') as string;
    throw new OAuthError(String(err), typeof j.error === 'string' ? j.error : undefined);
  }
  const exp = Number(j.expires_in);
  return {
    accessToken: access,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : typeof au.refresh_token === 'string' ? au.refresh_token : prev?.refreshToken,
    expiresAt: Number.isFinite(exp) && exp > 0 ? Date.now() + exp * 1000 : undefined,
    idToken: typeof j.id_token === 'string' ? j.id_token : undefined,
    raw: j,
  };
}

export class OAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
  /** yenileme belirteci geçersiz/iptal: kullanıcı yeniden giriş yapmalı */
  get revoked(): boolean {
    return /invalid_grant|invalid_token|invalid_refresh_token|token_revoked|expired|revoked|unauthorized/i.test(`${this.code ?? ''} ${this.message}`);
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  return (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as Record<string, unknown>;
}

async function broker(action: 'token' | 'refresh', body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(`${OAUTH_BROKER}?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const j = (await r.json().catch(() => ({ error: `Mivelo giriş sunucusu yanıt vermedi (HTTP ${r.status})` }))) as Record<string, unknown>;
  return j;
}

/** Yetki kodu → belirteç */
export async function exchangeCode(p: OAuthProvider, cfg: ProviderConfig, code: string, verifier?: string, port = PORT): Promise<TokenSet> {
  const s = SPECS[p];
  const redirect_uri = redirectUri(p, port);
  if (s.exchange === 'local') {
    const body: Record<string, string> = { client_id: cfg.clientId, grant_type: 'authorization_code', code, redirect_uri };
    if (verifier) body.code_verifier = verifier;
    if (p === 'microsoft') body.scope = (cfg.scopes?.length ? cfg.scopes : s.scopes).join(' ');
    return toTokenSet(await postForm(s.tokenUrl!, body));
  }
  const body: Record<string, string> = { provider: p, code, redirect_uri };
  if (verifier && s.pkce) body.code_verifier = verifier;
  return toTokenSet(await broker('token', body));
}

/** Erişim belirtecini yenile. Yenileme belirteci geçersizse OAuthError.revoked */
export async function refreshToken(p: OAuthProvider, refresh: string): Promise<TokenSet> {
  const cfg = await providerConfig(p);
  if (!cfg) throw new OAuthError(`${PROVIDER_NAME[p]} resmi girişi şu an kapalı`);
  const s = SPECS[p];
  if (p === 'instagram') {
    // uzun ömürlü Instagram belirteci gizisiz yenilenir (≥24 sa yaşında, süresi dolmamış olmalı); "refresh" = erişim belirtecinin kendisi
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(refresh)}`, { signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const t = toTokenSet(j);
    return { ...t, refreshToken: t.accessToken };
  }
  if (s.exchange === 'local') {
    const body: Record<string, string> = { client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: refresh };
    if (p === 'microsoft') body.scope = (cfg.scopes?.length ? cfg.scopes : s.scopes).join(' ');
    return toTokenSet(await postForm(s.tokenUrl!, body), { refreshToken: refresh });
  }
  return toTokenSet(await broker('refresh', { provider: p, refresh_token: refresh }), { refreshToken: refresh });
}

/** id_token yükünü çöz (imza doğrulanmaz: belirteç doğrudan sağlayıcının TLS'li belirteç ucundan/aracıdan geldi) */
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> {
  if (!idToken) return {};
  try {
    const part = idToken.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** E-posta sağlayıcısında giriş yapılan adres (IMAP/SMTP XOAUTH2 kullanıcı adı) */
export async function mailIdentity(p: OAuthProvider, t: TokenSet): Promise<{ email: string; name?: string }> {
  const c = idTokenClaims(t.idToken);
  const pick = (v: unknown) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : '');
  const name = typeof c.name === 'string' ? c.name : undefined;
  let email = pick(c.email) || (p === 'microsoft' ? pick(c.preferred_username) || pick(c.upn) : '');
  if (!email) {
    try {
      if (p === 'google') {
        const j = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${t.accessToken}` }, signal: AbortSignal.timeout(10_000) })).json()) as Record<string, unknown>;
        email = pick(j.email);
      } else if (p === 'yahoo') {
        const j = (await (await fetch('https://api.login.yahoo.com/openid/v1/userinfo', { headers: { authorization: `Bearer ${t.accessToken}` }, signal: AbortSignal.timeout(10_000) })).json()) as Record<string, unknown>;
        email = pick(j.email);
      } else if (p === 'yandex') {
        const j = (await (await fetch('https://login.yandex.ru/info?format=json', { headers: { authorization: `OAuth ${t.accessToken}` }, signal: AbortSignal.timeout(10_000) })).json()) as Record<string, unknown>;
        email = pick(j.default_email) || (typeof j.login === 'string' && j.login ? `${j.login}@yandex.com` : '');
      }
    } catch {
      /* aşağıda hata */
    }
  }
  if (!email) throw new OAuthError(`${PROVIDER_NAME[p]} e-posta adresini vermedi; girişi yeniden dene`);
  return { email, name };
}

// ───────────── Etkileşimli giriş ─────────────

export interface AuthorizeOptions {
  loginHint?: string;
  signal?: AbortSignal;
  /** giriş adresi hazır (arayüz "Sayfayı tekrar aç" için saklar) */
  onUrl?: (url: string) => void;
  /** tarayıcıyı açma (testler) */
  noBrowser?: boolean;
  /** kod alındı, belirteç değişimi başlıyor */
  onExchange?: () => void;
  timeoutMs?: number;
}

/**
 * Sağlayıcının giriş sayfasını varsayılan tarayıcıda aç, geri dönüşü bekle, kodu belirtece çevir.
 * Sağlayıcı yapılandırılmamışsa (Mivelo uygulaması henüz kayıtlı değil) hata.
 */
export async function authorize(p: OAuthProvider, o: AuthorizeOptions = {}): Promise<TokenSet> {
  const cfg = await providerConfig(p);
  if (!cfg) throw new OAuthError(`${PROVIDER_NAME[p]} resmi girişi henüz etkin değil`);
  const state = makeState(p);
  const { verifier, challenge } = pkcePair();
  const url = buildAuthUrl(p, cfg, { state, challenge: SPECS[p].pkce ? challenge : undefined, loginHint: o.loginHint });
  const code = waitOAuth(state, o.timeoutMs ?? 600_000, o.signal);
  o.onUrl?.(url);
  if (!o.noBrowser) openExternal(url);
  const c = await code;
  o.onExchange?.();
  const t = await exchangeCode(p, cfg, c, SPECS[p].pkce ? verifier : undefined);
  // geri dönüşle gelen ek alanlar (WhatsApp Embedded Signup: phone_number_id, waba_id) belirteç yanıtının yanına
  const extra = takeOAuthExtra(state);
  return extra ? { ...t, raw: { ...t.raw, ...extra } } : t;
}
