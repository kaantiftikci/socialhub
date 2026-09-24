import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';

/**
 * Etsy Mesajları (Conversations): Open API v3'te mesajlaşma ucu YOK; bu yüzden etsy.com/messages sayfasının
 * DOM'u kalıcı profilli Chromium'da okunur (Messenger/Gmail ile aynı yol).
 *
 * DOĞRULANMADI: Bu dosyadaki seçiciler canlı bir Etsy oturumuyla denenmedi; herkese açık bilgi (Etsy'nin
 * "Messages" arayüzü `/messages` listesi, `/messages/<id>` konuşma sayfası; eski arayüzde `/conversations/<id>`)
 * ve genel DOM kalıplarına dayanır. Bu yüzden her adım için birden çok seçici denenir ve hiçbiri tutmazsa
 * bir kez `bus.log` uyarısı düşer. Arayüz değişince burası güncellenmeli.
 *
 * - Giriş: `etala`/`uaid` çerezleri konuklarda da olduğundan yetmez; oturum, `/messages` adresinin `/signin`e
 *   yönlenmemesi ve sayfada oturum izleri (hesap menüsü, "Shop Manager"/`/your/` bağlantıları) ile anlaşılır.
 * - Sohbet listesi: `/messages/<id>` ya da `/conversations/<id>` bağlantıları ile `data-convo-id` benzeri öznitelikler.
 * - Mesajlar: `data-message-id` taşıyan ya da sınıf adında "message" geçen balonlar; gönderen adı, metin, `<time datetime>`.
 * - Gönderim: konuşma sayfasındaki textarea + "Send"/"Gönder" düğmesi.
 */
const BASE = 'https://www.etsy.com';
const HOME = `${BASE}/messages`;

/** Sayfa bağlamından okunan ham sohbet satırı */
export interface RawThreadRow {
  id: string;
  name: string;
  preview: string;
  /** `<time datetime>` (ISO) ya da görünen zaman metni */
  time: string;
  unread: boolean;
  avatarUrl?: string;
}

/** Sayfa bağlamından okunan ham mesaj satırı */
export interface RawMessageRow {
  /** data-message-id (yoksa boş; kimlik içerikten üretilir) */
  id: string;
  sender: string;
  text: string;
  time: string;
  /** Sınıf adı/geometriden çıkarılan "ben mi" bilgisi; undefined = bilinmiyor (gönderen adıyla karar verilir) */
  me?: boolean;
  avatarUrl?: string;
  images: string[];
}

/** page.evaluate'e verilen ayırt edici bağımsız değişken (sahte sayfa testlerde bununla hangi okuma olduğunu anlar) */
export type EvalArg = { mode: 'threads' } | { mode: 'messages' } | { mode: 'me' } | { mode: 'inbox' } | { mode: 'session' };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  oca: 0, şub: 1, sub: 1, nis: 3, haz: 5, tem: 6, ağu: 7, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11, // "mar"/"may" iki dilde de aynı
  ocak: 0, şubat: 1, mart: 2, nisan: 3, mayıs: 4, haziran: 5, temmuz: 6, ağustos: 7, eylül: 8, ekim: 9, kasım: 10, aralık: 11,
};

/**
 * Etsy'nin gösterdiği zaman metnini ms'ye çevir. Öncelik `<time datetime>` (ISO). Metin biçimleri: "2:32 PM", "14:32",
 * "Yesterday"/"Dün", "Sep 24", "Sep 24, 2025", "24 Eyl 2025", "3h"/"2d" (relatif). Çözülemezse undefined.
 */
