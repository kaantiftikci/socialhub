import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay } from './poll-timer.js';
import { BrowserConnector } from './browser/bridge.js';
import { makeShopifyInbox } from './browser/shopify.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { AccountStatus, Participant } from '../model.js';
import type { Store } from '../store.js';

/**
 * Shopify: siparişler Admin REST API (özel uygulama erişim belirteci, `X-Shopify-Access-Token`),
 * müşteri sohbetleri Shopify Inbox'tan tarayıcı köprüsüyle (Inbox'ın açık API'si yok).
 *
 * - Her sipariş bir "sohbet"tir (remoteId `order-<id>`); sipariş olayları (oluşturma, kargo, iade, iptal)
 *   mesaj olarak akar. Sohbete yazılan metin yerel not olarak tutulur.
 * - Inbox sohbetleri aynı hesapta, köprünün verdiği kimliklerle yer alır; gönderim köprüye devredilir.
 *
 * Yapılandırma (token dosyası JSON): { shop: "magaza.myshopify.com" | "magaza", accessToken: "shpat_…", inbox?: boolean }
 * Belirteç: Shopify yönetici → Ayarlar → Uygulamalar ve satış kanalları → Uygulama geliştir → Admin API erişim belirteci;
 * kapsamlar read_orders, read_customers, read_fulfillments.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const API_VERSION = '2025-07';

export interface ShopifyConfig {
  shop: string;
  accessToken: string;
  /** Inbox köprüsünü (Chromium) başlat; varsayılan true */
  inbox?: boolean;
}

/** Yapılandırma metnini çöz; mağaza tanıtıcısı ve API ana bilgisayarı türetilir */
export function parseShopifyConfig(config: string): { handle: string; host: string; token: string; inbox: boolean } {
  let cfg: Partial<ShopifyConfig> = {};
  try {
    cfg = JSON.parse(config || '{}') as Partial<ShopifyConfig>;
  } catch {
    /* geçersiz JSON: boş yapılandırma */
  }
  const raw = String(cfg.shop ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const handle = raw.replace(/\.myshopify\.com$/i, '').toLowerCase();
  return { handle, host: handle ? `${handle}.myshopify.com` : '', token: String(cfg.accessToken ?? '').trim(), inbox: cfg.inbox === true }; // Inbox tarayıcı köprüsü varsayılan kapalı (ban önleme); açıkça true ile açılır
}

/** Belirteç reddi (401/403): yoklama durdurulur, durum error */
class AuthError extends Error {}

const money = (v: unknown, cur: string): string => {
  const n = Number(v ?? 0);
  const s = Number.isFinite(n) ? n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? '0');
  return `${s} ${cur === 'TRY' ? '₺' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur}`;
};

const FINANCIAL: Record<string, string> = { pending: 'ödeme bekliyor', authorized: 'ödeme onaylandı', partially_paid: 'kısmen ödendi', paid: 'ödendi', partially_refunded: 'kısmen iade', refunded: 'iade edildi', voided: 'iptal' };
const SHIPMENT: Record<string, string> = {
  label_printed: 'Etiket basıldı',
  label_purchased: 'Etiket alındı',
  attempted_delivery: 'Teslimat denendi',
  ready_for_pickup: 'Teslim noktasında',
  confirmed: 'Gönderi onaylandı',
  in_transit: 'Yolda',
  out_for_delivery: 'Dağıtımda',
  delivered: 'Teslim edildi',
  failure: 'Teslimat başarısız',
};

/** `Link` başlığından rel="next" adresini çıkar (Shopify imleçli sayfalama) */
export function nextLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Bileşik durum: API bağlıysa hesap 'connected'; Inbox köprüsünün durumu ayrıntıya yazılır.
 * API hatası her zaman baskın (siparişler asıl kaynak). API 'connected' değilse köprü durumu görünmez.
 */
export function combineStatus(api: { status: AccountStatus; detail?: string }, inbox?: { status: AccountStatus; detail?: string }): { status: AccountStatus; detail?: string } {
  if (api.status !== 'connected' || !inbox) return api;
  switch (inbox.status) {
    case 'pairing':
      return { status: 'connected', detail: 'Inbox için Shopify\'a giriş gerekli (Yeniden bağlan)' };
    case 'error':
      return { status: 'connected', detail: `Inbox: ${inbox.detail ?? 'hata'}` };
    case 'connecting':
      return { status: 'connected', detail: 'Inbox bağlanıyor…' };
    case 'disconnected':
      return { status: 'connected', detail: `Inbox kapalı${inbox.detail ? ` — ${inbox.detail}` : ''}` };
    default:
      return { status: 'connected', detail: api.detail };
  }
}

