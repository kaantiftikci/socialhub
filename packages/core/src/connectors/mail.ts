import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { type ComposeDraft, BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { cleanMailHtml } from './mail-html.js';
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
  yandex: { host: 'imap.yandex.com', port: 993, secure: true, smtpHost: 'smtp.yandex.com', smtpPort: 465, smtpSecure: true },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
};

/** Kişisel Microsoft hesabı (Outlook.com) alan adları: SMTP smtp-mail.outlook.com:587; iş/okul (Microsoft 365) smtp.office365.com */
const MS_PERSONAL = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;
export const OUTLOOK_PERSONAL_SMTP = 'smtp-mail.outlook.com';
export function isOutlookPersonal(user: string | undefined): boolean {
  return MS_PERSONAL.test(String(user ?? '').trim());
}
/**
 * Outlook.com kişisel hesaplarında SMTP sunucusunu düzelt: ön ayar ya da eski kayıt smtp.office365.com diyorsa
 * smtp-mail.outlook.com:587 (STARTTLS). Kullanıcının elle girdiği başka sunucuya dokunulmaz.
 */
export function fixOutlookSmtp<T extends Pick<MailConfig, 'user' | 'smtpHost' | 'smtpPort' | 'smtpSecure'>>(cfg: T): T {
  if (isOutlookPersonal(cfg.user) && (!cfg.smtpHost || cfg.smtpHost === 'smtp.office365.com')) return { ...cfg, smtpHost: OUTLOOK_PERSONAL_SMTP, smtpPort: 587, smtpSecure: false };
  return cfg;
}

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

