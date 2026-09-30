import fs from 'node:fs';
import path from 'node:path';
import { ordersFlag, BaseConnector, type StartOptions } from './base.js';
import { PollTimer, marketDelay } from './poll-timer.js';
import { ingestChunked, writeJsonAtomic } from './market-state.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Participant } from '../model.js';
import type { Store } from '../store.js';

/**
 * Shopify: siparişler Admin REST API (`X-Shopify-Access-Token`). Yalnız resmi API; Shopify Inbox tarayıcı köprüsü KALDIRILDI
 * (Inbox'ın açık API'si yok, otomasyon resmi değil).
 *
 * - Her sipariş bir "sohbet"tir (remoteId `order-<id>`); sipariş olayları (oluşturma, kargo, iade, iptal)
 *   mesaj olarak akar. Sohbete yazılan metin yerel not olarak tutulur.
 *
 * Kimlik (token dosyası JSON), iki yol:
 *  1) Yeni (Dev Dashboard uygulaması, 2026): { shop, clientId, clientSecret } → `POST https://{shop}/admin/oauth/access_token`
 *     (grant_type=client_credentials) ile 24 saatlik erişim belirteci; bellekte tutulur, bitmeden 10 dk önce ve 401'de bir kez
 *     yenilenir. Uygulama mağazaya kurulu olmalı; kapsamlar read_orders, read_customers, read_fulfillments.
 *  2) Eski (mağaza içi özel uygulama): { shop, accessToken: "shpat_…" } — süresiz belirteç, olduğu gibi kullanılır.
 * İkisi birden varsa istemci kimliği yolu önce gelir.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const API_VERSION = '2026-07';
/** client_credentials belirtecinin bitişinden bu kadar önce yenilenir */
const TOKEN_SKEW_MS = 10 * 60_000;

export interface ShopifyConfig {
  shop: string;
  /** Eski özel uygulama belirteci (shpat_…) */
  accessToken?: string;
  /** Dev Dashboard uygulaması: istemci kimliği + gizli anahtar (client_credentials) */
  clientId?: string;
  clientSecret?: string;
}

