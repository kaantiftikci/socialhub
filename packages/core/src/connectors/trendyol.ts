import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay, retryAfterSec } from './poll-timer.js';
import { ingestChunked, writeJsonAtomic } from './market-state.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Participant } from '../model.js';

/**
 * Trendyol Satıcı API'si (developers.trendyol.com — Sipariş Entegrasyonu + Soru-Cevap Entegrasyonu).
 * - Her sipariş (orderNumber) bir "sohbet": sipariş paketleri (shipmentPackages) ve durum geçmişi mesaj olarak akar.
 * - Her müşteri sorusu bir "sohbet": soru metni müşteriden, cevap bizden; yanıt POST .../answers ile gönderilir.
 * Kimlik: Basic base64(apiKey:apiSecret) + `User-Agent: <sellerId> - SelfIntegration` (Trendyol hız sınırını bu başlıkla sayar).
 *
 * Ağ geçitleri: güncel `apigw.trendyol.com/integration/...` (Eylül 2026 dokümanı); eski `api.trendyol.com/sapigw/suppliers/...`
 * yalnızca yedek (404/410 gelirse ötekine düşülür). Trendyol'da alıcıya doğrudan mesaj ucu YOK; sipariş sohbetine yazılan metin yerel nottur.
 * Servis limitleri (doküman): sipariş paketleri 30–100 istek/dk (kademeye göre), soru çekme 1000/dk, cevaplama 500/dk; aynı uca 10 sn'de 50.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TrendyolConfig {
  sellerId: string | number;
  apiKey: string;
  apiSecret: string;
}

interface Gateway {
  name: string;
  orders(sellerId: string): string;
  /** Sipariş API v2 (v1 /orders 15 Ekim 2026'da kapanıyor; v2 yalnız son 1 ay, en çok 10.000 kayıt) */
  ordersV2?(sellerId: string): string;
  questions(sellerId: string): string;
  answer(sellerId: string, questionId: string): string;
}

/** Sıra önemli: ilk eleman güncel ağ geçidi; 404/410 durumunda bir sonrakine geçilir. */
export const GATEWAYS: Gateway[] = [
  {
    name: 'apigw',
    orders: (s) => `https://apigw.trendyol.com/integration/order/sellers/${s}/orders`,
    ordersV2: (s) => `https://apigw.trendyol.com/integration/order/sellers/${s}/v2/orders`,
    questions: (s) => `https://apigw.trendyol.com/integration/qna/sellers/${s}/questions/filter`,
    answer: (s, q) => `https://apigw.trendyol.com/integration/qna/sellers/${s}/questions/${q}/answers`,
  },
  {
    name: 'sapigw',
    orders: (s) => `https://api.trendyol.com/sapigw/suppliers/${s}/orders`,
    questions: (s) => `https://api.trendyol.com/sapigw/suppliers/${s}/questions/filter`,
    answer: (s, q) => `https://api.trendyol.com/sapigw/suppliers/${s}/questions/${q}/answers`,
  },
];

const DAY = 86_400_000;
/** İlk yoklama penceresi: doküman en fazla 2 hafta aralığa izin veriyor; sınırın hemen altında kal. */
const FIRST_WINDOW = 14 * DAY - 60_000;
/** Sonraki yoklamalar: son değişenler (PackageLastModifiedDate'e göre) — 3 günlük pencere geç gelen kargo/teslim olaylarını da yakalar */
const NEXT_WINDOW = 3 * DAY;
const PAGE_SIZE = 200;

/** Paket durumu → mesaj metni. `Created` yeni sipariş mesajıyla zaten anlatılıyor, ayrıca yazılmaz. */
const PACKAGE_STATUS: Record<string, string> = {
  Awaiting: '⏳ Ödeme/onay bekleniyor',
  Verified: '✔️ Sipariş doğrulandı',
  Picking: '📦 Gönderi hazırlanıyor',
  Invoiced: '🧾 Faturalandı',
  Shipped: '📦 Kargoya verildi',
  AtCollectionPoint: '📍 Teslimat noktasında',
  Delivered: '✅ Teslim edildi',
  UnDelivered: '⚠️ Teslim edilemedi',
  Returned: '↩️ İade edildi',
  Cancelled: '❌ İptal edildi',
  UnSupplied: '⚠️ Tedarik edilemedi',
  UnPacked: '📦 Paket bölündü',
};
const CLOSED = new Set(['Delivered', 'Cancelled', 'Returned', 'UnSupplied']);

