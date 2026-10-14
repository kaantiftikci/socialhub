import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BaseConnector, type OutFile, type SendOptions, type StartOptions } from './base.js';
import { PollTimer, marketDelay, retryAfterSec } from './poll-timer.js';
import { onUiActive } from '../activity.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { MEDIA_MAX } from '../media-hosts.js';
import { DEFAULT_GRAPH_VERSION, OAuthError, refreshToken } from '../oauth/index.js';
import type { WhatsAppCloudToken } from '../oauth/flows.js';
import { chatId, messageId, type Account, type Attachment, type MessageStatus, type ReplyRef } from '../model.js';
import type { Store } from '../store.js';

/**
 * WhatsApp Business Platform — resmi Cloud API (Ekim 2026). Hesap Meta "Embedded Signup" ile bağlanır (oauth/flows.ts
 * WhatsAppCloudToken: işletme belirteci + phone_number_id + waba_id). Kişisel WhatsApp numarası bu yola GİREMEZ: WhatsApp Business
 * uygulamasındaki numara ("coexistence": telefon + Mivelo aynı anda) ya da hiçbir telefona kayıtlı olmayan ayrı numara.
 *
 * Gelen mesajlar Meta'dan yalnız WEBHOOK ile (herkese açık HTTPS) gelir, yoklama ucu yok → mivelo.app'teki aktarıcı
 * (`api/wa-webhook.php`) olayları numara başına kuyruklar; çekirdek `pull` ile çeker (odakta ≈4 sn, boşta ≈20 sn; anahtar `pullKey`,
 * kayıt sırasında numaranın belirteciyle doğrulanır; aktarıcıda belirteç SAKLANMAZ). Alanlar: `messages` (gelen + durumlar),
 * `smb_message_echoes` (telefondaki WhatsApp Business uygulamasından gönderilenler), `smb_app_state_sync` (rehber adları),
 * `history` (coexistence: Meta'nın aktardığı geçmiş). Mesaj gönderimi doğrudan Graph: POST /{phone_number_id}/messages.
 *
 * Kurallar: kişi son 24 saatte yazmadıysa serbest metin gönderilemez (131047; şablon mesaj gerekir — Mivelo şablon göndermez),
 * grup sohbeti yok, eski mesajlar API'de yok (coexistence'ta Meta'nın aktardığı kadar). Medya istek üzerine (`wamedia:<id>` →
 * GET /{id} → imzalı adres, Bearer ile indirilir; disk önbelleği). Günlüğe içerik/belirteç yazılmaz.
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const WA_RELAY = process.env.MIVELO_WA_RELAY ?? 'https://mivelo.app/api/wa-webhook.php';
export const WA_WINDOW_TEXT = 'Meta kuralı: kişi son 24 saatte yazmadıysa serbest mesaj gönderilemez (şablon mesaj gerekir)';
const GRAPH = 'https://graph.facebook.com';
/** Meta'nın imzalı medya adresleri bu sunuculardan gelir */
const MEDIA_HOSTS = /(^|\.)(lookaside\.fbsbx\.com|fbsbx\.com|fbcdn\.net|whatsapp\.net|facebook\.com)$/i;
const RATE_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const DAY = 86_400_000;
/** Medya boyut sınırları (Meta): görsel 5 MB, ses/video 16 MB, belge 100 MB, çıkartma 500 KB */
const MEDIA_LIMIT: Record<string, number> = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };

export class WaCloudError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    readonly subcode = 0,
    readonly status = 0,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
  get expired(): boolean {
    return this.code === 190;
  }
  get rateLimited(): boolean {
    return this.status === 429 || RATE_CODES.has(this.code);
  }
  /** 24 saatlik müşteri hizmeti penceresi kapalı (yeniden etkileşim şablon ister) */
  get outsideWindow(): boolean {
    return this.code === 131047;
  }
  /** Alıcı WhatsApp'ta değil / engellemiş / ulaşılamıyor */
  get unreachable(): boolean {
    return this.code === 131026 || this.code === 131030;
  }
  /** İzin/yetki yok (uygulama erişimi, kapsam) */
  get permission(): boolean {
    return this.code === 3 || this.code === 10 || (this.code >= 200 && this.code < 300);
  }
}

