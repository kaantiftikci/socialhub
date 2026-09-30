import { useEffect, useSyncExternalStore } from 'react';
import type { CoreEvent, Message } from './types';
import { mlApi, type MessageTranslation, type MlStatus, type Transcript } from './ml-api';
import { setDemoMlEmitter } from './demo-ml';
import { detectLanguage } from './lang-detect';

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
      if (s.models.some((m) => m.state === 'downloading') || s.index.running) statusTimer = window.setTimeout(() => void refreshMlStatus(), 1500);
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

// ---- çeviriler ----
export type TranslationState = { state: 'loading' } | { state: 'done'; t: MessageTranslation } | { state: 'error'; error: string } | { state: 'hidden'; t?: MessageTranslation };
const translations = new Map<string, TranslationState>();

export function useTranslation(messageId: string): TranslationState | undefined {
  return useSyncExternalStore(subscribe, () => translations.get(messageId));
}

export async function translateMessage(messageId: string, opts: { force?: boolean; quiet?: boolean } = {}): Promise<void> {
  const cur = translations.get(messageId);
  if (cur?.state === 'loading') return;
  if (cur?.state === 'hidden' && cur.t) {
    translations.set(messageId, { state: 'done', t: cur.t });
    return notify();
  }
  translations.set(messageId, { state: 'loading' });
  notify();
  try {
    const t = await mlApi.translate(messageId, undefined, opts.force);
    // otomatik çeviride zaten Türkçe olan mesajın altına bir şey yazma
    if (t.same && opts.quiet) translations.delete(messageId);
    else translations.set(messageId, { state: 'done', t });
  } catch (e) {
    if (opts.quiet) translations.delete(messageId);
    else translations.set(messageId, { state: 'error', error: (e as Error).message });
  }
  notify();
}

export function hideTranslation(messageId: string): void {
  const cur = translations.get(messageId);
  translations.set(messageId, { state: 'hidden', t: cur?.state === 'done' ? cur.t : undefined });
  notify();
}

// ---- sohbet başına otomatik çeviri (bu tarayıcıda) ----
const AUTO_KEY = 'mivelo.autoTranslate';
let autoSet: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(AUTO_KEY) || '[]') as string[]);
  } catch {
    return new Set<string>();
  }
})();

export function useAutoTranslate(chatId: string): boolean {
  return useSyncExternalStore(subscribe, () => autoSet.has(chatId));
}

export function setAutoTranslate(chatId: string, on: boolean): void {
  autoSet = new Set(autoSet);
  if (on) autoSet.add(chatId);
  else autoSet.delete(chatId);
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify([...autoSet].slice(-500)));
  } catch {
    /* depolama kapalı */
  }
  notify();
}

/** Mesaj yabancı dilde mi (arayüz dili Türkçe): kısa/kararsız metinde hayır */
export function isForeign(text: string, target = 'tr'): boolean {
  const g = detectLanguage(text);
  return !!g.lang && g.lang !== target && g.confidence >= 0.3;
}

/** Otomatik çeviri: açık sohbette son gelen yabancı mesajlar sırayla çevrilir (en çok 30, sessiz) */
export function useAutoTranslateEffect(chatId: string, messages: Message[]): void {
  const on = useAutoTranslate(chatId);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const todo = messages
      .filter((m) => !m.fromMe && !m.deleted && m.text.trim().length > 3 && !translations.has(m.id) && isForeign(m.text))
      .slice(-30);
    void (async () => {
      for (const m of todo) {
        if (!alive) return;
        await translateMessage(m.id, { quiet: true });
      }
    })();
    return () => {
      alive = false;
    };
    // yeni mesaj gelince yeniden bakılır; çevrilmekte olanlar haritada olduğundan tekrar istenmez
  }, [on, chatId, messages]);
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
