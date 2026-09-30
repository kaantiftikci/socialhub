import type { CalendarResult, DeviceCalendars } from './api';
import type { CalEvent } from './types';
import type { Account, Attachment, CalendarDraft, Chat, ChatFlags, CoreEvent, CoreOs, DraftResult, LinkPreview, Message, Platform } from './types';
import { DELETED_TEXT, PLATFORMS } from './types';
import { brandSvgMarkup } from './brand-icons';
import { authSaveAccounts } from './auth-api';
import { demoAsset } from './demo-asset';
import { DEMO_OFFLINE } from './profile';
import { DEMO_APPS, SCRIPTS } from './demo-scripts';
import { DEMO_STYLE, demoDraft, demoQuestionDraft } from './demo-ai';
import { demoDigestGet, demoDigestSet, demoMarketSummary } from './demo-market';
import { STATIC_DEMO } from './profile';
import { demoLibrary, demoLibraryFacets, demoStats } from './demo-insights';
import type { LibQuery, StatsRange } from './insights-types';

/**
 * Herkese açık site. Uygulama listesi kullanıcının oturumunda saklanır;
 * şifre, belirteç ve gerçek oturum anahtarı tutulmaz.
 */

type Listener = (ev: CoreEvent) => void;
const listeners = new Set<Listener>();
/** Demo: kendi mesajını düzenle (text) ya da herkesten sil (null); son mesajsa sohbet önizlemesi de değişir */
function demoEdit(messageId: string, text: string | null): Message {
  const m = messages.find((x) => x.id === messageId);
  if (!m) throw new Error('Mesaj yok');
  if (!m.fromMe) throw new Error('Yalnız kendi mesajın');
  if (m.deleted) throw new Error('Mesaj zaten silinmiş');
  if (text === null) {
    m.text = DELETED_TEXT;
    m.attachments = [];
    m.deleted = true;
  } else {
    const t = text.trim();
    if (!t) throw new Error('Metin gerekli');
    if (t === m.text) return { ...m };
    m.text = t;
    m.edited = true;
  }
  let chat = chatOf(m.chatId);
  if (!messages.some((x) => x.chatId === m.chatId && x.ts > m.ts)) {
    chat = { ...chat, lastPreview: m.text };
    chats = chats.map((c) => (c.id === chat.id ? chat : c));
  }
  emit({ type: 'message.upsert', message: { ...m }, chat });
  return { ...m };
}

const emit = (ev: CoreEvent) => {
  for (const fn of listeners) fn(ev);
};

let accounts: Account[] = [];
let chats: Chat[] = [];
let messages: Message[] = [];


/**
 * Demo: X kanalı kullanıcı eylemi bekler (şifreli sohbet PIN'i) → kenar çubuğunda yanıp sönen kırmızı uyarı işareti ve açılır kart
 * gösterilir. "PIN'i gir" (restartAccount) 2 sn sonra girilmiş sayar; sayfa yenilenince uyarı geri gelir.
 */
let demoPinDone = false;
const DEMO_X_ATTENTION = 'Şifreli sohbetler için PIN gerekli; girilene dek yeni mesajlar geç ve eksik gelir';
function withDemoAttention(a: Account): Account {
  return a.platform === 'x' && a.status === 'connected' && !demoPinDone ? { ...a, attention: DEMO_X_ATTENTION } : { ...a };
}

/**
 * Demoda bağlanma akışı gerçek uygulamadaki gibi: WhatsApp/Telegram önce QR gösterir ("Kodu okuttum" ile bağlanır; kendiliğinden DEĞİL),
 * tarayıcıyla girilen uygulamalar giriş formu ister (Connect.tsx DemoLogin; girilen bilgiler hiçbir yere gönderilmez/saklanmaz).
 * Eskiden "Bağlan" hesabı anında "bağlı" yapıyordu → QR / giriş adımı hiç görünmüyordu.
 */
const QR_PLATFORMS = new Set<Platform>(['whatsapp', 'telegram']);

/** Taranamayan, gerçekçi görünümlü QR (köşe hedefleri + sözde rastgele modüller) */
function demoQr(seedText: string): string {
  const n = 29;
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967296;
  const finder = (x: number, y: number) => {
    const inBox = (cx: number, cy: number) => cx >= x && cx < x + 7 && cy >= y && cy < y + 7;
    return { inBox, on: (cx: number, cy: number) => { const dx = cx - x, dy = cy - y; return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4); } };
  };
  const fs = [finder(0, 0), finder(n - 7, 0), finder(0, n - 7)];
  let rects = '';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const f = fs.find((q) => q.inBox(x, y));
      const nearFinder = fs.some((q) => q.inBox(x - 1, y) || q.inBox(x + 1, y) || q.inBox(x, y - 1) || q.inBox(x, y + 1));
      const on = f ? f.on(x, y) : !nearFinder && rnd() < 0.48;
      if (on) rects += `<rect x="${x + 2}" y="${y + 2}" width="1.02" height="1.02"/>`;
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Bekleyen demo girişini tamamla: bağlı yap, kaydet, (yeni üye değilse) örnek sohbetleri ekle */
async function completeDemoLogin(id: string): Promise<void> {
  const a = accounts.find((x) => x.id === id);
  if (!a || a.status === 'connected') return;
  const next: Account = { ...a, status: 'connected', detail: undefined, qrDataUrl: undefined };
  accounts = accounts.map((x) => (x.id === id ? next : x));
  await saveAccounts().catch(() => undefined);
  emit({ type: 'account.status', account: withDemoAttention(next) });
  if (!freshUser) seedAccount(next);
  for (const c of chats.filter((x) => x.accountId === id)) emit({ type: 'chat.upsert', chat: c });
}

