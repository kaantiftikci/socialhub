import { bus } from '../bus.js';
import type { Store } from '../store.js';
import { chatId, messageId, type Account, type AccountStatus, type Chat, type ChatKind, type Message, type Participant } from '../model.js';

/**
 * Her platform adapter'ının uyguladığı arayüz. Adapter'lar platform nesnelerini
 * ortak modele çevirip `upsertChat` / `upsertMessage` ile depoya yazar; olaylar
 * otomatik olarak arayüze akar.
 */
export interface StartOptions {
  interactive?: boolean;
}

export interface Connector {
  readonly account: Account;
  /** interactive=false: açılışta arka planda başlat; kullanıcıdan giriş isteyen pencere/QR açma. */
  start(opts?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }>;
  /** Telegram gibi etkileşimli girişlerde (telefon, kod, 2FA) arayüzden gelen değeri iletir. */
  provideInput?(kind: 'phone' | 'code' | 'password', value: string): void;
  /** Belirli bir sohbetin geçmişini (daha eski mesajları) ister. */
  /** `before`: yüklü en eski mesajın zaman damgası (ms); platformdan bundan eski mesajlar istenir */
  loadHistory?(remoteChatId: string, limit: number, before?: number): Promise<void>;
  /** Oturum çerezleri gerektiren medyayı (DM fotoğrafı/videosu) platformdan indirir. */
  fetchMedia?(url: string): Promise<{ body: Buffer; type: string } | undefined>;
  /** Bir grup üyesiyle birebir sohbet aç/bul; sohbetin remoteId'sini döndürür. */
  openDirect?(participant: Participant): Promise<string>;
  /** Platform tarafında da oturumu kapat (örn. WhatsApp "bağlı cihazlar"dan düş). */
  logout?(): Promise<void>;
  /** Fotoğraf/video/dosya gönder (destekleyen platformlar). file.path çekirdeğin yazdığı geçici dosya; caption isteğe bağlı açıklama */
  sendMedia?(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }>;
  /** Sohbet listesinin sonraki sayfasını (daha eski sohbetler/e-postalar) getir; eklenen sohbet sayısını döner, 0 = daha yok */
  loadMoreChats?(): Promise<number>;
  /** Sohbet açıkken çağrılır: yazıyor/çevrimiçi bilgisi için platforma abone ol (WhatsApp presenceSubscribe vb.) */
  watch?(remoteChatId: string): Promise<void>;
  /** Sohbet Kavşak'ta açılınca platformda da okundu işaretle (telefon/diğer istemcilerde okunmamış kalmasın) */
  markRead?(remoteChatId: string): Promise<void>;
  /** Platforma özel işlem (örn. Shopier siparişi kargo bilgisiyle kapatma) */
  action?(remoteChatId: string, payload: Record<string, unknown>): Promise<void>;
}

export abstract class BaseConnector implements Connector {
  constructor(
    public readonly account: Account,
    protected readonly store: Store,
  ) {}

