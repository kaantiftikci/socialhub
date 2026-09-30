import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { writeJsonAtomic } from './market-state.js';
import { chatId, type Participant } from '../model.js';
import type { Store } from '../store.js';

/**
 * Amazon: yalnız resmi Selling Partner API (SP-API).
 *  1) Siparişler — Kimlik: Login with Amazon (LWA) refresh token; erişim belirteci
 *     `POST https://api.amazon.com/auth/o2/token` ile (1 saat, 5 dk önce yenilenir, bellekte). İstekler
 *     `x-amz-access-token` başlığıyla; 2023 sonrası AWS SigV4 imzası GEREKMEZ. Uç bölgeye göre
 *     sellingpartnerapi-{eu|na|fe}.amazon.com.
 *       - Orders API v2026-01-01 (models/orders-api-model/orders_2026-01-01.json):
 *         GET /orders/2026-01-01/orders (searchOrders; createdAfter | lastUpdatedAfter — tam biri; marketplaceIds; maxResultsPerPage ≤100;
 *         sonraki sayfa `pagination.nextToken` → `paginationToken`; includedData=BUYER,RECIPIENT,PROCEEDS,FULFILLMENT,PACKAGES).
 *         Hız sınırı 0.0056/sn (patlama 20) → yoklama ≈3,3 dk. Kalemler (orderItems) yanıtın içinde gelir; ayrı istek yok.
 *         Yanıtta kalem yoksa GET /orders/2026-01-01/orders/{orderId} (getOrder, 0.5/sn, kalemler dahil).
 *         BUYER/RECIPIENT (PII) rolü yoksa 403 → bir kez PII'siz yeniden istenir ("Amazon alıcısı").
 *       - Eski v0 (GET /orders/v0/orders + /orderItems; 27 Mart 2027'de kapanıyor) yalnız yedek: v2026 ucu 404/403 verirse
 *         bir kez uyarı yazılır ve o çalışmada v0 kullanılır (getOrders 0.0167/sn → yoklama 2 dk).
 *     Her sipariş bir sohbet (`order-<siparişNo>`); durum değişimleri mesaj olarak akar. v2026 yanıtı v0 biçimine çevrilir
 *     (`fromOrderV2`) — durum imzaları ve sohbet meta'sı iki sürümde aynı kalır.
 *  2) Satıcıdan alıcıya şablonlu mesaj — Messaging API (/messaging/v1): `action(remoteChatId, { kind: 'message', type, text })`.
 *     Alıcıdan gelen mesajları OKUYAN resmi uç yoktur. Seller Central tarayıcı köprüsü KALDIRILDI: Amazon Business Solutions
 *     Agreement §19 ve Agent Policy (4 Mart 2026'dan beri) tarayıcı otomasyonunu/kazımayı yasaklıyor.
 *
 * Yapılandırma (token dosyası JSON): { clientId, clientSecret, refreshToken, marketplaceId?: 'A33AVAJ2PDY3EV' (Türkiye),
 *   region?: 'eu'|'na'|'fe' (varsayılan pazar yerinden türetilir) }. Eski `messaging` alanı yok sayılır.
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
/** v0 getOrders 0.0167/sn → 2 dk; v2026 searchOrders 0.0056/sn (≈178 sn'de bir jeton) → 200 sn (patlama payı tükenmesin) */
const POLL_MS_V0 = 120_000;
const POLL_MS_V2 = 200_000;
const FIRST_WINDOW_MS = 90 * 86_400_000;
const ORDERS_V2 = '/orders/2026-01-01/orders';
const INCLUDED_V2 = ['BUYER', 'RECIPIENT', 'PROCEEDS', 'FULFILLMENT', 'PACKAGES'];
const INCLUDED_V2_NO_PII = ['PROCEEDS', 'FULFILLMENT', 'PACKAGES'];
const ITEMS_FIRST_MAX = 30;
const USER_AGENT = 'Mivelo/1.0 (Language=TypeScript; Platform=Node)';

export interface AmazonConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId?: string;
  region?: 'eu' | 'na' | 'fe';
}

