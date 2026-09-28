export type Platform = 'whatsapp' | 'telegram' | 'slack' | 'linkedin' | 'x' | 'imessage' | 'instagram' | 'messenger' | 'gmail' | 'outlook' | 'yahoo' | 'yandex' | 'icloud' | 'imap' | 'shopier' | 'trendyol' | 'hepsiburada' | 'etsy' | 'shopify' | 'n11' | 'amazon' | 'pttavm' | 'demo';
export type Category = 'chat' | 'mail' | 'shop';
export type AccountStatus = 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'error';

export interface Account {
  id: string;
  platform: Platform;
  label: string;
  status: AccountStatus;
  detail?: string;
  createdAt: number;
  qrDataUrl?: string;
  /** Bağlı ama kullanıcı eylemi bekliyor (şifreli sohbet PIN'i vb.) */
  attention?: string;
}

export interface Chat {
  id: string;
  accountId: string;
  platform: Platform;
  remoteId: string;
  name: string;
  kind: 'direct' | 'group' | 'channel';
  unread: number;
  lastMessageAt: number;
  lastPreview: string;
  lastFromMe?: boolean;
  avatarUrl?: string;
  tags: string[];
  handle?: string;
  link?: string;
  participants?: Participant[];
  meta?: Record<string, unknown>;
  /** Yerel bayraklar (yalnızca Mivelo'da) */
  pinned?: boolean;
  archived?: boolean;
  muted?: boolean;
  hidden?: boolean;
  /** Takip hatırlatıcısı: `at` zamanına kadar yanıt gelmezse hatırlat; `due` = süre doldu, yanıt yok */
  followUp?: { at: number; since: number; due?: boolean };
}

export type ChatFlags = Pick<Chat, 'pinned' | 'archived' | 'muted' | 'hidden'>;

export interface Reaction {
  emoji: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
}

export interface LinkPreview {
  url: string;
  site?: string;
  title?: string;
  description?: string;
  image?: string;
  none?: boolean;
}

export interface Participant {
  id: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  admin?: boolean;
}

export interface Attachment {
  kind: 'image' | 'file' | 'audio' | 'video' | 'other';
  name?: string;
  mime?: string;
  size?: number;
  url?: string;
  link?: string;
  page?: string;
}

export interface Message {
  id: string;
  chatId: string;
  remoteId: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
  text: string;
  ts: number;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  attachments?: Attachment[];
  senderAvatarUrl?: string;
  reactions?: Reaction[];
  /** Slack iş parçacığı yanıtı: üst mesajın remoteId'si */
  threadId?: string;
  replyCount?: number;
  /** Alıntılı yanıt: yanıtlanan mesaj (balonda alıntı kutusu) */
  replyTo?: { remoteId: string; senderName: string; text: string; fromMe?: boolean };
  /** E-posta: özgün HTML gövdesi var (api.messageHtml ile yüklenir) */
  hasHtml?: boolean;
}

/** Mesaja alıntılı yanıt verilebilen platformlar (sağa kaydır / Yanıtla); Slack'te yanıt iş parçacığına gider */
export const REPLY_PLATFORMS = new Set<Platform>(['whatsapp', 'telegram', 'instagram', 'slack', 'demo']);

