import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BaseConnector, type SendOptions, type StartOptions } from './base.js';
import { PollTimer, marketDelay, retryAfterSec } from './poll-timer.js';
import { onUiActive } from '../activity.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { MEDIA_MAX, mediaHostAllowed } from '../media-hosts.js';
import { DEFAULT_GRAPH_VERSION, OAuthError, PROVIDER_NAME, refreshToken } from '../oauth/index.js';
import type { FacebookPagesToken, InstagramGraphToken } from '../oauth/flows.js';
import { chatId, type Account, type Attachment } from '../model.js';
import type { Store } from '../store.js';

/**
 * Meta resmi Graph API (Ekim 2026):
 *  - Instagram API with Instagram Login (graph.instagram.com): profesyonel hesabın DM'leri.
 *    GET /me/conversations?platform=instagram, GET /{konuşma}?fields=messages{…}, POST /me/messages {recipient:{id}, message:{text}}.
 *    Konuşma başına yalnız EN YENİ 20 mesajın ayrıntısı alınabilir (Meta sınırı); Conversations API hesap başına 2 istek/sn.
 *  - Messenger Platform (graph.facebook.com): Facebook Sayfası mesajları, sayfa belirteciyle.
 *    GET /{sayfa}/conversations?platform=messenger, GET /{konuşma}/messages, POST /{sayfa}/messages {messaging_type:'RESPONSE'}.
 * Yanıt penceresi: kişi son 24 saatte yazmadıysa gönderim reddedilir (hata 10 / 2534022; eski 2018278).
 * Webhook herkese açık HTTPS ister → yerel uygulamada yoklama: odakta 30 sn, boşta 120 sn (±%30), hız sınırında üstel bekleme.
 * Belirteç dosyası: oauth/flows.ts InstagramGraphToken / FacebookPagesToken. Günlüğe içerik/belirteç yazılmaz (yalnız hata kodu).
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type MetaKind = 'instagram' | 'facebook';

interface GUser {
  id?: string;
  username?: string;
  name?: string;
}
interface GMsg {
  id: string;
  created_time?: string;
  from?: GUser;
  to?: { data?: GUser[] };
  message?: string;
  attachments?: { data?: J[] } | J[];
  shares?: { data?: J[] };
  sticker?: string;
  is_unsupported?: boolean;
}
interface GConv {
  id: string;
  updated_time?: string;
  unread_count?: number;
  participants?: { data?: GUser[] };
}
interface GPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Bir belirteçle konuşulan kaynak: Instagram hesabı ya da tek bir Facebook Sayfası */
interface Source {
  /** 'ig' ya da sayfa kimliği */
  key: string;
  token: string;
  pageId?: string;
  pageName?: string;
  /** "benden" tanıma: hesabın/sayfanın kimlikleri */
  myIds: Set<string>;
  /** Instagram kullanıcı adı (küçük harf) */
  myName?: string;
}

export const WINDOW_TEXT = 'Meta kuralı: kişi son 24 saatte yazmadıysa yanıt gönderilemez';
const GRAPH_HOSTS = new Set(['graph.instagram.com', 'graph.facebook.com']);
/** Hız sınırı hata kodları (Graph: uygulama/kullanıcı/sayfa limiti, Messenger/Instagram iş kullanım limiti) */
const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006]);
/**
 * Mesaj alanları: Meta bir alanı tanımazsa (#100 nonexisting field) bir alt düzeye inilir; son düzey yalnız kimlik + mesaj başına
 * ayrıntı isteği (Instagram belgesindeki yol). shares/sticker Messenger'da belgeli, Instagram'da doğrulanmadı.
 */
const MSG_LEVELS = ['id,created_time,from,to,message,attachments,shares,sticker', 'id,created_time,from,to,message,attachments', 'id,created_time,from,to,message', ''];
const DAY = 86_400_000;

/** Graph API hatası (kod/alt kod korunur; mesaj günlüğe kısaltılarak yazılır) */
export class MetaError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    readonly subcode = 0,
    readonly status = 0,
    /** hız sınırında beklenecek süre (sn) */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
  /** Erişim belirteci geçersiz/süresi dolmuş (şifre değişti, uygulama kaldırıldı…) */
  get expired(): boolean {
    return this.code === 190;
  }
  get rateLimited(): boolean {
    return this.status === 429 || RATE_CODES.has(this.code);
  }
  /** 24 saatlik yanıt penceresi kapalı */
  get outsideWindow(): boolean {
    return this.subcode === 2534022 || this.subcode === 2018278 || /outside (of )?(the )?allowed window/i.test(this.message);
  }
  /** Alıcı ulaşılamaz (engelledi, mesaj isteklerini kapattı, hesap yok) */
  get unreachable(): boolean {
    return this.code === 551 || this.subcode === 1545041;
  }
  /** İzin/yetenek yok (kapsam verilmedi, uygulama erişimi yok) */
  get permission(): boolean {
    return !this.outsideWindow && (this.code === 3 || this.code === 10 || (this.code >= 200 && this.code < 300));
  }
  /** İstenen alan bu düğümde yok: daha az alanla yeniden denenir */
  get badField(): boolean {
    return this.code === 100 && /nonexist|unknown field|tried accessing|field/i.test(this.message);
  }
}

