/**
 * Pazaryeri gün sonu özeti — SAF hesap (içe aktarma yok). AYNI dosya arayüzde de var: apps/web/src/market-calc.ts
 * (statik demo çekirdeksiz hesaplar). İki kopya birebir aynı kalmalı (test: market-summary-calc.test.ts denetler).
 *
 * Girdi bağlayıcıların `chat.meta.order` / `chat.meta.question` biçimidir (Trendyol, Hepsiburada, n11, ePttAVM, Amazon, Etsy,
 * Shopify, Shopier). Durum adları platformdan platforma değişir → `orderState` metinden sınıflar. Gün yerel saatle (çekirdeğin
 * saat dilimi) "YYYY-MM-DD".
 */

export type OrderState = 'open' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
export interface Money {
  currency: string;
  amount: number;
}
export interface MarketOrderInput {
  platform: string;
  chatId?: string;
  order: Record<string, unknown>;
}
export interface MarketQuestionInput {
  platform: string;
  chatId?: string;
  question: Record<string, unknown>;
  /** meta.question.dateCreated yoksa sohbetin son mesaj zamanı */
  ts?: number;
}
export interface DaySide {
  day: string;
  orders: number;
  revenue: Money[];
}
export interface MarketSummary {
  day: string;
  platform: string | null;
  /** O gün oluşturulan sipariş sayısı (sonradan iptal edilenler dahil) */
  orders: number;
  /** Net ciro: o günün siparişlerinden iptal/iade OLMAYANLAR, para birimine göre */
  revenue: Money[];
  avgBasket: Money[];
  /** O gün iptal/iade olan siparişler (olay zamanı yoksa sipariş günü) */
  cancelled: { count: number; amount: Money[] };
  returned: { count: number; amount: Money[] };
  /** Şu an kargoya verilmeyi bekleyen (son 30 günün açık siparişleri; seçilen günden bağımsız) */
  awaitingShipment: number;
  shipped: number;
  delivered: number;
  /** received: o gün gelen soru; waiting: şu an cevap bekleyen */
  questions: { received: number; waiting: number };
  topProducts: Array<{ title: string; qty: number; revenue: Money[] }>;
  platforms: Array<{ platform: string; orders: number; revenue: Money[]; cancelled: number; returned: number; waitingQuestions: number }>;
  compare: { yesterday: DaySide; lastWeek: DaySide };
  /** Seçilen günle biten 7 gün (eski → yeni); ciro ana para biriminde */
  trend: Array<{ day: string; orders: number; revenue: number }>;
  /** Ana para birimi (en çok ciro) */
  currency: string;
  /** Bağlı pazaryeri hesabı var mı (yoksa arayüz kartı göstermez) */
  hasShop: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Yerel gün anahtarı */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function isDayKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
}
/** Gün anahtarına n gün ekle (yaz saati geçişinde de doğru: öğlen üzerinden) */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12).getTime());
}

/** "1249.90", "1.249,90", "12,50 $", 1249.9 → sayı; okunamazsa 0 */
export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  let s = v.replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const lc = s.lastIndexOf(',');
  const ld = s.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc >= 0) s = s.replace(/,/g, (_m, i: number) => (i === lc ? '.' : ''));
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const lower = (s: string) => s.toLocaleLowerCase('tr');

/** Sipariş durumu → beş sınıf (Trendyol/HB/n11/ePttAVM/Amazon/Etsy/Shopify/Shopier durum adları ve Türkçe etiketleri) */
export function orderState(order: Record<string, unknown>): OrderState {
  const s = lower(`${str(order.status)} ${str(order.statusLabel)}`);
  const pay = lower(str(order.paymentStatus));
  if (/undeliver|teslim edilemedi/.test(s)) return 'shipped';
  if (/cancel|iptal|unsupplied|tedarik edilemedi|unfulfillable|karşılanamıyor|void/.test(s) || pay === 'voided') return 'cancelled';
  if (/return|iade|refund|claim|talep/.test(s) || /refund/.test(pay)) return 'returned';
  if (/unshipped|unfulfilled|kargolanacak|awaiting|bekleniyor/.test(s)) return 'open';
  if (/collection|teslimat noktas/.test(s)) return 'shipped';
  if (/deliver|teslim|completed|tamamland/.test(s)) return 'delivered';
  if (/ship|fulfilled|kargo|transit|sevk|yolda|gönderil|partial/.test(s)) return 'shipped';
  return 'open';
}

