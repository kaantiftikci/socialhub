/**
 * Ortak veri modeli. Her connector, platformun kendi nesnelerini bu şekle çevirir.
 * Kimlik kuralı: her kaydın (accountId, remoteId) çifti benzersizdir; böylece
 * geçmiş yükleme (backfill) ile canlı akış çakıştığında kayıt tekrarlanmaz.
 */

export type Platform = 'whatsapp' | 'telegram' | 'slack' | 'linkedin' | 'x' | 'imessage' | 'instagram' | 'messenger' | 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'imap' | 'shopier' | 'trendyol' | 'hepsiburada' | 'etsy' | 'shopify' | 'demo';
export const MAIL_PLATFORMS: Platform[] = ['gmail', 'outlook', 'yahoo', 'icloud', 'imap'];

export type AccountStatus = 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'error';

export interface Account {
  id: string; // ör. "whatsapp:905xxxxxxxxx" ya da rastgele
  platform: Platform;
  label: string; // kullanıcıya gösterilen ad (telefon no, kullanıcı adı, workspace)
  status: AccountStatus;
  detail?: string; // hata mesajı, eşleşme adımı vb.
  createdAt: number;
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
}

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
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export function chatId(accountId: string, remoteId: string): string {
  return `${accountId}/${remoteId}`;
}

export function messageId(chat: string, remoteId: string): string {
  return `${chat}#${remoteId}`;
}
