import { getSecret, setSecret } from '../secrets.js';
import { MlError } from './config.js';

/**
 * Google Cloud Translation (resmi API, v2 "Basic"). Kullanıcının KENDİ anahtarıyla (Google Cloud Console → Cloud Translation API
 * etkin + API anahtarı; ayda 500 bin karaktere kadar ücretsiz, faturalandırma hesabı Google'da açık olmalı). Anahtar Mivelo'nun
 * gizli deposunda (Anahtar Zinciri / DPAPI / 0600 dosya) durur, arayüze yalnız maskesi döner. Resmi olmayan anahtarsız
 * translate.googleapis.com ("gtx") adresi KULLANILMAZ: kullanım koşullarına aykırı, her an engellenebilir.
 * Yalnız kullanıcı "Çevir" dediğinde / otomatik çeviriyi açtığında o metin Google'a gider.
 */
const SECRET = 'google-translate';
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

let cache: { v: string | null } | undefined;

export function googleKey(): string | null {
  if (!cache) cache = { v: getSecret(SECRET) };
  return cache.v;
}

export function googleKeyInfo(): { set: boolean; hint: string | null } {
  const k = googleKey();
  return { set: !!k, hint: k ? `…${k.slice(-4)}` : null };
}

/** Anahtarı kaydet (null → sil). Biçim: Google API anahtarları "AIza" ile başlar, 39 karakter. */
export function setGoogleKey(key: string | null): void {
  const k = key?.trim() || null;
  if (k && !/^AIza[0-9A-Za-z_-]{30,60}$/.test(k)) throw new MlError(400, 'Geçersiz Google API anahtarı (AIza… ile başlamalı)');
  setSecret(SECRET, k);
  cache = { v: k };
}

/** Testler için */
export function resetGoogleKeyCache(v?: string | null): void {
  cache = v === undefined ? undefined : { v };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? _);

type Fetch = typeof fetch;

export async function viaGoogle(texts: string[], target: string, source?: string | null, f: Fetch = fetch): Promise<{ texts: string[]; source: string | null }> {
  const key = googleKey();
  if (!key) throw new MlError(409, 'Google çeviri anahtarı yok (Ayarlar → Yerel AI modelleri → Çeviri)');
  const body: Record<string, unknown> = { q: texts, target, format: 'text' };
  if (source) body.source = source;
  let res: Response;
  try {
    res = await f(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MlError(503, 'Çeviri yapılamadı: internet bağlantısını kontrol et');
  }
  const j = (await res.json().catch(() => null)) as {
    data?: { translations?: Array<{ translatedText?: string; detectedSourceLanguage?: string }> };
    error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> };
  } | null;
  if (!res.ok) {
    const reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? '';
    if (res.status === 400 && /key/i.test(`${reason} ${j?.error?.message ?? ''}`)) throw new MlError(400, 'Google API anahtarı geçersiz');
    if (res.status === 403)
      throw new MlError(
        400,
        /billing/i.test(`${reason} ${j?.error?.message ?? ''}`)
          ? 'Google Cloud projesinde faturalandırma açık değil (ücretsiz kota için de gerekli)'
          : 'Google Cloud Translation API bu anahtarın projesinde etkin değil ya da anahtar kısıtlı',
      );
    if (res.status === 429) throw new MlError(429, 'Google çeviri kotası/hız sınırı aşıldı; biraz sonra yeniden dene');
    throw new MlError(502, `Google çeviri yapılamadı (${res.status})`);
  }
  const tr = j?.data?.translations ?? [];
  if (tr.length !== texts.length) throw new MlError(502, 'Google çeviri yanıtı okunamadı');
  const detected = tr.find((t) => t.detectedSourceLanguage)?.detectedSourceLanguage;
  return { texts: tr.map((t) => unescape(String(t.translatedText ?? ''))), source: (source ?? detected ?? null)?.slice(0, 2).toLowerCase() ?? null };
}
