import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { parseDate } from './messenger.js';
import { bus } from '../../bus.js';
import type { Attachment } from '../../model.js';

/**
 * TikTok (tiktok.com/messages): herkese açık bir DM API'si yok (yalnız onaylı işletme ortaklarına kapalı API), web istemcisinin
 * DOM'u okunur. DENEYSEL — gerçek hesapla DOĞRULANMADI. Seçiciler önce TikTok'un `data-e2e` test öznitelikleri (en kararlı
 * olanlar), sonra sınıf adı parçaları (`InfoNickname`, `InfoExtract`…), en son geometri. İlk turda `TikTok tanı:` günlüğü yazılır
 * (seçici sayıları + sohbetle ilgili data-e2e adları; içerik YOK) → seçiciler buna göre ayarlanır.
 *
 * - Oturum: `sessionid` / `sid_tt` çerezi. Kimlik: sayfadaki `__UNIVERSAL_DATA_FOR_REHYDRATION__` → webapp.app-context.user.
 * - Sohbet listesi `[data-e2e="chat-list-item"]`: satırda bağlantı/kimlik yok → kimlik görünen addan (aynı adlı ikinciye #2);
 *   sohbet açılınca başlıktaki @kullanıcı adı öğrenilir (handle + profil bağlantısı).
 * - Mesajlar `[data-e2e="chat-item"]`, zaman ayırıcıları sonraki mesajların zamanı (Messenger'daki gibi imleç; "Bugün 14:32" ertesi
 *   gün "Dün 14:32" olsa da çözülen mutlak zaman aynı → kimlik değişmez). Ben: kendi profil bağlantım ya da sağa yaslı balon.
 * - Paylaşılan TikTok videosu (DM'lerin çoğu): kapak görseli + video sayfası bağlantısı eki.
 * - Gönderim: Draft.js düzenleyicisi → klavyeyle yaz (satır arası Shift+Enter) → gönder düğmesi / Enter.
 * - Okumak için sohbet açılır: TikTok karşı tarafa "Görüldü" gösterebilir; yalnız önizlemesi değişen sohbetler açılır (köprü).
 * - Doğrulama (kaydırmalı captcha) çıkarsa yoklama durur ('captcha' → köprü 'pairing'); Yeniden bağlan görünür pencerede tamamlatır.
 */
const HOME = 'https://www.tiktok.com/messages';
// data-e2e önce; TikTok zaman zaman test özniteliklerini kaldırıyor → bileşen sınıf adı parçaları yedek (css-<hash>-DivItemWrapper…).
// İç içe eşleşmeler (satırın içindeki alt parça) `outer()` ile elenir: yalnız en dıştaki satır sayılır.
const LIST_ITEM =
  '[data-e2e="chat-list-item"], [data-e2e="conversation-item"], [class*="DivItemWrapper"][class*="Chat"], [class*="ChatListItem"], [class*="ConversationItem"], [class*="ConversationListItem"]';
const MSG_ITEM =
  '[data-e2e="chat-item"], [data-e2e="message-item"], [class*="DivChatItemWrapper"], [class*="ChatItemWrapper"], [class*="MessageItemWrapper"], [class*="DivMessageContainer"]';
const TIME_SEP = '[data-e2e="chat-time"], [class*="TimeContainer"], [class*="DivTimeWrapper"]';
const INPUT = '[data-e2e="message-input-area"] [contenteditable="true"], [data-e2e="message-input-area"] textarea, [class*="DraftEditor-root"] [contenteditable="true"]';
const SEND_BTN = '[data-e2e="message-send"]';
const CAPTCHA = '#captcha_container, #captcha-verify-container-main-page, .captcha_verify_container, [class*="captcha_verify"], [id*="secsdk-captcha"]';

