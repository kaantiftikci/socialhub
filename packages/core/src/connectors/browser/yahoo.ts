import type { Locator, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import { fillListTimes, parseMailDate, persistSessionCookies } from './outlook.js';
import { cleanMailHtml } from '../mail-html.js';

/**
 * Yahoo Mail (tarayıcı oturumu): kullanıcı görünür pencerede login.yahoo.com'da normal şifresiyle (ve doğrulamayla) girer,
 * sonra mail.yahoo.com görünmez pencerede okunur. Yahoo birçok hesapta uygulama şifresi üretmeyi kapattığı ve IMAP normal
 * şifreyi kabul etmediği için (Eylül 2026: "Giriş reddedildi") varsayılan yol budur; uygulama şifresi (IMAP) isteğe bağlı.
 *
 * Seçiciler: Yahoo Mail web istemcisi kararlı `data-test-id` öznitelikleri kullanır (message-list-item, senders,
 * message-subject, snippet, message-view, message-view-body-content, email-pill, rte, compose-send-button…); her biri için
 * ARIA/metin yedeği var. DOĞRULANMADI (bu makinede Yahoo oturumu yok): ilk gerçek girişte günlükteki tanıyla ayarlanır.
 * Avrupa/Türkiye'de açılışta çerez onayı (consent.yahoo.com / guce) gelebilir: "Tümünü kabul et" tıklanır.
 */
const HOME = 'https://mail.yahoo.com/d/folders/1';
const YAHOO_COOKIE_DOMAINS = /(^|\.)(yahoo\.com|yahoo\.net|login\.yahoo\.com)$/;
const ROW_SEL = '[data-test-id="message-list-item"], ul[role="list"] li[role="listitem"] a[href*="/messages/"], [role="list"] [role="listitem"]';

let meEmail = '';
/** Liste satırının zamanı (ileti görünümünde zaman okunamazsa yedek; "şimdi" yazılınca sıra bozuluyordu) */
const threadTs = new Map<string, number>();
/** Ekran okuyucu etiketleri (görünmez): gönderen/konu yerine okunmasın */
const A11Y = /^(Okunmamış mesaj|Okunmuş mesaj|Okundu|Unread message|Read message|Unread|Yıldızlı|Starred|Mesaj Gövdesi|Message body|Ek var|Has attachment|Seç|Select)$/i;

const onLogin = (u: string) => /^https:\/\/login\.yahoo\.com\//.test(u);
const onConsent = (u: string) => /^https:\/\/(consent\.yahoo\.com|guce\.yahoo\.com)\//.test(u);

/** Çerez onay sayfası: "Tümünü kabul et" (ilk açılışta Avrupa/Türkiye'de) */
async function passConsent(page: Page): Promise<void> {
  if (!onConsent(page.url())) return;
  await page
    .locator('button[name="agree"], button.accept-all, button:has-text("Tümünü kabul et"), button:has-text("Accept all"), button:has-text("Kabul et")')
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
}

/** Posta kutusunu aç; liste çizildiyse true, giriş sayfasına düştüyse 'signin' */
async function openMail(page: Page): Promise<true | 'signin' | undefined> {
  if (!/^https:\/\/mail\.yahoo\.com\//.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  for (let i = 0; i < 25; i++) {
    await passConsent(page);
    if (onLogin(page.url())) return 'signin';
    const n = await page.locator(ROW_SEL).count().catch(() => 0);
    if (n > 0) return true;
    // boş gelen kutusu: liste kabı var ama satır yok
    if (await page.locator('[data-test-id="message-list"], [data-test-id="empty-folder"], [aria-label*="Message list" i], [aria-label*="İleti listesi" i]').count().catch(() => 0)) return true;
    await page.waitForTimeout(1000);
  }
  return onLogin(page.url()) ? 'signin' : undefined;
}

interface YahooRow {
  key: string;
  unread: boolean;
  sender: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  time: string;
}

/** Liste satırlarını oku (threads ve messages aynı anahtarı üretsin diye tek yerde) */
function readRows(page: Page): Promise<YahooRow[]> {
  return page.evaluate(({ sel, a11ySrc }) => {
    const a11y = new RegExp(a11ySrc, 'i');
    const q = (el: Element, s: string) => el.querySelector<HTMLElement>(s);
    const out: YahooRow[] = [];
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const lines = el.innerText.split('\n').map((t) => t.trim()).filter((t) => t && !a11y.test(t));
      const senderEl = q(el, '[data-test-id="senders"], [data-test-id="senders_list"] span, [data-test-id="message-from"]');
      const sender = (senderEl?.innerText || lines[0] || '').trim();
      const senderEmail = senderEl?.getAttribute('title') ?? '';
      const subject = (q(el, '[data-test-id="message-subject"]')?.innerText || lines[1] || '(konu yok)').trim();
      const snippet = (q(el, '[data-test-id="snippet"]')?.innerText || lines.slice(2).join(' ')).trim();
      const timeEl = q(el, 'time, [data-test-id="message-date"]');
      const time = (timeEl?.getAttribute('title') || timeEl?.getAttribute('datetime') || timeEl?.innerText || '').trim();
      // okunmamış: "okundu olarak işaretle" düğmesi (şu an okunmamış demek) ya da kalın konu
      const readBtn = q(el, '[data-test-id="icon-btn-read"], button[title*="okundu" i], button[title*="as read" i]');
      const bold = subject && senderEl ? Number(getComputedStyle(senderEl).fontWeight) >= 600 : false;
      const unread = /okundu olarak|mark as read/i.test(readBtn?.getAttribute('title') ?? readBtn?.getAttribute('aria-label') ?? '') || el.getAttribute('data-test-read') === 'false' || bold;
      // kararlı anahtar: ileti bağlantısı (/messages/<id>) ya da DOM kimliği; yoksa içerik (zaman hariç)
      const href = el.getAttribute('href') ?? el.querySelector('a[href*="/messages/"]')?.getAttribute('href') ?? '';
      let key = (href.match(/\/messages\/([^/?#]+)/) ?? [])[1] ?? el.getAttribute('data-test-cmi') ?? el.id ?? '';
      if (!key) {
        const base = 'c:' + [sender, subject, snippet.slice(0, 60)].join('|').slice(0, 200);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        key = n ? `${base}#${n}` : base;
      }
      out.push({ key, unread, sender, senderEmail, subject, snippet, time });
    }
    return out;
  }, { sel: ROW_SEL, a11ySrc: A11Y.source });
}

/** Satırı aç, okuma bölmesindeki iletileri oku; restore=true ise (yoklama) okunmamış satır sonra yeniden okunmadı yapılır */
async function readThread(page: Page, threadId: string, limit: number, restore: boolean): Promise<Msg[]> {
  if ((await openMail(page)) !== true) return [];
  const list = await readRows(page).catch(() => [] as YahooRow[]);
  const idx = list.findIndex((r) => hashId(r.key) === threadId);
  if (idx < 0) return [];
  const wasUnread = list[idx].unread;
  await page.locator(ROW_SEL).nth(idx).click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const rows = await page
    .evaluate(() => {
      const views = Array.from(document.querySelectorAll<HTMLElement>('[data-test-id="message-view"], [data-test-id="message-group-view"] article, [role="article"], article'));
      return views.map((v) => {
        const bodyEl = v.querySelector<HTMLElement>('[data-test-id="message-view-body-content"], [data-test-id="message-view-body"], .msg-body, [class*="msg-body"]');
        const body = (bodyEl?.innerText ?? v.innerText).replace(/^(Mesaj Gövdesi|Message body)\s*\n/i, '');
        let html = '';
        if (bodyEl) {
          const c = bodyEl.cloneNode(true) as HTMLElement;
          for (const img of Array.from(c.querySelectorAll<HTMLImageElement>('img[src]'))) img.setAttribute('src', img.src);
          html = c.innerHTML;
        }
        const pill = v.querySelector<HTMLElement>('[data-test-id="message-from"] [data-test-id="email-pill"], [data-test-id="email-pill"]');
        const from = pill?.getAttribute('title') || (v.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [])[0] || '';
        const fromName = pill?.innerText?.trim() || from;
        const time = v.querySelector<HTMLElement>('[data-test-id="message-date"], time')?.getAttribute('title') || v.querySelector('time')?.getAttribute('datetime') || (v.innerText.match(/\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{1,2}:\d{2}|\d{1,2}:\d{2}/) ?? [])[0] || '';
        return { text: body.trim(), from, fromName, time, html };
      });
    })
    .catch(() => [] as Array<{ text: string; from: string; fromName: string; time: string; html: string }>);
  if (restore && wasUnread) await markUnread(page, threadId);
  const good = rows.filter((r) => r.text.length > 0);
  return good
    .map((r, i) => {
      const fromMe = !!meEmail && r.from.toLowerCase() === meEmail;
      return {
        id: hashId(threadId + '|' + r.from + '|' + r.text.slice(0, 120)),
        text: r.text.replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').slice(0, 20_000),
        html: cleanMailHtml(r.html, 'https://mail.yahoo.com/'),
        ts: parseMailDate(r.time) ?? (threadTs.get(threadId) ?? Date.now()) - (good.length - 1 - i) * 60_000,
        fromMe,
        senderId: fromMe ? 'me' : r.from || threadId,
        senderName: fromMe ? 'Ben' : r.fromName || r.from || 'Gönderen',
      };
    })
    .slice(-limit);
}

/** Açık iletiyi yeniden okunmadı yap (araç çubuğu düğmesi ya da Yahoo kısayolu Shift+K) */
async function markUnread(page: Page, threadId: string): Promise<void> {
  await page.waitForTimeout(500);
  const done = await page
    .evaluate(() => {
      const re = /^(Okunmadı olarak işaretle|Okunmamış olarak işaretle|Mark as unread)$/i;
      const b = Array.from(document.querySelectorAll<HTMLElement>('[data-test-id="toolbar-mark-unread"], button, [role="button"], [role="menuitem"]')).find(
        (e) => (e.getAttribute('data-test-id') === 'toolbar-mark-unread' || re.test((e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.innerText ?? '').trim())) && e.getBoundingClientRect().width > 0,
      );
      if (!b) return false;
      b.click();
      return true;
    })
    .catch(() => false);
  if (!done) {
    // Yahoo Mail klavye kısayolu: Shift+K = okunmadı olarak işaretle
    await page.keyboard.press('Shift+K').catch(() => undefined);
    bus.log('info', `Yahoo Mail: okunmamış düğmesi bulunamadı, kısayol denendi (${threadId.slice(0, 10)}…)`);
  }
}

/** İletiyi aç, Yanıtla'ya bas, düzenleyici kutusunu döndür */
async function openReply(page: Page, threadId: string): Promise<Locator> {
  await readThread(page, threadId, 1, false);
  await page
    .locator('[data-test-id="btn-reply-sender"], [data-test-id="toolbar-reply"], [aria-label="Yanıtla"], [aria-label="Reply"], button:has-text("Yanıtla"), button:has-text("Reply")')
    .first()
    .click({ timeout: 8000 });
  const box = page.locator('[data-test-id="rte"], [contenteditable="true"][role="textbox"], [contenteditable="true"]').last();
  await box.waitFor({ timeout: 10_000 });
  return box;
}

async function clickSend(page: Page): Promise<void> {
  await page.locator('[data-test-id="compose-send-button"], [aria-label="Gönder"], [aria-label="Send"], button:has-text("Gönder"), button:has-text("Send")').last().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

export const yahoo: Strategy = {
  unloadWhenIdle: true,
  watchSelector: ROW_SEL,
  home: HOME,
  loginHint: 'Açılan pencerede Yahoo hesabına normal şifrenle gir (doğrulama isterse tamamla; "Oturumumu açık tut" işaretli olsun); gelen kutusu görününce pencere kendiliğinden kapanır',

  async loggedIn(page, cookies, passive) {
    if (passive) {
      await passConsent(page);
      if (!/^https:\/\/mail\.yahoo\.com\//.test(page.url())) return false;
      return (await page.locator(ROW_SEL).count().catch(() => 0)) > 0 || !!cookies.T;
    }
    const r = await openMail(page);
    if (r === 'signin') return false;
    if (r) {
      await persistSessionCookies(page.context(), YAHOO_COOKIE_DOMAINS).catch(() => 0);
      return true;
    }
    // ne liste ne giriş sayfası (seçiciler eskimiş olabilir): oturum çerezi varsa bağlı say, günlük tanıyı gösterir
    return !!cookies.T;
  },

  async afterLogin(page) {
    await page.waitForTimeout(1500);
    const n = await persistSessionCookies(page.context(), YAHOO_COOKIE_DOMAINS).catch(() => 0);
    bus.log('info', `Yahoo Mail: ${n} oturum çerezi kalıcı yapıldı (görünmez tarayıcıda oturum sürsün diye)`);
  },

  async me(page) {
    await openMail(page);
    const email = await page
      .evaluate(() => {
        const el = document.querySelector('[data-test-id="account-email"], [data-test-id="profile-email"]');
        return (el?.textContent ?? document.body.innerText).match(/[\w.+-]+@(yahoo|ymail|rocketmail)\.[a-z.]+/i)?.[0] ?? '';
      })
      .catch(() => '');
    meEmail = email.toLowerCase();
    return { id: meEmail || 'yahoo', label: email || 'Yahoo Mail' };
  },

  async threads(page): Promise<Thread[]> {
    const r = await openMail(page);
    if (r === 'signin') throw new Error('Yahoo oturumu düşmüş (giriş sayfası açılıyor) — kanal uyarısından Yeniden bağlan');
    if (!r) {
      bus.log('warn', `Yahoo Mail: ileti listesi bulunamadı (sayfa: ${page.url()}). Seçiciler değişmiş olabilir; Yeniden bağlan ile pencereyi açıp kontrol et.`);
      return [];
    }
    await persistSessionCookies(page.context(), YAHOO_COOKIE_DOMAINS).catch(() => 0);
    if (!meEmail) await this.me(page, {});
    const rows = await readRows(page);
    const times = fillListTimes(rows.map((r) => parseMailDate(r.time)));
    return rows.map((row, i) => ({
      id: hashId(row.key),
      name: row.subject || '(konu yok)',
      kind: 'direct' as const,
      lastTs: times[i] !== undefined ? (threadTs.set(hashId(row.key), times[i]!), times[i]!) : 0,
      preview: `${row.sender}: ${row.snippet}`.slice(0, 200),
      unread: row.unread ? 1 : 0,
      participants: row.sender ? [{ id: row.senderEmail || row.sender, name: row.sender, handle: row.senderEmail || undefined }] : undefined,
    }));
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    return readThread(page, threadId, limit, true);
  },

  async send(page, _cookies, threadId, text) {
    const box = await openReply(page, threadId);
    await box.click();
    await box.fill(text);
    await clickSend(page);
    return undefined; // gerçek ileti yoklamayla gelir (köprü local- kimliği yazar)
  },
};
