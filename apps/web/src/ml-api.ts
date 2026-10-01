import type { Chat, Message } from './types';
import { API_BASE, coreToken, refreshCoreToken } from './desktop';
import { USE_STATIC } from './api';
import { demoMlApi } from './demo-ml';

/**
 * Yerel AI (cihazda çalışan modeller) istemcisi: çekirdeğin /api/ml/… uçları (packages/core/src/ml/routes.ts).
 * Statik demoda model indirmeden taklit (demo-ml.ts).
 */
export type ModelKey = 'whisper' | 'embed';
export interface MlModel {
  key: ModelKey;
  id: string;
  title: string;
  state: 'absent' | 'downloading' | 'ready' | 'error';
  pct: number;
  sizeMb: number;
  approx: boolean;
  error?: string;
}
export interface MlSettings {
  autoTranscribe: boolean;
  semanticIndex: boolean;
  translateTarget: string;
  /** Modeller ilk açılışta arka planda kendiliğinden kurulur */
  autoInstall: boolean;
  declined?: ModelKey[];
}
/** Otomatik kurulum durumu (çekirdek ml/auto-install.ts) */
export interface MlAutoStatus {
  enabled: boolean;
  phase: 'off' | 'idle' | 'scheduled' | 'running' | 'retry' | 'nospace' | 'done';
  pct: number;
  keys: ModelKey[];
  error?: string;
  nextAt?: number;
  needMb?: number;
  freeMb?: number;
}
export interface IndexStatus {
  enabled: boolean;
  ready: boolean;
  indexed: number;
  total: number;
  pct: number;
  running: boolean;
}
export interface MlStatus {
  models: MlModel[];
  runtime: { ready: boolean; approxMb: number };
  settings: MlSettings;
  index: IndexStatus;
  /** Eski çekirdekte yok */
  auto?: MlAutoStatus;
  languages: Record<string, string>;
  demo?: boolean;
}
export interface Transcript {
  messageId: string;
  status: 'pending' | 'done' | 'error';
  text: string;
  lang?: string;
  error?: string;
  seconds?: number;
  updatedAt: number;
}
export interface SemanticHit {
  message: Message;
  chat: Chat;
  score: number;
  via: 'semantic' | 'text' | 'both';
  transcript?: string;
}
export interface SemanticResult {
  hits: SemanticHit[];
  mode: 'semantic' | 'text';
  hints: { dateLabel?: string; people: string[] };
  index: IndexStatus;
}
async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = await coreToken();
  const init: RequestInit = {
    method,
    headers: { 'x-mivelo-client': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-kavsak-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  };
  let res: Response;
  try {
    res = await fetch(API_BASE + '/api' + path, init);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      res = await fetch(API_BASE + '/api' + path, init);
    } catch {
      throw new Error(`Çekirdeğe ulaşılamadı (${(e as Error).message})`);
    }
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 403 && !retried && data.error === 'Yetkisiz kaynak') {
    const fresh = await refreshCoreToken();
    if (fresh && fresh !== token) return call<T>(method, path, body, true);
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const enc = encodeURIComponent;

const liveMlApi = {
  status: () => call<MlStatus>('GET', '/ml'),
  saveSettings: (s: Partial<MlSettings>) => call<MlStatus>('POST', '/ml/settings', s),
  download: (key: ModelKey) => call<MlModel>('POST', `/ml/models/${key}/download`),
  cancel: (key: ModelKey) => call<MlStatus>('POST', `/ml/models/${key}/cancel`),
  remove: (key: ModelKey) => call<MlStatus>('DELETE', `/ml/models/${key}`),
  transcripts: (chatId: string) => call<Record<string, Transcript>>('GET', `/ml/transcripts?chat=${enc(chatId)}`),
  transcribe: (messageId: string) => call<Transcript>('POST', '/ml/transcribe', { messageId }),
  search: (q: string, limit = 60) => call<SemanticResult>('GET', `/ml/search?q=${enc(q)}&limit=${limit}`),
};

export const mlApi: typeof liveMlApi = USE_STATIC ? demoMlApi : liveMlApi;
