import type { Account, CalEvent, LoginInput, CalendarDraft, Chat, ChatFlags, CoreEvent, CoreOs, DraftResult, LinkPreview, Message, Platform } from './types';
import { API_BASE, REMOTE_CORE, coreToken } from './desktop';
import { STATIC_DEMO } from './profile';
import { connectStaticEvents, staticApi } from './static-demo';

const BASE = API_BASE + '/api';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await coreToken;
  const init: RequestInit = {
    method,
    headers: { 'x-mivelo-client': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-kavsak-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  };
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    // WebKit'te kapanmış keep-alive bağlantısı "Load failed" verir; bir kez yeniden dene
    await new Promise((r) => setTimeout(r, 150));
    try {
      res = await fetch(BASE + path, init);
    } catch {
      throw new Error(`Çekirdeğe ulaşılamadı (${(e as Error).message}). Çekirdek çalışıyor mu?`);
    }
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const enc = encodeURIComponent;

/** Paketli uygulamanın lisans durumu (çekirdek license.ts) */
export interface LicenseStatus {
  required: boolean;
  valid: boolean;
  key?: string;
  expiresAt?: string | null;
  reason?: string;
  /** Lisans sahibi (profil adı) */
  owner?: { name?: string; email?: string };
}

const liveApi = {
  health: () => call<{ ok: boolean; ai: boolean; stats: { unread: number; chats: number }; os?: CoreOs; user?: string }>('GET', '/health'),
  /** Pencere açık ve odakta mı (uyarlamalı yoklama için; ağ hatası sessizce yutulur) */
  license: (check = false) => call<LicenseStatus>('GET', check ? '/license?check=1' : '/license'),
  activateLicense: (key: string) => call<LicenseStatus>('POST', '/license', { key }),
  releaseLicense: () => call<LicenseStatus>('DELETE', '/license'),
  activity: (active: boolean) => call('POST', '/activity', { active }).catch(() => undefined),
  accounts: () => call<Account[]>('GET', '/accounts'),
  addAccount: (platform: Platform, token?: string) => call<Account>('POST', '/accounts', { platform, token }),
  removeAccount: (id: string) => call('DELETE', `/accounts/${enc(id)}`),
  restartAccount: (id: string) => call('POST', `/accounts/${enc(id)}/restart`),
  messageHtml: (messageId: string) => call<{ html: string }>('GET', `/messages/${enc(messageId)}/html`),
  loginInput: (id: string, events: LoginInput[]) => call('POST', `/accounts/${enc(id)}/login-input`, { events }),
  loginCancel: (id: string) => call('POST', `/accounts/${enc(id)}/login-cancel`),
  /** Bağlanmayı iptal et: hiç bağlanmamış yeni hesap kaldırılır, var olanın denemesi durur */
  cancelLogin: (id: string) => call<{ result: 'removed' | 'stopped' | 'none' }>('POST', `/accounts/${enc(id)}/cancel-login`),
  loginWindow: (id: string) => call('POST', `/accounts/${enc(id)}/login-window`),
  accountInput: (id: string, kind: 'phone' | 'code' | 'password', value: string) => call('POST', `/accounts/${enc(id)}/input`, { kind, value }),
  chats: () => call<Chat[]>('GET', '/chats'),
  messages: (chatId: string, limit = 100, before?: number) => call<Message[]>('GET', `/chats/${enc(chatId)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`),
  send: (chatId: string, text: string, threadId?: string, replyTo?: string) => call<{ remoteId: string }>('POST', `/chats/${enc(chatId)}/send`, { text, threadId, replyTo }),
  compose: (accountId: string, draft: { to: string; subject: string; text: string }) => call<Chat>('POST', `/accounts/${enc(accountId)}/compose`, draft),
  react: (chatId: string, messageId: string, emoji: string) => call<Message>('POST', `/chats/${enc(chatId)}/react`, { messageId, emoji }),
  /** Kendi mesajını herkesten sil / düzenle (EDIT_PLATFORMS / UNSEND_PLATFORMS) */
  deleteMessage: (messageId: string) => call<Message>('POST', `/messages/${enc(messageId)}/delete`),
  editMessage: (messageId: string, text: string) => call<Message>('POST', `/messages/${enc(messageId)}/edit`, { text }),
  setFlags: (chatId: string, flags: ChatFlags) => call<Chat>('POST', `/chats/${enc(chatId)}/flags`, flags),
  preview: (url: string) => call<LinkPreview>('GET', `/preview?url=${enc(url)}`),
  markRead: (chatId: string) => call('POST', `/chats/${enc(chatId)}/read`),
  setTags: (chatId: string, tags: string[]) => call<Chat>('POST', `/chats/${enc(chatId)}/tags`, { tags }),
  sendFile: (chatId: string, file: { name: string; mime: string; data: string; caption?: string; voice?: boolean }) => call<{ remoteId: string }>('POST', `/chats/${enc(chatId)}/send-file`, file),
  moreChats: (accountId: string) => call<{ added: number; supported: boolean }>('POST', `/accounts/${enc(accountId)}/more`),
  /** timedOut: telefon/platform yanıt vermedi; unavailable: kanal bağlı değil (ikisi de "daha eski yok" anlamına gelmez) */
  loadHistory: (chatId: string, before?: number, limit = 50) => call<{ ok?: boolean; timedOut?: boolean; unavailable?: string } | undefined>('POST', `/chats/${enc(chatId)}/history`, { limit, before }),
  draft: (chatId: string, tone?: string) => call<DraftResult>('POST', `/chats/${enc(chatId)}/draft`, { tone }),
  openChat: (accountId: string, participant: { id: string; name: string; handle?: string; avatarUrl?: string }) => call<Chat>('POST', '/chats/open', { accountId, participant }),
  action: (chatId: string, payload: Record<string, unknown>) => call<Chat>('POST', `/chats/${enc(chatId)}/action`, payload),
  aiKey: () => call<{ set: boolean; source: 'settings' | 'env' | null; hint: string | null }>('GET', '/ai/key'),
  setAiKey: (key: string | null) => call<{ ok: boolean; ai: boolean }>('POST', '/ai/key', { key }),
  lan: () => call<{ enabled: boolean; urls: string[]; qr?: string }>('GET', '/lan'),
  setLan: (enabled: boolean) => call<{ enabled: boolean; urls: string[]; qr?: string }>('POST', '/lan', { enabled }),
  logs: () => call<Array<{ ts: number; level: 'info' | 'warn' | 'error'; text: string }>>('GET', '/logs'),
  setFollowUp: (chatId: string, at: number | null) => call<Chat>('POST', `/chats/${enc(chatId)}/followup`, { at }),
  calendar: (ev: CalendarDraft & { mode?: 'device' | 'file'; calendar?: string }) => call<CalendarResult>('POST', '/calendar', ev),
  events: (from?: string, to?: string) => call<CalEvent[]>('GET', `/events${from && to ? `?from=${enc(from)}&to=${enc(to)}` : ''}`),
  saveEvent: (ev: Partial<CalEvent> & { title: string; start: string; device?: boolean; calendar?: string }) => call<{ event: CalEvent; device?: { added?: boolean; calendar?: string; denied?: boolean; error?: string } }>('POST', '/events', ev),
  deleteEvent: (id: string) => call<{ ok: boolean }>('DELETE', `/events/${enc(id)}`),
  calendars: (probe = false) => call<DeviceCalendars>('GET', `/calendars${probe ? '?probe=1' : ''}`),
  calendarPermission: () => call<{ ok: boolean }>('POST', '/calendars/permission'),
  // ilk açılış kurulumu (Onboarding): izin durumu, Sistem Ayarları bölmesi, Mesajlar otomasyon istemi (macOS)
  permissions: () => call<{ os: string; fullDisk: boolean | null }>('GET', '/permissions'),
  openPermissionPane: (pane: 'fulldisk' | 'automation' | 'microphone' | 'notifications') => call<{ ok: boolean }>('POST', '/permissions/open', { pane }),
  messagesPermission: () => call<{ result: 'granted' | 'denied' | 'error' }>('POST', '/permissions/messages'),
  style: (platform?: string) => call<{ lines: string[] }>('GET', `/style${platform ? `?platform=${enc(platform)}` : ''}`),
  search: (q: string, limit = 50) => call<Array<{ message: Message; chat: Chat }>>('GET', `/search?q=${enc(q)}&limit=${limit}`),
  // zamanlanmış gönderim (çekirdekte; arayüz kapalıyken de gider)
  scheduled: () => call<ScheduledItem[]>('GET', '/scheduled'),
  schedule: (chatId: string, text: string, at: number, threadId?: string) => call<ScheduledItem>('POST', '/scheduled', { chatId, text, at, threadId }),
  unschedule: (id: string) => call<{ ok: boolean }>('DELETE', `/scheduled/${enc(id)}`),
};

/** Takvime ekleme sonucu: added → cihaz takvimine eklendi; denied → izin yok; opened → .ics takvim uygulamasında açıldı */
export interface CalendarResult {
  ics: string;
  opened: boolean;
  added?: boolean;
  calendar?: string;
  denied?: boolean;
  error?: string;
  fallback?: string;
}
export interface DeviceCalendars {
  supported: boolean;
  app?: string;
  reason?: 'remote' | 'os';
  calendars?: string[];
  denied?: boolean;
  error?: string;
}

export interface ScheduledItem {
  id: string;
  chatId: string;
  text: string;
  at: number;
  threadId?: string;
  missed?: { reason: string; at: number };
}

/** Statik sitede uzak çekirdek ayarlıysa (#core=…) gerçek API, yoksa örnek veri */
export const USE_STATIC = STATIC_DEMO && !REMOTE_CORE;
export const api = USE_STATIC ? staticApi : liveApi;

/** Çekirdeğin olay demeti (packages/core/src/ws-batch.ts): sohbetler bir kez, mesaj olayları sohbetsiz */
interface WsBatch {
  type: 'batch';
  chats: Chat[];
  deletes: string[];
  events: Array<CoreEvent | { type: 'message.upsert'; message: Message; live?: boolean }>;
  refetch?: string[];
}

function safeEmit(onEvent: (ev: CoreEvent) => void, ev: CoreEvent): void {
  try {
    onEvent(ev);
  } catch (e) {
    console.error('olay işlenemedi', ev.type, e);
  }
}

/** Demeti eski tek tek olaylara aç: silinenler, sohbetler (son hali), sıralı olaylar (mesaja sohbeti eklenir), yeniden okuma */
function unpackBatch(b: WsBatch, onEvent: (ev: CoreEvent) => void): void {
  const chats = new Map(b.chats.map((c) => [c.id, c]));
  for (const id of b.deletes) safeEmit(onEvent, { type: 'chat.delete', chatId: id });
  for (const c of b.chats) safeEmit(onEvent, { type: 'chat.upsert', chat: c });
  for (const e of b.events) {
    if (e.type === 'message.upsert') safeEmit(onEvent, { type: 'message.upsert', message: e.message, live: e.live, chat: chats.get(e.message.chatId) });
    else safeEmit(onEvent, e);
  }
  if (b.refetch?.length) safeEmit(onEvent, { type: 'messages.refetch', chatIds: b.refetch });
}

/** Sunucudan gelen olay akışı; kopunca kendini yeniden bağlar. */
export function connectEvents(onEvent: (ev: CoreEvent) => void, onState?: (open: boolean) => void): () => void {
  if (USE_STATIC) return connectStaticEvents(onEvent, onState);
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: number | undefined;
  const open = async () => {
    const token = await coreToken;
    if (closed) return;
    const base = API_BASE ? API_BASE.replace(/^http/, 'ws') + '/ws' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    ws = new WebSocket(url);
    ws.onopen = () => onState?.(true);
    ws.onmessage = (m) => {
      let data: CoreEvent | WsBatch;
      try {
        data = JSON.parse(String(m.data)) as CoreEvent | WsBatch;
      } catch {
        return;
      }
      if (data.type === 'batch') unpackBatch(data, onEvent);
      else safeEmit(onEvent, data);
    };
    ws.onclose = () => {
      onState?.(false);
      if (!closed) timer = window.setTimeout(() => void open(), 1500);
    };
    ws.onerror = () => ws?.close();
  };
  void open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
