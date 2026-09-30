import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { Platform } from './model.js';
import type { Store } from './store.js';
import { dayKey, digestText, summarizeMarket, type MarketOrderInput, type MarketQuestionInput, type MarketSummary } from './market-calc.js';

/**
 * Pazaryeri gün sonu özeti: sipariş/soru sohbetlerinin meta'sından günlük toplamlar (hesap market-calc.ts'te, saf) +
 * kullanıcının seçtiği saatte bir kez bildirim ("Gün sonu özeti: 12 sipariş · 8.450 ₺ · 3 soru bekliyor").
 * Ayar `~/.mivelo/market-digest.json` {enabled, time, lastSent}. Yalnız pazaryeri hesabı varsa çalışır. Veri cihazdan çıkmaz.
 */

export const SHOP_PLATFORMS: readonly Platform[] = ['trendyol', 'hepsiburada', 'n11', 'pttavm', 'amazon', 'etsy', 'shopify', 'shopier'];

export interface DigestSettings {
  enabled: boolean;
  /** "HH:MM" yerel saat */
  time: string;
  /** son bildirilen gün (YYYY-MM-DD) */
  lastSent?: string;
}
export const DIGEST_DEFAULT: DigestSettings = { enabled: true, time: '21:00' };
export const isDigestTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

function settingsFile(dir = DATA_DIR): string {
  return path.join(dir, 'market-digest.json');
}
export function readDigestSettings(dir = DATA_DIR): DigestSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8')) as Partial<DigestSettings>;
    return {
      enabled: raw.enabled !== false,
      time: isDigestTime(raw.time) ? raw.time : DIGEST_DEFAULT.time,
      ...(typeof raw.lastSent === 'string' ? { lastSent: raw.lastSent } : {}),
    };
  } catch {
    return { ...DIGEST_DEFAULT };
  }
}
export function writeDigestSettings(s: DigestSettings, dir = DATA_DIR): DigestSettings {
  const clean: DigestSettings = { enabled: !!s.enabled, time: isDigestTime(s.time) ? s.time : DIGEST_DEFAULT.time, ...(s.lastSent ? { lastSent: s.lastSent } : {}) };
  const file = settingsFile(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

/**
 * Bildirim zamanı geldi mi: açık, bugün henüz gönderilmedi ve yerel saat seçilen saati geçti (aynı gün içinde; çekirdek
 * 23:50'de açıldıysa da o günün özeti gider, ertesi gün eskisi gönderilmez).
 */
export function digestDue(s: DigestSettings, now = new Date()): boolean {
  if (!s.enabled || !isDigestTime(s.time)) return false;
  const today = dayKey(now.getTime());
  if (s.lastSent === today) return false;
  const [h, m] = s.time.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

/** Depodan sipariş + soru girdileri (yalnız pazaryeri hesapları, hesap dizininden) */
export function collectMarket(store: Store): { orders: MarketOrderInput[]; questions: MarketQuestionInput[]; hasShop: boolean } {
  const accounts = store.listAccounts().filter((a) => SHOP_PLATFORMS.includes(a.platform));
  const orders: MarketOrderInput[] = [];
  const questions: MarketQuestionInput[] = [];
  for (const a of accounts)
    for (const r of store.marketMeta(a.id)) {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(r.meta) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (meta.order && typeof meta.order === 'object') orders.push({ platform: r.platform, chatId: r.id, order: meta.order as Record<string, unknown> });
      else if (meta.question && typeof meta.question === 'object') questions.push({ platform: r.platform, chatId: r.id, question: meta.question as Record<string, unknown>, ts: r.lastMessageAt });
    }
  return { orders, questions, hasShop: accounts.length > 0 };
}

/** Kısa önbellek: arayüz tarih okuyla hızlı gezinir, her tıklamada tüm meta yeniden ayrıştırılmasın */
let cache: { at: number; data: ReturnType<typeof collectMarket> } | undefined;
export function marketSummary(store: Store, day: string, platform?: string | null, now = Date.now()): MarketSummary {
  if (!cache || now - cache.at > 15_000) cache = { at: now, data: collectMarket(store) };
  const { orders, questions, hasShop } = cache.data;
  return summarizeMarket(orders, questions, day, { platform: platform || null, now, hasShop });
}
export function clearMarketCache(): void {
  cache = undefined;
}

/**
 * Dakikalık döngünün tek adımı: zamanı geldiyse özeti hesapla, bildirilecek metni döndür ve günü işaretle.
 * Pazaryeri hesabı yoksa ya da gün tamamen boşsa (sipariş/soru yok) bildirim yok (gün yine işaretlenir).
 */
export function checkDigest(store: Store, now = new Date(), dir = DATA_DIR): { day: string; text: string; summary: MarketSummary } | null {
  const s = readDigestSettings(dir);
  if (!digestDue(s, now)) return null;
  const day = dayKey(now.getTime());
  clearMarketCache();
  const summary = marketSummary(store, day, null, now.getTime());
  // pazaryeri hesabı yoksa dosyaya dokunma (hesap bağlanınca aynı gün yine gönderilebilsin)
  if (!summary.hasShop) return null;
  writeDigestSettings({ ...s, lastSent: day }, dir);
  if (!summary.orders && !summary.questions.waiting && !summary.questions.received && !summary.awaitingShipment) return null;
  return { day, text: digestText(summary), summary };
}
