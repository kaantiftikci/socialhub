import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';

/**
 * Outlook.com (tarayıcı oturumu): Gmail stratejisiyle aynı yaklaşım — kullanıcı görünür pencerede Microsoft
 * hesabına girer, sonra outlook.live.com/mail görünmez pencerede açık kalır; ileti listesi ve okuma bölmesi
 * DOM'dan okunur, yanıt Outlook'un kendi düzenleyicisiyle gönderilir. Uygulama şifresi / Azure kimliği gerekmez.
 *
 * Seçiciler (Outlook web, 2025-2026): liste satırı div[role="option"][data-convid] (aria-label: "Okunmamış, Gönderen,
 * Konu, Önizleme, Tarih"); okuma bölmesi div[aria-label*="Message body" | "İleti gövdesi"]; gönderen span[title*="@"].
 * Deneysel: arayüz değişirse günlükteki "Outlook: … bulunamadı" satırı seçicilerin güncellenmesi gerektiğini gösterir.
 */
const BASE = 'https://outlook.live.com/mail/0/';
const HOME = BASE;

const MONTHS: Record<string, number> = {
  oca: 0, şub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Çar 24.09.2026 14:32", "24.09.2026 14:32", "Wed 9/24/2026 2:32 PM", "24 Eyl 14:32", "14:32" */
export function parseOutlookDate(s: string | undefined | null, now = new Date()): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m) {
    let h = Number(m[4] ?? 0);
    if (m[6]) h = (h % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5] ?? 0)).getTime();
  }
  m = t.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})\w*\.?(?:\s+(\d{4}))?(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const mon = MONTHS[m[2].toLocaleLowerCase('tr')];
    if (mon !== undefined) {
      const d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0));
      return !m[3] && d.getTime() > now.getTime() + 86400e3 ? new Date(now.getFullYear() - 1, mon, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime() : d.getTime();
    }
  }
  m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (m) {
    let h = Number(m[1]);
    if (m[3]) h = (h % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(m[2])).getTime();
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : undefined;
}

let meEmail = '';

