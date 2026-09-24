import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { parseWhen } from './shopify.js';
import { bus } from '../../bus.js';

/**
 * Amazon Seller Central — Alıcı-Satıcı Mesajları (Buyer-Seller Messaging) tarayıcı köprüsü stratejisi.
 *
 * SP-API Messaging API yalnızca satıcıdan alıcıya şablonlu mesaj GÖNDERİR; alıcıdan gelen mesajları OKUYAN bir uç yoktur
 * (bkz. connectors/amazon.ts). Bu yüzden gelen kutusu Seller Central'ın mesajlaşma sayfasından
 * (https://<sellercentral host>/messaging/inbox) DOM okunarak alınır; yanıt da aynı sayfadaki yanıt kutusuyla gider.
 *
 * DOĞRULANMADI: Canlı bir Seller Central oturumu olmadan yazıldı. Aşağıdaki seçiciler Seller Central mesajlaşma
 * arayüzüne dair en makul tahminlerdir; her biri çoklu ve gevşek tutuldu (href deseni, data-* öznitelikleri, rol, sınıf adı
 * parçaları). Gerçek DOM'la ilk denemede uymayanlar `bus.log` uyarısıyla görünür ve bu dosyada güncellenmelidir.
 */

/** Pazar yeri tablosu: SP-API MarketplaceId → ülke, Amazon alan adı, Seller Central ana bilgisayarı, SP-API bölgesi (docs: marketplace-ids, seller-central-urls) */
export interface Marketplace {
  id: string;
  country: string;
  /** Mağaza alan adı (amazon.com.tr gibi); hesap etiketi ve sipariş bağlantısı için */
  domain: string;
  /** Seller Central ana bilgisayarı (mesajlaşma köprüsünün evi) */
  host: string;
  region: 'eu' | 'na' | 'fe';
}

const EU = 'sellercentral-europe.amazon.com';
export const MARKETPLACES: Record<string, Marketplace> = {
  // Avrupa / Orta Doğu / Hindistan / Afrika (uç: sellingpartnerapi-eu)
  A33AVAJ2PDY3EV: { id: 'A33AVAJ2PDY3EV', country: 'Türkiye', domain: 'amazon.com.tr', host: 'sellercentral.amazon.com.tr', region: 'eu' },
  A1PA6795UKMFR9: { id: 'A1PA6795UKMFR9', country: 'Almanya', domain: 'amazon.de', host: EU, region: 'eu' },
  A1F83G8C2ARO7P: { id: 'A1F83G8C2ARO7P', country: 'Birleşik Krallık', domain: 'amazon.co.uk', host: EU, region: 'eu' },
  A13V1IB3VIYZZH: { id: 'A13V1IB3VIYZZH', country: 'Fransa', domain: 'amazon.fr', host: EU, region: 'eu' },
  APJ6JRA9NG5V4: { id: 'APJ6JRA9NG5V4', country: 'İtalya', domain: 'amazon.it', host: EU, region: 'eu' },
  A1RKKUPIHCS9HS: { id: 'A1RKKUPIHCS9HS', country: 'İspanya', domain: 'amazon.es', host: EU, region: 'eu' },
  A1805IZSGTT6HS: { id: 'A1805IZSGTT6HS', country: 'Hollanda', domain: 'amazon.nl', host: 'sellercentral.amazon.nl', region: 'eu' },
  A2NODRKZP88ZB9: { id: 'A2NODRKZP88ZB9', country: 'İsveç', domain: 'amazon.se', host: 'sellercentral.amazon.se', region: 'eu' },
  A1C3SOZRARQ6R3: { id: 'A1C3SOZRARQ6R3', country: 'Polonya', domain: 'amazon.pl', host: 'sellercentral.amazon.pl', region: 'eu' },
  AMEN7PMS3EDWL: { id: 'AMEN7PMS3EDWL', country: 'Belçika', domain: 'amazon.com.be', host: 'sellercentral.amazon.com.be', region: 'eu' },
  A28R8C7NBKEWEA: { id: 'A28R8C7NBKEWEA', country: 'İrlanda', domain: 'amazon.ie', host: 'sellercentral.amazon.ie', region: 'eu' },
  AE08WJ6YKNBMC: { id: 'AE08WJ6YKNBMC', country: 'Güney Afrika', domain: 'amazon.co.za', host: 'sellercentral.amazon.co.za', region: 'eu' },
  ARBP9OOSHTCHU: { id: 'ARBP9OOSHTCHU', country: 'Mısır', domain: 'amazon.eg', host: 'sellercentral.amazon.eg', region: 'eu' },
  A17E79C6D8DWNP: { id: 'A17E79C6D8DWNP', country: 'Suudi Arabistan', domain: 'amazon.sa', host: 'sellercentral.amazon.sa', region: 'eu' },
  A2VIGQ35RCS4UG: { id: 'A2VIGQ35RCS4UG', country: 'BAE', domain: 'amazon.ae', host: 'sellercentral.amazon.ae', region: 'eu' },
  A21TJRUUN4KGV: { id: 'A21TJRUUN4KGV', country: 'Hindistan', domain: 'amazon.in', host: 'sellercentral.amazon.in', region: 'eu' },
  // Kuzey Amerika / Brezilya (uç: sellingpartnerapi-na)
  ATVPDKIKX0DER: { id: 'ATVPDKIKX0DER', country: 'ABD', domain: 'amazon.com', host: 'sellercentral.amazon.com', region: 'na' },
  A2EUQ1WTGCTBG2: { id: 'A2EUQ1WTGCTBG2', country: 'Kanada', domain: 'amazon.ca', host: 'sellercentral.amazon.ca', region: 'na' },
  A1AM78C64UM0Y8: { id: 'A1AM78C64UM0Y8', country: 'Meksika', domain: 'amazon.com.mx', host: 'sellercentral.amazon.com.mx', region: 'na' },
  A2Q3Y263D00KWC: { id: 'A2Q3Y263D00KWC', country: 'Brezilya', domain: 'amazon.com.br', host: 'sellercentral.amazon.com.br', region: 'na' },
  // Uzak Doğu (uç: sellingpartnerapi-fe)
  A1VC38T7YXB528: { id: 'A1VC38T7YXB528', country: 'Japonya', domain: 'amazon.co.jp', host: 'sellercentral.amazon.co.jp', region: 'fe' },
  A39IBJ37TRP1C6: { id: 'A39IBJ37TRP1C6', country: 'Avustralya', domain: 'amazon.com.au', host: 'sellercentral.amazon.com.au', region: 'fe' },
  A19VAU5U5O7RUS: { id: 'A19VAU5U5O7RUS', country: 'Singapur', domain: 'amazon.sg', host: 'sellercentral.amazon.sg', region: 'fe' },
};

