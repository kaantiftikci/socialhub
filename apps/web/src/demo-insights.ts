import type { Chat, Message, Platform } from './types';
import { PLATFORMS } from './types';
import { libKindOf, linksOf, type LibFacets, type LibItem, type LibKind, type LibPage, type LibQuery, type StatsRange, type WrappedPerson, type WrappedStats } from './insights-types';

/**
 * Statik demo (demo.mivelo.app) için Raporum ve Medya kütüphanesi verisi. Çekirdek yok: rapor demo sohbetlerinin adları/platformları
 * üzerine TUTARLI (tohumlu) örnek sayılarla kurulur, kütüphane demo mesajlarının gerçek eklerinden/bağlantılarından çıkarılır.
 * Kayıtla gelen "fresh" üye örnek veri görmez (boş durum).
 */

export interface DemoCtx {
  chats: Chat[];
  messages: Message[];
  fresh: boolean;
}

const DAY = 86_400_000;
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function period(range: StatsRange, at: string | undefined, now: number): { from: number; end: number; at: string; label: string; prevLabel?: string } {
  const n = new Date(now);
  if (range === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(at ?? '');
    const y = m ? Number(m[1]) : n.getFullYear();
    const mo = m ? Number(m[2]) - 1 : n.getMonth();
    const pf = new Date(y, mo - 1, 1);
    return { from: new Date(y, mo, 1).getTime(), end: new Date(y, mo + 1, 1).getTime(), at: `${y}-${String(mo + 1).padStart(2, '0')}`, label: `${MONTHS[mo]} ${y}`, prevLabel: `${MONTHS[pf.getMonth()]} ${pf.getFullYear()}` };
  }
  if (range === 'year') {
    const y = /^\d{4}$/.test(at ?? '') ? Number(at) : n.getFullYear();
    return { from: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime(), at: String(y), label: String(y), prevLabel: String(y - 1) };
  }
  return { from: new Date(n.getFullYear() - 2, n.getMonth() - 3, 1).getTime(), end: now + 1, at: '', label: 'Tüm zamanlar' };
}

/** Platformların tipik payı (demo) */
const PLATFORM_WEIGHT: Partial<Record<Platform, number>> = { whatsapp: 0.4, instagram: 0.15, telegram: 0.1, slack: 0.09, gmail: 0.06, imessage: 0.07, linkedin: 0.04, x: 0.03, messenger: 0.03, tiktok: 0.02, outlook: 0.02 };
/** Saatlik yoğunluk eğrisi (00-23): sabah hafif, öğleden sonra ve akşam 21-23 tepe */
const HOUR_CURVE = [0.9, 0.6, 0.3, 0.15, 0.08, 0.1, 0.25, 0.6, 1.1, 1.6, 2.0, 2.1, 2.0, 1.9, 2.1, 2.2, 2.1, 2.0, 2.1, 2.4, 2.7, 3.0, 2.8, 1.8];
const DAY_CURVE = [1.0, 1.05, 1.12, 1.0, 1.08, 0.82, 0.78];
const EMOJIS: Array<[string, number]> = [['😂', 1], ['❤', 0.74], ['🙏', 0.52], ['🔥', 0.41], ['👍', 0.37], ['🥹', 0.26], ['✨', 0.19], ['😅', 0.16], ['🎉', 0.11]];

export function emptyStats(range: StatsRange, at?: string, now = Date.now()): WrappedStats {
  const p = period(range, at, now);
  return {
    range, at: p.at, label: p.label, from: p.from, to: Math.min(p.end, now), current: p.end > now, computedAt: now, tookMs: 0,
    totals: { sent: 0, received: 0, total: 0, chats: 0, people: 0, activeDays: 0, days: Math.max(1, Math.ceil((Math.min(p.end, now) - p.from) / DAY)) },
    platforms: [], people: [], groups: [], reply: null, heat: new Array(168).fill(0), busiestHour: null, busiestDay: null,
    streak: { longest: 0, current: 0 }, emojis: [], night: { hour: null, count: 0, share: 0 }, profile: { kind: 'day', nightShare: 0, morningShare: 0 }, change: null, waiting: 0,
  };
}

