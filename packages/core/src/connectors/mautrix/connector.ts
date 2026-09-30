import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { bus } from '../../bus.js';
import { DATA_DIR, sessionDir } from '../../config.js';
import { chatId, messageId, type Account, type Attachment, type Chat, type ChatKind, type Participant, type Platform, type ReplyRef } from '../../model.js';
import type { Store } from '../../store.js';
import { BaseConnector, type OutFile, type SendOptions, type StartOptions } from '../base.js';
import { sidecar, BridgeError, type BridgeEvent } from './sidecar.js';
import { collectCookies, type CookieParams } from './cookie-login.js';

/**
 * Beeper'ın mautrix köprüleriyle çalışan kanal (WhatsApp, Instagram, Messenger, X, LinkedIn, Slack). Platform protokolü
 * Go yardımcı sürecinde (apps/bridge); bu sınıf olayları Mivelo modeline çevirir, kullanıcı işlemlerini köprüye iletir.
 * Hesap ↔ köprü oturumu eşlemesi sessions/<hesap>/mautrix.json ({login}).
 */
export const MAUTRIX_NET: Partial<Record<Platform, string>> = {
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'messenger',
  x: 'x',
  linkedin: 'linkedin',
  slack: 'slack',
};

interface MxState {
  login?: string;
  /** eski (tarayıcı) bağlayıcının sohbetleri bir kez temizlendi */
  migrated?: boolean;
}