/** Oturum sahibinin TikTok kullanıcı adı (me() doldurur): kendi mesajlarımı profil bağlantısından tanımak için */
let myHandle = '';
/** Sohbet kimliği → açılınca başlıkta görülen @kullanıcı adı */
const handles = new Map<string, string>();
/** Son görülen önizleme: değiştiyse sohbette yeni etkinlik ("şimdi") */
const lastPreview = new Map<string, string>();
/** Sohbetin son bilinen zamanı (önizleme değişmedikçe sabit): göreli liste zamanı ("1 g", "2h") her turda yeniden hesaplanınca
 *  zaman kayıyor → köprü değişmeyen sohbeti her turda "değişti" sayıp açıyordu ("Görüldü" riski) ve sohbet listede üste çıkıyordu */
const stableTs = new Map<string, number>();

interface ListRow {
  name: string;
  preview: string;
  time: string;
  unread: number;
  avatarUrl?: string;
}

/** Captcha / "çok fazla deneme" sayfası: köprünün sınıflandırıcısı bu metinlerle yoklamayı durdurur ya da bekletir */
async function assertUsable(page: Page): Promise<void> {
  if (await page.locator(CAPTCHA).count().catch(() => 0)) throw new Error('TikTok doğrulama istiyor (captcha): Yeniden bağlan ile pencerede tamamla');
  const tooMany = await page
    .evaluate(() => /too many attempts|çok fazla (deneme|istek)|maximum number of attempts/i.test(document.body?.innerText?.slice(0, 4000) ?? ''))
    .catch(() => false);
  if (tooMany) throw new Error('TikTok: 429 rate limit (çok fazla istek)');
}

/** Mesajlar sayfasını aç ve sohbet listesi (ya da boş gelen kutusu) görünene dek bekle */
async function ensureInbox(page: Page, timeout = 20_000): Promise<boolean> {
  if (!/tiktok\.com\/messages/.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.locator(LIST_ITEM).count().catch(() => 0)) return true;
    await assertUsable(page);
    // boş gelen kutusu: yazı alanı ya da "mesaj yok" görünümü
    if (Date.now() - t0 > 6000 && (await page.locator('[data-e2e*="empty"], [class*="Empty"], [class*="NoMessage"]').count().catch(() => 0))) return true;
    if (/\/login/.test(page.url())) return false;
    await page.waitForTimeout(300);
  }
  return false;
}

