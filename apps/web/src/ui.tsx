import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { ReactNode } from 'react';
import { PLATFORMS, TAG_COLORS, type Platform } from './types';
import { siWhatsapp, siTelegram, siX, siInstagram, siMessenger, siGmail, siIcloud } from 'simple-icons';
import { faSlack, faLinkedinIn, faMicrosoft, faYahoo } from '@fortawesome/free-brands-svg-icons';

const PATHS: Record<string, ReactNode> = {
  search: (<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>),
  inbox: (<><path d="M3 13h4.5l1.5 2.5h6l1.5-2.5H21" /><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" /></>),
  sparkle: (<><path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>),
  bell: (<><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></>),
  archive: (<><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>),
  plus: <path d="M12 5v14M5 12h14" />,
  pen: (<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></>),
  sliders: (<><path d="M4 7h9M18 7h2M4 17h4M12 17h8" /><circle cx="15.5" cy="7" r="2.3" /><circle cx="9.5" cy="17" r="2.3" /></>),
  clock: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checks: (<><path d="M2.5 12.5l4.5 4.5L15.5 8.5" /><path d="M10.5 16l1 1L21 7.5" /></>),
  send: (<><path d="M4.5 12L20 4.5l-5 15.5-3.2-6.3z" /><path d="M11.8 13.7L20 4.5" /></>),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3.5v5h-5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
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
  link: (<><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>),
  trash: (<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  shield: (<><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></>),
  snooze: (<><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.5M4.5 5.5l2.5-2M19.5 5.5l-2.5-2" /></>),
  calendar: (<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>),
  chev: <path d="M6 9l6 6 6-6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  eyeoff: (<><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.4M6.4 6.5A16 16 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>),
  history: (<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>),
};

export function Icon({ name, size = 16, color = 'currentColor', sw = 1.8 }: { name: string; size?: number; color?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
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
  icloud: { path: siIcloud.path, bg: '#3693F3', ratio: 0.62 },
};
const MIN_BRAND = 18;

export function Chip({ platform, size = 18, ring }: { platform: Platform; size?: number; ring?: string }) {
  const p = PLATFORMS[platform];
  const brand = BRAND[platform];
  const s = Math.max(size, MIN_BRAND);
  const base = { width: s, height: s, borderRadius: s * 0.3, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined };
  if (brand) {
    const inner = Math.round(s * brand.ratio);
    return (
      <span className="plat" title={p.name} style={{ ...base, background: brand.bg }}>
        <svg width={inner} height={inner} viewBox={brand.vb ?? "0 0 24 24"} aria-hidden="true">
          <path d={brand.path} fill="#fff" />
        </svg>
      </span>
    );
  }
  if (platform === 'imessage') {
    return (
      <span className="plat" title={p.name} style={{ ...base, background: '#E8F7EC', color: '#1C8C3A' }}>
        <svg width={Math.round(s * 0.62)} height={Math.round(s * 0.62)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4c-4.4 0-8 2.9-8 6.5 0 2 1.1 3.8 2.8 5L6 19.5l3.9-1.6c.7.1 1.4.2 2.1.2 4.4 0 8-2.9 8-6.5S16.4 4 12 4z" />
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

const PALETTE: Array<[string, string]> = [
  ['#DDEBFB', '#1E4E8C'], ['#FCE9E0', '#9A3412'], ['#E2F2EE', '#0B5E55'], ['#F4E8F4', '#86198F'],
  ['#ECEBFE', '#3730A3'], ['#FCE7EF', '#9D174D'], ['#FFF3D6', '#8A5300'], ['#E6F1FB', '#0C447C'],
];

export function Avatar({ name, size = 40, url }: { name: string; size?: number; url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  // süresi dolan CDN bağlantıları (WhatsApp/Instagram/X) kırık resim yerine baş harfe düşsün
  if (url && !failed) return <img className="avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setFailed(true)} />;
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

export function Tag({ name, onRemove }: { name: string; onRemove?: () => void }) {
  const [bg, fg] = TAG_COLORS[name.toLowerCase()] ?? ['#efeee9', '#3f3e3a'];
  return (
    <span className="tag" style={{ background: bg, color: fg }}>
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
const PANE_DEFAULT: Record<Pane, number> = { side: 232, list: 340, ctx: 288 };
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