export function parseEtsyTime(s: string | undefined, now = new Date()): number | undefined {
  const t = (s ?? '').trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const v = Date.parse(t);
    return Number.isNaN(v) ? undefined : v;
  }
  const day = (d: Date, h = 0, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  const clock = t.match(/(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i);
  const hm = (): [number, number] | undefined => {
    if (!clock) return undefined;
    let h = Number(clock[1]);
    const ap = clock[3]?.toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return [h, Number(clock[2])];
  };
  if (/^(yesterday|dün)\b/i.test(t)) return day(new Date(now.getTime() - 86_400_000), ...(hm() ?? [0, 0]));
  if (/^(today|bugün)\b/i.test(t) || (clock && /^\d{1,2}:\d{2}\s*([ap]\.?m\.?)?$/i.test(t))) return day(now, ...(hm() ?? [0, 0]));
  const rel = t.match(/^(\d+)\s*(m|min|h|hr|d|w|dk|sa|g|hf)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const ms = u.startsWith('m') || u === 'dk' ? 60_000 : u.startsWith('h') || u === 'sa' ? 3_600_000 : u === 'd' || u === 'g' ? 86_400_000 : 7 * 86_400_000;
    return now.getTime() - n * ms;
  }
  // "Sep 24", "Sep 24, 2025", "24 Sep 2025", "24 Eyl", "24 Eylül 2025"
  const m1 = t.match(/^([A-Za-zÇçĞğİıÖöŞşÜü]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  const m2 = t.match(/^(\d{1,2})\s+([A-Za-zÇçĞğİıÖöŞşÜü]+)\.?(?:,?\s+(\d{4}))?/);
  const monName = (m1?.[1] ?? m2?.[2] ?? '').toLowerCase();
  const mon = MONTHS[monName] ?? MONTHS[monName.slice(0, 3)];
  const dd = Number(m1?.[2] ?? m2?.[1]);
  if (mon !== undefined && dd >= 1 && dd <= 31) {
    const yStr = m1?.[3] ?? m2?.[3];
    let y = yStr ? Number(yStr) : now.getFullYear();
    const [h, m] = hm() ?? [0, 0];
    let d = new Date(y, mon, dd, h, m);
    if (!yStr && d.getTime() > now.getTime() + 86_400_000) d = new Date(--y, mon, dd, h, m); // yılsız gelecek tarih → geçen yıl
    return d.getTime();
  }
  const v = Date.parse(t);
  return Number.isNaN(v) ? undefined : v;
}

/** Ham satır → sohbet. lastTs bilinmiyorsa 0 (köprü depodaki zamanı korur). */
export function rowToThread(r: RawThreadRow, now = new Date()): Thread {
  return {
    id: r.id,
    name: r.name || `Etsy sohbeti ${r.id}`,
    kind: 'direct',
    lastTs: parseEtsyTime(r.time, now) ?? 0,
    preview: r.preview.replace(/\s+/g, ' ').slice(0, 200),
    unread: r.unread ? 1 : 0,
    avatarUrl: r.avatarUrl,
    link: `${BASE}/messages/${r.id}`,
  };
}

/**
 * Ham mesaj satırları → mesajlar. Zaman çözülemeyen satırlar bir önceki satırın zamanını (+1 ms) alır.
 * Kimlik: data-message-id varsa o; yoksa sohbet + dakika çözünürlüklü zaman + gönderen + metin özeti (yoklamalar arası kararlı).
 */
export function rowsToMessages(threadId: string, rows: RawMessageRow[], meName: string, now = new Date()): Msg[] {
  const msgs: Msg[] = [];
  let cursor: number | undefined;
  const dupes = new Map<string, number>();
  const meLower = meName.trim().toLowerCase();
  for (const r of rows) {
    const text = r.text.trim();
    if (!text && !r.images.length) continue;
    const sender = r.sender.trim();
    const fromMe = r.me ?? (!!meLower && sender.toLowerCase() === meLower);
    const parsed = parseEtsyTime(r.time, now);
    const ts = parsed ?? (cursor = cursor !== undefined ? cursor + 1 : now.getTime());
    if (parsed !== undefined) cursor = parsed;
    const minute = Math.floor(ts / 60_000);
    const key = r.id ? `etsy-msg-${r.id}` : `${threadId}|${minute}|${fromMe ? 'me' : sender}|${text.slice(0, 120)}`;
    const n = dupes.get(key) ?? 0;
    dupes.set(key, n + 1);
    msgs.push({
      id: r.id || hashId(n ? `${key}#${n}` : key),
      text,
      ts,
      fromMe,
      senderId: fromMe ? 'me' : threadId,
      senderName: fromMe ? 'Ben' : sender || 'Alıcı',
      senderAvatarUrl: fromMe ? undefined : r.avatarUrl,
      attachments: r.images.length ? r.images.map((u) => ({ kind: 'image' as const, url: u, link: u, name: 'Görsel' })) : undefined,
    });
  }
  return msgs;
}

/** Gönderim sonrası köprüye verilen kimlik (rowsToMessages ile aynı anahtar → sonraki yoklama kopya yazmasın) */
export function sentMessageId(threadId: string, text: string, now = new Date()): string {
  return hashId(`${threadId}|${Math.floor(now.getTime() / 60_000)}|me|${text.trim().slice(0, 120)}`);
}

/** Oturum düşmüş URL'si mi? */
export function isSignedOutUrl(url: string): boolean {
  return /etsy\.com\/(signin|join|login)\b/i.test(url) || /accounts\.etsy\.com/i.test(url);
}

/** Sohbet liste satırlarını sayfadan oku (DOĞRULANMADI: seçiciler çoklu, ilk tutan kullanılır) */
function readThreadRows(page: Page): Promise<RawThreadRow[]> {
  return page.evaluate((_arg: EvalArg) => {
    const out: RawThreadRow[] = [];
    const seen = new Set<string>();
    const idOf = (el: Element): string => {
      // 1) veri öznitelikleri (Etsy'nin React bileşenleri genelde data-* taşır)
      for (const a of ['data-convo-id', 'data-conversation-id', 'data-conversation_id', 'data-thread-id', 'data-id']) {
        const v = el.getAttribute(a);
        if (v && /^\d+$/.test(v)) return v;
      }
      // 2) satırın bağlantısı: /messages/<id> (yeni arayüz) ya da /conversations/<id> (eski) ya da ?convo_id=
      const link = el.matches('a[href]') ? el : el.querySelector('a[href*="/messages/"], a[href*="/conversations/"], a[href*="convo"]');
      const href = link?.getAttribute('href') ?? '';
      const m = href.match(/\/(?:messages|conversations)\/(\d+)/) ?? href.match(/[?&](?:convo_id|conversation_id|convoId)=(\d+)/);
      return m ? m[1] : '';
    };
    const cands = Array.from(
      document.querySelectorAll<HTMLElement>('[data-convo-id], [data-conversation-id], [data-thread-id], a[href*="/messages/"], a[href*="/conversations/"], a[href*="convo_id="]'),
    );
    for (const c of cands) {
      const id = idOf(c);
      if (!id || seen.has(id)) continue;
      // satırın tamamı: en yakın liste öğesi (ad + önizleme + zaman aynı kapta)
      const row = (c.closest('li, [role="listitem"], [role="row"], article, [class*="convo" i], [class*="conversation" i]') as HTMLElement | null) ?? c;
      const txt = (e: Element | null) => (e as HTMLElement | null)?.innerText?.trim() ?? '';
      // ad: sınıfında name/username geçen öğe, başlık ya da kalın metin
      const nameEl = row.querySelector('[class*="username" i], [class*="name" i], [data-selector*="name" i], h2, h3, h4, strong, b');
      // önizleme: sınıfında preview/snippet/excerpt geçen öğe ya da ilk paragraf
      const prevEl = row.querySelector('[class*="preview" i], [class*="snippet" i], [class*="excerpt" i], [class*="last-message" i], p');
      // zaman: <time datetime> öncelikli
      const timeEl = row.querySelector('time');
      const time = timeEl?.getAttribute('datetime') || txt(timeEl) || txt(row.querySelector('[class*="time" i], [class*="date" i], [class*="ago" i]'));
      const name = txt(nameEl) || txt(row).split('\n')[0] || '';
      let preview = txt(prevEl);
      if (!preview) preview = txt(row).split('\n').filter((l) => l && l !== name && l !== time)[0] ?? '';
      const weight = nameEl ? Number(getComputedStyle(nameEl).fontWeight) || 400 : 400;
      // okunmamış: sınıf/aria "unread|okunmamış", nokta göstergesi ya da kalın ad
      const unread = /unread|okunmam/i.test(row.className + ' ' + (row.getAttribute('aria-label') ?? '')) || !!row.querySelector('[class*="unread" i], [aria-label*="unread" i], [aria-label*="okunmam" i]') || weight >= 600;
      const avatarUrl = Array.from(row.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '').find((s) => /^https?:\/\//.test(s));
      seen.add(id);
      out.push({ id, name, preview, time, unread, avatarUrl });
    }
    return out;
  }, { mode: 'threads' } as EvalArg);
}

/** Konuşma sayfasındaki mesaj balonlarını oku (DOĞRULANMADI) */
function readMessageRows(page: Page): Promise<RawMessageRow[]> {
  return page.evaluate((_arg: EvalArg) => {
    const SEL = '[data-message-id], [data-selector*="message-item" i], [class*="convo-message" i], [class*="message-item" i], [class*="message-bubble" i], [class*="message-row" i], [class*="message-list" i] > li, [class*="message-list" i] > div';
    const all = Array.from(document.querySelectorAll<HTMLElement>(SEL));
    // iç içe adaylar: yalnızca başka aday içermeyen (en içteki) öğeler bir mesajdır
    const rows = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    const W = document.documentElement.clientWidth || 1000;
    const txt = (e: Element | null) => (e as HTMLElement | null)?.innerText?.trim() ?? '';
    return rows.map((el): RawMessageRow => {
      const id = el.getAttribute('data-message-id') ?? '';
      const senderEl = el.querySelector('[class*="sender" i], [class*="author" i], [class*="username" i], [class*="name" i], strong, b');
      const timeEl = el.querySelector('time');
      const time = timeEl?.getAttribute('datetime') || txt(timeEl) || txt(el.querySelector('[class*="time" i], [class*="date" i]'));
      const bodyEl = el.querySelector('[class*="message-text" i], [class*="message-body" i], [class*="body" i], [class*="content" i], p');
      const sender = txt(senderEl);
      let text = txt(bodyEl);
      if (!text) text = txt(el).split('\n').filter((l) => l && l !== sender && l !== time).join('\n');
      const cls = el.className + ' ' + (el.getAttribute('data-selector') ?? '') + ' ' + (el.getAttribute('aria-label') ?? '');
      let me: boolean | undefined;
      if (/outgoing|from-me|is-me|is-mine|\bmine\b|\bsent\b|\bself\b|\byou\b|\bsen\b|\bsiz\b/i.test(cls)) me = true;
      else if (/incoming|from-them|received|\bthem\b/i.test(cls)) me = false;
      else {
        // geometri yedeği: sağa yaslı balon = ben
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < W * 0.85) me = r.left + r.width / 2 > W * 0.55;
      }
      const images = Array.from(el.querySelectorAll('img'))
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return /^https?:\/\//.test(i.getAttribute('src') ?? '') && (r.width === 0 || r.width >= 48) && !/avatar|profile/i.test((i.getAttribute('alt') ?? '') + ' ' + i.className);
        })
        .map((i) => i.getAttribute('src')!);
      const avatarUrl = Array.from(el.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '').find((s) => /^https?:\/\//.test(s) && /avatar|profile|iusa|isla/i.test(s));
      return { id, sender, text: text.slice(0, 4000), time, me, avatarUrl, images };
    });
  }, { mode: 'messages' } as EvalArg);
}

/** Sayfada oturum izi var mı? (hesap menüsü, Shop Manager / /your/ bağlantıları, çıkış bağlantısı) DOĞRULANMADI */
function hasSessionMarks(page: Page): Promise<boolean> {
  return page
    .evaluate((_arg: EvalArg) => !!document.querySelector('a[href*="/your/"], a[href*="/signout"], a[href*="logout"], [data-user-id], [data-selector*="account" i], img[alt*="avatar" i], [class*="avatar" i]'), { mode: 'session' } as EvalArg)
    .catch(() => false);
}

/** Sohbet listesi çizildi mi (en az bir sohbet bağlantısı ya da boş gelen kutusu iletisi)? */
function inboxReady(page: Page): Promise<boolean> {
  return page
    .evaluate((_arg: EvalArg) => {
      if (document.querySelector('[data-convo-id], [data-conversation-id], a[href*="/messages/"], a[href*="/conversations/"]')) return true;
      return /no messages|mesaj yok|henüz mesaj|inbox is empty/i.test(document.body?.innerText ?? '');
    }, { mode: 'inbox' } as EvalArg)
    .catch(() => false);
}

/** /messages listesine git ve satırlar görünene dek bekle (en fazla timeout ms) */
async function ensureInbox(page: Page, timeout = 20_000): Promise<boolean> {
  const url = page.url();
  if (!/^https:\/\/www\.etsy\.com\/messages\/?(\?|$)/.test(url)) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (isSignedOutUrl(page.url())) return false;
    if (await inboxReady(page)) return true;
    await page.waitForTimeout(300).catch(() => undefined);
  }
  return false;
}

/** Konuşma sayfasını aç; balonlar çizilene dek bekle (sayı iki okuma boyunca sabitlenince döner) */
async function openThread(page: Page, id: string): Promise<boolean> {
  const here = new RegExp(`/(messages|conversations)/${id}(?:[/?#]|$)`).test(page.url());
  if (!here) await page.goto(`${BASE}/messages/${id}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  if (isSignedOutUrl(page.url())) return false;
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < (here ? 4_000 : 12_000)) {
    const n = (await readMessageRows(page).catch(() => [])).length;
    if (n > 0 && n === last) return true;
    last = n;
    await page.waitForTimeout(300).catch(() => undefined);
  }
  return last > 0;
}

let meName = '';
let warnedThreads = false;
let warnedMessages = false;

export const etsy: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede Etsy hesabına giriş yap; Mesajlar sayfası görününce pencere kendiliğinden kapanır. (Siparişler için ayrıca Etsy uygulama izni penceresi açılır.)',

  async loggedIn(page, _cookies, passive) {
    // etala/uaid çerezleri konuklarda da bulunur; oturum URL + DOM'dan anlaşılır
    const url = page.url();
    if (isSignedOutUrl(url)) return false;
    // görünür pencerede yönlendirme yapma: kullanıcı 2FA/captcha adımında olabilir
    if (passive) return /etsy\.com\/(messages|conversations|your\/)/.test(url);
    if (!/etsy\.com\/(messages|conversations)/.test(url)) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1500).catch(() => undefined);
    if (isSignedOutUrl(page.url())) return false;
    // /messages'ta kalabildiysek giriş var; emin olmak için DOM izleri de denenir (yönlendirme gecikmeli olabilir)
    return /etsy\.com\/messages/.test(page.url()) || (await hasSessionMarks(page)) || (await inboxReady(page));
  },

  async me(page) {
    const r = await page
      .evaluate((_arg: EvalArg) => {
        // DOĞRULANMADI: üst çubuktaki hesap avatarının alt metni ("Ad" ya da "Ad's avatar") ve data-user-id
        const av = document.querySelector<HTMLImageElement>('[data-selector*="account" i] img[alt], [class*="avatar" i] img[alt], img[alt*="avatar" i], header img[alt]');
        const alt = (av?.getAttribute('alt') ?? '').replace(/'s avatar|avatar[ıi]?|profile picture/gi, '').trim();
        const id = document.querySelector('[data-user-id]')?.getAttribute('data-user-id') ?? '';
        return { name: alt, id };
      }, { mode: 'me' } as EvalArg)
      .catch(() => ({ name: '', id: '' }));
    meName = r.name;
    return { id: r.id || r.name || 'etsy', label: r.name ? `Etsy · ${r.name}` : 'Etsy' };
  },

  async threads(page): Promise<Thread[]> {
    if (!(await ensureInbox(page))) {
      if (isSignedOutUrl(page.url())) throw new Error('Etsy oturumu düşmüş');
      if (!warnedThreads) {
        warnedThreads = true;
        bus.log('warn', `Etsy: mesaj listesi bulunamadı (sayfa: ${page.url().slice(0, 90)}). Seçiciler doğrulanmadı; arayüz değişmiş olabilir.`);
      }
      return [];
    }
    const rows = await readThreadRows(page).catch(() => [] as RawThreadRow[]);
    if (!rows.length && !warnedThreads) {
      warnedThreads = true;
      bus.log('warn', 'Etsy: sohbet satırları okunamadı (liste görünüyor ama satır seçicileri tutmadı)');
    }
    return rows.map((r) => rowToThread(r));
  },

  async messages(page, _cookies, threadId, limit, before): Promise<Msg[]> {
    if (!(await openThread(page, threadId))) {
      if (isSignedOutUrl(page.url())) throw new Error('Etsy oturumu düşmüş');
      if (!warnedMessages) {
        warnedMessages = true;
        bus.log('warn', `Etsy: ${threadId} sohbetinde mesaj balonu bulunamadı; seçiciler doğrulanmadı`);
      }
      return [];
    }
    const rows = await readMessageRows(page);
    const msgs = rowsToMessages(threadId, rows, meName);
    // sayfa tüm konuşmayı bir arada gösterir: "before" ile yalnızca daha eski olanlar
    return (before ? msgs.filter((m) => m.ts < before) : msgs).slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    await openThread(page, threadId); // konuşma açılınca Etsy okundu sayar
  },

  async send(page, _cookies, threadId, text) {
    await openThread(page, threadId);
    // DOĞRULANMADI: yanıt kutusu textarea; ad/placeholder çeşitleri denenir
    const box = page.locator('textarea[name*="message" i], textarea[id*="message" i], textarea[placeholder*="essage" i], textarea[placeholder*="esaj" i], form textarea, textarea').first();
    await box.click({ timeout: 10_000 });
    await box.fill(text, { timeout: 10_000 });
    const now = new Date();
    // gönder düğmesi: form içindeki submit ya da "Send"/"Gönder" metinli düğme; yoksa Enter
    const clicked = await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll<HTMLElement>('form button[type="submit"], button[type="submit"], button, [role="button"]'));
        const b = btns.find((x) => /^(send|gönder|yanıtla|reply)\b/i.test((x.innerText ?? x.getAttribute('aria-label') ?? '').trim()) || x.getAttribute('type') === 'submit');
        if (!b) return false;
        b.click();
        return true;
      })
      .catch(() => false);
    if (!clicked) await page.keyboard.press('Enter').catch(() => undefined);
    // kutu boşalana dek (gönderildi) en fazla 3 sn bekle
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250).catch(() => undefined);
      if (!(await box.inputValue({ timeout: 1_000 }).catch(() => '')).trim()) break;
    }
    return sentMessageId(threadId, text, now);
  },
};
