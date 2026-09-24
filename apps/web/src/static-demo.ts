import type { Account, Attachment, Chat, CoreEvent, DraftResult, Message, Platform } from './types';
import { PLATFORMS } from './types';
import { authSaveAccounts } from './auth-api';
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

type Line = [fromMe: boolean, text: string, attachments?: Attachment[]];

/** Platform başına örnek sohbet şablonları (uydurma kişiler; gerçek hesap ya da kişisel veri yok) */
interface Script {
  remoteId: string;
  name: string;
  kind: Chat['kind'];
  tags: string[];
  unread: number;
  handle?: string;
  lines: Line[];
}
const T: Partial<Record<Platform, Script[]>> = {
  whatsapp: [
    { remoteId: 'ayse', name: 'Ayşe Demir', kind: 'direct', tags: ['müşteri'], unread: 2, handle: '+90 532 000 00 01', lines: [[false, 'Merhaba, siparişim ne zaman kargoya verilir?'], [true, 'Merhaba Ayşe Hanım, bugün 17:00’ye kadar kargoya veriyoruz.'], [false, 'Süper, teşekkürler 🙏'], [false, 'Bir de faturayı e-posta ile alabilir miyim?']] },
    { remoteId: 'ekip', name: 'Satış Ekibi', kind: 'group', tags: ['ekip'], unread: 5, lines: [[false, 'Mert: Bu haftanın hedefi 40 sipariş, şu an 31’deyiz'], [true, 'Kalan 9 için kampanya mailini bugün atalım'], [false, 'Zeynep: Tasarım hazır, 15:00’te yollarım'], [false, 'Mert: 👍'], [false, 'Zeynep: Kargo firmasıyla görüştüm, cumartesi de teslimat var']] },
    { remoteId: 'burak', name: 'Burak Kaya', kind: 'direct', tags: ['fırsat'], unread: 0, handle: '+90 505 000 00 02', lines: [[false, 'Toptan fiyat listeniz var mı? 200 adet düşünüyoruz.'], [true, 'Var, PDF olarak gönderiyorum. 200 adette %18 indirim uyguluyoruz.'], [false, 'Harika, yarın döneriz.']] },
    { remoteId: 'annem', name: 'Annem', kind: 'direct', tags: ['kişisel'], unread: 1, lines: [[false, 'Akşam yemeğe geliyor musun?'], [true, 'Geliyorum, 19:30 gibi oradayım'], [false, 'Tamam, sarma yaptım 🥰']] },
  ],
  telegram: [
    { remoteId: 'can', name: 'Can Yılmaz', kind: 'direct', tags: [], unread: 1, handle: '@canyilmaz', lines: [[false, 'API dokümanını güncelledim, bakabilir misin?'], [true, 'Bakıyorum, 20 dk sonra dönerim'], [false, 'Ok, özellikle webhook kısmına bak']] },
    { remoteId: 'duyuru', name: 'Mivelo Duyurular', kind: 'channel', tags: [], unread: 3, lines: [[false, 'Sürüm 1.4: e-posta görünümü ve dosya gönderme eklendi'], [false, 'Bakım: Cumartesi 03:00-04:00'], [false, 'Yeni: kanal sıralama ve uygulama başına bildirim sesi']] },
    { remoteId: 'gelistirici', name: 'Geliştiriciler', kind: 'group', tags: ['ekip'], unread: 0, lines: [[false, 'Elif: PR #212 hazır, review alabilir miyim?'], [true, 'Aldım, iki küçük not bıraktım'], [false, 'Elif: Düzelttim, merge edebilirsin']] },
  ],
  instagram: [
    { remoteId: 'selin', name: 'selin.tasarim', kind: 'direct', tags: ['fırsat'], unread: 2, handle: '@selin.tasarim', lines: [[false, 'Merhaba! İş birliği için yazıyorum, ürünlerinizi çok beğendim ✨'], [true, 'Merhaba Selin, ilgin için teşekkürler. Nasıl bir iş birliği düşünüyorsun?'], [false, 'Hikâyede 3 paylaşım + 1 reels olabilir'], [false, 'Fiyat teklifimi DM’den atayım mı?']] },
    { remoteId: 'musteri1', name: 'deniz_87', kind: 'direct', tags: ['müşteri'], unread: 0, handle: '@deniz_87', lines: [[false, 'Bu ürün 38 numara var mı?'], [true, 'Var, siteden sipariş verebilirsiniz 🙂'], [false, 'Verdim, teşekkürler!']] },
  ],
  x: [
    { remoteId: 'tech', name: 'Tech Haber', kind: 'direct', tags: [], unread: 1, handle: '@techhaber', lines: [[false, 'Ürün lansmanınızla ilgili kısa bir röportaj yapabilir miyiz?'], [true, 'Tabii, perşembe uygun mu?'], [false, 'Perşembe 14:00 harika']] },
    { remoteId: 'okan', name: 'Okan', kind: 'direct', tags: [], unread: 0, handle: '@okan_dev', lines: [[false, 'Paylaştığın thread çok iyiydi 👏'], [true, 'Teşekkürler!']] },
  ],
  linkedin: [
    { remoteId: 'gamze', name: 'Gamze Aksoy', kind: 'direct', tags: ['fırsat'], unread: 1, handle: 'İK Müdürü · Nova Yazılım', lines: [[false, 'Merhaba, ekibimize kıdemli geliştirici arıyoruz. Görüşmek ister misiniz?'], [true, 'Merhaba Gamze Hanım, detayları dinlemek isterim.'], [false, 'Harika, takvim bağlantısını gönderiyorum.']] },
    { remoteId: 'emre', name: 'Emre Şahin', kind: 'direct', tags: [], unread: 0, handle: 'Kurucu · Lumo', lines: [[false, 'Bağlantı isteğimi kabul ettiğiniz için teşekkürler!'], [true, 'Rica ederim, projeleriniz ilgimi çekti.']] },
  ],
  slack: [
    { remoteId: 'genel', name: '#genel', kind: 'channel', tags: ['ekip'], unread: 4, lines: [[false, 'Ali: Sprint toplantısı 11:00’de'], [false, 'Ceren: Deploy tamam, prod sağlıklı ✅'], [true, 'Süper, release notlarını paylaşıyorum'], [false, 'Ali: Teşekkürler'], [false, 'Ceren: Bir de tasarım review isteyenler var mı?']] },
    { remoteId: 'ceren', name: 'Ceren Ulu', kind: 'direct', tags: [], unread: 0, handle: '@ceren', lines: [[false, 'Bugün 1:1 saatimizi 30 dk kaydırabilir miyiz?'], [true, 'Olur, 15:30’da görüşürüz']] },
  ],
  messenger: [
    { remoteId: 'hakan', name: 'Hakan Öz', kind: 'direct', tags: ['müşteri'], unread: 1, lines: [[false, 'Ürün stokta var mı?'], [true, 'Var, bugün sipariş verirseniz yarın kargoda.'], [false, 'Tamam sipariş veriyorum']] },
  ],
  imessage: [
    { remoteId: 'esra', name: 'Esra', kind: 'direct', tags: ['kişisel'], unread: 1, lines: [[false, 'Akşam sinemaya gidelim mi?'], [true, 'Olur, 20:30 seansı?'], [false, 'Tamam, biletleri alıyorum 🎬']] },
    { remoteId: 'kargo', name: 'Kargo Bildirim', kind: 'direct', tags: [], unread: 0, lines: [[false, 'Gönderiniz dağıtıma çıktı. Takip: 1234567890']] },
  ],
  gmail: [
    { remoteId: 'fatura', name: 'Eylül faturanız hazır', kind: 'direct', tags: [], unread: 1, handle: 'fatura@bulutdepo.example', lines: [[false, 'Merhaba,\n\nEylül ayı faturanız ektedir. Toplam: 1.250,00 TL. Son ödeme tarihi 5 Ekim.\n\nBulut Depo Ekibi', [{ kind: 'file', name: 'fatura-eylul.pdf', mime: 'application/pdf', size: 84_212 }]]] },
    { remoteId: 'toplanti', name: 'Toplantı özeti ve sonraki adımlar', kind: 'direct', tags: ['ekip'], unread: 0, handle: 'melis@nova.example', lines: [[false, 'Selam,\n\nBugünkü toplantının özeti:\n- Lansman 15 Ekim\n- Basın bülteni bu hafta\n- Demo ortamı hazır\n\nMelis'], [true, 'Teşekkürler Melis, basın bültenini yarın gönderirim.']] },
  ],
  outlook: [
    { remoteId: 'teklif', name: 'Re: Teklif talebi', kind: 'direct', tags: ['fırsat'], unread: 1, handle: 'satinalma@marmara.example', lines: [[false, 'Merhaba,\n\nTeklifinizi aldık, teşekkürler. Teslim süresini 3 haftaya çekebilir misiniz?\n\nSaygılarımla,\nSatın Alma'], [true, 'Merhaba,\n\n3 hafta mümkün, revize teklifi ekte iletiyorum.'], [false, 'Teşekkürler, yarın yönetimle görüşüp döneceğiz.']] },
  ],
  shopier: [
    { remoteId: '10231', name: 'Sipariş #10231', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Ali Vural', lines: [[false, 'Sipariş alındı: 2 × Keten Gömlek (M) — 1.398,00 TL'], [false, 'Ödeme onaylandı']] },
    { remoteId: '10228', name: 'Sipariş #10228', kind: 'direct', tags: [], unread: 0, handle: 'Nur Çelik', lines: [[false, 'Sipariş alındı: 1 × Deri Cüzdan — 649,00 TL'], [false, 'Ödeme onaylandı'], [true, 'Kargoya verildi']] },
  ],
};
const GENERIC: Script[] = [{ remoteId: 'ornek', name: 'Örnek sohbet', kind: 'direct', tags: [], unread: 1, lines: [[false, 'Merhaba! Bu bir demo sohbeti.'], [true, 'Selam, demo mesajı 👋']] }];

/** Canlı akış: rastgele bir sohbete gelen kısa mesajlar */
const LIVE_TEXTS = ['Müsait olunca bir bakar mısın?', 'Teşekkürler, harika oldu 🙌', 'Toplantı 15 dk gecikecek', 'Bu fiyat hâlâ geçerli mi?', 'Gönderdim, ulaştı mı?', 'Yarın görüşelim mi?'];

let accounts: Account[] = [];
let chats: Chat[] = [];
let messages: Message[] = [];

/** Bağlı hesaplardan sohbetleri üret (hesap başına platform şablonu) */
function seed(): void {
  const now = Date.now();
  chats = [];
  messages = [];
  let k = 0;
  for (const acc of accounts) {
    const scripts = T[acc.platform] ?? GENERIC;
    scripts.forEach((s, i) => {
      k++;
      const id = `${acc.id}/${s.remoteId}`;
      const lines = s.lines;
      const lastAt = now - k * 1_900_000 - i * 600_000;
      lines.forEach(([fromMe, text, attachments], j) => {
        messages.push({
          id: `${id}#seed-${j}`,
          chatId: id,
          remoteId: `seed-${j}`,
          senderId: fromMe ? 'me' : s.remoteId,
          senderName: fromMe ? 'Ben' : s.kind === 'direct' ? s.name : (text.split(':')[0] ?? s.name),
          fromMe,
          text: s.kind === 'direct' || fromMe ? text : text.replace(/^[^:]+:\s*/, ''),
          ts: lastAt - (lines.length - 1 - j) * 240_000,
          status: fromMe ? 'read' : 'delivered',
          attachments,
        });
      });
      const last = lines[lines.length - 1];
      const lastText = last?.[1] ?? '';
      chats.push({
        id,
        accountId: acc.id,
        platform: acc.platform,
        remoteId: s.remoteId,
        name: s.name,
        kind: s.kind,
        unread: s.unread,
        lastMessageAt: lastAt,
        lastPreview: s.kind === 'direct' ? lastText : last?.[0] ? `Sen: ${lastText}` : lastText,
        lastFromMe: last?.[0] ?? false,
        tags: s.tags,
        handle: s.handle,
        participants: s.handle && (PLATFORMS[acc.platform].category === 'mail') ? [{ id: s.handle, name: s.handle.split('@')[0] ?? s.handle, handle: s.handle }] : undefined,
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
    }));
  seed();
}

export function clearDemoAccounts(): void {
  accounts = [];
  chats = [];
  messages = [];
}

let tick = 0;
if (STATIC_DEMO) {
  setInterval(() => {
    const pool = chats.filter((c) => c.kind === 'direct' && PLATFORMS[c.platform].category !== 'mail' && PLATFORMS[c.platform].category !== 'shop');
    if (!pool.length) return;
    const chat = pool[tick++ % pool.length];
    const id = chat.id;
    const text = LIVE_TEXTS[Math.floor(Math.random() * LIVE_TEXTS.length)];
    const ts = Date.now();
    const message: Message = {
      id: `${id}#live-${ts}`,
      chatId: id,
      remoteId: `live-${ts}`,
      senderId: chat.remoteId,
      senderName: chat.name,
      fromMe: false,
      text,
      ts,
      status: 'delivered',
    };
    messages.push(message);
    const next = { ...touch(chat, text, false, ts), unread: chat.unread + 1 };
    chats = chats.map((c) => (c.id === id ? next : c));
    emit({ type: 'chat.upsert', chat: next });
    emit({ type: 'message.upsert', message, chat: next, live: true });
  }, 45_000);
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
  sendFile: async (chatId: string, file: { name: string; mime: string; data: string; caption?: string }) => {
    const chat = chatOf(chatId);
    const ts = Date.now();
    const remoteId = `file-${ts}`;
    const kind: Attachment['kind'] = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : 'file';
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
      attachments: [{ kind, name: file.name, mime: file.mime, url: kind === 'image' ? file.data && `data:${file.mime};base64,${file.data}` : undefined }],
    };
    messages.push(message);
    const next = touch(chat, file.caption || file.name, true, ts);
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
