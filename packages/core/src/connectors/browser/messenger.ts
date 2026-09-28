import type { Page } from 'playwright';
import { hashId, LIGHTSPEED_EVENT, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import type { Attachment } from '../../model.js';

/**
 * Messenger: uçtan uca şifreleme varsayılan olduğundan iç API yerine DOM okunur.
 *
 * - Facebook çerezleri (c_user/xs) olsa da messenger.com ilk açılışta "<Ad> Olarak Devam Et" ara sayfasında
 *   kalır; gelen kutusu ancak bu düğmeye tıklanınca açılır. Düğme tek kullanımlık bir nonce ile giriş yapar:
 *   İKİ kez tıklanırsa ikinci istek login.php'ye düşürür — bu yüzden yalnızca bir kez tıklanır.
 * - Sohbet listesi sol kenardaki `/t/<id>/` bağlantılarından; kenar çubuğundaki gezinme bağlantıları
 *   (`?focus_target=`, /marketplace/t/, /requests/t/…) elenir. Okunmamış: ad kalın (≥600) ya da önizleme
 *   "Okunmamış mesaj:" önekli; Messenger sayı vermez → 1.
 * - Mesajlar `[role=main] [role=log]` içindeki `data-scope="messages_table"` öğelerinden okunur; aria-label
 *   "24 Aralık 2021 19:50, Sen: metin" (yalnızca medya: "24 Aralık 2021 20:35, Gülnur Korkmaz") biçiminde
 *   zaman + gönderen taşır. Tarih ayırıcıları ("24.12.2021 20:35"), profil başlığı ve sistem satırlarının
 *   aria-label'ı yoktur.
 * - Uçtan uca şifreli geçmiş: yeni cihazda Messenger "Sohbetlerini geri yüklemek için PIN kodunu gir" penceresi
 *   açar (her sohbette, ~0,5 sn sonra). PIN girilmeden eski mesajlar sunucudan gelmez; pencere tıklamaları
 *   yutar ama DOM okunabilir. Bu yüzden tüm tıklamalar DOM üzerinden (element.click()) yapılır.
 * Deneysel: arayüz değişince seçicilerin güncellenmesi gerekir.
 */
/**
 * İki adres: messenger.com Nisan 2026'da kapatılıp facebook.com/messages'a yönlendirilmeye başlandı. Önce facebook.com
 * denenir; gelen kutusu orada açılmazsa messenger.com'a düşülür. Çalışan adres hatırlanır (oturum boyunca), hangisinin
 * seçildiği günlüğe yazılır. Sohbet bağlantıları facebook.com'da `/messages/t/<id>/` (şifreli: `/messages/e2ee/t/<id>/`),
 * messenger.com'da `/t/<id>/` (`/e2ee/t/<id>/`); kimlik her iki adreste aynı sayısal id.
 */
export interface MessengerSite {
  key: 'facebook' | 'messenger';
  base: string;
  /** sohbet yolunun öneki: `${base}${prefix}/t/<id>/` */
  prefix: string;
}
export const SITES: MessengerSite[] = [
  { key: 'facebook', base: 'https://www.facebook.com', prefix: '/messages' },
  { key: 'messenger', base: 'https://www.messenger.com', prefix: '' },
];
let site: MessengerSite | undefined;
/** Şu an kullanılan adres (doğrulama betiği ve günlük için) */
export function messengerSite(): MessengerSite | undefined {
  return site;
}
/** URL hangi adrese ait? (yönlendirme sonrası gerçek adresi bulmak için) */
export function siteOfUrl(url: string): MessengerSite | undefined {
  try {
    const h = new URL(url).hostname;
    if (/(^|\.)facebook\.com$/.test(h)) return SITES[0];
    if (/(^|\.)messenger\.com$/.test(h)) return SITES[1];
  } catch {
    /* geçersiz URL */
  }
  return undefined;
}
/** Kenar çubuğu bağlantısından sohbet kimliği: /t/1, /e2ee/t/1, /messages/t/1, /messages/e2ee/t/1 (sondaki / isteğe bağlı) */
export const THREAD_HREF = /^(?:\/messages)?(?:\/e2ee)?\/t\/(\d+)\/?$/;
/** Kimlik → son görülen bağlantı yolu (şifreli sohbetler /e2ee/ yolunda açılır) */
const hrefOf = new Map<string, string>();
const cur = (): MessengerSite => site ?? SITES[0];
/** Sohbet adresi: kenar çubuğunda görülen yol varsa o (aynı adresteyse), yoksa `${base}${prefix}/t/<id>/` */
export function threadUrl(id: string, s: MessengerSite = cur(), href = hrefOf.get(id)): string {
  if (href && (s.prefix ? href.startsWith(s.prefix + '/') : !href.startsWith('/messages/'))) return s.base + (href.endsWith('/') ? href : href + '/');
  return `${s.base}${s.prefix}/t/${id}/`;
}
const CHAT_LINK = 'a[href^="/t/"], a[href^="/e2ee/t/"], a[href^="/messages/t/"], a[href^="/messages/e2ee/t/"]';
const ROW = '[role="main"] [role="log"] [data-scope="messages_table"]';
const CONTINUE_RE = /Olarak Devam Et|Continue as/i;

/** Ara sayfadaki "<Ad> Olarak Devam Et" düğmesine (bir kez) DOM tıklaması; tıklandıysa true. */
async function clickContinue(page: Page): Promise<boolean> {
  return page
    .evaluate((re) => {
      const rx = new RegExp(re, 'i');
      const b = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find((x) => rx.test(x.textContent ?? ''));
      if (!b) return false;
      b.click();
      return true;
    }, CONTINUE_RE.source)
    .catch(() => false);
}

/** "Olarak Devam Et" ara sayfası varsa geç; gelen kutusu bağlantıları görünene dek bekle. */
async function ensureInbox(page: Page, timeout = 20_000): Promise<boolean> {
  const t0 = Date.now();
  let clicked = false;
  // Düğme sayfa yüklendikten birkaç saniye sonra çiziliyor: bağlantı ya da düğme görünene dek yokla
  while (Date.now() - t0 < timeout) {
    if (await page.locator(CHAT_LINK).count().catch(() => 0)) return true;
    if (!clicked && (await clickContinue(page))) {
      bus.log('info', 'Messenger: "Devam Et" ara sayfası geçiliyor');
      clicked = true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** Mesaj satırları görünene dek bekle; arada "Devam Et" ara sayfası çıkarsa geç. Satır sayısı 2 okuma boyunca sabitlenince döner. */
async function waitForRows(page: Page, timeout: number): Promise<number> {
  const t0 = Date.now();
  let clicked = false;
  let last = -1;
  while (Date.now() - t0 < timeout) {
    const n = await page.locator(ROW).count().catch(() => 0);
    if (n > 0 && n === last) return n; // 200 ms boyunca değişmedi: çizim bitti
    if (n === 0 && !clicked && (await clickContinue(page))) {
      bus.log('info', 'Messenger: "Devam Et" ara sayfası geçiliyor');
      clicked = true;
    }
    // boş sohbet (yazı kutusu var, mesaj yok): 4 sn sonra bekleme
    if (n === 0 && Date.now() - t0 > 4000 && (await page.locator('[role="main"] div[role="textbox"]').count().catch(() => 0))) return 0;
    last = n;
    await page.waitForTimeout(200);
  }
  return Math.max(last, 0);
}

let pinWarned = false;
/** Uçtan uca şifreli geçmiş için PIN isteyen pencere açık mı? (Eski mesajlar PIN girilmeden yüklenemez.) */
async function pinDialogOpen(page: Page): Promise<boolean> {
  const open = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(
        (d) => /PIN/.test(d.innerText) && (d.querySelector('input') !== null || /geri yükle|restore/i.test(d.innerText)),
      ),
    )
    .catch(() => false);
  if (open && !pinWarned) {
    pinWarned = true;
    bus.log('warn', 'Messenger: sohbet geçmişi uçtan uca şifreli ve bu cihazda PIN girilmemiş ("Sohbetlerini geri yüklemek için PIN kodunu gir"). Eski mesajlar PIN girilene dek yüklenemez; yalnızca ekranda olanlar okunur.');
  }
  return open;
}

/**
 * Sohbeti aç ve mesaj satırlarını bekle. Zaten açıksa gezinme yok. Sabit bekleme yerine satırlar çizilene
 * dek yoklanır (~1,5-2,5 sn). Tıklama yerine goto: PIN penceresi açıkken Playwright tıklamaları engellenir.
 */
async function openThread(page: Page, id: string): Promise<void> {
  const here = new RegExp(`/t/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?:[?#]|$)`).test(page.url());
  if (!here) await page.goto(threadUrl(id), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const n = await waitForRows(page, here ? 5_000 : 15_000);
  if (n === 0 && !here) {
    // ara sayfa geç açılmış olabilir: gelen kutusunu bekle, sonra bir kez daha dene
    if (await ensureInbox(page, 10_000)) {
      if (!new RegExp(`/t/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?:[?#]|$)`).test(page.url())) await page.goto(threadUrl(id), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForRows(page, 10_000);
    }
  }
  void pinDialogOpen(page); // yalnızca uyarı (bir kez); okuma engellenmez
}

/** Mesaj alanının kaydırma kabı (overflow-y auto olan en yakın ata) — en üste kaydır; kaydırılabildiyse true. */
function scrollLogToTop(page: Page): Promise<boolean> {
  return page
    .evaluate((sel) => {
      let el = document.querySelector<HTMLElement>(sel)?.parentElement ?? null;
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
    }, ROW)
    .catch(() => false);
}

/**
 * Daha eski mesajları yükle: mesaj alanını en üste kaydır, yeni satır gelmesini bekle (2-3 tur).
 * Sohbetin başı (profil başlığı satırı) görünüyorsa ya da PIN penceresi açıksa (sunucudan geçmiş gelmez) durur.
 */
async function loadOlder(page: Page, rounds = 3): Promise<void> {
  if (await pinDialogOpen(page)) return;
  for (let i = 0; i < rounds; i++) {
    const before = await page.locator(ROW).count().catch(() => 0);
    // sohbetin başı: aria-label'sız profil başlığı satırı (adı taşıyan dolu h1-h4; mesaj satırlarındaki h3 boştur)
    const atStart = await page
      .evaluate((sel) => {
        const first = document.querySelector(sel);
        return !!first && !first.getAttribute('aria-label') && Array.from(first.querySelectorAll('h1, h2, h3, h4')).some((h) => (h.textContent ?? '').trim().length > 0);
      }, ROW)
      .catch(() => false);
    if (atStart || !(await scrollLogToTop(page))) return;
    // yeni satırlar gelene dek en fazla 2 sn bekle
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < 2000) {
      await page.waitForTimeout(250);
      after = await page.locator(ROW).count().catch(() => 0);
      if (after > before) break;
    }
    if (after <= before) return;
    await page.waitForTimeout(300);
  }
}

/** Sayfadan okunan ham satır: aria-label + metin + ekler + geometri (ben mi). */
interface RawRow {
  aria: string;
  text: string;
  isDateBreak: boolean;
  /** sohbette "Görüldü" işareti var (giden mesajlar okundu) */
  seen?: boolean;
  me: boolean | undefined;
  avatar?: string;
  attachments: Attachment[];
}

function readRows(page: Page): Promise<RawRow[]> {
  return page.evaluate((sel) => {
    const main = document.querySelector('[role="main"]');
    const mainRect = (main ?? document.body).getBoundingClientRect();
    const out: RawRow[] = [];
    const isMediaImg = (img: HTMLImageElement) => {
      const src = img.getAttribute('src') ?? '';
      // /s32x32/ /p50x50/: CDN'in küçük avatar boyutları
      if (!/^https?:\/\//.test(src) || /emoji|\/images\/|safe_image|external\.|\/[sp]\d{1,2}x\d{1,2}\//.test(src)) return false;
      const alt = img.getAttribute('alt') ?? '';
      // "X'in profil fotoğrafı" (avatar) ve "gördü" göstergesi medya değildir; alt'taki "fotoğraf" yanıltmasın
      if (/profil|profile|avatar|gördü|seen/i.test(alt)) return false;
      if (/(göster|open|view) ?(photo|image)|fotoğraf|çıkartma|sticker|gif|resim|image/i.test(alt)) return true;
      const r = img.getBoundingClientRect();
      return r.width >= 48 && r.height >= 48; // avatar 28px, "gördü" 14px, emoji ≤ 32px
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const aria = el.getAttribute('aria-label') ?? '';
      const parts: string[] = [];
      for (const t of Array.from(el.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]'))) {
        const s = t.innerText?.trim();
        if (s && !parts.includes(s) && !parts.some((p) => p.includes(s))) parts.push(s);
      }
      const text = parts.join('\n').slice(0, 4000);
      const attachments: Attachment[] = [];
      const seen = new Set<string>();
      for (const img of Array.from(el.querySelectorAll('img'))) {
        if (!isMediaImg(img)) continue;
        const src = img.getAttribute('src')!;
        if (seen.has(src)) continue;
        seen.add(src);
        // video posteri ise ayrı ele alınır
        if (img.closest('video') || el.querySelector(`video[poster="${CSS.escape(src)}"]`)) continue;
        const mediaPage = img.closest('a[href*="/messenger_media/"]')?.getAttribute('href');
        attachments.push({ kind: 'image', url: src, link: src, name: img.getAttribute('alt') || undefined, page: mediaPage ? new URL(mediaPage, location.origin).href : undefined });
      }
      for (const v of Array.from(el.querySelectorAll('video'))) {
        const src = v.getAttribute('src') || v.querySelector('source')?.getAttribute('src') || '';
        const poster = v.getAttribute('poster') || '';
        const link = /^https?:\/\//.test(src) ? src : undefined;
        const url = /^https?:\/\//.test(poster) ? poster : undefined;
        attachments.push(link ? { kind: 'video', url, link, name: 'Video', mime: 'video/mp4' } : { kind: 'other', url, name: 'Video' });
      }
      for (const a of Array.from(el.querySelectorAll('audio'))) {
        const src = a.getAttribute('src') || a.querySelector('source')?.getAttribute('src') || '';
        attachments.push(/^https?:\/\//.test(src) ? { kind: 'audio', link: src, name: 'Sesli mesaj' } : { kind: 'other', name: 'Sesli mesaj' });
      }
      if (!attachments.some((a) => a.name === 'Sesli mesaj')) {
        const voice = Array.from(el.querySelectorAll<HTMLElement>('[aria-label]')).some((b) => /sesli mesaj|voice (message|clip)|ses kaydı|audio (message|clip)/i.test(b.getAttribute('aria-label') ?? ''));
        if (voice) attachments.push({ kind: 'other', name: 'Sesli mesaj' });
      }
      for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
        const href = a.getAttribute('href') ?? '';
        // dosya ekleri cdn.fbsbx.com'dan indirilir; /messenger_media/ fotoğraf sayfasıdır (görsel zaten alındı)
        if (!/^https?:\/\/(cdn\.)?fbsbx\.com\//.test(href) && !/[?&]dl=1/.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const name = a.innerText?.trim().split('\n')[0] || a.getAttribute('aria-label') || 'Dosya';
        attachments.push({ kind: 'file', link: href, name: name.slice(0, 120) });
      }
      const avatar = Array.from(el.querySelectorAll('img')).find((i) => {
        const r = i.getBoundingClientRect();
        const src = i.getAttribute('src') ?? '';
        return /^https?:\/\//.test(src) && !/emoji/.test(src) && r.width > 0 && r.width <= 40 && r.width >= 20 && i.getAttribute('alt') && !/gördü|seen/i.test(i.getAttribute('alt') ?? '');
      });
      const r = el.getBoundingClientRect();
      const isDateBreak = !aria && !!el.querySelector('[data-scope="date_break"]');
      // geometri yedeği: sağa yaslı balon = ben
      const me = r.width > 0 ? r.left + r.width > mainRect.left + mainRect.width * 0.6 : undefined;
      out.push({ aria, text, isDateBreak, me, avatar: avatar?.getAttribute('src') ?? undefined, attachments, seen: !!document.querySelector('[role="main"] [aria-label^="Görüldü"], [role="main"] [aria-label^="Seen"], [role="main"] img[alt^="Görüldü"], [role="main"] img[alt^="Seen"]') });
    }
    return out;
  }, ROW);
}

/** DOM satırlarını mesajlara çevir. Tarih ayırıcıları ve çözülen zamanlar sıradaki satırlar için "imleç" olur. */
function toMessages(threadId: string, rows: RawRow[]): Msg[] {
  const msgs: Msg[] = [];
  let cursor: number | undefined; // son bilinen zaman (satırlar kronolojik)
  const dupes = new Map<string, number>();
  let unparsedSample: string | undefined;
  for (const r of rows) {
    if (!r.aria) {
      // tarih ayırıcı ("24.12.2021 20:35", "Bugün 14:32"): sonraki mesajlar için zaman tabanı
      const t = r.isDateBreak || /^\S.{0,30}\d{1,2}:\d{2}$/.test(r.text.trim()) ? parseDate(r.text.trim()) : undefined;
      if (t !== undefined) cursor = t;
      continue; // profil başlığı / sistem satırı
    }
    const parsed = parseAria(r.aria);
    if (!parsed) continue;
    if (parsed.ts !== undefined) cursor = parsed.ts;
    else unparsedSample ??= r.aria.slice(0, 60);
    const fromMe = parsed.me;
    const text = (parsed.text ?? r.text).trim();
    if (!text && r.attachments.length === 0) continue;
    // Kimlik ham aria yerine çözülen zaman + gönderen + aria metninden: "Bugün 14:32" ertesi gün "Dün 14:32" olsa da
    // kimlik değişmez (yoksa aynı mesaj ikinci kez ve canlı bildirimle yazılır). send() de aynı anahtarı üretir.
    // Aynı dakikada aynı metin iki kez gönderilmişse anahtar özdeş olur: sıra numarasıyla ayır
    const key = msgKey(threadId, parsed.ts ?? r.aria, fromMe ? 'me' : parsed.sender, parsed.text ?? '');
    const n = dupes.get(key) ?? 0;
    dupes.set(key, n + 1);
    // zaman çözülemediyse önceki mesajın/ayırıcının zamanı (+1 ms); hiç yoksa satır sırası korunacak şekilde "şimdi"
    const ts = parsed.ts ?? (cursor = cursor !== undefined ? cursor + 1 : Date.now());
    msgs.push({
      id: hashId(n ? `${key}#${n}` : key),
      text,
      ts,
      fromMe,
      senderId: fromMe ? 'me' : threadId,
      senderName: fromMe ? 'Ben' : parsed.sender || 'Karşı taraf',
      senderAvatarUrl: fromMe ? undefined : r.avatar,
      attachments: r.attachments.length ? r.attachments : undefined,
      // sohbetin altında "Görüldü" işareti varsa benim tüm mesajlarım görülmüş demektir
      status: fromMe ? (rows.some((x) => x.seen) ? 'read' : 'sent') : 'delivered',
    });
  }
  if (unparsedSample && !dateWarned) {
    dateWarned = true;
    bus.log('warn', `Messenger: bazı mesajların zamanı çözülemedi (örnek: "${unparsedSample}"); önceki mesajın zamanı kullanıldı`);
  }
  return msgs;
}
let dateWarned = false;

/** Mesaj kimliği anahtarı: sohbet + zaman (ms ya da çözülemeyen ham aria) + gönderen ('me' ya da ad) + metin. */
function msgKey(threadId: string, ts: number | string, sender: string, text: string): string {
  return `${threadId}|${ts}|${sender.trim()}|${text.trim()}`;
}

/** Son görülen önizleme: değişmediyse lastTs=0 döner (depodaki zaman korunur), değiştiyse "şimdi". */
const lastPreview = new Map<string, string>();
/** threads()/moreThreads ile depoya yazılmış sohbetler (moreThreads yalnızca yenilerini döndürür) */
const listed = new Set<string>();

interface SidebarRow {
  id: string;
  name: string;
  preview: string;
  unread: boolean;
  avatarUrl?: string;
}

/** Kenar çubuğundaki sohbet satırları (`/t/<id>/` bağlantıları; sohbet penceresi içindekiler hariç) */
async function readSidebarRows(page: Page): Promise<SidebarRow[]> {
  const rows = await page.evaluate(({ sel, hrefRe }) => {
    const out: Array<{ id: string; href: string; name: string; preview: string; unread: boolean; avatarUrl?: string }> = [];
    const seen = new Set<string>();
    const mainLeft = document.querySelector('[role="main"]')?.getBoundingClientRect().left ?? window.innerWidth;
    const re = new RegExp(hrefRe);
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(sel))) {
      const href = a.getAttribute('href') ?? '';
      const m = href.match(re);
      if (!m || seen.has(m[1])) continue;
      if (a.getBoundingClientRect().left >= mainLeft) continue; // sohbet penceresi içindeki bağlantılar
      seen.add(m[1]);
      const spans = Array.from(a.querySelectorAll('span'))
        .map((s) => ({ t: s.textContent?.trim() ?? '', w: Number(getComputedStyle(s).fontWeight) || 400 }))
        // durum ("Şu An Aktif") ve zaman etiketleri ("4y", "12 dk", "14:32", "Çar") önizleme değildir
        .filter((s) => s.t.length > 0 && !/^(Şu An Aktif|Active now)$/i.test(s.t) && !/^(\d{1,2}:\d{2}|\d+\s?(sn|dk|sa|g|h|y|m|w|d|s)|Pzt|Sal|Çar|Per|Cum|Cmt|Paz|Mon|Tue|Wed|Thu|Fri|Sat|Sun|·)$/i.test(s.t));
      const nameSpan = spans.find((s) => s.w >= 500) ?? spans[0];
      const name = nameSpan?.t ?? m[1];
      let preview = spans.find((s) => s.t !== name)?.t ?? '';
      const unreadPrefix = /^(Okunmamış mesaj|Unread message):\s*/i;
      // okunmamış: ad kalın (Messenger 600; okunmuşta 500) ya da erişilebilirlik öneki. Sayı verilmez → 1
      const unread = (nameSpan?.w ?? 400) >= 600 || unreadPrefix.test(preview);
      preview = preview.replace(unreadPrefix, '').replace(/\s+/g, ' ').slice(0, 200);
      const avatarUrl = Array.from(a.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '').find((s) => /^https?:\/\//.test(s) && !/emoji/.test(s));
      out.push({ id: m[1], href, name, preview, unread, avatarUrl });
    }
    return out;
  }, { sel: CHAT_LINK, hrefRe: THREAD_HREF.source });
  for (const r of rows) hrefOf.set(r.id, r.href);
  return rows.map(({ href: _h, ...r }) => r);
}

/** Ham satır → sohbet; önizleme değiştiyse "şimdi", ilk görüşte/değişmediyse 0 (depodaki zaman kalır) */
function rowToThread(r: SidebarRow): Thread {
  const prev = lastPreview.get(r.id);
  lastPreview.set(r.id, r.preview);
  // ilk görüşte 0 → mesajlar çekilince gerçek zaman yazılır; sonraki yoklamada önizleme değiştiyse yeni mesaj (şimdi)
  const lastTs = prev !== undefined && prev !== r.preview ? Date.now() : 0;
  return { id: r.id, name: r.name, kind: 'direct' as const, lastTs, preview: r.preview, unread: r.unread ? 1 : 0, avatarUrl: r.avatarUrl };
}

/**
 * Kenar çubuğundaki sohbet listesini sona kaydır. Kap: bir sohbet satırının overflow:auto olan en yakın atası
 * (soldaki gezinme çubuğundaki "Sohbetler" bağlantısı da /t/ ile başlar; o yüzden satır role=row içinden aranır).
 * Kaydırılabilir kap yoksa false.
 */
function scrollSidebar(page: Page): Promise<boolean> {
  return page
    .evaluate(({ sel, hrefRe }) => {
      const re = new RegExp(hrefRe);
      const mainLeft = document.querySelector('[role="main"]')?.getBoundingClientRect().left ?? window.innerWidth;
      const row = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel)).find((a) => re.test(a.getAttribute('href') ?? '') && a.getBoundingClientRect().left < mainLeft && a.closest('[role="row"], [role="grid"]'));
      let el: HTMLElement | null = row ?? null;
      while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          return true;
        }
        el = el.parentElement;
      }
      return false;
    }, { sel: CHAT_LINK, hrefRe: THREAD_HREF.source })
    .catch(() => false);
}

/** Kenar çubuğundaki ilk sohbeti aç ve PIN penceresinin açılıp açılmadığını bildir (ilk sohbet yoksa false). */
async function pinPendingOnFirstThread(page: Page): Promise<boolean> {
  if (!(await goInbox(page))) return false;
  const id = (await readSidebarRows(page).catch(() => []))[0]?.id;
  if (!id) return false;
  await openThread(page, id);
  await page.waitForTimeout(1500); // pencere satırlardan ~0,5 sn sonra çiziliyor
  return pinDialogOpen(page);
}

/**
 * Gelen kutusuna git (gerekirse). Adres henüz seçilmediyse önce facebook.com/messages, olmazsa messenger.com denenir;
 * yönlendirme olursa (messenger.com → facebook.com) varılan adres esas alınır. Seçilen adres sayfa bu adresteyken
 * yeniden gezinmeye yol açmaz (her yoklamada tam sayfa yüklemesi yok).
 */
async function goInbox(page: Page, timeout = 20_000): Promise<boolean> {
  const here = siteOfUrl(page.url());
  // facebook.com'un ana akışında sohbet bağlantısı yok: yalnız /messages altındaysak yerinde bekle (boşuna 20 sn beklenmesin)
  const onInbox = here && site && here.key === site.key && (here.prefix === '' || safeUrl(page.url()).replace(here.base, '').startsWith(here.prefix + '/'));
  if (onInbox && (await ensureInbox(page, timeout))) return true;
  const order = site ? [site, ...SITES.filter((x) => x.key !== site!.key)] : SITES;
  for (const cand of order) {
    await page.goto(`${cand.base}${cand.prefix}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    const landed = siteOfUrl(page.url()) ?? cand;
    if (await ensureInbox(page, timeout)) {
      if (site?.key !== landed.key) bus.log('info', `Messenger: gelen kutusu ${landed.key === 'facebook' ? 'facebook.com/messages' : 'messenger.com'} üzerinden okunuyor`);
      site = landed;
      return true;
    }
    bus.log('info', `Messenger: ${cand.base}${cand.prefix}/ gelen kutusunu açmadı (${safeUrl(page.url())}), diğer adres deneniyor`);
    // yönlendirmeyle zaten diğer adrese varıldıysa onu ikinci kez deneme
    if (landed.key !== cand.key) break;
  }
  return false;
}

/** Günlüğe sorgusuz adres */
function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
}

/**
 * Köprüye ek kancalar (bridge.ts Strategy'ye eklendiğinde çağrılır; eklenene dek zararsız):
 * - needsWindow: kayıtlı oturum olsa da "Yeniden bağlan"da görünür pencere gerekiyor mu (PIN adımı bekliyor)?
 * - afterLogin: görünür pencere kapanmadan önce kullanıcının PIN'i girmesi için bekle (en fazla 3 dk).
 */
interface PinHooks {
  needsWindow(page: Page): Promise<boolean>;
  afterLogin(page: Page): Promise<void>;
  attention(page: Page): Promise<string | undefined>;
}

export const messenger: Strategy & PinHooks = {
  // giriş penceresi: Facebook girişi her iki adres için ortak (c_user/xs çerezleri); kapanan messenger.com'u açmıyoruz
  home: `${SITES[0].base}${SITES[0].prefix}/`,
  // Anlık: sayfanın kendi soketleri (mautrix-meta: DGW gateway.facebook.com/ws/lightspeed; şifreli sohbetler
  // web-chat-e2ee.facebook.com — çerçeveler opak, yalnız büyüklüğe bakılır) + kenar çubuğu önizlemeleri (DOM).
  watchSockets: [
    { url: /gateway\.facebook\.com\/ws\/lightspeed|edge-chat\.(facebook|messenger)\.com/, event: LIGHTSPEED_EVENT },
    { url: /web-chat-e2ee\.facebook\.com/, minBytes: 300 },
  ],
  watchSelector: CHAT_LINK,
  loginHint: 'Açılan pencerede Facebook hesabına giriş yap; "PIN kodunu gir" çıkarsa eski mesajlar için PIN\'ini gir',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.c_user && cookies.xs);
  },

  async needsWindow(page) {
    return pinPendingOnFirstThread(page).catch(() => false);
  },

  async attention() {
    // PIN penceresi bir sohbette görüldüyse (pinDialogOpen) PIN adımı tamamlanana dek
    return pinWarned ? 'Şifreli sohbet geçmişi için PIN gerekli; girilene dek eski mesajlar yüklenmez' : undefined;
  },
  async afterLogin(page) {
    if (!(await pinPendingOnFirstThread(page).catch(() => false))) return;
    bus.log('info', 'Messenger: açık pencerede "PIN kodunu gir" adımı bekleniyor (eski mesajlar için). 3 dk içinde girilmezse atlanır.');
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000 && !page.isClosed()) {
      await page.waitForTimeout(2000).catch(() => undefined); // pencere bu arada kapanırsa hata fırlatmasın
      if (page.isClosed()) return;
      if (!(await pinDialogOpen(page))) {
        bus.log('info', 'Messenger: PIN adımı tamamlandı, sohbet geçmişi geri yüklenebilir');
        pinWarned = false; // sonraki yoklamalarda pencere yeniden çıkarsa uyarı tekrar düşsün
        return;
      }
    }
  },

  async me(page, cookies) {
    return { id: cookies.c_user ?? '', label: (await facebookName(page).catch(() => '')) || 'Messenger' };
  },

  async threads(page): Promise<Thread[]> {
    const ready = await goInbox(page);
    if (!ready) {
      const title = await page.title().catch(() => '?');
      bus.log('warn', `Messenger: sohbet listesi bulunamadı (sayfa: ${page.url()} · "${title}"). Görünmez modda engelleniyorsa kanala sağ tık → Yeniden bağlan ile pencereyi açıp deneyin.`);
      return [];
    }
    // kenar çubuğu parça parça çiziliyor (ilk ~15, 1-2 sn sonra ~20 sohbet): bağlantı sayısı ~1,4 sn sabit kalana dek bekle
    let prevCount = -1;
    let stable = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 6_000 && stable < 4; ) {
      await page.waitForTimeout(350);
      const n = await page.locator(CHAT_LINK).count().catch(() => 0);
      stable = n === prevCount ? stable + 1 : 0;
      prevCount = n;
    }
    const rows = await readSidebarRows(page);
    if (rows.length === 0) bus.log('warn', `Messenger: gelen kutusu açık ama sohbet bağlantısı okunamadı (${page.url()})`);
    for (const r of rows) listed.add(r.id);
    return rows.map(rowToThread);
  },

  /**
   * Daha eski sohbetler: kenar çubuğundaki sohbet listesinin kaydırma kabı (bir sohbet satırının overflow:auto atası;
   * soldaki gezinme çubuğu değil) sona kaydırılır, Messenger yeni satırları ekler (liste sanal değil, büyür).
   * Daha önce listelenmemiş satırlar döner; kaydırma yeni satır getirmiyorsa boş dizi.
   * (Profil kopyasıyla doğrulandı: 14 → 19 → 24 sohbet.)
   */
  async moreThreads(page): Promise<Thread[]> {
    if (!(await goInbox(page))) return [];
    let fresh: SidebarRow[] = [];
    // Messenger ilk kaydırmada her zaman yüklemez (gözlem: 1. tur 14→14, 2. tur 14→19): art arda iki tur boş kalınca durulur
    for (let round = 0, idle = 0; round < 6 && !fresh.length && idle < 2; round++) {
      const before = await page.locator(CHAT_LINK).count().catch(() => 0);
      if (!(await scrollSidebar(page))) break;
      // yeni bağlantılar gelene dek en çok 3 sn bekle
      let grew = false;
      for (const t0 = Date.now(); Date.now() - t0 < 3000 && !grew; ) {
        await page.waitForTimeout(400);
        grew = (await page.locator(CHAT_LINK).count().catch(() => 0)) > before;
      }
      idle = grew ? 0 : idle + 1;
      if (!grew) continue;
      await page.waitForTimeout(600); // satırlar parça parça çiziliyor
      fresh = (await readSidebarRows(page)).filter((r) => !listed.has(r.id));
    }
    for (const r of fresh) listed.add(r.id);
    return fresh.map(rowToThread);
  },

  /**
   * Dosya/fotoğraf: sohbet açıkken yazı kutusunun yanındaki gizli `input[type=file]` (multiple, accept yok;
   * "Boyutu en fazla 25 MB olan bir dosya ekle" düğmesi) dosyayı alır, önizleme çizilince Enter gönderir.
   * Açıklama varsa aynı mesajda metin olarak gider. (Giriş profil kopyasıyla doğrulandı; gönderim canlı denenmedi.)
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    await openThread(page, threadId);
    const box = page.locator('[role="main"] div[role="textbox"][contenteditable="true"]').first();
    await box.waitFor({ timeout: 15_000 });
    const input = page.locator('[role="main"] input[type="file"]').last();
    if (!(await input.count().catch(() => 0))) throw new Error('Messenger: sohbette dosya girişi bulunamadı');
    await input.setInputFiles(file.path);
    await page.waitForTimeout(1500); // önizleme (küçük resim / dosya kartı)
    const now = new Date();
    if (caption) await box.fill(caption, { timeout: 10_000 });
    else await box.focus().catch(() => undefined);
    await page.keyboard.press('Enter');
    // yükleme bitene dek: kutu boşalır ve önizleme kalkar (en fazla ~dosya boyutuna göre)
    const maxMs = Math.max(8_000, Math.min(180_000, file.size / 50));
    for (const t0 = Date.now(); Date.now() - t0 < maxMs; ) {
      await page.waitForTimeout(400);
      const text = (await box.innerText({ timeout: 1_000 }).catch(() => '')).trim();
      const previews = await page.locator('[role="main"] [aria-label*="Eki kaldır"], [role="main"] [aria-label*="Remove attachment"], [role="main"] [aria-label*="Kaldır"], [role="main"] [aria-label*="Remove"]').count().catch(() => 0);
      if (!text && previews === 0) break;
    }
    const minute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime();
    return hashId(msgKey(threadId, minute, 'me', caption ?? ''));
  },

  /**
   * Sohbetin ekrandaki mesajları. `before` verilirse (eski mesaj yükleme) mesaj alanı yukarı kaydırılarak
   * daha eski satırlar çizdirilir ve yalnızca `before`'dan eski olanlar döner.
   */
  async messages(page, _cookies, threadId, limit, before): Promise<Msg[]> {
    await openThread(page, threadId);
    if (before !== undefined) {
      // DOM'da zaten yeterince eski satır yoksa yukarı kaydırarak yükle
      const have = toMessages(threadId, await readRows(page)).filter((m) => m.ts < before).length;
      if (have < limit) await loadOlder(page, 3);
    }
    let msgs = toMessages(threadId, await readRows(page));
    if (before !== undefined) msgs = msgs.filter((m) => m.ts < before);
    return msgs.slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    // Sohbeti açmak Messenger'da okundu sayılır; istemci okundu olayını yalnız sekme görünürken gönderir → görünür aç
    // (köprünün gizli sekme taklidi #mivelo-visible ile kapatılır), sonra normal sayfaya dönülür
    await page.goto(`${threadUrl(threadId)}#mivelo-visible`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await waitForRows(page, 15_000);
    await page.waitForTimeout(2500);
    // Görünür belgede kalınmasın: sohbet açık ve görünür kaldıkça sonraki gelen mesajlar anında "Görüldü" olur (goInbox/openThread
    // aynı adreste gezinmez, yumuşak yenileme hash'i korur). Yalnız hash değişimi aynı belgede kalır → gerçek gezinme (gelen kutusu).
    await page.goto(`${cur().base}${cur().prefix}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  },

  async send(page, _cookies, threadId, text) {
    await openThread(page, threadId);
    const box = page.locator('[role="main"] div[role="textbox"][contenteditable="true"]').first();
    // click yok: PIN penceresi açıkken tıklama engellenir (30 sn zaman aşımı); fill odaklayıp yazar
    const now = new Date();
    await box.fill(text, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    // kutu boşalana dek (gönderildi) en fazla 2 sn bekle
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250);
      if (!(await box.innerText({ timeout: 1_000 }).catch(() => '')).trim()) break;
    }
    // toMessages ile aynı anahtar (aria zamanı dakika çözünürlüklü): sonraki yoklama aynı mesajı ikinci kez yazmasın
    const minute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).getTime();
    return hashId(msgKey(threadId, minute, 'me', text));
  },
};

const MONTHS: Record<string, number> = {
  ocak: 0, şubat: 1, mart: 2, nisan: 3, mayıs: 4, haziran: 5, temmuz: 6, ağustos: 7, eylül: 8, ekim: 9, kasım: 10, aralık: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  pazar: 0, pazartesi: 1, salı: 2, çarşamba: 3, perşembe: 4, cuma: 5, cumartesi: 6,
  paz: 0, pzt: 1, sal: 2, çar: 3, per: 4, cum: 5, cmt: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * "24 Aralık 2021 19:50, Sen: metin" / "Dec 24, 2021, 7:50 PM, You: text" → zaman, gönderen, metin, ben mi.
 * Yalnızca medya taşıyan mesajlarda metin yoktur: "24 Aralık 2021 20:35, Gülnur Korkmaz".
 */
export function parseAria(aria: string): { ts?: number; sender: string; me: boolean; text?: string } | undefined {
  // metinli biçim: ":" + boşluk zorunlu ("7:50" saatine takılmasın)
  let m = aria.match(/^(.*?),\s*([^:,]{1,60}):\s([\s\S]*)$/);
  let text: string | undefined;
  let ts: number | undefined;
  if (m) {
    text = m[3];
    ts = parseDate(m[1]);
  } else {
    m = aria.match(/^(.*?),\s*([^:,]{1,60})$/);
    if (!m) return undefined;
    ts = parseDate(m[1]);
    if (ts === undefined) return undefined; // "tarih, gönderen" değilse (ör. "İlet, tepki" gibi başka etiket) atla
  }
  const sender = m[2].trim();
  const me = /^(Sen|You)$/i.test(sender);
  return { ts, sender, me, text };
}

/** Saat "19:50" ya da "7:50 PM" → [saat, dakika] */
function hm(h: string, min: string, ampm?: string): [number, number] {
  let hour = Number(h);
  if (ampm) hour = (hour % 12) + (/^(p|ös)/i.test(ampm) ? 12 : 0);
  return [hour, Number(min)];
}

/**
 * Messenger'ın tarih biçimleri (tr/en):
 *  "24 Aralık 2021 19:50" · "24 Aralık 19:50" · "24.12.2021 20:35" · "Bugün 14:32" · "Dün 09:10" · "Sal 18:20" · "18:20"
 *  "Dec 24, 2021, 7:50 PM" · "Dec 24, 7:50 PM" · "Today at 7:50 PM" · "Yesterday 9:10 AM" · "Tue 6:20 PM" · "6:20 PM"
 */
export function parseDate(input: string, now = new Date()): number | undefined {
  const s = input.trim().replace(/\s+/g, ' ');
  const TIME = '(\\d{1,2})[:.](\\d{2})\\s*(AM|PM|ÖÖ|ÖS)?';
  // yıl bir kez geçerse ve gelecekte kalırsa (yılı olmayan biçimler) bir yıl geri al
  const build = (y: number, mo: number, d: number, h: number, mi: number, guessYear = false) => {
    let t = new Date(y, mo, d, h, mi).getTime();
    if (guessYear && t > now.getTime() + 60_000) t = new Date(y - 1, mo, d, h, mi).getTime();
    return t;
  };
  let m = s.match(new RegExp(`^(\\d{1,2}) ([A-Za-zÇĞİÖŞÜçğıöşü]+),? (\\d{4}),? ${TIME}$`, 'i'));
  if (m) {
    const mon = MONTHS[m[2].toLocaleLowerCase('tr')] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return build(Number(m[3]), mon, Number(m[1]), ...hm(m[4], m[5], m[6]));
  }
  m = s.match(new RegExp(`^(\\d{1,2}) ([A-Za-zÇĞİÖŞÜçğıöşü]+),? ${TIME}$`, 'i'));
  if (m) {
    const mon = MONTHS[m[2].toLocaleLowerCase('tr')] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return build(now.getFullYear(), mon, Number(m[1]), ...hm(m[3], m[4], m[5]), true);
  }
  m = s.match(new RegExp(`^(\\d{1,2})[./](\\d{1,2})[./](\\d{4}),? ${TIME}$`));
  if (m) return build(Number(m[3]), Number(m[2]) - 1, Number(m[1]), ...hm(m[4], m[5], m[6]));
  m = s.match(new RegExp(`^([A-Za-z]{3})[a-z]*\\.? (\\d{1,2}),? (\\d{4}),? (?:at )?${TIME}$`, 'i'));
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon !== undefined) return build(Number(m[3]), mon, Number(m[2]), ...hm(m[4], m[5], m[6]));
  }
  m = s.match(new RegExp(`^([A-Za-z]{3})[a-z]*\\.? (\\d{1,2}),? (?:at )?${TIME}$`, 'i'));
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon !== undefined) return build(now.getFullYear(), mon, Number(m[2]), ...hm(m[3], m[4], m[5]), true);
  }
  m = s.match(new RegExp(`^(Bugün|Today|Dün|Yesterday|[A-Za-zÇĞİÖŞÜçğıöşü]+),? (?:at |saat )?${TIME}$`, 'i'));
  if (m) {
    const w = m[1].toLocaleLowerCase('tr');
    const [h, mi] = hm(m[2], m[3], m[4]);
    let back: number | undefined;
    if (w === 'bugün' || w === 'today') back = 0;
    else if (w === 'dün' || w === 'yesterday') back = 1;
    else {
      const wd = WEEKDAYS[w] ?? WEEKDAYS[w.slice(0, 3)] ?? WEEKDAYS[m[1].slice(0, 3).toLowerCase()];
      if (wd !== undefined) back = (now.getDay() - wd + 7) % 7 || 7; // bu hafta içindeki son o gün
    }
    if (back !== undefined) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, mi).getTime();
  }
  m = s.match(new RegExp(`^${TIME}$`, 'i'));
  if (m) {
    const [h, mi] = hm(m[1], m[2], m[3]);
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi).getTime();
    return t > now.getTime() + 60_000 ? t - 86_400_000 : t; // saat henüz gelmediyse dünkü
  }
  // Yedek: V8'in Date.parse'ı gevşektir ("Mesaj 2021" → 2021 yılı!); yalnızca saat içeren kısa dizgeler için dene
  if (s.length > 40 || !/\d{1,2}[:.]\d{2}/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Oturum sahibinin adı (+ kullanıcı adı): facebook.com/me profile yönlendirir; sayfa başlığı "Ad | Facebook",
 *  son adres /<kullanıcı-adı> (profile.php?id= ise kullanıcı adı yok). Tarayıcı bağlamının istek bağlamı (aynı çerezler). */
async function facebookName(page: Page): Promise<string> {
  const r = await page.context().request.get('https://www.facebook.com/me', { timeout: 20_000 });
  const html = await r.text();
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '').replace(/\s*\|\s*Facebook\s*$/i, '').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').trim();
  const vanity = (r.url().match(/facebook\.com\/([A-Za-z0-9.]{3,})\/?(?:[?#]|$)/)?.[1] ?? '').replace(/^(profile\.php|login|checkpoint|me)$/i, '');
  const name = /^(facebook|log in|giriş yap)/i.test(title) ? '' : title;
  return [name, vanity && `@${vanity}`].filter(Boolean).join(' · ');
}