/** Ham Graph yanıtından MetaError */
export function metaError(j: J, status: number, headers?: Headers): MetaError {
  const e = (j?.error ?? {}) as J;
  const code = Number(e.code) || 0;
  const sub = Number(e.error_subcode) || 0;
  const msg = String(e.message ?? (status ? `HTTP ${status}` : 'Meta yanıtı okunamadı'));
  let wait: number | undefined;
  if (status === 429 || RATE_CODES.has(code)) wait = rateWait(headers);
  return new MetaError(msg, code, sub, status, wait);
}

/** Hız sınırı başlıklarından bekleme (sn): Retry-After ya da X-Business-Use-Case-Usage estimated_time_to_regain_access (dk) */
function rateWait(h?: Headers): number {
  let min = 0;
  for (const name of ['x-business-use-case-usage', 'x-ad-account-usage']) {
    const raw = h?.get(name);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      for (const arr of Object.values(j)) for (const x of Array.isArray(arr) ? arr : []) min = Math.max(min, Number(x.estimated_time_to_regain_access) || 0);
    } catch {
      /* başlık okunamadı */
    }
  }
  if (min > 0) return min * 60;
  return retryAfterSec(h?.get('retry-after'), 300);
}

/** Gönderim hatası → kullanıcı dili */
export function sendErrorText(e: unknown, kind: MetaKind): string {
  const name = PROVIDER_NAME[kind];
  if (!(e instanceof MetaError)) return `${name}: ${short(e)}`;
  if (e.outsideWindow) return WINDOW_TEXT;
  if (e.expired) return `${name} oturumu sona erdi — yeniden giriş yap`;
  if (e.unreachable) return 'Bu kişiye şu an mesaj gönderilemiyor (Meta: alıcıya ulaşılamıyor)';
  if (e.rateLimited) return 'Meta istek sınırına ulaşıldı; biraz sonra yeniden dene';
  if (e.permission) return `${name} mesaj gönderme izni yok — yeniden giriş yapıp izin ver`;
  return `${name}: ${short(e)}`;
}

/** Instagram uzun ömürlü belirteci: süresi dolmadıysa ve 10 günden az kaldıysa yenilenir (60 günlük; ≥24 sa yaşında olmalı) */
export function igNeedsRefresh(expiresAt: number | undefined, now = Date.now()): boolean {
  return !!expiresAt && expiresAt > now && expiresAt - now < 10 * DAY;
}

/** Graph zaman damgası ("2026-10-08T10:00:00+0000" ya da Unix sn) → ms */
export function parseMetaTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string' || !v) return undefined;
  if (/^\d+$/.test(v)) return parseMetaTime(Number(v));
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : undefined;
}

