import type { BrowserContext, Page } from 'playwright';
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
 *
 * Oturum kalıcılığı (kök neden, 2026-09): Microsoft hesabının oturum çerezleri (login.live.com) "Oturumunuz açık
 * kalsın mı?" sorusuna Evet denmedikçe OTURUM çerezidir; OWA'nın MSAL önbelleği de localStorage'da şifreli durur ve
 * anahtarı outlook.live.com'daki `msal.cache.encryption` OTURUM çerezindedir. Köprü girişten sonra görünür pencereyi
 * kapatıp görünmez tarayıcıyı yeniden açınca (tarayıcı yeniden başlar) bu çerezlerin hepsi silinir → MSAL belirteçleri
 * çözülemez, sessiz yetkilendirme login_required döner ve sayfa login.microsoftonline.com / login.live.com'a düşer
 * (görünür modda da aynı; user-agent ile ilgisi yok). Çözüm: Microsoft alan adlarındaki oturum çerezleri süreli
 * (kalıcı) çereze çevrilir — girişten hemen sonra (afterLogin, pencere kapanmadan) ve her yoklamada.
 */
const BASE = 'https://outlook.live.com/mail/0/';
/** nlp=1: oturum yoksa pazarlama sayfası yerine doğrudan Microsoft giriş ekranı */
const HOME = `${BASE}?nlp=1`;
// nlp=1 oturumu olmayan MSAL önbelleğinde doğrudan prompt=select_account ile yönlendirir (sessiz SSO denenmez, hesap
// seçici ekranında takılır). Görünmez yeniden gezinmelerde parametresiz adres kullanılır: önce sessiz iframe, sonra
// login.live.com çerezleriyle kendiliğinden geri dönen yönlendirme.
const LIST = 'div[role="option"][data-convid]';
const onMailUrl = (u: string) => /^https:\/\/outlook\.(live|office)\.com\/mail/.test(u);
/** Microsoft giriş / pazarlama sayfası: oturum yok ya da düşmüş */
const onLoginUrl = (u: string) => /^https:\/\/(login\.(live|microsoftonline|microsoft)\.com|account\.live\.com|signup\.live\.com|(www\.)?microsoft\.com)\//.test(u);
/** Oturum çerezleri kalıcılaştırılacak Microsoft alan adları */
const MS_COOKIE_DOMAINS = /(^|\.)(live\.com|microsoftonline\.com|microsoft\.com|office\.com|outlook\.com)$/;

/**
 * Oturum (süresiz) çerezlerini süreli çereze çevir: tarayıcı yeniden başlayınca silinmesinler. Host-only çerezler
 * (`__Host-` önekliler dahil) url ile, alan çerezleri domain ile yeniden yazılır. Döndürür: çevrilen çerez sayısı.
 */
export async function persistSessionCookies(ctx: BrowserContext, domains: RegExp = MS_COOKIE_DOMAINS, days = 30): Promise<number> {
  const expires = Math.floor(Date.now() / 1000) + days * 86400;
  const all = await ctx.cookies().catch(() => []);
  const todo = all.filter((c) => c.expires === -1 && domains.test(c.domain.replace(/^\./, '')));
  let n = 0;
  for (const c of todo) {
    const common = { name: c.name, value: c.value, expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) };
    const cookie = c.domain.startsWith('.') ? { ...common, domain: c.domain, path: c.path } : { ...common, url: `https://${c.domain}${c.path}` };
    // tek tek: biri reddedilirse (ör. önek kuralı) diğerleri yine yazılsın
    if (await ctx.addCookies([cookie]).then(() => true, () => false)) n++;
  }
  return n;
}

