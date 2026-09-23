import fs from 'node:fs';
import path from 'node:path';
import { BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Participant } from '../model.js';

/**
 * Shopier: resmi REST API (https://api.shopier.com/v1) + Kişisel Erişim Anahtarı (PAT).
 * Her sipariş bir "sohbet"tir; sipariş olayları (oluşturma, kargo, iade) mesaj olarak akar.
 * Sipariş kapatma / kargo bildirimi PUT /orders/{id} ile yapılır.
 *
 * Not: Shopier API'sinde alıcı-satıcı mesajlaşması için bir uç yoktur (yalnızca sipariş, ürün,
 * kargo, iade, bakiye, webhook). Bu yüzden DM burada sunulmaz.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const API = 'https://api.shopier.com/v1';
const COMPANIES: Record<string, string> = {
  yurtici: 'Yurtiçi Kargo', mng: 'MNG Kargo', ptt: 'PTT Kargo', aras: 'Aras Kargo', surat: 'Sürat Kargo', ups: 'UPS', fedex: 'FedEx', dhl: 'DHL', tnt: 'TNT', pts: 'PTS', aramex: 'Aramex', interGlobal: 'InterGlobal', hepsijet: 'HepsiJET', other: 'Diğer',
};

export interface OrderAction {
  kind: 'fulfill';
  productType?: 'physical' | 'digital';
  shippingCompany?: string;
  trackingNumber?: string;
  note?: string;
}

const money = (v: unknown, cur: string) => `${String(v ?? '0').replace('.', ',')} ${cur === 'TRY' ? '₺' : cur}`;

export class ShopierConnector extends BaseConnector {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopping = false;
  /** sipariş id → son görülen durum imzası */
  private seen = new Map<string, string>();
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], private token: string) {
    super(account, store);
    this.stateFile = path.join(sessionDir(account.id), 'shopier-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(st)) this.seen.set(k, v);
    } catch {
      /* ilk çalıştırma */
    }
  }

  private async api(method: string, p: string, body?: unknown): Promise<{ data: J; headers: Headers }> {
    const r = await fetch(API + p, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (r.status === 429) throw new Error(`Shopier istek limiti; ${r.headers.get('retry-after') ?? '60'} sn sonra`);
    if (!r.ok) throw new Error(`Shopier ${r.status} ${p}: ${text.slice(0, 160)}`);
    return { data: text ? (JSON.parse(text) as J) : {}, headers: r.headers };
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    if (!this.token) return this.setStatus('error', 'Kişisel Erişim Anahtarı (PAT) girilmedi');
    this.setStatus('connecting');
    try {
      const { data: owner } = await this.api('GET', '/shop/owner').catch(() => ({ data: {} as J, headers: new Headers() }));
      this.account.label = owner.shopName ?? owner.name ?? owner.username ?? 'Shopier';
      await this.poll(true);
      this.setStatus('connected', owner.email ?? undefined);
      this.timer = setInterval(() => void this.poll(false), 60_000);
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.setStatus('disconnected');
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      const orders: J[] = [];
      const pages = first ? 4 : 1;
      for (let page = 1; page <= pages; page++) {
        const { data, headers } = await this.api('GET', `/orders?limit=50&page=${page}&sort=dateDesc`);
        const list = Array.isArray(data) ? data : (data.orders ?? data.data ?? []);
        orders.push(...list);
        const total = Number(headers.get('shopier-pagination-total-pages') ?? 1);
        if (page >= total || list.length < 50) break;
      }
      let changed = 0;
      for (const o of orders.reverse()) if (this.ingest(o, !first)) changed++;
      if (changed) bus.log('info', `Shopier: ${changed} sipariş güncellendi`);
      this.saveState();
    } catch (e) {
      bus.log('warn', `Shopier yoklama: ${(e as Error).message}`);
      if (first) throw e;
    } finally {
      this.polling = false;
    }
  }

  private saveState(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of [...this.seen.entries()].slice(-3000)) obj[k] = v;
    fs.writeFileSync(this.stateFile, JSON.stringify(obj));
  }

  /** Sipariş → sohbet + olay mesajları. Değişiklik varsa true döner. */
  private ingest(o: J, live: boolean): boolean {
    const id = String(o.id);
    const sig = JSON.stringify([o.status, (o.fulfillments ?? []).map((f: J) => [f.status, f.trackingNumber]), (o.refunds ?? []).map((r: J) => [r.status, r.total])]);
    const prev = this.seen.get(id);
    if (prev === sig) return false;
    this.seen.set(id, sig);

    const s = o.shippingInfo ?? {};
    const customer = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.company || 'Müşteri';
    const cur = o.currency ?? 'TRY';
    const created = Date.parse(o.dateCreated ?? '') || Date.now();
    const items: J[] = o.lineItems ?? [];
    const itemLines = items.map((li) => {
      const sel = (li.selection ?? []).map((x: J) => x.title).filter(Boolean).join(' / ');
      return `• ${li.quantity ?? 1} × ${li.title}${sel ? ` (${sel})` : ''} — ${money(li.total, cur)}`;
    });
    const participant: Participant = { id: s.email || s.phone || id, name: customer, handle: s.phone || s.email || undefined };
    const open = o.status !== 'fulfilled';
    this.upsertChat({
      remoteId: id,
      name: `#${id} · ${customer}`,
      kind: 'direct',
      lastMessageAt: created,
      handle: s.phone || s.email || undefined,
      participants: [participant],
      // açık sipariş ilk görüldüğünde "ilgi bekliyor" olarak işaretle
      unread: !prev && open ? 1 : undefined,
      meta: {
        order: {
          id,
          status: o.status,
          paymentStatus: o.paymentStatus,
          dateCreated: o.dateCreated,
          currency: cur,
          totals: o.totals,
          note: o.note,
          items: items.map((li) => ({ title: li.title, quantity: li.quantity, total: li.total, type: li.type, selection: (li.selection ?? []).map((x: J) => x.title) })),
          shipping: { name: customer, phone: s.phone, email: s.email, address: [s.address, s.district, s.city, s.postcode, s.country].filter(Boolean).join(', ') },
          fulfillments: (o.fulfillments ?? []).map((f: J) => ({ status: f.status, company: f.company ? COMPANIES[f.company] ?? f.company : undefined, trackingNumber: f.trackingNumber, trackingUrl: f.trackingUrl, date: f.dateDispatched ?? f.dateCreated })),
          refunds: (o.refunds ?? []).map((r: J) => ({ type: r.type, status: r.status, total: r.total, date: r.dateCreated })),
        },
      },
    });

    // 1) sipariş oluşturma mesajı (bir kez)
    if (!prev) {
      const text = [
        `🛍️ Yeni sipariş #${id} — ${money(o.totals?.total, cur)}${o.installments ? ' (taksitli)' : ''}`,
        ...itemLines,
        `Teslimat: ${[s.address, s.district, s.city].filter(Boolean).join(', ') || '—'}`,
        s.phone ? `Telefon: ${s.phone}` : '',
        o.note ? `Not: ${o.note}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.upsertMessage({ remoteChatId: id, remoteId: `order-${id}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: created, status: 'delivered' }, { live: live && open });
    }
    // 2) kargo / teslimat olayları
    for (const [i, f] of (o.fulfillments ?? []).entries()) {
      const when = Date.parse(f.dateDispatched ?? f.dateCreated ?? '') || created + 1000 * (i + 1);
      const company = f.company ? COMPANIES[f.company] ?? f.company : '';
      const text =
        f.status === 'shipped'
          ? `📦 Kargoya verildi${company ? ` · ${company}` : ''}${f.trackingNumber ? ` · takip: ${f.trackingNumber}` : ''}${f.trackingUrl ? `\n${f.trackingUrl}` : ''}`
          : `📦 Gönderi hazırlanıyor${company ? ` · ${company}` : ''}${f.code ? ` · kod: ${f.code}` : ''}`;
      this.upsertMessage({ remoteChatId: id, remoteId: `ful-${id}-${i}-${f.status}`, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: when, status: 'sent' });
    }
    // 3) iadeler
    for (const r of o.refunds ?? []) {
      const when = Date.parse(r.dateRefunded ?? r.dateCreated ?? '') || Date.now();
      const text = `↩️ ${r.type === 'full' ? 'Tam' : 'Kısmi'} iade ${money(r.total, cur)} — ${r.status === 'succeeded' ? 'tamamlandı' : r.status === 'failed' ? 'başarısız' : 'bekliyor'}`;
      this.upsertMessage({ remoteChatId: id, remoteId: `ref-${r.id ?? when}-${r.status}`, senderId: participant.id, senderName: customer, fromMe: false, text, ts: when, status: 'delivered' }, { live });
    }
    if (!open && prev) {
      this.upsertMessage({ remoteChatId: id, remoteId: `closed-${id}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: '✅ Sipariş kapatıldı', ts: Date.now(), status: 'sent' });
    }
    return true;
  }

  /** Sohbete yazılan metin sipariş notu olarak yerelde tutulur; Shopier'de alıcıya mesaj ucu yok. */
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const id = `note-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben (yerel not)', fromMe: true, text: `📝 ${text}`, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /** Siparişi kargo bilgisiyle kapat */
  async action(remoteChatId: string, payload: Record<string, unknown>): Promise<void> {
    const a = payload as unknown as OrderAction;
    if (a.kind !== 'fulfill') throw new Error('Bilinmeyen işlem');
    const body = {
      fulfillments: {
        productType: a.productType ?? 'physical',
        ...(a.shippingCompany ? { shippingCompany: a.shippingCompany } : {}),
        ...(a.trackingNumber ? { trackingNumber: a.trackingNumber } : {}),
        ...(a.note ? { note: a.note } : {}),
      },
    };
    const { data } = await this.api('PUT', `/orders/${encodeURIComponent(remoteChatId)}`, body);
    this.seen.delete(remoteChatId);
    this.ingest(data.id ? data : { ...data, id: remoteChatId }, false);
    this.saveState();
  }
}
