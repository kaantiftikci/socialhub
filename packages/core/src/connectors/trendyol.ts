import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay } from './poll-timer.js';
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
  questions(sellerId: string): string;
  answer(sellerId: string, questionId: string): string;
}

/** Sıra önemli: ilk eleman güncel ağ geçidi; 404/410 durumunda bir sonrakine geçilir. */
export const GATEWAYS: Gateway[] = [
  {
    name: 'apigw',
    orders: (s) => `https://apigw.trendyol.com/integration/order/sellers/${s}/orders`,
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
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string) {
    super(account, store);
    this.cfg = parseConfig(config);
    this.ordersOn = ordersFlag(config);
    this.stateFile = path.join(sessionDir(account.id), 'trendyol-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { seen?: Record<string, string>; gw?: number };
      for (const [k, v] of Object.entries(st.seen ?? {})) this.seen.set(k, v);
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
  private async api(method: string, kind: 'orders' | 'questions' | 'answer', query?: Record<string, string | number>, body?: unknown, questionId?: string): Promise<J> {
    // Geçit dizini çağrı yerelinde ilerler: eşzamanlı iki çağrı 404 alınca birbirini geri çevirmesin
    let gi = this.gw;
    for (let attempt = 0; attempt < GATEWAYS.length; attempt++) {
      const g = GATEWAYS[gi];
      let url = kind === 'answer' ? g.answer(this.sellerId, encodeURIComponent(questionId ?? '')) : g[kind](this.sellerId);
      if (query) url += '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
      const r = await fetch(url, { method, headers: this.headers(body), body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (r.status === 401 || r.status === 403) throw new TrendyolAuthError('Trendyol kimlik bilgileri reddedildi');
      if (r.status === 429) throw new TrendyolRateLimit(`Trendyol istek limiti (429); ${r.headers.get('retry-after') ?? '60'} sn sonra`);
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
    if (!this.account.label || this.account.label === 'Trendyol') this.account.label = `Trendyol · ${this.sellerId}`;
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
      const startDate = now - (first ? FIRST_WINDOW : NEXT_WINDOW);
      // İki servis ayrı hız sınırına sahip: biri 429 verirse öteki yine işlensin
      // sipariş sohbetleri isteğe bağlı (varsayılan kapalı: yalnız müşteri soruları)
      const [ro, rq] = await Promise.allSettled([this.ordersOn ? this.fetchOrders(startDate, now, first ? 50 : 5) : Promise.resolve(new Map<string, J[]>()), this.fetchQuestions(startDate, now, first ? 50 : 5)]);
      for (const r of [ro, rq]) if (r.status === 'rejected' && r.reason instanceof TrendyolAuthError) throw r.reason;
      const orders = ro.status === 'fulfilled' ? ro.value : new Map<string, J[]>();
      const questions = rq.status === 'fulfilled' ? rq.value : [];
      let failed: Error | undefined;
      for (const r of [ro, rq]) {
        if (r.status !== 'rejected') continue;
        bus.log('warn', `Trendyol yoklama: ${(r.reason as Error).message}`);
        if (!(r.reason instanceof TrendyolRateLimit)) failed = r.reason as Error;
      }
      let changedOrders = 0;
      for (const group of orders.values()) if (this.ingestOrder(group, !first)) changedOrders++;
      let changedQuestions = 0;
      for (const q of questions.reverse()) if (this.ingestQuestion(q, !first)) changedQuestions++;
      if (changedOrders || changedQuestions || first) {
        bus.log('info', `Trendyol: ${orders.size} sipariş (${changedOrders} güncellendi), ${questions.length} soru (${changedQuestions} güncellendi)`);
      }
      this.saveState();
      // ilk yoklamada her iki servis de (hız sınırı dışında) çöktüyse bağlantı kurulamadı say
      if (first && failed && ro.status === 'rejected' && rq.status === 'rejected') throw failed;
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
    for (const [k, v] of [...this.seen.entries()].slice(-4000)) seen[k] = v;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ seen, gw: this.gw }));
    } catch (e) {
      bus.log('warn', `Trendyol durum dosyası yazılamadı: ${(e as Error).message}`);
    }
  }

  /** Aynı siparişin paketleri → tek sohbet + olay mesajları. Değişiklik varsa true. */
  private ingestOrder(packages: J[], live: boolean): boolean {
    const first = packages[0];
    const orderNumber = String(first.orderNumber ?? first.id);
    const rid = `order-${orderNumber}`;
    const sig = JSON.stringify(packages.map((p) => [p.id, p.status, p.shipmentPackageStatus, p.cargoTrackingNumber, (p.packageHistories ?? p.packageHistory ?? []).length, (p.lines ?? []).map((l: J) => l.orderLineItemStatusName)]));
    const prev = this.seen.get(rid);
    if (prev === sig) return false;
    this.seen.set(rid, sig);

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
    if (prev === sig) return false;
    this.seen.set(rid, sig);

    const status = String(q.status ?? 'WAITING_FOR_ANSWER');
    const created = Number(q.creationDate) || Date.now();
    const name = (q.showUserName === false ? '' : q.userName) || 'Müşteri';
    const participant: Participant = { id: String(q.customerId ?? id), name };
    const waiting = status === 'WAITING_FOR_ANSWER';
    const product = String(q.productName ?? 'Ürün');
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
      this.upsertMessage({ remoteChatId: rid, remoteId: `rep-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `⚠️ Soru raporlandı${q.reportReason ? `: ${q.reportReason}` : ''}`, ts: Date.now(), status: 'sent' });
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
      this.seen.delete(remoteChatId);
      this.saveState();
      return { remoteId: rid };
    }
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
}
