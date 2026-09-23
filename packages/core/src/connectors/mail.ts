import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import type { Attachment, Participant, Platform } from '../model.js';

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

/** Görünür bir Chromium penceresi aç; `done` çözülünce kapat. Kullanıcı yalnızca giriş yapar. */
async function withAuthWindow<T>(url: string, done: Promise<T>): Promise<T> {
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
  private threadOf = new Map<string, string>(); // message-id → thread key
  private stateFile: string;

  constructor(account: BaseConnector['account'], store: BaseConnector['store'], cfg: MailConfig) {
    super(account, store);
    this.cfg = { ...PRESETS[account.platform], ...cfg };
    this.stateFile = path.join(sessionDir(account.id), 'mail-state.json');
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { lastUid?: number; threads?: Record<string, string> };
      this.lastUid = st.lastUid ?? 0;
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
    fs.writeFileSync(this.stateFile, JSON.stringify({ lastUid: this.lastUid, threads }));
  }

  private saveCfg(): void {
    fs.writeFileSync(path.join(sessionDir(this.account.id), 'token'), JSON.stringify(this.cfg), { mode: 0o600 });
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
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
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  private async poll(first: boolean): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    const client = new ImapFlow({ host: this.cfg.host!, port: this.cfg.port!, secure: this.cfg.secure ?? true, auth: this.auth(), logger: false });
    try {
      if (this.cfg.accessToken) await this.ensureOAuth();
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        let uids: number[];
        if (this.lastUid > 0) uids = (await client.search({ uid: `${this.lastUid + 1}:*` }, { uid: true })) || [];
        else {
          const since = new Date(Date.now() - 30 * 86_400_000);
          uids = ((await client.search({ since }, { uid: true })) || []).slice(-150);
        }
        uids = uids.filter((u) => u > this.lastUid);
        let n = 0;
        for await (const msg of client.fetch(uids.length ? uids : [], { uid: true, source: true, flags: true, threadId: true }, { uid: true })) {
          try {
            if (!msg.source) continue;
            const parsed: ParsedMail = await simpleParser(msg.source);
            this.ingest(parsed, msg.uid, msg.flags?.has('\\Seen') ?? false, (msg as { threadId?: string }).threadId, !first);
            n++;
          } catch (e) {
            bus.log('warn', `${this.account.platform} e-posta okunamadı (uid ${msg.uid}): ${(e as Error).message}`);
          }
          if (msg.uid > this.lastUid) this.lastUid = msg.uid;
        }
        if (n) bus.log('info', `${this.account.platform}: ${n} e-posta alındı`);
        this.saveState();
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      bus.log('warn', `${this.account.platform} IMAP: ${(e as Error).message}`);
      if (first) throw e;
      if (/auth|login|credential/i.test((e as Error).message)) this.setStatus('error', 'Giriş reddedildi: uygulama şifresini kontrol et');
    } finally {
      this.polling = false;
      client.close();
    }
  }

  private ingest(m: ParsedMail, uid: number, seen: boolean, gmThread: string | undefined, live: boolean): void {
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
      participants: [...uniq.values()],
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
  }

  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    const key = u.replace(/^mail:/, '').replace(/[^a-f0-9]/g, '');
    const file = path.join(sessionDir(this.account.id), 'media', key);
    if (!fs.existsSync(file)) throw new Error('ek bulunamadı');
    return { body: fs.readFileSync(file), type: fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : 'application/octet-stream' };
  }

  // ---------- SMTP ----------
  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const chat = this.store.getChat(`${this.account.id}/${remoteChatId}`);
    if (!chat) throw new Error('Sohbet yok');
    const last = this.store.listMessages(chat.id, 50).filter((x) => !x.fromMe).pop();
    const me = this.cfg.user.toLowerCase();
    const to = (chat.participants ?? []).map((p) => p.id).filter((a) => a !== me);
    if (!to.length) throw new Error('Alıcı yok');
    if (this.cfg.accessToken) await this.ensureOAuth();
    const transport = nodemailer.createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort,
      secure: this.cfg.smtpSecure ?? false,
      auth: this.cfg.accessToken ? { type: 'OAuth2', user: this.cfg.user, accessToken: this.cfg.accessToken } : { user: this.cfg.user, pass: this.cfg.pass ?? '' },
    });
    const info = await transport.sendMail({
      from: this.cfg.user,
      to,
      subject: chat.name === '(konu yok)' ? '' : /^(re|ynt):/i.test(chat.name) ? chat.name : `Re: ${chat.name}`,
      text,
      inReplyTo: last?.remoteId.startsWith('<') ? last.remoteId : undefined,
      references: last?.remoteId.startsWith('<') ? last.remoteId : undefined,
    });
    const id = info.messageId ?? `local-${Date.now()}`;
    if (id) this.threadOf.set(id, remoteChatId);
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }
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
