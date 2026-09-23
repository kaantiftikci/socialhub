import path from 'node:path';
import fs from 'node:fs';
import bigInt from 'big-integer';
import QRCode from 'qrcode';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import { sessionDir, TELEGRAM_API_ID, TELEGRAM_API_HASH } from '../config.js';
import type { ChatKind } from '../model.js';

import type { Entity } from 'telegram/define.js';

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
    await this.backfill(client);
  }

  async stop(): Promise<void> {
    await this.client?.disconnect();
    this.client = undefined;
    this.setStatus('disconnected');
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
    const entity = this.entities.get(remoteChatId) ?? (await this.client.getInputEntity(bigInt(remoteChatId)));
    const sent = await this.client.sendMessage(entity, { message: text });
    const id = String(sent.id);
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  async loadHistory(remoteChatId: string, limit = 50): Promise<void> {
    if (!this.client) return;
    const entity = this.entities.get(remoteChatId) ?? (await this.client.getInputEntity(bigInt(remoteChatId)));
    const chat = this.ensureChat(remoteChatId, remoteChatId);
    const msgs = await this.client.getMessages(entity, { limit });
    for (const m of msgs) this.ingest(m, remoteChatId, chat.name, false);
  }

  private ask(kind: 'phone' | 'code' | 'password', message: string): Promise<string> {
    this.setStatus('pairing', message);
    bus.emit({ type: 'account.prompt', accountId: this.account.id, prompt: kind, message });
    return new Promise((resolve) => this.pending.set(kind, { resolve }));
  }

  private async backfill(client: TelegramClient): Promise<void> {
    const dialogs = await client.getDialogs({ limit: 60 });
    for (const d of dialogs) {
      if (!d.id || !d.entity) continue;
      const rid = String(d.id);
      this.entities.set(rid, d.entity);
      const kind: ChatKind = d.isUser ? 'direct' : d.isChannel && !d.isGroup ? 'channel' : 'group';
      const name = d.title || d.name || rid;
      const last = d.message;
      this.upsertChat({
        remoteId: rid,
        name,
        kind,
        unread: d.unreadCount ?? 0,
        lastMessageAt: last?.date ? last.date * 1000 : 0,
        lastPreview: last?.message ?? '',
      });
      if (last) this.ingest(last, rid, name, false);
    }
    // En yeni 15 sohbetin son mesajlarını da çek
    for (const d of dialogs.slice(0, 15)) {
      if (!d.id || !d.entity) continue;
      const rid = String(d.id);
      try {
        const msgs = await client.getMessages(d.entity, { limit: 30 });
        for (const m of msgs) this.ingest(m, rid, d.title || d.name || rid, false);
      } catch (e) {
        bus.log('warn', `Telegram geçmiş alınamadı (${rid}): ${(e as Error).message}`);
      }
    }
    bus.log('info', `Telegram geçmişi: ${dialogs.length} sohbet`);
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
  }

  private ingest(m: Api.Message, remoteChatId: string, chatName: string, live: boolean, senderName?: string): void {
    const text = m.message ?? '';
    const media = m.media ? [{ kind: mediaKind(m.media), name: fileNameOf(m.media) }] : undefined;
    if (!text && !media) return;
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
        attachments: media,
      },
      { live },
    );
  }
}

function mediaKind(media: Api.TypeMessageMedia): 'image' | 'file' | 'audio' | 'video' | 'other' {
  if (media instanceof Api.MessageMediaPhoto) return 'image';
  if (media instanceof Api.MessageMediaDocument) {
    const mime = (media.document as Api.Document | undefined)?.mimeType ?? '';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    return 'file';
  }
  return 'other';
}

function fileNameOf(media: Api.TypeMessageMedia): string | undefined {
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as Api.Document | undefined;
    const attr = doc?.attributes?.find((a) => a instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined;
    return attr?.fileName;
  }
  return undefined;
}
