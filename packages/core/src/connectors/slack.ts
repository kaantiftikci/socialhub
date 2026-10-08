import { WebClient } from '@slack/web-api';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { BaseConnector, type OutFile, type SendOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { OAuthError, PROVIDER_NAME, refreshToken, type TokenSet } from '../oauth/index.js';
import { chatId, type Account, type Participant, type Reaction } from '../model.js';
import type { Store } from '../store.js';
import { SKIP_SUBTYPES, SLACK_EMOJI, completedShareTs, fileToAttachment, formatSlackText, rawSlackText, slackEmojiName, type UserInfo } from './browser/slack.js';

/**
 * Slack uygulama bildirimi (manifest): kullanıcı Bağlan ekranındaki bağlantıyla KENDİ çalışma alanında dahili bir uygulama
 * oluşturur (Marketplace dışı dahili uygulamalara Mayıs 2025 hız kısıtı uygulanmıyor), kurar ve User OAuth Token'ı (xoxp)
 * yapıştırır. İsteğe bağlı App-Level Token (xapp, connections:write) verilirse Socket Mode ile anlık olay alınır.
 */
export const SLACK_USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write',
  // tepki ver/gör, dosya gönder/indir, okundu işaretle (conversations.mark) ve birebir aç (conversations.open)
  'reactions:read', 'reactions:write', 'files:read', 'files:write', 'channels:write', 'groups:write', 'im:write', 'mpim:write',
];
export const SLACK_MANIFEST = {
  display_information: { name: 'Mivelo', description: 'Mivelo birleşik gelen kutusu — yalnız bu bilgisayarda, kişisel kullanım', background_color: '#6c47ff' },
  oauth_config: { scopes: { user: SLACK_USER_SCOPES } },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added', 'reaction_removed'] },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};

/** Belirteç dosyasının içeriği (parseSlackToken) */
export interface SlackTokenFile {
  token: string;
  appToken?: string;
  /** resmi giriş: Mivelo'nun Slack uygulaması (OAuth, oauth/flows.ts SlackOAuthToken) */
  oauth?: 'slack';
  teamId?: string;
  team?: string;
  userId?: string;
  /** belirteç döndürme açıksa yenileme belirteci + erişim belirtecinin bitişi (ms) */
  refreshToken?: string;
  expiresAt?: number;
  /** uygulama Marketplace'te değil: conversations.history/replies dakikada 1 istek, ≤15 mesaj */
  historyLimited?: boolean;
}

/**
 * Belirteç dosyası: düz "xoxp-…" (eski), JSON {token, appToken} (kendi Slack uygulaması) ya da resmi giriş
 * {token, oauth:'slack', teamId, team, userId, refreshToken?, expiresAt?, historyLimited}
 */
export function parseSlackToken(raw: string): SlackTokenFile | undefined {
  const t = raw.trim();
  if (t.startsWith('xox')) return { token: t };
  if (!t.startsWith('{')) return undefined;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    const token = typeof j.token === 'string' ? j.token.trim() : '';
    if (!token.startsWith('xox')) return undefined;
    const appToken = typeof j.appToken === 'string' && j.appToken.trim().startsWith('xapp-') ? j.appToken.trim() : undefined;
    const out: SlackTokenFile = { token, appToken };
    // yalnız dolu alanlar eklenir (eski {token, appToken} dosyası aynen döner)
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    if (j.oauth === 'slack') out.oauth = 'slack';
    const team = str(j.team);
    if (team) out.team = team;
    const teamId = str(j.teamId);
    if (teamId) out.teamId = teamId;
    const userId = str(j.userId);
    if (userId) out.userId = userId;
    const refresh = str(j.refreshToken);
    if (refresh) out.refreshToken = refresh;
    const exp = Number(j.expiresAt);
    if (j.expiresAt != null && Number.isFinite(exp) && exp > 0) out.expiresAt = exp;
    // resmi girişte varsayılan sınırlı (Marketplace dışı dağıtılan uygulama); yalnız açıkça false ise sınırsız
    if (typeof j.historyLimited === 'boolean') out.historyLimited = j.historyLimited;
    else if (out.oauth) out.historyLimited = true;
    return out;
  } catch {
    return undefined;
  }
}

/** SlackConnector seçenekleri (registry belirteç dosyasından: parseSlackToken) */
export interface SlackOptions {
  /** Mayıs 2025 kuralı (Marketplace dışı ticari dağıtılan uygulama): conversations.history/replies dakikada 1 istek, ≤15 mesaj */
  historyLimited?: boolean;
  /** belirteç döndürme: yenileme belirteci + erişim belirtecinin bitişi (ms) */
  refresh?: { token: string; expiresAt?: number };
  /** resmi girişle gelen belirteç: geçersiz/iptal olunca "Slack oturumu sona erdi — yeniden giriş yap" */
  official?: boolean;
  /** çalışma alanı adı (etiket: "Slack · <ad>") */
  team?: string;
}

/**
 * Slack: resmi Web API, kullanıcı token'ı (xoxp-…) ile. App-Level Token varsa Socket Mode: mesaj olayı gelen sohbetin
 * geçmişi hemen çekilir, yoklama ~5 dk'lık yedeğe iner. Yoksa ~60 sn'lik (±%30) yoklama.
 * Hız sınırları: conversations.list 10 dk önbellekli; conversations.history (Tier 3, ~50/dk) tur başına en çok
 * HISTORY_PER_POLL kanal — DM'ler ve yakın zamanda etkin olanlar önce, kalanlar sırayla dönüşümlü. 429'da WebClient
 * Retry-After kadar bekler.
 * Gerekli scope'lar SLACK_USER_SCOPES. Eski bildirimle kurulmuş uygulamada eksik kapsam (missing_scope) varsa ilgili özellik
 * (tepki/dosya/okundu) anlaşılır bir hatayla durur; metin gönderme/alma etkilenmez — Bağlan ekranındaki bağlantıyla yeniden kurmak yeter.
 *
 * Resmi giriş (Mivelo'nun Slack uygulaması, OAuth): Socket Mode yok (uygulama düzeyi xapp belirteci dağıtılamaz) → yoklama.
 * Uygulama Marketplace'te değilse (historyLimited) Slack conversations.history ve conversations.replies'ı DAKİKADA 1 istek ve
 * istek başına ≤15 mesajla sınırlıyor. Bu kipte:
 *  - hangi sohbetin değiştiği history çağırmadan sınırsız uçlarla anlaşılır: users.conversations (liste) + conversations.info
 *    (Tier 3; kullanıcı belirteciyle latest / unread_count_display / last_read); `latest` önizleme ve son mesaj olarak hemen yazılır,
 *  - history/replies tek kuyrukta, aralarında ≥61 sn: açık sohbet ve eski mesaj isteği > okunmamış/yeni etkinlikli birebir ve
 *    küçük gruplar > kanallar > boşluk/ilk geçmiş > iş parçacığı yanıtları (bunlar sohbet açılınca öne geçer). 429'da Retry-After.
 * Belirteç döndürme açıksa (refreshToken + expiresAt) erişim belirteci süresi dolmadan yenilenir ve dosyaya yazılır; yenileme de
 * reddedilirse hesap "Slack oturumu sona erdi — yeniden giriş yap" durumunda kalır, yoklama durur.
 */
export class SlackConnector extends BaseConnector {
  private web: WebClient;
  private timer?: NodeJS.Timeout;
  private users = new Map<string, UserInfo>();
  /** iş parçacığı: `kanal/üst ts` → son görülen latest_reply (değişmediyse conversations.replies istenmez) */
  private threadsSeen = new Map<string, string>();
  private meId = '';
  /** sohbet → bu ts'e kadar (dahil) tüm mesajlar alındı; kalıcı (meta `slack_last:<hesap>`), yeniden açılışta kaldığı yerden */
  private lastTs = new Map<string, string>();
  /** bu oturumda en az bir kez geçmişi çekilen sohbetler (kalıcı imleçle gelen birikmiş eskiler canlı sayılmasın) */
  private sessionKnown = new Set<string>();
  /**
   * Sayfa sınırında kalan boşluk: (lastTs, top) aralığı henüz alınmadı; high = o sırada alınmış en yeni ts.
   * Boşluk kapanınca imleç high'a ilerler (aradaki mesajlar kaybolmaz).
   */
  private gaps = new Map<string, { top: string; high: string }>();
  private saveTimer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private convs: Array<{ id: string; name: string; kind: 'direct' | 'group' | 'channel' }> = [];
  private convsAt = 0;
  private cursor = 0;
  /** Bağlanma anı (ms): imleci (lastTs) olmayan sohbette yalnız bundan yeni mesajlar canlı sayılır */
  private startedAt = Date.now();
  /** iş parçacığı: `kanal/üst ts` → alınmış en yeni yanıtın ts'i (sonraki istek oldest ile yalnız yenileri getirir) */
  private threadLast = new Map<string, string>();

