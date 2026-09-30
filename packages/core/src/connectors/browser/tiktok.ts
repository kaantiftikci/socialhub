import type { Frame, Page } from 'playwright';
import { hashId, type Msg, type Strategy, type Thread } from './bridge.js';
import { parseDate } from './messenger.js';
import { bus } from '../../bus.js';
import type { Attachment } from '../../model.js';

/**
 * TikTok (tiktok.com/messages): herkese açık bir DM API'si yok (yalnız onaylı işletme ortaklarına kapalı API), web istemcisinin
 * DOM'u okunur. DENEYSEL — gerçek hesapla DOĞRULANMADI. Seçiciler önce TikTok'un `data-e2e` test öznitelikleri (2026 düzeni
 * `dm-new-*`; eski `chat-list-item`/`chat-item`), bulunamazsa sayfa yapısı GÖRÜNÜŞTEN tanınır (`installLib` → `tag`). İlk turda
 * `TikTok tanı:`, mesajı okunamayan ilk sohbette `TikTok mesaj alanı tanı:` günlüğü yazılır (yalnız sayılar/yapı; içerik YOK).
 *
 * - Oturum: `sessionid` / `sid_tt` çerezi. Kimlik: sayfadaki `__UNIVERSAL_DATA_FOR_REHYDRATION__` → webapp.app-context.user.
 * - Sohbet listesi `[data-e2e="dm-new-conversation-item"]` (data-conv-id, aria-selected): satırda bağlantı yok → kimlik görünen addan
 *   (aynı adlı ikinciye #2); sohbet açılınca başlıktaki @kullanıcı adı öğrenilir (handle + profil bağlantısı). Liste sırası = TikTok'un
 *   yenilik sırası (zamanlar çakışsa/okunamasa da alttaki sohbet üsttekinden yeni görünmez).
 * - Sohbet açma: satır görünür alana kaydırılıp ad üzerine GERÇEK fare tıklaması (TikTok'un tıklama işleyicisi iç öğede olabilir;
 *   DOM .click() ulaşmıyordu) → sohbet bölmesi değişene (başlık adı/seçili satır/bölme imzası) dek beklenir; değişmezse hata (eski
 *   bölmenin mesajları yanlış sohbete yazılmaz).
 * - Mesajlar `[data-e2e="dm-new-chat-item"]` ya da görünüşten: renkli/yuvarlak köşeli BALONLAR bulunur, her balonun satırı tek balon
 *   içeren en üst sarmalayıcıdır (gün/gönderen blokları açılır), ortalanmış tarih/saat yazısı ayırıcı. Metin balondan (<p> şart değil),
 *   saat/"Görüldü" satırları atılır. Ayırıcıdaki (çözülen, mutlak) zaman sonraki mesajların tabanı (Messenger'daki gibi; "Bugün 14:32"
 *   ertesi gün "Dün 14:32" olsa da kimlik aynı). Ben: kendi profil bağlantım, yoksa balonun mesaj alanında sağa yaslı olması.
 * - Business Suite (/business-suite/messages; TikTok bazı KİŞİSEL hesapları da oraya yönlendiriyor): mesaj uygulaması gömülü
 *   çerçevede → okuma/tıklama o çerçevede yapılır.
 * - Paylaşılan TikTok videosu (DM'lerin çoğu): kapak görseli + video sayfası bağlantısı eki.
 * - Gönderim: Draft.js düzenleyicisi → klavyeyle yaz (satır arası Shift+Enter) → gönder düğmesi / Enter.
 * - Okumak için sohbet açılır: TikTok karşı tarafa "Görüldü" gösterebilir; yalnız önizlemesi değişen sohbetler açılır (köprü).
 * - Doğrulama (kaydırmalı captcha) çıkarsa yoklama durur ('captcha' → köprü 'pairing'); Yeniden bağlan görünür pencerede tamamlatır.
 */
const HOME = 'https://www.tiktok.com/messages';

/** Bilinen seçiciler (sayfa içi okuyucuya da verilir). data-e2e önce; sınıf adı parçaları yalnız satır/balon İÇİNDE alan bulmak için. */
const SEL = {
  listItem: '[data-e2e="dm-new-conversation-item"], [data-e2e="chat-list-item"], [data-e2e="conversation-item"]',
  nick: '[data-e2e="dm-new-conversation-nickname"], [data-e2e="chat-list-item-nickname"], [class*="InfoNickname"], [class*="NicknameText"]',
  preview: '[class*="SpanInfoExtract"], [data-e2e="chat-list-item-message"], [data-e2e="dm-new-conversation-message"], [class*="LastMsg"], [class*="LastMessage"]',
  time: '[class*="SpanInfoTime"], [data-e2e="chat-list-item-time"], [data-e2e="dm-new-conversation-time"], [class*="InfoTime"]',
  unread: '[data-e2e="dm-new-conversation-unread"], [data-e2e="chat-list-item-unread"], [class*="SpanNewMessage"], [class*="NewMessageCount"], [class*="UnreadCount"], [class*="RedDot"], [data-e2e*="unread"]',
  msgList: '[data-e2e="dm-new-message-list"], [data-e2e="chat-message-list"]',
  msgItem: '[data-e2e="dm-new-chat-item"], [data-e2e="chat-item"], [data-e2e="message-item"]',
  msgText: '[data-e2e="dm-new-message-text"], [data-e2e="chat-item-text"], [class*="DivTextContainer"], [class*="PText"]',
  sep: '[data-e2e="dm-new-time-separator"], [data-e2e="chat-time"], [class*="DivTimeContainer"], [class*="DivTimeWrapper"]',
  input:
    '[data-e2e="dm-new-input-editor"] [contenteditable="true"], [data-e2e="message-input-area"] [contenteditable="true"], [data-e2e="message-input-area"] textarea, .DraftEditor-root [contenteditable="true"]',
  headName: '[data-e2e="dm-new-chat-nickname"], [data-e2e="chat-nickname"]',
  headHandle: '[data-e2e="chat-uniqueid"], [data-e2e="dm-new-chat-uniqueid"]',
};
type Sel = typeof SEL;
/** Liste satırı: bilinen öznitelikler ya da görünüşten işaretlenen (`data-mv="list"`); anlık DOM izleyicisi de bunu kullanır */
const LIST_ITEM = `${SEL.listItem}, [data-mv="list"]`;
const INPUT = `${SEL.input}, [data-mv="input"]`;
const SEND_BTN = '[data-e2e="dm-new-send-btn"], [data-e2e="message-send"]';
const CAPTCHA = '#captcha_container, #captcha-verify-container-main-page, .captcha_verify_container, [class*="captcha_verify"], [id*="secsdk-captcha"]';
/** Sayfa içi okuyucu sürümü: değişince yeniden kurulur (tsx watch ile kod değişip sayfa yenilenmediyse) */
const LIB_V = 6;

/** Oturum sahibinin TikTok kullanıcı adı (me() doldurur): kendi mesajlarımı profil bağlantısından tanımak için */
let myHandle = '';
/** Sohbet kimliği → açılınca başlıkta görülen @kullanıcı adı */
const handles = new Map<string, string>();
/** Son görülen önizleme: değiştiyse sohbette yeni etkinlik ("şimdi") */
const lastPreview = new Map<string, string>();
/** Sohbetin son bilinen zamanı (önizleme değişmedikçe sabit): göreli liste zamanı ("1 g", "2h") her turda yeniden hesaplanınca
 *  zaman kayıyor → köprü değişmeyen sohbeti her turda "değişti" sayıp açıyordu ("Görüldü" riski) ve sohbet listede üste çıkıyordu */
const stableTs = new Map<string, number>();
/** Sohbet satırında son görülen zaman yazısı: kesin saat ("14:32" → "15:10") değişince önizleme aynı kalsa da yeni etkinlik */
const lastTime = new Map<string, string>();
/** Son okunan sayfa listesindeki en alttaki sohbetin zamanı: "daha eski sohbetler" bunun altında kalır (sıra korunur) */
let listFloor = 0;

export interface ListRow {
  name: string;
  preview: string;
  time: string;
  unread: number;
  avatarUrl?: string;
  /** Profil görseli kolajı (birden çok görsel) → grup sohbeti */
  group?: boolean;
  /** TikTok'un sohbet kimliği (data-conv-id), varsa: satır yeniden çizilse de tıklamadan hemen önce bununla yeniden bulunur */
  key?: string;
  selected?: boolean;
  /** Satırın liste içeriğindeki konumu (px, kaydırmadan bağımsız): sanal listede ekranlar arası aynı satır */
  pos?: number;
}

