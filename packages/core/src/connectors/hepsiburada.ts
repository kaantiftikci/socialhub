import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay, retryAfterSec } from './poll-timer.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Attachment, Participant } from '../model.js';

/**
 * Hepsiburada Pazaryeri: resmi entegrasyon API'leri (HTTP Basic Auth, entegrasyon kullanıcı adı/şifresi).
 *
 * Uçlar developers.hepsiburada.com (Eylül 2026) portalından doğrulandı; dokümandaki adresler test (SIT) ortamına
 * aittir, canlı ortam "-sit" kaldırılarak elde edilir:
 *  - Sipariş yönetimi (OMS):  https://oms-external.hepsiburada.com   (test: https://oms-external-sit.hepsiburada.com)
 *      GET /orders/merchantid/{merchantId}?offset&limit                      ödemesi tamamlanmış (paketlenecek) kalemler
 *      GET /orders/merchantid/{merchantId}/ordernumber/{orderNumber}         siparişe ait kalem detayları
 *      GET /packages/merchantid/{merchantId}?timespan&limit(≤10)&offset      satıcının paketleri
 *      GET /packages/merchantid/{merchantId}/shipped?offset&limit(≤50)       kargoya verilenler (son 1 ay)
 *      GET /packages/merchantid/{merchantId}/delivered?offset&limit(≤50)     teslim edilenler (son 1 ay)
 *      GET /packages/merchantid/{merchantId}/packagenumber/{packageNumber}   kargo takip (trackingInfoCode/Url)
 *  - Satıcıya Sor (soru-cevap): https://api-asktoseller-merchant.hepsiburada.com
 *      (test: https://api-asktoseller-merchant-sit.hepsiburada.com); `merchantId` başlığı zorunlu
 *      GET  /api/v1.0/issues?status=1&page&size&sortBy&desc                 soru listesi (1 bekleyen, 2 cevaplanan, 3 sorun bildirilen, 4 otomatik kapanan)
 *      GET  /api/v1.0/issues/{number}                                       soru detayı
 *      POST /api/v1.0/issues/{number}/answer  (multipart/form-data: Answer)  cevaplama (≤2000 karakter)
 *  - Her istekte `User-Agent` zorunlu; doküman "basic auth kullanıcı adı" der, entegratör rehberleri "merchantId - uygulama"
 *    der; ikisini de kapsayan `<merchantId> - <kullanıcıAdı>` gönderilir.
 *  - Limit: OMS 1 sn'de 1000 istek (429 + X-RateLimit-* başlıkları).
 *
 * DOĞRULANMADI: yanıt gövdelerinin sayfalama sarmalayıcısı (dokümanda alan adları var, örnek yanıt yok). Kod hem düz dizi
 * hem `{items|data}` biçimini kabul eder; sayfalama başlıkları (totalcount/pagecount) yoksa kısa sayfada durur.
 *
 * Model: her sipariş bir sohbet (`order-<siparişNo>`), sipariş/paket/kargo olayları mesaj; her müşteri sorusu bir sohbet
 * (`q-<soruNo>`), soru fromMe=false, satıcı cevabı fromMe=true. Sipariş sohbetine yazılan metin yerel not olarak kalır
 * (Hepsiburada'da sipariş üzerinden müşteriye mesaj ucu yok).
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OMS = 'https://oms-external.hepsiburada.com';
const ASK = 'https://api-asktoseller-merchant.hepsiburada.com';
/** İlk yoklamada paket/kargo geçmişi: son 14 gün (saat) */
const FIRST_TIMESPAN_H = 14 * 24;

export interface HepsiburadaConfig {
  merchantId: string;
  username: string;
  password: string;
}

class HbError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Sipariş sohbetinde birleştirilen temel bilgi (kaynaklar: açık kalemler, paket listesi, sipariş detayı) */
interface OrderBase {
  orderNumber: string;
  orderId?: string;
  orderDate?: string;
  customerName?: string;
  customerId?: string;
  currency: string;
  items: Array<{ id?: string; sku?: string; title: string; quantity: number; total: number; status?: string }>;
  shipping: { name?: string; address?: string; phone?: string; email?: string; city?: string; town?: string; district?: string };
}