export const QUESTION_STATUS: Record<string, string> = {
  WAITING_FOR_ANSWER: 'Cevap bekliyor',
  ANSWERED: 'Cevaplandı',
  REJECTED: 'Cevap reddedildi',
  REPORTED: 'Raporlandı',
};

class TrendyolAuthError extends Error {}
class TrendyolRateLimit extends Error {}

/** Cevap gönderildi işareti (seen değeri): API cevabı yansıtana dek (≤30 dk) soru yeniden "bekliyor/okunmamış" olmasın */
const ANSWERED_SENTINEL_PREFIX = 'answered:';
const answeredSentinel = () => `${ANSWERED_SENTINEL_PREFIX}${Date.now()}`;
const answeredRecently = (prev: string | undefined) => !!prev && prev.startsWith(ANSWERED_SENTINEL_PREFIX) && Date.now() - Number(prev.slice(ANSWERED_SENTINEL_PREFIX.length)) < 30 * 60_000;
/** Durum dosyasında paketleri saklanan en fazla sipariş (en son güncellenenler) */
const MAX_STORED_ORDERS = 2000;
/** Durum dosyasında saklanan en fazla imza (sipariş + soru; son görülme sırasına göre, LRU) */
const MAX_SEEN = 8000;
/** Kaçan aralık telafisi: son başarılı yoklamadan bu kadar öncesinden başla (saat/API gecikmesi payı) */
const CATCHUP_SLACK = 10 * 60_000;
/** Başarısız geniş isteğin yeniden denenme aralığı */
const WIDE_RETRY = 10 * 60_000;

const pick = (o: J | undefined, keys: string[]): J | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const out: J = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
};

/** Paketi ingestOrder'ın kullandığı alanlara indir (durum dosyası küçük kalsın) */
export function stripPackage(p: J): J {
  const out = pick(p, ['id', 'orderNumber', 'status', 'shipmentPackageStatus', 'cargoTrackingNumber', 'cargoTrackingLink', 'cargoProviderName', 'customerFirstName', 'customerLastName', 'customerEmail', 'customerPhone', 'customerId', 'currencyCode', 'orderDate', 'totalPrice', 'grossAmount', 'totalDiscount', 'totalTyDiscount', 'deliveryType', 'lastModifiedDate', 'estimatedDeliveryEndDate'])!;
  const addr = pick(p.shipmentAddress, ['fullName', 'fullAddress', 'address1', 'address2', 'neighborhood', 'district', 'city', 'phone']);
  if (addr) out.shipmentAddress = addr;
  const hist: J[] | undefined = p.packageHistories ?? p.packageHistory;
  if (Array.isArray(hist)) out.packageHistories = hist.map((h) => pick(h, ['status', 'createdDate']));
  if (Array.isArray(p.lines)) out.lines = p.lines.map((l: J) => pick(l, ['quantity', 'productName', 'productSize', 'productColor', 'amount', 'price', 'currencyCode', 'merchantSku', 'barcode', 'orderLineItemStatusName']));
  return out;
}

/**
 * İki paket listesini paket kimliğine göre birleştir: `primary`deki kayıt kazanır, `secondary`de olup primary'de olmayanlar
 * eklenir. Sonuç kimliğe göre sıralı (gelen alt küme değişince imza/ilk paket oynamasın).
 */
