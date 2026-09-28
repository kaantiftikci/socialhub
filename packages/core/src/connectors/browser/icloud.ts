import type { Frame, Locator, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import { fillListTimes, parseMailDate, persistSessionCookies, pickFileInput } from './outlook.js';
import { cleanMailHtml } from '../mail-html.js';

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
/** Liste satırının zamanı (ileti görünümünde zaman okunamazsa yedek) */
const threadTs = new Map<string, number>();

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
  unloadWhenIdle: true,
  // canlı liste izleme (bridge watchDom): sayfa açıkken yeni e-posta satırı düşünce birkaç sn içinde yoklama
  watchSelector: '[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]',
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
    const rows = await readRows(f);
    const timeOf = (r: (typeof rows)[number]) => r.lines.find((l) => parseMailDate(l) !== undefined) ?? '';
    const times = fillListTimes(rows.map((r) => parseMailDate(timeOf(r))));
    return rows.map((r, i) => {
      const [sender = '', subject = '(konu yok)', ...rest] = r.lines;
      const time = timeOf(r);
      if (times[i] !== undefined) threadTs.set(hashId(r.key), times[i]!);
      return { id: hashId(r.key), name: subject, kind: 'direct' as const, lastTs: times[i] ?? 0, preview: `${sender}: ${rest.filter((l) => l !== time).join(' ')}`.slice(0, 200), unread: r.unread ? 1 : 0, participants: sender ? [{ id: sender, name: sender }] : undefined };
    });
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    return readThread(page, threadId, limit, true);
  },

  async send(page, _cookies, threadId, text) {
    const box = await openReply(page, threadId);
    await box.click();
    await box.fill(text);
    await clickSend(page);
    // gerçek ileti yoklamayla gelir: undefined → köprü local- kimliği yazar, gerçek kayıt gelince metinle eşleşip silinir
    return undefined;
  },

  /**
   * Ekli yanıt: yanıt düzenleyicisi açıldıktan sonra tüm çerçevelerde `input[type=file]` aranır (iCloud Mail
   * içerik iframe'lerinde çalışır), dosya türüne uyan girişe setInputFiles, sonra metin ve Gönder.
   * DOĞRULANMADI: bu makinede iCloud oturumu yok; seçiciler ilk gerçek girişte günlükle ayarlanmalı.
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    const box = await openReply(page, threadId);
    let input: Locator | undefined;
    for (let i = 0; i < 20 && !input; i++) {
      for (const f of page.frames()) {
        const inputs = f.locator('input[type="file"]');
        const n = await inputs.count().catch(() => 0);
        if (!n) continue;
        const accepts: Array<{ accept: string | null }> = [];
        for (let k = 0; k < n; k++) accepts.push({ accept: await inputs.nth(k).getAttribute('accept').catch(() => null) });
        const idx = pickFileInput(accepts, file);
        if (idx >= 0) {
          input = inputs.nth(idx);
          break;
        }
      }
      if (!input) await page.waitForTimeout(250);
    }
    if (!input) throw new Error('iCloud Mail: yanıt düzenleyicisinde dosya girişi bulunamadı (seçici doğrulanmadı)');
    await input.setInputFiles(file.path);
    // yükleme: ilerleme çubuğu kaybolana dek (en çok dosya boyutuna göre)
    const t0 = Date.now();
    const maxMs = Math.max(30_000, Math.min(300_000, file.size / 50));
    for (let quiet = 0; quiet < 3 && Date.now() - t0 < maxMs; ) {
      await page.waitForTimeout(500);
      let busy = false;
      for (const f of page.frames()) busy ||= await f.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="progressbar"]')).some((e) => e.offsetParent !== null)).catch(() => false);
      quiet = busy ? 0 : quiet + 1;
    }
    if (caption) {
      await box.click();
      await box.fill(caption);
    }
    await clickSend(page);
    return undefined;
  },
};

const ROW_SEL = '[role="listbox"] [role="option"], [role="list"] [role="listitem"], [role="grid"] [role="row"]';

interface IcloudRow {
  /** kararlı anahtar: DOM kimliği; yoksa satır içeriği (zaman ifadeleri hariç) — satır sırası DEĞİL (yeni posta gelince kayardı) */
  key: string;
  label: string;
  unread: boolean;
  lines: string[];
}