/**
 * Tarayıcıyla girilen uygulamalar: gerçek Mivelo'daki gibi AYRI bir giriş penceresi açılır (public/demo-login.html; 460×640 küçük
 * pencere). Giriş yapılınca pencere "tamam" haberini (BroadcastChannel + postMessage, aynı köken) gönderip kapanır; bilgiler kullanılmaz.
 */
export function openDemoLoginWindow(a: Account): boolean {
  const p = PLATFORMS[a.platform];
  const q = new URLSearchParams({ id: a.id, n: p.name, code: p.code, c: p.color, mail: p.category === 'mail' ? '1' : '0' });
  // pencerenin başında markanın orijinal simgesi (arayüzdeki Chip ile aynı SVG)
  const logo = brandSvgMarkup(a.platform);
  if (logo) q.set('logo', logo);
  const w = 460;
  const h = 640;
  const left = Math.max(0, Math.round((window.screenX || 0) + ((window.outerWidth || w) - w) / 2));
  const top = Math.max(0, Math.round((window.screenY || 0) + ((window.outerHeight || h) - h) / 2));
  const win = window.open(`/demo-login.html?${q}`, `mivelo-login-${a.id}`, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (win) watchDemoLoginWindow(win, a.id);
  return !!win;
}

/**
 * Giriş penceresi giriş yapılmadan kapatılırsa (gerçek uygulamadaki gibi) bağlanma iptal: yeni hesap kaldırılır, Bağlan
 * kartı ilk haline döner. Başarıda pencere "tamam" mesajını gönderip kendini kapatır; mesaj işlenebilsin diye kısa bekleme.
 */
function watchDemoLoginWindow(win: Window, id: string): void {
  const t = window.setInterval(() => {
    const a = accounts.find((x) => x.id === id);
    if (!a || a.status === 'connected') return window.clearInterval(t);
    if (!win.closed) return;
    window.clearInterval(t);
    window.setTimeout(() => {
      const still = accounts.find((x) => x.id === id);
      if (still && still.status !== 'connected') void cancelDemoLogin(id, true);
    }, 900);
  }, 400);
}

/** Bekleyen (hiç bağlanmamış) demo hesabını kaldır: kart "Bağlan"a döner */
async function cancelDemoLogin(id: string, windowClosed = false): Promise<'removed' | 'none'> {
  const a = accounts.find((x) => x.id === id);
  if (!a || a.status === 'connected') return 'none';
  accounts = accounts.filter((x) => x.id !== id);
  await saveAccounts().catch(() => undefined);
  emit({ type: 'account.removed', accountId: id });
  if (windowClosed) emit({ type: 'account.login-cancelled', accountId: id });
  return 'removed';
}
if (typeof window !== 'undefined') {
  const done = (d: unknown) => {
    const x = d as { type?: string; id?: string } | null;
    if (x?.type === 'mivelo-demo-login' && typeof x.id === 'string') void completeDemoLogin(x.id);
  };
  try {
    new BroadcastChannel('mivelo-demo-login').onmessage = (e) => done(e.data);
  } catch {
    /* eski tarayıcı: postMessage yeter */
  }
  window.addEventListener('message', (e) => e.origin === location.origin && done(e.data));
}

/** QR bekleyen hesap: kod gösterilir; kendiliğinden bağlanmaz (kullanıcı "Kodu okuttum"a basınca, Connect.tsx) */
function startDemoQr(a: Account): Account {
  return { ...a, status: 'pairing', qrDataUrl: demoQr(a.id), detail: undefined };
}

function demoAccount(platform: Platform): Account {
  return { id: `demo:${platform}`, platform, label: PLATFORMS[platform].name, status: 'connected', createdAt: 1_750_000_000_000 };
}

/** public/demo/avatars içindeki dosyalar: grup üyesinin adı eşleşirse avatarı, yoksa baş harfleri */
const AVATAR_FILES = new Set(['ayse', 'burak', 'can', 'deniz', 'duyuru', 'ece', 'ekip', 'elif', 'emre', 'fatura', 'kerem', 'melis', 'mert', 'nisa', 'pinar', 'selin']);
const slug = (name: string) =>
  name
    .split(/\s+/)[0]
    .toLocaleLowerCase('tr-TR')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/[^a-z0-9]/g, '');
const memberAvatar = (name: string): string | undefined => (AVATAR_FILES.has(slug(name)) ? demoAsset(`avatars/${slug(name)}.jpg`) : undefined);
/** Beğeni/tepki olayı olan platformlar (e-posta ve alışveriş kanallarında yok) */
const REACT_PLATFORMS = new Set<Platform>(['whatsapp', 'instagram', 'linkedin', 'telegram', 'slack']);
const REACT_EMOJI = ['👍', '❤️', '😂', '🔥', '👏'];
export const isReactionText = (t: string) => /^(👍|❤️|😂|🔥|👏|😮) .+ (bir mesajı beğendi|mesajına tepki verdi)$/.test(t);

/** Albüm satırı (metinsiz + ekli): kendinden sonraki satıra kadar olan 18 dk'lık aralığı kapat → albüm kareleri saniyeler arayla */
function albumShift(lines: Array<[boolean, string, Attachment[]?]>, j: number): number {
  const isAlbum = (l?: [boolean, string, Attachment[]?]) => !!l && !l[1] && !!l[2]?.length;
  if (!isAlbum(lines[j])) return 0;
  // dizinin ilk albüm satırına göre: zaman = ilk satırın zamanı + 4 sn × sıra (18 dk'lık satır aralığı geri alınır)
  let first = j;
  while (first > 0 && isAlbum(lines[first - 1]) && lines[first - 1][0] === lines[j][0]) first--;
  return (j - first) * (18 * 60_000 - 4_000);
}

/** Sohbet sırası sayacı (zaman damgaları buna göre kademelenir); yeni eklenen hesap kaldığı yerden devam eder */
let seedK = 0;

