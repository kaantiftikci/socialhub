import type { Frame, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';

/**
 * Shopify Inbox (müşteri sohbetleri) — tarayıcı köprüsü stratejisi.
 *
 * Shopify Inbox'ın açık bir API'si yok; sohbetler yönetici panelindeki Inbox uygulamasından
 * (https://admin.shopify.com/store/<mağaza>/apps/inbox) DOM okunarak alınır. Inbox, panelde gömülü
 * bir uygulama (App Bridge) olarak çalışır; içerik ana belgede ya da bir iframe içinde olabilir.
 * Bu yüzden her okuma önce ana sayfada, sonra çerçevelerde denenir.
 *
 * DOĞRULANMADI: Canlı bir Shopify oturumu olmadan yazıldı. Aşağıdaki seçiciler Shopify Inbox web
 * arayüzüne dair en makul tahminlerdir; her biri çoklu ve gevşek tutuldu (data-testid, href deseni,
 * rol, sınıf adı parçaları). Gerçek DOM'la ilk denemede uymayanlar `bus.log` uyarısıyla görünür ve
 * bu dosyada güncellenmelidir.
 */
const ADMIN = 'https://admin.shopify.com';

/** Yönetici paneli URL'si (giriş sayfasına düşmemiş) */
const inAdmin = (url: string) => /^https:\/\/admin\.shopify\.com\/store\/[^/?#]+/.test(url) && !/accounts\.shopify\.com|\/login(\b|\/|\?)|\/auth\//.test(url);

/** Tarayıcıda çalışan okuma/işlem işlevlerine geçen etiketli argüman (sahte sayfa testleri `op` ile ayırt eder) */
interface Op {
  op: 'probe' | 'threads' | 'open' | 'messages' | 'scrollTop' | 'focusComposer' | 'clickSend';
  id?: string;
  name?: string;
}

/** DOM'dan okunan ham sohbet satırı */
export interface RawThread {
  id: string;
  href?: string;
  name: string;
  preview: string;
  when: string;
  unread: boolean;
}

/** DOM'dan okunan ham mesaj */
export interface RawMsg {
  text: string;
  /** time[datetime] / title / görünen zaman metni; çözülemezse boş */
  when: string;
  /** sınıf/geometriden çıkarılan "ben" bilgisi */
  me: boolean | undefined;
  sender?: string;
}

// ─────────── Zaman çözümleme (Inbox göreli/kısa zaman gösterir) ───────────
const MONTHS: Record<string, number> = {
  oca: 0, şub: 1, sub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * "14:32", "Dün 14:32", "3 Eyl", "3 Eyl 14:32", "Sep 3", "2026-09-24T11:20:00Z", "5 dk", "2 sa" → ms.
 * Çözülemezse undefined (çağıran bir önceki zamana ya da 0'a düşer).
 */
export function parseWhen(s: string, now = Date.now()): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const iso = Date.parse(t);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(t)) return iso;
  const d = new Date(now);
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d+)\s*(sn|s|dk|m|sa|h|g|d|hf|w)$/i))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = /^s/.test(unit) && unit !== 'sa' ? 1000 : /^(dk|m)$/.test(unit) ? 60_000 : /^(sa|h)$/.test(unit) ? 3_600_000 : /^(g|d)$/.test(unit) ? 86_400_000 : 7 * 86_400_000;
    return now - n * ms;
  }
  if (/^(şimdi|now|az önce|just now)$/i.test(t)) return now;
  const hm = t.match(/(\d{1,2}):(\d{2})/);
  const setHm = (x: Date) => {
    if (hm) x.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    else x.setHours(12, 0, 0, 0);
    return x.getTime();
  };
  if (/^(bugün|today)/i.test(t) || /^\d{1,2}:\d{2}$/.test(t)) return setHm(d);
  if (/^(dün|yesterday)/i.test(t)) {
    d.setDate(d.getDate() - 1);
    return setHm(d);
  }
  // "3 Eyl", "3 Eyl 2025", "Sep 3", "3 Eylül 14:32"
  if ((m = t.match(/^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})[^\d]*(\d{4})?/)) || (m = t.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?/))) {
    const dayFirst = /^\d/.test(t);
    const day = Number(dayFirst ? m[1] : m[2]);
    const mon = MONTHS[(dayFirst ? m[2] : m[1]).toLowerCase().slice(0, 3)];
    if (mon === undefined) return undefined;
    const year = m[3] ? Number(m[3]) : d.getFullYear();
    const x = new Date(year, mon, day);
    if (!m[3] && x.getTime() > now + 86_400_000) x.setFullYear(year - 1); // gelecek tarih olamaz: geçen yıl
    return setHm(x);
  }
  // "24.09.2026 14:32" / "24/09/2026"
  if ((m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/))) return setHm(new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return undefined;
}