const ms = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};
export function orderCreatedMs(order: Record<string, unknown>): number | undefined {
  return ms(order.dateCreated);
}
/** Durum değişikliğinin zamanı: dateUpdated, yoksa en yeni kargo/iade tarihi, yoksa oluşturulma */
export function orderEventMs(order: Record<string, unknown>): number | undefined {
  const up = ms(order.dateUpdated);
  if (up) return up;
  let best: number | undefined;
  for (const list of [order.fulfillments, order.refunds]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const t = ms((f as Record<string, unknown> | null)?.date);
      if (t && (!best || t > best)) best = t;
    }
  }
  return best ?? orderCreatedMs(order);
}
/** Sipariş tutarı: totals.total, yoksa kalemlerin toplamı */
export function orderTotal(order: Record<string, unknown>): number {
  const t = parseAmount((order.totals as Record<string, unknown> | undefined)?.total);
  if (t) return t;
  const items = Array.isArray(order.items) ? (order.items as Array<Record<string, unknown>>) : [];
  return items.reduce((s, i) => s + parseAmount(i?.total), 0);
}
export function orderCurrency(order: Record<string, unknown>): string {
  const c = str(order.currency).trim().toUpperCase();
  return c === 'TL' || !c ? 'TRY' : c;
}
export function questionWaiting(q: Record<string, unknown>): boolean {
  return /wait|bekl/i.test(`${str(q.status)} ${str(q.statusLabel)}`);
}

class Purse {
  private m = new Map<string, number>();
  add(cur: string, n: number): void {
    this.m.set(cur, (this.m.get(cur) ?? 0) + n);
  }
  get(cur: string): number {
    return this.m.get(cur) ?? 0;
  }
  list(): Money[] {
    return [...this.m.entries()].filter(([, a]) => a !== 0).map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
  }
}

const OPEN_WINDOW_MS = 30 * 86_400_000;

/**
 * Günlük özet. `platform` verilirse yalnız o pazaryeri. `now` şimdiki anlık durumlar (kargo bekleyen, cevap bekleyen) için.
 */