export const DEFAULT_MARKETPLACE = 'A33AVAJ2PDY3EV'; // Türkiye

/** Pazar yeri kaydı; bilinmeyen kimlikte Türkiye */
export function marketplaceOf(id?: string): Marketplace {
  return MARKETPLACES[(id ?? '').trim()] ?? MARKETPLACES[DEFAULT_MARKETPLACE];
}

/** Pazar yerine göre Seller Central ana bilgisayarı */
export function sellerCentralHost(marketplaceId?: string): string {
  return marketplaceOf(marketplaceId).host;
}

/** Seller Central sayfası (giriş sayfasına düşmemiş). /ap/signin, /ap/mfa, /ap/cvf (doğrulama) → giriş yok */
const inSellerCentral = (url: string, host: string) => url.startsWith(`https://${host}/`) && !/\/ap\/(signin|mfa|cvf|register)|\/signin\b/.test(url);

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
  /** Satırda görünen sipariş numarası (3-7-7); sipariş sohbetiyle ilişkilendirme için */
  orderId?: string;
}

/** DOM'dan okunan ham mesaj */
export interface RawMsg {
  text: string;
  when: string;
  me: boolean | undefined;
  sender?: string;
}

// ─────────── Belge sondası ───────────
/**
 * Tarayıcı içinde: bu sayfada mesajlaşma DOM'u var mı?
 * DOĞRULANMADI — Seller Central mesajlaşma sayfasında iş parçacığı bağlantıları (/messaging/thread…), data-thread-id ya da
 * yanıt kutusu (textarea) olduğu varsayıldı.
 */
function probeFn(): boolean {
  const sel = 'a[href*="/messaging/thread"], a[href*="/messaging/inbox/"], a[href*="threadId="], [data-thread-id], [data-testid*="thread" i], [data-testid*="message" i], [role="log"], textarea, [contenteditable="true"]';
  return document.querySelector(sel) !== null;
}

// ─────────── Sohbet listesi ───────────
/**
 * Tarayıcı içinde çalışır: gelen kutusundaki konuşma satırlarını okur.
 * DOĞRULANMADI — satırların `a[href*="/messaging/thread/<id>"]` (ya da `?threadId=`) bağlantısı ya da `data-thread-id`
 * taşıdığı varsayıldı; yoksa liste öğeleri (tr / li / role=row / role=listitem) taranır ve kimlik addan üretilir.
 */
