import type { Locator, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { bus } from '../../bus.js';
import { fillListTimes, parseMailDate, persistSessionCookies } from './outlook.js';
import { cleanMailHtml } from '../mail-html.js';

/**
 * Yandex Mail (tarayıcı oturumu): kullanıcı görünür pencerede passport.yandex.com'da normal şifresiyle (SMS/QR doğrulamasıyla)
 * girer, sonra mail.yandex.com görünmez pencerede okunur. Yandex posta uygulamalarında (IMAP) normal şifreyi kabul etmiyor;
 * uygulama şifresi zahmetli olduğu için varsayılan yol budur (eski IMAP hesapları token dosyasıyla çalışmaya devam eder).
 *
 * Seçiciler: Yandex Mail web istemcisinin (liza) BEM sınıfları — mail-MessageSnippet (satır), -FromText (gönderen, title = adres),
 * -Item_subject, -Item_firstline, -Item_dateText (title = tam tarih), okunmamış işareti; ileti görünümü mail-Message-Body-Content,
 * mail-Message-Sender-Email, mail-Message-Date. Yeni arayüz için data-testid / ARIA yedekleri var.
 * DOĞRULANMADI (bu makinede Yandex oturumu yok): ilk gerçek girişte günlükteki tanıyla ayarlanır.
 */
const HOME = 'https://mail.yandex.com/';
const YANDEX_COOKIE_DOMAINS = /(^|\.)yandex\.(com|com\.tr|ru)$/;
// Dizi (thread, "8 ▾" sayılı) satırları bağlantı değil: tıklanınca yerinde açılan div → yalnız a.mail-MessageSnippet onları kaçırıyordu
// (Kaan: bugünkü ve bazı eski e-postalar yoktu — hepsi dizi satırıydı). En dıştaki eşleşme satır sayıldığı için iç içe eşleşme sorun değil.
const ROW_SEL = '.ns-view-messages-item-wrap a.mail-MessageSnippet, a.mail-MessageSnippet, .mail-MessageSnippet, [data-testid="message-list-item"], [data-testid*="message-snippet" i], [role="listitem"] a[href*="message"]';

let meEmail = '';
/** Liste satırının zamanı (ileti görünümünde zaman okunamazsa yedek; "şimdi" yazılınca sıra bozuluyordu) */
const threadTs = new Map<string, number>();

const onMail = (u: string) => /^https:\/\/mail\.yandex\.(com|com\.tr|ru)\//.test(u);
/** Oturum yokken mail.yandex.com giriş formuna değil Yandex ana sayfasına yönlendiriyor → giriş penceresi doğrudan buraya gider */
const LOGIN_URL = 'https://passport.yandex.com/auth?retpath=' + encodeURIComponent(HOME);
const onPortal = (u: string) => /^https:\/\/(www\.)?(yandex\.(com|com\.tr|ru)|ya\.ru)\/?([?#].*)?$/.test(u);
const onLogin = (u: string) => /^https:\/\/passport\.yandex\.(com|com\.tr|ru)\//.test(u);

/** Posta kutusunu aç; liste çizildiyse true, giriş sayfasına düştüyse 'signin' */
async function openMail(page: Page): Promise<true | 'signin' | undefined> {
  if (!onMail(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  // önceki okumadan açık kalan ileti/dizi görünümü (#message/…, #thread/…): liste sanılıp dizinin iç satırları okunuyordu → gelen kutusuna dön
  else if (!/^(#(inbox)?)?$/.test(new URL(page.url()).hash)) {
    await page.evaluate(() => (location.hash = '#inbox')).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  for (let i = 0; i < 25; i++) {
    if (onLogin(page.url())) return 'signin';
    if ((await page.locator(ROW_SEL).count().catch(() => 0)) > 0) return true;
    // boş gelen kutusu: liste kabı var ama satır yok
    if (await page.locator('.ns-view-messages, .mail-MessagesList, [data-testid="message-list"], .mail-EmptyFolder, [class*="EmptyFolder"]').count().catch(() => 0)) return true;
    await page.waitForTimeout(1000);
  }
  return onLogin(page.url()) ? 'signin' : undefined;
}

interface YandexRow {
  key: string;
  unread: boolean;
  sender: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  time: string;
  /** gönderen logosu/fotoğrafı (Yandex listesinde görünen; img ya da arka plan görseli) */
  avatar: string;
  /** tıklama için: sayfadaki en dıştaki eşleşmeler arasındaki sıra */
  idx: number;
}

/** Liste satırlarını oku (threads ve messages aynı anahtarı üretsin diye tek yerde). Seçiciler satırın iç parçalarını da
 *  yakalayabildiği için yalnız EN DIŞTAKİ ve metni olan eşleşmeler satır sayılır; alan seçicileri tutmazsa satır metninin
 *  satırlarından (gönderen / konu / özet, saat satırları hariç) çıkarılır. */
function readRows(page: Page): Promise<YandexRow[]> {
  return page.evaluate((sel) => {
    const q = (el: Element, s: string) => el.querySelector<HTMLElement>(s);
    const out: YandexRow[] = [];
    const seen = new Map<string, number>();
    const all = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const outer = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
    // eşleşen öğe metinsiz bir bağlantı kaplaması olabilir (metin kardeş öğelerde): başka satır içermeyen, metinli en yakın üst öğe
    const lift = (el: HTMLElement): HTMLElement => {
      let r = el;
      for (let i = 0; i < 6 && !r.innerText.trim() && r.parentElement; i++) {
        const up = r.parentElement;
        if (outer.filter((o) => up.contains(o)).length > 1) break;
        r = up;
      }
      return r;
    };
    const rows = outer.map((el, idx) => ({ el: lift(el), link: el, idx })).filter((x) => x.el.innerText.trim().length > 0);
    const isTime = (t: string) => /^(\d{1,2}[:.]\d{2}|\d{1,2}[./]\d{1,2}([./]\d{2,4})?|\d{1,2}\s+\p{L}{3,}\.?(\s+\d{4})?|dün|yesterday|вчера)$/iu.test(t);
    for (const { el, link, idx } of rows) {
      // metin parçaları: yaprak öğelerin metni sırayla (innerText satır kırmayabilir: satır içi öğeler)
      const leaves = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((e) => !e.children.length && e.innerText?.trim());
      const parts = (leaves.length ? leaves.map((e) => e.innerText.trim()) : el.innerText.split('\n')).map((t) => t.replace(/\s+/g, ' ').trim());
      const lines = parts.filter((t, i) => t.length > 1 && !isTime(t) && parts.indexOf(t) === i);
      const senderEl = q(el, '.mail-MessageSnippet-FromText, [class*="FromText"], [class*="_from" i] [title*="@"], [title*="@"]');
      const sender = (senderEl?.innerText || lines[0] || '').trim();
      const senderEmail = (senderEl?.getAttribute('title') ?? '').match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? '';
      const subjEl = q(el, '.mail-MessageSnippet-Item_subject, [class*="Item_subject"], [class*="subject" i]');
      const subject = (subjEl?.innerText || lines.find((l, i) => i > 0 && l !== sender) || '').trim();
      const snipEl = q(el, '.mail-MessageSnippet-Item_firstline, [class*="firstline" i]');
      const snippet = (snipEl?.innerText || lines.filter((l) => l !== sender && l !== subject).join(' ')).trim();
      const timeEl = q(el, '.mail-MessageSnippet-Item_dateText, [class*="dateText"], [class*="date" i][title], time');
      const time = (timeEl?.getAttribute('title') || timeEl?.getAttribute('datetime') || timeEl?.innerText || parts.find(isTime) || '').trim();
      const unread =
        /is-unread|_unread|unread/i.test(el.className) ||
        !!q(el, '.mail-MessageSnippet-Item_unread, [class*="_unread"], [class*="Unread"], [aria-label*="okunmadı" i], [title*="Okundu olarak" i], [title*="Mark as read" i]');
      // kararlı anahtar: ileti bağlantısı (#message/<id>, /message/<id>, /thread/<id>); yoksa içerik (zaman hariç)
      const href = link.getAttribute('href') ?? el.getAttribute('href') ?? el.querySelector('a[href*="message"], a[href*="thread"]')?.getAttribute('href') ?? '';
      let key = (href.match(/(?:message|thread)[s]?\/([^/?#]+)/) ?? [])[1] ?? el.getAttribute('data-id') ?? '';
      if (!key) {
        const base = 'c:' + [sender, subject, snippet.slice(0, 60)].join('|').slice(0, 200);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        key = n ? `${base}#${n}` : base;
      }
      // avatar: satırdaki ilk gerçek görsel (img) ya da avatar kutusunun arka plan görseli; baş harf kutuları (görselsiz) boş
      let avatar = '';
      const img = el.querySelector<HTMLImageElement>('img[src^="http"], img[src^="//"]');
      if (img && img.naturalWidth !== 1) avatar = img.src;
      if (!avatar) {
        for (const a of Array.from(el.querySelectorAll<HTMLElement>('[class*="vatar" i], [class*="Logo" i], [class*="userpic" i]')).slice(0, 6)) {
          const bg = getComputedStyle(a).backgroundImage.match(/url\(["']?((?:https?:)?\/\/[^"')]+)/)?.[1];
          if (bg) {
            avatar = bg.startsWith('//') ? 'https:' + bg : bg;
            break;
          }
        }
      }
      out.push({ key, unread, sender, senderEmail, subject, snippet: snippet.slice(0, 300), time, avatar, idx });
    }
    return out;
  }, ROW_SEL);
}

let diagDone = false;
/** Tanı (bir kez, içerik yok): hangi seçici kaç öğe buldu, ilk satırın yapısı (etiket, sınıf, data-testid'ler) */
async function diagnose(page: Page): Promise<void> {
  if (diagDone) return;
  diagDone = true;
  const d = await page
    .evaluate((sel) => {
      const counts = sel.split(',').map((x) => `${x.trim().slice(0, 40)}=${document.querySelectorAll(x).length}`);
      const first = document.querySelector<HTMLElement>(sel);
      const desc = (e: Element | null) => (e ? `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 80)}` : '-');
      const inner = first ? Array.from(first.querySelectorAll('[class]')).slice(0, 25).map((e) => String(e.className).split(' ')[0]).filter(Boolean) : [];
      const tids = first ? Array.from(first.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).slice(0, 15) : [];
      // dizi satırları (sayılı) ve avatar yapısı: tanı için yalnız sayılar/sınıf adları
      const threadish = Array.from(document.querySelectorAll('[class*="hread" i]')).slice(0, 5).map((e) => desc(e));
      const avatarish = first ? Array.from(first.querySelectorAll('img, [class*="vatar" i]')).slice(0, 3).map((e) => desc(e)) : [];
      return { counts, row: desc(first), parent: desc(first?.parentElement ?? null), inner: [...new Set(inner)], tids, threadish, avatarish, hash: location.hash.slice(0, 12) };
    }, ROW_SEL)
    .catch((e) => ({ error: String(e).slice(0, 100) }));
  bus.log('info', `Yandex Mail tanı: ${JSON.stringify(d)}`);
}

/** Satırı aç, iletileri oku; restore=true ise (yoklama) okunmamış satır sonra yeniden okunmadı yapılır */
async function readThread(page: Page, threadId: string, limit: number, restore: boolean): Promise<Msg[]> {
  if ((await openMail(page)) !== true) return [];
  const list = await readRows(page).catch(() => [] as YandexRow[]);
  const row = list.find((r) => hashId(r.key) === threadId);
  if (!row) return [];
  const wasUnread = row.unread;
  // en dıştaki eşleşmenin sırasıyla tıkla (iç parçalar sayılmaz)
  await page
    .evaluate(
      ({ sel, idx }) => {
        const all = Array.from(document.querySelectorAll<HTMLElement>(sel));
        const outer = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
        outer[idx]?.click();
      },
      { sel: ROW_SEL, idx: row.idx },
    )
    .catch(() => undefined);
  await page.waitForTimeout(2500);
  const rows = await page
    .evaluate(() => {
      const views = Array.from(document.querySelectorAll<HTMLElement>('.mail-Message, .ns-view-message, [data-testid="message-view"], article'));
      return views.map((v) => {
        const bodyEl = v.querySelector<HTMLElement>('.mail-Message-Body-Content, [class*="Body-Content"], [data-testid*="message-body" i]');
        const body = bodyEl?.innerText ?? v.innerText;
        let html = '';
        if (bodyEl) {
          const c = bodyEl.cloneNode(true) as HTMLElement;
          for (const img of Array.from(c.querySelectorAll<HTMLImageElement>('img[src]'))) img.setAttribute('src', img.src);
          html = c.innerHTML;
        }
        const fromEl = v.querySelector<HTMLElement>('.mail-Message-Sender-Email, [class*="Sender-Email"], [data-testid*="sender-email" i]');
        const from = (fromEl?.innerText || fromEl?.getAttribute('title') || (v.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [])[0] || '').trim();
        const fromName = (v.querySelector<HTMLElement>('.mail-Message-Sender-Name, [class*="Sender-Name"]')?.innerText || from).trim();
        const dateEl = v.querySelector<HTMLElement>('.mail-Message-Date, [class*="Message-Date"], time');
        const time = dateEl?.getAttribute('title') || dateEl?.getAttribute('datetime') || dateEl?.innerText || '';
        return { text: body.trim(), from, fromName, time, html };
      });
    })
    .catch(() => [] as Array<{ text: string; from: string; fromName: string; time: string; html: string }>);
  if (restore && wasUnread) await markUnread(page, threadId);
  const good = rows.filter((r) => r.text.length > 0);
  // ileti görünümü okunamadı (dizi satırı yerinde açılıyor olabilir): en azından listedeki özet tek ileti olarak görünsün
  if (!good.length && (row.snippet || row.subject)) {
    return [
      {
        id: hashId(threadId + '|row'),
        text: [row.subject, row.snippet].filter(Boolean).join('\n\n'),
        ts: threadTs.get(threadId) ?? parseMailDate(row.time) ?? Date.now(),
        fromMe: false,
        senderId: row.senderEmail || row.sender || threadId,
        senderName: row.sender || 'Gönderen',
      },
    ];
  }
  return good
    .map((r, i) => {
      const fromMe = !!meEmail && r.from.toLowerCase() === meEmail;
      return {
        id: hashId(threadId + '|' + r.from + '|' + r.text.slice(0, 120)),
        text: r.text.replace(/[ \t\u00a0]+$/gm, '').replace(/\n{3,}/g, '\n\n').slice(0, 20_000),
        html: cleanMailHtml(r.html, 'https://mail.yandex.com/'),
        ts: parseMailDate(r.time) ?? (threadTs.get(threadId) ?? Date.now()) - (good.length - 1 - i) * 60_000,
        fromMe,
        senderId: fromMe ? 'me' : r.from || threadId,
        senderName: fromMe ? 'Ben' : r.fromName || r.from || 'Gönderen',
      };
    })
    .slice(-limit);
}

/** Açık iletiyi yeniden okunmadı yap (araç çubuğu düğmesi) */
async function markUnread(page: Page, threadId: string): Promise<void> {
  await page.waitForTimeout(500);
  const done = await page
    .evaluate(() => {
      const re = /^(Okunmadı olarak işaretle|Okunmamış olarak işaretle|Mark as unread|Не прочитано)$/i;
      const b = Array.from(document.querySelectorAll<HTMLElement>('.mail-Toolbar-Item_unread, [data-testid*="mark-unread" i], button, [role="button"], [role="menuitem"]')).find(
        (e) => (/Toolbar-Item_unread/.test(e.className) || re.test((e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.innerText ?? '').trim())) && e.getBoundingClientRect().width > 0,
      );
      if (!b) return false;
      b.click();
      return true;
    })
    .catch(() => false);
  if (!done) bus.log('info', `Yandex Mail: okunmamış düğmesi bulunamadı (${threadId.slice(0, 10)}…)`);
}

/** İletiyi aç, Yanıtla'ya bas, düzenleyici kutusunu döndür */
async function openReply(page: Page, threadId: string): Promise<Locator> {
  await readThread(page, threadId, 1, false);
  await page
    .locator('.mail-Toolbar-Item_reply, .mail-QuickReply-Placeholder, [data-testid*="reply" i], [aria-label="Yanıtla"], [aria-label="Reply"], button:has-text("Yanıtla"), button:has-text("Reply")')
    .first()
    .click({ timeout: 8000 });
  const box = page.locator('.cke_wysiwyg_div, [contenteditable="true"][role="textbox"], [contenteditable="true"], .mail-QuickReply textarea').last();
  await box.waitFor({ timeout: 10_000 });
  return box;
}

async function clickSend(page: Page): Promise<void> {
  await page
    .locator('.mail-Compose-SendButton, .ComposeSendButton, [data-testid*="send-button" i], [aria-label="Gönder"], [aria-label="Send"], button:has-text("Gönder"), button:has-text("Send")')
    .last()
    .click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

export const yandex: Strategy = {
  unloadWhenIdle: true,
  watchSelector: ROW_SEL,
  home: HOME,
  loginUrl: LOGIN_URL,
  loginHint: 'Açılan pencerede Yandex hesabına normal şifrenle gir (SMS/QR doğrulaması isterse tamamla); gelen kutusu görününce pencere kendiliğinden kapanır',

  async loggedIn(page, cookies, passive) {
    if (passive) {
      // giriş penceresi ana sayfaya düştüyse (ya da hiç gezinmediyse) giriş formunu aç
      if (!cookies.Session_id && (onPortal(page.url()) || page.url() === 'about:blank')) {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
        return false;
      }
      if (!onMail(page.url())) return false;
      return (await page.locator(ROW_SEL).count().catch(() => 0)) > 0 || !!cookies.Session_id;
    }
    const r = await openMail(page);
    if (r === 'signin') return false;
    if (r) {
      await persistSessionCookies(page.context(), YANDEX_COOKIE_DOMAINS).catch(() => 0);
      return true;
    }
    // ne liste ne giriş sayfası (seçiciler eskimiş olabilir): oturum çerezi varsa bağlı say, günlük tanıyı gösterir
    return !!cookies.Session_id;
  },

  async afterLogin(page) {
    await page.waitForTimeout(800);
    const n = await persistSessionCookies(page.context(), YANDEX_COOKIE_DOMAINS).catch(() => 0);
    bus.log('info', `Yandex Mail: ${n} oturum çerezi kalıcı yapıldı (görünmez tarayıcıda oturum sürsün diye)`);
  },

  async me(page, cookies) {
    // Yandex oturum çerezi giriş adını taşır (yandex_login) — sayfa seçicisinden güvenilir
    const login = decodeURIComponent(cookies?.yandex_login ?? '').trim();
    if (/^[\w.+-]+(@[\w.-]+)?$/.test(login)) {
      const email = login.includes('@') ? login : `${login}@yandex.com`;
      meEmail = email.toLowerCase();
      return { id: meEmail, label: email };
    }
    await openMail(page);
    const email = await page
      .evaluate(() => {
        const el = document.querySelector('.user-account__subname, .mail-User-Name, [class*="UserID-Account"], [data-testid*="user-email" i]');
        const fromEl = (el?.textContent ?? '').match(/[\w.+-]+@yandex\.[a-z.]+/i)?.[0];
        if (fromEl) return fromEl;
        // hesap kutusu yalnız giriş adını gösterebilir (kullanici) → @yandex.com ekle
        const login = (el?.textContent ?? '').trim();
        if (/^[\w.-]+$/.test(login)) return `${login}@yandex.com`;
        return document.body.innerText.match(/[\w.+-]+@yandex\.[a-z.]+/i)?.[0] ?? '';
      })
      .catch(() => '');
    meEmail = email.toLowerCase();
    return { id: meEmail || 'yandex', label: email || 'Yandex Mail' };
  },

  async threads(page, cookies): Promise<Thread[]> {
    const r = await openMail(page);
    if (r === 'signin') throw new Error('Yandex oturumu düşmüş (giriş sayfası açılıyor) — kanal uyarısından Yeniden bağlan');
    if (!r) {
      bus.log('warn', `Yandex Mail: ileti listesi bulunamadı (sayfa: ${page.url()}). Seçiciler değişmiş olabilir; Yeniden bağlan ile pencereyi açıp kontrol et.`);
      return [];
    }
    await persistSessionCookies(page.context(), YANDEX_COOKIE_DOMAINS).catch(() => 0);
    if (!meEmail) await this.me(page, cookies);
    await diagnose(page);
    const rows = await readRows(page);
    const times = fillListTimes(rows.map((r) => parseMailDate(r.time)));
    return rows.map((row, i) => {
      if (times[i] !== undefined) threadTs.set(hashId(row.key), times[i]!);
      return {
        id: hashId(row.key),
        name: row.subject || '(konu yok)',
        kind: 'direct' as const,
        lastTs: times[i] ?? 0,
        preview: `${row.sender}: ${row.snippet}`.slice(0, 200),
        avatarUrl: row.avatar || undefined,
        unread: row.unread ? 1 : 0,
        participants: row.sender ? [{ id: row.senderEmail || row.sender, name: row.sender, handle: row.senderEmail || undefined }] : undefined,
      };
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
    return undefined; // gerçek ileti yoklamayla gelir (köprü local- kimliği yazar)
  },
};
