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

/**
 * `accept` özniteliği (ör. "image/*,.pdf,.docx") verilen dosyayı kabul eder mi? Boş accept her şeyi alır.
 * Tarayıcı köprüsündeki tüm stratejiler için ortak (düzenleyicide birden çok gizli dosya girişi olabiliyor:
 * LinkedIn'de resim/dosya, Outlook'ta resim/ek).
 */
export function acceptsMime(accept: string | null | undefined, file: { name: string; mime: string }): boolean {
  const a = (accept ?? '').trim();
  if (!a) return true;
  const mime = file.mime.toLowerCase();
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
  return a
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith('.')) return rule === ext;
      if (rule.endsWith('/*')) return mime.startsWith(rule.slice(0, -1));
      return rule === mime;
    });
}

/**
 * Dosyayı kabul eden girişin dizini: önce en dar (özel) eşleşen kural, sonra her şeyi alan boş accept.
 * Hiçbiri kabul etmiyorsa -1 (ör. Instagram DM'e PDF).
 */
export function pickFileInput(inputs: Array<{ accept: string | null | undefined }>, file: { name: string; mime: string }): number {
  let best = -1;
  let bestScore = -1;
  inputs.forEach((inp, i) => {
    if (!acceptsMime(inp.accept, file)) return;
    const a = (inp.accept ?? '').trim();
    // özel kural (image/* ya da uzantı) > her şeyi alan giriş; eşitlikte sonuncusu (en son çizilen, açık düzenleyici)
    const score = a ? 2 : 1;
    if (score >= bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
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
/** Açık ileti listeyi örtüyorsa (adres …/inbox/id/…; satırlar visibility:hidden) gelen kutusuna dön: yeni gelen mailler
 * ancak liste görünürken taze okunur (profil kopyasıyla: goto ~600 ms, "Kapat"/Escape işe yaramıyor) */
async function ensureListVisible(page: Page): Promise<boolean> {
  const vis = () => page.evaluate((s) => Array.from(document.querySelectorAll<HTMLElement>(s)).some((r) => getComputedStyle(r).visibility !== 'hidden' && r.getBoundingClientRect().width > 0), LIST).catch(() => false);
  if (!/\/id\//.test(page.url()) && (await vis())) return true;
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  for (let i = 0; i < 30; i++) {
    if (await vis()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function inboxState(page: Page): Promise<InboxState> {
  if (!onMailUrl(page.url())) await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  let onLogin = 0;
  for (let i = 0; i < 30; i++) {
    if ((await page.locator(LIST).count().catch(() => 0)) > 0) return 'ok';
    const url = page.url();
    // login.live.com çerezleri geçerliyse yönlendirme birkaç saniyede kendiliğinden döner; 10 sn kalıyorsa etkileşim ister
    if (onLoginUrl(url)) {
      if (++onLogin >= 15) return 'login';
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
  // Tıklama bölmeyi değiştirmezse (satır bulunamadı/tık yutuldu) eski iletiyi bu sohbete yazmayalım:
  // satır zaten seçili değilse gövde metninin değişmesini bekle
  const paneText = () => page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((b) => b.innerText.slice(0, 400)).join('|'), BODY).catch(() => '');
  const wasSelected = (await row.getAttribute('aria-selected').catch(() => null)) === 'true';
  const before = await paneText();
  // Bu görünüm genişliğinde açık ileti listeyi örtüyor (satırlar visibility:hidden): Playwright tıklaması "görünmez" diye
  // bekler; DOM click() ise React işleyicisini çalıştırıp satırı seçiyor (profil kopyasıyla doğrulandı)
  const clicked = await row.click({ timeout: 2500 }).then(() => true).catch(() => false);
  if (!clicked) await row.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  const ok = await page
    .waitForSelector(BODY, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) return false;
  if (!wasSelected) {
    // Asıl kanıt satırın seçili olması (aria-selected); art arda aynı içerikli iletilerde gövde metni değişmeyebilir
    let changed = false;
    for (let i = 0; i < 16 && !changed; i++) {
      await page.waitForTimeout(500);
      changed = (await row.getAttribute('aria-selected').catch(() => null)) === 'true' || (!!before && (await paneText()) !== before);
    }
    if (!changed) {
      bus.log('warn', `Outlook: ileti bölmesi satıra geçmedi (${id.slice(0, 12)}…); içerik atlandı`);
      return false;
    }
  }
  await page.waitForTimeout(800);
  return true;
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
/** Gövde metnine sızan HTML yorumu / CSS kuralları (bazı pazarlama e-postalarında <style> içeriği metin olarak geliyor) temizlenir */
export function cleanMailText(t: string): string {
  return t
    .replace(/[\u200b-\u200f\u2060\ufeff\ue000-\uf8ff]/g, '') // sıfır genişlikli + simge yazı tipi (özel kullanım alanı) karakterleri
    .replace(/\u00a0/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '')
    .replace(/(?:^|\n)\s*[.#@][\w.\-#:>, \[\]="']*\{[^}]*\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function outlookRow(r: OutlookRawRow, now = new Date()): { subject: string; sender: string; email: string; preview: string; ts: number; unread: boolean } {
  // aria-label iki biçimde: "Gönderen, Konu, Önizleme, Tarih" (virgüllü) ya da boşlukla akan tek metin (yeni OWA; önizlemedeki
  // virgüller parça sanılmasın)
  const rawParts = r.label.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
  const commaForm = rawParts.length >= 3 && rawParts[0].length <= 60 && !/\d{1,2}[:.]\d{2}/.test(rawParts[0]);
  const parts = commaForm ? rawParts : [r.label.trim()];
  const labelBody = /^(Okunmamış|Unread)$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
  const email = (r.senderEmail.match(/[\w.+-]+@[\w.-]+/) ?? [])[0]?.toLowerCase() ?? '';
  const initialsOf = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase();
  // Gönderen: adres span'ı yoksa (açık ileti listeyi örtünce satır sadeleşiyor) aria-label virgülsüz tek parça olabilir;
  // o zaman satır metninden: ilk satır avatar baş harfleri ise ikincisi, değilse ilki
  const fromLines = r.lines[0] && r.lines[1] && r.lines[0].length <= 3 && r.lines[0] === initialsOf(r.lines[1]) ? r.lines[1] : r.lines[0] ?? '';
  const sender = r.senderName || (labelBody.length > 1 ? labelBody[0] : '') || (fromLines.length <= 60 ? fromLines : '') || email;
  const noise = /^(Okunmamış|Unread|Okundu|Read|Sabitlenmiş|Pinned|Bayrak(lı)?|Flagged|Ek(ler)?|Has attachments?|Önemli|Important)$/i;
  // zaman: önce title (tam tarih), sonra görünen satırlar, sonra aria-label'ın sonu
  const timeText = [...r.titles, ...r.lines, labelBody[labelBody.length - 1] ?? ''].find((x) => x && !/@/.test(x) && parseOutlookDate(x, now) !== undefined && /\d{1,2}[:.]\d{2}|\d{1,2}\/\d{1,2}/.test(x)) ?? '';
  const ts = parseOutlookDate(timeText, now) ?? 0;
  // satırın ilk metni avatar baş harfleri ("RG", "M"): konu sanılmasın
  const initials = initialsOf(sender);
  const isInitials = (l: string) => l.length <= 3 && l === l.toUpperCase() && /^[A-ZÇĞİÖŞÜ0-9]+$/.test(l) && (l === initials || initials.startsWith(l));
  const rest = r.lines.filter((l) => l !== sender && l !== email && l !== timeText && !noise.test(l) && !isInitials(l) && !(l.length <= 24 && parseOutlookDate(l, now) !== undefined));
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
    bus.log('info', `Outlook: giriş denetimi '${st}' (${page.url().slice(0, 90)})`);
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
          // anahtar adları "olk-…Enabled_adres" biçiminde: adresin önündeki ön ek atılır
          for (let i = 0; !email && i < localStorage.length; i++) email = pick(localStorage.key(i)).replace(/^.*_/, '');
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
    if (onMailUrl(page.url())) await ensureListVisible(page);
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
    // moreThreads listeyi aşağı kaydırmışsa (liste sanal: üstteki satırlar DOM'dan düşer) başa dön
    if (await scrollList(page, 'top')) await page.waitForTimeout(1200);
    const raw = await readListRows(page);
    for (const r of raw) listed.add(r.id);
    return raw.map(rawToThread);
  },

  /**
   * Daha eski iletiler: ileti listesinin kaydırma kabı (satırın overflow:auto atası) sona kaydırılır, OWA yeni
   * satırları yükler (liste sanal; eski satırlar DOM'dan düşer). Daha önce görülmemiş satırlar döner; kaydırma
   * yeni satır getirmiyorsa boş dizi. (Profil kopyasıyla doğrulandı: 11 → 18 satır.)
   */
  async moreThreads(page): Promise<Thread[]> {
    if ((await inboxState(page)) !== 'ok') return [];
    const fresh: OutlookRawRow[] = [];
    for (let round = 0; round < 4 && !fresh.length; round++) {
      const before = (await readListRows(page)).length;
      if (!(await scrollList(page, 'bottom'))) break;
      // yeni satırlar gelene dek (en çok 4 sn) bekle
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        await page.waitForTimeout(400);
        const rows = await readListRows(page);
        const unseen = rows.filter((r) => !listed.has(r.id));
        if (unseen.length) {
          fresh.push(...unseen);
          break;
        }
        if (rows.length !== before) break; // satırlar değişti ama hepsi biliniyor: bir tur daha kaydır
      }
    }
    for (const r of fresh) listed.add(r.id);
    return fresh.map(rawToThread);
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
        // zaman öğesi bulunamazsa kutunun metnindeki tam tarih ("24.09.2026 Per 03:33")
        const timeTxt = timeEl?.getAttribute('title') || timeEl?.innerText || (box?.innerText.match(/\d{1,2}\.\d{1,2}\.\d{4}[^\n]{0,12}\d{1,2}:\d{2}/) ?? [])[0] || '';
        // ekler: dosya adı taşıyan kartlar (seçici doğrulanmadı; ad yoksa atlanır)
        const files = Array.from(box?.querySelectorAll<HTMLElement>('[data-testid*="ttachment"] [title], [role="listitem"][aria-label], [role="option"][aria-label]:not([data-convid])') ?? [])
          .map((a) => (a.getAttribute('title') || a.getAttribute('aria-label') || '').split(/,\s*/)[0].trim())
          .filter((n) => /\.[a-z0-9]{2,5}$/i.test(n));
        // canlı öğenin innerText'i <style>/<script> metnini içermez (kopyada içeriyordu); alıntılanan önceki iletiler metinden çıkarılır
        let text = body.innerText ?? '';
        for (const q of Array.from(body.querySelectorAll<HTMLElement>('blockquote, #divRplyFwdMsg, [id^="divRplyFwdMsg"], [id*="appendonsend"]'))) {
          const qt = q.innerText?.trim();
          if (qt) text = text.replace(qt, '');
        }
        out.push({ email: email.toLowerCase(), name, time: timeTxt, text: text.trim(), files: Array.from(new Set(files)) });
      }
      return out;
    }, BODY);
    const msgs: Msg[] = rows
      .map((r) => ({ ...r, text: cleanMailText(r.text) }))
      .filter((r) => r.text || r.files.length)
      .map((r, i) => {
        const fromMe = !!meEmail && r.email === meEmail;
        return {
          id: hashId(threadId + '|' + r.email + '|' + r.time + '|' + r.text.slice(0, 80)),
          text: r.text.slice(0, 20_000),
          // zaman okunamazsa listedeki satır zamanı (yoklama saati yazılırsa sohbet en üste fırlıyor ve liste zamanı bir daha kazanamıyordu)
          ts: parseOutlookDate(r.time) ?? (threadTs.get(threadId) || Date.now()) - (rows.length - 1 - i) * 60_000,
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
    const body = await openReply(page, threadId);
    await body.click();
    await body.fill(text);
    await clickSend(page);
    return hashId(threadId + '|' + text + '|' + Date.now());
  },

  /**
   * Ekli yanıt: yanıt düzenleyicisi açılınca şeritte gizli `input[type=file][data-testid="local-computer-filein"]`
   * girişleri çizilir (biri image/*, diğerleri her tür; profil kopyasıyla doğrulandı). Dosya türüne uyan girişe
   * setInputFiles, yükleme bitince metin ve Gönder. (Gönderim canlı denenmedi.)
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    const body = await openReply(page, threadId);
    const input = await composeFileInput(page, file);
    if (!input) throw new Error('Outlook: yanıt düzenleyicisinde dosya girişi bulunamadı');
    await input.setInputFiles(file.path);
    await waitUploadDone(page, Math.max(30_000, Math.min(300_000, file.size / 50)));
    if (caption) {
      await body.click();
      await body.fill(caption);
    }
    await clickSend(page);
    return hashId(threadId + '|' + file.name + '|' + Date.now());
  },
};

export const REPLY_BTN = 'button[aria-label="Yanıtla"], button[aria-label="Reply"], button[name="Yanıtla"], button[name="Reply"]';
export const EDITOR = 'div[aria-label*="İleti gövdesi"][contenteditable="true"], div[aria-label*="Message body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]';
export const SEND_BTN = 'button[aria-label="Gönder"], button[aria-label="Send"], button[name="Gönder"], button[name="Send"]';
export const FILE_INPUT = 'input[type="file"][data-testid="local-computer-filein"], input[type="file"]';

/** threads()/moreThreads ile depoya yazılmış satır kimlikleri (moreThreads yalnızca yenilerini döndürür) */
const listed = new Set<string>();
/** liste satırından okunan zaman (ileti zamanı okunamazsa yedek) */
const threadTs = new Map<string, number>();

/** DOM'daki liste satırlarını ham alanlarıyla oku */
function readListRows(page: Page): Promise<OutlookRawRow[]> {
  return page.evaluate((sel) => {
    const out: OutlookRawRow[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const id = el.getAttribute('data-convid') ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = el.getAttribute('aria-label') ?? '';
      // yeni OWA: aria-label "Okunmamış" ile başlamıyor; satırdaki düğme okunmamışta "Okundu olarak işaretle" (okunmuşta "Okunmadı olarak işaretle")
      const unread =
        /^(Okunmamış|Unread)\b/i.test(label) ||
        !!el.querySelector('[aria-label="Okunmamış"], [aria-label="Unread"], [title="Okundu olarak işaretle"], [aria-label="Okundu olarak işaretle"], [title="Mark as read"], [aria-label="Mark as read"]');
      const from = el.querySelector<HTMLElement>('span[title*="@"]');
      const titles = Array.from(el.querySelectorAll<HTMLElement>('[title]')).map((s) => s.getAttribute('title') ?? '').filter(Boolean);
      // Açık ileti listeyi örtünce satırlar visibility:hidden olur ve innerText boş döner; o zaman yaprak öğelerin
      // textContent'i (aynı sıra: baş harfler, gönderen, konu, önizleme, saat)
      let lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
      if (!lines.length) {
        const leaves = Array.from(el.querySelectorAll<HTMLElement>('span, div')).filter((x) => x.children.length === 0);
        lines = leaves.map((x) => (x.textContent ?? '').trim()).filter((t) => t && t.length < 400);
        lines = lines.filter((t, i) => i === 0 || t !== lines[i - 1]);
      }
      out.push({ id, label, unread, senderName: (from?.innerText || from?.textContent || '').trim(), senderEmail: from?.getAttribute('title') ?? '', titles, lines });
    }
    return out;
  }, LIST);
}

function rawToThread(r: OutlookRawRow): Thread {
  const x = outlookRow(r);
  if (x.ts) threadTs.set(r.id, x.ts);
  return {
    id: r.id,
    name: x.subject,
    kind: 'direct' as const,
    lastTs: x.ts,
    preview: `${x.sender}: ${x.preview}`.slice(0, 200),
    unread: x.unread ? 1 : 0,
    participants: x.sender || x.email ? [{ id: x.email || x.sender, name: x.sender || x.email, handle: x.email || undefined }] : undefined,
  };
}

/**
 * İleti listesinin kaydırma kabını (bir satırın overflow:auto olan en yakın atası) başa/sona kaydır.
 * Kaydırılabilir kap yoksa ya da zaten oradaysa false.
 */
function scrollList(page: Page, to: 'top' | 'bottom'): Promise<boolean> {
  return page
    .evaluate(
      ({ sel, to }) => {
        let el = document.querySelector<HTMLElement>(sel)?.parentElement ?? null;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            const target = to === 'top' ? 0 : el.scrollHeight;
            if (Math.abs(el.scrollTop - target) < 2 && to === 'top') return false;
            el.scrollTop = target;
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
            return true;
          }
          el = el.parentElement;
        }
        return false;
      },
      { sel: LIST, to },
    )
    .catch(() => false);
}

/** İletiyi aç, Yanıtla'ya bas, gövde düzenleyicisini döndür */
async function openReply(page: Page, threadId: string) {
  if (!(await openThread(page, threadId))) throw new Error('İleti açılamadı');
  const reply = page.locator(REPLY_BTN).last();
  await reply.click({ timeout: 8000 });
  const body = page.locator(EDITOR).last();
  await body.waitFor({ timeout: 10_000 });
  return body;
}

async function clickSend(page: Page): Promise<void> {
  const sendBtn = page.locator(SEND_BTN).last();
  await sendBtn.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

/** Açık düzenleyicinin dosya türüne uyan gizli dosya girişi (accept'e göre; yoksa undefined) */
export async function composeFileInput(page: Page, file: { name: string; mime: string }) {
  for (let i = 0; i < 20; i++) {
    const inputs = page.locator(FILE_INPUT);
    const n = await inputs.count().catch(() => 0);
    if (n) {
      const accepts: Array<{ accept: string | null }> = [];
      for (let k = 0; k < n; k++) accepts.push({ accept: await inputs.nth(k).getAttribute('accept').catch(() => null) });
      const idx = pickFileInput(accepts, file);
      if (idx >= 0) return inputs.nth(idx);
      return undefined;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}

/** Ek yükleme bitene dek bekle: görünür ilerleme çubuğu kalmayınca ve 1,5 sn sessiz kalınca döner */
async function waitUploadDone(page: Page, maxMs: number): Promise<void> {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(500);
    const busy = await page
      .evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="progressbar"]')).some((e) => e.offsetParent !== null && e.getAttribute('aria-valuenow') !== e.getAttribute('aria-valuemax')))
      .catch(() => false);
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 3) return;
  }
}
