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

let meEmail = '';

async function readMe(page: Page): Promise<{ email: string; name: string }> {
  return page.evaluate(() => {
    const a = document.querySelector<HTMLElement>('a[aria-label*="Google Hesabı"], a[aria-label*="Google Account"], a[href*="accounts.google.com/SignOutOptions"]');
    const label = a?.getAttribute('aria-label') ?? '';
    const email = label.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? '';
    const name = label.replace(/\(.*$/, '').replace(/^(Google Hesabı|Google Account):?\s*/i, '').trim();
    return { email, name };
  });
}

async function ensureInbox(page: Page): Promise<boolean> {
  if (!page.url().startsWith(BASE)) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  return page
    .waitForSelector('tr.zA', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
}

async function openThread(page: Page, id: string): Promise<boolean> {
  const url = `${BASE}#inbox/${id}`;
  if (!page.url().includes(`/${id}`)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }
  const ok = await page
    .waitForSelector('div.adn', { timeout: 15_000 })
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

  async loggedIn(page, cookies) {
    if (!cookies.SID || !cookies.HSID) return false;
    if (page.url().startsWith('https://accounts.google.com/')) return false;
    if (page.url().startsWith(BASE)) return true;
    // Google giriş sonrası mail.google.com'a yönlendirir; başka bir sayfadaysak (ör. myaccount) gelen kutusunu dene
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    return page.url().startsWith(BASE);
  },

  async me(page) {
    if (!page.url().startsWith(BASE)) await ensureInbox(page);
    const { email, name } = await readMe(page).catch(() => ({ email: '', name: '' }));
    meEmail = email.toLowerCase();
    return { id: meEmail, label: email || name || 'Gmail' };
  },

  async threads(page): Promise<Thread[]> {
    const ok = await ensureInbox(page);
    if (!ok) {
      bus.log('warn', `Gmail: gelen kutusu satırları bulunamadı (sayfa: ${page.url()}). Görünmez modda engellendiyse kanala sağ tık → Yeniden bağlan ile pencereyi aç.`);
      return [];
    }
    if (!meEmail) await this.me(page, {});
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; name: string; email: string; subject: string; snippet: string; time: string; unread: boolean; count: number }> = [];
      const seen = new Set<string>();
      for (const tr of Array.from(document.querySelectorAll<HTMLElement>('tr.zA'))) {
        const idEl = tr.querySelector<HTMLElement>('[data-legacy-thread-id]');
        const id = idEl?.getAttribute('data-legacy-thread-id') ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const senders = Array.from(tr.querySelectorAll<HTMLElement>('span[email]'));
        const last = senders[senders.length - 1];
        const countTxt = tr.querySelector<HTMLElement>('.bA4 .bx0')?.innerText ?? '';
        out.push({
          id,
          name: last?.getAttribute('name') ?? last?.innerText ?? '',
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
    return rows.map((r) => {
      const others = r.email && r.email !== meEmail ? { name: r.name || r.email, email: r.email } : { name: r.name || 'Ben', email: r.email };
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
    });
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    if (!(await openThread(page, threadId))) return [];
    const rows = await page.evaluate(() => {
      const out: Array<{ id: string; name: string; email: string; time: string; text: string; atts: string[] }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('div.adn'))) {
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
        const attachments = r.atts
          .map((d): Attachment | undefined => {
            const m = d.match(/^([^:]+):([^:]*):(https?:\/\/.+)$/);
            if (!m) return undefined;
            const mime = m[1];
            const kind: Attachment['kind'] = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
            const att: Attachment = { kind, name: decodeURIComponent(m[2]) || undefined, mime, url: kind === 'image' ? m[3] : undefined, link: m[3] };
            return att;
          })
          .filter((a): a is Attachment => !!a);
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
    return msgs.slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    await openThread(page, threadId); // dizi açılınca Gmail okundu sayar
  },

  async send(page, _cookies, threadId, text) {
    if (!(await openThread(page, threadId))) throw new Error('İleti dizisi açılamadı');
    // son iletinin "Yanıtla" bağlantısı (tr/en)
    const reply = page.locator('span.ams.bkH, [aria-label="Yanıtla"], [aria-label="Reply"], [data-tooltip="Yanıtla"], [data-tooltip="Reply"]').last();
    await reply.click({ timeout: 8000 });
    const body = page.locator('div[aria-label="Mesaj Gövdesi"], div[aria-label="Message Body"], div[role="textbox"][contenteditable="true"]').last();
    await body.waitFor({ timeout: 10_000 });
    await body.click();
    await body.fill(text);
    const sendBtn = page.locator('div[role="button"][aria-label^="Gönder"], div[role="button"][aria-label^="Send"], div[role="button"][data-tooltip^="Gönder"], div[role="button"][data-tooltip^="Send"]').last();
    await sendBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },
};