/** Pazar yeri tablosu: SP-API MarketplaceId → ülke, Amazon alan adı, Seller Central ana bilgisayarı, SP-API bölgesi (docs: marketplace-ids, seller-central-urls) */
export interface Marketplace {
  id: string;
  country: string;
  /** Mağaza alan adı (amazon.com.tr gibi); hesap etiketi ve sipariş bağlantısı için */
  domain: string;
  /** Seller Central ana bilgisayarı (sipariş bağlantısı) */
  host: string;
  region: 'eu' | 'na' | 'fe';
}

const EU = 'sellercentral-europe.amazon.com';
export const MARKETPLACES: Record<string, Marketplace> = {
  // Avrupa / Orta Doğu / Hindistan / Afrika (uç: sellingpartnerapi-eu)
  A33AVAJ2PDY3EV: { id: 'A33AVAJ2PDY3EV', country: 'Türkiye', domain: 'amazon.com.tr', host: 'sellercentral.amazon.com.tr', region: 'eu' },
  A1PA6795UKMFR9: { id: 'A1PA6795UKMFR9', country: 'Almanya', domain: 'amazon.de', host: EU, region: 'eu' },
  A1F83G8C2ARO7P: { id: 'A1F83G8C2ARO7P', country: 'Birleşik Krallık', domain: 'amazon.co.uk', host: EU, region: 'eu' },
  A13V1IB3VIYZZH: { id: 'A13V1IB3VIYZZH', country: 'Fransa', domain: 'amazon.fr', host: EU, region: 'eu' },
  APJ6JRA9NG5V4: { id: 'APJ6JRA9NG5V4', country: 'İtalya', domain: 'amazon.it', host: EU, region: 'eu' },
  A1RKKUPIHCS9HS: { id: 'A1RKKUPIHCS9HS', country: 'İspanya', domain: 'amazon.es', host: EU, region: 'eu' },
  A1805IZSGTT6HS: { id: 'A1805IZSGTT6HS', country: 'Hollanda', domain: 'amazon.nl', host: 'sellercentral.amazon.nl', region: 'eu' },
  A2NODRKZP88ZB9: { id: 'A2NODRKZP88ZB9', country: 'İsveç', domain: 'amazon.se', host: 'sellercentral.amazon.se', region: 'eu' },
  A1C3SOZRARQ6R3: { id: 'A1C3SOZRARQ6R3', country: 'Polonya', domain: 'amazon.pl', host: 'sellercentral.amazon.pl', region: 'eu' },
  AMEN7PMS3EDWL: { id: 'AMEN7PMS3EDWL', country: 'Belçika', domain: 'amazon.com.be', host: 'sellercentral.amazon.com.be', region: 'eu' },
  A28R8C7NBKEWEA: { id: 'A28R8C7NBKEWEA', country: 'İrlanda', domain: 'amazon.ie', host: 'sellercentral.amazon.ie', region: 'eu' },
  AE08WJ6YKNBMC: { id: 'AE08WJ6YKNBMC', country: 'Güney Afrika', domain: 'amazon.co.za', host: 'sellercentral.amazon.co.za', region: 'eu' },
  ARBP9OOSHTCHU: { id: 'ARBP9OOSHTCHU', country: 'Mısır', domain: 'amazon.eg', host: 'sellercentral.amazon.eg', region: 'eu' },
  A17E79C6D8DWNP: { id: 'A17E79C6D8DWNP', country: 'Suudi Arabistan', domain: 'amazon.sa', host: 'sellercentral.amazon.sa', region: 'eu' },
  A2VIGQ35RCS4UG: { id: 'A2VIGQ35RCS4UG', country: 'BAE', domain: 'amazon.ae', host: 'sellercentral.amazon.ae', region: 'eu' },
  A21TJRUUN4KGV: { id: 'A21TJRUUN4KGV', country: 'Hindistan', domain: 'amazon.in', host: 'sellercentral.amazon.in', region: 'eu' },
  // Kuzey Amerika / Brezilya (uç: sellingpartnerapi-na)
  ATVPDKIKX0DER: { id: 'ATVPDKIKX0DER', country: 'ABD', domain: 'amazon.com', host: 'sellercentral.amazon.com', region: 'na' },
  A2EUQ1WTGCTBG2: { id: 'A2EUQ1WTGCTBG2', country: 'Kanada', domain: 'amazon.ca', host: 'sellercentral.amazon.ca', region: 'na' },
  A1AM78C64UM0Y8: { id: 'A1AM78C64UM0Y8', country: 'Meksika', domain: 'amazon.com.mx', host: 'sellercentral.amazon.com.mx', region: 'na' },
  A2Q3Y263D00KWC: { id: 'A2Q3Y263D00KWC', country: 'Brezilya', domain: 'amazon.com.br', host: 'sellercentral.amazon.com.br', region: 'na' },
  // Uzak Doğu (uç: sellingpartnerapi-fe)
  A1VC38T7YXB528: { id: 'A1VC38T7YXB528', country: 'Japonya', domain: 'amazon.co.jp', host: 'sellercentral.amazon.co.jp', region: 'fe' },
  A39IBJ37TRP1C6: { id: 'A39IBJ37TRP1C6', country: 'Avustralya', domain: 'amazon.com.au', host: 'sellercentral.amazon.com.au', region: 'fe' },
  A19VAU5U5O7RUS: { id: 'A19VAU5U5O7RUS', country: 'Singapur', domain: 'amazon.sg', host: 'sellercentral.amazon.sg', region: 'fe' },
};

