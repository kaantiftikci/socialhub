import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { APIRequestContext, BrowserContext, CDPSession, Page } from 'playwright';
import { BaseConnector, type ComposeDraft, type LoginInput, type SendOptions, type StartOptions } from '../base.js';
import { chatId, messageId } from '../../model.js';
import { trReactionText } from '../../reaction-text.js';
import { persistSessionCookies } from './outlook.js';
import { bus } from '../../bus.js';
import { sessionDir } from '../../config.js';
import { killProcessesMatching } from '../../platform.js';
import { ensureChromium } from '../../browser-install.js';
import { bootSlots } from '../../boot-plan.js';
import { mediaHostAllowed, MEDIA_MAX } from '../../media-hosts.js';
import { isUiActive, onUiActive } from '../../activity.js';
import type { Account, Attachment, Chat, ChatKind, Participant, Reaction } from '../../model.js';
import type { Store } from '../../store.js';

/**
 * Tarayıcı köprüsü: resmi mesaj API'si olmayan platformlar (LinkedIn, X, Instagram, Messenger)
 * için kalıcı profilli bir Chromium penceresi açılır; kullanıcı bir kez giriş yapar.
 * Sonrasında platformun kendi web istemcisinin kullandığı iç uçlar sayfa bağlamında
 * (çerezlerle) çağrılır ya da DOM okunur. Oturum ~/.mivelo/sessions/<hesap>/profile altında kalır.
 *
 * Bu yollar platformların kullanım koşullarına aykırı olabilir; test hesabı kullan.
 */
export interface Thread {
  id: string;
  name: string;
  kind: ChatKind;
  lastTs: number;
  preview: string;
  unread: number;
  avatarUrl?: string;
  handle?: string;
  link?: string;
  participants?: Participant[];
  /** Karşı tarafın son gördüğü an (ms): bundan eski giden mesajlar 'görüldü' olur */
  readByOthersUpTo?: number;
  /** Aynı sohbetin eski kimlikleri (ör. X'te eski DM grubu "<id>" → XChat "g<id>"): depoda varsa bu sohbete birleştirilir */
  aliases?: string[];
  /** Platforma özel veri; e-postada folder: 'inbox' | 'sent' | 'junk' */
  meta?: Record<string, unknown>;
  /**
   * Sohbetteki en yeni etkinlik bir mesaj değil TEPKİ (karşı taraf bir mesajı beğendi): önizleme bu metin olur, mesaj
   * gelmiş gibi görünmez (okunmamış sayılmaz, tik gösterilmez). Strateji platform verisinden bildiğinde doldurur.
   */
  reactionPreview?: string;
}

/**
 * Platformun kendi önizlemesi tepkiyi anlatıyor (Messenger "Ayşe mesajına ❤ ile tepki verdi", LinkedIn "reacted", IG
 * "bir mesajı beğendi"): o turda yeni gelen mesaj yoksa sohbet okunmamış sayılmaz.
 */
export const REACTION_PREVIEW_RE = /tepki verdi|tepki gösterdi|reacted\b|bir mesaj[ıi]n?[ıi]? beğendi|mesaj[ıi]n[ıi] beğendi|liked a message|loved a message|mesajınızı beğendi/i;

export interface Msg {
  id: string;
  text: string;
  ts: number;
  fromMe: boolean;
  senderId: string;
  senderName: string;
  attachments?: Attachment[];
  senderAvatarUrl?: string;
  /** Platform iletim/görülme bilgisi veriyorsa (varsayılan: benimkiler 'sent', gelenler 'delivered') */
  status?: 'sent' | 'delivered' | 'read';
  reactions?: Reaction[];
  /** Slack iş parçacığı: üst mesajın kimliği / yanıt sayısı */
  threadId?: string;
  replyCount?: number;
  /** Alıntılı yanıt: yanıtlanan mesajın kimliği (ad/metin verilmezse depodan doldurulur) */
  replyTo?: { remoteId: string; senderName?: string; text?: string };
  /** E-posta: özgün gövde HTML'i (arayüz güvenli çerçevede gösterir) */
  html?: string;
  /** Gönderildikten sonra düzenlendi */
  edited?: boolean;
}

/** Sayfasız (tarayıcısız) modda stratejiye verilen sahte sayfanın taşıdığı istek bağlamı */
export interface ApiHandle {
  api: APIRequestContext;
  state: StorageState;
}
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
/** Strateji bir DOM işlemi için gerçek sayfaya ihtiyaç duyduğunda fırlatır; köprü tarayıcıyı açıp yeniden dener */
export const NEEDS_PAGE = 'NEEDS_PAGE';
export function apiOf(page: Page): ApiHandle | undefined {
  return (page as unknown as { __api?: ApiHandle }).__api;
}
/** Günlük için adres: sorgu/parça (OAuth code, nonce vb.) atılır */
export function safeUrl(u: string | undefined): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).slice(0, 90);
  } catch {
    return u.slice(0, 40);
  }
}

export function needsPage(page: Page): void {
  if (apiOf(page)) throw new Error(NEEDS_PAGE);
}

export interface Strategy {
  home: string;
  loginHint: string;
  /** Mivelo içi girişte doğrudan açılacak giriş sayfası (yoksa home; ör. Yandex: posta ana sayfası oturumsuzken portala atıyor) */
  loginUrl?: string;
  /** API tabanlı: giriş sonrası tarayıcı kapanır, istekler Node'dan (Playwright request bağlamı, kayıtlı çerezler) atılır */
  pageless?: boolean;
  /** Görünmez sekme "arka planda" tanıtılmasın (site gizli sekmede içerik yüklemiyorsa) */
  keepVisible?: boolean;
  /** Görünmez tarayıcının görünüm boyutu (varsayılan 1180×820): masaüstü düzeni geniş ekranda açılan siteler (TikTok) için */
  viewport?: { width: number; height: number };
  /** Yoklama bitince sayfayı about:blank'e al (ağır siteler boşta bellek tutmasın); strateji her çağrıda kendi sayfasına döner */
  unloadWhenIdle?: boolean;
  /** send() opts.replyTo ile alıntılı yanıt gönderebilir (Instagram) */
  canReply?: boolean;
  /** Giriş yapılmış mı? (çerezler Node tarafında okunur, sayfa da verilir) */
  /** passive=true: görünür giriş penceresi açıkken çağrılır — sayfayı YÖNLENDİRME, yalnızca çerez/URL'ye bak (kullanıcının girişini bölmemek için) */
  loggedIn(page: Page, cookies: Record<string, string>, passive?: boolean): Promise<boolean>;
  /** Kendi kimliğini ve görünen adını döndür */
  me(page: Page, cookies: Record<string, string>): Promise<{ id: string; label: string }>;
  threads(page: Page, cookies: Record<string, string>): Promise<Thread[]>;
  /** `before`: verilirse bu zamandan (ms) eski mesajlar (eski mesaj yükleme) */
  messages(page: Page, cookies: Record<string, string>, threadId: string, limit: number, before?: number): Promise<Msg[]>;
  /** true: API tabanlı strateji, mesaj çağrıları paralel yapılabilir (DOM okuyanlar tek sayfayı paylaştığı için sıralı) */
  parallel?: boolean;
  send(page: Page, cookies: Record<string, string>, threadId: string, text: string, opts?: SendOptions): Promise<string | undefined>;
  /** Yeni e-posta (web posta istemcisinde Oluştur → Kime/Konu/Metin → Gönder); dizi kimliği biliniyorsa döner */
  compose?(page: Page, cookies: Record<string, string>, draft: ComposeDraft): Promise<string | undefined>;
  /** Emoji tepkisi ver/kaldır (Slack reactions.add/remove) */
  react?(page: Page, cookies: Record<string, string>, threadId: string, msgId: string, emoji: string, remove: boolean): Promise<void>;
  /** Kendi mesajımı herkesten sil / geri al (Slack chat.delete, Instagram unsend) */
  unsend?(page: Page, cookies: Record<string, string>, threadId: string, msgId: string): Promise<void>;
  /** Kendi mesajımın metnini düzenle (Slack chat.update) */
  edit?(page: Page, cookies: Record<string, string>, threadId: string, msgId: string, text: string): Promise<void>;
  /** Bir üyeyle birebir sohbet kimliği (yoksa oluştur) */
  openDirect?(page: Page, cookies: Record<string, string>, participant: Participant): Promise<string>;
  /** Platformda okundu işaretle; lastIncomingId depodaki son gelen mesajın kimliği */
  markRead?(page: Page, cookies: Record<string, string>, threadId: string, lastIncomingId?: string): Promise<void>;
  /** http(s) olmayan özel medya şeması (ör. X'in "xc:<sohbet>/<ek>" çözülmüş OPFS dosyaları): strateji sayfa bağlamından okur */
  fetchMedia?(page: Page, cookies: Record<string, string>, u: string): Promise<{ body: Buffer; type: string } | undefined>;
  /** Fotoğraf/video/dosya gönder: genelde düzenleyicideki input[type=file]'a setInputFiles ile; dönen kimlik ya da undefined */
  sendFile?(page: Page, cookies: Record<string, string>, threadId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<string | undefined>;
  /** Sohbet listesinin `pageIndex`. sayfası (1 = ilk sayfadan sonraki); boş dizi = daha yok */
  moreThreads?(page: Page, cookies: Record<string, string>, pageIndex: number): Promise<Thread[]>;
  /** Kayıtlı oturum olsa da "Yeniden bağlan"da görünür pencere gerekiyor mu (ör. Messenger uçtan uca şifreli geçmiş için PIN adımı)? */
  needsWindow?(page: Page): Promise<boolean>;
  /** Görünür pencere kapatılmadan önce: kullanıcının tamamlaması gereken ek adım (PIN) için bekle */
  afterLogin?(page: Page): Promise<void>;
  /**
   * Her yoklamadan sonra ucuz denetim: bağlı ama kullanıcı eylemi bekleyen durum (şifreli sohbet PIN'i vb.) varsa kısa açıklama,
   * yoksa undefined. Arayüz kanal satırında uyarı + "PIN'i gir" düğmesi gösterir (Yeniden bağlan → görünür pencere → afterLogin).
   */
  attention?(page: Page): Promise<string | undefined>;
  /**
   * Anlık bildirim: sayfanın kendi gerçek zamanlı akışını (LinkedIn /realtime/connect) dinle. Sayfa her açıldığında
   * gezinmeden önce çağrılır. notify('alive'): akış açık (kalp atışı) → yoklama seyrekleşir; notify('event'): yeni
   * mesaj/sohbet olayı → birkaç saniye içinde yoklama.
   */
  watch?(page: Page, notify: (kind: 'alive' | 'event') => void): Promise<void>;
  /**
   * watch yoksa genel izleyici: sayfa (ve iframe'leri) açıkken bu seçiciye uyan ilk satırların metni 2 sn'de bir karşılaştırılır;
   * değişince (yeni e-posta listeye düştü) 'event'. Ağ trafiği yok, yalnız sayfanın kendi DOM'u okunur (Gmail tr.zA vb.).
   */
  watchSelector?: string;
  /**
   * Sayfanın KENDİ WebSocket'leri (Playwright page.on('websocket') → framereceived): yalnız dinlenir, soket açılmaz/yazılmaz.
   * url'ye uyan sokette `event` eşleşen çerçeve (ya da event yoksa minBytes'tan büyük çerçeve) → 'event', diğerleri → 'alive'.
   * Kaynak: mautrix-meta (Instagram/Messenger DGW lightspeed), mautrix-twitter (XChat chat-ws.x.com).
   */
  watchSockets?: Array<{ url: RegExp; event?: RegExp; minBytes?: number }>;
}

/**
 * Meta Lightspeed (Instagram ve Messenger web, DGW `gateway.<site>/ws/lightspeed`) yeni mesaj/sohbet saklı yordamları.
 * Kaynak: mautrix-meta pkg/messagix/table/table.go. Çerçeve ikili ama yük JSON; latin1 metinde aranır.
 */
export const LIGHTSPEED_EVENT = /insertMessage|upsertMessage|updateThreadSnippet|deleteThenInsertThread|insertNewMessageRange/;

/** Sayfanın kendi WebSocket çerçevelerini pasif dinle (Strategy.watchSockets) */
export function watchSocketFrames(page: Page, rules: NonNullable<Strategy['watchSockets']>, notify: (kind: 'alive' | 'event') => void): void {
  page.on('websocket', (ws) => {
    const rule = rules.find((r) => r.url.test(ws.url()));
    if (!rule) return;
    ws.on('framereceived', (f) => {
      const p = f.payload;
      const text = typeof p === 'string' ? p : Buffer.from(p).toString('latin1');
      const hit = rule.event ? rule.event.test(text) : text.length >= (rule.minBytes ?? 64);
      notify(hit ? 'event' : 'alive');
    });
  });
}

/**
 * Genel DOM izleyicisi (Strategy.watchSelector). Zaman ifadeleri ("14:32", "5 dk") imzadan atılır: yalnız geçen süre
 * yüzünden olay çıkmasın. Seçici görünmüyorsa (sohbet açık, başka görünüm) imza sıfırlanır; dönüşte olay sayılmaz.
 */
export async function watchDom(page: Page, selector: string, notify: (kind: 'alive' | 'event') => void): Promise<void> {
  await page.exposeBinding('__miveloDom', (_src, kind: string) => notify(kind === 'event' ? 'event' : 'alive'));
  await page.addInitScript((sel: string) => {
    const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (w.__miveloDomHooked) return;
    w.__miveloDomHooked = true;
    let prev: string | null = null;
    let aliveAt = 0;
    setInterval(() => {
      try {
        const rows = Array.from(document.querySelectorAll(sel)).slice(0, 6);
        if (!rows.length) {
          prev = null;
          return;
        }
        const sig = rows
          .map((r) => (r.textContent ?? '').replace(/\d{1,2}[:.]\d{2}|\d+\s?(sn|dk|sa|gün|sec|min|hr|h|m|s|d)\b/gi, '').replace(/\s+/g, ' ').slice(0, 160))
          .join('|');
        if (prev !== null && sig !== prev) w.__miveloDom?.('event');
        prev = sig;
        if (Date.now() - aliveAt > 30_000) {
          aliveAt = Date.now();
          w.__miveloDom?.('alive');
        }
      } catch {
        /* sayfa değişiyor */
      }
    }, 2000);
  }, selector);
}

export interface BridgeOptions {
  /** Arayüz boştayken (pencere kapalı/odaksız) yoklama aralığı; verilmezse her zaman pollMs */
  idlePollMs?: number;
  /**
   * unloadWhenIdle stratejilerde tarayıcıyı yoklamalar arasında açık tut: 'always' (Outlook: sayfanın canlı listesi izlenir),
   * 'whileActive' (Gmail/iCloud tarayıcı yolu: Mivelo odaktayken açık, boşta bellek için kapanır).
   */
  keepOpen?: 'always' | 'whileActive';
  /**
   * Anlık sinyal canlıyken (son 5 dk'da sinyal + en az bir kez 'event' görülmüş) yedek yoklama bu kat seyrekleşir (varsayılan 3).
   * 'event' hiç görülmediyse seyrekleşme yok: dinleyici yanlış çerçeveye bakıyorsa mesajlar gecikmesin.
   */
  rtSlowdown?: number;
  /**
   * Uzun süre açık kalan sayfa (Facebook/X/Instagram SPA'ları bellek sızdırır) bu aralıkta rastgele bir anda yumuşak yenilenir
   * (saat; varsayılan 6–10). Dinleyiciler (init betikleri, page.on) yenilemeden sonra da geçerli. Instagram 12–20 (mautrix-meta 20 sa).
   */
  softReloadHours?: [number, number];
  /**
   * İlk eşitlemede mesajları henüz alınmamış (son 30 günde etkin ya da okunmamış) sohbet kaldıkça sıradaki tur bu aralıkla
   * (±%30) gelir; bitince olağan aralığa döner. Eskiden tur başına 8 sohbet × 30-60 sn → 200 sohbetin mesajları ~20 dk sürüyordu.
   * Verilmezse hızlandırma yok (DOM'u tıklayarak okuyan e-posta yolları gibi ağır kanallar).
   */
  backfillMs?: number;
}

/** Açılış yuvaları: etkileşimsiz tarayıcı açılışları sırayla (BOOT_SLOTS kadarı birlikte, spawn sırasıyla = boot-plan puanı); yuva en geç 45 sn sonra boşalır */
// makineye göre (boot-plan.ts bootSlots: çekirdek/3 ve boş bellek/700 MB, 1–4); süreç boyunca tek değer → "Açılış sırası … aynı anda N" günlüğüyle aynı
const BOOT_SLOTS = bootSlots();
let bootBusy = 0;
const bootWaiters: Array<() => void> = [];
function acquireBootSlot(cancelled: () => boolean): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      if (cancelled()) {
        resolve(() => undefined);
        return nextBootSlot();
      }
      bootBusy++;
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        bootBusy--;
        nextBootSlot();
      };
      const t = setTimeout(release, 45_000);
      t.unref?.();
      resolve(release);
    };
    if (bootBusy < BOOT_SLOTS) grant();
    else bootWaiters.push(grant);
  });
}
function nextBootSlot(): void {
  while (bootBusy < BOOT_SLOTS && bootWaiters.length) bootWaiters.shift()!();
}

