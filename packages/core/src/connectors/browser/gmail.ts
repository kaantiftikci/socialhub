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
 * Liste görünümüne dön ve görünür satırları bekle. messages()/markRead bir diziyi açınca sayfa #inbox/<id>'de
 * kalır; o görünümde gelen kutusu satırları DOM'da ama gizlidir → görünür tr.zA hiç gelmez. Önce SPA içinde
 * hash'i değiştir (hızlı), olmazsa sayfayı yeniden yükle.
 */
async function ensureInbox(page: Page): Promise<boolean> {
  const visibleRows = (ms: number) =>
    page
      .waitForSelector('tr.zA', { state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);
  if (page.url().startsWith(BASE)) {
    if (!isInboxListUrl(page.url())) {
      await page.evaluate(() => {
        location.hash = '#inbox';
      }).catch(() => undefined);
    }
    if (await visibleRows(10_000)) return true;
  }
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  return visibleRows(20_000);
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
    const rows = await page.evaluate(() => {
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