export function summarizeMarket(orders: MarketOrderInput[], questions: MarketQuestionInput[], day: string, opts: { platform?: string | null; now?: number; hasShop?: boolean } = {}): MarketSummary {
  const platform = opts.platform || null;
  const now = opts.now ?? Date.now();
  const os = platform ? orders.filter((o) => o.platform === platform) : orders;
  const qs = platform ? questions.filter((q) => q.platform === platform) : questions;
  const rows = os.map((o) => {
    const created = orderCreatedMs(o.order);
    const event = orderEventMs(o.order);
    return { o, state: orderState(o.order), created, cday: created ? dayKey(created) : '', eday: event ? dayKey(event) : '', total: orderTotal(o.order), cur: orderCurrency(o.order) };
  });
  const lost = (s: OrderState) => s === 'cancelled' || s === 'returned';

  const side = (d: string): DaySide => {
    const p = new Purse();
    let n = 0;
    for (const r of rows)
      if (r.cday === d) {
        n++;
        if (!lost(r.state)) p.add(r.cur, r.total);
      }
    return { day: d, orders: n, revenue: p.list() };
  };

  const revenue = new Purse();
  const kept = new Map<string, number>();
  const cancelled = new Purse();
  const returned = new Purse();
  let orderN = 0;
  let cancelN = 0;
  let returnN = 0;
  let shipped = 0;
  let delivered = 0;
  let awaiting = 0;
  const products = new Map<string, { title: string; qty: number; revenue: Purse }>();
  const plats = new Map<string, { platform: string; orders: number; revenue: Purse; cancelled: number; returned: number; waitingQuestions: number }>();
  const plat = (p: string) => {
    let x = plats.get(p);
    if (!x) plats.set(p, (x = { platform: p, orders: 0, revenue: new Purse(), cancelled: 0, returned: 0, waitingQuestions: 0 }));
    return x;
  };

  for (const r of rows) {
    if (r.state === 'open' && r.created && now - r.created < OPEN_WINDOW_MS) awaiting++;
    if (r.cday === day) {
      orderN++;
      const pl = plat(r.o.platform);
      pl.orders++;
      if (!lost(r.state)) {
        revenue.add(r.cur, r.total);
        pl.revenue.add(r.cur, r.total);
        kept.set(r.cur, (kept.get(r.cur) ?? 0) + 1);
        const items = Array.isArray(r.o.order.items) ? (r.o.order.items as Array<Record<string, unknown>>) : [];
        for (const it of items) {
          const title = str(it?.title).trim() || 'Ürün';
          const qty = Math.max(1, Math.round(parseAmount(it?.quantity) || 1));
          const key = lower(title);
          let pr = products.get(key);
          if (!pr) products.set(key, (pr = { title, qty: 0, revenue: new Purse() }));
          pr.qty += qty;
          pr.revenue.add(r.cur, parseAmount(it?.total));
        }
      }
    }
    if (r.eday === day) {
      if (r.state === 'cancelled') (cancelN++, cancelled.add(r.cur, r.total), plat(r.o.platform).cancelled++);
      else if (r.state === 'returned') (returnN++, returned.add(r.cur, r.total), plat(r.o.platform).returned++);
      else if (r.state === 'delivered') delivered++;
      else if (r.state === 'shipped') shipped++;
    }
  }

  let received = 0;
  let waiting = 0;
  for (const q of qs) {
    const t = ms(q.question.dateCreated) ?? q.ts;
    if (t && dayKey(t) === day) received++;
    if (questionWaiting(q.question)) {
      waiting++;
      plat(q.platform).waitingQuestions++;
    }
  }

  const revList = revenue.list();
  // ana para birimi: günün en büyük cirosu; gün boşsa son 7 günün
  const trendDays = Array.from({ length: 7 }, (_, i) => addDays(day, i - 6));
  let currency = revList[0]?.currency;
  if (!currency) {
    const p = new Purse();
    for (const r of rows) if (trendDays.includes(r.cday) && !lost(r.state)) p.add(r.cur, r.total);
    currency = p.list()[0]?.currency ?? 'TRY';
  }
  const trend = trendDays.map((d) => {
    const s = side(d);
    return { day: d, orders: s.orders, revenue: s.revenue.find((m) => m.currency === currency)?.amount ?? 0 };
  });

  return {
    day,
    platform,
    orders: orderN,
    revenue: revList,
    avgBasket: revList.map((m) => ({ currency: m.currency, amount: Math.round((m.amount / Math.max(1, kept.get(m.currency) ?? 1)) * 100) / 100 })),
    cancelled: { count: cancelN, amount: cancelled.list() },
    returned: { count: returnN, amount: returned.list() },
    awaitingShipment: awaiting,
    shipped,
    delivered,
    questions: { received, waiting },
    topProducts: [...products.values()]
      .sort((a, b) => b.qty - a.qty || b.revenue.get(currency) - a.revenue.get(currency) || a.title.localeCompare(b.title, 'tr'))
      .slice(0, 8)
      .map((p) => ({ title: p.title, qty: p.qty, revenue: p.revenue.list() })),
    platforms: [...plats.values()]
      .filter((p) => p.orders || p.cancelled || p.returned || p.waitingQuestions)
      .sort((a, b) => b.orders - a.orders || b.revenue.get(currency) - a.revenue.get(currency))
      .map((p) => ({ platform: p.platform, orders: p.orders, revenue: p.revenue.list(), cancelled: p.cancelled, returned: p.returned, waitingQuestions: p.waitingQuestions })),
    compare: { yesterday: side(addDays(day, -1)), lastWeek: side(addDays(day, -7)) },
    trend,
    currency,
    hasShop: opts.hasShop ?? (orders.length > 0 || questions.length > 0),
  };
}

const SYMBOL: Record<string, string> = { TRY: '₺', USD: '$', EUR: '€', GBP: '£' };
/** 8450 TRY → "8.450 ₺" (kuruşlar yalnız decimals ile) */
export function formatMoney(m: Money, decimals = 0): string {
  const n = m.amount.toLocaleString('tr-TR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${n} ${SYMBOL[m.currency] ?? m.currency}`;
}
export function formatMoneyList(list: Money[], decimals = 0): string {
  return list.length ? list.map((m) => formatMoney(m, decimals)).join(' + ') : formatMoney({ currency: 'TRY', amount: 0 }, decimals);
}

/** Bildirim metni: "Gün sonu özeti: 12 sipariş · 8.450 ₺ · 3 soru bekliyor" */
export function digestText(s: MarketSummary): string {
  const parts = [`${s.orders} sipariş`, formatMoneyList(s.revenue)];
  if (s.questions.waiting) parts.push(`${s.questions.waiting} soru bekliyor`);
  if (s.awaitingShipment) parts.push(`${s.awaitingShipment} kargo bekliyor`);
  if (s.cancelled.count + s.returned.count) parts.push(`${s.cancelled.count + s.returned.count} iptal/iade`);
  return `Gün sonu özeti: ${parts.join(' · ')}`;
}
