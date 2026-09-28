import fs from 'node:fs';
import path from 'node:path';
import { BaseConnector, type StartOptions } from './base.js';
import type { Participant } from '../model.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { PollTimer, marketDelay } from './poll-timer.js';
import { xmlBlocks, xmlEscape, xmlText } from './n11.js';

/**
 * ePttAVM (PTT AVM) satıcı entegrasyonu — YALNIZ SİPARİŞLER (API'de müşteri sorusu/mesaj ucu yok; WSDL'deki 35 işlemin hiçbiri).
 *   SOAP 1.1 (WCF) https://ws.pttavm.com:93/service.svc, SOAPAction http://tempuri.org/IService/<İşlem>, ad alanı http://tempuri.org/.
 *   Kimlik: WS-Security UsernameToken (satıcı panelindeki entegrasyon kullanıcı adı + şifresi).
 *   SiparisKontrolListesiV2(BaslangicTarihi, BitisTarihi, AktifSiparisler) → TedarikciSiparisKontrolV2[] (SiparisNo, IslemTarihi,
 *   MusteriAdi/Soyadi, SiparisAdresi/Ili/Ilce, TelefonNo, Eposta, KargoBarkod, SiparisUrunler[SiparisUrun: Urun, UrunKodu,
 *   ToplamIslemAdedi, KdvDahilToplamTutar, SiparisDurumu (metin), SiparisNotu, LineItemId]).
 *   Kaynak: WSDL'den üretilmiş istemci + resmi ePttAVM/api-client (PHP). Servis yavaş (resmi istemci 90-120 sn zaman aşımı).
 *   Resmi istemciler TLS doğrulamasını kapatıyor; burada KAPATILMAZ (kimlik bilgisi gidiyor) — sertifika hatasında açık hata verilir.
 * Token dosyası JSON { username, password, ordersOff? }.
 */
const PTT_URL = process.env.MIVELO_PTTAVM_URL ?? 'https://ws.pttavm.com:93/service.svc';
const NS = 'http://tempuri.org/';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const MAX_STORED = 2000;

type J = Record<string, string | undefined>;
interface Cfg {
  username: string;
  password: string;
}
interface OrderRec {
  no: string;
  date: number;
  customer: string;
  phone?: string;
  email?: string;
  address: string;
  cargo?: string;
  items: Array<{ title: string; qty: number; total: number; sku?: string; status: string; note?: string; lineId?: string }>;
}

export class PttAvmAuthError extends Error {}

export function parsePttConfig(raw: string): Cfg | undefined {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const username = String(j.username ?? '').trim();
    const password = String(j.password ?? '');
    return username && password ? { username, password } : undefined;
  } catch {
    return undefined;
  }
}

/** ePttAVM ürün satırı durumu (Türkçe metin) → ortak kod (arayüz açık/kapalı sipariş ayrımı ORDER_CLOSED ile) */
export function pttStatus(s: string | undefined): { code: string; label: string } {
  const t = (s ?? '').trim();
  const l = t.toLocaleLowerCase('tr'); // "İptal" → "iptal" (JS /i Türkçe İ'yi i saymaz)
  if (/iptal/.test(l)) return { code: 'Cancelled', label: t || 'İptal' };
  if (/iade/.test(l)) return { code: 'Returned', label: t || 'İade' };
  if (/teslim edil/.test(l)) return { code: 'Delivered', label: t };
  if (/kargo|gönderil|sevk|yolda/.test(l)) return { code: 'Shipped', label: t };
  return { code: 'Created', label: t || 'Yeni' };
}

