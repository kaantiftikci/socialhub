import type { Account, Attachment, Chat, CoreEvent, DraftResult, Message, Platform } from './types';
import { PLATFORMS } from './types';
import { authSaveAccounts } from './auth-api';
import { DEMO_APPS, SCRIPTS } from './demo-scripts';
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
const memberAvatar = (name: string): string | undefined => (AVATAR_FILES.has(slug(name)) ? `/demo/avatars/${slug(name)}.jpg` : undefined);
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
          senderAvatarUrl: fromMe ? undefined : s.kind === 'direct' ? `/demo/avatars/${s.avatar}` : memberAvatar(who),
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
        const text = `${REACT_EMOJI[k % REACT_EMOJI.length]} ${who} bir mesajı beğendi`;
        messages.push({ id: `${id}#react`, chatId: id, remoteId: 'react', senderId: s.kind === 'direct' ? s.remoteId : slug(who), senderName: who, fromMe: false, text, ts: lastAt + 90_000, status: 'delivered' });
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
        avatarUrl: `/demo/avatars/${s.avatar}`,
        meta: s.summary?.length || s.note ? { ...(s.summary?.length ? { summary: s.summary } : {}), ...(s.note ? { note: s.note } : {}) } : undefined,
        participants: s.handle && PLATFORMS[acc.platform].category === 'mail' ? [{ id: s.handle, name: s.handle.split('@')[0] ?? s.handle, handle: s.handle, avatarUrl: `/demo/avatars/${s.avatar}` }] : undefined,
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

// Canlı beğeni akışı: 70 sn'de bir uygun bir sohbete "X bir mesajı beğendi" düşer (önizleme ve bildirim canlı kalsın)
let reactTick = 0;
if (STATIC_DEMO) {
  setInterval(() => {
    const pool = chats.filter((c) => REACT_PLATFORMS.has(c.platform));
    if (!pool.length) return;
    const chat = pool[reactTick++ % pool.length];
    const who = chat.kind === 'direct' ? chat.name.split(' ')[0] : (messages.find((m) => m.chatId === chat.id && !m.fromMe)?.senderName ?? chat.name);
    const ts = Date.now();
    const text = `${REACT_EMOJI[reactTick % REACT_EMOJI.length]} ${who} bir mesajı beğendi`;
    const message: Message = { id: `${chat.id}#react-${ts}`, chatId: chat.id, remoteId: `react-${ts}`, senderId: chat.remoteId, senderName: who, fromMe: false, text, ts, status: 'delivered' };
    messages.push(message);
    const next = { ...touch(chat, text, false, ts), unread: chat.unread + 1 };
    chats = chats.map((c) => (c.id === chat.id ? next : c));
    emit({ type: 'chat.upsert', chat: next });
    emit({ type: 'message.upsert', message, chat: next, live: true });
  }, 70_000);
}

export const staticApi = {
  health: async () => ({ ok: true, ai: false, stats: { unread: chats.reduce((n, c) => n + c.unread, 0), chats: chats.length } }),
  accounts: async () => accounts.map((a) => ({ ...a })),
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
    emit({ type: 'account.status', account });
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
  restartAccount: async (_id: string) => {
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
  send: async (chatId: string, text: string) => {
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
  draft: async (_chatId: string): Promise<DraftResult> => ({
    draft: 'Teşekkürler, uygun bir zamanda dönüş yapacağım.',
    summary: ['Bu herkese açık demodur; taslak örnektir ve kaydedilmez.'],
    actions: [],
  }),
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
