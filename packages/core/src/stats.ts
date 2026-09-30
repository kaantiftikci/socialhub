import type { Store } from './store.js';

/**
 * Mivelo Wrapped ("Raporum"): aylık / yıllık / tüm zamanlar iletişim raporu. YALNIZ yerel SQLite'tan hesaplanır; hiçbir yere
 * gönderilmez, mesaj içeriği sonuçta yer almaz (emoji sayımı dışında metin okunmaz, o da yalnız kendi mesajlarımda).
 *
 * Büyük veritabanında (300 bin+ şifreli mesaj) tek sorguda tüm aralığı okumak olay döngüsünü saniyelerce kilitler: mesajlar
 * `messages_ts` dizininde (ts, rowid) sırasıyla 2-4 binlik dilimlerle okunur, her dilimden sonra setImmediate ile olay döngüsüne
 * dönülür (dilim boyu süreye göre ayarlanır). Sonuç dönem başına meta tablosunda önbelleğe alınır (geçmiş dönem 6 sa, süren 10 dk).
 */

export type StatsRange = 'month' | 'year' | 'all';

export interface WrappedPerson {
  chatId: string;
  name: string;
  platform: string;
  avatarUrl?: string;
  sent: number;
  received: number;
  total: number;
  /** bu kişiye ortanca yanıt süren (ms; en az 3 yanıt varsa) */
  medianReplyMs?: number;
}

export interface WrappedStats {
  range: StatsRange;
  /** 'YYYY-MM' (ay), 'YYYY' (yıl), '' (tümü) */
  at: string;
  label: string;
  from: number;
  /** dönemin (şimdiye kadarki) sonu */
  to: number;
  /** dönem sürüyor mu (bu ay / bu yıl) */
  current: boolean;
  computedAt: number;
  tookMs: number;
  totals: { sent: number; received: number; total: number; chats: number; people: number; activeDays: number; days: number };
  platforms: Array<{ platform: string; sent: number; received: number; total: number }>;
  people: WrappedPerson[];
  groups: WrappedPerson[];
  reply: { count: number; avgMs: number; medianMs: number; fastest?: WrappedPerson } | null;
  /** 7×24 ısı haritası: indeks = gün×24 + saat; gün 0 = Pazartesi (yerel saat) */
  heat: number[];
  busiestHour: { hour: number; count: number } | null;
  busiestDay: { day: number; count: number } | null;
  streak: { longest: number; from?: string; to?: string; current: number };
  emojis: Array<{ emoji: string; count: number }>;
  /** gece (00-05) en yoğun saat; share = gece mesajlarının tüm mesajlara oranı */
  night: { hour: number | null; count: number; share: number };
  /** kendi mesajlarına göre: gece kuşu (22-05) / erkenci (05-09) / gündüz */
  profile: { kind: 'night' | 'early' | 'day'; nightShare: number; morningShare: number };
  /** önceki döneme göre değişim (%; aynı süre karşılaştırılır). null = karşılaştırma yok */
  change: { total: number | null; sent: number | null; received: number | null; prevTotal: number; prevLabel: string } | null;
  /** şu an yanıt bekleyen birebir sohbet sayısı (son mesaj karşıdan, son 14 gün) */
  waiting: number;
}

/** Sipariş/soru olayları iletişim sayılmaz */
const SHOP = new Set(['shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm']);
const MAIL = new Set(['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap']);
/** Bu süreden sonra gelen yanıt "yanıt süresi" sayılmaz (ertesi güne kalan konuşma) */
export const REPLY_CAP_MS = 12 * 3_600_000;
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const MIN_TS = Date.UTC(2000, 0, 1);

/** Bağlayıcıların yazdığı sistem baş emojileri ("📷 Fotoğraf", "🎤 Sesli mesaj") kullanıcının emojisi sayılmaz */
const SYSTEM_LEAD = /^(?:📦|🛍|🛒|✅|✔|☑|📝|❌|🚫|⚠|↩|↪|🔁|📍|👤|🧾|📊|🔒|📷|🖼|🎤|🎙|🎵|🎬|📹|📎|🗑|💬|🎁|💳|✉|📧|📅|📆|🔗|❓|🚚|⏰|⏳|⌛|⏱|🔔)️?\s/u;
/** Tepki olayı metinleri ("👍 Bir mesajı beğendi", "❤️ Ayşe mesajına tepki verdi") */
const REACTION_TEXT = /(bir mesajı beğendi|mesajına tepki verdi|mesajını beğendi)$/;
/** Emoji dizileri: ten rengi, ZWJ birleşimleri (👨‍👩‍👧), bayraklar, tuş başlıkları */
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])*(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])*)*/gu;

