import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_MODEL } from '../config.js';
import { aiEnabled, aiKey } from '../ai.js';
import type { Store } from '../store.js';
import { mlSettings, MlError } from './config.js';
import { isModelUsable, runMl } from './engine.js';
import { detectLanguage, dominantLanguage, LANG_NAMES } from './lang.js';
import { getTranslation, saveTranslation } from './ml-store.js';
import { googleKey, viaGoogle } from './google-translate.js';

/**
 * Anlık çeviri. Motor: kullanıcının Anthropic anahtarı varsa Claude (hızlı, bağlamı ve üslubu koruyan), yoksa ya da
 * "yalnız yerel" seçiliyse cihazdaki NLLB-200. Mesaj çevirileri `translations` tablosunda önbelleklenir (aynı mesaj ikinci kez
 * modele gitmez; mesaj düzenlenince tetikleyici siler).
 */

/** ISO 639-1 → NLLB-200 (FLORES) kodu */
export const NLLB_CODES: Record<string, string> = {
  tr: 'tur_Latn', en: 'eng_Latn', de: 'deu_Latn', fr: 'fra_Latn', es: 'spa_Latn', it: 'ita_Latn', pt: 'por_Latn', nl: 'nld_Latn', pl: 'pol_Latn',
  ro: 'ron_Latn', sv: 'swe_Latn', az: 'azj_Latn', id: 'ind_Latn', ru: 'rus_Cyrl', uk: 'ukr_Cyrl', bg: 'bul_Cyrl', el: 'ell_Grek', ar: 'arb_Arab',
  fa: 'pes_Arab', he: 'heb_Hebr', zh: 'zho_Hans', ja: 'jpn_Jpan', ko: 'kor_Hang', hi: 'hin_Deva', th: 'tha_Thai', ka: 'kat_Geor', hy: 'hye_Armn',
};

export type Engine = 'google' | 'claude' | 'local';

export function translationEngine(): Engine | null {
  const s = mlSettings();
  // öncelik: kullanıcının Google Cloud Translation anahtarı (resmi, ayda 500 bin karakter ücretsiz) → Claude → yerel model
  if (googleKey() && !s.localOnlyTranslate) return 'google';
  if (aiEnabled() && !s.localOnlyTranslate) return 'claude';
  if (isModelUsable('translate')) return 'local';
  return null;
}

function requireEngine(): Engine {
  const e = translationEngine();
  if (e) return e;
  throw new MlError(
    409,
    mlSettings().localOnlyTranslate
      ? 'Yerel çeviri için önce modeli indir: Ayarlar → Yerel AI modelleri → Yerel çeviri'
      : "Çeviri için Ayarlar → Yerel AI modelleri → Çeviri'den Google çeviri anahtarı ekle (ya da Anthropic anahtarı / yerel model)",
  );
}

let client: { key: string; c: Anthropic } | undefined;
function claude(): Anthropic {
  const key = aiKey();
  if (!client || client.key !== key) client = { key, c: new Anthropic({ apiKey: key }) };
  return client.c;
}

const SCHEMA = {
  type: 'object',
  properties: {
    source_lang: { type: 'string' },
    translations: { type: 'array', items: { type: 'string' } },
  },
  required: ['source_lang', 'translations'],
  additionalProperties: false,
} as const;

const SYSTEM = `Sen bir mesajlaşma çevirmenisin. Verilen her metni hedef dile çevir.
Anlamı, tonu ve hitabı (sen/siz, resmî/samimi) koru; emoji, bağlantı, sayı, sipariş numarası, ürün adı ve özel adları olduğu gibi bırak.
Açıklama, not ya da tırnak ekleme; yalnız çeviriyi yaz. Metin zaten hedef dildeyse aynen döndür.
translations: girdilerle aynı sayıda ve aynı sırada. source_lang: girdilerin baskın dilinin ISO 639-1 kodu (ör. "en").`;

async function viaClaude(texts: string[], target: string, source?: string | null): Promise<{ texts: string[]; source: string | null }> {
  const input = texts.map((t, i) => `<metin no="${i + 1}">\n${t}\n</metin>`).join('\n');
  const res = await claude()
    .messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `Hedef dil: ${LANG_NAMES[target] ?? target} (${target}).${source ? ` Kaynak dil: ${LANG_NAMES[source] ?? source} (${source}).` : ''}\n\n${input}` }],
    })
    .catch((e: unknown) => {
      if (e instanceof Anthropic.APIError) {
        const st = e.status;
        if (st === 401 || st === 403) throw new MlError(400, 'Anthropic API anahtarı geçersiz ya da yetkisiz (Ayarlar → AI özellikleri)');
        if (st === 429) throw new MlError(429, 'Anthropic hız/kota sınırı aşıldı; biraz sonra yeniden dene');
        if (st === 529 || st === 503) throw new MlError(503, 'Anthropic şu an yoğun; biraz sonra yeniden dene');
        throw new MlError(502, `Çeviri yapılamadı${st ? ` (${st})` : ''}`);
      }
      throw new MlError(503, 'Çeviri yapılamadı: internet bağlantısını kontrol et');
    });
  if (res.stop_reason === 'refusal') throw new MlError(422, 'AI bu metni çevirmeyi reddetti');
  const raw = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    const j = JSON.parse(raw) as { source_lang?: string; translations?: string[] };
    const out = (j.translations ?? []).map((t) => String(t));
    if (out.length !== texts.length) throw new Error('sayı tutmadı');
    return { texts: out, source: (j.source_lang ?? source ?? null)?.slice(0, 2).toLowerCase() ?? null };
  } catch {
    if (texts.length === 1 && raw.trim()) return { texts: [raw.trim()], source: source ?? null };
    throw new MlError(502, 'Çeviri yanıtı okunamadı; yeniden dene');
  }
}

async function viaLocal(texts: string[], target: string, source: string | null, interactive: boolean): Promise<{ texts: string[]; source: string | null }> {
  const src = source ?? dominantLanguage(texts).lang;
  const s = src ? NLLB_CODES[src] : undefined;
  const t = NLLB_CODES[target];
  if (!s) throw new MlError(422, src ? `Yerel model bu dili çeviremiyor (${LANG_NAMES[src] ?? src})` : 'Metnin dili algılanamadı');
  if (!t) throw new MlError(422, `Yerel model bu dile çeviremiyor (${LANG_NAMES[target] ?? target})`);
  const out = await runMl((b) => b.translate(texts, s, t), interactive ? 'interactive' : 'background');
  return { texts: out, source: src };
}

export async function translateTexts(texts: string[], target: string, opts: { source?: string | null; interactive?: boolean } = {}): Promise<{ texts: string[]; source: string | null; engine: Engine }> {
  if (!NLLB_CODES[target]) throw new MlError(400, 'Desteklenmeyen hedef dil');
  const engine = requireEngine();
  const r = engine === 'google' ? await viaGoogle(texts, target, opts.source) : engine === 'claude' ? await viaClaude(texts, target, opts.source) : await viaLocal(texts, target, opts.source ?? null, opts.interactive ?? true);
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
