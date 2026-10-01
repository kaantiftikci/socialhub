import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Yasal onaylar (01.10): Kullanım Koşulları + EULA kabulü, KVKK Aydınlatma Metni'nin okunduğu, resmi olmayan bağlantı
 * yöntemlerinin hesap kısıtlaması riskinin anlaşıldığı (üçü zorunlu) ve isteğe bağlı açık rıza (AI özellikleri için içeriğin
 * Anthropic'e, yurt dışına aktarımı). Yalnız bu bilgisayarda `~/.mivelo/consent.json` (0600); sunucuya kişisel veri gitmez
 * (lisans etkinleştirmede yalnız kabul edilen koşul SÜRÜMÜ gider). Metin sürümü değişince (CONSENT_VERSIONS) yeniden sorulur.
 * "Tüm verileri sil" bu dosyaya dokunmaz (lisans gibi).
 */
export const CONSENT_VERSIONS = {
  terms: '2026-10-01',
  kvkk: '2026-10-01',
  risk: '2026-10-01',
  ai: '2026-10-01',
} as const;
export type ConsentKey = keyof typeof CONSENT_VERSIONS;
/** Uygulamayı kullanmak için zorunlu olanlar (ai isteğe bağlı açık rıza) */
export const REQUIRED_CONSENTS: ConsentKey[] = ['terms', 'kvkk', 'risk'];

export interface ConsentEntry {
  /** Kabul edilen metin sürümü */
  v: string;
  /** Kabul zamanı (ms) */
  at: number;
}
export interface ConsentRecord {
  terms?: ConsentEntry;
  kvkk?: ConsentEntry;
  risk?: ConsentEntry;
  ai?: ConsentEntry;
  /** Açık rıza geri çekildiyse zamanı (ms) */
  aiRevokedAt?: number;
}
export interface ConsentState {
  versions: typeof CONSENT_VERSIONS;
  accepted: ConsentRecord;
  /** Eksik ya da sürümü eskimiş zorunlu onaylar (boşsa uygulama açılır) */
  needed: ConsentKey[];
  /** AI açık rızası güncel sürümle verilmiş mi */
  ai: boolean;
}

export class ConsentError extends Error {}

export const CONSENT_FILE = () => path.join(DATA_DIR, 'consent.json');

const isEntry = (v: unknown): v is ConsentEntry =>
  !!v && typeof v === 'object' && typeof (v as ConsentEntry).v === 'string' && Number.isFinite((v as ConsentEntry).at);

export function readConsent(): ConsentRecord {
  try {
    const raw = JSON.parse(fs.readFileSync(CONSENT_FILE(), 'utf8')) as Record<string, unknown>;
    const out: ConsentRecord = {};
    for (const k of Object.keys(CONSENT_VERSIONS) as ConsentKey[]) if (isEntry(raw[k])) out[k] = { v: String(raw[k].v).slice(0, 20), at: Number(raw[k].at) };
    if (Number.isFinite(raw.aiRevokedAt)) out.aiRevokedAt = Number(raw.aiRevokedAt);
    return out;
  } catch {
    return {};
  }
}

function writeConsent(r: ConsentRecord): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = CONSENT_FILE();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

const current = (r: ConsentRecord, k: ConsentKey) => r[k]?.v === CONSENT_VERSIONS[k];

export function consentState(r: ConsentRecord = readConsent()): ConsentState {
  return { versions: CONSENT_VERSIONS, accepted: r, needed: REQUIRED_CONSENTS.filter((k) => !current(r, k)), ai: current(r, 'ai') };
}

/** Kabul edilen Kullanım Koşulları sürümü (lisans sunucusuna yalnız bu gider); güncel kabul yoksa '' */
export function acceptedTermsVersion(): string {
  const r = readConsent();
  return current(r, 'terms') ? CONSENT_VERSIONS.terms : '';
}

/**
 * POST /api/consent: {accept?: ConsentKey[], ai?: boolean}. accept'teki her onay güncel sürümle kaydedilir; ai true = açık rıza
 * verildi, false = geri çekildi (zamanı tutulur). Zorunlu onaylar arayüzden geri alınamaz (uygulamayı kullanmamak = geri almak).
 */
export function saveConsent(input: unknown, now = Date.now()): ConsentState {
  if (!input || typeof input !== 'object') throw new ConsentError('Geçersiz istek');
  const b = input as { accept?: unknown; ai?: unknown };
  const r = readConsent();
  if (b.accept !== undefined) {
    if (!Array.isArray(b.accept) || b.accept.length > 4) throw new ConsentError('Geçersiz onay listesi');
    for (const k of b.accept) {
      if (typeof k !== 'string' || !(k in CONSENT_VERSIONS)) throw new ConsentError('Bilinmeyen onay');
      r[k as ConsentKey] = { v: CONSENT_VERSIONS[k as ConsentKey], at: now };
      if (k === 'ai') delete r.aiRevokedAt;
    }
  }
  if (b.ai !== undefined) {
    if (typeof b.ai !== 'boolean') throw new ConsentError('Geçersiz açık rıza değeri');
    if (b.ai) {
      r.ai = { v: CONSENT_VERSIONS.ai, at: now };
      delete r.aiRevokedAt;
    } else if (r.ai) {
      delete r.ai;
      r.aiRevokedAt = now;
    }
  }
  writeConsent(r);
  return consentState(r);
}