export function demoStats(ctx: DemoCtx, range: StatsRange, at?: string, now = Date.now()): WrappedStats {
  const p = period(range, at, now);
  const to = Math.min(p.end, now);
  const talk = ctx.chats.filter((c) => PLATFORMS[c.platform]?.category !== 'shop');
  if (ctx.fresh || ctx.messages.length < 5 || !talk.length || to <= p.from) return emptyStats(range, at, now);
  const r = rng(`${range}:${p.at}`);
  const days = Math.max(1, Math.ceil((to - p.from) / DAY));
  const total = Math.round(days * (70 + r() * 22));
  const sent = Math.round(total * (0.44 + r() * 0.06));
  const received = total - sent;

  // platform dağılımı: demodaki bağlı uygulamalar, tipik paylarla
  const plats = [...new Set(talk.map((c) => c.platform))];
  const w = plats.map((pl) => (PLATFORM_WEIGHT[pl] ?? 0.025) * (0.85 + r() * 0.3));
  const wsum = w.reduce((a, b) => a + b, 0);
  let left = total;
  const platforms = plats
    .map((pl, i) => ({ pl, n: Math.round((total * w[i]) / wsum) }))
    .sort((a, b) => b.n - a.n)
    .map((x, i, arr) => {
      const n = i === arr.length - 1 ? Math.max(0, left) : x.n;
      left -= n;
      const s = Math.round(n * (sent / total));
      return { platform: x.pl, sent: s, received: n - s, total: n };
    })
    .filter((x) => x.total > 0);

  const person = (c: Chat, n: number, reply?: number): WrappedPerson => {
    const s = Math.round(n * (0.45 + r() * 0.1));
    return { chatId: c.id, name: c.name, platform: c.platform, avatarUrl: c.avatarUrl, sent: s, received: n - s, total: n, medianReplyMs: reply };
  };
  const direct = talk.filter((c) => c.kind === 'direct' && PLATFORMS[c.platform]?.category !== 'mail').map((c) => ({ c, k: r() }));
  direct.sort((a, b) => a.k - b.k);
  let top = total * (0.1 + r() * 0.03);
  const people = direct.slice(0, 8).map(({ c }) => {
    const pp = person(c, Math.max(4, Math.round(top)), Math.round((40 + r() * 600) * 1000));
    top *= 0.7 + r() * 0.1;
    return pp;
  });
  let gtop = total * 0.08;
  const groups = talk
    .filter((c) => c.kind !== 'direct')
    .slice(0, 4)
    .map((c) => {
      const g = person(c, Math.max(3, Math.round(gtop)));
      gtop *= 0.62;
      return g;
    });
  const fastest = people.length > 1 ? { ...people[1], medianReplyMs: 38_000 + Math.round(r() * 20_000) } : undefined;
  if (fastest) people[1] = fastest;

  const heat: number[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) heat.push(HOUR_CURVE[h] * DAY_CURVE[d] * (0.8 + r() * 0.4));
  const hsum = heat.reduce((a, b) => a + b, 0);
  for (let i = 0; i < heat.length; i++) heat[i] = Math.round((heat[i] / hsum) * total);
  const hours = Array.from({ length: 24 }, (_, h) => heat.filter((_, i) => i % 24 === h).reduce((a, b) => a + b, 0));
  const byDay = Array.from({ length: 7 }, (_, d) => heat.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0));
  const bh = hours.indexOf(Math.max(...hours));
  const bd = byDay.indexOf(Math.max(...byDay));
  const nights = hours.slice(0, 6);
  const nh = nights.indexOf(Math.max(...nights));

  const longest = range === 'month' ? Math.min(days, 11 + Math.round(r() * 9)) : range === 'year' ? 38 + Math.round(r() * 20) : 87;
  const startDay = new Date(to - (longest + 3) * DAY);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const eScale = sent / 90;
  const changeOf = (base: number) => Math.round(base * 10) / 10;
  return {
    range,
    at: p.at,
    label: p.label,
    from: p.from,
    to,
    current: p.end > now,
    computedAt: now,
    tookMs: 3,
    totals: { sent, received, total, chats: talk.length, people: Math.max(people.length, Math.round(days * 0.9)), activeDays: Math.min(days, Math.round(days * (0.78 + r() * 0.15))), days },
    platforms,
    people,
    groups,
    reply: { count: Math.round(sent * 0.42), avgMs: Math.round((13 + r() * 8) * 60_000), medianMs: Math.round((3 + r() * 2.5) * 60_000), fastest },
    heat,
    busiestHour: { hour: bh, count: hours[bh] },
    busiestDay: { day: bd, count: byDay[bd] },
    streak: { longest, from: ymd(startDay), to: ymd(new Date(startDay.getTime() + (longest - 1) * DAY)), current: p.end > now ? Math.min(longest, 6 + Math.round(r() * 4)) : 0 },
    emojis: EMOJIS.map(([emoji, k]) => ({ emoji, count: Math.max(1, Math.round(eScale * k * (0.85 + r() * 0.3))) })).sort((a, b) => b.count - a.count),
    night: { hour: nh, count: hours[nh], share: Math.round((nights.reduce((a, b) => a + b, 0) / total) * 1000) / 1000 },
    profile: { kind: 'night', nightShare: 0.17, morningShare: 0.05 },
    change: p.prevLabel ? { total: changeOf(range === 'year' ? 23.6 : p.end > now ? 12.4 : -4.1), sent: changeOf(p.end > now ? 15.2 : -2.3), received: changeOf(p.end > now ? 9.8 : -6.0), prevTotal: Math.round(total / 1.12), prevLabel: p.prevLabel } : null,
    waiting: ctx.chats.filter((c) => c.kind === 'direct' && c.unread > 0 && !c.lastFromMe && PLATFORMS[c.platform]?.category !== 'shop').length,
  };
}

