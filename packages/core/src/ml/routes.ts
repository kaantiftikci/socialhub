import type http from 'node:http';
import { aiEnabled } from '../ai.js';
import { bus } from '../bus.js';
import type { Store } from '../store.js';
import { MODEL_KEYS, MlError, mlSettings, saveMlSettings, type ModelKey } from './config.js';
import { disposeMl } from './engine.js';
import { chatTranscripts } from './ml-store.js';
import { allModelStatus, cancelDownload, emitMlStatus, removeModel, RUNTIME_APPROX_MB, runtimeReady, startDownload } from './models.js';
import { SemanticIndex } from './semantic.js';
import { TranscribeService, type MediaSource } from './transcribe.js';
import { chatLanguage, translateMessage, translateTexts, translationEngine } from './translate.js';
import { LANG_NAMES } from './lang.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body: unknown) => Promise<unknown> | unknown;
type Route = (method: string, path: string, handler: Handler) => void;

/**
 * Yerel ML uçları (/api/ml/…). server.ts yalnız bağlar: registerMlRoutes(route, …). Hatalar anlaşılır Türkçe metinle ilgili
 * HTTP durumuna çevrilir (409 = model indirilmemiş / anahtar yok).
 */
export function registerMlRoutes(route: Route, deps: { store: Store; media: MediaSource; httpError: (status: number, message: string) => Error }): { semantic: SemanticIndex; transcribe: TranscribeService } {
  const { store, httpError } = deps;
  const transcribe = new TranscribeService(store, deps.media);
  const semantic = new SemanticIndex(store);
  transcribe.start();
  semantic.start();

  const wrap =
    (fn: Handler): Handler =>
    async (...a) => {
      try {
        return await fn(...a);
      } catch (e) {
        if (e instanceof MlError) throw httpError(e.status >= 400 && e.status < 600 ? e.status : 500, e.message);
        throw e;
      }
    };
  const key = (k: string): ModelKey => {
    if (!(MODEL_KEYS as string[]).includes(k)) throw httpError(404, 'Model yok');
    return k as ModelKey;
  };
  const q = (req: http.IncomingMessage) => new URL(req.url ?? '/', 'http://x').searchParams;

  const status = () => ({
    models: allModelStatus(),
    runtime: { ready: runtimeReady(), approxMb: RUNTIME_APPROX_MB },
    settings: mlSettings(),
    index: semantic.status(),
    translate: { engine: translationEngine(), ai: aiEnabled() },
    languages: LANG_NAMES,
  });

  route('GET', '/api/ml', wrap(() => status()));
  route(
    'POST',
    '/api/ml/settings',
    wrap((_r, _s, _p, body) => {
      const prev = mlSettings();
      const next = saveMlSettings((body ?? {}) as Record<string, unknown>);
      if (next.semanticIndex && !prev.semanticIndex) semantic.kick(500);
      emitMlStatus(true);
      return status();
    }),
  );
  route(
    'POST',
    '/api/ml/models/:key/download',
    wrap((_r, _s, p) => {
      const k = key(p.key);
      const st = startDownload(k);
      return st;
    }),
  );
  route('POST', '/api/ml/models/:key/cancel', wrap((_r, _s, p) => (cancelDownload(key(p.key)), status())));
  route(
    'DELETE',
    '/api/ml/models/:key',
    wrap((_r, _s, p) => {
      disposeMl(); // işçi modeli bellekte tutuyor olabilir
      removeModel(key(p.key));
      return status();
    }),
  );

  // ---- sesli mesaj metni ----
  route(
    'GET',
    '/api/ml/transcripts',
    wrap((req) => {
      const chatId = q(req).get('chat') ?? '';
      if (!chatId) throw httpError(400, 'chat gerekli');
      return Object.fromEntries(chatTranscripts(store, chatId).map((t) => [t.messageId, t]));
    }),
  );
  route(
    'POST',
    '/api/ml/transcribe',
    wrap((_r, _s, _p, body) => {
      const id = (body as { messageId?: string })?.messageId;
      if (!id) throw httpError(400, 'messageId gerekli');
      return transcribe.request(id);
    }),
  );

  // ---- anlamsal arama ----
  route(
    'GET',
    '/api/ml/search',
    wrap(async (req) => {
      const sp = q(req);
      const text = (sp.get('q') ?? '').trim();
      const limit = Math.max(1, Math.min(200, Number(sp.get('limit')) || 60));
      if (!text) return { hits: [], mode: 'text', hints: { people: [] }, index: semantic.status() };
      return semantic.search(text, limit);
    }),
  );

  // ---- çeviri ----
  route(
    'POST',
    '/api/ml/translate',
    wrap(async (_r, _s, _p, body) => {
      const b = (body ?? {}) as { messageId?: string; target?: string; force?: boolean };
      if (!b.messageId) throw httpError(400, 'messageId gerekli');
      return translateMessage(store, b.messageId, b.target || mlSettings().translateTarget, { force: !!b.force });
    }),
  );
  route(
    'POST',
    '/api/ml/translate-text',
    wrap(async (_r, _s, _p, body) => {
      const b = (body ?? {}) as { text?: string; target?: string; source?: string };
      const text = (b.text ?? '').trim();
      if (!text) throw httpError(400, 'Metin boş');
      if (text.length > 8000) throw httpError(413, 'Metin çok uzun');
      if (!b.target) throw httpError(400, 'Hedef dil gerekli');
      const r = await translateTexts([text], b.target, { source: b.source ?? null, interactive: true });
      return { text: r.texts[0] ?? '', source: r.source, target: b.target, engine: r.engine };
    }),
  );
  route(
    'GET',
    '/api/ml/chat-lang',
    wrap((req) => {
      const chatId = q(req).get('chat') ?? '';
      if (!chatId) throw httpError(400, 'chat gerekli');
      return chatLanguage(store, chatId);
    }),
  );

  const ready = allModelStatus().filter((m) => m.state === 'ready').length;
  if (ready) bus.log('info', `Yerel AI: ${ready} model hazır`);
  return { semantic, transcribe };
}
