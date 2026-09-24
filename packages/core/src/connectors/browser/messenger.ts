import type { Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';

/**
 * Messenger: uçtan uca şifreleme varsayılan olduğundan iç API yerine DOM okunur.
 *
 * - Facebook çerezleri (c_user/xs) olsa da messenger.com ilk açılışta "<Ad> Olarak Devam Et" ara sayfasında
 *   kalır; gelen kutusu ancak bu düğmeye tıklanınca açılır. (Sohbet listesinin boş dönmesinin nedeni buydu.)
 * - Sohbet listesi sol kenardaki `/t/<id>/` bağlantılarından; kenar çubuğundaki gezinme bağlantıları
 *   (`?focus_target=`, /marketplace/t/, /requests/t/…) elenir.
 * - Mesajlar `[role=main] [role=log]` içindeki `data-scope="messages_table"` öğelerinden okunur; aria-label
 *   "24 Aralık 2021 19:50, Sen: metin" biçiminde zaman + gönderen taşır.
 * Deneysel: arayüz değişince seçicilerin güncellenmesi gerekir.
 */
const BASE = 'https://www.messenger.com';
const CHAT_LINK = 'a[href^="/t/"]';

/** "Olarak Devam Et" ara sayfası varsa geç; gelen kutusu bağlantıları görünene dek bekle. */
async function ensureInbox(page: Page, timeout = 20_000): Promise<boolean> {
  const cont = page.locator('button, [role="button"]').filter({ hasText: /Olarak Devam Et|Continue as/i }).first();
  const t0 = Date.now();
  let clicked = false;
  // Düğme sayfa yüklendikten birkaç saniye sonra çiziliyor: bağlantı ya da düğme görünene dek yokla
  while (Date.now() - t0 < timeout) {
    if (await page.locator(CHAT_LINK).count().catch(() => 0)) return true;
    if (!clicked && (await cont.count().catch(() => 0))) {
      bus.log('info', 'Messenger: "Devam Et" ara sayfası geçiliyor');
      await cont.click({ timeout: 5000 }).catch(() => undefined);
      clicked = true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function openThread(page: Page, id: string): Promise<void> {
  if (!page.url().includes(`/t/${id}`)) {
    await page.goto(`${BASE}/t/${id}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await ensureInbox(page, 15_000);
  }
  await page.waitForSelector('[role="main"] [role="log"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

/** Son görülen önizleme: değişmediyse lastTs=0 döner (depodaki zaman korunur), değiştiyse "şimdi". */
const lastPreview = new Map<string, string>();

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
    if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const ready = await ensureInbox(page);
    if (!ready) {
      const title = await page.title().catch(() => '?');
      bus.log('warn', `Messenger: sohbet listesi bulunamadı (sayfa: ${page.url()} · "${title}"). Görünmez modda engelleniyorsa kanala sağ tık → Yeniden bağlan ile pencereyi açıp deneyin.`);
      return [];
    }
    await page.waitForTimeout(800);
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; name: string; preview: string; unread: boolean }> = [];
      const seen = new Set<string>();
      const mainLeft = document.querySelector('[role="main"]')?.getBoundingClientRect().left ?? window.innerWidth;
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/t/"]'))) {
        const m = a.getAttribute('href')?.match(/^\/t\/(\d+)\/?$/);
        if (!m || seen.has(m[1])) continue;
        if (a.getBoundingClientRect().left >= mainLeft) continue; // sohbet penceresi içindeki bağlantılar
        seen.add(m[1]);
        const spans = Array.from(a.querySelectorAll('span'))
          .map((s) => ({ t: s.textContent?.trim() ?? '', w: Number(getComputedStyle(s).fontWeight) || 400 }))
          .filter((s) => s.t.length > 0 && !/^(Şu An Aktif|Active now)$/i.test(s.t));
        const nameSpan = spans.find((s) => s.w >= 500) ?? spans[0];
        const name = nameSpan?.t ?? m[1];
        let preview = spans.find((s) => s.t !== name)?.t ?? '';
        const unreadPrefix = /^(Okunmamış mesaj|Unread message):\s*/i;
        const unread = (nameSpan?.w ?? 400) >= 600 || unreadPrefix.test(preview);
        preview = preview.replace(unreadPrefix, '');
        out.push({ id: m[1], name, preview, unread });
      }
      return out;
    });
    if (rows.length === 0) bus.log('warn', `Messenger: gelen kutusu açık ama sohbet bağlantısı okunamadı (${page.url()})`);
    const now = Date.now();
    return rows.map((r) => {
      const prev = lastPreview.get(r.id);
      lastPreview.set(r.id, r.preview);
      // ilk görüşte ya da önizleme değiştiyse "şimdi"; yoksa 0 → depodaki zaman kalır (sohbet üste fırlamaz)
      // ilk görüşte 0 → mesajlar çekilince gerçek zaman yazılır; sonraki yoklamada önizleme değiştiyse yeni mesaj (şimdi)
      const lastTs = prev !== undefined && prev !== r.preview ? now : 0;
      return { id: r.id, name: r.name, kind: 'direct' as const, lastTs, preview: r.preview, unread: r.unread ? 1 : 0 };
    });
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    await openThread(page, threadId);
    const rows = await page.evaluate(() => {
      const main = document.querySelector('[role="main"]');
      const log = main?.querySelector('[role="log"]') ?? main ?? document.body;
      const mainRect = (main ?? document.body).getBoundingClientRect();
      const out: Array<{ aria: string; text: string; me: boolean | undefined; hasMedia: boolean }> = [];
      for (const el of Array.from(log.querySelectorAll<HTMLElement>('[data-scope="messages_table"]'))) {
        const aria = el.getAttribute('aria-label') ?? '';
        const parts: string[] = [];
        for (const t of Array.from(el.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]'))) {
          const s = t.innerText?.trim();
          if (s && !parts.includes(s) && !parts.some((p) => p.includes(s))) parts.push(s);
        }
        const text = parts.join('\n').slice(0, 4000);
        const hasMedia = !!el.querySelector('img[src*="fbcdn"], video, a[href*="attachment"]');
        const r = el.getBoundingClientRect();
        // geometri yedeği: sağa yaslı balon = ben
        const me = r.width > 0 ? r.left + r.width > mainRect.left + mainRect.width * 0.6 : undefined;
        out.push({ aria, text, me, hasMedia });
      }
      return out;
    });
    const fallbackBase = Date.now() - rows.length * 1000;
    const msgs: Msg[] = [];
    rows.forEach((r, i) => {
      const parsed = parseAria(r.aria);
      // aria-label'ı "tarih, Gönderen: …" biçiminde olmayanlar tarih ayırıcı / sistem satırı / profil başlığıdır
      if (!parsed) return;
      const fromMe = parsed.me;
      const text = r.text || (r.hasMedia ? '[Ek]' : '');
      if (!text) return;
      msgs.push({
        id: hashId(threadId + '|' + (r.aria || text)),
        text,
        ts: parsed?.ts ?? fallbackBase + i * 1000,
        fromMe,
        senderId: fromMe ? 'me' : threadId,
        senderName: fromMe ? 'Ben' : parsed?.sender ?? 'Karşı taraf',
      });
    });
    return msgs.slice(-limit);
  },

  async send(page, _cookies, threadId, text) {
    await openThread(page, threadId);
    const box = page.locator('[role="main"] div[role="textbox"][contenteditable="true"]').first();
    await box.click();
    await box.fill(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    return hashId(threadId + '|' + text);
  },
};

const MONTHS: Record<string, number> = {
  ocak: 0, şubat: 1, mart: 2, nisan: 3, mayıs: 4, haziran: 5, temmuz: 6, ağustos: 7, eylül: 8, ekim: 9, kasım: 10, aralık: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "24 Aralık 2021 19:50, Sen: metin" / "Dec 24, 2021, 7:50 PM, You: text" → zaman, gönderen, ben mi */
function parseAria(aria: string): { ts?: number; sender: string; me: boolean } | undefined {
  const m = aria.match(/^(.*?),\s*([^:,]{1,60}):\s/s);
  if (!m) return undefined;
  const sender = m[2].trim();
  const me = /^(Sen|You)$/i.test(sender);
  return { ts: parseDate(m[1]), sender, me };
}

function parseDate(s: string): number | undefined {
  const tr = s.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (tr) {
    const mon = MONTHS[tr[2].toLocaleLowerCase('tr')];
    if (mon !== undefined) return new Date(Number(tr[3]), mon, Number(tr[1]), Number(tr[4]), Number(tr[5])).getTime();
  }
  const en = s.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (en) {
    const mon = MONTHS[en[1].toLowerCase()];
    let h = Number(en[4]);
    if (en[6]) h = (h % 12) + (en[6].toUpperCase() === 'PM' ? 12 : 0);
    if (mon !== undefined) return new Date(Number(en[3]), mon, Number(en[2]), h, Number(en[5])).getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}