/* ───────── Medya kütüphanesi (demo mesajlarının gerçek ekleri ve bağlantıları) ───────── */

function allItems(ctx: DemoCtx): LibItem[] {
  if (ctx.fresh) return [];
  const byId = new Map(ctx.chats.map((c) => [c.id, c]));
  const out: LibItem[] = [];
  for (const m of ctx.messages) {
    const c = byId.get(m.chatId);
    if (!c || m.deleted) continue;
    const seen = new Set<string>();
    (m.attachments ?? []).forEach((a, i) => {
      const kind = libKindOf(a);
      if (!kind) return;
      for (const u of [a.link, a.page]) if (u) seen.add(u);
      out.push({ id: `${m.id}|${i}`, messageId: m.id, chatId: c.id, accountId: c.accountId, platform: c.platform, kind, ts: m.ts, name: a.name ?? '', att: a, senderName: m.senderName, fromMe: m.fromMe, chatName: c.name, chatKind: c.kind });
    });
    linksOf(m.text, seen).forEach((u, j) =>
      out.push({ id: `${m.id}|${100 + j}`, messageId: m.id, chatId: c.id, accountId: c.accountId, platform: c.platform, kind: 'link', ts: m.ts, name: u.replace(/^https?:\/\/(www\.)?/i, ''), att: { kind: 'other', page: u, name: u }, senderName: m.senderName, fromMe: m.fromMe, chatName: c.name, chatKind: c.kind }),
    );
  }
  return out.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
}

export function demoLibrary(ctx: DemoCtx, q: LibQuery): LibPage {
  const term = (q.q ?? '').trim().toLocaleLowerCase('tr-TR');
  const list = allItems(ctx).filter(
    (i) => (!q.kind || i.kind === q.kind) && (!q.platform || i.platform === q.platform) && (!q.chat || i.chatId === q.chat) && (!term || `${i.name} ${i.chatName}`.toLocaleLowerCase('tr-TR').includes(term)),
  );
  const off = Number(q.before) || 0;
  const limit = Math.max(1, Math.min(200, q.limit ?? 60));
  const page = list.slice(off, off + limit);
  return { items: page, next: off + limit < list.length ? String(off + limit) : null };
}

export function demoLibraryFacets(ctx: DemoCtx): LibFacets {
  const items = allItems(ctx);
  const kinds: Partial<Record<LibKind, number>> = {};
  const plats = new Map<Platform, number>();
  const chats = new Map<string, { chatId: string; name: string; platform: Platform; kind: string; count: number; lastTs: number }>();
  for (const i of items) {
    kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    plats.set(i.platform, (plats.get(i.platform) ?? 0) + 1);
    const c = chats.get(i.chatId) ?? { chatId: i.chatId, name: i.chatName, platform: i.platform, kind: i.chatKind, count: 0, lastTs: 0 };
    c.count++;
    c.lastTs = Math.max(c.lastTs, i.ts);
    chats.set(i.chatId, c);
  }
  return {
    kinds,
    platforms: [...plats.entries()].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count),
    chats: [...chats.values()].sort((a, b) => b.lastTs - a.lastTs),
    progress: { ready: true, pct: 100, pending: 0 },
  };
}
