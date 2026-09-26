import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { type ComposeDraft, BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Attachment, Chat, Participant, Platform } from '../model.js';

/**
 * E-posta: IMAP (okuma) + SMTP (gönderme). Gmail / Yahoo / iCloud / özel sunucu için
 * uygulama şifresiyle; Outlook / Microsoft 365 için ücretsiz Azure uygulama kimliğiyle
 * "cihaz kodu" OAuth akışı (Microsoft kişisel hesaplarda şifreyle IMAP'ı kapattı).
 *
 * Her e-posta konuşması (thread) bir sohbet, her e-posta bir mesajdır. Yanıt, son gelen
 * e-postaya In-Reply-To/References ile SMTP üzerinden gönderilir.
 */
export interface MailConfig {
  user: string; // e-posta adresi
  pass?: string; // uygulama şifresi (OAuth kullanılmıyorsa)
  host?: string;
  port?: number;
  secure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  clientId?: string; // Outlook: Azure uygulama kimliği / Gmail: Google Cloud OAuth istemci kimliği
  clientSecret?: string; // Gmail OAuth istemci gizi (masaüstü uygulaması türü)
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}

const PRESETS: Partial<Record<Platform, Required<Pick<MailConfig, 'host' | 'port' | 'secure' | 'smtpHost' | 'smtpPort' | 'smtpSecure'>>>> = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
};

const MS_SCOPES = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://mail.google.com/';
const CALLBACK = `http://127.0.0.1:${process.env.KAVSAK_PORT ?? 7788}/oauth/callback`;

/** Bekleyen OAuth geri dönüşleri: state → çözücü. Sunucu /oauth/callback ile çağırır. */
const pendingOAuth = new Map<string, (r: { code?: string; error?: string }) => void>();
export function resolveOAuth(state: string, r: { code?: string; error?: string }): boolean {
  const fn = pendingOAuth.get(state);
  if (!fn) return false;
  pendingOAuth.delete(state);
  fn(r);
  return true;
}

/** Diğer OAuth akışları (Etsy vb.) için: /oauth/callback'e gelen code/error'u bekle (10 dk). */
export function waitOAuth(state: string, timeoutMs = 600_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    pendingOAuth.set(state, (r) => (r.code ? resolve(r.code) : reject(new Error(r.error ?? 'Giriş iptal edildi'))));
    setTimeout(() => {
      if (pendingOAuth.delete(state)) reject(new Error('Giriş zaman aşımına uğradı'));
    }, timeoutMs).unref?.();
  });
}
export const OAUTH_CALLBACK = CALLBACK;

/** Görünür bir Chromium penceresi aç; `done` çözülünce kapat. Kullanıcı yalnızca giriş yapar. */
export async function withAuthWindow<T>(url: string, done: Promise<T>): Promise<T> {
  let close = async () => {};
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: false,
      channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium',
      executablePath: process.env.KAVSAK_CHROMIUM || undefined,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=560,760'],
    });
    const page = await browser.newPage({ viewport: { width: 540, height: 720 } });
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    close = () => browser.close().catch(() => undefined);
    browser.on('disconnected', () => pendingOAuth.forEach((fn, k) => (pendingOAuth.delete(k), fn({ error: 'Pencere kapatıldı' }))));
  } catch (e) {
    bus.log('warn', `Giriş penceresi açılamadı (${(e as Error).message.split('\n')[0]}); adresi kendin aç: ${url}`);
  }
  try {
    return await done;
  } finally {
    await close();
  }
}
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_DEVICE = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';

const cleanSubject = (s: string | undefined) => (s ?? '').replace(/^\s*((re|fw|fwd|ynt|ilt)\s*:\s*)+/i, '').trim() || '(konu yok)';
const addrs = (a: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value.map((v) => ({ address: (v.address ?? '').toLowerCase(), name: v.name || v.address || '' })));
};

