/**
 * Ortak veri modeli. Her connector, platformun kendi nesnelerini bu şekle çevirir.
 * Kimlik kuralı: her kaydın (accountId, remoteId) çifti benzersizdir; böylece
 * geçmiş yükleme (backfill) ile canlı akış çakıştığında kayıt tekrarlanmaz.
 */

export type Platform = 'whatsapp' | 'telegram' | 'slack' | 'linkedin' | 'x' | 'imessage' | 'instagram' | 'messenger' | 'gmail' | 'outlook' | 'yahoo' | 'yandex' | 'icloud' | 'imap' | 'shopier' | 'trendyol' | 'hepsiburada' | 'etsy' | 'shopify' | 'n11' | 'amazon' | 'pttavm' | 'demo';
export const ALL_PLATFORMS: readonly Platform[] = ['whatsapp', 'telegram', 'slack', 'linkedin', 'x', 'imessage', 'instagram', 'messenger', 'gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm', 'demo'];
export const MAIL_PLATFORMS: Platform[] = ['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap'];

export type AccountStatus = 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'error';

export interface Account {
  id: string; // ör. "whatsapp:905xxxxxxxxx" ya da rastgele
  platform: Platform;
  label: string; // kullanıcıya gösterilen ad (telefon no, kullanıcı adı, workspace)
  status: AccountStatus;
  detail?: string; // hata mesajı, eşleşme adımı vb.
  createdAt: number;
  /** Bağlı ama kullanıcı eylemi bekleyen durum (ör. "şifreli sohbetler için PIN gerekli"); kalıcı değil, connector'dan gelir */
  attention?: string;
}

export type ChatKind = 'direct' | 'group' | 'channel';

export interface Chat {
  id: string; // `${accountId}/${remoteId}`
  accountId: string;
  platform: Platform;
  remoteId: string;
  name: string;
  kind: ChatKind;
  unread: number;
  lastMessageAt: number; // epoch ms
  lastPreview: string;
  /** Son mesaj benden mi (Odak → "Senin beklediklerin") */
  lastFromMe?: boolean;
  /** Mivelo'da okunan nokta (ms): bu zamana kadar olan mesajlar kalıcı olarak okundu */
  readUpto?: number;
  avatarUrl?: string;
  tags: string[];
  /** Platforma özel tanıtıcı: +numara, @kullanıcı, profil adı */
  handle?: string;
  /** Profil/grup sayfası bağlantısı (varsa) */
  link?: string;
  /** Grup üyeleri ya da birebir sohbetteki karşı taraf */
  participants?: Participant[];
  /** Platforma özel yapılandırılmış veri (örn. Shopier sipariş detayı) */
  meta?: Record<string, unknown>;
  /** Yerel düzenleme bayrakları (yalnızca Mivelo'da; platforma yansımaz) */
  pinned?: boolean;
  archived?: boolean;
  muted?: boolean;
  hidden?: boolean;
  /** Takip hatırlatıcısı: `at` zamanına kadar karşı taraftan (`since` sonrasında) yanıt gelmezse hatırlat */
  followUp?: FollowUp;
}

export interface FollowUp {
  /** Hatırlatma zamanı (ms) */
  at: number;
  /** Kurulduğu an (ms): bundan sonra gelen yanıt hatırlatmayı kendiliğinden kapatır */
  since: number;
  /** Süre doldu, yanıt yok: kullanıcıya gösteriliyor */
  due?: boolean;
}

/** Yerel sohbet bayrakları (sabitle/arşivle/sessize al/gizle) */
export type ChatFlags = Pick<Chat, 'pinned' | 'archived' | 'muted' | 'hidden'>;

export interface Participant {
  id: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  admin?: boolean;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string; // `${chatId}#${remoteId}`
  chatId: string;
  remoteId: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
  text: string;
  ts: number; // epoch ms
  status: MessageStatus;
  attachments?: Attachment[];
  /** Gönderenin profil fotoğrafı (grup sohbetleri için) */
  senderAvatarUrl?: string;
  /** Mesaja verilen emoji tepkileri */
  reactions?: Reaction[];
  /** Slack iş parçacığı yanıtı: üst mesajın remoteId'si */
  threadId?: string;
  /** Slack: bu mesajın iş parçacığındaki yanıt sayısı */
  replyCount?: number;
  /** Alıntılı yanıt: yanıtlanan mesaj (WhatsApp/Telegram/Instagram) — balonda alıntı kutusu, tıklayınca o mesaja gider */
  replyTo?: ReplyRef;
  /** E-posta: özgün HTML gövdesi var (ayrı yüklenir: GET /api/messages/:id/html; listede taşınmaz) */
  hasHtml?: boolean;
  /** Mesaj gönderildikten sonra düzenlendi (arayüzde "düzenlendi") */
  edited?: boolean;
  /** Mesaj herkesten silindi (metin "🚫 Bu mesaj silindi", ekler boş) */
  deleted?: boolean;
}

