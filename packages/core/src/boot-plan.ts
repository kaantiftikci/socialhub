import os from 'node:os';
import type { Account, Platform } from './model.js';

/**
 * Açılış eşitleme planı (29.09, Kaan: "uzun aradan sonra açınca hepsi aynı anda eşitleniyor, çok kasıyor; kullanıcının değerlerine göre
 * hızlı hesap yapılsın, en hızlı sıra otomatik belirlensin").
 *
 * - Hafif kanallar (API/soket: WhatsApp, Telegram, iMessage, IMAP e-posta, pazaryerleri) hemen ve birlikte başlar — Chromium açmazlar.
 * - Tarayıcı kanalları (Instagram, X, LinkedIn, Messenger, TikTok, Slack/Gmail/Outlook… tarayıcı yolu) sıraya girer. Aynı anda kaç
 *   tanesinin kalkacağı makineden hesaplanır (`browserSlots`: çekirdek sayısı / 3 ve boş bellek / 700 MB'ın küçüğü, 1–4).
 * - Sıra: önem / beklenen süre (en kısa-önemli iş önce → ortalama bekleme en az). Önem = okunmamış sayısı + son etkinliğin yakınlığı;
 *   süre = hesabın önceki açılışında ölçülen süre (`boot_ms:<hesap>`), yoksa platform varsayılanı.
 */
export const BROWSER_DEFAULT_MS: Partial<Record<Platform, number>> = {
  instagram: 18_000,
  messenger: 25_000,
  linkedin: 22_000,
  x: 25_000,
  tiktok: 25_000,
  slack: 15_000,
  gmail: 20_000,
  outlook: 25_000,
  icloud: 20_000,
  yahoo: 20_000,
  yandex: 20_000,
};

export interface BootInfo {
  account: Account;
  browser: boolean;
  unread: number;
  lastAt: number;
  estMs?: number;
}

export function bootScore(b: BootInfo, now = Date.now()): number {
  const ageH = b.lastAt ? Math.max(0, now - b.lastAt) / 3_600_000 : 24 * 30;
  const recency = 1 / (1 + ageH / 24); // bugün etkin ≈1, bir hafta önce ≈0,12
  const urgency = 1 + Math.min(b.unread, 50) / 10; // okunmamış: en çok ×6
  const est = Math.max(3_000, b.estMs ?? BROWSER_DEFAULT_MS[b.account.platform] ?? 20_000);
  return (urgency * (0.3 + recency)) / (est / 1000);
}

/** Başlatma sırası: hafifler önce (hepsi hemen), tarayıcılar puana göre */
export function bootOrder(list: BootInfo[], now = Date.now()): BootInfo[] {
  const light = list.filter((b) => !b.browser);
  const heavy = list.filter((b) => b.browser).sort((a, b) => bootScore(b, now) - bootScore(a, now));
  return [...light, ...heavy];
}

/**
 * Chromium'a ayrılabilecek bellek. macOS'ta os.freemem() yalnız libuv free_count (inactive/purgeable/sıkıştırılmış sayfalar yok):
 * normal kullanımda 100-800 MB → her zaman 1 yuva çıkıyor, tarayıcı kanalları tek tek açılıyordu. Orada toplam belleğin %35'i.
 * Windows (ullAvailPhys) ve Linux (MemAvailable) değeri gerçekçi.
 */
export function memForBrowsers(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? os.totalmem() * 0.35 : os.freemem();
}

/** Aynı anda açılabilecek tarayıcı kanalı sayısı (makineye göre) */
export function browserSlots(cpus = os.cpus().length, freeMem = memForBrowsers()): number {
  const forced = Number(process.env.MIVELO_BOOT_SLOTS);
  if (forced >= 1) return Math.min(8, Math.floor(forced));
  const byCpu = Math.floor(cpus / 3);
  const byMem = Math.floor(freeMem / (700 * 1024 * 1024));
  return Math.max(1, Math.min(4, byCpu, byMem));
}

let slotsCache: number | undefined;
/** Süreç boyunca tek değer (köprü yuvaları ve günlükteki "aynı anda N" aynı sayıyı görsün) */
export function bootSlots(): number {
  return (slotsCache ??= browserSlots());
}
