import { useSyncExternalStore } from 'react';
import { call, USE_STATIC } from './api';

/**
 * Yasal onaylar (01.10; çekirdek consent.ts ile AYNI sürümler): Kullanım Koşulları/EULA kabulü, KVKK aydınlatma okundu,
 * resmi olmayan bağlantı riski (üçü zorunlu, masaüstünde lisans ekranında) + isteğe bağlı AI açık rızası (yurt dışına aktarım;
 * ilk AI kullanımında `requireAiConsent`). Kaynak çekirdek (`/api/consent`, ~/.mivelo/consent.json); çekirdeğe ulaşılamazsa ya da
 * statik demoda localStorage `mivelo.consent` (her kayıtta kopyası da yazılır). Sürüm değişince yeniden sorulur.
 */
export const CONSENT_VERSIONS = { terms: '2026-10-01', kvkk: '2026-10-01', risk: '2026-10-01', ai: '2026-10-01' } as const;
export type ConsentKey = keyof typeof CONSENT_VERSIONS;
export const REQUIRED_CONSENTS: ConsentKey[] = ['terms', 'kvkk', 'risk'];

export interface ConsentEntry {
  v: string;
  at: number;
}
export type ConsentRecord = Partial<Record<ConsentKey, ConsentEntry>> & { aiRevokedAt?: number };
export interface ConsentState {
  accepted: ConsentRecord;
  needed: ConsentKey[];
  ai: boolean;
}

export const LEGAL_URLS = {
  terms: 'https://mivelo.app/kosullar.html',
  privacy: 'https://mivelo.app/gizlilik.html',
  kvkk: 'https://mivelo.app/kvkk.html',
  consent: 'https://mivelo.app/acik-riza.html',
  cookies: 'https://mivelo.app/cerez.html',
  oss: 'https://mivelo.app/lisanslar.html',
} as const;

const LS = 'mivelo.consent';
const subs = new Set<() => void>();
let cache: ConsentState | null = null;

const cur = (r: ConsentRecord, k: ConsentKey) => r[k]?.v === CONSENT_VERSIONS[k];
function stateOf(r: ConsentRecord): ConsentState {
  return { accepted: r, needed: REQUIRED_CONSENTS.filter((k) => !cur(r, k)), ai: cur(r, 'ai') };
}
function readLocal(): ConsentRecord {
  try {
    const r = JSON.parse(localStorage.getItem(LS) || '{}') as ConsentRecord;
    return r && typeof r === 'object' ? r : {};
  } catch {
    return {};
  }
}
function writeLocal(r: ConsentRecord): void {
  try {
    localStorage.setItem(LS, JSON.stringify(r));
  } catch {
    /* depolama yok */
  }
}
function set(s: ConsentState): ConsentState {
  cache = s;
  writeLocal(s.accepted);
  subs.forEach((f) => f());
  return s;
}

/** Eşzamanlı son bilinen durum (yüklenmediyse yerel kopya) */
export function getConsent(): ConsentState {
  // useSyncExternalStore aynı nesneyi beklemeli: ilk okumada önbelleğe al
  if (!cache) cache = stateOf(readLocal());
  return cache;
}

export async function loadConsent(): Promise<ConsentState> {
  if (!USE_STATIC) {
    try {
      return set(stateOf((await call<ConsentState>('GET', '/consent')).accepted ?? {}));
    } catch {
      /* eski çekirdek / çekirdek kapalı: yerel kopya */
    }
  }
  return set(stateOf(readLocal()));
}

/** accept: bu onayları güncel sürümle kaydet; ai: açık rıza ver (true) / geri çek (false) */
export async function saveConsent(body: { accept?: ConsentKey[]; ai?: boolean }): Promise<ConsentState> {
  if (!USE_STATIC) {
    try {
      return set(stateOf((await call<ConsentState>('POST', '/consent', body)).accepted ?? {}));
    } catch {
      /* yerelde sürdür */
    }
  }
  const r = { ...readLocal() };
  const now = Date.now();
  for (const k of body.accept ?? []) r[k] = { v: CONSENT_VERSIONS[k], at: now };
  if (body.ai === true || body.accept?.includes('ai')) {
    r.ai = { v: CONSENT_VERSIONS.ai, at: now };
    delete r.aiRevokedAt;
  } else if (body.ai === false && r.ai) {
    delete r.ai;
    r.aiRevokedAt = now;
  }
  return set(stateOf(r));
}

export function useConsent(): ConsentState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    getConsent,
    getConsent,
  );
}

// ---------- AI açık rızası kapısı ----------
type Ask = (resolve: (ok: boolean) => void) => void;
let asker: Ask | null = null;
/** AiConsentHost (Consent.tsx) kendini kaydeder */
export function registerAiConsentAsker(fn: Ask | null): void {
  asker = fn;
}

/**
 * Bulut AI çağrısından (taslak, özet, soru taslağı, anahtar kaydı) önce: açık rıza güncelse hemen true; değilse onay penceresi
 * açılır, kullanıcının cevabını döndürür. Statik demoda model çağrısı/aktarım yok → her zaman true.
 */
export async function requireAiConsent(): Promise<boolean> {
  if (USE_STATIC) return true;
  if (getConsent().ai) return true;
  if ((await loadConsent()).ai) return true;
  if (!asker) return false;
  const ask = asker;
  return new Promise<boolean>((resolve) => ask(resolve));
}
