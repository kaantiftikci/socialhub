import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment } from '../../model.js';
import { bus } from '../../bus.js';

/**
 * X (Twitter): web istemcisinin 1.1 DM uçları. Not: X, Kasım 2025'te uçtan uca şifreli
 * "Chat"e geçti; şifreli sohbetler bu uçlarla okunamaz, yalnızca şifrelenmemiş (legacy) DM'ler gelir.
 * Bu connector "deneysel" olarak işaretlidir.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function xapi(page: Page, cookies: Record<string, string>, path: string, body?: unknown): Promise<J> {
  return page.evaluate(
    async ({ path, body, csrf, bearer }) => {
      const r = await fetch('https://x.com/i/api' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + bearer,
          'x-csrf-token': csrf,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'tr',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`X ${r.status} ${path}`);
      return r.json();
    },
    { path, body, csrf: cookies.ct0 ?? '', bearer: BEARER },
  );
}

let meId = '';
const users = new Map<string, string>();
const avatars = new Map<string, string>();
const handles = new Map<string, string>();

function collectUsers(state: J) {
  for (const [id, u] of Object.entries(state?.users ?? {})) {
    users.set(id, (u as J).name ?? (u as J).screen_name ?? id);
    if ((u as J).screen_name) handles.set(id, '@' + (u as J).screen_name);
    if ((u as J).profile_image_url_https) avatars.set(id, String((u as J).profile_image_url_https).replace('_normal.', '_bigger.'));
  }
}

/** twid çerezi "u%3D<id>" biçimindedir */
function meFromCookies(cookies: Record<string, string>): string {
  const m = decodeURIComponent(cookies.twid ?? '').match(/u=(\d+)/);
  return m ? m[1] : '';
}