/** Tüm hesapların örnek verisini baştan kur (açılışta) */
function seed(): void {
  const now = Date.now();
  chats = [];
  messages = [];
  seedK = 0;
  // yeni üye: ASLA örnek veri yok (bağladığı uygulamalar boş kanal olarak görünür)
  if (freshUser) return;
  for (const acc of accounts) if (acc.status === 'connected') seedAccount(acc, now);
}

/** Tek hesabın örnek sohbetlerini EKLE (var olan sohbetlere, okundu/etiket/gönderilen mesajlara dokunmaz) */
function seedAccount(acc: Account, now = Date.now()): void {
  {
    const scripts = SCRIPTS[acc.platform];
    if (!scripts) return;
    scripts.forEach((s, i) => {
      seedK += 1;
      const k = seedK;
      const id = `${acc.id}/${s.remoteId}`;
      const lastAt = now - k * 4 * 3_600_000 - i * 25 * 60_000;
      const members = new Set<string>();
      s.lines.forEach(([fromMe, text, attachments], j) => {
        // grupta gönderen "Ad: metin" ön ekinden; her üyenin kendi kimliği ve (dosyası varsa) avatarı
        const who = fromMe ? 'Ben' : s.kind === 'direct' ? s.name : (text.split(':')[0] ?? s.name);
        if (!fromMe && s.kind !== 'direct') members.add(who);
        messages.push({
          id: `${id}#${j}`,
          chatId: id,
          remoteId: `m-${j}`,
          senderId: fromMe ? 'me' : s.kind === 'direct' ? s.remoteId : slug(who) || s.remoteId,
          senderName: who,
          senderAvatarUrl: fromMe ? undefined : s.kind === 'direct' ? demoAsset(`avatars/${s.avatar}`) : memberAvatar(who),
          fromMe,
          text: s.kind === 'direct' || fromMe ? text : text.replace(/^[^:]+:\s*/, ''),
          // metinsiz art arda medya (albüm) gerçekteki gibi saniyeler arayla: önceki satıra yapışık
          ts: lastAt - (s.lines.length - 1 - j) * 18 * 60_000 - albumShift(s.lines, j),
          status: fromMe ? 'read' : 'delivered',
          attachments,
        });
      });
      let last = s.lines[s.lines.length - 1];
      let lastText = last?.[1] ?? '';
      // uygun platformlarda her ikinci sohbette son olay bir beğeni: "Ayşe bir mesajı beğendi"
      if (REACT_PLATFORMS.has(acc.platform) && k % 2 === 0) {
        const who = s.kind === 'direct' ? s.name.split(' ')[0] : ([...members][0] ?? s.name);
        const emoji = REACT_EMOJI[k % REACT_EMOJI.length];
        const text = `${emoji} ${who} mesajına tepki verdi`;
        // sohbette ayrı bir satır değil: benim son mesajıma (yoksa son mesaja) gerçek tepki; liste önizlemesi olay metnini gösterir
        const mine = [...messages].reverse().find((m) => m.chatId === id && m.fromMe) ?? [...messages].reverse().find((m) => m.chatId === id);
        if (mine) mine.reactions = [...(mine.reactions ?? []), { emoji, senderId: s.kind === 'direct' ? s.remoteId : slug(who), senderName: who, fromMe: false }];
        last = [false, text];
        lastText = text;
      }
      chats.push({
        id,
        accountId: acc.id,
        platform: acc.platform,
        remoteId: s.remoteId,
        name: s.name,
        kind: s.kind,
        unread: s.unread,
        lastMessageAt: isReactionText(lastText) ? lastAt + 90_000 : lastAt,
        lastPreview: (s.kind === 'direct' || isReactionText(lastText) ? lastText : last?.[0] ? `Sen: ${lastText}` : lastText).replace(/\s+/g, ' ').trim(),
        lastFromMe: last?.[0] ?? false,
        // son mesaj bendense listede tik: çoğu görüldü, bazıları iletildi/gönderildi (gerçek kanallardaki gibi)
        lastStatus: last?.[0] ? (k % 5 === 3 ? 'delivered' : k % 7 === 5 ? 'sent' : 'read') : undefined,
        lastReaction: isReactionText(lastText) || undefined,
        tags: s.tags,
        handle: s.handle,
        avatarUrl: demoAsset(`avatars/${s.avatar}`),
        meta: (() => {
          // pazaryeri: sipariş kartı olmayan sohbetler müşteri sorusudur (gerçek bağlayıcılardaki meta.question biçimi)
          const question =
            PLATFORMS[acc.platform].category === 'shop' && !s.order
              ? { status: s.unread ? 'WAITING_FOR_ANSWER' : 'ANSWERED', statusLabel: s.unread ? 'Cevap bekliyor' : 'Cevaplandı', productName: s.name.split('·')[1]?.trim() || undefined, orderNumber: s.questionOrderNo, dateCreated: new Date(lastAt - 3 * 3_600_000).toISOString(), public: true }
              : undefined;
          // demo siparişinin tarihi, ilk olay satırıyla aynı gün olsun (zaman çizelgesi tutarlı)
          const order = s.order ? { ...s.order, dateCreated: new Date(lastAt - (s.lines.length - 1) * 18 * 60_000).toISOString() } : undefined;
          const m = { ...(s.summary?.length ? { summary: s.summary } : {}), ...(s.note ? { note: s.note } : {}), ...(order ? { order } : {}), ...(question ? { question } : {}) };
          return Object.keys(m).length ? m : undefined;
        })(),
        participants: s.handle && PLATFORMS[acc.platform].category === 'mail' ? [{ id: s.handle, name: s.contact ?? s.handle.split('@')[0] ?? s.handle, handle: s.handle, avatarUrl: demoAsset(`avatars/${s.avatar}`) }] : undefined,
      });
    });
    // platformun kendi arşivi (WhatsApp "Arşivlenmiş", Telegram arşiv klasörü): en eski, okunmuş 2 birebir sohbet
    if (acc.platform === 'whatsapp' || acc.platform === 'telegram')
      chats
        .filter((c) => c.accountId === acc.id && c.kind === 'direct' && c.unread === 0)
        .sort((a, b) => a.lastMessageAt - b.lastMessageAt)
        .slice(0, 2)
        .forEach((c) => (c.meta = { ...(c.meta ?? {}), archived: true }));
  }
}