/** Uzun metni sınırı aşmayan parçalara böl (mümkünse satır/boşlukta; vekil çiftleri bölünmez) */
export function splitText(text: string, max: number): string[] {
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

/** Günlük için kısa ve belirteçsiz hata metni */
function short(e: unknown): string {
  const m = e instanceof MetaError ? `${e.code ? `#${e.code}${e.subcode ? '/' + e.subcode : ''} ` : ''}${e.message}` : e instanceof Error ? e.message : String(e);
  return m
    .split('\n')[0]
    .replace(/[A-Za-z0-9_-]{40,}/g, '…')
    .slice(0, 160);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export class MetaGraphConnector extends BaseConnector {
  private sources: Source[] = [];
  private igTok?: InstagramGraphToken;
  private version = DEFAULT_GRAPH_VERSION;
  private timer?: PollTimer;
  private offActive?: () => void;
  private polling = false;
  private stopped = false;
  /** belirteç geçersiz: yoklama durdu, kullanıcı yeniden giriş yapmalı */
  private dead = false;
  private startedAt = Date.now();
  private refreshTriedAt = 0;
  /** ilk eşitleme (testler bekleyebilsin) */
  private firstSync?: Promise<void>;
  /** konuşma → son görülen updated_time (ms); lastOk = son başarılı tur. Kalıcı: meta `meta_graph:<hesap>` */
  private seen = new Map<string, number>();
  private lastOk = 0;
  private stateDirty = false;
  /** sohbet → eski mesajlar için sonraki sayfa imleci (null = daha yok) */
  private older = new Map<string, string | null>();
  /** kaynak → konuşma listesinin sonraki sayfa imleci (null = daha yok) */
  private listAfter = new Map<string, string | null>();
  /** sohbet → alıcı kimliği (IGSID / PSID) */
  private recipients = new Map<string, string>();
  /** bu oturumda profili sorulan kişiler */
  private profileTried = new Set<string>();
  /** alan desteği: MSG_LEVELS dizini (son düzey: yalnız kimlik + tek tek ayrıntı) */
  private msgLevel = 0;
  private detailLevel = 0;
  private leanList = false;
  private loggedCodes = new Set<string>();
  /** Conversations API 2 istek/sn: GET'ler arasında en az bu kadar (testlerde 0) */
  private gapMs = 550;
  private gate: Promise<void> = Promise.resolve();
  private lastCall = 0;

  constructor(
    account: Account,
    store: Store,
    private kind: MetaKind,
  ) {
    super(account, store);
  }

  private get name(): string {
    return PROVIDER_NAME[this.kind];
  }
  private get expiredText(): string {
    return `${this.name} oturumu sona erdi — yeniden giriş yap`;
  }
  private get tokenFile(): string {
    return path.join(sessionDir(this.account.id), 'token');
  }
  private get stateKey(): string {
    return `meta_graph:${this.account.id}`;
  }
  /** Resmi API "benden" bilgisini kesin verir: aynı metinli gelen mesaj yankı sayılıp yutulmasın */
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
      if (this.kind === 'instagram') {
        await this.maybeRefresh(true);
        if (this.dead) return;
        await this.identifyIg();
      } else await this.identifyFb();
    } catch (e) {
      if (e instanceof MetaError && e.expired) return this.expire();
      if (e instanceof MetaError && e.permission) return this.setStatus('error', `${this.name} mesajlarına erişim izni yok — yeniden giriş yapıp izin ver`);
      return this.setStatus('error', `${this.name} bağlantısı kurulamadı: ${short(e)}`);
    }
    if (this.stopped) return;
    this.setStatus('connected');
    this.loadState();
    this.timer = new PollTimer(() => this.poll(), () => marketDelay(30_000, 120_000));
    this.firstSync = this.poll().finally(() => {
      if (!this.stopped && !this.dead) this.timer?.start();
    });
    // pencere öne gelince bekleyen uzun (boşta 2 dk) tur odak aralığına çekilir
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

  /** Belirteç geçersiz: kullanıcı yeniden giriş yapmalı; otomatik deneme yok */
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
    if (this.kind === 'instagram') {
      if (raw.official !== 'instagram' || typeof raw.accessToken !== 'string' || !raw.accessToken) return false;
      this.igTok = raw as InstagramGraphToken;
      this.version = this.igTok.graphVersion ?? DEFAULT_GRAPH_VERSION;
      const ids = new Set([String(raw.userId ?? '')].filter(Boolean));
      this.sources = [{ key: 'ig', token: this.igTok.accessToken, myIds: ids, myName: str(raw.username)?.toLowerCase() }];
      return true;
    }
    const t = raw as FacebookPagesToken;
    if (t.official !== 'facebook' || !Array.isArray(t.pages)) return false;
    this.version = t.graphVersion ?? DEFAULT_GRAPH_VERSION;
    this.sources = t.pages
      .filter((p) => typeof p?.id === 'string' && typeof p.token === 'string' && p.token)
      .map((p) => ({ key: p.id, token: p.token, pageId: p.id, pageName: p.name || p.id, myIds: new Set([p.id]) }));
    return this.sources.length > 0;
  }

  private writeIgToken(t: InstagramGraphToken): void {
    const tmp = `${this.tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    fs.renameSync(tmp, this.tokenFile);
    try {
      fs.chmodSync(this.tokenFile, 0o600);
    } catch {
      /* Windows */
    }
  }

  /** Instagram belirteci 10 günden az kaldıysa yenile (6 saatte en çok bir deneme) */
  private async maybeRefresh(force = false): Promise<void> {
    const t = this.igTok;
    if (this.kind !== 'instagram' || !t) return;
    const now = Date.now();
    if (!igNeedsRefresh(t.expiresAt, now)) return;
    if (!force && now - this.refreshTriedAt < 6 * 3600_000) return;
    this.refreshTriedAt = now;
    try {
      const n = await refreshToken('instagram', t.accessToken);
      this.igTok = { ...t, accessToken: n.accessToken, expiresAt: n.expiresAt ?? t.expiresAt };
      this.writeIgToken(this.igTok);
      for (const s of this.sources) s.token = n.accessToken;
      bus.log('info', 'Instagram: erişim belirteci yenilendi');
    } catch (e) {
      // geçersiz belirteç → yeniden giriş; diğer hatalarda (çok yeni belirteç, ağ) eskisiyle sürer
      if (e instanceof OAuthError && e.revoked) return this.expire();
      bus.log('warn', `Instagram belirteci yenilenemedi: ${short(e)}`);
    }
  }

  private async identifyIg(): Promise<void> {
    const src = this.sources[0]!;
    let me: J;
    try {
      me = await this.graph(src.token, 'me', { query: { fields: 'id,user_id,username,name' } });
    } catch (e) {
      if (!(e instanceof MetaError && e.badField)) throw e;
      me = await this.graph(src.token, 'me', { query: { fields: 'user_id,username' } });
    }
    for (const k of ['id', 'user_id']) if (me[k]) src.myIds.add(String(me[k]));
    const u = str(me.username) ?? this.igTok?.username;
    if (u) {
      src.myName = u.toLowerCase();
      this.account.label = `@${u}`;
    }
  }

  private async identifyFb(): Promise<void> {
    const ok: Source[] = [];
    let firstErr: unknown;
    for (const s of this.sources) {
      try {
        const me = await this.graph(s.token, 'me', { query: { fields: 'id,name' } });
        if (me.id) s.myIds.add(String(me.id));
        if (str(me.name)) s.pageName = me.name;
        ok.push(s);
      } catch (e) {
        if (e instanceof MetaError && (e.expired || e.rateLimited)) throw e;
        firstErr ??= e;
        bus.log('warn', `Facebook sayfası atlandı (${s.key}): ${short(e)}`);
      }
    }
    if (!ok.length) throw firstErr ?? new Error('Sayfa yok');
    this.sources = ok;
    const names = ok.map((s) => s.pageName ?? s.key);
    const joined = names.join(', ');
    this.account.label = joined.length <= 40 ? joined : `${names[0]} +${names.length - 1}`;
  }

  // ───────────── Graph isteği ─────────────

  private get base(): string {
    return `https://${this.kind === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'}/${this.version}`;
  }

  /** GET'ler sıralı ve aralıklı (Conversations API 2 istek/sn) */
  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.gate.then(async () => {
      const wait = this.lastCall + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
    });
    this.gate = turn.catch(() => undefined);
    await turn;
    return fn();
  }

  private async graph(token: string, p: string, o: { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<J> {
    const url = new URL(`${this.base}/${p.replace(/^\//, '')}`);
    if (!GRAPH_HOSTS.has(url.hostname)) throw new MetaError('izinsiz Graph adresi');
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const method = o.method ?? 'GET';
    // belirteç başlıkta (adreste değil: hata/günlük metnine sızmasın)
    const call = () =>
      fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}) },
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    const r = method === 'GET' ? await this.paced(call) : await call();
    const text = await r.text();
    let j: J = {};
    try {
      j = text ? (JSON.parse(text) as J) : {};
    } catch {
      /* JSON değil (ağ geçidi sayfası) */
    }
    if (!r.ok || j.error) throw metaError(j, r.status, r.headers);
    return j;
  }

  // ───────────── Kimlikler ─────────────

  private remoteOf(src: Source, convId: string): string {
    return this.kind === 'facebook' ? `${src.pageId}:${convId}` : convId;
  }

  private locate(remoteChatId: string): { src: Source; convId: string } {
    if (this.kind === 'facebook') {
      const i = remoteChatId.indexOf(':');
      const src = this.sources.find((s) => s.pageId === remoteChatId.slice(0, i));
      if (i < 1 || !src) throw new Error('Bu sohbetin Facebook Sayfası artık bağlı değil');
      return { src, convId: remoteChatId.slice(i + 1) };
    }
    const src = this.sources[0];
    if (!src) throw new Error(`${this.name} bağlı değil`);
    return { src, convId: remoteChatId };
  }

  private isMe(src: Source, u?: GUser): boolean {
    if (!u) return false;
    if (u.id && src.myIds.has(String(u.id))) return true;
    return !!src.myName && u.username?.toLowerCase() === src.myName;
  }

  private peerOf(src: Source, users: GUser[] | undefined, msgs: GMsg[]): GUser | undefined {
    const p = users?.find((u) => u.id && !this.isMe(src, u));
    if (p) return p;
    for (const m of msgs) {
      if (m.from?.id && !this.isMe(src, m.from)) return m.from;
      const to = m.to?.data?.find((u) => u.id && !this.isMe(src, u));
      if (to) return to;
    }
    return undefined;
  }

  private recipientOf(remoteChatId: string): string | undefined {
    const hit = this.recipients.get(remoteChatId);
    if (hit) return hit;
    const cid = chatId(this.account.id, remoteChatId);
    const meta = this.store.getChat(cid)?.meta;
    const fromMeta = typeof meta?.recipientId === 'string' ? meta.recipientId : undefined;
    const fromMsgs = fromMeta ?? this.store.listMessages(cid, 50).find((m) => !m.fromMe && m.senderId && m.senderId !== 'unknown')?.senderId;
    if (fromMsgs) this.recipients.set(remoteChatId, fromMsgs);
    return fromMsgs;
  }

  // ───────────── Durum (kalıcı) ─────────────

  private loadState(): void {
    try {
      const j = JSON.parse(this.store.meta(this.stateKey) ?? '{}') as { lastOk?: number; convs?: Record<string, number> };
      this.lastOk = Number(j.lastOk) || 0;
      this.seen = new Map(Object.entries(j.convs ?? {}).map(([k, v]) => [k, Number(v) || 0]));
    } catch {
      this.lastOk = 0;
      this.seen = new Map();
    }
  }

  private saveState(): void {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    const convs: Record<string, number> = {};
    for (const [k, v] of [...this.seen.entries()].slice(-2000)) convs[k] = v;
    this.store.setFlag(this.stateKey, JSON.stringify({ lastOk: this.lastOk, convs }));
  }

  // ───────────── Yoklama ─────────────

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.dead) return;
    this.polling = true;
    const started = Date.now();
    const initial = !this.lastOk;
    try {
      await this.maybeRefresh();
      if (this.dead) return;
      let ok = 0;
      let failed: unknown;
      for (const [i, src] of this.sources.entries()) {
        if (this.stopped || this.dead) return;
        try {
          await this.pollSource(src, initial, i);
          ok++;
        } catch (e) {
          if (e instanceof MetaError && (e.expired || e.rateLimited)) throw e;
          failed ??= e;
          this.logOnce(`${src.key}:${e instanceof MetaError ? e.code : 'x'}`, `${this.name} yoklama (${src.key === 'ig' ? 'hesap' : 'sayfa ' + src.key}): ${short(e)}`);
        }
      }
      if (ok) {
        this.lastOk = started;
        this.stateDirty = true;
        this.saveState();
        if (initial) this.syncProgress(100);
        await this.fillProfiles(initial ? 20 : 8);
      } else if (failed) throw failed;
    } catch (e) {
      this.onPollError(e);
    } finally {
      this.polling = false;
    }
  }

  private onPollError(e: unknown): void {
    if (e instanceof MetaError && e.expired) return this.expire();
    if (e instanceof MetaError && e.rateLimited) {
      bus.log('warn', `${this.name}: Meta istek sınırı (#${e.code || e.status}); ${Math.round(e.retryAfter ?? 300)} sn bekleniyor`);
      this.timer?.backoff(e.retryAfter ?? 300);
      return;
    }
    if (e instanceof MetaError && e.permission) {
      this.dead = true;
      this.timer?.stop();
      this.setStatus('error', `${this.name} mesajlarına erişim izni yok — yeniden giriş yapıp izin ver`);
      return;
    }
    this.logOnce(`poll:${short(e)}`, `${this.name} yoklama: ${short(e)}`);
  }

  private logOnce(key: string, text: string): void {
    if (this.loggedCodes.has(key)) return;
    if (this.loggedCodes.size > 200) this.loggedCodes.clear();
    this.loggedCodes.add(key);
    bus.log('warn', text);
  }

  /** Konuşma listesi (en yeni önce). Sonraki turlarda değişmemiş konuşmaya ulaşınca sayfalama durur. */
  private async listConvs(src: Source, initial: boolean): Promise<GConv[]> {
    const out: GConv[] = [];
    const want = initial ? 50 : 25;
    let after: string | undefined;
    for (let page = 0; page < 3; page++) {
      const r = await this.convPage(src, want, after);
      out.push(...r.convs);
      after = r.convs.length ? r.after : undefined;
      // "daha eski sohbetler" imleci: ilk eşitlemede alınan son sayfadan sonrası
      if (!this.listAfter.has(src.key) && !initial) this.listAfter.set(src.key, after ?? null);
      if (!after) break;
      if (initial ? out.length >= want : r.convs.some((c) => !this.changed(src, c))) break;
    }
    if (initial) this.listAfter.set(src.key, after ?? null);
    return initial ? out.slice(0, want) : out;
  }

  private async convPage(src: Source, limit: number, after?: string): Promise<{ convs: GConv[]; after?: string }> {
    const rich = this.kind === 'facebook' ? 'id,updated_time,unread_count,participants' : 'id,updated_time,participants';
    const p = this.kind === 'facebook' ? `${src.pageId}/conversations` : 'me/conversations';
    const ask = (fields: string) => this.graph(src.token, p, { query: { platform: this.kind === 'facebook' ? 'messenger' : 'instagram', fields, limit, after } });
    let j: J;
    try {
      j = await ask(this.leanList ? 'id,updated_time' : rich);
    } catch (e) {
      if (this.leanList || !(e instanceof MetaError && e.badField)) throw e;
      this.leanList = true;
      j = await ask('id,updated_time');
    }
    const pg = j as GPage<GConv>;
    return { convs: (pg.data ?? []).filter((c) => typeof c?.id === 'string'), after: nextCursor(pg) };
  }

  private changed(src: Source, c: GConv): boolean {
    const remote = this.remoteOf(src, c.id);
    const prev = this.seen.get(remote);
    const t = parseMetaTime(c.updated_time) ?? 0;
    return prev === undefined || t > prev || !this.store.hasChat(chatId(this.account.id, remote));
  }

  private async pollSource(src: Source, initial: boolean, index: number): Promise<void> {
    const convs = await this.listConvs(src, initial);
    const todo = convs.filter((c) => this.changed(src, c));
    const span = 39 / Math.max(1, this.sources.length);
    for (const [i, c] of todo.entries()) {
      if (this.stopped || this.dead) return;
      const remote = this.remoteOf(src, c.id);
      const prev = this.seen.get(remote);
      // canlı sayılacak (okunmamış + bildirim) mesajlar: ilk eşitlemede yok; sonra bilinen konuşmada son görülenden yeniler,
      // yeni konuşmada son başarılı turdan (2 dk pay) yeniler
      const freshAfter = initial ? undefined : (prev ?? (this.lastOk ? this.lastOk - 120_000 : undefined));
      try {
        await this.ingestConv(src, c, { limit: initial || prev === undefined ? 25 : 10, freshAfter });
        this.seen.set(remote, parseMetaTime(c.updated_time) ?? Date.now());
        this.stateDirty = true;
      } catch (e) {
        if (e instanceof MetaError && (e.expired || e.rateLimited)) throw e;
        this.logOnce(`conv:${e instanceof MetaError ? e.code : short(e)}`, `${this.name}: bir konuşma alınamadı (${short(e)})`);
      }
      if (initial) this.syncProgress(60 + span * index + (span * (i + 1)) / todo.length, 'sohbetler alınıyor');
    }
  }

  /** Bir konuşmanın mesaj sayfası (en yeni önce) */
  private async fetchMessages(src: Source, convId: string, limit: number, after?: string): Promise<{ msgs: GMsg[]; after?: string }> {
    for (;;) {
      const fields = MSG_LEVELS[this.msgLevel]!;
      try {
        let pg: GPage<GMsg>;
        if (after || this.kind === 'facebook') {
          pg = (await this.graph(src.token, `${convId}/messages`, { query: { fields: fields || 'id,created_time', limit, after } })) as GPage<GMsg>;
        } else {
          const j = await this.graph(src.token, convId, { query: { fields: fields ? `messages.limit(${limit}){${fields}}` : `messages.limit(${limit})` } });
          pg = (j.messages ?? {}) as GPage<GMsg>;
        }
        const msgs = (pg.data ?? []).filter((m) => typeof m?.id === 'string');
        return { msgs: await this.withDetails(src, convId, msgs), after: nextCursor(pg) };
      } catch (e) {
        if (!(e instanceof MetaError && e.badField) || this.msgLevel >= MSG_LEVELS.length - 1) throw e;
        this.msgLevel++;
        bus.log('info', `${this.name}: mesaj alanları daraltıldı (düzey ${this.msgLevel})`);
      }
    }
  }

  /** Yalnız kimlik/zaman dönen mesajların ayrıntısı tek tek (Instagram belgesindeki yol; konuşma başına son 20) */
  private async withDetails(src: Source, convId: string, msgs: GMsg[]): Promise<GMsg[]> {
    const out: GMsg[] = [];
    let asked = 0;
    const remote = this.remoteOf(src, convId);
    for (const m of msgs) {
      if (m.from || m.message !== undefined || m.attachments || m.shares || m.sticker) {
        out.push(m);
        continue;
      }
      if (this.hasMessage(remote, m.id) || asked >= 20) continue;
      asked++;
      try {
        out.push({ ...m, ...(await this.messageDetail(src, m.id)) });
      } catch (e) {
        if (e instanceof MetaError && (e.expired || e.rateLimited)) throw e;
        // 20'den eski mesaj "silinmiş" hatası verir: atla
      }
    }
    return out;
  }

  private async messageDetail(src: Source, id: string): Promise<GMsg> {
    for (;;) {
      try {
        return (await this.graph(src.token, id, { query: { fields: MSG_LEVELS[this.detailLevel]! } })) as GMsg;
      } catch (e) {
        if (!(e instanceof MetaError && e.badField) || this.detailLevel >= MSG_LEVELS.length - 2) throw e;
        this.detailLevel++;
      }
    }
  }

  /** Konuşma → sohbet + mesajlar. Dönen: depoya yeni giren mesaj sayısı */
  private async ingestConv(src: Source, c: GConv, o: { limit: number; freshAfter?: number }): Promise<number> {
    const remote = this.remoteOf(src, c.id);
    const cid = chatId(this.account.id, remote);
    const existing = this.store.getChat(cid);
    const { msgs, after } = await this.fetchMessages(src, c.id, o.limit);
    if (after && !this.older.has(remote)) this.older.set(remote, after);
    else if (!after && !this.older.has(remote)) this.older.set(remote, null);
    const peer = this.peerOf(src, c.participants?.data, msgs);
    if (peer?.id) this.recipients.set(remote, String(peer.id));
    const prevMeta = (existing?.meta ?? {}) as Record<string, unknown>;
    const name = (this.kind === 'instagram' ? (typeof prevMeta.profileName === 'string' ? prevMeta.profileName : undefined) ?? peer?.username ?? peer?.name : peer?.name) || existing?.name || `${this.kind === 'instagram' ? 'Instagram' : 'Messenger'} kullanıcısı`;
    const username = this.kind === 'instagram' ? peer?.username : undefined;
    this.upsertChat({
      remoteId: remote,
      name,
      kind: 'direct',
      handle: username ? `@${username}` : this.kind === 'facebook' ? src.pageName : undefined,
      link: username ? `https://www.instagram.com/${encodeURIComponent(username)}` : undefined,
      participants: peer?.id ? [{ id: String(peer.id), name, handle: username ? `@${username}` : undefined, avatarUrl: existing?.avatarUrl }] : undefined,
      meta: { ...prevMeta, ...(peer?.id ? { recipientId: String(peer.id) } : {}), ...(src.pageId ? { pageId: src.pageId, pageName: src.pageName } : {}) },
      // Messenger: sayfanın okunmamış sayacı yetkili; Instagram'da yeni gelenler sayılır
      unread: this.kind === 'facebook' && typeof c.unread_count === 'number' ? c.unread_count : undefined,
    });
    let added = 0;
    for (const m of [...msgs].reverse()) if (this.ingestMessage(src, remote, m, name, o.freshAfter)) added++;
    // mesaj alınamadıysa sıra konuşma zamanına göre
    const t = parseMetaTime(c.updated_time);
    if (t && !this.store.getChatLite(cid)?.lastMessageAt) this.upsertChat({ remoteId: remote, name, lastMessageAt: t });
    return added;
  }

  private ingestMessage(src: Source, remote: string, m: GMsg, chatName: string, freshAfter?: number): boolean {
    const ts = parseMetaTime(m.created_time) ?? Date.now();
    const fromMe = this.isMe(src, m.from);
    const atts = this.attachmentsOf(m);
    let text = typeof m.message === 'string' ? m.message : '';
    if (!text && !atts.length) text = m.is_unsupported ? 'Desteklenmeyen mesaj türü' : 'Bu içerik burada gösterilemiyor';
    const isNew = !this.hasMessage(remote, m.id);
    const fresh = isNew && !fromMe && freshAfter !== undefined && ts > freshAfter;
    this.upsertMessage(
      {
        remoteChatId: remote,
        remoteId: m.id,
        senderId: fromMe ? 'me' : String(m.from?.id ?? 'unknown'),
        senderName: fromMe ? 'Ben' : (m.from?.name ?? m.from?.username ?? chatName),
        fromMe,
        text,
        ts,
        status: fromMe ? 'sent' : 'delivered',
        attachments: atts.length ? atts : undefined,
      },
      // bildirim yalnız bu oturumda gelenlere; Messenger okunmamışı sayfadan (bump yok)
      { live: fresh && ts >= this.startedAt - 120_000, bump: this.kind === 'instagram' ? fresh : false },
    );
    return isNew;
  }

  // ───────────── Ekler / medya ─────────────

  private proxied(u: unknown): string | undefined {
    if (typeof u !== 'string' || !/^https:\/\//i.test(u)) return undefined;
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      return undefined;
    }
    if (!mediaHostAllowed(this.account.platform, host)) return undefined;
    return `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(u)}`;
  }

  /** Graph ek biçimleri (image_data/video_data/file_url) ve webhook biçimi ({type, payload.url}) */
  private attachmentsOf(m: GMsg): Attachment[] {
    const out: Attachment[] = [];
    const raw: J[] = Array.isArray(m.attachments) ? m.attachments : (m.attachments?.data ?? []);
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const mime = str(a.mime_type);
      const name = str(a.name);
      const size = Number(a.size) || undefined;
      const img = a.image_data as J | undefined;
      if (img?.url || img?.preview_url) {
        const full = this.proxied(img.animated_gif_url ?? img.url ?? img.preview_url);
        out.push({ kind: 'image', name: name ?? (img.render_as_sticker ? 'Çıkartma' : 'Fotoğraf'), mime, size, url: this.proxied(img.preview_url) ?? full, link: full });
        continue;
      }
      const vid = a.video_data as J | undefined;
      if (vid?.url) {
        out.push({ kind: 'video', name: name ?? 'Video', mime, size, url: this.proxied(vid.preview_url), link: this.proxied(vid.url) });
        continue;
      }
      const aud = a.audio_data as J | undefined;
      if (aud?.url) {
        out.push({ kind: 'audio', name: name ?? 'Sesli mesaj', mime, size, link: this.proxied(aud.url) });
        continue;
      }
      if (str(a.file_url)) {
        const link = this.proxied(a.file_url);
        if (mime?.startsWith('audio/')) out.push({ kind: 'audio', name: name ?? 'Sesli mesaj', mime, size, link });
        else if (mime?.startsWith('video/')) out.push({ kind: 'video', name: name ?? 'Video', mime, size, link });
        else if (mime?.startsWith('image/')) out.push({ kind: 'image', name: name ?? 'Fotoğraf', mime, size, url: link, link });
        else out.push({ kind: 'file', name: name ?? 'Dosya', mime, size, link });
        continue;
      }
      const pu = str((a.payload as J | undefined)?.url);
      if (pu) {
        const t = String(a.type ?? '');
        const px = this.proxied(pu);
        if (t === 'image') out.push({ kind: 'image', name: 'Fotoğraf', url: px, link: px });
        else if (t === 'video') out.push({ kind: 'video', name: 'Video', link: px });
        else if (t === 'audio') out.push({ kind: 'audio', name: 'Sesli mesaj', link: px });
        else if (t === 'file') out.push({ kind: 'file', name: 'Dosya', link: px });
        else out.push({ kind: 'other', name: t === 'story_mention' ? 'Hikâyede senden bahsetti' : 'Paylaşım', url: /\.(jpe?g|png|webp)(\?|$)/i.test(pu) ? px : undefined, link: px ?? (/^https:\/\//.test(pu) ? pu : undefined) });
      }
    }
    // paylaşım: Meta yalnız görsel/video adresini verir
    for (const s of m.shares?.data ?? []) {
      const link = str(s?.link);
      if (!link) continue;
      const px = this.proxied(link);
      if (px) out.push(/\.mp4(\?|$)/i.test(link) ? { kind: 'video', name: 'Paylaşılan video', link: px } : { kind: 'image', name: str(s.name) ?? 'Paylaşım', url: px, link: px });
      else if (/^https:\/\//i.test(link)) out.push({ kind: 'other', name: str(s.name) ?? 'Paylaşım', link });
    }
    if (str(m.sticker)) {
      const px = this.proxied(m.sticker);
      if (px) out.push({ kind: 'image', name: 'Çıkartma', url: px, link: px });
    }
    return out;
  }

  /** Meta CDN'den imzalı medya (belirteçsiz; yönlendirmeler izin listesinden). Disk önbelleği: sessions/<hesap>/media/<sha1> */
  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    const dir = path.join(sessionDir(this.account.id), 'media');
    const file = path.join(dir, createHash('sha1').update(url).digest('hex'));
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    let cur = url;
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(cur);
      if (u.protocol !== 'https:' || !mediaHostAllowed(this.account.platform, u.hostname)) throw new Error(`yönlendirme izinli değil: ${u.hostname}`);
      const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (!r.ok) throw new Error(`Meta medya ${r.status}`);
      if (Number(r.headers.get('content-length') ?? 0) > MEDIA_MAX) throw new Error('medya çok büyük');
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > MEDIA_MAX) throw new Error('medya çok büyük');
      const type = r.headers.get('content-type') ?? 'application/octet-stream';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body);
      fs.writeFileSync(file + '.type', type);
      return { body, type };
    }
    throw new Error('Meta medya: çok fazla yönlendirme');
  }

  /** Profil fotoğrafı ve (Instagram) görünen ad: kişi başına oturumda bir kez, tur başına bütçeli */
  private async fillProfiles(budget: number): Promise<void> {
    const todo = this.store
      .listChatsOf(this.account.id)
      .filter((c) => !c.avatarUrl && typeof c.meta?.recipientId === 'string' && !this.profileTried.has(c.remoteId))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, budget);
    for (const c of todo) {
      if (this.stopped || this.dead) return;
      this.profileTried.add(c.remoteId);
      let src: Source;
      try {
        src = this.locate(c.remoteId).src;
      } catch {
        continue;
      }
      let j: J;
      try {
        j = await this.graph(src.token, String(c.meta!.recipientId), { query: { fields: this.kind === 'instagram' ? 'name,username,profile_pic' : 'name,profile_pic' } });
      } catch (e) {
        // izin/rıza yok (230), kişi bulunamadı (100): adsız kalır
        if (e instanceof MetaError && (e.expired || e.rateLimited)) throw e;
        continue;
      }
      const avatarUrl = this.proxied(j.profile_pic);
      const full = str(j.name);
      const name = full ?? c.name;
      if (!avatarUrl && name === c.name) continue;
      this.upsertChat({ remoteId: c.remoteId, name, avatarUrl, meta: { ...(c.meta ?? {}), ...(this.kind === 'instagram' && full ? { profileName: full } : {}) } });
    }
  }

  // ───────────── Gönderim / okundu / geçmiş ─────────────

  async sendText(remoteChatId: string, text: string, _opts?: SendOptions): Promise<{ remoteId: string }> {
    if (this.dead) throw new Error(this.expiredText);
    const { src } = this.locate(remoteChatId);
    const recipient = this.recipientOf(remoteChatId);
    if (!recipient) throw new Error('Alıcı bilinmiyor; sohbet yeniden eşitlenince dene');
    let last = '';
    // Instagram metni ≤1000, Messenger ≤2000 karakter
    for (const part of splitText(text, this.kind === 'instagram' ? 1000 : 2000)) {
      const body = this.kind === 'facebook' ? { recipient: { id: recipient }, messaging_type: 'RESPONSE', message: { text: part } } : { recipient: { id: recipient }, message: { text: part } };
      let j: J;
      try {
        j = await this.graph(src.token, this.kind === 'facebook' ? `${src.pageId}/messages` : 'me/messages', { method: 'POST', body });
      } catch (e) {
        if (e instanceof MetaError && e.expired) this.expire();
        throw new Error(sendErrorText(e, this.kind));
      }
      const id = str(j.message_id) ?? `local-${Date.now()}`;
      // yanıtı beklemeden balon: sonraki turda aynı kimlikle gelir (kopya olmaz)
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: part, ts: Date.now(), status: 'sent' });
      last = id;
    }
    return { remoteId: last };
  }

  /** Mivelo'da açılan sohbet Meta'da da görüldü (sender_action mark_seen); hata sessiz */
  async markRead(remoteChatId: string): Promise<void> {
    if (this.dead || this.stopped) return;
    const recipient = this.recipientOf(remoteChatId);
    if (!recipient) return;
    try {
      const { src } = this.locate(remoteChatId);
      await this.graph(src.token, this.kind === 'facebook' ? `${src.pageId}/messages` : 'me/messages', { method: 'POST', body: { recipient: { id: recipient }, sender_action: 'mark_seen' } });
    } catch (e) {
      if (e instanceof MetaError && e.expired) return this.expire();
      this.logOnce(`seen:${e instanceof MetaError ? e.code : 'x'}`, `${this.name}: görüldü bildirilemedi (${short(e)})`);
    }
  }

  /** Eski mesajlar: konuşmanın mesaj sayfaları (Instagram'da Meta yalnız son 20 mesajın ayrıntısını verir) */
  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void | { unavailable?: string }> {
    if (this.dead || this.stopped || !this.sources.length) return { unavailable: `${this.name} bağlı değil` };
    const { src, convId } = this.locate(remoteChatId);
    const chatName = this.store.getChat(chatId(this.account.id, remoteChatId))?.name ?? '';
    let after = this.older.get(remoteChatId);
    if (after === null) return;
    let got = 0;
    const take = (msgs: GMsg[]) => {
      for (const m of [...msgs].reverse()) {
        const isNew = this.ingestMessage(src, remoteChatId, m, chatName);
        if (isNew && (!before || (parseMetaTime(m.created_time) ?? 0) < before)) got++;
      }
    };
    try {
      if (after === undefined) {
        const first = await this.fetchMessages(src, convId, 25);
        take(first.msgs);
        after = first.after;
      }
      for (let i = 0; i < 5 && after && got < limit; i++) {
        const pg = await this.fetchMessages(src, convId, Math.min(50, Math.max(10, limit)), after);
        take(pg.msgs);
        after = pg.msgs.length ? pg.after : undefined;
      }
    } catch (e) {
      if (e instanceof MetaError && e.expired) {
        this.expire();
        throw new Error(this.expiredText);
      }
      if (e instanceof MetaError && e.rateLimited) throw new Error('Meta istek sınırına ulaşıldı; biraz sonra yeniden dene');
      // Meta'nın verdiği aralığın sonu (eski mesaj ayrıntısı yok): daha eski yok
      if (e instanceof MetaError && e.code === 100) after = undefined;
      else throw e;
    }
    this.older.set(remoteChatId, after ?? null);
  }

  /** Sohbet listesinin sonraki sayfası (ilk eşitlemedeki 50 konuşmadan eskiler) */
  async loadMoreChats(): Promise<number> {
    if (this.dead || this.stopped) return 0;
    let added = 0;
    for (const src of this.sources) {
      for (let page = 0; page < 4 && added === 0; page++) {
        const after = this.listAfter.get(src.key);
        if (!after) break;
        const r = await this.convPage(src, 25, after);
        this.listAfter.set(src.key, r.convs.length ? (r.after ?? null) : null);
        for (const c of r.convs) {
          const remote = this.remoteOf(src, c.id);
          if (this.store.hasChat(chatId(this.account.id, remote))) continue;
          await this.ingestConv(src, c, { limit: 25 });
          this.seen.set(remote, parseMetaTime(c.updated_time) ?? 0);
          this.stateDirty = true;
          added++;
        }
      }
    }
    this.saveState();
    return added;
  }
}

/** Sonraki sayfa imleci (cursors.after; yoksa next adresindeki after) */
function nextCursor(pg: GPage<unknown>): string | undefined {
  if (!pg.paging?.next) return undefined;
  const a = pg.paging.cursors?.after;
  if (a) return a;
  try {
    return new URL(pg.paging.next).searchParams.get('after') ?? undefined;
  } catch {
    return undefined;
  }
}
