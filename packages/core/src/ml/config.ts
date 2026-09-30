import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * Yerel ML (cihazda çalışan modeller): sesli mesajı yazıya dökme (Whisper), anlamsal arama (çok dilli gömme).
 * Her şey kullanıcının Ayarlar → Yerel AI modelleri'nden açıkça indirmesiyle gelir; hiçbiri pakette değildir.
 *   ~/.mivelo/models/<org>/<model>/…   Hugging Face'ten inen model dosyaları (transformers.js yerel düzeni)
 *   ~/.mivelo/ml/runtime/<sürüm>/      çalışma zamanı (transformers.js + onnxruntime-web wasm; npm kayıt defterinden, bütünlük denetimli)
 *   ~/.mivelo/ml.json                  ayarlar
 */
export const MODELS_DIR = process.env.MIVELO_MODELS_DIR ?? path.join(DATA_DIR, 'models');
export const ML_DIR = path.join(DATA_DIR, 'ml');
export const RUNTIME_ROOT = path.join(ML_DIR, 'runtime');
const SETTINGS_FILE = path.join(DATA_DIR, 'ml.json');

export type ModelKey = 'whisper' | 'embed';
export const MODEL_KEYS: ModelKey[] = ['whisper', 'embed'];

export interface ModelSpec {
  key: ModelKey;
  /** Hugging Face depo kimliği */
  id: string;
  title: string;
  /** Arayüzde onay metni için yaklaşık boyut (MB); gerçek boyut indirme başında dosya listesinden */
  approxMb: number;
  /** Depodaki hangi dosyalar gerekir (kök .json'lar + nicemlenmiş onnx) */
  onnx: string[];
  /** Gömme boyutu (yalnız embed) */
  dim?: number;
}

/**
 * Model seçimi (boyut/kalite):
 * - Whisper small (çok dilli, q8 ≈ 250 MB): Türkçe'de base/tiny'den belirgin iyi (FLEURS tr WER ≈ %20 vs ≈ %35+); medium/large
 *   masaüstünde wasm ile çok yavaş. Sesli mesajlar kısa: small yeterli hızda.
 * - multilingual-e5-small (q8 ≈ 120 MB, 384 boyut): 100 dilde erişim (retrieval) için eğitilmiş; paraphrase-MiniLM'den aramada iyi.
 *   "query: " / "passage: " önekleri şart.
 * Yerel çeviri modeli (NLLB-200, ≈900 MB) 30.09'da KALDIRILDI (Kaan): ağır ve yavaştı; çeviri Google Cloud Translation ya da Claude.
 */
export const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
  whisper: { key: 'whisper', id: 'Xenova/whisper-small', title: 'Konuşma tanıma (Whisper small)', approxMb: 250, onnx: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'] },
  embed: { key: 'embed', id: 'Xenova/multilingual-e5-small', title: 'Anlamsal arama (multilingual-e5-small)', approxMb: 135, onnx: ['onnx/model_quantized.onnx'], dim: 384 },
};

export function modelDir(key: ModelKey): string {
  return path.join(MODELS_DIR, ...MODEL_SPECS[key].id.split('/'));
}

export interface MlSettings {
  /** Yeni gelen sesli mesajlar arka planda kendiliğinden yazıya dökülür */
  autoTranscribe: boolean;
  /** Mesajlar arka planda anlamsal arama için dizinlenir */
  semanticIndex: boolean;
  /** Çeviri hedef dili (arayüz dili) */
  translateTarget: string;
}

const DEFAULTS: MlSettings = { autoTranscribe: false, semanticIndex: false, translateTarget: 'tr' };
let cached: MlSettings | undefined;

export function mlSettings(): MlSettings {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<MlSettings>;
    cached = { ...DEFAULTS, ...pick(raw) };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

function pick(x: Partial<MlSettings>): Partial<MlSettings> {
  const out: Partial<MlSettings> = {};
  if (typeof x.autoTranscribe === 'boolean') out.autoTranscribe = x.autoTranscribe;
  if (typeof x.semanticIndex === 'boolean') out.semanticIndex = x.semanticIndex;
  if (typeof x.translateTarget === 'string' && /^[a-z]{2}$/.test(x.translateTarget)) out.translateTarget = x.translateTarget;
  return out;
}

export function saveMlSettings(patch: Partial<MlSettings>): MlSettings {
  cached = { ...mlSettings(), ...pick(patch) };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch {
    /* yazılamadı: bellekte kalır */
  }
  return cached;
}

/** Testler için */
export function resetMlSettingsCache(): void {
  cached = undefined;
}

/** Arayüze anlaşılır Türkçe hata (durum kodu HTTP'ye çevrilir) */
export class MlError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
