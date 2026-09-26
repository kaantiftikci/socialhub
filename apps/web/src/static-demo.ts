import type { Account, Attachment, CalendarDraft, Chat, ChatFlags, CoreEvent, CoreOs, DraftResult, LinkPreview, Message, Platform } from './types';
import { PLATFORMS } from './types';
import { authSaveAccounts } from './auth-api';
import { demoAsset } from './demo-asset';
import { DEMO_OFFLINE } from './profile';
import { DEMO_APPS, SCRIPTS } from './demo-scripts';
import { DEMO_STYLE, demoDraft } from './demo-ai';
import { STATIC_DEMO } from './profile';

/**
 * Herkese açık site. Uygulama listesi kullanıcının oturumunda saklanır;
 * şifre, belirteç ve gerçek oturum anahtarı tutulmaz.
 */

type Listener = (ev: CoreEvent) => void;
const listeners = new Set<Listener>();
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
const REACT_PLATFORMS = new Set<Platform>(['whatsapp', 'instagram', 'messenger', 'imessage', 'telegram', 'slack']);
const REACT_EMOJI = ['👍', '❤️', '😂', '🔥', '👏'];
export const isReactionText = (t: string) => /^(👍|❤️|😂|🔥|👏|😮) .+ (bir mesajı beğendi|mesajına tepki verdi)$/.test(t);

function seed(): void {
  const now = Date.now();
  chats = [];
  messages = [];
  let k = 0;
  for (const acc of accounts) {
    const scripts = SCRIPTS[acc.platform];
    if (!scripts) continue;
    scripts.forEach((s, i) => {
      k += 1;
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
          ts: lastAt - (s.lines.length - 1 - j) * 18 * 60_000,
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
        const text = `${emoji} ${who} bir mesajı beğendi`;
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
        participants: s.handle && PLATFORMS[acc.platform].category === 'mail' ? [{ id: s.handle, name: s.handle.split('@')[0] ?? s.handle, handle: s.handle, avatarUrl: demoAsset(`avatars/${s.avatar}`) }] : undefined,
      });
    });
  }
}

function chatOf(id: string): Chat {
  const c = chats.find((x) => x.id === id);
  if (!c) throw new Error('Sohbet bulunamadı');
  return c;
}

function touch(chat: Chat, text: string, fromMe: boolean, ts: number): Chat {
  const next = { ...chat, lastPreview: text, lastFromMe: fromMe, lastMessageAt: ts };
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

export function loadDemoAccounts(list: Array<Record<string, unknown>>): void {
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
  const next = [...DEMO_APPS.map((p) => byPlatform.get(p) ?? demoAccount(p)), ...extras];
  const changed = next.length !== accounts.length || next.some((a, i) => a.id !== accounts[i]?.id);
  accounts = next;
  if (changed) void saveAccounts().catch(() => undefined);
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
if (STATIC_DEMO) {
  setInterval(() => {
    const pool = chats.filter((c) => REACT_PLATFORMS.has(c.platform) && c.kind !== 'channel');
    if (!pool.length) return;
    liveTick++;
    const chat = pool[(liveTick * 7) % pool.length];
    const tag = chat.tags.find((t) => LIVE_LINES[t]) ?? 'genel';
    const lines = LIVE_LINES[tag];
    const text = lines[(liveTick * 3) % lines.length];
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
  }, 70_000);
}


/** Demo: çekirdek yok; tek etkinlikli .ics tarayıcıda üretilir ve indirilir */
function demoIcs(ev: CalendarDraft): string {
  const [d, t] = ev.start.split('T');
  const ymd = d.replace(/-/g, '');
  const start = t ? `DTSTART:${ymd}T${t.replace(':', '')}00` : `DTSTART;VALUE=DATE:${ymd}`;
  const esc = (x: string) => x.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mivelo//TR', 'BEGIN:VEVENT', `UID:${Date.now()}@mivelo`, start, `SUMMARY:${esc(ev.title)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export const staticApi = {
  activity: async (_active: boolean) => undefined,
  health: async () => ({ ok: true, ai: true, stats: { unread: chats.reduce((n, c) => n + c.unread, 0), chats: chats.length }, os: undefined as CoreOs | undefined }),
  accounts: async () => accounts.map(withDemoAttention),
  addAccount: async (platform: Platform, _token?: string): Promise<Account> => {
    const account: Account = {
      id: `${platform}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      platform,
      label: PLATFORMS[platform].name,
      status: 'connected',
      createdAt: Date.now(),
    };
    const prev = accounts;
    accounts = [...accounts, account];
    try {
      await saveAccounts();
    } catch (e) {
      accounts = prev;
      throw e;
    }
    emit({ type: 'account.status', account: withDemoAttention(account) });
    seed();
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
  restartAccount: async (id: string) => {
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
  accountInput: async (_id: string, _kind: 'phone' | 'code' | 'password', _value: string) => {
    throw new Error(DEMO_BLOCK);
  },
  chats: async () => chats.map((c) => ({ ...c })),
  messages: async (chatId: string, limit = 100, before?: number) =>
    messages
      .filter((m) => m.chatId === chatId && (before == null || m.ts < before))
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit),
  send: async (chatId: string, text: string, _threadId?: string) => {
    const chat = chatOf(chatId);
    const ts = Date.now();
    const remoteId = `demo-${ts}`;
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
    };
    messages.push(message);
    const next = { ...touch(chat, text, true, ts), unread: 0 };
    chats = chats.map((c) => (c.id === chatId ? next : c));
    emit({ type: 'message.upsert', message, chat: next });
    window.setTimeout(() => {
      message.status = 'read';
      emit({ type: 'message.upsert', message: { ...message }, chat: next });
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
  calendar: async (ev: CalendarDraft) => ({ ics: demoIcs(ev), opened: false }),
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
  search: async (q: string) => {
    const query = q.toLocaleLowerCase('tr-TR');
    return messages
      .filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(query))
      .slice(0, 40)
      .map((message) => ({ message, chat: chatOf(message.chatId) }));
  },
};

export function connectStaticEvents(onEvent: (ev: CoreEvent) => void, onState?: (open: boolean) => void): () => void {
  listeners.add(onEvent);
  onState?.(true);
  return () => {
    listeners.delete(onEvent);
    onState?.(false);
  };
}