interface PackageInfo {
  packageNumber: string;
  status: 'packaged' | 'shipped' | 'delivered' | 'undelivered';
  company?: string;
  barcode?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  date?: string;
}

interface State {
  /** sohbet remoteId → son görülen imza */
  seen: Record<string, string>;
  /** siparişNo → temel bilgi (yalnızca shipped/delivered listesinde görünen eski siparişler için gerekir) */
  orders: Record<string, OrderBase>;
  /** siparişNo → paketler */
  packages: Record<string, Record<string, PackageInfo>>;
}

const money = (v: unknown, cur: string) => `${Number(v ?? 0).toFixed(2).replace('.', ',')} ${cur === 'TRY' ? '₺' : cur}`;
const amount = (v: unknown): number => (typeof v === 'object' && v !== null ? Number((v as J).amount ?? 0) : Number(v ?? 0));
const currencyOf = (v: unknown, fallback = 'TRY'): string => (typeof v === 'object' && v !== null ? String((v as J).currency ?? fallback) : fallback);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const ORDER_RANK: Record<PackageInfo['status'], number> = { packaged: 1, shipped: 2, undelivered: 2, delivered: 3 };
const STATUS_TR: Record<string, string> = {
  open: 'Yeni', unpacked: 'Paket bozuldu', packaged: 'Paketlendi', shipped: 'Kargoda', intransit: 'Kargoda', delivered: 'Teslim edildi', undelivered: 'Teslim edilemedi',
  cancelledbymerchant: 'Satıcı iptal etti', cancelledbycustomer: 'Müşteri iptal etti', cancelledbysap: 'İptal (sistem)', claimcreated: 'Talep açıldı',
};

/** Dizi ya da `{items|data|issues|orders}` sarmalayıcısı → dizi */
function listOf(data: unknown): J[] {
  if (Array.isArray(data)) return data as J[];
  if (data && typeof data === 'object') {
    const d = data as J;
    for (const k of ['items', 'data', 'issues', 'orders', 'packages', 'result', 'results']) {
      if (Array.isArray(d[k])) return d[k] as J[];
      if (d[k] && typeof d[k] === 'object' && Array.isArray(d[k].items)) return d[k].items as J[];
    }
  }
  return [];
}

/** Soru statüsü: sayı (1-4) ya da metin → normalize metin */
function issueStatus(v: unknown): 'WaitingForAnswer' | 'Answered' | 'Rejected' | 'AutoClosed' | string {
  const map: Record<string, string> = { '1': 'WaitingForAnswer', '2': 'Answered', '3': 'Rejected', '4': 'AutoClosed' };
  const s = String(v ?? '');
  return map[s] ?? s;
}

