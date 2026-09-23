import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';

/**
 * Messenger: uçtan uca şifreleme varsayılan olduğundan iç API yerine DOM okunur.
 * Sohbet listesi sol kenardan, mesajlar açık sohbetin satırlarından toplanır;
 * gönderme yazı kutusuna yazıp Enter'a basarak yapılır. "Deneysel": arayüz değişince
 * seçicilerin güncellenmesi gerekir.
 */
const BASE = 'https://www.messenger.com';

async function openThread(page: Page, id: string): Promise<void> {
  if (!page.url().includes(`/t/${id}`)) {
    await page.goto(`${BASE}/t/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  }
}

export const messenger: Strategy = {
  home: `${BASE}/`,
  loginHint: 'Açılan pencerede Facebook hesabına giriş yap',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.c_user && cookies.xs);
  },

  async me(_page, cookies) {
    return { id: cookies.c_user ?? '', label: 'Messenger' };
  },

  async threads(page): Promise<Thread[]> {
    if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; name: string; preview: string; unread: boolean }> = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[role="link"][href*="/t/"]'))) {
        const m = a.getAttribute('href')?.match(/\/t\/([^/?#]+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const spans = Array.from(a.querySelectorAll('span')).map((s) => s.textContent?.trim() ?? '').filter((t) => t.length > 0);
        const name = spans[0] ?? m[1];
        const preview = spans.find((t, i) => i > 0 && t !== name) ?? '';
        const bold = Array.from(a.querySelectorAll('span')).some((s) => Number(getComputedStyle(s).fontWeight) >= 600);
        out.push({ id: m[1], name, preview, unread: bold });
      }
      return out;
    });
    if (rows.length === 0) {
      const title = await page.title().catch(() => '?');
      bus.log('warn', `Messenger: sohbet listesi bulunamadı (sayfa: ${page.url()} · "${title}"). Görünmez modda engelleniyorsa kanala sağ tık → Yeniden bağlan ile pencereyi açıp deneyin.`);
    }
    const now = Date.now();
    return rows.map((r, i) => ({ id: r.id, name: r.name, kind: 'direct' as const, lastTs: now - i * 60_000, preview: r.preview, unread: r.unread ? 1 : 0 }));
  },

  async messages(page, _cookies, threadId): Promise<Msg[]> {
    await openThread(page, threadId);
    const rows = await page.evaluate(() => {
      const mid = window.innerWidth / 2;
      const out: Array<{ text: string; me: boolean }> = [];
      for (const row of Array.from(document.querySelectorAll<HTMLElement>('div[role="row"]'))) {
        const text = row.innerText?.trim();
        if (!text || text.length > 4000) continue;
        const bubble = row.querySelector<HTMLElement>('div[dir="auto"]') ?? row;
        const rect = bubble.getBoundingClientRect();
        out.push({ text, me: rect.left + rect.width / 2 > mid });
      }
      return out;
    });
    const base = Date.now() - rows.length * 1000;
    return rows.map((r, i) => ({
      id: hashId(threadId + '|' + r.text),
      text: r.text,
      ts: base + i * 1000,
      fromMe: r.me,
      senderId: r.me ? 'me' : threadId,
      senderName: r.me ? 'Ben' : 'Karşı taraf',
    }));
  },

  async send(page, _cookies, threadId, text) {
    await openThread(page, threadId);
    const box = page.locator('div[role="textbox"][contenteditable="true"]').first();
    await box.click();
    await box.fill(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    return hashId(threadId + '|' + text);
  },
};
