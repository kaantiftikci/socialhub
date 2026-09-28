import { mediaUrl } from './desktop';
import { publicAsset } from './demo-asset';
import { useEffect, useState, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent } from 'react';
import type { ReactNode } from 'react';
import { PLATFORMS, TAG_COLORS, type Platform } from './types';
import { siWhatsapp, siTelegram, siX, siInstagram, siMessenger, siGmail, siIcloud, siShopify } from 'simple-icons';
import { faSlack, faLinkedinIn, faMicrosoft, faYahoo, faYandex } from '@fortawesome/free-brands-svg-icons';

const PATHS: Record<string, ReactNode> = {
  search: (<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>),
  inbox: (<><path d="M3 13h4.5l1.5 2.5h6l1.5-2.5H21" /><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" /></>),
  sparkle: (<><path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>),
  box: (<><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>),
  cart: (<><path d="M3 4h2l2.4 11h10.2L20 7H6.3" /><circle cx="9.5" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /></>),
  receipt: (<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>),
  truck: (<><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.6" /><circle cx="17" cy="17.5" r="1.6" /></>),
  undo: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>),
  ban: (<><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>),
  help: (<><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8v.5" /><path d="M12 17h.01" /></>),
  user: (<><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></>),
  mappin: (<><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>),
  camera: (<><path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z" /><circle cx="12" cy="13.2" r="3.4" /></>),
  music: (<><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>),
  chart: (<><path d="M4 20h16" /><path d="M7 16v-5M12 16V7M17 16v-8" /></>),
  gift: (<><path d="M4 10h16v10H4zM3 7h18v3H3zM12 7v13" /><path d="M12 7C10 3 7 4.5 8.5 7M12 7c2-4 5-2.5 3.5 0" /></>),
  card: (<><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></>),
  moon: (<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />),
  monitor: (<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
  bell: (<><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></>),
  archive: (<><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>),
  plus: <path d="M12 5v14M5 12h14" />,
  pen: (<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
  alert: (<><path d="M12 3.5 2.8 19.5h18.4z" /><path d="M12 10v4.2M12 17.2v.1" /></>),
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></>),
  sliders: (<><path d="M4 7h9M18 7h2M4 17h4M12 17h8" /><circle cx="15.5" cy="7" r="2.3" /><circle cx="9.5" cy="17" r="2.3" /></>),
  clock: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checks: (<><path d="M2.5 12.5l4.5 4.5L15.5 8.5" /><path d="M10.5 16l1 1L21 7.5" /></>),
  send: (<><path d="M4.5 12L20 4.5l-5 15.5-3.2-6.3z" /><path d="M11.8 13.7L20 4.5" /></>),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3.5v5h-5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  logout: (<><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16l-4-4 4-4M6 12h10" /></>),
  clip: <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" />,
  file: (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>),
  image: (<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-9 8.5" /></>),
  bag: (<><path d="M6 8h12l1 12H5z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>),
  mail: (<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></>),
  panel: (<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M15 4.5v15" /></>),
  volume: (<><path d="M4 10v4h3.5L12 18V6L7.5 10z" /><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" /><path d="M18 7a7 7 0 0 1 0 10" /></>),
  copy: (<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>),
  play: (<path d="M7 4.5v15l13-7.5z" />),
  external: (<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 13v6H5V6h6" /></>),
  mic: (<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>),
  dots: (<><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>),
  smile: (<><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></>),
  pin: (<><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 14v7" /></>),
  reply: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h9a7 7 0 0 1 7 7v4" /></>),
  thread: (<><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>),
  mute: (<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></>),
  unarchive: (<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8" /><path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5" /></>),
  link: (<><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>),
  trash: (<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  shield: (<><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></>),
  snooze: (<><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.5M4.5 5.5l2.5-2M19.5 5.5l-2.5-2" /></>),
  calendar: (<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>),
  chev: <path d="M6 9l6 6 6-6" />,
  chevup: <path d="M6 15l6-6 6 6" />,
  grip: <path d="M4 7h16M4 12h16M4 17h16" />,
  back: <path d="M15 6l-6 6 6 6" />,
  eye: (<><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" /><circle cx="12" cy="12" r="3" /></>),
  eyeoff: (<><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.4M6.4 6.5A16 16 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>),
  history: (<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>),
  users: (<><path d="M16 20v-1.2A3.8 3.8 0 0 0 12.2 15H7.8A3.8 3.8 0 0 0 4 18.8V20" /><circle cx="10" cy="8" r="3" /><path d="M20 20v-1.1a3.2 3.2 0 0 0-2.4-3.1" /><path d="M16.2 5.1a3 3 0 0 1 0 5.8" /></>),
};

/**
 * Kapanış animasyonu için: değer null olunca öğe hemen kalkmaz, `closing` ile ms kadar daha çizilir (son değer korunur).
 */
export function useClosing<T>(value: T | null | undefined | false, ms = 160): { value: T | null; closing: boolean } {
  const [cached, setCached] = useState<T | null>(value || null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (value) {
      setCached(value);
      setClosing(false);
      return;
    }
    if (!cached) return;
    setClosing(true);
    const t = setTimeout(() => {
      setCached(null);
      setClosing(false);
    }, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return { value: value || cached, closing: !value && closing };
}

/**
 * Bağlayıcıların yazdığı durum/önizleme metinleri baştaki bir emojiyle başlar ("📦 Kargoya verildi", "📷 Fotoğraf"): arayüzde emoji
 * yerine ikon çizilir. Yalnız bu tanıdık sistem emojileri; kullanıcı içeriği / tepkiler ("😂 … beğendi") olduğu gibi kalır.
 */
const LEAD_ICONS: Record<string, string> = {
  '📦': 'box', '🛍': 'bag', '🛒': 'cart', '✅': 'check', '✔': 'check', '☑': 'check', '📝': 'pen', '❌': 'x', '🚫': 'ban', '⚠': 'alert',
  '↩': 'undo', '↪': 'arrow', '🔁': 'refresh', '📍': 'mappin', '👤': 'user', '🧾': 'receipt', '📊': 'chart', '🔒': 'lock', '📷': 'camera',
  '🖼': 'image', '🎤': 'mic', '🎙': 'mic', '🎵': 'music', '🎬': 'play', '📹': 'play', '📎': 'clip', '🗑': 'trash', '💬': 'thread', '🎁': 'gift',
  '💳': 'card', '✉': 'mail', '📧': 'mail', '📅': 'calendar', '📆': 'calendar', '🔗': 'link', '❓': 'help', '🚚': 'truck', '⏰': 'clock', '⏳': 'clock', '⌛': 'clock', '⏱': 'clock', '🔔': 'bell',
};
// isteğe bağlı "Sen: " / "Mert: " öneki + baştaki emoji (+ varyasyon seçicisi) + boşluk
// U+2300–23FF: ⏳ ⌛ ⏰ ⏱ (eskiden aralık dışındaydı → emoji olarak kalıyordu)
const LEAD_RE = /^((?:[^:\n]{1,40}: )?)([\u2190-\u21FF\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF]|[\u{1F000}-\u{1FAFF}])\uFE0F?\s+/u;
export function leadIcon(text: string): { prefix: string; icon?: string; rest: string } {
  const m = LEAD_RE.exec(text ?? '');
  const icon = m ? LEAD_ICONS[m[2]] : undefined;
  return icon ? { prefix: m![1], icon, rest: text.slice(m![0].length) } : { prefix: '', rest: text };
}
/** Düz metin (sistem bildirimi vb.): tanıdık baş emojiyi at */
export const stripLeadIcon = (text: string) => {
  const r = leadIcon(text);
  return r.prefix + r.rest;
};
/** Metin + baştaki sistem emojisinin ikon karşılığı (satır içi, metinle hizalı) */
export function IconText({ text, size = 13 }: { text: string; size?: number }) {
  const { prefix, icon, rest } = leadIcon(text);
  if (!icon) return <>{text}</>;
  return (
    <>
      {prefix}
      <span className="lead-ic" aria-hidden="true">
        <Icon name={icon} size={size} />
      </span>
      {rest}
    </>
  );
}

export function Icon({ name, size = 16, color = 'currentColor', sw = 1.8 }: { name: string; size?: number; color?: string; sw?: number }) {
  return (
    // renk style üzerinden (currentColor): tema değişkenleri (var(--v)) SVG özniteliğinde her motorda çözülmüyor
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: color === 'currentColor' ? undefined : color }}>
      {PATHS[name]}
    </svg>
  );
}

/**
 * Marka simgeleri — her platformun kendi kullanım kurallarına göre:
 * - WhatsApp: yeşil zemin üzerinde beyaz, değiştirilmemiş glif; "WhatsApp" yazımı korunur.
 * - Telegram: mavi zemin üzerinde beyaz.
 * - Instagram: renkli zeminde yalnızca beyaz glif; zemin resmi gradyan (düz renk yasak).
 * - Messenger: resmi gradyan üzerinde beyaz.
 * - X: yalnızca siyah/beyaz; her yanda glif genişliği kadar boşluk (glif küçük tutulur).
 * - Slack / LinkedIn: logolar üçüncü taraf paketlerde dağıtılamaz; resmi SVG'yi /brands/ altına koyarsan
 *   beyaz zeminde, LinkedIn için en az 21px olarak gösterilir. Yoksa harf rozeti.
 * - iMessage: Apple, uygulama simgelerinin üçüncü taraflarca kullanımına izin vermez; kendi nötr balon simgemiz.
 * Hiçbir logo 18px altında çizilmez (küçük yerlerde rozet otomatik büyür).
 */
type Brand = { path: string; bg: string; ratio: number; min?: number; vb?: string };
// Slack ve LinkedIn simple-icons'ta yok; Font Awesome Free (CC BY 4.0) marka setinden.
const fa = (i: { icon: [number, number, unknown, unknown, string | string[]] }) => ({ path: Array.isArray(i.icon[4]) ? i.icon[4].join(' ') : i.icon[4], vb: `0 0 ${i.icon[0]} ${i.icon[1]}` });

const BRAND: Partial<Record<Platform, Brand>> = {
  whatsapp: { path: siWhatsapp.path, bg: '#25D366', ratio: 0.62 },
  telegram: { path: siTelegram.path, bg: '#26A5E4', ratio: 0.62 },
  instagram: { path: siInstagram.path, bg: 'linear-gradient(45deg, #FFD600 0%, #FF7A00 25%, #FF0069 50%, #D300C5 75%, #7638FA 100%)', ratio: 0.6 },
  messenger: { path: siMessenger.path, bg: 'linear-gradient(45deg, #0099FF 0%, #A033FF 40%, #FF5280 75%, #FF7061 100%)', ratio: 0.62 },
  x: { path: siX.path, bg: '#000000', ratio: 0.45 },
  // Slack: tek renkli logo, resmi aubergine zemin üzerinde beyaz (marka kılavuzunun izin verdiği kullanım)
  slack: { ...fa(faSlack), bg: '#4A154B', ratio: 0.6 },
  // LinkedIn: "in" logosu, resmi mavi (#0A66C2) zemin üzerinde beyaz
  linkedin: { ...fa(faLinkedinIn), bg: '#0A66C2', ratio: 0.58 },
  // E-posta sağlayıcıları
  gmail: { path: siGmail.path, bg: '#EA4335', ratio: 0.6 },
  outlook: { ...fa(faMicrosoft), bg: '#0F6CBD', ratio: 0.52 },
  yahoo: { ...fa(faYahoo), bg: '#6001D2', ratio: 0.58 },
  yandex: { ...fa(faYandex), bg: '#FC3F1D', ratio: 0.5 },
  icloud: { path: siIcloud.path, bg: '#3693F3', ratio: 0.62 },
  // Shopify: PNG'nin beyaz zemini yerine marka yeşilinde beyaz çanta (diğer alışveriş simgeleri gibi dolu kare)
  shopify: { path: siShopify.path, bg: '#7AB55C', ratio: 0.62 },
};
const MIN_BRAND = 18;

/** Alışveriş kanalları: harf rozeti yerine markanın kendi ikonu. */
const SHOP_ICON: Partial<Record<Platform, { src: string; fit: 'cover' | 'contain' }>> = {
  shopier: { src: '/brands/shopier.png', fit: 'cover' },
  trendyol: { src: '/brands/trendyol.png', fit: 'cover' },
  hepsiburada: { src: '/brands/hepsiburada.png', fit: 'cover' },
  n11: { src: '/brands/n11.png', fit: 'cover' },
  etsy: { src: '/brands/etsy.png', fit: 'cover' },
  amazon: { src: '/brands/amazon.png', fit: 'cover' },
};

export function Chip({ platform, size = 18, ring }: { platform: Platform; size?: number; ring?: string }) {
  const p = PLATFORMS[platform];
  const brand = BRAND[platform];
  const shopIcon = SHOP_ICON[platform];
  const [shopFailed, setShopFailed] = useState(false);
  useEffect(() => setShopFailed(false), [platform]);
  const s = Math.max(size, MIN_BRAND);
  const base = { width: s, height: s, borderRadius: s * 0.3, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined, overflow: 'hidden' as const };
  if (shopIcon && !shopFailed) {
    return (
      <span className="plat" title={p.name} style={{ ...base, background: 'transparent' }}>
        <img src={publicAsset(shopIcon.src.replace(/^\//, ''))} alt="" width={s} height={s} draggable={false} style={{ width: s, height: s, objectFit: shopIcon.fit, display: 'block' }} onError={() => setShopFailed(true)} />
      </span>
    );
  }
  if (brand) {
    const inner = Math.round(s * brand.ratio);
    return (
      <span className={`plat plat-${platform}`} title={p.name} style={{ ...base, background: brand.bg }}>
        <svg width={inner} height={inner} viewBox={brand.vb ?? "0 0 24 24"} aria-hidden="true">
          <path d={brand.path} fill="#fff" />
        </svg>
      </span>
    );
  }
  if (platform === 'imessage') {
    return (
      // Apple Mesajlar simgesi gibi: yeşil degrade zemin + dolu beyaz balon (kuyruk sol altta)
      <span className="plat" title={p.name} style={{ ...base, background: 'linear-gradient(180deg, #65f97c 0%, #0cc723 100%)' }}>
        <svg width={Math.round(s * 0.72)} height={Math.round(s * 0.72)} viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#fff" d="M12 3.2c-5.3 0-9.6 3.55-9.6 7.95 0 2.55 1.45 4.8 3.7 6.25-.2 1.25-.85 2.4-1.9 3.3 2 .05 3.8-.6 5.15-1.8.85.15 1.75.25 2.65.25 5.3 0 9.6-3.55 9.6-7.95S17.3 3.2 12 3.2z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="plat" title={p.name} style={{ ...base, background: p.color, fontSize: s * (p.code.length > 1 ? 0.4 : 0.52) }}>
      {p.code}
    </span>
  );
}

/** Baş harf avatarları: renkler styles.css'te (--avN-bg/--avN-fg), gece modunda koyu zemin + açık harf */
const PALETTE: Array<[string, string]> = Array.from({ length: 8 }, (_, i) => [`var(--av${i}-bg)`, `var(--av${i}-fg)`]);

export function Avatar({ name, size = 40, url }: { name: string; size?: number; url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  // süresi dolan CDN bağlantıları (WhatsApp/Instagram/X) kırık resim yerine baş harfe düşsün
  if (url && !failed) return <img className="avatar" src={mediaUrl(url)} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setFailed(true)} />;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = PALETTE[h % PALETTE.length];
  const initials = name.replace(/^#/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.38) }}>
      {initials}
    </span>
  );
}

export function Tag({ name, onRemove, mini = false }: { name: string; onRemove?: () => void; mini?: boolean }) {
  const [bg, fg] = TAG_COLORS[name.toLowerCase()] ?? ['var(--tag-bg)', 'var(--tag-txt)'];
  return (
    <span className={`tag ${mini ? 'mini' : ''}`} style={{ background: bg, color: fg }}>
      {name}
      {onRemove && (
        <span className="x" onClick={onRemove} role="button" aria-label={`${name} etiketini kaldır`}>
          ×
        </span>
      )}
    </span>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="9" fill="#6C47FF" />
      <path d="M8 8c4.5 0 6 3 6 6s1.5 6 6 6M8 20c4.5 0 6-3 6-6" stroke="#FFFFFF" strokeWidth="2.3" fill="none" strokeLinecap="round" />
      <circle cx="20" cy="8" r="2.5" fill="#D4FF3F" />
    </svg>
  );
}

export function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

/** Mesaj balonu damgası: bugün → 14:32, dün → Dün 14:32, eski → 24 Eyl 14:32 */
export function fmtStamp(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Dün ${time}`;
  const day = d.toLocaleDateString('tr-TR', d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return `${day} ${time}`;
}

export function fmtDay(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Bugün';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Dün';
  return d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function ago(ts: number): string {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m} dk`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} sa`;
  return `${Math.round(h / 24)} gün`;
}

/** "3 saattir", "40 dakikadır", "2 gündür" */
export function agoLong(ts: number): string {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m} dakikadır`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} saattir`;
  return `${Math.round(h / 24)} gündür`;
}

// ---------- yeniden boyutlanabilir paneller ----------
type Pane = 'side' | 'list' | 'ctx';
const PANE_DEFAULT: Record<Pane, number> = { side: 268, list: 340, ctx: 320 };
const PANE_LIMIT: Record<Pane, [number, number]> = { side: [168, 380], list: [250, 600], ctx: [220, 520] };
const PANE_KEY = 'kavsak.panes';

/** Kaydedilmiş panel genişliklerini CSS değişkenlerine uygula (açılışta bir kez). */
export function loadPaneSizes(): void {
  try {
    const s = JSON.parse(localStorage.getItem(PANE_KEY) ?? '{}') as Partial<Record<Pane, number>>;
    for (const k of Object.keys(PANE_DEFAULT) as Pane[]) if (s[k]) document.documentElement.style.setProperty(`--w-${k}`, `${s[k]}px`);
  } catch {
    /* yok */
  }
}

/** Paneller arasındaki dikey tutamaç: sürükleyince yanındaki paneli genişletir/daraltır, çift tık varsayılana döner. */
export function Resizer({ pane, sign = 1 }: { pane: Pane; sign?: 1 | -1 }) {
  const setW = (w: number) => document.documentElement.style.setProperty(`--w-${pane}`, `${Math.round(w)}px`);
  const current = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--w-${pane}`)) || PANE_DEFAULT[pane];
  const save = () => {
    try {
      const s = JSON.parse(localStorage.getItem(PANE_KEY) ?? '{}') as Record<string, number>;
      s[pane] = current();
      localStorage.setItem(PANE_KEY, JSON.stringify(s));
    } catch {
      /* yok */
    }
  };
  const onDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = current();
    el.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: globalThis.MouseEvent) => setW(Math.min(PANE_LIMIT[pane][1], Math.max(PANE_LIMIT[pane][0], startW + sign * (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      el.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className="resizer" role="separator" aria-orientation="vertical" title="Sürükleyerek boyutlandır · çift tık: varsayılan" onMouseDown={onDown} onDoubleClick={() => (setW(PANE_DEFAULT[pane]), save())} />;
}

/**
 * Bağlanma/eşitleme çubuğu: lime, düz dolan; yüzde etiketi çubuğun ucuyla birlikte ilerler.
 * Gerçek ilerleme (progress) kilometre taşlarıyla gelir; taşlar arasında zamanla yavaşça (en çok +22) "sürünür".
 */
export function SyncBar({ progress, since, compact = false }: { progress: number; since: number; compact?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 400);
    return () => clearInterval(t);
  }, []);
  const elapsed = (Date.now() - since) / 1000;
  const creep = Math.min(22, 22 * (1 - Math.exp(-elapsed / 12)));
  const shown = Math.max(2, Math.min(progress >= 100 ? 100 : Math.min(98, progress + creep), 100));
  const pct = Math.round(shown);
  return (
    <span className={`syncbar ${compact ? 'compact' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="fill" style={{ width: `${shown}%` }} />
      <span className="pct" style={{ left: `clamp(0px, calc(${shown}% - 17px), calc(100% - 34px))` }}>
        {pct}%
      </span>
    </span>
  );
}

/** Parola alanı: sağdaki göze basılı tutunca parola görünür, bırakınca yeniden gizlenir (klavyede Boşluk/Enter basılıyken). */
export function PasswordInput({ style, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  const hide = () => setShow(false);
  return (
    <span className={`pw-field ${className ?? ''}`} style={style}>
      <input {...rest} type={show ? 'text' : 'password'} />
      <button
        type="button"
        className={`pw-eye ${show ? 'on' : ''}`}
        tabIndex={-1}
        aria-label="Parolayı göstermek için basılı tut"
        title="Görmek için basılı tut"
        onPointerDown={(e) => {
          e.preventDefault(); // odak alanda kalsın
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          setShow(true);
        }}
        onPointerUp={hide}
        onPointerCancel={hide}
        onLostPointerCapture={hide}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), setShow(true))}
        onKeyUp={hide}
        onBlur={hide}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name={show ? 'eyeoff' : 'eye'} size={15} sw={1.9} />
      </button>
    </span>
  );
}