function chatOf(id: string): Chat {
  const c = chats.find((x) => x.id === id);
  if (!c) throw new Error('Sohbet bulunamadı');
  return c;
}

function touch(chat: Chat, text: string, fromMe: boolean, ts: number): Chat {
  const next: Chat = { ...chat, lastPreview: text, lastFromMe: fromMe, lastMessageAt: ts, lastStatus: fromMe ? 'sent' : 'delivered', lastReaction: undefined };
  chats = chats.map((c) => (c.id === chat.id ? next : c));
  emit({ type: 'chat.upsert', chat: next });
  return next;
}

const DEMO_BLOCK = 'Bu hesap bu siteden yeniden başlatılamaz. Uygulamayı kaldırıp yeniden bağla.';

function publicAccount(a: Account): Record<string, unknown> {
  return { id: a.id, platform: a.platform, label: a.label, status: a.status, createdAt: a.createdAt };
}

async function saveAccounts(): Promise<void> {
  if (DEMO_OFFLINE) return; // tek dosyalık demo: sunucu yok, hesaplar bellekte
  await authSaveAccounts(accounts.map(publicAccount));
}

/** Yeni kayıtlı demo kullanıcısı: boş panel (varsayılan uygulama, örnek sohbet ve etkinlik yok); bağladığı uygulamanın örnekleri gelir */
let freshUser = false;

export function loadDemoAccounts(list: Array<Record<string, unknown>>, opts: { fresh?: boolean } = {}): void {
  freshUser = !!opts.fresh;
  calEvents = freshUser ? [] : null;
  accounts = list
    .filter((a) => PLATFORMS[a.platform as Platform])
    .map((a) => ({
      id: String(a.id),
      platform: a.platform as Platform,
      label: String(a.label || PLATFORMS[a.platform as Platform]?.name || a.platform),
      status: (a.status as Account['status']) || 'connected',
      createdAt: Number(a.createdAt) || Date.now(),
    }))
    .filter((a) => DEMO_APPS.includes(a.platform) || !String(a.id).startsWith('demo:'));
  const byPlatform = new Map(accounts.map((a) => [a.platform, a]));
  const extras = accounts.filter((a) => !DEMO_APPS.includes(a.platform));
  // yeni kullanıcıya varsayılan demo uygulamaları eklenmez: yalnız kendi bağladıkları
  const next = freshUser ? accounts : [...DEMO_APPS.map((p) => byPlatform.get(p) ?? demoAccount(p)), ...extras];
  const changed = next.length !== accounts.length || next.some((a, i) => a.id !== accounts[i]?.id);
  accounts = next;
  if (changed) void saveAccounts().catch(() => undefined);
  // yarım kalmış QR eşleştirmesi (sayfa yenilendi): kod yeniden gösterilir
  accounts = accounts.map((a) => (a.status === 'pairing' && QR_PLATFORMS.has(a.platform) ? startDemoQr(a) : a));
  seed();
}

export function clearDemoAccounts(): void {
  accounts = [];
  chats = [];
  messages = [];
}

// Canlı mesaj akışı: 70 sn'de bir uygun bir sohbete gerçekçi bir gelen mesaj düşer (önizleme ve bildirim canlı kalsın).
// Beğeni/tepki bildirimi ÜRETİLMEZ: bildirimler hep aynı "X bir mesajı beğendi" olmasın diye metinler sohbetin etiketine göre seçilir.
const LIVE_LINES: Record<string, string[]> = {
  müşteri: [
    'Merhaba, siparişim ne zaman kargoya verilir?',
    'Bu ürünün mavi rengi var mı?',
    'Kargo takip numarasını paylaşabilir misiniz?',
    'İade süreci nasıl işliyor acaba?',
    'Fatura adresini değiştirmek istiyorum, mümkün mü?',
    'Ürün elime ulaştı, teşekkürler! Bir bedeni büyüğü de var mı?',
  ],
  ekip: [
    'Toplantıyı 15:00\'e alabilir miyiz?',
    'Raporun son halini yükledim, bakabilir misin?',
    'Müşteri demosu için sunum hazır mı?',
    'Bugün öğleden sonra ofiste misin?',
    'Yeni sürüm test ortamına çıktı, göz atar mısın?',
    'Sprint planlamasını yarına aldım, uygun mu?',
  ],
  fırsat: [
    'Teklifinizi inceledik, detayları konuşabilir miyiz?',
    'İş birliği için uygun bir gün var mı?',
    'Fiyat listesini paylaşabilir misiniz?',
    'Önümüzdeki hafta bir görüşme ayarlayalım mı?',
  ],
  kişisel: [
    'Akşam yemeğe geliyor musun?',
    'Fotoğrafları gördün mü? 😄',
    'Hafta sonu plan var mı?',
    'Aradım ulaşamadım, müsait olunca yaz',
  ],
  genel: [
    'Selam, müsait misin?',
    'Dünkü konuyla ilgili bir sorum olacak',
    'Gönderdiğin dosyayı aldım, sağ ol',
    'Bunu bir de sen kontrol eder misin?',
    'Haberleri gördün mü? 🙂',
  ],
};
let liveTick = 0;
/** Sohbete gerçekçi bir gelen mesaj düşür (canlı akış ve tanıtım videosu kancası aynı yolu kullanır) */
function pushIncoming(chat: Chat, text: string): void {
  const src = chat.kind === 'direct' ? undefined : messages.find((m) => m.chatId === chat.id && !m.fromMe && !isReactionText(m.text));
  const who = chat.kind === 'direct' ? chat.name : (src?.senderName ?? chat.name);
  const ts = Date.now();
  const message: Message = {
    id: `${chat.id}#live-${ts}`,
    chatId: chat.id,
    remoteId: `live-${ts}`,
    senderId: chat.kind === 'direct' ? chat.remoteId : (src?.senderId ?? chat.remoteId),
    senderName: who,
    senderAvatarUrl: chat.kind === 'direct' ? chat.avatarUrl : src?.senderAvatarUrl,
    fromMe: false,
    text,
    ts,
    status: 'delivered',
  };
  messages.push(message);
  const preview = chat.kind === 'direct' ? text : `${who.split(' ')[0]}: ${text}`;
  const next = { ...touch(chat, preview, false, ts), unread: chat.unread + 1 };
  chats = chats.map((c) => (c.id === chat.id ? next : c));
  emit({ type: 'chat.upsert', chat: next });
  emit({ type: 'message.upsert', message, chat: next, live: true });
}
if (STATIC_DEMO) {
  setInterval(() => {
    const pool = chats.filter((c) => REACT_PLATFORMS.has(c.platform) && c.kind !== 'channel');
    if (!pool.length) return;
    liveTick++;
    const chat = pool[(liveTick * 7) % pool.length];
    const tag = chat.tags.find((t) => LIVE_LINES[t]) ?? 'genel';
    const lines = LIVE_LINES[tag];
    pushIncoming(chat, lines[(liveTick * 3) % lines.length]);
  }, 70_000);
  // Tanıtım videosu (scripts/promo) gerçek arayüzü sürerken belirli bir sohbete mesaj düşürür
  (window as unknown as { __miveloDemo?: unknown }).__miveloDemo = {
    incoming: (name: string, text: string): boolean => {
      const chat = chats.find((c) => c.name === name) ?? chats.find((c) => c.name.includes(name));
      if (chat) pushIncoming(chat, text);
      return !!chat;
    },
  };
}


