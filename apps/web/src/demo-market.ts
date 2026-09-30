import type { Account, Chat } from './types';
import { PLATFORMS } from './types';
import { addDays, dayKey, summarizeMarket, type MarketOrderInput, type MarketQuestionInput, type MarketSummary } from './market-calc';

/**
 * Statik demo: pazaryeri gün sonu özeti çekirdeksiz hesaplanır (market-calc.ts, çekirdekteki hesabın birebir kopyası).
 * Kaynak: demo sohbetlerindeki sipariş/soru kartları + bağlı her pazaryeri için belirlenimci "satış geçmişi" (son 21 gün;
 * sohbet listesine eklenmez, yalnız özete girer). Kayıtla gelen boş panelli üye (fresh) örnek veri GÖRMEZ.
 */

const PRODUCTS: Array<[string, number]> = [
  ['Keten gömlek · ekru', 1249.9],
  ['Seramik kupa · 2’li', 349],
  ['Keten elbise · kırmızı', 1890],
  ['Pamuk tişört · siyah', 449.9],
  ['Örgü hırka · bej', 1590],
  ['Bez çanta · naturel', 289.9],
];
const RATE: Record<string, number> = { trendyol: 9, hepsiburada: 4, n11: 3, amazon: 2, etsy: 2, shopify: 3, shopier: 2, pttavm: 2 };

/** Belirlenimci küçük rastgele sayı üreteci (her yenilemede aynı sayılar) */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}
const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

function history(platform: string, now: number): MarketOrderInput[] {
  const out: MarketOrderInput[] = [];
  const today = dayKey(now);
  const cur = platform === 'etsy' || platform === 'amazon' ? 'USD' : 'TRY';
  for (let back = 0; back < 21; back++) {
    const day = addDays(today, -back);
    const r = rng(hash(`${platform}:${day}`));
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00`).getDay());
    const n = Math.round((RATE[platform] ?? 2) * (0.6 + r() * 0.8) * (weekend ? 1.3 : 1));
    for (let i = 0; i < n; i++) {
      const [y, m, d] = day.split('-').map(Number);
      const midnight = new Date(y, m - 1, d).getTime();
      // bugün: gece yarısından şimdiye dek dağıtılır (demo sabah erken açılsa da "Bugün" kartı boş kalmasın)
      const at = back === 0 ? midnight + Math.floor(r() * Math.max(1, now - midnight)) : new Date(y, m - 1, d, 8 + Math.floor(r() * 14), Math.floor(r() * 60)).getTime();
      const [title, price] = PRODUCTS[Math.floor(r() * PRODUCTS.length)];
      const qty = r() < 0.18 ? 2 : 1;
      const unit = cur === 'USD' ? Math.round((price / 34) * 100) / 100 : price;
      const total = Math.round(unit * qty * 100) / 100;
      const x = r();
      const [status, statusLabel] =
        x < 0.05 ? ['Cancelled', 'İptal edildi'] : back >= 4 && x < 0.1 ? ['Returned', 'İade edildi'] : back === 0 ? (x < 0.6 ? ['Picking', 'Hazırlanıyor'] : ['Created', 'Yeni']) : back <= 2 ? ['Shipped', 'Kargoya verildi'] : ['Delivered', 'Teslim edildi'];
      const eventAt = status === 'Picking' || status === 'Created' ? at : Math.min(now, at + (status === 'Cancelled' ? 2 : status === 'Shipped' ? 20 : status === 'Returned' ? 96 : 48) * 3_600_000);
      out.push({
        platform,
        order: {
          id: `${platform.slice(0, 2).toUpperCase()}${day.replace(/-/g, '')}${i}`,
          status,
          statusLabel,
          dateCreated: new Date(at).toISOString(),
          currency: cur,
          totals: { total },
          items: [{ title, quantity: qty, total }],
          fulfillments: status === 'Picking' || status === 'Created' ? [] : [{ status, date: new Date(eventAt).toISOString() }],
        },
      });
    }
  }
  return out;
}

export function demoMarketSummary(chats: Chat[], accounts: Account[], fresh: boolean, day?: string, platform?: string | null): MarketSummary {
  const now = Date.now();
  const d = day || dayKey(now);
  const shops = accounts.filter((a) => a.status === 'connected' && PLATFORMS[a.platform]?.category === 'shop');
  const orders: MarketOrderInput[] = [];
  const questions: MarketQuestionInput[] = [];
  if (!fresh) {
    for (const c of chats) {
      if (PLATFORMS[c.platform]?.category !== 'shop') continue;
      if (c.meta?.order) orders.push({ platform: c.platform, chatId: c.id, order: c.meta.order as Record<string, unknown> });
      else if (c.meta?.question) questions.push({ platform: c.platform, chatId: c.id, question: c.meta.question as Record<string, unknown>, ts: c.lastMessageAt });
    }
    for (const p of new Set(shops.map((a) => a.platform))) orders.push(...history(p, now));
  }
  return summarizeMarket(orders, questions, d, { platform: platform || null, now, hasShop: shops.length > 0 });
}

const KEY = 'mivelo.marketDigest';
export function demoDigestGet(): { enabled: boolean; time: string } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as { enabled?: boolean; time?: string };
    return { enabled: v.enabled !== false, time: typeof v.time === 'string' && /^\d{2}:\d{2}$/.test(v.time) ? v.time : '21:00' };
  } catch {
    return { enabled: true, time: '21:00' };
  }
}
export function demoDigestSet(s: { enabled?: boolean; time?: string }): { enabled: boolean; time: string } {
  const next = { ...demoDigestGet(), ...s };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* gizli mod */
  }
  return next;
}
