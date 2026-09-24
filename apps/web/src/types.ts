export type Platform = 'whatsapp' | 'telegram' | 'slack' | 'linkedin' | 'x' | 'imessage' | 'instagram' | 'messenger' | 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'imap' | 'shopier' | 'trendyol' | 'hepsiburada' | 'etsy' | 'shopify' | 'demo';
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
}

export type CoreEvent =
  | { type: 'account.status'; account: Account }
  | { type: 'account.qr'; accountId: string; qrDataUrl: string }
  | { type: 'account.prompt'; accountId: string; prompt: 'phone' | 'code' | 'password'; message: string }
  | { type: 'chat.upsert'; chat: Chat }
  | { type: 'chat.delete'; chatId: string }
  | { type: 'message.upsert'; message: Message; chat: Chat; live?: boolean }
  | { type: 'message.delete'; chatId: string; messageId: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface DraftResult {
  draft: string;
  summary: string[];
  actions: string[];
}

export const PLATFORMS: Record<Platform, { name: string; code: string; color: string; method: string; available: boolean; mode: 'native' | 'browser' | 'token' | 'mail' | 'demo'; experimental?: boolean; category?: Category }> = {
  whatsapp: { name: 'WhatsApp', code: 'WA', color: '#0E8A45', method: 'QR ile bağlı cihaz', available: true, mode: 'native' },
  telegram: { name: 'Telegram', code: 'TG', color: '#1B7FB8', method: 'Resmi API · QR ile giriş', available: true, mode: 'token' },
  slack: { name: 'Slack', code: 'SL', color: '#4A154B', method: 'Tarayıcı oturumu', available: true, mode: 'browser' },
  imessage: { name: 'iMessage', code: 'IM', color: '#1C8C3A', method: 'Bu Mac’teki Mesajlar', available: true, mode: 'native' },
  linkedin: { name: 'LinkedIn', code: 'LI', color: '#0A66C2', method: 'Tarayıcı oturumu', available: true, mode: 'browser' },
  x: { name: 'X', code: 'X', color: '#2B2833', method: 'Tarayıcı oturumu', available: true, mode: 'browser' },
  instagram: { name: 'Instagram', code: 'IG', color: '#C13584', method: 'Tarayıcı oturumu', available: true, mode: 'browser' },
  messenger: { name: 'Messenger', code: 'MS', color: '#0866FF', method: 'Tarayıcı oturumu', available: true, mode: 'browser' },
  gmail: { name: 'Gmail', code: 'GM', color: '#EA4335', method: 'Tarayıcı girişi · Gmail web', available: true, mode: 'browser', category: 'mail' },
  outlook: { name: 'Outlook', code: 'OL', color: '#0F6CBD', method: 'Tarayıcı girişi · Outlook web', available: true, mode: 'browser', category: 'mail' },
  yahoo: { name: 'Yahoo Mail', code: 'YH', color: '#6001D2', method: 'IMAP · uygulama şifresi', available: true, mode: 'mail', category: 'mail' },
  icloud: { name: 'iCloud Mail', code: 'IC', color: '#3693F3', method: 'Tarayıcı girişi · iCloud web', available: true, mode: 'browser', category: 'mail' },
  imap: { name: 'Diğer e-posta', code: '@', color: '#4A4757', method: 'IMAP/SMTP · Yandex, Fastmail, kurumsal…', available: true, mode: 'mail', category: 'mail' },
  shopier: { name: 'Shopier', code: 'SH', color: '#1F2A44', method: 'Resmi API · sipariş takibi (PAT)', available: true, mode: 'token', category: 'shop' },
  trendyol: { name: 'Trendyol', code: 'TY', color: '#F27A1A', method: 'Satıcı API · sipariş + soru-cevap', available: false, mode: 'token', category: 'shop' },
  hepsiburada: { name: 'Hepsiburada', code: 'HB', color: '#FF6000', method: 'Satıcı API · sipariş', available: false, mode: 'token', category: 'shop' },
  etsy: { name: 'Etsy', code: 'ET', color: '#F1641E', method: 'OAuth · sipariş + mesaj', available: false, mode: 'token', category: 'shop' },
  shopify: { name: 'Shopify', code: 'SP', color: '#5E8E3E', method: 'Mağaza token’ı · sipariş', available: false, mode: 'token', category: 'shop' },
  demo: { name: 'Demo', code: 'DM', color: '#8C889B', method: 'Örnek veri', available: true, mode: 'demo' },
};

export const TAG_COLORS: Record<string, [string, string]> = {
  müşteri: ['#E1F6EC', '#0B6B45'],
  fırsat: ['#FFEFDF', '#9C4700'],
  ekip: ['#EFEAFF', '#4526C9'],
  kişisel: ['#FFE8F1', '#A3195B'],
};

export const DEFAULT_TAGS = ['müşteri', 'fırsat', 'ekip', 'kişisel', 'sessiz'];