/** Demo: çekirdek yok; tek etkinlikli .ics tarayıcıda üretilir ve indirilir */
/** Demo takvimi: bellekte; açılışta bu haftaya birkaç örnek etkinlik (sohbetlere bağlı olanlar "Sohbete git" gösterir) */
let calEvents: CalEvent[] | null = null;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function demoEvents(): CalEvent[] {
  if (calEvents) return calEvents;
  const at = (days: number, hm?: string) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return hm ? `${ymd(d)}T${hm}` : ymd(d);
  };
  const byName = (n: string) => chats.find((c) => c.name === n);
  const mk = (title: string, start: string, extra: Partial<CalEvent> = {}): CalEvent => ({ id: `ev-${Math.random().toString(36).slice(2, 9)}`, title, start, durationMin: 60, allDay: !start.includes('T'), createdAt: Date.now(), ...extra });
  const ayse = byName('Ayşe Demir');
  const ekip = byName('Satış Ekibi');
  calEvents = [
    mk('Ayşe Demir · kargo takip kodu', at(0, '17:30'), { durationMin: 15, chatId: ayse?.id, remindMin: 10, notes: 'Ayşe Demir: Çıkınca takip numarasını da buradan atar mısınız?' }),
    mk('Kampanya maili çıkışı', at(1, '10:00'), { chatId: ekip?.id, remindMin: 30, notes: 'Satış Ekibi: Yarın 10:00’da maile çıksın.' }),
    mk('Tedarikçi görüşmesi', at(2, '14:00'), { durationMin: 45, location: 'Zoom', remindMin: 15 }),
    mk('KDV beyannamesi', at(4)),
    mk('Haftalık stok sayımı', at(6, '09:30'), { durationMin: 90 }),
    mk('Fatura kesimi · Demir Studio', at(-2, '11:00'), { chatId: ayse?.id }),
  ];
  return calEvents;
}

