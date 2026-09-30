import type { Store } from '../store.js';
import { mlSettings, MlError } from './config.js';
import { detectLanguage, dominantLanguage } from './lang.js';
import { getTranslation, saveTranslation } from './ml-store.js';
import { googleKey, viaGoogle } from './google-translate.js';

/**
 * Anlık çeviri: YALNIZ kullanıcının Google Cloud Translation anahtarıyla (resmi, ayda 500 bin karakter ücretsiz). Yerel model (NLLB)
 * ve Claude ile çeviri 30.09'da kaldırıldı (Kaan). Mesaj çevirileri `translations` tablosunda
 * önbelleklenir (aynı mesaj ikinci kez servise gitmez; mesaj düzenlenince tetikleyici siler).
 */

/** Desteklenen hedef diller (ISO 639-1) */
export const TARGET_LANGS = new Set(['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ro', 'sv', 'az', 'id', 'ru', 'uk', 'bg', 'el', 'ar', 'fa', 'he', 'zh', 'ja', 'ko', 'hi', 'th', 'ka', 'hy']);

export type Engine = 'google';

export function translationEngine(): Engine | null {
  return googleKey() ? 'google' : null;
}

function requireEngine(): Engine {
  const e = translationEngine();
  if (e) return e;
  throw new MlError(409, "Çeviri için Ayarlar → Yerel AI modelleri → Google çeviri'den anahtar ekle");
}

export async function translateTexts(texts: string[], target: string, opts: { source?: string | null } = {}): Promise<{ texts: string[]; source: string | null; engine: Engine }> {
  if (!TARGET_LANGS.has(target)) throw new MlError(400, 'Desteklenmeyen hedef dil');
  const engine = requireEngine();
  const r = await viaGoogle(texts, target, opts.source);
  return { ...r, engine };
}

export interface MessageTranslation {
  messageId: string;
  lang: string;
  /** Mesajın algılanan dili */
  source: string | null;
  text: string;
  /** Mesaj zaten hedef dilde: çeviri gerekmedi */
  same?: boolean;
  engine?: Engine;
  cached?: boolean;
}

/** Mesajı çevir (önbellekli). Mesaj zaten hedef dildeyse `same: true` (model çağrılmaz). */
export async function translateMessage(store: Store, messageId: string, target = mlSettings().translateTarget, opts: { force?: boolean } = {}): Promise<MessageTranslation> {
  const m = store.getMessage(messageId);
  if (!m) throw new MlError(404, 'Mesaj bulunamadı');
  const text = m.text.trim();
  if (!text) throw new MlError(400, 'Çevrilecek metin yok');
  const cached = getTranslation(store, messageId, target);
  if (cached) return { messageId, lang: target, source: cached.src, text: cached.text, engine: (cached.engine as Engine) ?? undefined, cached: true };
  const guess = detectLanguage(text);
  if (!opts.force && guess.lang === target) return { messageId, lang: target, source: guess.lang, text, same: true };
  const r = await translateTexts([text], target, { source: guess.lang });
  const out = r.texts[0] ?? '';
  saveTranslation(store, messageId, target, r.source, out, r.engine);
  return { messageId, lang: target, source: r.source, text: out, engine: r.engine };
}

/** Sohbette karşı tarafın dili (son gelen mesajlardan) — "Çevir ve gönder" hedefi */
export function chatLanguage(store: Store, chatId: string): { lang: string | null; confidence: number } {
  const rows = store.mlStmt('SELECT text FROM messages WHERE chat_id = ? AND from_me = 0 AND length(text) > 3 ORDER BY ts DESC LIMIT 20').all(chatId) as Array<{ text: string }>;
  return dominantLanguage(rows.map((r) => r.text));
}