// ─────────── Belge seçimi: ana sayfa ya da Inbox iframe'i ───────────
type Doc = Page | Frame;

/** Ana sayfa + Inbox'a benzeyen çerçeveler (önce ana belge) */
function docs(page: Page): Doc[] {
  const frames = (page.frames?.() ?? []).filter((f) => f !== page.mainFrame?.() && /shopify|inbox/i.test(f.url()));
  return [page, ...frames];
}

/** Tarayıcı içinde: bu belgede sohbet listesi ya da mesaj alanı var mı? */
function probeFn(): boolean {
  const sel = 'a[href*="/conversations/"], [data-conversation-id], [data-testid*="conversation" i], [data-testid*="message" i], [role="log"], textarea, [contenteditable="true"]';
  return document.querySelector(sel) !== null;
}

/** İçinde Inbox DOM'u bulunan ilk belge (yoksa ana sayfa) */
async function inboxDoc(page: Page): Promise<Doc> {
  for (const d of docs(page)) {
    const ok = await d.evaluate(probeFn, { op: 'probe' } as Op).catch(() => false);
    if (ok) return d;
  }
  return page;
}

// ─────────── Sohbet listesi ───────────
/**
 * Tarayıcı içinde çalışır: sol sütundaki konuşma satırlarını okur.
 * DOĞRULANMADI — Inbox satırlarının `a[href*="/conversations/<id>"]` bağlantısı ya da `data-conversation-id`
 * taşıdığı varsayıldı; yoksa liste öğeleri (li / role=listitem / role=option) taranır ve kimlik metinden üretilir.
 */