export type CoreEvent =
  | { type: 'account.status'; account: Account }
  | { type: 'account.qr'; accountId: string; qrDataUrl: string }
  | { type: 'account.prompt'; accountId: string; prompt: 'phone' | 'code' | 'password'; message: string }
  | { type: 'chat.upsert'; chat: Chat }
  | { type: 'chat.delete'; chatId: string }
  | { type: 'message.upsert'; message: Message; chat: Chat; live?: boolean }
  | { type: 'message.delete'; chatId: string; messageId: string }
  | { type: 'chat.typing'; chatId: string; typing: boolean; name?: string }
  | { type: 'account.sync'; accountId: string; progress: number; label?: string }
  | { type: 'messages.read'; chatId: string; before: number }
  | { type: 'chat.followup'; chat: Chat }
  | { type: 'scheduled.update' }
  | { type: 'events.update' }
  | { type: 'event.reminder'; event: CalEvent }
  | { type: 'scheduled.missed'; item: { id: string; chatId: string; text: string; at: number; missed?: { reason: string; at: number } }; chatName: string }
  | { type: 'login.frame'; accountId: string; data: string; width: number; height: number; host: string }
  | { type: 'login.start'; accountId: string }
  | { type: 'login.end'; accountId: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** Mivelo içi giriş ekranına girdi (çekirdek LoginInput ile aynı) */
export type LoginInput =
  | { type: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

/** Çekirdeğin çalıştığı işletim sistemi (Node process.platform); /api/health `os` alanı */
export type CoreOs = 'darwin' | 'win32' | 'linux' | (string & {});
/** Yalnız macOS'ta çalışan kanallar (Windows/Linux çekirdeğinde pasif gösterilir) */
export const MAC_ONLY = new Set<Platform>(['imessage']);

export interface DraftResult {
  draft: string;
  summary: string[];
  actions: string[];
  /** Mesajlardan çıkan tarihli olaylar (start: "YYYY-MM-DDTHH:mm" ya da "YYYY-MM-DD") → Takvime ekle */
  events?: CalendarDraft[];
  /** "Tarzın": kullanıcının kendi mesajlarından çıkarılan üslup maddeleri */
  style?: string[];
}

export interface CalendarDraft {
  title: string;
  start: string;
  durationMin?: number;
  notes?: string;
  /** mesajdan açıldıysa: Takvim'den sohbete dönmek için */
  chatId?: string;
  messageId?: string;
}

/** Mivelo takvimindeki etkinlik (çekirdek events tablosu) */
export interface CalEvent {
  id: string;
  title: string;
  /** yerel saat "YYYY-MM-DDTHH:mm" ya da tüm gün "YYYY-MM-DD" */
  start: string;
  durationMin?: number;
  allDay?: boolean;
  notes?: string;
  location?: string;
  chatId?: string;
  messageId?: string;
  remindMin?: number;
  deviceCalendar?: string;
  createdAt: number;
}

export const PLATFORMS: Record<Platform, { name: string; code: string; color: string; method: string; available: boolean; mode: 'native' | 'browser' | 'token' | 'mail' | 'demo'; experimental?: boolean; category?: Category }> = {
  whatsapp: { name: 'WhatsApp', code: 'WA', color: '#0E8A45', method: 'QR ile bağlı cihaz', available: true, mode: 'native' },
  telegram: { name: 'Telegram', code: 'TG', color: '#1B7FB8', method: 'QR ile giriş', available: true, mode: 'token' },
  slack: { name: 'Slack', code: 'SL', color: '#4A154B', method: 'Slack hesabınla', available: true, mode: 'browser' },
  imessage: { name: 'iMessage', code: 'IM', color: '#1C8C3A', method: 'Bu Mac’teki Mesajlar', available: true, mode: 'native' },
  linkedin: { name: 'LinkedIn', code: 'LI', color: '#0A66C2', method: 'Hesabınla giriş', available: true, mode: 'browser' },
  x: { name: 'X', code: 'X', color: '#2B2833', method: 'Hesabınla giriş', available: true, mode: 'browser' },
  instagram: { name: 'Instagram', code: 'IG', color: '#C13584', method: 'Hesabınla giriş', available: true, mode: 'browser' },
  messenger: { name: 'Messenger', code: 'MS', color: '#0866FF', method: 'Hesabınla giriş', available: true, mode: 'browser' },
  gmail: { name: 'Gmail', code: 'GM', color: '#EA4335', method: 'Google hesabınla giriş', available: true, mode: 'browser', category: 'mail' },
  outlook: { name: 'Outlook', code: 'OL', color: '#0F6CBD', method: 'Microsoft hesabınla giriş', available: true, mode: 'browser', category: 'mail' },
  yahoo: { name: 'Yahoo Mail', code: 'YH', color: '#6001D2', method: 'Yahoo hesabınla giriş', available: true, mode: 'browser', category: 'mail' },
  yandex: { name: 'Yandex Mail', code: 'YA', color: '#FC3F1D', method: 'Yandex hesabınla giriş', available: true, mode: 'browser', category: 'mail' },
  icloud: { name: 'iCloud Mail', code: 'IC', color: '#3693F3', method: 'Apple hesabınla giriş', available: true, mode: 'browser', category: 'mail' },
  imap: { name: 'Diğer e-posta', code: '@', color: '#4A4757', method: 'E-posta ve şifreyle', available: true, mode: 'mail', category: 'mail' },
  pttavm: { name: 'ePttAVM', code: 'PT', color: '#FFC20E', method: 'Siparişler', available: true, mode: 'token', category: 'shop' },
  shopier: { name: 'Shopier', code: 'SH', color: '#1F2A44', method: 'Siparişler', available: false, mode: 'token', category: 'shop' },
  trendyol: { name: 'Trendyol', code: 'TY', color: '#F27A1A', method: 'Siparişler ve müşteri soruları', available: true, mode: 'token', category: 'shop' },
  hepsiburada: { name: 'Hepsiburada', code: 'HB', color: '#FF6000', method: 'Siparişler ve müşteri soruları', available: true, mode: 'token', category: 'shop' },
  etsy: { name: 'Etsy', code: 'ET', color: '#F1641E', method: 'Siparişler', available: true, mode: 'token', category: 'shop', experimental: true },
  shopify: { name: 'Shopify', code: 'SP', color: '#5E8E3E', method: 'Siparişler', available: true, mode: 'token', category: 'shop', experimental: true },
  n11: { name: 'n11', code: 'N11', color: '#5D3EBC', method: 'Siparişler ve müşteri soruları', available: true, mode: 'token', category: 'shop' },
  amazon: { name: 'Amazon', code: 'AMZ', color: '#FF9900', method: 'Siparişler', available: true, mode: 'token', category: 'shop', experimental: true },
  demo: { name: 'Demo', code: 'DM', color: '#8C889B', method: 'Örnek veri', available: true, mode: 'demo' },
};

export const TAG_COLORS: Record<string, [string, string]> = {
  // renkler styles.css'te (gece modunda koyu karşılıkları)
  müşteri: ['var(--tg-green-bg)', 'var(--tg-green)'],
  fırsat: ['var(--tg-orange-bg)', 'var(--tg-orange)'],
  ekip: ['var(--tg-violet-bg)', 'var(--tg-violet)'],
  kişisel: ['var(--tg-pink-bg)', 'var(--tg-pink)'],
};

export const DEFAULT_TAGS = ['müşteri', 'ekip', 'fırsat', 'kişisel'];

/** Emoji tepkisi verilebilen platformlar */
export const REACT_PLATFORMS = new Set<Platform>(['whatsapp', 'telegram', 'slack', 'instagram', 'linkedin', 'demo']);
/** Hızlı tepki çubuğu */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '😮'];

/**
 * Sohbeti kendi uygulamasında/web'inde açacak bağlantı. Platform sağladıysa chat.link; yoksa kimlikten türetilir.
 * Grup tanıtıcıları (WhatsApp @g.us vb.) için yalnızca uygulama şeması.
 */
const OPEN_LABEL: Partial<Record<Platform, string>> = { whatsapp: "WhatsApp'ta aç", telegram: "Telegram'da aç", slack: "Slack'te aç", instagram: "Instagram'da aç", messenger: "Messenger'da aç", x: "X'te aç", linkedin: "LinkedIn'de aç", imessage: "Mesajlar'da aç", gmail: "Gmail'de aç", outlook: "Outlook'ta aç", icloud: "iCloud'da aç", demo: 'Uygulamada aç' };
export function openInAppLink(c: Chat): { href: string; label: string } | null {
  const label = OPEN_LABEL[c.platform] ?? `${PLATFORMS[c.platform]?.name ?? c.platform} · aç`;
  const id = c.remoteId;
  switch (c.platform) {
    case 'whatsapp': {
      if (id.endsWith('@g.us')) return { href: 'whatsapp://', label };
      const num = id.split('@')[0].replace(/\D/g, '');
      return num ? { href: `https://wa.me/${num}`, label } : null;
    }
    case 'telegram':
      return { href: c.link || (c.handle?.startsWith('@') ? `https://t.me/${c.handle.slice(1)}` : `tg://user?id=${id.replace(/^-100/, '')}`), label };
    case 'slack': {
      const team = (c.meta?.team as string | undefined) ?? '';
      return { href: team ? `slack://channel?team=${team}&id=${id}` : `https://app.slack.com/client/${id}`, label };
    }
    case 'instagram':
      return { href: c.link || `https://www.instagram.com/direct/t/${id}/`, label };
    case 'messenger':
      return { href: c.link || `https://www.facebook.com/messages/t/${id}/`, label };
    case 'x':
      return { href: c.link || `https://x.com/messages/${id}`, label };
    case 'linkedin':
      return { href: c.link || `https://www.linkedin.com/messaging/thread/${encodeURIComponent(id)}/`, label };
    case 'imessage':
      return { href: `imessage://${encodeURIComponent(c.handle ?? id)}`, label };
    case 'gmail':
      return { href: `https://mail.google.com/mail/u/0/#all/${id}`, label };
    case 'outlook':
      return { href: 'https://outlook.live.com/mail/0/', label };
    case 'icloud':
      return { href: 'https://www.icloud.com/mail/', label };
    case 'yahoo':
      return { href: 'https://mail.yahoo.com/', label };
    case 'yandex':
      return { href: 'https://mail.yandex.com/', label };
    default:
      return c.link ? { href: c.link, label } : null;
  }
}

/** Pazaryeri sohbeti türü: sipariş (meta.order) ya da müşteri sorusu/mesajı (diğerleri). Pazaryeri değilse null. */
export type ShopKind = 'order' | 'question';
export function shopKind(c: Pick<Chat, 'platform' | 'meta'>): ShopKind | null {
  if (PLATFORMS[c.platform]?.category !== 'shop') return null;
  return c.meta?.order ? 'order' : 'question';
}
/** Pazaryeri sorusunun bağlı olduğu sipariş (sipariş sorusu); yoksa ürün sorusu.
 *  Kaynaklar: meta.question.orderNumber (Trendyol/Hepsiburada), Amazon alıcı mesajında sipariş no (handle 123-1234567-1234567). */
export function questionOrderRef(c: Pick<Chat, 'platform' | 'meta' | 'handle'>): string | undefined {
  const q = c.meta?.question as { orderNumber?: string | number } | undefined;
  if (q?.orderNumber) return String(q.orderNumber);
  if (c.platform === 'amazon' && c.handle && /^\d{3}-\d{7}-\d{7}$/.test(c.handle)) return c.handle;
  return undefined;
}
/** Pazaryeri liste sekmesi: siparişler · ürün soruları · sipariş soruları */
export type ShopTab = 'order' | 'productQ' | 'orderQ';
export function shopTabOf(c: Pick<Chat, 'platform' | 'meta' | 'handle'>): ShopTab | null {
  const kind = shopKind(c);
  if (!kind) return null;
  if (kind === 'order') return 'order';
  return questionOrderRef(c) ? 'orderQ' : 'productQ';
}
/** Sipariş soruları sekmesi olan pazaryerleri (sipariş sorusu yoksa da sekme görünür) */
// Trendyol'da sipariş sorusu API'si YOK (qna yanıtında sipariş bağı yok; order-questions ucu 556 = yönlendirilmemiş yol): sekme yalnız içerik varsa
export const ORDER_Q_PLATFORMS = new Set<Platform>(['hepsiburada', 'amazon']);
/** Kapanmış sipariş durumları (gönderildi/teslim/iptal/iade): bunlar "bekleyen" sayılmaz */
export const ORDER_CLOSED = /^(fulfilled|delivered|shipped|cancelled|canceled|returned|completed|closed)$/i;
/** Satıcıdan bir şey bekleyen pazaryeri sohbeti: açık sipariş ya da yanıt bekleyen soru */
export function shopPending(c: Pick<Chat, 'platform' | 'meta' | 'unread'>): boolean {
  const kind = shopKind(c);
  if (kind === 'order') return !ORDER_CLOSED.test(String((c.meta?.order as { status?: string } | undefined)?.status ?? ''));
  if (kind === 'question') {
    const q = c.meta?.question as { status?: string; statusLabel?: string } | undefined;
    return q ? /wait|bekl/i.test(`${q.status ?? ''} ${q.statusLabel ?? ''}`) : c.unread > 0;
  }
  return false;
}

/** Sipariş üzerinden alıcıya mesaj ucu OLMAYAN pazaryerleri: sipariş sohbet değil, sipariş sayfası olarak gösterilir.
 *  (Amazon/Etsy/Shopify'da alıcı mesajlaşması var; orada sohbet kalır.) */
export const ORDER_ONLY_PLATFORMS = new Set<Platform>(['trendyol', 'hepsiburada', 'n11', 'shopier', 'pttavm']);
export function isOrderPage(c: Pick<Chat, 'platform' | 'meta'>): boolean {
  return shopKind(c) === 'order' && ORDER_ONLY_PLATFORMS.has(c.platform);
}