export class HepsiburadaConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private cfg: HepsiburadaConfig;
  private state: State = { seen: {}, orders: {}, packages: {} };
  private stateFile: string;
  private askWarned = false;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string) {
    super(account, store);
    let cfg: Partial<HepsiburadaConfig> = {};
    try {
      cfg = JSON.parse(config || '{}') as Partial<HepsiburadaConfig>;
    } catch {
      /* bozuk JSON → start() hata verir */
    }
    this.cfg = { merchantId: String(cfg.merchantId ?? '').trim(), username: String(cfg.username ?? '').trim(), password: String(cfg.password ?? '') };
    this.ordersOn = ordersFlag(config);
    this.stateFile = path.join(sessionDir(account.id), 'hepsiburada-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>;
      this.state = { seen: st.seen ?? {}, orders: st.orders ?? {}, packages: st.packages ?? {} };
    } catch {
      /* ilk çalıştırma */
    }
  }

  private get headers(): Record<string, string> {
    return {
      authorization: 'Basic ' + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64'),
      'user-agent': `${this.cfg.merchantId} - ${this.cfg.username}`,
      accept: 'application/json',
    };
  }

  /** Ortak istek: 401/403 kimlik hatası, 429 limit; gövde JSON değilse boş nesne */
  private async api(method: string, url: string, opts: { body?: unknown; form?: FormData; ask?: boolean } = {}): Promise<{ data: J | J[]; headers: Headers; status: number }> {
    const headers: Record<string, string> = { ...this.headers };
    if (opts.ask) headers.merchantid = this.cfg.merchantId;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const r = await fetch(url, { method, headers, body });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new HbError(r.status, 'Hepsiburada kimlik bilgileri reddedildi');
    if (r.status === 429) this.timer?.backoff(retryAfterSec(r.headers.get('x-ratelimit-reset') ?? r.headers.get('retry-after')));
    if (r.status === 429) throw new HbError(429, `Hepsiburada istek limiti; ${r.headers.get('x-ratelimit-reset') ?? r.headers.get('retry-after') ?? '60'} sn sonra`);
    if (!r.ok) throw new HbError(r.status, `Hepsiburada ${r.status} ${new URL(url).pathname}: ${text.slice(0, 160)}`);
    let data: J | J[] = {};
    if (text) {
      try {
        data = JSON.parse(text) as J;
      } catch {
        data = {};
      }
    }
    return { data, headers: r.headers, status: r.status };
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.cfg.merchantId || !this.cfg.username || !this.cfg.password) return this.setStatus('error', 'Hepsiburada merchant ID / kullanıcı adı / şifre girilmedi');
    this.setStatus('connecting');
    this.account.label = this.account.label && this.account.label !== 'Hepsiburada' ? this.account.label : `Hepsiburada · ${this.cfg.username}`;
    try {
      await this.poll(true);
      this.setStatus('connected', `merchant ${this.cfg.merchantId.slice(0, 8)}…`);
      this.timer?.stop();
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay()).start();
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.stop();
    this.setStatus('disconnected');
  }

  private saveState(): void {
    // imza haritasını sınırlı tut (eski siparişler düşer, yeniden görülürse "yeni" sayılmaz çünkü orders'ta kalır)
    const seenEntries = Object.entries(this.state.seen).slice(-4000);
    const keep = new Set(seenEntries.map(([k]) => k.replace(/^order-/, '')));
    const orders: Record<string, OrderBase> = {};
    const packages: Record<string, Record<string, PackageInfo>> = {};
    for (const [k, v] of Object.entries(this.state.orders)) if (keep.has(k)) orders[k] = v;
    for (const [k, v] of Object.entries(this.state.packages)) if (keep.has(k)) packages[k] = v;
    this.state = { seen: Object.fromEntries(seenEntries), orders, packages };
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      // sipariş sohbetleri isteğe bağlı (varsayılan kapalı: yalnız müşteri soruları)
      const o = this.ordersOn ? await this.pollOrders(first) : 0;
      const q = await this.pollQuestions(first);
      if (o || q) bus.log('info', `Hepsiburada: ${o} sipariş, ${q} soru güncellendi`);
      this.saveState();
    } catch (e) {
      const err = e as HbError;
      if (err.status === 401 || err.status === 403) {
        this.setStatus('error', err.message);
        this.timer?.stop();
      } else bus.log('warn', `Hepsiburada yoklama: ${err.message}`);
      if (first) throw e;
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------ siparişler

  private async omsList(p: string, params: Record<string, string | number>): Promise<{ list: J[]; headers: Headers }> {
    const u = new URL(`${OMS}${p}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const { data, headers } = await this.api('GET', u.toString());
    return { list: listOf(data), headers };
  }

  /** Sayfalı listeyi çek; başlık/gövde toplam sayfa bilgisi yoksa kısa sayfada durur */
  private async omsPages(p: string, limit: number, maxPages: number, extra: Record<string, string | number> = {}): Promise<J[]> {
    const out: J[] = [];
    for (let page = 0; page < maxPages; page++) {
      const { list, headers } = await this.omsList(p, { ...extra, offset: page * limit, limit });
      out.push(...list);
      const total = Number(headers.get('totalcount') ?? headers.get('x-total-count') ?? NaN);
      if (list.length < limit || (Number.isFinite(total) && out.length >= total)) break;
    }
    return out;
  }

  private async pollOrders(first: boolean): Promise<number> {
    const m = encodeURIComponent(this.cfg.merchantId);
    // 1) ödemesi tamamlanmış açık kalemler → sipariş numarasına göre grupla
    const openItems = await this.omsPages(`/orders/merchantid/${m}`, 100, first ? 5 : 2);
    const touched = new Set<string>();
    const byOrder = new Map<string, J[]>();
    for (const it of openItems) {
      const n = String(it.orderNumber ?? it.OrderNumber ?? '');
      if (!n) continue;
      if (!byOrder.has(n)) byOrder.set(n, []);
      byOrder.get(n)!.push(it);
    }
    for (const [n, items] of byOrder) {
      this.state.orders[n] = this.baseFromLineItems(n, items, this.state.orders[n]);
      touched.add(n);
    }
    // 2) paketler (ilk yoklamada 14 gün, sonra son 3 saat + açık olanlar)
    const pkgs = await this.omsPages(`/packages/merchantid/${m}`, 10, first ? 30 : 5, { timespan: first ? FIRST_TIMESPAN_H : 3 });
    for (const pk of pkgs) {
      const n = String(pk.orderNumber ?? pk.items?.[0]?.orderNumber ?? '');
      if (!n) continue;
      this.state.orders[n] = this.baseFromPackage(n, pk, this.state.orders[n]);
      this.notePackage(n, { packageNumber: String(pk.packageNumber ?? pk.id ?? ''), status: 'packaged', company: pk.cargoCompany ?? pk.cargoCompanyModel?.name, barcode: pk.barcode, date: pk.orderDate ?? pk.createdDate });
      touched.add(n);
    }
    // 3) kargoya verilen / teslim edilen (son 1 ay; ilk yoklamada 3 sayfa)
    for (const [kind, status] of [['shipped', 'shipped'], ['delivered', 'delivered']] as const) {
      const rows = await this.omsPages(`/packages/merchantid/${m}/${kind}`, 50, first ? 3 : 1);
      for (const r of rows) {
        const n = String(r.orderNumber ?? r.OrderNumber ?? '');
        if (!n) continue;
        this.notePackage(n, { packageNumber: String(r.packageNumber ?? r.PackageNumber ?? ''), status, barcode: r.barcode ?? r.Barcode, date: r.shippedDate ?? r.ShippedDate ?? r.deliveredDate ?? r.DeliveredDate });
        touched.add(n);
      }
    }
    // 4) temel bilgisi olmayan siparişler (yalnızca kargo listesinde görünenler) → sipariş detayı; kargodakiler → takip bilgisi
    let detailBudget = 20;
    let trackBudget = 20;
    for (const n of touched) {
      if (!this.state.orders[n] && detailBudget-- > 0) {
        try {
          const { data } = await this.api('GET', `${OMS}/orders/merchantid/${m}/ordernumber/${encodeURIComponent(n)}`);
          const items = listOf(data).length ? listOf(data) : Array.isArray((data as J).items) ? ((data as J).items as J[]) : [data as J];
          this.state.orders[n] = this.baseFromLineItems(n, items, undefined);
        } catch (e) {
          if ((e as HbError).status === 401 || (e as HbError).status === 403) throw e;
          bus.log('warn', `Hepsiburada sipariş detayı #${n}: ${(e as Error).message}`);
        }
      }
      for (const pk of Object.values(this.state.packages[n] ?? {})) {
        if (pk.status === 'shipped' && !pk.trackingNumber && pk.packageNumber && trackBudget-- > 0) {
          try {
            const { data } = await this.api('GET', `${OMS}/packages/merchantid/${m}/packagenumber/${encodeURIComponent(pk.packageNumber)}`);
            const d = (listOf(data)[0] ?? data) as J;
            pk.trackingNumber = d.trackingInfoCode ?? d.trackingNumber ?? undefined;
            pk.trackingUrl = d.trackingInfoUrl ?? d.trackingUrl ?? undefined;
            pk.company = d.cargoCompany ?? pk.company;
            if (String(d.status ?? '').toLowerCase() === 'delivered') pk.status = 'delivered';
            if (!pk.trackingNumber) pk.trackingNumber = pk.barcode; // takip yoksa barkod (yeniden sorgulanmasın)
          } catch (e) {
            if ((e as HbError).status === 401 || (e as HbError).status === 403) throw e;
            pk.trackingNumber = pk.barcode ?? '-';
          }
        }
      }
    }
    // 5) sohbet + mesajlar (eskiden yeniye)
    const ordered = [...touched].filter((n) => this.state.orders[n]).sort((a, b) => Date.parse(this.state.orders[a].orderDate ?? '') - Date.parse(this.state.orders[b].orderDate ?? ''));
    let changed = 0;
    for (const n of ordered) if (this.ingestOrder(n, !first)) changed++;
    return changed;
  }

  private notePackage(n: string, p: PackageInfo): void {
    if (!p.packageNumber) return;
    const bag = (this.state.packages[n] ??= {});
    const prev = bag[p.packageNumber];
    if (!prev) {
      bag[p.packageNumber] = p;
      return;
    }
    // durum geri gitmesin, bilinen alanlar korunsun
    bag[p.packageNumber] = {
      ...prev,
      ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '')),
      status: ORDER_RANK[p.status] >= ORDER_RANK[prev.status] ? p.status : prev.status,
      trackingNumber: prev.trackingNumber ?? p.trackingNumber,
      trackingUrl: prev.trackingUrl ?? p.trackingUrl,
      date: ORDER_RANK[p.status] >= ORDER_RANK[prev.status] ? p.date ?? prev.date : prev.date,
    };
  }

  /** Açık kalem listesi / sipariş detayı satırları → temel bilgi */
  private baseFromLineItems(n: string, items: J[], prev?: OrderBase): OrderBase {
    const f = items[0] ?? {};
    const a: J = f.shippingAddress ?? f.deliveryAddress ?? {};
    const cur = currencyOf(f.totalPrice, prev?.currency ?? 'TRY');
    return {
      orderNumber: n,
      orderId: f.orderId ?? prev?.orderId,
      orderDate: f.orderDate ?? prev?.orderDate,
      customerName: f.customerName ?? a.name ?? prev?.customerName,
      customerId: f.customerId ?? prev?.customerId,
      currency: cur,
      items: items.map((it) => ({
        id: it.id ?? it.lineItemId,
        sku: it.sku ?? it.hbSku ?? it.merchantSku,
        title: it.productName ?? it.name ?? it.sku ?? 'Ürün',
        quantity: Number(it.quantity ?? 1),
        total: amount(it.totalPrice ?? it.merchantTotalPrice),
        status: it.status,
      })),
      shipping: {
        name: a.name ?? f.customerName ?? prev?.shipping.name,
        address: [a.address ?? a.addressDetail, a.district, a.town, a.city].filter(Boolean).join(', ') || prev?.shipping.address,
        phone: a.phoneNumber ?? prev?.shipping.phone,
        email: a.email ?? prev?.shipping.email,
        city: a.city ?? prev?.shipping.city,
        town: a.town ?? prev?.shipping.town,
        district: a.district ?? prev?.shipping.district,
      },
    };
  }

  /** Paket listesi kaydı → temel bilgi (adres alanları düz) */
  private baseFromPackage(n: string, pk: J, prev?: OrderBase): OrderBase {
    const items: J[] = Array.isArray(pk.items) ? pk.items : [];
    const cur = currencyOf(pk.totalPrice, prev?.currency ?? 'TRY');
    const mapped = items.map((it) => ({
      id: it.lineItemId ?? it.id,
      sku: it.hbSku ?? it.sku ?? it.merchantSku,
      title: it.productName ?? it.name ?? it.hbSku ?? 'Ürün',
      quantity: Number(it.quantity ?? 1),
      total: amount(it.totalPrice ?? it.merchantTotalPrice),
      status: 'Packaged',
    }));
    return {
      orderNumber: n,
      orderId: pk.id ?? prev?.orderId,
      orderDate: pk.orderDate ?? prev?.orderDate,
      customerName: pk.customerName ?? pk.recipientName ?? prev?.customerName,
      customerId: pk.customerId ?? prev?.customerId,
      currency: cur,
      // açık kalemler listesinden gelen kalemler + pakette olup orada olmayanlar
      items: prev?.items.length ? [...prev.items, ...mapped.filter((x) => !prev.items.some((y) => y.id && y.id === x.id))] : mapped,
      shipping: {
        name: pk.recipientName ?? prev?.shipping.name,
        address: [pk.shippingAddressDetail, pk.shippingDistrict, pk.shippingTown, pk.shippingCity].filter(Boolean).join(', ') || prev?.shipping.address,
        phone: pk.phoneNumber ?? prev?.shipping.phone,
        email: pk.email ?? prev?.shipping.email,
        city: pk.shippingCity ?? prev?.shipping.city,
        town: pk.shippingTown ?? prev?.shipping.town,
        district: pk.shippingDistrict ?? prev?.shipping.district,
      },
    };
  }

  /** Sipariş → sohbet + olay mesajları. Değişiklik varsa true döner. */
  private ingestOrder(n: string, live: boolean): boolean {
    const o = this.state.orders[n];
    const pkgs = Object.values(this.state.packages[n] ?? {}).sort((a, b) => a.packageNumber.localeCompare(b.packageNumber));
    const cancelled = o.items.length > 0 && o.items.every((i) => /^cancelled/i.test(String(i.status ?? '')));
    const top = pkgs.reduce<PackageInfo['status'] | 'open'>((acc, p) => (acc === 'open' || ORDER_RANK[p.status] > ORDER_RANK[acc as PackageInfo['status']] ? p.status : acc), 'open');
    const status = cancelled ? 'cancelled' : top;
    const sig = JSON.stringify([status, o.items.length, pkgs.map((p) => [p.packageNumber, p.status, p.trackingNumber])]);
    const key = `order-${n}`;
    const prev = this.state.seen[key];
    if (prev === sig) return false;
    this.state.seen[key] = sig;

    const customer = o.customerName || o.shipping.name || 'Müşteri';
    const created = Date.parse(o.orderDate ?? '') || Date.now();
    const total = o.items.reduce((s, i) => s + i.total, 0);
    const participant: Participant = { id: o.customerId || o.shipping.email || o.shipping.phone || n, name: customer, handle: o.shipping.phone || o.shipping.email || undefined };
    const open = status !== 'delivered' && status !== 'cancelled';
    const remoteId = key;
    this.upsertChat({
      remoteId,
      name: `#${n} · ${customer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: o.shipping.phone || o.shipping.email || undefined,
      participants: [participant],
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id: n,
          status,
          statusLabel: STATUS_TR[status] ?? status,
          dateCreated: o.orderDate,
          currency: o.currency,
          totals: { total },
          items: o.items.map((i) => ({ title: i.title, quantity: i.quantity, total: i.total, sku: i.sku, status: i.status })),
          shipping: { name: o.shipping.name ?? customer, phone: o.shipping.phone, email: o.shipping.email, address: o.shipping.address },
          fulfillments: pkgs.map((p) => ({ status: p.status, company: p.company, trackingNumber: p.trackingNumber, trackingUrl: p.trackingUrl, packageNumber: p.packageNumber, barcode: p.barcode, date: p.date })),
        },
      },
    });

    // 1) yeni sipariş mesajı (bir kez)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş #${n} — ${money(total, o.currency)}`,
        ...o.items.map((i) => `• ${i.quantity} × ${i.title} — ${money(i.total, o.currency)}`),
        `Teslimat: ${o.shipping.address || '—'}`,
        o.shipping.phone ? `Telefon: ${o.shipping.phone}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.upsertMessage({ remoteChatId: remoteId, senderId: participant.id, senderName: customer, fromMe: false, remoteId: `new-${n}`, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) paket / kargo / teslimat olayları
    for (const [i, p] of pkgs.entries()) {
      const when = Date.parse(p.date ?? '') || created + 1000 * (i + 1);
      const company = p.company ? ` · ${p.company}` : '';
      const packed = `📦 Paketlendi${company} · paket ${p.packageNumber}${p.barcode ? ` · barkod ${p.barcode}` : ''}`;
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `pkg-${p.packageNumber}-packaged`, senderId: 'me', senderName: 'Ben', fromMe: true, text: packed, ts: Math.min(when, Date.parse(p.date ?? '') || when), status: 'sent' });
      if (ORDER_RANK[p.status] >= ORDER_RANK.shipped && p.status !== 'delivered') {
        const text = p.status === 'undelivered' ? `📦 Teslim edilemedi${company}` : `📦 Kargoya verildi${company}${p.trackingNumber ? ` · takip: ${p.trackingNumber}` : ''}${p.trackingUrl ? `\n${p.trackingUrl}` : ''}`;
        this.upsertMessage({ remoteChatId: remoteId, remoteId: `pkg-${p.packageNumber}-${p.status}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: when + 1, status: 'sent' });
      }
      if (p.status === 'delivered') {
        this.upsertMessage({ remoteChatId: remoteId, remoteId: `pkg-${p.packageNumber}-delivered`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `✅ Teslim edildi${company}${p.trackingNumber ? ` · takip: ${p.trackingNumber}` : ''}`, ts: when + 2, status: 'sent' });
      }
    }
    if (cancelled && prev) {
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `cancel-${n}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: '🚫 Sipariş iptal edildi', ts: Date.now(), status: 'sent' });
    }
    return true;
  }

  // ------------------------------------------------------------------ müşteri soruları

  private async askList(params: Record<string, string | number | string[]>): Promise<J[]> {
    const u = new URL(`${ASK}/api/v1.0/issues`);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
      else u.searchParams.set(k, String(v));
    }
    const { data } = await this.api('GET', u.toString(), { ask: true });
    return listOf(data);
  }

  private async pollQuestions(first: boolean): Promise<number> {
    let issues: J[] = [];
    try {
      // bekleyenler (hepsi) + son cevaplanan/kapananlar (kendi cevaplarımız ve süresi dolanlar için)
      const waiting = await this.askList({ status: '1', page: 1, size: 50, sortBy: 0, desc: 'true' });
      const done = await this.askList({ status: ['2', '4', '3'], page: 1, size: first ? 50 : 25, sortBy: 1, desc: 'true' });
      issues = [...done, ...waiting];
    } catch (e) {
      const err = e as HbError;
      if (err.status === 401 || err.status === 403) throw e;
      if (err.status === 404) {
        if (!this.askWarned) bus.log('warn', 'Hepsiburada Satıcıya Sor API 404 döndü; soru-cevap atlanıyor (yetki/uç değişmiş olabilir)');
        this.askWarned = true;
        return 0;
      }
      bus.log('warn', `Hepsiburada soru listesi: ${err.message}`);
      return 0;
    }
    // aynı soru iki listede olabilir; son hali kazansın
    const byNo = new Map<string, J>();
    for (const q of issues) {
      const n = String(q.issueNumber ?? q.number ?? q.id ?? '');
      if (n) byNo.set(n, q);
    }
    const ordered = [...byNo.values()].sort((a, b) => (Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0));
    let changed = 0;
    for (const q of ordered) if (this.ingestQuestion(q, !first)) changed++;
    return changed;
  }

  /** Soru → sohbet + yazışma mesajları. Değişiklik varsa true döner. */
  private ingestQuestion(q: J, live: boolean): boolean {
    const n = String(q.issueNumber ?? q.number ?? q.id ?? '');
    if (!n) return false;
    const status = issueStatus(q.status);
    const conv: J[] = Array.isArray(q.conversations) ? q.conversations : [];
    const sig = JSON.stringify([status, conv.length, q.lastModifiedAt ?? '', q.lastContent ?? '']);
    const key = `q-${n}`;
    const prev = this.state.seen[key];
    if (prev === sig) return false;
    this.state.seen[key] = sig;

    const product = String(q.product?.name ?? q.productName ?? '');
    const customer = String(q.customerName ?? q.customer?.name ?? 'Müşteri');
    const customerId = String(q.customerId ?? q.customer?.id ?? `q-${n}`);
    const created = Date.parse(q.createdAt ?? '') || Date.now();
    const waiting = status === 'WaitingForAnswer';
    const participant: Participant = { id: customerId, name: customer };
    const remoteId = key;
    this.upsertChat({
      remoteId,
      name: `Soru · ${short(product || q.subject?.description || `#${n}`, 40)}`,
      kind: 'direct',
      lastMessageAt: created,
      participants: [participant],
      avatarUrl: q.product?.imageUrl ?? undefined,
      // yanıt bekleyen yeni soru "ilgi bekliyor"
      unread: !prev && waiting ? 1 : undefined,
      meta: {
        question: {
          number: n,
          status,
          statusLabel: { WaitingForAnswer: 'Cevap bekliyor', Answered: 'Cevaplandı', Rejected: 'Sorun bildirildi', AutoClosed: 'Süresi doldu' }[status] ?? status,
          subject: q.subject?.description ?? q.subject,
          product: { sku: q.product?.sku, name: product, imageUrl: q.product?.imageUrl, stockCode: q.product?.stockCode },
          orderNumber: q.orderNumber ?? undefined,
          expireDate: q.expireDate,
          lastModifiedAt: q.lastModifiedAt,
        },
      },
    });

    const header = [product ? `🛒 ${product}` : '', q.orderNumber ? `Sipariş #${q.orderNumber}` : '', q.subject?.description ? `Konu: ${q.subject.description}` : ''].filter(Boolean).join(' · ');
    if (conv.length) {
      for (const [i, c] of conv.entries()) {
        const fromMe = /merchant/i.test(String(c.from ?? ''));
        const ts = Date.parse(c.createdAt ?? '') || created + i;
        const files: unknown[] = Array.isArray(c.files) ? c.files : [];
        const attachments: Attachment[] = files.map((f) => {
          // dosya ya düz URL dizesi ya da {url|fileUrl, name|fileName} nesnesi (doküman biçim vermiyor)
          const o: J = typeof f === 'string' ? { url: f, name: f.split('/').pop() } : ((f ?? {}) as J);
          const url = o.url ?? o.fileUrl ?? o.link;
          const name = o.name ?? o.fileName;
          return { kind: /\.(png|jpe?g|bmp|gif|webp)(\?|$)/i.test(String(url ?? name)) ? 'image' : 'file', url, link: url, name };
        });
        const text = c.rejectReason ? `🚫 Sorun bildirildi: ${c.rejectReason}` : String(c.content ?? '');
        const body = i === 0 && !fromMe && header ? `${header}\n${text}` : text;
        const isNew = !this.hasMessage(remoteId, `c-${c.id ?? i}`);
        this.upsertMessage(
          { remoteChatId: remoteId, remoteId: `c-${c.id ?? i}`, senderId: fromMe ? 'me' : customerId, senderName: fromMe ? 'Ben' : customer, fromMe, text: body, ts, status: fromMe ? 'sent' : 'delivered', ...(attachments.length ? { attachments } : {}) },
          { live: live && isNew && !fromMe },
        );
      }
    } else {
      // yazışma listesi yoksa son içerik soru metnidir
      const text = header ? `${header}\n${q.lastContent ?? ''}` : String(q.lastContent ?? '');
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `q-${n}`, senderId: customerId, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && !prev });
    }
    if (status === 'AutoClosed' && prev) {
      this.upsertMessage({ remoteChatId: remoteId, remoteId: `closed-${n}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: '⏱️ Cevap süresi doldu, soru otomatik kapandı', ts: Date.parse(q.lastModifiedAt ?? '') || Date.now(), status: 'sent' });
    }
    return true;
  }

  // ------------------------------------------------------------------ gönderim

  /** `q-<no>`: Satıcıya Sor cevabı (API); `order-<no>`: yerel not (Hepsiburada'da siparişten müşteriye mesaj ucu yok). */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (remoteChatId.startsWith('q-')) {
      const n = remoteChatId.slice(2);
      const answer = text.trim().slice(0, 2000);
      const form = new FormData();
      form.set('Answer', answer);
      try {
        await this.api('POST', `${ASK}/api/v1.0/issues/${encodeURIComponent(n)}/answer`, { form, ask: true });
      } catch (e) {
        const err = e as HbError;
        if (err.status === 401 || err.status === 403) this.setStatus('error', err.message);
        throw new Error(err.status === 409 || err.status === 400 ? `Hepsiburada cevabı kabul etmedi (süre dolmuş olabilir): ${err.message}` : err.message);
      }
      const id = `ans-${Date.now()}`;
      const ts = Date.now();
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: answer, ts, status: 'sent' });
      // sohbet meta'sında durumu "cevaplandı" yap; sonraki yoklama gerçek yazışmayı getirir
      const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
      const qm = (chat?.meta?.question ?? {}) as J;
      this.upsertChat({ remoteId: remoteChatId, name: chat?.name ?? remoteChatId, lastMessageAt: ts, meta: { ...(chat?.meta ?? {}), question: { ...qm, status: 'Answered', statusLabel: 'Cevaplandı' } } });
      delete this.state.seen[remoteChatId];
      this.saveState();
      bus.log('info', `Hepsiburada: soru #${n} cevaplandı`);
      return { remoteId: id };
    }
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
}
