import { randomBytes } from 'node:crypto';
import type { Account, Platform } from '../model.js';
import { bus } from '../bus.js';
import { openExternal } from '../platform.js';
import { DEFAULT_GRAPH_VERSION, OAuthError, PROVIDER_NAME, authorize, mailIdentity, oauthConfig, type OAuthProvider, type TokenSet } from './index.js';
import { graphGet, graphPost, relayRegister } from '../connectors/whatsapp-cloud.js';

/**
 * Bağlan → "resmi giriş" akışı: hesap ÖNCE açılmaz; sağlayıcıda giriş tamamlanınca belirteçten hesap yapılandırması kurulur ve
 * registry.add ile eklenir (aynı adres/çalışma alanı varsa var olan hesap güncellenir). Arayüz akışı /api/oauth/flows/:id ile izler.
 */
export const OFFICIAL_PROVIDER: Partial<Record<Platform, OAuthProvider>> = {
  gmail: 'google',
  outlook: 'microsoft',
  yahoo: 'yahoo',
  yandex: 'yandex',
  slack: 'slack',
  instagram: 'instagram',
  messenger: 'facebook',
  whatsapp: 'whatsapp',
};

/** Resmi girişi açık (Mivelo uygulaması sağlayıcıda kayıtlı ve mivelo.app yapılandırmasında) platformlar */
export async function officialPlatforms(force = false): Promise<Platform[]> {
  const cfg = await oauthConfig(force);
  return (Object.entries(OFFICIAL_PROVIDER) as Array<[Platform, OAuthProvider]>).filter(([, p]) => !!cfg[p]).map(([pl]) => pl);
}

export type FlowState = 'waiting' | 'exchanging' | 'done' | 'error' | 'cancelled';
export interface FlowView {
  id: string;
  platform: Platform;
  provider: OAuthProvider;
  state: FlowState;
  url?: string;
  accountId?: string;
  error?: string;
}
interface Flow extends FlowView {
  abort: AbortController;
  endedAt?: number;
}

const flows = new Map<string, Flow>();

function gc(): void {
  const now = Date.now();
  for (const [id, f] of flows) if (f.endedAt && now - f.endedAt > 15 * 60_000) flows.delete(id);
}

export function getFlow(id: string): FlowView | undefined {
  const f = flows.get(id);
  return f && view(f);
}

function view(f: Flow): FlowView {
  return { id: f.id, platform: f.platform, provider: f.provider, state: f.state, url: f.url, accountId: f.accountId, error: f.error };
}

export function cancelFlow(id: string): boolean {
  const f = flows.get(id);
  if (!f || f.state === 'done' || f.state === 'error' || f.state === 'cancelled') return false;
  f.state = 'cancelled';
  f.endedAt = Date.now();
  f.abort.abort();
  return true;
}

export function reopenFlow(id: string): boolean {
  const f = flows.get(id);
  if (!f?.url || f.state !== 'waiting') return false;
  openExternal(f.url);
  return true;
}

export interface FlowDeps {
  add: (platform: Platform, opts: { token: string; label?: string }) => Promise<Account>;
  /** testler: tarayıcıyı açma */
  noBrowser?: boolean;
}

/**
 * Resmi giriş akışını başlat; giriş adresi hazır olunca döner (tarayıcı açılmıştır). Aynı platformda bekleyen eski akış iptal edilir.
 */
export async function startFlow(platform: Platform, deps: FlowDeps, opts: { loginHint?: string } = {}): Promise<FlowView> {
  gc();
  const provider = OFFICIAL_PROVIDER[platform];
  if (!provider) throw new OAuthError(`${platform} için resmi giriş yok`);
  for (const f of flows.values()) if (f.platform === platform && (f.state === 'waiting' || f.state === 'exchanging')) cancelFlow(f.id);
  const f: Flow = { id: randomBytes(9).toString('hex'), platform, provider, state: 'waiting', abort: new AbortController() };
  flows.set(f.id, f);
  let urlReady!: (u?: string) => void;
  const ready = new Promise<string | undefined>((r) => (urlReady = r));
  void (async () => {
    try {
      const tokens = await authorize(provider, {
        loginHint: opts.loginHint,
        signal: f.abort.signal,
        noBrowser: deps.noBrowser,
        onUrl: (u) => {
          f.url = u;
          urlReady(u);
        },
        onExchange: () => {
          if (f.state === 'waiting') f.state = 'exchanging';
        },
      });
      if ((f.state as FlowState) === 'cancelled') return;
      const built = await buildAccountToken(platform, provider, tokens);
      if ((f.state as FlowState) === 'cancelled') return;
      const acc = await deps.add(platform, built);
      f.accountId = acc.id;
      f.state = 'done';
      bus.log('info', `${PROVIDER_NAME[provider]} resmi girişi tamamlandı (${platform})`);
    } catch (e) {
      if ((f.state as FlowState) !== 'cancelled') {
        f.state = 'error';
        f.error = (e as Error).message;
        bus.log('warn', `${PROVIDER_NAME[provider]} resmi girişi başarısız: ${f.error}`);
      }
    } finally {
      f.endedAt = Date.now();
      urlReady(undefined);
    }
  })();
  await ready;
  return view(f);
}

