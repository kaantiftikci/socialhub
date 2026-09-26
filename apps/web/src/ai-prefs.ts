import { useSyncExternalStore } from 'react';

/**
 * AI özellik tercihleri (Ayarlar → AI): özetler, taslaklar, aksiyon çıkarma ayrı ayrı açılıp kapanır.
 * Cihaza özel; localStorage'da tutulur, açık tüm bileşenler anında güncellenir.
 */
export interface AiPrefs {
  summary: boolean;
  drafts: boolean;
  actions: boolean;
}

const KEY = 'mivelo.aiPrefs';
const DEFAULTS: AiPrefs = { summary: true, drafts: true, actions: true };
const subs = new Set<() => void>();
let cache: AiPrefs | null = null;

function read(): AiPrefs {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<AiPrefs>;
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setAiPrefs(patch: Partial<AiPrefs>) {
  cache = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* gizli mod vb.: yalnızca bu oturumda geçerli */
  }
  subs.forEach((f) => f());
}

export function useAiPrefs(): AiPrefs {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    read,
    read,
  );
}