export function extractEmojis(text: string): string[] {
  if (!text || REACTION_TEXT.test(text)) return [];
  const t = text.replace(SYSTEM_LEAD, '');
  // hızlı eleme: emoji yoksa (çoğu mesaj) düzenli ifade hiç çalışmasın
  if (!/[←-⯿⃣\u{1F000}-\u{1FAFF}]/u.test(t)) return [];
  const out: string[] = [];
  for (const m of t.matchAll(EMOJI_RE)) {
    // metin sunumlu tek karakterler (©, ®, ™, ↔ vb. VS16'sız) emoji sayılmaz
    const e = m[0];
    if (e.length === 1 && e.charCodeAt(0) < 0x2600) continue;
    out.push(e.replace(/️/g, ''));
  }
  return out;
}

/** Dönemin sınırları (yerel saat) */
export function periodOf(range: StatsRange, at: string | undefined, now: number, firstTs?: number): { from: number; end: number; at: string; label: string; prev?: { from: number; end: number; label: string } } {
  const n = new Date(now);
  if (range === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(at ?? '');
    const y = m ? Number(m[1]) : n.getFullYear();
    const mo = m ? Number(m[2]) - 1 : n.getMonth();
    const from = new Date(y, mo, 1).getTime();
    const end = new Date(y, mo + 1, 1).getTime();
    const pf = new Date(y, mo - 1, 1);
    return {
      from,
      end,
      at: `${y}-${String(mo + 1).padStart(2, '0')}`,
      label: `${MONTHS[mo]} ${y}`,
      prev: { from: pf.getTime(), end: from, label: `${MONTHS[pf.getMonth()]} ${pf.getFullYear()}` },
    };
  }
  if (range === 'year') {
    const y = /^\d{4}$/.test(at ?? '') ? Number(at) : n.getFullYear();
    const from = new Date(y, 0, 1).getTime();
    return { from, end: new Date(y + 1, 0, 1).getTime(), at: String(y), label: String(y), prev: { from: new Date(y - 1, 0, 1).getTime(), end: from, label: String(y - 1) } };
  }
  return { from: Math.max(MIN_TS, firstTs ?? MIN_TS), end: now + 1, at: '', label: 'Tüm zamanlar' };
}

type ChatInfo = { platform: string; kind: string; name: string; avatar?: string; skip: boolean };
type Row = { r: number; c: string; f: number; t: number; x?: string | null };

/**
 * Aralıktaki mesajları (ts, rowid) sırasıyla dilim dilim okur; her dilimden sonra olay döngüsüne döner.
 * withText: kendi mesajlarımın metni de gelir (emoji sayımı).
 */
async function scan(store: Store, from: number, end: number, withText: boolean, onRow: (row: Row) => void): Promise<void> {
  const st = store.sql(
    `SELECT m.rowid AS r, m.chat_id AS c, m.from_me AS f, m.ts AS t${withText ? ', CASE WHEN m.from_me = 1 THEN m.text END AS x' : ''}
     FROM messages m INDEXED BY messages_ts
     WHERE m.ts >= @ts AND m.ts < @end AND NOT (m.ts = @ts AND m.rowid <= @r)
     ORDER BY m.ts, m.rowid LIMIT @n`,
  );
  let ts = from;
  let r = -1;
  let n = 3000;
  for (;;) {
    const t0 = performance.now();
    const rows = st.all({ ts, end, r, n }) as Row[];
    for (const row of rows) onRow(row);
    if (rows.length < n) return;
    const last = rows[rows.length - 1];
    ts = last.t;
    r = last.r;
    // dilim ≈20 ms kalsın (şifreli ve yavaş diskte küçülür, hızlıda büyür)
    const ms = performance.now() - t0;
    n = Math.max(500, Math.min(8000, Math.round(n * (ms > 0 ? Math.min(2, 20 / ms) : 2))));
    await new Promise((res) => setImmediate(res));
  }
}