type Sender = { id?: string; name?: string; avatar?: string; me?: boolean; bot?: boolean };
type MxContent = {
  msgtype?: string;
  body?: string;
  filename?: string;
  url?: string;
  file?: { url?: string };
  info?: { mimetype?: string; size?: number; w?: number; h?: number; duration?: number; thumbnail_url?: string };
  geo_uri?: string;
  'org.matrix.msc3245.voice'?: unknown;
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** Go tarafındaki ids.go roomIDFor ile aynı */
export function roomOf(portal: string, login: string): string {
  return `!${b64(portal)}~${b64(login)}:mivelo.local`;
}

const LOGIN_HINT: Record<string, string> = {
  instagram: 'Açılan pencerede Instagram hesabına giriş yap',
  messenger: 'Açılan pencerede Facebook hesabına giriş yap',
  x: 'Açılan pencerede X hesabına giriş yap',
  linkedin: 'Açılan pencerede LinkedIn hesabına giriş yap',
  slack: 'Açılan pencerede Slack çalışma alanına giriş yap ve çalışma alanını aç',
};

export class MautrixConnector extends BaseConnector {
  private readonly net: string;
  private state: MxState;
  private off?: () => void;
  private stopping = false;
  private loginProc?: string;
  private cancelLogin = false;
  /** toplu (geçmiş) gönderimde sohbet başına son kendi mesajımdan sonraki gelen mesaj sayısı */
  private batchUnread = new Map<string, number>();
  private labelSet = false;

  constructor(account: Account, store: Store) {
    super(account, store);
    this.net = MAUTRIX_NET[account.platform]!;
    this.state = this.readState();
  }

  private get stateFile(): string {
    return path.join(sessionDir(this.account.id), 'mautrix.json');
  }
  private readState(): MxState {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as MxState;
    } catch {
      return {};
    }
  }
  private saveState(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state), { mode: 0o600 });
  }

  /** Eşitlemede WhatsApp'ın kendi okundu/ekleri yetkili; tarayıcı kanallarındaki yankı süzgeci gerekmez */
  protected get echoFilter(): boolean {
    return false;
  }

  async start(opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    this.cancelLogin = false;
    this.off?.();
    this.off = sidecar.on((e) => this.onEvent(e));
    this.setStatus('connecting', this.state.login ? undefined : 'Bağlantı hazırlanıyor');
    try {
      await sidecar.ready();
    } catch (e) {
      this.setStatus('error', `Köprü bileşeni açılamadı: ${(e as Error).message}`);
      return;
    }
    if (this.stopping) return;
    // oturum düştüğü biliniyor ('pairing' iken Yeniden bağlan) → yeniden giriş; yoksa var olan oturumla bağlan
    if (this.state.login && !opts.login) {
      try {
        const r = await sidecar.call<{ name?: string }>('connect', { net: this.net, login: this.state.login }, 60_000);
        this.applyName(r.name);
        void this.resyncChats();
        return;
      } catch (e) {
        if (!(e instanceof BridgeError && e.code === 'no_login')) {
          this.setStatus('error', `Bağlanılamadı: ${(e as Error).message}`);
          return;
        }
        // köprüde oturum yok (silinmiş/çıkış yapılmış): yeniden giriş
        this.state.login = undefined;
        this.saveState();
      }
    }
    await this.login(!!opts.interactive || !!opts.login || !!opts.window);
  }

  // ---------------- giriş ----------------

  private async login(interactive: boolean): Promise<void> {
    if (this.account.platform === 'whatsapp') {
      if (!interactive) {
        this.setStatus('pairing', 'QR kodunu okutarak bağlan (WhatsApp → Bağlı cihazlar)');
        return;
      }
      return this.qrLogin();
    }
    return this.cookieLogin(interactive);
  }

  private async qrLogin(): Promise<void> {
    let res: { proc: string; step: { type: string; display_and_wait?: { data?: string } }; login?: string; name?: string };
    try {
      res = await sidecar.call('login.start', { net: this.net, relogin: this.state.login ?? '' }, 60_000);
    } catch (e) {
      this.setStatus('error', `Eşleştirme başlatılamadı: ${(e as Error).message}`);
      return;
    }
    this.loginProc = res.proc;
    try {
      for (let i = 0; i < 20 && !this.stopping && !this.cancelLogin; i++) {
        if (res.step.type === 'complete') return this.finishLogin(res.login, res.name);
        if (res.step.type !== 'display_and_wait' || !res.step.display_and_wait?.data) {
          this.setStatus('error', 'Beklenmeyen eşleştirme adımı');
          return;
        }
        const qrDataUrl = await QRCode.toDataURL(res.step.display_and_wait.data, { margin: 1, width: 320 });
        bus.emit({ type: 'account.qr', accountId: this.account.id, qrDataUrl });
        this.setStatus('pairing', 'Telefonda WhatsApp → Ayarlar → Bağlı cihazlar → Cihaz bağla ile QR kodunu okut');
        res = await sidecar.call('login.wait', { proc: res.proc }, 200_000);
      }
      if (!this.stopping) {
        this.setStatus('disconnected', 'QR süresi doldu — bağlanmak için Yeniden bağlan');
        bus.emit({ type: 'account.login-cancelled', accountId: this.account.id });
      }
    } catch (e) {
      if (this.stopping || this.cancelLogin) return;
      this.setStatus('disconnected', `Eşleşme tamamlanmadı: ${(e as Error).message}`);
    } finally {
      if (this.loginProc) void sidecar.call('login.cancel', { proc: this.loginProc }, 5_000).catch(() => undefined);
      this.loginProc = undefined;
    }
  }

  private async cookieLogin(interactive: boolean): Promise<void> {
    let res: { proc: string; step: { type: string; cookies?: CookieParams; user_input?: { fields?: Array<{ id: string; options?: string[]; default_value?: string }> } }; login?: string; name?: string };
    try {
      res = await sidecar.call('login.start', { net: this.net, relogin: this.state.login ?? '' }, 60_000);
    } catch (e) {
      this.setStatus('error', `Giriş başlatılamadı: ${(e as Error).message}`);
      return;
    }
    this.loginProc = res.proc;
    try {
      for (let guard = 0; guard < 6 && !this.stopping; guard++) {
        if (res.step.type === 'complete') return this.finishLogin(res.login, res.name);
        if (res.step.type === 'cookies' && res.step.cookies) {
          const params = res.step.cookies;
          // 1) kayıtlı oturum (eski tarayıcı profili / önceki giriş): pencere açmadan
          let got = await collectCookies(params, { accountId: this.account.id, net: this.net, visible: false, cancelled: () => this.stopping || this.cancelLogin });
          if (!got.ok && !this.stopping) {
            if (!interactive) {
              this.setStatus('pairing', 'Giriş gerekli — bağlanmak için Yeniden bağlan');
              return;
            }
            // 2) görünür giriş penceresi
            this.setStatus('connecting', 'Giriş penceresi açılıyor');
            got = await collectCookies(params, {
              accountId: this.account.id,
              net: this.net,
              visible: true,
              cancelled: () => this.stopping || this.cancelLogin,
              onWindow: () => this.setStatus('pairing', LOGIN_HINT[this.net] ?? 'Açılan pencerede giriş yap'),
            });
          }
          if (this.stopping) return;
          if (!got.ok) {
            if (got.reason === 'closed' || got.reason === 'cancelled') {
              bus.log('info', `${this.account.platform}: giriş penceresi girişsiz kapatıldı; bağlanma iptal edildi`);
              this.setStatus('disconnected', 'Giriş yapılmadı — bağlanmak için Yeniden bağlan');
              bus.emit({ type: 'account.login-cancelled', accountId: this.account.id });
            } else {
              this.setStatus('error', got.reason === 'timeout' ? 'Giriş zaman aşımına uğradı — Yeniden bağlan' : `Giriş yapılamadı: ${got.message ?? got.reason}`);
            }
            return;
          }
          this.setStatus('connecting', 'Oturum doğrulanıyor');
          res = await sidecar.call('login.submit', { proc: res.proc, cookies: got.values }, 120_000);
          continue;
        }
        if (res.step.type === 'user_input' && res.step.user_input?.fields?.length) {
          // seçimli ek adımlar (ör. çerez onayı): varsayılan / ilk seçenek
          const input: Record<string, string> = {};
          for (const f of res.step.user_input.fields) input[f.id] = f.default_value || f.options?.[0] || '';
          res = await sidecar.call('login.submit', { proc: res.proc, input }, 120_000);
          continue;
        }
        this.setStatus('error', `Beklenmeyen giriş adımı (${res.step.type})`);
        return;
      }
    } catch (e) {
      if (this.stopping) return;
      const msg = (e as Error).message;
      // güvenlik doğrulaması / checkpoint: kullanıcı eylemi gerekir (otomatik deneme yok)
      this.setStatus(/checkpoint|captcha|verify|doğrula/i.test(msg) ? 'pairing' : 'error', `Giriş yapılamadı: ${msg}`);
    } finally {
      if (this.loginProc) void sidecar.call('login.cancel', { proc: this.loginProc }, 5_000).catch(() => undefined);
      this.loginProc = undefined;
    }
  }

  private finishLogin(login: string | undefined, name: string | undefined): void {
    this.loginProc = undefined;
    if (!login) {
      this.setStatus('error', 'Giriş tamamlanamadı');
      return;
    }
    // eski tarayıcı bağlayıcısının sohbet kimlikleri köprününkilerle aynı değil: bir kez temizlenip köprüden yeniden eşitlenir
    // (WhatsApp sohbet ve mesaj kimlikleri aynı kaldığı için dokunulmaz)
    if (!this.state.migrated && this.account.platform !== 'whatsapp') {
      const n = this.store.dropAccountChats(this.account.id);
      if (n) bus.log('info', `${this.account.platform}: yeni bağlantı altyapısına geçildi; ${n} eski sohbet yeniden eşitlenecek`);
    }
    this.state = { login, migrated: true };
    this.saveState();
    this.applyName(name);
    this.setStatus('connecting', 'Sohbetler alınıyor');
  }

  private applyName(name: string | undefined): void {
    if (!name || this.labelSet) return;
    if (this.account.label === name) return;
    this.account.label = name;
    this.labelSet = true;
    this.store.upsertAccount(this.account);
    bus.emit({ type: 'account.status', account: { ...this.account } });
  }

  // ---------------- olaylar ----------------

  private mine(e: BridgeEvent): boolean {
    if (e.net !== this.net) return false;
    if (e.ev === 'bridge.exit' || e.ev === 'bridge.restart') return true;
    return !!this.state.login && e.login === this.state.login;
  }

  private onEvent(e: BridgeEvent): void {
    if (e.ev === 'bridge.exit') {
      if (this.state.login && !this.stopping) this.setStatus('connecting', 'Köprü yeniden başlatılıyor');
      return;
    }
    if (e.ev === 'bridge.restart') {
      if (this.state.login && !this.stopping) void sidecar.call('connect', { net: this.net, login: this.state.login }).catch(() => undefined);
      return;
    }
    if (!this.mine(e) || this.stopping) return;
    switch (e.ev) {
      case 'status':
        return this.onStatus(e);
      case 'chat':
        return void this.onChat(e);
      case 'chat.delete':
        return this.onChatDelete(e);
      case 'message':
        return this.onMessage(e);
      case 'edit':
        return this.onEdit(e);
      case 'reaction':
        return this.onReaction(e);
      case 'redact':
        return this.onRedact(e);
      case 'receipt':
        return this.onReceipt(e);
      case 'typing':
        return this.typing(String(e.portal), !!e.on, (e.sender as Sender | undefined)?.name);
      case 'unread':
        return this.onUnread(e);
      case 'batch':
        return this.onBatch(e);
      case 'tag':
        return this.onTag(e);
      default:
        return;
    }
  }

  private onStatus(e: BridgeEvent): void {
    const st = String(e.state);
    const msg = String(e.message || e.error || '').slice(0, 200);
    this.applyName(typeof e.name === 'string' ? e.name : undefined);
    switch (st) {
      case 'CONNECTED':
        this.setAttention(undefined);
        if (this.account.status !== 'connected') this.setStatus('connected');
        return;
      case 'CONNECTING':
      case 'BACKFILLING':
        if (this.account.status !== 'connected') this.setStatus('connecting', st === 'BACKFILLING' ? 'Sohbetler alınıyor' : undefined);
        return;
      case 'TRANSIENT_DISCONNECT':
        // köprü kendisi yeniden bağlanır: uyarı değil
        this.setStatus('connecting', 'Bağlantı koptu, yeniden deneniyor');
        return;
      case 'BAD_CREDENTIALS':
      case 'LOGGED_OUT':
        this.setStatus('pairing', `Oturum kapandı — yeniden giriş gerekli${msg ? ` (${msg})` : ''}`);
        return;
      case 'UNKNOWN_ERROR':
        this.setStatus('error', msg || 'Bilinmeyen hata');
        return;
      default:
        return;
    }
  }

  private mediaUrl(uri: string | undefined): string | undefined {
    if (!uri) return undefined;
    return `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent('mx:' + uri)}`;
  }

  private kindOf(e: BridgeEvent): ChatKind {
    if (e.type === 'dm') return 'direct';
    if (this.account.platform === 'slack' && typeof e.name === 'string' && e.name.startsWith('#')) return 'channel';
    return 'group';
  }

  private handleOf(ids: unknown): string | undefined {
    if (!Array.isArray(ids)) return undefined;
    for (const pre of ['tel:', 'username:', 'email:', 'mailto:']) {
      const hit = ids.find((x): x is string => typeof x === 'string' && x.startsWith(pre));
      if (hit) {
        const v = hit.slice(pre.length);
        return pre === 'username:' ? '@' + v.replace(/^@/, '') : v;
      }
    }
    return undefined;
  }

  private onChat(e: BridgeEvent): Chat | undefined {
    if (e.type === 'space') return undefined;
    const remoteId = String(e.portal);
    const kind = this.kindOf(e);
    const members = Array.isArray(e.members) ? (e.members as Array<{ id?: string; name?: string; avatar?: string; me?: boolean }>) : undefined;
    const participants: Participant[] | undefined = members
      ?.filter((m) => !m.me && m.id)
      .map((m) => ({ id: m.id!, name: m.name || m.id!, avatarUrl: this.mediaUrl(m.avatar) }));
    const name = (typeof e.name === 'string' && e.name) || (typeof e.otherName === 'string' && e.otherName) || '';
    const existing = this.store.getChatLite(chatId(this.account.id, remoteId));
    const meta = { ...(existing?.meta ?? {}), ...(e.request ? { request: true } : {}) };
    return this.upsertChat({
      remoteId,
      name,
      kind,
      avatarUrl: this.mediaUrl((e.avatar as string) || (kind === 'direct' ? (e.otherAvatar as string) : undefined)),
      handle: kind === 'direct' ? this.handleOf(e.otherIds) : undefined,
      participants: participants?.length ? participants : undefined,
      meta,
    });
  }

  private onChatDelete(e: BridgeEvent): void {
    const cid = chatId(this.account.id, String(e.portal));
    if (!this.store.getChatLite(cid)) return;
    this.store.deleteChat(cid);
    bus.emit({ type: 'chat.delete', chatId: cid });
  }

  private convert(c: MxContent): { text: string; attachments?: Attachment[] } {
    const body = c.body ?? '';
    switch (c.msgtype) {
      case 'm.image':
      case 'm.video':
      case 'm.audio':
      case 'm.file': {
        const kind: Attachment['kind'] = c.msgtype === 'm.image' ? 'image' : c.msgtype === 'm.video' ? 'video' : c.msgtype === 'm.audio' ? 'audio' : 'file';
        const url = this.mediaUrl(c.url || c.file?.url);
        const name = c.filename || body || undefined;
        const caption = c.filename && body && body !== c.filename ? body : '';
        return { text: caption, attachments: [{ kind, name, mime: c.info?.mimetype, size: c.info?.size, url }] };
      }
      case 'm.location': {
        const m = /geo:([-\d.]+),([-\d.]+)/.exec(c.geo_uri ?? '');
        return { text: `📍 ${body || 'Konum'}`, attachments: m ? [{ kind: 'other', name: 'Konum', link: `https://maps.google.com/?q=${m[1]},${m[2]}` }] : undefined };
      }
      case 'm.emote':
        return { text: `* ${body}` };
      default:
        return { text: body };
    }
  }

  private replyRef(remoteChatId: string, rid: string): ReplyRef {
    const q = this.store.getMessage(messageId(chatId(this.account.id, remoteChatId), rid));
    return { remoteId: rid, senderName: q ? (q.fromMe ? 'Sen' : q.senderName) : 'Mesaj', text: (q?.text || q?.attachments?.[0]?.name || '').slice(0, 160), fromMe: q?.fromMe };
  }

  private ensureChatFor(e: BridgeEvent): string {
    const remoteChatId = String(e.portal);
    if (!this.store.hasChat(chatId(this.account.id, remoteChatId))) {
      // sohbet olayı henüz gelmedi (300 ms gecikmeli): ad köprüden sonra gelir
      this.upsertChat({ remoteId: remoteChatId, name: '' });
    }
    return remoteChatId;
  }

  private onMessage(e: BridgeEvent): void {
    const remoteChatId = this.ensureChatFor(e);
    const sender = (e.sender ?? {}) as Sender;
    const fromMe = !!sender.me;
    const c = (e.content ?? {}) as MxContent;
    if (e.type === 'm.sticker' && !c.msgtype) c.msgtype = 'm.image';
    const { text, attachments } = this.convert(c);
    const rid = String(e.rid);
    const live = !!e.live;
    if (!live) {
      const n = this.batchUnread.get(remoteChatId) ?? 0;
      this.batchUnread.set(remoteChatId, fromMe ? 0 : n + 1);
    }
    this.upsertMessage(
      {
        remoteChatId,
        remoteId: rid,
        senderId: fromMe ? 'me' : sender.id || 'unknown',
        senderName: fromMe ? 'Ben' : sender.name || sender.id || '',
        senderAvatarUrl: fromMe ? undefined : this.mediaUrl(sender.avatar),
        fromMe,
        text,
        attachments,
        ts: Number(e.ts) || Date.now(),
        status: fromMe ? 'sent' : 'read',
        replyTo: typeof e.reply === 'string' && e.reply ? this.replyRef(remoteChatId, e.reply) : undefined,
        threadId: typeof e.thread === 'string' && e.thread ? e.thread : undefined,
      },
      { live: live && !fromMe },
    );
  }

  private onEdit(e: BridgeEvent): void {
    const content = (e.content ?? {}) as MxContent;
    this.applyEdited(String(e.portal), String(e.target), this.convert(content).text);
  }

  private onReaction(e: BridgeEvent): void {
    const s = (e.sender ?? {}) as Sender;
    const target = String(e.target ?? '');
    if (!target) return;
    this.applyReaction(String(e.portal), target, { emoji: String(e.key ?? ''), senderId: s.me ? 'me' : s.id || '', senderName: s.me ? 'Ben' : s.name || '', fromMe: !!s.me });
    // canlı tepki: sohbet önizlemesi (mesaj gelmiş gibi görünmez)
    if (e.live && !s.me) this.reactionPreview(String(e.portal), `${String(e.key ?? '')} ${s.name || ''} mesajına tepki verdi`.trim());
  }

  private onRedact(e: BridgeEvent): void {
    const s = (e.sender ?? {}) as Sender;
    if (e.kind === 'reaction') {
      this.applyReaction(String(e.portal), String(e.target), { emoji: String(e.key ?? ''), senderId: s.me ? 'me' : s.id || '', senderName: s.name || '', fromMe: !!s.me }, true);
      return;
    }
    this.applyEdited(String(e.portal), String(e.target), null);
  }

  private onReceipt(e: BridgeEvent): void {
    const remoteChatId = String(e.portal);
    const s = (e.sender ?? {}) as Sender;
    const cid = chatId(this.account.id, remoteChatId);
    const rid = typeof e.rid === 'string' ? e.rid : '';
    const msg = rid ? this.store.getMessage(messageId(cid, rid)) : undefined;
    if (s.me) {
      // başka cihazımda okudum: Mivelo'da da okundu
      const chat = this.store.getChatLite(cid);
      if (!chat || (chat.unread <= 0 && (chat.readUpto ?? 0) >= chat.lastMessageAt)) return;
      if (msg && msg.ts < chat.lastMessageAt) return; // daha eski bir mesaja kadar okundu
      this.store.markRead(cid);
      const full = this.store.getChat(cid);
      if (full) bus.emit({ type: 'chat.upsert', chat: full });
      return;
    }
    this.outgoingRead(remoteChatId, msg?.ts ?? (Number(e.ts) || Date.now()));
  }

  private onUnread(e: BridgeEvent): void {
    const cid = chatId(this.account.id, String(e.portal));
    if (e.unread) return;
    this.store.markRead(cid);
    const chat = this.store.getChat(cid);
    if (chat) bus.emit({ type: 'chat.upsert', chat });
  }

  private onBatch(e: BridgeEvent): void {
    const remoteChatId = String(e.portal);
    const n = this.batchUnread.get(remoteChatId) ?? 0;
    this.batchUnread.delete(remoteChatId);
    if (!e.forward) return;
    const cid = chatId(this.account.id, remoteChatId);
    if (e.markRead) {
      this.store.markRead(cid);
    } else if (n > 0) {
      const chat = this.store.getChatLite(cid);
      if (chat && chat.unread < n) this.upsertChat({ remoteId: remoteChatId, name: chat.name, unread: n });
      return;
    }
    const chat = this.store.getChat(cid);
    if (chat) bus.emit({ type: 'chat.upsert', chat });
  }

  private onTag(e: BridgeEvent): void {
    if (e.tag !== 'mivelo.archive') return;
    const remoteChatId = String(e.portal);
    const chat = this.store.getChatLite(chatId(this.account.id, remoteChatId));
    if (!chat) return;
    const meta = { ...(chat.meta ?? {}) };
    if (e.on) meta.archived = true;
    else delete meta.archived;
    this.upsertChat({ remoteId: remoteChatId, name: chat.name, meta });
  }

  /** Çekirdek yeniden başladıysa köprüdeki sohbet listesiyle tam eşitleme (ad/avatar/üyeler) */
  private async resyncChats(): Promise<void> {
    if (!this.state.login) return;
    try {
      const r = await sidecar.call<{ chats: BridgeEvent[] }>('chats', { net: this.net, login: this.state.login }, 120_000);
      for (const c of r.chats ?? []) {
        if (this.stopping) return;
        this.onChat(c);
        await new Promise((res) => setImmediate(res));
      }
    } catch (e) {
      bus.log('warn', `${this.account.platform}: sohbet listesi alınamadı: ${(e as Error).message}`);
    }
  }

  // ---------------- kullanıcı işlemleri ----------------

  private room(remoteChatId: string): string {
    if (!this.state.login) throw new Error('Hesap bağlı değil');
    return roomOf(remoteChatId, this.state.login);
  }

  async sendText(remoteChatId: string, text: string, opts?: SendOptions): Promise<{ remoteId: string }> {
    const r = await sidecar.call<{ rid: string; ts: number }>('send', { net: this.net, room: this.room(remoteChatId), text, replyTo: opts?.replyTo ?? '', thread: opts?.threadId ?? '' }, 150_000);
    this.upsertMessage({
      remoteChatId,
      remoteId: r.rid,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text,
      ts: Number(r.ts) || Date.now(),
      status: 'sent',
      replyTo: opts?.replyTo ? this.replyRef(remoteChatId, opts.replyTo) : undefined,
      threadId: opts?.threadId,
    });
    return { remoteId: r.rid };
  }

  async sendMedia(remoteChatId: string, file: OutFile, caption?: string): Promise<{ remoteId: string }> {
    // köprü yalnız kendi klasöründeki dosyayı okur; kopya kendi balonumuzun önizlemesi olarak da kalır
    const dir = path.join(DATA_DIR, 'bridge', this.net, 'out');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file.name).replace(/[^.\w]/g, '').slice(0, 10);
    const dest = path.join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`);
    await fs.promises.copyFile(file.path, dest);
    await fs.promises.writeFile(dest + '.type', file.mime, { mode: 0o600 });
    const r = await sidecar.call<{ rid: string; ts: number }>(
      'send',
      { net: this.net, room: this.room(remoteChatId), text: caption ?? '', file: { path: dest, name: file.name, mime: file.mime, size: file.size, voice: !!file.voice } },
      300_000,
    );
    const kind: Attachment['kind'] = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
    this.upsertMessage({
      remoteChatId,
      remoteId: r.rid,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text: caption ?? '',
      attachments: [{ kind, name: file.name, mime: file.mime, size: file.size, url: this.mediaUrl('mxc://f/' + b64(dest)) }],
      ts: Number(r.ts) || Date.now(),
      status: 'sent',
    });
    return { remoteId: r.rid };
  }

  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    await sidecar.call(remove ? 'unreact' : 'react', { net: this.net, room: this.room(remoteChatId), target: remoteMsgId, key: emoji }, 60_000);
    this.applyReaction(remoteChatId, remoteMsgId, { emoji, senderId: 'me', senderName: 'Ben', fromMe: true }, remove);
  }

  async deleteMessage(remoteChatId: string, remoteId: string): Promise<void> {
    await sidecar.call('redact', { net: this.net, room: this.room(remoteChatId), target: remoteId }, 60_000);
  }

  async editMessage(remoteChatId: string, remoteId: string, text: string): Promise<void> {
    await sidecar.call('edit', { net: this.net, room: this.room(remoteChatId), target: remoteId, text }, 60_000);
  }

  async markRead(remoteChatId: string): Promise<void> {
    await sidecar.call('read', { net: this.net, room: this.room(remoteChatId) }, 30_000);
  }

  async loadHistory(remoteChatId: string): Promise<void | { unavailable?: string; timedOut?: boolean }> {
    if (!this.state.login || this.account.status !== 'connected') return { unavailable: 'Hesap bağlı değil' };
    const r = await sidecar.call<{ done?: boolean; timedOut?: boolean }>('backfill', { net: this.net, room: this.room(remoteChatId) }, 100_000).catch((e: Error) => {
      bus.log('warn', `${this.account.platform}: eski mesajlar alınamadı: ${e.message}`);
      return { timedOut: true };
    });
    if (r.timedOut) return { timedOut: true };
  }

  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    if (!url.startsWith('mx:')) return undefined;
    const r = await sidecar.call<{ path: string; mime?: string }>('media', { net: this.net, uri: url.slice(3) }, 200_000);
    const body = await fs.promises.readFile(r.path);
    return { body, type: r.mime || 'application/octet-stream' };
  }

  async openDirect(p: Participant): Promise<string> {
    if (!this.state.login) throw new Error('Hesap bağlı değil');
    const r = await sidecar.call<{ chat: BridgeEvent }>('open', { net: this.net, login: this.state.login, identifier: p.handle || p.id }, 60_000);
    const chat = this.onChat(r.chat);
    return chat?.remoteId ?? String(r.chat.portal);
  }

  async logout(): Promise<void> {
    this.cancelLogin = true;
    if (!this.state.login) return;
    await sidecar.call('logout', { net: this.net, login: this.state.login }, 40_000).catch((e) => bus.log('warn', `${this.account.platform}: platform çıkışı yapılamadı: ${(e as Error).message}`));
    this.state.login = undefined;
    this.saveState();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelLogin = true;
    this.off?.();
    this.off = undefined;
    if (this.loginProc) await sidecar.call('login.cancel', { proc: this.loginProc }, 5_000).catch(() => undefined);
    if (this.state.login) await sidecar.call('disconnect', { net: this.net, login: this.state.login }, 15_000).catch(() => undefined);
    if (this.account.status !== 'disconnected' && this.account.status !== 'pairing') this.setStatus('disconnected');
  }
}