export class BrowserConnector extends BaseConnector {
  private chromium?: (typeof import('playwright'))['chromium'];
  private request?: (typeof import('playwright'))['request'];
  private ctx?: BrowserContext;
  private page?: Page;
  /** sayfasız mod: tarayıcı kapalı, istekler bu bağlamdan */
  private api?: APIRequestContext;
  private state?: StorageState;
  private pageless = false;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private polling = false;
  /** 429/hız sınırı sonrası bu zamana kadar yoklama yok (oturum kilitlenmesin) */
  private backoffUntil = 0;
  /** Art arda hız sınırı sayısı: bekleme 5 dk → 10 → 20 … (≤ 2 sa); başarılı yoklamada sıfırlanır */
  private rateHits = 0;
  /** unloadWhenIdle: yoklamalar arasında tarayıcı kapalı (bellek); bir sonraki yoklama/işlem yeniden açar */
  private idleClosed = false;
  private known = new Map<string, number>(); // threadId → son görülen ts
  /**
   * Değişimi görülüp mesajları henüz alınamamış sohbetler (tur sınırı dışında kaldı / istek düştü / zaman aşımı). Önizleme
   * değişimine dayalı stratejilerde (Messenger, X DOM yedeği) değişim sinyali tek turluk: sonraki turda lastTs=0 → sohbet
   * bir daha 'changed' sayılmıyor, yeni mesaj hiç çekilmiyordu. Hata alan sohbet üstel bekler (30 sn·2^n ≤ 30 dk, ≤6 deneme).
   */
  private pendingFetch = new Map<string, { tries: number; next: number }>();
  /**
   * Yarım kalan boşluk doldurma: yoklama sohbetin yalnız en yeni 15-25 mesajını alır; arada (uyku, kapalıyken, hız sınırı
   * beklemesi) daha fazlası geldiyse depodaki en yeni mesajla alınan en eskisi arasında boşluk kalır ve arayüzün "daha eski"si
   * önce depoya baktığı için hiç dolmaz. threadId → {before: sıradaki sayfanın üst sınırı, floor: depodaki en yeni ts, turns}
   */
  private gapFill = new Map<string, { before: number; floor: number; turns: number }>();
  /** markRead birleştirme: aynı sohbet için kuyrukta bekleyen okundu işi varsa yenisi eklenmez */
  private pendingRead = new Set<string>();
  /** Bu oturumda Mivelo'dan yazılan sohbetler: kendi yeni mesajımız depoda "güncel" sanılıp eski mesajların alınması atlanmasın */
  private sentHere = new Set<string>();
  /** Bu turda mesajına yeni tepki gelen sohbetler (önizleme metni) ve yeni gelen mesajı olan sohbetler */
  private turnReacted = new Map<string, string>();
  private turnIncoming = new Set<string>();
  /**
   * Son etkinliği tepki olan sohbetler → o etkinliğin zamanı: platform bunu "okunmamış" saymaya devam etse de (IG read_state,
   * LinkedIn read:false, Messenger kalın satır) yeni etkinlik gelene dek Mivelo'da okunmamış artmaz.
   */
  private reactionOnly = new Map<string, number>();
  /** Mesajları henüz alınmamış önemli sohbet sayısı (ilk eşitleme sürüyor): sıradaki tur backfillMs ile öne çekilir */
  private backlogLeft = 0;

  constructor(
    account: Account,
    store: Store,
    private strategy: Strategy,
    private pollMs = 20_000,
    private opts: BridgeOptions = {},
  ) {
    super(account, store);
  }

  /** Anlık akış en son ne zaman yaşam belirtisi verdi (0: hiç) */
  private rtAliveAt = 0;
  private rtLogged = false;
  /** Son 'event' zamanı (0: hiç) — seyrekleşme ancak dinleyicinin gerçekten olay yakaladığı görülünce */
  private rtEventAt = 0;
  /** Öne çekilmiş tur ne zaman çalışacak (üst üste olaylar bekleyen turu sürekli ertelemesin) */
  private soonAt = 0;
  /** Yoklama sürerken gelen anlık olay: tur bitince hemen bir tur daha */
  private pendingPoll = false;
  private lastPollAt = 0;
  private offActive?: () => void;
  /** Sıradaki yumuşak yenileme zamanı (0: sayfa yeni açıldı, hesaplanacak) */
  private nextSoftReload = 0;

