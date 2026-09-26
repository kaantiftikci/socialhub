import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay, retryAfterSec } from './poll-timer.js';
import { BrowserConnector } from './browser/bridge.js';
import { etsy as etsyStrategy } from './browser/etsy.js';
import { OAUTH_CALLBACK, waitOAuth, withAuthWindow } from './mail.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { AccountStatus, Participant } from '../model.js';

/**
 * Etsy: iki parça tek hesapta.
 *  1) Siparişler — resmi Open API v3 (OAuth2 PKCE, `x-api-key` = uygulama keystring'i). Her sipariş (receipt) bir
 *     sohbet; sipariş/ödeme/kargo olayları mesaj olarak akar. Sohbete yazılan metin yerel not olur (API'de alıcıya
 *     mesaj ucu yok).
 *  2) Mesajlar — Etsy Conversations API'de olmadığı için tarayıcı köprüsü (`browser/etsy.ts`, etsy.com/messages DOM'u).
 *
 * OAuth: kullanıcı etsy.com/developers'da uygulama açar, geri dönüş adresi olarak OAUTH_CALLBACK'i
 * (http://127.0.0.1:7788/oauth/callback) kaydeder; keystring Bağlan formundan gelir. Token'lar
 * `sessions/<hesap>/token` dosyasında (config JSON'ı güncellenerek, 0600) tutulur.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const API = 'https://api.etsy.com/v3/application';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const SCOPES = 'transactions_r shops_r listings_r email_r';

export interface EtsyConfig {
  keystring: string;
  sharedSecret?: string;
  shopId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** ms; erişim belirtecinin bitişi (5 dk öncesinden yenilenir) */
  expiresAt?: number;
}

interface EtsyMoney {
  amount?: number;
  divisor?: number;
  currency_code?: string;
}

/** Bir sipariş için "son görülen" durum imzası (değişince olay mesajı üretilir) */
interface Sig {
  status?: string;
  paid?: boolean;
  shipped?: boolean;
  ships: Array<[string, string, number]>; // [takip kodu, kargo, bildirim zamanı (s)]
  refunds: Array<[string, number]>; // [durum/not, tutar]
}

const SYMBOL: Record<string, string> = { TRY: '₺', USD: '$', EUR: '€', GBP: '£' };
export const money = (m: EtsyMoney | undefined): string => {
  if (!m || typeof m.amount !== 'number') return '—';
  const v = (m.amount / (m.divisor || 100)).toFixed(2).replace('.', ',');
  const cur = m.currency_code ?? '';
  return `${v} ${SYMBOL[cur] ?? cur}`.trim();
};
const sec = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v * 1000 : undefined);

