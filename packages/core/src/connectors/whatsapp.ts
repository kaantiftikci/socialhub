import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Baileys from '@whiskeysockets/baileys';
import type { WASocket, WAMessage, proto } from '@whiskeysockets/baileys';
import { BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { chatId as chatIdOf, type Attachment, type Participant } from '../model.js';
import { macContacts } from '../contacts-mac.js';

// Baileys CJS olarak yayınlanıyor; ESM'den yüklenince default export iç içe gelebilir.
const B = Baileys as unknown as Record<string, unknown>;
const makeWASocket = ((B.default as { default?: unknown })?.default ?? B.default ?? B.makeWASocket) as typeof Baileys.default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, downloadMediaMessage, BufferJSON } = Baileys;
const execFileP = promisify(execFile);

/**
 * WhatsApp: "bağlı cihaz" protokolü (WhatsApp Web ile aynı). Kullanıcı QR okutur,
 * bu Mac bir bağlı cihaz olur. Mesajlar uçtan uca şifreli gelir, burada çözülür.
 */
export class WhatsAppConnector extends BaseConnector {
  private sock?: WASocket;
  private stopping = false;
  private nameCache = new Map<string, string>();
  /** LID ↔ telefon JID eşlemesi (WhatsApp 2025+ kişileri gizli "lid" kimliğiyle gönderebiliyor) */
  private alias = new Map<string, string>();
  private avatarCache = new Map<string, string>();
  private historySeen = false;
  /** Bu oturumda hiç 'open' görmeden üst üste kaç kez koptu (bayat kimlik tespiti) */
  private failedBeforeOpen = 0;
  private opened = false;
  private retryTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private loadingNames = false;
  /** Mesajlara en son uygulanan ad/fotoğraf (gönderen → imza); değişmediyse UPDATE atılmaz */
  private appliedSender = new Map<string, string>();

  /** Öğrenilen lid↔numara eşlemeleri ve adlar oturumlar arasında kaybolmasın (~/.kavsak/sessions/<hesap>/names.json) */
  private namesFile(): string {
    return path.join(sessionDir(this.account.id), 'names.json');
  }

