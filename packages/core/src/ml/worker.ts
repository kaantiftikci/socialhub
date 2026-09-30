/**
 * Yerel ML işçisi (worker_thread): model yükleme + çıkarım ana olay döngüsünü hiç bloklamaz. Ana taraf (engine.ts) işleri tek
 * tek gönderir; boşta kalınca işçiyi sonlandırır (modellerin belleği tamamen geri verilir).
 * Çalışma zamanı ~/.mivelo/ml/runtime/<sürüm>/node_modules altından dosya yoluyla yüklenir (models.ts indirir).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// Yerel modül dinamik ve uzantısı açık: geliştirmede (tsx) işçi .ts kaynağını Node'un kendi tür ayıklamasıyla çalıştırıyor ve
// tsx'in ".js → .ts" eşlemesi işçide devreye girmiyor. Derlenmiş pakette .js.
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
type AudioMod = typeof import('./audio.js');
let audioMod: Promise<AudioMod> | null = null;
const audio = () => (audioMod ??= import(new URL(`./audio${EXT}`, import.meta.url).href) as Promise<AudioMod>);
const SAMPLE_RATE = 16000;

interface Init {
  runtimeDir: string;
  modelsDir: string;
}
type Req =
  | { id: number; op: 'transcribe'; model: string; audio: Uint8Array; language: string | null }
  | { id: number; op: 'embed'; model: string; texts: string[] }
  | { id: number; op: 'translate'; model: string; texts: string[]; src: string; tgt: string };

type Pipe = ((input: unknown, opts?: Record<string, unknown>) => Promise<unknown>) & {
  dispose?: () => Promise<void>;
  model?: { generate: (o: Record<string, unknown>) => Promise<{ tolist(): number[][] }>; generation_config?: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number } };
  processor?: (audio: Float32Array) => Promise<{ input_features: unknown }>;
};
interface Tf {
  env: Record<string, unknown> & { backends?: unknown };
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Pipe>;
}

const init = workerData as Init;
let tfP: Promise<Tf> | null = null;

function loadTf(): Promise<Tf> {
  tfP ??= (async () => {
    const nm = path.join(init.runtimeDir, 'node_modules');
    const ort = (await import(pathToFileURL(path.join(nm, 'onnxruntime-web', 'dist', 'ort.node.min.mjs')).href)) as { env: { wasm: Record<string, unknown>; logLevel?: string } };
    // wasm dosyaları yerelden (transformers.js aksi halde CDN adresi yazar); iş parçacığı: çekirdeklerin biri arayüze/ana döngüye kalsın
    ort.env.wasm.wasmPaths = pathToFileURL(path.join(nm, 'onnxruntime-web', 'dist') + path.sep).href;
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
    ort.env.logLevel = 'error';
    (globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = ort;
    const tf = (await import(pathToFileURL(path.join(nm, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href)) as Tf;
    Object.assign(tf.env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: init.modelsDir + path.sep, useWasmCache: false, useFSCache: false, useBrowserCache: false });
    return tf;
  })();
  return tfP;
}

// en çok 2 boru hattı açık kalır (whisper + gömme gibi); üçüncüsü gelince en eskisi bırakılır
const pipes = new Map<string, Promise<Pipe>>();
async function getPipe(task: string, model: string): Promise<Pipe> {
  const key = `${task}|${model}`;
  let p = pipes.get(key);
  if (p) {
    pipes.delete(key);
    pipes.set(key, p); // LRU: sona al
    return p;
  }
  const tf = await loadTf();
  // device 'auto': Symbol.for('onnxruntime') ile verilen arka uçta aygıt listesi boş → boş EP listesi = onnxruntime-web'in
  // varsayılanı (wasm). Node'da transformers.js'in varsayılanı 'cpu' (onnxruntime-node) olurdu.
  p = tf.pipeline(task, model, { dtype: 'q8', device: 'auto', local_files_only: true });
  pipes.set(key, p);
  p.catch(() => pipes.delete(key));
  while (pipes.size > 2) {
    const [oldKey, old] = pipes.entries().next().value as [string, Promise<Pipe>];
    pipes.delete(oldKey);
    void old.then((x) => x.dispose?.()).catch(() => undefined);
  }
  return p;
}

/** Whisper dil algılama: yalnız "başlangıç" belirteciyle tek adım üret; en olası belirteç dil belirtecidir */
async function detectSpokenLanguage(pipe: Pipe, audio: Float32Array): Promise<string | null> {
  try {
    const gc = pipe.model?.generation_config;
    const lang = gc?.lang_to_id;
    const sot = gc?.decoder_start_token_id;
    if (!pipe.processor || !pipe.model || !lang || sot === undefined) return null;
    const feats = await pipe.processor(audio.subarray(0, 30 * SAMPLE_RATE));
    const out = await pipe.model.generate({ inputs: feats.input_features, decoder_input_ids: [sot], max_new_tokens: 1 });
    const tok = out.tolist()[0]?.at(-1);
    const hit = Object.entries(lang).find(([, id]) => id === Number(tok));
    return hit ? hit[0].replace(/[<|>]/g, '') : null;
  } catch {
    return null;
  }
}

async function handle(req: Req): Promise<{ result: unknown; transfer?: ArrayBuffer[] }> {
  if (req.op === 'transcribe') {
    const pcm = await (await audio()).decodeAudio(req.audio);
    if (pcm.length < SAMPLE_RATE * 0.3) return { result: { text: '', lang: req.language, seconds: pcm.length / SAMPLE_RATE } };
    const pipe = await getPipe('automatic-speech-recognition', req.model);
    const lang = req.language ?? (await detectSpokenLanguage(pipe, pcm)) ?? 'tr';
    const out = (await pipe(pcm, { language: lang, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: false })) as { text?: string } | Array<{ text?: string }>;
    const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '').replace(/\s+/g, ' ').trim();
    return { result: { text, lang, seconds: pcm.length / SAMPLE_RATE } };
  }
  if (req.op === 'embed') {
    const pipe = await getPipe('feature-extraction', req.model);
    const out = (await pipe(req.texts, { pooling: 'mean', normalize: true })) as { data: Float32Array; dims: number[] };
    const data = new Float32Array(out.data); // kopya: aktarılabilir tampon
    return { result: { data, dim: out.dims.at(-1) }, transfer: [data.buffer] };
  }
  const pipe = await getPipe('translation', req.model);
  const out = (await pipe(req.texts, { src_lang: req.src, tgt_lang: req.tgt, max_new_tokens: 512 })) as Array<{ translation_text?: string }>;
  return { result: out.map((o) => (o.translation_text ?? '').trim()) };
}

parentPort?.on('message', (req: Req) => {
  handle(req)
    .then(({ result, transfer }) => parentPort!.postMessage({ id: req.id, result }, transfer ?? []))
    .catch((e: unknown) => parentPort!.postMessage({ id: req.id, error: (e as Error)?.message ?? String(e) }));
});
