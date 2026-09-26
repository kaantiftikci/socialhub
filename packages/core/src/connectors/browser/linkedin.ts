import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment } from '../../model.js';
import { bus } from '../../bus.js';
import { pickFileInput } from './outlook.js';

/**
 * LinkedIn: web istemcisinin kullandığı iç "Voyager" API'si, tarayıcı oturumunun çerezleriyle.
 *
 * LinkedIn mesajlaşmayı GraphQL'e taşıdı (voyagerMessagingGraphQL); sorgu kimlikleri (queryId)
 * sık değişir. Bu yüzden sorguları sabit yazmak yerine sayfanın kendi yaptığı istekler dinlenir:
 * mesajlaşma sayfası açılınca istemcinin gönderdiği "messengerConversations" ve "messengerMessages"
 * URL'leri yakalanır, sonra aynı URL'ler çerezlerle yeniden çağrılır. Eski LEGACY_INBOX uçları
 * yedek olarak durur.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const HOME = 'https://www.linkedin.com/messaging/';

/**
 * Ban önleme (Unipile modeli): ardışık Voyager istekleri arasında 400–1500 ms rastgele aralık. Patlamalı istek dizisi
 * (ör. 6 sayfa + 8 sohbet art arda) LinkedIn'in otomasyon algısını tetikler. Birim testlerinde (node --test) atlanır.
 */