let diagDone = false;
let msgDiagDone = false;
let listWarned = false;
/** Bir kez: seçici sayıları ve sohbetle ilgili data-e2e adları (içerik yazılmaz) → seçiciler gerçek sayfaya göre ayarlanır */
async function diagnose(page: Page): Promise<void> {
  if (diagDone) return;
  diagDone = true;
  const d = await page
    .evaluate(
      ({ list, item, input }) => {
        const n = (s: string) => document.querySelectorAll(s).length;
        const e2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e') ?? '')))
          .filter((k) => /chat|message|inbox|dm|conversation|msg/i.test(k))
          .slice(0, 40);
        // bileşen adları (css-<hash>-DivChatBox → DivChatBox): sohbetle ilgili sınıf parçaları ve sayıları — metin/içerik YOK
        const parts = new Map<string, number>();
        for (const e of Array.from(document.querySelectorAll('[class]')).slice(0, 6000)) {
          for (const c of (e.getAttribute('class') ?? '').split(/\s+/)) {
            const m = c.match(/^(?:css|tiktok)-[\w]+-(\w+)$/);
            const k = m ? m[1] : '';
            if (k && /chat|message|conversation|inbox|msg|item|list|nick|extract|time|unread/i.test(k)) parts.set(k, (parts.get(k) ?? 0) + 1);
          }
        }
        const cls = [...parts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`);
        const allE2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e') ?? ''))).slice(0, 60);
        const login = !!document.querySelector('[data-e2e="top-login-button"], [data-e2e*="login"]');
        return { path: location.pathname, title: document.title.slice(0, 60), bodyLen: document.body?.innerText.length ?? 0, login, list: n(list), items: n(item), input: n(input), e2e, allE2e, cls };
      },
      { list: LIST_ITEM, item: MSG_ITEM, input: INPUT },
    )
    .catch(() => undefined);
  if (d) bus.log('info', `TikTok tanı: ${JSON.stringify(d)}`);
}

function readList(page: Page): Promise<ListRow[]> {
  return page.evaluate((sel) => {
    const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const TIME_RE = /^(\d{1,2}[:.]\d{2}|\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?|dün|yesterday|pzt|sal|çar|per|cum|cmt|paz|mon|tue|wed|thu|fri|sat|sun|\d+\s*(dk|sa|g|gün|hf|m|min|h|d|w)\b.*)$/i;
    const out: ListRow[] = [];
    const all = Array.from(document.querySelectorAll(sel));
    for (const it of all.filter((e) => !e.parentElement?.closest(sel))) {
      const leaves = Array.from(it.querySelectorAll('p, span, div, strong'))
        .filter((e) => !e.children.length)
        .map((e) => txt(e))
        .filter(Boolean);
      let name = txt(it.querySelector('[data-e2e="chat-list-item-nickname"], [class*="InfoNickname"], [class*="Nickname"]')) || leaves[0] || '';
      const time = txt(it.querySelector('[data-e2e="chat-list-item-time"], [class*="InfoTime"], [class*="SpanTime"]')) || leaves.find((t) => TIME_RE.test(t)) || '';
      const badgeEl = it.querySelector('[data-e2e*="unread"], [class*="Unread"], [class*="NewMessage"], [class*="RedDot"], [class*="Badge"]');
      const badge = txt(badgeEl);
      let preview =
        txt(it.querySelector('[data-e2e="chat-list-item-message"], [class*="InfoExtract"], [class*="Extract"], [class*="LastMsg"]')) ||
        leaves.filter((t) => t !== name && t !== time && t !== badge && !TIME_RE.test(t)).sort((a, b) => b.length - a.length)[0] ||
        '';
      name = name.slice(0, 80);
      preview = preview.slice(0, 200);
      const avatarUrl = Array.from(it.querySelectorAll('img'))
        .map((i) => i.getAttribute('src') ?? '')
        .find((s) => /^https?:\/\//.test(s));
      out.push({ name, preview, time, unread: badgeEl ? Number(badge.replace(/\D/g, '')) || 1 : 0, avatarUrl });
    }
    return out;
  }, LIST_ITEM);
}

/** Liste satırlarının kimlikleri: görünen ad; aynı adlı ikinci/üçüncü sohbete #2/#3 */
export function rowIds(rows: Array<{ name: string }>): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = r.name.trim().toLocaleLowerCase('tr') || '?';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return hashId(`tiktok|${base}${n > 1 ? `#${n}` : ''}`);
  });
}

const WEEKDAY: Record<string, number> = { paz: 0, pzt: 1, sal: 2, çar: 3, per: 4, cum: 5, cmt: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** Sohbet listesindeki kısa zaman: "14:32", "Dün", "Sal", "3 g", "2h", "12.10", "12/10/2025"; okunamazsa 0 (depodaki kalır) */
export function listTime(input: string, now = new Date()): number {
  const s = input.trim();
  if (!s) return 0;
  // "12.10" / "12/10": listede saat hep iki nokta üst üsteyle ("14:32"); noktalı/eğik çizgili kısa biçim gün.ay (parseDate saat sanıyordu)
  const dm = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
  if (dm) {
    let y = dm[3] ? Number(dm[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    const t = new Date(y, Number(dm[2]) - 1, Number(dm[1]), 12).getTime();
    return !dm[3] && t > now.getTime() ? new Date(y - 1, Number(dm[2]) - 1, Number(dm[1]), 12).getTime() : t;
  }
  const full = parseDate(s, now);
  if (full !== undefined) return full;
  const low = s.toLocaleLowerCase('tr');
  const noon = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12, 0).getTime();
  if (/^(dün|yesterday)$/.test(low)) return noon(1);
  const wd = WEEKDAY[low.slice(0, 3)];
  if (wd !== undefined && low.length <= 9 && !/\d/.test(low)) return noon((now.getDay() - wd + 7) % 7 || 7);
  const rel = low.match(/^(\d+)\s*(dk|dakika|m|min|sa|saat|h|g|gün|d|hf|hafta|w)\b/);
  if (rel) {
    const unit = rel[2];
    const ms = /^(dk|dakika|m|min)$/.test(unit) ? 60_000 : /^(sa|saat|h)$/.test(unit) ? 3_600_000 : /^(g|gün|d)$/.test(unit) ? 86_400_000 : 7 * 86_400_000;
    return now.getTime() - Number(rel[1]) * ms;
  }
  return 0;
}

export function toThreads(rows: ListRow[], now = Date.now()): Thread[] {
  const ids = rowIds(rows);
  return rows.map((r, i) => {
    const id = ids[i];
    const prev = lastPreview.get(id);
    lastPreview.set(id, r.preview);
    // önizleme değiştiyse yeni etkinlik (şimdi); ilk görüşte listedeki kısa zaman (okunamazsa 0: mesajlar çekilince gerçek zaman yazılır);
    // değişmediyse önceki değer aynen (değişim anı da korunur: bu turda okunamayan sohbet sonraki turda yine "değişmiş" kalır)
    const lastTs = prev !== undefined && prev !== r.preview ? now : (stableTs.get(id) ?? listTime(r.time, new Date(now)));
    stableTs.set(id, lastTs);
    const handle = handles.get(id);
    return {
      id,
      name: r.name || 'TikTok kullanıcısı',
      kind: 'direct' as const,
      lastTs,
      preview: r.preview,
      unread: r.unread,
      avatarUrl: r.avatarUrl,
      handle: handle ? `@${handle}` : undefined,
      link: handle ? `https://www.tiktok.com/@${handle}` : undefined,
    };
  });
}

