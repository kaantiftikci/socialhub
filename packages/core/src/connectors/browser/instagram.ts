import type { Page } from 'playwright';
import { apiOf, needsPage, type Msg, type Strategy, type Thread } from './bridge.js';
import { pickFileInput } from './outlook.js';
import type { Attachment } from '../../model.js';
import { bus } from '../../bus.js';

/** Instagram: web istemcisinin kullandığı /api/v1/direct_v2 uçları, sayfa bağlamında (çerezlerle). */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const APP_ID = '936619743392459';

async function ig(page: Page, cookies: Record<string, string>, path: string, form?: Record<string, string>): Promise<J> {
  // Sayfasız mod: aynı istek Node'dan (Playwright request bağlamı; çerezler + gerçek Chrome kimliği). Profil kopyasıyla doğrulandı (200).
  const h = apiOf(page);
  if (h) {
    const r = await h.api.fetch('https://www.instagram.com' + path, {
      method: form ? 'POST' : 'GET',
      headers: {
        'x-ig-app-id': APP_ID,
        'x-requested-with': 'XMLHttpRequest',
        'x-csrftoken': cookies.csrftoken ?? '',
        'x-asbd-id': '129477',
        referer: 'https://www.instagram.com/direct/inbox/',
        origin: 'https://www.instagram.com',
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      data: form ? new URLSearchParams(form).toString() : undefined,
      timeout: 45_000,
    });
    const text = await r.text();
    if (!r.ok()) throw new Error(`Instagram ${r.status()} ${path}: ${text.slice(0, 120)}`);
    try {
      return JSON.parse(text) as J;
    } catch {
      throw new Error(`Instagram beklenmeyen yanıt ${path}: ${text.slice(0, 80)}`);
    }
  }
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
        // asılı kalan istek page.evaluate'i (ve köprü kuyruğunu) sonsuza dek bekletmesin
        signal: AbortSignal.timeout(45_000),
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
/** thread → karşı tarafın son gördüğü an (ms) */
const otherSeenMs = new Map<string, number>();
const userNames = new Map<string, string>();
const userPics = new Map<string, string>();
let debugged = 0;
/**
 * Sohbet başına bilinen sayfalama imleçleri (eski mesaj yükleme): threadId → [{ cursor, o sayfanın en eski mesajı (ms) }].
 * Bir imleç, oldestTs'ten ESKİ mesajları verir; `before` için en uygun imleç oldestTs ≥ before olanların en eskisidir
 * (oldestTs < before olan imleç [oldestTs, before) aralığını atlardı → boşluk).
 */
const cursors = new Map<string, Array<{ cursor: string; oldestTs: number }>>();

/** `before`dan eski mesajlara boşluksuz ulaşan en derin imleç */
export function pickCursor(list: Array<{ cursor: string; oldestTs: number }> | undefined, before: number): string | undefined {
  let best: { cursor: string; oldestTs: number } | undefined;
  for (const c of list ?? []) if (c.oldestTs >= before && (!best || c.oldestTs < best.oldestTs)) best = c;
  return best?.cursor;
}

function rememberCursor(threadId: string, cursor: string, oldestTs: number): void {
  const list = cursors.get(threadId) ?? [];
  if (!list.some((c) => c.cursor === cursor)) list.push({ cursor, oldestTs });
  // sohbet başına en çok 20 imleç (en yenileri değil en farklı derinlikler kalsın: eski ucu koru)
  list.sort((a, b) => b.oldestTs - a.oldestTs);
  if (list.length > 20) list.splice(0, list.length - 20);
  cursors.set(threadId, list);
}

/** Okunma kaydı/tepki satırı ("Bir mesajı beğendi"): sohbette gizli (hide_in_thread), mesaj değildir */
const isLogItem = (it: J) => it.item_type === 'action_log' || Number(it.hide_in_thread ?? 0) === 1;

/** Instagram zaman damgaları µs; ms'ye çevir */
const tsMs = (t: unknown) => Math.floor(Number(t ?? 0) / 1000);

/** Sohbet listesi/mesaj yanıtındaki kullanıcıları ad ve fotoğraf haritasına al */
function rememberUsers(users: J[] | undefined) {
  for (const u of users ?? []) {
    userNames.set(String(u.pk), u.full_name || u.username);
    if (u.profile_pic_url) userPics.set(String(u.pk), u.profile_pic_url);
  }
}

/** Bir Instagram medya nesnesinden (gönderi/reel/story) önizleme görseli; carousel'de ilk öğe */
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

/** Medya nesnesinin (ya da carousel'de ilk öğesinin) video dosyası (mp4 CDN adresi) */
function mediaVideo(m: J | undefined): string | undefined {
  if (!m) return undefined;
  const first: J = m.carousel_media?.[0] ?? m;
  const v = first.video_versions ?? m.video_versions;
  if (!Array.isArray(v) || !v.length) return undefined;
  // en düşük çözünürlük yeterli (DM önizlemesi); yoksa ilk
  const sorted = [...v].filter((x: J) => x.url).sort((a: J, b: J) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((x: J) => (x.width ?? 0) >= 480) ?? sorted[0])?.url;
}

function mediaLink(m: J | undefined): string | undefined {
  if (!m?.code) return undefined;
  return m.media_type === 2 && m.product_type === 'clips' ? `https://www.instagram.com/reel/${m.code}/` : `https://www.instagram.com/p/${m.code}/`;
}

function caption(m: J | undefined, max = 140): string {
  const t = String(m?.caption?.text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Mesaj öğesini metin + eklere çevir. Paylaşılan gönderi/reel/story görsel önizleme (url), medya dosyası (link: video mp4,
 * CDN → köprü vekile çevirir) ve gönderi sayfası (page) olarak gelir; foto gönderilerde link gönderi sayfasıdır.
 */
function itemContent(it: J): { text: string; attachments: Attachment[] } {
  const att: Attachment[] = [];
  const post = (m: J | undefined, label: string, forceVideo = false) => {
    if (!m) return label;
    const user = m.user?.username ? `@${m.user.username}` : '';
    const cap = caption(m);
    const video = mediaVideo(m);
    const page = mediaLink(m);
    const kind = video || forceVideo ? 'video' : 'image';
    const count = Array.isArray(m.carousel_media) && m.carousel_media.length > 1 ? ` (${m.carousel_media.length})` : '';
    att.push({ kind, name: [label + count, user].filter(Boolean).join(' · '), url: mediaImage(m), link: video ?? page, page, mime: video ? 'video/mp4' : undefined });
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
    const target = xma.target_url ?? xma.header_url;
    att.push({ kind: xma.playable_url ? 'video' : 'image', name: title, url: xma.preview_url ?? xma.preview_url_info?.url, link: xma.playable_url ?? target, page: target, mime: xma.playable_url ? 'video/mp4' : undefined });
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
      // doğrudan çekilen/yüklenen foto ya da video
      const m = it.media;
      const video = mediaVideo(m);
      att.push({ kind: video ? 'video' : 'image', name: video ? 'Video' : 'Fotoğraf', url: mediaImage(m), link: video, mime: video ? 'video/mp4' : undefined });
      return { text: '', attachments: att };
    }
    case 'raven_media': {
      // tek seferlik görsel: açıldıysa/süresi dolduysa medya gelmez, yalnızca tür bilgisi kalır
      const m = it.visual_media?.media ?? (it.raven_media?.image_versions2 || it.raven_media?.video_versions ? it.raven_media : undefined);
      const video = mediaVideo(m);
      const isVideo = video || Number(it.raven_media?.media_type ?? it.visual_media?.media?.media_type) === 2;
      att.push({ kind: isVideo ? 'video' : 'image', name: isVideo ? 'Tek seferlik video' : 'Tek seferlik görsel', url: mediaImage(m), link: video, mime: video ? 'video/mp4' : undefined });
      return { text: '', attachments: att };
    }
    case 'voice_media': {
      const a = it.voice_media?.media?.audio;
      const secs = a?.duration ? Math.round(Number(a.duration) / 1000) : 0;
      att.push({ kind: 'audio', name: secs ? `Sesli mesaj · ${secs} sn` : 'Sesli mesaj', link: a?.audio_src, mime: 'audio/mp4' });
      return { text: '', attachments: att };
    }
    case 'media_share':
      // 2025+: gönderi `direct_media_share.media` altında gelir; eski biçim `media_share`
      return { text: post(it.direct_media_share?.media ?? it.media_share, 'Gönderi'), attachments: att };
    case 'clip':
      return { text: post(it.clip?.clip, 'Reels', true), attachments: att };
    case 'felix_share':
      return { text: post(it.felix_share?.video, 'Video', true), attachments: att };
    case 'reel_share': {
      const rs = it.reel_share;
      const kind = rs?.type === 'reply' ? 'Hikâyene yanıt' : rs?.type === 'mention' ? 'Hikâyede bahsetti' : rs?.type === 'reaction' ? 'Hikâyene tepki' : 'Hikâye';
      const m: J | undefined = rs?.media?.image_versions2 || rs?.media?.video_versions ? rs.media : undefined; // süresi dolmuş hikâyede yalnızca user kalır
      const video = mediaVideo(m);
      const name = kind + (rs?.media?.user?.username ? ` · @${rs.media.user.username}` : '');
      if (m) att.push({ kind: video ? 'video' : 'image', name, url: mediaImage(m), link: video ?? mediaLink(m), page: mediaLink(m), mime: video ? 'video/mp4' : undefined });
      else att.push({ kind: 'other', name: name + ' (hikâye artık görünmüyor)' });
      const emoji = rs?.reaction_info?.emoji ? String(rs.reaction_info.emoji) : '';
      return { text: rs?.text || emoji, attachments: att };
    }
    case 'story_share': {
      const ss = it.story_share;
      const m: J | undefined = ss?.media?.image_versions2 || ss?.media?.video_versions ? ss.media : undefined;
      const video = mediaVideo(m);
      const user = m?.user?.username ? ` · @${m.user.username}` : '';
      if (m) att.push({ kind: video ? 'video' : 'image', name: (ss?.title || 'Hikâye') + user, url: mediaImage(m), link: video ?? mediaLink(m), page: mediaLink(m), mime: video ? 'video/mp4' : undefined });
      else att.push({ kind: 'other', name: ss?.title || 'Hikâye' }); // erişilemeyen hikâye: yalnızca başlık/mesaj
      const text = ss?.text || (ss?.message && ss.message !== ss.title ? ss.message : '');
      return { text, attachments: att };
    }
    case 'animated_media': {
      const im = it.animated_media?.images ?? {};
      const g = im.fixed_height ?? im.original ?? im.fixed_height_downsampled ?? im.preview_gif;
      att.push({ kind: 'image', name: 'GIF', url: g?.url ?? g?.webp, mime: g?.url ? 'image/gif' : 'image/webp' });
      return { text: '', attachments: att };
    }
    case 'profile': {
      const p = it.profile;
      att.push({ kind: 'other', name: p?.username ? `Profil · @${p.username}` : 'Profil', url: p?.profile_pic_url, link: p?.username ? `https://www.instagram.com/${p.username}/` : undefined });
      return { text: p?.full_name ?? '', attachments: att };
    }
    case 'placeholder': {
      const p = it.placeholder;
      return { text: '', attachments: [{ kind: 'other', name: p?.message || p?.title || 'Desteklenmeyen mesaj' }] };
    }
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

/** Sohbet sayfasındaki dosya girişi: dosya türünü accept listesi kabul ediyorsa (uzantı ya da mime) */
export async function dmFileInput(page: Page, file: { name: string; mime: string }) {
  for (let i = 0; i < 20; i++) {
    const inputs = page.locator('[role="main"] input[type="file"], input[type="file"]');
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

/**
 * Gelen kutusu sayfası. thread_message_limit=10: her sohbetin son mesajları da gelir → okunmamış sayısı gerçekten
 * hesaplanır (inbox yanıtında unseen_count yok; read_state yalnızca 0/1 veriyor). Instagram bazen geniş isteğe
 * (limit=40, thread_message_limit=10) 500 'Oops' döndürüyor: dar parametrelerle (tek mesaj) yedek. `cursor`: sonraki sayfa.
 */
async function fetchInbox(page: Page, cookies: Record<string, string>, cursor?: string): Promise<J> {
  const q = (tml: number) => `/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=20&thread_message_limit=${tml}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  return ig(page, cookies, q(10)).catch(async (e: Error) => {
    if (!/Instagram 5\d\d/.test(e.message)) throw e;
    return ig(page, cookies, q(1));
  });
}

/** Gelen kutusu sayfalama zinciri: k. sayfanın (0 = ilk) sonraki imleci ve daha eski var mı */
const inboxCursors: Array<{ cursor?: string; hasOlder: boolean }> = [];
function rememberInboxCursor(k: number, data: J): void {
  const ib: J = data.inbox ?? {};
  const raw = ib.oldest_cursor;
  const cursor = raw === undefined || raw === null ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw);
  inboxCursors.length = k; // bu sayfadan sonrası artık geçersiz (liste değişmiş olabilir)
  inboxCursors[k] = { cursor, hasOlder: ib.has_older !== false && !!cursor && (ib.threads?.length ?? 0) > 0 };
}

/** Testler için: sayfalama zincirini sıfırla */
export function _resetInboxCursors(): void {
  inboxCursors.length = 0;
}

/** inbox yanıtı → sohbet listesi */
function inboxThreads(data: J): Thread[] {
  if (data.viewer?.pk) viewerId = String(data.viewer.pk);
  const out: Thread[] = [];
  for (const t of data.inbox?.threads ?? []) {
    rememberUsers(t.users);
    const items: J[] = Array.isArray(t.items) ? t.items : [];
    // önizleme: son GÖRÜNÜR mesaj (son öğe "Bir mesajı beğendi" tepki kaydıysa önizleme boş kalıyordu)
    const last = items.find((i) => !isLogItem(i)) ?? t.last_permanent_item ?? items[0];
    const participants = (t.users ?? []).map((u: J) => ({ id: String(u.pk), name: u.full_name || u.username, handle: u.username ? '@' + u.username : undefined, avatarUrl: u.profile_pic_url }));
    const solo = !t.is_group && t.users?.[0];
    // Okunmamış: platformun sayısı varsa o; yoksa viewer'ın son gördüğü andan (last_seen_at) sonra gelen,
    // kendisinin göndermediği mesajları say (sistem satırları hariç). read_state=0 ise 0.
    let unread = 0;
    if (Number(t.read_state ?? 0) > 0) {
      const seenTs = Number(t.last_seen_at?.[viewerId]?.timestamp ?? 0);
      const counted = items.filter((i) => String(i.user_id) !== viewerId && !i.is_sent_by_viewer && i.item_type !== 'action_log' && (!seenTs || Number(i.timestamp ?? 0) > seenTs)).length;
      unread = typeof t.unseen_count === 'number' && t.unseen_count > 0 ? t.unseen_count : Math.max(1, counted);
    }
    // karşı tarafların son gördüğü an (görüldü bilgisi): viewer dışındaki last_seen_at'lerin en büyüğü (µs → ms)
    const seenOthers = Math.max(0, ...Object.entries((t.last_seen_at ?? {}) as Record<string, { timestamp?: string | number }>).filter(([uid]) => uid !== viewerId).map(([, v]) => Number(v?.timestamp ?? 0)));
    if (seenOthers) otherSeenMs.set(String(t.thread_id), Math.floor(seenOthers / 1000));
    out.push({
      readByOthersUpTo: seenOthers ? Math.floor(seenOthers / 1000) : undefined,
      handle: solo?.username ? '@' + solo.username : undefined,
      link: solo?.username ? `https://www.instagram.com/${solo.username}/` : undefined,
      participants,
      id: String(t.thread_id),
      name: t.thread_title || (t.users ?? []).map((u: J) => u.full_name || u.username).join(', ') || 'Sohbet',
      kind: t.is_group ? 'group' : 'direct',
      lastTs: tsMs(t.last_activity_at ?? last?.timestamp),
      preview: last ? itemText(last) || (isLogItem(last) ? String(last.action_log?.description ?? '') : '') : '',
      unread,
      // grup: özel grup fotoğrafı varsa o, yoksa ilk üyenin fotoğrafı
      avatarUrl: t.is_group ? (t.thread_image?.url ?? t.thread_image_url ?? t.users?.[0]?.profile_pic_url) : t.users?.[0]?.profile_pic_url,
    });
  }
  return out;
}

export const instagram: Strategy = {
  home: 'https://www.instagram.com/direct/inbox/',
  loginHint: 'Açılan pencerede Instagram hesabına giriş yap',

  pageless: true,

  async loggedIn(_page, cookies) {
    return Boolean(cookies.ds_user_id && cookies.sessionid);
  },

  async me(page, cookies) {
    viewerId = cookies.ds_user_id ?? '';
    // inbox yanıtı viewer'ı da taşır ve users/info gibi hız sınırına (429) takılmaz
    try {
      const d = await ig(page, cookies, '/api/v1/direct_v2/inbox/?limit=1&thread_message_limit=1');
      if (d.viewer?.pk) viewerId = String(d.viewer.pk);
      if (d.viewer?.username) return { id: viewerId, label: `@${d.viewer.username}` };
    } catch {
      /* aşağıdaki uca düş */
    }
    try {
      const u = await ig(page, cookies, `/api/v1/users/${viewerId}/info/`);
      return { id: viewerId, label: u.user?.username ? `@${u.user.username}` : 'Instagram' };
    } catch {
      return { id: viewerId, label: 'Instagram' };
    }
  },

  async markRead(page, _cookies, threadId) {
    needsPage(page);
    // /items/<id>/seen/ ucu web'de 404; web istemcisi okunduyu useIGDMarkThreadAsReadMutation ile gönderiyor.
    // Sohbet sayfasını açmak bu mutation'ı tetikliyor (profil kopyasıyla doğrulandı: read_state 1 → 0).
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(6000);
  },

  /** API tabanlı: mesaj çağrıları paralel yapılabilir (köprü 4'lü paralel çağırır) */
  parallel: true,

  async threads(page, cookies): Promise<Thread[]> {
    const data = await fetchInbox(page, cookies);
    rememberInboxCursor(0, data);
    return inboxThreads(data);
  },

  /**
   * Gelen kutusunun sonraki sayfaları: `inbox.oldest_cursor` (dizge) `cursor=` ile verilir, `has_older=false`
   * sayfalamanın sonu. İmleç zinciri süreç belleğinde tutulur (k. sayfanın imleci = k. yanıtın oldest_cursor'ı);
   * bilinmeyen sayfa istenirse zincir bilinen son halkadan ilerletilir. (Profil kopyasıyla doğrulandı: 20+20 sohbet, 0 çakışma.)
   */
  async moreThreads(page, cookies, pageIndex): Promise<Thread[]> {
    if (!inboxCursors.length) rememberInboxCursor(0, await fetchInbox(page, cookies));
    // pageIndex. sayfa için imleç: (pageIndex-1). sayfanın oldest_cursor'ı (0 = ilk sayfa)
    for (let k = inboxCursors.length; k <= pageIndex - 1; k++) {
      const prev = inboxCursors[k - 1];
      if (!prev?.hasOlder || !prev.cursor) return [];
      rememberInboxCursor(k, await fetchInbox(page, cookies, prev.cursor));
    }
    const prev = inboxCursors[pageIndex - 1];
    if (!prev?.hasOlder || !prev.cursor) return [];
    const data = await fetchInbox(page, cookies, prev.cursor);
    rememberInboxCursor(pageIndex, data);
    return inboxThreads(data);
  },

  /**
   * Fotoğraf/video: web istemcisinin DM sayfasındaki gizli `input[type=file]` (accept "audio/*,.mp4,.mov,.png,.jpg,.jpeg",
   * profil kopyasıyla doğrulandı) dosyayı alır, önizleme çizilince Enter gönderir. Açıklama varsa ayrı metin mesajı
   * olarak API ile gider (Instagram DM'de medyaya altyazı yok). Kabul edilmeyen türde hata. (Gönderim canlı denenmedi.)
   */
  async sendFile(page, cookies, threadId, file, caption) {
    needsPage(page);
    const url = `https://www.instagram.com/direct/t/${threadId}/`;
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const box = page.locator('[role="main"] div[role="textbox"][contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea').first();
    await box.waitFor({ timeout: 20_000 });
    const input = await dmFileInput(page, file);
    if (!input) throw new Error(`Instagram: bu dosya türü DM'de gönderilemiyor (${file.mime || file.name})`);
    await input.setInputFiles(file.path);
    // önizleme (composer'da küçük resim) çizilsin; sonra Enter gönderir
    await page.waitForTimeout(1500);
    await box.click({ timeout: 5000 }).catch(() => undefined);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    if (caption) await this.send(page, cookies, threadId, caption);
    return undefined;
  },

  /**
   * Sohbet mesajları. `before` (ms) verilirse ondan eski mesajlar: bilinen en derin imleçten (oldest_cursor) devam edilir;
   * imleç yoksa ya da yeterince derin değilse sayfa sayfa (en çok 4 istek) eskiye gidilir.
   */
  async messages(page, cookies, threadId, limit, before): Promise<Msg[]> {
    const pageSize = Math.max(1, Math.min(limit, 50));
    let cursor = before ? pickCursor(cursors.get(threadId), before) : undefined;
    const items: J[] = [];
    for (let i = 0; i < (before ? 4 : 1); i++) {
      const data = await ig(page, cookies, `/api/v1/direct_v2/threads/${threadId}/?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const th: J = data.thread ?? {};
      rememberUsers(th.users);
      const got: J[] = Array.isArray(th.items) ? th.items : [];
      const oldest = got.length ? Math.min(...got.map((it) => tsMs(it.timestamp))) : 0;
      if (th.oldest_cursor && got.length) rememberCursor(threadId, String(th.oldest_cursor), oldest);
      items.push(...(before ? got.filter((it) => tsMs(it.timestamp) < before) : got).filter((it) => !isLogItem(it)));
      if (!before || !got.length || th.has_older === false || !th.oldest_cursor) break;
      if (items.length >= Math.min(pageSize, 10)) break;
      cursor = String(th.oldest_cursor);
    }
    // API yeniden eskiye ve limit+1 öğe döndürür: köprü sözleşmesi eskiden yeniye, en çok `limit`
    const seen = new Set<string>();
    const ordered = items
      .filter((it) => !seen.has(String(it.item_id)) && seen.add(String(it.item_id)))
      .sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
      .slice(-pageSize);
    const seenMs = otherSeenMs.get(String(threadId)) ?? 0;
    return ordered.map((it: J) => {
      const uid = String(it.user_id);
      const { text, attachments } = itemContent(it);
      const mine = uid === viewerId || it.is_sent_by_viewer === true;
      return {
        status: mine ? (seenMs && tsMs(it.timestamp) <= seenMs ? ('read' as const) : ('sent' as const)) : ('delivered' as const),
        id: String(it.item_id),
        text,
        attachments,
        senderAvatarUrl: userPics.get(uid),
        ts: tsMs(it.timestamp),
        fromMe: uid === viewerId || it.is_sent_by_viewer === true,
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
