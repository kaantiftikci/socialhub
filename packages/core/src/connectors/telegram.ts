import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import bigInt from 'big-integer';
import QRCode from 'qrcode';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage, Raw, type NewMessageEvent } from 'teleproto/events/index.js';
import { getPeerId } from 'teleproto/Utils.js';
import { BaseConnector, type OutFile } from './base.js';
import type { Reaction } from '../model.js';
import { bus } from '../bus.js';
import { FFMPEG_HINT } from '../platform.js';
import { sessionDir, TELEGRAM_API_ID, TELEGRAM_API_HASH } from '../config.js';

/** Telegram cihaz listesinde görünen sürüm (paket sürümü) */
const MIVELO_VERSION = '0.1.0';
import type { Attachment, ChatKind } from '../model.js';

import type { Entity } from 'teleproto/define.js';
import type { Dialog } from 'teleproto/tl/custom/dialog.js';
import { installMessageBehaviour } from 'teleproto/tl/custom/message.js';

// teleproto mesaj yardımcılarını (m.sender, m.out…) ilk istemci oluşturulunca kurar; ingest istemciden bağımsız da çalışsın
installMessageBehaviour();

const execFileP = promisify(execFile);

type Pending = { resolve: (v: string) => void };

/**
 * Telegram: resmi MTProto istemcisi (GramJS). Kullanıcının kendi hesabı; bot değil.
 * Giriş etkileşimli: telefon → SMS/uygulama kodu → (varsa) 2FA parolası.
 */
export class TelegramConnector extends BaseConnector {
  private client?: TelegramClient;
  private pending = new Map<'phone' | 'code' | 'password', Pending>();
  private entities = new Map<string, Entity>();
  private meId = '';
  private watchTimer?: NodeJS.Timeout;
  private polling = false;
  /** stop() çağrıldı: sürmekte olan start() zamanlayıcı kurmadan çıksın */
  private stopped = false;

  private get sessionFile(): string {
    return path.join(sessionDir(this.account.id), 'session.txt');
  }