/** Herkesten silinen mesajın metni (WhatsApp/Telegram/Slack/Instagram ortak; arayüz 🚫 baş ikonunu SYSTEM_LEAD ile çizer) */
export const DELETED_TEXT = '🚫 Bu mesaj silindi';

export interface ReplyRef {
  /** yanıtlanan mesajın platform kimliği */
  remoteId: string;
  senderName: string;
  /** kısaltılmış metin (ek ise ek adı) */
  text: string;
  fromMe?: boolean;
}

export interface Reaction {
  emoji: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
}

export interface Attachment {
  kind: 'image' | 'file' | 'audio' | 'video' | 'other';
  name?: string;
  mime?: string;
  size?: number;
  /** Gönderi/profil sayfası (medya dosyasından ayrı) */
  page?: string;
  /** Önizleme görseli (varsa) */
  url?: string;
  /** Tıklanınca açılacak bağlantı (gönderi, reel, dış link) */
  link?: string;
}

/** Connector'ların yaydığı olaylar. Sunucu bunları WebSocket'e aynen iletir. */
export type CoreEvent =
  | { type: 'account.status'; account: Account }
  | { type: 'account.qr'; accountId: string; qrDataUrl: string }
  | { type: 'account.prompt'; accountId: string; prompt: 'phone' | 'code' | 'password'; message: string }
  | { type: 'chat.upsert'; chat: Chat }
  | { type: 'chat.delete'; chatId: string }
  | { type: 'message.upsert'; message: Message; chat: Chat; live?: boolean }
  | { type: 'message.delete'; chatId: string; messageId: string }
  /** Karşı taraf yazıyor / yazmayı bıraktı */
  | { type: 'chat.typing'; chatId: string; typing: boolean; name?: string }
  /** Bağlanma/eşitleme ilerlemesi 0-100 (0 = gizle, 100 = bitti) */
  | { type: 'account.sync'; accountId: string; progress: number; label?: string }
  /** Gönderdiğim mesajlar `before` zamanına kadar karşı tarafça görüldü */
  | { type: 'messages.read'; chatId: string; before: number }
  /** Takip hatırlatıcısının süresi doldu (yanıt gelmedi) */
  | { type: 'chat.followup'; chat: Chat }
  /** Zamanlanmış gönderim listesi değişti (eklendi/iptal/gönderildi) */
  | { type: 'scheduled.update' }
  /** Mivelo takvimi değişti / etkinlik hatırlatması */
  | { type: 'events.update' }
  | { type: 'event.reminder'; event: CalEvent }
  /** Zamanlanmış mesaj gönderilemedi / kaçırıldı */
  | { type: 'scheduled.missed'; item: { id: string; chatId: string; text: string; at: number; missed?: { reason: string; at: number } }; chatName: string }
  /** Mivelo içi giriş: görünmez tarayıcıdaki giriş sayfasının canlı görüntüsü (JPEG base64; boyut CSS pikseli) */
  | { type: 'login.frame'; accountId: string; data: string; width: number; height: number; host: string }
  | { type: 'login.start'; accountId: string }
  | { type: 'login.end'; accountId: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface CalEvent {
  id: string;
  title: string;
  /** yerel saat "YYYY-MM-DDTHH:mm" ya da tüm gün "YYYY-MM-DD" */
  start: string;
  durationMin?: number;
  allDay?: boolean;
  notes?: string;
  location?: string;
  /** mesajdan eklendiyse: sohbet ve mesaj (Takvim'den "Sohbete git") */
  chatId?: string;
  messageId?: string;
  /** başlangıçtan kaç dk önce bildirim (yok = hatırlatma yok) */
  remindMin?: number;
  /** cihaz takvimine de eklendiyse takvim adı */
  deviceCalendar?: string;
  createdAt: number;
}

export function chatId(accountId: string, remoteId: string): string {
  return `${accountId}/${remoteId}`;
}

export function messageId(chat: string, remoteId: string): string {
  return `${chat}#${remoteId}`;
}