function groupName(ids: string[]): string {
  const names = ids.map((u) => users.get(u) ?? u);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/** En düşük bit hızlı mp4 varyantı (hızlı önizleme) */
function mp4(v: J | undefined): string | undefined {
  const vs = (v?.video_info?.variants ?? []).filter((x: J) => x.content_type === 'video/mp4');
  vs.sort((a: J, b: J) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
  return vs[Math.min(1, vs.length - 1)]?.url ?? vs[0]?.url;
}

/** DM eki: fotoğraf, video, GIF, kart (link) ya da paylaşılan gönderi */
function attachmentsOf(md: J): { attachments: Attachment[]; strip: string[] } {
  const out: Attachment[] = [];
  const strip: string[] = [];
  const a = md?.attachment;
  if (!a) return { attachments: out, strip };
  if (a.photo) {
    out.push({ kind: 'image', name: 'Fotoğraf', url: a.photo.media_url_https, link: a.photo.media_url_https });
    if (a.photo.url) strip.push(a.photo.url);
  }
  if (a.video) {
    out.push({ kind: 'video', name: 'Video', url: a.video.media_url_https, link: mp4(a.video) ?? a.video.media_url_https });
    if (a.video.url) strip.push(a.video.url);
  }
  if (a.animated_gif) {
    out.push({ kind: 'video', name: 'GIF', url: a.animated_gif.media_url_https, link: mp4(a.animated_gif) });
    if (a.animated_gif.url) strip.push(a.animated_gif.url);
  }
  if (a.tweet?.status) {
    const t = a.tweet.status;
    const u = t.user ?? {};
    const media = t.extended_entities?.media?.[0] ?? t.entities?.media?.[0];
    const text = String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim();
    const page = `https://x.com/${u.screen_name ?? 'i'}/status/${t.id_str ?? t.id}`;
    const isVideo = media && media.type !== 'photo';
    out.push({
      kind: media ? (isVideo ? 'video' : 'image') : 'other',
      name: `Gönderi · @${u.screen_name ?? '?'}${text ? ': ' + (text.length > 90 ? text.slice(0, 89) + '…' : text) : ''}`,
      url: media?.media_url_https ?? u.profile_image_url_https?.replace('_normal.', '_bigger.'),
      link: isVideo ? (mp4(media) ?? page) : media ? media.media_url_https : page,
      page,
    });
    if (a.tweet.url) strip.push(a.tweet.url);
  }
  if (a.card) {
    const bv = a.card.binding_values ?? {};
    const title = bv.title?.string_value ?? bv.vanity_url?.string_value ?? 'Bağlantı';
    const img = bv.thumbnail_image_large?.image_value?.url ?? bv.summary_photo_image?.image_value?.url ?? bv.thumbnail_image?.image_value?.url;
    const link = bv.card_url?.string_value ?? a.card.url;
    out.push({ kind: 'other', name: title, url: img, link });
    if (a.card.url) strip.push(a.card.url);
  }
  return { attachments: out, strip };
}

function fromEntries(entries: J[], convId?: string): Msg[] {
  return entries
    .filter((e) => e.message && (!convId || e.message.conversation_id === convId))
    .map((e) => {
      const m = e.message;
      const md = m.message_data ?? {};
      const sid = String(md.sender_id ?? '');
      const { attachments, strip } = attachmentsOf(md);
      let text = String(md.text ?? '');
      for (const u of strip) text = text.replace(u, '');
      // metindeki t.co kısaltmalarını açık adresle değiştir
      for (const u of md.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.replace(u.url, u.expanded_url);
      return {
        id: String(m.id),
        text: text.trim(),
        ts: Number(m.time ?? md.time ?? Date.now()),
        fromMe: sid === meId,
        senderId: sid,
        senderName: users.get(sid) ?? 'X kullanıcısı',
        senderAvatarUrl: avatars.get(sid),
        attachments,
      };
    });
}

const CHAT = 'https://x.com/i/chat';
const TR_MONTHS: Record<string, number> = { oca: 0, şub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, eki: 9, kas: 10, ara: 11, jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "3 g", "1 ha", "12 dk", "2 sa", "5 ay" → yaklaşık zaman damgası */
function fromRelative(rel: string): number {
  const m = rel.trim().match(/^(\d+)\s*(dk|sa|g|ha|ay|y|m|h|d|w|mo)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === 'dk' || unit === 'm' ? 60e3 : unit === 'sa' || unit === 'h' ? 3600e3 : unit === 'g' || unit === 'd' ? 86400e3 : unit === 'ha' || unit === 'w' ? 7 * 86400e3 : unit === 'ay' || unit === 'mo' ? 30 * 86400e3 : 365 * 86400e3;
  return Date.now() - n * ms;
}
/** "15 Eyl Sal, 21:47" / "15 Eyl 2025 Sal, 21:47" → gün başlangıcı; saat ayrıca alınır */
function parseDayLabel(label: string): number | undefined {
  const m = label.match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})\w*\.?\s*(\d{4})?/);
  if (!m) return undefined;
  const mon = TR_MONTHS[m[2].toLocaleLowerCase('tr')];
  if (mon === undefined) return undefined;
  const now = new Date();
  let d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, Number(m[1]));
  if (!m[3] && d.getTime() > now.getTime() + 86400e3) d = new Date(now.getFullYear() - 1, mon, Number(m[1]));
  return d.getTime();
}
/** Önceki yoklamada görülen DOM önizlemesi: değiştiyse sohbet "yeni etkinlik" sayılır */
const domPreview = new Map<string, string>();
void fromRelative;
/** 1.1 ucunda bulunmayan (yalnızca XChat) sohbetler */
const apiMissing = new Set<string>();

async function domInbox(page: Page): Promise<Array<{ id: string; name: string; preview: string; rel: string }>> {
  if (!page.url().startsWith(CHAT)) await page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid^="dm-conversation-item-"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const out: Array<{ id: string; name: string; preview: string; rel: string }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="dm-conversation-item-"]'))) {
      const raw = el.getAttribute('data-testid')!.slice('dm-conversation-item-'.length);
      const id = raw.replace(':', '-');
      const lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
      if (!lines.length) continue;
      const relIdx = lines.findIndex((t, i) => i > 0 && /^\d+\s*(dk|sa|g|ha|ay|y|m|h|d|w|mo)$/i.test(t));
      const name = lines[0];
      const rel = relIdx > 0 ? lines[relIdx] : '';
      const preview = lines.slice(relIdx > 0 ? relIdx + 1 : 1).join(' ').replace(/^(You|Sen):\s*/, '');
      out.push({ id, name, preview, rel });
    }
    return out;
  });
}