export const DEFAULT_MARKETPLACE = 'A33AVAJ2PDY3EV'; // Türkiye

/** Pazar yeri kaydı; bilinmeyen kimlikte Türkiye */
export function marketplaceOf(id?: string): Marketplace {
  return MARKETPLACES[(id ?? '').trim()] ?? MARKETPLACES[DEFAULT_MARKETPLACE];
}

/** Yapılandırma metnini çöz; pazar yeri ve bölge türetilir */
export function parseAmazonConfig(config: string): { clientId: string; clientSecret: string; refreshToken: string; marketplace: Marketplace; region: 'eu' | 'na' | 'fe' } {
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
  };
}

/** Kimlik reddi (LWA invalid_grant, 401 yenileme sonrası, 403): yoklama durdurulur, durum error */
class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
/** Diğer HTTP hataları (404 vb.): durum kodu yedeğe geçiş kararı için taşınır */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
/** v2026 Orders API bu uygulama/hesap için yok (404/403): v0'a dönülür */
class V2Unavailable extends Error {}
const statusOf = (e: unknown): number | undefined => (e instanceof AuthError || e instanceof ApiError ? e.status : undefined);

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
  digitalAccessKey: { label: 'Dijital erişim anahtarı', text: true, max: 400 }, // CreateDigitalAccessKeyRequest.text maxLength 400
  unexpectedProblem: { label: 'Beklenmeyen sorun', text: true, max: 2000 },
  legalDisclosure: { label: 'Yasal bildirim (yalnız ek)', text: false },
  warranty: { label: 'Garanti (yalnız ek)', text: false },
  invoice: { label: 'Fatura gönder (yalnız ek)', text: false },
};

/** v2026 FulfillmentStatus → v0 OrderStatus adı (durum imzaları ve etiketler sürümler arasında aynı kalsın) */
const V2_STATUS: Record<string, string> = {
  PENDING_AVAILABILITY: 'PendingAvailability',
  PENDING: 'Pending',
  UNSHIPPED: 'Unshipped',
  PARTIALLY_SHIPPED: 'PartiallyShipped',
  SHIPPED: 'Shipped',
  CANCELLED: 'Canceled',
  UNFULFILLABLE: 'Unfulfillable',
};
/** Paket durumu (v2026 PackageStatus.status) → Türkçe */
const PACKAGE_LABEL: Record<string, string> = {
  PENDING: 'hazırlanıyor',
  IN_TRANSIT: 'yolda',
  SHIPPED: 'kargolandı',
  DELIVERED: 'teslim edildi',
  CANCELLED: 'iptal edildi',
  UNDELIVERABLE: 'teslim edilemedi',
};