  private loadNames(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.namesFile(), 'utf8')) as { alias?: Array<[string, string]>; names?: Array<[string, string]> };
      this.loadingNames = true;
      for (const [k, v] of raw.names ?? []) this.nameCache.set(k, v);
      this.store.transaction(() => {
        for (const [lid, pn] of raw.alias ?? []) if (lid.endsWith('@lid') && pn.endsWith('@s.whatsapp.net')) this.link(lid, pn);
      });
      this.loadingNames = false;
      bus.log('info', `WhatsApp: ${(raw.alias ?? []).length} lid eşlemesi, ${(raw.names ?? []).length} ad diskten yüklendi`);
    } catch {
      this.loadingNames = false; // dosya yok ya da bozuk
    }
  }

  private scheduleSaveNames(): void {
    if (this.loadingNames || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNames();
    }, 3000);
  }

  private saveNames(): void {
    try {
      const alias = [...this.alias.entries()].filter(([k]) => k.endsWith('@lid'));
      fs.writeFileSync(this.namesFile(), JSON.stringify({ alias, names: [...this.nameCache.entries()] }));
    } catch {
      /* diske yazılamadı */
    }
  }

  private retry(ms: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopping) void this.start();
    }, ms);
  }

  async start(_opts: StartOptions = {}): Promise<void> {
    this.stopping = false;
    this.historySeen = false;
    this.opened = false;
    this.account.label = 'WhatsApp';
    const dir = path.join(sessionDir(this.account.id), 'auth');
    if (this.alias.size === 0 && this.nameCache.size === 0) this.loadNames();
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as number[] | undefined }));

    this.setStatus('connecting');
    const sock = makeWASocket({
      version: version as [number, number, number] | undefined,
      auth: state,
      logger: pino({ level: 'silent' }),
      // DİKKAT: browser[0] 'Mac OS'/'Windows' + syncFullHistory birleşimi Baileys'i yerel masaüstü uygulaması
      // (DARWIN/WIN32) gibi tanıtır; WhatsApp bunu web sürüm numarasıyla kabul etmeyip bağlantıyı hemen kapatır (428).
      // Bu yüzden OS alanı özel bir ad: telefonda "Kavşak (Mac)" görünür, protokolde WEB_BROWSER kalır,
      // requireFullSync ile telefon tam sohbet geçmişini yine gönderir.
      browser: ['Mac', 'Kavşak', '1.0'],
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.setStatus('pairing', 'QR kodunu telefonundan okut');
        const qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        bus.emit({ type: 'account.qr', accountId: this.account.id, qrDataUrl });
      }
      if (u.connection === 'open') {
        this.opened = true;
        this.failedBeforeOpen = 0;
        const me = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
        this.account.label = 'WhatsApp';
        this.setStatus('connected', me ? `+${me.split('@')[0]}` : undefined);
        bus.log('info', 'WhatsApp bağlandı; telefon geçmişi gönderiyor (ilk seferde 10-60 sn sürebilir)');
        void this.syncGroups(sock);
        setTimeout(() => void this.syncGroups(sock), 20_000);
        // Rehber adları uygulama durumu (app state) eşitlemesindeki contactAction kayıtlarından gelir; bazı hesaplarda
        // bağlantıda kendiliğinden gelmiyor — açıkça iste
        setTimeout(() => {
          if (this.sock !== sock || this.stopping) return;
          sock
            .resyncAppState(['critical_unblock_low', 'regular_low', 'regular_high', 'critical_block'], false)
            .then(() => bus.log('info', 'WhatsApp: uygulama durumu (rehber/sohbet ayarları) eşitlendi'))
            .catch((e) => bus.log('warn', `WhatsApp uygulama durumu eşitlenemedi: ${(e as Error).message}`));
        }, 8_000);
        setTimeout(() => {
          // geçmiş yalnızca ilk eşleşmede gelir; depoda sohbet varsa uyarı gereksiz
          if (!this.historySeen && !this.stopping && this.sock === sock && this.store.listChatsOf(this.account.id).length === 0)
            bus.log('warn', 'WhatsApp: 90 sn geçti, telefondan sohbet geçmişi gelmedi. Telefonda WhatsApp → Bağlı cihazlar → bu cihazı kaldır, sonra kanala sağ tık → Kaldır → yeniden bağlan.');
        }, 90_000);
      }
      if (u.receivedPendingNotifications) bus.log('info', 'WhatsApp: bekleyen bildirimler alındı');
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined;
        const code = err?.output?.statusCode;
        if (this.stopping) return;
        bus.log('warn', `WhatsApp bağlantı kapandı: ${code ?? '?'} ${err?.message ?? ''}`);
        const resetAuth = (why: string) => {
          fs.rmSync(dir, { recursive: true, force: true });
          this.failedBeforeOpen = 0;
          bus.log('warn', `WhatsApp: ${why}; kayıtlı oturum silindi, yeni QR üretiliyor`);
          this.retry(800);
        };
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch || code === 403) {
          resetAuth(code === DisconnectReason.loggedOut ? 'telefondan çıkış yapılmış' : `oturum geçersiz (${code})`);
          return;
        }
        if (code === DisconnectReason.restartRequired) {
          // eşleşmeden hemen sonra normaldir: anında yeniden bağlan
          this.retry(300);
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          this.setStatus('error', 'Başka bir yerde WhatsApp Web açıldı; Yeniden bağlan de');
          return;
        }
        if (!this.opened) {
          this.failedBeforeOpen += 1;
          // telefonda "bağlı cihazı kaldır" yapıldıysa sunucu 401 yerine 428 ile kapatır ve kimlik hiç açılmaz
          if (this.failedBeforeOpen >= 3 && fs.existsSync(path.join(dir, 'creds.json'))) {
            resetAuth(`kayıtlı kimlikle ${this.failedBeforeOpen} denemede bağlanılamadı (${code ?? '?'})`);
            return;
          }
        }
        const wait = Math.min(2000 * 2 ** Math.max(0, this.failedBeforeOpen - 1), 15_000);
        this.setStatus('connecting', `Bağlantı koptu (${code ?? '?'}), ${Math.round(wait / 1000)} sn sonra yeniden deneniyor`);
        this.retry(wait);
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      this.historySeen = true;
      bus.log('info', `WhatsApp geçmiş paketi: ${chats?.length ?? 0} sohbet, ${messages?.length ?? 0} mesaj (tür ${String(syncType)}, %${progress ?? '?'}${isLatest ? ', son' : ''})`);
      let named = 0;
      for (const c of contacts ?? []) {
        const n = c.name ?? c.notify ?? c.verifiedName ?? undefined;
        if (n) named++;
        this.learnContact(c.id, c.lid ?? undefined, n);
      }
      if (contacts?.length) bus.log('info', `WhatsApp: ${contacts.length} kişi geldi (${named} adlı)`);
      // Binlerce satır tek işlemde: her satırda ayrı commit/fsync olmasın (olay döngüsü dakikalarca kilitleniyordu)
      const t0 = Date.now();
      this.store.transaction(() => {
        for (const c of chats ?? []) {
          if (!c.id || !isChatJid(c.id)) continue;
          const cc = c as typeof c & { lidJid?: string | null; pnJid?: string | null };
          if (cc.lidJid && cc.pnJid) this.link(cc.lidJid, cc.pnJid);
          else if (cc.lidJid && c.id.endsWith('@s.whatsapp.net')) this.link(cc.lidJid, c.id);
          else if (cc.pnJid && c.id.endsWith('@lid')) this.link(c.id, cc.pnJid);
          const jid = this.canon(c.id);
          if (c.name) this.nameCache.set(jid, c.name);
          else this.ensureGroupMeta(jid);
          this.upsertChat({
            remoteId: jid,
            name: this.nameOf(jid),
            kind: jid.endsWith('@g.us') ? 'group' : 'direct',
            unread: c.unreadCount ?? 0,
            lastMessageAt: Number(c.conversationTimestamp ?? 0) * 1000,
            handle: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined,
          });
        }
        for (const m of messages ?? []) this.ingest(m, false);
      });
      if (Date.now() - t0 > 1500) bus.log('info', `WhatsApp geçmiş paketi işlendi (${Date.now() - t0} ms)`);
      this.scheduleRefresh();
      void this.fetchAvatars(sock, (chats ?? []).map((c) => c.id).filter((id): id is string => !!id && isChatJid(id)).map((id) => this.canon(id)).slice(0, 60));
    });

    sock.ev.on('contacts.upsert', (cs) => {
      for (const c of cs) this.learnContact(c.id, c.lid ?? undefined, c.name ?? c.notify ?? c.verifiedName ?? undefined);
      bus.log('info', `WhatsApp: rehberden ${cs.length} kişi (${cs.filter((c) => c.name).length} adlı)`);
      this.scheduleRefresh();
    });
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      this.link(lid, jid);
      this.scheduleRefresh();
    });
    sock.ev.on('groups.upsert', (gs) => {
      for (const g of gs) this.applyGroup(g.id, g.subject, g.participants as Array<{ id: string; admin?: string | null }> | undefined);
    });
    sock.ev.on('groups.update', (gs) => {
      for (const g of gs) if (g.id && g.subject) this.applyGroup(g.id, g.subject, undefined);
    });
    sock.ev.on('contacts.update', (cs) => {
      for (const c of cs) this.learnContact(c.id, c.lid ?? undefined, c.name ?? c.notify ?? c.verifiedName ?? undefined);
      this.scheduleRefresh();
    });

    sock.ev.on('chats.upsert', (cs) => {
      for (const c of cs) {
        if (!c.id || !isChatJid(c.id)) continue;
        const jid = this.canon(c.id);
        if (c.name) this.nameCache.set(jid, c.name);
        this.upsertChat({ remoteId: jid, name: this.nameOf(jid), kind: jid.endsWith('@g.us') ? 'group' : 'direct' });
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (messages.length > 1) this.store.transaction(() => messages.forEach((m) => this.ingest(m, type === 'notify')));
      else for (const m of messages) this.ingest(m, type === 'notify');
    });

    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!u.key.remoteJid || !u.key.id || !isChatJid(u.key.remoteJid)) continue;
        const st = u.update.status;
        if (st === undefined || st === null) continue;
        const map: Record<number, 'pending' | 'sent' | 'delivered' | 'read'> = { 0: 'pending', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
        const cj = this.canon(u.key.remoteJid);
        const mid = `${chatIdOf(this.account.id, cj)}#${u.key.id}`;
        const stored = this.store.getMessage(mid);
        if (!stored) continue; // bilmediğimiz mesaj için boş kayıt açma
        const next = map[st] ?? 'sent';
        if (stored.status === next) continue;
        this.store.updateStatus(mid, next);
        const chat = this.store.getChat(stored.chatId);
        if (chat) bus.emit({ type: 'message.upsert', message: { ...stored, status: next }, chat });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.saveNames();
    }
    this.sock?.end(undefined);
    this.sock = undefined;
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (!this.sock) throw new Error('WhatsApp bağlı değil');
    const sent = await this.sock.sendMessage(remoteChatId, { text });
    const id = sent?.key.id ?? `local-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /** En yeni sohbetlerin profil fotoğraflarını (varsa) çek. */
  private async fetchAvatars(sock: WASocket, jids: string[]): Promise<void> {
    for (const jid of jids) {
      if (this.avatarCache.has(jid)) continue;
      try {
        const url = await sock.profilePictureUrl(jid, 'preview');
        if (url) {
          this.avatarCache.set(jid, url);
          this.upsertChat({ remoteId: jid, name: this.nameOf(jid), avatarUrl: url });
        }
      } catch {
        this.avatarCache.set(jid, '');
      }
    }
  }

  /** Katılınan tüm grupların adını ve üyelerini çek (geçmiş paketinde grup adı gelmeyebiliyor) */
  private async syncGroups(sock: WASocket): Promise<void> {
    try {
      const all = await sock.groupFetchAllParticipating();
      let n = 0;
      for (const g of Object.values(all)) {
        this.applyGroup(g.id, g.subject, g.participants);
        n++;
      }
      bus.log('info', `WhatsApp: ${n} grup adı/üyesi alındı${n ? ' (örn. ' + Object.values(all)[0]?.subject + ')' : ''}`);
    } catch (e) {
      bus.log('warn', `WhatsApp grup bilgileri alınamadı: ${(e as Error).message}`);
    }
  }

  private groupPending = new Set<string>();
  /** Adı bilinmeyen bir grup görülünce meta verisini tek tek çek (toplu çağrı başarısızsa yedek yol) */
  private ensureGroupMeta(jid: string): void {
    if (!jid.endsWith('@g.us') || this.nameCache.has(jid) || this.groupPending.has(jid) || !this.sock) return;
    this.groupPending.add(jid);
    const sock = this.sock;
    setTimeout(() => {
      sock
        .groupMetadata(jid)
        .then((g) => this.applyGroup(g.id, g.subject, g.participants))
        .catch((e) => bus.log('warn', `WhatsApp grup bilgisi alınamadı (${jid}): ${(e as Error).message}`))
        .finally(() => this.groupPending.delete(jid));
    }, 300 * this.groupPending.size);
  }

  private applyGroup(id: string, subject: string | undefined, participants: Array<{ id: string; jid?: string; lid?: string; admin?: string | null }> | undefined): void {
    if (!id) return;
    if (subject) this.nameCache.set(id, subject);
    // grup üyeleri hem lid hem telefon kimliğiyle gelir: eşlemeyi öğren (rehber adları telefon kimliğinde)
    for (const p of participants ?? []) if (p.lid && p.jid) this.link(p.lid, p.jid);
    const members: Participant[] | undefined = participants?.map((p) => {
      const jid = p.jid && p.jid.endsWith('@s.whatsapp.net') ? p.jid : this.canon(p.id);
      return { id: jid, name: this.nameOf(jid), handle: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined, avatarUrl: this.avatarCache.get(jid) || undefined, admin: !!p.admin };
    });
    if (this.store.getChat(chatIdOf(this.account.id, id)) || subject) this.upsertChat({ remoteId: id, name: subject ?? this.nameOf(id), kind: 'group', participants: members, link: undefined });
    // üye fotoğrafları (arka planda, sınırlı)
    if (members && this.sock) {
      const sock = this.sock;
      void this.fetchAvatars(sock, members.map((m) => m.id).slice(0, 40)).then(() => {
        const chat = this.store.getChat(chatIdOf(this.account.id, id));
        if (!chat?.participants) return;
        this.upsertChat({ remoteId: id, name: chat.name, participants: chat.participants.map((m) => ({ ...m, name: this.nameOf(m.id), avatarUrl: this.avatarCache.get(m.id) || m.avatarUrl })) });
        this.scheduleRefresh();
      });
    }
  }

  async openDirect(p: Participant): Promise<string> {
    return p.id;
  }

  /** Telefondaki "Bağlı cihazlar" listesinden de düş */
  async logout(): Promise<void> {
    if (!this.sock) return;
    this.stopping = true;
    await this.sock.logout().catch(() => undefined);
  }

  /** lid ↔ telefon numarası eşlemesi kaydet */
  private link(lid: string, pn: string): void {
    if (!lid || !pn || lid === pn) return;
    const fresh = this.alias.get(lid) !== pn;
    this.alias.set(lid, pn);
    this.alias.set(pn, lid);
    const n = this.nameCache.get(pn) ?? this.nameCache.get(lid);
    if (n) {
      this.nameCache.set(lid, n);
      this.nameCache.set(pn, n);
    }
    if (fresh) {
      this.scheduleSaveNames();
      // eski mesajlarda lid ile kayıtlı gönderen artık numarayla anılsın (ad/fotoğraf eşlemesi tek kimlikte toplanır)
      this.store.rewriteSender(this.account.id, lid, pn);
      // aynı kişi iki sohbet olarak açıldıysa (lid + numara) birleştir
      const lidChat = this.store.getChat(chatIdOf(this.account.id, lid));
      if (lidChat) {
        const target = chatIdOf(this.account.id, pn);
        if (!this.store.getChat(target)) this.upsertChat({ remoteId: pn, name: this.nameOf(pn), kind: 'direct', handle: '+' + pn.split('@')[0], avatarUrl: lidChat.avatarUrl });
        this.store.mergeChats(lidChat.id, target);
        bus.emit({ type: 'chat.delete', chatId: lidChat.id });
        const merged = this.store.getChat(target);
        if (merged) bus.emit({ type: 'chat.upsert', chat: merged });
      }
    }
  }

  /** Sohbet kimliği olarak telefon JID'sini tercih et (lid biliniyorsa çevir) */
  private canon(jid: string): string {
    if (jid.endsWith('@lid')) return this.alias.get(jid) ?? jid;
    return jid;
  }

  private learnContact(id: string | undefined, lid: string | undefined, name: string | undefined): void {
    if (!id) return;
    if (lid) this.link(lid, id);
    if (name) {
      if (this.nameCache.get(id) !== name) this.scheduleSaveNames();
      this.nameCache.set(id, name);
      const other = this.alias.get(id);
      if (other) this.nameCache.set(other, name);
    }
  }

  /**
   * Ad yenilemeyi ertele ve birleştir: kişi/grup olayları peş peşe geldiğinde (163 grubun avatarları vb.)
   * tam tarama bir kez çalışsın. Eskiden her olayda anında çalışıp olay döngüsünü kilitliyordu.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer || this.stopping) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      try {
        this.refreshNames();
      } catch (e) {
        bus.log('warn', `WhatsApp ad yenileme: ${(e as Error).message}`);
      }
    }, 1500);
  }

  /** Sonradan öğrenilen adları/eşlemeleri depodaki sohbetlere uygula (numara yerine isim görünsün) */
  private refreshNames(): void {
    const t0 = Date.now();
    let renamed = 0;
    this.store.transaction(() => {
      for (const chat of this.store.listChatsOf(this.account.id)) {
        const better = this.nameOf(chat.remoteId);
        if (better !== chat.name && !better.startsWith('+') && better !== 'WhatsApp kişisi' && chat.kind !== 'group') this.upsertChat({ remoteId: chat.remoteId, name: better });
        if (chat.kind === 'group' && chat.participants?.length) {
          const parts = chat.participants.map((m) => ({ ...m, name: this.nameOf(m.id), avatarUrl: this.avatarCache.get(m.id) || m.avatarUrl }));
          if (JSON.stringify(parts) !== JSON.stringify(chat.participants)) this.upsertChat({ remoteId: chat.remoteId, name: chat.name, participants: parts });
          for (const m of parts) {
            // aynı ad/fotoğraf daha önce uygulandıysa mesaj tablosuna dokunma
            const sig = `${m.name}\u0000${m.avatarUrl ?? ''}`;
            if (this.appliedSender.get(m.id) === sig) continue;
            this.appliedSender.set(m.id, sig);
            const alt = this.alias.get(m.id);
            for (const sid of [m.id, alt].filter((x): x is string => !!x)) this.store.renameSender(this.account.id, sid, m.name, m.avatarUrl);
            renamed++;
          }
        }
      }
    });
    const ms = Date.now() - t0;
    if (ms > 1000) bus.log('info', `WhatsApp: adlar yenilendi (${renamed} gönderen, ${ms} ms)`);
  }

  private nameOf(jid: string): string {
    const n = this.nameCache.get(jid) ?? this.nameCache.get(this.alias.get(jid) ?? '');
    if (n) return n;
    const pn = jid.endsWith('@lid') ? this.alias.get(jid) : jid;
    if (pn && pn.endsWith('@s.whatsapp.net')) {
      const mac = macContacts().get('+' + pn.split('@')[0]);
      if (mac) return mac;
      return '+' + pn.split('@')[0];
    }
    if (jid.endsWith('@lid')) return 'WhatsApp kişisi';
    if (jid.endsWith('@g.us')) return 'Grup';
    return '+' + jid.split('@')[0];
  }

  // ---------- medya ----------
  private mediaIndexDir(): string {
    const d = path.join(sessionDir(this.account.id), 'media-index');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private mediaKey(jid: string, id: string): string {
    return `${jid}__${id}`.replace(/[^a-zA-Z0-9_.@-]/g, '_');
  }

  /** Medya taşıyan mesajın protokol nesnesini sakla; sonra istek üzerine indirmek için gerekir */
  private rememberMedia(m: WAMessage, jid: string): void {
    try {
      fs.writeFileSync(path.join(this.mediaIndexDir(), this.mediaKey(jid, m.key.id!) + '.json'), JSON.stringify(m, BufferJSON.replacer));
    } catch {
      /* diske yazılamadı */
    }
  }

  /**
   * u biçimleri: "wa:<jid>/<id>" tam medya, "wa-thumb:<jid>/<id>" küçük önizleme (mesajın içindeki jpeg).
   * Sesli mesajlar (ogg/opus) ffmpeg varsa mp3'e çevrilir (WebKit ogg oynatamaz).
   */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    const m = u.match(/^(wa|wa-thumb):(.+)\/([^/]+)$/);
    if (!m) throw new Error('geçersiz WhatsApp medya adresi');
    const [, kind, jid, id] = m;
    const idx = path.join(this.mediaIndexDir(), this.mediaKey(jid, id) + '.json');
    if (!fs.existsSync(idx)) throw new Error('medya kaydı yok (mesaj eski olabilir)');
    const msg = JSON.parse(fs.readFileSync(idx, 'utf8'), BufferJSON.reviver) as WAMessage;
    const content = unwrap(msg.message);
    const media = content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? content?.documentMessage ?? content?.stickerMessage;
    if (kind === 'wa-thumb') {
      const th = (content?.imageMessage ?? content?.videoMessage ?? content?.documentMessage)?.jpegThumbnail;
      if (!th) throw new Error('önizleme yok');
      return { body: Buffer.from(th), type: 'image/jpeg' };
    }
    const dir = path.join(sessionDir(this.account.id), 'media');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, this.mediaKey(jid, id));
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    if (!this.sock) throw new Error('WhatsApp bağlı değil');
    let body = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: this.sock.updateMediaMessage });
    let type = media?.mimetype?.split(';')[0] ?? 'application/octet-stream';
    if (type === 'audio/ogg' || type === 'audio/opus') {
      const mp3 = await transcodeToMp3(body).catch(() => undefined);
      if (mp3) {
        body = mp3;
        type = 'audio/mpeg';
      }
    }
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.type', type);
    return { body, type };
  }

  private ingest(m: WAMessage, live: boolean): void {
    const raw = m.key.remoteJid;
    if (!raw || !m.key.id || !isChatJid(raw)) return;
    // Sunucu her mesajda karşı kimliği de verir (lid sohbette sender_pn, numaralı sohbette sender_lid;
    // gruplarda participant_pn / participant_lid): en güvenilir lid↔numara kaynağı
    const k = m.key as typeof m.key & { senderPn?: string | null; senderLid?: string | null; participantPn?: string | null; participantLid?: string | null };
    if (raw.endsWith('@lid') && k.senderPn) this.link(raw, jidNormalizedUser(k.senderPn));
    else if (raw.endsWith('@s.whatsapp.net') && k.senderLid) this.link(jidNormalizedUser(k.senderLid), raw);
    const part = m.key.participant ? jidNormalizedUser(m.key.participant) : undefined;
    if (part?.endsWith('@lid') && k.participantPn) this.link(part, jidNormalizedUser(k.participantPn));
    else if (part?.endsWith('@s.whatsapp.net') && k.participantLid) this.link(jidNormalizedUser(k.participantLid), part);
    const jid = this.canon(raw);
    const content = unwrap(m.message);
    const text = textOf(content);
    const attachments = attachmentsOf(content);
    if (!text && attachments.length === 0) {
      // protokol/sistem mesajları; tanınmayan içerik türlerini bir kez günlüğe yaz (tek seferlik medya vb. tanı)
      const keys = Object.keys(m.message ?? {}).filter((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage').join(',') || '(boş)';
      const sig = `${keys}#${m.messageStubType ?? '-'}`;
      if (live && !seenUnknown.has(sig) && !/protocolMessage|reactionMessage|pollUpdateMessage|keepInChatMessage/.test(keys)) {
        seenUnknown.add(sig);
        bus.log('info', `WhatsApp: içeriği alınamayan mesaj: tür=${keys} stub=${m.messageStubType ?? '-'} sohbet=${jid} gönderen=${m.key.participant ?? '-'} fromMe=${!!m.key.fromMe}`);
      }
      return;
    }
    const bizName = (m as WAMessage & { verifiedBizName?: string | null }).verifiedBizName ?? undefined;
    if (!m.pushName && bizName) m.pushName = bizName;
    if (m.pushName && !m.key.fromMe) {
      const senderJid = this.canon(m.key.participant ?? jid);
      if (!this.nameCache.has(senderJid)) this.nameCache.set(senderJid, m.pushName);
      if (!jid.endsWith('@g.us') && !this.nameCache.has(jid)) {
        this.nameCache.set(jid, m.pushName);
        const existing = this.store.getChat(chatIdOf(this.account.id, jid));
        if (existing && existing.name !== m.pushName && (existing.name.startsWith('+') || existing.name === 'WhatsApp kişisi')) this.upsertChat({ remoteId: jid, name: m.pushName });
      }
    }
    if (attachments.length) {
      this.rememberMedia(m, jid);
      const base = `/api/media/${encodeURIComponent(this.account.id)}?u=`;
      const full = base + encodeURIComponent(`wa:${jid}/${m.key.id}`);
      const thumb = base + encodeURIComponent(`wa-thumb:${jid}/${m.key.id}`);
      const hasThumb = !!(content?.imageMessage?.jpegThumbnail ?? content?.videoMessage?.jpegThumbnail ?? content?.documentMessage?.jpegThumbnail);
      for (const a of attachments) {
        if (a.kind === 'image') {
          a.url = full;
          a.link = full;
        } else if (a.kind === 'video') {
          a.url = hasThumb ? thumb : undefined;
          a.link = full;
        } else if (a.kind === 'audio' || a.kind === 'file') {
          a.link = full;
          if (hasThumb) a.url = thumb;
        } else if (a.kind === 'other' && content?.stickerMessage) {
          a.url = full;
        }
      }
    }
    const senderJid = m.key.fromMe ? 'me' : this.canon(m.key.participant ?? jid);
    if (jid.endsWith('@g.us')) this.ensureGroupMeta(jid);
    if (!this.store.getChat(chatIdOf(this.account.id, jid)))
      this.upsertChat({ remoteId: jid, name: this.nameOf(jid), kind: jid.endsWith('@g.us') ? 'group' : 'direct', handle: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : undefined });
    this.upsertMessage(
      {
        remoteChatId: jid,
        remoteId: m.key.id,
        senderId: senderJid,
        senderName: m.key.fromMe ? 'Ben' : (this.nameCache.get(senderJid) ?? m.pushName ?? this.nameOf(senderJid)),
        senderAvatarUrl: m.key.fromMe ? undefined : this.avatarCache.get(senderJid) || undefined,
        fromMe: !!m.key.fromMe,
        text,
        ts: Number(m.messageTimestamp ?? Date.now() / 1000) * 1000,
        status: m.key.fromMe ? 'sent' : 'delivered',
        attachments: attachments.length ? attachments : undefined,
      },
      { live },
    );
  }
}