async function domMessages(page: Page, threadId: string): Promise<Msg[]> {
  const url = `${CHAT}/${threadId}`;
  if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="dm-message-list"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="dm-message-scroller"]') ?? document.querySelector<HTMLElement>('[data-testid="dm-message-list"]');
    if (!scroller) return [] as Array<{ id: string; text: string; time: string; day: string; me: boolean; media: boolean }>;
    const pr = scroller.getBoundingClientRect();
    const mid = pr.left + pr.width / 2;
    const out: Array<{ id: string; text: string; time: string; day: string; me: boolean; media: boolean }> = [];
    let day = '';
    for (const el of Array.from(scroller.querySelectorAll<HTMLElement>('*'))) {
      const tid = el.getAttribute('data-testid') ?? '';
      if (tid.startsWith('message-') && !tid.startsWith('message-text-')) {
        const textEl = el.querySelector<HTMLElement>('[data-testid^="message-text-"]');
        // metin öğesi saati de içeriyor ("altlar 6000\n22:08"): sondaki saati at
        const text = (textEl?.innerText ?? '')
          .split('\n')
          .map((t) => t.trim())
          .filter((t) => t && !/^\d{2}:\d{2}$/.test(t) && !/^(Görüldü|Seen|Gönderildi|Sent|Yeni|New)$/i.test(t))
          .join('\n');
        const time = (el.innerText.match(/(^|\s)(\d{2}:\d{2})(\s|$)/) ?? [])[2] ?? '';
        const r = (textEl ?? el).getBoundingClientRect();
        out.push({ id: tid.slice('message-'.length), text, time, day, me: r.left + r.width / 2 > mid, media: !!el.querySelector('img[src*="pbs.twimg"], video') });
      } else if (el.children.length === 0 && /^\d{1,2}\s+\S+.*,\s*\d{2}:\d{2}$/.test(el.innerText?.trim() ?? '')) {
        day = el.innerText.trim();
      }
    }
    return out;
  });
  const others = threadId.split('-').filter((p) => p !== meId);
  const senderId = others[0] ?? threadId;
  return rows
    .filter((r) => r.text || r.media)
    .map((r, i) => {
      const dayTs = parseDayLabel(r.day);
      const tm = r.time.match(/(\d{2}):(\d{2})/);
      const ts = dayTs !== undefined && tm ? dayTs + Number(tm[1]) * 3600e3 + Number(tm[2]) * 60e3 : Date.now() - (rows.length - i) * 1000;
      return { id: 'xc-' + r.id, text: r.text || '[medya]', ts, fromMe: r.me, senderId: r.me ? 'me' : senderId, senderName: r.me ? 'Ben' : (users.get(senderId) ?? 'X kullanıcısı'), senderAvatarUrl: r.me ? undefined : avatars.get(senderId) };
    });
}