// ───────────── Belirteç → hesap yapılandırması (token dosyası) ─────────────

/** E-posta: MailConfig JSON (IMAP/SMTP sunucuları platform ön ayarından) */
export interface MailOAuthToken {
  user: string;
  oauth: OAuthProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
/** Slack: SlackConnector belirteç dosyası (parseSlackToken {token} alanını okur) */
export interface SlackOAuthToken {
  token: string;
  oauth: 'slack';
  teamId?: string;
  team?: string;
  userId?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Mivelo uygulaması Slack Marketplace'te değil: geçmiş istekleri dakikada 1, ≤15 mesaj */
  historyLimited?: boolean;
}
/** Instagram API (Instagram girişi): profesyonel hesap */
export interface InstagramGraphToken {
  official: 'instagram';
  accessToken: string;
  expiresAt?: number;
  userId: string;
  username?: string;
  graphVersion?: string;
}
/** Messenger Platform: Facebook Sayfaları (sayfa belirteçleri uzun ömürlü kullanıcı belirtecinden: süresiz) */
export interface FacebookPagesToken {
  official: 'facebook';
  userToken: string;
  expiresAt?: number;
  pages: Array<{ id: string; name: string; token: string; igId?: string }>;
  graphVersion?: string;
}

/**
 * WhatsApp Business Platform (Cloud API): Embedded Signup ile seçilen numara. Belirteç işletme sistem kullanıcısı (süresiz) ya da uzun
 * ömürlü kullanıcı belirteci (expiresAt; aracı yeniler). pullKey: mivelo.app webhook aktarıcısından olay çekme anahtarı (hesaba özel).
 */
export interface WhatsAppCloudToken {
  official: 'whatsapp';
  accessToken: string;
  expiresAt?: number;
  phoneNumberId: string;
  wabaId: string;
  displayPhone?: string;
  verifiedName?: string;
  pullKey: string;
  graphVersion?: string;
}

export async function buildAccountToken(platform: Platform, provider: OAuthProvider, t: TokenSet): Promise<{ token: string; label?: string }> {
  const cfg = (await oauthConfig())[provider];
  switch (provider) {
    case 'google':
    case 'microsoft':
    case 'yahoo':
    case 'yandex': {
      const id = await mailIdentity(provider, t);
      const tok: MailOAuthToken = { user: id.email, oauth: provider, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
      if (!tok.refreshToken) throw new OAuthError(`${PROVIDER_NAME[provider]} kalıcı oturum vermedi (yenileme belirteci yok); girişi yeniden dene`);
      return { token: JSON.stringify(tok), label: id.email };
    }
    case 'slack': {
      const u = (t.raw.authed_user ?? {}) as Record<string, unknown>;
      const team = (t.raw.team ?? {}) as Record<string, unknown>;
      // kullanıcı belirteci authed_user içinde (üst düzey access_token varsa o bot belirtecidir)
      const token = typeof u.access_token === 'string' ? u.access_token : t.accessToken;
      if (!token.startsWith('xoxp-') && !token.startsWith('xoxe.xoxp-')) throw new OAuthError('Slack kullanıcı belirteci gelmedi');
      const exp = Number(u.expires_in);
      const tok: SlackOAuthToken = {
        token,
        oauth: 'slack',
        teamId: typeof team.id === 'string' ? team.id : undefined,
        team: typeof team.name === 'string' ? team.name : undefined,
        userId: typeof u.id === 'string' ? u.id : undefined,
        refreshToken: typeof u.refresh_token === 'string' ? u.refresh_token : undefined,
        expiresAt: Number.isFinite(exp) && exp > 0 ? Date.now() + exp * 1000 : undefined,
        historyLimited: cfg?.historyLimited ?? true,
      };
      return { token: JSON.stringify(tok), label: tok.team ? `Slack · ${tok.team}` : 'Slack' };
    }
    case 'instagram': {
      const v = cfg?.graphVersion ?? DEFAULT_GRAPH_VERSION;
      let userId = String(t.raw.user_id ?? '');
      let username: string | undefined;
      try {
        const j = (await (await fetch(`https://graph.instagram.com/${v}/me?fields=user_id,username&access_token=${encodeURIComponent(t.accessToken)}`, { signal: AbortSignal.timeout(15_000) })).json()) as Record<string, unknown>;
        if (j.user_id) userId = String(j.user_id);
        if (typeof j.username === 'string') username = j.username;
      } catch {
        /* kimlik belirteç yanıtından */
      }
      if (!userId) throw new OAuthError('Instagram hesap kimliği alınamadı (yalnız işletme/içerik üretici hesapları)');
      const tok: InstagramGraphToken = { official: 'instagram', accessToken: t.accessToken, expiresAt: t.expiresAt, userId, username, graphVersion: v };
      return { token: JSON.stringify(tok), label: username ? `@${username}` : 'Instagram' };
    }
    case 'facebook': {
      const v = cfg?.graphVersion ?? DEFAULT_GRAPH_VERSION;
      const pages: FacebookPagesToken['pages'] = [];
      let next: string | undefined = `https://graph.facebook.com/${v}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100&access_token=${encodeURIComponent(t.accessToken)}`;
      for (let i = 0; next && i < 5; i++) {
        const j = (await (await fetch(next, { signal: AbortSignal.timeout(15_000) })).json()) as { data?: Array<Record<string, unknown>>; paging?: { next?: string }; error?: { message?: string } };
        if (j.error) throw new OAuthError(`Facebook sayfaları alınamadı: ${j.error.message ?? 'hata'}`);
        for (const p of j.data ?? []) {
          if (typeof p.id === 'string' && typeof p.access_token === 'string') pages.push({ id: p.id, name: String(p.name ?? p.id), token: p.access_token, igId: (p.instagram_business_account as { id?: string } | undefined)?.id });
        }
        next = j.paging?.next;
      }
      if (!pages.length) throw new OAuthError('Bu Facebook hesabının yönettiği bir Sayfa yok (Messenger resmi girişi yalnız Sayfa mesajları içindir)');
      const tok: FacebookPagesToken = { official: 'facebook', userToken: t.accessToken, expiresAt: t.expiresAt, pages, graphVersion: v };
      return { token: JSON.stringify(tok), label: pages.length === 1 ? pages[0]!.name : `${pages[0]!.name} +${pages.length - 1}` };
    }
    case 'whatsapp': {
      const v = cfg?.graphVersion ?? DEFAULT_GRAPH_VERSION;
      const pn = String(t.raw.phone_number_id ?? '');
      const waba = String(t.raw.waba_id ?? '');
      if (!/^\d{5,30}$/.test(pn)) throw new OAuthError('WhatsApp numarası seçilmedi; girişi yeniden başlatıp numarayı seç');
      // numara bu belirteçle okunabiliyor mu (yanlış hesap/yetki yoksa burada düşer)
      const info = await graphGet(v, t.accessToken, pn, 'id,display_phone_number,verified_name');
      // webhook'lar bu uygulamaya aksın (idempotent; yetki yoksa Meta hata döner)
      if (/^\d{5,30}$/.test(waba)) {
        try {
          await graphPost(v, t.accessToken, `${waba}/subscribed_apps`, {});
        } catch (e) {
          throw new OAuthError(`WhatsApp hesabına bildirim aboneliği yapılamadı: ${(e as Error).message}`);
        }
      }
      const pullKey = await relayRegister(pn, waba, t.accessToken);
      const tok: WhatsAppCloudToken = {
        official: 'whatsapp',
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        phoneNumberId: pn,
        wabaId: waba,
        displayPhone: typeof info.display_phone_number === 'string' ? info.display_phone_number : undefined,
        verifiedName: typeof info.verified_name === 'string' ? info.verified_name : undefined,
        pullKey,
        graphVersion: v,
      };
      return { token: JSON.stringify(tok), label: tok.displayPhone ?? tok.verifiedName ?? 'WhatsApp Business' };
    }
  }
}

/** Belirteç dosyası resmi Meta girişi mi (Instagram profesyonel / Facebook Sayfası / WhatsApp Business) */
export function officialKind(raw: string | undefined): 'instagram' | 'facebook' | 'whatsapp' | undefined {
  if (!raw || !raw.trim().startsWith('{')) return undefined;
  try {
    const k = (JSON.parse(raw) as { official?: unknown }).official;
    return k === 'instagram' || k === 'facebook' || k === 'whatsapp' ? k : undefined;
  } catch {
    return undefined;
  }
}