  async start(): Promise<void> {
    // api_id / api_hash: Bağlan penceresinden girilen değerler (token dosyası) ya da ortam değişkenleri
    let apiId = TELEGRAM_API_ID;
    let apiHash = TELEGRAM_API_HASH;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(sessionDir(this.account.id), 'token'), 'utf8')) as { apiId?: number | string; apiHash?: string };
      if (t.apiId && t.apiHash) {
        apiId = Number(t.apiId);
        apiHash = String(t.apiHash);
      }
    } catch {
      /* dosya yok */
    }
    if (!apiId || !apiHash) {
      this.setStatus('error', 'Telegram api_id / api_hash girilmedi (my.telegram.org → API development tools)');
      return;
    }
    const saved = fs.existsSync(this.sessionFile) ? fs.readFileSync(this.sessionFile, 'utf8').trim() : '';
    // teleproto (bakımı süren GramJS fork'u; GramJS Temmuz 2026'da arşivlendi): gerçek pts/qts boşluk yönetimi, UpdatesTooLong,
    // 15 dk sessizlikte getDifference. floodSleepThreshold 60: ≤60 sn FLOOD_WAIT kütüphanece beklenir, büyüğü hata olarak döner.
    const client = new TelegramClient(new StringSession(saved), apiId, apiHash, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      floodSleepThreshold: 60,
      // dürüst ve tutarlı cihaz bilgisi (Telegram'da Ayarlar → Cihazlar'da "Mivelo · macOS 15.x" gibi görünür)
      deviceModel: 'Mivelo',
      systemVersion: `${os.type() === 'Darwin' ? 'macOS' : os.type() === 'Windows_NT' ? 'Windows' : os.type()} ${os.release()}`,
      appVersion: MIVELO_VERSION,
      langCode: 'tr',
      systemLangCode: 'tr',
    });
    this.client = client;
    this.stopped = false;
    this.setStatus('connecting');

    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        // WhatsApp gibi: QR üret (tg://login?token=…), telefondaki Telegram → Ayarlar → Cihazlar → Masaüstü cihazı bağla ile okutulur.
        // 2FA parolası varsa arayüzden istenir. QR ~30 sn'de bir yenilenir; GramJS bunu kendisi yapar.
        this.setStatus('pairing', 'Telefondaki Telegram → Ayarlar → Cihazlar → “Masaüstü Cihazı Bağla” ile QR’ı okut');
        await client.signInUserWithQrCode(
          { apiId, apiHash },
          {
            qrCode: async ({ token }) => {
              const url = `tg://login?token=${token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
              const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
              bus.emit({ type: 'account.qr', accountId: this.account.id, qrDataUrl });
            },
            password: () => this.ask('password', 'İki adımlı doğrulama parolanı gir'),
            onError: async (e) => {
              bus.log('error', `Telegram: ${e.message}`);
              return false;
            },
          },
        );
      }
    } catch (e) {
      if (this.stopped || this.client !== client) return; // durdurulurken kopan bağlantı hata sayılmaz
      this.setStatus('error', (e as Error).message);
      return;
    }
    // start sürerken stop() çağrıldıysa (ya da yeni istemci kurulduysa) devam etme: zamanlayıcı/olay işleyicisi sızmasın
    if (this.stopped || this.client !== client) return;

    fs.writeFileSync(this.sessionFile, String(client.session.save()), { mode: 0o600 });
    const me = await client.getMe();
    if (this.stopped || this.client !== client) return;
    this.meId = String(me.id);
    this.account.label = me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(' ');
    this.setStatus('connected');
    // Telefon bildirimleri: başka bir oturum "çevrimiçi" görünürse Telegram telefona bildirim göndermeyebilir; açıkça çevrimdışı ol
    await client.invoke(new Api.account.UpdateStatus({ offline: true })).catch(() => undefined);

    client.addEventHandler((ev: NewMessageEvent) => void this.onNew(ev), new NewMessage({}));
    // Telefonda/başka istemcide okununca okunmamış sayacı burada da düşsün
    client.addEventHandler((u: Api.TypeUpdate) => this.onRead(u), new Raw({ types: [Api.UpdateReadHistoryInbox, Api.UpdateReadChannelInbox, Api.UpdateFolderPeers, Api.UpdateReadHistoryOutbox, Api.UpdateReadChannelOutbox, Api.UpdateUserTyping, Api.UpdateChatUserTyping, Api.UpdateChannelUserTyping, Api.UpdateMessageReactions] }));
    await this.backfill(client);
    // güncelleme durumunu (pts/qts) başlat: bundan sonra kopmada kaçanlar getDifference ile olay olarak gelir
    await client.catchUp().catch(() => undefined);
    if (this.stopped || this.client !== client) return;
    this.lastDialogScan = Date.now();
    // Bekçi (60 sn): bağlantı koptuysa bağlan + catchUp (kaçan güncellemeler olay akışından gelir). Eskiden 30 sn'de bir
    // getDialogs + getHistory yapılıyordu (saatte 120+ çağrı; yeni api_id'ler için FLOOD_WAIT ve anomali riski). Artık tam
    // sohbet taraması yalnız 10 dk'da bir yedek olarak.
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => void this.poll(), 60_000);
    this.watchTimer.unref?.();
  }

  private lastDialogScan = 0;
  private presenceTimer?: NodeJS.Timeout;
  /** Gönderim/okundu sonrası "çevrimdışı" durumunu tek sefer tazele (telefon bildirimleri kesilmesin); düzenli zamanlayıcı yok */
  private offlineSoon(): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    const client = this.client;
    this.presenceTimer = setTimeout(() => {
      if (client && client === this.client && client.connected) void client.invoke(new Api.account.UpdateStatus({ offline: true })).catch(() => undefined);
    }, 20_000 + Math.random() * 20_000);
    this.presenceTimer.unref?.();
  }

  /** Bağlantı bekçisi + kaçan mesaj yoklaması */
  private async poll(): Promise<void> {
    const client = this.client;
    if (!client || this.polling) return;
    this.polling = true;
    try {
      if (!client.connected) {
        bus.log('warn', 'Telegram: bağlantı kopmuş, yeniden bağlanılıyor');
        await client.connect();
        if (!client.connected) return;
        await client.catchUp().catch(() => undefined); // arada kaçan güncellemeler
      }
      if (Date.now() - this.lastDialogScan < 10 * 60_000) return;
      this.lastDialogScan = Date.now();
      const dialogs = await client.getDialogs({ limit: 25 });
      for (const d of dialogs) {
        if (!d.id || !d.entity || !d.message) continue;
        const rid = String(d.id);
        this.entities.set(rid, d.entity);
        const chat = this.store.getChat(`${this.account.id}/${rid}`);
        if (!this.hasMessage(rid, String(d.message.id))) {
          const name = chat?.name || d.title || d.name || rid;
          const msgs = await client.getMessages(d.entity, { limit: 20 });
          for (const m of [...msgs].reverse()) {
            if (this.hasMessage(rid, String(m.id))) continue;
            let senderName: string | undefined;
            if (!m.out && !d.isUser) senderName = entityName((m as { sender?: unknown }).sender) || undefined;
            this.ingest(m, rid, name, true, senderName);
          }
        }
        // Sayaç kaçan mesajlar yazıldıktan SONRA platformunkine eşitlenir: önce yazılınca canlı ingest aynı mesajları bir kez daha sayıyordu
        const cur = this.store.getChat(`${this.account.id}/${rid}`);
        if (cur && (d.unreadCount ?? 0) !== cur.unread) this.upsertChat({ remoteId: rid, name: cur.name, unread: d.unreadCount ?? 0 });
      }
    } catch (e) {
      bus.log('warn', `Telegram yoklama: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
    await this.client?.disconnect();
    this.client = undefined;
    this.setStatus('disconnected');
  }

  /** Telefondaki Ayarlar → Cihazlar ("Aktif oturumlar") listesinden de düş; registry.remove() çağırır. */
  async logout(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      // Bağlantı kurulamamışsa invoke sonsuza dek bekleyebilir; 10 sn ile sınırla ki hesap kaldırma askıda kalmasın
      if (client.connected) {
        await withTimeout(
          (async () => {
            if (await client.checkAuthorization()) await client.invoke(new Api.auth.LogOut());
          })(),
          10_000,
          'Telegram oturum kapatma zaman aşımı',
        );
      }
    } finally {
      await withTimeout(client.disconnect(), 5_000, 'disconnect').catch(() => undefined);
      this.client = undefined;
    }
  }

  provideInput(kind: 'phone' | 'code' | 'password', value: string): void {
    const p = this.pending.get(kind);
    if (p) {
      this.pending.delete(kind);
      p.resolve(value);
    }
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (!this.client) throw new Error('Telegram bağlı değil');
    const entity = await this.entityOf(remoteChatId);
    const sent = await this.client.sendMessage(entity, { message: text });
    const id = String(sent.id);
    this.offlineSoon();
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /** Yeni sohbet: @kullanıcıadı, +telefon ya da sayısal kimlik → varlık çözülür, sohbet kimliği (kullanıcı id) döner */
  async openDirect(p: { id: string; name: string }): Promise<string> {
    if (!this.client) throw new Error('Telegram bağlı değil');
    const raw = p.id.trim();
    if (/^-?\d+$/.test(raw)) return raw;
    const key = raw.startsWith('@') ? raw : /^\+?\d[\d\s-]{6,}$/.test(raw) ? raw.replace(/[\s-]/g, '') : '@' + raw;
    const ent = await this.client.getEntity(key).catch(() => undefined);
    if (!ent || !('id' in ent)) throw new Error(`Telegram'da bulunamadı: ${raw} (kullanıcı adı ya da rehberdeki numara olmalı)`);
    this.entities.set(String(ent.id), ent as never);
    return String(ent.id);
  }

  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    if (!this.client) throw new Error('Telegram bağlı değil');
    const peer = await this.entityOf(remoteChatId);
    await this.client.invoke(new Api.messages.SendReaction({ peer, msgId: Number(remoteMsgId), reaction: remove ? [] : [new Api.ReactionEmoji({ emoticon: emoji })] }));
  }

  /**
   * Fotoğraf/video/ses/belge gönder. GramJS sendFile dosya türünü uzantıdan çıkarır (jpg/png → fotoğraf, mp4 → video);
   * MIME görsel/video/ses değilse forceDocument ile belge olarak gider. Dönen mesaj ingest ile yazılır: medya vekili tg:<sohbet>/<id>.
   */
  async sendMedia(remoteChatId: string, file: OutFile, caption?: string): Promise<{ remoteId: string }> {
    if (!this.client) throw new Error('Telegram bağlı değil');
    if (!fs.existsSync(file.path)) throw new Error('Gönderilecek dosya bulunamadı');
    const entity = await this.entityOf(remoteChatId);
    const sent = await this.client.sendFile(entity, tgSendFileParams(file, caption));
    const id = String(sent.id);
    const chat = this.ensureChat(remoteChatId, remoteChatId);
    this.ingest(sent, remoteChatId, chat.name, false);
    if (!this.hasMessage(remoteChatId, id)) {
      // sendFile medyasız/eksik mesaj döndürdüyse yerel kayıt: ek bilgisi dosyadan
      const kind = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
      const link = `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(`tg:${remoteChatId}/${id}`)}`;
      this.upsertMessage({
        remoteChatId,
        remoteId: id,
        senderId: 'me',
        senderName: 'Ben',
        fromMe: true,
        text: caption ?? '',
        ts: Date.now(),
        status: 'sent',
        attachments: [{ kind, name: file.name, mime: file.mime, size: file.size, url: kind === 'image' ? link : undefined, link }],
      });
    }
    return { remoteId: id };
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (!this.client) return;
    const entity = await this.entityOf(remoteChatId);
    await this.client.markAsRead(entity);
    this.offlineSoon();
  }

  /** before: arayüzde yüklü en eski mesajın ms zaman damgası → bundan eski mesajlar; yoksa en yeni `limit` mesaj */
  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (!this.client) return;
    const entity = await this.entityOf(remoteChatId);
    const chat = this.ensureChat(remoteChatId, remoteChatId);
    const msgs = await this.client.getMessages(entity, before ? { limit, offsetDate: Math.floor(before / 1000) } : { limit });
    for (const m of msgs) this.ingest(m, remoteChatId, chat.name, false);
  }

  /**
   * u biçimleri: "tg:<sohbet>/<mesaj>" tam medya, "tg-thumb:<sohbet>/<mesaj>" belge/video küçük önizlemesi.
   * Mesaj yeniden alınır (file_reference tazelenir), indirilir ve ~/.kavsak/sessions/<hesap>/media altına önbelleklenir.
   * Sesli mesajlar (ogg/opus) ffmpeg varsa mp3'e çevrilir (WebKit ogg oynatamaz).
   */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    // "tg-avatar:<sohbet>": profil fotoğrafı (küçük boy), 1 gün önbellek
    const av = u.match(/^tg-avatar:(-?\d+)$/);
    if (av) {
      const dir = path.join(sessionDir(this.account.id), 'media');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${av[1]}_avatar`);
      if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 86400e3) return { body: fs.readFileSync(file), type: 'image/jpeg' };
      if (!this.client) throw new Error('Telegram bağlı değil');
      const entity = await this.entityOf(av[1]);
      const res = await this.client.downloadProfilePhoto(entity, { isBig: false });
      const body = Buffer.isBuffer(res) ? res : typeof res === 'string' ? fs.readFileSync(res) : undefined;
      if (!body || !body.length) return undefined;
      fs.writeFileSync(file, body);
      return { body, type: 'image/jpeg' };
    }
    const m = u.match(/^(tg|tg-thumb):(-?\d+)\/(\d+)$/);
    if (!m) throw new Error('geçersiz Telegram medya adresi');
    const [, kind, rid, idStr] = m;
    const msgId = Number(idStr);
    const thumb = kind === 'tg-thumb';
    const dir = path.join(sessionDir(this.account.id), 'media');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${rid}_${msgId}${thumb ? '_thumb' : ''}`);
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    if (!this.client) throw new Error('Telegram bağlı değil');
    const entity = await this.entityOf(rid);
    const [msg] = await this.client.getMessages(entity, { ids: [msgId] });
    if (!(msg instanceof Api.Message) || !msg.media) throw new Error('mesajda medya yok (silinmiş olabilir)');
    let type = 'application/octet-stream';
    let params: { thumb?: number } = {};
    if (thumb) {
      const doc = msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document ? msg.media.document : undefined;
      const sizes = (doc?.thumbs ?? []).filter((t) => !(t instanceof Api.PhotoPathSize));
      if (doc && !sizes.length) throw new Error('önizleme yok');
      // GramJS küçük→büyük sıralar; en büyük (≤320px) önizlemeyi al. Fotoğrafta thumb verilmezse tam boyut iner.
      params = doc ? { thumb: sizes.length - 1 } : {};
      type = 'image/jpeg';
    } else if (msg.media instanceof Api.MessageMediaPhoto) type = 'image/jpeg';
    else if (msg.media instanceof Api.MessageMediaDocument && msg.media.document instanceof Api.Document) type = msg.media.document.mimeType || type;
    const out = await this.client.downloadMedia(msg, params);
    if (!out) throw new Error('medya indirilemedi');
    let body = Buffer.isBuffer(out) ? out : fs.readFileSync(out);
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

  private async entityOf(remoteChatId: string): Promise<Entity | Api.TypeInputPeer> {
    if (!this.client) throw new Error('Telegram bağlı değil');
    return this.entities.get(remoteChatId) ?? (await this.client.getInputEntity(bigInt(remoteChatId)));
  }

  /** UpdateReadHistoryInbox / UpdateReadChannelInbox: başka istemcide okundu → platformun verdiği kalan sayıyı yaz */
  private onRead(u: Api.TypeUpdate): void {
    if (u instanceof Api.UpdateMessageReactions) {
      const rid = getPeerId(u.peer);
      const chat = this.store.getChat(`${this.account.id}/${rid}`);
      const m = chat && this.store.setReactions(`${chat.id}#${u.msgId}`, tgReactions(u.reactions, chat.kind === 'direct' ? chat.name : ''));
      if (m && chat) bus.emit({ type: 'message.upsert', message: m, chat });
      return;
    }
    // Karşı taraf yazıyor (birebir / grup / kanal)
    if (u instanceof Api.UpdateUserTyping || u instanceof Api.UpdateChatUserTyping || u instanceof Api.UpdateChannelUserTyping) {
      const rid = u instanceof Api.UpdateUserTyping ? String(u.userId) : u instanceof Api.UpdateChatUserTyping ? String(-Number(u.chatId)) : getPeerId(new Api.PeerChannel({ channelId: u.channelId }));
      const typing = !(u.action instanceof Api.SendMessageCancelAction);
      const from = u instanceof Api.UpdateUserTyping ? String(u.userId) : u.fromId instanceof Api.PeerUser ? String(u.fromId.userId) : undefined;
      const who = from ? this.store.getChat(`${this.account.id}/${from}`)?.name : undefined;
      if (rid) this.typing(rid, typing, who);
      return;
    }
    // Gönderdiklerim karşı tarafça okundu (maxId'ye kadar)
    if (u instanceof Api.UpdateReadHistoryOutbox || u instanceof Api.UpdateReadChannelOutbox) {
      const rid = u instanceof Api.UpdateReadHistoryOutbox ? getPeerId(u.peer) : getPeerId(new Api.PeerChannel({ channelId: u.channelId }));
      if (rid) {
        const cid = `${this.account.id}/${rid}`;
        const t = this.store.markOutgoingReadUpToId(cid, u.maxId);
        if (t) bus.emit({ type: 'messages.read', chatId: cid, before: t });
      }
      return;
    }
    // Arşive alma / arşivden çıkarma anında yansısın
    if (u instanceof Api.UpdateFolderPeers) {
      for (const fp of u.folderPeers) {
        const id = getPeerId(fp.peer);
        const chat = id ? this.store.getChat(`${this.account.id}/${id}`) : undefined;
        if (chat) this.upsertChat({ remoteId: id!, name: chat.name, meta: { ...(chat.meta ?? {}), archived: fp.folderId === 1 } });
      }
      return;
    }
    let rid: string | undefined;
    let still = 0;
    if (u instanceof Api.UpdateReadHistoryInbox) {
      rid = getPeerId(u.peer);
      still = u.stillUnreadCount;
    } else if (u instanceof Api.UpdateReadChannelInbox) {
      rid = getPeerId(new Api.PeerChannel({ channelId: u.channelId }));
      still = u.stillUnreadCount;
    }
    if (!rid) return;
    const chat = this.store.getChat(`${this.account.id}/${rid}`);
    const unread = Math.max(0, still ?? 0);
    if (!chat || chat.unread === unread) return;
    this.upsertChat({ remoteId: rid, name: chat.name, unread });
  }

  private ask(kind: 'phone' | 'code' | 'password', message: string): Promise<string> {
    this.setStatus('pairing', message);
    bus.emit({ type: 'account.prompt', accountId: this.account.id, prompt: kind, message });
    return new Promise((resolve) => this.pending.set(kind, { resolve }));
  }

  private async backfill(client: TelegramClient): Promise<void> {
    // Ana liste (folder 0) + arşiv (folder 1) ayrı ayrı; arşiv ana listenin limitine takılmasın
    const dialogs: Dialog[] = [];
    const seen = new Set<string>();
    for (const params of [{ limit: 200, folder: 0 }, { limit: 100, archived: true }]) {
      try {
        for (const d of await client.getDialogs(params)) {
          if (!d.id || !d.entity) continue;
          const rid = String(d.id);
          if (seen.has(rid)) continue;
          seen.add(rid);
          dialogs.push(d);
        }
      } catch (e) {
        bus.log('warn', `Telegram sohbet listesi alınamadı (${'archived' in params ? 'arşiv' : 'ana liste'}): ${(e as Error).message}`);
      }
    }
    for (const d of dialogs) {
      const rid = String(d.id);
      this.entities.set(rid, d.entity!);
      const kind: ChatKind = d.isUser ? 'direct' : d.isChannel && !d.isGroup ? 'channel' : 'group';
      const name = d.title || d.name || rid;
      const last = d.message;
      const archived = !!(d.archived || d.folderId === 1);
      const existing = this.store.getChat(`${this.account.id}/${rid}`);
      const photo = (d.entity as { photo?: unknown }).photo;
      const hasPhoto = !!photo && !(photo instanceof Api.UserProfilePhotoEmpty) && !(photo instanceof Api.ChatPhotoEmpty);
      this.upsertChat({
        remoteId: rid,
        name,
        kind,
        avatarUrl: hasPhoto ? `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(`tg-avatar:${rid}`)}` : undefined,
        unread: d.unreadCount ?? 0,
        lastMessageAt: last?.date ? last.date * 1000 : undefined,
        lastPreview: last ? previewOf(last) : undefined,
        // archived:false da açıkça yazılır ki arşivden çıkarılan sohbet ana listeye dönsün (meta COALESCE ile korunur)
        meta: { ...(existing?.meta ?? {}), archived },
      });
      if (last) this.ingest(last, rid, name, false);
    }
    // En yeni 15 sohbetin son 30 mesajı: 5'li gruplar halinde paralel; hata (flood-wait vb.) gelirse seri devam
    const top = dialogs.filter((d) => !(d.archived || d.folderId === 1)).slice(0, 15);
    const recent = async (d: Dialog): Promise<void> => {
      const rid = String(d.id);
      const msgs = await client.getMessages(d.entity, { limit: 30 });
      for (const m of msgs) this.ingest(m, rid, d.title || d.name || rid, false);
    };
    let serial = false;
    for (let i = 0; i < top.length; i += 5) {
      const group = top.slice(i, i + 5);
      if (!serial) {
        const results = await Promise.allSettled(group.map(recent));
        const failed = group.filter((_, j) => results[j].status === 'rejected');
        if (!failed.length) continue;
        serial = true;
        bus.log('warn', `Telegram geçmiş paralel alınamadı (${(results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message ?? '?'}); seri devam`);
        for (const d of failed) await recent(d).catch((e) => bus.log('warn', `Telegram geçmiş alınamadı (${d.id}): ${(e as Error).message}`));
      } else {
        for (const d of group) await recent(d).catch((e) => bus.log('warn', `Telegram geçmiş alınamadı (${d.id}): ${(e as Error).message}`));
      }
    }
    const archivedCount = dialogs.filter((d) => d.archived || d.folderId === 1).length;
    bus.log('info', `Telegram geçmişi: ${dialogs.length} sohbet (${archivedCount} arşivde)`);
  }

  private async onNew(ev: NewMessageEvent): Promise<void> {
    const m = ev.message;
    const rid = m.chatId ? String(m.chatId) : undefined;
    if (!rid) return;
    let name = this.store.getChat(`${this.account.id}/${rid}`)?.name;
    if (!name) {
      try {
        const chat = await m.getChat();
        name = entityName(chat) || rid;
        if (chat) this.entities.set(rid, chat as Entity);
      } catch {
        name = rid;
      }
    }
    let senderName = name;
    if (!m.out && !ev.isPrivate) {
      try {
        senderName = entityName(await m.getSender()) || name;
      } catch {
        /* yok say */
      }
    }
    this.ingest(m, rid, name, true, senderName);
    // Başka cihazdan gönderdiğim mesaj sohbeti Telegram'da okundu sayar; sayaç burada da sıfırlansın
    if (m.out) {
      const chat = this.store.getChat(`${this.account.id}/${rid}`);
      if (chat && chat.unread > 0) this.upsertChat({ remoteId: rid, name: chat.name, unread: 0 });
    }
  }

  private ingest(m: Api.Message, remoteChatId: string, chatName: string, live: boolean, senderName?: string): void {
    if (!(m instanceof Api.Message)) return; // MessageService (katılma, başlık değişimi vb.) atlanır
    const text = m.message ?? '';
    const attachments = m.media ? this.attachmentsOf(m.media, remoteChatId, m.id) : undefined;
    if (!text && !attachments?.length) return;
    const chat = this.ensureChat(remoteChatId, chatName);
    // Gruplarda gönderen: getMessages/getDialogs sonucundaki varlıklar mesaja bağlanır (m.sender). Eskiden geçmiş mesajlarda
    // gönderen adı olarak grup adı yazılıyordu. Kanal gönderileri kanal adıyla, birebir sohbetler karşı tarafın adıyla kalır.
    if (!senderName && !m.out && chat.kind === 'group') senderName = entityName((m as { sender?: unknown }).sender) || undefined;
    this.upsertMessage(
      {
        remoteChatId,
        remoteId: String(m.id),
        senderId: m.out ? 'me' : String(m.senderId ?? remoteChatId),
        senderName: m.out ? 'Ben' : (senderName ?? chatName),
        fromMe: !!m.out,
        text,
        ts: (m.date ?? Math.floor(Date.now() / 1000)) * 1000,
        status: m.out ? 'sent' : 'delivered',
        // Boş dizi de yazılır: eski sürümün bağlantı önizlemesi için bıraktığı içi boş {kind:'other'} eki temizlensin
        attachments: attachments ?? undefined,
        reactions: tgReactions(m.reactions, chat.kind === 'direct' ? chatName : ''),
      },
      { live },
    );
  }

  /** Foto/video/sesli mesaj/belge/çıkartma → Attachment; medya "/api/media/<hesap>?u=tg:<sohbet>/<mesaj>" vekilinden iner */
  private attachmentsOf(media: Api.TypeMessageMedia, remoteChatId: string, msgId: number): Attachment[] {
    const base = `/api/media/${encodeURIComponent(this.account.id)}?u=`;
    const full = base + encodeURIComponent(`tg:${remoteChatId}/${msgId}`);
    const thumb = base + encodeURIComponent(`tg-thumb:${remoteChatId}/${msgId}`);
    if (media instanceof Api.MessageMediaPhoto) {
      const photo = media.photo instanceof Api.Photo ? media.photo : undefined;
      const size = photo?.sizes.reduce((acc, s) => Math.max(acc, s instanceof Api.PhotoSize ? s.size : s instanceof Api.PhotoSizeProgressive ? Math.max(...s.sizes) : 0), 0);
      return [{ kind: 'image', name: 'Fotoğraf', mime: 'image/jpeg', size: size || undefined, url: full, link: full }];
    }
    if (media instanceof Api.MessageMediaDocument) {
      const doc = media.document instanceof Api.Document ? media.document : undefined;
      if (!doc) return [{ kind: 'other', name: 'Medya' }];
      const mime = doc.mimeType || 'application/octet-stream';
      const size = Number(doc.size.toString()) || undefined;
      const attrs = doc.attributes ?? [];
      const fileName = (attrs.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined)?.fileName;
      const audio = attrs.find((a) => a instanceof Api.DocumentAttributeAudio) as Api.DocumentAttributeAudio | undefined;
      const video = attrs.find((a) => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
      const sticker = attrs.some((a) => a instanceof Api.DocumentAttributeSticker);
      const hasThumb = (doc.thumbs ?? []).some((t) => !(t instanceof Api.PhotoPathSize));
      if (sticker) {
        // webp çıkartma doğrudan gösterilir; animasyonlu (tgs/webm) için önizleme
        if (mime === 'image/webp') return [{ kind: 'image', name: 'Çıkartma', mime, size, url: full, link: full }];
        return [{ kind: 'other', name: 'Çıkartma', mime, size, url: hasThumb ? thumb : undefined, link: full }];
      }
      if (audio || mime.startsWith('audio/')) {
        const title = audio?.voice ? 'Sesli mesaj' : fileName ?? ([audio?.performer, audio?.title].filter(Boolean).join(' — ') || 'Ses');
        return [{ kind: 'audio', name: title, mime, size, link: full }];
      }
      if (video || mime.startsWith('video/')) {
        const name = video?.roundMessage ? 'Görüntülü mesaj' : fileName ?? 'Video';
        return [{ kind: 'video', name, mime, size, url: hasThumb ? thumb : undefined, link: full }];
      }
      if (mime.startsWith('image/')) return [{ kind: 'image', name: fileName ?? 'Görsel', mime, size, url: full, link: full }];
      return [{ kind: 'file', name: fileName ?? 'Dosya', mime, size, url: hasThumb ? thumb : undefined, link: full }];
    }
    if (media instanceof Api.MessageMediaWebPage) {
      // Bağlantı önizlemesi: adres metinde zaten var; başlık varsa tıklanabilir kart olarak ekle
      const wp = media.webpage instanceof Api.WebPage ? media.webpage : undefined;
      if (!wp?.url || !(wp.title || wp.siteName)) return [];
      return [{ kind: 'other', name: [wp.siteName, wp.title].filter(Boolean).join(' — '), link: wp.url }];
    }
    if (media instanceof Api.MessageMediaContact) return [{ kind: 'other', name: `Kişi: ${[media.firstName, media.lastName].filter(Boolean).join(' ')} ${media.phoneNumber}`.trim() }];
    if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) return [{ kind: 'other', name: 'Konum' }];
    if (media instanceof Api.MessageMediaPoll) return [{ kind: 'other', name: 'Anket' }];
    return [{ kind: 'other', name: 'Medya' }];
  }
}