export function mergePackages(primary: J[], secondary: J[]): J[] {
  const byId = new Map<string, J>();
  for (const p of [...primary, ...secondary]) if (!byId.has(String(p.id))) byId.set(String(p.id), p);
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

const money = (v: unknown, cur: string) => `${Number(v ?? 0).toFixed(2).replace('.', ',')} ${cur === 'TRY' || !cur ? '₺' : cur}`;
const shorten = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Token dosyasındaki JSON'u çözümler; alan eksikse undefined. */
export function parseConfig(raw: string): TrendyolConfig | undefined {
  try {
    const j = JSON.parse(raw) as J;
    const sellerId = String(j.sellerId ?? j.supplierId ?? '').trim();
    const apiKey = String(j.apiKey ?? '').trim();
    const apiSecret = String(j.apiSecret ?? '').trim();
    if (!sellerId || !apiKey || !apiSecret) return undefined;
    return { sellerId, apiKey, apiSecret };
  } catch {
    return undefined;
  }
}

export class TrendyolConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private cfg?: TrendyolConfig;
  private gw = 0;
  /** sohbet remoteId (order-…/q-…) → son görülen imza */
  private seen = new Map<string, string>();
  /**
   * siparişNo → bilinen paketler (yalnız ingestOrder'ın kullandığı alanlar). Yoklama penceresi yalnız son değişen paketleri
   * döndürdüğü için çok paketli siparişte gelen paketler bunlarla birleştirilir; yoksa sohbet meta'sı eksik paketle ezilirdi.
   */
  private packages = new Map<string, J[]>();
  private stateFile: string;
  /**
   * Son hatasız tamamlanan yoklamanın zamanı (ms; sorular / siparişler). Sonraki tur [min(şimdi-3g, lastOk-10dk), şimdi]
   * aralığını ister: 3 günü aşan uyku ya da yarım kalan ilk eşitleme telafi edilir. 0 = tam ilk eşitleme gerekiyor.
   */
  private lastOkQ = 0;
  private lastOkO = 0;
  /** Son geniş isteğin (tam eşitleme / çok dilimli telafi) zamanı: başarısızsa WIDE_RETRY dolmadan yinelenmez */
  private wideAtQ = 0;
  private wideAtO = 0;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string) {
    super(account, store);
    this.cfg = parseConfig(config);
    this.ordersOn = ordersFlag(config);
    this.stateFile = path.join(sessionDir(account.id), 'trendyol-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { seen?: Record<string, string>; gw?: number; packages?: Record<string, J[]>; lastOkQ?: number; lastOkO?: number };
      for (const [k, v] of Object.entries(st.seen ?? {})) this.seen.set(k, v);
      if (typeof st.lastOkQ === 'number') this.lastOkQ = st.lastOkQ;
      if (typeof st.lastOkO === 'number') this.lastOkO = st.lastOkO;
      for (const [k, v] of Object.entries(st.packages ?? {})) if (Array.isArray(v)) this.packages.set(k, v);
      if (typeof st.gw === 'number' && GATEWAYS[st.gw]) this.gw = st.gw;
    } catch {
      /* ilk çalıştırma */
    }
  }

  private get sellerId(): string {
    return String(this.cfg?.sellerId ?? '');
  }

  private headers(body?: unknown): Record<string, string> {
    const c = this.cfg!;
    return {
      authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64')}`,
      'user-agent': `${c.sellerId} - SelfIntegration`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
  }

  /**
   * `kind` ucunu geçerli ağ geçidinde çağırır; 404/410 gelirse öteki geçide düşüp bir kez daha dener ve seçimi kalıcı yapar.
   */
  /** Sipariş v2 ucu bu hesapta/geçitte yoksa v1 (bir kez öğrenilir) */
  private noOrdersV2 = false;

  private async api(method: string, kind: 'orders' | 'questions' | 'answer', query?: Record<string, string | number>, body?: unknown, questionId?: string): Promise<J> {
    // Geçit dizini çağrı yerelinde ilerler: eşzamanlı iki çağrı 404 alınca birbirini geri çevirmesin
    let gi = this.gw;
    for (let attempt = 0; attempt < GATEWAYS.length; attempt++) {
      const g = GATEWAYS[gi];
      const v2 = kind === 'orders' && !!g.ordersV2 && !this.noOrdersV2;
      let url = kind === 'answer' ? g.answer(this.sellerId, encodeURIComponent(questionId ?? '')) : v2 ? g.ordersV2!(this.sellerId) : g[kind](this.sellerId);
      if (query) url += '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
      const r = await fetch(url, { method, headers: this.headers(body), body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (r.status === 401 || r.status === 403) throw new TrendyolAuthError('Trendyol kimlik bilgileri reddedildi');
      if (r.status === 429) this.timer?.backoff(retryAfterSec(r.headers.get('retry-after')));
      if (r.status === 429) throw new TrendyolRateLimit(`Trendyol istek limiti (429); ${r.headers.get('retry-after') ?? '60'} sn sonra`);
      // v2 henüz yoksa (556 = ağ geçidinde yönlendirilmemiş yol) v1'e düş; aynı geçitte yeniden dene
      if (v2 && [404, 410, 556].includes(r.status)) {
        this.noOrdersV2 = true;
        bus.log('warn', `Trendyol: sipariş API v2 ${r.status} döndü; v1 kullanılıyor (v1 15 Ekim 2026'da kapanacak)`);
        attempt--;
        continue;
      }
      if ((r.status === 404 || r.status === 410) && attempt < GATEWAYS.length - 1) {
        gi = (gi + 1) % GATEWAYS.length;
        if (this.gw !== gi) bus.log('warn', `Trendyol: ${g.name} ${r.status} döndü, ${GATEWAYS[gi].name} geçidine geçiliyor`);
        this.gw = gi;
        continue;
      }
      if (!r.ok) throw new Error(`Trendyol ${r.status} ${kind}: ${text.slice(0, 160)}`);
      if (!text) return {};
      try {
        return JSON.parse(text) as J;
      } catch {
        return { raw: text };
      }
    }
    throw new Error('Trendyol: uç bulunamadı');
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.cfg) return this.setStatus('error', 'Trendyol satıcı ID / API anahtarı / API secret girilmedi');
    if (!this.account.label || /^trendyol$/i.test(this.account.label)) this.account.label = `Trendyol · ${this.sellerId}`;
    this.setStatus('connecting');
    try {
      await this.poll(true);
      this.setStatus('connected', `Satıcı ${this.sellerId}`);
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

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      const now = Date.now();
      const gwBefore = this.gw;
      // İki servis ayrı hız sınırına sahip: biri 429 verirse öteki yine işlensin
      // API tek istekte en çok 2 haftalık aralık kabul ediyor: ilk eşitlemede geriye doğru 2 haftalık dilimler
      // (sorular ~6 ay, siparişler ~3 ay); sonraki yoklamalarda son 3 gün — ya da son başarılı yoklamadan beri (uyku/kopma
      // 3 günü aştıysa aynı 2 haftalık dilimlerle, üst sınır ilk eşitleme penceresi). İlk eşitleme yarım kaldıysa (lastOk 0) yeniden tam.
      // Geniş istek (tam eşitleme ya da çok dilimli telafi) başarısız kaldıysa her 30 sn'de yeniden değil, en çok WIDE_RETRY'da
      // bir denenir (kalıcı hata veren eski bir dilim her turda yüzlerce istek üretmesin); arada yalnız son 3 gün, imleç ilerlemez.
      const plan = (n: number, lastOk: number, wideAt: number): { spans: Array<[number, number]>; pages: number; wide: boolean; narrow: boolean } => {
        const wide = first || !lastOk || lastOk - CATCHUP_SLACK < now - NEXT_WINDOW;
        if (wide && !first && now - wideAt < WIDE_RETRY) return { spans: [[now - NEXT_WINDOW, now]], pages: 5, wide: false, narrow: true };
        if (first || !lastOk) return { spans: Array.from({ length: n }, (_, i) => [now - (i + 1) * FIRST_WINDOW, now - i * FIRST_WINDOW] as [number, number]), pages: 50, wide: true, narrow: false };
        const from = Math.max(now - n * FIRST_WINDOW, Math.min(now - NEXT_WINDOW, lastOk - CATCHUP_SLACK));
        const spans: Array<[number, number]> = [];
        for (let b = now; b > from; b -= FIRST_WINDOW) spans.push([Math.max(from, b - FIRST_WINDOW), b]);
        return { spans, pages: spans.length > 1 ? 50 : 5, wide, narrow: false };
      };
      const pO = plan(this.noOrdersV2 ? 6 : 2, this.lastOkO, this.wideAtO);
      const pQ = plan(13, this.lastOkQ, this.wideAtQ);
      // ilk turun hatası hemen bir kez daha geniş denensin; sonrakiler aralıklı
      if (pO.wide && this.ordersOn && !first) this.wideAtO = now;
      if (pQ.wide && !first) this.wideAtQ = now;
      /** Dilimler tek tek: biri düşerse öncekiler atılmaz; kimlik hatası ölümcül, hız sınırında kalan dilimler denenmez */
      const slices = async <T>(p: ReturnType<typeof plan>, fetchOne: (a: number, b: number, pages: number) => Promise<T>, add: (v: T) => void): Promise<Error | undefined> => {
        let err: Error | undefined;
        for (const [a, b] of p.spans) {
          try {
            add(await fetchOne(a, b, p.pages));
          } catch (e) {
            if (e instanceof TrendyolAuthError) throw e;
            err ??= e as Error;
            if (e instanceof TrendyolRateLimit) break;
          }
        }
        return err;
      };
      const allOrders = async () => {
        const m = new Map<string, J[]>();
        // dilimler birleşir (aynı siparişin paketleri farklı dilimlere düşebilir); önce görülen (daha yeni dilim) kazanır
        // v2 yalnız son 1 ayı veriyor: ilk eşitleme 2 dilim (≈4 hafta); v1'e düşüldüyse eskisi gibi 6 dilim (≈3 ay)
        const err = await slices(pO, (a, b, pages) => this.fetchOrders(a, b, pages), (v) => {
          for (const [k, pk] of v) m.set(k, mergePackages(m.get(k) ?? [], pk));
        });
        return { m, err };
      };
      const allQuestions = async () => {
        const out: J[] = [];
        const ids = new Set<string>();
        const err = await slices(pQ, (a, b, pages) => this.fetchQuestions(a, b, pages), (v) => {
          for (const q of v) if (!ids.has(String(q.id))) (ids.add(String(q.id)), out.push(q));
        });
        return { out, err };
      };
      const [ro, rq] = await Promise.allSettled([this.ordersOn ? allOrders() : Promise.resolve({ m: new Map<string, J[]>(), err: undefined }), allQuestions()]);
      // kimlik hatası ancak soru tarafı da reddedildiyse ölümcül; yalnız sipariş ucu reddederse (yetki kapsamı) sorular sürsün
      if (rq.status === 'rejected' && rq.reason instanceof TrendyolAuthError) throw rq.reason;
      if (ro.status === 'rejected' && ro.reason instanceof TrendyolAuthError && rq.status === 'rejected') throw ro.reason;
      const orders = ro.status === 'fulfilled' ? ro.value.m : new Map<string, J[]>();
      const questions = rq.status === 'fulfilled' ? rq.value.out : [];
      const oErr = ro.status === 'rejected' ? (ro.reason as Error) : ro.value.err;
      const qErr = rq.status === 'rejected' ? (rq.reason as Error) : rq.value.err;
      let failed: Error | undefined;
      for (const e of [oErr, qErr]) {
        if (!e) continue;
        bus.log('warn', `Trendyol yoklama: ${e.message}`);
        if (!(e instanceof TrendyolRateLimit)) failed = e;
      }
      // Siparişler eskiden yeniye (son paket değişikliğine göre): packages/seen sonunda en yeniler kalsın (kırpma eskileri atar)
      const lastMod = (g: J[]) => Math.max(0, ...g.map((p) => Number(p.lastModifiedDate) || 0));
      const orderList = [...orders].sort((a, b) => lastMod(a[1]) - lastMod(b[1]));
      let changedOrders = 0;
      let done = await ingestChunked(this.store, orderList, ([k, group]) => {
        // bilinen paketlerle birleştir (gelen güncel olanı kazanır), en yeni kullanılan sona taşınsın (sınır eskileri atar)
        const merged = mergePackages(group.map(stripPackage), this.packages.get(k) ?? []);
        this.packages.delete(k);
        this.packages.set(k, merged);
        if (this.ingestOrder(merged, !first)) changedOrders++;
      }, () => this.stopping);
      let changedQuestions = 0;
      if (done) done = await ingestChunked(this.store, questions.reverse(), (q) => {
        if (this.ingestQuestion(q, !first)) changedQuestions++;
      }, () => this.stopping);
      if (changedOrders || changedQuestions || first) {
        bus.log('info', `Trendyol: ${orders.size} sipariş (${changedOrders} güncellendi), ${questions.length} soru (${changedQuestions} güncellendi)`);
      }
      // imleç yalnız hatasız ve tamamen işlenmiş aralıkta ilerler; eksik aralık sonraki turda yeniden istenir
      const pendingBefore = !this.lastOkQ || (this.ordersOn && !this.lastOkO);
      // başarılı turda geniş istek kısıtı kalkar (yalnız başarısız geniş istek aralıklı yinelenir)
      if (done && !qErr && !pQ.narrow) (this.lastOkQ = now), (this.wideAtQ = 0);
      if (done && this.ordersOn && !oErr && !pO.narrow) (this.lastOkO = now), (this.wideAtO = 0);
      const pendingAfter = !this.lastOkQ || (this.ordersOn && !this.lastOkO);
      // durum dosyası yalnız bir şey değiştiyse (her 30 sn'de MB'larca yeniden yazılıyordu). Dosyadaki imleç eski kalabilir:
      // zararsız (açılış zaten tam eşitleme; eski imleç yalnız daha geniş aralık ister)
      if (changedOrders || changedQuestions || first || pendingBefore !== pendingAfter || this.gw !== gwBefore) this.saveState();
      // ilk yoklamada her iki servis de (hız sınırı dışında) çöktü ve hiçbir şey alınamadıysa bağlantı kurulamadı say
      if (first && failed && oErr && qErr && !orders.size && !questions.length) throw failed;
    } catch (e) {
      if (e instanceof TrendyolAuthError) {
        if (first) throw e;
        this.setStatus('error', e.message);
        this.timer?.stop();
        return;
      }
      if (first) throw e;
      bus.log('warn', `Trendyol yoklama: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Sipariş paketlerini sayfalı çeker ve orderNumber'a göre gruplar (bir sipariş birden çok paket olabilir). */
  private async fetchOrders(startDate: number, endDate: number, maxPages: number): Promise<Map<string, J[]>> {
    const groups = new Map<string, J[]>();
    for (let page = 0; page < maxPages; page++) {
      const data = await this.api('GET', 'orders', { startDate, endDate, page, size: PAGE_SIZE, orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC' });
      const list: J[] = Array.isArray(data.content) ? data.content : [];
      for (const p of list) {
        const key = String(p.orderNumber ?? p.id);
        const g = groups.get(key) ?? [];
        g.push(p);
        groups.set(key, g);
      }
      const totalPages = Number(data.totalPages ?? 1);
      if (page + 1 >= totalPages || list.length < PAGE_SIZE) break;
    }
    return groups;
  }

  private async fetchQuestions(startDate: number, endDate: number, maxPages: number): Promise<J[]> {
    const out: J[] = [];
    for (let page = 0; page < maxPages; page++) {
      const data = await this.api('GET', 'questions', { startDate, endDate, page, size: PAGE_SIZE, orderByField: 'LastModifiedDate', orderByDirection: 'DESC' });
      const list: J[] = Array.isArray(data.content) ? data.content : [];
      out.push(...list);
      const totalPages = Number(data.totalPages ?? 1);
      if (page + 1 >= totalPages || list.length < PAGE_SIZE) break;
    }
    return out;
  }

  private saveState(): void {
    const seen: Record<string, string> = {};
    // seen son görülme sırasında (touchSeen): kırpma en uzun süredir görülmeyenleri atar
    const seenKeep = [...this.seen.entries()].slice(-MAX_SEEN);
    if (seenKeep.length < this.seen.size) this.seen = new Map(seenKeep);
    for (const [k, v] of seenKeep) seen[k] = v;
    const keep = [...this.packages.entries()].slice(-MAX_STORED_ORDERS);
    if (keep.length < this.packages.size) this.packages = new Map(keep);
    try {
      writeJsonAtomic(this.stateFile, { seen, gw: this.gw, packages: Object.fromEntries(keep), lastOkQ: this.lastOkQ, lastOkO: this.lastOkO });
    } catch (e) {
      bus.log('warn', `Trendyol durum dosyası yazılamadı: ${(e as Error).message}`);
    }
  }

  /** seen'i LRU tut: var olan anahtar da sona taşınır (Map.set yerinde bırakıyordu → kırpma en yenileri atıyordu) */
  private touchSeen(rid: string, sig: string): void {
    this.seen.delete(rid);
    this.seen.set(rid, sig);
  }

  /** Aynı siparişin paketleri → tek sohbet + olay mesajları. Değişiklik varsa true. */
  private ingestOrder(packages: J[], live: boolean): boolean {
    const first = packages[0];
    const orderNumber = String(first.orderNumber ?? first.id);
    const rid = `order-${orderNumber}`;
    const sig = JSON.stringify(packages.map((p) => [p.id, p.status, p.shipmentPackageStatus, p.cargoTrackingNumber, (p.packageHistories ?? p.packageHistory ?? []).length, (p.lines ?? []).map((l: J) => l.orderLineItemStatusName)]));
    const prev = this.seen.get(rid);
    this.touchSeen(rid, sig);
    if (prev === sig) return false;

    const addr: J = first.shipmentAddress ?? {};
    const customer = [first.customerFirstName, first.customerLastName].filter(Boolean).join(' ') || addr.fullName || 'Müşteri';
    const lines: J[] = packages.flatMap((p) => p.lines ?? []);
    const cur = lines[0]?.currencyCode ?? first.currencyCode ?? 'TRY';
    const created = Number(first.orderDate) || Date.now();
    const total = packages.reduce((s, p) => s + Number(p.totalPrice ?? 0), 0);
    const gross = packages.reduce((s, p) => s + Number(p.grossAmount ?? 0), 0);
    const discount = packages.reduce((s, p) => s + Number(p.totalDiscount ?? 0) + Number(p.totalTyDiscount ?? 0), 0);
    const address = [addr.fullAddress || [addr.address1, addr.address2, addr.neighborhood].filter(Boolean).join(' '), addr.district, addr.city].filter(Boolean).join(', ');
    const email = first.customerEmail as string | undefined;
    const phone = (addr.phone ?? first.customerPhone) as string | undefined;
    const participant: Participant = { id: String(first.customerId ?? email ?? orderNumber), name: customer, handle: phone || email || undefined };
    const open = packages.some((p) => !CLOSED.has(String(p.status ?? p.shipmentPackageStatus)));
    const status = packages.length === 1 ? String(first.status ?? first.shipmentPackageStatus ?? '') : open ? 'Open' : String(first.status ?? '');
    const itemLines = lines.map((l) => `• ${l.quantity ?? 1} × ${l.productName}${l.productSize || l.productColor ? ` (${[l.productColor, l.productSize].filter(Boolean).join(' / ')})` : ''} — ${money(l.amount ?? l.price, cur)}`);

    this.upsertChat({
      remoteId: rid,
      name: `#${orderNumber} · ${customer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: phone || email || undefined,
      participants: [participant],
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id: orderNumber,
          status,
          statusLabel: PACKAGE_STATUS[status]?.replace(/^\S+\s/, '') ?? (status === 'Open' ? 'Açık' : status === 'Created' ? 'Oluşturuldu' : status),
          dateCreated: new Date(created).toISOString(),
          currency: cur,
          totals: { total, subtotal: gross || undefined, discount: discount || undefined },
          items: lines.map((l) => ({ title: l.productName, quantity: l.quantity, total: l.amount ?? l.price, sku: l.merchantSku, barcode: l.barcode, status: l.orderLineItemStatusName, selection: [l.productColor, l.productSize].filter(Boolean) })),
          shipping: { name: addr.fullName || customer, phone, email, address, deliveryType: first.deliveryType },
          fulfillments: packages.map((p) => ({
            packageId: p.id,
            status: p.status ?? p.shipmentPackageStatus,
            company: p.cargoProviderName,
            trackingNumber: p.cargoTrackingNumber ? String(p.cargoTrackingNumber) : undefined,
            trackingUrl: p.cargoTrackingLink,
            date: p.lastModifiedDate ? new Date(Number(p.lastModifiedDate)).toISOString() : undefined,
            estimatedDelivery: p.estimatedDeliveryEndDate ? new Date(Number(p.estimatedDeliveryEndDate)).toISOString() : undefined,
          })),
        },
      },
    });

    // 1) yeni sipariş mesajı (bir kez, müşteriden)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş #${orderNumber} — ${money(total, cur)}`,
        ...itemLines,
        `Teslimat: ${address || '—'}${first.deliveryType && first.deliveryType !== 'normal' ? ` (${first.deliveryType})` : ''}`,
        phone ? `Telefon: ${phone}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.upsertMessage({ remoteChatId: rid, remoteId: `new-${orderNumber}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) paket durum geçmişi + güncel durum (bizden, sistem olayı)
    for (const p of packages) {
      const pid = String(p.id);
      const history: J[] = p.packageHistories ?? p.packageHistory ?? [];
      const events = new Map<string, number>();
      for (const h of history) if (h.status) events.set(String(h.status), Number(h.createdDate) || created);
      const cur = String(p.status ?? p.shipmentPackageStatus ?? '');
      if (cur && !events.has(cur)) events.set(cur, Number(p.lastModifiedDate) || Date.now());
      for (const [st, when] of events) {
        if (st === 'Created') continue;
        const label = PACKAGE_STATUS[st] ?? `📦 ${st}`;
        const extra = st === 'Shipped' || st === 'AtCollectionPoint' || st === 'Delivered' ? `${p.cargoProviderName ? ` · ${p.cargoProviderName}` : ''}${p.cargoTrackingNumber ? ` · takip: ${p.cargoTrackingNumber}` : ''}${st === 'Shipped' && p.cargoTrackingLink ? `\n${p.cargoTrackingLink}` : ''}` : '';
        const multi = packages.length > 1 ? ` (paket ${pid})` : '';
        this.upsertMessage({ remoteChatId: rid, remoteId: `pkg-${pid}-${st}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `${label}${extra}${multi}`, ts: when, status: 'sent' });
      }
    }
    return true;
  }

  /** Müşteri sorusu → sohbet (soru müşteriden, cevap bizden). Değişiklik varsa true. */
  private ingestQuestion(q: J, live: boolean): boolean {
    const id = String(q.id);
    const rid = `q-${id}`;
    const sig = JSON.stringify([q.status, q.answer?.text, q.answer?.creationDate, q.rejectedAnswer?.text, q.reportReason]);
    const prev = this.seen.get(rid);
    if (prev === sig) return this.touchSeen(rid, sig), false;
    const status = String(q.status ?? 'WAITING_FOR_ANSWER');
    // az önce cevapladık ama API hâlâ "cevap bekliyor" diyor: soruyu yeniden açma
    if (status === 'WAITING_FOR_ANSWER' && answeredRecently(prev)) return this.touchSeen(rid, prev!), false;
    this.touchSeen(rid, sig);

    const created = Number(q.creationDate) || Date.now();
    const name = (q.showUserName === false ? '' : q.userName) || 'Müşteri';
    const participant: Participant = { id: String(q.customerId ?? id), name };
    const waiting = status === 'WAITING_FOR_ANSWER';
    const product = String(q.productName ?? 'Ürün');
    // Sipariş soruları API'de YOK (ölçüm 28.09: qna yanıtında sipariş bağı yok, order-questions ucu yok) → hepsi ürün sorusu
    this.upsertChat({
      remoteId: rid,
      name: `Soru · ${shorten(product)}`,
      kind: 'direct',
      lastMessageAt: Number(q.answer?.creationDate) || created,
      link: q.webUrl || undefined,
      avatarUrl: q.imageUrl || undefined,
      participants: [participant],
      unread: !prev && waiting ? 1 : undefined,
      meta: { question: { id, status, statusLabel: QUESTION_STATUS[status] ?? status, productName: product, productMainId: q.productMainId, imageUrl: q.imageUrl, webUrl: q.webUrl, public: q.public, dateCreated: new Date(created).toISOString(), reportReason: q.reportReason } },
    });
    if (q.text) {
      this.upsertMessage({ remoteChatId: rid, remoteId: `q-${id}`, senderId: participant.id, senderName: name, fromMe: false, text: String(q.text), ts: created, status: 'delivered' }, { live: live && !prev && waiting });
    }
    if (q.answer?.text) {
      this.upsertMessage({ remoteChatId: rid, remoteId: `a-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: String(q.answer.text), ts: Number(q.answer.creationDate) || created + 1000, status: status === 'ANSWERED' ? 'delivered' : 'sent' });
    }
    if (q.rejectedAnswer?.text) {
      this.upsertMessage({ remoteChatId: rid, remoteId: `ra-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `🚫 Reddedilen cevap: ${q.rejectedAnswer.text}`, ts: Number(q.rejectedAnswer.creationDate) || created + 2000, status: 'failed' });
    }
    if (status === 'REPORTED') {
      this.upsertMessage({ remoteChatId: rid, remoteId: `rep-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `⚠️ Soru raporlandı${q.reportReason ? `: ${q.reportReason}` : ''}`, ts: prev ? Date.now() : Number(q.lastModifiedDate) || created + 3000, status: 'sent' });
    }
    return true;
  }

  /** `q-…`: Trendyol'a cevap gönder. `order-…`: yerel not (Trendyol'da alıcıya mesaj ucu yok). */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (remoteChatId.startsWith('q-')) {
      const qid = remoteChatId.slice(2);
      const body = text.trim();
      if (body.length < 10) throw new Error('Trendyol cevabı en az 10 karakter olmalı');
      if (body.length > 2000) throw new Error('Trendyol cevabı en fazla 2000 karakter olabilir');
      await this.api('POST', 'answer', undefined, { text: body }, qid);
      const now = Date.now();
      const rid = `a-${qid}`;
      this.upsertMessage({ remoteChatId, remoteId: rid, senderId: 'me', senderName: 'Ben', fromMe: true, text: body, ts: now, status: 'sent' });
      const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
      const q = (chat?.meta?.question ?? {}) as J;
      this.upsertChat({ remoteId: remoteChatId, name: chat?.name ?? remoteChatId, lastMessageAt: now, meta: { ...chat?.meta, question: { ...q, status: 'ANSWERED', statusLabel: `${QUESTION_STATUS.ANSWERED} (onay bekliyor)` } } });
      // bir sonraki yoklama API'nin kaydettiği cevabı getirince imza değişsin ve mesaj güncellensin
      this.touchSeen(remoteChatId, answeredSentinel());
      this.saveState();
      return { remoteId: rid };
    }
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
}