  /** Socket Mode */
  private sock?: WebSocket;
  private sockUp = false;
  private sockFails = 0;
  private sockTimer?: NodeJS.Timeout;
  /** olay gelen, geçmişi çekilecek sohbetler (1,5 sn'de toplanır) */
  private dirty = new Set<string>();
  private dirtyTimer?: NodeJS.Timeout;
  private dirtyThreads = new Set<string>();

  /** Resmi giriş seçenekleri */
  private readonly limited: boolean;
  private readonly official: boolean;
  private readonly team?: string;
  private refresh?: { token: string; expiresAt?: number };
  /** yenilenen belirtecin yazılacağı dosya (hesap kaldırıldıysa yazılmaz) */
  private tokenFile?: string;
  private refreshTimer?: NodeJS.Timeout;
  private renewing?: Promise<'ok' | 'revoked' | 'failed'>;
  private renewedAt = 0;
  private expired = false;
  /** Yenileme işlevi (testte sahtesiyle değiştirilir) */
  protected renewToken: (refresh: string) => Promise<TokenSet> = (r) => refreshToken('slack', r);

  /**
   * Sınırlı kipte history/replies/info istemcisi: 429'da istemci kuyruğunu DURDURMAZ (rejectRateLimitedCalls) — gönderim,
   * tepki, okundu gibi kullanıcı işleri ana istemcide beklemeden gider; hız sınırını kuyruk kendisi uygular.
   */
  private poller?: WebClient;
  /** bekleyen history/replies işleri (anahtar: h:<sohbet> | o:<sohbet> | r:<sohbet>/<üst ts>) */
  private jobs = new Map<string, HistJob>();
  private pumpTimer?: NodeJS.Timeout;
  private pumping = false;
  /** sonraki history/replies isteğinin en erken zamanı (ms) */
  private nextHistAt = 0;
  /** sohbet → conversations.info'nun bildirdiği en yeni mesaj ts'i */
  private latestSeen = new Map<string, string>();
  /** ≤SMALL_GROUP üyeli kanallar (birebir gibi öncelikli) */
  private small = new Set<string>();
  /** sohbet → son başarılı geçmiş isteği (ms) */
  private fetchedAt = new Map<string, number>();
  private infoCursor = 0;
  private infoPauseUntil = 0;
  /** iş anahtarı → kalıcı hatadan (not_in_channel, thread_not_found…) sonra bu zamana dek kendiliğinden yeniden istenmez */
  private failUntil = new Map<string, number>();

  constructor(account: Account, store: Store, private token: string, private appToken?: string, opts: SlackOptions = {}) {
    super(account, store);
    this.limited = !!opts.historyLimited;
    this.official = !!opts.official || !!opts.refresh;
    this.team = opts.team;
    this.refresh = opts.refresh;
    if (this.refresh) this.tokenFile = path.join(sessionDir(account.id), 'token');
    this.web = this.makeClient(token, false);
    if (this.limited) this.poller = this.makeClient(token, true);
  }

  /** Testte sahte istemciyle değiştirilir */
  protected makeClient(token: string, poller: boolean): WebClient {
    return poller ? new WebClient(token, { rejectRateLimitedCalls: true, retryConfig: { retries: 2 } }) : new WebClient(token);
  }

  /** history/replies/info: sınırlı kipte ayrı istemci, değilse ana istemci */
  private get reader(): WebClient {
    return this.poller ?? this.web;
  }

  async start(): Promise<void> {
    this.setStatus('connecting');
    this.stopped = false;
    this.expired = false;
    // döndürülen belirteç: süresi dolmuş ya da dolmak üzereyse önce yenile
    if (this.refresh?.expiresAt && this.refresh.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
      if ((await this.renew()) === 'revoked') return;
    }
    let auth: Awaited<ReturnType<WebClient['auth']['test']>> | undefined;
    for (let attempt = 0; !auth; attempt++) {
      try {
        auth = await this.web.auth.test();
      } catch (e) {
        const h = await this.onAuthError(e);
        if (h === 'expired') return;
        if (h !== 'renewed' || attempt > 0) {
          this.halt();
          // yenileme ağ yüzünden olmadı: geçici hata (kendiliğinden yeniden denenir)
          this.setStatus('error', h === 'retry' ? 'Slack oturumu yenilenemedi (bağlantı sorunu) — yeniden denenecek' : `Slack token doğrulanamadı: ${(e as Error).message}`);
          return;
        }
      }
    }
    this.meId = String(auth.user_id ?? '');
    const team = String(auth.team ?? this.team ?? '').trim();
    this.account.label = this.official ? (team ? `Slack · ${team}` : 'Slack') : `${auth.user ?? 'slack'} @ ${auth.team ?? ''}`.trim();
    this.setStatus('connected');
    this.stopped = false;
    this.startedAt = Date.now();
    this.loadCursors();
    this.scheduleRefresh();
    await this.poll(true);
    this.schedule();
    if (this.appToken) void this.openSocket();
  }

  private schedule(): void {
    if (this.stopped) return;
    // Socket Mode açıkken olaylar anında geliyor: yoklama yalnız kaçan olaylar için yedek (~5 dk)
    const base = this.sockUp ? 300_000 : 60_000;
    this.timer = setTimeout(async () => {
      await this.poll(false);
      this.schedule();
    }, Math.round(base * (0.7 + Math.random() * 0.6)));
  }

  async stop(): Promise<void> {
    this.halt();
    // oturumu sona ermiş hesap "Yeniden giriş yap" durumunda kalır
    if (!this.expired) this.setStatus('disconnected');
  }

