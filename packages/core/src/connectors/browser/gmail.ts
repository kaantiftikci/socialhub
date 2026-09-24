import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import type { Attachment } from '../../model.js';

/**
 * Gmail (tarayıcı oturumu): uygulama şifresi / OAuth istemci kimliği gerekmez. Kullanıcı görünür pencerede
 * Google hesabına normal şekilde giriş yapar; sonra Gmail web arayüzü görünmez pencerede açık kalır ve
 * gelen kutusu / ileti dizileri DOM'dan okunur, yanıt Gmail'in kendi düzenleyicisiyle gönderilir.
 *
 * Seçiciler (Gmail'in yıllardır değişmeyen sınıf adları):
 *  - satır: tr.zA (okunmamış: .zE, okunmuş: .yO); dizi kimliği span[data-legacy-thread-id]; gönderen span[email][name];
 *    konu span.bog; özet span.y2; zaman td.xW span[title]
 *  - ileti: div.adn[data-legacy-message-id]; gönderen span.gD[email][name]; zaman span.g3[title]; gövde div.a3s;
 *    ekler span.aZo[download_url="mime:ad:url"]
 * Deneysel: Gmail arayüzü değişirse seçicilerin güncellenmesi gerekir.
 */
const BASE = 'https://mail.google.com/mail/u/0/';
const HOME = `${BASE}#inbox`;

const MONTHS: Record<string, number> = {
  oca: 0, şub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "24 Eyl 2026 14:32", "24 Eylül 2026 Per 14:32", "Sep 24, 2026, 2:32 PM", "14:32" (bugün), "24 Eyl" (bu yıl) */
export function parseGmailDate(s: string | undefined | null, now = new Date()): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = t.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})[^\d]*?(\d{4})?[^\d]*?(\d{1,2}):(\d{2})/);
  if (m) {
    const mon = MONTHS[m[2].toLocaleLowerCase('tr')];
    if (mon !== undefined) return new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
  }
  m = t.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?,?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    let h = Number(m[4]);
    if (m[6]) h = (h % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    if (mon !== undefined) return new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, Number(m[2]), h, Number(m[5])).getTime();
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2])).getTime();
  m = t.match(/^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})/);
  if (m) {
    const mon = MONTHS[m[2].toLocaleLowerCase('tr')];
    if (mon !== undefined) {
      const d = new Date(now.getFullYear(), mon, Number(m[1]));
      return d.getTime() > now.getTime() + 86400e3 ? new Date(now.getFullYear() - 1, mon, Number(m[1])).getTime() : d.getTime();
    }
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : undefined;
}

/**
 * Ek öğesinin download_url'si: "mime:ad:url". Gmail url'nin başına bazen hesap kökünü bir kez daha ekler
 * ("https://mail.google.com/mail/u/0/https://mail.google.com/mail/u/0?ui=2&…&view=att&disp=safe") → son
 * "https://"den itibaren al. Dosya adında ':' olabilir; ayrım ":http" ile yapılır.
 */
export function parseDownloadUrl(d: string): Attachment | undefined {
  const i = d.indexOf(':');
  const j = d.indexOf(':http', i + 1);
  if (i <= 0 || j < 0) return undefined;
  const mime = d.slice(0, i).trim().toLowerCase();
  let name = d.slice(i + 1, j);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* ham ad kalsın */
  }
  const raw = d.slice(j + 1);
  const url = raw.slice(raw.lastIndexOf('https://'));
  if (!/^https:\/\//.test(url)) return undefined;
  const kind: Attachment['kind'] = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
  return { kind, name: name || undefined, mime: mime || undefined, url: kind === 'image' ? url : undefined, link: url };
}

let meEmail = '';

