import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { bus } from '../bus.js';
import { MODEL_KEYS, MODEL_SPECS, MlError, RUNTIME_ROOT, modelDir, type ModelKey } from './config.js';
import { TarExtract } from './tar.js';

/**
 * Model ve çalışma zamanı indirmeleri: ilk açılışta arka planda kendiliğinden (auto-install.ts) ya da Ayarlar'da "İndir" ile.
 *
 * Çalışma zamanı neden pakette değil / neden onnxruntime-node değil:
 *  - onnxruntime-node 1.30 npm paketi 113 MB (sıkıştırılmış) ve tüm platform ikililerini birden taşıyor; darwin-x64 (Intel Mac
 *    paketi: x64 Node + Rosetta) ikilisi HİÇ yok → mac-intel DMG'de çalışmazdı. Ayrıca @huggingface/transformers, sharp'ı
 *    (libvips yerel ikilileri) zorunlu bağımlılık olarak çeker.
 *  - Bunun yerine onnxruntime-web'in Node yapısı (ort.node.min.mjs + tek wasm, SIMD + worker_threads ile çok iş parçacıklı)
 *    kullanılır: üç platformda aynı, yerel ikili yok, imza/karantina sorunu yok. transformers.js'in Node yapısı
 *    `globalThis[Symbol.for('onnxruntime')]` ile bu arka uca yönlendirilir; sharp ve onnxruntime-node için boş taslak paketler yazılır
 *    (görsel işleme ve yerel arka uç kullanılmıyor).
 *  - Dosyalar ilk kullanımda npm kayıt defterinden, sabit sürüm ve sha512 bütünlüğüyle (package-lock ile aynı) iner; yalnız
 *    gereken dosyalar açılır (≈ 36 MB indirme, ≈ 17 MB disk). DMG/EXE boyutu değişmez.
 */
const RUNTIME_VERSION = 'tfjs-4.3.0_ort-1.31.0-dev.20260914';
interface RuntimePkg {
  name: string;
  url: string;
  integrity: string;
  keep: (p: string) => boolean;
}
const RUNTIME_PKGS: RuntimePkg[] = [
  {
    name: '@huggingface/transformers',
    url: 'https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.3.0.tgz',
    integrity: 'sha512-fL1A/WUZwouPrOlYxU5dzIwD2T5J781JiB2jDR8bFe5DwCj0Gfudq+NEXCMno49kQgajHA7xQkrRLJlqG1veEA==',
    keep: (p) => ['package.json', 'LICENSE', 'dist/transformers.node.mjs'].includes(p),
  },
  {
    name: 'onnxruntime-web',
    url: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.31.0-dev.20260914-8d85527a0.tgz',
    integrity: 'sha512-Iy7rtadoBgxS/LLvDr3QW38DB1PNXRnr0GJMcL0TAt7c9qjgVQl83UlGCVyeAnK2InpmW8Uc3PL8XIuqtDeF6g==',
    keep: (p) => ['package.json', 'LICENSE', 'dist/ort.node.min.mjs', 'dist/ort-wasm-simd-threaded.mjs', 'dist/ort-wasm-simd-threaded.wasm'].includes(p),
  },
  {
    name: 'onnxruntime-common',
    url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.31.0-dev.20260911-2a43ec07e.tgz',
    integrity: 'sha512-gBuF6U32YErKIAt+yD7DeGBpjRxhJ1uJwako6ygjokSZULDU6Pd+KWComX8Tumk1hYVHRxjPj7mdMnD0ryAPOw==',
    keep: (p) => p === 'package.json' || p === 'LICENSE' || (p.startsWith('dist/esm/') && p.endsWith('.js')),
  },
];
/** npm tarball boyutları toplamı (ilerleme yüzdesi için; tam değer indirme başlığından) */
const RUNTIME_APPROX_BYTES = 36 * 1024 * 1024;
export const RUNTIME_APPROX_MB = 36;

export const runtimeDir = () => path.join(RUNTIME_ROOT, RUNTIME_VERSION);
const RUNTIME_MARK = () => path.join(runtimeDir(), '.mivelo-complete');
const MODEL_MARK = (key: ModelKey) => path.join(modelDir(key), '.mivelo-complete.json');