/**
 * Gönderilecek dosya → GramJS sendFile parametreleri. Görsel/video/ses MIME'ları doğal medya olarak gider (GramJS türü
 * uzantıdan çıkarır; ses için DocumentAttributeAudio kendisi ekler), diğerleri forceDocument ile belge. Boş altyazı verilmez.
 */
export function tgSendFileParams(file: { path: string; name: string; mime: string; voice?: boolean }, caption?: string): { file: string; caption?: string; forceDocument: boolean; voiceNote?: boolean } {
  const mime = file.mime.toLowerCase().split(';')[0].trim();
  const native = /^(image|video|audio)\//.test(mime) && mime !== 'image/gif' && !/^image\/(svg|heic|heif|tiff)/.test(mime);
  // voice: mikrofon kaydı → Telegram "sesli mesaj" (yuvarlak dalga biçimli balon); GramJS ogg/opus bekler ama diğer biçimleri de kabul eder
  if (file.voice) return { file: file.path, caption: caption || undefined, forceDocument: false, voiceNote: true };
  return { file: file.path, caption: caption || undefined, forceDocument: !native };
}

/**
 * Telegram tepkileri → Reaction[]: recentReactions varsa kişi bazlı (my → benim); yoksa results sayaçları
 * (chosenOrder → benim, kalanlar kimliksiz). Birebir sohbette karşı tarafın adı otherName.
 */