interface TagRes {
  list: number;
  mode: 'e2e' | 'geo' | 'none';
  msg: number;
  msgMode: 'e2e' | 'geo' | 'none';
  sep: number;
  input: number;
  pane: boolean;
}
interface SigRes {
  name: string;
  handle: string;
  sig: string;
  /** yalnız mesajların imzası (sayı + ilk/son mesaj) */
  msig: string;
  selKey: string;
  selName: string;
  /** seçili satırın liste içindeki konumu (seçili satır görünüşten de bulunamazsa null) */
  selPos: number | null;
  selSrc: 'aria' | 'bg' | '';
  composer: boolean;
  n: number;
}
/** Tıklanacak satır: TikTok kimliği (varsa), liste içeriğindeki konum, pencere sırası, ad; strict = konum tutmazsa ada göre arama yok */
interface Target {
  key?: string;
  pos?: number;
  idx: number;
  name: string;
  strict?: boolean;
}
interface RowPoint {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

/** Sayfadan okunan ham satır: zaman ayırıcı ya da mesaj (metin, ben mi, gönderen etiketi (grup), ekler) */
export interface RawItem {
  sep?: string;
  text?: string;
  me?: boolean;
  avatar?: string;
  /** Grup sohbetinde balonun üstündeki gönderen adı */
  sender?: string;
  attachments?: Attachment[];
}

/**
 * Sayfaya (ya da Business Suite çerçevesine) bir kez kurulan okuyucu: `window.__mvTT`. Durum (bulunan sohbet listesi kabı, mesaj
 * alanı ve imzası) sayfada kalır → 250 ms'lik bekleme döngülerinde tüm sayfa yeniden taranmaz. İçerik günlüğe yazılmaz; okunan
 * satırlar yalnız Node'a döner, tanı (`diag`) yalnız sayı/yapı verir.
 *
 * Görünüşten tanıma (29.09, Kaan: sohbetler geldi ama içleri boş; masaüstünde yalnız 3 "grup mesajı" sohbet sanıldı):
 * - Sohbet listesi: bir kabın doğrudan çocukları arasında alt alta dizili, profil görselli (grup kolajı da), 1-10 kısa yazılı satırlar.
 *   Satırlar SINIF ADINA göre gruplanmaz (TikTok'un emotion sınıflarında hash okunmuş/okunmamış/seçili/grup satırında değişiyor).
 *   Aday kaplar puanlanır: satır sayısı × zaman yazısı olanlar × hizalı satırlar; başka sayfaya bağlantı olan (sol menü "takip
 *   edilenler") ve menü/gezinme kaplarındaki satırlar cezalı; yazma alanının sütunu (açık sohbet bölmesi) HİÇ aday olmaz (açık grup
 *   sohbetinin mesaj satırları da profil görselli + kısa yazılı → eskiden sohbet sanılıyordu). Bulunan kap hatırlanır.
 * - Mesaj alanı: sohbet bölmesindeki en büyük kaydırılan alan; balon = arka planı/kenarlığı olan, köşesi yuvarlak, alanın %90'ından
 *   dar kutu. Her balonun satırı: yalnız o balonu içeren (ayırıcı içermeyen) en üst ata → gün/gönderen blokları kendiliğinden açılır.
 * - Yazma alanı: sağ alttaki düzenlenebilir alan / textarea (arama kutusu değil).
 */
function installLib(cfg: { sel: Sel; v: number }): void {
  const sel = cfg.sel;
  const st = { list: null as Element | null, area: null as Element | null, msgSig: '', msgRes: null as null | { msg: number; mode: 'e2e' | 'geo' | 'none'; sep: number }, listMode: 'none' as 'e2e' | 'geo' | 'none' };
  const W = () => innerWidth || document.documentElement.clientWidth;
  const H = () => innerHeight || document.documentElement.clientHeight;
  const norm = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  const R = (e: Element) => e.getBoundingClientRect();
  const shown = (e: Element) => {
    const r = R(e);
    return r.width > 0 && r.height > 0;
  };
  const MON = '(?:oca|şub|sub|mar|nis|may|haz|tem|ağu|agu|eyl|eki|kas|ara|jan|feb|apr|jun|jul|aug|sep|oct|nov|dec)[a-zçğıöşü]*\\.?';
  const DAYN = '(?:pazartesi|salı|çarşamba|perşembe|cumartesi|cuma|pazar|pzt|sal|çar|per|cum|cmt|paz|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\\.?';
  const HM = '\\d{1,2}[:.]\\d{2}(?:\\s*(?:am|pm|öö|ös))?';
  // liste zamanı / ayırıcı: saat, bugün/dün, gün adı, tarih (sayısal ya da ay adlı), göreli ("3 g", "2h", "5 dk önce")
  const TIMEISH = new RegExp(
    `^(?:(?:bugün|dün|today|yesterday|şimdi|az önce|just now|now)(?:[\\s,].*)?|${DAYN},?(?:\\s+${HM})?|${HM}|\\d{1,4}[./-]\\d{1,2}(?:[./-]\\d{2,4})?(?:,?\\s+${HM})?|\\d{1,2}\\s+${MON}(?:\\s+\\d{4})?(?:,?\\s+${HM})?|${MON}\\s+\\d{1,2}(?:,?\\s+\\d{4})?(?:,?\\s+(?:at\\s+)?${HM})?|\\d+\\s*(?:sn|s|dk|dakika|sa|saat|g|gün|hf|hafta|ay|y|yıl|m|min|mins|h|hr|hrs|d|w|wk|mo|yr)\\.?(?:\\s+(?:önce|ago))?)$`,
    'i',
  );
  const CLOCK = new RegExp(`^${HM}$`, 'i');
  const STATUS = /^(görüldü|görüntülendi|gönderildi|gönderiliyor|gönderilemedi|iletildi|okundu|seen|sent|sending|delivered|read|failed(?: to send)?|not sent)(?:\s*[·•:,]\s*.*)?$/i;
  const DIGITS = /^\d{1,3}\+?$/;
  const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\s)+$/u;
  /** Sınıf adlarındaki bileşen adları: css-<hash>-<yapı>--DivItemWrapper → DivItemWrapper (hash atılır) */
  const labels = (e: Element) =>
    (e.getAttribute('class') ?? '')
      .split(/\s+/)
      .flatMap((t) => t.split(/[-_]+/))
      .filter((p) => /^[A-Z][A-Za-z]{2,}\d?$/.test(p));
  const lowerParts = (e: Element) => (e.getAttribute('class') ?? '').toLowerCase().split(/[\s_-]+/);
  const navLike = (e: Element | null) => {
    for (let i = 0; e && i < 3; i++, e = e.parentElement) {
      if (labels(e).some((l) => /Nav|Sidebar|SideBar|Menu|Following|Suggest|Header/.test(l))) return true;
      if (lowerParts(e).some((p) => /^(nav|sidenav|sidebar|menu|navigation|following|suggested|header)$/.test(p))) return true;
    }
    return false;
  };
  const ownText = (e: Element) => {
    for (const n of Array.from(e.childNodes)) if (n.nodeType === 3 && (n.textContent ?? '').trim()) return true;
    return false;
  };
  /** Kendi yazısı olan en dış öğeler (alt öğeleri ayrıca sayılmaz) */
  const blocks = (root: Element, skip?: (e: Element) => boolean): Element[] => {
    if (ownText(root)) return [root];
    const out: Element[] = [];
    const walk = (e: Element) => {
      for (const c of Array.from(e.children)) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName) || skip?.(c)) continue;
        if (ownText(c)) out.push(c);
        else walk(c);
      }
    };
    walk(root);
    return out;
  };
  const inner = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const bgUrl = (e: Element | null | undefined) => {
    if (!e) return '';
    const b = (e as HTMLElement).style?.backgroundImage || getComputedStyle(e).backgroundImage;
    const m = b.match(/url\(["']?(https?:[^"')]+)/);
    return m ? m[1] : '';
  };
  const http = (s?: string | null) => (s && /^https?:\/\//.test(s) ? s : '');
  const alpha = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,/\s]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };
  /** Ekrandaki (görsel) sıraya göre: üstten alta, sonra soldan sağa; eşitlikte DOM sırası (sanal listelerde yeniden kullanılan
   *  satırlar ve column-reverse mesaj alanlarında DOM sırası görsel sıra değil). Görünmeyen öğe DOM'da önündekinin yerinde kalır. */
  const byTop = <T extends Element>(els: T[]): T[] => {
    let last = -Infinity;
    return els
      .map((e, i) => {
        const r = R(e);
        const vis = r.width > 0 || r.height > 0;
        const top = vis ? r.top : last;
        if (vis) last = r.top;
        return { e, i, top, left: vis ? r.left : 0 };
      })
      .sort((a, b) => (Math.abs(a.top - b.top) > 1 ? a.top - b.top : Math.abs(a.left - b.left) > 1 && a.top !== -Infinity ? a.left - b.left : a.i - b.i))
      .map((x) => x.e);
  };
  /** "Mesaj istekleri" / "Message requests" girişi: sohbet değil (tıklanınca istekler görünümü açılır) */
  const REQ = /^(mesaj istekleri|istekler|message requests|requests|filtered requests|filtrelenmiş istekler)$/i;
  const reqLike = (e: Element) => (e.getAttribute('data-e2e') ?? '').toLowerCase().includes('request') || labels(e).some((l) => /Request/.test(l));

  // ---------- sohbet listesi ----------
  /**
   * Satırdaki profil görseli: <img>/<picture>/arka plan görseli (≥24 px) ya da yuvarlak (baş harfli) kutu (≥28 px). Düz svg/ikon
   * yazı tipi sayılmaz (Business Suite sol menüsünün 20 px'lik simgeleri avatar sanılıp menü "sohbet listesi" oluyordu).
   * `icon`: avatar yerinde yalnız svg/ikon olan yuvarlak kutu ("Mesaj istekleri" girişi).
   */
  const avatarInfo = (row: Element, rr: DOMRect) => {
    let n = 0;
    const pos: string[] = [];
    let src = '';
    for (const e of Array.from(row.querySelectorAll('img, picture, [style*="background-image"]'))) {
      const r = R(e);
      if (r.width < 24 || r.width > 100 || r.height < 24 || r.height > 100) continue;
      const ar = r.width / r.height;
      if (ar < 0.45 || ar > 2.2 || r.left - rr.left > rr.width * 0.45) continue;
      if (e.tagName === 'IMG' && e.closest('picture') && row.contains(e.closest('picture'))) continue;
      n++;
      const s = e.tagName === 'IMG' ? http(e.getAttribute('src')) : e.tagName === 'PICTURE' ? http(e.querySelector('img')?.getAttribute('src')) : bgUrl(e);
      const k = `${Math.round(r.left / 4)}:${Math.round(r.top / 4)}`;
      if (!pos.includes(k)) pos.push(k);
      if (!src && s) src = s;
    }
    let icon = false;
    if (!n) {
      // yedek: sınıfı hash'li, görseli CSS'ten gelen ya da baş harfli yuvarlak kutu
      for (const e of Array.from(row.querySelectorAll('div, span, i, figure')).slice(0, 24)) {
        const r = R(e);
        if (r.width < 28 || r.width > 72 || Math.abs(r.width - r.height) > 4 || r.left - rr.left > rr.width * 0.35) continue;
        const cs = getComputedStyle(e);
        const url = cs.backgroundImage.includes('url(');
        if (url || (parseFloat(cs.borderTopLeftRadius) >= r.width * 0.3 && alpha(cs.backgroundColor) > 0.05)) {
          // yuvarlak kutuda yalnız simge (svg), yazı/görsel yok → istek/klasör girişi
          if (!url && e.querySelector('svg') && !norm(e.textContent)) icon = true;
          else n++;
          if (!src) src = bgUrl(e);
          break;
        }
      }
    }
    return { n, imgs: pos.length, src, icon };
  };
  const rowInfo = (ch: Element) => {
    const r = R(ch);
    if (r.width < 140 || r.height < 36 || r.height > 170 || r.width > W() * 0.62 || r.left > W() * 0.6) return null;
    const av = avatarInfo(ch, r);
    if (!av.n && !av.icon) return null;
    const bl = blocks(ch).map((e) => norm(e.textContent)).filter(Boolean);
    if (bl.length < 1 || bl.length > 10 || bl.join('').length > 500) return null;
    const links = (ch.matches('a[href]') ? [ch] : []).concat(Array.from(ch.querySelectorAll('a[href]')));
    const link = links.some((a) => {
      const h = a.getAttribute('href') ?? '';
      return h && h !== '#' && !/^javascript:/i.test(h) && !/messag|conversation|chat|conv|inbox/i.test(h);
    });
    const role = (ch.getAttribute('role') ?? '').toLowerCase();
    return {
      r,
      n: bl.length,
      link,
      time: bl.some((t) => TIMEISH.test(t)),
      req: av.icon || reqLike(ch) || bl.slice(0, 2).some((t) => REQ.test(t)),
      navRole: /^(button|menuitem|tab|link)$/.test(role) && bl.length === 1,
    };
  };
  const knownRows = () => {
    const all = Array.from(document.querySelectorAll(sel.listItem));
    return byTop(
      all.filter((e) => {
        if (e.parentElement?.closest(sel.listItem) || reqLike(e)) return false;
        const first = blocks(e).map((b) => norm(b.textContent)).find(Boolean) ?? '';
        return !REQ.test(first);
      }),
    );
  };
  const geoRows = () =>
    st.list && st.list.isConnected
      ? byTop(
          Array.from(st.list.children).filter((c) => {
            const i = rowInfo(c);
            return !!i && !i.req;
          }),
        )
      : [];
  const listRows = () => {
    const k = knownRows();
    return k.length ? k : geoRows();
  };
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  /** Satır tıklanabilir mi (satırın kendisi ya da ilk iki düzeydeki öğesi imleci el): sohbet satırları evet, mesaj satırları genelde hayır */
  const pointer = (e: Element) => {
    if (getComputedStyle(e).cursor === 'pointer') return true;
    for (const c of Array.from(e.children).slice(0, 4)) {
      if (getComputedStyle(c).cursor === 'pointer') return true;
      for (const d of Array.from(c.children).slice(0, 4)) if (getComputedStyle(d).cursor === 'pointer') return true;
    }
    return false;
  };
  /** Aday kabın puanı (0 = sohbet listesi değil) */
  const scoreOf = (c: Element, pane: Element | null): number => {
    const n = c.childElementCount;
    if (n < 1 || n > 600) return 0;
    if (pane && (pane.contains(c) || c.contains(pane))) return 0;
    const cr = R(c);
    if (cr.width < 140 || cr.height < 36 || cr.left > W() * 0.6) return 0;
    const rows: Array<NonNullable<ReturnType<typeof rowInfo>> & { e: Element }> = [];
    for (const ch of Array.from(c.children)) {
      const info = rowInfo(ch);
      if (info && !info.req) rows.push({ ...info, e: ch });
    }
    const k = rows.length;
    if (!k || (k === 1 && rows[0].n < 2)) return 0;
    const mL = median(rows.map((x) => x.r.left));
    const mW = median(rows.map((x) => x.r.width));
    const fAlign = rows.filter((x) => Math.abs(x.r.left - mL) < 6 && Math.abs(x.r.width - mW) < 6).length / k;
    const fTime = rows.filter((x) => x.time).length / k;
    const fTwo = rows.filter((x) => x.n >= 2).length / k;
    const fLink = rows.filter((x) => x.link).length / k;
    const fPtr = rows.slice(0, 6).filter((x) => pointer(x.e)).length / Math.min(k, 6);
    const fNav = rows.filter((x) => x.navRole).length / k;
    let sc = k * (1 + 2 * fTime) * (0.5 + fTwo) * (fAlign >= 0.8 ? 1 : 0.2) * (k / n >= 0.5 ? 1 : 0.5) * (fPtr >= 0.5 ? 2 : 1);
    // zaman yazılı satırlar (sohbet listesi) güçlü işaret: tek sohbetli gerçek liste, satır sayısı çok olan menüyü geçsin
    if (fTime > 0) sc *= 3;
    // tek yazılı düğme/menü öğeleri (gezinme)
    if (fNav > 0.5) sc *= 0.2;
    if (fLink > 0.5) sc *= 0.1;
    if (c.closest('nav, [role="navigation"], header, [role="banner"]') || navLike(c)) sc *= 0.3;
    return sc;
  };
  const findList = (pane: Element | null): { el: Element | null; score: number } => {
    let best: Element | null = null;
    let bestS = 0;
    const all = document.querySelectorAll('div, ul, ol, section, nav, aside, main, [role="list"], [role="listbox"], [role="grid"], [role="rowgroup"], [role="tree"]');
    const lim = Math.min(all.length, 12000);
    for (let i = 0; i < lim; i++) {
      const c = all[i];
      const n = c.childElementCount;
      if (n < 1 || n > 600) continue;
      const sc = scoreOf(c, pane);
      if (sc > bestS) {
        best = c;
        bestS = sc;
      }
    }
    return { el: best, score: bestS };
  };

  // ---------- yazma alanı / sohbet bölmesi ----------
  const composer = (): Element | null => {
    const k = Array.from(document.querySelectorAll(sel.input)).find(shown);
    if (k) return k;
    const c = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea, [role="textbox"]'))
      .filter((e) => {
        const r = R(e);
        if (r.width < 100 || r.height <= 0) return false;
        if (e.closest('[role="search"], form[action*="search"], [data-e2e*="search"], [class*="Search"]')) return false;
        return r.left > W() * 0.2 && r.top > H() * 0.35;
      })
      .sort((a, b) => R(b).bottom - R(a).bottom)[0];
    return c ?? null;
  };
  /** Yazma alanının sütunu (açık sohbet bölmesi): soldaki listeyi içerecek kadar genişlemeden en üst ata */
  const paneOf = (comp: Element | null): Element | null => {
    if (!comp) return null;
    const cr = R(comp);
    let cur: Element = comp;
    while (cur.parentElement && cur.parentElement !== document.body && cur.parentElement !== document.documentElement) {
      const p = cur.parentElement;
      const pr = R(p);
      if (pr.left < cr.left - 140 || pr.width > W() * 0.95) break;
      if (st.list && p.contains(st.list)) break;
      cur = p;
    }
    return cur;
  };

  const tagList = (fresh: boolean, pane: Element | null): { n: number; mode: 'e2e' | 'geo' | 'none' } => {
    const k = knownRows();
    if (k.length) {
      st.listMode = 'e2e';
      return { n: k.length, mode: 'e2e' };
    }
    if (st.list && (!st.list.isConnected || (pane && pane.contains(st.list)))) st.list = null;
    let rows = geoRows();
    if (!rows.length || fresh) {
      const best = findList(pane);
      // bulunan kap yapışkan: tam taramada ancak belirgin biçimde daha iyi bir aday çıkarsa değişir (yazma alanı görünmezken açık
      // sohbetin mesaj satırları bir an önde görünse de liste kaçmasın)
      const cur = rows.length && st.list ? scoreOf(st.list, pane) : 0;
      if (best.el && (!cur || best.score > cur * 1.5)) st.list = best.el;
      rows = geoRows();
    }
    for (const e of Array.from(document.querySelectorAll('[data-mv="list"]'))) if (!rows.includes(e)) e.removeAttribute('data-mv');
    for (const e of rows) e.setAttribute('data-mv', 'list');
    st.listMode = rows.length ? 'geo' : 'none';
    return { n: rows.length, mode: st.listMode };
  };

  // ---------- mesaj alanı ----------
  const scrollable = (e: Element) => {
    const oy = getComputedStyle(e).overflowY;
    return oy === 'auto' || oy === 'scroll' || e.getAttribute('role') === 'log';
  };
  const scrollParent = (e: Element | null): HTMLElement | null => {
    for (let p = e?.parentElement ?? null; p && p !== document.body; p = p.parentElement) if (scrollable(p) && p.scrollHeight > p.clientHeight + 4) return p;
    return null;
  };
  const listRight = () => {
    const rs = listRows();
    return rs.length ? Math.max(...rs.map((e) => R(e).right)) : 0;
  };
  const findArea = (pane: Element | null): Element | null => {
    const k = Array.from(document.querySelectorAll(sel.msgList)).find(shown);
    if (k) return k;
    // yalnız kaydırılan alan hatırlanır (bölme yedeği değil: mesajlar yüklenince asıl alan ortaya çıkar)
    if (st.area && st.area.isConnected && shown(st.area) && st.area !== pane && scrollable(st.area) && (!pane || pane.contains(st.area))) return st.area;
    const lr = listRight();
    const kr = knownRows()[0];
    const scope = pane ?? document.body;
    let best: Element | null = null;
    let size = 0;
    const els = scope.querySelectorAll('div, section, main, ul, ol, [role="log"], [role="list"]');
    for (let i = 0; i < Math.min(els.length, 8000); i++) {
      const el = els[i];
      const r = R(el);
      if (r.width <= 0 || r.height < H() * 0.25) continue;
      if (!pane && r.left < Math.max(lr - 4, W() * 0.25)) continue;
      if (st.list && (el.contains(st.list) || st.list.contains(el))) continue;
      if (kr && el.contains(kr)) continue;
      if (!scrollable(el)) continue;
      const a = r.width * r.height;
      if (a > size && norm(el.textContent)) {
        best = el;
        size = a;
      }
    }
    return best ?? pane;
  };
  // WeakMap: uzun açık kalan sayfada eski sohbetlerin (DOM'dan çıkmış) düğümlerini tutmaz; her okuma/etiketlemede yenilenir
  let bubbleMemo = new WeakMap<Element, boolean>();
  const isBubble = (e: Element, aw: number) => {
    const hit = bubbleMemo.get(e);
    if (hit !== undefined) return hit;
    const r = R(e);
    let ok = false;
    if (r.width >= 16 && r.height >= 14 && r.width < aw * 0.9) {
      const s = getComputedStyle(e);
      const rad = Math.max(parseFloat(s.borderTopLeftRadius) || 0, parseFloat(s.borderTopRightRadius) || 0, parseFloat(s.borderBottomLeftRadius) || 0, parseFloat(s.borderBottomRightRadius) || 0);
      const paint = alpha(s.backgroundColor) > 0.05 || s.backgroundImage !== 'none' || ((parseFloat(s.borderTopWidth) || 0) >= 1 && s.borderTopStyle !== 'none' && alpha(s.borderTopColor) > 0.05);
      ok = paint && rad >= 4;
    }
    bubbleMemo.set(e, ok);
    return ok;
  };
  /** Öğeyi içeren en içteki balon (alan sınırına ya da `stop`a dek, en çok 9 düzey) */
  const bubbleOf = (e: Element, stop: Element, aw: number): Element | null => {
    let cur: Element | null = e;
    for (let d = 0; cur && cur !== stop && d < 9; d++, cur = cur.parentElement) if (isBubble(cur, aw)) return cur;
    return null;
  };
  const clearMsgTags = () => {
    for (const e of Array.from(document.querySelectorAll('[data-mv="msg"], [data-mv="sep"]'))) e.removeAttribute('data-mv');
    for (const e of Array.from(document.querySelectorAll('[data-mv-b]'))) e.removeAttribute('data-mv-b');
  };
  const tagMsgs = (): { msg: number; mode: 'e2e' | 'geo' | 'none'; sep: number } => {
    const comp = composer();
    const pane = paneOf(comp);
    const first = document.querySelector(sel.msgItem);
    if (first) {
      bubbleMemo = new WeakMap();
      st.area = first.closest(sel.msgList) ?? scrollParent(first) ?? first.parentElement;
      const n = Array.from(document.querySelectorAll(sel.msgItem)).filter((e) => !e.parentElement?.closest(sel.msgItem)).length;
      return { msg: n, mode: 'e2e', sep: document.querySelectorAll(sel.sep).length };
    }
    const area = findArea(pane);
    if (!area) {
      clearMsgTags();
      st.area = null;
      return { msg: 0, mode: 'none', sep: 0 };
    }
    const sig = `${area.getElementsByTagName('*').length}:${(area.textContent ?? '').length}:${Math.round(area.scrollHeight)}:${Math.round(R(area).width)}`;
    if (area === st.area && sig === st.msgSig && st.msgRes && (st.msgRes.msg === 0 || area.querySelector('[data-mv="msg"]'))) return st.msgRes;
    st.area = area;
    st.msgSig = sig;
    bubbleMemo = new WeakMap();
    clearMsgTags();
    const ar = R(area);
    const aw = ar.width;
    const skip = (e: Element) => !!(comp && comp.contains(e)) || /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(e.tagName) || e.getAttribute('contenteditable') === 'true';
    const texts = blocks(area, skip).filter((b) => norm(b.textContent) && shown(b));
    const media = Array.from(area.querySelectorAll('img, video, canvas, [style*="background-image"]')).filter((e) => {
      if (skip(e) || e.closest('button')) return false;
      const r = R(e);
      return (r.width >= 56 && r.height >= 40) || (e.matches('img[alt="sticker" i]') && r.width >= 24);
    });
    const centered = (r: DOMRect) => Math.abs(r.left + r.width / 2 - (ar.left + aw / 2)) < aw * 0.12;
    const sepLike = (e: Element) => {
      const t = norm(e.textContent);
      return t.length > 0 && t.length <= 40 && TIMEISH.test(t) && centered(R(e)) && !e.querySelector('img, video');
    };
    let units: Element[] = [];
    const loose: Element[] = [];
    for (const b of texts) {
      const u = bubbleOf(b, area, aw);
      if (u) units.push(u);
      else loose.push(b);
    }
    for (const m of media) units.push(bubbleOf(m, area, aw) ?? m);
    units = Array.from(new Set(units));
    // ortalanmış tarih/saat hapı (arka planlı ayırıcı) balon değil
    const pillSeps = units.filter((u) => sepLike(u));
    units = units.filter((u) => !pillSeps.includes(u));
    // iç içe balonlar (alıntı kutusu, video kartı + açıklama): dıştaki kalır
    units = units.filter((u) => !units.some((o) => o !== u && o.contains(u)));
    // hiç balon yoksa (düz yazılı düzen): ayırıcı/durum/ortalanmış ipucu olmayan yazılar mesaj sayılır
    const plain = (b: Element) => {
      const t = norm(b.textContent);
      return !sepLike(b) && !STATUS.test(t) && !CLOCK.test(t) && !centered(R(b));
    };
    if (!units.length) units = loose.filter(plain);
    else {
      // balonlu düzende de balonsuz mesajlar olabilir (yalnız emoji büyük yazılır, arka plansız): balon yazısı boyutunda,
      // bir balonun hemen üstünde durmayan (gönderen etiketi değil) serbest yazılar da mesaj; yalnız emojiden oluşanlar her zaman
      const fsOf = (e: Element) => parseFloat(getComputedStyle(e).fontSize) || 0;
      // balon başına en büyük yazı (saat/durum küçük yazısı değil)
      const bubbleFs = median(
        units
          .slice(0, 40)
          .map((u) => Math.max(0, ...blocks(u).map(fsOf)))
          .filter((x) => x > 0),
      );
      const labelLike = (b: Element) => {
        const r = R(b);
        return units.some((u) => {
          const ur = R(u);
          return ur.top >= r.bottom - 2 && ur.top - r.bottom < 24 && ur.left < r.right && ur.right > r.left;
        });
      };
      for (const b of loose) {
        if (!plain(b) || units.some((u) => u.contains(b) || b.contains(u))) continue;
        const t = norm(b.textContent);
        if (EMOJI_ONLY.test(t) || (bubbleFs > 0 && fsOf(b) >= bubbleFs - 0.5 && !labelLike(b))) units.push(b);
      }
    }
    const unitCnt = new Map<Element, number>();
    for (const u of units) for (let p = u.parentElement; p && p !== area; p = p.parentElement) unitCnt.set(p, (unitCnt.get(p) ?? 0) + 1);
    const seps: Element[] = [];
    for (const b of loose.filter(sepLike).concat(pillSeps)) {
      let cur = b;
      const t = norm(b.textContent);
      while (cur.parentElement && cur.parentElement !== area && !unitCnt.has(cur.parentElement) && norm(cur.parentElement.textContent) === t) cur = cur.parentElement;
      if (!units.some((u) => u.contains(cur))) seps.push(cur);
    }
    const sepCnt = new Set<Element>();
    for (const s of seps) for (let p = s.parentElement; p && p !== area; p = p.parentElement) sepCnt.add(p);
    const rows: Element[] = [];
    for (const u of units) {
      let cur = u;
      while (cur.parentElement && cur.parentElement !== area && (unitCnt.get(cur.parentElement) ?? 0) <= 1 && !sepCnt.has(cur.parentElement)) cur = cur.parentElement;
      if (!rows.includes(cur)) rows.push(cur);
      u.setAttribute('data-mv-b', '1');
    }
    for (const r of rows) r.setAttribute('data-mv', 'msg');
    for (const s of seps) if (!rows.some((r) => r.contains(s))) s.setAttribute('data-mv', 'sep');
    st.msgRes = { msg: rows.length, mode: rows.length ? 'geo' : 'none', sep: seps.length };
    return st.msgRes;
  };

  const tagInput = (comp: Element | null): number => {
    if (document.querySelector(sel.input)) return 1;
    for (const e of Array.from(document.querySelectorAll('[data-mv="input"]'))) if (e !== comp) e.removeAttribute('data-mv');
    if (!comp) return 0;
    comp.setAttribute('data-mv', 'input');
    return 1;
  };

  const tag = (o?: { fresh?: boolean }) => {
    const comp = composer();
    const pane = paneOf(comp);
    const l = tagList(!!o?.fresh, pane);
    const m = tagMsgs();
    return { list: l.n, mode: l.mode, msg: m.msg, msgMode: m.mode, sep: m.sep, input: tagInput(comp), pane: !!pane };
  };

  // ---------- okuma ----------
  const readRow = (it: Element, ctx?: { sel: Element | null; sc: HTMLElement | null }) => {
    const rr = R(it);
    const bl = blocks(it)
      .map((e) => ({ e, t: norm(e.textContent), r: R(e) }))
      .filter((x) => x.t);
    const q = (s: string) =>
      Array.from(it.querySelectorAll(s))
        .map((e) => norm(e.textContent))
        .find((t) => t && t.length < 300);
    let unread = 0;
    let badge = '';
    const bEl = it.querySelector(sel.unread);
    if (bEl) {
      const t = norm(bEl.textContent);
      if (DIGITS.test(t)) {
        unread = parseInt(t, 10) || 1;
        badge = t;
      } else if (!t) unread = 1;
    }
    if (!bEl) {
      // yedek: satırın sağındaki renkli hap içinde yalnız sayı
      // (renk iç <span>'de değil sarmalayıcıda olabilir: en çok 2 ata, satırın içinde)
      const painted = (e: Element) => {
        let cur: Element | null = e;
        for (let d = 0; cur && cur !== it && d < 3; d++, cur = cur.parentElement) {
          const s = getComputedStyle(cur);
          if (alpha(s.backgroundColor) > 0.05 && (d === 0 || (parseFloat(s.borderTopLeftRadius) || 0) > 0)) return R(cur).width <= 44;
        }
        return false;
      };
      const b = bl.find((x) => DIGITS.test(x.t) && x.r.left > rr.left + rr.width * 0.6 && x.r.width <= 40 && painted(x.e));
      if (b) {
        unread = parseInt(b.t, 10) || 1;
        badge = b.t;
      }
    }
    let time = q(sel.time) ?? '';
    if (!time) time = bl.filter((x) => TIMEISH.test(x.t)).sort((a, b) => b.r.right - a.r.right)[0]?.t ?? '';
    let name = q(sel.nick) ?? '';
    if (!name) {
      const c = bl
        .filter((x) => !DIGITS.test(x.t) && x.t !== time && !STATUS.test(x.t))
        .sort((a, b) => Math.round((a.r.top - b.r.top) / 6) || a.r.left - b.r.left);
      name = c[0]?.t ?? '';
    }
    let preview = q(sel.preview) ?? '';
    if (!preview)
      preview =
        bl
          .filter((x) => x.t !== name && x.t !== time && !(badge && x.t === badge && x.r.left > rr.left + rr.width * 0.5))
          .sort((a, b) => b.t.length - a.t.length)[0]?.t ?? '';
    const av = avatarInfo(it, rr);
    const key =
      it.getAttribute('data-conv-id') ||
      it.getAttribute('data-conversation-id') ||
      it.querySelector('[data-conv-id]')?.getAttribute('data-conv-id') ||
      it.closest('[data-conversation-id]')?.getAttribute('data-conversation-id') ||
      '';
    const selected = it.getAttribute('aria-selected') === 'true' || !!it.querySelector('[aria-selected="true"]') || !!it.closest('[aria-selected="true"]') || ctx?.sel === it;
    return {
      name: name.slice(0, 80),
      preview: preview.slice(0, 200),
      time: time.slice(0, 40),
      unread,
      avatarUrl: av.src || undefined,
      group: av.imgs >= 2,
      key: key || undefined,
      selected,
      pos: ctx ? posOf(it, ctx.sc) : undefined,
    };
  };
  const rows = () => {
    const rs = listRows();
    const sc = listScroller(rs[0] ?? null);
    const ctx = { sel: selectedRow(rs)?.el ?? null, sc };
    return { lang: document.documentElement.lang || '', top: !sc || sc.scrollTop <= 2, rows: rs.map((e) => readRow(e, ctx)) };
  };

  const header = (): { name: string; handle: string } => {
    let name = norm(document.querySelector(sel.headName)?.textContent);
    let handle = norm(document.querySelector(sel.headHandle)?.textContent).replace(/^@/, '');
    const pane = paneOf(composer());
    const area = st.area && st.area.isConnected ? st.area : null;
    const scope = pane ?? area?.parentElement ?? null;
    const comp = composer();
    if (scope && (!name || !handle)) {
      const top = area && area !== scope ? R(area).top : R(scope).top + 90;
      const above = (e: Element) => R(e).bottom <= top + 2 && shown(e);
      if (!handle) {
        const a = Array.from(scope.querySelectorAll('a[href*="/@"]')).find(above);
        const m = a?.getAttribute('href')?.match(/\/@([^/?#]+)/);
        if (m) handle = decodeURIComponent(m[1]);
      }
      if (!name) {
        const b = blocks(scope, (e) => (!!area && (e === area || area.contains(e))) || (!!comp && comp.contains(e)))
          .filter((e) => above(e) && !e.closest('button'))
          .map((e) => norm(e.textContent))
          .find((t) => t && t.length <= 80 && !t.startsWith('@') && !TIMEISH.test(t) && !STATUS.test(t));
        name = b ?? '';
      }
    }
    return { name, handle };
  };

  const msgRowsNow = () => {
    const k = Array.from(document.querySelectorAll(sel.msgItem)).filter((e) => !e.parentElement?.closest(sel.msgItem));
    return byTop(k.length ? k : Array.from(document.querySelectorAll('[data-mv="msg"]')));
  };

  const sig = () => {
    tagMsgs();
    const h = header();
    const mr = msgRowsNow();
    const comp = composer();
    const pane = paneOf(comp) ?? st.area;
    const rs = listRows();
    const sr = selectedRow(rs);
    const sc = listScroller(rs[0] ?? null);
    const s = sr ? readRow(sr.el) : undefined;
    const msig = `${mr.length}|${norm(mr[0]?.textContent).slice(0, 80)}|${norm(mr[mr.length - 1]?.textContent).slice(0, 80)}`;
    return {
      name: h.name,
      handle: h.handle,
      sig: `${h.name}|${msig}|${(pane?.textContent ?? '').length}`,
      msig,
      selKey: s?.key ?? '',
      selName: s?.name ?? '',
      selPos: sr ? posOf(sr.el, sc) : null,
      selSrc: sr?.src ?? '',
      composer: !!comp,
      n: mr.length,
    };
  };

  /** Satırı (tıklamadan hemen önce taze) bul, görünür alana kaydır, adın ortasını ve yedek noktayı ver */
  const findRowEl = (t: Target) => {
    const rs = listRows();
    let row = t.key ? rs.find((e) => readRow(e).key === t.key) : undefined;
    if (!row && t.pos !== undefined) {
      // liste içindeki konumuyla (aynı adlı sohbetler karışmasın)
      const sc = listScroller(rs[0] ?? null);
      row = rs.find((e) => Math.abs(posOf(e, sc) - (t.pos as number)) < 20 && readRow(e).name === t.name);
      if (!row && t.strict) return null;
    }
    if (!row) {
      row = rs[t.idx];
      if (!row || readRow(row).name !== t.name) row = rs.find((e) => readRow(e).name === t.name);
    }
    return row ?? null;
  };
  const nameEl = (row: Element) => {
    const k = row.querySelector(sel.nick);
    if (k && shown(k)) return k;
    const n = readRow(row).name;
    return blocks(row).find((e) => norm(e.textContent) === n) ?? null;
  };
  const point = (t: Target): RowPoint | null => {
    const row = findRowEl(t);
    if (!row) return null;
    (row as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
    const rr = R(row);
    const ne = nameEl(row);
    const nr = ne ? R(ne) : rr;
    const cx = (x: number) => Math.max(1, Math.min(W() - 2, x));
    const cy = (y: number) => Math.max(1, Math.min(H() - 2, y));
    return {
      x: cx(nr.left + Math.min(nr.width / 2, 40)),
      y: cy(nr.top + nr.height / 2),
      ax: cx(rr.left + rr.width * 0.55),
      ay: cy(rr.top + rr.height / 2),
    };
  };
  /** Yedek: iç ad öğesine tam işaretçi/fare olay dizisi (gerçek tıklama ulaşmadıysa) */
  const poke = (t: Target): boolean => {
    const row = findRowEl(t);
    if (!row) return false;
    const target = nameEl(row) ?? row;
    const r = R(target);
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const ev = type.startsWith('pointer') ? new PointerEvent(type, { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, o);
      target.dispatchEvent(ev);
    }
    return true;
  };

  /** Sohbet listesini kaydıran öğe (yoksa null: sayfa kayar) */
  const listScroller = (r0?: Element | null): HTMLElement | null => {
    if (r0 === undefined) r0 = listRows()[0] ?? null;
    let el: HTMLElement | null = st.list && scrollable(st.list) && st.list.scrollHeight > st.list.clientHeight + 4 ? (st.list as HTMLElement) : scrollParent(r0 ?? null);
    if (!el && r0) {
      // TikTok 2026: kaydırılan öğe liste kabının atası değil, çekmecenin (DivDrawerContainer) içinde
      const d = r0.closest('[class*="DrawerContainer"], [class*="Drawer"]');
      el = d ? (Array.from(d.querySelectorAll('div')).find((x) => scrollable(x) && x.scrollHeight > x.clientHeight + 4) as HTMLElement | undefined) ?? null : null;
    }
    return el;
  };
  /** Satırın liste İÇERİĞİNDEKİ konumu (kaydırmadan bağımsız): sanal listede ekranlar arası aynı satırı tanımak için */
  const posOf = (row: Element, sc: HTMLElement | null) => Math.round(sc ? R(row).top - R(sc).top + sc.scrollTop : R(row).top + scrollY);
  /** Arka planı görünür (ya da satırı kaplayan ilk çocuğunun) renk imzası */
  const rowBg = (e: Element): string => {
    const own = getComputedStyle(e).backgroundColor;
    if (alpha(own) > 0.05) return own;
    const r = R(e);
    for (const c of Array.from(e.children).slice(0, 3)) {
      const cr = R(c);
      if (cr.width >= r.width * 0.9 && cr.height >= r.height * 0.8) {
        const b = getComputedStyle(c).backgroundColor;
        if (alpha(b) > 0.05) return b;
      }
    }
    return '';
  };
  /** Seçili (açık) sohbet satırı: aria-selected, yoksa (görünüşten) arka planı öteki satırlardan farklı TEK satır */
  const selectedRow = (rs: Element[]): { el: Element; src: 'aria' | 'bg' } | null => {
    const a = rs.find((e) => e.getAttribute('aria-selected') === 'true' || !!e.querySelector('[aria-selected="true"]'));
    if (a) return { el: a, src: 'aria' };
    if (!rs.length) return null;
    const bgs = rs.map(rowBg);
    const cnt = new Map<string, number>();
    for (const b of bgs) cnt.set(b, (cnt.get(b) ?? 0) + 1);
    // en yaygın arka plan = seçili olmayan satırlar; eşitlikte saydam (ya da altındaki zeminle aynı) olan
    let under = '';
    for (let p = rs[0].parentElement; p && !under; p = p.parentElement) {
      const b = getComputedStyle(p).backgroundColor;
      if (alpha(b) > 0.05) under = b;
    }
    const plainBg = (b: string) => (!b ? 2 : b === (under || 'rgb(255, 255, 255)') ? 1 : 0);
    const modal = [...cnt].sort((x, y) => y[1] - x[1] || plainBg(y[0]) - plainBg(x[0]))[0][0];
    const cand = rs.filter((_e, i) => bgs[i] && bgs[i] !== modal);
    if (rs.length === 1) return bgs[0] && plainBg(bgs[0]) === 0 ? { el: rs[0], src: 'bg' } : null;
    if (cand.length === 1 && plainBg(bgs[rs.indexOf(cand[0])]) !== 0) return null;
    return cand.length === 1 ? { el: cand[0], src: 'bg' } : null;
  };

  const scroll = (o: { what: 'list' | 'msgs'; to: 'top' | 'step' | 'bottom' }): { moved: boolean } => {
    let el: HTMLElement | null = null;
    if (o.what === 'list') {
      el = listScroller();
    } else {
      tagMsgs();
      const a = st.area as HTMLElement | null;
      const f = msgRowsNow()[0];
      el = a && scrollable(a) && a.scrollHeight > a.clientHeight + 4 ? a : a && a.firstElementChild && scrollable(a.firstElementChild) ? (a.firstElementChild as HTMLElement) : scrollParent(f ?? null);
    }
    if (!el) {
      if (o.what === 'list' && o.to !== 'top') {
        const rs = listRows();
        (rs[rs.length - 1] as HTMLElement | undefined)?.scrollIntoView({ block: 'end' });
      }
      return { moved: false };
    }
    const before = el.scrollTop;
    const rev = getComputedStyle(el).flexDirection === 'column-reverse';
    if (o.to === 'top') el.scrollTop = rev ? -el.scrollHeight : 0;
    else if (o.to === 'bottom') el.scrollTop = rev ? 0 : el.scrollHeight;
    else el.scrollTop = before + el.clientHeight * 0.85;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { moved: Math.abs(el.scrollTop - before) > 1 };
  };

  // ---------- mesajlar ----------
  const lines = (e: Element, drop: (t: string) => boolean) => {
    const ls = inner(e)
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    const kept = ls.length > 1 ? ls.filter((x) => !drop(x)) : ls;
    return kept.join('\n');
  };
  const handleOf = (a: Element) => {
    const m = (a.getAttribute('href') ?? '').match(/\/@([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  };
  const items = (o: { mine: string; peer: string }): RawItem[] => {
    const res = tagMsgs();
    const known = res.mode === 'e2e';
    const area = st.area && st.area.isConnected ? st.area : null;
    const itemSel = known ? sel.msgItem : '[data-mv="msg"]';
    const sepSel = known ? `${sel.sep}, [data-mv="sep"]` : '[data-mv="sep"]';
    const out: RawItem[] = [];
    let lastSender = '';
    let lastAv = '';
    let lastWrap: Element | null = null;
    bubbleMemo = new WeakMap();
    const isRow = (e: Element) => e.matches(itemSel) || e.matches(sepSel) || !!e.querySelector(`${itemSel}, ${sepSel}`);
    /** Balon bloğunun üstündeki gönderen adı (grupta ad bir kez, ardışık balonların sarmalayıcısında satırların KARDEŞİ olarak) */
    const labelAbove = (row: Element): string => {
      const top = R(row).top;
      for (let cur: Element | null = row; cur && cur !== area && cur !== document.body; cur = cur.parentElement) {
        const ps = cur.previousElementSibling;
        if (ps) {
          if (isRow(ps)) return ''; // önceki mesaj satırı: blok devam ediyor
          const bs = blocks(ps).map((b) => ({ t: norm(b.textContent), r: R(b) })).filter((x) => x.t);
          if (bs.length === 1) {
            const x = bs[0];
            if (x.t.length <= 40 && !TIMEISH.test(x.t) && !STATUS.test(x.t) && !x.t.startsWith('@') && x.r.bottom <= top + 3 && !ps.querySelector('img, video')) return x.t;
          }
          if (bs.length) return '';
        }
        if (cur.parentElement && area && cur.parentElement === area) break;
      }
      return '';
    };
    // görsel sıra (column-reverse alanda DOM sırası en yeniden eskiye; sanal listede düğümler karışık)
    for (const el of byTop(Array.from(document.querySelectorAll(`${itemSel}, ${sepSel}`)))) {
      if (!el.matches(itemSel)) {
        if (el.closest(itemSel) || el.parentElement?.closest(sepSel)) continue; // mesajın içindeki saat / iç içe ayırıcı
        if (area && !area.contains(el) && known) continue;
        const t = norm(inner(el));
        if (t && t.length <= 60) out.push({ sep: t });
        lastSender = '';
        continue;
      }
      if (el.parentElement?.closest(itemSel)) continue; // satırın içindeki parça
      const aw = area ? R(area).width : R(el).width;
      const textEl = el.querySelector('[data-e2e="dm-new-message-text"], [data-e2e="chat-item-text"]') ?? el.querySelector(sel.msgText);
      let bubble: Element | null = el.querySelector('[data-mv-b]') ?? (textEl ? bubbleOf(textEl, el, aw) ?? textEl : null);
      if (!bubble) {
        for (const b of blocks(el)) {
          const t = norm(b.textContent);
          if (!t || CLOCK.test(t) || STATUS.test(t)) continue;
          bubble = bubbleOf(b, el, aw);
          if (bubble) break;
        }
      }
      const tip = el.querySelector('[class*="ChatTip"]');
      // paylaşılan video: kart (arka plan görseli) ya da /video/ bağlantısı
      const attachments: Attachment[] = [];
      const vid = el.querySelector('[data-e2e="dm-new-shared-video"], [data-e2e*="shared-video"], a[href*="/video/"]');
      let text = '';
      if (textEl && (!vid || !vid.contains(textEl))) text = lines(textEl, (x) => CLOCK.test(x) || STATUS.test(x));
      else if (bubble && (!vid || !vid.contains(bubble) || bubble.contains(vid))) text = lines(bubble, (x) => CLOCK.test(x) || STATUS.test(x));
      if (vid) {
        const a = vid.matches('a[href*="/video/"]') ? vid : vid.querySelector('a[href*="/video/"]') ?? vid.closest('a[href*="/video/"]');
        const href = a ? new URL(a.getAttribute('href') ?? '', location.origin).href : undefined;
        const cover = bgUrl(vid) || bgUrl(vid.querySelector('[style*="background-image"]')) || http(vid.querySelector('img')?.getAttribute('src')) || undefined;
        attachments.push({ kind: 'other', name: 'TikTok videosu', link: href, url: cover, page: href });
        if (bubble && vid.contains(bubble)) text = ''; // kart altındaki video açıklaması mesaj metni değil
        if (text && vid.textContent && norm(vid.textContent) === norm(text)) text = '';
      }
      for (const img of Array.from(el.querySelectorAll('img'))) {
        if (vid && vid.contains(img)) continue;
        const src = http(img.getAttribute('src'));
        const r = R(img);
        const sticker = /sticker/i.test(img.getAttribute('alt') ?? '');
        if (!src || (!(r.width >= 60 && r.height >= 60) && !(sticker && r.width >= 24))) continue; // avatar ~32-40px
        attachments.push({ kind: 'image', name: sticker ? 'Çıkartma' : img.getAttribute('alt') || 'Fotoğraf', url: src, link: src });
      }
      for (const e of Array.from(el.querySelectorAll('[style*="background-image"]'))) {
        if (vid && (vid === e || vid.contains(e))) continue;
        const r = R(e);
        const u = bgUrl(e);
        if (u && r.width >= 60 && r.height >= 60) attachments.push({ kind: 'image', name: 'Fotoğraf', url: u, link: u });
      }
      for (const v of Array.from(el.querySelectorAll('video'))) {
        const src = http(v.getAttribute('src')) || http(v.querySelector('source')?.getAttribute('src'));
        if (src) attachments.push({ kind: 'video', name: 'Video', link: src, url: http(v.getAttribute('poster')) || undefined, mime: 'video/mp4' });
      }
      // grup: balonun üstündeki kısa ad etiketi
      const br = bubble ? R(bubble) : null;
      const outside = blocks(el)
        .filter((b) => !(bubble && (bubble.contains(b) || b.contains(bubble))) && !(vid && vid.contains(b)))
        .map((b) => ({ t: norm(b.textContent), r: R(b) }))
        .filter((x) => x.t && !TIMEISH.test(x.t) && !STATUS.test(x.t) && !(tip && x.t === norm(tip.textContent)));
      let label = br ? outside.find((x) => x.t.length <= 60 && x.r.bottom <= br.top + 3 && !x.t.startsWith('@')) : undefined;
      if (!label && !known) {
        const t = labelAbove(el);
        if (t) label = { t, r: new DOMRect() };
      }
      if (!textEl && !bubble) {
        // balonsuz satır: satır yazısından ad etiketi, saat ve durum satırları atılır
        text = lines(el, (x) => TIMEISH.test(x) || STATUS.test(x) || (!!label && x === label.t));
      }
      if (!text && !attachments.length) continue;
      if (tip && !bubble && !attachments.length) continue; // "artık mesajlaşabilirsiniz" gibi sistem ipucu
      // ben mi: 1) kendi profil bağlantım 2) balon mesaj alanında sağa yaslı 3) karşı tarafın avatarı 4) hizalama stili
      let me: boolean | undefined;
      const prof = Array.from(el.querySelectorAll('a[href*="/@"]'))
        .map(handleOf)
        .find(Boolean);
      if (prof && o.mine) me = prof.toLowerCase() === o.mine.toLowerCase();
      else if (prof && o.peer && prof.toLowerCase() === o.peer.toLowerCase()) me = false;
      const ref = area ? R(area) : R(el);
      let box = br;
      if (!box) {
        const rs = blocks(el)
          .filter((b) => !label || norm(b.textContent) !== label.t)
          .map(R)
          .filter((r) => r.width > 0);
        if (rs.length) box = new DOMRect(Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left)), 1);
      }
      if (me === undefined && box && box.width > 0 && box.width < ref.width * 0.92) {
        const gapL = box.left - ref.left;
        const gapR = ref.right - box.right;
        if (Math.abs(gapL - gapR) > 16) me = gapR < gapL;
      }
      const avImg = Array.from(el.querySelectorAll('img'))
        .map((i) => ({ src: http(i.getAttribute('src')), r: R(i) }))
        .find((i) => i.src && i.r.width > 0 && i.r.width < 60 && (!box || i.r.right <= box.left + 4));
      if (me === undefined && (el.querySelector('[data-e2e="chat-avatar"]') || avImg)) me = false;
      if (me === undefined) {
        for (let cur: Element | null = bubble ?? el; cur && cur !== el.parentElement; cur = cur.parentElement) {
          const s = getComputedStyle(cur);
          const col = s.flexDirection.startsWith('column');
          if (s.display.includes('flex') && ((col && /end|right/.test(s.alignItems)) || (!col && /end|right/.test(s.justifyContent)) || s.flexDirection === 'row-reverse')) {
            me = true;
            break;
          }
          if (s.marginLeft === 'auto' || s.alignSelf.includes('end') || s.textAlign === 'right') {
            me = true;
            break;
          }
        }
      }
      me = me ?? false;
      let sender = me ? '' : label?.t ?? '';
      // etiketsiz satır önceki gönderenin devamı; ama avatarı farklıysa ya da başka blok sarmalayıcısındaysa (gönderen değişti) değil
      const av = me ? '' : avImg?.src ?? '';
      const wrap = el.parentElement;
      if (!me && !sender && ((av && lastAv && av !== lastAv) || (lastWrap && wrap !== lastWrap && wrap !== area))) lastSender = '';
      if (me) lastSender = '';
      else if (sender) lastSender = sender;
      else sender = lastSender;
      if (!me) {
        if (av) lastAv = av;
        lastWrap = wrap;
      } else {
        lastAv = '';
        lastWrap = null;
      }
      out.push({ text: text.slice(0, 4000), me, avatar: me ? undefined : avImg?.src, sender: sender || undefined, attachments });
    }
    return out;
  };

  /** Mesaj alanı tanısı: yalnız yapı ve sayılar (içerik YOK) */
  const diag = () => {
    const t = tag();
    const comp = composer();
    const pane = paneOf(comp);
    const area = st.area && st.area.isConnected ? st.area : null;
    const depth = (e: Element | null) => {
      let d = 0;
      for (let p = e; p && p !== document.body; p = p.parentElement) d++;
      return d;
    };
    const rowsM = msgRowsNow();
    const rowDepth = rowsM.map((r) => depth(r) - depth(area));
    const kids = area ? Array.from(area.children) : [];
    const e2e = Array.from(new Set(Array.from((pane ?? document).querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e') ?? ''))).slice(0, 30);
    const tb = area ? blocks(area).filter((b) => norm(b.textContent)) : [];
    return {
      tag: t,
      pane: !!pane,
      paneW: pane ? Math.round(R(pane).width) : 0,
      composer: !!comp,
      area: !!area,
      areaIsPane: !!area && area === pane,
      areaW: area ? Math.round(R(area).width) : 0,
      areaH: area ? Math.round(R(area).height) : 0,
      areaDepth: depth(area),
      areaKids: kids.length,
      areaKidKids: kids.slice(0, 12).map((k) => k.childElementCount),
      scroll: area ? scrollable(area) : false,
      rows: rowsM.length,
      rowDepth: rowDepth.length ? [Math.min(...rowDepth), Math.max(...rowDepth)] : [],
      bubbles: document.querySelectorAll('[data-mv-b]').length,
      textBlocks: tb.length,
      textDepth: tb.length ? [Math.min(...tb.map((b) => depth(b) - depth(area))), Math.max(...tb.map((b) => depth(b) - depth(area)))] : [],
      imgs: area ? area.querySelectorAll('img').length : 0,
      e2e,
      listMode: st.listMode,
    };
  };

  (window as unknown as { __mvTT: unknown }).__mvTT = { v: cfg.v, tag, rows, header, sig, point, poke, scroll, items, diag };
}

type LibFn = 'tag' | 'rows' | 'header' | 'sig' | 'point' | 'poke' | 'scroll' | 'items' | 'diag';
/** Okuyucuyu çağır (yoksa ya da sürümü eskiyse önce kur) */
async function lib<T>(f: Frame, fn: LibFn, arg?: unknown): Promise<T> {
  const run = () =>
    f.evaluate(
      ({ fn, arg, v }) => {
        const L = (window as unknown as { __mvTT?: Record<string, (a: unknown) => unknown> & { v: number } }).__mvTT;
        if (!L || L.v !== v) return { missing: true as const };
        return { r: L[fn](arg) };
      },
      { fn, arg, v: LIB_V },
    );
  let res = await run();
  if ('missing' in res) {
    await f.evaluate(installLib, { sel: SEL, v: LIB_V });
    res = await run();
  }
  if ('missing' in res) throw new Error('TikTok sayfa okuyucusu kurulamadı');
  return res.r as T;
}

async function tag(f: Frame, fresh = false): Promise<TagRes | undefined> {
  return lib<TagRes>(f, 'tag', { fresh }).catch(() => undefined);
}

/** Captcha / "çok fazla deneme" sayfası: köprünün sınıflandırıcısı bu metinlerle yoklamayı durdurur ya da bekletir */
async function assertUsable(page: Page, f?: Frame): Promise<void> {
  if (await page.locator(CAPTCHA).count().catch(() => 0)) throw new Error('TikTok doğrulama istiyor (captcha): Yeniden bağlan ile pencerede tamamla');
  if (f && f !== page.mainFrame() && (await f.locator(CAPTCHA).count().catch(() => 0))) throw new Error('TikTok doğrulama istiyor (captcha): Yeniden bağlan ile pencerede tamamla');
  const tooMany = await page
    .evaluate(() => /too many attempts|çok fazla (deneme|istek)|maximum number of attempts/i.test(document.body?.innerText?.slice(0, 4000) ?? ''))
    .catch(() => false);
  if (tooMany) throw new Error('TikTok: 429 rate limit (çok fazla istek)');
}

/**
 * Mesaj sayfası adresleri. TikTok web /messages'ı Business Suite'e yönlendirebiliyor — KİŞİSEL hesapta da (29.09, Kaan'ın tanısı:
 * path /business-suite/messages, sayfada sohbet öğesi yok). Business Suite'te mesaj uygulaması gömülü çerçevede (/messages?…scene=business):
 * okuma/tıklama doğrudan o çerçevede yapılır (çerçeve adresini üst sayfada açmak yeniden yönlendirmeye düşebiliyor).
 */
const INBOX_RE = /tiktok\.com\/(messages|business-suite\/messages|business-suite\/.*(message|chat|inbox))/i;
const FRAME_RE = /(message|chat|\/im\b|\/im\/|inbox|conversation)/i;
let bizLogged = false;

/** Business Suite: mesajların gömülü çerçevesi (yalnız tiktok alan adları) */
function inboxFrame(page: Page): Frame | undefined {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const url = new URL(f.url());
      if (/(^|\.)tiktok(v)?\.com$|(^|\.)tiktokcdn\.com$|(^|\.)tiktok-row\.net$/.test(url.hostname) && FRAME_RE.test(url.pathname)) return f;
    } catch {
      /* about:blank vb. */
    }
  }
  return undefined;
}

/** Okunacak belge: normal sayfada ana çerçeve, Business Suite'te mesaj çerçevesi */
function inboxRoot(page: Page): Frame {
  if (!/business-suite/.test(page.url())) return page.mainFrame();
  const f = inboxFrame(page);
  if (f && !bizLogged) {
    bizLogged = true;
    try {
      const u = new URL(f.url());
      bus.log('info', `TikTok: mesajlar Business Suite çerçevesinde okunuyor (${u.hostname}${u.pathname})`);
    } catch {
      /* yok */
    }
  }
  return f ?? page.mainFrame();
}

/** Mesajlar sayfasını aç ve sohbet listesi (ya da boş gelen kutusu) görünene dek bekle; okunacak belgeyi döndürür */
async function ensureInbox(page: Page, timeout = 20_000): Promise<Frame | undefined> {
  if (!INBOX_RE.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const t0 = Date.now();
  let prevGeo = -1;
  while (Date.now() - t0 < timeout) {
    const f = inboxRoot(page);
    const t = await tag(f);
    const biz = /business-suite/.test(page.url()) && f === page.mainFrame();
    // görünüşten bulunan liste iki okumada aynı kalınca kabul (sayfa yüklenirken yarım düzen seçilmesin); Business Suite'te çerçeve beklenir
    if (t && t.list > 0 && (t.mode === 'e2e' || t.list === prevGeo) && !(biz && Date.now() - t0 < 8000)) return f;
    prevGeo = t?.mode === 'geo' ? t.list : -1;
    await assertUsable(page, f);
    // boş gelen kutusu: "mesaj yok" görünümü
    if (Date.now() - t0 > 6000 && (await f.locator('[data-e2e*="empty"], [class*="Empty"], [class*="NoMessage"]').count().catch(() => 0))) return f;
    if (/\/login/.test(page.url())) return undefined;
    await page.waitForTimeout(350);
  }
  return undefined;
}

let diagDone = false;
let msgDiagDone = false;
let listWarned = false;
/** Bir kez: seçici sayıları, sohbetle ilgili data-e2e adları, sınıf sözcükleri, çerçeveler, görünüşten tanıma sonucu (içerik YOK) */
async function diagnose(page: Page, root?: Frame): Promise<void> {
  if (diagDone) return;
  diagDone = true;
  const f = root ?? inboxRoot(page);
  const d = await f
    .evaluate(
      ({ list, item, input }) => {
        const n = (s: string) => document.querySelectorAll(s).length;
        const e2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e') ?? '')))
          .filter((k) => /chat|message|inbox|dm|conversation|msg/i.test(k))
          .slice(0, 40);
        // bileşen adları (css-<hash>-DivChatBox → DivChatBox): sohbetle ilgili sınıf parçaları ve sayıları — metin/içerik YOK
        const parts = new Map<string, number>();
        for (const e of Array.from(document.querySelectorAll('[class]')).slice(0, 6000)) {
          for (const c of (e.getAttribute('class') ?? '').split(/\s+/)) {
            const m = c.match(/-([A-Z][A-Za-z0-9]+)$/);
            const k = m ? m[1] : '';
            if (k && /chat|message|conversation|inbox|msg|item|list|nick|extract|time|unread|drawer|editor/i.test(k)) parts.set(k, (parts.get(k) ?? 0) + 1);
          }
        }
        const cls = [...parts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`);
        const allE2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e') ?? ''))).slice(0, 60);
        const login = !!document.querySelector('[data-e2e="top-login-button"], [data-e2e*="login"]');
        // hash'siz sınıf sözcükleri (sohbetle ilgili), rol sayıları, çerçeve ve gölge DOM sayısı — içerik YOK
        const words = new Map<string, number>();
        for (const e of Array.from(document.querySelectorAll('[class]')).slice(0, 8000)) {
          for (const c of (e.getAttribute('class') ?? '').split(/\s+/)) {
            for (const w of c.split(/[-_]+/)) {
              if (w.length > 2 && w.length < 40 && !/\d{2}/.test(w) && /chat|messag|conver|session|inbox|list|item|contact|unread|nick|avatar|input|editor|send/i.test(w)) words.set(w, (words.get(w) ?? 0) + 1);
            }
          }
        }
        const clsWords = [...words].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`);
        const roles: Record<string, number> = {};
        for (const r of ['list', 'listitem', 'listbox', 'option', 'textbox', 'grid', 'row', 'tab']) roles[r] = n(`[role="${r}"]`);
        const shadow = Array.from(document.querySelectorAll('*')).slice(0, 8000).filter((e) => (e as HTMLElement).shadowRoot).length;
        return {
          path: location.pathname,
          title: document.title.slice(0, 60),
          lang: document.documentElement.lang,
          vw: innerWidth,
          vh: innerHeight,
          bodyLen: document.body?.innerText.length ?? 0,
          login,
          list: n(list),
          items: n(item),
          input: n(input),
          e2e,
          allE2e,
          cls,
          clsWords,
          roles,
          iframes: n('iframe'),
          shadow,
          editable: n('[contenteditable="true"], textarea'),
        };
      },
      { list: LIST_ITEM, item: SEL.msgItem, input: INPUT },
    )
    .catch(() => undefined);
  // çerçeveler: adres (alan adı + yol; sorgu dizesi YOK) ve her çerçevedeki sohbet öğesi sayıları
  const frames: Array<Record<string, unknown>> = [];
  for (const fr of page.frames().slice(0, 12)) {
    if (fr === page.mainFrame()) continue;
    let where = fr.url().slice(0, 40);
    try {
      const u = new URL(fr.url());
      where = `${u.hostname}${u.pathname}`.slice(0, 100);
    } catch {
      /* about:blank */
    }
    const c = await fr
      .evaluate(
        ({ list, item }) => ({ list: document.querySelectorAll(list).length, items: document.querySelectorAll(item).length, e2e: document.querySelectorAll('[data-e2e]').length, bodyLen: document.body?.innerText.length ?? 0 }),
        { list: LIST_ITEM, item: SEL.msgItem },
      )
      .catch(() => undefined);
    frames.push({ where, ...(c ?? { err: true }) });
  }
  const auto = await tag(f, true);
  if (d) bus.log('info', `TikTok tanı: ${JSON.stringify({ ...d, root: f === page.mainFrame() ? 'main' : 'frame', auto, frames })}`);
}

/** Son okunan sayfa dili (mesaj ayırıcılarında ay/gün sırası) */
let pageLang = '';
/** Listede birden çok kez görülen (normalize) adlar: bu sohbetler yalnız konum/kimlikle açılır, adla "zaten açık" sayılmaz */
const dupNames = new Set<string>();
const nameKey = (s: string) => s.trim().toLocaleLowerCase('tr') || '?';
function noteDupes(rows: ListRow[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = nameKey(r.name);
    if (seen.has(k)) dupNames.add(k);
    seen.add(k);
  }
}

/** Liste satırları (+ sayfa dili: "3/5/2026" ay/gün mü gün/ay mı; top: liste başında mı) */
async function readList(f: Frame, fresh = false): Promise<{ lang: string; top: boolean; rows: ListRow[] }> {
  await tag(f, fresh);
  const r = await lib<{ lang: string; top: boolean; rows: ListRow[] }>(f, 'rows');
  if (r.lang) pageLang = r.lang;
  if (r.top) noteDupes(r.rows);
  return r;
}

/** Ekranlar arası birikmiş liste (liste içeriğindeki konuma göre; aynı satır iki ekranda görülse de bir kez) */
function mergeRows(acc: ListRow[], win: ListRow[]): number {
  let added = 0;
  for (const r of win) {
    const i = r.pos === undefined ? -1 : acc.findIndex((a) => a.pos !== undefined && Math.abs(a.pos - (r.pos as number)) < 20);
    if (i >= 0) acc[i] = r;
    else {
      acc.push(r);
      added++;
    }
  }
  acc.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  return added;
}

/**
 * Listeyi baştan ekran ekran oku, satırları konumlarıyla biriktir (kimlikler BÜTÜN listedeki sırayla: aynı adlı ikinci sohbet ancak
 * ilki görüldüyse #2 olur — eskiden her ekran kendi içinde sayılıyordu). `stop` true dönünce durur (liste o konumda kalır).
 */
async function scanList(page: Page, f: Frame, stop: (acc: ListRow[], win: ListRow[]) => boolean, maxSteps = 10): Promise<{ acc: ListRow[]; win: ListRow[]; lang: string }> {
  await lib(f, 'scroll', { what: 'list', to: 'top' }).catch(() => undefined);
  await page.waitForTimeout(300);
  const acc: ListRow[] = [];
  let lang = '';
  let win: ListRow[] = [];
  for (let step = 0; step <= maxSteps; step++) {
    const r = await readList(f);
    lang ||= r.lang;
    win = r.rows;
    mergeRows(acc, win);
    noteDupes(acc);
    if (stop(acc, win)) return { acc, win, lang };
    if (step === maxSteps) break;
    const s = await lib<{ moved: boolean }>(f, 'scroll', { what: 'list', to: 'step' }).catch(() => ({ moved: false }));
    if (!s.moved) break;
    await page.waitForTimeout(500);
  }
  return { acc, win, lang };
}

/** Liste satırlarının kimlikleri: görünen ad; aynı adlı ikinci/üçüncü sohbete #2/#3 */
export function rowIds(rows: Array<{ name: string }>): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = r.name.trim().toLocaleLowerCase('tr') || '?';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return hashId(`tiktok|${base}${n > 1 ? `#${n}` : ''}`);
  });
}

const WEEKDAY: Record<string, number> = { paz: 0, pzt: 1, sal: 2, çar: 3, per: 4, cum: 5, cmt: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH: Record<string, number> = {
  oca: 0, şub: 1, sub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
/** Geçerli takvim günü mü (31 Şubat gibi taşmaları reddeder) */
function dayAt(y: number, m: number, d: number, h = 12): number {
  if (m < 0 || m > 11 || d < 1 || d > 31) return 0;
  const t = new Date(y, m, d, h);
  return t.getMonth() === m && t.getDate() === d ? t.getTime() : 0;
}

/**
 * Sohbet listesindeki kısa zaman: "14:32", "Dün", "Sal", "3 g", "2h", "12.10", "3/27/2025", "12 Eyl", "Sep 12", "2026-9-12";
 * okunamazsa 0 (depodaki kalır). Sayısal tarihte gün/ay sırası: 12'den büyük olan gün; ikisi de ≤12 ise "." ve "-" gün.ay,
 * "/" sayfa dili İngilizceyse (ya da bilinmiyorsa) ay/gün (TikTok İngilizce arayüzü M/D/YYYY). Gelecek zaman şimdiye çekilir.
 */
export function listTime(input: string, now = new Date(), mdy?: boolean): number {
  const t = dayParse(input, now, mdy);
  return t > now.getTime() ? now.getTime() : t;
}

const WEEKDAY_FULL: Record<string, number> = {
  pazar: 0, pazartesi: 1, salı: 2, çarşamba: 3, perşembe: 4, cuma: 5, cumartesi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** listTime'ın çekirdeği: gelecek zamanı ŞİMDİYE ÇEKMEZ (ayırıcıda gelecek = yanlış okuma, reddedilir) */
function dayParse(input: string, now: Date, mdy?: boolean): number {
  const s = input.trim().replace(/\s+/g, ' ').replace(/[.,]$/, '');
  if (!s) return 0;
  const nowMs = now.getTime();
  const low = s.toLocaleLowerCase('tr');
  if (/^(şimdi|az önce|just now|now)$/.test(low)) return nowMs;
  const ymd = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymd) return dayAt(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const dm = s.match(/^(\d{1,2})([./-])(\d{1,2})(?:\2(\d{2,4}))?$/);
  if (dm) {
    const a = Number(dm[1]);
    const b = Number(dm[3]);
    let day = a;
    let mon = b;
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    if (b > 12 && a <= 12) [day, mon] = [b, a];
    else if (ambiguous && dm[2] === '/' && mdy !== false) [day, mon] = [b, a];
    let y = dm[4] ? Number(dm[4]) : now.getFullYear();
    if (y < 100) y += 2000;
    let t = dayAt(y, mon - 1, day);
    // "/" ile iki okuma da geçerliyse ve seçilen gelecekte kalıyorsa öteki (sayfa dili bilinmiyor/yanlış olabilir)
    if (t > nowMs && ambiguous && dm[2] === '/') {
      const alt = dayAt(y, day - 1, mon);
      if (alt && alt <= nowMs) t = alt;
    }
    if (t && !dm[4] && t > nowMs) t = dayAt(y - 1, mon - 1, day);
    return t;
  }
  // ay adlı tarih (saatsiz): "12 Eyl", "12 Eylül 2025", "Sep 12", "Sep 12, 2025"
  const dMon = low.match(/^(\d{1,2})\.?\s+([a-zçğıöşü]{3,})\.?,?(?:\s+(\d{4}))?$/);
  const monD = low.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  const md = dMon ? { d: Number(dMon[1]), m: MONTH[dMon[2].slice(0, 3)], y: dMon[3] } : monD ? { d: Number(monD[2]), m: MONTH[monD[1].slice(0, 3)] ?? (monD[1].startsWith('mar') ? 2 : monD[1].startsWith('may') ? 4 : undefined), y: monD[3] } : undefined;
  if (md && md.m !== undefined) {
    const y = md.y ? Number(md.y) : now.getFullYear();
    let t = dayAt(y, md.m, md.d);
    if (t && !md.y && t > nowMs) t = dayAt(y - 1, md.m, md.d);
    return t;
  }
  const noon = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12, 0).getTime();
  if (/^(bugün|today)$/.test(low)) return Math.min(noon(0), nowMs);
  if (/^(dün|yesterday)$/.test(low)) return noon(1);
  const wd = WEEKDAY_FULL[low] ?? WEEKDAY[low.replace(/\.$/, '').slice(0, 3)];
  if (wd !== undefined && low.length <= 10 && !/\d/.test(low) && (WEEKDAY_FULL[low] !== undefined || low.length <= 4)) return noon((now.getDay() - wd + 7) % 7 || 7);
  const rel = low
    .replace(/\b(seconds?|secs?)\b/, 's')
    .replace(/\b(minutes?)\b/, 'min')
    .replace(/\b(hours?)\b/, 'h')
    .replace(/\b(days?)\b/, 'd')
    .replace(/\b(weeks?)\b/, 'w')
    .replace(/\b(months?)\b/, 'mo')
    .replace(/\b(years?)\b/, 'yr')
    .match(/^(\d+)\s*(sn|s|dk|dakika|m|min|mins|sa|saat|h|hr|hrs|g|gün|d|hf|hafta|w|wk|ay|mo|y|yıl|yr)\.?(?:\s+(?:önce|ago))?$/);
  if (rel) {
    const unit = rel[2];
    const n = Number(rel[1]);
    const ms = /^(sn|s)$/.test(unit)
      ? 1000
      : /^(dk|dakika|m|min|mins)$/.test(unit)
        ? 60_000
        : /^(sa|saat|h|hr|hrs)$/.test(unit)
          ? 3_600_000
          : /^(g|gün|d)$/.test(unit)
            ? 86_400_000
            : /^(hf|hafta|w|wk)$/.test(unit)
              ? 7 * 86_400_000
              : /^(ay|mo)$/.test(unit)
                ? 30 * 86_400_000
                : 365 * 86_400_000;
    return nowMs - n * ms;
  }
  const full = parseDate(s, now);
  return full !== undefined && Number.isFinite(full) && full <= nowMs + 60_000 ? full : 0;
}

/**
 * Mesaj alanındaki zaman ayırıcısı → mutlak zaman (0 = okunamadı). Sondaki saat ("14:32", "3:05 PM") ayrılır, tarih kısmı
 * listTime kurallarıyla (gün/ay taşması reddedilir, sayfa dili ay/gün sırasını belirler, ay adları, gün adları, Bugün/Dün) çözülüp
 * saat eklenir. Gelecekte kalan sonuç (yanlış gün/ay okuması) reddedilir.
 */
export function sepTime(sep: string, now = new Date(), mdy?: boolean): number {
  const s = sep.trim().replace(/\s+/g, ' ');
  if (!s) return 0;
  const nowMs = now.getTime();
  const m = s.match(/^(.*?)[,\s]*(?:\b(?:at|saat)\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm|öö|ös)?$/i);
  if (m && !/^\d{1,2}[./-]?$/.test(m[1])) {
    let h = Number(m[2]);
    const mi = Number(m[3]);
    const ap = (m[4] ?? '').toLocaleLowerCase('tr');
    if (h > 23 || mi > 59 || (ap && (h < 1 || h > 12))) return 0;
    if ((ap === 'pm' || ap === 'ös') && h < 12) h += 12;
    if ((ap === 'am' || ap === 'öö') && h === 12) h = 0;
    const datePart = m[1].trim().replace(/[,\s]+$/, '');
    if (!datePart) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi).getTime();
      return t > nowMs + 60_000 ? t - 86_400_000 : t;
    }
    const d = dayParse(datePart, now, mdy);
    if (d) {
      const dd = new Date(d);
      const t = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate(), h, mi).getTime();
      if (t <= nowMs + 60_000) return t;
      // bugünün ileri saati / gelecekteki tarih: yanlış okuma
      return 0;
    }
    // sayısal tarih kısmı dayParse'ta tam denetlendi (31.02 gibi taşmalar); gevşek yedeğe düşmesin
    if (!/\p{L}/u.test(datePart)) return 0;
  }
  const t = dayParse(s, now, mdy);
  return t && t <= nowMs + 60_000 ? t : 0;
}

const normPreview = (s: string) => s.replace(/\s+/g, ' ').trim();
const CLOCK_RE = /^\d{1,2}[:.]\d{2}(\s*(am|pm|öö|ös))?$/i;

/**
 * Liste satırları → sohbetler. Zaman: önizleme değiştiyse "şimdi" (liste zamanı eski değilse), değişmediyse önceki kararlı değer,
 * ilk görüşte listedeki kısa zaman. Sonra SAYFA SIRASI uygulanır (TikTok listesi en yeniden eskiye): okunamayan zaman alttaki ilk
 * okunan zamanın hemen üstüne yerleşir; zamanı üsttekiyle çakışan / göreli yuvarlama yüzünden üsttekinden biraz yeni görünen satır
 * üsttekinin 1 ms altına çekilir (üstteki sabitlenmiş eski bir sohbetse ve fark büyükse dokunulmaz). Sonuç kararlı değer olarak
 * saklanır → değişmeyen sohbet sonraki turlarda aynı zamanla gelir (köprü onu yeniden açmaz).
 */
export function toThreads(rows: ListRow[], now = Date.now(), opts: { floor?: number; mdy?: boolean; ids?: string[] } = {}): Thread[] {
  const ids = opts.ids ?? rowIds(rows);
  const nowD = new Date(now);
  const recent = 36 * 3_600_000;
  const lt = rows.map((r) => listTime(r.time, nowD, opts.mdy));
  const prevSeen = rows.map(() => false);
  const out = rows.map((r, i) => {
    const id = ids[i];
    const pv = normPreview(r.preview);
    const prev = lastPreview.get(id);
    const prevTime = lastTime.get(id);
    prevSeen[i] = prev !== undefined;
    lastPreview.set(id, pv);
    lastTime.set(id, r.time.trim());
    const stable = stableTs.get(id) || 0;
    if (prev !== undefined && prev !== pv && (!lt[i] || lt[i] >= now - recent)) return Math.max(now, stable + 1);
    // aynı önizlemeyle yeni mesaj ("Bir video paylaştı" iki kez): satırın kesin saati ilerlediyse o saat
    if (prevTime !== undefined && prevTime !== r.time.trim() && CLOCK_RE.test(r.time.trim()) && lt[i] > stable + 60_000) return lt[i];
    return stable || lt[i];
  });
  const fresh = out.slice();
  // bu turda GERÇEK değişiklik görülen satırlar (önizleme değişti / kesin saat ilerledi): sıra düzeltmesi onları önceki
  // kararlı değerlerine (ya da altına) çekemez — yoksa köprü "değişmedi" sanıp yeni mesajı hiç almaz (üstte sabitlenmiş sohbet)
  const changed = rows.map((_r, i) => prevSeen[i] && fresh[i] > (stableTs.get(ids[i]) || 0));
  const filled = out.map(() => false);
  let below = 0;
  let k = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] > 0) {
      below = out[i];
      k = 0;
    } else if (below > 0) {
      out[i] = below + ++k;
      filled[i] = true;
    }
  }
  let above = opts.floor && opts.floor > 0 ? opts.floor : now + 1;
  let aboveTime = '';
  for (let i = 0; i < out.length; i++) {
    if (!out[i] && i > 0 && out[i - 1] > 0) {
      out[i] = out[i - 1] - 1;
      filled[i] = true;
    }
    if (out[i] > 0 && out[i] >= above && (i === 0 || filled[i] || rows[i].time === aboveTime || out[i] - above < recent)) {
      const prevStable = prevSeen[i] ? stableTs.get(ids[i]) || 0 : 0;
      // değişen satır önceki değerinin altına çekilmez (yoksa köprü yeni mesajı almaz); daha önce saklanmış değişmeyen satır da
      // geri gitmez (önceki turda değişiklikle yükselmiş olabilir — ertesi turda eski değerine inip zıplamasın)
      if (!prevStable) out[i] = above - 1;
      else if (changed[i]) out[i] = above - 1 > prevStable ? above - 1 : out[i];
      else out[i] = Math.max(above - 1, Math.min(out[i], prevStable));
    }
    if (out[i] > 0) above = out[i];
    aboveTime = rows[i].time;
  }
  if (out.length && !opts.floor) listFloor = out[out.length - 1] || listFloor;
  return rows.map((r, i) => {
    const id = ids[i];
    stableTs.set(id, out[i]);
    const handle = handles.get(id);
    return {
      id,
      name: r.name || 'TikTok kullanıcısı',
      kind: r.group ? ('group' as const) : ('direct' as const),
      lastTs: out[i],
      preview: r.preview,
      unread: r.unread,
      avatarUrl: r.avatarUrl,
      handle: handle ? `@${handle}` : undefined,
      link: handle ? `https://www.tiktok.com/@${handle}` : undefined,
    };
  });
}

/** Sayfa dili İngilizceyse (ABD) "3/5" ay/gün; Türkçe vb. gün.ay; bilinmiyorsa undefined (listTime'ın varsayılanı) */
const mdyOf = (lang: string): boolean | undefined => (!lang ? undefined : /^en(-us)?$/i.test(lang) ? true : /^en/i.test(lang) ? undefined : false);

/** Açık sohbetin başlığı (ad + @kullanıcı adı) */
function readHeader(f: Frame): Promise<{ name: string; handle: string }> {
  return lib<{ name: string; handle: string }>(f, 'header').catch(() => ({ name: '', handle: '' }));
}

/** Mesaj satırları görünene (ya da boş sohbette yazı alanı) dek bekle; sayı iki okuma boyunca sabitlenince döner */
async function waitForMessages(page: Page, f: Frame, timeout: number): Promise<number> {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeout) {
    const t = await tag(f);
    const n = t?.msg ?? 0;
    if (n > 0 && n === last) return n;
    if (n === 0 && Date.now() - t0 > 4000 && t?.input) return 0;
    last = n;
    await page.waitForTimeout(250);
  }
  return Math.max(last, 0);
}

/** Çerçevenin ana görünümdeki konumu (Business Suite çerçevesinde fare koordinatları için) */
async function frameOffset(f: Frame): Promise<{ x: number; y: number }> {
  let x = 0;
  let y = 0;
  for (let cur: Frame | null = f; cur && cur.parentFrame(); cur = cur.parentFrame()) {
    const el = await cur.frameElement();
    const o = await el.evaluate((n) => {
      const e = n as Element;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return { x: r.left + e.clientLeft + (parseFloat(s.paddingLeft) || 0), y: r.top + e.clientTop + (parseFloat(s.paddingTop) || 0) };
    });
    x += o.x;
    y += o.y;
  }
  return { x, y };
}

/** Başlıktaki ad ile satırdaki ad aynı mı (boşluk/emoji/büyük-küçük harf farkı yok sayılır; "Ali" ≠ "Ali Veli") */
const same = (a: string, b: string) => {
  const n = (s: string) => s.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');
  const x = n(a);
  const y = n(b);
  return !!x && x === y;
};

/**
 * Sohbeti listede bul: liste başındaysa görünen satırlardan; değilse (ya da yoksa) baştan ekran ekran inilerek (sanal listede
 * yukarıda kalan satırlar DOM'dan çıkıyor; kimlikler bütün listedeki sırayla hesaplanır). Satır o an ekrandaki pencerede olur.
 */
async function findRow(page: Page, f: Frame, id: string): Promise<{ row: ListRow; idx: number; dup: boolean } | undefined> {
  const pick = (acc: ListRow[], win: ListRow[]) => {
    const i = rowIds(acc).indexOf(id);
    if (i < 0) return undefined;
    const row = acc[i];
    const idx = win.findIndex((w) => w === row || (w.pos !== undefined && row.pos !== undefined ? Math.abs(w.pos - row.pos) < 20 : w.name === row.name));
    if (idx < 0) return undefined;
    return { row: win[idx], idx, dup: dupNames.has(nameKey(row.name)) || acc.filter((a) => nameKey(a.name) === nameKey(row.name)).length > 1 };
  };
  const cur = await readList(f);
  if (cur.top) {
    const p = pick(cur.rows, cur.rows);
    if (p) return p;
  }
  let hit: ReturnType<typeof pick>;
  await scanList(page, f, (acc, win) => !!(hit = pick(acc, win)));
  if (hit) return hit;
  await lib(f, 'scroll', { what: 'list', to: 'top' }).catch(() => undefined);
  return undefined;
}

/** Fareyi satırdan uzaklaştır (üzerine gelme vurgusu seçili satır sanılmasın) */
async function mouseAway(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(vp.width - 4, Math.round(vp.height / 2)).catch(() => undefined);
}

/**
 * Sohbeti listeden aç ve açıldığını DOĞRULA. Zaten açıksa dokunulmaz. "Açık" kanıtı sırasıyla: seçili satırın TikTok kimliği;
 * aria-selected satırın liste konumu; aynı adlı başka sohbet varsa YALNIZ seçili satırın konumu (ad eşitliği iki sohbeti ayırmaz);
 * yoksa seçili satır (görünüşten) / başlıktaki ad. Tıklama: satır görünür alana kaydırılır, adın ortasına gerçek fare tıklaması
 * (Business Suite çerçevesinde çerçeve konumu eklenir); 3,5 sn'de bölme değişmezse iç öğeye işaretçi/fare olay dizisi + satırın başka
 * noktasına ikinci tıklama. Okumada (strict değil) kanıt yoksa bölme değişip durulması + başlığın/seçimin değişmesi yeterli; gönderimde
 * (strict) olumlu kanıt şart. Açılmazsa hata: eski bölme okunmaz, mesaj başka kişiye yazılmaz.
 */
async function openThread(page: Page, id: string, strict = false): Promise<Frame> {
  const f = await ensureInbox(page);
  if (!f) throw new Error('TikTok mesajlar sayfası açılamadı (oturum kapalı olabilir)');
  const found = await findRow(page, f, id);
  if (!found) throw new Error('Sohbet TikTok listesinde bulunamadı');
  const { row, idx, dup } = found;
  const target: Target = { key: row.key, pos: row.pos, idx, name: row.name, strict: dup };
  const near = (s: SigRes) => s.selPos !== null && row.pos !== undefined && Math.abs(s.selPos - row.pos) < 20;
  const isOpen = (s: SigRes): boolean => {
    if (row.key && s.selKey) return s.selKey === row.key;
    if (s.selSrc === 'aria' && s.selPos !== null && row.pos !== undefined) return near(s);
    if (dup) return near(s) && (!s.selName || same(s.selName, row.name));
    return (near(s) && (!s.selName || same(s.selName, row.name))) || (!!s.selName && same(s.selName, row.name)) || (!!s.name && same(s.name, row.name));
  };
  const before = await lib<SigRes>(f, 'sig');
  if (!(isOpen(before) && before.composer)) {
    const click = async (alt: boolean) => {
      const p = await lib<RowPoint | null>(f, 'point', target);
      if (!p) return false;
      const off = f === page.mainFrame() ? { x: 0, y: 0 } : await frameOffset(f);
      const x = (alt ? p.ax : p.x) + off.x;
      const y = (alt ? p.ay : p.y) + off.y;
      await page.mouse.move(x - 12, y + 3);
      await page.mouse.move(x, y, { steps: 3 });
      await page.mouse.down();
      await page.waitForTimeout(40 + Math.round(Math.random() * 40));
      await page.mouse.up();
      await mouseAway(page);
      return true;
    };
    if (!(await click(false))) throw new Error('Sohbet TikTok listesinde bulunamadı');
    const t0 = Date.now();
    let retried = false;
    let prev = '';
    let ok = false;
    let openAt = 0;
    while (Date.now() - t0 < 9000) {
      await page.waitForTimeout(220);
      const s = await lib<SigRes>(f, 'sig').catch(() => undefined);
      if (!s) continue;
      // açıldı: olumlu kanıt (isOpen) ya da — yalnız okumada, aynı adlı sohbet yokken — bölme değişip durulmuş ve başlık ya da seçili
      // satır ÖNCEKİNDEN farklı (açık sohbete yeni mesaj düşmesi de bölmeyi değiştirir → tıklama tutmadıysa eski sohbet okunmasın)
      const moved = (!!s.name && !same(s.name, before.name)) || (s.selPos !== null && s.selPos !== before.selPos);
      const opened = isOpen(s) || (!strict && !dup && s.sig !== before.sig && s.sig === prev && moved);
      if (opened) {
        openAt ||= Date.now();
        // başlık hemen değişip eski sohbetin mesajları bir an kalabiliyor: mesajlar da değişene dek (en çok 2,5 sn) bekle
        if (s.msig !== before.msig || s.n === 0 || Date.now() - openAt > 2500) {
          ok = true;
          break;
        }
      }
      prev = s.sig;
      if (!retried && Date.now() - t0 > 3500) {
        retried = true;
        await lib(f, 'poke', target).catch(() => undefined);
        await page.waitForTimeout(400);
        const s2 = await lib<SigRes>(f, 'sig').catch(() => undefined);
        if (!s2 || !(isOpen(s2) || s2.sig !== before.sig)) await click(true).catch(() => false);
      }
    }
    if (!ok) throw new Error(dup && !strict ? 'TikTok: aynı adlı sohbet açıldığı doğrulanamadı' : 'TikTok: sohbet açılamadı (tıklama sohbet bölmesini değiştirmedi)');
  }
  await waitForMessages(page, f, 8000);
  const h = await readHeader(f);
  if (h.handle) handles.set(id, h.handle);
  return f;
}

/** Daha eski mesajlar: mesaj alanını en üste kaydır, yeni satır gelmesini bekle (en çok `rounds` tur) */
async function loadOlder(page: Page, f: Frame, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const before = (await tag(f))?.msg ?? 0;
    const s = await lib<{ moved: boolean }>(f, 'scroll', { what: 'msgs', to: 'top' }).catch(() => ({ moved: false }));
    if (!s.moved) return;
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < 2500) {
      await page.waitForTimeout(250);
      after = (await tag(f))?.msg ?? 0;
      if (after > before) break;
    }
    if (after <= before) return;
    await page.waitForTimeout(300);
  }
}