  abstract start(opts?: StartOptions): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }>;
  openDirect?(participant: Participant): Promise<string>;

  /** Karşı taraf yazıyor (true) / bıraktı (false) — arayüz 6 sn sonra kendiliğinden düşürür */
  protected typing(remoteChatId: string, typing: boolean, name?: string): void {
    bus.emit({ type: 'chat.typing', chatId: chatId(this.account.id, remoteChatId), typing, name });
  }

  /** Gönderdiğim mesajlar `before` (ms) zamanına kadar görüldü: depoyu güncelle, arayüze bildir */
  protected outgoingRead(remoteChatId: string, before: number): void {
    const cid = chatId(this.account.id, remoteChatId);
    if (this.store.markOutgoingRead(cid, before) > 0) bus.emit({ type: 'messages.read', chatId: cid, before });
  }

  private syncDone = false;
  private syncTimer?: NodeJS.Timeout;
  private syncLast = 0;
  /** Bağlanma/eşitleme ilerlemesi (0-100). Connector kilometre taşlarını bildirir; bağlandıktan sonra 6 sn sohbet gelmezse 100 sayılır. */
  protected syncProgress(progress: number, label?: string): void {
    if (this.syncDone && progress < 100) this.syncDone = false;
    if (progress >= 100) this.syncDone = true;
    if (progress < this.syncLast && progress > 0) return; // geriye gitmesin
    this.syncLast = progress >= 100 ? 0 : progress;
    bus.emit({ type: 'account.sync', accountId: this.account.id, progress: Math.max(0, Math.min(100, Math.round(progress))), label });
  }
  /** Sohbet/mesaj akışı bağlandıktan sonra durunca eşitleme bitti sayılır */
  private touchSync(): void {
    if (this.syncDone || this.account.status !== 'connected') return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.syncProgress(100), 6000);
    this.syncTimer.unref?.();
  }

  protected setStatus(status: AccountStatus, detail?: string): void {
    this.account.status = status;
    this.account.detail = detail;
    this.store.upsertAccount(this.account);
    bus.emit({ type: 'account.status', account: { ...this.account } });
    if (status === 'connecting') this.syncProgress(5, 'bağlanıyor');
    else if (status === 'connected') {
      this.syncProgress(this.syncLast >= 60 ? this.syncLast : 60, 'sohbetler alınıyor');
      this.touchSync();
    } else this.syncProgress(0);
    bus.log(status === 'error' ? 'error' : 'info', `${this.account.platform}/${this.account.label}: ${status}${detail ? ' — ' + detail : ''}`);
  }

  protected upsertChat(input: {
    remoteId: string;
    name: string;
    kind?: ChatKind;
    unread?: number;
    lastMessageAt?: number;
    lastPreview?: string;
    avatarUrl?: string;
    handle?: string;
    link?: string;
    participants?: Participant[];
    meta?: Record<string, unknown>;
  }): Chat {
    this.touchSync();
    const id = chatId(this.account.id, input.remoteId);
    const existing = this.store.getChat(id);
    const chat = this.store.upsertChat({
      id,
      accountId: this.account.id,
      platform: this.account.platform,
      remoteId: input.remoteId,
      name: input.name || existing?.name || input.remoteId,
      kind: input.kind ?? existing?.kind ?? 'direct',
      unread: input.unread ?? existing?.unread ?? 0,
      lastMessageAt: input.lastMessageAt ?? existing?.lastMessageAt ?? 0,
      lastFromMe: existing?.lastFromMe,
      lastPreview: input.lastPreview ?? existing?.lastPreview ?? '',
      avatarUrl: input.avatarUrl ?? existing?.avatarUrl,
      tags: existing?.tags ?? [],
      handle: input.handle ?? existing?.handle,
      link: input.link ?? existing?.link,
      participants: input.participants ?? existing?.participants,
      meta: input.meta ?? existing?.meta,
    });
    bus.emit({ type: 'chat.upsert', chat });
    return chat;
  }

  protected upsertMessage(
    input: Omit<Message, 'id' | 'chatId'> & { remoteChatId: string },
    opts: { live?: boolean; bump?: boolean } = {},
  ): Message | undefined {
    const cid = chatId(this.account.id, input.remoteChatId);
    if (!this.store.getChat(cid)) {
      this.upsertChat({ remoteId: input.remoteChatId, name: input.fromMe ? input.remoteChatId : input.senderName });
    }
    const { remoteChatId: _drop, ...rest } = input;
    const message: Message = { ...rest, id: messageId(cid, input.remoteId), chatId: cid };
    // bump: okunmamış sayacını artır (varsayılan canlı mesajlarda); platform sayacı yetkiliyse (tarayıcı köprüsü) kapatılır
    const inserted = this.store.upsertMessage(message, { bumpUnread: opts.bump ?? opts.live });
    if (inserted && input.fromMe && !input.remoteId.startsWith('local-')) {
      for (const id of this.store.dropLocalDuplicates(cid)) bus.emit({ type: 'message.delete', chatId: cid, messageId: id });
    }
    const chat = this.store.getChat(cid)!;
    // Depodaki satırı yayınla (durum güncellemesi gibi kısmi girdiler metni/zamanı ezmesin)
    const stored = this.store.getMessage(message.id) ?? message;
    if (inserted || opts.live) bus.emit({ type: 'message.upsert', message: stored, chat, live: !!opts.live });
    else bus.emit({ type: 'chat.upsert', chat });
    return stored;
  }

  /** Bir üyeyle birebir sohbeti aç (yoksa oluştur) ve depoya yaz. */
  async openChatWith(p: Participant): Promise<Chat> {
    if (!this.openDirect) throw new Error('Bu platformda üyeyle doğrudan sohbet açma desteklenmiyor');
    const remoteId = await this.openDirect(p);
    return this.upsertChat({ remoteId, name: p.name, kind: 'direct', avatarUrl: p.avatarUrl, handle: p.handle });
  }

  protected hasMessage(remoteChatId: string, remoteId: string): boolean {
    return this.store.hasMessage(messageId(chatId(this.account.id, remoteChatId), remoteId));
  }

  protected ensureChat(remoteId: string, name: string, kind: ChatKind = 'direct'): Chat {
    return this.store.getChat(chatId(this.account.id, remoteId)) ?? this.upsertChat({ remoteId, name, kind });
  }
}