/** Açık sohbetin başlığı (ad + @kullanıcı adı) */
function readHeader(page: Page): Promise<{ name: string; handle: string }> {
  return page
    .evaluate(() => {
      const txt = (s: string) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return { name: txt('[data-e2e="chat-nickname"]'), handle: txt('[data-e2e="chat-uniqueid"]').replace(/^@/, '') };
    })
    .catch(() => ({ name: '', handle: '' }));
}

/** Mesaj satırları görünene (ya da boş sohbette yazı alanı) dek bekle; sayı iki okuma boyunca sabitlenince döner */
async function waitForMessages(page: Page, timeout: number): Promise<number> {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeout) {
    const n = await page.locator(MSG_ITEM).count().catch(() => 0);
    if (n > 0 && n === last) return n;
    if (n === 0 && Date.now() - t0 > 3000 && (await page.locator(INPUT).count().catch(() => 0))) return 0;
    last = n;
    await page.waitForTimeout(250);
  }
  return Math.max(last, 0);
}

/** Sohbeti listeden aç (satırda bağlantı yok: DOM tıklaması); zaten açıksa (başlıktaki ad aynı) dokunma */
async function openThread(page: Page, id: string): Promise<void> {
  if (!(await ensureInbox(page))) throw new Error('TikTok mesajlar sayfası açılamadı (oturum kapalı olabilir)');
  let rows = await readList(page);
  let idx = rowIds(rows).indexOf(id);
  if (idx < 0) {
    // listenin aşağısında kalmış olabilir: bir kez kaydır
    await scrollList(page);
    rows = await readList(page);
    idx = rowIds(rows).indexOf(id);
  }
  if (idx < 0) throw new Error('Sohbet TikTok listesinde bulunamadı');
  const head = await readHeader(page);
  const already = head.name && head.name === rows[idx].name && (await page.locator(INPUT).count().catch(() => 0)) > 0;
  if (!already) {
    await page.evaluate(({ sel, i }) => (Array.from(document.querySelectorAll(sel)).filter((e) => !e.parentElement?.closest(sel))[i] as HTMLElement | undefined)?.click(), { sel: LIST_ITEM, i: idx });
    await waitForMessages(page, 12_000);
  }
  const h = await readHeader(page);
  if (h.handle) handles.set(id, h.handle);
}

