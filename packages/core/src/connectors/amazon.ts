import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { BrowserConnector } from './browser/bridge.js';
import { makeAmazonMessaging, marketplaceOf, DEFAULT_MARKETPLACE, type Marketplace } from './browser/amazon.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { chatId, type AccountStatus, type Participant } from '../model.js';
import type { Store } from '../store.js';

/**
 * Amazon: iki parça tek hesapta.
 *  1) Siparişler — Selling Partner API (SP-API). Kimlik: Login with Amazon (LWA) refresh token; erişim belirteci
 *     `POST https://api.amazon.com/auth/o2/token` ile (1 saat, 5 dk önce yenilenir, bellekte). İstekler
 *     `x-amz-access-token` başlığıyla; 2023 sonrası AWS SigV4 imzası GEREKMEZ. Uç bölgeye göre
 *     sellingpartnerapi-{eu|na|fe}.amazon.com.
 *       - GET /orders/v0/orders?MarketplaceIds=…&CreatedAfter=… | LastUpdatedAfter=… (ikisi birlikte olmaz), sayfalama NextToken;
 *         getOrders hız sınırı 0.0167/sn (patlama 20) → yoklama 2 dk.
 *       - GET /orders/v0/orders/{orderId}/orderItems (0.5/sn, patlama 30) → ilk yoklamada en fazla 30 sipariş, sonra yalnız yeniler.
 *       - Alıcı adı / teslimat adresi (PII) yalnızca uygulamada "Direct-to-Consumer Shipping" rolü varsa gelir; yoksa "Amazon alıcısı".
 *     Her sipariş bir sohbet (`order-<AmazonOrderId>`); durum değişimleri mesaj olarak akar.
 *  2) Alıcı mesajları — SP-API Messaging API (/messaging/v1) YALNIZCA satıcıdan alıcıya şablonlu mesaj gönderir
 *     (confirmDeliveryDetails, unexpectedProblem…); alıcıdan gelen mesajları OKUYAN bir uç YOKTUR. Gelen kutusu bu yüzden
 *     Seller Central mesajlaşma sayfasından tarayıcı köprüsüyle (`browser/amazon.ts`) okunur; oradaki yanıt kutusuyla yanıtlanır.
 *     Şablonlu gönderim `action(remoteChatId, { kind: 'message', type: '<şablon>', text })` ile.
 *
 * Yapılandırma (token dosyası JSON): { clientId, clientSecret, refreshToken, marketplaceId?: 'A33AVAJ2PDY3EV' (Türkiye),
 *   region?: 'eu'|'na'|'fe' (varsayılan pazar yerinden türetilir), messaging?: boolean (Seller Central köprüsü; varsayılan KAPALI —
 *   Amazon'un 4 Mart 2026 ajan/otomasyon politikası; açıkça true verilirse başlar) }
 * Client ID/Secret: Seller Central → Uygulamalar ve Hizmetler → Geliştirici Merkezi (özel uygulama); Refresh Token: uygulamayı
 * yetkilendirince ("Self authorization").
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const LWA_URL = 'https://api.amazon.com/auth/o2/token';
const ENDPOINTS: Record<'eu' | 'na' | 'fe', string> = {
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  na: 'https://sellingpartnerapi-na.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};
const POLL_MS = 120_000;
const FIRST_WINDOW_MS = 90 * 86_400_000;
const ITEMS_FIRST_MAX = 30;
const USER_AGENT = 'Mivelo/1.0 (Language=TypeScript; Platform=Node)';

export interface AmazonConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId?: string;
  region?: 'eu' | 'na' | 'fe';
  /** Seller Central mesajlaşma köprüsünü (Chromium) başlat; varsayılan true */
  messaging?: boolean;
}

/** Yapılandırma metnini çöz; pazar yeri ve bölge türetilir */
export function parseAmazonConfig(config: string): { clientId: string; clientSecret: string; refreshToken: string; marketplace: Marketplace; region: 'eu' | 'na' | 'fe'; messaging: boolean } {
  let cfg: Partial<AmazonConfig> = {};
  try {
    cfg = JSON.parse(config || '{}') as Partial<AmazonConfig>;
  } catch {
    /* geçersiz JSON: boş yapılandırma */
  }
  const marketplace = marketplaceOf(String(cfg.marketplaceId ?? DEFAULT_MARKETPLACE));
  const region = cfg.region && cfg.region in ENDPOINTS ? cfg.region : marketplace.region;
  return {
    clientId: String(cfg.clientId ?? '').trim(),
    clientSecret: String(cfg.clientSecret ?? '').trim(),
    refreshToken: String(cfg.refreshToken ?? '').trim(),
    marketplace,
    region,
    messaging: cfg.messaging === true,
  };
}

