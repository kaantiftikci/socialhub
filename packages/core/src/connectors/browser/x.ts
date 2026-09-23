import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment } from '../../model.js';

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
    return out;
  },

  async messages(page, cookies, threadId, limit): Promise<Msg[]> {
    const data = await xapi(page, cookies, `/1.1/dm/conversation/${encodeURIComponent(threadId)}.json?count=${limit}&include_ext_alt_text=false&tweet_mode=extended`);
    const tl = data.conversation_timeline ?? {};
    collectUsers(tl);
    return fromEntries(tl.entries ?? [], threadId).reverse();
  },

  async openDirect(_page, _cookies, p) {
    // X birebir sohbet kimliği: iki kullanıcı kimliğinin küçükten büyüğe birleşimi
    const a = BigInt(meId);
    const b = BigInt(p.id);
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  },

  async send(page, cookies, threadId, text) {
    const r = await xapi(page, cookies, '/1.1/dm/new2.json?ext=mediaColor,altText&include_ext_alt_text=true&supports_reactions=true', {
      conversation_id: threadId,
      recipient_ids: false,
      request_id: crypto.randomUUID(),
      text,
      cards_platform: 'Web-12',
      include_cards: 1,
      include_quote_count: true,
      dm_users: false,
    });
    return r?.entries?.[0]?.message?.id ? String(r.entries[0].message.id) : undefined;
  },
};