export function tgReactions(r: Api.TypeMessageReactions | undefined | null, otherName: string): Reaction[] | undefined {
  if (!(r instanceof Api.MessageReactions)) return undefined;
  const emojiOf = (x: Api.TypeReaction) => (x instanceof Api.ReactionEmoji ? x.emoticon : x instanceof Api.ReactionCustomEmoji ? '⭐' : '');
  const out: Reaction[] = [];
  if (r.recentReactions?.length) {
    for (const x of r.recentReactions) {
      const e = emojiOf(x.reaction);
      if (!e) continue;
      const pid = getPeerId(x.peerId);
      out.push({ emoji: e, senderId: x.my ? 'me' : pid, senderName: x.my ? 'Ben' : otherName, fromMe: !!x.my });
    }
    if (out.length) return out;
  }
  for (const c of r.results ?? []) {
    const e = emojiOf(c.reaction);
    if (!e) continue;
    const mine = c.chosenOrder != null;
    if (mine) out.push({ emoji: e, senderId: 'me', senderName: 'Ben', fromMe: true });
    for (let i = mine ? 1 : 0; i < c.count; i++) out.push({ emoji: e, senderId: otherName && c.count - (mine ? 1 : 0) === 1 ? 'other' : `tg#${e}#${i}`, senderName: otherName, fromMe: false });
  }
  return out.length ? out : undefined;
}

