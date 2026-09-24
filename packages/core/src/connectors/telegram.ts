import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import bigInt from 'big-integer';
import QRCode from 'qrcode';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js';
import { getPeerId } from 'telegram/Utils.js';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import { sessionDir, TELEGRAM_API_ID, TELEGRAM_API_HASH } from '../config.js';
import type { Attachment, ChatKind } from '../model.js';

import type { Entity } from 'telegram/define.js';
import type { Dialog } from 'telegram/tl/custom/dialog.js';

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
    const client = new TelegramClient(new StringSession(saved), apiId, apiHash, {
      connectionRetries: 5,
      deviceModel: 'Kavşak',
      appVersion: '0.1',
    });
    this.client = client;
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
      this.setStatus('error', (e as Error).message);
      return;
    }

    fs.writeFileSync(this.sessionFile, String(client.session.save()), { mode: 0o600 });
    const me = await client.getMe();
    this.meId = String(me.id);
    this.account.label = me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(' ');
    this.setStatus('connected');

    client.addEventHandler((ev: NewMessageEvent) => void this.onNew(ev), new NewMessage({}));
    // Telefonda/başka istemcide okununca okunmamış sayacı burada da düşsün
    client.addEventHandler((u: Api.TypeUpdate) => this.onRead(u), new Raw({ types: [Api.UpdateReadHistoryInbox, Api.UpdateReadChannelInbox, Api.UpdateFolderPeers] }));
    await this.backfill(client);
  }

  async stop(): Promise<void> {
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
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (!this.client) return;
    const entity = await this.entityOf(remoteChatId);
    await this.client.markAsRead(entity);
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
        const c = chat as { title?: string; firstName?: string; lastName?: string } | undefined;
        name = c?.title ?? [c?.firstName, c?.lastName].filter(Boolean).join(' ') ?? rid;
        if (chat) this.entities.set(rid, chat as Entity);
      } catch {
        name = rid;
      }
    }
    let senderName = name;
    if (!m.out && !ev.isPrivate) {
      try {
        const s = (await m.getSender()) as { firstName?: string; lastName?: string; title?: string } | undefined;
        senderName = s?.title ?? [s?.firstName, s?.lastName].filter(Boolean).join(' ') ?? name;
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
    this.ensureChat(remoteChatId, chatName);
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
        attachments: attachments?.length ? attachments : undefined,
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
    if (media instanceof Api.MessageMediaWebPage) return []; // bağlantı önizlemesi; metin zaten mesajda
    if (media instanceof Api.MessageMediaContact) return [{ kind: 'other', name: `Kişi: ${[media.firstName, media.lastName].filter(Boolean).join(' ')} ${media.phoneNumber}`.trim() }];
    if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) return [{ kind: 'other', name: 'Konum' }];
    if (media instanceof Api.MessageMediaPoll) return [{ kind: 'other', name: 'Anket' }];
    return [{ kind: 'other', name: 'Medya' }];
  }
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
    if (!ffmpegOk) bus.log('info', 'ffmpeg yok: Telegram sesli mesajları ogg olarak sunulur (brew install ffmpeg ile mp3 dönüşümü açılır)');
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