/** Liste satırlarını DOM sırasıyla oku (threads ve messages aynı anahtarı üretsin diye tek yerde) */
function readRows(f: Frame): Promise<IcloudRow[]> {
  return f.evaluate((sel) => {
    const out: IcloudRow[] = [];
    const seen = new Map<string, number>();
    const timeRe = /\d{1,2}[:.]\d{2}(\s*(AM|PM|ÖÖ|ÖS))?|\d{1,2}[./]\d{1,2}[./]\d{2,4}|^(Dün|Yesterday|Bugün|Today)$/gi;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const label = el.getAttribute('aria-label') ?? '';
      const lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
      const unread = /okunmamış|unread/i.test(label) || !!el.querySelector('[aria-label*="Okunmamış"], [aria-label*="Unread"], .unread');
      let key = el.getAttribute('data-id') ?? el.getAttribute('data-message-id') ?? el.id ?? '';
      if (!key) {
        // içerikten: gönderen + konu + önizleme başı; zaman ve okunmamış işaretleri atılır (zamanla/okununca değişmesin)
        const content = lines
          .map((l) => l.replace(timeRe, '').replace(/okunmamış|unread/gi, '').trim())
          .filter(Boolean)
          .slice(0, 3)
          .join('|')
          .slice(0, 200);
        const base = 'c:' + content;
        // aynı içerikli satırlar (ör. aynı otomatik bildirim) ayrılsın
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        key = n ? `${base}#${n}` : base;
      }
      out.push({ key, label, unread, lines });
    }
    return out;
  }, ROW_SEL);
}

/**
 * Satırı bul, tıkla ve okuma bölmesindeki iletileri oku. Tıklamak iCloud'da iletiyi okundu yapar: restore=true ise
 * (yoklama) satır okunmamışsa okuduktan sonra "Okunmadı olarak işaretle" ile geri alınır.
 */
async function readThread(page: Page, threadId: string, limit: number, restore: boolean): Promise<Msg[]> {
  const f = await ensureInbox(page);
  if (!f) return [];
  const list = await readRows(f).catch(() => [] as IcloudRow[]);
  const idx = list.findIndex((r) => hashId(r.key) === threadId);
  if (idx < 0) return [];
  const wasUnread = list[idx].unread;
  await f.locator(ROW_SEL).nth(idx).click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const rows: Array<{ text: string; from: string; time: string; html: string }> = [];
  for (const fr of page.frames()) {
    const got = await fr
      .evaluate(() => {
        const arts = Array.from(document.querySelectorAll<HTMLElement>('[role="article"], article, [role="document"]'));
        return arts.map((a) => ({ html: a.innerHTML, text: a.innerText.trim(), from: (a.innerText.match(/[\w.+-]+@[\w.-]+/) ?? [])[0] ?? '', time: (a.innerText.match(/\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{1,2}:\d{2}|\d{1,2}:\d{2}/) ?? [])[0] ?? '' }));
      })
      .catch(() => [] as Array<{ text: string; from: string; time: string; html: string }>);
    rows.push(...got.filter((r) => r.text.length > 0));
  }
  if (restore && wasUnread) await markUnread(page, threadId);
  return rows
    .map((r, i) => {
      const fromMe = !!meEmail && r.from.toLowerCase() === meEmail;
      return { id: hashId(threadId + '|' + r.from + '|' + r.text.slice(0, 120)), text: r.text.replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').slice(0, 20_000), html: cleanMailHtml(r.html, 'https://www.icloud.com/'), ts: parseMailDate(r.time) ?? (threadTs.get(threadId) ?? Date.now()) - (rows.length - 1 - i) * 60_000, fromMe, senderId: fromMe ? 'me' : r.from || threadId, senderName: fromMe ? 'Ben' : r.from || 'Gönderen' };
    })
    .slice(-limit);
}

/** Açık iletiyi yeniden okunmadı yap (tüm çerçevelerde düğme aranır; bulunamazsa günlüğe yazılır) */
async function markUnread(page: Page, threadId: string): Promise<void> {
  await page.waitForTimeout(600);
  let done = false;
  for (const fr of page.frames()) {
    done = await fr
      .evaluate(() => {
        const re = /^(Okunmadı olarak işaretle|Okunmamış olarak işaretle|Mark as Unread)$/i;
        const b = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], ui-button')).find(
          (e) => re.test((e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.innerText ?? '').trim()) && e.getBoundingClientRect().width > 0,
        );
        if (!b) return false;
        b.click();
        return true;
      })
      .catch(() => false);
    if (done) break;
  }
  if (!done) bus.log('info', `iCloud Mail: okunmamış durumu geri alınamadı (${threadId.slice(0, 10)}…)`);
}

/** İletiyi aç, Yanıtla'ya bas, düzenleyici kutusunu döndür */
async function openReply(page: Page, threadId: string): Promise<Locator> {
  await readThread(page, threadId, 1, false); // iletiyi aç (yanıtlanacak: okunmamışa geri alınmaz)
  const btn = page.locator('[aria-label="Yanıtla"], [aria-label="Reply"], button:has-text("Yanıtla"), button:has-text("Reply")').first();
  await btn.click({ timeout: 8000 });
  const box = page.locator('[contenteditable="true"][role="textbox"], [contenteditable="true"]').last();
  await box.waitFor({ timeout: 10_000 });
  return box;
}

async function clickSend(page: Page): Promise<void> {
  await page.locator('[aria-label="Gönder"], [aria-label="Send"], button:has-text("Gönder"), button:has-text("Send")').last().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}
