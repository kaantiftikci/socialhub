import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay } from './poll-timer.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Participant } from '../model.js';

/**
 * n11 pazar yeri: siparişler yeni REST API'den, müşteri soruları klasik SOAP servisinden.
 *
 * Uçlar Eylül 2026'da doğrulandı (developer.n11.com / magazadestek.n11.com "RestAPI Sipariş Listeleme" + canlı WSDL):
 *  - Siparişler (REST): GET https://api.n11.com/rest/delivery/v1/shipmentPackages
 *      Başlıklar: `appkey`, `appsecret` (Satıcı Ofisi › Hesabım › API Hesapları). Parametreler: startDate/endDate (ms, GMT+3),
 *      status (Created|Picking|Shipped|Cancelled|Delivered|UnPacked|UnSupplied — tek değer!), orderNumber, packageIds,
 *      orderByDirection (ASC|DESC), page (0'dan), size (≤100). Limit 1000 istek/dk. Kasım 2024 öncesi siparişler dönmez.
 *      Yanıt: { content: [{ orderNumber, id, customerfullName|customerFirstName/LastName, customerEmail, shipmentPackageStatus,
 *      cargoProviderName, cargoTrackingNumber, cargoTrackingLink, lastModifiedDate, totalAmount, totalDiscountAmount,
 *      shipmentAddress{firstName,lastName,company,address1,…}, lines[{ orderLineId, productName, quantity, price, sellerDiscount,
 *      orderItemLineItemStatusName, stockCode }] }], totalPages, page, size }
 *  - Müşteri soruları (SOAP, ProductService — REST'te soru ucu YOK): https://api.n11.com/ws/productService/
 *      ad alanı http://www.n11.com/ws/schemas, soapAction boş; auth { appKey, appSecret }.
 *      GetProductQuestionList { productQuestionSearch{productId,buyerEmail,subject,status,questionDate,startDate,endDate}, pagingData{currentPage,pageSize} }
 *        → productQuestions/productQuestion { id, productId, productTitle, questionSubject, question, answer, images }
 *      GetProductQuestionDetail { productQuestionId } → productQuestion { …, fullName, email, status, questionDate, answeredDate, sellerExpose, buyerExpose }
 *      SaveProductAnswer { productQuestionId, answer } → result { status, errorCode, errorMessage }
 *
 * DOĞRULANMADI: (1) `status` verilmezse tüm durumların dönmesi (400 gelirse durum durum sorgulanır); (2) `startDate`'in sipariş
 * tarihine mi son değişikliğe mi baktığı (bu yüzden her yoklamada 14 günlük pencere kullanılır); (3) SOAP `questionDate`
 * biçimi (dd/MM/yyyy, ISO ve epoch kabul edilir) ve ProductQuestionStatus enum değerleri (cevap metni varsa "cevaplandı" sayılır);
 * (4) SOAP yetki hatasının biçimi (fault/errorCode içinde auth/appkey geçerse kimlik hatası sayılır).
 *
 * Model: sipariş → `order-<siparişNo>` sohbeti (yeni sipariş müşteriden, paket olayları bizden); soru → `q-<id>` sohbeti
 * (soru müşteriden, cevap bizden; sendText SOAP ile cevaplar). Sipariş sohbetine yazılan metin yerel nottur (alıcıya mesaj ucu yok).
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const N11_ORDERS_URL = 'https://api.n11.com/rest/delivery/v1/shipmentPackages';
export const N11_SOAP_URL = 'https://api.n11.com/ws/productService/';
export const N11_SOAP_NS = 'http://www.n11.com/ws/schemas';
export const ORDER_STATUSES = ['Created', 'Picking', 'Shipped', 'Cancelled', 'Delivered', 'UnPacked', 'UnSupplied'];

const DAY = 86_400_000;
/** Sipariş penceresi: 14 gün (startDate'in hangi tarihe baktığı belirsiz; geniş pencere kargo/teslim olaylarını da yakalar) */
const WINDOW = 14 * DAY - 60_000;
const PAGE_SIZE = 100;
const Q_PAGE_SIZE = 50;