export function runtimeReady(): boolean {
  return fs.existsSync(RUNTIME_MARK());
}

export function modelReady(key: ModelKey): boolean {
  return fs.existsSync(MODEL_MARK(key));
}

export type ModelState = 'absent' | 'downloading' | 'ready' | 'error';
export interface ModelStatus {
  key: ModelKey;
  id: string;
  title: string;
  state: ModelState;
  /** 0-100 (yalnız indirilirken) */
  pct: number;
  /** Diskteki boyut (hazırsa) ya da yaklaşık boyut (MB) */
  sizeMb: number;
  approx: boolean;
  error?: string;
}

interface Job {
  abort: AbortController;
  done: number;
  total: number;
  /** İş bitince çözülür; hata (MlError) ile reddedilir */
  promise?: Promise<void>;
}
const jobs = new Map<ModelKey, Job>();
const errors = new Map<ModelKey, string>();
let runtimeJob: Promise<void> | null = null;

export function modelStatus(key: ModelKey): ModelStatus {
  const spec = MODEL_SPECS[key];
  const job = jobs.get(key);
  const ready = modelReady(key);
  let sizeMb = spec.approxMb;
  let approx = true;
  if (ready) {
    try {
      const m = JSON.parse(fs.readFileSync(MODEL_MARK(key), 'utf8')) as { bytes?: number };
      if (m.bytes) (sizeMb = Math.round(m.bytes / 1048576)), (approx = false);
    } catch {
      /* eski işaret */
    }
  }
  return {
    key,
    id: spec.id,
    title: spec.title,
    state: job ? 'downloading' : ready ? 'ready' : errors.has(key) ? 'error' : 'absent',
    pct: job ? Math.min(99, Math.floor((job.done / Math.max(job.total, 1)) * 100)) : ready ? 100 : 0,
    sizeMb,
    approx,
    error: errors.get(key),
  };
}

export function allModelStatus(): ModelStatus[] {
  return MODEL_KEYS.map(modelStatus);
}

// ilerleme olayları seyreltilir (en çok ~3/sn)
let emitTimer: NodeJS.Timeout | undefined;
export function emitMlStatus(now = false): void {
  if (now) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = undefined;
    bus.emit({ type: 'ml.status' });
    return;
  }
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = undefined;
    bus.emit({ type: 'ml.status' });
  }, 350);
}

/** Ağ hatasını anlaşılır Türkçe'ye çevir (ayrıntı günlüğe) */
function netError(e: unknown, what: string): MlError {
  const err = e as Error & { cause?: { code?: string } };
  if (err.name === 'AbortError') return new MlError(499, 'İndirme iptal edildi');
  if (err instanceof MlError) return err;
  const code = err.cause?.code ?? '';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR/.test(code) || /fetch failed/i.test(err.message))
    return new MlError(503, `${what} indirilemedi: internet bağlantısı yok ya da sunucuya ulaşılamıyor. Bağlantını kontrol edip yeniden dene.`);
  if (/ENOSPC/.test(String((e as NodeJS.ErrnoException).code ?? err.message))) return new MlError(507, `${what} kaydedilemedi: diskte yer kalmadı.`);
  return new MlError(502, `${what} indirilemedi: ${err.message.split('\n')[0].slice(0, 160)}`);
}

/** Çalışma zamanını (transformers.js + onnxruntime-web) indir; varsa hemen döner. onBytes: indirilen sıkıştırılmış bayt */
export async function ensureRuntime(signal?: AbortSignal, onBytes?: (n: number) => void): Promise<string> {
  if (runtimeReady()) return runtimeDir();
  runtimeJob ??= installRuntime(signal, onBytes).finally(() => (runtimeJob = null));
  await runtimeJob;
  return runtimeDir();
}

