import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment } from '../../model.js';
import { bus } from '../../bus.js';

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

async function voyager(page: Page, cookies: Record<string, string>, url: string, init?: { method?: string; body?: unknown; graphql?: boolean }): Promise<J> {
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
const captured: { conversations?: string; messages?: string; older?: string; headers?: Record<string, string> } = {};
/** Yakalanamazsa kullanılacak bilinen "daha eski" sorgu kimliği (istemci sürümüyle değişebilir) */
const OLDER_QUERY_ID = 'messengerMessages.d8ea76885a52fd5dc5c317078ab7c977';
const installed = new WeakSet<Page>();

function install(page: Page): void {
  if (installed.has(page)) return;
  installed.add(page);
  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes('voyagerMessagingGraphQL/graphql')) return;
    if (u.includes('messengerConversations') && !u.includes('messengerConversationsBySyncToken')) captured.conversations = u;
    else if (u.includes('messengerConversations')) captured.conversations ??= u;
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

export const linkedin: Strategy = {
  home: HOME,
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
      const els = findElements(data, 'messengerConversations');
      if (!meId) {
        // mailboxUrn sorguda var: variables=(mailboxUrn:urn%3Ali%3Afsd_profile%3AABC)
        const m = decodeURIComponent(captured.conversations).match(/mailboxUrn:urn:li:fsd_profile:([^,)]+)/);
        if (m) meId = m[1];
      }
      const out: Thread[] = [];
      let sponsored = 0;
      for (const c of els) {
        if (isSponsored(c)) {
          sponsored++;
          continue;
        }
        const parts = (c.conversationParticipants ?? []).map(memberOf);
        const others = parts.filter((p: { id: string }) => p.id !== meId);
        const last = (c.messages?.elements ?? []).find((m: J) => !isAdMessage(m));
        out.push({
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
        });
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
};