function readThreadsFn(): RawThread[] {
  const out: RawThread[] = [];
  const seenText = new Set<string>();
  const seenId = new Set<string>();
  const timeRe = /^(\d{1,2}:\d{2}|\d+\s?(sn|s|dk|m|sa|h|g|d|hf|w)|dün|yesterday|bugün|today|şimdi|now|az önce|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,}( \d{4})?|[A-Za-z]{3} \d{1,2}(, \d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i;
  const orderRe = /\b(\d{3}-\d{7}-\d{7})\b/;
  const cands = Array.from(document.querySelectorAll<HTMLElement>('a[href*="/messaging/thread"], a[href*="threadId="], [data-thread-id], [data-testid*="thread" i], tr[data-id], [role="row"], [role="listitem"], li'));
  for (const el of cands) {
    if (el.closest('[role="log"], [data-testid*="message-body" i], thead')) continue; // mesaj alanı / tablo başlığı değil
    const a = el.matches('a[href]') ? (el as HTMLAnchorElement) : el.querySelector<HTMLAnchorElement>('a[href*="/messaging/thread"], a[href*="threadId="], a[href*="/messaging/inbox/"]');
    const href = a?.getAttribute('href') ?? '';
    const m = href.match(/threadId=([\w-]+)/) ?? href.match(/\/messaging\/(?:thread|inbox|conversation)s?\/([\w-]+)/);
    let id = m?.[1] ?? el.getAttribute('data-thread-id') ?? el.getAttribute('data-id') ?? '';
    const lines = (el.innerText ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const key = lines.join('|');
    if (seenText.has(key)) continue;
    const when = lines.find((s) => timeRe.test(s)) ?? '';
    const rest = lines.filter((s) => s !== when && !/^\d+$/.test(s)); // salt sayı = okunmamış rozeti
    const name = rest[0] ?? '';
    if (!name || name.length > 80) continue;
    if (rest.length > 8) continue; // satır olmayan büyük kaplar (tüm liste tek li gibi) elensin
    const preview = rest.slice(1).join(' · ').slice(0, 200);
    const orderId = (el.innerText ?? '').match(orderRe)?.[1];
    if (!id) id = 'h' + String(Math.abs(Array.from(name).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)));
    if (seenId.has(id)) continue;
    seenId.add(id);
    seenText.add(key);
    // okunmamış: rozet/erişilebilirlik etiketi ya da kalın ad
    const badge = el.querySelector('[aria-label*="okunmamış" i], [aria-label*="unread" i], [class*="unread" i], [data-testid*="unread" i]');
    const first = el.querySelector<HTMLElement>('span, p, h2, h3, td, div');
    const bold = first ? (Number(getComputedStyle(first).fontWeight) || 400) >= 600 : false;
    out.push({ id, href: href || undefined, name, preview, when, unread: !!badge || bold, orderId });
  }
  return out;
}

/** Tarayıcı içinde: verilen sohbet satırına DOM tıklaması (href/data ya da ad eşleşmesi); tıklandıysa true. DOĞRULANMADI */
function openFn(arg: Op): boolean {
  const esc = arg.id ? CSS.escape(arg.id) : '';
  let el: HTMLElement | null = esc
    ? (document.querySelector<HTMLElement>(`a[href*="threadId=${esc}"]`) ?? document.querySelector<HTMLElement>(`a[href*="/messaging/thread/${esc}"]`) ?? document.querySelector<HTMLElement>(`[data-thread-id="${esc}"]`))
    : null;
  if (!el && arg.name) {
    el = Array.from(document.querySelectorAll<HTMLElement>('[role="row"], [role="listitem"], li, tr, a[href*="/messaging/"]')).find((x) => (x.innerText ?? '').trim().startsWith(arg.name!)) ?? null;
  }
  if (!el) return false;
  (el.querySelector<HTMLElement>('a, button') ?? el).click();
  return true;
}

// ─────────── Mesajlar ───────────
/**
 * Tarayıcı içinde çalışır: açık konuşmadaki mesajları okur.
 * DOĞRULANMADI — mesajların `data-testid*="message"` ya da sınıf adında "message"/"bubble" taşıdığı varsayıldı; "benim"
 * bilgisi sınıf adından (outbound/seller/sent) ya da gönderen etiketinden ("Siz"/"You"), yoksa geometriden (sağa yaslı) çıkarılır.
 */
function readMessagesFn(): RawMsg[] {
  const sel = '[data-testid*="message" i]:not([data-testid*="list" i]), [class*="message-item" i], [class*="MessageItem" i], [class*="message-body" i], [class*="bubble" i], [role="log"] > *, [role="log"] li';
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => !el.matches('textarea, [contenteditable="true"], form, button'));
  const leaves = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  const root = document.querySelector('[role="log"], main, [role="main"]') ?? document.body;
  const rect = root.getBoundingClientRect();
  const out: RawMsg[] = [];
  for (const el of leaves) {
    const timeEl = el.querySelector<HTMLElement>('time, [datetime], [title*=":"]');
    const when = timeEl?.getAttribute('datetime') ?? timeEl?.getAttribute('title') ?? timeEl?.innerText?.trim() ?? '';
    const sender = el.querySelector<HTMLElement>('[class*="author" i], [class*="sender" i], [class*="from" i], [data-testid*="author" i], [data-testid*="sender" i]')?.innerText?.trim();
    const text = (el.innerText ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && s !== when.trim() && s !== sender)
      .join('\n')
      .slice(0, 4000);
    if (!text) continue;
    const cls = `${el.className} ${el.parentElement?.className ?? ''} ${el.getAttribute('data-testid') ?? ''}`;
    let me: boolean | undefined = /outbound|seller|self|mine|sent-by-me|from-me|right/i.test(cls) ? true : /inbound|buyer|customer|received|left/i.test(cls) ? false : undefined;
    if (me === undefined && sender) me = /^(siz|you|ben|me)\b/i.test(sender) ? true : undefined;
    if (me === undefined) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && rect.width > 0) me = r.left + r.width / 2 > rect.left + rect.width * 0.55;
    }
    out.push({ text, when, me, sender });
  }
  return out;
}