/** Artan UID listesi → IMAP dizi kümesi ("1:3,7,9:10") */
export function uidRanges(uids: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < uids.length; ) {
    let j = i;
    while (j + 1 < uids.length && uids[j + 1] === uids[j]! + 1) j++;
    out.push(i === j ? String(uids[i]) : `${uids[i]}:${uids[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

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
  private threadIdOk = true;
  /** Dizi → gelen kutusundaki okunmamış UID'ler (Mivelo'da okununca sunucuda da \\Seen) */
  private unseen = new Map<string, Set<number>>();
  /** Gönderilenler/Gereksiz kutularının UID imleci (v = kutunun UIDVALIDITY'si): sonraki turlar yalnız yeni iletileri indirir */
  private folderCur: Partial<Record<'sent' | 'junk', { v: string; last: number }>> = {};
  /** İlk turda arka plana bırakılan birikimin son UID'si: bu UID'ye dek alınanlar canlı sayılmaz (bildirim/sayaç şişmesin) */
  private backlogTo = 0;
  /** withInbox'un geçici (IDLE dışı) istemcisi: stop() onu da kapatır, eski örneğin FETCH'i yenisiyle paralel sürmesin */
  private tmpClient?: ImapFlow;
  private stateFile: string;
  /** INBOX UIDVALIDITY: değişirse (kutu yeniden oluşturuldu/taşındı) UID imleçleri geçersiz → baştan eşitle */
  private uidValidity = '';
  /** Sağlayıcı kısıtı (ETHROTTLE, [LIMIT], çok fazla bağlantı): bu zamana dek yoklama/IDLE yok */
  private pauseUntil = 0;
  /** Kimlik reddedildi: otomatik deneme yok (tekrarlı başarısız giriş "Too many login failures" kilidine götürür) */
  private authFailed = false;

  /** Registry kendiliğinden iyileşmede okur: sağlayıcının istediği bekleme (ms) — yeni oturum bundan önce açılmasın */
  get retryAfterMs(): number {
    return Math.max(0, this.pauseUntil - Date.now());
  }

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], cfg: MailConfig) {
    super(account, store);
    this.cfg = fixOutlookSmtp({ ...PRESETS[account.platform], ...cfg });
    this.stateFile = path.join(sessionDir(account.id), 'mail-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as {
        lastUid?: number;
        oldestUid?: number;
        uidValidity?: string;
        threads?: Record<string, string>;
        unseen?: Record<string, number[]>;
        folders?: MailConnector['folderCur'];
      };
      this.lastUid = st.lastUid ?? 0;
      this.uidValidity = st.uidValidity ?? '';
      this.oldestUid = st.oldestUid ?? 0;
      // eski sürümün yanlış kaydı: hiç e-posta alınmamış (lastUid 0) kutuda "başa ulaşıldı" (1) yazılıyordu → eski e-postalar kalıcı erişilemezdi
      if (this.lastUid === 0 && this.oldestUid === 1) this.oldestUid = 0;
      for (const [k, v] of Object.entries(st.threads ?? {})) this.threadOf.set(k, v);
      for (const [k, v] of Object.entries(st.unseen ?? {})) if (Array.isArray(v) && v.length) this.unseen.set(k, new Set(v));
      this.folderCur = st.folders ?? {};
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
    // okunmamış UID'ler de kalıcı: yeniden başlatmadan sonra Mivelo'da okunan dizi sunucuda da \\Seen olabilsin (dizi başına ≤50, ≤2000 dizi)
    const unseen: Record<string, number[]> = {};
    for (const [k, v] of [...this.unseen.entries()].slice(-2000)) if (v.size) unseen[k] = [...v].slice(-50);
    fs.writeFileSync(this.stateFile, JSON.stringify({ lastUid: this.lastUid, oldestUid: this.oldestUid, uidValidity: this.uidValidity, threads, unseen, folders: this.folderCur }));
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
      // "Diğer e-posta": sunucu girilmediyse adresten bul (bilinen sağlayıcı / autoconfig / imap.<alan>)
      if (!this.cfg.host) {
        const { discoverMail } = await import('./mail-discover.js');
        Object.assign(this.cfg, await discoverMail(this.cfg.user));
        this.saveCfg();
        bus.log('info', `${this.account.platform}: sunucu bulundu ${this.cfg.host} / ${this.cfg.smtpHost}`);
      }
      if (this.account.platform === 'outlook' || (!this.cfg.pass && this.cfg.clientId)) await this.ensureOAuth();
      else if (this.cfg.pass && this.cfg.accessToken) this.cfg.accessToken = undefined;
      else if (!this.cfg.pass) return this.setStatus('error', 'Şifre gerekli');
      if (this.stopping) return;
      await this.poll(true);
      this.setStatus('connected', this.cfg.user);
      this.schedule();
      void this.startIdle();
    } catch (e) {
      // İlk girişteki hata da sınıflandırılsın: şifre reddi → "Giriş reddedildi…" (arayüz "Şifreyi güncelle" gösterir); imapflow'un
      // genel "Command failed" metnine sunucunun asıl açıklaması (responseText) eklenir — eskiden yalnız "Command failed" görünüyordu
      const err = e as { message?: string; responseText?: string; reason?: string; authenticationFailed?: boolean };
      this.classify(e);
      if (this.authFailed) return;
      const msg = String(err.message ?? e).split('\n')[0];
      // BYE ile kapanan bağlantıda ("Unexpected close") sunucunun gerekçesi reason'da
      const why = err.responseText || err.reason;
      const extra = why && !msg.includes(why) ? ` — ${why}` : '';
      this.setStatus('error', `${msg}${extra}`.slice(0, 300));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleRetry) clearTimeout(this.idleRetry);
    if (this.idleDebounce) clearTimeout(this.idleDebounce);
    const t = this.tmpClient;
    this.tmpClient = undefined;
    if (t) {
      await t.logout().catch(() => undefined);
      t.close();
    }
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
      // başka cihazda okundu/okunmadı (\\Seen) → kısa yoklama: okunmamış sayacı eşitlensin (bkz. syncSeen)
      c.on('flags', () => {
        if (this.idleDebounce) clearTimeout(this.idleDebounce);
        this.idleDebounce = setTimeout(() => void this.poll(false), 1000);
      });
      c.on('close', () => {
        if (this.idleClient !== c) return;
        // kurulu IDLE oturumu sunucu BYE'ıyla kapandıysa ("Too many simultaneous connections") gerekçe sınıflandırılsın:
        // yoksa 5 sn sonra yeniden bağlanıp sınırı zorluyordu
        const bye = (c as unknown as { byeReason?: string }).byeReason;
        if (bye) this.classify({ reason: bye });
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
    const err = e as { authenticationFailed?: boolean; code?: string; throttleReset?: number; message?: string; response?: unknown; responseText?: string; reason?: string; serverResponseCode?: string };
    // imapflow çoğu komutta response'u metne çevirir; çevirmediği yollarda ayrıştırılmış nesne kalır ("[object Object]" olmasın)
    const resp = typeof err.response === 'string' ? err.response : '';
    const sec = (err.response as { attributes?: { section?: { value?: unknown }[] }[] } | undefined)?.attributes?.[0]?.section?.[0]?.value;
    const rcode = String(err.serverResponseCode ?? (typeof sec === 'string' ? sec : '')).toUpperCase().trim();
    // reason: karşılama/BYE ile kapanan bağlantıda sunucu metni ("* BYE Too many simultaneous connections") yalnız burada
    const text = `${err.message ?? ''} ${resp} ${err.responseText ?? ''} ${err.reason ?? ''}`;
    // Sınır kalıbı kimlik denetiminden ÖNCE: imapflow LOGIN'e gelen her NO'da authenticationFailed koyar → Gmail'in
    // "NO [ALERT] Too many simultaneous connections" yanıtı yanlış şifre sanılıyordu. Yalın [ALERT] burada sayılmaz
    // (Gmail yanlış şifre/web girişi uyarılarında da [ALERT] kullanıyor); o, kimlik denetiminden sonra.
    if (rcode === 'LIMIT' || /\[LIMIT\]|Too many simultaneous|too many connections|bandwidth limits/i.test(text)) {
      this.limitPause();
      return;
    }
    if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Web login required|LOGIN failed|Authentication failed|incorrect (username|password)/i.test(text)) {
      this.authFailed = true;
      if (this.timer) clearTimeout(this.timer);
      if (this.idleRetry) clearTimeout(this.idleRetry);
      this.setStatus('error', 'Giriş reddedildi: uygulama şifresini kontrol edip "Şifreyi güncelle" ile yeniden gir (tekrarlı deneme hesabı kilitleyebileceği için otomatik denenmiyor)');
      return;
    }
    if (err.code === 'ETHROTTLE') this.pauseUntil = Date.now() + Math.max(err.throttleReset ?? 60_000, 30_000);
    else if (/\[ALERT\]/i.test(text)) this.limitPause();
  }

  private limitPause(): void {
    this.pauseUntil = Date.now() + 15 * 60_000;
    bus.log('warn', `${this.account.platform}: sağlayıcı sınırı bildirdi, 15 dk bekleniyor`);
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
    // Belirteç istemci kurulmadan ÖNCE tazelenir: ImapFlow auth nesnesini kurulurken alır (sonra tazelenen belirteci görmez)
    if (this.cfg.accessToken) await this.ensureOAuth();
    const client = this.createImapClient();
    this.tmpClient = client;
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      if (this.tmpClient === client) this.tmpClient = undefined;
      await client.logout().catch(() => undefined);
      client.close();
    }
  }

  /** Kısa ömürlü IMAP oturumu (yoklama/klasörler; testler ezer) */
  protected createImapClient(): ImapFlow {
    return new ImapFlow({ host: this.cfg.host!, port: this.cfg.port!, secure: this.cfg.secure ?? true, auth: this.auth(), logger: false });
  }

  /** Verilen UID'leri indirip sohbet/mesaj olarak yaz; (işlenen e-posta, yeni açılan sohbet) sayısını döner */
  private async fetchUids(client: ImapFlow, uids: number[], live: boolean, folder?: MailFolder): Promise<{ mails: number; chats: number }> {
    let mails = 0;
    let chats = 0;
    if (!uids.length) return { mails, chats };
    // Dizi kimliği yalnız Gmail'de (X-GM-THRID). OBJECTID bildiren bazı sunucular (Yahoo) THREADID isteğini "Command failed" ile
    // reddediyor; o durumda alan olmadan bir kez daha denenir
    const useThread = this.account.platform === 'gmail' && this.threadIdOk;
    const it = async function* (self: MailConnector) {
      try {
        yield* client.fetch(uids, { uid: true, source: true, flags: true, threadId: useThread }, { uid: true });
      } catch (e) {
        if (!useThread) throw e;
        self.threadIdOk = false;
        bus.log('warn', `${self.account.platform}: dizi kimliği alınamadı (${(e as Error).message}); onsuz devam`);
        yield* client.fetch(uids, { uid: true, source: true, flags: true }, { uid: true });
      }
    };
    for await (const msg of it(this)) {
      if (this.stopping) break; // durdurulan örneğin FETCH'i yeni örnekle paralel sürmesin
      try {
        if (!msg.source) continue;
        // textAsHtml (linkify) hiç kullanılmıyor: büyük düz metinli bültende olay döngüsünü 50-90 ms kilitliyordu
        const parsed: ParsedMail = await simpleParser(msg.source, { skipTextToHtml: true });
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

  /** Bir FETCH'te indirilen en çok e-posta: her dilimden sonra imleç kaydedilir (kopmada kaldığı yerden sürer) */
  static CHUNK = 100;

  private async poll(first: boolean): Promise<void> {
    if (this.stopping) return;
    if (this.polling) {
      if (!first) this.pollAgain = true;
      return;
    }
    this.polling = true;
    let folders = false;
    try {
      await this.withInbox(async (client) => {
        const v = String((client as { mailbox?: { uidValidity?: bigint | number } | false }).mailbox ? ((client as { mailbox: { uidValidity?: bigint | number } }).mailbox.uidValidity ?? '') : '');
        let reset = false;
        if (v && this.uidValidity && v !== this.uidValidity) {
          bus.log('warn', `${this.account.platform}: gelen kutusunun UIDVALIDITY değeri değişti; UID imleçleri sıfırlanıp son 30 gün yeniden eşitleniyor`);
          this.lastUid = 0;
          this.oldestUid = 0;
          this.backlogTo = 0;
          this.unseen.clear(); // eski UID'ler artık BAŞKA iletileri gösterir: markRead onları \\Seen yapmasın
          reset = true;
        }
        if (v) this.uidValidity = v;
        const fresh = this.lastUid === 0;
        let uids: number[];
        if (!fresh) uids = (await client.search({ uid: `${this.lastUid + 1}:*` }, { uid: true })) || [];
        else {
          const since = new Date(Date.now() - 30 * 86_400_000);
          uids = ((await client.search({ since }, { uid: true })) || []).slice(-150);
        }
        uids = uids.filter((u) => u > this.lastUid);
        // HTML gövde eski sürümlerde saklanmıyordu: son e-postaları bir kez yeniden oku. Yeni hesap (ya da UIDVALIDITY
        // sıfırlaması) ilk eşitlemesini zaten HTML'le yapar → işaret hemen yazılır (aynı 150 e-posta iki kez inmesin)
        const mark = path.join(sessionDir(this.account.id), 'html-v1');
        const htmlDue = !fs.existsSync(mark);
        if (htmlDue && (fresh || reset)) fs.writeFileSync(mark, '');
        let mails = 0;
        for (let i = 0; i < uids.length; i += MailConnector.CHUNK) {
          if (this.stopping) break;
          // ilk tur sınırsız birikimde (lastUid+1:*) yalnız ilk dilimi bekler: hesap hemen 'connected' olur, kalan birikim arka
          // planda (canlı sayılmadan) iner. Yeni hesabın penceresi zaten ≤150 → tamamı ilk turda
          if (first && i > 0 && !fresh) {
            this.backlogTo = Math.max(this.backlogTo, uids[uids.length - 1]!);
            this.pollAgain = true;
            break;
          }
          const part = uids.slice(i, i + MailConnector.CHUNK);
          const old = part.filter((u) => u <= this.backlogTo);
          const rest = part.filter((u) => u > this.backlogTo);
          try {
            if (old.length) mails += (await this.fetchUids(client, old, false)).mails;
            if (rest.length) mails += (await this.fetchUids(client, rest, !first)).mails;
          } finally {
            this.saveState(); // yarıda kopsa da işlenenler yeniden inmesin
          }
        }
        if (this.backlogTo && this.lastUid >= this.backlogTo) this.backlogTo = 0;
        if (mails) bus.log('info', `${this.account.platform}: ${mails} e-posta alındı`);
        if (!first && !this.stopping) {
          // eski hesabın tek seferlik HTML yenilemesi 'connected' SONRASI (ilk turu uzatmasın)
          if (htmlDue && !fresh && !reset) {
            const recent = ((await client.search({ since: new Date(Date.now() - 30 * 86_400_000) }, { uid: true })) || []).slice(-150);
            await this.fetchUids(client, recent, false).catch((e) => bus.log('warn', `${this.account.platform}: HTML yenileme: ${(e as Error).message}`));
            fs.writeFileSync(mark, '');
          }
          await this.syncSeen(client).catch((e) => bus.log('warn', `${this.account.platform}: okundu eşitlemesi: ${(e as Error).message}`));
        }
        this.saveState();
      });
      // Gönderilenler / Gereksiz: her 8. yoklamada (ilk turdan hemen sonraki arka plan turu dahil). İlk tur beklemez.
      if (first) this.pollAgain = true;
      else if (this.folderTick++ % 8 === 0) folders = true;
      if (folders) await this.pollFolders().catch((e) => bus.log('warn', `${this.account.platform} klasörler: ${(e as Error).message}`));
    } catch (e) {
      bus.log('warn', `${this.account.platform} IMAP: ${(e as Error).message}`);
      if (first) {
        this.pollAgain = false; // açılış başarısız: arka plan turu hata durumundaki örnekte sürmesin
        throw e;
      }
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
   * Başka cihazda okunan e-postalar: izlenen okunmamış UID'lerden sunucuda artık \\Seen olanlar kümeden düşer; dizinin
   * hepsi okunduysa sohbet Mivelo'da da okundu olur (yoklama yalnız yeni UID'leri çektiği için bayrak değişimi hiç görülmüyordu).
   */
  private async syncSeen(client: ImapFlow): Promise<void> {
    // komut satırı sınırlı: en yeni 2000 UID, ardışıklar aralık (a:b) olarak
    const tracked = [...new Set([...this.unseen.values()].flatMap((x) => [...x]))].sort((a, b) => a - b).slice(-2000);
    if (!tracked.length) return;
    const checked = new Set(tracked);
    // bazı sunucular komut satırını ~8 KB'ta keser: 500'lük dilimler
    const open = new Set<number>();
    for (let i = 0; i < tracked.length; i += 500)
      for (const u of ((await client.search({ uid: uidRanges(tracked.slice(i, i + 500)), seen: false }, { uid: true })) || []) as number[]) open.add(u);
    let changed = false;
    for (const [thread, set] of [...this.unseen.entries()]) {
      for (const u of [...set])
        if (checked.has(u) && !open.has(u)) {
          set.delete(u);
          changed = true;
        }
      if (set.size) continue;
      this.unseen.delete(thread);
      const cid = `${this.account.id}/${thread}`;
      const chat = this.store.getChat(cid);
      if (!chat || !chat.unread) continue;
      this.store.markRead(cid);
      const upd = this.store.getChat(cid);
      if (upd) bus.emit({ type: 'chat.upsert', chat: upd });
    }
    if (changed) this.saveState();
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
          if (firstPage.length) this.oldestUid = Math.min(...firstPage);
          else if (this.lastUid > 0) this.oldestUid = this.lastUid + 1;
          else {
            // son 30 günde hiç e-posta yok (az kullanılan kutu): kutudaki her şeyden büyük UID'den geriye git.
            // Eskiden lastUid + 1 = 1 yazılıyordu → "başa ulaşıldı" sanılıp eski e-postalar kalıcı erişilemiyordu
            const next = Number((client as { mailbox?: { uidNext?: number | bigint } | false }).mailbox ? ((client as { mailbox: { uidNext?: number | bigint } }).mailbox.uidNext ?? 0) : 0);
            if (next > 1) this.oldestUid = next;
            else return 0; // gerçekten boş kutu: 1 YAZMA, sonra yeniden denensin
          }
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
  /**
   * \\Sent ve \\Junk kutuları (imapflow specialUse); yoksa adla (Sent, Gönderilmiş, Junk, Spam). Kutu başına UID imleci:
   * ilk tur (ya da kutunun UIDVALIDITY'si değişince) son 30 günün son 40 e-postası, sonra yalnız yenileri. IDLE bağlantısı
   * açıksa aynı oturum kullanılır (yeni giriş yok), sonra INBOX yeniden seçilir (IDLE gelen kutusunu izlemeyi sürdürsün).
   */
  private async pollFolders(): Promise<void> {
    if (this.stopping) return;
    const idle = this.idleClient;
    const shared = !!(idle && this.idleUp && idle.usable);
    let client: ImapFlow;
    if (shared) client = idle!;
    else {
      if (this.cfg.accessToken) await this.ensureOAuth(); // istemciden önce (bkz. withInbox)
      client = this.createImapClient();
    }
    // ortak oturumda kutu değişirken gelen kutusu IDLE'da değil ('exists' gelmez): dönüşte uidNext büyüdüyse bir tur daha
    type Mb = { path?: string; uidNext?: number | bigint } | false | undefined;
    const inboxNext = (): number => {
      const mb = (client as { mailbox?: Mb }).mailbox;
      return mb && mb.path === 'INBOX' ? Number(mb.uidNext ?? 0) : 0;
    };
    const nextBefore = shared ? inboxNext() : 0;
    try {
      if (!shared) await client.connect();
      const boxes = await client.list();
      const pick = (use: string, re: RegExp) => boxes.find((b) => (b as { specialUse?: string }).specialUse === use) ?? boxes.find((b) => re.test(b.path));
      const targets: Array<['sent' | 'junk', string | undefined]> = [
        ['sent', pick('\\Sent', /^(\[Gmail\]\/)?(Sent( Items| Mail)?|Gönderilmiş(ler| Öğeler)?|Gönderilenler)$/i)?.path],
        ['junk', pick('\\Junk', /^(\[Gmail\]\/)?(Junk( E-?mail)?|Spam|Gereksiz|İstenmeyen)$/i)?.path],
      ];
      for (const [folder, path] of targets) {
        if (!path || this.stopping) continue;
        const lock = await client.getMailboxLock(path);
        try {
          const mb = (client as { mailbox?: { uidValidity?: bigint | number } | false }).mailbox;
          const v = String(mb ? (mb.uidValidity ?? '') : '');
          const cur = this.folderCur[folder];
          let uids: number[];
          if (cur && v && cur.v === v) {
            // sunucu "N:*" isteğinde son UID'yi her zaman döndürür → süz
            // uzun kesintiden sonra binlerce e-posta inmesin: en yeni 100 (imleç yine en büyüğe ilerler)
            uids = (((await client.search({ uid: `${cur.last + 1}:*` }, { uid: true })) || []) as number[]).filter((u) => u > cur.last).slice(-100);
          } else uids = ((await client.search({ since: new Date(Date.now() - 30 * 86_400_000) }, { uid: true })) || []).slice(-40);
          await this.fetchUids(client, uids, false, folder);
          if (v && !this.stopping) {
            this.folderCur[folder] = { v, last: Math.max(cur && cur.v === v ? cur.last : 0, ...uids) };
            this.saveState();
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      if (shared) {
        const l = await client.getMailboxLock('INBOX').catch(() => undefined);
        if (l && nextBefore && inboxNext() > nextBefore) this.pollAgain = true;
        l?.release();
      } else {
        await client.logout().catch(() => undefined);
        client.close();
      }
    }
  }

  /** E-postayı sohbet (thread) + mesaj olarak yaz; sohbet bu e-postayla ilk kez açıldıysa true */
  private ingest(m: ParsedMail, uid: number, seen: boolean, gmThread: string | undefined, live: boolean, folder: MailFolder = 'inbox'): boolean {
    const from = addrs(m.from)[0] ?? { address: '', name: '' };
    const me = this.cfg.user.toLowerCase();
    const fromMe = from.address === me;
    const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
    const chain = [...refs, m.inReplyTo].filter((x): x is string => !!x);
    let thread: string | undefined;
    if (gmThread) {
      // Mivelo'dan yazılan (compose) dizi msg:<Message-ID> ile açılır; Gmail'in dizi kimliği (Gönderilmiş kopyası / yanıtlar)
      // o sohbete bağlanır (takma ad "gm:<thrid>" → msg:…), yoksa aynı yazışma iki sohbete bölünüyordu
      thread = this.threadOf.get(`gm:${gmThread}`);
      if (!thread) {
        const composed = [m.messageId, ...chain].map((r) => (r ? this.threadOf.get(r) : undefined)).find((t) => t?.startsWith('msg:'));
        if (composed) this.threadOf.set(`gm:${gmThread}`, composed);
        thread = composed ?? `gm:${gmThread}`;
      }
    } else thread = chain.map((r) => this.threadOf.get(r)).find(Boolean) ?? (chain[0] ? `msg:${chain[0]}` : `msg:${m.messageId ?? `uid-${uid}`}`);
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
    // Yalnız ilk kez alınan e-posta sayılır: Gereksiz kutusu her 8. yoklamada yeniden okunuyor, UIDVALIDITY sıfırlanınca
    // gelen kutusu da; aynı okunmamış ileti sayacı her seferinde artırıyordu
    const unreadDelta = !seen && !fromMe && !this.hasMessage(remoteId, m.messageId ?? `uid-${uid}`) ? 1 : 0;
    if (!seen && !fromMe && folder === 'inbox') this.unseen.set(remoteId, (this.unseen.get(remoteId) ?? new Set()).add(uid));
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
    const text = (m.text ?? htmlToText(m.html || '')).replace(/\r/g, '').replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    const attachments: Attachment[] = [];
    // gövdeye gömülü görseller (cid:) → yerel medya adresi; yalnız gövdede kullanılanlar ek listesine girmez
    const rawHtml = typeof m.html === 'string' ? m.html : '';
    const cidUrl = new Map<string, string>();
    let mediaDir = '';
    for (const [i, a] of (m.attachments ?? []).entries()) {
      // UID yalnız kendi kutusunda tekil: Gönderilmiş/Gereksiz'in UID 5'i gelen kutusunun UID 5'inin ekini ezmesin
      // (gelen kutusu anahtarı eskisiyle aynı kalır; kayıtlı bağlantılar bozulmaz)
      const key = createHash('sha1').update(`${folder === 'inbox' ? '' : folder + '/'}${uid}/${i}/${a.filename ?? ''}`).digest('hex');
      if (!mediaDir) fs.mkdirSync((mediaDir = path.join(sessionDir(this.account.id), 'media')), { recursive: true });
      // aynı ek (klasör yeniden okuması, HTML yenilemesi) yeniden yazılmasın: büyük ekte olay döngüsünü kilitliyordu
      const file = path.join(mediaDir, key);
      let same = false;
      try {
        same = fs.statSync(file).size === a.content.length;
      } catch {
        /* yok */
      }
      if (!same) fs.writeFileSync(file, a.content);
      if (!fs.existsSync(file + '.type')) fs.writeFileSync(file + '.type', a.contentType || 'application/octet-stream');
      const url = `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent('mail:' + key)}`;
      const kind: Attachment['kind'] = a.contentType?.startsWith('image/') ? 'image' : a.contentType?.startsWith('video/') ? 'video' : a.contentType?.startsWith('audio/') ? 'audio' : 'file';
      const cid = a.cid ? a.cid.replace(/^<|>$/g, '') : '';
      if (cid) cidUrl.set(cid, url);
      if (cid && rawHtml.includes(`cid:${cid}`)) continue;
      attachments.push({ kind, name: a.filename ?? 'ek', mime: a.contentType, size: a.size, url: kind === 'image' ? url : undefined, link: url });
    }
    const html = cleanMailHtml(rawHtml ? rawHtml.replace(/cid:([^"'\s)>]+)/g, (all, id: string) => cidUrl.get(id) ?? all) : undefined);
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
        html,
      },
      // canlı turda da yalnız okunmamış yeni e-posta sayılır (telefonda okunmuş olan \\Seen ile gelir → +1 değil)
      { live, bump: live && unreadDelta === 1 },
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
  /**
   * Mivelo'da açılan dizi sunucuda da okundu (\\Seen): telefon/web posta istemcisinde okunmamış kalmasın. UID'ler alımda
   * tutulur; bilinmiyorsa (yeniden başlatma sonrası) Gmail'de dizi kimliğiyle (X-GM-THRID) okunmamışlar aranır.
   */
  async markRead(remoteChatId: string): Promise<void> {
    await this.withInbox(async (client) => {
      let uids = [...(this.unseen.get(remoteChatId) ?? [])];
      if (!uids.length && remoteChatId.startsWith('gm:')) uids = ((await client.search({ threadId: remoteChatId.slice(3), seen: false }, { uid: true })) || []) as number[];
      else if (!uids.length) {
        // UID bilinmiyor (eski sürüm/yeniden başlatma): dizinin son gelen iletileri Message-ID ile aranır
        const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
        const ids = chat ? this.store.listMessages(chat.id, 50).filter((m) => !m.fromMe && m.remoteId.startsWith('<')).slice(-20).map((m) => m.remoteId) : [];
        for (const id of ids) uids.push(...(((await client.search({ header: { 'message-id': id }, seen: false }, { uid: true })) || []) as number[]));
      }
      // SILENT: sunucu bayrakları geri yollamasın (IDLE oturumunda 'flags' olayı → gereksiz yoklama)
      if (uids.length) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true, silent: true });
      if (this.unseen.delete(remoteChatId)) this.saveState();
    });
  }

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