/** Yapılandırma metnini çöz; mağaza tanıtıcısı ve API ana bilgisayarı türetilir */
export function parseShopifyConfig(config: string): { handle: string; host: string; token: string; clientId: string; clientSecret: string } {
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
  return {
    handle,
    host: handle ? `${handle}.myshopify.com` : '',
    token: String(cfg.accessToken ?? '').trim(),
    clientId: String(cfg.clientId ?? '').trim(),
    clientSecret: String(cfg.clientSecret ?? '').trim(),
  };
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

export class ShopifyConnector extends BaseConnector {
  /** sipariş sohbetleri açık mı (token JSON; varsayılan açık, ordersOff:true kapatır) */
  private ordersOn = false;
  private timer?: PollTimer;
  private polling = false;
  private stopping = false;
  private readonly handle: string;
  private readonly host: string;
  /** eski süresiz shpat_ belirteci */
  private readonly staticToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  /** client_credentials ile alınan belirteç (bellekte) */
  private issued?: { token: string; expiresAt: number };
  /** sipariş id → son görülen durum imzası */
  private seen = new Map<string, string>();
  /** son başarılı yoklamanın başlangıcı (ISO): sonraki yoklama updated_at_min ile yalnız değişenleri alır */
  private since?: string;
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: Store, config: string) {
    super(account, store);
    ({ handle: this.handle, host: this.host, token: this.staticToken, clientId: this.clientId, clientSecret: this.clientSecret } = parseShopifyConfig(config));
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

  private get usesClientCredentials(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** Dev Dashboard uygulaması: client_credentials ile 24 saatlik belirteç (bitmeden 10 dk önce ya da `force` ile yenilenir) */
  private async accessToken(force = false): Promise<string> {
    if (!this.usesClientCredentials) return this.staticToken;
    if (!force && this.issued && this.issued.expiresAt - TOKEN_SKEW_MS > Date.now()) return this.issued.token;
    const r = await fetch(`https://${this.host}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }).toString(),
    });
    const text = await r.text();
    let j: J = {};
    try {
      j = text ? (JSON.parse(text) as J) : {};
    } catch {
      /* JSON değil */
    }
    if (!r.ok || !j.access_token) {
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new AuthError(`Shopify istemci kimliği / gizli anahtarı reddedildi (${String(j.error ?? r.status)}) — uygulama mağazaya kurulu mu?`);
      throw new Error(`Shopify belirteç ${r.status}: ${String(j.error_description ?? text).slice(0, 160)}`);
    }
    this.issued = { token: String(j.access_token), expiresAt: Date.now() + (Number(j.expires_in) || 86_399) * 1000 };
    return this.issued.token;
  }

  // ─────────── Admin REST API ───────────
  /** `p`: `/orders.json?…` biçiminde yol ya da Link başlığından gelen tam adres */
  private async api(p: string, retried = false, renewed = false): Promise<{ data: J; headers: Headers }> {
    const url = /^https?:\/\//.test(p) ? p : `https://${this.host}/admin/api/${API_VERSION}${p}`;
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': await this.accessToken(), accept: 'application/json' } });
    const text = await r.text();
    // client_credentials belirteci süresinden önce düşmüş olabilir: bir kez yenile
    if (r.status === 401 && this.usesClientCredentials && !renewed) {
      await this.accessToken(true);
      return this.api(p, retried, true);
    }
    if (r.status === 401 || r.status === 403) throw new AuthError('Shopify erişim belirteci reddedildi');
    if (r.status === 429) {
      const wait = Math.min(Math.max(Number(r.headers.get('retry-after') ?? '2') || 2, 1), 60);
      if (!retried) {
        bus.log('warn', `Shopify istek limiti (429); ${wait} sn bekleniyor`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        return this.api(p, true, renewed);
      }
      this.timer?.backoff(wait);
      throw new Error(`Shopify istek limiti; ${wait} sn sonra yeniden dene`);
    }
    if (!r.ok) throw new Error(`Shopify ${r.status} ${p.replace(/^https?:\/\/[^/]+/, '')}: ${text.slice(0, 160)}`);
    return { data: text ? (JSON.parse(text) as J) : {}, headers: r.headers };
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.host || (!this.staticToken && !this.usesClientCredentials)) return this.setStatus('error', 'Shopify mağaza adresi / istemci kimliği + gizli anahtar (ya da Admin API erişim belirteci) girilmedi');
    this.setStatus('connecting');
    try {
      await this.accessToken();
      const { data } = await this.api('/shop.json').catch((e) => {
        if (e instanceof AuthError) throw e;
        return { data: {} as J, headers: new Headers() };
      });
      const shop: J = data.shop ?? {};
      this.account.label = shop.name ?? this.handle;
      await this.poll(true);
      this.setStatus('connected', shop.email ?? undefined);
      this.timer?.stop();
      this.timer = new PollTimer(() => this.poll(false), () => marketDelay()).start();
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.stop();
    this.timer = undefined;
    this.setStatus('disconnected');
  }

  // ─────────── Sipariş yoklama ───────────
  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    if (!this.ordersOn) {
      this.polling = false;
      return; // sipariş sohbetleri kapalı
    }
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString(); // saat kayması payı
    try {
      /** Sayfalı çek; sınır dolduğunda hâlâ sonraki sayfa varsa truncated */
      const fetchPages = async (start: string, maxPages: number): Promise<{ list: J[]; truncated: boolean }> => {
        const list: J[] = [];
        let url: string | undefined = start;
        for (let page = 0; url && page < maxPages; page++) {
          const { data, headers } = await this.api(url);
          const got: J[] = Array.isArray(data.orders) ? data.orders : [];
          list.push(...got);
          url = got.length ? nextLink(headers.get('link')) : undefined;
        }
        return { list, truncated: !!url };
      };
      const byId = new Map<string, J>();
      // ilk kurulum / açılış: en yeni oluşturulan siparişler
      if (first || !this.since) for (const o of (await fetchPages('/orders.json?status=any&limit=50&order=created_at%20desc', 10)).list) byId.set(String(o.id), o);
      // kalıcı imleç varsa (açılışta da): o andan beri DEĞİŞENLER, eskiden yeniye — kapalıyken güncellenen eski sipariş kaçmasın
      let nextSince = startedAt;
      if (this.since) {
        const inc = await fetchPages(`/orders.json?status=any&limit=50&updated_at_min=${encodeURIComponent(this.since)}&order=updated_at%20asc`, 10);
        for (const o of inc.list) byId.set(String(o.id), o);
        // sayfa sınırı doldu: imleç yalnız işlenen son değişikliğe ilerler (kalanlar sonraki turda)
        const last = inc.list[inc.list.length - 1]?.updated_at;
        if (inc.truncated && last) nextSince = String(last);
      }
      const orders = [...byId.values()];
      let changed = 0;
      // eskiden yeniye: sohbet sırası ve "canlı" bildirimler doğru olsun
      orders.sort((a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0));
      const done = await ingestChunked(this.store, orders, (o) => {
        if (this.ingest(o, !first)) changed++;
      }, () => this.stopping);
      if (!done) return; // durduruldu: imleç ilerlemesin
      if (changed) bus.log('info', `Shopify: ${changed} sipariş güncellendi`);
      const moved = nextSince !== startedAt;
      this.since = nextSince;
      // durum dosyası yalnız değişince (dosyadaki eski since yalnız daha geniş aralık ister, kayıp olmaz)
      if (changed || first || moved) this.saveState();
    } catch (e) {
      if (e instanceof AuthError) {
        this.timer?.stop();
        this.timer = undefined;
        if (!first) this.setStatus('error', e.message);
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
      writeJsonAtomic(this.stateFile, { seen, since: this.since });
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

  /** Sipariş sohbetine yazılan metin yerel not (Admin API'de alıcıya mesaj ucu yok) */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (!this.isOrder(remoteChatId)) throw new Error('Shopify Inbox desteklenmiyor (resmi API yok)');
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
}