/**
 * Ham satırlar → mesajlar. Zaman ayırıcıdaki (çözülen, mutlak) zaman sonraki mesajların tabanı; kimlik sohbet + ayırıcı zamanı +
 * gönderen + metin (+ aynı blokta aynı metin tekrarında sıra no). Çözülebilen bir ayırıcı varsa ondan önceki (henüz ayırıcısı
 * yüklenmemiş bloğun) mesajları ATLANIR: zamanları bilinmiyor (eskiden "şimdi" alıp sohbeti üste taşıyor, ayırıcı yüklenince
 * başka kimlikle ikinci kez yazılıyordu); yukarı kaydırınca (loadOlder) doğru zaman ve kalıcı kimlikle gelir. Hiç ayırıcı yoksa
 * 'x' tabanlı, zamanı `fallbackTs − kalan sıra` (sohbet satırının zamanı; yoksa şimdi). Grup sohbetinde gönderen balonun üstündeki
 * ad etiketinden (kimliğe girmez: sanal listede etiket görünmeyebilir).
 */
export function toMessages(threadId: string, name: string, items: RawItem[], now = new Date(), fallbackTs?: number, mdy?: boolean): Msg[] {
  const out: Msg[] = [];
  let base: number | undefined;
  let baseKey = 'x';
  let step = 0;
  const dupes = new Map<string, number>();
  const times = items.map((it) => (it.sep !== undefined ? sepTime(it.sep, now, mdy) : 0));
  const hasSep = items.some((it) => it.sep !== undefined);
  const anchor = fallbackTs && fallbackTs > 0 ? Math.min(fallbackTs, now.getTime()) : now.getTime();
  // her mesajdan sonraki ilk çözülen ayırıcının zamanı ve aradaki mesaj sayısı (çözülemeyen ayırıcılı blokların zamanı için)
  const nextBase: Array<{ t: number; left: number } | undefined> = new Array(items.length);
  {
    let nb: number | undefined;
    let left = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].sep !== undefined) {
        if (times[i]) {
          nb = times[i];
          left = 0;
        }
        continue;
      }
      left++;
      nextBase[i] = nb !== undefined ? { t: nb, left } : undefined;
    }
  }
  let sawSep = false;
  let rawBlock = false;
  let prevTs = 0;
  const tsOf = (i: number): number => {
    const nb = nextBase[i];
    let t: number;
    if (base !== undefined && !rawBlock) t = base + step;
    else if (rawBlock && prevTs) t = prevTs + 1;
    else if (nb) t = nb.t - nb.left;
    else t = anchor - (items.length - i);
    prevTs = t;
    return t;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.sep !== undefined) {
      sawSep = true;
      const t = times[i];
      if (t) {
        base = t;
        baseKey = String(t);
        rawBlock = false;
      } else {
        // okunamayan ayırıcı: yeni blok (kimliği ayırıcının yazısından); mesajlar atılmaz
        baseKey = `r:${it.sep.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr')}`;
        rawBlock = true;
      }
      step = 0;
      continue;
    }
    // ayırıcısı henüz yüklenmemiş en üst blok: zamanı bilinmiyor → atlanır (yukarı kaydırınca doğru kimlikle gelir)
    if (hasSep && !sawSep) continue;
    const fromMe = !!it.me;
    const text = (it.text ?? '').trim();
    const key = `${threadId}|${baseKey}|${fromMe ? 'me' : 'o'}|${text}|${(it.attachments ?? []).map((a) => a.link ?? a.url ?? a.name).join(',')}`;
    const n = dupes.get(key) ?? 0;
    dupes.set(key, n + 1);
    step++;
    // birebir sohbette karşı tarafın adı etiket olarak görünse de gönderen kimliği sohbetin kendisi kalır
    const sender = !fromMe && it.sender && !same(it.sender, name) ? it.sender.slice(0, 80) : '';
    out.push({
      id: hashId(n ? `${key}#${n}` : key),
      text,
      // bloğun zamanı + sıra (ms): sıralama korunur; okunamayan ayırıcılı blok önceki bloğun devamı ya da sonraki çözülen
      // ayırıcının hemen öncesi; hiç ayırıcı çözülemezse sohbet zamanı − kalan sıra
      ts: tsOf(i),
      fromMe,
      senderId: fromMe ? 'me' : sender ? hashId(`tiktok|${threadId}|${sender.toLocaleLowerCase('tr')}`) : threadId,
      senderName: fromMe ? 'Ben' : sender || name || 'Karşı taraf',
      senderAvatarUrl: fromMe ? undefined : it.avatar,
      attachments: it.attachments?.length ? it.attachments : undefined,
      status: fromMe ? 'sent' : 'delivered',
    });
  }
  return out;
}