/** Tarayıcı içinde: mesaj alanını en üste kaydır (daha eski mesajlar için) */
function scrollTopFn(): boolean {
  const first = document.querySelector('[data-testid*="message" i], [class*="bubble" i], [class*="message-item" i], [role="log"]');
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
  const el = document.querySelector<HTMLElement>('[data-testid*="reply" i] textarea, [data-testid*="composer" i] textarea, textarea[name*="message" i], textarea, [contenteditable="true"], [role="textbox"]');
  if (!el) return false;
  el.focus();
  return true;
}

/** Tarayıcı içinde: gönder düğmesine tıkla (data-testid, aria-label, submit ya da "Gönder"/"Send" metni). DOĞRULANMADI */
function clickSendFn(): boolean {
  let b = document.querySelector<HTMLElement>('[data-testid*="send" i], button[aria-label*="Gönder" i], button[aria-label*="Send" i], button[name*="send" i], form button[type="submit"], input[type="submit"]');
  if (!b) b = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => /^(gönder|send|yanıtla|reply)$/i.test((x.innerText ?? '').trim())) ?? null;
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
      senderName: fromMe ? 'Ben' : r.sender || threadName || 'Amazon alıcısı',
      status: fromMe ? 'sent' : 'delivered',
    });
  }
  return msgs;
}

/** Ham satırı köprü sohbetine çevir; sipariş numarası görünüyorsa handle'a yazılır (sipariş sohbetiyle eşleştirme) */
export function toThread(r: RawThread, host: string, now = Date.now()): Thread {
  const base = `https://${host}`;
  return {
    id: r.id,
    name: r.name,
    kind: 'direct',
    lastTs: parseWhen(r.when, now) ?? 0, // çözülemezse 0: köprü depodaki değeri korur
    preview: r.preview,
    unread: r.unread ? 1 : 0,
    handle: r.orderId,
    link: r.href ? new URL(r.href, base).href : `${base}/messaging/inbox`,
  };
}

const listed = new Map<string, RawThread>(); // id → son görülen satır (open için ad/href)
let warnedEmpty = false;

/** Mesajlaşma sayfasında değilsek eve git; liste görünene dek (en fazla `timeout`) bekle */
async function ensureInbox(page: Page, home: string, timeout = 20_000): Promise<void> {
  if (!page.url().includes('/messaging/')) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(probeFn, { op: 'probe' } as Op).catch(() => false)) return;
    await page.waitForTimeout(500);
  }
}