/** Kimlik reddi (LWA invalid_grant, 401 yenileme sonrası, 403): yoklama durdurulur, durum error */
class AuthError extends Error {}

const money = (v: unknown, cur: string): string => {
  const n = Number(v ?? 0);
  const s = Number.isFinite(n) ? n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? '0');
  return `${s} ${cur === 'TRY' ? '₺' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur}`;
};

/** OrderStatus → Türkçe etiket (Orders API v0 enum) */
export const STATUS_LABEL: Record<string, string> = {
  PendingAvailability: 'stok bekleniyor',
  Pending: 'ödeme bekleniyor',
  Unshipped: 'kargolanacak',
  PartiallyShipped: 'kısmen kargolandı',
  Shipped: 'kargolandı',
  InvoiceUnconfirmed: 'fatura bekliyor',
  Canceled: 'iptal edildi',
  Unfulfillable: 'karşılanamıyor',
  Delivered: 'teslim edildi',
};
/** Sohbet "açık" (ilgi bekliyor) sayılan durumlar */
const OPEN_STATUSES = new Set(['PendingAvailability', 'Pending', 'Unshipped', 'PartiallyShipped', 'InvoiceUnconfirmed']);
/** Durum → olay mesajı (fromMe); Pending/Unshipped geçişi yalnız daha önce görülmüş siparişte yazılır */
const STATUS_EVENT: Record<string, string> = {
  Unshipped: '✅ Ödeme onaylandı — kargolanmayı bekliyor',
  PartiallyShipped: '📦 Kısmen kargoya verildi',
  Shipped: '📦 Kargoya verildi',
  Delivered: '📦 Teslim edildi',
  Canceled: '❌ Sipariş iptal edildi',
  Unfulfillable: '❌ Sipariş karşılanamıyor',
};

/** Messaging API şablonları: metin alan (text) ve yalnız ek isteyen (attachments) — bkz. messaging.json */
export const MESSAGE_TEMPLATES: Record<string, { label: string; text: boolean; max?: number }> = {
  confirmCustomizationDetails: { label: 'Özelleştirme ayrıntılarını onayla', text: true, max: 800 },
  confirmDeliveryDetails: { label: 'Teslimat ayrıntılarını onayla', text: true, max: 2000 },
  confirmOrderDetails: { label: 'Sipariş ayrıntılarını onayla', text: true, max: 2000 },
  confirmServiceDetails: { label: 'Hizmet ayrıntılarını onayla', text: true, max: 2000 },
  digitalAccessKey: { label: 'Dijital erişim anahtarı', text: true, max: 800 },
  unexpectedProblem: { label: 'Beklenmeyen sorun', text: true, max: 2000 },
  legalDisclosure: { label: 'Yasal bildirim (yalnız ek)', text: false },
  warranty: { label: 'Garanti (yalnız ek)', text: false },
  invoice: { label: 'Fatura gönder (yalnız ek)', text: false },
};

/**
 * Bileşik durum: API bağlıysa hesap 'connected'; mesajlaşma köprüsünün durumu ayrıntıya yazılır.
 * API hatası her zaman baskın (siparişler asıl kaynak). API 'connected' değilse köprü durumu görünmez.
 */
export function combineStatus(api: { status: AccountStatus; detail?: string }, bridge?: { status: AccountStatus; detail?: string }): { status: AccountStatus; detail?: string } {
  if (api.status !== 'connected' || !bridge) return api;
  switch (bridge.status) {
    case 'pairing':
      return { status: 'connected', detail: 'Alıcı mesajları için Seller Central girişi gerekli (Yeniden bağlan)' };
    case 'error':
      return { status: 'connected', detail: `Mesajlar: ${bridge.detail ?? 'hata'}` };
    case 'connecting':
      return { status: 'connected', detail: 'Mesajlar bağlanıyor…' };
    case 'disconnected':
      return { status: 'connected', detail: `Mesajlar kapalı${bridge.detail ? ` — ${bridge.detail}` : ''}` };
    default:
      return { status: 'connected', detail: api.detail };
  }
}