function readThreadsFn(): RawThread[] {
  const out: RawThread[] = [];
  const seenText = new Set<string>();
  const seenId = new Set<string>();
  const timeRe = /^(\d{1,2}:\d{2}|\d+\s?(sn|s|dk|m|sa|h|g|d|hf|w)|dün|yesterday|bugün|today|şimdi|now|az önce|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,}( \d{4})?|[A-Za-z]{3} \d{1,2}(, \d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i;
  const cands = Array.from(document.querySelectorAll<HTMLElement>('a[href*="/conversations/"], [data-conversation-id], [data-testid*="conversation" i], [role="listitem"], [role="option"], li'));
  for (const el of cands) {
    // iç içe adaylar (li > a): en dıştaki satırı al, aynı metni bir kez yaz
    if (el.closest('[role="log"], [data-testid*="message" i]')) continue; // mesaj alanı değil
    const a = el.matches('a[href]') ? (el as HTMLAnchorElement) : el.querySelector<HTMLAnchorElement>('a[href*="/conversations/"]');
    const href = a?.getAttribute('href') ?? '';
    const m = href.match(/\/conversations\/([\w-]+)/);
    let id = m?.[1] ?? el.getAttribute('data-conversation-id') ?? el.getAttribute('data-id') ?? '';
    const lines = (el.innerText ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const key = lines.join('|');
    if (seenText.has(key)) continue;
    // zaman satırı ayrıştır
    const when = lines.find((s) => timeRe.test(s)) ?? '';
    const rest = lines.filter((s) => s !== when && !/^\d+$/.test(s)); // salt sayı = okunmamış rozeti
    const name = rest[0] ?? '';
    if (!name || name.length > 80) continue;
    // satır olmayan büyük kaplar (tüm liste tek li gibi) elensin: çok satır
    if (rest.length > 6) continue;
    const preview = rest.slice(1).join(' · ').slice(0, 200);
    if (!id) id = 'h' + String(Math.abs(Array.from(name).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)));
    if (seenId.has(id)) continue;
    seenId.add(id);
    seenText.add(key);
    // okunmamış: rozet/erişilebilirlik etiketi ya da kalın ad
    const badge = el.querySelector('[aria-label*="okunmamış" i], [aria-label*="unread" i], [class*="unread" i], [class*="Unread"], [data-testid*="unread" i]');
    const first = el.querySelector<HTMLElement>('span, p, h2, h3, div');
    const bold = first ? (Number(getComputedStyle(first).fontWeight) || 400) >= 600 : false;
    out.push({ id, href: href || undefined, name, preview, when, unread: !!badge || bold });
  }
  return out;
}

/** Tarayıcı içinde: verilen sohbet satırına DOM tıklaması (href ya da ad eşleşmesi); tıklandıysa true */
function openFn(arg: Op): boolean {
  const byHref = arg.id ? document.querySelector<HTMLElement>(`a[href*="/conversations/${CSS.escape(arg.id)}"]`) : null;
  const byData = arg.id ? document.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(arg.id)}"]`) : null;
  let el: HTMLElement | null = byHref ?? byData;
  if (!el && arg.name) {
    el = Array.from(document.querySelectorAll<HTMLElement>('[role="listitem"], [role="option"], li, a[href*="/conversations/"]')).find((x) => (x.innerText ?? '').trim().startsWith(arg.name!)) ?? null;
  }
  if (!el) return false;
  (el.querySelector<HTMLElement>('a, button') ?? el).click();
  return true;
}

// ─────────── Mesajlar ───────────
/**
 * Tarayıcı içinde çalışır: açık konuşmadaki mesaj balonlarını okur.
 * DOĞRULANMADI — balonların `data-testid*="message"` ya da sınıf adında "Message"/"bubble" taşıdığı varsayıldı;
 * "benim" bilgisi sınıf adından (outbound/merchant/self/sent) yoksa geometriden (sağa yaslı) çıkarılır.
 */
function readMessagesFn(): RawMsg[] {
  const sel = '[data-testid*="message" i]:not([data-testid*="list" i]), [class*="MessageBubble" i], [class*="message-bubble" i], [class*="bubble" i], [role="log"] > *, [role="log"] li';
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => !el.matches('textarea, [contenteditable="true"], form, button'));
  // iç içe eşleşmelerde en içteki balonu al (bir başka eşleşeni kapsayanlar elensin)
  const leaves = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  const root = document.querySelector('[role="log"], main, [role="main"]') ?? document.body;
  const rect = root.getBoundingClientRect();
  const out: RawMsg[] = [];
  for (const el of leaves) {
    const timeEl = el.querySelector<HTMLElement>('time, [datetime], [title*=":"]');
    const when = timeEl?.getAttribute('datetime') ?? timeEl?.getAttribute('title') ?? timeEl?.innerText?.trim() ?? '';
    const text = (el.innerText ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && s !== when.trim())
      .join('\n')
      .slice(0, 4000);
    if (!text) continue;
    const cls = `${el.className} ${el.parentElement?.className ?? ''} ${el.getAttribute('data-testid') ?? ''}`;
    let me: boolean | undefined = /outbound|merchant|self|mine|sent-by-me|from-me|right/i.test(cls) ? true : /inbound|customer|visitor|received|left/i.test(cls) ? false : undefined;
    if (me === undefined) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && rect.width > 0) me = r.left + r.width / 2 > rect.left + rect.width * 0.55;
    }
    const sender = el.querySelector<HTMLElement>('[class*="author" i], [class*="sender" i], [data-testid*="author" i]')?.innerText?.trim();
    out.push({ text, when, me, sender });
  }
  return out;
}