/** PKCE çifti: 32 baytlık rastgele verifier (base64url) ve S256 challenge'ı */
export function pkcePair(verifier = base64url(randomBytes(32))): { verifier: string; challenge: string } {
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}
function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Etsy izin sayfası adresi */
export function authorizeUrl(keystring: string, state: string, challenge: string, callback = OAUTH_CALLBACK): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: keystring, redirect_uri: callback, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${AUTH_URL}?${q.toString()}`;
}

/**
 * Köprünün durum bildirimlerini bileşik connector'a yönlendiren alt sınıf. BrowserConnector `setStatus`'u aynı
 * account nesnesi üzerinde çağırır ve API tarafının durumunu ezerdi; burada araya girilip iki durum tek yerde
 * (EtsyConnector.publish) birleştirilir. Depo/olay yayını yalnızca bileşik tarafta yapılır.
 */
class EtsyBridge extends BrowserConnector {
  constructor(account: BaseConnector['account'], store: BaseConnector['store'], private readonly onStatus: (s: AccountStatus, detail?: string) => void) {
    super(account, store, etsyStrategy, 30_000);
  }
  protected override setStatus(status: AccountStatus, detail?: string): void {
    this.onStatus(status, detail);
  }
}

export class EtsyConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private cfg: EtsyConfig;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private seen = new Map<string, string>();
  private stateFile: string;
  private tokenFile: string;
  private bridge?: EtsyBridge;
  /** alt bileşen durumları (publish() birleştirir) */
  private apiStatus: AccountStatus = 'disconnected';
  private apiDetail?: string;
  private bridgeStatus: AccountStatus = 'disconnected';
  private bridgeDetail?: string;
  /** testlerde/isteğe bağlı: giriş penceresi yerine kullanılacak akış */
  protected authWindow: <T>(url: string, done: Promise<T>) => Promise<T> = withAuthWindow;

  /**
   * @param config Bağlan formunun yazdığı JSON (EtsyConfig); keystring zorunlu.
   * @param messaging false: tarayıcı köprüsü (Etsy Mesajları) başlatılmaz — yalnızca siparişler (testler de bunu kullanır).
   */
  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string, private readonly messaging = true) {
    super(account, store);
    let cfg: EtsyConfig = { keystring: '' };
    try {
      const parsed = JSON.parse(config || '{}') as Partial<EtsyConfig> | string;
      cfg = typeof parsed === 'string' ? { keystring: parsed } : { keystring: '', ...parsed };
    } catch {
      cfg = { keystring: (config ?? '').trim() }; // düz metin: yalnızca keystring
    }
    this.cfg = cfg;
    this.ordersOn = ordersFlag(config);
    const dir = sessionDir(account.id);
    this.stateFile = path.join(dir, 'etsy-state.json');
    this.tokenFile = path.join(dir, 'token');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(st)) this.seen.set(k, v);
    } catch {
      /* ilk çalıştırma */
    }
  }

  // ───────────── durum birleştirme ─────────────

  /** API + köprü durumlarını tek account.status'a indir ve yayınla */
  private publish(): void {
    if (this.stopping) return;
    const a = this.apiStatus;
    const b = this.bridgeStatus;
    const bridgeNote = !this.messaging
      ? undefined
      : b === 'pairing'
        ? 'Mesajlar için Etsy\'ye giriş gerekli (Yeniden bağlan)'
        : b === 'error' || b === 'disconnected'
          ? this.bridgeDetail
            ? `Mesajlar: ${this.bridgeDetail}`
            : undefined
          : undefined;
    if (a === 'connected') return super.setStatus('connected', [this.apiDetail, bridgeNote].filter(Boolean).join(' · ') || undefined);
    if (a === 'error' || a === 'pairing') return super.setStatus(a, [this.apiDetail, bridgeNote].filter(Boolean).join(' · ') || undefined);
    if (a === 'connecting') return super.setStatus('connecting', this.apiDetail);
    // API kapalı (disconnected): köprü ne diyorsa o
    super.setStatus(b, this.bridgeDetail);
  }

  private setApi(status: AccountStatus, detail?: string): void {
    this.apiStatus = status;
    this.apiDetail = detail;
    this.publish();
  }

  private setBridge(status: AccountStatus, detail?: string): void {
    this.bridgeStatus = status;
    this.bridgeDetail = detail;
    this.publish();
  }

  // ───────────── OAuth / belirteç ─────────────

  private saveTokens(): void {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify(this.cfg), { mode: 0o600 });
      fs.chmodSync(this.tokenFile, 0o600);
    } catch (e) {
      bus.log('warn', `Etsy: belirteç dosyası yazılamadı: ${(e as Error).message}`);
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<void> {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Etsy belirteç ${r.status}: ${text.slice(0, 160)}`);
    const t = JSON.parse(text) as J;
    if (!t.access_token) throw new Error('Etsy belirteç yanıtında access_token yok');
    this.cfg.accessToken = t.access_token;
    if (t.refresh_token) this.cfg.refreshToken = t.refresh_token;
    this.cfg.expiresAt = Date.now() + (Number(t.expires_in) || 3600) * 1000;
    this.saveTokens();
  }

  /** Görünür pencerede Etsy izin sayfası; /oauth/callback'e gelen code PKCE ile belirtece çevrilir */
  private async authorize(): Promise<void> {
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(16));
    const url = authorizeUrl(this.cfg.keystring, state, challenge);
    this.setApi('pairing', `Açılan pencerede Etsy'ye giriş yapıp uygulamaya izin ver (geri dönüş adresi ${OAUTH_CALLBACK} uygulamada kayıtlı olmalı)`);
    const code = await this.authWindow(url, waitOAuth(state));
    await this.tokenRequest({ grant_type: 'authorization_code', client_id: this.cfg.keystring, redirect_uri: OAUTH_CALLBACK, code, code_verifier: verifier });
  }

  private async refresh(): Promise<void> {
    if (!this.cfg.refreshToken) throw new Error('Etsy yenileme belirteci yok — Yeniden bağlan');
    await this.tokenRequest({ grant_type: 'refresh_token', client_id: this.cfg.keystring, refresh_token: this.cfg.refreshToken });
  }

  /** Erişim belirteci yoksa false (çağıran karar verir); süresi dolmak üzereyse yeniler */
  private async ensureToken(): Promise<boolean> {
    if (!this.cfg.accessToken) return false;
    if (this.cfg.expiresAt && this.cfg.expiresAt - 5 * 60_000 < Date.now()) await this.refresh();
    return true;
  }

  private async api(p: string, retry = true): Promise<J> {
    await this.ensureToken();
    const r = await fetch(API + p, {
      headers: { 'x-api-key': this.cfg.keystring, authorization: `Bearer ${this.cfg.accessToken ?? ''}`, accept: 'application/json' },
    });
    const text = await r.text();
    if (r.status === 401) {
      if (retry && this.cfg.refreshToken) {
        await this.refresh();
        return this.api(p, false);
      }
      throw new Error('Etsy yetkisi düştü (401) — kanala sağ tıklayıp "Yeniden bağlan" de');
    }
    if (r.status === 429) this.timer?.backoff(retryAfterSec(r.headers.get('retry-after')));
    if (r.status === 429) throw new Error(`Etsy istek limiti; ${r.headers.get('retry-after') ?? '60'} sn sonra`);
    if (!r.ok) throw new Error(`Etsy ${r.status} ${p}: ${text.slice(0, 160)}`);
    return text ? (JSON.parse(text) as J) : {};
  }

  // ───────────── yaşam döngüsü ─────────────

  async start(opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    const interactive = opts.interactive !== false;
    if (!this.cfg.keystring) return this.setApi('error', 'Etsy uygulama anahtarı (keystring) girilmedi');
    this.setApi('connecting');
    try {
      if (!(await this.ensureToken())) {
        if (!interactive) {
          this.setApi('pairing', 'Etsy izni gerekli — kanala sağ tıklayıp "Yeniden bağlan" de');
          this.startBridge(opts);
          return;
        }
        await this.authorize();
      }
      // dükkân kimliği ve adı
      if (!this.cfg.shopId) {
        const me = await this.api('/users/me');
        if (me.shop_id) this.cfg.shopId = String(me.shop_id);
        else {
          // users/me shop_id vermezse dükkânlar listesinden
          const shops = await this.api(`/users/${encodeURIComponent(String(me.user_id ?? ''))}/shops`).catch(() => ({}) as J);
          const first = Array.isArray(shops.results) ? shops.results[0] : shops.shop_id ? shops : undefined;
          if (first?.shop_id) this.cfg.shopId = String(first.shop_id);
        }
        if (!this.cfg.shopId) throw new Error('Bu Etsy hesabında dükkân bulunamadı (shop_id)');
        this.saveTokens();
      }
      const shop = await this.api(`/shops/${encodeURIComponent(this.cfg.shopId)}`).catch(() => ({}) as J);
      if (shop.shop_name) this.account.label = `Etsy · ${shop.shop_name}`;
      await this.poll(true);
      this.setApi('connected');
      this.timer?.stop();
      this.timer?.stop();
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay(60_000, 90_000)).start();
    } catch (e) {
      this.setApi('error', (e as Error).message.split('\n')[0]);
    }
    this.startBridge(opts);
  }

  /** Mesaj köprüsünü arka planda başlat (etkileşimli girişte kullanıcıyı bekler; bileşik start'ı bloklamaz) */
  private startBridge(opts: StartOptions): void {
    if (!this.messaging || this.stopping) return;
    this.bridge ??= new EtsyBridge(this.account, this.store, (s, d) => this.setBridge(s, d));
    void this.bridge.start(opts).catch((e) => this.setBridge('error', (e as Error).message.split('\n')[0]));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.stop();
    this.timer = undefined;
    await this.bridge?.stop().catch(() => undefined);
    this.apiStatus = 'disconnected';
    this.bridgeStatus = 'disconnected';
    super.setStatus('disconnected');
  }

  // ───────────── siparişler ─────────────

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    if (!this.ordersOn) {
      this.polling = false;
      return; // sipariş sohbetleri kapalı: yalnız mesajlaşma köprüsü çalışır
    }
    try {
      const receipts: J[] = [];
      const pages = first ? 3 : 1;
      for (let i = 0; i < pages; i++) {
        const data = await this.api(`/shops/${encodeURIComponent(this.cfg.shopId ?? '')}/receipts?limit=50&offset=${i * 50}&sort_on=created&sort_order=desc`);
        const list: J[] = Array.isArray(data.results) ? data.results : [];
        receipts.push(...list);
        if (list.length < 50 || (typeof data.count === 'number' && receipts.length >= data.count)) break;
      }
      let changed = 0;
      for (const r of receipts.reverse()) if (this.ingest(r, !first)) changed++;
      if (changed) bus.log('info', `Etsy: ${changed} sipariş güncellendi`);
      this.saveState();
    } catch (e) {
      bus.log('warn', `Etsy yoklama: ${(e as Error).message}`);
      if (first) throw e;
      // canlı yoklamada yetki düşmüşse durumu göster (sonraki yoklama yeniden dener)
      if (/401/.test((e as Error).message)) this.setApi('error', (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private saveState(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of [...this.seen.entries()].slice(-3000)) obj[k] = v;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(obj));
    } catch {
      /* yazılamadı */
    }
  }

  /** Receipt → sohbet + olay mesajları. Değişiklik varsa true. */
  private ingest(o: J, live: boolean): boolean {
    const rid = String(o.receipt_id ?? o.id ?? '');
    if (!rid) return false;
    const remoteId = `order-${rid}`;
    const ships: J[] = Array.isArray(o.shipments) ? o.shipments : [];
    const refunds: J[] = Array.isArray(o.refunds) ? o.refunds : [];
    const sig: Sig = {
      status: o.status,
      paid: !!o.is_paid,
      shipped: !!o.is_shipped,
      ships: ships.map((s) => [String(s.tracking_code ?? ''), String(s.carrier_name ?? ''), Number(s.shipment_notification_timestamp ?? 0)]),
      refunds: refunds.map((r) => [String(r.status ?? r.note ?? ''), Number(r.amount?.amount ?? 0)]),
    };
    const sigStr = JSON.stringify(sig);
    const prevStr = this.seen.get(rid);
    if (prevStr === sigStr) return false;
    let prev: Sig | undefined;
    try {
      prev = prevStr ? (JSON.parse(prevStr) as Sig) : undefined;
    } catch {
      prev = undefined;
    }
    this.seen.set(rid, sigStr);

    const buyer = String(o.name ?? o.buyer_email ?? 'Alıcı').trim() || 'Alıcı';
    const email = typeof o.buyer_email === 'string' ? o.buyer_email : undefined;
    const created = sec(o.create_timestamp ?? o.created_timestamp) ?? Date.now();
    const cur = o.grandtotal?.currency_code ?? o.total_price?.currency_code ?? 'USD';
    const tx: J[] = Array.isArray(o.transactions) ? o.transactions : [];
    const itemLines = tx.map((t) => {
      const vars = (Array.isArray(t.variations) ? t.variations : []).map((v: J) => v.formatted_value).filter(Boolean).join(' / ');
      const lineTotal: EtsyMoney | undefined = t.price ? { amount: (t.price.amount ?? 0) * (t.quantity ?? 1), divisor: t.price.divisor, currency_code: t.price.currency_code } : undefined;
      return `• ${t.quantity ?? 1} × ${t.title ?? 'Ürün'}${vars ? ` (${vars})` : ''} — ${money(lineTotal)}`;
    });
    const address = String(o.formatted_address ?? [o.first_line, o.second_line, o.city, o.state, o.zip, o.country_iso].filter(Boolean).join(', ')).replace(/\n+/g, ', ');
    const participant: Participant = { id: email || String(o.buyer_user_id ?? rid), name: buyer, handle: email };
    const open = !['completed', 'canceled', 'fully refunded'].includes(String(o.status ?? '').toLowerCase()) && !o.is_shipped;
    this.upsertChat({
      remoteId,
      name: `#${rid} · ${buyer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: email,
      // DOĞRULANMADI: satıcı panelindeki sipariş sayfası adresi
      link: `https://www.etsy.com/your/orders/sold?order_id=${encodeURIComponent(rid)}`,
      participants: [participant],
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id: rid,
          status: o.status,
          paymentStatus: o.is_paid ? 'paid' : 'pending',
          dateCreated: new Date(created).toISOString(),
          currency: cur,
          totals: { subtotal: money(o.subtotal), shipping: money(o.total_shipping_cost), tax: money(o.total_tax_cost), discount: money(o.discount_amt), total: money(o.grandtotal ?? o.total_price) },
          note: o.message_from_buyer || undefined,
          giftMessage: o.is_gift ? o.gift_message || undefined : undefined,
          items: tx.map((t) => ({ title: t.title, quantity: t.quantity, total: money(t.price ? { amount: (t.price.amount ?? 0) * (t.quantity ?? 1), divisor: t.price.divisor, currency_code: t.price.currency_code } : undefined), sku: t.sku || undefined, type: t.is_digital ? 'digital' : 'physical', selection: (Array.isArray(t.variations) ? t.variations : []).map((v: J) => v.formatted_value).filter(Boolean) })),
          shipping: { name: buyer, email, address, country: o.country_iso },
          fulfillments: ships.map((s) => ({ status: 'shipped', company: s.carrier_name || undefined, trackingNumber: s.tracking_code || undefined, trackingUrl: undefined, date: sec(s.shipment_notification_timestamp) ? new Date(sec(s.shipment_notification_timestamp)!).toISOString() : undefined })),
          refunds: refunds.map((r) => ({ status: r.status, total: money(r.amount), note: r.note, date: sec(r.created_timestamp) ? new Date(sec(r.created_timestamp)!).toISOString() : undefined })),
        },
      },
    });

    // 1) yeni sipariş (bir kez)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş #${rid} — ${money(o.grandtotal ?? o.total_price)}${o.is_gift ? ' 🎁' : ''}`,
        ...itemLines,
        `Teslimat: ${address || '—'}`,
        o.is_paid ? 'Ödeme: alındı' : 'Ödeme: bekliyor',
      ].join('\n');
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `order-${rid}`, senderId: participant.id, senderName: buyer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
      if (o.message_from_buyer) {
        this.upsertMessage({ remoteChatId: remoteId, remoteId: `note-${rid}`, senderId: participant.id, senderName: buyer, fromMe: false, text: `💬 ${String(o.message_from_buyer).trim()}`, ts: created + 1, status: 'delivered' }, { live: live && open });
      }
      if (o.is_gift && o.gift_message) {
        this.upsertMessage({ remoteChatId: remoteId, remoteId: `gift-${rid}`, senderId: participant.id, senderName: buyer, fromMe: false, text: `🎁 Hediye notu: ${String(o.gift_message).trim()}`, ts: created + 2, status: 'delivered' });
      }
    }
    // 2) ödeme alındı (sonradan)
    if (prev && !prev.paid && sig.paid) {
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `paid-${rid}`, senderId: participant.id, senderName: buyer, fromMe: false, text: `💳 Ödeme alındı — ${money(o.grandtotal ?? o.total_price)}`, ts: Date.now(), status: 'delivered' }, { live });
    }
    // 3) kargo olayları (shipments[])
    for (const [i, s] of ships.entries()) {
      const when = sec(s.shipment_notification_timestamp) ?? created + 1000 * (i + 1);
      const text = `📦 Kargoya verildi${s.carrier_name ? ` · ${s.carrier_name}` : ''}${s.tracking_code ? ` · takip: ${s.tracking_code}` : ''}`;
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `ship-${rid}-${s.receipt_shipping_id ?? i}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: when, status: 'sent' });
    }
    if (sig.shipped && !ships.length && (!prev || !prev.shipped)) {
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `shipped-${rid}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: '📦 Kargolandı olarak işaretlendi', ts: prev ? Date.now() : created + 1000, status: 'sent' });
    }
    // 4) iadeler
    for (const [i, r] of refunds.entries()) {
      const when = sec(r.created_timestamp) ?? Date.now();
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `ref-${rid}-${i}`, senderId: participant.id, senderName: buyer, fromMe: false, text: `↩️ İade ${money(r.amount)}${r.note ? ` — ${r.note}` : ''}`, ts: when, status: 'delivered' }, { live });
    }
    // 5) durum değişimi (iptal / tamamlandı)
    if (prev && prev.status !== sig.status && sig.status) {
      const st = String(sig.status).toLowerCase();
      const text = st === 'canceled' ? '❌ Sipariş iptal edildi' : st === 'completed' ? '✅ Sipariş tamamlandı' : `ℹ️ Sipariş durumu: ${sig.status}`;
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `status-${rid}-${st}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    }
    return true;
  }

  // ───────────── mesajlaşma (köprüye devir) ─────────────

  /** Sipariş sohbetine yazılan metin yerel not; diğer sohbetler Etsy Mesajları köprüsüne gider */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (remoteChatId.startsWith('order-')) {
      const id = `note-${Date.now()}`;
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
      return { remoteId: id };
    }
    if (!this.bridge) throw new Error('Etsy Mesajları bağlı değil');
    return this.bridge.sendText(remoteChatId, text);
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (remoteChatId.startsWith('order-') || !this.bridge) return;
    await this.bridge.markRead(remoteChatId);
  }

  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (remoteChatId.startsWith('order-') || !this.bridge) return;
    await this.bridge.loadHistory(remoteChatId, limit, before);
  }

  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    return this.bridge?.fetchMedia(url);
  }
}