function chatMap(store: Store): Map<string, ChatInfo> {
  const rows = store.sql('SELECT id, account_id, platform, kind, name, avatar_url FROM chats').all() as Array<{ id: string; account_id: string; platform: string; kind: string; name: string; avatar_url: string | null }>;
  const out = new Map<string, ChatInfo>();
  for (const c of rows) out.set(c.id, { platform: c.platform, kind: c.kind, name: c.name, avatar: c.avatar_url ?? undefined, skip: SHOP.has(c.platform) || store.isRemoving(c.account_id) });
  return out;
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
};
const pct = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const ymdOf = (day: number): string => {
  // day: yerel gün numarası (yerel gece yarısının UTC karşılığı / gün)
  const d = new Date(day * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Önbelleksiz hesap (testler ve önbellek dolumu) */
export async function computeStats(store: Store, range: StatsRange, at?: string, now = Date.now()): Promise<WrappedStats> {
  const t0 = Date.now();
  const first = range === 'all' ? ((store.sql('SELECT MIN(ts) AS t FROM messages WHERE ts > ?').get(MIN_TS) as { t: number | null }).t ?? now) : undefined;
  const p = periodOf(range, at, now, first);
  const to = Math.min(p.end, now);
  const current = p.end > now;
  const chats = chatMap(store);

  let sent = 0;
  let received = 0;
  const perChat = new Map<string, { s: number; r: number }>();
  const perPlat = new Map<string, { s: number; r: number }>();
  const heat = new Array<number>(7 * 24).fill(0);
  const hourAll = new Array<number>(24).fill(0);
  const hourMine = new Array<number>(24).fill(0);
  const sentDays = new Set<number>();
  const emojis = new Map<string, number>();
  /** birebir sohbette yanıtlanmamış ilk gelen mesajın zamanı */
  const pending = new Map<string, number>();
  const gaps: number[] = [];
  const gapsByChat = new Map<string, number[]>();
  const d = new Date();

  await scan(store, p.from, to, true, (row) => {
    const c = chats.get(row.c);
    if (!c || c.skip) return;
    const mine = row.f === 1;
    if (mine) sent++;
    else received++;
    let pc = perChat.get(row.c);
    if (!pc) perChat.set(row.c, (pc = { s: 0, r: 0 }));
    let pp = perPlat.get(c.platform);
    if (!pp) perPlat.set(c.platform, (pp = { s: 0, r: 0 }));
    if (mine) (pc.s++, pp.s++);
    else (pc.r++, pp.r++);
    d.setTime(row.t);
    const hour = d.getHours();
    const dow = (d.getDay() + 6) % 7;
    heat[dow * 24 + hour]++;
    hourAll[hour]++;
    if (mine) {
      hourMine[hour]++;
      sentDays.add(Math.floor((row.t - d.getTimezoneOffset() * 60_000) / 86_400_000));
      if (row.x) for (const e of extractEmojis(row.x)) emojis.set(e, (emojis.get(e) ?? 0) + 1);
    }
    // yanıt süresi: yalnız birebir (grupta kime yanıt verildiği belirsiz)
    if (c.kind === 'direct') {
      if (!mine) {
        if (!pending.has(row.c)) pending.set(row.c, row.t);
      } else {
        const since = pending.get(row.c);
        if (since !== undefined) {
          pending.delete(row.c);
          const gap = row.t - since;
          if (gap >= 0 && gap <= REPLY_CAP_MS) {
            gaps.push(gap);
            let g = gapsByChat.get(row.c);
            if (!g) gapsByChat.set(row.c, (g = []));
            g.push(gap);
          }
        }
      }
    }
  });

  const person = (id: string, v: { s: number; r: number }): WrappedPerson => {
    const c = chats.get(id)!;
    const g = gapsByChat.get(id);
    return { chatId: id, name: c.name, platform: c.platform, avatarUrl: c.avatar, sent: v.s, received: v.r, total: v.s + v.r, medianReplyMs: g && g.length >= 3 ? median(g) : undefined };
  };
  const entries = [...perChat.entries()];
  // kişiler: gerçek konuşma (iki yönlü) olan birebir sohbetler; bültenler/tek yönlü e-postalar sayılmaz
  const people = entries
    .filter(([id, v]) => chats.get(id)?.kind === 'direct' && v.s > 0 && v.r > 0)
    .sort((a, b) => b[1].s + b[1].r - (a[1].s + a[1].r))
    .slice(0, 10)
    .map(([id, v]) => person(id, v));
  const groups = entries
    .filter(([id]) => chats.get(id)?.kind !== 'direct')
    .sort((a, b) => b[1].s + b[1].r - (a[1].s + a[1].r))
    .slice(0, 5)
    .map(([id, v]) => person(id, v));
  let fastest: WrappedPerson | undefined;
  for (const [id, g] of gapsByChat) {
    if (g.length < 3) continue;
    const m = median(g);
    if (!fastest || m < (fastest.medianReplyMs ?? Infinity)) fastest = person(id, perChat.get(id)!);
  }

  // en uzun ardışık gün serisi (kendi mesajım olan günler) + bugün/dün biten güncel seri
  const days = [...sentDays].sort((a, b) => a - b);
  let longest = 0;
  let lFrom = 0;
  let lTo = 0;
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    if (j - i + 1 > longest) (longest = j - i + 1, (lFrom = days[i]), (lTo = days[j]));
    i = j + 1;
  }
  d.setTime(now);
  const today = Math.floor((now - d.getTimezoneOffset() * 60_000) / 86_400_000);
  let cur = 0;
  if (current || range === 'all') {
    let k = sentDays.has(today) ? today : today - 1;
    while (sentDays.has(k)) (cur++, k--);
  }

  const argmax = (a: number[], lo = 0, hi = a.length): number => {
    let best = -1;
    for (let i = lo; i < hi; i++) if (a[i] > 0 && (best < 0 || a[i] > a[best])) best = i;
    return best;
  };
  const bh = argmax(hourAll);
  const byDay = Array.from({ length: 7 }, (_, dd) => heat.slice(dd * 24, dd * 24 + 24).reduce((x, y) => x + y, 0));
  const bd = argmax(byDay);
  const nh = argmax(hourAll, 0, 6);
  const total = sent + received;
  const nightAll = hourAll.slice(0, 6).reduce((x, y) => x + y, 0);
  const mineNight = [22, 23, 0, 1, 2, 3, 4].reduce((x, h) => x + hourMine[h], 0);
  const mineMorning = [5, 6, 7, 8].reduce((x, h) => x + hourMine[h], 0);
  const nightShare = sent ? mineNight / sent : 0;
  const morningShare = sent ? mineMorning / sent : 0;
  const profile: WrappedStats['profile']['kind'] =
    nightShare >= 0.08 && nightShare >= morningShare * 1.5 ? 'night' : morningShare >= 0.08 && morningShare >= nightShare * 1.5 ? 'early' : 'day';

  // önceki dönem: süren dönemde aynı uzunluk (1-30 Eylül ↔ 1-30 Ağustos), bitmiş dönemde tamamı
  let change: WrappedStats['change'] = null;
  if (p.prev) {
    const span = to - p.from;
    const prevEnd = current ? Math.min(p.prev.end, p.prev.from + span) : p.prev.end;
    let ps = 0;
    let pr = 0;
    await scan(store, p.prev.from, prevEnd, false, (row) => {
      const c = chats.get(row.c);
      if (!c || c.skip) return;
      if (row.f === 1) ps++;
      else pr++;
    });
    change = { total: pct(total, ps + pr), sent: pct(sent, ps), received: pct(received, pr), prevTotal: ps + pr, prevLabel: p.prev.label };
  }

  const waiting = Number(
    (
      store
        .sql(
          `SELECT COUNT(*) AS n FROM chats WHERE kind = 'direct' AND last_from_me = 0 AND last_reaction = 0 AND last_message_at > ?
             AND platform NOT IN ('shopier','trendyol','hepsiburada','etsy','shopify','n11','amazon','pttavm')
             AND (flags IS NULL OR (flags NOT LIKE '%"archived":true%' AND flags NOT LIKE '%"hidden":true%' AND flags NOT LIKE '%"muted":true%'))`,
        )
        .get(now - 14 * 86_400_000) as { n: number }
    ).n,
  );

  return {
    range,
    at: p.at,
    label: p.label,
    from: p.from,
    to,
    current,
    computedAt: now,
    tookMs: Date.now() - t0,
    totals: {
      sent,
      received,
      total,
      chats: perChat.size,
      people: entries.filter(([id, v]) => chats.get(id)?.kind === 'direct' && v.s > 0 && v.r > 0).length,
      activeDays: sentDays.size,
      days: Math.max(1, Math.ceil((to - p.from) / 86_400_000)),
    },
    platforms: [...perPlat.entries()].map(([platform, v]) => ({ platform, sent: v.s, received: v.r, total: v.s + v.r })).sort((a, b) => b.total - a.total),
    people,
    groups,
    reply: gaps.length ? { count: gaps.length, avgMs: Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length), medianMs: median(gaps), fastest } : null,
    heat,
    busiestHour: bh >= 0 ? { hour: bh, count: hourAll[bh] } : null,
    busiestDay: bd >= 0 ? { day: bd, count: byDay[bd] } : null,
    streak: { longest, from: longest ? ymdOf(lFrom) : undefined, to: longest ? ymdOf(lTo) : undefined, current: cur },
    emojis: [...emojis.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([emoji, count]) => ({ emoji, count })),
    night: { hour: nh >= 0 ? nh : null, count: nh >= 0 ? hourAll[nh] : 0, share: total ? Math.round((nightAll / total) * 1000) / 1000 : 0 },
    profile: { kind: profile, nightShare: Math.round(nightShare * 1000) / 1000, morningShare: Math.round(morningShare * 1000) / 1000 },
    change,
    waiting,
  };
}