let lastCallAt = 0;
let paceChain: Promise<void> = Promise.resolve();
function pace(): Promise<void> {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  // eşzamanlı çağrılar (köprü 2'li paralel) sıraya girer: her biri bir öncekinden sonra kendi aralığını bekler
  const next = paceChain.then(async () => {
    const wait = lastCallAt + 400 + Math.random() * 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  paceChain = next.catch(() => undefined);
  return next;
}

async function voyager(page: Page, cookies: Record<string, string>, url: string, init?: { method?: string; body?: unknown; graphql?: boolean }): Promise<J> {
  await pace();
  const csrf = (cookies.JSESSIONID ?? '').replace(/"/g, '');
  return page.evaluate(
    async ({ url, csrf, init, extra }) => {
      const r = await fetch(url.startsWith('http') ? url : 'https://www.linkedin.com/voyager/api' + url, {
        method: init?.method ?? 'GET',
        headers: {
          ...(init?.graphql ? extra : {}),
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'tr_TR',
          accept: init?.graphql ? 'application/graphql' : 'application/json',
          ...(init?.body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        credentials: 'include',
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`Voyager ${r.status} ${url.slice(0, 90)}: ${t.slice(0, 100)}`);
      return t ? JSON.parse(t) : {};
    },
    { url, csrf, init, extra: captured.headers ?? {} },
  );
}

/**
 * Sayfanın yaptığı GraphQL isteklerinden yakalanan URL'ler.
 * - messages: sohbetin ilk sayfası (variables=(conversationUrn:…), syncToken YOK — token'lı istek yalnızca
 *   son değişiklikleri döndürür, şablon olarak kullanılırsa geçmiş boş gelir)
 * - older: istemcinin listeyi yukarı kaydırınca yaptığı "daha eski" isteği
 *   (variables=(deliveredAt:<ms>,conversationUrn:…,countBefore:20,countAfter:0) → messengerMessagesByAnchorTimestamp)
 */
const captured: { conversations?: string; conversationsPage?: string; messages?: string; older?: string; headers?: Record<string, string> } = {};
/**
 * Sohbet listesinin sonraki sayfaları: istemci listeyi aşağı kaydırınca
 * variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:…,nextCursor:…)
 * ile ister (lastUpdatedBefore yok sayılıyor; yalnızca nextCursor sayfalıyor). Yakalanamazsa bu bilinen sorgu kimliği kullanılır.
 */
const CONV_PAGE_QUERY_ID = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';
/** İlk sayfadan sonra en çok bu kadar sayfa (20'şer sohbet) okunur */
const MAX_CONV_PAGES = 5;
/** Eski sohbet sayfaları seyrek değişir (yeni etkinlik ilk sayfaya çıkar): 3 sa önbellek — gereksiz istek (ve oturum riski) olmasın */
const PAGE_TTL = 3 * 60 * 60_000;
let olderPages: { at: number; els: J[] } | undefined;
/** Yakalanamazsa kullanılacak bilinen "daha eski" sorgu kimliği (istemci sürümüyle değişebilir) */
const OLDER_QUERY_ID = 'messengerMessages.d8ea76885a52fd5dc5c317078ab7c977';
const installed = new WeakSet<Page>();

function install(page: Page): void {
  if (installed.has(page)) return;
  installed.add(page);
  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes('voyagerMessagingGraphQL/graphql')) return;
    if (u.includes('messengerConversations')) {
      let v = u;
      try {
        v = decodeURIComponent(u);
      } catch {
        /* ham URL */
      }
      // sayfalama isteği (liste aşağı kaydırıldı) ilk sayfa şablonunun yerine geçmesin
      if (/[(,](nextCursor|lastUpdatedBefore):|predicateUnions/.test(v)) captured.conversationsPage = u;
      else if (!u.includes('messengerConversationsBySyncToken')) captured.conversations = u;
      else captured.conversations ??= u;
    }
    if (u.includes('messengerMessages')) {
      let v = u;
      try {
        v = decodeURIComponent(u);
      } catch {
        /* bozuk kodlama: ham URL üzerinden sınıflandır */
      }
      if (/[(,]deliveredAt:|[(,]countBefore:/.test(v)) captured.older = u;
      else if (!/[(,]syncToken:/.test(v)) captured.messages = u;
    }
    // istemcinin gönderdiği başlıkları (x-li-track, page-instance vb.) aynen kullan — yalnızca
    // GET sohbet/mesaj sorgularından; POST'lar (seen-receipts vb.) farklı pem/page-instance taşır
    if (req.method() !== 'GET' || !/messenger(Conversations|Messages)/.test(u)) return;
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) if (/^(x-li-|x-restli|accept$|csrf-token)/i.test(k)) h[k] = v;
    captured.headers = h;
  });
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return pred();
}

/**
 * Yakalanan sorgu şablonundaki bir Rest.li değişkenini (variables=(ad:değer,…)) değiştir.
 * Değer, üst düzeydeki ilk ',' ya da ')' karakterine kadar okunur (iç içe parantezler atlanır).
 */
function varSpan(template: string, name: string): [number, number] | undefined {
  const key = name + ':';
  const i = template.indexOf(key);
  if (i < 0) return undefined;
  const start = i + key.length;
  let depth = 0;
  let end = start;
  for (; end < template.length; end++) {
    const ch = template[end];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
  }
  return [start, end];
}

function withVar(template: string, name: string, value: string): string {
  const span = varSpan(template, name);
  if (!span) return template;
  return template.slice(0, span[0]) + value + template.slice(span[1]);
}

/**
 * Sohbet URN'ini Rest.li için kodla. encodeURIComponent parantezleri kodlamaz; istemci %28/%29
 * gönderiyor ve Rest.li ham parantezi kendi sözdizimi sanıp 400 döndürüyor → parantezler elle kodlanır.
 */
const encodeUrn = (urn: string) => encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29');

/**
 * Yakalanan mesaj sorgusundaki conversationUrn değerini, istemcinin kullandığı kodlama biçimini
 * koruyarak (parantezler ham ya da %28/%29) başka bir sohbetle değiştir.
 */
function withConversation(template: string, conversationUrn: string): string {
  const span = varSpan(template, 'conversationUrn');
  if (!span) return template;
  // ham parantezli şablon: mevcut değer '(' içeriyorsa yalnızca iç ayraçlar kodlanır
  const rawParens = template.slice(span[0], span[1]).includes('(');
  const encoded = rawParens ? conversationUrn.replace(/:/g, '%3A').replace(/,/g, '%2C').replace(/=/g, '%3D') : encodeUrn(conversationUrn);
  return template.slice(0, span[0]) + encoded + template.slice(span[1]);
}

let olderCaptureTried = false;
let templateCapture: Promise<void> | undefined;

/**
 * Mesaj sorgu şablonu yoksa bir sohbeti açtır ki istemci kendi messengerMessages isteğini yapsın.
 * Paralel messages() çağrıları aynı sayfada ayrı ayrı gezinmesin diye tek uçuş paylaşılır.
 */
function ensureMessagesTemplate(page: Page, threadId: string): Promise<void> {
  if (captured.messages) return Promise.resolve();
  templateCapture ??= (async () => {
    try {
      await page.goto(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(convId(threadId))}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitFor(() => !!captured.messages, 12_000);
    } finally {
      templateCapture = undefined;
    }
  })();
  return templateCapture;
}

/** İstemciye "daha eski" isteğini yaptır: sohbeti aç, mesaj listesini en üste kaydır (en çok ~10 sn). */
async function captureOlder(page: Page, threadId: string): Promise<void> {
  await page.goto(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(convId(threadId))}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await waitFor(() => false, 2500);
  for (let i = 0; i < 6 && !captured.older; i++) {
    const box = await page.$('.msg-s-message-list').catch(() => null);
    const b = await box?.boundingBox().catch(() => null);
    if (b) {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2).catch(() => undefined);
      await page.mouse.wheel(0, -4000).catch(() => undefined);
    }
    await page
      .evaluate(() => {
        const el = document.querySelector('.msg-s-message-list');
        if (el) {
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
        }
      })
      .catch(() => undefined);
    await waitFor(() => !!captured.older, 1200);
  }
  bus.log('info', captured.older ? 'LinkedIn: "daha eski" sorgu şablonu yakalandı' : 'LinkedIn: "daha eski" sorgu şablonu yakalanamadı');
}

/** "Daha eski" sorgusu: yakalanan şablon varsa onu, yoksa bilinen sorgu kimliğiyle sentezlenmiş URL'yi kullan. */
function olderUrl(threadId: string, before: number, limit: number): string | undefined {
  if (captured.older) {
    let u = withConversation(captured.older, threadId);
    u = withVar(u, 'deliveredAt', String(before));
    u = withVar(u, 'countBefore', String(limit));
    return u;
  }
  const base = captured.messages;
  if (!base) return undefined;
  const q = base.indexOf('?');
  const origin = q < 0 ? base : base.slice(0, q);
  return `${origin}?queryId=${OLDER_QUERY_ID}&variables=(deliveredAt:${before},conversationUrn:${encodeUrn(threadId)},countBefore:${limit},countAfter:0)`;
}

/** Sohbet listesinin `nextCursor` sayfası için URL (yakalanan şablonun kökeni + sorgu kimliği) */
export function conversationsPageUrl(base: string, mailboxUrn: string, cursor?: string, pageTemplate?: string): string {
  const q = base.indexOf('?');
  const origin = q < 0 ? base : base.slice(0, q);
  const qid = pageTemplate?.match(/queryId=([^&]+)/)?.[1] ?? CONV_PAGE_QUERY_ID;
  const vars = `query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:${encodeUrn(mailboxUrn)}${cursor ? `,nextCursor:${encodeURIComponent(cursor)}` : ''}`;
  return `${origin}?queryId=${qid}&variables=(${vars})`;
}

/** Yanıttaki sohbet listesi sayfasının sonraki imleci */
function nextCursorOf(data: J): string | undefined {
  const d = data?.data ?? data;
  for (const k of Object.keys(d ?? {})) if (k.startsWith('messengerConversations') && d[k]?.metadata?.nextCursor) return String(d[k].metadata.nextCursor);
  return undefined;
}

let pagingWarned = false;
/**
 * PRIMARY_INBOX sayfalarının imleç zinciri: pageCursors[i] = i. sayfanın (0 = imleçsiz ilk sayfa) yanıtındaki
 * nextCursor; '' = zincir bitti. olderConversations ilk sayfaları doldurur, moreThreads oradan devam eder.
 */
const pageCursors: string[] = [];

/** i. PRIMARY_INBOX sayfasını getir (gerekirse önceki sayfaların imleçleri sırayla alınır); zincir bittiyse undefined */
async function fetchConversationPage(page: Page, cookies: Record<string, string>, i: number): Promise<J[] | undefined> {
  if (!captured.conversations || !meId) return undefined;
  let cursor: string | undefined;
  if (i > 0) {
    if (pageCursors[i - 1] === undefined) {
      if (!(await fetchConversationPage(page, cookies, i - 1))) return undefined;
    }
    cursor = pageCursors[i - 1];
    if (!cursor) return undefined; // '' : önceki sayfa sonuncuydu
  }
  const data = await voyager(page, cookies, conversationsPageUrl(captured.conversations, `urn:li:fsd_profile:${meId}`, cursor, captured.conversationsPage), { graphql: true });
  const got = findElements(data, 'messengerConversations');
  pageCursors.length = i;
  pageCursors[i] = got.length ? (nextCursorOf(data) ?? '') : '';
  return got;
}

/**
 * İlk sayfanın (en yeni 20, sponsorlular dahil) ötesindeki sohbetler: PRIMARY_INBOX sayfaları nextCursor ile
 * (imleçsiz ilk istek ilk sayfayla büyük ölçüde örtüşür). Çakışanlar çağıran tarafta elenir. Hata ölümcül değil (ilk sayfa yine döner).
 */
async function olderConversations(page: Page, cookies: Record<string, string>): Promise<J[]> {
  if (!captured.conversations || !meId) return [];
  if (olderPages && Date.now() - olderPages.at < PAGE_TTL) return olderPages.els;
  const els: J[] = [];
  try {
    for (let i = 0; i <= MAX_CONV_PAGES; i++) {
      const got = await fetchConversationPage(page, cookies, i);
      if (!got) break;
      els.push(...got);
      if (!got.length || !pageCursors[i]) break;
    }
  } catch (e) {
    if (!pagingWarned) {
      pagingWarned = true;
      bus.log('warn', `LinkedIn: eski sohbet sayfaları okunamadı (yalnızca en yeni 20 sohbet): ${(e as Error).message}`);
    }
    if (!els.length) return olderPages?.els ?? [];
  }
  olderPages = { at: Date.now(), els };
  return els;
}

/** urn:li:fsd_profile:ABC → ABC ; urn:li:fs_miniProfile:ABC → ABC */
const tail = (urn: string | undefined) => String(urn ?? '').split(':').pop() ?? '';
/** urn:li:msg_conversation:(urn:li:fsd_profile:ABC,2-XYZ==) → 2-XYZ== */
const convId = (urn: string) => {
  const m = urn.match(/,([^,)]+)\)$/);
  return m ? m[1] : urn.split(':').pop() ?? urn;
};

let meId = '';
let meUrn = '';
let templateWarned = false;
let sponsoredLogged = false;

function memberOf(p: J | undefined): { id: string; name: string; avatar?: string; handle?: string } {
  const m = p?.participantType?.member ?? p?.participantType?.organization ?? p?.member ?? {};
  const handle: string | undefined = m.publicIdentifier ?? (typeof m.profileUrl === 'string' ? m.profileUrl.split('/in/')[1]?.replace(/\/$/, '') : undefined);
  const first = m.firstName?.text ?? m.firstName ?? '';
  const last = m.lastName?.text ?? m.lastName ?? '';
  const name = [first, last].filter(Boolean).join(' ') || m.name?.text || m.name || 'LinkedIn kullanıcısı';
  const pic = m.profilePicture ?? m.logo;
  const art = pic?.artifacts?.find((a: J) => a.width >= 100) ?? pic?.artifacts?.[0];
  return { id: tail(p?.hostIdentityUrn ?? m.entityUrn ?? m.objectUrn), name, avatar: pic?.rootUrl && art ? pic.rootUrl + art.fileIdentifyingUrlPathSegment : undefined, handle };
}

function findElements(data: J, key: string): J[] {
  const d = data?.data ?? data;
  for (const k of Object.keys(d ?? {})) {
    if (k.startsWith(key) && d[k]?.elements) return d[k].elements;
  }
  // included biçimi (bazı yanıtlar düz liste döner)
  return (data?.included ?? []).filter((e: J) => e.$type?.includes(key === 'messengerConversations' ? 'Conversation' : 'Message'));
}

const renderContent = (m: J): J[] => {
  const rc = m.renderContent ?? m.renderContentUnions ?? [];
  return Array.isArray(rc) ? rc.filter(Boolean) : [];
};

/** Sponsorlu (reklam) mesaj: Message Ad ya da Conversation Ad içeriği taşır; mobil uygulama bunları göstermez */
function isAdMessage(m: J): boolean {
  if ((m.categories ?? []).some((c: unknown) => /SPONSORED/i.test(String(c)))) return true;
  return renderContent(m).some((r) => r.messageAdRenderContent || r.conversationAdsMessageContent || r.sponsoredMessageContent);
}

/**
 * Sponsorlu sohbet: contentMetadata.conversationAdContent (Sponsored InMail / "LinkedIn Teklifi"),
 * "Sponsorlu" tür etiketi ya da reklam içerikli mesajlar. Not: yalnızca 'INMAIL' kategorisi yeterli değil —
 * Premium InMail (gerçek kişilerden, hostUrnData PREMIUM_INMAIL) de bu kategoriyi taşır ve mobilde görünür.
 */
function isSponsored(c: J): boolean {
  if (c.contentMetadata?.conversationAdContent) return true;
  if ((c.categories ?? []).some((x: unknown) => /SPONSORED/i.test(String(x)))) return true;
  if (/sponsor/i.test(String(c.conversationTypeText?.text ?? ''))) return true;
  return (c.messages?.elements ?? []).some(isAdMessage);
}

/** VectorImage → en büyük artifact'ın tam adresi (artifacts boşsa rootUrl'nin kendisi tam adres) */
function vectorUrl(vi: J | undefined): string | undefined {
  if (!vi?.rootUrl) return undefined;
  const arts: J[] = Array.isArray(vi.artifacts) ? vi.artifacts : [];
  const art = arts.reduce<J | undefined>((best, a) => (!best || Number(a.width ?? 0) > Number(best.width ?? 0) ? a : best), undefined);
  return String(vi.rootUrl) + String(art?.fileIdentifyingUrlPathSegment ?? '');
}

const kindOfMime = (mime: string | undefined): Attachment['kind'] =>
  /^image\//.test(mime ?? '') ? 'image' : /^video\//.test(mime ?? '') ? 'video' : /^audio\//.test(mime ?? '') ? 'audio' : 'file';

/**
 * renderContent öğelerinden ekler: vectorImage (görsel), file (dosya/görsel/video/ses), audio (sesli mesaj),
 * video (VideoPlayMetadata), externalMedia (GIF). Reklam ve hostUrnData (Premium InMail etiketi) atlanır.
 */
function attachmentsOf(m: J): Attachment[] {
  const out: Attachment[] = [];
  for (const r of renderContent(m)) {
    if (r.vectorImage) {
      const url = vectorUrl(r.vectorImage);
      if (url) out.push({ kind: 'image', name: 'Görsel', url, link: url });
    } else if (r.file) {
      const f = r.file;
      const kind = kindOfMime(f.mediaType);
      out.push({ kind, name: f.name || 'Dosya', mime: f.mediaType || undefined, size: f.byteSize ? Number(f.byteSize) : undefined, url: kind === 'image' ? f.url : undefined, link: f.url });
    } else if (r.audio) {
      out.push({ kind: 'audio', name: 'Sesli mesaj', mime: r.audio.mediaType || undefined, link: r.audio.url });
    } else if (r.video) {
      const v = r.video;
      const streams: J[] = v.progressiveStreams ?? v.videoPlayMetadata?.progressiveStreams ?? [];
      const best = streams.reduce<J | undefined>((b, s) => (!b || Number(s.width ?? 0) > Number(b.width ?? 0) ? s : b), undefined);
      const link = best?.streamingLocations?.[0]?.url ?? v.url;
      out.push({ kind: 'video', name: 'Video', url: vectorUrl(v.thumbnail ?? v.videoPlayMetadata?.thumbnail), link });
    } else if (r.externalMedia) {
      const em = r.externalMedia;
      const url = em.media?.url ?? em.previewMedia?.url;
      if (url) out.push({ kind: 'image', name: em.title || 'GIF', url, link: url });
    } else if (r.forwardedMessageContent) {
      out.push(...attachmentsOf(r.forwardedMessageContent));
    } else if (r.unavailableContent) {
      out.push({ kind: 'other', name: 'Kullanılamayan içerik' });
    } else if (r.hostUrnData?.type === 'FEED_UPDATE') {
      // paylaşılan gönderi: metin/ek yok, yalnızca urn:li:fsd_update:(urn:li:activity:<id>,MESSAGING_RESHARE,…)
      const act = String(r.hostUrnData.hostUrn ?? '').match(/urn:li:(?:activity|ugcPost|share):\d+/)?.[0];
      const link = act ? `https://www.linkedin.com/feed/update/${act}/` : undefined;
      out.push({ kind: 'other', name: 'Paylaşılan gönderi', link, page: link });
    }
    // hostUrnData (PREMIUM_INMAIL etiketi), messageAdRenderContent, conversationAdsMessageContent: ek değil
  }
  return out;
}

function msgText(m: J): string {
  const t = m.body?.text ?? (typeof m.body === 'string' ? m.body : '') ?? '';
  if (t) return String(t);
  const fwd = renderContent(m).find((r) => r.forwardedMessageContent)?.forwardedMessageContent;
  const fwdText = fwd?.originalMessage?.body?.text ?? fwd?.body?.text;
  if (fwdText) return `↪ ${fwdText}`;
  return String(m.renderContentFallbackText ?? '');
}

/** Sohbet listesi önizlemesi: metin yoksa ekin adı (arayüz ek göstermez) */
function preview(m: J | undefined): string {
  if (!m) return '';
  const t = msgText(m);
  if (t) return t;
  const a = attachmentsOf(m)[0];
  return a?.name ? `[${a.name}]` : '';
}

/** Okunmamış sayısı: platformun gerçek sayacı; 'read:false' ama sayaç 0 ise en az 1 (kalın gösterim için) */
const unreadOf = (c: J): number => {
  const n = Number(c.unreadCount ?? 0);
  return c.read === false ? Math.max(1, n) : n;
};

/** GraphQL sohbet öğesi → sohbet (katılımcılar, tek kişiyse profil bağlantısı/avatar, son mesaj önizlemesi) */
export function conversationToThread(c: J, me: string): Thread {
  const parts = (c.conversationParticipants ?? []).map(memberOf);
  const others = parts.filter((p: { id: string }) => p.id !== me);
  const last = (c.messages?.elements ?? []).find((m: J) => !isAdMessage(m));
  return {
    id: String(c.entityUrn ?? ''),
    participants: parts.map((p: ReturnType<typeof memberOf>) => ({ id: p.id, name: p.name, avatarUrl: p.avatar, handle: p.handle })),
    handle: others.length === 1 ? others[0].handle : undefined,
    link: others.length === 1 && others[0].handle ? `https://www.linkedin.com/in/${others[0].handle}/` : undefined,
    name: c.title || others.map((p: { name: string }) => p.name).join(', ') || 'Sohbet',
    kind: others.length > 1 || c.groupChat ? 'group' : 'direct',
    lastTs: Number(c.lastActivityAt ?? last?.deliveredAt ?? 0),
    preview: preview(last),
    unread: unreadOf(c),
    avatarUrl: others.length === 1 ? others[0].avatar : undefined,
  };
}

/** Testler için: yakalanan sohbet listesi şablonunu ve kimliği ayarla, imleç zincirini sıfırla */
export function _seedLinkedinForTests(conversationsUrl: string, me: string): void {
  captured.conversations = conversationsUrl;
  meId = me;
  pageCursors.length = 0;
  olderPages = undefined;
}

/**
 * Anlık akış (mautrix-linkedin modeli, ama kendi bağlantımızı AÇMADAN): LinkedIn web istemcisi açık sayfada
 * `/realtime/connect` akışını zaten tutuyor (SSE biçimi, fetch/XHR/EventSource ile). Sayfaya eklenen betik bu akışın
 * kopyasını okur; mesaj/sohbet konuları gelince Node'a 'event', kalp atışlarında (en çok 30 sn'de bir) 'alive' bildirir.
 * Yazma alanı göstergesi (typingIndicatorsTopic) ve çevrimiçi durumu (presenceStatusTopic) olay sayılmaz.
 * Akış hiç görülmezse yoklama eskisi gibi (60 sn) sürer; görülürse köprü aralığı 3 katına çıkarır.
 */
export const RT_EVENT_RE = /messagesTopic|conversationsTopic|messageReactionSummariesTopic|messageSeenReceiptsTopic|conversationDeletesTopic/;
/** Sekme rozeti güncellemesi (mautrix-linkedin bunu da "sohbet değişti" sayar) — yalnız mesajlaşma rozetiyse */
const BADGE_RE = /tabBadgeUpdateTopic[\s\S]*MESSAGING|MESSAGING[\s\S]*tabBadgeUpdateTopic/;
export function realtimeKind(chunk: string): 'event' | 'alive' {
  return RT_EVENT_RE.test(chunk) || BADGE_RE.test(chunk) ? 'event' : 'alive';
}

async function watchRealtime(page: Page, notify: (kind: 'alive' | 'event') => void): Promise<void> {
  await page.exposeBinding('__miveloRt', (_src, kind: string) => notify(kind === 'event' ? 'event' : 'alive'));
  await page.addInitScript((eventRe: string) => {
    const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (w.__miveloRtHooked) return;
    w.__miveloRtHooked = true;
    const re = new RegExp(eventRe);
    const isRt = (u: unknown) => /\/realtime\/connect/.test(String(u ?? ''));
    let aliveAt = 0;
    // ClientConnection kimliği değişince (akış koptu, yeniden bağlandı) arada olay kaçmış olabilir: mautrix-linkedin gibi eşitle
    let connId = '';
    const emit = (text: string) => {
      try {
        const cid = /realtimefrontend\.ClientConnection"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
        const reconnected = !!cid && !!connId && cid !== connId;
        if (cid) connId = cid;
        if (reconnected || re.test(text) || (/tabBadgeUpdateTopic/.test(text) && /MESSAGING/.test(text))) w.__miveloRt?.('event');
        else if (Date.now() - aliveAt > 30_000) {
          aliveAt = Date.now();
          w.__miveloRt?.('alive');
        }
      } catch {
        /* bağlama yok */
      }
    };
    // fetch: yanıtın kopyası okunur, istemciye özgün yanıt döner
    const of = w.fetch;
    if (typeof of === 'function') {
      w.fetch = function (this: unknown, input: any, init?: unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
        const p = of.call(this, input, init);
        try {
          const url = typeof input === 'string' ? input : input?.url ?? String(input);
          if (isRt(url))
            p.then((res: Response) => {
              const reader = res.clone().body?.getReader();
              if (!reader) return;
              const dec = new TextDecoder();
              const pump = (): Promise<void> => reader.read().then(({ done, value }) => (done ? undefined : (emit(dec.decode(value, { stream: true })), pump())));
              pump().catch(() => undefined);
            }).catch(() => undefined);
        } catch {
          /* yok say */
        }
        return p;
      };
    }
    // XHR: akış progress olaylarıyla büyüyen responseText
    const XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      if (isRt(args[1])) {
        let seen = 0;
        this.addEventListener('progress', () => {
          const t = this.responseText ?? '';
          if (t.length > seen) emit(t.slice(seen));
          seen = t.length;
        });
      }
      return (XO as (...a: unknown[]) => void).apply(this, args);
    } as typeof XO;
    // EventSource
    const ES = w.EventSource;
    if (typeof ES === 'function') {
      const Wrapped = function (url: unknown, cfg?: unknown) {
        const es = new ES(url, cfg);
        if (isRt(url)) es.addEventListener('message', (e: MessageEvent) => emit(String(e.data ?? '')));
        return es;
      } as unknown as Record<string, unknown>;
      Wrapped.prototype = ES.prototype;
      w.EventSource = Wrapped;
    }
  }, RT_EVENT_RE.source);
}

export const linkedin: Strategy = {
  home: HOME,
  watch: watchRealtime,
  loginHint: 'Açılan pencerede LinkedIn hesabına giriş yap',
  // API tabanlı: mesaj sorguları sayfa gezdirmeden fetch ile yapılır, paralel çağrılabilir
  parallel: true,

  async loggedIn(_page, cookies) {
    return Boolean(cookies.li_at && cookies.JSESSIONID);
  },

  async me(page, cookies) {
    install(page);
    // fetch sayfanın kaynağından yapılır: ilk gezinme başarısız kaldıysa (about:blank) önce ana sayfaya git
    if (!page.url().startsWith('https://www.linkedin.com/')) await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    try {
      const me = await voyager(page, cookies, '/me');
      meUrn = String(me.miniProfile?.entityUrn ?? '');
      meId = tail(meUrn);
      return { id: meId, label: [me.miniProfile?.firstName, me.miniProfile?.lastName].filter(Boolean).join(' ') || 'LinkedIn' };
    } catch (e) {
      bus.log('warn', `LinkedIn /me: ${(e as Error).message}`);
      return { id: '', label: 'LinkedIn' };
    }
  },

  async threads(page, cookies): Promise<Thread[]> {
    install(page);
    if (!captured.conversations) {
      // sayfanın kendisi sohbet listesini istesin; URL'yi yakala
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitFor(() => !!captured.conversations, 12_000);
    }
    if (captured.conversations) {
      const data = await voyager(page, cookies, captured.conversations, { graphql: true });
      const first = findElements(data, 'messengerConversations');
      if (!meId) {
        // mailboxUrn sorguda var: variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AABC)
        const m = decodeURIComponent(captured.conversations).match(/mailboxUrn:urn:li:fsd_profile:([^,)]+)/);
        if (m) meId = m[1];
      }
      // ilk sayfa yalnızca en yeni 20 sohbet (çoğu sponsorlu olabilir): eski sohbetler sayfalanarak eklenir
      const seenUrns = new Set(first.map((c) => String(c.entityUrn ?? '')));
      const els = [...first];
      for (const c of first.length ? await olderConversations(page, cookies) : []) {
        const urn = String(c.entityUrn ?? '');
        if (!urn || seenUrns.has(urn)) continue;
        seenUrns.add(urn);
        els.push(c);
      }
      const out: Thread[] = [];
      let sponsored = 0;
      for (const c of els) {
        if (isSponsored(c)) {
          sponsored++;
          continue;
        }
        out.push(conversationToThread(c, meId));
      }
      if (sponsored && !sponsoredLogged) {
        sponsoredLogged = true;
        bus.log('info', `LinkedIn: ${sponsored} sponsorlu sohbet gizlendi`);
      }
      if (out.length) {
        // mesaj şablonu henüz yoksa tek bir sohbeti şimdi açtır: yoklama mesajları 4'lü paralel ister,
        // her biri ayrı ayrı sayfa gezdirmesin. Okunmuş bir sohbet seçilir: web istemcisi açılan sohbete
        // görüldü bildirimi gönderir, okunmamış bir sohbet platformda (ve burada) okunmuş sayılmasın.
        if (!captured.messages) await ensureMessagesTemplate(page, (out.find((t) => !t.unread) ?? out[0]).id);
        return out;
      }
      if (els.length) return out; // hepsi sponsorluysa liste gerçekten boş
      bus.log('warn', 'LinkedIn: GraphQL sohbet listesi boş döndü, eski uç deneniyor');
    }
    // yedek: eski API
    const data = await voyager(page, cookies, '/messaging/conversations?keyVersion=LEGACY_INBOX&count=40');
    const out: Thread[] = [];
    for (const c of data.elements ?? []) {
      const others = (c.participants ?? []).map((p: J) => {
        const mp = p['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile ?? {};
        return { id: tail(mp.entityUrn), name: [mp.firstName, mp.lastName].filter(Boolean).join(' ') || 'LinkedIn kullanıcısı' };
      }).filter((p: { id: string }) => p.id !== meId);
      const last = (c.events ?? [])[0];
      const lc = last?.eventContent?.['com.linkedin.voyager.messaging.event.MessageEvent'] ?? {};
      out.push({
        id: String(c.entityUrn ?? c.backendUrn ?? ''),
        name: c.name || others.map((p: { name: string }) => p.name).join(', ') || 'Sohbet',
        kind: others.length > 1 ? 'group' : 'direct',
        lastTs: Number(c.lastActivityAt ?? last?.createdAt ?? 0),
        preview: lc.attributedBody?.text ?? lc.body ?? '',
        unread: unreadOf(c),
      });
    }
    return out;
  },

  async messages(page, cookies, threadId, limit, before): Promise<Msg[]> {
    install(page);
    // bir sohbeti açtır ki istemci mesaj sorgusunu yapsın; URL şablonunu yakala (paralel çağrılar tek uçuşu bekler)
    await ensureMessagesTemplate(page, threadId);
    if (captured.messages) {
      let url = before ? (olderUrl(threadId, before, limit) ?? withConversation(captured.messages, threadId)) : withConversation(captured.messages, threadId);
      let data: J | undefined;
      try {
        data = await voyager(page, cookies, url, { graphql: true });
      } catch (e) {
        // "daha eski" bilinen sorgu kimliği reddedildiyse (istemci sürümü değişmiş) şablonu bir kez
        // istemciden yakalamayı dene: sohbeti aç, listeyi en üste kaydır → sayfa kendi isteğini yapar
        if (before && !captured.older && !olderCaptureTried) {
          olderCaptureTried = true;
          await captureOlder(page, threadId);
          if (captured.older) {
            url = olderUrl(threadId, before, limit)!;
            // yakalanan şablon da reddedilirse aşağıdaki uyarı yoluna düş (özgün hata fırlatılır)
            data = await voyager(page, cookies, url, { graphql: true }).catch(() => undefined);
          }
        }
        if (!data) {
          // şablon ayrıntısı yalnızca ilk kez basılır; köprü zaten yoklama başına tek özet uyarı verir
          if (!templateWarned) {
            templateWarned = true;
            bus.log('warn', `LinkedIn mesaj sorgusu reddedildi; şablon: ${(before ? captured.older ?? OLDER_QUERY_ID : captured.messages).slice(0, 400)} → ${url.slice(0, 400)}`);
          }
          throw e;
        }
      }
      const els = findElements(data, 'messengerMessages');
      // ilk sayfa yeniden-eskiye, "daha eski" yanıtı eskiden-yeniye gelir → zaman damgasına göre sırala
      return els
        .filter((m: J) => !isAdMessage(m))
        .filter((m: J) => !before || Number(m.deliveredAt ?? 0) < before)
        .map((m: J): Msg => {
          const from = memberOf(m.sender);
          return {
            id: String(m.entityUrn ?? m.backendUrn ?? m.deliveredAt),
            text: msgText(m),
            ts: Number(m.deliveredAt ?? Date.now()),
            fromMe: !!meId && from.id === meId,
            senderId: from.id,
            senderName: from.name,
            senderAvatarUrl: from.avatar,
            attachments: attachmentsOf(m),
          };
        })
        .sort((a: Msg, b: Msg) => a.ts - b.ts);
    }
    // yedek: eski API
    const data = await voyager(page, cookies, `/messaging/conversations/${encodeURIComponent(threadId.split(':').pop() ?? threadId)}/events?count=${limit}${before ? `&createdBefore=${before}` : ''}`);
    return (data.elements ?? []).map((ev: J) => {
      const mp = ev.from?.['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile ?? {};
      const c = ev.eventContent?.['com.linkedin.voyager.messaging.event.MessageEvent'] ?? {};
      const fromId = tail(mp.entityUrn);
      return {
        id: String(ev.entityUrn ?? ev.createdAt),
        text: c.attributedBody?.text ?? c.body ?? '',
        ts: Number(ev.createdAt ?? Date.now()),
        fromMe: !!meId && fromId === meId,
        senderId: fromId,
        senderName: [mp.firstName, mp.lastName].filter(Boolean).join(' ') || 'LinkedIn kullanıcısı',
      };
    });
  },

  /**
   * Okundu: web istemcisinin sohbet açılınca yaptığı istek —
   * POST voyagerMessagingDashMessengerConversations?ids=List(<urn>) {"entities":{<urn>:{"patch":{"$set":{"read":true}}}}}
   * (sayfa gezdirmeden; profil kopyasıyla doğrulandı: read false → true, unreadCount → 0).
   */
  async markRead(page, cookies, threadId) {
    if (!threadId.startsWith('urn:li:msg_conversation:')) return;
    await voyager(page, cookies, `https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?ids=List(${encodeUrn(threadId)})`, {
      method: 'POST',
      body: { entities: { [threadId]: { patch: { $set: { read: true } } } } },
    });
    olderPages = undefined; // önbellekteki eski sayfada okunmamış kalmasın
  },

  async send(page, cookies, threadId, text) {
    if (threadId.startsWith('urn:li:msg_conversation:')) {
      const body = {
        message: { body: { attributes: [], text }, renderContentUnions: [], conversationUrn: threadId, originToken: crypto.randomUUID() },
        mailboxUrn: `urn:li:fsd_profile:${meId}`,
        trackingId: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        dedupeByClientGeneratedToken: false,
      };
      const r = await voyager(page, cookies, 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', { method: 'POST', body });
      return r?.value?.entityUrn ? String(r.value.entityUrn) : undefined;
    }
    const body = {
      eventCreate: { value: { 'com.linkedin.voyager.messaging.create.MessageCreate': { body: text, attachments: [], attributedBody: { text, attributes: [] } } } },
    };
    const r = await voyager(page, cookies, `/messaging/conversations/${encodeURIComponent(threadId.split(':').pop() ?? threadId)}/events?action=create`, { method: 'POST', body });
    return r?.value?.eventUrn ? String(r.value.eventUrn) : undefined;
  },

  /**
   * Sohbet listesinin sonraki sayfaları: threads() ilk MAX_CONV_PAGES+1 PRIMARY_INBOX sayfasını zaten birleştirir;
   * pageIndex=1 ondan sonraki sayfadır (nextCursor zinciriyle). Zincir bitmişse boş dizi. Sponsorlu sohbetler elenir.
   */
  async moreThreads(page, cookies, pageIndex): Promise<Thread[]> {
    install(page);
    if (!captured.conversations) {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitFor(() => !!captured.conversations, 12_000);
    }
    if (!captured.conversations) throw new Error('LinkedIn: sohbet listesi sorgu şablonu yakalanamadı');
    if (!meId) {
      const m = decodeURIComponent(captured.conversations).match(/mailboxUrn:urn:li:fsd_profile:([^,)]+)/);
      if (m) meId = m[1];
    }
    const got = await fetchConversationPage(page, cookies, MAX_CONV_PAGES + pageIndex);
    return (got ?? []).filter((c) => !isSponsored(c)).map((c) => conversationToThread(c, meId));
  },

  /**
   * Dosya/görsel: mesaj düzenleyicisindeki gizli `input.msg-form__attachment-upload-input` girişleri (biri image/*,
   * diğeri .pdf/.docx/… + video; profil kopyasıyla doğrulandı) dosyayı alır; ek kartı çizilip Gönder etkinleşince
   * açıklama yazılır ve Gönder'e basılır. (Gönderim canlı denenmedi.)
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    await page.goto(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(convId(threadId))}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const editor = page.locator('.msg-form__contenteditable, .msg-form div[role="textbox"][contenteditable="true"]').first();
    await editor.waitFor({ timeout: 20_000 });
    const input = await attachmentInput(page, file);
    if (!input) throw new Error(`LinkedIn: bu dosya türü mesajda gönderilemiyor (${file.mime || file.name})`);
    await input.setInputFiles(file.path);
    // yükleme: Gönder düğmesi etkinleşene dek (en çok dosya boyutuna göre)
    const send = page.locator('.msg-form__send-button, button.msg-form__send-btn').last();
    const maxMs = Math.max(20_000, Math.min(300_000, file.size / 50));
    for (const t0 = Date.now(); Date.now() - t0 < maxMs; ) {
      await page.waitForTimeout(500);
      if (await send.isEnabled().catch(() => false)) break;
    }
    if (caption) {
      await editor.click();
      await editor.fill(caption);
    }
    await send.click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return undefined;
  },
};

/** Düzenleyicideki, dosya türünü kabul eden gizli ataç girişi (LinkedIn: image/* ve genel; accept'e göre seçilir) */
export async function attachmentInput(page: Page, file: { name: string; mime: string }) {
  for (let i = 0; i < 20; i++) {
    const inputs = page.locator('input.msg-form__attachment-upload-input, .msg-form input[type="file"], form[class*="msg-form"] input[type="file"]');
    const n = await inputs.count().catch(() => 0);
    if (n) {
      const accepts: Array<{ accept: string | null }> = [];
      for (let k = 0; k < n; k++) accepts.push({ accept: await inputs.nth(k).getAttribute('accept').catch(() => null) });
      const idx = pickFileInput(accepts, file);
      return idx >= 0 ? inputs.nth(idx) : undefined;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}
