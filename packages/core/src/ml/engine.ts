import { Worker } from 'node:worker_threads';
import { bus } from '../bus.js';
import { MODELS_DIR, MODEL_SPECS, MlError, type ModelKey } from './config.js';
import { modelReady, runtimeDir, runtimeReady } from './models.js';
import { JobQueue, type Priority } from './queue.js';

/**
 * Model çıkarımı için soyut arka uç: gerçekte worker_thread (worker.ts), testlerde sahte (setMlBackend).
 * Tüm çağrılar tek kuyruktan geçer (eşzamanlılık 1). İşçi tembel açılır; 3 dk boş kalınca kapatılır → modeller bellekten çıkar.
 */
export interface MlBackend {
  transcribe(audio: Uint8Array, language: string | null): Promise<{ text: string; lang: string | null; seconds?: number }>;
  /** Birim uzunlukta gömmeler (önekler çağıranda eklenir: "query: " / "passage: ") */
  embed(texts: string[]): Promise<Float32Array[]>;
  translate(texts: string[], src: string, tgt: string): Promise<string[]>;
  dispose?(): void;
}

const IDLE_MS = 3 * 60_000;

class WorkerBackend implements MlBackend {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private idle: NodeJS.Timeout | undefined;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    // tsx ile (geliştirme/test) kaynak .ts, derlenmiş pakette .js
    const here = import.meta.url;
    const isTs = here.endsWith('.ts');
    const url = new URL(isTs ? './worker.ts' : './worker.js', here);
    const w = new Worker(url, { workerData: { runtimeDir: runtimeDir(), modelsDir: MODELS_DIR } });
    w.unref();
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.error !== undefined) p.reject(new MlError(500, m.error));
      else p.resolve(m.result);
      this.armIdle();
    });
    const fail = (e: Error) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const p of this.waiting.values()) p.reject(new MlError(500, `Yerel AI işçisi durdu: ${e.message}`));
      this.waiting.clear();
    };
    w.on('error', (e) => {
      bus.log('warn', `Yerel AI işçisi hata verdi: ${e.message.split('\n')[0]}`);
      fail(e);
    });
    w.on('exit', (code) => fail(new Error(`çıkış kodu ${code}`)));
    this.worker = w;
    return w;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.waiting.size) return;
    this.idle = setTimeout(() => this.dispose(), IDLE_MS);
    this.idle.unref();
  }

  private call<T>(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
    const w = this.ensure();
    if (this.idle) clearTimeout(this.idle);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  transcribe(audio: Uint8Array, language: string | null) {
    const copy = new Uint8Array(audio); // aktarılabilir kopya (Buffer havuzunu işçiye taşımayalım)
    return this.call<{ text: string; lang: string | null; seconds?: number }>({ op: 'transcribe', model: MODEL_SPECS.whisper.id, audio: copy, language }, [copy.buffer]);
  }

  async embed(texts: string[]) {
    const r = await this.call<{ data: Float32Array; dim: number }>({ op: 'embed', model: MODEL_SPECS.embed.id, texts });
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) out.push(r.data.slice(i * r.dim, (i + 1) * r.dim));
    return out;
  }

  translate(texts: string[], src: string, tgt: string) {
    return this.call<string[]>({ op: 'translate', model: MODEL_SPECS.translate.id, texts, src, tgt });
  }

  dispose(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
  }
}

let backend: MlBackend | null = null;
let mockReady: Set<ModelKey> | null = null;
export const mlQueue = new JobQueue();

/** Testler: sahte arka uç + "hazır" sayılacak modeller */
export function setMlBackend(b: MlBackend | null, ready: ModelKey[] = ['whisper', 'embed', 'translate']): void {
  backend?.dispose?.();
  backend = b;
  mockReady = b ? new Set(ready) : null;
}

export function isModelUsable(key: ModelKey): boolean {
  if (mockReady) return mockReady.has(key);
  return runtimeReady() && modelReady(key);
}

/** Model hazır değilse anlaşılır hata */
export function requireModel(key: ModelKey): void {
  if (isModelUsable(key)) return;
  const what = { whisper: 'Sesli mesajı yazıya dökmek', embed: 'Anlamsal arama', translate: 'Yerel çeviri' }[key];
  throw new MlError(409, `${what} için önce modeli indir: Ayarlar → Yerel AI modelleri → ${MODEL_SPECS[key].title}`);
}

/** Kuyruğa iş ekle: kullanıcı bekliyorsa 'interactive' (arka plan işlerinin önüne geçer) */
export function runMl<T>(fn: (b: MlBackend) => Promise<T>, priority: Priority = 'background'): Promise<T> {
  return mlQueue.add(() => fn((backend ??= new WorkerBackend())), priority);
}

export function disposeMl(): void {
  mlQueue.clearBackground();
  backend?.dispose?.();
}