/** Tarayıcı içinde: mesaj alanını en üste kaydır (daha eski mesajlar için) */
function scrollTopFn(): boolean {
  const first = document.querySelector('[data-testid*="message" i], [class*="bubble" i], [role="log"]');
  let el: HTMLElement | null = (first?.parentElement as HTMLElement | null) ?? null;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** Tarayıcı içinde: yanıt kutusunu bul ve odakla. DOĞRULANMADI (textarea / contenteditable / role=textbox) */
function focusComposerFn(): boolean {
  const el = document.querySelector<HTMLElement>('[data-testid*="composer" i] textarea, [data-testid*="reply" i] textarea, textarea, [contenteditable="true"], [role="textbox"]');
  if (!el) return false;
  el.focus();
  return true;
}

/** Tarayıcı içinde: gönder düğmesine tıkla. DOĞRULANMADI */
function clickSendFn(): boolean {
  const b = document.querySelector<HTMLElement>('[data-testid*="send" i], button[aria-label*="Gönder" i], button[aria-label*="Send" i], form button[type="submit"]');
  if (!b) return false;
  b.click();
  return true;
}

/** DOM ham mesajlarını köprü mesajlarına çevir (kimlik: sohbet + çözülen zaman + gönderen + metin) */
export function toMessages(threadId: string, threadName: string, rows: RawMsg[], now = Date.now()): Msg[] {
  const msgs: Msg[] = [];
  let cursor: number | undefined;
  const dupes = new Map<string, number>();
  for (const r of rows) {
    const parsed = parseWhen(r.when, now);
    if (parsed !== undefined) cursor = parsed;
    // zaman çözülemedi: önceki mesajın zamanı + 1 ms (sıra korunur), hiç yoksa "şimdi"
    const ts = parsed ?? (cursor = cursor !== undefined ? cursor + 1 : now);
    const fromMe = r.me === true;
    const key = `${threadId}|${parsed ?? r.when}|${fromMe ? 'me' : r.sender ?? threadName}|${r.text}`;
    const n = dupes.get(key) ?? 0;
    dupes.set(key, n + 1);
    msgs.push({
      id: hashId(n ? `${key}#${n}` : key),
      text: r.text,
      ts,
      fromMe,
      senderId: fromMe ? 'me' : threadId,
      senderName: fromMe ? 'Ben' : r.sender || threadName || 'Müşteri',
      status: fromMe ? 'sent' : 'delivered',
    });
  }
  return msgs;
}

/** Ham satırı köprü sohbetine çevir */
export function toThread(r: RawThread, handle: string, now = Date.now()): Thread {
  return {
    id: r.id,
    name: r.name,
    kind: 'direct',
    // zaman çözülemezse 0: köprü depodaki değeri korur
    lastTs: parseWhen(r.when, now) ?? 0,
    preview: r.preview,
    unread: r.unread ? 1 : 0,
    link: r.href ? new URL(r.href, ADMIN).href : `${ADMIN}/store/${handle}/apps/inbox`,
  };
}

const listed = new Map<string, RawThread>(); // id → son görülen satır (open için ad/href)
let warnedEmpty = false;

/** Inbox sayfasında değilsek eve git; liste görünene dek (en fazla `timeout`) bekle */
async function ensureInbox(page: Page, home: string, timeout = 20_000): Promise<Doc> {
  if (!page.url().includes('/apps/inbox')) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const d = await inboxDoc(page);
    if (d !== page || (await page.evaluate(probeFn, { op: 'probe' } as Op).catch(() => false))) return d;
    await page.waitForTimeout(500);
  }
  return page;
}