export const x: Strategy = {
  home: 'https://x.com/messages',
  loginHint: 'Açılan pencerede X hesabına giriş yap',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.ct0 && cookies.auth_token);
  },

  async me(page, cookies) {
    meId = meFromCookies(cookies);
    try {
      const v = await xapi(page, cookies, '/1.1/account/verify_credentials.json');
      meId = String(v.id_str ?? v.id ?? meId);
      users.set(meId, v.name ?? 'Ben');
      return { id: meId, label: v.screen_name ? `@${v.screen_name}` : 'X' };
    } catch {
      // verify_credentials kapalı olabilir; gelen kutusundaki kullanıcı listesinden adı bul
      const data: J = await xapi(page, cookies, '/1.1/dm/inbox_initial_state.json?include_ext_alt_text=false&include_reply_count=1&tweet_mode=extended&dm_secret_conversations_enabled=false').catch(() => ({}) as J);
      const u = data?.inbox_initial_state?.users?.[meId];
      return { id: meId, label: u?.screen_name ? `@${u.screen_name}` : 'X' };
    }
  },

  async threads(page, cookies): Promise<Thread[]> {
    const data = await xapi(page, cookies, '/1.1/dm/inbox_initial_state.json?include_ext_alt_text=false&include_reply_count=1&tweet_mode=extended&dm_secret_conversations_enabled=false');
    const state = data.inbox_initial_state ?? {};
    collectUsers(state);
    const lastByConv = new Map<string, J>();
    for (const e of state.entries ?? []) if (e.message) lastByConv.set(e.message.conversation_id, e.message);
    const out: Thread[] = [];
    for (const [id, c] of Object.entries(state.conversations ?? {}) as Array<[string, J]>) {
      const others = (c.participants ?? []).map((p: J) => String(p.user_id)).filter((u: string) => u !== meId);
      const last = lastByConv.get(id);
      const participants = (c.participants ?? []).map((p: J) => ({ id: String(p.user_id), name: users.get(String(p.user_id)) ?? String(p.user_id), handle: handles.get(String(p.user_id)), avatarUrl: avatars.get(String(p.user_id)) }));
      out.push({
        id,
        handle: c.type === 'GROUP_DM' ? undefined : handles.get(others[0]),
        link: c.type === 'GROUP_DM' ? undefined : handles.get(others[0]) ? `https://x.com/${handles.get(others[0])!.slice(1)}` : undefined,
        participants,
        name: c.name || groupName(others) || 'Sohbet',
        kind: c.type === 'GROUP_DM' ? 'group' : 'direct',
        lastTs: Number(c.sort_timestamp ?? last?.time ?? 0),
        preview: last?.message_data?.text ?? '',
        unread: last && String(last.message_data?.sender_id) !== meId && Number(c.last_read_event_id ?? 0) < Number(last.id) ? 1 : 0,
        avatarUrl: c.type === 'GROUP_DM' ? c.avatar_image_https : avatars.get(others[0]),
      });
    }
    // XChat (Kasım 2025 sonrası uçtan uca şifreli sohbetler) 1.1 uçlarında görünmez; /i/chat DOM'undan tamamla
    try {
      const dom = await domInbox(page);
      for (const d of dom) {
        const prev = domPreview.get(d.id);
        domPreview.set(d.id, d.preview);
        const changed = prev !== undefined && prev !== d.preview;
        const ex = out.find((t) => t.id === d.id);
        if (ex) {
          // göreli süre ("3 g") kaba: var olan sohbetin zamanını yalnızca önizleme değiştiğinde (yeni mesaj) ilerlet
          if (d.preview && d.preview !== ex.preview.replace(/^(You|Sen):\s*/, '')) {
            ex.preview = d.preview;
            if (changed) ex.lastTs = Math.max(ex.lastTs, Date.now());
          }
        } else {
          // göreli süre kaba; zaman mesajlar okununca gerçek değerini alır (ilk görüşte 0), önizleme değişince "şimdi"
          out.push({ id: d.id, name: d.name || 'Sohbet', kind: d.id.startsWith('g') ? 'group' : 'direct', lastTs: changed ? Date.now() : 0, preview: d.preview, unread: 0 });
        }
      }
    } catch (e) {
      bus.log('warn', `X sohbet listesi (DOM) okunamadı: ${(e as Error).message}`);
    }
    return out;
  },

  async messages(page, cookies, threadId, limit): Promise<Msg[]> {
    // XChat grup kimlikleri (g…) ve daha önce 404 veren sohbetler 1.1 ucunda yok → yalnızca DOM
    let api: Msg[] = [];
    if (!threadId.startsWith('g') && !apiMissing.has(threadId)) {
      try {
        const data = await xapi(page, cookies, `/1.1/dm/conversation/${encodeURIComponent(threadId)}.json?count=${limit}&include_ext_alt_text=false&tweet_mode=extended`);
        const tl = data.conversation_timeline ?? {};
        collectUsers(tl);
        api = fromEntries(tl.entries ?? [], threadId).reverse();
      } catch (e) {
        if (/X 404/.test((e as Error).message)) apiMissing.add(threadId);
        else throw e;
      }
    }
    let dom: Msg[] = [];
    try {
      dom = await domMessages(page, threadId);
    } catch (e) {
      bus.log('warn', `X mesajlar (DOM) okunamadı (${threadId}): ${(e as Error).message}`);
    }
    // aynı mesaj iki kaynakta da olabilir (eski DM'ler): metin + yön + ±3 dk eşleşiyorsa API kaydı kalsın
    const dup = (m: Msg) => api.some((a) => a.fromMe === m.fromMe && a.text === m.text && Math.abs(a.ts - m.ts) < 180e3);
    return [...api, ...dom.filter((m) => !dup(m))].sort((a, b) => a.ts - b.ts).slice(-Math.max(limit, 25));
  },

  async markRead(page, _cookies, threadId) {
    // /i/chat/<id> sayfasını açmak hem eski DM'leri hem XChat'i okundu işaretler
    const url = `${CHAT}/${threadId}`;
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
  },

  async openDirect(_page, _cookies, p) {
    // X birebir sohbet kimliği: iki kullanıcı kimliğinin küçükten büyüğe birleşimi
    const a = BigInt(meId);
    const b = BigInt(p.id);
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  },

  async send(page, cookies, threadId, text) {
    // Şifreli (XChat) sohbetlerde 1.1 gönderimi reddedilir → sayfadaki yazı kutusuna yaz
    const domSend = async (): Promise<string | undefined> => {
      const url = `${CHAT}/${threadId}`;
      if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const box = page.locator('[data-testid="dm-composer-textarea"]').first();
      await box.waitFor({ timeout: 15_000 });
      await box.click();
      await box.fill(text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      return undefined;
    };
    let r: J;
    try {
      r = await xapi(page, cookies, '/1.1/dm/new2.json?ext=mediaColor,altText&include_ext_alt_text=true&supports_reactions=true', {
      conversation_id: threadId,
      recipient_ids: false,
      request_id: crypto.randomUUID(),
      text,
      cards_platform: 'Web-12',
      include_cards: 1,
      include_quote_count: true,
      dm_users: false,
      });
    } catch {
      return domSend();
    }
    return r?.entries?.[0]?.message?.id ? String(r.entries[0].message.id) : domSend();
  },
};