/** Köprü alt bileşeni: durumunu hesaba yazmak yerine bileşik connector'a bildirir (aynı Account nesnesi paylaşılır) */
class MessagingBridge extends BrowserConnector {
  constructor(
    account: BaseConnector['account'],
    store: Store,
    host: string,
    getLabel: () => string | undefined,
    private readonly onStatus: (status: AccountStatus, detail?: string) => void,
  ) {
    super(account, store, makeAmazonMessaging(host, getLabel), 30_000);
  }
  protected override setStatus(status: AccountStatus, detail?: string): void {
    this.onStatus(status, detail);
  }
}

export class AmazonConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly marketplace: Marketplace;
  private readonly endpoint: string;
  private readonly messagingEnabled: boolean;
  private bridge?: MessagingBridge;
  private apiState: { status: AccountStatus; detail?: string } = { status: 'disconnected' };
  private bridgeState?: { status: AccountStatus; detail?: string };
  /** LWA erişim belirteci (bellekte; 1 saat) */
  private token?: { access: string; expiresAt: number };
  /** sipariş id → son görülen durum imzası */
  private seen = new Map<string, string>();
  /** son başarılı yoklamanın başlangıcı (ISO): sonraki yoklama LastUpdatedAfter = since − 5 dk ile yalnız değişenleri alır */
  private since?: string;
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: Store, config: string) {
    super(account, store);
    const cfg = parseAmazonConfig(config);
    this.ordersOn = ordersFlag(config);
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.refreshToken = cfg.refreshToken;
    this.marketplace = cfg.marketplace;
    this.endpoint = ENDPOINTS[cfg.region];
    this.messagingEnabled = cfg.messaging;
    this.stateFile = path.join(sessionDir(account.id), 'amazon-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { seen?: Record<string, string>; since?: string };
      for (const [k, v] of Object.entries(st.seen ?? {})) this.seen.set(k, v);
      this.since = st.since;
    } catch {
      /* ilk çalıştırma */
    }
  }

  // ─────────── LWA ───────────
  /** Erişim belirteci yoksa ya da 5 dk içinde dolacaksa refresh_token ile yenile */
  private async ensureToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 5 * 60_000 > Date.now()) return this.token.access;
    const r = await fetch(LWA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId, client_secret: this.clientSecret }).toString(),
    });
    const text = await r.text();
    let j: J = {};
    try {
      j = text ? (JSON.parse(text) as J) : {};
    } catch {
      /* JSON değil */
    }
    if (!r.ok || !j.access_token) {
      const code = String(j.error ?? r.status);
      if (r.status === 400 || r.status === 401) throw new AuthError(`Amazon LWA belirteci reddedildi (${code}) — Client ID / Client Secret / Refresh Token'ı denetle`);
      throw new Error(`Amazon LWA ${r.status}: ${String(j.error_description ?? text).slice(0, 160)}`);
    }
    this.token = { access: String(j.access_token), expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.token.access;
  }

  // ─────────── SP-API ───────────
  /** `p`: `/orders/v0/orders?…` biçiminde yol. 401 → belirteç bir kez yenilenir; 403 → AuthError; 429 → Retry-After/RateLimit sonra bir kez daha */
  private async api(method: 'GET' | 'POST', p: string, body?: J, retried = false): Promise<{ data: J; headers: Headers }> {
    const access = await this.ensureToken();
    const r = await fetch(this.endpoint + p, {
      method,
      headers: { 'x-amz-access-token': access, accept: 'application/json', 'user-agent': USER_AGENT, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data: J = {};
    try {
      data = text ? (JSON.parse(text) as J) : {};
    } catch {
      /* JSON değil */
    }
    const errMsg = Array.isArray(data.errors) && data.errors[0]?.message ? String(data.errors[0].message) : text.slice(0, 160);
    if (r.status === 401) {
      if (!retried) {
        await this.ensureToken(true); // belirteç süresi dolmuş/iptal olabilir: bir kez yenile
        return this.api(method, p, body, true);
      }
      throw new AuthError('Amazon SP-API erişimi reddedildi (401) — Refresh Token geçersiz ya da uygulama yetkisi düşmüş');
    }
    if (r.status === 403) throw new AuthError(`Amazon SP-API yetkisi yok (403): ${errMsg}`);
    if (r.status === 429) {
      // Retry-After yoksa x-amzn-RateLimit-Limit (istek/sn) tersinden bekleme türet; 1–60 sn
      const rate = Number(r.headers.get('x-amzn-ratelimit-limit') ?? '') || 0;
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after') ?? '') || (rate > 0 ? Math.ceil(1 / rate) : 2), 1), 60);
      if (!retried) {
        bus.log('warn', `Amazon istek limiti (429); ${wait} sn bekleniyor`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        return this.api(method, p, body, true);
      }
      throw new Error(`Amazon istek limiti; ${wait} sn sonra yeniden dene`);
    }
    if (!r.ok) throw new Error(`Amazon ${r.status} ${p.split('?')[0]}: ${errMsg}`);
    return { data, headers: r.headers };
  }

  // ─────────── Durum birleştirme ───────────
  private publish(): void {
    if (this.stopping) return;
    const { status, detail } = combineStatus(this.apiState, this.bridgeState);
    super.setStatus(status, detail);
  }
  private setApiStatus(status: AccountStatus, detail?: string): void {
    this.apiState = { status, detail };
    this.publish();
  }
  private setBridgeStatus(status: AccountStatus, detail?: string): void {
    this.bridgeState = { status, detail };
    bus.log(status === 'error' ? 'warn' : 'info', `amazon/mesajlar: ${status}${detail ? ' — ' + detail : ''}`);
    this.publish();
  }

  async start(opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.clientId || !this.clientSecret || !this.refreshToken) return this.setApiStatus('error', 'Amazon LWA Client ID / Client Secret / Refresh Token girilmedi');
    this.setApiStatus('connecting');
    try {
      await this.ensureToken();
      // Pazar yeri katılımları: kimliği doğrular, seçili pazar yeri hesapta yoksa uyarır (rol yoksa sessizce geç)
      const { data } = await this.api('GET', '/sellers/v1/marketplaceParticipations').catch((e) => {
        if (e instanceof AuthError) throw e;
        return { data: {} as J, headers: new Headers() };
      });
      const parts: J[] = Array.isArray(data.payload) ? data.payload : [];
      if (parts.length && !parts.some((x) => x.marketplace?.id === this.marketplace.id)) {
        bus.log('warn', `Amazon: seçili pazar yeri (${this.marketplace.id} ${this.marketplace.country}) hesabın katılımlarında yok: ${parts.map((x) => x.marketplace?.countryCode ?? x.marketplace?.id).join(', ')}`);
      }
      if (!this.account.label || /^amazon$/i.test(this.account.label)) this.account.label = `Amazon.${this.marketplace.domain.replace(/^amazon\./, '')}`;
      await this.poll(true);
      this.setApiStatus('connected', this.marketplace.country);
      if (this.timer) clearInterval(this.timer);
      // poll AuthError'u yeniden fırlatır (durumu zaten 'error' yapıp zamanlayıcıyı durdurur): burada yutulur, söz reddi yakalanmamış kalmasın
      this.timer = setInterval(() => void this.poll(false).catch(() => undefined), POLL_MS);
    } catch (e) {
      this.setApiStatus('error', (e as Error).message.split('\n')[0]);
      return;
    }
    // Mesajlaşma köprüsü: kullanıcı girişi (interactive) dakikalar sürebilir, start'ı bekletmesin
    if (this.messagingEnabled && !this.stopping) {
      this.bridge ??= new MessagingBridge(this.account, this.store, this.marketplace.host, () => this.account.label, (s, d) => this.setBridgeStatus(s, d));
      void this.bridge.start(opts).catch((e) => this.setBridgeStatus('error', (e as Error).message.split('\n')[0]));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.bridge?.stop().catch(() => undefined);
    this.bridgeState = undefined;
    this.apiState = { status: 'disconnected' };
    this.setStatus('disconnected');
  }

  // ─────────── Sipariş yoklama ───────────
  private ordersQuery(first: boolean): string {
    const q = new URLSearchParams({ MarketplaceIds: this.marketplace.id, MaxResultsPerPage: '100' });
    // CreatedAfter ve LastUpdatedAfter birlikte verilemez; ilk yoklama 14 gün, sonra son yoklama − 5 dk
    if (first || !this.since) q.set('CreatedAfter', new Date(Date.now() - FIRST_WINDOW_MS).toISOString());
    else q.set('LastUpdatedAfter', new Date((Date.parse(this.since) || Date.now()) - 5 * 60_000).toISOString());
    return `/orders/v0/orders?${q.toString()}`;
  }

  private async fetchItems(orderId: string): Promise<J[]> {
    const items: J[] = [];
    let next: string | undefined;
    for (let page = 0; page < 3; page++) {
      const q = next ? `?NextToken=${encodeURIComponent(next)}` : '';
      const { data } = await this.api('GET', `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems${q}`);
      const list: J[] = Array.isArray(data.payload?.OrderItems) ? data.payload.OrderItems : [];
      items.push(...list);
      next = data.payload?.NextToken || undefined;
      if (!next) break;
    }
    return items;
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    if (!this.ordersOn) {
      this.polling = false;
      return; // sipariş sohbetleri kapalı: yalnız mesajlaşma köprüsü çalışır
    }
    const startedAt = new Date().toISOString();
    try {
      const orders: J[] = [];
      let url: string | undefined = this.ordersQuery(first);
      for (let page = 0; url && page < 10; page++) {
        const { data } = await this.api('GET', url);
        const list: J[] = Array.isArray(data.payload?.Orders) ? data.payload.Orders : [];
        orders.push(...list);
        const next: string | undefined = data.payload?.NextToken || undefined;
        url = next && list.length ? `/orders/v0/orders?MarketplaceIds=${encodeURIComponent(this.marketplace.id)}&NextToken=${encodeURIComponent(next)}` : undefined;
      }
      // eskiden yeniye: sohbet sırası ve "canlı" bildirimler doğru olsun
      orders.sort((a, b) => (Date.parse(a.PurchaseDate ?? '') || 0) - (Date.parse(b.PurchaseDate ?? '') || 0));
      // kalemler: ilk yoklamada en yeni 30 sipariş, sonrasında yalnız daha önce görülmemiş siparişler (getOrderItems 0.5/sn)
      const fresh = orders.filter((o) => !this.seen.has(String(o.AmazonOrderId)));
      const withItems = new Set((first ? fresh.slice(-ITEMS_FIRST_MAX) : fresh).map((o) => String(o.AmazonOrderId)));
      let changed = 0;
      for (const o of orders) {
        const id = String(o.AmazonOrderId ?? '');
        if (!id) continue;
        let items: J[] | undefined;
        if (withItems.has(id)) {
          items = await this.fetchItems(id).catch((e) => {
            if (e instanceof AuthError) throw e;
            bus.log('warn', `Amazon kalemler ${id}: ${(e as Error).message}`);
            return undefined;
          });
        }
        if (this.ingest(o, items, !first)) changed++;
      }
      if (changed) bus.log('info', `Amazon: ${changed} sipariş güncellendi`);
      this.since = startedAt;
      this.saveState();
    } catch (e) {
      if (e instanceof AuthError) {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (!first) this.setApiStatus('error', e.message);
        throw e;
      }
      bus.log('warn', `Amazon yoklama: ${(e as Error).message}`);
      if (first) throw e;
    } finally {
      this.polling = false;
    }
  }

  private saveState(): void {
    const seen: Record<string, string> = {};
    for (const [k, v] of [...this.seen.entries()].slice(-3000)) seen[k] = v;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ seen, since: this.since }));
    } catch {
      /* yazılamadı */
    }
  }

  /** Sipariş → sohbet + olay mesajları. Değişiklik varsa true döner. `items` verilmezse depodaki kalemler korunur. */
  private ingest(o: J, items: J[] | undefined, live: boolean): boolean {
    const id = String(o.AmazonOrderId);
    const remoteChatId = `order-${id}`;
    const status: string = o.OrderStatus ?? 'Pending';
    const sig = JSON.stringify([status, o.NumberOfItemsShipped ?? 0, o.NumberOfItemsUnshipped ?? 0, o.FulfillmentChannel ?? '']);
    const prev = this.seen.get(id);
    if (prev === sig) return false;
    this.seen.set(id, sig);
    let prevStatus: string | undefined;
    try {
      prevStatus = prev ? (JSON.parse(prev) as unknown[])[0] as string : undefined;
    } catch {
      /* eski imza */
    }

    const buyer: J = o.BuyerInfo ?? {};
    const ship: J = o.ShippingAddress ?? {};
    const customer: string = buyer.BuyerName || ship.Name || 'Amazon alıcısı';
    const email: string | undefined = buyer.BuyerEmail || undefined;
    const phone: string | undefined = ship.Phone || undefined;
    const cur: string = o.OrderTotal?.CurrencyCode ?? 'TRY';
    const total: string | undefined = o.OrderTotal?.Amount;
    const created = Date.parse(o.PurchaseDate ?? '') || Date.now();
    const updated = Date.parse(o.LastUpdateDate ?? '') || created;
    const address = [ship.AddressLine1, ship.AddressLine2, ship.AddressLine3, ship.District, ship.City, ship.StateOrRegion, ship.PostalCode, ship.CountryCode].filter(Boolean).join(', ');
    const existing = this.store.getChat(chatId(this.account.id, remoteChatId));
    const prevItems = (existing?.meta?.order as J | undefined)?.items as J[] | undefined;
    const metaItems: J[] = items
      ? items.map((li) => ({ title: li.Title ?? li.ASIN ?? 'Ürün', quantity: li.QuantityOrdered ?? 1, total: li.ItemPrice?.Amount ?? undefined, sku: li.SellerSKU, asin: li.ASIN, selection: [] }))
      : prevItems ?? [];
    const itemLines = metaItems.map((li) => `• ${li.quantity ?? 1} × ${li.title}${li.total != null ? ` — ${money(li.total, cur)}` : ''}`);
    const participant: Participant = { id: email || `buyer-${id}`, name: customer, handle: email || phone || undefined };
    const open = OPEN_STATUSES.has(status);
    const channel = o.FulfillmentChannel === 'AFN' ? 'Amazon Lojistik (FBA)' : o.FulfillmentChannel === 'MFN' ? 'Satıcı kargolar (FBM)' : undefined;

    this.upsertChat({
      remoteId: remoteChatId,
      name: `#${id} · ${customer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: email || phone || undefined,
      link: `https://${this.marketplace.host}/orders-v3/order/${encodeURIComponent(id)}`,
      participants: [participant],
      unread: !prev && open ? 1 : undefined, // açık sipariş ilk görüldüğünde "ilgi bekliyor"
      meta: {
        order: {
          id,
          status,
          statusLabel: STATUS_LABEL[status] ?? status,
          paymentStatus: status === 'Pending' ? 'pending' : status === 'Canceled' ? 'voided' : 'paid',
          dateCreated: o.PurchaseDate,
          dateUpdated: o.LastUpdateDate,
          currency: cur,
          totals: { total },
          items: metaItems,
          shipping: { name: ship.Name || customer, phone, email, address, service: o.ShipServiceLevel ?? o.ShipmentServiceLevelCategory ?? undefined },
          fulfillments: [{ status: channel ? `${STATUS_LABEL[status] ?? status} · ${channel}` : STATUS_LABEL[status] ?? status, company: o.FulfillmentChannel ?? undefined, date: o.LastUpdateDate }],
          refunds: [],
          fulfillmentChannel: o.FulfillmentChannel,
          salesChannel: o.SalesChannel,
          marketplaceId: o.MarketplaceId ?? this.marketplace.id,
          isPrime: o.IsPrime ?? undefined,
          isBusinessOrder: o.IsBusinessOrder ?? undefined,
          latestShipDate: o.LatestShipDate ?? undefined,
          earliestDeliveryDate: o.EarliestDeliveryDate ?? undefined,
          latestDeliveryDate: o.LatestDeliveryDate ?? undefined,
          messageTemplates: Object.entries(MESSAGE_TEMPLATES).filter(([, t]) => t.text).map(([type, t]) => ({ type, label: t.label, max: t.max })),
          platform: 'amazon',
        },
      },
    });

    // 1) sipariş oluşturma (bir kez)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş #${id} — ${total != null ? money(total, cur) : '—'} (${STATUS_LABEL[status] ?? status})`,
        ...itemLines,
        channel ? `Kargo: ${channel}` : '',
        `Teslimat: ${address || '—'}`,
        phone ? `Telefon: ${phone}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.upsertMessage({ remoteChatId, remoteId: `order-${id}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) durum olayı (durum başına bir mesaj; Unshipped yalnız Pending'den geçişte — ilk yoklamada gürültü olmasın)
    const event = STATUS_EVENT[status];
    if (event && (status !== 'Unshipped' || (prev && prevStatus === 'Pending'))) {
      const when = prev ? Math.max(updated, created + 1000) : updated > created ? updated : created + 1000;
      this.upsertMessage({ remoteChatId, remoteId: `status-${id}-${status}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: event, ts: when, status: 'sent' }, { live: live && status === 'Canceled' });
    }
    return true;
  }

  // ─────────── Gönderim / devredilen işlemler ───────────
  private isOrder(remoteChatId: string): boolean {
    return remoteChatId.startsWith('order-');
  }

  /** Sipariş sohbetine yazılan metin yerel not (Amazon'da serbest metin şablonsuz gönderilemez); köprü sohbeti köprüye gider */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (this.isOrder(remoteChatId)) {
      bus.log('warn', `Amazon ${remoteChatId}: serbest metin şablonsuz gönderilemez; sağ panelden şablonla gönder (yerel not olarak kaydedildi)`);
      const id = `note-${Date.now()}`;
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
      return { remoteId: id };
    }
    if (!this.bridge) throw new Error('Amazon mesajlaşma köprüsü kapalı (yapılandırmada messaging: false)');
    return this.bridge.sendText(remoteChatId, text);
  }

  /**
   * Platforma özel işlemler (sipariş sohbeti):
   *  - { kind: 'message', type: '<şablon>', text } → POST /messaging/v1/orders/{id}/messages/{şablon}?marketplaceIds=…
   *  - { kind: 'actions' } → GET /messaging/v1/orders/{id}?marketplaceIds=… ; kullanılabilir şablonlar meta.order.messagingActions'a yazılır
   */
  async action(remoteChatId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.isOrder(remoteChatId)) throw new Error('Bu işlem yalnız sipariş sohbetinde');
    const id = remoteChatId.slice('order-'.length);
    const mp = `marketplaceIds=${encodeURIComponent(this.marketplace.id)}`;
    const kind = String(payload.kind ?? '');
    if (kind === 'actions') {
      const { data } = await this.api('GET', `/messaging/v1/orders/${encodeURIComponent(id)}?${mp}`);
      const actions: string[] = (Array.isArray(data._embedded?.actions) ? data._embedded.actions : []).map((a: J) => String(a.name ?? a._links?.schema?.name ?? '')).filter(Boolean);
      const existing = this.store.getChat(chatId(this.account.id, remoteChatId));
      const order = (existing?.meta?.order as J | undefined) ?? { id };
      this.upsertChat({ remoteId: remoteChatId, name: existing?.name ?? `#${id}`, meta: { ...(existing?.meta ?? {}), order: { ...order, messagingActions: actions } } });
      return;
    }
    if (kind !== 'message') throw new Error('Bilinmeyen işlem');
    const type = String(payload.type ?? '');
    const tpl = MESSAGE_TEMPLATES[type];
    if (!tpl) throw new Error(`Bilinmeyen Amazon mesaj şablonu: ${type || '(boş)'}`);
    if (!tpl.text) throw new Error(`${tpl.label}: bu şablon yalnız ek (PDF) ister; metin gönderilemez`);
    const text = String(payload.text ?? '').trim();
    if (!text) throw new Error('Mesaj metni boş');
    if (tpl.max && text.length > tpl.max) throw new Error(`Mesaj en fazla ${tpl.max} karakter olabilir`);
    const { data } = await this.api('POST', `/messaging/v1/orders/${encodeURIComponent(id)}/messages/${type}?${mp}`, { text });
    if (Array.isArray(data.errors) && data.errors.length) throw new Error(`Amazon mesaj: ${String(data.errors[0].message ?? data.errors[0].code)}`);
    const now = Date.now();
    this.upsertMessage({ remoteChatId, remoteId: `msg-${type}-${now}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `✉️ [${tpl.label}] ${text}`, ts: now, status: 'sent' });
  }

  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (this.isOrder(remoteChatId) || !this.bridge) throw new Error('Bu sohbette dosya gönderme desteklenmiyor');
    return this.bridge.sendMedia(remoteChatId, file, caption);
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (this.isOrder(remoteChatId) || !this.bridge) return;
    await this.bridge.markRead(remoteChatId);
  }

  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (this.isOrder(remoteChatId) || !this.bridge) return;
    await this.bridge.loadHistory(remoteChatId, limit, before);
  }

  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    return this.bridge?.fetchMedia(url);
  }
}