  /** Tüm zamanlayıcılar/soket durur; bekleyen eski mesaj istekleri bırakılır */
  private halt(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sockTimer) clearTimeout(this.sockTimer);
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.pumpTimer = undefined;
    this.refreshTimer = undefined;
    for (const j of this.jobs.values()) for (const w of j.waiters) w.resolve();
    this.jobs.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.saveCursors();
    }
    this.sock?.removeAllListeners();
    this.sock?.close();
    this.sock = undefined;
    this.sockUp = false;
  }

  // ───────────── Resmi giriş: belirteç döndürme ve oturum düşmesi ─────────────

  /**
   * Slack yetki hatası (invalid_auth/token_revoked/token_expired…) — yalnız resmi girişte işlenir (eski elle girilen belirteçte
   * davranış aynı). Yenileme belirteci varsa bir kez yenilenir; olmazsa oturum sona erdi.
   * Dönüş: 'renewed' yeniden dene · 'retry' yenileme geçici olarak başarısız (ağ) · 'expired' oturum bitti · undefined yetki hatası değil
   */
  private async onAuthError(e: unknown): Promise<'renewed' | 'retry' | 'expired' | undefined> {
    if (!this.official || !AUTH_ERRORS.test(slackError(e))) return undefined;
    if (this.expired) return 'expired';
    // az önce yenilendiği hâlde hâlâ reddediliyor (hesap kapatıldı, uygulama kaldırıldı): döngüye girme
    if (this.refresh && Date.now() - this.renewedAt > 5 * 60_000) {
      const r = await this.renew();
      if (r === 'ok') return 'renewed';
      if (r === 'failed') return 'retry';
      return 'expired';
    }
    this.expire();
    return 'expired';
  }

  /** Yetki bitti: yoklama durur, otomatik deneme yok; arayüz "Yeniden giriş yap" gösterir */
  private expire(): void {
    if (this.expired) return;
    this.expired = true;
    this.halt();
    this.setStatus('error', `${PROVIDER_NAME.slack} oturumu sona erdi — yeniden giriş yap`);
  }

  /** Süresi bir dakikadan az kalan belirteci istekten önce yenile (uykudan uyanınca zamanlayıcı geç kalabilir) */
  private async ensureFresh(): Promise<void> {
    const exp = this.refresh?.expiresAt;
    if (exp && !this.expired && Date.now() > exp - 60_000) await this.renew();
  }

  /** Tek uçuş yenileme */
  private renew(): Promise<'ok' | 'revoked' | 'failed'> {
    if (!this.refresh) return Promise.resolve('revoked');
    return (this.renewing ??= this.renewNow().finally(() => (this.renewing = undefined)));
  }

  private async renewNow(): Promise<'ok' | 'revoked' | 'failed'> {
    const refresh = this.refresh!;
    try {
      const t = await this.renewToken(refresh.token);
      if (!t.accessToken.startsWith('xox')) throw new OAuthError('Slack yeni belirteç vermedi');
      this.applyToken(t);
      return 'ok';
    } catch (e) {
      if (renewRevoked(e)) {
        this.expire();
        return 'revoked';
      }
      const code = e instanceof OAuthError ? e.code || 'oauth' : (e as NodeJS.ErrnoException)?.code || (e as Error)?.name || 'hata';
      this.warnOnce('renew', `Slack belirteci yenilenemedi (${code}); 5 dk sonra yeniden denenecek`);
      this.scheduleRefresh(RENEW_RETRY_MS);
      return 'failed';
    }
  }

  /** Yeni belirteç: istemciler yeniden kurulur, dosyaya yazılır, sonraki yenileme zamanlanır */
  private applyToken(t: TokenSet): void {
    this.token = t.accessToken;
    this.refresh = { token: t.refreshToken ?? this.refresh!.token, expiresAt: t.expiresAt };
    this.renewedAt = Date.now();
    this.web = this.makeClient(this.token, false);
    if (this.limited) this.poller = this.makeClient(this.token, true);
    this.saveToken();
    this.scheduleRefresh();
    bus.log('info', 'Slack: oturum belirteci yenilendi');
  }

  /** Belirteç dosyasını güncelle (tmp + rename, 0600); hesap kaldırıldıysa (dosya yok) yazılmaz */
  private saveToken(): void {
    const file = this.tokenFile;
    if (!file || !fs.existsSync(file)) return;
    try {
      let cur: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw.startsWith('{')) cur = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* bozuk dosya: yenisi yazılır */
      }
      const next: Record<string, unknown> = { ...cur, token: this.token, refreshToken: this.refresh?.token, expiresAt: this.refresh?.expiresAt };
      if (!next.oauth && this.official) next.oauth = 'slack';
      if (next.historyLimited === undefined) next.historyLimited = this.limited;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      bus.log('warn', `Slack: yenilenen belirteç kaydedilemedi (${(e as NodeJS.ErrnoException).code ?? 'hata'})`);
    }
  }

  /** Bitişten REFRESH_AHEAD_MS önce yenile (ms verilirse o kadar sonra yeniden dene) */
  private scheduleRefresh(ms?: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    const exp = this.refresh?.expiresAt;
    if (this.stopped || !this.refresh || (!exp && ms === undefined)) return;
    const wait = ms ?? Math.max(30_000, exp! - Date.now() - REFRESH_AHEAD_MS);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.renew();
    }, Math.min(wait, 2 ** 31 - 1));
    this.refreshTimer.unref?.();
  }

  /**
   * Socket Mode: apps.connections.open (xapp) → wss adresi. Her zarf onaylanır ({envelope_id}); message olayında sohbet
   * "kirli" işaretlenir. Slack bağlantıyı düzenli yeniler ('disconnect' → hemen yeniden aç). Hata/kopmada üstel bekleme ≤5 dk.
   */
  private async openSocket(): Promise<void> {
    if (this.stopped || !this.appToken) return;
    let url: string | undefined;
    try {
      const r = (await new WebClient(this.appToken).apps.connections.open()) as { url?: string };
      url = r.url;
    } catch (e) {
      bus.log('warn', `Slack Socket Mode açılamadı (${(e as Error).message}); yoklamayla devam`);
      return this.retrySocket();
    }
    if (this.stopped) return; // istek sürerken stop(): soket açılmasın
    if (!url) return this.retrySocket();
    const ws = new WebSocket(url);
    this.sock = ws;
    ws.on('message', (data) => {
      let env: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
      try {
        env = JSON.parse(String(data));
      } catch {
        return;
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === 'hello') {
        if (!this.sockUp) bus.log('info', 'Slack: Socket Mode bağlı, mesajlar anında geliyor');
        this.sockUp = true;
        this.sockFails = 0;
      } else if (env.type === 'disconnect') {
        ws.removeAllListeners();
        ws.close();
        this.sockUp = false;
        void this.openSocket();
      } else if (env.type === 'events_api') {
        const ev = env.payload?.event;
        if (ev?.type === 'message' && ev.channel) {
          // düzenleme / silme doğrudan olaydan (history'de oldest sonrası görünmez); yanıt sayısı değişimi de message_changed gelir
          if (ev.subtype === 'message_changed' && ev.message?.ts && ev.message.edited) {
            const text = formatSlackText(ev.message.text ?? '', this.users);
            if (text) this.applyEdited(ev.channel, String(ev.message.ts), text);
          } else if (ev.subtype === 'message_deleted' && ev.deleted_ts) this.applyEdited(ev.channel, String(ev.deleted_ts), null);
          this.markDirty(ev.channel);
          // iş parçacığı yanıtı history'de görünmez: üst mesajın yanıtları da çekilsin
          const parent = ev.thread_ts ?? ev.message?.thread_ts;
          if (parent) this.threadsSeen.delete(`${ev.channel}/${parent}`), this.dirtyThreads.add(`${ev.channel}/${parent}`);
        } else if ((ev?.type === 'reaction_added' || ev?.type === 'reaction_removed') && ev.item?.channel && ev.item.ts && ev.reaction && ev.user) {
          void this.onReaction(ev.item.channel, ev.item.ts, ev.reaction, ev.user, ev.type === 'reaction_removed');
        }
      }
    });
    ws.on('close', () => {
      if (this.sock !== ws) return;
      this.sockUp = false;
      this.retrySocket();
    });
    ws.on('error', () => undefined);
  }

  private retrySocket(): void {
    if (this.stopped) return;
    const ms = Math.min(300_000, 5_000 * 2 ** this.sockFails++) * (0.7 + Math.random() * 0.6);
    if (this.sockTimer) clearTimeout(this.sockTimer);
    this.sockTimer = setTimeout(() => void this.openSocket(), ms);
  }

  private markDirty(channel: string): void {
    // sınırlı kip: geçmiş isteği kuyruktan (dakikada 1)
    if (this.limited) {
      this.enqueue({ ch: channel, kind: 'new', prio: P_NEW_SMALL, at: Date.now() / 1000, force: true });
      return;
    }
    this.dirty.add(channel);
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined;
      void this.pollDirty();
    }, 1500);
  }

  /** Olay gelen sohbetlerin yalnız yeni mesajları (oldest = son görülen ts) */
  private async pollDirty(): Promise<void> {
    if (this.polling) {
      // yoklama sürüyor: bitince yeniden dene
      this.dirtyTimer = setTimeout(() => {
        this.dirtyTimer = undefined;
        void this.pollDirty();
      }, 2000);
      return;
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    this.polling = true;
    try {
      // listede olmayan (yeni DM/kanal) → liste yenilensin
      if (ids.some((id) => !this.convs.some((c) => c.id === id))) await this.refreshList();
      for (const id of ids) {
        const c = this.convs.find((x) => x.id === id);
        if (c) await this.fetchHistory(c, false);
      }
      const threads = [...this.dirtyThreads];
      this.dirtyThreads.clear();
      for (const key of threads) {
        const [ch, ts] = key.split('/');
        await this.fetchReplies(ch, ts);
      }
    } catch (e) {
      bus.log('warn', `Slack olay işleme: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  async sendText(remoteChatId: string, text: string, opts?: SendOptions): Promise<{ remoteId: string }> {
    await this.ensureFresh();
    const res = await this.web.chat.postMessage({ channel: remoteChatId, text, ...(opts?.threadId ? { thread_ts: opts.threadId } : {}) });
    const id = String(res.ts ?? Date.now());
    // lastTs burada ilerletilmez: son yoklamayla bu gönderim arasında karşıdan gelen mesaj (daha eski ts) sonraki
    // yoklamada oldest=<benim ts> yüzünden hiç çekilmiyordu. Kendi mesajım yoklamada aynı ts ile gelip üzerine yazılır.
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent', threadId: opts?.threadId });
    return { remoteId: id };
  }

  /** Herkesten sil (chat.delete; kullanıcı belirteci kendi mesajını silebilir) */
  async deleteMessage(remoteChatId: string, remoteId: string): Promise<void> {
    await this.web.chat.delete({ channel: remoteChatId, ts: remoteId }).catch((e) => {
      if (slackError(e) !== 'message_not_found') throw scopeHint(e, 'silme');
    });
  }

  /** Metni düzenle (chat.update; Slack'te süre sınırı çalışma alanı ayarına bağlı) */
  async editMessage(remoteChatId: string, remoteId: string, text: string): Promise<void> {
    await this.web.chat.update({ channel: remoteChatId, ts: remoteId, text }).catch((e) => {
      throw scopeHint(e, 'düzenleme');
    });
  }

  /** Tepki ver/kaldır (reactions:write). Zaten var/yok hataları sessiz: sonuç aynı */
  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    const name = slackEmojiName(emoji);
    await this.ensureFresh();
    try {
      if (remove) await this.web.reactions.remove({ channel: remoteChatId, timestamp: remoteMsgId, name });
      else await this.web.reactions.add({ channel: remoteChatId, timestamp: remoteMsgId, name });
    } catch (e) {
      const code = slackError(e);
      if (code !== 'already_reacted' && code !== 'no_reaction') throw scopeHint(e, 'tepki');
    }
    this.applyReaction(remoteChatId, remoteMsgId, { emoji: SLACK_EMOJI[name] ?? emoji, senderId: this.meId, senderName: 'Ben', fromMe: true }, remove);
  }

  /** Mivelo'da okununca Slack'te de okundu (conversations.mark; *:write kapsamları) */
  async markRead(remoteChatId: string): Promise<void> {
    await this.ensureFresh();
    // boşluk kapanana dek imleç geride kalır: alınmış en yeni mesaj (gap.high) okundu sayılsın
    const ts = this.limited
      ? // sınırlı kip: history yerine bilinen en yeni (conversations.info latest dahil); yoksa info'dan
        (maxTs(this.gaps.get(remoteChatId)?.high, this.lastTs.get(remoteChatId), this.latestSeen.get(remoteChatId)) ??
        ((await this.reader.conversations.info({ channel: remoteChatId })).channel as InfoChannel | undefined)?.latest?.ts)
      : (this.gaps.get(remoteChatId)?.high ?? this.lastTs.get(remoteChatId) ?? (await this.web.conversations.history({ channel: remoteChatId, limit: 1 })).messages?.[0]?.ts);
    if (!ts) return;
    try {
      await this.web.conversations.mark({ channel: remoteChatId, ts: String(ts) });
    } catch (e) {
      throw scopeHint(e, 'okundu işaretleme');
    }
  }

  /**
   * Yukarı kaydırınca eski mesajlar: latest = yüklü en eski mesaj. Sınırlı kipte kuyruğun en önüne girer (≤15 mesaj); sıra
   * LOAD_WAIT_MS içinde gelmezse arayüze timedOut döner ("daha eski yok" denmez), mesajlar gelince olayla eklenir.
   */
  async loadHistory(remoteChatId: string, limit: number, before?: number): Promise<void | { timedOut?: boolean }> {
    const latest = before ? (before / 1000).toFixed(6) : undefined;
    if (this.limited) {
      const done = this.enqueue({ ch: remoteChatId, kind: 'older', prio: P_USER, at: Date.now() / 1000, latest }, true)!;
      let t: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([done.then(() => false), new Promise<boolean>((r) => (t = setTimeout(() => r(true), LOAD_WAIT_MS)))]).finally(() => clearTimeout(t));
      return timedOut ? { timedOut: true } : undefined;
    }
    const c = this.convs.find((x) => x.id === remoteChatId) ?? { id: remoteChatId };
    await this.fetchHistory(c, true, { limit: Math.min(200, limit), latest });
  }

  /** Sohbet açıldı (sınırlı kip): güncel durumu sor, gerekiyorsa geçmişini ve en çok 3 iş parçacığını öne al */
  async watch(remoteChatId: string): Promise<void> {
    if (!this.limited || this.stopped) return;
    const c = this.convs.find((x) => x.id === remoteChatId) ?? { id: remoteChatId, name: '', kind: 'channel' as const };
    try {
      await this.infoOne(c, P_USER);
    } catch (e) {
      if (retryAfterSec(e) === undefined) await this.onAuthError(e);
    }
    if (!this.lastTs.has(remoteChatId) || this.gaps.has(remoteChatId)) this.enqueue({ ch: remoteChatId, kind: 'new', prio: P_USER, at: Date.now() / 1000 });
    const threads = [...this.jobs.values()].filter((j) => j.kind === 'replies' && j.ch === remoteChatId).sort((a, b) => b.at - a.at);
    for (const j of threads.slice(0, 3)) j.prio = Math.max(j.prio, P_USER_THREAD);
    this.kick();
  }

  /** Dosya (files:write): getUploadURLExternal → baytlar → completeUploadExternal (files.upload emekli) */
  async sendMedia(remoteChatId: string, file: OutFile, caption?: string): Promise<{ remoteId: string }> {
    await this.ensureFresh();
    try {
      const up = await this.web.files.getUploadURLExternal({ filename: file.name, length: file.size });
      if (!up.upload_url || !up.file_id) throw new Error('Slack yükleme adresi vermedi');
      const r = await fetch(up.upload_url, { method: 'POST', body: fs.readFileSync(file.path), headers: { 'content-type': file.mime || 'application/octet-stream' } });
      if (!r.ok) throw new Error(`Slack dosya yükleme ${r.status}`);
      const done = await this.web.files.completeUploadExternal({ files: [{ id: up.file_id, title: file.name }], channel_id: remoteChatId, ...(caption ? { initial_comment: caption } : {}) });
      const ts = completedShareTs(done as never, remoteChatId);
      // paylaşım mesajı birkaç sn içinde oluşur: sohbetin yenisi çekilsin
      this.markDirty(remoteChatId);
      return { remoteId: ts ?? `local-${Date.now()}` };
    } catch (e) {
      throw scopeHint(e, 'dosya gönderme');
    }
  }

  /** Slack dosyaları (url_private) yalnız belirteçle iner (files:read); ana makine denetimi sunucuda (PLATFORM_MEDIA_HOSTS) */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    await this.ensureFresh();
    let cur = u;
    for (let hop = 0; hop < 5; hop++) {
      const host = new URL(cur).hostname;
      if (!/(^|\.)(slack\.com|slack-edge\.com|slack-files\.com)$/i.test(host)) throw new Error(`yönlendirme izinli değil: ${host}`);
      const r = await fetch(cur, { redirect: 'manual', headers: /(^|\.)slack\.com$/i.test(host) ? { authorization: `Bearer ${this.token}` } : {} });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (!r.ok) throw new Error(`Slack medya ${r.status}`);
      const type = r.headers.get('content-type') ?? 'application/octet-stream';
      // kapsam yoksa Slack giriş sayfası (HTML) döndürür
      if (/text\/html/i.test(type)) throw new Error('Slack medya 403 (files:read kapsamı yok — uygulamayı yeniden kur)');
      return { body: Buffer.from(await r.arrayBuffer()), type };
    }
    throw new Error('Slack medya: çok fazla yönlendirme');
  }

  /** Grup üyesiyle birebir (conversations.open; im:write) */
  async openDirect(p: Participant): Promise<string> {
    try {
      const r = await this.web.conversations.open({ users: p.id });
      const id = String(r.channel?.id ?? '');
      if (!id) throw new Error('Slack birebir sohbet açmadı');
      this.ensureChat(id, p.name, 'direct');
      if (!this.convs.some((c) => c.id === id)) this.convs.push({ id, name: p.name, kind: 'direct' });
      return id;
    } catch (e) {
      throw scopeHint(e, 'birebir sohbet açma');
    }
  }

  /** Socket Mode tepki olayı: eski mesajlarda da (history'nin oldest penceresi dışında) anında işlenir */
  private async onReaction(channel: string, ts: string, name: string, user: string, remove: boolean): Promise<void> {
    const base = name.split('::')[0];
    const fromMe = user === this.meId;
    this.applyReaction(channel, ts, { emoji: SLACK_EMOJI[base] ?? `:${base}:`, senderId: user, senderName: fromMe ? 'Ben' : (await this.user(user)).name, fromMe }, remove);
  }

  /** Aynı hata satırı en çok 10 dk'da bir (yalnız kod/sayı; içerik yok) */
  private warned = new Map<string, number>();
  private warnOnce(key: string, text: string): void {
    if (Date.now() - (this.warned.get(key) ?? 0) < 10 * 60_000) return;
    this.warned.set(key, Date.now());
    bus.log('warn', text);
  }
  /** adı alınamayan kimlik → son deneme (10 dk yeniden istenmez) */
  private userMiss = new Map<string, number>();

  private async user(id: string): Promise<UserInfo> {
    if (!id) return { name: 'Slack' };
    const cached = this.users.get(id);
    if (cached) return cached;
    if (Date.now() - (this.userMiss.get(id) ?? 0) < 10 * 60_000) return { name: id };
    try {
      const r = id.startsWith('B') ? await this.web.bots.info({ bot: id }) : await this.web.users.info({ user: id });
      const u = ((r as { user?: Record<string, any> }).user ?? (r as { bot?: Record<string, any> }).bot ?? {}) as Record<string, any>;
      const v: UserInfo = { name: u.real_name || u.profile?.display_name || u.name || id, avatar: u.profile?.image_72 ?? u.icons?.image_72, handle: u.name && !id.startsWith('B') ? '@' + u.name : undefined };
      this.users.set(id, v);
      return v;
    } catch (e) {
      this.userMiss.set(id, Date.now());
      this.warnOnce(`user:${slackError(e)}`, `Slack ${id.startsWith('B') ? 'bots.info' : 'users.info'} başarısız (${slackError(e) || 'hata'}); ad yerine kimlik`);
      return { name: id };
    }
  }

  private async userName(id: string): Promise<string> {
    return id ? (await this.user(id)).name : '';
  }

  /** Bu turda geçmişi çekilecek sohbetler: yarısı en son etkin olanlar (DM öncelikli), yarısı dönüşümlü sıradakiler */
  private pickForPoll(first: boolean): typeof this.convs {
    const HISTORY_PER_POLL = first ? 40 : 20;
    if (this.convs.length <= HISTORY_PER_POLL) return this.convs;
    // sayfa sınırında boşluğu kalan sohbetler önce (kalan aralık hemen alınsın)
    const recent = [...this.convs]
      .sort(
        (a, b) =>
          Number(this.gaps.has(b.id)) - Number(this.gaps.has(a.id)) ||
          Number(this.lastTs.get(b.id) ?? 0) + (b.kind === 'direct' ? 1e9 : 0) - (Number(this.lastTs.get(a.id) ?? 0) + (a.kind === 'direct' ? 1e9 : 0)),
      )
      .slice(0, HISTORY_PER_POLL / 2);
    const picked = new Set(recent.map((c) => c.id));
    const out = [...recent];
    for (let i = 0; i < this.convs.length && out.length < HISTORY_PER_POLL; i++) {
      const c = this.convs[(this.cursor + i) % this.convs.length];
      if (picked.has(c.id)) continue;
      out.push(c);
      picked.add(c.id);
    }
    this.cursor = (this.cursor + HISTORY_PER_POLL / 2) % this.convs.length;
    return out;
  }

  private async poll(first: boolean): Promise<void> {
    if (this.limited) return this.pollLimited(first);
    if (this.polling) return; // önceki yoklama sürüyorsa üst üste binme (rate limit)
    this.polling = true;
    try {
      await this.ensureFresh();
      if (this.stopped) return;
      if (first || Date.now() - this.convsAt > 10 * 60_000) await this.refreshList();
      // Sohbet başına ayrı: tek bir sohbetin hatası (not_in_channel, channel_not_found, eksik kapsam mpim:history…) eskiden
      // turun geri kalanını durduruyordu → aynı sohbet hep önde seçildiği için diğer sohbetlerin mesajları/önizlemeleri hiç gelmiyordu
      const failed: string[] = [];
      for (const c of this.pickForPoll(first)) {
        try {
          await this.fetchHistory(c, first);
        } catch (e) {
          // resmi girişte yetki hatası tüm hesabın: tur durur, aşağıda yenile / oturum sona erdi
          if (this.official && AUTH_ERRORS.test(slackError(e))) throw e;
          failed.push(`${c.id.slice(0, 1)}…:${slackError(e) || (e as Error).message.split('\n')[0].slice(0, 60)}`);
        }
      }
      if (failed.length) this.warnOnce(`hist:${failed[0].split(':')[1]}`, `Slack geçmişi alınamadı: ${failed.length} sohbet (ilk: ${failed[0]})`);
    } catch (e) {
      if ((await this.onAuthError(e)) === undefined) bus.log('warn', `Slack yoklama hatası: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  // ───────────── Sınırlı kip (history/replies dakikada 1, ≤15 mesaj) ─────────────

  /** Yoklama: liste (10 dk) + conversations.info taraması; geçmiş kuyruktan ayrıca */
  private async pollLimited(first: boolean): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.ensureFresh();
      if (this.stopped) return;
      if (first || Date.now() - this.convsAt > 10 * 60_000) await this.refreshList();
      await this.sweepInfo(first);
    } catch (e) {
      if ((await this.onAuthError(e)) === undefined) this.warnOnce(`poll:${slackError(e)}`, `Slack yoklama hatası: ${slackError(e) || (e as Error).message.split('\n')[0].slice(0, 80)}`);
    } finally {
      this.polling = false;
    }
    this.kick();
  }

  /** Sohbet etkinliği (sn): Slack'in bildirdiği / alınmış en yeni ya da depodaki son mesaj */
  private activity(id: string): number {
    const stored = this.store.getChatLite(chatId(this.account.id, id))?.lastMessageAt ?? 0;
    return Math.max(Number(this.latestSeen.get(id) ?? 0), Number(this.lastTs.get(id) ?? 0), stored / 1000);
  }

  private isSmall(c: { id: string; kind?: string }): boolean {
    return (c.kind !== undefined && c.kind !== 'channel') || this.small.has(c.id);
  }

  /** Bu turda conversations.info sorulacak sohbetler: yarısı en etkinler (birebir/küçük grup önde), yarısı dönüşümlü sıradakiler */
  private pickForInfo(first: boolean): typeof this.convs {
    const n = first ? INFO_FIRST : INFO_PER_POLL;
    if (this.convs.length <= n) return this.convs;
    const w = new Map(this.convs.map((c) => [c.id, this.activity(c.id) + (this.isSmall(c) ? SMALL_BOOST_S : 0)]));
    const hot = [...this.convs].sort((a, b) => w.get(b.id)! - w.get(a.id)!).slice(0, Math.ceil(n / 2));
    const picked = new Set(hot.map((c) => c.id));
    const out = [...hot];
    for (let i = 0; i < this.convs.length && out.length < n; i++) {
      const c = this.convs[(this.infoCursor + i) % this.convs.length];
      if (picked.has(c.id)) continue;
      out.push(c);
      picked.add(c.id);
    }
    this.infoCursor = (this.infoCursor + Math.floor(n / 2)) % this.convs.length;
    return out;
  }

  private async sweepInfo(first: boolean): Promise<void> {
    if (Date.now() < this.infoPauseUntil) return;
    const failed: string[] = [];
    for (const c of this.pickForInfo(first)) {
      if (this.stopped) return;
      try {
        await this.infoOne(c);
      } catch (e) {
        const retry = retryAfterSec(e);
        if (retry !== undefined) {
          this.infoPauseUntil = Date.now() + retry * 1000;
          this.warnOnce('info429', `Slack conversations.info hız sınırı; ${retry} sn bekleniyor`);
          break;
        }
        if (AUTH_ERRORS.test(slackError(e))) throw e;
        failed.push(`${c.id.slice(0, 1)}…:${slackError(e) || (e as Error).message.split('\n')[0].slice(0, 60)}`);
      }
    }
    if (failed.length) this.warnOnce(`info:${failed[0].split(':')[1]}`, `Slack sohbet bilgisi alınamadı: ${failed.length} sohbet (ilk: ${failed[0]})`);
  }

  /**
   * conversations.info (kullanıcı belirteci): latest = sohbetin en yeni mesajı → history beklemeden önizleme/son mesaj olarak yazılır
   * (imleç ilerlemez: aradaki mesajlar kuyrukla gelir); unread_count_display öncelik için; last_read başka cihazda okunduysa sayaç sıfırlanır.
   * boost: kullanıcı sohbeti açtı (geçmiş gerekiyorsa en önde).
   */
  private async infoOne(c: { id: string; kind?: string }, boost?: number): Promise<void> {
    const r = await this.reader.conversations.info({ channel: c.id, ...(c.kind === 'channel' ? { include_num_members: true } : {}) });
    const ch = (r.channel ?? {}) as InfoChannel;
    if (c.kind === 'channel' && typeof ch.num_members === 'number') {
      if (ch.num_members <= SMALL_GROUP) this.small.add(c.id);
      else this.small.delete(c.id);
    }
    const unread = typeof ch.unread_count_display === 'number' ? ch.unread_count_display : typeof ch.unread_count === 'number' ? ch.unread_count : undefined;
    const latest = ch.latest && typeof ch.latest === 'object' ? ch.latest : undefined;
    const lts = latest?.ts ? String(latest.ts) : undefined;
    if (lts) this.latestSeen.set(c.id, lts);
    else if (ch.latest === null) this.latestSeen.delete(c.id);
    if (lts && !this.hasMessage(c.id, lts)) {
      // başka cihazda okunmuş (ya da benim) mesaj bildirim/okunmamış üretmez
      const seenElsewhere = unread === 0 && Number(ch.last_read ?? 0) >= Number(lts);
      await this.ingest(c.id, latest!, Number(lts) * 1000 > this.startedAt && !seenElsewhere);
    }
    this.readElsewhere(c.id, ch.last_read, unread);
    const floor = this.lastTs.get(c.id);
    const small = this.isSmall(c);
    const bonus = unread ? P_UNREAD_BONUS : 0;
    const newPrio = (small ? P_NEW_SMALL : P_NEW_CHANNEL) + bonus;
    let prio: number | undefined;
    let force = false;
    if (lts && (!floor || Number(lts) > Number(floor))) {
      // imleci olmayan (hiç alınmamış) sohbet: bağlandıktan sonra yazıldıysa yeni etkinlik, değilse ilk geçmiş (düşük)
      prio = floor || Number(lts) * 1000 > this.startedAt ? newPrio : (small ? P_BACKFILL_SMALL : P_BACKFILL) + bonus;
    } else if (this.gaps.has(c.id)) prio = small ? P_GAP_SMALL : P_GAP;
    else if (ch.latest === undefined && (!floor || Date.now() - (this.fetchedAt.get(c.id) ?? 0) > (unread ? UNREAD_STALE_MS : STALE_MS))) {
      // Slack bu sohbette latest vermedi: geçmişten bak (okunmamış varsa 2 dk'da, yoksa 15 dk'da bir)
      prio = unread ? newPrio : P_BACKFILL;
      force = !!floor;
    }
    if (prio !== undefined) this.enqueue({ ch: c.id, kind: 'new', prio: boost ? Math.max(prio, boost) : prio, at: Number(lts ?? floor ?? 0), force });
  }

  /** Slack başka cihazda okundu diyor (sayacı 0, okuma noktası bizdeki son mesajda/ileride): Mivelo'da da okundu */
  private readElsewhere(ch: string, lastRead: string | undefined, unread: number | undefined): void {
    if (unread !== 0 || !lastRead || !Number(lastRead)) return;
    const cid = chatId(this.account.id, ch);
    const chat = this.store.getChatLite(cid);
    if (!chat || chat.unread <= 0 || Number(lastRead) * 1000 + 1 < chat.lastMessageAt) return;
    this.store.markRead(cid);
    const full = this.store.getChat(cid);
    if (full) bus.emit({ type: 'chat.upsert', chat: full });
  }

  /** Kuyruğa ekle (aynı anahtar varsa öncelik yükselir); wait → iş bitince çözülen söz */
  private enqueue(j: { ch: string; kind: HistJob['kind']; prio: number; at?: number; parent?: string; latest?: string; force?: boolean }, wait = false): Promise<void> | undefined {
    if (this.stopped) return wait ? Promise.resolve() : undefined;
    const key = j.kind === 'replies' ? `r:${j.ch}/${j.parent}` : `${j.kind === 'older' ? 'o' : 'h'}:${j.ch}`;
    // kalıcı hata veren iş her taramada yeniden kuyruğa girip dakikalık hakkı yemesin (kullanıcı isteği hariç)
    if (j.prio < P_USER && (this.failUntil.get(key) ?? 0) > Date.now()) return wait ? Promise.resolve() : undefined;
    let cur = this.jobs.get(key);
    if (!cur) {
      cur = { key, ch: j.ch, kind: j.kind, prio: j.prio, at: j.at ?? 0, parent: j.parent, latest: j.latest, force: !!j.force, waiters: [] };
      this.jobs.set(key, cur);
    } else {
      cur.prio = Math.max(cur.prio, j.prio);
      cur.at = Math.max(cur.at, j.at ?? 0);
      cur.force ||= !!j.force;
      if (j.latest !== undefined) cur.latest = j.latest;
    }
    const job = cur;
    const p = wait ? new Promise<void>((resolve, reject) => job.waiters.push({ resolve, reject })) : undefined;
    this.kick();
    return p;
  }

  private kick(): void {
    if (!this.limited || this.stopped || this.pumpTimer || this.pumping || !this.jobs.size) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      void this.pump();
    }, Math.max(0, this.nextHistAt - Date.now()));
  }

  /** En öncelikli iş (eşitse en yeni etkinlik) */
  private nextJob(): HistJob | undefined {
    let best: HistJob | undefined;
    for (const j of this.jobs.values()) if (!best || j.prio > best.prio || (j.prio === best.prio && j.at > best.at)) best = j;
    return best;
  }

  /** İş hâlâ gerekli mi (bu arada başka iş aynı mesajları getirmiş olabilir; gereksiz istek dakikalık hakkı yemesin) */
  private jobNeeded(j: HistJob): boolean {
    if (j.kind === 'older' || j.force) return true;
    if (j.kind === 'replies') return this.threadsSeen.get(`${j.ch}/${j.parent}`) !== j.latest;
    if (this.gaps.has(j.ch)) return true;
    const floor = this.lastTs.get(j.ch);
    const seen = this.latestSeen.get(j.ch);
    if (!floor) return !!seen || !this.fetchedAt.has(j.ch);
    return !!seen && Number(seen) > Number(floor);
  }

  /** Tek iş, ardından ≥HIST_GAP_MS bekleme (Slack: dakikada 1 istek) */
  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.nextJob();
        if (!job) return;
        this.jobs.delete(job.key);
        if (!this.jobNeeded(job)) {
          for (const w of job.waiters) w.resolve();
          continue;
        }
        await this.ensureFresh();
        if (this.stopped) {
          for (const w of job.waiters) w.resolve();
          return;
        }
        this.nextHistAt = Date.now() + HIST_GAP_MS + Math.round(Math.random() * 2000);
        try {
          await this.runJob(job);
          for (const w of job.waiters) w.resolve();
        } catch (e) {
          await this.jobFailed(job, e);
        }
        return;
      }
    } finally {
      this.pumping = false;
      this.kick();
    }
  }

  private async runJob(j: HistJob): Promise<void> {
    const c = this.convs.find((x) => x.id === j.ch) ?? { id: j.ch };
    if (j.kind === 'replies') return this.fetchReplies(j.ch, j.parent!, j.latest, true);
    if (j.kind === 'older') return this.fetchHistory(c, false, { limit: HIST_LIMIT, latest: j.latest });
    await this.fetchHistory(c, false);
    this.fetchedAt.set(j.ch, Date.now());
  }

  private requeue(j: HistJob): void {
    if (this.stopped) {
      for (const w of j.waiters) w.resolve();
      return;
    }
    const cur = this.jobs.get(j.key);
    if (cur) {
      cur.prio = Math.max(cur.prio, j.prio);
      cur.waiters.push(...j.waiters);
    } else this.jobs.set(j.key, j);
  }

  private async jobFailed(j: HistJob, e: unknown): Promise<void> {
    const retry = retryAfterSec(e);
    if (retry !== undefined) {
      // Slack'in istediği kadar bekle (aynı çalışma alanındaki diğer Mivelo kullanıcıları da aynı hakkı paylaşır)
      this.nextHistAt = Date.now() + Math.max(HIST_GAP_MS, retry * 1000) + Math.round(Math.random() * 2000);
      this.warnOnce('hist429', `Slack geçmiş isteği hız sınırına takıldı; ${Math.max(61, retry)} sn sonra yeniden`);
      return this.requeue(j);
    }
    const auth = await this.onAuthError(e);
    if (auth === 'renewed' || auth === 'retry') return this.requeue(j);
    if (auth === 'expired') {
      for (const w of j.waiters) w.resolve();
      return;
    }
    const code = slackError(e) || (e as Error).message.split('\n')[0].slice(0, 60);
    // Slack'in reddi (kod var) kalıcı sayılır; ağ hatası değil (sonraki taramada yeniden)
    if (slackError(e)) {
      if (this.failUntil.size > 2000) this.failUntil.clear();
      this.failUntil.set(j.key, Date.now() + FAIL_BACKOFF_MS);
    }
    this.warnOnce(`hist:${code}`, `Slack ${j.kind === 'replies' ? 'conversations.replies' : 'geçmişi'} alınamadı (${j.ch.slice(0, 1)}…:${code})`);
    for (const w of j.waiters) w.reject(e instanceof Error ? e : new Error(code));
  }

  /** İş parçacığı yanıtları kuyruğa: varsayılan en düşük öncelik; high verilirse en yeni `max` tanesi o öncelikte */
  private queueThreads(channel: string, msgs: SlackMsg[], high?: number, max = 0): void {
    const parents = msgs.filter((m) => m.reply_count && m.ts).sort((a, b) => Number(b.latest_reply ?? b.ts) - Number(a.latest_reply ?? a.ts));
    let n = 0;
    for (const m of parents) {
      const latest = String(m.latest_reply ?? m.reply_count);
      if (this.threadsSeen.get(`${channel}/${m.ts}`) === latest) continue;
      this.enqueue({ ch: channel, kind: 'replies', parent: String(m.ts), latest, prio: high && n++ < max ? high : P_THREAD, at: Number(m.latest_reply ?? m.ts) });
    }
  }

  private async refreshList(): Promise<void> {
    // users.conversations: yalnız üyesi olunan sohbetler (conversations.list üye olunmayan açık kanalları da sayfaya
    // dolduruyordu) + imleçle tüm sayfalar (tek 200'lük sayfada büyük çalışma alanında DM'ler hiç görünmüyordu)
    const channels: NonNullable<Awaited<ReturnType<WebClient['users']['conversations']>>['channels']> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const r = await this.web.users.conversations({ types: 'im,mpim,private_channel,public_channel', limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) });
      channels.push(...(r.channels ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    const next: typeof this.convs = [];
    for (const c of channels) {
      if (!c.id) continue;
      const kind = c.is_im ? 'direct' : c.is_mpim ? 'group' : 'channel';
      const name = c.is_im ? await this.userName(String(c.user ?? '')) : `#${c.name ?? c.id}`;
      this.ensureChat(c.id, name, kind);
      next.push({ id: c.id, name, kind });
    }
    this.convs = next;
    this.convsAt = Date.now();
  }

  private cursorKey(): string {
    return `slack_last:${this.account.id}`;
  }

  /** Kalıcı imleçler (depo meta): yeniden açılışta kapalıyken gelen mesajlar oldest=imleç ile alınır */
  private loadCursors(): void {
    if (this.lastTs.size) return;
    try {
      const raw = this.store.meta(this.cursorKey());
      const j = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) this.lastTs.set(k, v);
    } catch {
      /* bozuk kayıt: ilk kurulum gibi davran */
    }
  }

  private saveCursors(): void {
    try {
      this.store.setFlag(this.cursorKey(), JSON.stringify(Object.fromEntries(this.lastTs)));
    } catch {
      /* depo kapalı (durdurma sırasında) */
    }
  }

  /** İmleç yazımı birkaç saniyede bir toplu */
  private cursorsDirty(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveCursors();
    }, 3000);
    this.saveTimer.unref?.();
  }

  private async fetchHistory(c: { id: string }, first: boolean, older?: { limit: number; latest?: string }): Promise<void> {
    const lim = this.limited;
    if (older) {
      const hist = await this.reader.conversations.history({ channel: c.id, limit: lim ? Math.min(HIST_LIMIT, older.limit) : older.limit, ...(older.latest ? { latest: older.latest } : {}), inclusive: false });
      const msgs = (hist.messages ?? []) as SlackMsg[];
      for (const m of [...msgs].reverse()) await this.ingest(c.id, m, false);
      // sınırlı kip: yanıtlar kuyrukta (kullanıcı yukarı kaydırdı: en yeni 2 dizi öne)
      if (lim) this.queueThreads(c.id, msgs, P_USER_THREAD, 2);
      else await this.threadReplies(c.id, msgs, false);
      return;
    }
    const floor = this.lastTs.get(c.id);
    // İmleci olmayan sohbet (ilk kurulum / sonradan listeye girmiş): oldest verilmedi, son mesajlar geldi — yalnız
    // bağlandıktan sonra yazılanlar canlı (eskiler bildirim/okunmamış üretmesin). Kalıcı imleçle gelen, kapalıyken
    // birikmiş mesajlar da bu oturumda ilk çekilişte canlı sayılmaz.
    const known = this.sessionKnown.has(c.id);
    const live = !first;
    this.sessionKnown.add(c.id);
    // sınırlı kipte geçmiş kuyrukla geç gelebilir (boşluk 15'erli dolar, conversations.info son mesajı önceden yazmış olabilir):
    // yalnız bağlandıktan sonra yazılan ve depoda olmayan mesaj canlı
    const isLive = (m: SlackMsg) => (lim ? live && Number(m.ts) * 1000 > this.startedAt && !this.hasMessage(c.id, String(m.ts)) : live && (known || Number(m.ts) * 1000 > this.startedAt));
    if (!floor) {
      const hist = await this.reader.conversations.history({ channel: c.id, limit: lim ? HIST_LIMIT : first ? 30 : 20, inclusive: false });
      const msgs = (hist.messages ?? []) as SlackMsg[];
      for (const m of [...msgs].reverse()) {
        await this.ingest(c.id, m, isLive(m));
        const prev = this.lastTs.get(c.id);
        if (m.ts && (!prev || Number(m.ts) > Number(prev))) this.lastTs.set(c.id, String(m.ts));
      }
      if (this.lastTs.has(c.id)) this.cursorsDirty();
      if (lim) this.queueThreads(c.id, msgs);
      else await this.threadReplies(c.id, msgs, live);
      return;
    }
    // İmleçten sonrası TAMAMI: Slack oldest verilince aralığın EN YENİ `limit` mesajını döndürür → imleçle (cursor)
    // sayfala. Sınırda hâlâ daha eski mesaj varsa imleç ilerlemez; kalan aralık (floor, top) sonraki turda alınır.
    const gap = this.gaps.get(c.id);
    const msgs: SlackMsg[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < (lim ? 1 : HISTORY_PAGES); page++) {
      const hist = await this.reader.conversations.history({
        channel: c.id,
        limit: lim ? HIST_LIMIT : 200,
        oldest: floor,
        ...(gap ? { latest: gap.top } : {}),
        inclusive: false,
        ...(cursor ? { cursor } : {}),
      });
      msgs.push(...((hist.messages ?? []) as SlackMsg[]));
      cursor = (hist as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor || undefined;
      if (!cursor || !hist.has_more) {
        complete = true;
        break;
      }
    }
    const sorted = msgs.filter((m) => m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of sorted) await this.ingest(c.id, m, isLive(m));
    const newest = sorted.length ? String(sorted[sorted.length - 1].ts) : undefined;
    const high = [gap?.high, newest].filter((x): x is string => !!x).reduce<string | undefined>((a, b) => (!a || Number(b) > Number(a) ? b : a), undefined);
    if (complete) {
      this.gaps.delete(c.id);
      // eşzamanlı çağrı (Socket Mode olayı + yoklama) imleci daha ileri taşımış olabilir: geri alma
      if (high && Number(high) > Number(this.lastTs.get(c.id) ?? floor)) {
        this.lastTs.set(c.id, high);
        this.cursorsDirty();
      }
    } else if (sorted.length) {
      this.gaps.set(c.id, { top: String(sorted[0].ts), high: high ?? String(sorted[0].ts) });
    }
    if (lim) {
      // kalan aralık (boşluk) sırayla, yanıtlar en düşük öncelikle
      if (this.gaps.has(c.id)) this.enqueue({ ch: c.id, kind: 'new', prio: this.isSmall(this.convs.find((x) => x.id === c.id) ?? c) ? P_GAP_SMALL : P_GAP, at: Number(high ?? 0) });
      this.queueThreads(c.id, msgs);
      return;
    }
    await this.threadReplies(c.id, msgs, live);
  }

  /** iş parçacığı yanıtları history'de yok: yanıtı olan (ve yeni yanıt gelmiş) üst mesajlarınki ayrıca, tur başına en çok 5 */
  private async threadReplies(channel: string, msgs: SlackMsg[], live: boolean): Promise<void> {
    const c = { id: channel };
    let n = 0;
    for (const m of msgs) {
      if (!m.reply_count || !m.ts || n >= 5) continue;
      const key = `${c.id}/${m.ts}`;
      const latest = String(m.latest_reply ?? m.reply_count);
      if (this.threadsSeen.get(key) === latest) continue;
      n++;
      await this.fetchReplies(c.id, String(m.ts), latest, live);
    }
  }

  /**
   * Yanıtlar eskiden yeniye gelir: tek 40'lık istekte uzun dizilerin yeni yanıtları hiç alınmıyordu. Artık alınmış en yeni
   * yanıttan (oldest) sonrası, imleçle en çok 5 sayfa. live: yalnız depoda olmayan ve bağlandıktan sonra yazılan yanıtlar canlı.
   */
  private async fetchReplies(channel: string, parentTs: string, latest?: string, live = true): Promise<void> {
    const key = `${channel}/${parentTs}`;
    const lim = this.limited;
    try {
      const all: SlackMsg[] = [];
      let cursor: string | undefined;
      const oldest = this.threadLast.get(key);
      // sınırlı kip: tek istek (≤15); devamı varsa iş yeniden kuyruğa (threadLast ilerlediği için sonraki istek kaldığı yerden)
      for (let page = 0; page < (lim ? 1 : 5); page++) {
        const rep = await this.reader.conversations.replies({ channel, ts: parentTs, limit: lim ? HIST_LIMIT : 200, ...(oldest ? { oldest, inclusive: false } : {}), ...(cursor ? { cursor } : {}) });
        all.push(...((rep.messages ?? []) as SlackMsg[]));
        cursor = (rep as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      for (const x of all) {
        if (!x.ts || String(x.ts) === parentTs) continue;
        const isLive = live && !this.hasMessage(channel, String(x.ts)) && Number(x.ts) * 1000 > this.startedAt;
        await this.ingest(channel, { ...x, thread_ts: parentTs }, isLive);
        const prev = this.threadLast.get(key);
        if (!prev || Number(x.ts) > Number(prev)) this.threadLast.set(key, String(x.ts));
      }
      if (lim && cursor) {
        this.enqueue({ ch: channel, kind: 'replies', parent: parentTs, latest, prio: P_THREAD, at: Number(latest ?? parentTs) });
        return;
      }
      this.threadsSeen.set(key, latest ?? String(all[0]?.latest_reply ?? all.length));
    } catch (e) {
      // sınırlı kip: hız sınırı/yetki hatası kuyruğa (Retry-After, belirteç yenileme)
      if (lim) throw e;
      // yanıtlar alınamadı; sonraki olay/yoklamada yeniden
      this.warnOnce(`replies:${slackError(e)}`, `Slack conversations.replies başarısız (${slackError(e) || (e as Error).message.split('\n')[0].slice(0, 60)})`);
    }
  }

  /** Slack mesajı → ortak model (tarayıcı yoluyla aynı biçimlendirme: bahsetmeler, bağlantılar, dosyalar, tepkiler) */
  private async ingest(channel: string, m: SlackMsg, live: boolean): Promise<void> {
    if (!m.ts || (m.subtype && SKIP_SUBTYPES.has(m.subtype))) return;
    const files = (m.files ?? []).filter((f) => f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
    const uid = String(m.user ?? m.bot_id ?? '');
    // bahsetmelerdeki adlar önbellekte olsun
    // metni boş, içeriği yalnız bloklarda/eklerde olan mesajlar (uygulama/iş akışı mesajları) atılmasın
    const raw = rawSlackText(m as Record<string, unknown>);
    for (const id of new Set([...raw.matchAll(/<@([A-Z0-9_]+)>/g)].map((x) => x[1]))) await this.user(id);
    const text = formatSlackText(raw, this.users);
    if (!text && !files.length) return;
    const fromMe = uid === this.meId;
    const u = m.subtype === 'bot_message' && m.username ? { name: m.username, avatar: m.icons?.image_64 } : fromMe ? { name: 'Ben' } : await this.user(uid);
    const reactions: Reaction[] = [];
    for (const r of m.reactions ?? []) {
      const name = String(r.name ?? '').split('::')[0];
      const emoji = SLACK_EMOJI[name] ?? `:${name}:`;
      const ids = (r.users ?? []).slice(0, 50);
      for (const id of ids) reactions.push({ emoji, senderId: id, senderName: id === this.meId ? 'Ben' : (this.users.get(id)?.name ?? id), fromMe: id === this.meId });
      for (let i = ids.length; i < Number(r.count ?? ids.length); i++) reactions.push({ emoji, senderId: `${name}#${i}`, senderName: '', fromMe: false });
    }
    const proxied = (x?: string) => (x ? `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(x)}` : undefined);
    this.upsertMessage(
      {
        remoteChatId: channel,
        remoteId: String(m.ts),
        senderId: fromMe ? 'me' : uid || 'bot',
        senderName: u.name,
        senderAvatarUrl: u.avatar,
        fromMe,
        text,
        ts: Math.floor(Number(m.ts) * 1000),
        status: fromMe ? 'sent' : 'delivered',
        attachments: files.length ? files.map((f) => fileToAttachment(f)).map((a) => ({ ...a, url: proxied(a.url), link: proxied(a.link) })) : undefined,
        reactions: reactions.length ? reactions : [],
        threadId: m.thread_ts && String(m.thread_ts) !== String(m.ts) ? String(m.thread_ts) : undefined,
        replyCount: m.reply_count ? Number(m.reply_count) : undefined,
        edited: m.edited ? true : undefined,
      },
      { live },
    );
  }
}

/** İmleçten sonrası için tur başına en çok sayfa (×200 mesaj); fazlası boşluk kaydıyla sonraki turda */
const HISTORY_PAGES = 5;

/** Sınırlı kip: history/replies istekleri arası (Slack: dakikada 1) */
const HIST_GAP_MS = 61_000;
/** Sınırlı kip: istek başına en çok mesaj (Slack: ≤15) */
const HIST_LIMIT = 15;
/** conversations.info (Tier 3, ~50/dk): ilk turda / sonraki turlarda sorulan sohbet sayısı */
const INFO_FIRST = 40;
const INFO_PER_POLL = 20;
/** Bu kadar ya da daha az üyeli kanal "küçük grup" (birebir gibi öncelikli) */
const SMALL_GROUP = 8;
/** Birebir/küçük grup etkinlik avantajı (sn): 3 günden eski birebir, bugün etkin kanalın arkasında kalır */
const SMALL_BOOST_S = 3 * 86_400;
/** Eski mesaj isteği bu kadar beklerse arayüze timedOut (mesajlar sonra olayla gelir) */
const LOAD_WAIT_MS = 20_000;
/** latest vermeyen sohbette geçmiş yenileme aralığı */
const STALE_MS = 15 * 60_000;
const UNREAD_STALE_MS = 2 * 60_000;
/** Belirteç bitişinden bu kadar önce yenilenir */
const REFRESH_AHEAD_MS = 10 * 60_000;
const RENEW_RETRY_MS = 5 * 60_000;
/** Kalıcı hata veren geçmiş işi bu kadar süre kendiliğinden yeniden istenmez */
const FAIL_BACKOFF_MS = 30 * 60_000;
/** Kuyruk öncelikleri (büyük önce) */
const P_USER = 100;
const P_USER_THREAD = 90;
const P_NEW_SMALL = 70;
const P_NEW_CHANNEL = 50;
const P_UNREAD_BONUS = 10;
const P_GAP_SMALL = 40;
const P_GAP = 30;
const P_BACKFILL_SMALL = 25;
const P_BACKFILL = 15;
const P_THREAD = 10;

/** Sınırlı kip kuyruk işi: new = imleçten sonrası (ya da ilk geçmiş/boşluk), older = yukarı kaydırma, replies = iş parçacığı */
type HistJob = {
  key: string;
  ch: string;
  kind: 'new' | 'older' | 'replies';
  prio: number;
  /** etkinlik zamanı (Slack ts, sn): aynı öncelikte yenisi önce */
  at: number;
  parent?: string;
  /** older: bu ts'ten eskiler; replies: üst mesajın latest_reply'ı */
  latest?: string;
  /** "gerekli mi" denetimi atlanır (dosya paylaşımı, latest vermeyen sohbet) */
  force: boolean;
  waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
};
/** conversations.info kanalı (kullanıcı belirteciyle gelen okuma alanları) */
type InfoChannel = { latest?: SlackMsg | null; last_read?: string; unread_count?: number; unread_count_display?: number; num_members?: number };

/** Hesabın yetkisi bitti (belirteç geçersiz/iptal/süresi doldu) */
const AUTH_ERRORS = /^(invalid_auth|not_authed|token_revoked|token_expired|account_inactive)$/;

/** Hız sınırı hatası → beklenecek saniye (WebClient rejectRateLimitedCalls ya da Slack "ratelimited") */
function retryAfterSec(e: unknown): number | undefined {
  const x = e as { code?: string; retryAfter?: number; data?: { error?: string; response_metadata?: { retryAfter?: number } } } | undefined;
  if (x?.code === 'slack_webapi_rate_limited_error') return Number(x.retryAfter) || 60;
  if (x?.data?.error === 'ratelimited' || x?.data?.error === 'rate_limited') return Number(x.data.response_metadata?.retryAfter) || 60;
  return undefined;
}

/** Yenileme belirteci de geçersiz: kullanıcı yeniden giriş yapmalı (Slack: invalid_refresh_token OAuthError.revoked'a girmiyor) */
function renewRevoked(e: unknown): boolean {
  if (!(e instanceof OAuthError)) return false;
  return e.revoked || /invalid_refresh_token|invalid_auth|account_inactive|token_expired/i.test(`${e.code ?? ''} ${e.message}`);
}

function maxTs(...xs: Array<string | undefined>): string | undefined {
  return xs.filter((x): x is string => !!x).reduce<string | undefined>((a, b) => (!a || Number(b) > Number(a) ? b : a), undefined);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SlackMsg = {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  icons?: { image_64?: string };
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: Array<Record<string, any>>;
  /** metin boşsa içerik (rich_text / section) — rawSlackText */
  blocks?: Array<Record<string, any>>;
  attachments?: Array<Record<string, any>>;
  reactions?: Array<{ name?: string; users?: string[]; count?: number }>;
  /** düzenlendiyse {user, ts} */
  edited?: { user?: string; ts?: string };
};
type SlackEvent = {
  type?: string;
  channel?: string;
  subtype?: string;
  thread_ts?: string;
  /** message_changed: mesajın yeni hâli */
  message?: SlackMsg & { thread_ts?: string };
  /** message_deleted: silinen mesajın ts'si */
  deleted_ts?: string;
  user?: string;
  reaction?: string;
  item?: { channel?: string; ts?: string };
};

function slackError(e: unknown): string {
  return String((e as { data?: { error?: string } })?.data?.error ?? '');
}
/** Eski bildirimle kurulmuş uygulama: yeni kapsam eksikse ne yapılacağını söyle */
function scopeHint(e: unknown, what: string): Error {
  const code = slackError(e);
  if (code === 'missing_scope' || code === 'not_allowed_token_type') {
    return new Error(`Slack ${what} için yeni izin gerekiyor: Bağlan → Slack'teki bağlantıyla uygulamayı güncelleyip yeniden kur ve yeni xoxp belirtecini gir`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
