import type { Account, Chat, CoreEvent, DraftResult, Message, Platform } from './types';
import { API_BASE } from './desktop';

const BASE = API_BASE + '/api';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
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

export const api = {
  health: () => call<{ ok: boolean; ai: boolean; stats: { unread: number; chats: number } }>('GET', '/health'),
  accounts: () => call<Account[]>('GET', '/accounts'),
  addAccount: (platform: Platform, token?: string) => call<Account>('POST', '/accounts', { platform, token }),
  removeAccount: (id: string) => call('DELETE', `/accounts/${enc(id)}`),
  restartAccount: (id: string) => call('POST', `/accounts/${enc(id)}/restart`),
  accountInput: (id: string, kind: 'phone' | 'code' | 'password', value: string) => call('POST', `/accounts/${enc(id)}/input`, { kind, value }),
  chats: () => call<Chat[]>('GET', '/chats'),
  messages: (chatId: string, limit = 100) => call<Message[]>('GET', `/chats/${enc(chatId)}/messages?limit=${limit}`),
  send: (chatId: string, text: string) => call<{ remoteId: string }>('POST', `/chats/${enc(chatId)}/send`, { text }),
  markRead: (chatId: string) => call('POST', `/chats/${enc(chatId)}/read`),
  setTags: (chatId: string, tags: string[]) => call<Chat>('POST', `/chats/${enc(chatId)}/tags`, { tags }),
  loadHistory: (chatId: string) => call('POST', `/chats/${enc(chatId)}/history`, { limit: 50 }),
  draft: (chatId: string, tone?: string) => call<DraftResult>('POST', `/chats/${enc(chatId)}/draft`, { tone }),
  openChat: (accountId: string, participant: { id: string; name: string; handle?: string; avatarUrl?: string }) => call<Chat>('POST', '/chats/open', { accountId, participant }),
  action: (chatId: string, payload: Record<string, unknown>) => call<Chat>('POST', `/chats/${enc(chatId)}/action`, payload),
  logs: () => call<Array<{ ts: number; level: 'info' | 'warn' | 'error'; text: string }>>('GET', '/logs'),
  search: (q: string) => call<Array<{ message: Message; chat: Chat }>>('GET', `/search?q=${enc(q)}`),
};

/** Sunucudan gelen olay akışı; kopunca kendini yeniden bağlar. */
export function connectEvents(onEvent: (ev: CoreEvent) => void, onState?: (open: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let timer: number | undefined;
  const open = () => {
    const url = API_BASE ? API_BASE.replace(/^http/, 'ws') + '/ws' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    ws = new WebSocket(url);
    ws.onopen = () => onState?.(true);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as CoreEvent);
      } catch {
        /* yok say */
      }
    };
    ws.onclose = () => {
      onState?.(false);
      if (!closed) timer = window.setTimeout(open, 1500);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