export function waError(j: J, status: number, headers?: Headers): WaCloudError {
  const e = (j?.error ?? {}) as J;
  const code = Number(e.code) || 0;
  const sub = Number(e.error_subcode) || 0;
  const data = (e.error_data ?? {}) as J;
  const detail = typeof data.details === 'string' ? data.details : '';
  const msg = String(e.message ?? (status ? `HTTP ${status}` : 'Meta yanıtı okunamadı')) + (detail ? ` — ${detail}` : '');
  let wait: number | undefined;
  if (status === 429 || RATE_CODES.has(code)) wait = retryAfterSec(headers?.get('retry-after'), 300);
  return new WaCloudError(msg, code, sub, status, wait);
}

/** Gönderim hatası → kullanıcı dili */
export function waErrorText(e: unknown): string {
  if (!(e instanceof WaCloudError)) return `WhatsApp: ${short(e)}`;
  if (e.outsideWindow) return WA_WINDOW_TEXT;
  if (e.expired) return 'WhatsApp oturumu sona erdi — yeniden giriş yap';
  if (e.code === 131030) return 'Bu numara uygulamanın test alıcı listesinde değil (Meta uygulaması henüz canlı değil)';
  if (e.unreachable) return 'Bu kişiye şu an mesaj gönderilemiyor (numara WhatsApp’ta değil ya da seni engellemiş)';
  if (e.code === 131042) return 'Meta: WhatsApp Business hesabında ödeme yöntemi ya da uygunluk sorunu var (Meta İşletme Yöneticisi → Ödeme)';
  if (e.code === 131031) return 'WhatsApp Business hesabı Meta tarafından kısıtlanmış';
  if (e.code === 133010) return 'Bu numara Cloud API’de kayıtlı değil; Meta İşletme Yöneticisi’nden numarayı kaydet';
  if (e.code === 131051 || e.code === 131053) return 'Bu dosya türü ya da boyutu WhatsApp tarafından kabul edilmedi';
  if (e.rateLimited) return 'WhatsApp istek sınırına ulaşıldı; biraz sonra yeniden dene';
  if (e.permission) return 'WhatsApp mesaj gönderme izni yok — yeniden giriş yapıp izin ver';
  return `WhatsApp: ${short(e)}`;
}

/** Belirteç süreli ise (uzun ömürlü kullanıcı belirteci) 10 günden az kaldıysa yenilenir */
export function waNeedsRefresh(expiresAt: number | undefined, now = Date.now()): boolean {
  return !!expiresAt && expiresAt > now && expiresAt - now < 10 * DAY;
}

/** Günlük için kısa ve belirteçsiz hata metni */
function short(e: unknown): string {
  const m = e instanceof WaCloudError ? `${e.code ? `#${e.code}${e.subcode ? '/' + e.subcode : ''} ` : ''}${e.message}` : e instanceof Error ? e.message : String(e);
  return m
    .split('\n')[0]
    .replace(/[A-Za-z0-9_-]{40,}/g, '…')
    .slice(0, 160);
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

// ───────────── Graph yardımcıları (giriş akışı da kullanır) ─────────────

async function graphCall(v: string, token: string, p: string, init: { method: 'GET' | 'POST' | 'DELETE'; query?: Record<string, string | undefined>; body?: unknown; form?: FormData }): Promise<J> {
  const url = new URL(`${GRAPH}/${v}/${p.replace(/^\//, '')}`);
  for (const [k, val] of Object.entries(init.query ?? {})) if (val !== undefined && val !== '') url.searchParams.set(k, val);
  const r = await fetch(url, {
    method: init.method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
    signal: AbortSignal.timeout(init.form ? 120_000 : 30_000),
  });
  const text = await r.text();
  let j: J = {};
  try {
    j = text ? (JSON.parse(text) as J) : {};
  } catch {
    /* JSON değil */
  }
  if (!r.ok || j.error) throw waError(j, r.status, r.headers);
  return j;
}
export function graphGet(v: string, token: string, p: string, fields?: string): Promise<J> {
  return graphCall(v, token, p, { method: 'GET', query: { fields } });
}
export function graphPost(v: string, token: string, p: string, body: unknown): Promise<J> {
  return graphCall(v, token, p, { method: 'POST', body });
}

// ───────────── Aktarıcı (mivelo.app webhook kuyruğu) ─────────────

async function relay(action: string, o: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown; key?: string }): Promise<{ status: number; j: J }> {
  const url = new URL(WA_RELAY);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: o.method,
    headers: { accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.key ? { 'x-mivelo-key': o.key } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const j = (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as J;
  return { status: r.status, j };
}

/** Numara aktarıcıya kaydedilir (aktarıcı belirteci Graph'ta bir kez doğrular, saklamaz); dönen anahtar olay çekmek için */
export async function relayRegister(phoneNumberId: string, wabaId: string, accessToken: string): Promise<string> {
  const { status, j } = await relay('register', { method: 'POST', body: { phone_number_id: phoneNumberId, waba_id: wabaId, access_token: accessToken } });
  const key = str(j.pullKey);
  if (status !== 200 || !key) throw new OAuthError(`Mivelo bildirim aktarıcısına kayıt yapılamadı: ${str(j.error_description) ?? str(j.error) ?? `HTTP ${status}`}`);
  return key;
}

// ───────────── Webhook biçimleri ─────────────

interface WaMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
}
interface WaMsg {
  id: string;
  from?: string;
  to?: string;
  timestamp?: string | number;
  type?: string;
  text?: { body?: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string; first_name?: string }; phones?: Array<{ phone?: string; wa_id?: string }> }>;
  reaction?: { message_id?: string; emoji?: string };
  context?: { from?: string; id?: string; forwarded?: boolean };
  button?: { text?: string; payload?: string };
  interactive?: { type?: string; button_reply?: { title?: string }; list_reply?: { title?: string } };
  errors?: Array<{ code?: number; title?: string }>;
  history_context?: { from_me?: boolean; status?: string };
}
interface WaStatus {
  id: string;
  status?: string;
  timestamp?: string | number;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
}
interface WaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: WaMsg[];
  statuses?: WaStatus[];
  message_echoes?: WaMsg[];
  state_sync?: Array<{ type?: string; action?: string; contact?: { full_name?: string; first_name?: string; phone_number?: string } }>;
  history?: Array<{ metadata?: { phase?: number; chunk_order?: number; progress?: number }; threads?: Array<{ id?: string; messages?: WaMsg[] }> }>;
}
interface RelayEvent {
  seq: number;
  t?: number;
  field?: string;
  value?: WaValue;
}