/** Kullanıcı/grup/kanal varlığının görünen adı (ad soyad → kullanıcı adı → başlık); bilinmiyorsa '' */
export function entityName(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const x = e as { title?: string; firstName?: string; lastName?: string; username?: string };
  if (x.title) return x.title;
  return [x.firstName, x.lastName].filter(Boolean).join(' ').trim() || (x.username ? '@' + x.username : '');
}

/** Sohbet listesi önizlemesi: metin yoksa medya türü */
function previewOf(m: Api.Message): string {
  if (m.message) return m.message;
  const media = m.media;
  if (!media) return '';
  if (media instanceof Api.MessageMediaPhoto) return '📷 Fotoğraf';
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document instanceof Api.Document ? media.document : undefined;
    const attrs = doc?.attributes ?? [];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) return 'Çıkartma';
    const audio = attrs.find((a) => a instanceof Api.DocumentAttributeAudio) as Api.DocumentAttributeAudio | undefined;
    if (audio?.voice) return '🎤 Sesli mesaj';
    if (audio || doc?.mimeType.startsWith('audio/')) return '🎵 Ses';
    if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo) || doc?.mimeType.startsWith('video/')) return '🎬 Video';
    const name = (attrs.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined)?.fileName;
    return `📎 ${name ?? 'Dosya'}`;
  }
  if (media instanceof Api.MessageMediaContact) return '👤 Kişi';
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) return '📍 Konum';
  if (media instanceof Api.MessageMediaPoll) return '📊 Anket';
  return '';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

let ffmpegOk: boolean | undefined;
async function transcodeToMp3(input: Buffer): Promise<Buffer | undefined> {
  if (ffmpegOk === undefined) {
    ffmpegOk = await execFileP('ffmpeg', ['-version']).then(() => true).catch(() => false);
    if (!ffmpegOk) bus.log('info', `ffmpeg yok: Telegram sesli mesajları ogg olarak sunulur (${FFMPEG_HINT} ile mp3 dönüşümü açılır)`);
  }
  if (!ffmpegOk) return undefined;
  const tmp = path.join(os.tmpdir(), `kavsak-tg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp + '.ogg', input);
  try {
    await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp + '.ogg', '-codec:a', 'libmp3lame', '-q:a', '4', tmp + '.mp3']);
    return fs.readFileSync(tmp + '.mp3');
  } finally {
    fs.rmSync(tmp + '.ogg', { force: true });
    fs.rmSync(tmp + '.mp3', { force: true });
  }
}
