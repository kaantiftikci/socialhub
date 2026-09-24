import type { Frame, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import { parseOutlookDate, persistSessionCookies } from './outlook.js';

/**
 * iCloud Mail (tarayıcı oturumu): kullanıcı görünür pencerede Apple hesabına girer (2FA dahil), sonra
 * icloud.com/mail görünmez pencerede açık kalır. iCloud web uygulaması içerik iframe'leri kullanır; ileti listesi
 * ve okuma bölmesi ARIA rolleriyle (listbox/option, article) tüm çerçevelerde aranır.
 * Uygulamaya özel şifre gerekmez. Deneysel: seçiciler ilk gerçek girişten sonra günlükteki tanıya göre ayarlanır.
 *
 * Oturumsuz durum (2026-09 doğrulandı): www.icloud.com/mail/ adresi değişmeden tanıtım sayfası gösterir
 * (`ui-button.sign-in-button` "Giriş Yap"); tıklanınca giriş formu idmsa.apple.com iframe'inde açılır. Bu yüzden
 * adres /mail olsa da oturum var sayılmaz. X-APPLE-WEBAUTH-TOKEN "Oturumumu açık tut" seçilmezse oturum çerezidir;
 * görünür → görünmez geçişte tarayıcı yeniden başladığı için Outlook'taki gibi kalıcılaştırılır.
 */
const HOME = 'https://www.icloud.com/mail/';
const APPLE_COOKIE_DOMAINS = /(^|\.)(icloud\.com|apple\.com)$/;

/** Giriş ekranı görünüyor mu (tanıtım sayfasındaki "Giriş Yap" düğmesi ya da Apple giriş iframe'i)? */
async function signInVisible(page: Page): Promise<boolean> {
  if (page.frames().some((f) => /^https:\/\/(idmsa|appleid)\.apple\.com\//.test(f.url()))) return true;
  if (/^https:\/\/(idmsa|appleid)\.apple\.com\//.test(page.url())) return true;
  return (await page.locator('ui-button.sign-in-button, .sign-in-button').count().catch(() => 0)) > 0;
}

let meEmail = '';

/** İleti listesini içeren çerçeve (ana sayfa ya da iframe) */
async function mailFrame(page: Page): Promise<Frame | undefined> {
  for (const f of page.frames()) {
    const n = await f.locator('[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]').count().catch(() => 0);
    if (n > 0) return f;
  }
  return undefined;
}

/** Mail'i aç; ileti listesinin çerçevesini ya da 'signin' (oturum yok/düşmüş) döndür. */
async function openMail(page: Page): Promise<Frame | 'signin' | undefined> {
  if (!page.url().startsWith('https://www.icloud.com/mail')) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  let signin = 0;
  for (let i = 0; i < 25; i++) {
    const f = await mailFrame(page);
    if (f) return f;
    // açılışta tanıtım sayfası bir an görünebilir: 8 sn sürerse oturum yok say
    if (await signInVisible(page)) {
      if (++signin >= 8) return 'signin';
    } else signin = 0;
    await page.waitForTimeout(1000);
  }
  return (await signInVisible(page)) ? 'signin' : undefined;
}

async function ensureInbox(page: Page): Promise<Frame | undefined> {
  const r = await openMail(page);
  return r === 'signin' ? undefined : r;
}

export const icloud: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede "Giriş Yap"a bas, Apple hesabına gir (iki adımlı doğrulama dahil; "Oturumumu açık tut"u işaretle); Mail görününce pencere kendiliğinden kapanır',

  async loggedIn(page, cookies, passive) {
    if (passive) {
      // giriş penceresi: yönlendirme yok. Oturum belirteci geldi ve giriş ekranı kalktıysa ya da liste çizildiyse tamam
      if (!/icloud\.com\/mail/.test(page.url())) return false;
      if (await mailFrame(page)) return true;
      return !!cookies['X-APPLE-WEBAUTH-TOKEN'] && !(await signInVisible(page));
    }
    // X-APPLE-WEBAUTH-USER oturum bittikten sonra da kalır: kanıt değildir. Sayfanın gerçekten ne gösterdiğine bak.
    const r = await openMail(page);
    if (r === 'signin') return false;
    if (r) {
      await persistSessionCookies(page.context(), APPLE_COOKIE_DOMAINS).catch(() => 0);
      return true;
    }
    // ne liste ne giriş ekranı (seçiciler eskimiş olabilir): belirteç varsa bağlı say, günlük tanıyı gösterir
    return !!cookies['X-APPLE-WEBAUTH-TOKEN'];
  },

  async afterLogin(page) {
    await page.waitForTimeout(1500);
    const n = await persistSessionCookies(page.context(), APPLE_COOKIE_DOMAINS).catch(() => 0);
    bus.log('info', `iCloud Mail: ${n} oturum çerezi kalıcı yapıldı (görünmez tarayıcıda oturum sürsün diye)`);
  },

  async me(page) {
    await ensureInbox(page);
    const email = await page
      .evaluate(() => (document.body.innerText.match(/[\w.+-]+@(icloud|me|mac)\.com/i) ?? [])[0] ?? '')
      .catch(() => '');
    meEmail = email.toLowerCase();
    return { id: meEmail, label: email || 'iCloud Mail' };
  },

  async threads(page): Promise<Thread[]> {
    const r = await openMail(page);
    // "bağlı ama boş" kalmasın: hata → köprü isLoggedIn ile denetler ve "Yeniden bağlan" durumuna geçer
    if (r === 'signin') throw new Error('iCloud oturumu düşmüş (giriş ekranı görünüyor) — kanala sağ tık → Yeniden bağlan');
    const f = r;
    if (f) await persistSessionCookies(page.context(), APPLE_COOKIE_DOMAINS).catch(() => 0);
    if (!f) {
      const frames = page.frames().map((x) => x.url().slice(0, 60)).join(' | ');
      bus.log('warn', `iCloud Mail: ileti listesi bulunamadı (sayfa: ${page.url()}; çerçeveler: ${frames}). Kanala sağ tık → Yeniden bağlan ile pencereyi açıp kontrol et.`);
      return [];
    }
    if (!meEmail) await this.me(page, {});
    const rows = await f.evaluate(() => {
      const out: Array<{ id: string; label: string; unread: boolean; lines: string[] }> = [];
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]'));
      items.forEach((el, i) => {
        const label = el.getAttribute('aria-label') ?? '';
        const id = (el.getAttribute('data-id') ?? el.getAttribute('data-message-id') ?? el.id) || `row-${i}-${label.slice(0, 40)}`;
        const unread = /okunmamış|unread/i.test(label) || !!el.querySelector('[aria-label*="Okunmamış"], [aria-label*="Unread"], .unread');
        const lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
        out.push({ id, label, unread, lines });
      });
      return out;
    });
    return rows.map((r) => {
      const [sender = '', subject = '(konu yok)', ...rest] = r.lines;
      const time = r.lines.find((l) => /\d{1,2}[:.]\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/.test(l)) ?? '';
      return { id: hashId(r.id), name: subject, kind: 'direct' as const, lastTs: parseOutlookDate(time) ?? 0, preview: `${sender}: ${rest.filter((l) => l !== time).join(' ')}`.slice(0, 200), unread: r.unread ? 1 : 0, participants: sender ? [{ id: sender, name: sender }] : undefined };
    });
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    const f = await ensureInbox(page);
    if (!f) return [];
    // satırı bul ve tıkla (kimlik hash'i satır metninden türetildiği için satırlar yeniden taranır)
    const idx = await f.evaluate((hashTarget) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]'));
      const h = (s: string) => {
        let x = 2166136261;
        for (let i = 0; i < s.length; i++) {
          x ^= s.charCodeAt(i);
          x = Math.imul(x, 16777619);
        }
        return (x >>> 0).toString(36);
      };
      return items.findIndex((el, i) => {
        const label = el.getAttribute('aria-label') ?? '';
        const id = (el.getAttribute('data-id') ?? el.getAttribute('data-message-id') ?? el.id) || `row-${i}-${label.slice(0, 40)}`;
        return h(id) === hashTarget;
      });
    }, threadId);
    if (idx < 0) return [];
    await f.locator('[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]').nth(idx).click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const rows: Array<{ text: string; from: string; time: string }> = [];
    for (const fr of page.frames()) {
      const got = await fr
        .evaluate(() => {
          const arts = Array.from(document.querySelectorAll<HTMLElement>('[role="article"], article, [role="document"]'));
          return arts.map((a) => ({ text: a.innerText.trim(), from: (a.innerText.match(/[\w.+-]+@[\w.-]+/) ?? [])[0] ?? '', time: (a.innerText.match(/\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{1,2}:\d{2}|\d{1,2}:\d{2}/) ?? [])[0] ?? '' }));
        })
        .catch(() => [] as Array<{ text: string; from: string; time: string }>);
      rows.push(...got.filter((r) => r.text.length > 0));
    }
    return rows
      .map((r, i) => {
        const fromMe = !!meEmail && r.from.toLowerCase() === meEmail;
        return { id: hashId(threadId + '|' + r.from + '|' + r.text.slice(0, 120)), text: r.text.slice(0, 8000), ts: parseOutlookDate(r.time) ?? Date.now() - (rows.length - i) * 60_000, fromMe, senderId: fromMe ? 'me' : r.from || threadId, senderName: fromMe ? 'Ben' : r.from || 'Gönderen' };
      })
      .slice(-limit);
  },

  async send(page, _cookies, threadId, text) {
    await this.messages(page, _cookies, threadId, 1); // iletiyi aç
    const btn = page.locator('[aria-label="Yanıtla"], [aria-label="Reply"], button:has-text("Yanıtla"), button:has-text("Reply")').first();
    await btn.click({ timeout: 8000 });
    const box = page.locator('[contenteditable="true"][role="textbox"], [contenteditable="true"]').last();
    await box.waitFor({ timeout: 10_000 });
    await box.click();
    await box.fill(text);
    await page.locator('[aria-label="Gönder"], [aria-label="Send"], button:has-text("Gönder"), button:has-text("Send")').last().click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },
};