  /** Açık tutulan sayfayı saatler sonra bir kez yenile (bellek sızıntısı; soketler sayfanın kendisince yeniden kurulur) */
  private async maybeSoftReload(): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed() || this.account.status !== 'connected' || this.stopping) return;
    const [a, b] = this.opts.softReloadHours ?? [6, 10];
    const due = () => Date.now() + (a + Math.random() * (b - a)) * 3_600_000;
    if (!this.nextSoftReload) {
      this.nextSoftReload = due();
      return;
    }
    if (Date.now() < this.nextSoftReload) return;
    this.nextSoftReload = due();
    bus.log('info', `${this.account.platform}: açık sayfa yumuşak yenileniyor (uzun süreli bellek birikimi)`);
    await this.serial(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })).catch(() => undefined);
  }

  /** Anlık akıştan haber: 'event' ise yakında yokla (en az 10 sn arayla), 'alive' yalnız akışı canlı sayar */
  private onRealtime(kind: 'alive' | 'event'): void {
    this.rtAliveAt = Date.now();
    if (kind === 'event') this.rtEventAt = Date.now();
    if (!this.rtLogged) {
      this.rtLogged = true;
      bus.log('info', `${this.account.platform}: sayfanın anlık bildirim akışı dinleniyor; yoklama seyrekleşti, yeni mesajda hemen okunur`);
    }
    if (kind === 'event') this.pollSoon('anlık sinyal');
  }

  /**
   * Tanı: dinleyici tanımlı kanalda 3 dk içinde hiç anlık sinyal gelmezse bir kez günlüğe sayfanın adresi, izlenen seçiciye
   * uyan öğe sayısı ve sayfanın açtığı soketler (yalnız host+yol) yazılır — sinyalin neden gelmediği canlı hesapta görülsün.
   */
  private diagnoseRealtime(page: Page): void {
    const st = this.strategy;
    if (!st.watch && !st.watchSelector && !st.watchSockets) return;
    const sockets = new Set<string>();
    page.on('websocket', (ws) => {
      try {
        const u = new URL(ws.url());
        if (sockets.size < 20) sockets.add(u.host + u.pathname);
      } catch {
        /* geçersiz adres */
      }
    });
    const t = setTimeout(async () => {
      if (this.rtAliveAt || page.isClosed() || this.stopping) return;
      const rows = st.watchSelector ? await page.evaluate((sel) => document.querySelectorAll(sel).length, st.watchSelector).catch(() => -1) : undefined;
      bus.log(
        'info',
        `${this.account.platform}: 3 dk'dır anlık sinyal yok (tanı) — sayfa ${safeUrl(page.url())}${rows !== undefined ? `, izlenen satır ${rows}` : ''}, soketler: ${[...sockets].join(' | ') || 'yok'}`,
      );
    }, 180_000);
    t.unref?.();
  }

  /** Bekleyen turu öne çek. Yoklama durmuşsa (doğrulama sayfası, kapalı) canlandırmaz. */
  /** Sıradaki turu öne çek; `reason` tanı günlüğü içindir (yeni mesajın hangi yoldan ve ne kadar gecikmeyle geldiği) */
  private pollSoon(reason = 'odak'): void {
    if (!this.timer || this.stopping || this.account.status !== 'connected' || Date.now() < this.backoffUntil) return;
    if (this.polling) {
      this.pendingPoll = true;
      this.pendingReason ??= { kind: reason, at: Date.now() };
      return;
    }
    if (this.soonAt > Date.now()) return; // zaten öne çekildi
    this.nextReason ??= { kind: reason, at: Date.now() };
    const delay = this.soonDelay();
    this.soonAt = Date.now() + delay;
    this.schedule(delay);
  }

  /** Öne çekilen turun gecikmesi: 1,5–4 sn, ama iki turun BAŞLANGIÇLARI arasında en az 10 sn (istek patlaması olmasın) */
  private soonDelay(): number {
    return Math.max(1500 + Math.random() * 2500, 10_000 - (Date.now() - this.lastPollAt));
  }
  /** Tanı: sıradaki turu ne tetikledi (anlık sinyal / odak / zamanlayıcı) ve ne zaman; turda gelen yeni mesajların gecikmesi */
  private nextReason?: { kind: string; at: number };
  private pendingReason?: { kind: string; at: number };
  private turnReason?: { kind: string; at: number };
  private freshIn: number[] = [];

  /** Tarayıcı sayfası şimdi açık tutulmalı mı (keepOpen) */
  private wantPage(): boolean {
    return this.opts.keepOpen === 'always' || (this.opts.keepOpen === 'whileActive' && isUiActive());
  }

  /**
   * Açılışta (etkileşimsiz) tarayıcı kanalları aynı anda en çok BOOT_SLOTS tanesi kalkar; kullanıcının bastığı "Bağlan"/
   * "Yeniden bağlan" sıraya girmez. (29.09, Kaan: uzun aradan sonra açınca her şey aynı anda eşitleniyor, TikTok giriş
   * penceresi dakikalar sonra açılıyor — 8-10 Chromium'un eşzamanlı açılışı + ilk turları CPU/diski tüketiyordu.)
   */
  async start(opts: StartOptions = {}): Promise<void> {
    if (opts.interactive !== false) return this.startInner(opts);
    const release = await acquireBootSlot(() => this.stopping);
    const t0 = Date.now();
    try {
      if (!this.stopping) await this.startInner(opts);
    } finally {
      release();
      // ölçülen açılış süresi: sonraki açılışta sıra buna göre (kısa + önemli önce); yalnız bağlandıysa, üstel ortalama
      if (this.account.status === 'connected') {
        const prev = Number(this.store.meta(`boot_ms:${this.account.id}`)) || 0;
        const ms = Date.now() - t0;
        this.store.setFlag(`boot_ms:${this.account.id}`, String(Math.round(prev ? prev * 0.6 + ms * 0.4 : ms)));
      }
    }
  }

  private async startInner(opts: StartOptions = {}): Promise<void> {
    const interactive = opts.interactive !== false;
    this.stopping = false;
    this.loginCancelledOnce = false;
    // Giriş varsayılan olarak AYRI pencerede (Kaan: Mivelo içi yayında sitelerin düğmeleri tepki vermiyordu); içeride açmak için MIVELO_LOGIN_EMBED=1.
    this.external = !!opts.external || process.env.MIVELO_LOGIN_EMBED !== '1';
    try {
      ({ chromium: this.chromium, request: this.request } = await import('playwright'));
    } catch {
      this.setStatus('error', 'playwright paketi yok: npm i playwright && npx playwright install chromium');
      return;
    }
    this.setStatus('connecting');

    // Uyarıdaki "PIN'i gir": PIN adımı bekleniyor olduğu zaten biliniyor → görünmez açılış + sayfa denetimi + kapatma
    // turunu (10-20 sn) atla, görünür pencereyi hemen aç; oturum çerezleri varsa giriş beklemeden PIN adımına geç
    if (interactive && opts.window && this.strategy.afterLogin) {
      if (!(await this.launchLogin())) return;
      if (!(await this.visibleLogin(await this.isLoggedIn(true)))) return;
      if (this.stopping) return;
      this.syncProgress(45, 'oturum doğrulandı');
      await this.finishStart();
      return;
    }

    // 0) API tabanlı kanal ve kayıtlı oturum durumu varsa tarayıcısız başla (bellek: Chromium hiç açılmaz)
    if (this.strategy.pageless && !interactive && fs.existsSync(this.stateFile)) {
      try {
        await this.openApi(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as StorageState);
        if (this.stopping) {
          await this.api?.dispose().catch(() => undefined);
          this.api = undefined;
          this.pageless = false;
          return;
        }
        this.syncProgress(45, 'oturum (sayfasız)');
        await this.finishStart();
        if (this.account.status === 'connected') return;
      } catch (e) {
        bus.log('info', `${this.account.platform}: sayfasız açılış olmadı (${(e as Error).message.slice(0, 80)}); tarayıcıyla deneniyor`);
      }
      await this.api?.dispose().catch(() => undefined);
      this.api = undefined;
      this.pageless = false;
      if (this.stopping) return;
    }
    // Hiç giriş yapılmamış profil (yeni "Bağlan") ya da oturumun düştüğü biliniyor ('pairing' iken Yeniden bağlan): görünmez
    // denetim turu (10-20 sn) boşuna — giriş penceresini hemen aç
    if (interactive && (opts.login || !hasProfileCookies(path.join(sessionDir(this.account.id), 'profile')))) {
      if (!(await this.launchLogin())) return;
      // oturum düşmüşken eski çerez "giriş var" sanılıp pencere hemen kapanmasın: girişi bekle
      if (!(await this.visibleLogin(opts.login ? false : await this.isLoggedIn(true)))) return;
      if (this.stopping) return;
      this.syncProgress(45, 'oturum doğrulandı');
      await this.finishStart();
      return;
    }
    // 1) Kayıtlı oturum var mı? Önce görünmez pencerede dene.
    if (!(await this.launch(true))) return;
    // (eşitleme yüzdesi burada BAŞLAMAZ: oturum doğrulanmadan — giriş penceresi bile açılmadan — "eşitleniyor %20" görünüyordu)
    // kullanıcı Yeniden bağlan dediyse denetim uzun sürmesin: 12 sn'de oturum görülmezse giriş penceresi açılır
    let loggedIn = interactive ? await withTimeout(this.isLoggedIn(), 12_000, 'oturum denetimi').catch(() => false) : await this.isLoggedIn();
    // Açılışta 8 tarayıcı aynı anda kalkınca sayfa geç çizilir ve oturum yokmuş sanılır (Outlook 'pairing' sonra 'connected'):
    // pencere açmadan önce bir kez daha dene
    if (!loggedIn && !interactive && this.page && !this.page.isClosed()) {
      bus.log('info', `${this.account.platform}: oturum ilk denetimde görülmedi, 8 sn sonra yeniden deneniyor`);
      await this.page.waitForTimeout(8000).catch(() => undefined);
      loggedIn = await this.isLoggedIn();
    }
    // Giriş var ama platform görünür pencerede ek adım istiyor (Messenger PIN): yalnızca kullanıcı 'Yeniden bağlan' dediyse pencere aç
    const needsWindow = loggedIn && interactive && !!this.strategy.needsWindow && (await withTimeout(this.strategy.needsWindow(this.page!), 30_000, 'pencere denetimi').catch(() => false));
    if (!loggedIn || needsWindow) {
      if (!interactive) {
        // Açılışta pencere fırlatma: kullanıcı "Yeniden bağlan" deyince giriş penceresi açılır.
        await this.closeCtx();
        this.setStatus('pairing', 'Giriş gerekli — kanala sağ tıklayıp "Yeniden bağlan" de');
        return;
      }
      // 2) Yok: görünür pencere aç, kullanıcı giriş yapsın; izin adımları bitince pencereyi kapat.
      await this.closeCtx();
      if (!(await this.launchLogin())) return;
      if (!(await this.visibleLogin(false))) return;
    }
    if (this.stopping) return;
    this.syncProgress(45, 'oturum doğrulandı');
    await this.finishStart();
  }

  /**
   * Görünür pencere açıkken: giriş (loggedIn=false ise beklenir), platformun son adımı (PIN), oturum çerezlerini kalıcı yap,
   * pencereyi kapatıp görünmez devam et.
   */
  private async visibleLogin(loggedIn: boolean): Promise<boolean> {
    if (this.loginCancelledOnce || this.stopping) return false;
    // oturum zaten var (PIN adımı): pencereyi kapatmak iptal sayılmaz, eskisi gibi görünmez devam edilir
    if (loggedIn) this.stopLoginWatch();
    this.setStatus('pairing', loggedIn ? 'Açılan pencerede PIN kodunu gir; kabul edilince pencere kendiliğinden kapanır' : this.strategy.loginHint);
    if (!loggedIn && !(await this.waitForLogin())) return false;
    // Platforma özgü son adım (Messenger: "PIN kodunu gir") — pencere hâlâ açıkken
    if (this.strategy.afterLogin && this.page && !this.page.isClosed()) await this.strategy.afterLogin(this.page).catch(() => undefined);
    // Görünür pencereden görünmeze geçişte süresiz (oturum) çerezleri silinir → Microsoft/Google/Apple oturumu düşer.
    // Pencere kapanmadan tüm oturum çerezlerini 30 günlük çereze çevir (tüm tarayıcı kanalları)
    if (this.ctx) {
      const n = await persistSessionCookies(this.ctx, /./).catch(() => 0);
      if (n) bus.log('info', `${this.account.platform}: ${n} oturum çerezi kalıcı yapıldı`);
    }
    bus.log('info', `${this.account.platform}: giriş yapıldı, pencere kapatılıyor`);
    await this.stopEmbed();
    await this.closeCtx();
    return this.launch(true);
  }

  private async finishStart(): Promise<void> {
    try {
      const me = await this.strategy.me(this.target(), await this.cookies());
      // strateji adı bulamayınca genel ad döner ("Instagram", "Outlook"): önceden öğrenilmiş @kullanıcı/adres ezilmesin
      if (me.label && (!GENERIC_LABEL.test(me.label.trim()) || !this.account.label || GENERIC_LABEL.test(this.account.label.trim()) || this.account.label === this.account.platform))
        this.account.label = me.label;
    } catch {
      /* etiket kalsın */
    }
    if (this.stopping) return;
    this.setStatus('connected');
    await this.poll(true);
    // durdurulan connector zamanlayıcı/odak dinleyicisi kurmasın (sızıntı)
    if (this.stopping || this.account.status !== 'connected') return;
    this.syncProgress(100);
    this.schedule();
    // uyarlamalı yoklama: arayüz boştan etkine geçince uzun bekleyen turu öne çek
    this.offActive?.();
    if (this.opts.idlePollMs) this.offActive = onUiActive(() => this.pollSoon('odak'));
  }

  private get stateFile(): string {
    return path.join(sessionDir(this.account.id), 'state.json');
  }

  /** Sayfasız istek bağlamını aç (kayıtlı çerezler + gerçek Chrome kimliği) */
  private async openApi(state: StorageState): Promise<void> {
    await this.api?.dispose().catch(() => undefined);
    this.state = state;
    this.api = await this.request!.newContext({ storageState: state, userAgent: await realUserAgent(this.chromium!), timeout: 45_000 });
    this.pageless = true;
  }

  /** Tarayıcıdan sayfasız moda geç: durumu kaydet, tarayıcıyı kapat */
  private async goPageless(): Promise<void> {
    if (!this.ctx || !this.request) return;
    const state = await this.ctx.storageState();
    this.saveState(state);
    await this.closeCtx();
    await this.openApi(state);
  }

  private saveState(state: StorageState): void {
    try {
      fs.mkdirSync(sessionDir(this.account.id), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state), { mode: 0o600 });
    } catch {
      /* yazılamadı */
    }
  }

  /** Stratejiye verilecek "sayfa": gerçek sayfa ya da sayfasız modda API taşıyan vekil (DOM çağrıları NEEDS_PAGE fırlatır) */
  private target(): Page {
    if (this.page && !this.page.isClosed()) return this.page;
    const handle: ApiHandle = { api: this.api!, state: this.state! };
    return new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === '__api') return handle;
          if (k === 'isClosed') return () => false;
          if (k === 'url') return () => 'pageless:';
          if (k === 'then') return undefined;
          return () => {
            throw new Error(NEEDS_PAGE);
          };
        },
      },
    ) as unknown as Page;
  }

  /** Strateji çağrısı: sayfasız modda DOM gerekirse tarayıcıyı açıp gerçek sayfayla yeniden dener, sonra sayfasıza döner */
  private async run<T>(fn: (page: Page, cookies: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      return await fn(this.target(), await this.cookies());
    } catch (e) {
      if ((e as Error).message !== NEEDS_PAGE) throw e;
    }
    if (!(await this.ensureOpen())) throw new Error('Tarayıcı açılamadı');
    try {
      return await fn(this.page!, await this.cookies());
    } finally {
      if (this.strategy.pageless && !this.wantPage() && this.account.status === 'connected' && !this.stopping) await this.goPageless().catch(() => undefined);
    }
  }

  /** Kalıcı profille Chromium aç. headless=true: arka planda çalışan görünmez pencere. */
  private async launch(headless: boolean, retried = false, navigate = true): Promise<boolean> {
    const profile = path.join(sessionDir(this.account.id), 'profile');
    // Paketli uygulama (DMG/EXE): Chromium ilk tarayıcılı kanalda bir kez indirilir
    if (!retried) {
      const ready = await ensureChromium((pct) => this.setStatus('connecting', pct == null ? 'Tarayıcı bileşeni indiriliyor (ilk sefere özel)…' : `Tarayıcı bileşeni indiriliyor… %${pct}`));
      if (!ready) {
        this.setStatus('error', 'Tarayıcı bileşeni indirilemedi; internet bağlantını kontrol edip "Yeniden bağlan"a bas');
        return false;
      }
    }
    try {
      const hidden = headless || process.env.KAVSAK_HEADLESS === '1';
      this.ctx = await this.chromium!.launchPersistentContext(profile, {
        headless: hidden,
        // Görünmez modda Chromium kimliği "HeadlessChrome" içerir; Microsoft/Google bazı oturumları bu yüzden reddeder
        // (Outlook görünmezde login.microsoftonline.com'a düşüyordu). Görünür pencereyle aynı gerçek kimlik kullanılır.
        userAgent: hidden ? await realUserAgent(this.chromium!) : undefined,
        // tam Chromium (headless-shell değil): siteler "yeni headless" modu normal tarayıcı gibi görür
        channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium',
        executablePath: process.env.KAVSAK_CHROMIUM || undefined,
        // Görünür giriş penceresi: tam tarayıcı yerine sekmesiz/adres çubuksuz küçük uygulama penceresi (--app) — kullanıcının
        // kendi tarayıcısında açılamaz (oturum çerezleri Mivelo'nun profilinde olmalı), ama giriş iletişim kutusu gibi görünür
        viewport: hidden ? (this.embedOn ? EMBED_SIZE : (this.strategy.viewport ?? { width: 1180, height: 820 })) : null,
        deviceScaleFactor: hidden && this.embedOn ? 2 : undefined,
        // boşta boşaltılan kanallarda service worker sekme kapansa da render sürecini (Outlook 470 MB) hayatta tutuyor: engelle
        serviceWorkers: this.strategy.unloadWhenIdle ? 'block' : 'allow',
        locale: 'tr-TR',
        // Playwright'ın varsayılan --enable-automation bayrağı tarayıcıyı "otomasyonla yönetiliyor" diye işaretler (bilgi çubuğu +
        // otomasyon sinyalleri). X bu yüzden her hesapta "Giriş erişimini geçici olarak kısıtladık" diyordu (29.09, Kaan, masaüstü).
        ignoreDefaultArgs: ['--enable-automation'],
        // bellek: GPU/uzantı/arka plan ağ süreçleri kapalı, render süreci sınırı, JS yığın üst sınırı, geri-ileri önbelleği kapalı
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-sync',
          '--mute-audio',
          '--renderer-process-limit=2',
          '--js-flags=--max-old-space-size=512',
          '--disable-features=Translate,MediaRouter,OptimizationHints,BackForwardCache,InterestFeedContentSuggestions,AutofillServerCommunication',
          ...(hidden ? [] : [`--app=${this.strategy.home}`, '--window-size=760,860', '--window-position=140,60']),
        ],
      });
      // açılış sürerken stop() geldi (Kaldır/Çıkış/stopAll): o an this.ctx boştu, kapatılacak bir şey yoktu → tarayıcı sahipsiz kalıyordu
      if (this.stopping) {
        await this.closeCtx();
        return false;
      }
      // tsx (npm run dev) esbuild keepNames ile iç fonksiyonlara __name(...) ekler; page.evaluate / init betiklerine giden
      // kodda sayfada bu yardımcı yoktur → "ReferenceError: __name is not defined" (Messenger mesajları, LinkedIn akış
      // dinleyicisi). Derlenmiş (tsc) sürümde etkisiz; her belgeye (iframe'ler dahil) en önce tanımlanır.
      await this.ctx.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (t) { return t; };' });
      // Görünmez oturum: sayfa kendini "arka planda/odaksız" tanıtsın. Messenger, X, LinkedIn gibi siteler görünür ve odaklı
      // sekmeyi "aktif" sayıp telefona bildirim göndermeyi kesiyor; gizli sekme (WhatsApp Web'deki gibi) bunu yapmıyor.
      if (hidden && !this.strategy.keepVisible && !this.embedOn) {
        await this.ctx
          .addInitScript(() => {
            try {
              // #mivelo-visible: strateji sayfayı bilerek "görünür" açar (okundu işaretleme gibi görünürlük isteyen işler)
              if (location.hash.includes('mivelo-visible')) return;
              Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
              Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
              document.hasFocus = () => false;
            } catch {
              /* yok */
            }
          })
          .catch(() => undefined);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Önceki çekirdekten kalan Chromium profil kilidini tutuyorsa: o süreci kapat, kilidi sil, bir kez daha dene
      if (!retried && /ProcessSingleton|SingletonLock|profile directory is already in use/i.test(msg)) {
        bus.log('warn', `${this.account.platform}: profil kilidi bulundu (eski tarayıcı açık kalmış); temizlenip yeniden deneniyor`);
        await killProcessesMatching(`--user-data-dir=${profile}`);
        await sleep(1500);
        // SingletonLock/Socket/Cookie: macOS/Linux; lockfile: Windows
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) fs.rmSync(path.join(profile, f), { force: true });
        return this.launch(headless, true, navigate);
      }
      this.setStatus('error', `Chromium açılamadı: ${msg.split('\n')[0]}`);
      return false;
    }
    const ctx = this.ctx;
    this.page = ctx.pages()[0] ?? (await ctx.newPage());
    this.nextSoftReload = 0;
    const onRt = (k: 'alive' | 'event') => this.onRealtime(k);
    const watching = this.strategy.watch ? this.strategy.watch(this.page, onRt) : this.strategy.watchSelector ? watchDom(this.page, this.strategy.watchSelector, onRt) : undefined;
    await watching?.catch((e) => bus.log('warn', `${this.account.platform}: anlık izleme kurulamadı: ${(e as Error).message}`));
    if (this.strategy.watchSockets) watchSocketFrames(this.page, this.strategy.watchSockets, onRt);
    this.diagnoseRealtime(this.page);
    ctx.on('close', () => {
      if (this.ctx !== ctx) return; // biz kapattık (görünürden görünmeze geçiş)
      // giriş penceresi (bekçi açıkken) girişsiz kapandı: bağlanma iptal (hesap "Bağlı değil", yeni hesap kaldırılır)
      if (this.loginWatchTimer && !this.stopping) return void this.loginCancelled('giriş penceresi giriş yapılmadan kapatıldı');
      if (!this.stopping) this.setStatus('disconnected', 'Tarayıcı penceresi kapatıldı');
      this.unschedule();
    });
    if (navigate) await this.page.goto(this.strategy.home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    if (this.stopping) return false; // gezinme sırasında durduruldu (stop bağlamı kapattı): akış 'pairing'/'connected' yazmasın
    return true;
  }

  /** Sayfa yoksa ve kanal boşta kapatılmışsa tarayıcıyı yeniden aç (Gmail/Outlook: yoklamalar arasında kapalı tutulur) */
  private opening?: Promise<boolean>;
  private ensureOpen(): Promise<boolean> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(true);
    // Eşzamanlı çağrılar (yoklama + okundu + medya) aynı profille iki Chromium açmasın: süren açılışı paylaş
    return (this.opening ??= this.openNow().finally(() => (this.opening = undefined)));
  }
  private async openNow(): Promise<boolean> {
    if (this.page && !this.page.isClosed()) return true;
    if (!(this.idleClosed || this.pageless) || this.stopping || !this.chromium) return false;
    if (this.pageless) {
      await this.api?.dispose().catch(() => undefined);
      this.api = undefined;
      this.pageless = false;
    }
    const ok = await this.launch(true);
    if (ok) this.idleClosed = false;
    return ok;
  }

  /* ---------- Mivelo içi giriş (canlı görüntü + girdi aktarımı) ---------- */
  private external = false;
  /** Giriş görünmez tarayıcıda, görüntüsü arayüze akıyor */
  private embedOn = false;
  private embedPage?: Page;
  private cdp?: CDPSession;
  private loginAbort = false;
  private inputQ: Promise<unknown> = Promise.resolve();

  /** Giriş sayfasını aç: varsayılan Mivelo içinde (görünmez tarayıcı + ekran yayını), istenirse ayrı küçük pencerede */
  private async launchLogin(): Promise<boolean> {
    if (this.external) {
      if (!(await this.launch(false))) return false;
      if (this.loginCancelledOnce || this.stopping) return false;
      // pencere artık ekranda: "Bağlanıyor %N" değil "Eşleşme bekleniyor" (kullanıcı pencereyi kapatınca bekçi iptal eder)
      this.setStatus('pairing', this.strategy.loginHint);
      this.watchLoginWindow();
      return true;
    }
    this.embedOn = true;
    this.loginAbort = false;
    // arayüz giriş ekranını hemen ("açılıyor…") gösterir; ilk kare sayfa yüklenmeden gelir (eskiden 5-10 sn sonra açılıyordu)
    bus.emit({ type: 'login.start', accountId: this.account.id });
    if (!(await this.launch(true, false, false))) {
      this.embedOn = false;
      bus.emit({ type: 'login.end', accountId: this.account.id });
      return false;
    }
    await this.startEmbed().catch((e) => bus.log('warn', `${this.account.platform}: giriş ekranı yayını başlatılamadı: ${(e as Error).message}`));
    await this.page?.goto(this.strategy.loginUrl ?? this.strategy.home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return true;
  }

  /** Akış donmasın: sayfa değişince (süreç değişimi yayını durdurabiliyor) ya da 2,5 sn kare gelmezse yayını yeniden başlat */
  private lastFrameAt = 0;
  private async keepEmbedAlive(): Promise<void> {
    if (!this.embedOn || !this.page || this.page.isClosed()) return;
    if (this.embedPage !== this.page || Date.now() - this.lastFrameAt > 2500) {
      this.embedPage = undefined;
      await this.startEmbed().catch(() => undefined);
    }
  }

  /** Etkin sayfanın ekran yayınını başlat (sayfa değiştiyse — OAuth açılır penceresi — yenisine geç) */
  private async startEmbed(): Promise<void> {
    const page = this.page;
    if (!this.embedOn || !page || page.isClosed() || !this.ctx || this.embedPage === page) return;
    await this.stopEmbed(false);
    this.embedPage = page;
    this.lastFrameAt = Date.now();
    if (!page.viewportSize() || page.viewportSize()!.width !== EMBED_SIZE.width) await page.setViewportSize(EMBED_SIZE).catch(() => undefined);
    const cdp = await this.ctx.newCDPSession(page);
    this.cdp = cdp;
    // görünmez tarayıcıda sayfa kendini "odakta değil" sanmasın (bazı giriş düğmeleri document.hasFocus() / focus olaylarına bakar)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await cdp.send('Page.bringToFront').catch(() => undefined);
    if (!(page as Page & { __mvNav?: boolean }).__mvNav) {
      (page as Page & { __mvNav?: boolean }).__mvNav = true;
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame() && this.embedOn && this.embedPage === page) setTimeout(() => ((this.lastFrameAt = 0), void this.keepEmbedAlive()), 400);
      });
    }
    const id = this.account.id;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      this.lastFrameAt = Date.now();
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      let host = '';
      try {
        host = new URL(page.url()).host;
      } catch {
        /* about:blank */
      }
      bus.emit({ type: 'login.frame', accountId: id, data: f.data, width: EMBED_SIZE.width, height: EMBED_SIZE.height, host });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: EMBED_SIZE.width * 2, maxHeight: EMBED_SIZE.height * 2, everyNthFrame: 1 });
  }

  private async stopEmbed(end = true): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.embedPage = undefined;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    if (end && this.embedOn) {
      this.embedOn = false;
      bus.emit({ type: 'login.end', accountId: this.account.id });
    }
  }

  /** Arayüzden gelen fare/klavye girdisi (sıralı işlenir) */
  loginInput(events: LoginInput[]): Promise<void> {
    // boş girdi = "görüntüyü yeniden gönder": sonradan bağlanan izleyici (ayrı giriş penceresi) ilk kareyi beklemesin
    if (!events.length) {
      this.lastFrameAt = 0;
      this.embedPage = undefined;
      return this.keepEmbedAlive();
    }
    const run = async () => {
      const page = this.embedPage;
      if (!page || page.isClosed()) throw new Error('Giriş ekranı açık değil');
      for (const ev of events) {
        switch (ev.type) {
          case 'move':
            await page.mouse.move(ev.x, ev.y);
            break;
          case 'down':
            await page.mouse.move(ev.x, ev.y);
            await page.mouse.down({ button: ev.button ?? 'left', clickCount: ev.clicks ?? 1 });
            break;
          case 'up':
            await page.mouse.move(ev.x, ev.y);
            await page.mouse.up({ button: ev.button ?? 'left', clickCount: ev.clicks ?? 1 });
            break;
          case 'wheel':
            await page.mouse.move(ev.x, ev.y);
            await page.mouse.wheel(ev.dx, ev.dy);
            break;
          case 'text':
            // Gerçek tuş olayları (keydown/keypress/input/keyup): insertText yalnız 'input' üretir → kutucuklu doğrulama kodu
            // alanları (Yandex vb.) kodu görüyor ama form geçerli sayılmıyor, "Continue" basılamıyordu. Uzun yapıştırma insertText.
            if (ev.text) {
              const t = ev.text.slice(0, 2000);
              if (t.length <= 200) await page.keyboard.type(t);
              else await page.keyboard.insertText(t);
            }
            break;
          case 'key':
            if (/^((Shift|Control|Alt|Meta|ControlOrMeta)\+)*[\w]{1,16}$/.test(ev.key)) await page.keyboard.press(ev.key);
            break;
        }
      }
    };
    const next = this.inputQ.then(run, run);
    this.inputQ = next.catch((e) => bus.log('warn', `${this.account.platform}: giriş ekranı girdisi uygulanamadı: ${(e as Error).message.split('\n')[0]}`));
    // tıklama sonrası sayfa değişebilir: akışı canlı tut
    if (events.some((e) => e.type === 'up' || e.type === 'key')) setTimeout(() => void this.keepEmbedAlive(), 900);
    return next;
  }

  /** Mivelo içi girişi iptal et */
  loginCancel(): void {
    if (this.embedOn) this.loginAbort = true;
  }

  private async closeCtx(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.page = undefined;
    await ctx?.close().catch(() => undefined);
  }

  private async isLoggedIn(passive = false): Promise<boolean> {
    if (this.pageless && !passive) await this.ensureOpen();
    if (!this.page || this.page.isClosed()) return false;
    try {
      return await this.strategy.loggedIn(this.page, await this.cookies(), passive);
    } catch {
      return false;
    }
  }

  /**
   * Kullanıcı görünür pencerede giriş yapana kadar bekle. Çerezler göründükten sonra
   * platformun izin/onay adımları (2FA, "girişi kaydet", uygulama izinleri) için sayfa
   * birkaç saniye hareketsiz kalana dek bekler, sonra döner.
   */
  /**
   * Kullanıcı giriş penceresini giriş yapmadan kapattı ya da iptal etti: tarayıcı tamamen kapatılır (macOS'ta son pencere
   * kapanınca Chromium açık kalıyordu), hesap "Bağlı değil" olur ve olay yayınlanır — hiç bağlanmamış yeni hesabı registry
   * kaldırır, Bağlan kartı ilk haline döner. Eskiden hesap sonsuza dek "Eşleşme bekleniyor"da kalıyordu.
   */
  private loginCancelledOnce = false;
  /**
   * Görünür giriş penceresi bekçisi (29.09, Kaan: Slack giriş penceresini kapattım, "Bağlanıyor" ve yüzde artmaya devam etti).
   * Pencere, akışın herhangi bir adımında (sayfa yüklenirken, oturum denetimi sürerken — waitForLogin'e gelmeden) kapatılabilir;
   * macOS'ta son pencere kapanınca Chromium ve bağlamı açık kalır, 'close' olayı gelmez. Saniyede bir açık sayfa kalmış mı bakılır;
   * kalmadıysa giriş iptal edilir. Giriş algılanınca (waitForLogin) bekçi durur: sonra kapatmak devam etmeyi engellemez.
   */
  private loginWatchTimer?: NodeJS.Timeout;
  private watchLoginWindow(): void {
    this.stopLoginWatch();
    const ctx = this.ctx;
    let empty = 0;
    this.loginWatchTimer = setInterval(() => {
      if (this.stopping || this.loginCancelledOnce || !ctx || this.ctx !== ctx) return this.stopLoginWatch();
      const open = ctx.pages().filter((p) => !p.isClosed()).length;
      // iki ardışık denetim: OAuth yönlendirmesinde sekme kısa süre kapanıp yenisi açılabilir
      empty = open ? 0 : empty + 1;
      if (empty >= 2) {
        this.stopLoginWatch();
        void this.loginCancelled('giriş penceresi giriş yapılmadan kapatıldı');
      }
    }, 1000);
    this.loginWatchTimer.unref?.();
  }
  private stopLoginWatch(): void {
    if (this.loginWatchTimer) clearInterval(this.loginWatchTimer);
    this.loginWatchTimer = undefined;
  }
  private async loginCancelled(why: string): Promise<void> {
    if (this.loginCancelledOnce) return;
    this.loginCancelledOnce = true;
    this.stopLoginWatch();
    bus.log('info', `${this.account.platform}: ${why}; bağlanma iptal edildi`);
    await this.stopEmbed().catch(() => undefined);
    await this.closeCtx();
    this.unschedule();
    this.setStatus('disconnected', 'Giriş yapılmadı — bağlanmak için Yeniden bağlan');
    bus.emit({ type: 'account.login-cancelled', accountId: this.account.id });
  }

  private async waitForLogin(): Promise<boolean> {
    let ticks = 0;
    while (!this.stopping && !this.loginCancelledOnce) {
      this.adoptNewestPage();
      if (this.embedOn) await this.keepEmbedAlive();
      if (this.loginAbort) {
        this.loginAbort = false;
        await this.loginCancelled('giriş iptal edildi');
        return false;
      }
      if (!this.page || this.page.isClosed()) {
        await this.loginCancelled('giriş penceresi giriş yapılmadan kapatıldı');
        return false;
      }
      if (await this.isLoggedIn(true)) break;
      // ilerleme görünür olsun: 20 sn'de bir hangi sayfada beklendiği
      if (++ticks % 30 === 0) bus.log('info', `${this.account.platform}: giriş bekleniyor (${safeUrl(this.page.url())})`);
      await sleep(700);
    }
    this.stopLoginWatch();
    if (this.stopping || this.loginCancelledOnce) return false;
    bus.log('info', `${this.account.platform}: giriş algılandı (${safeUrl(this.page?.url())}), izin adımları için bekleniyor`);
    // izin ekranları: URL ~1,5 sn değişmeyene ve giriş hâlâ geçerli olana kadar bekle (en fazla 60 sn).
    // Eskiden 2 sn'lik adımlarla 4 sn kararlılık → giriş sonrası pencere 6-8 sn açık kalıyordu.
    let lastUrl = '';
    let stableFor = 0;
    for (let i = 0; i < 120 && !this.stopping; i++) {
      this.adoptNewestPage();
      if (this.embedOn) await this.keepEmbedAlive();
      // giriş algılandıktan sonra pencere kapatıldı (izin adımları beklenmeden): oturum var, devam et
      if (!this.page || this.page.isClosed()) break;
      const url = this.page.url();
      const stillIn = await this.isLoggedIn(true);
      if (url === lastUrl && stillIn) stableFor += 500;
      else stableFor = 0;
      lastUrl = url;
      if (stableFor >= 1500) break;
      await sleep(500);
    }
    return !this.stopping;
  }

  /**
   * Görünür giriş penceresinde site yeni sekme açtıysa (OAuth / "çalışma alanını aç" bağlantıları yeni sekmede
   * açılabilir) girişi o sekmede izle; ilk sekme kapandıysa da kalan sekmeye geç.
   */
  private adoptNewestPage(): void {
    const pages = this.ctx?.pages().filter((p) => !p.isClosed()) ?? [];
    const newest = pages[pages.length - 1];
    if (newest && newest !== this.page && (!this.page || this.page.isClosed() || newest.url() !== 'about:blank')) this.page = newest;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopLoginWatch();
    await this.stopEmbed().catch(() => undefined);
    this.offActive?.();
    this.offActive = undefined;
    await this.api?.dispose().catch(() => undefined);
    this.api = undefined;
    this.pageless = false;
    this.unschedule();
    await this.closeCtx();
    this.setStatus('disconnected');
  }

  /** Strateji çağrıları tek sayfayı paylaşır: yoklama, gönderme ve geçmiş isteği sırayla çalışsın (sayfa gezintisi çakışmasın). */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    // her iş başlamadan önce bekleyen kullanıcı işlemleri (gönderim/tepki) koşar: kuyrukta bekleyen tur/okundu işinin önüne geçer
    const run = async () => {
      await this.runUrgent();
      return fn();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Kullanıcı işlemi (gönderme/tepki): yoklama turu sürüyorsa turun BİTMESİNİ beklemez; tur bir sonraki güvenli noktada
   * (sohbet listesinden sonra, iki mesaj isteği arasında) araya alır. Eskiden gönderim tüm turu (liste + 8 sohbetin mesajları,
   * LinkedIn'de istekler arası 0,4–1,5 sn) bekliyordu; gelen mesajın anlık sinyali tur başlattığı için "cevap verilen ilk
   * mesaj" birkaç saniye gecikiyordu. Tur içinde koşar → sayfa gezintisiyle çakışmaz (eşzamanlı evaluate yarıda kesilmez).
   */
  private inPoll = false;
  private urgentQ: Array<() => Promise<void>> = [];
  private urgent<T>(fn: () => Promise<T>): Promise<T> {
    // Eskiden yalnız tur KOŞARKEN öne geçiyordu: kuyrukta bekleyen tur ya da okundu gezinmesi (5-15 sn) varsa gönderim
    // hepsinin arkasına giriyordu (10-40 sn "Gönderiliyor"). Artık her zaman acil kuyruğa yazılır; tur dışındaysa bir boşaltma
    // adımı da kuyruğa girer — kuyruk boşsa hemen koşar, doluysa o an çalışan iş bitince bekleyenlerin önünde koşar (serial).
    const p = new Promise<T>((resolve, reject) => {
      this.urgentQ.push(() => fn().then(resolve, reject));
    });
    if (!this.inPoll) void this.serial(async () => undefined).catch(() => undefined);
    return p;
  }
  private async runUrgent(clearFlag = false): Promise<void> {
    while (this.urgentQ.length) await this.urgentQ.shift()!();
    // kuyruk boşken bayrak AYNI eşzamanlı adımda iner: arada urgent() kuyruğa yazıp sahipsiz kalmasın
    if (clearFlag) this.inPoll = false;
  }

  async sendText(remoteChatId: string, text: string, opts?: SendOptions): Promise<{ remoteId: string }> {
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    const id = (await this.urgent(async () => this.run((p, c) => this.strategy.send(p, c, remoteChatId, text, opts)))) ?? `local-${Date.now()}`;
    this.sentHere.add(remoteChatId);
    const replyTo = opts?.replyTo && this.strategy.canReply ? { remoteId: opts.replyTo, ...this.replyInfo(remoteChatId, opts.replyTo) } : undefined;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent', threadId: opts?.threadId, replyTo });
    return { remoteId: id };
  }

  /** Yanıtlanan mesajın adı/metni depodan (strateji yalnız kimlik verdiyse doldurmak için) */
  private replyInfo(remoteChatId: string, remoteId: string, given?: { senderName?: string; text?: string }): { senderName: string; text: string; fromMe?: boolean } {
    const q = this.store.getMessage(`${this.account.id}/${remoteChatId}#${remoteId}`);
    return {
      senderName: q ? (q.fromMe ? 'Sen' : q.senderName) : given?.senderName || 'Mesaj',
      text: (q?.text || q?.attachments?.[0]?.name || given?.text || '').slice(0, 160),
      fromMe: q?.fromMe,
    };
  }

  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    if (!this.strategy.react) throw new Error('Bu platformda tepki desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    await this.urgent(async () => this.run((p, c) => this.strategy.react!(p, c, remoteChatId, remoteMsgId, emoji, remove)));
  }

  /** Herkesten sil: strateji destekliyorsa (depo güncellemesi sunucuda) */
  async deleteMessage(remoteChatId: string, remoteId: string): Promise<void> {
    if (!this.strategy.unsend) throw new Error('Bu platformda mesaj silme desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    await this.urgent(async () => this.run((p, c) => this.strategy.unsend!(p, c, remoteChatId, remoteId)));
  }

  /** Metni düzenle: strateji destekliyorsa (depo güncellemesi sunucuda) */
  async editMessage(remoteChatId: string, remoteId: string, text: string): Promise<void> {
    if (!this.strategy.edit) throw new Error('Bu platformda mesaj düzenleme desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    await this.urgent(async () => this.run((p, c) => this.strategy.edit!(p, c, remoteChatId, remoteId, text)));
  }

  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (!this.strategy.sendFile) throw new Error('Bu platformda dosya gönderme desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    const id = (await this.urgent(async () => this.run((p, c) => this.strategy.sendFile!(p, c, remoteChatId, file, caption)))) ?? `local-${Date.now()}`;
    this.sentHere.add(remoteChatId);
    const kind = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: caption ?? '', ts: Date.now(), status: 'sent', attachments: [{ kind, name: file.name, mime: file.mime, size: file.size }] });
    return { remoteId: id };
  }

  async compose(d: ComposeDraft): Promise<Chat> {
    if (!this.strategy.compose) throw new Error('Bu hesapta yeni e-posta oluşturma desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    const to = d.to.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Geçerli bir e-posta adresi yaz');
    const id = (await this.serial(async () => this.run((p, c) => this.strategy.compose!(p, c, { ...d, to })))) ?? `out-${createHash('sha1').update(`${to}|${d.subject}|${Date.now()}`).digest('hex').slice(0, 16)}`;
    const chat = this.upsertChat({ remoteId: id, name: d.subject.trim() || '(konu yok)', kind: 'direct', handle: to, participants: [{ id: to.toLowerCase(), name: to }] });
    this.upsertMessage({ remoteChatId: id, remoteId: `local-${Date.now()}`, senderId: 'me', senderName: 'Ben', fromMe: true, text: d.text, ts: Date.now(), status: 'sent' });
    return this.store.getChat(chat.id) ?? chat;
  }

  /** Klasör bilgisi: gelen kutusunda görülen bir dizi, Gönderilenler/Gereksiz listesinde de çıksa gelen kutusundan düşmez */
  private folderMeta(remoteId: string, meta?: Record<string, unknown>, chat?: Chat): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    const ex = (chat ?? this.store.getChat(chatId(this.account.id, remoteId)))?.meta;
    if (ex?.folder === 'inbox' && meta.folder !== 'inbox') return ex;
    return { ...ex, ...meta };
  }

  private morePage = 0;
  async loadMoreChats(): Promise<number> {
    if (!this.strategy.moreThreads) throw new Error('Bu platformda daha eski sohbet listesi desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    const idx = this.morePage + 1;
    const threads = await this.serial(async () => withTimeout(this.run((p, c) => this.strategy.moreThreads!(p, c, idx)), 60_000, 'eski sohbetler'));
    let added = 0;
    for (const t of threads) {
      if (!this.store.getChat(chatId(this.account.id, t.id))) added++;
      this.upsertChat({ remoteId: t.id, name: t.name, kind: t.kind, unread: t.unread, lastMessageAt: t.lastTs || undefined, lastPreview: t.preview || undefined, avatarUrl: t.avatarUrl, handle: t.handle, link: t.link, participants: t.participants, meta: this.folderMeta(t.id, t.meta) });
    }
    if (threads.length) this.morePage = idx;
    return added;
  }

  /**
   * Mivelo'da okunan sohbetler: platform yoklaması bir süre eski 'okunmamış' değeriyle geri açmasın (platform okunduyu
   * geç işler ya da işaretleme başarısız olursa yeniden denenir). remoteId → {at, lastTs, retries}
   */
  private localRead = new Map<string, { at: number; lastTs: number; retries: number }>();
  async markRead(remoteChatId: string): Promise<void> {
    const chat = this.store.getChat(chatId(this.account.id, remoteChatId));
    this.localRead.set(remoteChatId, { at: Date.now(), lastTs: chat?.lastMessageAt ?? Date.now(), retries: 0 });
    if (!this.strategy.markRead || (!this.pageless && !(await this.ensureOpen()))) return;
    // hızlı gezinmede aynı sohbet için birden çok okundu gezinmesi kuyruğa girmesin
    if (this.pendingRead.has(remoteChatId)) return;
    this.pendingRead.add(remoteChatId);
    await this.serial(async () => {
      this.pendingRead.delete(remoteChatId);
      const last = this.store.listMessages(chatId(this.account.id, remoteChatId), 30).filter((m) => !m.fromMe).pop();
      return withTimeout(this.run((p, c) => this.strategy.markRead!(p, c, remoteChatId, last?.remoteId)), 30_000, 'okundu');
    });
  }

  async openDirect(p: Participant): Promise<string> {
    if (!this.strategy.openDirect) throw new Error('Bu platformda doğrudan sohbet açma desteklenmiyor');
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    return this.serial(async () => withTimeout(this.run((pg, c) => this.strategy.openDirect!(pg, c, p)), 60_000, 'sohbet açma'));
  }

  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    // Sayfasız modda (Instagram, Slack) this.page yoktur: istek Node'dan atılır; sayfalı modda tarayıcı açık olmalı
    if (!this.pageless && !(await this.ensureOpen())) throw new Error('Tarayıcı oturumu açık değil');
    const msgs = await this.serial(async () => withTimeout(this.run((p, c) => this.strategy.messages(p, c, remoteChatId, limit, before)), 60_000, 'eski mesajlar'));
    for (const m of msgs) this.ingest(remoteChatId, m, false);
  }

  /**
   * Oturum çerezleriyle medya indir (X'in DM görselleri, Instagram CDN'i vb. arayüzden doğrudan açılamaz).
   * Disk önbelleği: ~/.mivelo/sessions/<hesap>/media/<sha1>. CDN bağlantıları süreli olduğundan
   * bir kez inen dosya sonra da gösterilebilir.
   */
  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    const dir = path.join(sessionDir(this.account.id), 'media');
    const key = createHash('sha1').update(url).digest('hex');
    const file = path.join(dir, key);
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) {
      return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    }
    if (!this.ctx && !this.api) return undefined;
    let body: Buffer;
    let type: string;
    if (!/^https?:\/\//.test(url)) {
      // özel şema: stratejinin kancası (sayfa bağlamından okur; tek sayfayı paylaştığı için sırayla)
      if (!this.strategy.fetchMedia || (!this.pageless && !(await this.ensureOpen()))) return undefined;
      const r = await this.serial(async () => withTimeout(this.run((p, c) => this.strategy.fetchMedia!(p, c, url)), 30_000, 'medya'));
      if (!r) return undefined;
      ({ body, type } = r);
    } else {
      // Yönlendirmeler elle takip edilir: her sıçramada host allowlist'e vurulur (açık yönlendirme → iç ağ/SSRF olmasın)
      const client = this.api ?? this.ctx!.request;
      let cur = url;
      let r: Awaited<ReturnType<typeof client.get>> | undefined;
      for (let hop = 0; hop < 5; hop++) {
        r = await client.get(cur, { timeout: 25_000, maxRedirects: 0, headers: { referer: new URL(this.strategy.home).origin + '/' } });
        const loc = r.headers()['location'];
        if (r.status() >= 300 && r.status() < 400 && loc) {
          const next = new URL(loc, cur);
          if (!/^https?:$/.test(next.protocol) || !mediaHostAllowed(this.account.platform, next.hostname)) throw new Error(`yönlendirme izinli değil: ${next.hostname}`);
          cur = next.toString();
          continue;
        }
        break;
      }
      if (!r || !r.ok()) throw new Error(`medya ${r?.status() ?? '?'}`);
      const len = Number(r.headers()['content-length'] ?? 0);
      if (len > MEDIA_MAX) throw new Error('medya çok büyük');
      body = await r.body();
      if (body.length > MEDIA_MAX) throw new Error('medya çok büyük');
      type = r.headers()['content-type'] ?? 'application/octet-stream';
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.type', type);
    return { body, type };
  }

  /** Uzak medya adresini çekirdeğin vekil yoluna çevir (arayüz API_BASE ile önekler). */
  private proxied(u: string | undefined): string | undefined {
    // http(s) adresleri ve stratejiye özel şemalar ("xc:…") vekilden geçer; vekil yolu / data: / blob: olduğu gibi kalır
    if (!u || u.startsWith('/') || /^(data|blob):/.test(u)) return u;
    return `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(u)}`;
  }

  private async cookies(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (this.pageless && this.api) {
      this.state = await this.api.storageState().catch(() => this.state);
      for (const c of this.state?.cookies ?? []) out[c.name] = c.value;
      return out;
    }
    for (const c of (await this.ctx?.cookies()) ?? []) out[c.name] = c.value;
    return out;
  }

  /**
   * Yoklama zamanlayıcısı: sabit setInterval yerine her tur ±%30 sapmalı setTimeout. Saat gibi düzenli istek deseni
   * otomasyon imzasıdır (LinkedIn/X/Instagram/Slack); ayrıca önceki tur bitmeden yenisi planlanmaz.
   */
  private schedule(delay?: number): void {
    this.unschedule();
    const t: NodeJS.Timeout = setTimeout(async () => {
      this.soonAt = 0;
      await this.poll(false).catch(() => undefined);
      if (this.timer !== t || this.stopping) return;
      if (this.pendingPoll) {
        // tur sürerken anlık sinyal geldi: eskiden sabit 10–15 sn bekleniyordu (sinyal→mesaj gecikmesine 10+ sn ekliyordu);
        // artık öne çekilmiş tur kuralı: 1,5–4 sn, turların başlangıçları arası ≥10 sn
        this.pendingPoll = false;
        this.nextReason = this.pendingReason ?? this.nextReason;
        this.pendingReason = undefined;
        this.soonAt = Date.now() + this.soonDelay();
        this.schedule(this.soonDelay());
      } else this.schedule();
    }, Math.round(delay ?? this.nextDelay()));
    this.timer = t;
  }

  /**
   * Sıradaki tur: temel aralık (arayüz boştaysa idlePollMs), anlık akış son 5 dk'da canlıysa 3 katı (yeni mesaj zaten
   * akıştan haber verir; yoklama yalnız yedek), üstüne ±%30 sapma.
   */
  private nextDelay(): number {
    // ilk eşitleme: mesajları alınmamış sohbetler bitene dek kısa aralık (istek hızı yine sınırlı: tur başına 8 sohbet)
    if (this.backlogLeft > 0 && this.opts.backfillMs && Date.now() >= this.backoffUntil) return Math.min(this.opts.backfillMs, this.pollMs) * (0.7 + Math.random() * 0.6);
    const base = this.opts.idlePollMs && !isUiActive() ? this.opts.idlePollMs : this.pollMs;
    // tarayıcı boşta kapalıysa (unloadWhenIdle) izleyici çalışmıyor: seyrekleştirme yok
    const live = !this.idleClosed && !this.pageless && this.rtEventAt > 0 && Date.now() - this.rtAliveAt < 5 * 60_000;
    const rt = live ? (this.opts.rtSlowdown ?? 3) : 1;
    return base * rt * (0.7 + Math.random() * 0.6);
  }

  private unschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Hesap adı açılışta okunamadıysa (etiket genel: "Instagram", "Messenger"…) bağlıyken 10 dk'da bir yeniden dene */
  private labelTriedAt = 0;
  private async refreshLabel(): Promise<void> {
    if (this.account.status !== 'connected' || Date.now() - this.labelTriedAt < 10 * 60_000) return;
    const cur = (this.account.label ?? '').trim();
    if (cur && cur !== this.account.platform && !GENERIC_LABEL.test(cur)) return;
    this.labelTriedAt = Date.now();
    try {
      const me = await withTimeout(this.strategy.me(this.target(), await this.cookies()), 15_000, 'hesap adı');
      if (!me.label || GENERIC_LABEL.test(me.label.trim())) return;
      this.account.label = me.label;
      this.store.upsertAccount(this.account);
      bus.emit({ type: 'account.status', account: { ...this.account } });
    } catch {
      /* sonraki denemede */
    }
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || Date.now() < this.backoffUntil) return;
    // keepOpen: sayfasız (API) moddaki kanal için sayfa açılır → sayfanın kendi anlık soketi dinlenebilir
    if (this.pageless && this.wantPage() && this.account.status === 'connected') await this.ensureOpen().catch(() => false);
    if ((!this.page || this.page.isClosed()) && !this.pageless && !(await this.ensureOpen())) return;
    this.polling = true;
    this.lastPollAt = Date.now();
    this.turnReason = this.nextReason ?? { kind: 'zamanlayıcı', at: Date.now() };
    this.nextReason = undefined;
    this.freshIn = [];
    const turnStart = Date.now();
    try {
      await this.serial(async () => {
        this.inPoll = true;
        try {
          await this.pollInner(first);
          this.logFresh(turnStart);
          await this.refreshLabel();
        } finally {
          // turun sonunda bekleyen kullanıcı işlemi kalmasın (boşaltma ile bayrak arasında await yok)
          await this.runUrgent(true).catch(() => undefined);
          this.inPoll = false;
        }
      });
      // API tabanlı kanal: ilk başarılı yoklamadan sonra tarayıcı kapanır; sayfasızda çerezler her yoklamada diske
      if (this.strategy.pageless && !this.wantPage() && this.account.status === 'connected' && !this.stopping) {
        if (this.ctx) await this.serial(() => this.goPageless()).catch((e) => bus.log('warn', `${this.account.platform}: sayfasız moda geçilemedi: ${(e as Error).message}`));
        else if (this.api) this.saveState(await this.api.storageState().catch(() => this.state!));
      }
      // Boşta boşaltma: sekme kapatmak/about:blank render sürecini bırakmıyor (service worker, site izolasyonu); tarayıcıyı
      // tamamen kapat, sonraki yoklama/işlem yeniden açar (kalıcı profil oturumu korur; açılış ~3-5 sn)
      if (this.strategy.attention && this.page && !this.page.isClosed() && this.account.status === 'connected')
        this.setAttention(await this.strategy.attention(this.page).catch(() => undefined));
      await this.maybeSoftReload();
      const keep = this.wantPage();
      if (this.strategy.unloadWhenIdle && !keep && this.ctx && this.account.status === 'connected' && !this.stopping) {
        await this.serial(() => this.closeCtx()).catch(() => undefined);
        this.idleClosed = true;
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollInner(first: boolean): Promise<void> {
    if (!this.pageless && (!this.page || this.page.isClosed())) return;
    const page = this.target();
    try {
      const cookies = await this.cookies();
      // Strateji çağrıları asılı kalmasın: sayfa donarsa uyarı düşsün, sonraki yoklama devam etsin
      const threads = await withTimeout(this.strategy.threads(page, cookies), 120_000, 'sohbet listesi');
      await this.runUrgent();
      if (first) this.syncProgress(70, `${threads.length} sohbet, mesajlar alınıyor`);
      const changed: Thread[] = [];
      const retryRead: string[] = [];
      /** tur başındaki okunmamış (tepki yalnız etkinlikse geri dönülür) */
      const prevUnread = new Map<string, number>();
      for (const t of threads) {
        // lastTs=0: strateji zaman bilgisi vermiyor (DOM okuyan Messenger) → depodaki değer korunur
        // Mivelo'da okunan sohbeti platformun eski 'okunmamış' değeri geri açmasın: yalnızca yeni etkinlikte aktar
        const ex = this.store.getChat(chatId(this.account.id, t.id));
        // lastTs=0 (DOM okuyan Messenger): çekirdek yeniden başladıysa platformun okunmamış durumu depoya aktarılsın
        // ilk yoklamada (açılış) platformun okunmamış/önizleme değeri yetkili; sonra yalnızca yeni etkinlikte
        const fresh = first || !ex || t.lastTs > ex.lastMessageAt || !ex.lastPreview;
        // okunmamış platformun değeri (telefonda okunan burada da okunur); Mivelo'da okunan sohbeti depo kalıcı olarak korur
        // (chats.read_upto: yeni mesaj gelmedikçe platform geri açamaz). Platform hâlâ 'okunmamış' diyorsa işaretleme 2 kez yinelenir.
        // son etkinliği tepki olan sohbet: yeni etkinlik gelene dek platformun "okunmamış"ı yok sayılır
        // Tepki durumu yalnız bellekteydi: çekirdek yeniden başlayınca tepki alan sohbet ilk turda platformun "okunmamış"ı ve
        // eski mesaj önizlemesiyle geri geliyordu. Depodaki last_reaction açılışta belleğe geri yüklenir (yeni etkinlik gelmediyse).
        if (first && ex?.lastReaction && !this.reactionOnly.has(t.id) && t.lastTs && t.lastTs <= ex.lastMessageAt) this.reactionOnly.set(t.id, ex.lastMessageAt);
        const rxAt = this.reactionOnly.get(t.id);
        if (rxAt !== undefined && t.lastTs > rxAt) this.reactionOnly.delete(t.id);
        const quiet = this.reactionOnly.has(t.id) || !!t.reactionPreview;
        const unread = quiet ? Math.min(t.unread, ex?.unread ?? 0) : t.unread;
        prevUnread.set(t.id, ex?.unread ?? 0);
        const lr = this.localRead.get(t.id);
        if (lr) {
          if (t.lastTs > lr.lastTs + 1000 || t.unread === 0) this.localRead.delete(t.id);
          else if (lr.retries < 2) {
            lr.retries++;
            retryRead.push(t.id);
          }
        }
        // sessiz (son etkinliği tepki) sohbette platform önizlemesi tepki önizlemesini ve last_reaction'ı ezmesin
        const lastPreview = fresh && !quiet ? t.preview || undefined : undefined;
        const meta = this.folderMeta(t.id, t.meta, ex);
        // Değişmeyen sohbet yeniden yazılmaz: her turda tüm liste (Slack/X yüzlerce sohbet) ayrı ayrı yazılıp chat.upsert
        // olarak yayınlanıyordu (1000 sohbette ≈140 ms tek parça kilit + 1000 olay; arayüz listeyi boşuna yeniden çiziyordu)
        if (first || !ex || this.chatDiffers(ex, t, unread, lastPreview, meta))
          this.upsertChat({ remoteId: t.id, name: t.name, kind: t.kind, unread, lastMessageAt: t.lastTs || undefined, lastPreview, avatarUrl: t.avatarUrl, handle: t.handle, link: t.link, participants: t.participants, meta });
        if (t.reactionPreview && fresh) {
          this.reactionPreview(t.id, t.reactionPreview);
          this.reactionOnly.set(t.id, t.lastTs);
        }
        if (t.readByOthersUpTo) this.outgoingRead(t.id, t.readByOthersUpTo);
        // eski kimlikli kopya (hedef sohbet yukarıda yazıldı)
        for (const a of t.aliases ?? []) {
          const from = chatId(this.account.id, a);
          if (a !== t.id && this.store.getChat(from)) {
            this.store.mergeChats(from, chatId(this.account.id, t.id));
            bus.emit({ type: 'chat.delete', chatId: from });
          }
        }
        // Yeniden başlatma (çekirdek/iyileşme/Yeniden bağlan): known boş başlıyordu → mesajları depoda olan TÜM sohbetler yeniden
        // çekiliyordu (Slack'te hız sınırı, e-posta tarayıcı yollarında her dizi açılıp okundu→okunmadı geri alınıyordu). Depodaki
        // en yeni mesaj platformun son etkinliğine yetişmişse sohbet güncel sayılır. lastTs=0 (zaman vermeyen DOM stratejisi) eski
        // davranışta kalır: önizleme karşılaştırması güvenilir değil (değişim turunda depo önizlemesi zaten yeni değere yazılıyor).
        if (!this.known.has(t.id) && ex && t.lastTs > 0 && !this.localRead.has(t.id) && !this.pendingFetch.has(t.id) && !this.sentHere.has(t.id)) {
          const newest = this.store.listMessages(chatId(this.account.id, t.id), 1)[0]?.ts ?? 0;
          if (newest > 0 && newest >= t.lastTs - 1000) this.known.set(t.id, t.lastTs);
        }
        const pf = this.pendingFetch.get(t.id);
        // yarım boşluk da 'değişti' sayılır; ama hata alan sohbetin üstel beklemesini (pendingFetch) atlamaz
        const due = !pf || Date.now() >= pf.next;
        if (!this.known.has(t.id) || (this.known.get(t.id) ?? 0) < t.lastTs || (pf && due) || (this.gapFill.has(t.id) && due)) changed.push(t);
      }
      for (const id of retryRead.slice(0, 3)) {
        // okundu gezintisi (Instagram 7+ sn, Messenger ≤15 sn) arka arkaya koşmasın: bekleyen gönderim araya girsin
        await this.runUrgent();
        try {
          const last = this.store.listMessages(chatId(this.account.id, id), 30).filter((m) => !m.fromMe).pop();
          if (this.strategy.markRead) await this.run((p, c) => this.strategy.markRead!(p, c, id, last?.remoteId));
          bus.log('info', `${this.account.platform}: okundu işareti yinelendi (${id.slice(0, 24)})`);
        } catch (e) {
          bus.log('warn', `${this.account.platform}: okundu yinelenemedi: ${(e as Error).message.split('\n')[0].slice(0, 120)}`);
        }
      }
      // öncelik: okunmamış, sonra en yeni etkinlik (kullanıcının bakacağı sohbetler önce dolsun)
      changed.sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || (b.lastTs || 0) - (a.lastTs || 0));
      const batch = changed.slice(0, first ? 16 : 8);
      // tur sınırı dışında kalanlar: değişim sinyali kaybolmasın (sonraki turda lastTs=0 dönse de çekilir)
      for (const t of changed.slice(batch.length)) if (!this.pendingFetch.has(t.id)) this.pendingFetch.set(t.id, { tries: 0, next: 0 });
      const tried = new Set<string>();
      const monthAgo = Date.now() - 30 * 86_400_000;
      this.backlogLeft = changed.slice(batch.length).filter((t) => t.unread > 0 || !t.lastTs || t.lastTs > monthAgo).length;
      const failed: string[] = [];
      let firstErr = '';
      /** sohbet mesajlarında doğrulama/hız sınırı: tur sonunda yeniden fırlatılır → aşağıdaki catch durdurur/geri çekilir */
      let fatalErr = '';
      // API stratejileri en çok 2'li paralel (patlamalı istek deseni hız sınırı/otomasyon algısını tetikler); DOM okuyanlar sıralı
      const width = this.strategy.parallel ? 2 : 1;
      for (let i = 0; i < batch.length; i += width) {
        await this.runUrgent();
        await Promise.all(
          batch.slice(i, i + width).map(async (t) => {
            tried.add(t.id);
            try {
              const limit = first ? 25 : 15;
              const msgs = await withTimeout(this.strategy.messages(page, cookies, t.id, limit), 60_000, 'mesajlar');
              this.turnReacted.delete(t.id);
              this.turnIncoming.delete(t.id);
              // boşluk denetimi ingest'ten ÖNCE (sonra hepsi "bilinen" olur)
              const gap = this.gapFill.get(t.id) ?? this.detectGap(t.id, msgs, limit);
              for (const m of msgs) this.ingest(t.id, m, !first && !this.hasMessage(t.id, m.id));
              if (gap) {
                // önce kaydet (tur sayılmış olarak): fillGap hata verirse ilk sayfa zaten depoda → detectGap boşluğu bir daha
                // göremezdi; kayıt sonraki turda sürsün, hata döngüsü de 4 turla sınırlı kalsın
                if (gap.turns + 1 >= 4) this.gapFill.delete(t.id);
                else this.gapFill.set(t.id, { ...gap, turns: gap.turns + 1 });
                await this.fillGap(page, cookies, t.id, gap, () => !!fatalErr);
              }
              this.known.set(t.id, t.lastTs);
              this.pendingFetch.delete(t.id);
              if (!first) this.settleReaction(t, prevUnread.get(t.id) ?? 0);
            } catch (e) {
              failed.push(t.id);
              this.fetchFailed(t.id);
              const em = (e as Error).message;
              firstErr ||= em;
              if (!fatalErr && (VERIFY_RE.test(em) || RATE_RE.test(em))) fatalErr = em;
            }
          }),
        );
        if (fatalErr) break; // hız sınırı/doğrulamada kalan sohbetlere istek atma
      }
      // denenmeden kalanlar (hız sınırı/doğrulama sonrası): deneme sayılmadan bekleyen listesinde kalsın
      for (const t of batch) if (!tried.has(t.id) && !this.pendingFetch.has(t.id)) this.pendingFetch.set(t.id, { tries: 0, next: 0 });
      // aynı hata her sohbet için ayrı satır basmasın: yoklama başına tek özet
      if (failed.length) bus.log('warn', `${this.account.platform} mesajlar alınamadı: ${failed.length}/${batch.length} sohbet (ilk: ${failed[0]}): ${firstErr}`);
      if (fatalErr) throw new Error(fatalErr);
      if (first) bus.log('info', `${this.account.platform}: ${threads.length} sohbet yüklendi`);
      // yalnız en az bir sohbet başarılıysa (ya da istenecek sohbet yoksa) başarılı tur sayılır
      if (!batch.length || failed.length < batch.length) this.rateHits = 0;
    } catch (e) {
      bus.log('warn', `${this.account.platform} yoklama: ${(e as Error).message}`);
      const msg = (e as Error).message;
      // Doğrulama/kilit sayfası (checkpoint, captcha, X /account/access, Google "kimliğinizi doğrulayın"): ısrar etmek
      // kısıtlamayı yasağa çevirebilir → otomatik yoklamayı tamamen durdur, kullanıcı görünür pencerede çözsün
      if (VERIFY_RE.test(msg)) {
        this.unschedule();
        bus.log('warn', `${this.account.platform}: platform doğrulama istedi, otomatik yoklama durduruldu`);
        this.setStatus('pairing', 'Platform güvenlik doğrulaması istiyor; kanala sağ tıklayıp "Yeniden bağlan" de ve doğrulamayı tamamla');
        return;
      }
      // 429 / LinkedIn 999 / Slack ratelimited: üstel geri çekilme (5 dk, 10, 20 … ≤ 2 sa)
      if (RATE_RE.test(msg)) {
        this.rateHits += 1;
        const mins = Math.min(5 * 2 ** (this.rateHits - 1), 120);
        this.backoffUntil = Date.now() + mins * 60_000;
        bus.log('warn', `${this.account.platform}: hız sınırı, ${mins} dk beklenecek`);
        return;
      }
      // Ağ hatası (çevrimdışı, DNS, bağlantı koptu) oturum düşmesi değildir: Chromium açıp oturum denetlemek (sayfasız kanalda
      // her turda tarayıcı açılışı) ve 'pairing' → iyileşme → sayfasız 'connected' → yine düşüş döngüsü yerine kısa geri çekilme
      if (NET_RE.test(msg)) {
        this.backoffUntil = Date.now() + 60_000;
        return;
      }
      if (!(await this.isLoggedIn())) {
        bus.log('warn', `${this.account.platform}: oturum düşmüş, yeniden giriş gerekli`);
        this.unschedule();
        this.polling = false;
        this.pendingFetch.clear();
        this.gapFill.clear();
        // Sayfasız kanalın kayıtlı durumu artık geçersiz: iyileşme denemesi tarayıcı yolundan gerçek oturum denetimiyle açılsın
        // (yoksa sayfasız açılış oturumu doğrulamadan 'connected' yayınlıyor, iyileşme sayacı sıfırlanıp sonsuz döngü oluyordu)
        if (this.strategy.pageless) fs.rmSync(this.stateFile, { force: true });
        await this.closeCtx();
        this.setStatus('pairing', 'Oturum düştü — kanala sağ tıklayıp "Yeniden bağlan" de');
        return;
      }
    }
  }

  /** Strateji `before` (eski mesaj sayfası) parametresini alıyor mu (imzada 5. parametre) */
  private get canPageBack(): boolean {
    return this.strategy.messages.length >= 5;
  }

  /**
   * Boşluk: sohbetin depoda mesajı var, gelen sayfa dolu (limit kadar), hiçbiri bilinmiyor ve en eskisi depodaki en yenisinden
   * yeni → aradaki mesajlar alınmadı. Kendi gönderimim (depoda şimdiki zamanla) boşluk sanılmaz: en yeni depo ts'i onu kapsar.
   */
  private detectGap(threadId: string, msgs: Msg[], limit: number): { before: number; floor: number; turns: number } | undefined {
    if (!this.canPageBack || msgs.length < limit) return undefined;
    const floor = this.store.listMessages(chatId(this.account.id, threadId), 1)[0]?.ts ?? 0;
    if (!floor) return undefined;
    if (msgs.some((m) => this.hasMessage(threadId, m.id))) return undefined;
    const tss = msgs.map((m) => m.ts).filter((x) => x > 0);
    if (!tss.length) return undefined;
    const oldest = Math.min(...tss);
    return oldest > floor ? { before: oldest, floor, turns: 0 } : undefined;
  }

  /**
   * Boşluğu `before` ile geriye sayfalayarak kapat: tur başına ≤5 sayfa, sayfalar arası 0,4–1,5 sn (ban önleme); her istekten
   * önce bekleyen gönderim araya girer. Bilinen mesaja/depodaki en yeni zamana ya da boş sayfaya varınca biter; bitmezse
   * kaldığı yer `gapFill`'de kalır ve sonraki turlarda sürer (en çok 4 tur). Hız sınırı/doğrulama hatası yukarıya (fatalErr) gider.
   */
  private async fillGap(page: Page, cookies: Record<string, string>, threadId: string, gap: { before: number; floor: number; turns: number }, stop: () => boolean): Promise<void> {
    let before = gap.before;
    let done = false;
    let got = 0;
    for (let i = 0; i < 5 && !done; i++) {
      // paralel komşu sohbette hız sınırı/doğrulama çıktıysa daha fazla istek atma (kalan yer gapFill'de)
      if (stop()) break;
      await this.runUrgent();
      await sleep(400 + Math.random() * 1100);
      const page2 = await withTimeout(this.strategy.messages(page, cookies, threadId, 50, before), 60_000, 'boşluk mesajları');
      const older = page2.filter((m) => !m.ts || m.ts < before);
      if (!older.length) { done = true; break; }
      let reached = false;
      for (const m of older) {
        if (this.hasMessage(threadId, m.id) || (m.ts > 0 && m.ts <= gap.floor)) reached = true;
        // live=false: boşluktaki eski mesajlar tek tek bildirim/"yeni mesaj" sayılmasın (en yeni sayfa zaten canlı işlendi)
        this.ingest(threadId, m, false);
        got++;
      }
      const tss = older.map((m) => m.ts).filter((x) => x > 0);
      const next = tss.length ? Math.min(...tss) : before;
      if (reached || next >= before) done = true;
      before = next;
    }
    if (got) bus.log('info', `${this.account.platform}: boşluk dolduruldu (${got} mesaj${done ? '' : ', sürüyor'})`);
    if (done || gap.turns + 1 >= 4) this.gapFill.delete(threadId);
    else this.gapFill.set(threadId, { before, floor: gap.floor, turns: gap.turns + 1 });
  }

  /**
   * Tanı satırı: bu turda karşı taraftan gelen yeni mesaj(lar) varsa, mesajın platform zamanından Mivelo'da görünene kadar
   * geçen süre ve bunun parçaları (tetik ne zaman geldi, tur ne kadar sürdü). "anlık sinyal yok" → sinyal kaçırılıyor.
   */
  private logFresh(turnStart: number): void {
    if (!this.freshIn.length) return;
    const now = Date.now();
    const oldest = Math.min(...this.freshIn);
    const r = this.turnReason;
    const s = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)} sn`;
    const rt = this.rtAliveAt ? (this.rtEventAt ? `akış canlı, son olay ${s(now - this.rtEventAt)} önce` : 'akış canlı ama mesaj olayı hiç görülmedi') : 'anlık akış yok';
    bus.log(
      'info',
      `${this.account.platform}: gecikme ${s(now - oldest)} (${this.freshIn.length} yeni mesaj) — tetik: ${r?.kind ?? '?'}${r ? ` (mesajdan ${s(r.at - oldest)} sonra)` : ''}, tur ${s(now - turnStart)} · ${rt}`,
    );
  }

  /**
   * Turda yeni gelen mesaj yoksa ve bir mesaja yeni tepki geldiyse (ya da platform önizlemesi tepkiyi anlatıyorsa): önizleme
   * "❤️ Ayşe mesajına tepki verdi", okunmamış tur başındaki değerine döner (platform tepkiyi "okunmamış" sayabiliyor).
   */
  private settleReaction(t: Thread, before: number): void {
    let text = this.turnReacted.get(t.id);
    // platform önizlemesi tepkiyi anlatıyor — ama son mesajın kendi metniyse ("I reacted…" diye yazılmış mesaj) tepki sayılmaz
    if (!text && REACTION_PREVIEW_RE.test(t.preview) && this.store.listMessages(chatId(this.account.id, t.id), 1)[0]?.text.trim() !== t.preview.trim()) text = t.preview;
    const incoming = this.turnIncoming.has(t.id);
    this.turnReacted.delete(t.id);
    this.turnIncoming.delete(t.id);
    if (!text || incoming || t.reactionPreview) return;
    this.reactionPreview(t.id, text);
    this.reactionOnly.set(t.id, t.lastTs);
    const cur = this.store.getChatLite(chatId(this.account.id, t.id));
    if (cur && cur.unread > before) this.upsertChat({ remoteId: t.id, name: cur.name, unread: before });
  }

  /** Mesajları alınamayan sohbet: üstel bekleme (30 sn·2^n ≤ 30 dk); 6 denemeden sonra bırakılır (bir kez günlük) */
  private fetchFailed(id: string): void {
    const p = this.pendingFetch.get(id) ?? { tries: 0, next: 0 };
    p.tries++;
    if (p.tries >= 6) {
      this.pendingFetch.delete(id);
      bus.log('warn', `${this.account.platform}: sohbet mesajları ${p.tries} denemede alınamadı, yeni etkinliğe dek bırakıldı (${id.slice(0, 24)})`);
      return;
    }
    p.next = Date.now() + Math.min(30_000 * 2 ** p.tries, 30 * 60_000);
    this.pendingFetch.set(id, p);
  }

  /** Platformun verdiği sohbet depodakinden farklı mı (değilse yazım ve chat.upsert yayını atlanır) */
  private chatDiffers(ex: Chat, t: Thread, unread: number, lastPreview: string | undefined, meta: Record<string, unknown> | undefined): boolean {
    if (t.lastTs && t.lastTs > ex.lastMessageAt) return true;
    if (unread !== ex.unread) return true;
    if ((t.name && t.name !== ex.name) || (t.kind && t.kind !== ex.kind)) return true;
    if ((t.avatarUrl && t.avatarUrl !== ex.avatarUrl) || (t.handle && t.handle !== ex.handle) || (t.link && t.link !== ex.link)) return true;
    if (lastPreview !== undefined && trReactionText(lastPreview) !== ex.lastPreview) return true;
    if (meta && JSON.stringify(meta) !== JSON.stringify(ex.meta ?? null)) return true;
    // katılımcılar en sonda: depodan çözmek pahalı
    if (t.participants && JSON.stringify(t.participants) !== JSON.stringify(ex.participants ?? null)) return true;
    return false;
  }

  private ingest(threadId: string, m: Msg, live: boolean): void {
    if (!m.text && !m.attachments?.length) return;
    // karşı taraftan var olan bir mesaja yeni tepki (ilk eşitlemede değil: o zaman her şey "yeni")
    if (m.reactions?.length) {
      const prev = this.store.getMessage(messageId(chatId(this.account.id, threadId), m.id));
      if (prev) {
        const had = new Set((prev.reactions ?? []).map((r) => `${r.senderId}|${r.emoji}`));
        const fresh = m.reactions.find((r) => !r.fromMe && !had.has(`${r.senderId}|${r.emoji}`));
        if (fresh) this.turnReacted.set(threadId, `${fresh.emoji} ${(fresh.senderName || 'Biri').split(/\s+/)[0]} mesajına tepki verdi`);
      }
    }
    if (live && !m.fromMe) this.turnIncoming.add(threadId);
    // tanı: canlı ve yeni, karşı taraftan (son 10 dk içinde gönderilmiş) mesaj
    if (live && !m.fromMe && m.ts && Date.now() - m.ts < 10 * 60_000) this.freshIn.push(m.ts);
    // Platformun okunmamış sayısı yetkili (threads() ile yazılır); canlı mesaj burada ayrıca +1 yapmasın (çift sayım)
    this.upsertMessage(
      {
        remoteChatId: threadId,
        remoteId: m.id,
        senderId: m.fromMe ? 'me' : m.senderId,
        senderName: m.fromMe ? 'Ben' : m.senderName,
        fromMe: m.fromMe,
        text: m.text,
        ts: m.ts,
        status: m.status ?? (m.fromMe ? 'sent' : 'delivered'),
        senderAvatarUrl: m.senderAvatarUrl,
        attachments: m.attachments?.length ? m.attachments.map((a) => ({ ...a, url: this.proxied(a.url), link: isMediaFile(a.link) ? this.proxied(a.link) : a.link })) : undefined,
        reactions: m.reactions,
        threadId: m.threadId,
        replyCount: m.replyCount,
        replyTo: m.replyTo ? { ...m.replyTo, ...this.replyInfo(threadId, m.replyTo.remoteId, m.replyTo) } : undefined,
        html: m.html,
        edited: m.edited || undefined,
      },
      { live, bump: false },
    );
  }
}

/** Bağlantı bir medya dosyası mı (gönderi sayfası değil)? Bunlar vekil üzerinden, çerezlerle indirilir. */
function isMediaFile(u: string | undefined): boolean {
  if (!u) return false;
  // fbsbx.com: Instagram/Messenger sesli mesaj ve dosyaları; ton.x.com: X eski DM medyası; linkedin.com/dms: LinkedIn ekleri (çerez ister)
  return /(ton\.(x|twitter)\.com|video\.twimg\.com|pbs\.twimg\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com|licdn\.com|linkedin\.com\/dms\/|giphy\.com|tenor\.com|mail\.google\.com\/mail\/|googleusercontent\.com|outlook\.(live|office)\.com|icloud\.com|icloud-content\.com)/.test(u);
}

/** Platform doğrulama/kilit sayfası (yoklama durur) ve hız sınırı (üstel geri çekilme) hata kalıpları */
export const VERIFY_RE = /checkpoint|challenge_required|captcha|account\/access|\/authwall|verify it'?s you/i;
export const RATE_RE = /\b(429|999)\b|rate.?limit|too many/i;
/**
 * Ağ hatası (oturum düşmesi sayılmaz; kısa geri çekilme). net::ERR_ABORTED / TOO_MANY_REDIRECTS / BLOCKED_* bağlantı sorunu
 * değil: gezinmenin giriş sayfasına yönlenip kesilmesi olabilir → oturum denetiminden geçmeli.
 */
export const NET_RE = /net::ERR_(?!ABORTED|TOO_MANY_REDIRECTS|BLOCKED)|ENOTFOUND|EAI_AGAIN|ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|fetch failed|Failed to fetch|NetworkError|socket hang up|ağ hatası/i;

/** Genel ya da hatalı etiket (eski sürümlerin yazdığı "Error" / "olk-mail_…" dahil): yenisi gelince üstüne yazılabilir */
/** Mivelo içi giriş ekranının boyutu (CSS px; görüntü 2x) */
const EMBED_SIZE = { width: 820, height: 700 };

const GENERIC_LABEL = /^(messenger|instagram|tiktok|x|linkedin|slack|outlook|gmail|icloud mail|yahoo mail|yandex mail|yahoo|yandex|etsy|shopify|amazon|error|hata)$|^olk-|pivot/i;

/** Kalıcı profilde çerez veritabanı var mı (daha önce giriş denenmiş mi) */
function hasProfileCookies(profile: string): boolean {
  return ['Default/Cookies', 'Default/Network/Cookies'].some((f) => fs.existsSync(path.join(profile, f)));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gerçek (görünür) Chromium'un kullanıcı-aracısı: görünmez modda "HeadlessChrome" yerine bu gönderilir. Bir kez hesaplanır. */
let cachedUA: string | undefined;
async function realUserAgent(chromium: (typeof import('playwright'))['chromium']): Promise<string | undefined> {
  if (cachedUA) return cachedUA;
  try {
    const b = await chromium.launch({ headless: true, channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium', executablePath: process.env.KAVSAK_CHROMIUM || undefined });
    const p = await b.newPage();
    const ua = await p.evaluate(() => navigator.userAgent);
    await b.close();
    cachedUA = ua.replace(/HeadlessChrome/g, 'Chrome');
  } catch {
    cachedUA = undefined;
  }
  return cachedUA;
}

/** Söz belirli sürede çözülmezse hata ver (Playwright çağrıları bazen sonsuza dek bekleyebiliyor). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${Math.round(ms / 1000)} sn içinde yanıt gelmedi`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Basit, kararlı bir metin özeti — DOM'dan okunan mesajlara kimlik üretmek için. */
export function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
