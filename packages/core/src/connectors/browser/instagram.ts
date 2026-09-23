import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment } from '../../model.js';
import { bus } from '../../bus.js';

/** Instagram: web istemcisinin kullandığı /api/v1/direct_v2 uçları, sayfa bağlamında (çerezlerle). */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const APP_ID = '936619743392459';

async function ig(page: Page, cookies: Record<string, string>, path: string, form?: Record<string, string>): Promise<J> {
  return page.evaluate(
    async ({ path, form, csrf, appId }) => {
      const r = await fetch('https://www.instagram.com' + path, {
        method: form ? 'POST' : 'GET',
        headers: {
          'x-ig-app-id': appId,
          'x-requested-with': 'XMLHttpRequest',
          'x-csrftoken': csrf,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        credentials: 'include',
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`Instagram ${r.status} ${path}: ${text.slice(0, 120)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Instagram beklenmeyen yanıt ${path}: ${text.slice(0, 80)}`);
      }
    },
    { path, form, csrf: cookies.csrftoken ?? '', appId: APP_ID },
  );
}

let viewerId = '';
const userNames = new Map<string, string>();
const userPics = new Map<string, string>();
let debugged = 0;

/** Bir Instagram medya nesnesinden (gönderi/reel/story) önizleme görseli */
function mediaImage(m: J | undefined): string | undefined {
  if (!m) return undefined;
  const c = m.image_versions2?.candidates ?? m.carousel_media?.[0]?.image_versions2?.candidates;
  if (Array.isArray(c) && c.length) {
    // en küçük ama ≥ 320px olanı seç (hızlı yüklensin)
    const sorted = [...c].sort((a: J, b: J) => (a.width ?? 0) - (b.width ?? 0));
    return (sorted.find((x: J) => (x.width ?? 0) >= 320) ?? sorted[sorted.length - 1])?.url;
  }
  return m.thumbnail_url;
}

function mediaLink(m: J | undefined): string | undefined {
  if (!m?.code) return undefined;
  return m.media_type === 2 && m.product_type === 'clips' ? `https://www.instagram.com/reel/${m.code}/` : `https://www.instagram.com/p/${m.code}/`;
}

function caption(m: J | undefined, max = 140): string {
  const t = String(m?.caption?.text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Mesaj öğesini metin + eklere çevir. Paylaşılan gönderi/reel/story görsel önizleme ve bağlantı olarak gelir. */
function itemContent(it: J): { text: string; attachments: Attachment[] } {
  const att: Attachment[] = [];
  const post = (m: J | undefined, label: string, kind: 'image' | 'video' = 'image') => {
    if (!m) return label;
    const user = m.user?.username ? `@${m.user.username}` : '';
    const cap = caption(m);
    att.push({ kind, name: [label, user].filter(Boolean).join(' · '), url: mediaImage(m), link: mediaLink(m) });
    return cap ? `${user ? user + ': ' : ''}${cap}` : '';
  };
  // Yeni "xma" biçimi (2024+): önizleme + hedef bağlantı hazır gelir
  const xmaRaw = it.xma_media_share ?? it.xma_reel_share ?? it.xma_story_share ?? it.xma_reel_mention ?? it.xma_link ?? it.xma_profile ?? it.generic_xma ?? it.xma_clip ?? it.xma;
  const xma: J | undefined = Array.isArray(xmaRaw) ? xmaRaw[0] : xmaRaw;
  if (String(it.item_type ?? '').startsWith('xma') && !xma?.preview_url && !xma?.preview_url_info && debugged < 3) {
    debugged++;
    bus.log('warn', `Instagram tanınmayan xma öğesi: ${JSON.stringify(it).slice(0, 700)}`);
  }
  if (xma) {
    const title = [xma.subtitle_text || 'Paylaşım', xma.header_title ? '@' + String(xma.header_title).replace(/^@/, '') : '', xma.title_text].filter(Boolean).join(' · ');
    att.push({ kind: xma.playable_url ? 'video' : 'image', name: title, url: xma.preview_url ?? xma.preview_url_info?.url, link: xma.target_url ?? xma.header_url, mime: xma.playable_url ? 'video/mp4' : undefined });
    if (xma.playable_url) att[att.length - 1].link = xma.playable_url;
    return { text: it.text ?? '', attachments: att };
  }
  switch (it.item_type) {
    case 'text':
      return { text: it.text ?? '', attachments: att };
    case 'link': {
      const lc = it.link?.link_context;
      att.push({ kind: 'other', name: lc?.link_title || lc?.link_url || 'Bağlantı', url: lc?.link_image_url || undefined, link: lc?.link_url });
      return { text: it.link?.text ?? '', attachments: att };
    }
    case 'media': {
      const m = it.media;
      const video = m?.media_type === 2 ? m?.video_versions?.[0]?.url : undefined;
      att.push({ kind: video ? 'video' : 'image', name: video ? 'Video' : 'Fotoğraf', url: mediaImage(m), link: video });
      return { text: '', attachments: att };
    }
    case 'raven_media':
      att.push({ kind: 'image', name: 'Tek seferlik görsel', url: mediaImage(it.visual_media?.media) });
      return { text: '', attachments: att };
    case 'voice_media':
      att.push({ kind: 'audio', name: 'Sesli mesaj', link: it.voice_media?.media?.audio?.audio_src });
      return { text: '', attachments: att };
    case 'media_share':
      return { text: post(it.media_share, 'Gönderi', it.media_share?.media_type === 2 ? 'video' : 'image'), attachments: att };
    case 'clip':
      return { text: post(it.clip?.clip, 'Reels', 'video'), attachments: att };
    case 'felix_share':
      return { text: post(it.felix_share?.video, 'Video', 'video'), attachments: att };
    case 'reel_share': {
      const rs = it.reel_share;
      const kind = rs?.type === 'reply' ? 'Hikâyene yanıt' : rs?.type === 'mention' ? 'Hikâyede bahsetti' : rs?.type === 'reaction' ? 'Hikâyene tepki' : 'Hikâye';
      att.push({ kind: 'image', name: kind + (rs?.media?.user?.username ? ` · @${rs.media.user.username}` : ''), url: mediaImage(rs?.media), link: mediaLink(rs?.media) });
      return { text: rs?.text ?? '', attachments: att };
    }
    case 'story_share': {
      const ss = it.story_share;
      att.push({ kind: 'image', name: ss?.title || 'Hikâye', url: mediaImage(ss?.media), link: mediaLink(ss?.media) });
      return { text: ss?.message && ss.message !== ss.title ? ss.message : '', attachments: att };
    }
    case 'animated_media':
      att.push({ kind: 'image', name: 'GIF', url: it.animated_media?.images?.fixed_height?.url });
      return { text: '', attachments: att };
    case 'like':
      return { text: '❤', attachments: att };
    case 'action_log':
      return { text: '', attachments: att };
    default:
      return { text: it.text ?? '', attachments: it.item_type ? [{ kind: 'other', name: String(it.item_type) }] : att };
  }
}

function itemText(it: J): string {
  const { text, attachments } = itemContent(it);
  return text || (attachments[0]?.name ? `[${attachments[0].name}]` : '');
}

export const instagram: Strategy = {
  home: 'https://www.instagram.com/direct/inbox/',
  loginHint: 'Açılan pencerede Instagram hesabına giriş yap',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.ds_user_id && cookies.sessionid);
  },

  async me(page, cookies) {
    viewerId = cookies.ds_user_id ?? '';
    try {
      const u = await ig(page, cookies, `/api/v1/users/${viewerId}/info/`);
      return { id: viewerId, label: u.user?.username ? `@${u.user.username}` : 'Instagram' };
    } catch {
      return { id: viewerId, label: 'Instagram' };
    }
  },

  async threads(page, cookies): Promise<Thread[]> {
    const data = await ig(page, cookies, '/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=30&thread_message_limit=1');
    if (data.viewer?.pk) viewerId = String(data.viewer.pk);
    const out: Thread[] = [];
    for (const t of data.inbox?.threads ?? []) {
      for (const u of t.users ?? []) {
        userNames.set(String(u.pk), u.full_name || u.username);
        if (u.profile_pic_url) userPics.set(String(u.pk), u.profile_pic_url);
      }
      const last = t.last_permanent_item ?? t.items?.[0];
      const participants = (t.users ?? []).map((u: J) => ({ id: String(u.pk), name: u.full_name || u.username, handle: u.username ? '@' + u.username : undefined, avatarUrl: u.profile_pic_url }));
      const solo = !t.is_group && t.users?.[0];
      out.push({
        handle: solo?.username ? '@' + solo.username : undefined,
        link: solo?.username ? `https://www.instagram.com/${solo.username}/` : undefined,
        participants,
        id: String(t.thread_id),
        name: t.thread_title || (t.users ?? []).map((u: J) => u.full_name || u.username).join(', ') || 'Sohbet',
        kind: t.is_group ? 'group' : 'direct',
        lastTs: Math.floor(Number(t.last_activity_at ?? last?.timestamp ?? 0) / 1000),
        preview: last ? itemText(last) : '',
        unread: Number(t.read_state ?? 0) > 0 ? Number(t.unseen_count ?? 1) : 0,
        avatarUrl: t.is_group ? undefined : t.users?.[0]?.profile_pic_url,
      });
    }
    return out;
  },

  async messages(page, cookies, threadId, limit): Promise<Msg[]> {
    const data = await ig(page, cookies, `/api/v1/direct_v2/threads/${threadId}/?limit=${limit}`);
    for (const u of data.thread?.users ?? []) {
      userNames.set(String(u.pk), u.full_name || u.username);
      if (u.profile_pic_url) userPics.set(String(u.pk), u.profile_pic_url);
    }
    return (data.thread?.items ?? []).map((it: J) => {
      const uid = String(it.user_id);
      const { text, attachments } = itemContent(it);
      return {
        id: String(it.item_id),
        text,
        attachments,
        senderAvatarUrl: userPics.get(uid),
        ts: Math.floor(Number(it.timestamp ?? 0) / 1000),
        fromMe: uid === viewerId,
        senderId: uid,
        senderName: userNames.get(uid) ?? 'Instagram kullanıcısı',
      };
    });
  },

  async openDirect(page, cookies, p) {
    const r = await ig(page, cookies, '/api/v1/direct_v2/create_group_thread/', { recipient_users: JSON.stringify([String(p.id)]) });
    if (!r?.thread_id) throw new Error('Instagram sohbet açılamadı');
    return String(r.thread_id);
  },

  async send(page, cookies, threadId, text) {
    const r = await ig(page, cookies, '/api/v1/direct_v2/threads/broadcast/text/', {
      action: 'send_item',
      client_context: String(Date.now()) + Math.floor(Math.random() * 1e6),
      mutation_token: String(Date.now()),
      text,
      thread_ids: `["${threadId}"]`,
    });
    return r?.payload?.item_id ? String(r.payload.item_id) : undefined;
  },
};
