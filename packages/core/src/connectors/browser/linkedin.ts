import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
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

/** Sayfanın yaptığı GraphQL isteklerinden yakalanan URL'ler */
const captured: { conversations?: string; messages?: string; headers?: Record<string, string> } = {};
const installed = new WeakSet<Page>();

function install(page: Page): void {
  if (installed.has(page)) return;
  installed.add(page);
  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes('voyagerMessagingGraphQL/graphql')) return;
    if (u.includes('messengerConversations') && !u.includes('messengerConversationsBySyncToken')) captured.conversations = u;
    else if (u.includes('messengerConversations')) captured.conversations ??= u;
    if (u.includes('messengerMessages')) captured.messages = u;
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
 * Yakalanan mesaj sorgusundaki conversationUrn değerini, istemcinin kullandığı kodlama biçimini
 * koruyarak (parantezler ham ya da %28/%29) başka bir sohbetle değiştir.
 */
function withConversation(template: string, conversationUrn: string): string {
  const key = 'conversationUrn:';
  const i = template.indexOf(key);
  if (i < 0) return template;
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
  const original = template.slice(start, end);
  const rawParens = original.includes('(');
  // encodeURIComponent parantezleri kodlamaz; istemci %28/%29 gönderiyor ve Rest.li ham parantezi
  // kendi sözdizimi sanıp 400 döndürüyor → parantezler her zaman elle kodlanır.
  const encoded = rawParens
    ? conversationUrn.replace(/:/g, '%3A').replace(/,/g, '%2C').replace(/=/g, '%3D')
    : encodeURIComponent(conversationUrn).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return template.slice(0, start) + encoded + template.slice(end);
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

function msgText(m: J): string {
  const t = m.body?.text ?? m.body ?? '';
  if (t) return String(t);
  const rc = m.renderContent ?? m.renderContentUnions ?? [];
  if (Array.isArray(rc) && rc.length) return '[ek]';
  return '';
}

export const linkedin: Strategy = {
  home: HOME,
  loginHint: 'Açılan pencerede LinkedIn hesabına giriş yap',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.li_at && cookies.JSESSIONID);
  },

  async me(page, cookies) {
    install(page);
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
      for (const c of els) {
        const parts = (c.conversationParticipants ?? []).map(memberOf);
        const others = parts.filter((p: { id: string }) => p.id !== meId);
        const last = c.messages?.elements?.[0];
        out.push({
          id: String(c.entityUrn ?? ''),
          participants: parts.map((p: ReturnType<typeof memberOf>) => ({ id: p.id, name: p.name, avatarUrl: p.avatar, handle: p.handle })),
          handle: others.length === 1 ? others[0].handle : undefined,
          link: others.length === 1 && others[0].handle ? `https://www.linkedin.com/in/${others[0].handle}/` : undefined,
          name: c.title || others.map((p: { name: string }) => p.name).join(', ') || 'Sohbet',
          kind: others.length > 1 || c.groupChat ? 'group' : 'direct',
          lastTs: Number(c.lastActivityAt ?? last?.deliveredAt ?? 0),
          preview: last ? msgText(last) : '',
          unread: Number(c.unreadCount ?? 0),
          avatarUrl: others.length === 1 ? others[0].avatar : undefined,
        });
      }
      if (out.length) return out;
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
        unread: Number(c.unreadCount ?? 0),
      });
    }
    return out;
  },

  async messages(page, cookies, threadId, limit): Promise<Msg[]> {
    install(page);
    if (!captured.messages) {
      // bir sohbeti açtır ki istemci mesaj sorgusunu yapsın; URL şablonunu yakala
      await page.goto(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(convId(threadId))}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitFor(() => !!captured.messages, 12_000);
    }
    if (captured.messages) {
      const url = withConversation(captured.messages, threadId);
      let data: J;
      try {
        data = await voyager(page, cookies, url, { graphql: true });
      } catch (e) {
        // şablon ayrıntısı yalnızca ilk kez basılır; köprü zaten yoklama başına tek özet uyarı verir
        if (!templateWarned) {
          templateWarned = true;
          bus.log('warn', `LinkedIn mesaj sorgusu reddedildi; şablon: ${captured.messages.slice(0, 400)} → ${url.slice(0, 400)}`);
        }
        throw e;
      }
      const els = findElements(data, 'messengerMessages');
      return els.map((m: J) => {
        const from = memberOf(m.sender);
        return {
          id: String(m.entityUrn ?? m.backendUrn ?? m.deliveredAt),
          text: msgText(m),
          ts: Number(m.deliveredAt ?? Date.now()),
          fromMe: !!meId && from.id === meId,
          senderId: from.id,
          senderName: from.name,
          senderAvatarUrl: from.avatar,
        };
      }).reverse();
    }
    // yedek: eski API
    const data = await voyager(page, cookies, `/messaging/conversations/${encodeURIComponent(threadId.split(':').pop() ?? threadId)}/events?count=${limit}`);
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