/** Konuşmayı aç (URL'de zaten açıksa gezinme yok) ve mesajların çizilmesini bekle */
async function openThread(page: Page, home: string, id: string): Promise<Doc> {
  const doc = await ensureInbox(page, home);
  const here = page.url().includes(`/conversations/${id}`);
  if (!here) {
    const row = listed.get(id);
    const clicked = await doc.evaluate(openFn, { op: 'open', id, name: row?.name } as Op).catch(() => false);
    if (!clicked && row?.href) await page.goto(new URL(row.href, ADMIN).href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    else if (!clicked) throw new Error(`Shopify Inbox: sohbet satırı bulunamadı (${id})`);
    await page.waitForTimeout(1500);
  }
  // mesaj sayısı 2 okuma boyunca sabitlenene dek bekle (~1-3 sn)
  let last = -1;
  for (let i = 0; i < 12; i++) {
    const d = await inboxDoc(page);
    const n = ((await d.evaluate(readMessagesFn, { op: 'messages' } as Op).catch(() => [])) as RawMsg[]).length;
    if (n === last) return d;
    last = n;
    await page.waitForTimeout(250);
  }
  return inboxDoc(page);
}

/** Mağaza tanıtıcısına göre Inbox stratejisi. `getLabel`: hesap etiketi (Admin API'den gelen mağaza adı) korunsun diye */
export function makeShopifyInbox(handle: string, getLabel?: () => string | undefined): Strategy {
  const home = `${ADMIN}/store/${encodeURIComponent(handle)}/apps/inbox`;
  return {
    home,
    loginHint: 'Açılan pencerede Shopify hesabına giriş yap ve mağazayı seç (Inbox sohbetleri için); Inbox açılınca pencere kendiliğinden kapanır',

    async loggedIn(page, _cookies, passive) {
      const u = page.url();
      if (inAdmin(u)) return true;
      if (passive) return false; // görünür giriş penceresi: sayfayı yönlendirme
      if (/accounts\.shopify\.com|\/login/.test(u)) return false;
      // başka sayfadaysa (about:blank) bir kez eve git; giriş yoksa accounts.shopify.com'a yönlenir
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
      return inAdmin(page.url());
    },

    async me() {
      return { id: handle, label: getLabel?.() || handle };
    },

    async threads(page) {
      const doc = await ensureInbox(page, home);
      const rows = (await doc.evaluate(readThreadsFn, { op: 'threads' } as Op).catch(() => [])) as RawThread[];
      if (!rows.length) {
        if (!warnedEmpty) {
          warnedEmpty = true;
          bus.log('warn', `Shopify Inbox: sohbet listesi okunamadı (${page.url().slice(0, 90)}); seçiciler Inbox arayüzüne göre güncellenmeli (browser/shopify.ts)`);
        }
        return [];
      }
      warnedEmpty = false;
      for (const r of rows) listed.set(r.id, r);
      return rows.map((r) => toThread(r, handle));
    },

    async messages(page, _cookies, threadId, limit, before) {
      const doc = await openThread(page, home, threadId);
      if (before) {
        // eski mesajlar: bir kez en üste kaydır, yeni satırlar için kısa bekle
        if (await doc.evaluate(scrollTopFn, { op: 'scrollTop' } as Op).catch(() => false)) await page.waitForTimeout(1200);
      }
      const rows = (await doc.evaluate(readMessagesFn, { op: 'messages' } as Op).catch(() => [])) as RawMsg[];
      const name = listed.get(threadId)?.name ?? 'Müşteri';
      let msgs = toMessages(threadId, name, rows);
      if (before) msgs = msgs.filter((m) => m.ts < before);
      return msgs.slice(-limit);
    },

    async send(page, _cookies, threadId, text) {
      const doc = await openThread(page, home, threadId);
      if (!(await doc.evaluate(focusComposerFn, { op: 'focusComposer' } as Op).catch(() => false))) throw new Error('Shopify Inbox: yanıt kutusu bulunamadı');
      await page.keyboard.type(text, { delay: 5 });
      await page.waitForTimeout(200);
      if (!(await doc.evaluate(clickSendFn, { op: 'clickSend' } as Op).catch(() => false))) await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      // kimlik DOM'dan sonraki yoklamada üretilir; köprü yerel kopyayı (local-…) o zaman düşürür
      return undefined;
    },

    /** Inbox'ta sohbeti açmak platformda okundu sayılır */
    async markRead(page, _cookies, threadId) {
      await openThread(page, home, threadId).catch(() => undefined);
    },
  };
}

/** Testler için: modül durumunu sıfırla */
export function _resetShopifyInboxState(): void {
  listed.clear();
  warnedEmpty = false;
}