async function readMe(page: Page): Promise<{ email: string; name: string }> {
  return page.evaluate(() => {
    const a = document.querySelector<HTMLElement>('[aria-label^="Google Hesabı"], [aria-label^="Google Account"], a[href*="accounts.google.com/SignOutOptions"]');
    const label = a?.getAttribute('aria-label') ?? '';
    // yedek: sekme başlığı "Gelen Kutusu (2.437) - ad@gmail.com - Gmail"
    const email = label.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? document.title.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? '';
    const name = label.replace(/\(.*$/s, '').replace(/^(Google Hesabı|Google Account):?\s*/i, '').trim();
    return { email, name };
  });
}

/** Oturum düşmüşse Gmail giriş/tanıtım sayfasına yönlendirir: mail.google.com dışındaki her adres */
export function isSignedOutUrl(url: string): boolean {
  return /^https:\/\/(accounts\.google\.com|workspace\.google\.com|www\.google\.com\/(intl\/[^/]+\/)?gmail\/about)/.test(url);
}

/** Gelen kutusu liste görünümü mü? (#inbox; #inbox/<dizi> ya da #search/… değil) */
export function isInboxListUrl(url: string): boolean {
  if (!url.startsWith(BASE)) return false;
  const hash = url.slice(url.indexOf('#') >= 0 ? url.indexOf('#') : url.length);
  return hash === '' || hash === '#inbox' || /^#inbox\/p\d+$/.test(hash);
}

/**
 * Liste başlığındaki sayfa aralığı: "2.631 satırdan 51–100 arası" / "51–100 of 2,631" / "1-50 / 2631".
 * Gmail'in yeni arayüzü `#inbox/p2` adresini yok sayıp hep 1. sayfayı gösterir; sayfalar "Daha eski"/"Daha yeni"
 * düğmeleriyle gezilir ve hangi sayfada olunduğu yalnızca bu metinden anlaşılır.
 */
export function parseGmailPager(text: string | undefined | null): { from: number; to: number; total: number } | undefined {
  if (!text) return undefined;
  const t = text.replace(/[\u200e\u200f\u202a-\u202e\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  const num = (s: string) => Number(s.replace(/[.,\s]/g, ''));
  const range = t.match(/(\d[\d.,]*)\s*[–\-]\s*(\d[\d.,]*)/);
  if (!range) return undefined;
  const from = num(range[1]);
  const to = num(range[2]);
  // toplam: aralık dışında kalan (en büyük) sayı; yoksa `to`
  const rest = t.replace(range[0], ' ').match(/\d[\d.,]*/g)?.map(num).filter((n) => Number.isFinite(n)) ?? [];
  const total = rest.length ? Math.max(...rest) : to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) return undefined;
  return { from, to, total: Math.max(total, to) };
}

/** Sayfa numarası (1 tabanlı): aralığın başı ve sayfa boyutundan */
export function gmailPageOf(from: number, pageSize: number): number {
  return pageSize > 0 ? Math.floor((from - 1) / pageSize) + 1 : 1;
}

/** Görünür sayfa aralığı ("Daha eski/yeni" düğmeleriyle aynı araç çubuğundaki .Dj metni) */
async function readPager(page: Page): Promise<{ from: number; to: number; total: number } | undefined> {
  const text = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.Dj'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.innerText)
        .join(' | '),
    )
    .catch(() => '');
  return parseGmailPager(text.split(' | ')[0]);
}

/** İlk sayfanın (1–N) satır sayısı: sayfalama adımı. Kullanıcı ayarına göre 25/50/100. */
let pageSize = 0;
const OLDER_BTN = '[role="button"][aria-label="Daha eski"], [role="button"][aria-label="Older"]';
const NEWER_BTN = '[role="button"][aria-label="Daha yeni"], [role="button"][aria-label="Newer"]';

/** Görünür sayfalama düğmesine tıkla; aria-disabled ise false (liste sonu / başı) */
async function clickPager(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate((sel) => {
      const b = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null);
      if (!b || b.getAttribute('aria-disabled') === 'true') return false;
      b.click();
      return true;
    }, selector)
    .catch(() => false);
}