export class MailConnector extends BaseConnector {
  private cfg: MailConfig;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private polling = false;
  private lastUid = 0;
  /** Şimdiye dek alınan en küçük UID (daha eski sayfa buradan geriye gider); 0 = bilinmiyor, 1 = kutunun başı */
  private oldestUid = 0;
  private threadOf = new Map<string, string>(); // message-id → thread key
  private stateFile: string;
  /** INBOX UIDVALIDITY: değişirse (kutu yeniden oluşturuldu/taşındı) UID imleçleri geçersiz → baştan eşitle */
  private uidValidity = '';
  /** Sağlayıcı kısıtı (ETHROTTLE, [LIMIT], çok fazla bağlantı): bu zamana dek yoklama/IDLE yok */
  private pauseUntil = 0;
  /** Kimlik reddedildi: otomatik deneme yok (tekrarlı başarısız giriş "Too many login failures" kilidine götürür) */
  private authFailed = false;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], cfg: MailConfig) {
    super(account, store);
    this.cfg = { ...PRESETS[account.platform], ...cfg };
    this.stateFile = path.join(sessionDir(account.id), 'mail-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { lastUid?: number; oldestUid?: number; uidValidity?: string; threads?: Record<string, string> };
      this.lastUid = st.lastUid ?? 0;
      this.uidValidity = st.uidValidity ?? '';
      this.oldestUid = st.oldestUid ?? 0;
      for (const [k, v] of Object.entries(st.threads ?? {})) this.threadOf.set(k, v);
    } catch {
      /* ilk çalıştırma */
    }
  }

  private saveState(): void {
    const threads: Record<string, string> = {};
    let i = 0;
    for (const [k, v] of [...this.threadOf.entries()].slice(-5000)) {
      threads[k] = v;
      i++;
    }
    void i;
    fs.writeFileSync(this.stateFile, JSON.stringify({ lastUid: this.lastUid, oldestUid: this.oldestUid, uidValidity: this.uidValidity, threads }));
  }

  private saveCfg(): void {
    fs.writeFileSync(path.join(sessionDir(this.account.id), 'token'), JSON.stringify(this.cfg), { mode: 0o600 });
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    this.authFailed = false; // kullanıcı yeniden bağladı
    this.pauseUntil = 0;
    this.account.label = this.cfg.user || this.account.platform;
    if (!this.cfg.user) return this.setStatus('error', 'E-posta adresi girilmedi');
    this.setStatus('connecting');
    try {
      if (this.account.platform === 'outlook' || (!this.cfg.pass && this.cfg.clientId)) await this.ensureOAuth();
      else if (this.cfg.pass && this.cfg.accessToken) this.cfg.accessToken = undefined;
      else if (!this.cfg.pass) return this.setStatus('error', 'Uygulama şifresi gerekli');
      if (this.stopping) return;
      await this.poll(true);
      this.setStatus('connected', this.cfg.user);
      this.schedule();
      void this.startIdle();
    } catch (e) {
      this.setStatus('error', (e as Error).message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleRetry) clearTimeout(this.idleRetry);
    if (this.idleDebounce) clearTimeout(this.idleDebounce);
    const c = this.idleClient;
    this.idleClient = undefined;
    this.idleUp = false;
    if (c) {
      c.removeAllListeners();
      await c.logout().catch(() => undefined);
      c.close();
    }
    this.setStatus('disconnected');
  }

  /**
   * Yoklama: IMAP IDLE bağlantısı açıkken yeni e-posta zaten anında haber verir → yoklama yalnız yedek (~5 dk);
   * IDLE yoksa/koptuysa ~60 sn. Her tur ±%30 sapmalı.
   */
  private schedule(): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.authFailed) return;
    // IDLE açıkken yoklama aynı bağlantıda, yalnız yedek (10 dk). IDLE yoksa her tur yeni oturum = yeni giriş: 2 dk
    // (Yahoo 3-5 eşzamanlı oturum, Gmail 15; dakikalık giriş sağlayıcı kilidine yaklaştırır — EmailEngine/imapflow önerisi)
    const base = this.idleUp ? 600_000 : 120_000;
    const wait = Math.max(base * (0.7 + Math.random() * 0.6), this.pauseUntil - Date.now());
    this.timer = setTimeout(async () => {
      await this.poll(false);
      this.schedule();
    }, Math.round(wait));
    this.timer.unref?.();
  }

  // ---------- IMAP IDLE (anlık bildirim, RFC 2177) ----------
  private idleClient?: ImapFlow;
  private idleUp = false;
  private idleFails = 0;
  private idleRetry?: NodeJS.Timeout;
  private idleDebounce?: NodeJS.Timeout;

  /** IDLE için ayrı, uzun ömürlü IMAP oturumu açar (testler ezer: gerçek sunucuya bağlanılmasın) */
  protected createIdleClient(): ImapFlow {
    // maxIdleTime: IDLE 20 dk'da bir yenilenir (sunucular ~30 dk'da boştaki IDLE'ı düşürür; RFC 2177 29 dk önerir).
    // missingIdleCommand STATUS: IDLE bildirmeyen sunucuda varsayılan NOOP bazılarında yeni postayı hiç bildirmiyor
    return new ImapFlow({ host: this.cfg.host!, port: this.cfg.port!, secure: this.cfg.secure ?? true, auth: this.auth(), logger: false, maxIdleTime: 20 * 60_000, missingIdleCommand: 'STATUS' });
  }

  /**
   * INBOX'ı seçili tutan ikinci oturum: imapflow boştayken kendiliğinden IDLE'a geçer; sunucu yeni e-posta bildirince
   * ('exists') 1 sn içinde normal yoklama çalışır (yalnız yeni UID'ler çekilir). Sunucu IDLE desteklemiyorsa imapflow
   * NOOP ile yoklar, 'exists' yine gelir. Kopmada üstel yeniden bağlanma (5 sn → ≤5 dk, sapmalı); OAuth belirteci yenilenir.
   */
  private async startIdle(): Promise<void> {
    if (this.stopping || this.idleClient || this.authFailed) return;
    let client: ImapFlow | undefined;
    try {
      if (this.cfg.accessToken) await this.ensureOAuth();
      client = this.createIdleClient();
      this.idleClient = client;
      const c = client;
      c.on('exists', (d: { count?: number; prevCount?: number }) => {
        if ((d.count ?? 0) <= (d.prevCount ?? 0)) return; // silme/taşıma
        if (this.idleDebounce) clearTimeout(this.idleDebounce);
        this.idleDebounce = setTimeout(() => void this.poll(false), 1000);
      });
      c.on('close', () => {
        if (this.idleClient !== c) return;
        this.idleClient = undefined;
        this.idleUp = false;
        this.retryIdle();
      });
      c.on('error', () => undefined); // 'close' ardından gelir; yeniden bağlanma orada
      await c.connect();
      await c.mailboxOpen('INBOX');
      if (this.stopping || this.idleClient !== c) return;
      if (!this.idleUp) bus.log('info', `${this.account.platform}: anlık e-posta bildirimi (IMAP IDLE) açık`);
      this.idleUp = true;
      this.idleFails = 0;
      this.schedule(); // yoklama yedeğe insin
      void this.poll(false); // bağlantı arası kaçan e-postalar
    } catch (e) {
      if (client && this.idleClient === client) {
        this.idleClient = undefined;
        client.removeAllListeners();
        client.close();
      }
      this.idleUp = false;
      this.classify(e);
      if (this.idleFails === 0) bus.log('warn', `${this.account.platform}: IMAP IDLE açılamadı (${(e as Error).message.split('\n')[0]}); dakikalık yoklamayla devam`);
      this.retryIdle();
    }
  }

  /**
   * imapflow hata sınıfları (postalsys/imapflow errors.ts): authenticationFailed → dur, kullanıcı yeniden bağlasın;
   * ETHROTTLE → throttleReset kadar bekle; [ALERT]/[LIMIT]/çok fazla eşzamanlı bağlantı → 15 dk bekle.
   */
  private classify(e: unknown): void {
    const err = e as { authenticationFailed?: boolean; code?: string; throttleReset?: number; message?: string; response?: string };
    const text = `${err.message ?? ''} ${err.response ?? ''}`;
    if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Web login required/i.test(text)) {
      this.authFailed = true;
      if (this.timer) clearTimeout(this.timer);
      if (this.idleRetry) clearTimeout(this.idleRetry);
      this.setStatus('error', 'Giriş reddedildi: uygulama şifresini kontrol edip "Yeniden bağlan" de (tekrarlı deneme hesabı kilitleyebileceği için otomatik denenmiyor)');
      return;
    }
    if (err.code === 'ETHROTTLE') this.pauseUntil = Date.now() + Math.max(err.throttleReset ?? 60_000, 30_000);
    else if (/\[ALERT\]|\[LIMIT\]|Too many simultaneous|too many connections|bandwidth limits/i.test(text)) {
      this.pauseUntil = Date.now() + 15 * 60_000;
      bus.log('warn', `${this.account.platform}: sağlayıcı sınırı bildirdi, 15 dk bekleniyor`);
    }
  }

  private retryIdle(): void {
    if (this.stopping || this.authFailed) return;
    this.schedule(); // IDLE yokken yoklama sıklaşsın
    const ms = Math.max(Math.min(300_000, 5_000 * 2 ** this.idleFails++) * (0.7 + Math.random() * 0.6), this.pauseUntil - Date.now());
    if (this.idleRetry) clearTimeout(this.idleRetry);
    this.idleRetry = setTimeout(() => void this.startIdle(), ms);
    this.idleRetry.unref?.();
  }

  // ---------- Microsoft OAuth (cihaz kodu) ----------
  private async ensureOAuth(): Promise<void> {
    if (this.account.platform === 'gmail') return this.ensureGoogle();
    if (!this.cfg.clientId) throw new Error('Outlook için Azure uygulama kimliği (Client ID) gerekli — bkz. README');
    if (this.cfg.accessToken && (this.cfg.expiresAt ?? 0) > Date.now() + 60_000) return;
    if (this.cfg.refreshToken) {
      const ok = await this.msToken({ grant_type: 'refresh_token', refresh_token: this.cfg.refreshToken }).catch(() => false);
      if (ok) return;
    }
    const dc = (await (
      await fetch(MS_DEVICE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, scope: MS_SCOPES }) })
    ).json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number; error?: string; error_description?: string };
    if (dc.error) throw new Error(dc.error_description ?? dc.error);
    this.setStatus('pairing', `Açılan pencerede Microsoft hesabınla giriş yap (kod: ${dc.user_code})`);
    const poll = (async () => {
      const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
      while (!this.stopping && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, (dc.interval ?? 5) * 1000));
        const r = await this.msToken({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code }, true);
        if (r === true) return;
        if (r !== 'pending') throw new Error(String(r));
      }
      throw new Error('Microsoft girişi zaman aşımına uğradı');
    })();
    // kod önceden doldurulmuş cihaz girişi sayfası; giriş bitince pencere kendiliğinden kapanır
    await withAuthWindow(`https://microsoft.com/devicelogin?otc=${encodeURIComponent(dc.user_code)}`, poll);
  }

  // ---------- Google OAuth (yerel geri dönüş) ----------
  private async ensureGoogle(): Promise<void> {
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new Error('Gmail OAuth için Google Cloud istemci kimliği ve gizi gerekli (ya da uygulama şifresi gir)');
    if (this.cfg.accessToken && (this.cfg.expiresAt ?? 0) > Date.now() + 60_000) return;
    if (this.cfg.refreshToken) {
      const ok = await this.googleToken({ grant_type: 'refresh_token', refresh_token: this.cfg.refreshToken }).catch(() => false);
      if (ok) return;
    }
    const state = randomBytes(16).toString('hex');
    const url =
      `${GOOGLE_AUTH}?` +
      new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: CALLBACK, response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', state, login_hint: this.cfg.user }).toString();
    this.setStatus('pairing', 'Açılan pencerede Google hesabınla giriş yap ve izin ver');
    const code = new Promise<string>((resolve, reject) => {
      pendingOAuth.set(state, (r) => (r.code ? resolve(r.code) : reject(new Error(r.error ?? 'Google girişi iptal edildi'))));
      setTimeout(() => {
        if (pendingOAuth.delete(state)) reject(new Error('Google girişi zaman aşımına uğradı'));
      }, 600_000);
    });
    const c = await withAuthWindow(url, code);
    const ok = await this.googleToken({ grant_type: 'authorization_code', code: c, redirect_uri: CALLBACK });
    if (ok !== true) throw new Error(String(ok));
  }

  private async googleToken(params: Record<string, string>): Promise<true | string> {
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret!, ...params }),
    });
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (j.access_token) {
      this.cfg.accessToken = j.access_token;
      this.cfg.refreshToken = j.refresh_token ?? this.cfg.refreshToken;
      this.cfg.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
      this.saveCfg();
      return true;
    }
    return j.error_description ?? j.error ?? 'token alınamadı';
  }

  private async msToken(params: Record<string, string>, devicePoll = false): Promise<true | 'pending' | string> {
    const r = await fetch(MS_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId!, scope: MS_SCOPES, ...params }),
    });
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (j.access_token) {
      this.cfg.accessToken = j.access_token;
      this.cfg.refreshToken = j.refresh_token ?? this.cfg.refreshToken;
      this.cfg.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
      this.saveCfg();
      return true;
    }
    if (devicePoll && (j.error === 'authorization_pending' || j.error === 'slow_down')) return 'pending';
    return j.error_description ?? j.error ?? 'token alınamadı';
  }

  private auth(): { user: string; pass?: string; accessToken?: string } {
    return this.cfg.accessToken ? { user: this.cfg.user, accessToken: this.cfg.accessToken } : { user: this.cfg.user, pass: this.cfg.pass };
  }

  // ---------- IMAP ----------
  /** IMAP bağlantısı aç, INBOX kilidiyle `fn`i çalıştır, kapat. Testler sahte istemci için bu metodu ezer. */
  protected async withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    // IDLE bağlantısı açıksa onu kullan: imapflow kilit alınınca IDLE'dan çıkar, bırakınca yeniden girer (connectionBusy/autoidle).
    // Her turda yeni oturum açılmaz → sağlayıcının eşzamanlı oturum/giriş sınırlarından uzak durulur.
    const idle = this.idleClient;
    if (idle && this.idleUp && idle.usable) {
      const lock = await idle.getMailboxLock('INBOX');
      try {
        return await fn(idle);
      } finally {
        lock.release();
      }
    }
    const client = new ImapFlow({ host: this.cfg.host!, port: this.cfg.port!, secure: this.cfg.secure ?? true, auth: this.auth(), logger: false });
    try {
      if (this.cfg.accessToken) await this.ensureOAuth();
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  }

  /** Verilen UID'leri indirip sohbet/mesaj olarak yaz; (işlenen e-posta, yeni açılan sohbet) sayısını döner */
  private async fetchUids(client: ImapFlow, uids: number[], live: boolean, folder?: MailFolder): Promise<{ mails: number; chats: number }> {
    let mails = 0;
    let chats = 0;
    if (!uids.length) return { mails, chats };
    for await (const msg of client.fetch(uids, { uid: true, source: true, flags: true, threadId: true }, { uid: true })) {
      try {
        if (!msg.source) continue;
        const parsed: ParsedMail = await simpleParser(msg.source);
        if (this.ingest(parsed, msg.uid, msg.flags?.has('\\Seen') ?? false, (msg as { threadId?: string }).threadId, live, folder ?? 'inbox')) chats++;
        mails++;
      } catch (e) {
        bus.log('warn', `${this.account.platform} e-posta okunamadı (uid ${msg.uid}): ${(e as Error).message}`);
      }
      if (folder && folder !== 'inbox') continue; // başka kutunun UID'leri gelen kutusu imlecini oynatmasın
      if (msg.uid > this.lastUid) this.lastUid = msg.uid;
      if (!this.oldestUid || msg.uid < this.oldestUid) this.oldestUid = msg.uid;
    }
    return { mails, chats };
  }

  /** Yoklama sürerken gelen IDLE bildirimi: tur bitince bir kez daha (yeni e-posta 5 dk'lık yedeğe kalmasın) */
  private pollAgain = false;

  private async poll(first: boolean): Promise<void> {
    if (this.stopping) return;
    if (this.polling) {
      if (!first) this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      await this.withInbox(async (client) => {
        const v = String((client as { mailbox?: { uidValidity?: bigint | number } | false }).mailbox ? ((client as { mailbox: { uidValidity?: bigint | number } }).mailbox.uidValidity ?? '') : '');
        if (v && this.uidValidity && v !== this.uidValidity) {
          bus.log('warn', `${this.account.platform}: gelen kutusunun UIDVALIDITY değeri değişti; UID imleçleri sıfırlanıp son 30 gün yeniden eşitleniyor`);
          this.lastUid = 0;
          this.oldestUid = 0;
        }
        if (v) this.uidValidity = v;
        let uids: number[];
        if (this.lastUid > 0) uids = (await client.search({ uid: `${this.lastUid + 1}:*` }, { uid: true })) || [];
        else {
          const since = new Date(Date.now() - 30 * 86_400_000);
          uids = ((await client.search({ since }, { uid: true })) || []).slice(-150);
        }
        uids = uids.filter((u) => u > this.lastUid);
        const { mails } = await this.fetchUids(client, uids, !first);
        if (mails) bus.log('info', `${this.account.platform}: ${mails} e-posta alındı`);
        this.saveState();
      });
      // Gönderilenler / Gereksiz: her 8. yoklamada (ilk dahil) özel kullanım bayraklı kutulardan son 40 e-posta
      if (this.folderTick++ % 8 === 0) await this.pollFolders().catch((e) => bus.log('warn', `${this.account.platform} klasörler: ${(e as Error).message}`));
    } catch (e) {
      bus.log('warn', `${this.account.platform} IMAP: ${(e as Error).message}`);
      if (first) throw e;
      this.classify(e);
    } finally {
      this.polling = false;
      if (this.pollAgain && !this.stopping) {
        this.pollAgain = false;
        setTimeout(() => void this.poll(false), 500).unref?.();
      }
    }
  }

  /**
   * Daha eski e-postalar: şimdiye dek alınan en küçük UID'den geriye en çok 100 e-posta (sayfa). Eski durum dosyasında
   * oldestUid yoksa ilk eşitlemenin penceresi (son 30 gün / 150) yeniden hesaplanır. Yeni açılan sohbet (thread) sayısı döner; 0 = daha yok.
   */
  async loadMoreChats(): Promise<number> {
    if (this.stopping) return 0;
    if (this.oldestUid === 1) return 0;
    // Yoklama sürüyorsa bitmesini bekle (aynı anda iki IMAP oturumu durumu bozmasın)
    for (let i = 0; this.polling && i < 100; i++) await new Promise((r) => setTimeout(r, 200));
    if (this.polling) throw new Error('E-posta eşitlemesi sürüyor, biraz sonra yeniden dene');
    this.polling = true;
    try {
      return await this.withInbox(async (client) => {
        if (!this.oldestUid) {
          const since = new Date(Date.now() - 30 * 86_400_000);
          const firstPage = ((await client.search({ since }, { uid: true })) || []).slice(-150);
          this.oldestUid = firstPage.length ? Math.min(...firstPage) : this.lastUid + 1;
        }
        if (this.oldestUid <= 1) {
          this.oldestUid = 1;
          return 0;
        }
        const older = ((await client.search({ uid: `1:${this.oldestUid - 1}` }, { uid: true })) || []).filter((u) => u < this.oldestUid);
        const page = olderPage(older, 100);
        if (!page.length) {
          this.oldestUid = 1;
          this.saveState();
          return 0;
        }
        const { mails, chats } = await this.fetchUids(client, page, false);
        bus.log('info', `${this.account.platform}: ${mails} eski e-posta alındı (${chats} yeni sohbet)`);
        this.saveState();
        return chats;
      });
    } finally {
      this.polling = false;
    }
  }

  private folderTick = 0;
  /** \\Sent ve \\Junk kutuları (imapflow specialUse); yoksa adla (Sent, Gönderilmiş, Junk, Spam) */
  private async pollFolders(): Promise<void> {
    if (this.stopping) return;
    const client = new ImapFlow({ host: this.cfg.host!, port: this.cfg.port!, secure: this.cfg.secure ?? true, auth: this.auth(), logger: false });
    try {
      if (this.cfg.accessToken) await this.ensureOAuth();
      await client.connect();
      const boxes = await client.list();
      const pick = (use: string, re: RegExp) => boxes.find((b) => (b as { specialUse?: string }).specialUse === use) ?? boxes.find((b) => re.test(b.path));
      const targets: Array<[MailFolder, string | undefined]> = [
        ['sent', pick('\\Sent', /^(\[Gmail\]\/)?(Sent( Items| Mail)?|Gönderilmiş(ler| Öğeler)?|Gönderilenler)$/i)?.path],
        ['junk', pick('\\Junk', /^(\[Gmail\]\/)?(Junk( E-?mail)?|Spam|Gereksiz|İstenmeyen)$/i)?.path],
      ];
      for (const [folder, path] of targets) {
        if (!path) continue;
        const lock = await client.getMailboxLock(path);
        try {
          const uids = ((await client.search({ since: new Date(Date.now() - 30 * 86_400_000) }, { uid: true })) || []).slice(-40);
          await this.fetchUids(client, uids, false, folder);
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  }

  /** E-postayı sohbet (thread) + mesaj olarak yaz; sohbet bu e-postayla ilk kez açıldıysa true */
  private ingest(m: ParsedMail, uid: number, seen: boolean, gmThread: string | undefined, live: boolean, folder: MailFolder = 'inbox'): boolean {
    const from = addrs(m.from)[0] ?? { address: '', name: '' };
    const me = this.cfg.user.toLowerCase();
    const fromMe = from.address === me;
    const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
    const chain = [...refs, m.inReplyTo].filter((x): x is string => !!x);
    let thread = gmThread ? `gm:${gmThread}` : chain.map((r) => this.threadOf.get(r)).find(Boolean) ?? (chain[0] ? `msg:${chain[0]}` : `msg:${m.messageId ?? `uid-${uid}`}`);
    if (!thread) thread = `uid-${uid}`;
    if (m.messageId) this.threadOf.set(m.messageId, thread);
    const people = [...addrs(m.from), ...addrs(m.to), ...addrs(m.cc)];
    const others = people.filter((p) => p.address && p.address !== me);
    const uniq = new Map<string, Participant>();
    for (const p of people) if (p.address && !uniq.has(p.address)) uniq.set(p.address, { id: p.address, name: p.name || p.address, handle: p.address });
    const subject = cleanSubject(m.subject);
    const counterpart = others[0];
    const remoteId = thread;
    const chatKey = `${this.account.id}/${remoteId}`;
    const existing = this.store.getChat(chatKey);
    const unreadDelta = !seen && !fromMe ? 1 : 0;
    this.upsertChat({
      remoteId,
      name: subject,
      kind: others.length > 1 ? 'group' : 'direct',
      unread: (existing?.unread ?? 0) + (live ? 0 : unreadDelta),
      lastMessageAt: (m.date ?? new Date()).getTime(),
      handle: counterpart?.address,
      // mevcut katılımcıları ezme: sahte References ile diziye düşen bir ileti alıcı listesini değiştiremesin
      participants: [...new Map([...(existing?.participants ?? []), ...uniq.values()].map((p) => [p.id, p])).values()],
      // gelen kutusunda görülen dizi Gönderilenler/Gereksiz'de de çıksa gelen kutusunda kalır
      meta: existing?.meta?.folder === 'inbox' && folder !== 'inbox' ? existing.meta : { ...existing?.meta, folder },
    });
    const text = (m.text ?? htmlToText(m.html || '')).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    const attachments: Attachment[] = [];
    for (const [i, a] of (m.attachments ?? []).entries()) {
      const key = createHash('sha1').update(`${uid}/${i}/${a.filename ?? ''}`).digest('hex');
      const dir = path.join(sessionDir(this.account.id), 'media');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, key), a.content);
      fs.writeFileSync(path.join(dir, key + '.type'), a.contentType || 'application/octet-stream');
      const url = `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent('mail:' + key)}`;
      const kind: Attachment['kind'] = a.contentType?.startsWith('image/') ? 'image' : a.contentType?.startsWith('video/') ? 'video' : a.contentType?.startsWith('audio/') ? 'audio' : 'file';
      attachments.push({ kind, name: a.filename ?? 'ek', mime: a.contentType, size: a.size, url: kind === 'image' ? url : undefined, link: url });
    }
    this.upsertMessage(
      {
        remoteChatId: remoteId,
        remoteId: m.messageId ?? `uid-${uid}`,
        senderId: fromMe ? 'me' : from.address,
        senderName: fromMe ? 'Ben' : from.name || from.address,
        fromMe,
        text: text.length > 20_000 ? text.slice(0, 20_000) + '…' : text,
        ts: (m.date ?? new Date()).getTime(),
        status: fromMe ? 'sent' : seen ? 'read' : 'delivered',
        attachments: attachments.length ? attachments : undefined,
      },
      { live },
    );
    return !existing;
  }

  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    const key = u.replace(/^mail:/, '').replace(/[^a-f0-9]/g, '');
    const file = path.join(sessionDir(this.account.id), 'media', key);
    if (!fs.existsSync(file)) throw new Error('ek bulunamadı');
    return { body: fs.readFileSync(file), type: fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : 'application/octet-stream' };
  }

  // ---------- SMTP ----------
  /** Testler sahte taşıyıcı için bu metodu ezer */
  protected createTransport(): { sendMail(opts: SendMailOptions): Promise<{ messageId?: string }> } {
    return nodemailer.createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort,
      secure: this.cfg.smtpSecure ?? false,
      auth: this.cfg.accessToken ? { type: 'OAuth2', user: this.cfg.user, accessToken: this.cfg.accessToken } : { user: this.cfg.user, pass: this.cfg.pass ?? '' },
    });
  }

  /** Sohbetin (thread) son gelen e-postasına yanıt: alıcılar katılımcılardan, konu Re:, In-Reply-To/References son gelen mesaj */
  private async reply(remoteChatId: string, text: string, attachments?: SendMailOptions['attachments']): Promise<string> {
    const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
    if (!chat) throw new Error('Sohbet yok');
    const last = this.store.listMessages(chat.id, 50).filter((x) => !x.fromMe).pop();
    const me = this.cfg.user.toLowerCase();
    // birebir dizide yanıt son gelen iletinin gönderenine gider (dizi ele geçirme önlemi); grupta tüm katılımcılara
    const lastFrom = last?.senderId && last.senderId.includes('@') && last.senderId !== me ? last.senderId : undefined;
    const to = chat.kind === 'direct' && lastFrom ? [lastFrom] : (chat.participants ?? []).map((p) => p.id).filter((a) => a !== me);
    if (!to.length) throw new Error('Alıcı yok');
    if (this.cfg.accessToken) await this.ensureOAuth();
    const info = await this.createTransport().sendMail({
      from: this.cfg.user,
      to,
      subject: chat.name === '(konu yok)' ? '' : /^(re|ynt):/i.test(chat.name) ? chat.name : `Re: ${chat.name}`,
      text,
      inReplyTo: last?.remoteId.startsWith('<') ? last.remoteId : undefined,
      references: last?.remoteId.startsWith('<') ? last.remoteId : undefined,
      attachments,
    });
    const id = info.messageId ?? `local-${Date.now()}`;
    this.threadOf.set(id, remoteChatId);
    return id;
  }

  /** Yeni e-posta: SMTP ile gönder, Message-ID'den yeni dizi sohbeti aç (gelen yanıtlar References ile aynı diziye düşer) */
  async compose(d: ComposeDraft): Promise<Chat> {
    const to = d.to.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Geçerli bir e-posta adresi yaz');
    if (this.cfg.accessToken) await this.ensureOAuth();
    const info = await this.createTransport().sendMail({ from: this.cfg.user, to, subject: d.subject.trim(), text: d.text });
    const id = info.messageId ?? `<local-${Date.now()}@mivelo>`;
    const thread = `msg:${id}`;
    this.threadOf.set(id, thread);
    const chat = this.upsertChat({ remoteId: thread, name: d.subject.trim() || '(konu yok)', kind: 'direct', handle: to, participants: [{ id: to.toLowerCase(), name: to }] });
    this.upsertMessage({ remoteChatId: thread, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: d.text, ts: Date.now(), status: 'sent' });
    return this.store.getChat(chat.id) ?? chat;
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const id = await this.reply(remoteChatId, text);
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /**
   * Ekli yanıt: nodemailer attachments [{ filename, path, contentType }]. Dosya oturum klasörüne kopyalanır ki gönderilen ek
   * sohbette mail:<anahtar> vekilinden görünsün (outbox dosyası 10 dk sonra silinir).
   */
  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (!fs.existsSync(file.path)) throw new Error('Gönderilecek dosya bulunamadı');
    const mime = file.mime || 'application/octet-stream';
    const id = await this.reply(remoteChatId, caption ?? '', [{ filename: file.name, path: file.path, contentType: mime }]);
    const key = createHash('sha1').update(`out/${id}/${file.name}`).digest('hex');
    const dir = path.join(sessionDir(this.account.id), 'media');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file.path, path.join(dir, key));
    fs.writeFileSync(path.join(dir, key + '.type'), mime);
    const url = `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent('mail:' + key)}`;
    const kind: Attachment['kind'] = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    this.upsertMessage({
      remoteChatId,
      remoteId: id,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text: caption ?? '',
      ts: Date.now(),
      status: 'sent',
      attachments: [{ kind, name: file.name, mime, size: file.size, url: kind === 'image' ? url : undefined, link: url }],
    });
    return { remoteId: id };
  }
}

export type MailFolder = 'inbox' | 'sent' | 'junk';

/** Daha eski sayfa: UID listesinin (artan) sonundan `size` adet — silinmiş UID boşlukları sayfayı küçültmesin */
export function olderPage(uids: number[], size: number): number[] {
  return [...uids].sort((a, b) => a - b).slice(-size);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