/** Konuşmayı aç (URL'de zaten açıksa gezinme yok) ve mesajların çizilmesini bekle */
async function openThread(page: Page, home: string, host: string, id: string): Promise<void> {
  await ensureInbox(page, home);
  const u = page.url();
  const here = u.includes(`/messaging/thread/${id}`) || u.includes(`threadId=${id}`) || u.includes(`/messaging/inbox/${id}`);
  if (!here) {
    const row = listed.get(id);
    const clicked = await page.evaluate(openFn, { op: 'open', id, name: row?.name } as Op).catch(() => false);
    if (!clicked && row?.href) await page.goto(new URL(row.href, `https://${host}`).href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    else if (!clicked) throw new Error(`Amazon mesajları: sohbet satırı bulunamadı (${id})`);
    await page.waitForTimeout(1500);
  }
  // mesaj sayısı 2 okuma boyunca sabitlenene dek bekle (~1-3 sn)
  let last = -1;
  for (let i = 0; i < 12; i++) {
    const n = ((await page.evaluate(readMessagesFn, { op: 'messages' } as Op).catch(() => [])) as RawMsg[]).length;
    if (n === last) return;
    last = n;
    await page.waitForTimeout(250);
  }
}

/**
 * Seller Central mesajlaşma stratejisi. `host`: pazar yerinin Seller Central ana bilgisayarı (sellerCentralHost),
 * `getLabel`: hesap etiketi (API tarafının verdiği mağaza adı) korunsun diye.
 */
export function makeAmazonMessaging(host: string, getLabel?: () => string | undefined): Strategy {
  const home = `https://${host}/messaging/inbox`;
  return {
    home,
    loginHint: 'Açılan pencerede Amazon satıcı hesabına giriş yap (gerekirse doğrulama kodu) ve mağazayı seç; alıcı mesajları sayfası açılınca pencere kendiliğinden kapanır',
    unloadWhenIdle: true, // Seller Central ağır; yoklamalar arasında sayfa boşaltılır

    async loggedIn(page, _cookies, passive) {
      const u = page.url();
      if (inSellerCentral(u, host)) return true;
      if (passive) return false; // görünür giriş penceresi: sayfayı yönlendirme
      if (/\/ap\/|\/signin\b/.test(u)) return false;
      // başka sayfadaysa (about:blank) bir kez eve git; giriş yoksa /ap/signin'e yönlenir
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
      return inSellerCentral(page.url(), host);
    },

    async me() {
      return { id: host, label: getLabel?.() || host };
    },

    async threads(page) {
      await ensureInbox(page, home);
      const rows = (await page.evaluate(readThreadsFn, { op: 'threads' } as Op).catch(() => [])) as RawThread[];
      if (!rows.length) {
        if (!warnedEmpty) {
          warnedEmpty = true;
          bus.log('warn', `Amazon mesajları: sohbet listesi okunamadı (${page.url().slice(0, 90)}); seçiciler Seller Central arayüzüne göre güncellenmeli (browser/amazon.ts)`);
        }
        return [];
      }
      warnedEmpty = false;
      for (const r of rows) listed.set(r.id, r);
      return rows.map((r) => toThread(r, host));
    },

    async messages(page, _cookies, threadId, limit, before) {
      await openThread(page, home, host, threadId);
      if (before) {
        if (await page.evaluate(scrollTopFn, { op: 'scrollTop' } as Op).catch(() => false)) await page.waitForTimeout(1200);
      }
      const rows = (await page.evaluate(readMessagesFn, { op: 'messages' } as Op).catch(() => [])) as RawMsg[];
      const name = listed.get(threadId)?.name ?? 'Amazon alıcısı';
      let msgs = toMessages(threadId, name, rows);
      if (before) msgs = msgs.filter((m) => m.ts < before);
      return msgs.slice(-limit);
    },

    async send(page, _cookies, threadId, text) {
      await openThread(page, home, host, threadId);
      if (!(await page.evaluate(focusComposerFn, { op: 'focusComposer' } as Op).catch(() => false))) throw new Error('Amazon mesajları: yanıt kutusu bulunamadı');
      await page.keyboard.type(text, { delay: 5 });
      await page.waitForTimeout(200);
      if (!(await page.evaluate(clickSendFn, { op: 'clickSend' } as Op).catch(() => false))) await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      // kimlik DOM'dan sonraki yoklamada üretilir; köprü yerel kopyayı (local-…) o zaman düşürür
      return undefined;
    },

    /** Seller Central'da sohbeti açmak platformda okundu sayılır */
    async markRead(page, _cookies, threadId) {
      await openThread(page, home, host, threadId).catch(() => undefined);
    },
  };
}

/** Testler için: modül durumunu sıfırla */
export function _resetAmazonMessagingState(): void {
  listed.clear();
  warnedEmpty = false;
}