const WEEKDAYS: Record<string, number> = {
  paz: 0, pzt: 1, sal: 2, çar: 3, per: 4, cum: 5, cmt: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTHS: Record<string, number> = {
  oca: 0, şub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Çar 24.09.2026 14:32", "24.09.2026 14:32", "Wed 9/24/2026 2:32 PM", "24 Eyl 14:32", "Çar 14:32", "Dün 09:05", "14:32" */
export function parseOutlookDate(s: string | undefined | null, now = new Date()): number | undefined {
  if (!s) return undefined;
  const t = s.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || /@/.test(t)) return undefined;
  const hm = (h: string, min: string, ap?: string) => {
    let x = Number(h);
    if (ap) x = (x % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0);
    return [x, Number(min)] as const;
  };
  let m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m) {
    let h = Number(m[4] ?? 0);
    if (m[6]) h = (h % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5] ?? 0)).getTime();
  }
  // "Dün 09:05" / "Yesterday 9:05 AM"
  m = t.match(/^(Dün|Yesterday)\b\D*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (m) {
    const [h, min] = hm(m[2], m[3], m[4]);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, min).getTime();
  }
  // "Çar 14:32" / "Wed 2:32 PM": bu haftanın (bugün dahil, geriye doğru) o günü
  m = t.match(/^([A-Za-zÇĞİÖŞÜçğıöşü]{3})[^\s\d]*\.?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (m) {
    const wd = WEEKDAYS[m[1].toLocaleLowerCase('tr')] ?? WEEKDAYS[m[1].toLowerCase()];
    if (wd !== undefined) {
      const [h, min] = hm(m[2], m[3], m[4]);
      const back = (now.getDay() - wd + 7) % 7;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, min).getTime();
    }
  }
  // "24.09" (yılsız): gelecekteyse geçen yıl
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[1]));
    return d.getTime() > now.getTime() + 86400e3 ? new Date(now.getFullYear() - 1, Number(m[2]) - 1, Number(m[1])).getTime() : d.getTime();
  }
  m = t.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})[^\s\d.,]*\.?(?:\s+(\d{4}))?(?:\D+(\d{1,2}):(\d{2}))?/);
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
  // Date.parse yalnızca tanınır biçimlerde: V8 "Toplantı 5" gibi serbest metni de tarih sayar
  if (!/^\d{4}-\d{2}-\d{2}|^(\w{3},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/.test(t)) return undefined;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : undefined;
}

let meEmail = '';
let warnedEmpty = false;

type InboxState = 'ok' | 'empty' | 'login' | 'missing';

/**
 * Gelen kutusunu aç ve durumunu bildir. ok: satırlar var; empty: uygulama kabuğu (klasör ağacı) çizildi ama satır yok
 * (boş kutu ya da seçici eskidi); login: giriş/pazarlama sayfasında kalındı (oturum yok ya da düşmüş); missing: bilinmiyor.
 */
async function inboxState(page: Page): Promise<InboxState> {
  if (!onMailUrl(page.url())) await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  let onLogin = 0;
  for (let i = 0; i < 30; i++) {
    if ((await page.locator(LIST).count().catch(() => 0)) > 0) return 'ok';
    const url = page.url();
    // login.live.com çerezleri geçerliyse yönlendirme birkaç saniyede kendiliğinden döner; 10 sn kalıyorsa etkileşim ister
    if (onLoginUrl(url)) {
      if (++onLogin >= 10) return 'login';
    } else onLogin = 0;
    if (i >= 10 && onMailUrl(url) && (await page.locator('div[role="tree"]').count().catch(() => 0)) > 0) return 'empty';
    await page.waitForTimeout(1000);
  }
  return onLoginUrl(page.url()) ? 'login' : 'missing';
}