async function ensureInbox(page: Page): Promise<boolean> {
  if (!/outlook\.(live|office)\.com\/mail/.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  return page
    .waitForSelector('div[role="option"][data-convid]', { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
}

async function openThread(page: Page, id: string): Promise<boolean> {
  if (!(await ensureInbox(page))) return false;
  const row = page.locator(`div[role="option"][data-convid="${id}"]`).first();
  if (!(await row.count().catch(() => 0))) return false;
  await row.click({ timeout: 8000 }).catch(() => undefined);
  const ok = await page
    .waitForSelector('div[aria-label*="Message body"], div[aria-label*="İleti gövdesi"], div[aria-label*="ileti gövdesi"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(800);
  return ok;
}

export const outlook: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede Microsoft hesabına giriş yap; gelen kutusu görününce pencere kendiliğinden kapanır',

  async loggedIn(page, _cookies, passive) {
    const url = page.url();
    if (/login\.live\.com|login\.microsoftonline\.com|account\.microsoft\.com/.test(url)) return false;
    if (/outlook\.(live|office)\.com\/mail/.test(url)) return true;
    if (passive) return false;
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    return /outlook\.(live|office)\.com\/mail/.test(page.url());
  },

  async me(page) {
    await ensureInbox(page);
    const info = await page
      .evaluate(() => {
        const btn = document.querySelector<HTMLElement>('#O365_MainLink_Me, button[aria-label*="Hesap yöneticisi"], button[aria-label*="Account manager"]');
        const label = btn?.getAttribute('aria-label') ?? btn?.innerText ?? '';
        const email = (document.body.innerText.match(/[\w.+-]+@(outlook|hotmail|live|msn)\.[a-z.]+/i) ?? [])[0] ?? (label.match(/[\w.+-]+@[\w.-]+/) ?? [])[0] ?? '';
        return { email, name: label.replace(/[\w.+-]+@[\w.-]+/, '').replace(/^(Hesap yöneticisi|Account manager)( for)?:?/i, '').trim() };
      })
      .catch(() => ({ email: '', name: '' }));
    meEmail = info.email.toLowerCase();
    return { id: meEmail, label: info.email || info.name || 'Outlook' };
  },

  async threads(page): Promise<Thread[]> {
    if (!(await ensureInbox(page))) {
      bus.log('warn', `Outlook: ileti listesi bulunamadı (sayfa: ${page.url()}). Görünmez modda engellendiyse kanala sağ tık → Yeniden bağlan.`);
      return [];
    }
    if (!meEmail) await this.me(page, {});
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; label: string; unread: boolean; sender: string; subject: string; preview: string; time: string }> = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('div[role="option"][data-convid]'))) {
        const id = el.getAttribute('data-convid') ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = el.getAttribute('aria-label') ?? '';
        const unread = /^(Okunmamış|Unread)/i.test(label) || !!el.querySelector('[aria-label="Okunmamış"], [aria-label="Unread"]');
        // aria-label: "Okunmamış, <gönderen>, <konu>, <önizleme>, <tarih>" — DOM'daki spanlar daha güvenilir
        const spans = Array.from(el.querySelectorAll<HTMLElement>('span[title], span')).map((s) => s.innerText.trim()).filter(Boolean);
        const parts = label.split(/,\s*/);
        const base = unread ? 1 : 0;
        out.push({ id, label, unread, sender: spans[0] ?? parts[base] ?? '', subject: parts[base + 1] ?? spans[1] ?? '(konu yok)', preview: parts[base + 2] ?? '', time: el.querySelector<HTMLElement>('span[title]')?.getAttribute('title') ?? parts[parts.length - 1] ?? '' });
      }
      return out;
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.subject || '(konu yok)',
      kind: 'direct' as const,
      lastTs: parseOutlookDate(r.time) ?? 0,
      preview: `${r.sender}: ${r.preview}`.slice(0, 200),
      unread: r.unread ? 1 : 0,
      participants: r.sender ? [{ id: r.sender, name: r.sender }] : undefined,
    }));
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    if (!(await openThread(page, threadId))) return [];
    const rows = await page.evaluate(() => {
      const out: Array<{ email: string; name: string; time: string; text: string }> = [];
      const bodies = Array.from(document.querySelectorAll<HTMLElement>('div[aria-label*="Message body"], div[aria-label*="İleti gövdesi"], div[aria-label*="ileti gövdesi"]'));
      for (const body of bodies) {
        // ileti kapsayıcısı: gövdeden yukarı, gönderen adresi içeren en yakın kutu
        let box: HTMLElement | null = body;
        for (let i = 0; i < 8 && box; i++) {
          box = box.parentElement;
          if (box?.querySelector('span[title*="@"], [aria-label*="@"]')) break;
        }
        const from = box?.querySelector<HTMLElement>('span[title*="@"]');
        const email = (from?.getAttribute('title')?.match(/[\w.+-]+@[\w.-]+/) ?? box?.innerText.match(/[\w.+-]+@[\w.-]+/) ?? [])[0] ?? '';
        const name = from?.innerText?.trim() ?? '';
        const timeEl = box?.querySelector<HTMLElement>('[data-testid="SentReceivedSavedTime"], span[title*=":"]');
        const clone = body.cloneNode(true) as HTMLElement;
        for (const q of Array.from(clone.querySelectorAll('blockquote, #divRplyFwdMsg, [id^="divRplyFwdMsg"]'))) q.remove();
        out.push({ email: email.toLowerCase(), name, time: timeEl?.getAttribute('title') ?? timeEl?.innerText ?? '', text: clone.innerText?.trim() ?? '' });
      }
      return out;
    });
    const msgs: Msg[] = rows
      .filter((r) => r.text)
      .map((r, i) => {
        const fromMe = !!meEmail && r.email === meEmail;
        return {
          id: hashId(threadId + '|' + r.email + '|' + r.time + '|' + r.text.slice(0, 80)),
          text: r.text,
          ts: parseOutlookDate(r.time) ?? Date.now() - (rows.length - i) * 60_000,
          fromMe,
          senderId: fromMe ? 'me' : r.email || threadId,
          senderName: fromMe ? 'Ben' : r.name || r.email || 'Gönderen',
        };
      });
    return msgs.slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    await openThread(page, threadId);
  },

  async send(page, _cookies, threadId, text) {
    if (!(await openThread(page, threadId))) throw new Error('İleti açılamadı');
    const reply = page.locator('button[aria-label="Yanıtla"], button[aria-label="Reply"], button[name="Yanıtla"], button[name="Reply"]').last();
    await reply.click({ timeout: 8000 });
    const body = page.locator('div[aria-label="Message body, press Alt+F10 to exit"], div[aria-label*="İleti gövdesi"][contenteditable="true"], div[aria-label*="Message body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]').last();
    await body.waitFor({ timeout: 10_000 });
    await body.click();
    await body.fill(text);
    const sendBtn = page.locator('button[aria-label="Gönder"], button[aria-label="Send"], button[name="Gönder"], button[name="Send"]').last();
    await sendBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },
};
