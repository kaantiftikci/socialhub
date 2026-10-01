import { useEffect, useSyncExternalStore } from 'react';
import type { CoreEvent, Message } from './types';
import { mlApi, type MlStatus, type Transcript } from './ml-api';
import { setDemoMlEmitter } from './demo-ml';

/**
 * Yerel AI arayüz durumu (App'in büyük durumundan bağımsız; balonlar yalnız kendi mesajları değişince çizilir):
 * - model/dizin durumu (GET /api/ml, `ml.status` olayında tazelenir)
 * - sesli mesaj metinleri (sohbet açılınca toplu, sonra `transcript.update` olaylarıyla)
 * - mesaj çevirileri + sohbet başına "otomatik çevir" tercihi (localStorage)
 */
type Fn = () => void;
const subs = new Set<Fn>();
const notify = () => subs.forEach((f) => f());
const subscribe = (f: Fn) => (subs.add(f), () => void subs.delete(f));

let status: MlStatus | null = null;
let statusP: Promise<void> | null = null;
let statusTimer: number | undefined;

function loadStatus(): Promise<void> {
  statusP ??= mlApi
    .status()
    .then((s) => {
      status = s;
      notify();
      // indirme sürüyorsa olay kaçsa da ilerleme akar
      if (statusTimer) clearTimeout(statusTimer);
      if (s.models.some((m) => m.state === 'downloading') || s.index.running || s.auto?.phase === 'running') statusTimer = window.setTimeout(() => void refreshMlStatus(), 1500);
    })
    .catch(() => undefined)
    .finally(() => (statusP = null));
  return statusP;
}

export function refreshMlStatus(): Promise<void> {
  return loadStatus();
}

export function useMlStatus(): MlStatus | null {
  const s = useSyncExternalStore(subscribe, () => status);
  useEffect(() => {
    if (!status) void loadStatus();
  }, []);
  return s;
}

export const modelReady = (s: MlStatus | null, key: 'whisper' | 'embed') => !!s?.models.find((m) => m.key === key && m.state === 'ready');

// ---- sesli mesaj metinleri ----
const transcripts = new Map<string, Transcript>();
const loadingChats = new Set<string>();

/** Sohbetin sesli mesaj metinleri (sohbet her açıldığında; WS kopmasında kaçan olaylar da gelsin) */
export function loadChatTranscripts(chatId: string): void {
  if (loadingChats.has(chatId)) return;
  loadingChats.add(chatId);
  void mlApi
    .transcripts(chatId)
    .then((map) => {
      for (const t of Object.values(map)) transcripts.set(t.messageId, t);
      notify();
    })
    .catch(() => undefined)
    .finally(() => loadingChats.delete(chatId));
}

export function useTranscript(messageId: string): Transcript | undefined {
  return useSyncExternalStore(subscribe, () => transcripts.get(messageId));
}

export async function requestTranscript(messageId: string): Promise<void> {
  transcripts.set(messageId, { messageId, status: 'pending', text: '', updatedAt: Date.now() });
  notify();
  try {
    const t = await mlApi.transcribe(messageId);
    // olay önce geldiyse (done) geri 'pending'e düşürme
    if (transcripts.get(messageId)?.status === 'pending') transcripts.set(messageId, t);
  } catch (e) {
    transcripts.set(messageId, { messageId, status: 'error', text: '', error: (e as Error).message, updatedAt: Date.now() });
  }
  notify();
}

/** App.tsx olay akışından: yerel AI olaylarını işle (true = işlendi) */
export function pushMlEvent(ev: CoreEvent): boolean {
  if (ev.type === 'ml.status') {
    void loadStatus();
    return true;
  }
  if (ev.type === 'transcript.update') {
    transcripts.set(ev.messageId, ev.transcript);
    notify();
    return true;
  }
  return false;
}

setDemoMlEmitter(pushMlEvent);