const num = (s: string | undefined) => {
  const n = Number(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const money = (n: number) => `${n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;

/** TedarikciSiparisKontrolV2 XML bloğu → sipariş kaydı */
export function parsePttOrder(xml: string): OrderRec | undefined {
  const no = xmlText(xml, 'SiparisNo');
  if (!no) return undefined;
  const t = Date.parse(xmlText(xml, 'IslemTarihi') ?? '');
  const items = xmlBlocks(xml, 'SiparisUrun').map((u) => ({
    title: xmlText(u, 'Urun') ?? xmlText(u, 'UrunAdi') ?? 'Ürün',
    qty: num(xmlText(u, 'ToplamIslemAdedi')) || 1,
    total: num(xmlText(u, 'KdvDahilToplamTutar')),
    sku: xmlText(u, 'UrunBarkod') ?? xmlText(u, 'VariantBarkod') ?? undefined,
    status: xmlText(u, 'SiparisDurumu') ?? '',
    note: xmlText(u, 'SiparisNotu') ?? undefined,
    lineId: xmlText(u, 'LineItemId') ?? undefined,
  }));
  if (!items.length) items.push({ title: xmlText(xml, 'UrunAdi') ?? 'Ürün', qty: 1, total: 0, sku: xmlText(xml, 'UrunKodu') ?? undefined, status: '', note: undefined, lineId: undefined });
  return {
    no,
    date: Number.isFinite(t) ? t : Date.now(),
    customer: [xmlText(xml, 'MusteriAdi'), xmlText(xml, 'MusteriSoyadi')].filter(Boolean).join(' ') || 'Müşteri',
    phone: xmlText(xml, 'TelefonNo') || undefined,
    email: xmlText(xml, 'Eposta') || undefined,
    address: [xmlText(xml, 'SiparisAdresi'), xmlText(xml, 'SiparisIlce'), xmlText(xml, 'SiparisIli')].filter(Boolean).join(', '),
    cargo: xmlText(xml, 'KargoBarkod') || undefined,
    items,
  };
}

export class PttAvmConnector extends BaseConnector {
  private cfg?: Cfg;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private seen: Record<string, string> = {};
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], config: string) {
    super(account, store);
    this.cfg = parsePttConfig(config);
    this.stateFile = path.join(sessionDir(account.id), 'pttavm-state.json');
    try {
      this.seen = (JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { seen?: Record<string, string> }).seen ?? {};
    } catch {
      /* ilk çalıştırma */
    }
  }

  private async soap(op: string, bodyXml: string): Promise<string> {
    const c = this.cfg!;
    const envelope =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="${NS}">` +
      `<soap:Header><wsse:Security xmlns:wsse="${WSSE}"><wsse:UsernameToken><wsse:Username>${xmlEscape(c.username)}</wsse:Username>` +
      `<wsse:Password>${xmlEscape(c.password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header>` +
      `<soap:Body><tem:${op}>${bodyXml}</tem:${op}></soap:Body></soap:Envelope>`;
    let r: Response;
    try {
      r = await fetch(PTT_URL, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${NS}IService/${op}"`, accept: 'text/xml' },
        body: envelope,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      if (cause?.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause.code)) throw new Error(`ePttAVM sunucusunun TLS sertifikası doğrulanamadı (${cause.code}); güvenlik için bağlantı kurulmadı`);
      throw new Error(`ePttAVM'e ulaşılamadı: ${cause?.message ?? (e as Error).message}`);
    }
    const text = await r.text();
    const fault = xmlText(text, 'faultstring') ?? xmlText(text, 'Text');
    if (r.status === 401 || r.status === 403 || (fault && /auth|yetki|kullanıcı|şifre|parola|security|kimlik|credential|unauthori/i.test(fault))) {
      throw new PttAvmAuthError(`ePttAVM kimlik bilgileri reddedildi${fault ? ` (${fault.slice(0, 120)})` : ''}`);
    }
    if (fault) throw new Error(`ePttAVM ${op}: ${fault.slice(0, 200)}`);
    if (!r.ok) throw new Error(`ePttAVM ${op} ${r.status}: ${text.slice(0, 160)}`);
    return text;
  }

  private async fetchOrders(start: number, end: number): Promise<OrderRec[]> {
    const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const xml = await this.soap('SiparisKontrolListesiV2', `<tem:BaslangicTarihi>${iso(start)}</tem:BaslangicTarihi><tem:BitisTarihi>${iso(end)}</tem:BitisTarihi><tem:AktifSiparisler>0</tem:AktifSiparisler>`);
    return xmlBlocks(xml, 'TedarikciSiparisKontrolV2')
      .map(parsePttOrder)
      .filter((o): o is OrderRec => !!o);
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.cfg) return this.setStatus('error', 'ePttAVM entegrasyon kullanıcı adı / şifresi girilmedi');
    if (!this.account.label || /^pttavm$|^ePttAVM$/i.test(this.account.label)) this.account.label = `ePttAVM · ${this.cfg.username}`;
    this.setStatus('connecting');
    try {
      await this.poll(true);
      this.setStatus('connected', `Kullanıcı ${this.cfg.username}`);
      this.timer?.stop();
      // servis yavaş ve siparişler dakikalık değişmiyor: 90 sn / boşta 3 dk
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay(90_000, 180_000)).start();
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.stop();
    this.setStatus('disconnected');
  }

  async sendText(): Promise<{ remoteId: string }> {
    throw new Error('ePttAVM API’sinde alıcıya mesaj ucu yok');
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      const now = Date.now();
      // ilk eşitleme geriye 4 hafta (haftalık dilimler), sonra son 3 gün
      const spans: Array<[number, number]> = first ? Array.from({ length: 4 }, (_, i) => [now - (i + 1) * WINDOW, now - i * WINDOW]) : [[now - 3 * DAY, now]];
      const byNo = new Map<string, OrderRec>();
      for (const [a, b] of spans) for (const o of await this.fetchOrders(a, b)) if (!byNo.has(o.no)) byNo.set(o.no, o);
      let changed = 0;
      for (const o of [...byNo.values()].sort((x, y) => x.date - y.date)) if (this.ingest(o, !first)) changed++;
      if (changed || first) bus.log('info', `ePttAVM: ${byNo.size} sipariş (${changed} güncellendi)`);
      const keep = Object.entries(this.seen).slice(-MAX_STORED);
      this.seen = Object.fromEntries(keep);
      try {
        fs.writeFileSync(this.stateFile, JSON.stringify({ seen: this.seen }));
      } catch {
        /* disk */
      }
    } catch (e) {
      if (first) throw e;
      if (e instanceof PttAvmAuthError) {
        this.setStatus('error', e.message);
        this.timer?.stop();
        return;
      }
      bus.log('warn', `ePttAVM yoklama: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Sipariş → sohbet (sipariş sayfası) + olay mesajları. Değişiklik varsa true. */
  private ingest(o: OrderRec, live: boolean): boolean {
    const rid = `order-${o.no}`;
    const sts = o.items.map((i) => pttStatus(i.status));
    const sig = JSON.stringify([o.items.map((i) => i.status), o.cargo]);
    const prev = this.seen[rid];
    if (prev === sig) return false;
    this.seen[rid] = sig;
    const open = sts.some((s) => !/^(Delivered|Cancelled|Returned|Shipped)$/.test(s.code));
    const main = sts.find((s) => s.code === 'Created') ?? sts[0] ?? pttStatus('');
    const total = o.items.reduce((n, i) => n + i.total, 0);
    const participant: Participant = { id: o.email || o.phone || `ptt-${o.no}`, name: o.customer, handle: o.phone || o.email || undefined };
    this.upsertChat({
      remoteId: rid,
      name: `#${o.no} · ${o.customer}`,
      kind: 'direct',
      lastMessageAt: o.date,
      handle: participant.handle,
      participants: [participant],
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id: o.no,
          status: open ? main.code : (sts[0]?.code ?? main.code),
          statusLabel: open ? main.label : (sts[0]?.label ?? main.label),
          dateCreated: new Date(o.date).toISOString(),
          currency: 'TRY',
          totals: { total },
          items: o.items.map((i) => ({ title: i.title, quantity: i.qty, total: i.total, sku: i.sku, status: i.status, lineId: i.lineId })),
          shipping: { name: o.customer, phone: o.phone, email: o.email, address: o.address },
          fulfillments: o.cargo ? [{ packageId: o.no, status: sts[0]?.code ?? '', trackingNumber: o.cargo }] : [],
          note: o.items.map((i) => i.note).filter(Boolean).join(' · ') || undefined,
        },
      },
    });
    if (!prev) {
      const lines = o.items.map((i) => `• ${i.qty} × ${i.title} — ${money(i.total)}`);
      const text = [`🛍️ Yeni sipariş #${o.no} — ${money(total)}`, ...lines, `Teslimat: ${o.address || '—'}`, o.phone ? `Telefon: ${o.phone}` : ''].filter(Boolean).join('\n');
      this.upsertMessage({ remoteChatId: rid, remoteId: `new-${o.no}`, senderId: participant.id, senderName: o.customer, fromMe: false, text, ts: o.date, status: 'delivered' }, { live: live && open });
    }
    const st = sts[0];
    if (st && st.code !== 'Created') {
      const icon = st.code === 'Shipped' ? '📦' : st.code === 'Delivered' ? '✅' : st.code === 'Cancelled' ? '❌' : '↩';
      this.upsertMessage({ remoteChatId: rid, remoteId: `st-${o.no}-${st.code}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: `${icon} ${st.label}${o.cargo && st.code === 'Shipped' ? ` · takip: ${o.cargo}` : ''}`, ts: Date.now(), status: 'sent' });
    }
    return true;
  }
}