async function installRuntime(signal?: AbortSignal, onBytes?: (n: number) => void): Promise<void> {
  const final = runtimeDir();
  const tmp = `${final}.tmp-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(tmp, { recursive: true });
  bus.log('info', 'Yerel AI: çalışma zamanı indiriliyor (bir kez, ≈36 MB)');
  try {
    for (const pkg of RUNTIME_PKGS) {
      const nm = path.join(tmp, 'node_modules', ...pkg.name.split('/'));
      const res = await fetch(pkg.url, { signal }).catch((e: unknown) => {
        throw netError(e, 'Yerel AI çalışma zamanı');
      });
      if (!res.ok || !res.body) throw new MlError(502, `Yerel AI çalışma zamanı indirilemedi (HTTP ${res.status})`);
      const [algo, expected] = pkg.integrity.split('-');
      const hash = createHash(algo);
      const tap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          hash.update(chunk);
          onBytes?.(chunk.length);
          cb(null, chunk);
        },
      });
      const tar = new TarExtract(nm, (name) => {
        const rel = name.startsWith('package/') ? name.slice('package/'.length) : undefined;
        return rel && pkg.keep(rel) ? rel : undefined;
      });
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), tap, createGunzip(), tar, { signal }).catch((e: unknown) => {
        throw netError(e, 'Yerel AI çalışma zamanı');
      });
      if (hash.digest('base64') !== expected) throw new MlError(502, `Yerel AI çalışma zamanı bozuk indi (${pkg.name} bütünlük denetimi tutmadı); yeniden dene.`);
    }
    // Kullanılmayan yerel bağımlılıklar için taslaklar: transformers.js Node yapısı bunları yükleme anında ister
    const stub = (name: string, files: Record<string, string>) => {
      const dir = path.join(tmp, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    };
    stub('sharp', {
      'package.json': JSON.stringify({ name: 'sharp', version: '0.0.0-mivelo', type: 'module', main: 'index.js' }),
      'index.js': "export default function sharp() { throw new Error('Mivelo: görsel işleme yok'); }\n",
    });
    stub('onnxruntime-node', {
      'package.json': JSON.stringify({ name: 'onnxruntime-node', version: '0.0.0-mivelo', main: 'index.cjs' }),
      'index.cjs': '// Mivelo: yerel arka uç yok; onnxruntime-web (wasm) kullanılır\nmodule.exports = {};\n',
    });
    fs.writeFileSync(path.join(tmp, '.mivelo-complete'), new Date().toISOString());
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    // eski sürüm klasörleri
    for (const d of fs.readdirSync(RUNTIME_ROOT)) if (d !== RUNTIME_VERSION) fs.rmSync(path.join(RUNTIME_ROOT, d), { recursive: true, force: true });
    bus.log('info', 'Yerel AI: çalışma zamanı hazır');
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

interface HfEntry {
  type?: string;
  path?: string;
  rfilename?: string;
  size?: number;
  lfs?: { oid?: string; sha256?: string; size?: number };
}

const HF = 'https://huggingface.co';

/** Depodaki dosya listesi (boyut + LFS sha256): önce ağaç API'si, olmazsa model bilgisi */
async function listRepo(id: string, signal: AbortSignal): Promise<Array<{ path: string; size: number; sha256?: string }>> {
  const norm = (e: HfEntry) => ({ path: e.path ?? e.rfilename ?? '', size: e.lfs?.size ?? e.size ?? 0, sha256: e.lfs?.sha256 ?? e.lfs?.oid });
  const tree = await fetch(`${HF}/api/models/${id}/tree/main?recursive=true`, { signal });
  if (tree.ok) {
    const list = (await tree.json()) as HfEntry[];
    if (Array.isArray(list)) return list.filter((e) => e.type !== 'directory').map(norm);
  }
  const info = await fetch(`${HF}/api/models/${id}?blobs=true`, { signal });
  if (!info.ok) throw new MlError(502, `Model bilgisi alınamadı (HTTP ${info.status})`);
  const j = (await info.json()) as { siblings?: HfEntry[] };
  return (j.siblings ?? []).map(norm);
}

/** Modeli (gerekirse önce çalışma zamanını) indir. Arka planda sürer; ilerleme ml.status olayıyla. */
export function startDownload(key: ModelKey): ModelStatus {
  if (jobs.has(key) || modelReady(key)) return modelStatus(key);
  errors.delete(key);
  const job: Job = { abort: new AbortController(), done: 0, total: MODEL_SPECS[key].approxMb * 1048576 + (runtimeReady() ? 0 : RUNTIME_APPROX_BYTES) };
  jobs.set(key, job);
  emitMlStatus(true);
  job.promise = downloadModel(key, job)
    .then(() => bus.log('info', `Yerel AI: ${MODEL_SPECS[key].title} hazır`))
    .catch((e: unknown) => {
      const err = e instanceof MlError ? e : netError(e, MODEL_SPECS[key].title);
      if (err.status !== 499) {
        errors.set(key, err.message);
        bus.log('warn', `Yerel AI: ${MODEL_SPECS[key].title} indirilemedi — ${err.message}`);
      }
      throw err;
    })
    .finally(() => {
      jobs.delete(key);
      emitMlStatus(true);
    });
  job.promise.catch(() => undefined); // dinleyen yoksa işlenmemiş ret sayılmasın
  return modelStatus(key);
}

/** Modeli indirip bitmesini bekler (sürmekte olan indirmeye katılır); hata MlError (499 = iptal) */
export async function installModel(key: ModelKey): Promise<void> {
  if (modelReady(key)) return;
  startDownload(key);
  await jobs.get(key)?.promise;
}

export function cancelDownload(key: ModelKey): void {
  jobs.get(key)?.abort.abort();
}

export function removeModel(key: ModelKey): void {
  cancelDownload(key);
  errors.delete(key);
  fs.rmSync(modelDir(key), { recursive: true, force: true });
  emitMlStatus(true);
}

async function downloadModel(key: ModelKey, job: Job): Promise<void> {
  const spec = MODEL_SPECS[key];
  const signal = job.abort.signal;
  await ensureRuntime(signal, (n) => {
    job.done += n;
    emitMlStatus();
  });
  const files = await listRepo(spec.id, signal).catch((e: unknown) => {
    throw netError(e, spec.title);
  });
  const want = files.filter((f) => (!f.path.includes('/') && f.path.endsWith('.json')) || spec.onnx.some((o) => f.path === o || f.path.startsWith(`${o}_data`)));
  const missing = spec.onnx.filter((o) => !want.some((f) => f.path === o));
  if (missing.length) throw new MlError(502, `${spec.title}: model deposunda beklenen dosya yok (${missing.join(', ')})`);
  const total = want.reduce((s, f) => s + f.size, 0);
  job.total = job.done + total;
  emitMlStatus();
  const dir = modelDir(key);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of want) {
    const target = path.join(dir, ...f.path.split('/'));
    // önceki yarım indirmeden kalan, boyutu tutan dosya yeniden inmez (sha256 varsa yine doğrulanır)
    if (fs.existsSync(target) && fs.statSync(target).size === f.size && f.size > 0) {
      job.done += f.size;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    const res = await fetch(`${HF}/${spec.id}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`, { signal }).catch((e: unknown) => {
      throw netError(e, spec.title);
    });
    if (!res.ok || !res.body) throw new MlError(502, `${spec.title} indirilemedi (${f.path}: HTTP ${res.status})`);
    const hash = createHash('sha256');
    let got = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        hash.update(chunk);
        got += chunk.length;
        job.done += chunk.length;
        emitMlStatus();
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), tap, fs.createWriteStream(part), { signal }).catch((e: unknown) => {
      fs.rmSync(part, { force: true });
      throw netError(e, spec.title);
    });
    if ((f.size && got !== f.size) || (f.sha256 && /^[0-9a-f]{64}$/.test(f.sha256) && hash.digest('hex') !== f.sha256)) {
      fs.rmSync(part, { force: true });
      throw new MlError(502, `${spec.title}: ${path.basename(f.path)} bozuk indi (boyut/özet tutmadı); yeniden dene.`);
    }
    fs.renameSync(part, target);
  }
  fs.writeFileSync(MODEL_MARK(key), JSON.stringify({ id: spec.id, files: want.map((f) => f.path), bytes: total, at: new Date().toISOString() }));
}