/** Mail platformları (arayüz "E-posta" altında toplayabilir) */
export const isMailPlatform = (p: string): boolean => MAIL.has(p);

const CACHE_VER = 'v1';
const mem = new Map<string, WrappedStats>();
const inflight = new Map<string, Promise<WrappedStats>>();

/**
 * Önbellekli rapor. Anahtar dönem başına (meta tablosunda kalıcı; çekirdek yeniden başlasa da hızlı açılır).
 * Süren dönem 10 dk, geçmiş dönem 6 sa sonra yeniden hesaplanır (eşitleme eski mesajları sonradan getirebilir).
 */
export async function getStats(store: Store, range: StatsRange, at?: string, opts: { now?: number; fresh?: boolean } = {}): Promise<WrappedStats> {
  const now = opts.now ?? Date.now();
  const p = periodOf(range, at, now);
  const key = `wrapped:${CACHE_VER}:${range}:${p.at}`;
  const ttl = range === 'all' ? 30 * 60_000 : p.end > now ? 10 * 60_000 : 6 * 3_600_000;
  const fresh = (s: WrappedStats | undefined) => !!s && !opts.fresh && now - s.computedAt < ttl && now >= s.computedAt;
  const hit = mem.get(key);
  // "Tüm verileri sil" meta tablosunu boşaltır: bellekteki sonuç da geçersiz sayılır
  if (fresh(hit) && store.meta(key) !== undefined) return hit!;
  if (!opts.fresh) {
    try {
      const raw = store.meta(key);
      const saved = raw ? (JSON.parse(raw) as WrappedStats) : undefined;
      if (fresh(saved)) {
        mem.set(key, saved!);
        return saved!;
      }
    } catch {
      /* bozuk kayıt: yeniden hesapla */
    }
  }
  const running = inflight.get(key);
  if (running) return running;
  const job = computeStats(store, range, p.at || undefined, now)
    .then((s) => {
      mem.set(key, s);
      try {
        store.setFlag(key, JSON.stringify(s));
      } catch {
        /* yazılamadı: bellekte kalır */
      }
      return s;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Tüm verileri sil / testler: bellek önbelleğini boşalt (meta kayıtları wipeAll ile gider) */
export function clearStatsCache(): void {
  mem.clear();
}