async function openThread(page: Page, id: string): Promise<boolean> {
  if ((await inboxState(page)) !== 'ok') return false;
  const row = page.locator(`${LIST}[data-convid="${id}"]`).first();
  if (!(await row.count().catch(() => 0))) return false;
  await row.click({ timeout: 8000 }).catch(() => undefined);
  const ok = await page
    .waitForSelector(BODY, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(800);
  return ok;
}

const BODY = 'div[aria-label*="Message body"], div[aria-label*="İleti gövdesi"], div[aria-label*="ileti gövdesi"]';

/** DOM'dan okunan ham liste satırı */
export interface OutlookRawRow {
  id: string;
  label: string;
  unread: boolean;
  senderName: string;
  senderEmail: string;
  /** satırdaki title özniteliklerinin değerleri (tarih span'ı tam tarihi title'da taşır) */
  titles: string[];
  /** satırın görünen metin satırları (innerText) */
  lines: string[];
}

/** Ham satırı sohbet alanlarına çevir (DOM'dan bağımsız; birim testli). */
export function outlookRow(r: OutlookRawRow, now = new Date()): { subject: string; sender: string; email: string; preview: string; ts: number; unread: boolean } {
  const parts = r.label.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
  const labelBody = /^(Okunmamış|Unread)$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
  const email = (r.senderEmail.match(/[\w.+-]+@[\w.-]+/) ?? [])[0]?.toLowerCase() ?? '';
  const sender = r.senderName || labelBody[0] || email;
  const noise = /^(Okunmamış|Unread|Okundu|Read|Sabitlenmiş|Pinned|Bayrak(lı)?|Flagged|Ek(ler)?|Has attachments?|Önemli|Important)$/i;
  // zaman: önce title (tam tarih), sonra görünen satırlar, sonra aria-label'ın sonu
  const timeText = [...r.titles, ...r.lines, labelBody[labelBody.length - 1] ?? ''].find((x) => x && !/@/.test(x) && parseOutlookDate(x, now) !== undefined && /\d{1,2}[:.]\d{2}|\d{1,2}\/\d{1,2}/.test(x)) ?? '';
  const ts = parseOutlookDate(timeText, now) ?? 0;
  const rest = r.lines.filter((l) => l !== sender && l !== email && l !== timeText && !noise.test(l) && !(l.length <= 24 && parseOutlookDate(l, now) !== undefined));
  const subject = rest[0] || labelBody[1] || '(konu yok)';
  const preview = rest.slice(1).join(' ') || labelBody.slice(2, -1).join(', ');
  return { subject, sender, email, preview, ts, unread: r.unread };
}

export const outlook: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede Microsoft hesabına giriş yap ("Oturumunuz açık kalsın mı?" sorusuna Evet de); gelen kutusu görününce pencere kendiliğinden kapanır',

  async loggedIn(page, _cookies, passive) {
    // Oturum yoksa outlook.live.com/mail bir an açılıp giriş ya da pazarlama sayfasına yönlenir: adres tek başına
    // yetmez; ileti listesi (ya da klasör ağacı) gerçekten çizildiyse giriş tamamdır
    if (passive) return onMailUrl(page.url()) && (await page.locator(`${LIST}, div[role="tree"]`).count().catch(() => 0)) > 0;
    const st = await inboxState(page);
    if (st === 'ok' || st === 'empty') {
      await persistSessionCookies(page.context()).catch(() => 0);
      return true;
    }
    return false;
  },

  async afterLogin(page) {
    // Görünür pencere kapanmadan: MSAL anahtar çerezi ve login.live.com oturum çerezleri kalıcı olsun (bkz. dosya başı)
    await page.waitForTimeout(1500);
    const n = await persistSessionCookies(page.context()).catch(() => 0);
    bus.log('info', `Outlook: ${n} oturum çerezi kalıcı yapıldı (görünmez tarayıcıda oturum sürsün diye)`);
  },

  async me(page) {
    await inboxState(page);
    const info = await page
      .evaluate(() => {
        const pick = (s: string | null | undefined) => (s?.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) ?? [])[0] ?? '';
        // OWA hesabın adresini localStorage'da tutar (olk-login_hint, olk-mail_LAST_SELECTED_PIVOT<adres>)
        let email = '';
        try {
          email = pick(localStorage.getItem('olk-login_hint'));
          for (let i = 0; !email && i < localStorage.length; i++) email = pick(localStorage.key(i));
        } catch {
          /* yok */
        }
        const btn = document.querySelector<HTMLElement>('#O365_MainLink_Me, button[aria-label*="Hesap yöneticisi"], button[aria-label*="Account manager"]');
        const label = btn?.getAttribute('aria-label') ?? btn?.innerText ?? '';
        email ||= pick(label) || (document.body.innerText.match(/[\w.+-]+@(outlook|hotmail|live|msn)\.[a-z.]+/i) ?? [])[0] || '';
        return { email, name: label.replace(/[\w.+-]+@[\w.-]+/, '').replace(/^(Hesap yöneticisi|Account manager)( for)?:?/i, '').trim() };
      })
      .catch(() => ({ email: '', name: '' }));
    meEmail = info.email.toLowerCase();
    return { id: meEmail, label: info.email || info.name || 'Outlook' };
  },

  async threads(page): Promise<Thread[]> {
    const st = await inboxState(page);
    if (st === 'login') {
      // "bağlı ama boş" kalmasın: hata fırlat → köprü isLoggedIn ile denetleyip "Yeniden bağlan" durumuna geçer
      throw new Error(`Outlook oturumu düşmüş (sayfa: ${page.url().slice(0, 80)}…) — kanala sağ tık → Yeniden bağlan`);
    }
    if (st === 'missing') {
      bus.log('warn', `Outlook: ileti listesi bulunamadı (sayfa: ${page.url().slice(0, 120)}). Görünmez modda engellendiyse kanala sağ tık → Yeniden bağlan.`);
      return [];
    }
    await persistSessionCookies(page.context()).catch(() => 0);
    if (st === 'empty') {
      if (!warnedEmpty) bus.log('warn', 'Outlook: gelen kutusu açık ama ileti satırı yok (kutu boş ya da arayüz değişti)');
      warnedEmpty = true;
      return [];
    }
    if (!meEmail) await this.me(page, {});
    const raw = await page.evaluate((sel) => {
      const out: OutlookRawRow[] = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const id = el.getAttribute('data-convid') ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = el.getAttribute('aria-label') ?? '';
        const unread = /^(Okunmamış|Unread)\b/i.test(label) || !!el.querySelector('[aria-label="Okunmamış"], [aria-label="Unread"]');
        const from = el.querySelector<HTMLElement>('span[title*="@"]');
        const titles = Array.from(el.querySelectorAll<HTMLElement>('[title]')).map((s) => s.getAttribute('title') ?? '').filter(Boolean);
        const lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
        out.push({ id, label, unread, senderName: from?.innerText.trim() ?? '', senderEmail: from?.getAttribute('title') ?? '', titles, lines });
      }
      return out;
    }, LIST);
    return raw.map((r) => {
      const x = outlookRow(r);
      return {
        id: r.id,
        name: x.subject,
        kind: 'direct' as const,
        lastTs: x.ts,
        preview: `${x.sender}: ${x.preview}`.slice(0, 200),
        unread: x.unread ? 1 : 0,
        participants: x.sender || x.email ? [{ id: x.email || x.sender, name: x.sender || x.email, handle: x.email || undefined }] : undefined,
      };
    });
  },

  async messages(page, _cookies, threadId, limit): Promise<Msg[]> {
    if (!(await openThread(page, threadId))) return [];
    const rows = await page.evaluate((bodySel) => {
      const out: Array<{ email: string; name: string; time: string; text: string; files: string[] }> = [];
      for (const body of Array.from(document.querySelectorAll<HTMLElement>(bodySel))) {
        // ileti kapsayıcısı: gövdeden yukarı, gönderen adresi içeren en yakın kutu
        let box: HTMLElement | null = body;
        for (let i = 0; i < 8 && box; i++) {
          box = box.parentElement;
          if (box?.querySelector('span[title*="@"], [aria-label*="@"]')) break;
        }
        const from = box?.querySelector<HTMLElement>('span[title*="@"]');
        const email = (from?.getAttribute('title')?.match(/[\w.+-]+@[\w.-]+/) ?? box?.innerText.match(/[\w.+-]+@[\w.-]+/) ?? [])[0] ?? '';
        const name = from?.innerText?.trim() ?? '';
        const timeEl = box?.querySelector<HTMLElement>('[data-testid="SentReceivedSavedTime"], span[title*=":"]:not([title*="@"])');
        // ekler: dosya adı taşıyan kartlar (seçici doğrulanmadı; ad yoksa atlanır)
        const files = Array.from(box?.querySelectorAll<HTMLElement>('[data-testid*="ttachment"] [title], [role="listitem"][aria-label], [role="option"][aria-label]:not([data-convid])') ?? [])
          .map((a) => (a.getAttribute('title') || a.getAttribute('aria-label') || '').split(/,\s*/)[0].trim())
          .filter((n) => /\.[a-z0-9]{2,5}$/i.test(n));
        const clone = body.cloneNode(true) as HTMLElement;
        for (const q of Array.from(clone.querySelectorAll('blockquote, #divRplyFwdMsg, [id^="divRplyFwdMsg"], [id*="appendonsend"]'))) q.remove();
        out.push({ email: email.toLowerCase(), name, time: timeEl?.getAttribute('title') || timeEl?.innerText || '', text: clone.innerText?.trim() ?? '', files: Array.from(new Set(files)) });
      }
      return out;
    }, BODY);
    const msgs: Msg[] = rows
      .filter((r) => r.text || r.files.length)
      .map((r, i) => {
        const fromMe = !!meEmail && r.email === meEmail;
        return {
          id: hashId(threadId + '|' + r.email + '|' + r.time + '|' + r.text.slice(0, 80)),
          text: r.text.slice(0, 20_000),
          ts: parseOutlookDate(r.time) ?? Date.now() - (rows.length - i) * 60_000,
          fromMe,
          senderId: fromMe ? 'me' : r.email || threadId,
          senderName: fromMe ? 'Ben' : r.name || r.email || 'Gönderen',
          attachments: r.files.length ? r.files.map((name) => ({ kind: 'file' as const, name })) : undefined,
        };
      });
    return msgs.slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    // Outlook bir iletiyi okuma bölmesinde açınca okundu işaretler
    await openThread(page, threadId);
  },

  async send(page, _cookies, threadId, text) {
    if (!(await openThread(page, threadId))) throw new Error('İleti açılamadı');
    const reply = page.locator(REPLY_BTN).last();
    await reply.click({ timeout: 8000 });
    const body = page.locator(EDITOR).last();
    await body.waitFor({ timeout: 10_000 });
    await body.click();
    await body.fill(text);
    const sendBtn = page.locator(SEND_BTN).last();
    await sendBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },
};

export const REPLY_BTN = 'button[aria-label="Yanıtla"], button[aria-label="Reply"], button[name="Yanıtla"], button[name="Reply"]';
export const EDITOR = 'div[aria-label*="İleti gövdesi"][contenteditable="true"], div[aria-label*="Message body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]';
export const SEND_BTN = 'button[aria-label="Gönder"], button[aria-label="Send"], button[name="Gönder"], button[name="Send"]';