/** Görünmez oturumda sayfa kendini arka planda/odaksız tanıtıyor (köprü); TikTok odaksız yazmada sohbet bölmesini kapatabiliyor →
 *  yazarken geçici olarak görünür + odaklı */
async function setFocus(frames: Frame[], on: boolean): Promise<void> {
  for (const f of frames) {
    await f
      .evaluate((on) => {
        try {
          const w = window as unknown as { __mvSpoof?: boolean };
          if (on) {
            if (document.visibilityState !== 'hidden') return;
            w.__mvSpoof = true;
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            document.hasFocus = () => true;
          } else if (w.__mvSpoof) {
            w.__mvSpoof = false;
            Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
            document.hasFocus = () => false;
          }
        } catch {
          /* yok */
        }
      }, on)
      .catch(() => undefined);
  }
}

export const tiktok: Strategy = {
  home: HOME,
  loginUrl: 'https://www.tiktok.com/login',
  loginHint: 'Açılan pencerede TikTok hesabınla giriş yap; mesajlar sayfası açılınca pencere kendiliğinden kapanır.',
  // TikTok'un masaüstü düzeni geniş görünümde: ~1280 px'te satıra tıklamak sohbeti açmayabiliyor (dış kaynak, 2026-08)
  viewport: { width: 1440, height: 900 },
  // keepVisible YOK: sayfa kendini gizli/odaksız tanıtır (köprü varsayılanı) → TikTok kullanıcıyı "aktif" sayıp telefona bildirimi kesmez
  watchSelector: LIST_ITEM,
  // sayfanın kendi IM soketi (ikili çerçeveler): büyük çerçeve = yeni mesaj olayı, küçükler kalp atışı
  watchSockets: [{ url: /\bim-ws[\w-]*\.tiktok|tiktok\.com\/ws\//i, minBytes: 160 }],

  async loggedIn(_page, cookies) {
    return !!(cookies.sessionid || cookies.sessionid_ss || cookies.sid_tt);
  },

  async me(page, cookies) {
    if (!/tiktok\.com/.test(page.url())) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    const u = await page
      .evaluate(() => {
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          const j = el ? (JSON.parse(el.textContent || '{}') as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
          const user = j.__DEFAULT_SCOPE__?.['webapp.app-context']?.user;
          if (user && (user.uid || user.uniqueId)) return { uid: String(user.uid ?? ''), uniqueId: String(user.uniqueId ?? ''), nick: String(user.nickName ?? '') };
        } catch {
          /* biçim değişti */
        }
        return undefined;
      })
      .catch(() => undefined);
    if (u?.uniqueId) myHandle = u.uniqueId;
    const id = u?.uid || u?.uniqueId || hashId(`tt|${cookies.uid_tt ?? cookies.sid_tt ?? 'me'}`);
    const label = u?.uniqueId ? `@${u.uniqueId}` : u?.nick || 'TikTok';
    return { id, label };
  },

  async threads(page) {
    const f = await ensureInbox(page);
    await assertUsable(page, f);
    if (/\/login/.test(page.url())) throw new Error('TikTok oturumu kapalı (authwall): Yeniden bağlan');
    // tanı liste bulunamasa da yazılır: seçiciler tutmadığında asıl gereken durum bu
    await diagnose(page, f);
    if (!f) {
      if (!listWarned) bus.log('warn', 'TikTok: sohbet listesi okunamadı (sayfa düzeni değişmiş olabilir; "TikTok tanı" günlüğüne bak)');
      listWarned = true;
      return [];
    }
    // liste başı: önceki arama/sayfalama listeyi aşağıda bırakmış olabilir (sanal listede üstteki yeni sohbetler DOM'dan çıkar)
    const s = await lib<{ moved: boolean }>(f, 'scroll', { what: 'list', to: 'top' }).catch(() => ({ moved: false }));
    if (s.moved) await page.waitForTimeout(400);
    const { lang, rows } = await readList(f, true);
    return toThreads(rows, Date.now(), { mdy: mdyOf(lang) });
  },

  async messages(page, _cookies, threadId, limit, before) {
    const f = await openThread(page, threadId);
    if (before) await loadOlder(page, f, 3);
    const head = await readHeader(f);
    const items = await lib<RawItem[]>(f, 'items', { mine: myHandle, peer: head.handle || handles.get(threadId) || '' });
    if (!items.some((i) => i.sep === undefined)) {
      // sohbet açıldı ama mesaj satırı bulunamadı: mesaj alanının yapısını (içeriksiz) bir kez günlüğe yaz
      if (!msgDiagDone) {
        msgDiagDone = true;
        const d = await lib<Record<string, unknown>>(f, 'diag').catch((e: Error) => ({ err: e.message.slice(0, 80) }));
        bus.log('warn', `TikTok mesaj alanı tanı: ${JSON.stringify(d)}`);
      }
      // listede önizlemesi olan sohbet boş olamaz: hata → köprü bu sohbeti sonra yeniden dener (boş sonuç "okundu" sayılıyordu)
      if (lastPreview.get(threadId)) throw new Error('TikTok: sohbet açıldı ama mesajlar okunamadı');
    }
    const msgs = toMessages(threadId, head.name, items, new Date(), stableTs.get(threadId), mdyOf(pageLang));
    const out = before ? msgs.filter((m) => m.ts < before) : msgs;
    return out.slice(-limit);
  },

  async send(page, _cookies, threadId, text) {
    // gönderimde "açık" olumlu doğrulanmalı (başlık/seçili satır): yanlış kişiye yazılmasın
    const f = await openThread(page, threadId, true);
    await tag(f);
    const frames = f === page.mainFrame() ? [f] : [page.mainFrame(), f];
    await setFocus(frames, true);
    try {
      const box = f.locator(INPUT).first();
      await box.click({ timeout: 10_000 });
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i) await page.keyboard.press('Shift+Enter');
        if (lines[i]) await page.keyboard.type(lines[i], { delay: 6 });
      }
      await page.waitForTimeout(150);
      const btn = f.locator(SEND_BTN).first();
      if (await btn.count().catch(() => 0)) await btn.click({ timeout: 5000 }).catch(() => page.keyboard.press('Enter'));
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
    } finally {
      await setFocus(frames, false);
    }
    // gerçek kimlik sonraki okumada gelir; yerel kopya (local-…) aynı metinli gerçek kayıtla birleşir
    return undefined;
  },

  async moreThreads(page, _cookies, pageIndex) {
    if (pageIndex > 5) return [];
    const f = await ensureInbox(page);
    if (!f) return [];
    // baştan ekran ekran: pageIndex. ekranda İLK KEZ görülen satırlar (kimlikler bütün listedeki sırayla)
    let step = 0;
    let prevPos: number[] = [];
    const { acc, lang } = await scanList(
      page,
      f,
      (acc) => {
        if (step === pageIndex) return true;
        step++;
        prevPos = acc.map((r) => r.pos ?? Number.NaN);
        return false;
      },
      pageIndex,
    );
    await lib(f, 'scroll', { what: 'list', to: 'top' }).catch(() => undefined);
    const ids = rowIds(acc);
    const keep = acc.map((r) => r.pos !== undefined && !prevPos.some((p) => Math.abs(p - (r.pos as number)) < 20));
    if (!keep.some(Boolean)) return [];
    // yalnız yeni satırlar (üstteki sayfanın kararlı zamanlarına dokunulmaz)
    return toThreads(
      acc.filter((_r, i) => keep[i]),
      Date.now(),
      { floor: listFloor || undefined, mdy: mdyOf(lang), ids: ids.filter((_id, i) => keep[i]) },
    );
  },

  async attention(page) {
    return (await page.locator(CAPTCHA).count().catch(() => 0)) ? 'TikTok doğrulama istiyor: Yeniden bağlan → açılan pencerede doğrulamayı tamamla' : undefined;
  },
};

/** Testler için: modül durumunu sıfırla */
export function resetTikTokState(): void {
  myHandle = '';
  handles.clear();
  lastPreview.clear();
  lastTime.clear();
  stableTs.clear();
  listFloor = 0;
  pageLang = '';
  dupNames.clear();
  diagDone = false;
  msgDiagDone = false;
  listWarned = false;
  bizLogged = false;
}