export const PACKAGE_STATUS: Record<string, string> = {
  Created: '🛍️ Sipariş oluşturuldu',
  Picking: '📦 Gönderi hazırlanıyor',
  Shipped: '📦 Kargoya verildi',
  Delivered: '✅ Teslim edildi',
  UnDelivered: '⚠️ Teslim edilemedi',
  Returned: '↩️ İade edildi',
  Cancelled: '❌ İptal edildi',
  UnSupplied: '⚠️ Tedarik edilemedi',
  UnPacked: '📦 Paket bölündü',
};
const CLOSED = new Set(['Delivered', 'Cancelled', 'Returned', 'UnSupplied']);

export interface N11Config {
  appKey: string;
  appSecret: string;
}

class N11AuthError extends Error {}
class N11RateLimit extends Error {}
class N11BadRequest extends Error {}

const money = (v: unknown, cur: string) => `${Number(v ?? 0).toFixed(2).replace('.', ',')} ${cur === 'TRY' || !cur ? '₺' : cur}`;
const shorten = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Token dosyasındaki JSON'u çözümler; alan eksikse undefined. */
export function parseConfig(raw: string): N11Config | undefined {
  try {
    const j = JSON.parse(raw) as J;
    const appKey = String(j.appKey ?? j.appkey ?? j.apiKey ?? '').trim();
    const appSecret = String(j.appSecret ?? j.appsecret ?? j.apiSecret ?? '').trim();
    if (!appKey || !appSecret) return undefined;
    return { appKey, appSecret };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ SOAP yardımcıları (kütüphanesiz)

export const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const xmlUnescape = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** `<[ns:]name …>…</[ns:]name>` bloklarının iç metinleri (ad alanı öneki ne olursa olsun) */
export function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

/** İlk `<name>` alanının çözümlenmiş metni; yoksa undefined (boş/nil öğe → undefined) */
export function xmlText(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  if (!m) return undefined;
  const t = xmlUnescape(m[1]).trim();
  return t ? t : undefined;
}

/** dd/MM/yyyy[ HH:mm[:ss]], ISO ya da epoch (ms/sn) → ms; çözülemezse undefined */
export function parseDate(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  const tr = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (tr) return new Date(Number(tr[3]), Number(tr[2]) - 1, Number(tr[1]), Number(tr[4] ?? 0), Number(tr[5] ?? 0), Number(tr[6] ?? 0)).getTime();
  if (/^\d+$/.test(s)) return parseDate(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

interface QuestionRec {
  id: string;
  productId?: string;
  productTitle?: string;
  subject?: string;
  question?: string;
  answer?: string;
  fullName?: string;
  email?: string;
  status?: string;
  questionDate?: number;
  answeredDate?: number;
  /** son yoklamadaki liste imzası (soru+cevap metni) */
  listSig?: string;
}

interface State {
  seen: Record<string, string>;
  questions: Record<string, QuestionRec>;
  /** `status` parametresiz istek 400 verdiyse durum durum sorgula */
  perStatus?: boolean;
}

export class N11Connector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON orders:true); kapalıysa yalnız müşteri soruları/mesajları */
  private ordersOn = false;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private cfg?: N11Config;
  private state: State = { seen: {}, questions: {} };
  private stateFile: string;
  private soapWarned = false;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string) {
    super(account, store);
    this.cfg = parseConfig(config);
    this.ordersOn = ordersFlag(config);
    this.stateFile = path.join(sessionDir(account.id), 'n11-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>;
      this.state = { seen: st.seen ?? {}, questions: st.questions ?? {}, perStatus: st.perStatus };
    } catch {
      /* ilk çalıştırma */
    }
  }

  // ------------------------------------------------------------------ istekler

  /** REST: 401/403 kimlik, 429 limit, 400 (status parametresi) ayrı sınıf; gövde JSON değilse {raw} */
  private async rest(query: Record<string, string | number>): Promise<J> {
    const c = this.cfg!;
    const url = N11_ORDERS_URL + '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const r = await fetch(url, { method: 'GET', headers: { appkey: c.appKey, appsecret: c.appSecret, accept: 'application/json' } });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new N11AuthError('n11 kimlik bilgileri reddedildi');
    if (r.status === 429) throw new N11RateLimit(`n11 istek limiti (429); ${r.headers.get('retry-after') ?? '60'} sn sonra`);
    if (r.status === 400) throw new N11BadRequest(`n11 400: ${text.slice(0, 160)}`);
    if (!r.ok) throw new Error(`n11 ${r.status} shipmentPackages: ${text.slice(0, 160)}`);
    if (!text) return {};
    try {
      return JSON.parse(text) as J;
    } catch {
      return { raw: text };
    }
  }

  /** SOAP zarfı üretir, gönderir, yanıt gövdesini (XML dizesi) döndürür; fault/failure → hata */
  private async soap(op: string, bodyXml: string): Promise<string> {
    const c = this.cfg!;
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sch="${N11_SOAP_NS}"><soapenv:Header/><soapenv:Body>` +
      `<sch:${op}Request><sch:auth><sch:appKey>${xmlEscape(c.appKey)}</sch:appKey><sch:appSecret>${xmlEscape(c.appSecret)}</sch:appSecret></sch:auth>` +
      bodyXml +
      `</sch:${op}Request></soapenv:Body></soapenv:Envelope>`;
    const r = await fetch(N11_SOAP_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '""', accept: 'text/xml' }, body: envelope });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new N11AuthError('n11 kimlik bilgileri reddedildi');
    if (r.status === 429) throw new N11RateLimit(`n11 istek limiti (429); ${r.headers.get('retry-after') ?? '60'} sn sonra`);
    const fault = xmlText(text, 'faultstring');
    if (fault) throw this.soapError(op, fault, xmlText(text, 'faultcode'));
    if (!r.ok) throw new Error(`n11 SOAP ${op} ${r.status}: ${text.slice(0, 160)}`);
    const result = xmlBlocks(text, 'result')[0];
    if (result && /failure|error/i.test(xmlText(result, 'status') ?? '')) {
      throw this.soapError(op, xmlText(result, 'errorMessage') ?? 'başarısız', xmlText(result, 'errorCode'));
    }
    return text;
  }

  private soapError(op: string, message: string, code?: string): Error {
    const blob = `${code ?? ''} ${message}`;
    if (/auth|appkey|appsecret|yetki|unauthori|credential|kimlik/i.test(blob)) return new N11AuthError(`n11 kimlik bilgileri reddedildi (${message})`);
    return new Error(`n11 ${op}: ${message}${code ? ` [${code}]` : ''}`);
  }

  // ------------------------------------------------------------------ yaşam döngüsü

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.cfg) return this.setStatus('error', 'n11 App Key / App Secret girilmedi');
    if (!this.account.label || this.account.label === 'n11') this.account.label = `n11 · ${this.cfg.appKey.slice(0, 8)}…`;
    this.setStatus('connecting');
    try {
      await this.poll(true);
      this.setStatus('connected', `App Key ${this.cfg.appKey.slice(0, 8)}…`);
      this.timer?.stop();
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay(45_000, 90_000)).start();
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
    const seenEntries = Object.entries(this.state.seen).slice(-4000);
    const keep = new Set(seenEntries.filter(([k]) => k.startsWith('q-')).map(([k]) => k.slice(2)));
    const questions: Record<string, QuestionRec> = {};
    for (const [k, v] of Object.entries(this.state.questions)) if (keep.has(k)) questions[k] = v;
    this.state = { seen: Object.fromEntries(seenEntries), questions, perStatus: this.state.perStatus };
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) {
      bus.log('warn', `n11 durum dosyası yazılamadı: ${(e as Error).message}`);
    }
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      const now = Date.now();
      // REST ve SOAP ayrı servisler: biri çökerse öteki yine işlensin
      // sipariş sohbetleri isteğe bağlı (varsayılan kapalı: yalnız müşteri soruları)
      const [ro, rq] = await Promise.allSettled([this.ordersOn ? this.fetchOrders(now - WINDOW, now, first ? 50 : 5) : Promise.resolve(new Map<string, J[]>()), this.fetchQuestions(first ? 10 : 2)]);
      for (const r of [ro, rq]) if (r.status === 'rejected' && r.reason instanceof N11AuthError) throw r.reason;
      const orders = ro.status === 'fulfilled' ? ro.value : new Map<string, J[]>();
      const questions = rq.status === 'fulfilled' ? rq.value : [];
      let failed: Error | undefined;
      for (const r of [ro, rq]) {
        if (r.status !== 'rejected') continue;
        bus.log('warn', `n11 yoklama: ${(r.reason as Error).message}`);
        if (!(r.reason instanceof N11RateLimit)) failed = r.reason as Error;
      }
      let changedOrders = 0;
      // eskiden yeniye: sohbet listesi sırası doğru kurulsun
      const groups = [...orders.values()].sort((a, b) => this.orderDate(a[0]) - this.orderDate(b[0]));
      for (const group of groups) if (this.ingestOrder(group, !first)) changedOrders++;
      let changedQuestions = 0;
      for (const q of questions) if (this.ingestQuestion(q, !first)) changedQuestions++;
      if (changedOrders || changedQuestions || first) {
        bus.log('info', `n11: ${orders.size} sipariş (${changedOrders} güncellendi), ${questions.length} soru (${changedQuestions} güncellendi)`);
      }
      this.saveState();
      if (first && failed && ro.status === 'rejected' && rq.status === 'rejected') throw failed;
    } catch (e) {
      if (e instanceof N11AuthError) {
        if (first) throw e;
        this.setStatus('error', e.message);
        this.timer?.stop();
        return;
      }
      if (first) throw e;
      bus.log('warn', `n11 yoklama: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------ siparişler

  private orderDate(p: J): number {
    return parseDate(p.orderDate ?? p.createdDate ?? p.orderCreatedDate ?? (p.packageHistories ?? [])[0]?.createdDate) ?? parseDate(p.lastModifiedDate) ?? Date.now();
  }

  /** Paketleri sayfalı çeker, orderNumber'a göre gruplar. `status`suz istek 400 verirse durum durum sorgular. */
  private async fetchOrders(startDate: number, endDate: number, maxPages: number): Promise<Map<string, J[]>> {
    const groups = new Map<string, J[]>();
    const add = (p: J) => {
      const key = String(p.orderNumber ?? p.id);
      const g = groups.get(key) ?? [];
      // aynı paket iki listede gelirse tekrarlama
      if (!g.some((x) => String(x.id) === String(p.id))) g.push(p);
      groups.set(key, g);
    };
    const pages = async (status?: string) => {
      for (let page = 0; page < maxPages; page++) {
        const q: Record<string, string | number> = { startDate, endDate, page, size: PAGE_SIZE, orderByDirection: 'DESC' };
        if (status) q.status = status;
        const data = await this.rest(q);
        const list: J[] = Array.isArray(data.content) ? data.content : Array.isArray(data.shipmentPackages) ? data.shipmentPackages : [];
        for (const p of list) add(p);
        const totalPages = Number(data.totalPages ?? data.pageCount ?? 1);
        if (page + 1 >= totalPages || list.length < PAGE_SIZE) break;
      }
    };
    if (!this.state.perStatus) {
      try {
        await pages();
        return groups;
      } catch (e) {
        if (!(e instanceof N11BadRequest)) throw e;
        bus.log('warn', `n11: status parametresiz sipariş listesi 400 döndü, durum durum sorgulanacak (${e.message})`);
        this.state.perStatus = true;
      }
    }
    for (const st of ORDER_STATUSES) await pages(st);
    return groups;
  }

  /** Aynı siparişin paketleri → tek sohbet + olay mesajları. Değişiklik varsa true. */
  private ingestOrder(packages: J[], live: boolean): boolean {
    const first = packages[0];
    const orderNumber = String(first.orderNumber ?? first.id);
    const rid = `order-${orderNumber}`;
    const statusOf = (p: J) => String(p.shipmentPackageStatus ?? p.status ?? '');
    const sig = JSON.stringify(packages.map((p) => [p.id, statusOf(p), p.cargoTrackingNumber, (p.lines ?? []).map((l: J) => l.orderItemLineItemStatusName ?? l.status)]));
    const prev = this.state.seen[rid];
    if (prev === sig) return false;
    this.state.seen[rid] = sig;

    const addr: J = first.shipmentAddress ?? {};
    const addrName = [addr.firstName, addr.lastName].filter(Boolean).join(' ') || addr.fullName;
    const customer = String(first.customerfullName ?? first.customerFullName ?? [first.customerFirstName, first.customerLastName].filter(Boolean).join(' ') ?? '') || addrName || 'Müşteri';
    const lines: J[] = packages.flatMap((p) => p.lines ?? []);
    const cur = String(first.currencyCode ?? lines[0]?.currencyCode ?? 'TRY');
    const created = this.orderDate(first);
    const total = packages.reduce((s, p) => s + Number(p.totalAmount ?? p.totalPrice ?? 0), 0);
    const discount = packages.reduce((s, p) => s + Number(p.totalDiscountAmount ?? p.totalDiscount ?? 0), 0);
    const address = [addr.address1 ?? addr.address ?? addr.fullAddress, addr.address2, addr.neighborhood, addr.district, addr.city].filter(Boolean).join(', ');
    const email = (first.customerEmail ?? addr.email) as string | undefined;
    const phone = (addr.gsm ?? addr.phone ?? addr.phoneNumber ?? first.customerPhone) as string | undefined;
    const participant: Participant = { id: String(first.customerId ?? email ?? orderNumber), name: customer, handle: phone || email || undefined };
    const open = packages.some((p) => !CLOSED.has(statusOf(p)));
    const status = packages.length === 1 ? statusOf(first) : open ? 'Open' : statusOf(first);
    const lineTotal = (l: J) => Number(l.totalAmount ?? l.amount ?? l.dueAmount ?? l.price ?? 0);
    const itemLines = lines.map((l) => `• ${l.quantity ?? 1} × ${l.productName ?? l.title ?? l.stockCode ?? 'Ürün'}${l.productColor || l.productSize ? ` (${[l.productColor, l.productSize].filter(Boolean).join(' / ')})` : ''} — ${money(lineTotal(l), cur)}`);

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
          statusLabel: PACKAGE_STATUS[status]?.replace(/^\S+\s/, '') ?? (status === 'Open' ? 'Açık' : status),
          dateCreated: new Date(created).toISOString(),
          currency: cur,
          totals: { total, discount: discount || undefined },
          items: lines.map((l) => ({ title: l.productName ?? l.title ?? l.stockCode ?? 'Ürün', quantity: l.quantity ?? 1, total: lineTotal(l), sku: l.stockCode ?? l.sellerStockCode, status: l.orderItemLineItemStatusName ?? l.status, selection: [l.productColor, l.productSize].filter(Boolean), lineId: l.orderLineId })),
          shipping: { name: addrName || customer, phone, email, address, company: addr.company || undefined },
          fulfillments: packages.map((p) => ({
            packageId: p.id,
            status: statusOf(p),
            company: p.cargoProviderName,
            trackingNumber: p.cargoTrackingNumber ? String(p.cargoTrackingNumber) : undefined,
            trackingUrl: p.cargoTrackingLink || undefined,
            date: parseDate(p.lastModifiedDate) ? new Date(parseDate(p.lastModifiedDate)!).toISOString() : undefined,
          })),
        },
      },
    });

    // 1) yeni sipariş mesajı (bir kez, müşteriden)
    if (!prev) {
      const text = [`🛍️ Yeni sipariş #${orderNumber} — ${money(total, cur)}`, ...itemLines, `Teslimat: ${address || '—'}`, phone ? `Telefon: ${phone}` : ''].filter(Boolean).join('\n');
      this.upsertMessage({ remoteChatId: rid, remoteId: `new-${orderNumber}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) paket durumu (bizden, sistem olayı); Created yeni sipariş mesajıyla zaten anlatılıyor
    for (const p of packages) {
      const pid = String(p.id);
      const st = statusOf(p);
      if (!st || st === 'Created') continue;
      const label = PACKAGE_STATUS[st] ?? `📦 ${st}`;
      const extra = st === 'Shipped' || st === 'Delivered' ? `${p.cargoProviderName ? ` · ${p.cargoProviderName}` : ''}${p.cargoTrackingNumber ? ` · takip: ${p.cargoTrackingNumber}` : ''}${st === 'Shipped' && p.cargoTrackingLink ? `\n${p.cargoTrackingLink}` : ''}` : '';
      const multi = packages.length > 1 ? ` (paket ${pid})` : '';
      this.upsertMessage({ remoteChatId: rid, remoteId: `pkg-${pid}-${st}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `${label}${extra}${multi}`, ts: parseDate(p.lastModifiedDate) ?? Date.now(), status: 'sent' });
    }
    return true;
  }

  // ------------------------------------------------------------------ müşteri soruları (SOAP)

  /** Liste + (değişenler için) ayrıntı. Liste imzası aynıysa ayrıntı yeniden çekilmez. */
  private async fetchQuestions(maxPages: number): Promise<QuestionRec[]> {
    const out: QuestionRec[] = [];
    let detailBudget = 20;
    for (let page = 0; page < maxPages; page++) {
      const xml = await this.soap('GetProductQuestionList', `<sch:productQuestionSearch/><sch:pagingData><sch:currentPage>${page}</sch:currentPage><sch:pageSize>${Q_PAGE_SIZE}</sch:pageSize></sch:pagingData>`);
      const items = xmlBlocks(xml, 'productQuestion');
      for (const it of items) {
        const id = xmlText(it, 'id');
        if (!id) continue;
        const listSig = JSON.stringify([xmlText(it, 'question'), xmlText(it, 'answer')]);
        const prev = this.state.questions[id];
        let rec: QuestionRec = { ...(prev ?? { id }), productId: xmlText(it, 'productId') ?? prev?.productId, productTitle: xmlText(it, 'productTitle') ?? prev?.productTitle, subject: xmlText(it, 'questionSubject') ?? prev?.subject, question: xmlText(it, 'question') ?? prev?.question, answer: xmlText(it, 'answer') ?? prev?.answer };
        if ((prev?.listSig !== listSig || !prev?.questionDate) && detailBudget > 0) {
          detailBudget--;
          try {
            const dx = await this.soap('GetProductQuestionDetail', `<sch:productQuestionId>${xmlEscape(id)}</sch:productQuestionId>`);
            const d = xmlBlocks(dx, 'productQuestion')[0] ?? dx;
            rec = { ...rec, fullName: xmlText(d, 'fullName') ?? rec.fullName, email: xmlText(d, 'email') ?? rec.email, status: xmlText(d, 'status') ?? rec.status, questionDate: parseDate(xmlText(d, 'questionDate')) ?? rec.questionDate, answeredDate: parseDate(xmlText(d, 'answeredDate')) ?? rec.answeredDate, answer: xmlText(d, 'answer') ?? rec.answer, question: xmlText(d, 'question') ?? rec.question };
          } catch (e) {
            if (e instanceof N11AuthError) throw e;
            bus.log('warn', `n11 soru ayrıntısı #${id}: ${(e as Error).message}`);
          }
        }
        rec.listSig = listSig;
        this.state.questions[id] = rec;
        out.push(rec);
      }
      const pageCount = Number(xmlText(xml, 'pageCount') ?? 1);
      if (page + 1 >= pageCount || items.length < Q_PAGE_SIZE) break;
    }
    // eskiden yeniye
    return out.sort((a, b) => (a.questionDate ?? 0) - (b.questionDate ?? 0));
  }

  /** Soru → sohbet (soru müşteriden, cevap bizden). Değişiklik varsa true. */
  private ingestQuestion(q: QuestionRec, live: boolean): boolean {
    const rid = `q-${q.id}`;
    const answered = !!q.answer || /answered|cevaplan/i.test(q.status ?? '');
    const sig = JSON.stringify([q.question, q.answer, q.status, q.answeredDate]);
    const prev = this.state.seen[rid];
    if (prev === sig) return false;
    this.state.seen[rid] = sig;

    const created = q.questionDate ?? Date.now();
    const name = q.fullName || 'Müşteri';
    const participant: Participant = { id: q.email || `q-${q.id}`, name, handle: q.email || undefined };
    const product = q.productTitle || 'Ürün';
    const status = answered ? 'ANSWERED' : 'WAITING_FOR_ANSWER';
    this.upsertChat({
      remoteId: rid,
      name: `Soru · ${shorten(product)}`,
      kind: 'direct',
      lastMessageAt: q.answeredDate ?? created,
      link: q.productId ? `https://www.n11.com/urun/${q.productId}` : undefined,
      participants: [participant],
      unread: !prev && !answered ? 1 : undefined,
      meta: { question: { id: q.id, status, statusLabel: answered ? 'Cevaplandı' : 'Cevap bekliyor', rawStatus: q.status, productName: product, productId: q.productId, subject: q.subject, dateCreated: new Date(created).toISOString(), buyerEmail: q.email } },
    });
    if (q.question) {
      const text = q.subject ? `${q.subject}\n${q.question}` : q.question;
      this.upsertMessage({ remoteChatId: rid, remoteId: `q-${q.id}`, senderId: participant.id, senderName: name, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && !prev && !answered });
    }
    if (q.answer) {
      this.upsertMessage({ remoteChatId: rid, remoteId: `a-${q.id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: q.answer, ts: q.answeredDate ?? created + 1000, status: 'delivered' });
    }
    return true;
  }

  // ------------------------------------------------------------------ gönderim

  /** `q-…`: SaveProductAnswer ile n11'e cevap. `order-…`: yerel not (n11'de alıcıya mesaj ucu yok). */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (remoteChatId.startsWith('q-')) {
      const qid = remoteChatId.slice(2);
      const body = text.trim();
      if (!body) throw new Error('n11 cevabı boş olamaz');
      try {
        await this.soap('SaveProductAnswer', `<sch:productQuestionId>${xmlEscape(qid)}</sch:productQuestionId><sch:answer>${xmlEscape(body)}</sch:answer>`);
      } catch (e) {
        if (e instanceof N11AuthError) this.setStatus('error', e.message);
        throw e;
      }
      const now = Date.now();
      const rid = `a-${qid}`;
      this.upsertMessage({ remoteChatId, remoteId: rid, senderId: 'me', senderName: 'Ben', fromMe: true, text: body, ts: now, status: 'sent' });
      const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
      const q = (chat?.meta?.question ?? {}) as J;
      this.upsertChat({ remoteId: remoteChatId, name: chat?.name ?? remoteChatId, lastMessageAt: now, meta: { ...chat?.meta, question: { ...q, status: 'ANSWERED', statusLabel: 'Cevaplandı' } } });
      // sonraki yoklama API'nin kaydettiği cevabı getirince imza değişsin, ayrıntı yeniden çekilsin
      delete this.state.seen[remoteChatId];
      if (this.state.questions[qid]) this.state.questions[qid].listSig = undefined;
      this.saveState();
      bus.log('info', `n11: soru #${qid} cevaplandı`);
      return { remoteId: rid };
    }
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
}