function demoIcs(ev: CalendarDraft): string {
  const [d, t] = ev.start.split('T');
  const ymd = d.replace(/-/g, '');
  const start = t ? `DTSTART:${ymd}T${t.replace(':', '')}00` : `DTSTART;VALUE=DATE:${ymd}`;
  const esc = (x: string) => x.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mivelo//TR', 'BEGIN:VEVENT', `UID:${Date.now()}@mivelo`, start, `SUMMARY:${esc(ev.title)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export const staticApi = {
  license: async () => ({ required: false, valid: true }),
  updateStatus: async (): Promise<import('./api').UpdateStatus> => ({ state: 'idle', supported: false, pct: 0 }),
  startUpdate: async (): Promise<import('./api').UpdateStatus> => ({ state: 'idle', supported: false, pct: 0 }),
  installUpdate: async (): Promise<import('./api').UpdateStatus> => ({ state: 'idle', supported: false, pct: 0 }),
  // demoda profil yalnız bu tarayıcıda; tüm verileri silme masaüstüne özgü
  profile: async (): Promise<import('./api').Profile> => {
    try {
      return JSON.parse(localStorage.getItem('mivelo.profile') || '{}') as import('./api').Profile;
    } catch {
      return {};
    }
  },
  saveProfile: async (p: import('./api').Profile) => {
    localStorage.setItem('mivelo.profile', JSON.stringify(p));
    return p;
  },
  resetAll: async (): Promise<{ ok: boolean; accounts: number }> => {
    throw new Error('Demoda kullanılamaz');
  },
  activateLicense: async (_key: string) => ({ required: false, valid: true }),
  releaseLicense: async () => ({ required: false, valid: true }),
  activity: async (_active: boolean) => undefined,
  health: async () => ({ ok: true, ai: true, stats: { unread: chats.reduce((n, c) => n + c.unread, 0), chats: chats.length }, os: undefined as CoreOs | undefined, user: undefined as string | undefined }),
  accounts: async () => accounts.map(withDemoAttention),
  addAccount: async (platform: Platform, token?: string): Promise<Account> => {
    let account: Account = {
      id: `${platform}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      platform,
      label: PLATFORMS[platform].name,
      status: 'connected',
      createdAt: Date.now(),
    };
    // QR'lı uygulamalar kod gösterir; tarayıcıyla girilenler (form doldurulmadıysa) giriş formunu bekler
    const pending = QR_PLATFORMS.has(platform) || (PLATFORMS[platform].mode === 'browser' && token !== 'demo-form');
    if (QR_PLATFORMS.has(platform)) account = startDemoQr(account);
    else if (pending) account = { ...account, status: 'pairing', detail: 'Giriş bekleniyor' };
    const prev = accounts;
    accounts = [...accounts, account];
    try {
      await saveAccounts();
    } catch (e) {
      accounts = prev;
      throw e;
    }
    emit({ type: 'account.status', account: withDemoAttention(account) });
    if (account.qrDataUrl) emit({ type: 'account.qr', accountId: account.id, qrDataUrl: account.qrDataUrl });
    if (pending) return account;
    // yalnız yeni hesabın sohbetleri eklenir: seed() tüm demoyu sıfırlıyordu (okunanlar yeniden okunmamış, gönderilenler/etiketler kayıp)
    if (!freshUser) seedAccount(account);
    for (const c of chats.filter((x) => x.accountId === account.id)) emit({ type: 'chat.upsert', chat: c });
    return account;
  },
  removeAccount: async (id: string) => {
    const prev = accounts;
    accounts = accounts.filter((a) => a.id !== id);
    const gone = new Set(chats.filter((c) => c.accountId === id).map((c) => c.id));
    chats = chats.filter((c) => c.accountId !== id);
    messages = messages.filter((m) => !gone.has(m.chatId));
    try {
      await saveAccounts();
    } catch (e) {
      accounts = prev;
      throw e;
    }
    for (const chatId of gone) emit({ type: 'chat.delete', chatId });
  },
  cancelLogin: async (id: string) => ({ result: await cancelDemoLogin(id) }),
  /** Demo giriş formu gönderildi (Connect.tsx): bilgiler kullanılmaz, hesap bağlanır */
  demoLogin: async (id: string) => {
    await new Promise((r) => setTimeout(r, 900));
    await completeDemoLogin(id);
  },
  restartAccount: async (id: string, _opts?: { browserLogin?: boolean }) => {
    // X'in PIN uyarısı: gerçek uygulamada görünür pencere açılır, kullanıcı PIN'i girer; demoda 2 sn sonra girilmiş sayılır
    const a = accounts.find((x) => x.id === id);
    if (a?.platform === 'x' && !demoPinDone) {
      await new Promise((r) => setTimeout(r, 2000));
      demoPinDone = true;
      emit({ type: 'account.status', account: { ...a } });
      return;
    }
    throw new Error(DEMO_BLOCK);
  },
  messageHtml: async (_id: string): Promise<{ html: string }> => {
    throw new Error('HTML gövde yok');
  },
  loginInput: async (_id: string, _events: unknown[]) => ({ ok: true }),
  loginCancel: async (_id: string) => ({ ok: true }),
  loginWindow: async (_id: string) => ({ ok: true }),
  accountInput: async (_id: string, _kind: 'phone' | 'code' | 'password', _value: string) => {
    throw new Error(DEMO_BLOCK);
  },
  chats: async () => chats.map((c) => ({ ...c })),
  messages: async (chatId: string, limit = 100, before?: number) =>
    messages
      .filter((m) => m.chatId === chatId && (before == null || m.ts < before))
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit),
  send: async (chatId: string, text: string, _threadId?: string, replyTo?: string) => {
    const chat = chatOf(chatId);
    const ts = Date.now();
    const remoteId = `demo-${ts}`;
    const q = replyTo ? messages.find((m) => m.chatId === chatId && m.remoteId === replyTo) : undefined;
    const message: Message = {
      id: `${chatId}#${remoteId}`,
      chatId,
      remoteId,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text,
      ts,
      status: 'sent',
      replyTo: q ? { remoteId: q.remoteId, senderName: q.fromMe ? 'Sen' : q.senderName, text: (q.text || q.attachments?.[0]?.name || '').slice(0, 160), fromMe: q.fromMe } : undefined,
    };
    messages.push(message);
    const next = { ...touch(chat, text, true, ts), unread: 0 };
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'message.upsert', message, chat: next });
    window.setTimeout(() => {
      message.status = 'read';
      // listedeki tik de görüldüye dönsün (son mesaj hâlâ buysa)
      const cur = chats.find((c) => c.id === chatId);
      const upd = cur && cur.lastMessageAt === ts ? { ...cur, lastStatus: 'read' as const } : cur ?? next;
      if (cur && upd !== cur) chats = chats.map((c) => (c.id === chatId ? upd : c));
      emit({ type: 'message.upsert', message: { ...message }, chat: upd });
    }, 1200);
    return { remoteId };
  },
  markRead: async (chatId: string) => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || chat.unread === 0) return;
    const next = { ...chat, unread: 0 };
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'chat.upsert', chat: next });
  },
  compose: async (accountId: string, d: { to: string; subject: string; text: string }): Promise<Chat> => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error('Hesap bulunamadı');
    const ts = Date.now();
    const chat: Chat = { id: `${accountId}/out-${ts}`, accountId, platform: acc.platform, remoteId: `out-${ts}`, name: d.subject || '(konu yok)', kind: 'direct', unread: 0, lastMessageAt: ts, lastPreview: d.text, lastFromMe: true, tags: [], handle: d.to, participants: [{ id: d.to, name: d.to }] };
    chats.push(chat);
    messages.push({ id: `${chat.id}#m`, chatId: chat.id, remoteId: 'm', senderId: 'me', senderName: 'Ben', fromMe: true, text: d.text, ts, status: 'sent' });
    emit({ type: 'chat.upsert', chat });
    return chat;
  },
  react: async (chatId: string, messageId: string, emoji: string): Promise<Message> => {
    const m = messages.find((x) => x.id === messageId && x.chatId === chatId);
    if (!m) throw new Error('Mesaj yok');
    const mine = m.reactions?.find((r) => r.fromMe);
    const rest = (m.reactions ?? []).filter((r) => !r.fromMe);
    m.reactions = mine?.emoji === emoji ? (rest.length ? rest : undefined) : [...rest, { emoji, senderId: 'me', senderName: 'Ben', fromMe: true }];
    const chat = chatOf(chatId);
    emit({ type: 'message.upsert', message: { ...m }, chat });
    return { ...m };
  },
  deleteMessage: async (messageId: string): Promise<Message> => demoEdit(messageId, null),
  editMessage: async (messageId: string, text: string): Promise<Message> => demoEdit(messageId, text),
  setFlags: async (chatId: string, flags: ChatFlags): Promise<Chat> => {
    const cur = chatOf(chatId);
    const next: Chat = { ...cur };
    for (const k of ['pinned', 'archived', 'muted', 'hidden'] as const) if (typeof flags[k] === 'boolean') next[k] = flags[k] || undefined;
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'chat.upsert', chat: next });
    return next;
  },
  preview: async (url: string): Promise<LinkPreview> => {
    // Demo: çekirdek yok; bilinen örnek adresler için sabit kart, diğerleri kartsız
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'partners.beehiiv.com') return { url, site: 'beehiiv', title: 'Mivelo × beehiiv · lansman ortak tanıtımı', description: 'Lansman haftasında beehiiv yazar bültenine yerleşim.' };
      if (host === 'mivelo.app') return { url, site: 'Mivelo', title: 'Mivelo — tüm mesajların tek gelen kutusunda', description: 'WhatsApp, Telegram, Slack, Instagram, e-posta ve pazaryerleri tek yerde.' };
    } catch {
      /* geçersiz */
    }
    return { url, none: true };
  },
  setTags: async (chatId: string, tags: string[]) => {
    const next = { ...chatOf(chatId), tags };
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'chat.upsert', chat: next });
    return next;
  },
  sendFile: async (chatId: string, file: { name: string; mime: string; data: string; caption?: string; voice?: boolean }) => {
    const chat = chatOf(chatId);
    const ts = Date.now();
    const remoteId = `file-${ts}`;
    const kind: Attachment['kind'] = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
    const message: Message = {
      id: `${chatId}#${remoteId}`,
      chatId,
      remoteId,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text: file.caption ?? '',
      ts,
      status: 'sent',
      attachments: [{ kind, name: file.voice ? 'Sesli mesaj' : file.name, mime: file.mime, url: kind === 'image' ? file.data && `data:${file.mime};base64,${file.data}` : undefined, link: kind === 'audio' ? `data:${file.mime};base64,${file.data}` : undefined }],
    };
    messages.push(message);
    const next = touch(chat, file.caption || (file.voice ? '🎤 Sesli mesaj' : file.name), true, ts);
    emit({ type: 'message.upsert', message, chat: next });
    return { remoteId };
  },
  moreChats: async () => ({ added: 0, supported: false }),
  loadHistory: async () => undefined,
  // ---- pazaryeri gün sonu özeti + soru yanıtı AI taslağı (demo-market.ts, demo-ai.ts; model çağrısı yok) ----
  marketSummary: async (day?: string, platform?: string | null) => demoMarketSummary(chats, accounts, freshUser, day, platform),
  marketDigest: async () => demoDigestGet(),
  setMarketDigest: async (s: { enabled?: boolean; time?: string }) => demoDigestSet(s),
  questionDraft: async (chatId: string) => {
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));
    return demoQuestionDraft(chatOf(chatId), messages.filter((m) => m.chatId === chatId));
  },
  // Örnek AI: gerçek model yok; sohbete özel taslak/özet/aksiyon (demo-ai.ts). "Düşünme" süresi gerçekçi olsun
  draft: async (chatId: string, tone?: string): Promise<DraftResult> => {
    await new Promise((r) => setTimeout(r, 650 + Math.random() * 450));
    return demoDraft(chatOf(chatId), messages.filter((m) => m.chatId === chatId), (tone as 'default') ?? 'default');
  },
  setFollowUp: async (chatId: string, at: number | null): Promise<Chat> => {
    const next: Chat = { ...chatOf(chatId), followUp: at ? { at, since: Date.now() } : undefined };
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'chat.upsert', chat: next });
    // demo: kısa süreli hatırlatma gerçekten düşsün (çekirdekteki dakikalık denetimin karşılığı)
    if (at && at - Date.now() < 2_000_000_000) {
      window.setTimeout(() => {
        const cur = chats.find((c) => c.id === chatId);
        if (!cur?.followUp || cur.followUp.at !== at) return;
        const due: Chat = { ...cur, followUp: { ...cur.followUp, due: true } };
        chats = chats.map((c) => (c.id === chatId ? due : c));
        emit({ type: 'chat.upsert', chat: due });
        emit({ type: 'chat.followup', chat: due });
      }, Math.max(0, at - Date.now()));
    }
    return next;
  },
  // demo: cihaz takvimi taklidi (gerçek uygulamada Mac Takvim / Outlook'a doğrudan eklenir; indirme yok)
  calendar: async (ev: CalendarDraft & { mode?: 'device' | 'file'; calendar?: string }): Promise<CalendarResult> => ({ ics: demoIcs(ev), opened: false, added: true, calendar: ev.calendar || 'Kişisel' }),
  events: async (from?: string, to?: string): Promise<CalEvent[]> => demoEvents().filter((e) => !from || !to || (e.start >= from && e.start < to)).sort((a, b) => a.start.localeCompare(b.start)),
  saveEvent: async (ev: Partial<CalEvent> & { title: string; start: string; device?: boolean; calendar?: string }): Promise<{ event: CalEvent; device?: { added?: boolean; calendar?: string; denied?: boolean; error?: string } }> => {
    const list = demoEvents();
    const prev = ev.id ? list.find((e) => e.id === ev.id) : undefined;
    const next: CalEvent = { ...(prev ?? { id: `ev-${Date.now().toString(36)}`, createdAt: Date.now() }), title: ev.title, start: ev.start, allDay: !ev.start.includes('T'), durationMin: ev.durationMin ?? 60, notes: ev.notes, location: ev.location, remindMin: ev.remindMin, chatId: prev?.chatId ?? ev.chatId, messageId: prev?.messageId ?? ev.messageId, deviceCalendar: ev.device ? ev.calendar || 'Kişisel' : prev?.deviceCalendar };
    calEvents = [...list.filter((e) => e.id !== next.id), next];
    setTimeout(() => emit({ type: 'events.update' }), 0);
    return { event: next, device: ev.device ? { added: true, calendar: next.deviceCalendar } : undefined };
  },
  deleteEvent: async (id: string) => {
    calEvents = demoEvents().filter((e) => e.id !== id);
    setTimeout(() => emit({ type: 'events.update' }), 0);
    return { ok: true };
  },
  permissions: async () => ({ os: 'demo', fullDisk: true as boolean | null, tcc: null }),
  openPermissionPane: async (_pane: 'fulldisk' | 'automation' | 'microphone' | 'notifications') => ({ ok: true }),
  messagesPermission: async () => ({ result: 'granted' as 'granted' | 'denied' | 'error' }),
  calendars: async (probe = false): Promise<DeviceCalendars> => ({ supported: true, app: 'Takvim', calendars: probe ? ['Kişisel', 'İş', 'Aile'] : undefined }),
  calendarPermission: async () => ({ ok: true }),
  style: async () => ({ lines: DEMO_STYLE }),
  openChat: async (accountId: string, participant: { id: string; name: string; handle?: string; avatarUrl?: string }) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error('Hesap bulunamadı');
    const id = `${accountId}/${participant.id}`;
    const existing = chats.find((c) => c.id === id);
    if (existing) return existing;
    const chat: Chat = {
      id,
      accountId,
      platform: acc.platform,
      remoteId: participant.id,
      name: participant.name,
      kind: 'direct',
      unread: 0,
      lastMessageAt: Date.now(),
      lastPreview: '',
      tags: [],
      handle: participant.handle,
      avatarUrl: participant.avatarUrl,
    };
    chats.push(chat);
    emit({ type: 'chat.upsert', chat });
    return chat;
  },
  action: async (chatId: string, _payload?: Record<string, unknown>) => chatOf(chatId),
  // Demo: örnek AI hazır (model çağrısı yok); anahtar alanı gösterim amaçlı
  aiKey: async () => ({ set: true, source: 'settings' as const, hint: 'sk-ant-…demo' }),
  setAiKey: async () => ({ ok: true, ai: true }),
  lan: async () => ({ enabled: false, urls: [] as string[] }),
  setLan: async () => ({ enabled: false, urls: [] as string[] }),
  logs: async () => [{ ts: Date.now(), level: 'info' as const, text: 'Herkese açık demo. Gerçek hesap veya kişisel veri yok.' }],
  // demoda çekirdek yok: zamanlanmış gönderim tarayıcıda (Conversation.tsx yerel kuyruk) çalışır
  scheduled: async (): Promise<Array<{ id: string; chatId: string; text: string; at: number; threadId?: string; missed?: { reason: string; at: number } }>> => [],
  schedule: async (): Promise<never> => {
    throw new Error('Demoda zamanlama tarayıcıda tutulur');
  },
  unschedule: async () => ({ ok: false }),
  search: async (q: string, limit = 50) => {
    const query = q.toLocaleLowerCase('tr-TR');
    return [...messages]
      .filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(query) || (m.attachments ?? []).some((a) => (a.name ?? '').toLocaleLowerCase('tr-TR').includes(query)))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((message) => ({ message, chat: chatOf(message.chatId) }));
  },
  // ---- Raporum + Medya kütüphanesi (demo-insights.ts; yeni üye örnek veri görmez) ----
  stats: async (range: StatsRange, at?: string) => demoStats({ chats, messages, fresh: freshUser }, range, at),
  library: async (q: LibQuery) => demoLibrary({ chats, messages, fresh: freshUser }, q),
  libraryFacets: async () => demoLibraryFacets({ chats, messages, fresh: freshUser }),
  saveDownload: async (_name: string, _data: string): Promise<{ ok: boolean; name: string }> => ({ ok: false, name: '' }),
};

export function connectStaticEvents(onEvent: (ev: CoreEvent) => void, onState?: (open: boolean) => void): () => void {
  listeners.add(onEvent);
  onState?.(true);
  return () => {
    listeners.delete(onEvent);
    onState?.(false);
  };
}

/** Kişi birleştirme demosu (demo-people.ts): örnek sohbet/mesajlara salt okunur erişim + olay yayını */
export const demoPeopleSource = {
  chats: (): Chat[] => chats,
  messages: (): Message[] => messages,
  fresh: (): boolean => freshUser,
  emit: (ev: CoreEvent) => emit(ev),
};