/** Webhook zaman damgası (Unix sn, metin ya da sayı) → ms */
export function waTime(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** "905000000099" → "+90 500 000 00 99" (TR); diğerleri "+<rakamlar>" */
export function formatWaId(id: string): string {
  const d = id.replace(/\D/g, '');
  if (!d) return id;
  if (d.startsWith('90') && d.length === 12) return `+90 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
  return `+${d}`;
}

/** Uzun metni sınırı aşmayan parçalara böl (satır/boşlukta; vekil çiftleri bölünmez) */
export function splitWaText(text: string, max = 4096): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max));
    if (cut < max * 0.5) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[ \n]/, '');
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

const STATUS_MAP: Record<string, MessageStatus> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
const STATUS_RANK: Record<MessageStatus, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 1 };

export class WhatsAppCloudConnector extends BaseConnector {
  private tok?: WhatsAppCloudToken;
  private version = DEFAULT_GRAPH_VERSION;
  private timer?: PollTimer;
  private offActive?: () => void;
  private polling = false;
  private stopped = false;
  private dead = false;
  private startedAt = Date.now();
  private refreshTriedAt = 0;
  private firstSync?: Promise<void>;
  /** aktarıcıdan alınan son olay sırası; rehber adları (smb_app_state_sync). Kalıcı: meta `wa_cloud:<hesap>` */
  private lastSeq = 0;
  private names = new Map<string, string>();
  private stateDirty = false;
  private loggedCodes = new Set<string>();
  /** aktarıcı kaydı düşmüşse (404) bir kez yeniden kayıt */
  private reregistered = false;

  constructor(account: Account, store: Store) {
    super(account, store);
  }

  private get tokenFile(): string {
    return path.join(sessionDir(this.account.id), 'token');
  }
  private get stateKey(): string {
    return `wa_cloud:${this.account.id}`;
  }
  private get expiredText(): string {
    return 'WhatsApp oturumu sona erdi — yeniden giriş yap';
  }
  /** Resmi API "benden" bilgisini kesin verir */
  protected override get echoFilter(): boolean {
    return false;
  }

  // ───────────── Başlat / durdur ─────────────

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopped = false;
    this.dead = false;
    this.startedAt = Date.now();
    this.timer?.stop();
    if (!this.readToken()) return this.expire();
    this.setStatus('connecting');
    try {
      await this.maybeRefresh(true);
      if (this.dead) return;
      const info = await graphGet(this.version, this.tok!.accessToken, this.tok!.phoneNumberId, 'id,display_phone_number,verified_name');
      const phone = str(info.display_phone_number) ?? this.tok!.displayPhone;
      if (phone) this.account.label = phone;
      // webhook aboneliği her açılışta tazelenir (idempotent); hata bağlantıyı düşürmez, günlüğe
      if (this.tok!.wabaId) graphPost(this.version, this.tok!.accessToken, `${this.tok!.wabaId}/subscribed_apps`, {}).catch((e) => this.logOnce('sub', `WhatsApp: bildirim aboneliği tazelenemedi (${short(e)})`));
    } catch (e) {
      if (e instanceof WaCloudError && e.expired) return this.expire();
      if (e instanceof WaCloudError && e.permission) return this.setStatus('error', 'WhatsApp Business hesabına erişim izni yok — yeniden giriş yapıp izin ver');
      return this.setStatus('error', `WhatsApp Business bağlantısı kurulamadı: ${short(e)}`);
    }
    if (this.stopped) return;
    this.loadState();
    this.setStatus('connected');
    // geçmiş yok (API vermez): eşitleme çubuğu hemen biter
    this.syncProgress(100);
    this.timer = new PollTimer(() => this.poll(), () => marketDelay(4_000, 20_000));
    this.firstSync = this.poll().finally(() => {
      if (!this.stopped && !this.dead) this.timer?.start();
    });
    this.offActive?.();
    this.offActive = onUiActive(() => {
      if (!this.stopped && !this.dead && !this.polling) this.timer?.start();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.stop();
    this.offActive?.();
    this.offActive = undefined;
    this.saveState();
    if (!this.dead) this.setStatus('disconnected');
  }

  /** Hesap kaldırılınca aktarıcı kaydı da silinir (Meta tarafındaki bağlantı Meta İşletme Yöneticisi'nden kaldırılır) */
  async logout(): Promise<void> {
    const t = this.tok;
    if (!t) return;
    try {
      await relay('unregister', { method: 'POST', body: { phone_number_id: t.phoneNumberId }, key: t.pullKey });
    } catch {
      /* aktarıcıya ulaşılamadı; kayıt orada süresiyle düşer */
    }
  }

  private expire(): void {
    this.dead = true;
    this.timer?.stop();
    this.setStatus('error', this.expiredText);
  }

  private readToken(): boolean {
    let raw: J;
    try {
      raw = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as J;
    } catch {
      return false;
    }
    if (raw.official !== 'whatsapp' || typeof raw.accessToken !== 'string' || !raw.accessToken || typeof raw.phoneNumberId !== 'string' || typeof raw.pullKey !== 'string') return false;
    this.tok = raw as WhatsAppCloudToken;
    this.version = this.tok.graphVersion ?? DEFAULT_GRAPH_VERSION;
    return true;
  }

  private writeToken(t: WhatsAppCloudToken): void {
    const tmp = `${this.tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    fs.renameSync(tmp, this.tokenFile);
    try {
      fs.chmodSync(this.tokenFile, 0o600);
    } catch {
      /* Windows */
    }
  }

  /** Süreli belirteç 10 günden az kaldıysa aracıdan yenile (6 saatte en çok bir deneme) */
  private async maybeRefresh(force = false): Promise<void> {
    const t = this.tok;
    if (!t) return;
    const now = Date.now();
    if (!waNeedsRefresh(t.expiresAt, now)) return;
    if (!force && now - this.refreshTriedAt < 6 * 3600_000) return;
    this.refreshTriedAt = now;
    try {
      const n = await refreshToken('whatsapp', t.accessToken);
      this.tok = { ...t, accessToken: n.accessToken, expiresAt: n.expiresAt ?? t.expiresAt };
      this.writeToken(this.tok);
      bus.log('info', 'WhatsApp Business: erişim belirteci yenilendi');
    } catch (e) {
      if (e instanceof OAuthError && e.revoked) return this.expire();
      bus.log('warn', `WhatsApp Business belirteci yenilenemedi: ${short(e)}`);
    }
  }

  private loadState(): void {
    try {
      const j = JSON.parse(this.store.meta(this.stateKey) ?? '{}') as { lastSeq?: number; names?: Record<string, string> };
      this.lastSeq = Number(j.lastSeq) || 0;
      this.names = new Map(Object.entries(j.names ?? {}).filter(([, v]) => typeof v === 'string'));
    } catch {
      this.lastSeq = 0;
      this.names = new Map();
    }
  }

  private saveState(): void {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    const names: Record<string, string> = {};
    for (const [k, v] of [...this.names.entries()].slice(-5000)) names[k] = v;
    this.store.setFlag(this.stateKey, JSON.stringify({ lastSeq: this.lastSeq, names }));
  }

  private logOnce(key: string, text: string): void {
    if (this.loggedCodes.has(key)) return;
    if (this.loggedCodes.size > 200) this.loggedCodes.clear();
    this.loggedCodes.add(key);
    bus.log('warn', text);
  }

  // ───────────── Yoklama (aktarıcı kuyruğu) ─────────────

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.dead || !this.tok) return;
    this.polling = true;
    try {
      await this.maybeRefresh();
      if (this.dead) return;
      // tek turda en çok birkaç sayfa (kuyruk birikmişse)
      for (let page = 0; page < 5; page++) {
        const got = await this.pullOnce();
        if (got < 100) break;
      }
      this.saveState();
    } catch (e) {
      this.logOnce(`pull:${short(e)}`, `WhatsApp Business: bildirimler alınamadı (${short(e)})`);
    } finally {
      this.polling = false;
    }
  }

  /** Aktarıcıdan sıradaki olaylar; dönen: alınan olay sayısı */
  private async pullOnce(): Promise<number> {
    const t = this.tok!;
    const { status, j } = await relay('pull', { method: 'GET', query: { phone_number_id: t.phoneNumberId, after: String(this.lastSeq) }, key: t.pullKey });
    if (status === 404 || status === 401) {
      // kayıt düşmüş (aktarıcı temizlendi / anahtar değişti): bu belirteçle bir kez yeniden kayıt
      if (this.reregistered) throw new Error('aktarıcı kaydı yok');
      this.reregistered = true;
      const key = await relayRegister(t.phoneNumberId, t.wabaId, t.accessToken);
      this.tok = { ...t, pullKey: key };
      this.writeToken(this.tok);
      bus.log('info', 'WhatsApp Business: aktarıcı kaydı yenilendi');
      return 0;
    }
    if (status !== 200) throw new Error(str(j.error_description) ?? str(j.error) ?? `HTTP ${status}`);
    const events = Array.isArray(j.events) ? (j.events as RelayEvent[]) : [];
    for (const ev of events) {
      if (this.stopped || this.dead) break;
      if (typeof ev.seq !== 'number') continue;
      try {
        await this.ingestValue(ev.field ?? 'messages', ev.value ?? {});
      } catch (e) {
        this.logOnce(`ev:${short(e)}`, `WhatsApp Business: bir bildirim işlenemedi (${short(e)})`);
      }
      if (ev.seq > this.lastSeq) {
        this.lastSeq = ev.seq;
        this.stateDirty = true;
      }
    }
    return events.length;
  }

  /** Test/araçlar: bir webhook değerini doğrudan işle */
  async ingestValue(field: string, v: WaValue): Promise<void> {
    if (field === 'smb_app_state_sync') return this.ingestStateSync(v);
    if (field === 'history') return this.ingestHistory(v);
    // profil adları (push name) sohbet adı olarak; rehber adı varsa o önde
    for (const c of v.contacts ?? []) if (c.wa_id && c.profile?.name) this.rememberName(c.wa_id, c.profile.name, false);
    const echoes = field === 'smb_message_echoes';
    for (const m of (echoes ? v.message_echoes : v.messages) ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      this.ingestMessage(m, echoes || m.history_context?.from_me === true, { live: true });
    }
    for (const s of v.statuses ?? []) this.ingestStatus(s);
  }

  private rememberName(waId: string, name: string, fromContacts: boolean): void {
    const id = waId.replace(/\D/g, '');
    if (!id || !name.trim()) return;
    const key = fromContacts ? id : `push:${id}`;
    if (this.names.get(key) === name) return;
    this.names.set(key, name);
    this.stateDirty = true;
  }

  private nameOf(waId: string): string {
    return this.names.get(waId) ?? this.names.get(`push:${waId}`) ?? formatWaId(waId);
  }

  private ingestStateSync(v: WaValue): void {
    for (const s of v.state_sync ?? []) {
      if (s.type !== 'contact' || !s.contact?.phone_number) continue;
      const id = s.contact.phone_number.replace(/\D/g, '');
      if (!id) continue;
      if (s.action === 'remove') {
        if (this.names.delete(id)) this.stateDirty = true;
        continue;
      }
      const name = str(s.contact.full_name) ?? str(s.contact.first_name);
      if (!name) continue;
      this.rememberName(id, name, true);
      const cid = chatId(this.account.id, id);
      if (this.store.hasChat(cid)) this.upsertChat({ remoteId: id, name });
    }
  }

  /** Coexistence geçmiş aktarımı: Meta'nın parça parça gönderdiği eski mesajlar (canlı değil, bildirim yok) */
  private ingestHistory(v: WaValue): void {
    for (const h of v.history ?? []) {
      for (const th of h.threads ?? []) {
        const peer = str(th.id)?.replace(/\D/g, '');
        for (const m of th.messages ?? []) {
          if (!m || typeof m.id !== 'string') continue;
          const fromMe = m.history_context?.from_me === true;
          const mm: WaMsg = { ...m, from: fromMe ? this.tok?.phoneNumberId : (m.from ?? peer), to: fromMe ? (m.to ?? peer) : undefined };
          if (peer) this.ingestMessage(mm, fromMe, { live: false, peer });
        }
      }
    }
  }

  private ingestStatus(s: WaStatus): void {
    if (!s?.id || !s.status) return;
    const next = STATUS_MAP[s.status];
    if (!next) return;
    const stored = this.store.findMessageByRemote(this.account.id, s.id);
    if (!stored) return;
    // durumu geri götürme (okundu → iletildi); failed yalnız bekleyen/gönderildi'nin yerine
    if (next === 'failed' ? stored.status === 'delivered' || stored.status === 'read' : STATUS_RANK[next] <= STATUS_RANK[stored.status]) return;
    this.store.updateStatus(stored.id, next);
    const chat = this.store.getChatLite(stored.chatId);
    const m = this.store.getMessage(stored.id);
    if (m && chat) bus.emit({ type: 'message.upsert', message: m, chat });
    if (next === 'read') {
      const remote = chat?.remoteId;
      if (remote) this.outgoingRead(remote, waTime(s.timestamp) ?? Date.now());
    }
    if (next === 'failed') {
      const err = s.errors?.[0];
      if (err) this.logOnce(`st:${err.code}`, `WhatsApp Business: mesaj iletilemedi (#${err.code ?? '?'} ${str(err.title) ?? ''})`);
    }
  }

  private ingestMessage(m: WaMsg, fromMe: boolean, o: { live: boolean; peer?: string }): void {
    const peer = (o.peer ?? (fromMe ? m.to : m.from) ?? '').replace(/\D/g, '');
    if (!peer) return;
    const ts = waTime(m.timestamp) ?? Date.now();
    // tepki: mesaj değil, hedef mesaja tepki
    if (m.type === 'reaction' && m.reaction?.message_id) {
      const emoji = str(m.reaction.emoji);
      const who = fromMe ? 'me' : peer;
      this.applyReaction(peer, m.reaction.message_id, { emoji: emoji ?? '', senderId: who, senderName: fromMe ? 'Ben' : this.nameOf(peer), fromMe }, !emoji);
      if (!fromMe && emoji) this.reactionPreview(peer, `${emoji} ${this.nameOf(peer)} mesajına tepki verdi`);
      return;
    }
    const name = this.nameOf(peer);
    this.upsertChat({ remoteId: peer, name, kind: 'direct', handle: formatWaId(peer), participants: [{ id: peer, name }], meta: { waId: peer } });
    const { text, attachments } = this.contentOf(m);
    const isNew = !this.hasMessage(peer, m.id);
    const replyTo = this.replyOf(peer, m);
    this.upsertMessage(
      {
        remoteChatId: peer,
        remoteId: m.id,
        senderId: fromMe ? 'me' : peer,
        senderName: fromMe ? 'Ben' : name,
        fromMe,
        text,
        ts,
        status: fromMe ? (STATUS_MAP[m.history_context?.status ?? ''] ?? 'sent') : 'delivered',
        attachments: attachments.length ? attachments : undefined,
        replyTo,
      },
      { live: o.live && isNew && !fromMe && ts >= this.startedAt - 120_000, bump: o.live && isNew && !fromMe },
    );
  }

  private replyOf(peer: string, m: WaMsg): ReplyRef | undefined {
    const rid = str(m.context?.id);
    if (!rid) return undefined;
    const q = this.store.getMessage(messageId(chatId(this.account.id, peer), rid));
    if (!q) return { remoteId: rid, senderName: m.context?.from && m.context.from.replace(/\D/g, '') !== peer ? 'Ben' : this.nameOf(peer), text: '' };
    return { remoteId: rid, senderName: q.senderName, text: (q.text || q.attachments?.[0]?.name || '').slice(0, 120), fromMe: q.fromMe };
  }

  private mediaUrl(id: string | undefined): string | undefined {
    return id ? `/api/media/${encodeURIComponent(this.account.id)}?u=wamedia:${encodeURIComponent(id)}` : undefined;
  }

  /** Mesaj türü → metin + ekler */
  private contentOf(m: WaMsg): { text: string; attachments: Attachment[] } {
    const atts: Attachment[] = [];
    let text = '';
    const t = m.type ?? 'text';
    const med = (kind: Attachment['kind'], x: WaMedia | undefined, name: string) => {
      if (!x) return;
      const u = this.mediaUrl(x.id);
      atts.push({ kind, name: x.filename ?? name, mime: x.mime_type, url: kind === 'image' ? u : undefined, link: u });
      if (x.caption) text = x.caption;
    };
    switch (t) {
      case 'text':
        text = m.text?.body ?? '';
        break;
      case 'image':
        med('image', m.image, 'Fotoğraf');
        break;
      case 'sticker':
        med('image', m.sticker, 'Çıkartma');
        break;
      case 'video':
        med('video', m.video, 'Video');
        break;
      case 'audio':
        med('audio', m.audio, 'Sesli mesaj');
        break;
      case 'document':
        med('file', m.document, 'Dosya');
        break;
      case 'location': {
        const l = m.location ?? {};
        const lat = Number(l.latitude);
        const lng = Number(l.longitude);
        const label = [str(l.name), str(l.address)].filter(Boolean).join(' · ');
        text = `📍 ${label || 'Konum'}`;
        if (Number.isFinite(lat) && Number.isFinite(lng)) atts.push({ kind: 'other', name: label || 'Konum', link: `https://maps.google.com/?q=${lat},${lng}` });
        break;
      }
      case 'contacts': {
        const rows = (m.contacts ?? []).map((c) => [str(c.name?.formatted_name) ?? str(c.name?.first_name), c.phones?.map((p) => p.phone ?? p.wa_id).filter(Boolean).join(', ')].filter(Boolean).join(': '));
        text = `👤 ${rows.join('\n') || 'Kişi kartı'}`;
        break;
      }
      case 'button':
        text = m.button?.text ?? '';
        break;
      case 'interactive':
        text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
        break;
      case 'unsupported':
      default:
        text = m.errors?.length ? 'Desteklenmeyen mesaj türü' : (m.text?.body ?? 'Bu içerik burada gösterilemiyor');
    }
    if (m.context?.forwarded && text) text = `↪ İletildi: ${text}`;
    return { text, attachments: atts };
  }

  // ───────────── Medya ─────────────

  /** `wamedia:<id>` → GET /{id} (imzalı adres) → Bearer ile indir; önbellek sessions/<hesap>/media/<sha1> */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    if (!this.tok) return undefined;
    const id = u.startsWith('wamedia:') ? decodeURIComponent(u.slice('wamedia:'.length)) : '';
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error('geçersiz medya kimliği');
    const dir = path.join(sessionDir(this.account.id), 'media');
    const file = path.join(dir, createHash('sha1').update(`wamedia:${id}`).digest('hex'));
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    const meta = await graphGet(this.version, this.tok.accessToken, id, 'url,mime_type,file_size');
    const url = str(meta.url);
    if (!url) throw new Error('Meta medya adresi vermedi');
    const host = new URL(url).hostname;
    if (!MEDIA_HOSTS.test(host)) throw new Error(`medya adresi izinli değil: ${host}`);
    if (Number(meta.file_size) > MEDIA_MAX) throw new Error('medya çok büyük (413)');
    const r = await fetch(url, { headers: { authorization: `Bearer ${this.tok.accessToken}` }, redirect: 'manual', signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`Meta medya ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MEDIA_MAX) throw new Error('medya çok büyük (413)');
    const type = str(meta.mime_type) ?? r.headers.get('content-type') ?? 'application/octet-stream';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.type', type);
    return { body, type };
  }

  // ───────────── Gönderim ─────────────

  private async send(to: string, body: J): Promise<string> {
    if (this.dead || !this.tok) throw new Error(this.expiredText);
    let j: J;
    try {
      j = await graphPost(this.version, this.tok.accessToken, `${this.tok.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body });
    } catch (e) {
      if (e instanceof WaCloudError && e.expired) this.expire();
      throw new Error(waErrorText(e));
    }
    return str(j.messages?.[0]?.id) ?? `local-${Date.now()}`;
  }

  async sendText(remoteChatId: string, text: string, opts?: SendOptions): Promise<{ remoteId: string }> {
    const to = remoteChatId.replace(/\D/g, '');
    if (!to) throw new Error('Alıcı numarası bilinmiyor');
    let last = '';
    const parts = splitWaText(text);
    for (const [i, part] of parts.entries()) {
      const body: J = { type: 'text', text: { preview_url: true, body: part } };
      if (i === 0 && opts?.replyTo) body.context = { message_id: opts.replyTo };
      const id = await this.send(to, body);
      const q = opts?.replyTo && i === 0 ? this.store.getMessage(messageId(chatId(this.account.id, to), opts.replyTo)) : undefined;
      this.upsertMessage({
        remoteChatId: to,
        remoteId: id,
        senderId: 'me',
        senderName: 'Ben',
        fromMe: true,
        text: part,
        ts: Date.now(),
        status: 'sent',
        replyTo: q ? { remoteId: opts!.replyTo!, senderName: q.senderName, text: (q.text || q.attachments?.[0]?.name || '').slice(0, 120), fromMe: q.fromMe } : undefined,
      });
      last = id;
    }
    return { remoteId: last };
  }

  /** Dosya: önce /media yüklemesi (multipart), sonra kimlikle mesaj */
  async sendMedia(remoteChatId: string, file: OutFile, caption?: string): Promise<{ remoteId: string }> {
    if (this.dead || !this.tok) throw new Error(this.expiredText);
    const to = remoteChatId.replace(/\D/g, '');
    const mime = file.mime || 'application/octet-stream';
    const kind = mime.startsWith('image/') && mime !== 'image/gif' ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
    if (file.size > (MEDIA_LIMIT[kind] ?? MEDIA_LIMIT.document!)) throw new Error(`WhatsApp bu dosya boyutunu kabul etmiyor (en çok ${Math.round(MEDIA_LIMIT[kind]! / 1024 / 1024)} MB)`);
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', mime);
    fd.append('file', new Blob([fs.readFileSync(file.path)], { type: mime }), file.name);
    let up: J;
    try {
      up = await graphCall(this.version, this.tok.accessToken, `${this.tok.phoneNumberId}/media`, { method: 'POST', form: fd });
    } catch (e) {
      if (e instanceof WaCloudError && e.expired) this.expire();
      throw new Error(waErrorText(e));
    }
    const mediaId = str(up.id);
    if (!mediaId) throw new Error('WhatsApp dosyayı kabul etmedi');
    const payload: J = { id: mediaId };
    if (caption && kind !== 'audio') payload.caption = caption;
    if (kind === 'document') payload.filename = file.name;
    const id = await this.send(to, { type: kind, [kind]: payload });
    const att: Attachment = { kind: kind === 'document' ? 'file' : kind, name: file.name, mime, size: file.size, url: kind === 'image' ? this.mediaUrl(mediaId) : undefined, link: this.mediaUrl(mediaId) };
    this.upsertMessage({ remoteChatId: to, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: caption ?? '', ts: Date.now(), status: 'sent', attachments: [att] });
    return { remoteId: id };
  }

  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    const to = remoteChatId.replace(/\D/g, '');
    await this.send(to, { type: 'reaction', reaction: { message_id: remoteMsgId, emoji: remove ? '' : emoji } });
    this.applyReaction(to, remoteMsgId, { emoji, senderId: 'me', senderName: 'Ben', fromMe: true }, remove);
  }

  /** Mivelo'da açılan sohbet: son gelen mesaj Meta'da da okundu (mavi tik) */
  async markRead(remoteChatId: string): Promise<void> {
    if (this.dead || this.stopped || !this.tok) return;
    const to = remoteChatId.replace(/\D/g, '');
    // listMessages eskiden yeniye sıralı → en yeni gelen için sondan bak
    const last = [...this.store.listMessages(chatId(this.account.id, to), 30)].reverse().find((m) => !m.fromMe && !m.remoteId.startsWith('local-'));
    if (!last) return;
    try {
      await graphPost(this.version, this.tok.accessToken, `${this.tok.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: last.remoteId });
    } catch (e) {
      if (e instanceof WaCloudError && e.expired) return this.expire();
      this.logOnce(`read:${e instanceof WaCloudError ? e.code : 'x'}`, `WhatsApp Business: okundu bildirilemedi (${short(e)})`);
    }
  }

  async loadHistory(): Promise<{ unavailable?: string }> {
    return { unavailable: 'WhatsApp Business API eski mesajları vermez' };
  }
}