/** Köprü alt bileşeni: durumunu hesaba yazmak yerine bileşik connector'a bildirir (aynı Account nesnesi paylaşılır) */
class InboxBridge extends BrowserConnector {
  constructor(
    account: BaseConnector['account'],
    store: Store,
    handle: string,
    getLabel: () => string | undefined,
    private readonly onStatus: (status: AccountStatus, detail?: string) => void,
  ) {
    super(account, store, makeShopifyInbox(handle, getLabel), 30_000);
  }
  protected override setStatus(status: AccountStatus, detail?: string): void {
    this.onStatus(status, detail);
  }
}

export class ShopifyConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private readonly handle: string;
  private readonly host: string;
  private readonly token: string;
  private readonly inboxEnabled: boolean;
  private inbox?: InboxBridge;
  private apiState: { status: AccountStatus; detail?: string } = { status: 'disconnected' };
  private inboxState?: { status: AccountStatus; detail?: string };
  /** sipariş id → son görülen durum imzası */
  private seen = new Map<string, string>();
  /** son başarılı yoklamanın başlangıcı (ISO): sonraki yoklama updated_at_min ile yalnız değişenleri alır */
  private since?: string;
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: Store, config: string) {
    super(account, store);
    ({ handle: this.handle, host: this.host, token: this.token, inbox: this.inboxEnabled } = parseShopifyConfig(config));
    this.ordersOn = ordersFlag(config);
    this.stateFile = path.join(sessionDir(account.id), 'shopify-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { seen?: Record<string, string>; since?: string };
      for (const [k, v] of Object.entries(st.seen ?? {})) this.seen.set(k, v);
      this.since = st.since;
    } catch {
      /* ilk çalıştırma */
    }
  }

  // ─────────── Admin REST API ───────────
  /** `p`: `/orders.json?…` biçiminde yol ya da Link başlığından gelen tam adres */
  private async api(p: string, retried = false): Promise<{ data: J; headers: Headers }> {
    const url = /^https?:\/\//.test(p) ? p : `https://${this.host}/admin/api/${API_VERSION}${p}`;
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': this.token, accept: 'application/json' } });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new AuthError('Shopify erişim belirteci reddedildi');
    if (r.status === 429) {
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after') ?? '2') || 2, 1), 60);
      if (!retried) {
        bus.log('warn', `Shopify istek limiti (429); ${wait} sn bekleniyor`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        return this.api(p, true);
      }
      throw new Error(`Shopify istek limiti; ${wait} sn sonra yeniden dene`);
    }
    if (!r.ok) throw new Error(`Shopify ${r.status} ${p.replace(/^https?:\/\/[^/]+/, '')}: ${text.slice(0, 160)}`);
    return { data: text ? (JSON.parse(text) as J) : {}, headers: r.headers };
  }

  // ─────────── Durum birleştirme ───────────
  private publish(): void {
    if (this.stopping) return;
    const { status, detail } = combineStatus(this.apiState, this.inboxState);
    super.setStatus(status, detail);
  }
  private setApiStatus(status: AccountStatus, detail?: string): void {
    this.apiState = { status, detail };
    this.publish();
  }
  private setInboxStatus(status: AccountStatus, detail?: string): void {
    this.inboxState = { status, detail };
    bus.log(status === 'error' ? 'warn' : 'info', `shopify/inbox: ${status}${detail ? ' — ' + detail : ''}`);
    this.publish();
  }

  async start(opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.host || !this.token) return this.setApiStatus('error', 'Shopify mağaza adresi / Admin API erişim belirteci girilmedi');
    this.setApiStatus('connecting');
    try {
      const { data } = await this.api('/shop.json').catch((e) => {
        if (e instanceof AuthError) throw e;
        return { data: {} as J, headers: new Headers() };
      });
      const shop: J = data.shop ?? {};
      this.account.label = shop.name ?? this.handle;
      await this.poll(true);
      this.setApiStatus('connected', shop.email ?? undefined);
      this.timer?.stop();
      this.timer?.stop();
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay()).start();
    } catch (e) {
      this.setApiStatus('error', (e as Error).message.split('\n')[0]);
      return;
    }
    // Inbox köprüsü: kullanıcı girişi (interactive) dakikalar sürebilir, start'ı bekletmesin
    if (this.inboxEnabled && !this.stopping) {
      this.inbox ??= new InboxBridge(this.account, this.store, this.handle, () => this.account.label, (s, d) => this.setInboxStatus(s, d));
      void this.inbox.start(opts).catch((e) => this.setInboxStatus('error', (e as Error).message.split('\n')[0]));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.stop();
    this.timer = undefined;
    await this.inbox?.stop().catch(() => undefined);
    this.inboxState = undefined;
    this.apiState = { status: 'disconnected' };
    this.setStatus('disconnected');
  }

  // ─────────── Sipariş yoklama ───────────
  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    if (!this.ordersOn) {
      this.polling = false;
      return; // sipariş sohbetleri kapalı: yalnız mesajlaşma köprüsü çalışır
    }
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // saat kayması payı
    try {
      const orders: J[] = [];
      // ilk yoklama: en yeni siparişlerden 3 sayfa; sonrakiler: son yoklamadan beri değişenler
      let url: string | undefined = first || !this.since ? '/orders.json?status=any&limit=50&order=created_at%20desc' : `/orders.json?status=any&limit=50&updated_at_min=${encodeURIComponent(this.since)}`;
      const maxPages = first ? 3 : 10;
      for (let page = 0; url && page < maxPages; page++) {
        const { data, headers } = await this.api(url);
        const list: J[] = Array.isArray(data.orders) ? data.orders : [];
        orders.push(...list);
        url = list.length ? nextLink(headers.get('link')) : undefined;
      }
      let changed = 0;
      // eskiden yeniye: sohbet sırası ve "canlı" bildirimler doğru olsun
      orders.sort((a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0));
      for (const o of orders) if (this.ingest(o, !first)) changed++;
      if (changed) bus.log('info', `Shopify: ${changed} sipariş güncellendi`);
      this.since = startedAt;
      this.saveState();
    } catch (e) {
      if (e instanceof AuthError) {
        this.timer?.stop();
        this.timer = undefined;
        if (!first) this.setApiStatus('error', e.message);
        throw e;
      }
      bus.log('warn', `Shopify yoklama: ${(e as Error).message}`);
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

  /** Sipariş → sohbet + olay mesajları. Değişiklik varsa true döner. */
  private ingest(o: J, live: boolean): boolean {
    const id = String(o.id);
    const remoteChatId = `order-${id}`;
    const fulfillments: J[] = o.fulfillments ?? [];
    const refunds: J[] = o.refunds ?? [];
    const sig = JSON.stringify([
      o.financial_status,
      o.fulfillment_status,
      o.cancelled_at,
      o.closed_at,
      fulfillments.map((f) => [f.id, f.status, f.shipment_status, f.tracking_number]),
      refunds.map((r) => [r.id, (r.transactions ?? []).map((t: J) => t.amount)]),
    ]);
    const prev = this.seen.get(id);
    if (prev === sig) return false;
    this.seen.set(id, sig);

    const c: J = o.customer ?? {};
    const ship: J = o.shipping_address ?? o.billing_address ?? {};
    const customer = [c.first_name, c.last_name].filter(Boolean).join(' ') || ship.name || o.email || 'Müşteri';
    const email: string | undefined = o.email || c.email || undefined;
    const phone: string | undefined = o.phone || ship.phone || c.phone || undefined;
    const cur: string = o.currency ?? o.presentment_currency ?? 'TRY';
    const created = Date.parse(o.created_at ?? '') || Date.now();
    const name = o.name ?? (o.order_number != null ? `#${o.order_number}` : `#${id}`);
    const items: J[] = o.line_items ?? [];
    const itemLines = items.map((li) => `• ${li.quantity ?? 1} × ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''} — ${money(Number(li.price ?? 0) * Number(li.quantity ?? 1), cur)}`);
    const address = [ship.address1, ship.address2, ship.city, ship.province, ship.zip, ship.country].filter(Boolean).join(', ');
    const participant: Participant = { id: email || phone || String(c.id ?? id), name: customer, handle: phone || email || undefined };
    const cancelled = !!o.cancelled_at;
    const open = !cancelled && !o.closed_at && o.fulfillment_status !== 'fulfilled';
    const status = cancelled ? 'cancelled' : o.fulfillment_status ?? (o.financial_status === 'paid' ? 'paid' : o.financial_status ?? 'open');

    this.upsertChat({
      remoteId: remoteChatId,
      name: `${name} · ${customer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: phone || email || undefined,
      link: o.order_status_url || (this.handle ? `https://admin.shopify.com/store/${this.handle}/orders/${id}` : undefined),
      participants: [participant],
      // açık sipariş ilk görüldüğünde "ilgi bekliyor"
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id,
          name,
          status,
          paymentStatus: o.financial_status,
          fulfillmentStatus: o.fulfillment_status ?? null,
          dateCreated: o.created_at,
          currency: cur,
          totals: { total: o.total_price, subtotal: o.subtotal_price, tax: o.total_tax, discount: o.total_discounts, shipping: (o.shipping_lines ?? []).reduce((s: number, l: J) => s + Number(l.price ?? 0), 0).toFixed(2) },
          note: o.note,
          tags: o.tags,
          items: items.map((li) => ({ title: li.title, quantity: li.quantity, total: (Number(li.price ?? 0) * Number(li.quantity ?? 1)).toFixed(2), sku: li.sku, selection: li.variant_title ? [li.variant_title] : [] })),
          shipping: { name: ship.name || customer, phone, email, address },
          fulfillments: fulfillments.map((f) => ({ status: f.shipment_status ?? f.status, company: f.tracking_company ?? undefined, trackingNumber: f.tracking_number ?? undefined, trackingUrl: f.tracking_url ?? undefined, date: f.updated_at ?? f.created_at })),
          refunds: refunds.map((r) => ({ type: 'refund', status: 'succeeded', total: (r.transactions ?? []).reduce((s: number, t: J) => s + Number(t.amount ?? 0), 0).toFixed(2), date: r.created_at, note: r.note })),
          cancelledAt: o.cancelled_at ?? undefined,
          cancelReason: o.cancel_reason ?? undefined,
          platform: 'shopify',
        },
      },
    });

    // 1) sipariş oluşturma (bir kez)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş ${name} — ${money(o.total_price, cur)}${o.financial_status ? ` (${FINANCIAL[o.financial_status] ?? o.financial_status})` : ''}`,
        ...itemLines,
        `Teslimat: ${address || '—'}`,
        phone ? `Telefon: ${phone}` : '',
        o.note ? `Not: ${o.note}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.upsertMessage({ remoteChatId, remoteId: `order-${id}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) kargo / teslimat olayları (her fulfillment × durum bir mesaj)
    for (const [i, f] of fulfillments.entries()) {
      const when = Date.parse(f.updated_at ?? f.created_at ?? '') || created + 1000 * (i + 1);
      const company = f.tracking_company ?? '';
      const tracking = f.tracking_number ? ` · takip: ${f.tracking_number}` : '';
      const url = f.tracking_url ? `\n${f.tracking_url}` : '';
      const state = f.shipment_status ?? f.status;
      const text =
        f.status === 'cancelled'
          ? `📦 Gönderi iptal edildi${company ? ` · ${company}` : ''}${tracking}`
          : f.status === 'error' || f.status === 'failure'
            ? `📦 Gönderi hatası${company ? ` · ${company}` : ''}${tracking}`
            : `📦 ${SHIPMENT[f.shipment_status] ?? 'Kargoya verildi'}${company ? ` · ${company}` : ''}${tracking}${url}`;
      this.upsertMessage({ remoteChatId, remoteId: `ful-${f.id ?? i}-${state}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: when, status: 'sent' });
    }
    // 3) iadeler
    for (const r of refunds) {
      const when = Date.parse(r.processed_at ?? r.created_at ?? '') || Date.now();
      const total = (r.transactions ?? []).reduce((s: number, t: J) => s + Number(t.amount ?? 0), 0);
      const text = `↩️ İade ${money(total, cur)}${r.note ? ` — ${r.note}` : ''}`;
      this.upsertMessage({ remoteChatId, remoteId: `ref-${r.id ?? when}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: when, status: 'sent' });
    }
    // 4) iptal
    if (cancelled) {
      const when = Date.parse(o.cancelled_at) || Date.now();
      const reason: Record<string, string> = { customer: 'müşteri isteği', fraud: 'sahtecilik', inventory: 'stok yok', declined: 'ödeme reddedildi', other: 'diğer' };
      this.upsertMessage({ remoteChatId, remoteId: `cancel-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `❌ Sipariş iptal edildi${o.cancel_reason ? ` (${reason[o.cancel_reason] ?? o.cancel_reason})` : ''}`, ts: when, status: 'sent' }, { live });
    }
    // 5) kapatma (yalnız daha önce görülmüş siparişte; ilk yoklamada eski kapalı siparişler mesaj üretmesin)
    if (o.closed_at && prev && !cancelled) {
      this.upsertMessage({ remoteChatId, remoteId: `closed-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: '✅ Sipariş kapatıldı', ts: Date.parse(o.closed_at) || Date.now(), status: 'sent' });
    }
    return true;
  }

  // ─────────── Gönderim / devredilen işlemler ───────────
  private isOrder(remoteChatId: string): boolean {
    return remoteChatId.startsWith('order-');
  }

  /** Sipariş sohbetine yazılan metin yerel not; Inbox sohbeti köprüye gider */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (this.isOrder(remoteChatId)) {
      const id = `note-${Date.now()}`;
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
      return { remoteId: id };
    }
    if (!this.inbox) throw new Error('Shopify Inbox köprüsü kapalı (yapılandırmada inbox: false)');
    return this.inbox.sendText(remoteChatId, text);
  }

  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (this.isOrder(remoteChatId) || !this.inbox) throw new Error('Bu sohbette dosya gönderme desteklenmiyor');
    return this.inbox.sendMedia(remoteChatId, file, caption);
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (this.isOrder(remoteChatId) || !this.inbox) return;
    await this.inbox.markRead(remoteChatId);
  }

  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (this.isOrder(remoteChatId) || !this.inbox) return;
    await this.inbox.loadHistory(remoteChatId, limit, before);
  }

  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    return this.inbox?.fetchMedia(url);
  }
}