const seenUnknown = new Set<string>();
let ffmpegOk: boolean | undefined;
async function transcodeToMp3(input: Buffer): Promise<Buffer | undefined> {
  if (ffmpegOk === undefined) {
    ffmpegOk = await execFileP('ffmpeg', ['-version']).then(() => true).catch(() => false);
    if (!ffmpegOk) bus.log('info', 'ffmpeg yok: WhatsApp sesli mesajları ogg olarak sunulur (brew install ffmpeg ile mp3 dönüşümü açılır)');
  }
  if (!ffmpegOk) return undefined;
  const tmp = path.join(os.tmpdir(), `kavsak-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp + '.ogg', input);
  try {
    await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp + '.ogg', '-codec:a', 'libmp3lame', '-q:a', '4', tmp + '.mp3']);
    return fs.readFileSync(tmp + '.mp3');
  } finally {
    fs.rmSync(tmp + '.ogg', { force: true });
    fs.rmSync(tmp + '.mp3', { force: true });
  }
}

function isChatJid(jid: string): boolean {
  return (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid')) && jid !== 'status@broadcast';
}

function unwrap(m: proto.IMessage | null | undefined): proto.IMessage | undefined {
  if (!m) return undefined;
  const x = m as proto.IMessage & { viewOnceMessageV2Extension?: { message?: proto.IMessage | null } | null; editedMessage?: { message?: proto.IMessage | null } | null };
  const y = x as typeof x & { groupMentionedMessage?: { message?: proto.IMessage | null } | null; botInvokeMessage?: { message?: proto.IMessage | null } | null; lottieStickerMessage?: { message?: proto.IMessage | null } | null };
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? x.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message ?? x.editedMessage?.message ?? y.groupMentionedMessage?.message ?? y.botInvokeMessage?.message ?? y.lottieStickerMessage?.message;
  // iç içe sarmalar (ör. ephemeral içinde viewOnce)
  return inner ? unwrap(inner) ?? inner : m;
}

function textOf(m: proto.IMessage | undefined): string {
  if (!m) return '';
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ''
  );
}

function attachmentsOf(m: proto.IMessage | undefined): Attachment[] {
  if (!m) return [];
  const out: Attachment[] = [];
  if (m.imageMessage) out.push({ kind: 'image', name: 'Fotoğraf', mime: m.imageMessage.mimetype ?? undefined, size: Number(m.imageMessage.fileLength ?? 0) });
  if (m.videoMessage) out.push({ kind: 'video', name: m.videoMessage.gifPlayback ? 'GIF' : 'Video', mime: m.videoMessage.mimetype ?? undefined, size: Number(m.videoMessage.fileLength ?? 0) });
  if (m.audioMessage) out.push({ kind: 'audio', name: m.audioMessage.ptt ? 'Sesli mesaj' : 'Ses', mime: m.audioMessage.mimetype ?? undefined, size: Number(m.audioMessage.fileLength ?? 0) });
  if (m.documentMessage)
    out.push({ kind: 'file', name: m.documentMessage.fileName ?? undefined, mime: m.documentMessage.mimetype ?? undefined, size: Number(m.documentMessage.fileLength ?? 0) });
  if (m.stickerMessage) out.push({ kind: 'image', name: 'Çıkartma', mime: m.stickerMessage.mimetype ?? undefined });
  return out;
}