/**
 * getMessagingActionsForOrder yanıtından kullanılabilir şablon adları (messaging.json): `_embedded.actions[].payload.name`,
 * yoksa eylemin `_links.self|schema.name`'i, ayrıca `_links.actions[].name`. Sıra korunur, tekrarsız.
 */
export function messagingActionNames(data: J): string[] {
  const out = new Set<string>();
  for (const a of Array.isArray(data?._embedded?.actions) ? (data._embedded.actions as J[]) : []) {
    const n = a?.payload?.name ?? a?._links?.self?.name ?? a?._links?.schema?.name;
    if (n) out.add(String(n));
  }
  for (const l of Array.isArray(data?._links?.actions) ? (data._links.actions as J[]) : []) if (l?.name) out.add(String(l.name));
  return [...out];
}

const fixed2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Orders API v2026-01-01 sipariş nesnesi → v0 biçimi (AmazonOrderId, OrderStatus, OrderTotal, BuyerInfo, ShippingAddress…) +
 * v0 biçiminde kalemler (Title, ASIN, SellerSKU, QuantityOrdered, ItemPrice = satır toplamı). `items` undefined: yanıtta kalem yok.
 * Tüm paketler DELIVERED ise durum 'Delivered' (v2026'da sipariş düzeyinde teslim durumu yok).
 */
export function fromOrderV2(o: J): { order: J; items?: J[] } {
  const f: J = o.fulfillment ?? {};
  const list: J[] | undefined = Array.isArray(o.orderItems) ? o.orderItems : undefined;
  const pkgs: J[] = Array.isArray(o.packages) ? o.packages : [];
  let status = V2_STATUS[String(f.fulfillmentStatus ?? '')] ?? (f.fulfillmentStatus ? String(f.fulfillmentStatus) : 'Pending');
  if (status === 'Shipped' && pkgs.length && pkgs.every((p) => p.packageStatus?.status === 'DELIVERED')) status = 'Delivered';
  const sum = (k: 'quantityFulfilled' | 'quantityUnfulfilled'): number | undefined =>
    list?.some((i) => i.fulfillment?.[k] != null) ? list.reduce((s, i) => s + (Number(i.fulfillment?.[k]) || 0), 0) : undefined;
  const addr: J = o.recipient?.deliveryAddress ?? {};
  const total: J | undefined = o.proceeds?.grandTotal;
  const programs: string[] = Array.isArray(o.programs) ? o.programs : [];
  const order: J = {
    AmazonOrderId: o.orderId,
    PurchaseDate: o.createdTime,
    LastUpdateDate: o.lastUpdatedTime,
    OrderStatus: status,
    FulfillmentChannel: f.fulfilledBy === 'AMAZON' ? 'AFN' : f.fulfilledBy === 'MERCHANT' ? 'MFN' : undefined,
    SalesChannel: o.salesChannel?.marketplaceName ?? o.salesChannel?.channelName,
    MarketplaceId: o.salesChannel?.marketplaceId,
    // v2026'da sipariş toplamı satıcı gelirinin toplamı (proceeds.grandTotal)
    OrderTotal: total ? { CurrencyCode: total.currencyCode, Amount: total.amount } : undefined,
    NumberOfItemsShipped: sum('quantityFulfilled'),
    NumberOfItemsUnshipped: sum('quantityUnfulfilled'),
    BuyerInfo: o.buyer ? { BuyerName: o.buyer.buyerName, BuyerEmail: o.buyer.buyerEmail } : undefined,
    ShippingAddress: o.recipient?.deliveryAddress
      ? {
          Name: addr.name,
          Phone: addr.phone,
          AddressLine1: addr.addressLine1,
          AddressLine2: addr.addressLine2,
          AddressLine3: addr.addressLine3,
          District: addr.districtOrCounty,
          City: addr.city,
          StateOrRegion: addr.stateOrRegion,
          PostalCode: addr.postalCode,
          CountryCode: addr.countryCode,
        }
      : undefined,
    ShipmentServiceLevelCategory: f.fulfillmentServiceLevel,
    IsPrime: programs.includes('PRIME'),
    IsBusinessOrder: programs.includes('AMAZON_BUSINESS'),
    LatestShipDate: f.shipByWindow?.latestDateTime,
    EarliestDeliveryDate: f.deliverByWindow?.earliestDateTime,
    LatestDeliveryDate: f.deliverByWindow?.latestDateTime,
    Packages: pkgs.map((p) => ({ status: p.packageStatus?.status, carrier: p.carrier, trackingNumber: p.trackingNumber, shipTime: p.shipTime })),
  };
  const items = list?.map((i) => {
    const qty = Number(i.quantityOrdered ?? 1) || 1;
    const itemRow = (Array.isArray(i.proceeds?.breakdowns) ? i.proceeds.breakdowns : []).find((b: J) => b.type === 'ITEM')?.subtotal as J | undefined;
    const unit: J | undefined = i.product?.price?.unitPrice;
    const price: J | undefined = itemRow ?? (unit?.amount != null ? { amount: fixed2(Number(unit.amount) * qty), currencyCode: unit.currencyCode } : i.proceeds?.proceedsTotal);
    return {
      OrderItemId: i.orderItemId,
      Title: i.product?.title,
      ASIN: i.product?.asin,
      SellerSKU: i.product?.sellerSku,
      QuantityOrdered: qty,
      ItemPrice: price ? { CurrencyCode: price.currencyCode, Amount: price.amount } : undefined,
    };
  });
  return { order, items };
}

export class AmazonConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON; varsayılan açık, ordersOff:true kapatır) */
  private ordersOn = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly marketplace: Marketplace;
  private readonly endpoint: string;
  /** Eski yapılandırmada Seller Central köprüsü istenmişti (artık yok; bir kez bilgi yazılır) */
  private readonly legacyMessaging: boolean;
  /** Kullanılan Orders API sürümü: v2026-01-01; uç 404/403 verirse bu çalışmada v0 */
  private ordersApi: 'v2026' | 'v0' = 'v2026';
  /** v2026: BUYER/RECIPIENT (PII) istemek 403 verdi → PII'siz iste */
  private noPii = false;
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
    try {
      this.legacyMessaging = (JSON.parse(config || '{}') as { messaging?: unknown }).messaging === true;
    } catch {
      this.legacyMessaging = false;
    }
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
    if (r.status === 403) throw new AuthError(`Amazon SP-API yetkisi yok (403): ${errMsg}`, 403);
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
    if (!r.ok) throw new ApiError(`Amazon ${r.status} ${p.split('?')[0]}: ${errMsg}`, r.status);
    return { data, headers: r.headers };
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.clientId || !this.clientSecret || !this.refreshToken) return this.setStatus('error', 'Amazon LWA Client ID / Client Secret / Refresh Token girilmedi');
    if (this.legacyMessaging) bus.log('info', 'Amazon: Seller Central mesaj köprüsü kaldırıldı (Amazon ajan politikası); yalnız siparişler ve şablonlu mesajlar');
    this.setStatus('connecting');
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
      this.setStatus('connected', this.marketplace.country);
      if (this.timer) clearInterval(this.timer);
      // poll AuthError'u yeniden fırlatır (durumu zaten 'error' yapıp zamanlayıcıyı durdurur): burada yutulur, söz reddi yakalanmamış kalmasın
      // aralık ilk yoklamada seçilen sürümün hız sınırına göre
      this.timer = setInterval(() => void this.poll(false).catch(() => undefined), this.ordersApi === 'v0' ? POLL_MS_V0 : POLL_MS_V2);
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.setStatus('disconnected');
  }

  // ─────────── Sipariş yoklama ───────────
  /** İlk yoklama (ya da imleç yoksa) oluşturma zamanına göre 90 gün; sonra son yoklama − 5 dk'dan beri değişenler */
  private window(first: boolean): { created?: string; updated?: string } {
    if (first || !this.since) return { created: new Date(Date.now() - FIRST_WINDOW_MS).toISOString() };
    return { updated: new Date((Date.parse(this.since) || Date.now()) - 5 * 60_000).toISOString() };
  }

  // v0 (yedek) — CreatedAfter ve LastUpdatedAfter birlikte verilemez
  private ordersQueryV0(first: boolean): string {
    const q = new URLSearchParams({ MarketplaceIds: this.marketplace.id, MaxResultsPerPage: '100' });
    const w = this.window(first);
    if (w.created) q.set('CreatedAfter', w.created);
    else q.set('LastUpdatedAfter', w.updated!);
    return `/orders/v0/orders?${q.toString()}`;
  }

  private async searchV0(first: boolean): Promise<J[]> {
    const orders: J[] = [];
    let url: string | undefined = this.ordersQueryV0(first);
    for (let page = 0; url && page < 10; page++) {
      const { data } = await this.api('GET', url);
      const list: J[] = Array.isArray(data.payload?.Orders) ? data.payload.Orders : [];
      orders.push(...list);
      const next: string | undefined = data.payload?.NextToken || undefined;
      url = next && list.length ? `/orders/v0/orders?MarketplaceIds=${encodeURIComponent(this.marketplace.id)}&NextToken=${encodeURIComponent(next)}` : undefined;
    }
    return orders;
  }

  private async fetchItemsV0(orderId: string): Promise<J[]> {
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

  private includedV2(): string {
    return (this.noPii ? INCLUDED_V2_NO_PII : INCLUDED_V2).join(',');
  }

  /**
   * v2026 searchOrders: aynı süzgeç + paginationToken ile sayfalar (≤10). İlk sayfada 403 → önce PII'siz bir kez; yine 403
   * ya da 404 → V2Unavailable (çağıran v0'a döner).
   */
  private async searchV2(first: boolean): Promise<Array<{ order: J; items?: J[] }>> {
    const w = this.window(first);
    const out: Array<{ order: J; items?: J[] }> = [];
    let token: string | undefined;
    for (let page = 0; page < 10; ) {
      const q = new URLSearchParams({ marketplaceIds: this.marketplace.id, maxResultsPerPage: '100' });
      if (w.created) q.set('createdAfter', w.created);
      else q.set('lastUpdatedAfter', w.updated!);
      q.set('includedData', this.includedV2());
      if (token) q.set('paginationToken', token);
      let data: J;
      try {
        ({ data } = await this.api('GET', `${ORDERS_V2}?${q.toString()}`));
      } catch (e) {
        const st = statusOf(e);
        if (st === 403 && !this.noPii) {
          this.noPii = true;
          bus.log('info', 'Amazon: alıcı/teslimat bilgisi (PII) rolü yok; siparişler alıcı bilgisi olmadan alınıyor');
          continue; // aynı sayfa PII'siz
        }
        if (page === 0 && !token && (st === 403 || st === 404)) throw new V2Unavailable((e as Error).message);
        throw e;
      }
      const list: J[] = Array.isArray(data.orders) ? data.orders : [];
      for (const o of list) out.push(fromOrderV2(o));
      token = data.pagination?.nextToken || undefined;
      page++;
      if (!token || !list.length) break;
    }
    return out;
  }

  /** v2026 getOrder: kalemler dahil tek sipariş (arama yanıtında kalem yoksa) */
  private async getOrderV2(orderId: string): Promise<J[] | undefined> {
    const { data } = await this.api('GET', `${ORDERS_V2}/${encodeURIComponent(orderId)}?includedData=${encodeURIComponent(this.includedV2())}`);
    return data.order ? fromOrderV2(data.order).items : undefined;
  }

  /** Sürüme göre siparişleri (v0 biçiminde) ve varsa kalemlerini getir */
  private async fetchOrders(first: boolean): Promise<Array<{ order: J; items?: J[] }>> {
    if (this.ordersApi === 'v2026') {
      try {
        return await this.searchV2(first);
      } catch (e) {
        if (!(e instanceof V2Unavailable)) throw e;
        this.ordersApi = 'v0';
        bus.log('warn', `Amazon Orders API 2026-01-01 kullanılamadı (${e.message.slice(0, 120)}); eski v0 uçlarına dönülüyor (v0 27 Mart 2027'de kapanacak — uygulamanın Orders rolünü denetle)`);
      }
    }
    return (await this.searchV0(first)).map((order) => ({ order }));
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    if (!this.ordersOn) {
      this.polling = false;
      return; // sipariş sohbetleri kapalı
    }
    const startedAt = new Date().toISOString();
    try {
      const orders = await this.fetchOrders(first);
      // eskiden yeniye: sohbet sırası ve "canlı" bildirimler doğru olsun
      orders.sort((a, b) => (Date.parse(a.order.PurchaseDate ?? '') || 0) - (Date.parse(b.order.PurchaseDate ?? '') || 0));
      // ayrı kalem isteği (v0 getOrderItems 0.5/sn; v2026 yalnız yanıtta kalem yoksa getOrder): ilk yoklamada en yeni 30, sonra yalnız yeniler
      const fresh = orders.filter((x) => !x.items && !this.seen.has(String(x.order.AmazonOrderId)));
      const withItems = new Set((first ? fresh.slice(-ITEMS_FIRST_MAX) : fresh).map((x) => String(x.order.AmazonOrderId)));
      let changed = 0;
      for (const { order: o, items: got } of orders) {
        const id = String(o.AmazonOrderId ?? '');
        if (!id) continue;
        let items: J[] | undefined = got;
        if (!items && withItems.has(id)) {
          items = await (this.ordersApi === 'v0' ? this.fetchItemsV0(id) : this.getOrderV2(id)).catch((e) => {
            if (e instanceof AuthError) throw e;
            bus.log('warn', `Amazon kalemler ${id}: ${(e as Error).message}`);
            return undefined;
          });
        }
        if (this.ingest(o, items, !first)) changed++;
      }
      if (changed) bus.log('info', `Amazon: ${changed} sipariş güncellendi`);
      this.since = startedAt;
      // durum dosyası yalnız değişince (dosyadaki eski since yalnız daha geniş aralık ister, kayıp olmaz)
      if (changed || first) this.saveState();
    } catch (e) {
      if (e instanceof AuthError) {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (!first) this.setStatus('error', e.message);
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
      writeJsonAtomic(this.stateFile, { seen, since: this.since });
    } catch {
      /* yazılamadı */
    }
  }

  /** Sipariş → sohbet + olay mesajları. Değişiklik varsa true döner. `items` verilmezse depodaki kalemler korunur. */
  private ingest(o: J, items: J[] | undefined, live: boolean): boolean {
    const id = String(o.AmazonOrderId);
    const remoteChatId = `order-${id}`;
    const status: string = o.OrderStatus ?? 'Pending';
    const pkgs: J[] = Array.isArray(o.Packages) ? o.Packages : [];
    const base = [status, o.NumberOfItemsShipped ?? 0, o.NumberOfItemsUnshipped ?? 0, o.FulfillmentChannel ?? ''];
    // paket/takip bilgisi (v2026) yalnız varsa imzaya girer: v0 imzaları eskisiyle aynı kalır
    const sig = JSON.stringify(pkgs.length ? [...base, pkgs.map((p) => [p.status ?? '', p.trackingNumber ?? ''])] : base);
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
          fulfillments: pkgs.length
            ? pkgs.map((p) => ({ status: PACKAGE_LABEL[p.status] ?? p.status ?? STATUS_LABEL[status] ?? status, company: p.carrier ?? undefined, trackingNumber: p.trackingNumber ?? undefined, date: p.shipTime ?? o.LastUpdateDate }))
            : [{ status: channel ? `${STATUS_LABEL[status] ?? status} · ${channel}` : STATUS_LABEL[status] ?? status, company: o.FulfillmentChannel ?? undefined, date: o.LastUpdateDate }],
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

  /** Sipariş sohbetine yazılan metin yerel not (Amazon'da serbest metin şablonsuz gönderilemez; alıcı mesajı okuma/yanıt ucu yok) */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (!this.isOrder(remoteChatId)) throw new Error('Amazon alıcı mesajları desteklenmiyor (resmi API yok); sipariş sohbetinden şablonla gönder');
    bus.log('warn', `Amazon ${remoteChatId}: serbest metin şablonsuz gönderilemez; sağ panelden şablonla gönder (yerel not olarak kaydedildi)`);
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
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
      const actions = messagingActionNames(data);
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
}