/** Kaydırılabilir ata (overflow auto/scroll) */
function scrollParent(page: Page, sel: string, to: 'top' | 'bottom'): Promise<boolean> {
  return page
    .evaluate(
      ({ s, dir }) => {
        let el = document.querySelector<HTMLElement>(s)?.parentElement ?? null;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            el.scrollTop = dir === 'top' ? 0 : el.scrollHeight;
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
            return true;
          }
          el = el.parentElement;
        }
        return false;
      },
      { s: sel, dir: to },
    )
    .catch(() => false);
}

async function scrollList(page: Page): Promise<void> {
  if (await scrollParent(page, LIST_ITEM, 'bottom')) await page.waitForTimeout(1200);
}

/** Daha eski mesajlar: mesaj alanını en üste kaydır, yeni satır gelmesini bekle (en çok `rounds` tur) */
async function loadOlder(page: Page, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const before = await page.locator(MSG_ITEM).count().catch(() => 0);
    if (!(await scrollParent(page, MSG_ITEM, 'top'))) return;
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < 2500) {
      await page.waitForTimeout(250);
      after = await page.locator(MSG_ITEM).count().catch(() => 0);
      if (after > before) break;
    }
    if (after <= before) return;
    await page.waitForTimeout(300);
  }
}

/** Sayfadan okunan ham satır: zaman ayırıcı ya da mesaj (metin, ben mi, ekler) */
export interface RawItem {
  sep?: string;
  text?: string;
  me?: boolean;
  avatar?: string;
  attachments?: Attachment[];
}