/** Sayfa aralığı `pred`'i sağlayana dek bekle (en çok ms) */
async function waitPager(page: Page, pred: (p: { from: number; to: number; total: number }) => boolean, ms: number): Promise<{ from: number; to: number; total: number } | undefined> {
  const t0 = Date.now();
  for (;;) {
    const p = await readPager(page);
    if (p && pred(p)) return p;
    if (Date.now() - t0 > ms) return p;
    await page.waitForTimeout(300);
  }
}

/**
 * Liste görünümüne dön ve görünür satırları bekle. messages()/markRead bir diziyi açınca sayfa #inbox/<id>'de
 * kalır; o görünümde gelen kutusu satırları DOM'da ama gizlidir → görünür tr.zA hiç gelmez. Önce SPA içinde
 * hash'i değiştir (hızlı), olmazsa sayfayı yeniden yükle. moreThreads eski bir sayfada bıraktıysa 1. sayfaya dön
 * (yoklama en yeni sohbetleri okumalı).
 */
async function ensureInbox(page: Page, firstPage = true): Promise<boolean> {
  const visibleRows = (ms: number) =>
    page
      .waitForSelector('tr.zA', { state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);
  let ok = false;
  if (page.url().startsWith(BASE)) {
    if (!isInboxListUrl(page.url())) {
      await page.evaluate(() => {
        location.hash = '#inbox';
      }).catch(() => undefined);
    }
    ok = await visibleRows(10_000);
  }
  if (!ok) {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    ok = await visibleRows(20_000);
  }
  if (!ok) return false;
  const pager = await readPager(page);
  if (pager?.from === 1) pageSize = pager.to - pager.from + 1 || pageSize;
  if (firstPage && pager && pager.from > 1) {
    // "Daha yeni" ile başa dön (hash değişimi Gmail'de sayfayı sıfırlamıyor)
    for (let i = 0; i < 60; i++) {
      const cur = await readPager(page);
      if (!cur || cur.from <= 1) break;
      if (!(await clickPager(page, NEWER_BTN))) break;
      await waitPager(page, (p) => p.from < cur.from, 8_000);
    }
    await visibleRows(5_000);
  }
  return true;
}

/** Gelen kutusu satırlarını (görünür tr.zA) ham alanlarıyla oku */
interface GmailRawRow {
  id: string;
  name: string;
  email: string;
  subject: string;
  snippet: string;
  time: string;
  unread: boolean;
  count: number;
}
function readInboxRows(page: Page): Promise<GmailRawRow[]> {
  return page.evaluate(() => {
    const out: Array<{ id: string; name: string; email: string; subject: string; snippet: string; time: string; unread: boolean; count: number }> = [];
    const seen = new Set<string>();
    // gizli görünümlerdeki (önceki arama/etiket) satırlar karışmasın: yalnızca görünür satırlar
    const all = Array.from(document.querySelectorAll<HTMLElement>('tr.zA'));
    const visible = all.filter((tr) => tr.offsetParent !== null);
    for (const tr of visible.length ? visible : all) {
      const idEl = tr.querySelector<HTMLElement>('[data-legacy-thread-id]');
      const id = idEl?.getAttribute('data-legacy-thread-id') ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const senders = Array.from(tr.querySelectorAll<HTMLElement>('span[email]'));
      const last = senders[senders.length - 1];
      const countTxt = tr.querySelector<HTMLElement>('.bA4 .bx0')?.innerText ?? '';
      out.push({
        id,
        // name özniteliği bozuk kodlanmış olabilir ("Tiftik?i"): görünen metin daha güvenilir
        name: (() => {
          const attr = last?.getAttribute('name') ?? '';
          const shown = last?.innerText?.trim() ?? '';
          return attr && !attr.includes('?') ? attr : shown || attr;
        })(),
        email: (last?.getAttribute('email') ?? '').toLowerCase(),
        subject: tr.querySelector<HTMLElement>('span.bog')?.innerText?.trim() ?? '(konu yok)',
        snippet: tr.querySelector<HTMLElement>('span.y2')?.innerText?.replace(/^\s*-\s*/, '').trim() ?? '',
        time: tr.querySelector<HTMLElement>('td.xW span[title]')?.getAttribute('title') ?? tr.querySelector<HTMLElement>('td.xW span')?.innerText ?? '',
        unread: tr.classList.contains('zE'),
        count: Number(countTxt.replace(/\D/g, '')) || 1,
      });
    }
    return out;
  });
}

/** Ham satır → sohbet (gönderen ben isem "Ben") */
export function gmailRowToThread(r: GmailRawRow, me: string): Thread {
  const others = r.email && r.email !== me ? { name: r.name || r.email, email: r.email } : { name: r.name || 'Ben', email: r.email };
  return {
    id: r.id,
    name: r.subject,
    kind: 'direct' as const,
    lastTs: parseGmailDate(r.time) ?? 0,
    preview: `${others.name}: ${r.snippet}`.slice(0, 200),
    unread: r.unread ? 1 : 0,
    handle: others.email || undefined,
    participants: others.email ? [{ id: others.email, name: others.name, handle: others.email }] : undefined,
  };
}

async function openThread(page: Page, id: string): Promise<boolean> {
  const url = `${BASE}#inbox/${id}`;
  if (!page.url().includes(`/${id}`)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }
  // görünür bir ileti + (varsa) görünür konu başlığı bu dizinin: önceki dizinin görünümü henüz kapanmamışken okumayalım
  const ok = await page
    .waitForFunction(
      (tid) => {
        const shown = (e: Element) => (e as HTMLElement).offsetParent !== null;
        if (!Array.from(document.querySelectorAll('div.adn')).some(shown)) return false;
        const h = Array.from(document.querySelectorAll('h2[data-legacy-thread-id]')).find(shown);
        return !h || !/^[0-9a-f]+$/.test(tid) || h.getAttribute('data-legacy-thread-id') === tid;
      },
      id,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) return false;
  // daraltılmış eski iletileri aç ("Tümünü genişlet")
  const expand = page.locator('[aria-label="Tümünü genişlet"], [aria-label="Expand all"]').first();
  if (await expand.count().catch(() => 0)) await expand.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return true;
}

export const gmail: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede Google hesabına giriş yap; gelen kutusu görününce pencere kendiliğinden kapanır',

  async loggedIn(page, cookies, passive) {
    if (!cookies.SID || !cookies.HSID) return false;
    if (page.url().startsWith('https://accounts.google.com/')) return false;
    if (page.url().startsWith(BASE)) return true;
    // görünür pencerede yönlendirme yapma: kullanıcı Google'ın izin/2FA adımlarında olabilir
    if (passive) return page.url().includes('google.com') && !page.url().includes('/signin');
    // Google giriş sonrası mail.google.com'a yönlendirir; başka bir sayfadaysak (ör. myaccount) gelen kutusunu dene
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    return page.url().startsWith(BASE);
  },

  async me(page) {
    // üst çubuk (hesap düğmesi) satırlarla birlikte yüklenir; hemen okumak boş e-posta verir → fromMe hiç doğru olmaz
    await ensureInbox(page);
    const { email, name } = await readMe(page).catch(() => ({ email: '', name: '' }));
    meEmail = email.toLowerCase();
    return { id: meEmail, label: email || name || 'Gmail' };
  },

  async threads(page): Promise<Thread[]> {
    const ok = await ensureInbox(page);
    if (!ok) {
      // köprü hata yakalayınca loggedIn'e bakar ve eşleştirmeye (pairing) geçer; boş liste dönmek bunu engellerdi
      if (isSignedOutUrl(page.url())) throw new Error('Gmail oturumu düşmüş');
      bus.log('warn', `Gmail: gelen kutusu satırları bulunamadı (sayfa: ${page.url()}). Görünmez modda engellendiyse kanala sağ tık → Yeniden bağlan ile pencereyi aç.`);
      return [];
    }
    if (!meEmail) await this.me(page, {});
    return (await readInboxRows(page)).map((r) => gmailRowToThread(r, meEmail));
  },

  /**
   * Gelen kutusunun `pageIndex + 1`. sayfası. Gmail'in yeni arayüzü `#inbox/p<N>` adresini yok sayar (hep 1. sayfa;
   * profil kopyasıyla doğrulandı) → "Daha eski" düğmesine basılarak gezilir; hangi sayfada olunduğu araç
   * çubuğundaki "2.631 satırdan 51–100 arası" metninden okunur. Zaten bir önceki sayfadaysa tek tık yeter.
   * Düğme devre dışıysa (son sayfa) boş dizi.
   */
  async moreThreads(page, _cookies, pageIndex): Promise<Thread[]> {
    const target = pageIndex + 1;
    let pager = await readPager(page);
    const onList = page.url().startsWith(BASE) && isInboxListUrl(page.url()) && !!pager;
    let cur = onList && pager && pageSize ? gmailPageOf(pager.from, pageSize) : 0;
    if (!onList || cur < 1 || cur > target) {
      if (!(await ensureInbox(page, true))) return [];
      pager = await readPager(page);
      cur = pager && pageSize ? gmailPageOf(pager.from, pageSize) : 1;
    }
    if (!meEmail) await this.me(page, {});
    for (let guard = 0; cur < target && guard < 200; guard++) {
      const from = pager?.from ?? 0;
      if (!(await clickPager(page, OLDER_BTN))) return []; // devre dışı: daha eski sayfa yok
      pager = await waitPager(page, (p) => p.from > from, 10_000);
      if (!pager || pager.from <= from) return [];
      cur = pageSize ? gmailPageOf(pager.from, pageSize) : cur + 1;
    }
    await page.waitForSelector('tr.zA', { state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    return (await readInboxRows(page)).map((r) => gmailRowToThread(r, meEmail));
  },

  async messages(page, _cookies, threadId, limit, before): Promise<Msg[]> {
    if (!(await openThread(page, threadId))) return [];
    if (!meEmail) meEmail = (await readMe(page).catch(() => ({ email: '' }))).email.toLowerCase();
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; name: string; email: string; time: string; text: string; atts: string[] }> = [];
      const all = Array.from(document.querySelectorAll<HTMLElement>('div.adn'));
      const visible = all.filter((e) => e.offsetParent !== null);
      for (const el of visible.length ? visible : all) {
        const id = el.getAttribute('data-legacy-message-id') ?? el.getAttribute('data-message-id') ?? '';
        const from = el.querySelector<HTMLElement>('span.gD');
        const body = el.querySelector<HTMLElement>('div.a3s');
        // alıntılanmış önceki iletiler gövdeyi şişirmesin
        let text = '';
        if (body) {
          const clone = body.cloneNode(true) as HTMLElement;
          for (const q of Array.from(clone.querySelectorAll('.gmail_quote, blockquote, .gmail_extra'))) q.remove();
          text = clone.innerText?.trim() ?? '';
        }
        const atts = Array.from(el.querySelectorAll<HTMLElement>('span.aZo[download_url], div.aQH [download_url]')).map((a) => a.getAttribute('download_url') ?? '');
        out.push({ id, name: from?.getAttribute('name') ?? from?.innerText ?? '', email: (from?.getAttribute('email') ?? '').toLowerCase(), time: el.querySelector<HTMLElement>('span.g3')?.getAttribute('title') ?? el.querySelector<HTMLElement>('span.g3')?.innerText ?? '', text, atts });
      }
      return out;
    });
    const msgs: Msg[] = rows
      .filter((r) => r.text || r.atts.length)
      .map((r, i) => {
        const fromMe = !!meEmail && r.email === meEmail;
        const attachments = r.atts.map(parseDownloadUrl).filter((a): a is Attachment => !!a);
        return {
          id: r.id || hashId(threadId + '|' + r.email + '|' + r.time + '|' + r.text.slice(0, 80)),
          text: r.text,
          ts: parseGmailDate(r.time) ?? Date.now() - (rows.length - i) * 60_000,
          fromMe,
          senderId: fromMe ? 'me' : r.email || threadId,
          senderName: fromMe ? 'Ben' : r.name || r.email || 'Gönderen',
          attachments: attachments.length ? attachments : undefined,
        };
      });
    // dizinin tamamı tek seferde gelir: "before" ile yalnızca daha eski iletiler (yoksa boş → sayfalama biter)
    return (before ? msgs.filter((m) => m.ts < before) : msgs).slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    await openThread(page, threadId); // dizi açılınca Gmail okundu sayar
  },

  async send(page, _cookies, threadId, text) {
    const body = await openReply(page, threadId);
    await body.click();
    await body.fill(text);
    await clickSend(page);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },

  /**
   * Ekli yanıt: yanıt düzenleyicisindeki gizli `input[type=file][name="Filedata"]` (Gmail'in "Dosya ekle" düğmesi,
   * command="Files") dosyayı alır; yükleme ilerleme çubuğu kaybolana dek beklenir, sonra metin ve Gönder.
   * (Girişin varlığı/adı profil kopyasıyla doğrulandı; gönderim canlı denenmedi.)
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    const body = await openReply(page, threadId);
    const input = await composeFileInput(page);
    if (!input) throw new Error('Gmail: yanıt düzenleyicisinde dosya girişi bulunamadı');
    await input.setInputFiles(file.path);
    await waitUploadDone(page, Math.max(30_000, Math.min(300_000, file.size / 50)));
    if (caption) {
      await body.click();
      await body.fill(caption);
    }
    await clickSend(page);
    return hashId(threadId + '|' + file.name + '|' + Date.now());
  },
};

/** Diziyi aç, son iletinin "Yanıtla" bağlantısına bas, gövde düzenleyicisini döndür */
async function openReply(page: Page, threadId: string) {
  if (!(await openThread(page, threadId))) throw new Error('İleti dizisi açılamadı');
  // son iletinin "Yanıtla" bağlantısı (tr/en)
  const reply = page.locator('span.ams.bkH, [aria-label="Yanıtla"], [aria-label="Reply"], [data-tooltip="Yanıtla"], [data-tooltip="Reply"]').last();
  await reply.click({ timeout: 8000 });
  const body = page.locator('div[aria-label="Mesaj Gövdesi"], div[aria-label="Message Body"], div[role="textbox"][contenteditable="true"]').last();
  await body.waitFor({ timeout: 10_000 });
  return body;
}

async function clickSend(page: Page): Promise<void> {
  const sendBtn = page.locator('div[role="button"][aria-label^="Gönder"], div[role="button"][aria-label^="Send"], div[role="button"][data-tooltip^="Gönder"], div[role="button"][data-tooltip^="Send"]').last();
  await sendBtn.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

/** Açık yanıt düzenleyicisinin dosya girişi (Gmail: name="Filedata", multiple; düzenleyici açılınca DOM'a gelir) */
export async function composeFileInput(page: Page) {
  const sel = 'input[type="file"][name="Filedata"], form input[type="file"], [role="main"] input[type="file"]';
  for (let i = 0; i < 20; i++) {
    const loc = page.locator(sel).last();
    if (await loc.count().catch(() => 0)) return loc;
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** Ek yükleme bitene dek bekle: düzenleyicideki ilerleme çubuğu kaybolur ve 1 sn boyunca geri gelmez */
async function waitUploadDone(page: Page, maxMs: number): Promise<void> {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(500);
    const busy = await page
      .evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="progressbar"]')).some((e) => e.offsetParent !== null && e.getAttribute('aria-valuenow') !== e.getAttribute('aria-valuemax')))
      .catch(() => false);
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 3) return;
  }
}
