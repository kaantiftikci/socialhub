import type { Frame, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import { parseOutlookDate } from './outlook.js';

/**
 * iCloud Mail (tarayıcı oturumu): kullanıcı görünür pencerede Apple hesabına girer (2FA dahil), sonra
 * icloud.com/mail görünmez pencerede açık kalır. iCloud web uygulaması içerik iframe'leri kullanır; ileti listesi
 * ve okuma bölmesi ARIA rolleriyle (listbox/option, article) tüm çerçevelerde aranır.
 * Uygulamaya özel şifre gerekmez. Deneysel: seçiciler ilk gerçek girişten sonra günlükteki tanıya göre ayarlanır.
 */
const HOME = 'https://www.icloud.com/mail/';

let meEmail = '';

/** İleti listesini içeren çerçeve (ana sayfa ya da iframe) */
async function mailFrame(page: Page): Promise<Frame | undefined> {
  for (const f of page.frames()) {
    const n = await f.locator('[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]').count().catch(() => 0);
    if (n > 0) return f;
  }
  return undefined;
}

async function ensureInbox(page: Page): Promise<Frame | undefined> {
  if (!page.url().startsWith('https://www.icloud.com/mail')) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  for (let i = 0; i < 25; i++) {
    const f = await mailFrame(page);
    if (f) return f;
    await page.waitForTimeout(1000);
  }
  return undefined;
}

export const icloud: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede Apple hesabına giriş yap (iki adımlı doğrulama dahil); Mail görününce pencere kendiliğinden kapanır',

  async loggedIn(page, _cookies, passive) {
    const url = page.url();
    if (/appleid\.apple\.com|idmsa\.apple\.com|icloud\.com\/?(#|$)/.test(url) && !/\/mail/.test(url)) return false;
    if (/icloud\.com\/mail/.test(url)) {
      // giriş ekranı da /mail altında olabilir: oturum çerezi (X-APPLE-WEBAUTH-USER) ya da listbox varlığı
      if (_cookies['X-APPLE-WEBAUTH-USER'] || _cookies['X-APPLE-WEBAUTH-TOKEN']) return true;
      return !!(await mailFrame(page));
    }
    if (passive) return false;
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    return !!(_cookies['X-APPLE-WEBAUTH-USER'] || (await mailFrame(page)));
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
    const f = await ensureInbox(page);
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