function readItems(page: Page, mine: string): Promise<RawItem[]> {
  return page.evaluate(
    ({ item, sep, mine }) => {
      const txt = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
      const main = document.querySelector(item)?.closest('[class*="ChatMain"], [class*="ChatBox"], main') ?? document.body;
      const mainRect = main.getBoundingClientRect();
      const out: RawItem[] = [];
      for (const el of Array.from(document.querySelectorAll(`${item}, ${sep}`))) {
        if (el.matches(item) && el.parentElement?.closest(item)) continue; // satırın içindeki parça
        if (!el.matches(item)) {
          if (el.closest(item)) continue; // mesajın içindeki saat
          const t = txt(el);
          if (t) out.push({ sep: t.slice(0, 60) });
          continue;
        }
        const profile = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href^="/@"]'))
          .map((a) => (a.getAttribute('href') ?? '').replace(/^\/@/, '').split(/[/?]/)[0])
          .find(Boolean);
        const textEl = el.querySelector('[data-e2e="chat-item-text"], [class*="PText"], [class*="TextContainer"] p, p');
        let text = txt(textEl);
        const attachments: Attachment[] = [];
        // paylaşılan TikTok videosu: /@kullanıcı/video/<id> bağlantısı + kapak
        const video = el.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
        const imgs = Array.from(el.querySelectorAll('img')).filter((i) => {
          const r = i.getBoundingClientRect();
          return /^https?:\/\//.test(i.getAttribute('src') ?? '') && r.width >= 60 && r.height >= 60; // avatar ~32-40px
        });
        if (video) {
          const href = new URL(video.getAttribute('href') ?? '', location.origin).href;
          attachments.push({ kind: 'other', name: 'TikTok videosu', link: href, url: imgs[0]?.getAttribute('src') ?? undefined, page: href });
          if (text && video.contains(textEl)) text = ''; // kart altındaki video açıklaması mesaj metni değil
        } else {
          for (const img of imgs) attachments.push({ kind: 'image', name: img.getAttribute('alt') || 'Fotoğraf', url: img.getAttribute('src')!, link: img.getAttribute('src')! });
        }
        for (const v of Array.from(el.querySelectorAll('video'))) {
          const src = v.getAttribute('src') || v.querySelector('source')?.getAttribute('src') || '';
          if (/^https?:\/\//.test(src)) attachments.push({ kind: 'video', name: 'Video', link: src, url: v.getAttribute('poster') || undefined, mime: 'video/mp4' });
        }
        // ben: kendi profil bağlantım; yoksa balon (metin/ek) sağ yarıda
        const bubble = (textEl ?? imgs[0] ?? el) as Element;
        const r = bubble.getBoundingClientRect();
        let me: boolean | undefined = mine && profile ? profile.toLowerCase() === mine.toLowerCase() : undefined;
        if (me === undefined && r.width > 0) me = r.left + r.width / 2 > mainRect.left + mainRect.width / 2;
        const avatar = Array.from(el.querySelectorAll('img'))
          .map((i) => ({ src: i.getAttribute('src') ?? '', w: i.getBoundingClientRect().width }))
          .find((i) => /^https?:\/\//.test(i.src) && i.w > 0 && i.w < 60)?.src;
        if (!text && !attachments.length) continue;
        out.push({ text: text.slice(0, 4000), me, avatar, attachments });
      }
      return out;
    },
    { item: MSG_ITEM, sep: TIME_SEP, mine },
  );
}

/**
 * Ham satırlar → mesajlar. Zaman ayırıcıdaki (çözülen, mutlak) zaman sonraki mesajların tabanı; kimlik sohbet + ayırıcı zamanı +
 * gönderen + metin (+ aynı blokta aynı metin tekrarında sıra no). Çözülebilen bir ayırıcı varsa ondan önceki (henüz ayırıcısı
 * yüklenmemiş bloğun) mesajları ATLANIR: zamanları bilinmiyor (eskiden "şimdi" alıp sohbeti üste taşıyor, ayırıcı yüklenince
 * başka kimlikle ikinci kez yazılıyordu); yukarı kaydırınca (loadOlder) doğru zaman ve kalıcı kimlikle gelir. Hiç ayırıcı yoksa
 * 'x' tabanlı, zamanı `fallbackTs − kalan sıra` (sohbet satırının zamanı; yoksa şimdi).
 */
export function toMessages(threadId: string, name: string, items: RawItem[], now = new Date(), fallbackTs?: number): Msg[] {
  const out: Msg[] = [];
  let base: number | undefined;
  let baseKey = 'x';
  let step = 0;
  const dupes = new Map<string, number>();
  const sepTime = (sep: string) => parseDate(sep, now) ?? listTime(sep, now);
  const hasSep = items.some((it) => it.sep !== undefined && !!sepTime(it.sep));
  const anchor = fallbackTs && fallbackTs > 0 ? Math.min(fallbackTs, now.getTime()) : now.getTime();
  for (const it of items) {
    if (it.sep !== undefined) {
      const t = sepTime(it.sep);
      if (t) {
        base = t;
        baseKey = String(t);
        step = 0;
      }
      continue;
    }
    if (hasSep && base === undefined) continue;
    const fromMe = !!it.me;
    const text = (it.text ?? '').trim();
    const key = `${threadId}|${baseKey}|${fromMe ? 'me' : 'o'}|${text}|${(it.attachments ?? []).map((a) => a.link ?? a.name).join(',')}`;
    const n = dupes.get(key) ?? 0;
    dupes.set(key, n + 1);
    step++;
    out.push({
      id: hashId(n ? `${key}#${n}` : key),
      text,
      // bloğun zamanı + sıra (ms): sıralama korunur; hiç ayırıcı yoksa sohbet zamanı − kalan sıra
      ts: base !== undefined ? base + step : anchor - (items.length - step),
      fromMe,
      senderId: fromMe ? 'me' : threadId,
      senderName: fromMe ? 'Ben' : name || 'Karşı taraf',
      senderAvatarUrl: fromMe ? undefined : it.avatar,
      attachments: it.attachments?.length ? it.attachments : undefined,
      status: fromMe ? 'sent' : 'delivered',
    });
  }
  return out;
}

export const tiktok: Strategy = {
  home: HOME,
  loginUrl: 'https://www.tiktok.com/login',
  loginHint: 'Açılan pencerede TikTok hesabınla giriş yap; mesajlar sayfası açılınca pencere kendiliğinden kapanır.',
  // keepVisible YOK: sayfa kendini gizli/odaksız tanıtır (köprü varsayılanı) → TikTok kullanıcıyı "aktif" sayıp telefona bildirimi kesmez
  watchSelector: LIST_ITEM,
  // sayfanın kendi IM soketi (ikili çerçeveler): büyük çerçeve = yeni mesaj olayı, küçükler kalp atışı
  watchSockets: [{ url: /\bim-ws[\w-]*\.tiktok|tiktok\.com\/ws\//i, minBytes: 160 }],

  async loggedIn(_page, cookies) {
    return !!(cookies.sessionid || cookies.sessionid_ss || cookies.sid_tt);
  },

  async me(page, cookies) {
    if (!/tiktok\.com/.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    const u = await page
      .evaluate(() => {
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          const j = el ? (JSON.parse(el.textContent || '{}') as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
          const user = j.__DEFAULT_SCOPE__?.['webapp.app-context']?.user;
          if (user && (user.uid || user.uniqueId)) return { uid: String(user.uid ?? ''), uniqueId: String(user.uniqueId ?? ''), nick: String(user.nickName ?? '') };
        } catch {
          /* biçim değişti */
        }
        return undefined;
      })
      .catch(() => undefined);
    if (u?.uniqueId) myHandle = u.uniqueId;
    const id = u?.uid || u?.uniqueId || hashId(`tt|${cookies.uid_tt ?? cookies.sid_tt ?? 'me'}`);
    const label = u?.uniqueId ? `@${u.uniqueId}` : u?.nick || 'TikTok';
    return { id, label };
  },

  async threads(page) {
    const ok = await ensureInbox(page);
    await assertUsable(page);
    if (/\/login/.test(page.url())) throw new Error('TikTok oturumu kapalı (authwall): Yeniden bağlan');
    // tanı liste bulunamasa da yazılır: seçiciler tutmadığında asıl gereken durum bu
    await diagnose(page);
    if (!ok) {
      if (!listWarned) bus.log('warn', 'TikTok: sohbet listesi okunamadı (sayfa düzeni değişmiş olabilir; "TikTok tanı" günlüğüne bak)');
      listWarned = true;
      return [];
    }
    return toThreads(await readList(page));
  },

  async messages(page, _cookies, threadId, limit, before) {
    await openThread(page, threadId);
    if (before) await loadOlder(page, 3);
    const head = await readHeader(page);
    const items = await readItems(page, myHandle);
    // sohbet açıldı ama mesaj satırı bulunamadı: sayfa düzenini (içeriksiz) bir kez günlüğe yaz
    if (!items.some((i) => i.sep === undefined) && !msgDiagDone) {
      msgDiagDone = true;
      diagDone = false;
      bus.log('warn', 'TikTok: sohbet açıldı ama mesajlar okunamadı; sayfa düzeni tanısı:');
      await diagnose(page);
    }
    const msgs = toMessages(threadId, head.name, items, new Date(), stableTs.get(threadId));
    const out = before ? msgs.filter((m) => m.ts < before) : msgs;
    return out.slice(-limit);
  },

  async send(page, _cookies, threadId, text) {
    await openThread(page, threadId);
    const box = page.locator(INPUT).first();
    await box.click({ timeout: 10_000 });
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await page.keyboard.press('Shift+Enter');
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 6 });
    }
    await page.waitForTimeout(150);
    const btn = page.locator(SEND_BTN).first();
    if (await btn.count().catch(() => 0)) await btn.click({ timeout: 5000 }).catch(() => page.keyboard.press('Enter'));
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    // gerçek kimlik sonraki okumada gelir; yerel kopya (local-…) aynı metinli gerçek kayıtla birleşir
    return undefined;
  },

  async moreThreads(page, _cookies, pageIndex) {
    if (pageIndex > 5 || !(await ensureInbox(page))) return [];
    const before = (await readList(page)).length;
    await scrollList(page);
    const rows = await readList(page);
    return rows.length > before ? toThreads(rows).slice(before) : [];
  },

  async attention(page) {
    return (await page.locator(CAPTCHA).count().catch(() => 0)) ? 'TikTok doğrulama istiyor: Yeniden bağlan → açılan pencerede doğrulamayı tamamla' : undefined;
  },
};
