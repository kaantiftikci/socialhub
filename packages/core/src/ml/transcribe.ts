import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bus } from '../bus.js';
import type { Message } from '../model.js';
import type { Store } from '../store.js';
import { mlSettings, MlError } from './config.js';
import { isModelUsable, requireModel, runMl } from './engine.js';
import { dominantLanguage } from './lang.js';
import { getTranscript, saveTranscript, type Transcript } from './ml-store.js';
import { isOgg, isWav } from './audio.js';

const execFileP = promisify(execFile);

/**
 * Sesli mesajı yazıya dökme: mesajın ses eki connector'ın kendi medya yolundan (fetchMedia; /api/media vekilinin kullandığı,
 * önbellekli yol) alınır, Ogg/Opus ve WAV doğrudan işçide çözülür; diğer biçimler (iMessage .caf/.m4a, mp3) önce sistem aracıyla
 * WAV'a çevrilir (macOS afconvert her zaman var; yoksa ffmpeg). Sonuç `transcripts` tablosuna + transcript.update olayıyla arayüze.
 * Günlüğe yalnız süre/biçim yazılır, metin ASLA.
 */
export interface MediaSource {
  get(accountId: string): { fetchMedia?(u: string): Promise<{ body: Buffer; type: string } | undefined> } | undefined;
}

/** Yazıya dökülebilecek ses eki: çekirdeğin medya vekili üzerinden sunulanlar (/api/media/<hesap>?u=…) */
export function audioSourceOf(m: Pick<Message, 'attachments'>): { accountId: string; u: string; mime?: string } | undefined {
  for (const a of m.attachments ?? []) {
    if (a.kind !== 'audio' || !a.link?.startsWith('/api/media/')) continue;
    try {
      const url = new URL(a.link, 'http://x');
      const accountId = decodeURIComponent(url.pathname.slice('/api/media/'.length));
      const u = url.searchParams.get('u');
      if (accountId && u) return { accountId, u, mime: a.mime };
    } catch {
      /* bozuk adres */
    }
  }
  return undefined;
}

/** Otomatik yazıya dökmenin açık olduğu platformlar (sesli mesajı yaygın olanlar) */
const AUTO_PLATFORMS = /^(whatsapp|telegram|imessage|demo):/;
const MAX_BYTES = 40 * 1024 * 1024;

let ffmpegPath: string | null | undefined;
async function findFfmpeg(): Promise<string | null> {
  if (ffmpegPath !== undefined) return ffmpegPath;
  for (const p of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    const ok = await execFileP(p, ['-version'], { timeout: 5000, windowsHide: true }).then(() => true, () => false);
    if (ok) return (ffmpegPath = p);
  }
  return (ffmpegPath = null);
}

/** Ogg/WAV dışındaki sesi 16 kHz mono WAV'a çevir (macOS afconvert → ffmpeg) */
export async function toWav(body: Buffer, mime: string): Promise<Buffer> {
  const ext = /caf/i.test(mime) ? '.caf' : /mp4|m4a|aac/i.test(mime) ? '.m4a' : /mpeg|mp3/i.test(mime) ? '.mp3' : /amr/i.test(mime) ? '.amr' : /webm/i.test(mime) ? '.webm' : '.bin';
  const base = path.join(os.tmpdir(), `mivelo-ml-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const input = base + ext;
  const out = base + '.wav';
  await fs.promises.writeFile(input, body, { mode: 0o600 });
  try {
    if (process.platform === 'darwin') {
      const ok = await execFileP('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, out], { timeout: 120_000 }).then(() => true, () => false);
      if (ok) return await fs.promises.readFile(out);
    }
    const ff = await findFfmpeg();
    if (!ff) throw new MlError(415, 'Bu ses biçimi çözülemedi (ffmpeg yok). WhatsApp/Telegram sesli mesajları ffmpeg olmadan da yazıya dökülür.');
    await execFileP(ff, ['-nostdin', '-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-f', 'wav', out], { timeout: 120_000, windowsHide: true });
    return await fs.promises.readFile(out);
  } finally {
    void fs.promises.rm(input, { force: true });
    void fs.promises.rm(out, { force: true });
  }
}

export class TranscribeService {
  private inflight = new Map<string, Promise<Transcript | undefined>>();
  private stopBus?: () => void;

  constructor(
    private store: Store,
    private media: MediaSource,
  ) {}

  /** Otomatik mod: yeni gelen sesli mesajlar arka planda (ayar açıksa ve model indirilmişse) */
  start(): void {
    this.stopBus = bus.on((ev) => {
      if (ev.type !== 'message.upsert') return;
      const m = ev.message;
      if (m.fromMe || !m.attachments?.length) return;
      if (!mlSettings().autoTranscribe || !isModelUsable('whisper')) return;
      if (!AUTO_PLATFORMS.test(m.chatId)) return;
      // geçmiş eşitlemesinde eski sesler yazıya dökülmez (yalnız son 2 gün); kullanıcı eskileri düğmeyle döker
      if (!ev.live && Date.now() - m.ts > 2 * 86400e3) return;
      if (!audioSourceOf(m) || getTranscript(this.store, m.id)) return;
      void this.run(m.id, 'background').catch(() => undefined);
    });
  }

  stop(): void {
    this.stopBus?.();
  }

  /** Kullanıcı "Yazıya dök" dedi: hemen 'pending' döner, sonuç olayla gelir */
  request(messageId: string): Transcript {
    requireModel('whisper');
    const m = this.store.getMessage(messageId);
    if (!m) throw new MlError(404, 'Mesaj bulunamadı');
    if (!audioSourceOf(m)) throw new MlError(400, 'Bu mesajda yazıya dökülebilecek ses yok');
    const cur = getTranscript(this.store, messageId);
    if (cur?.status === 'pending' && this.inflight.has(messageId)) return cur;
    void this.run(messageId, 'interactive').catch(() => undefined);
    return getTranscript(this.store, messageId) ?? { messageId, status: 'pending', text: '', updatedAt: Date.now() };
  }

  private emit(chatId: string, t: Transcript | undefined): void {
    if (t) bus.emit({ type: 'transcript.update', chatId, messageId: t.messageId, transcript: t });
  }

  /** Sohbetin baskın yazı dili (Whisper'a ipucu; yetersizse null → Whisper kendisi algılar) */
  private chatLanguage(chatId: string): string | null {
    const rows = this.store.mlStmt("SELECT text FROM messages WHERE chat_id = ? AND length(text) > 3 AND from_me = 0 ORDER BY ts DESC LIMIT 40").all(chatId) as Array<{ text: string }>;
    const g = dominantLanguage(rows.map((r) => r.text));
    return g.lang && g.confidence >= 0.7 ? g.lang : null;
  }

  run(messageId: string, priority: 'interactive' | 'background'): Promise<Transcript | undefined> {
    const running = this.inflight.get(messageId);
    if (running) return running;
    const m = this.store.getMessage(messageId);
    const src = m ? audioSourceOf(m) : undefined;
    if (!m || !src) return Promise.resolve(undefined);
    this.emit(m.chatId, saveTranscript(this.store, { messageId, status: 'pending', text: '' }));
    const p = runMl(async (b) => {
      const t0 = Date.now();
      const c = this.media.get(src.accountId);
      if (!c?.fetchMedia) throw new MlError(503, 'Hesap bağlı değil; ses dosyası alınamadı');
      const media = await c.fetchMedia(src.u);
      if (!media) throw new MlError(503, 'Hesap bağlı değil; ses dosyası alınamadı');
      if (media.body.length > MAX_BYTES) throw new MlError(413, 'Ses dosyası çok uzun');
      const type = media.type || src.mime || '';
      const bytes = isOgg(media.body) || isWav(media.body) ? media.body : await toWav(media.body, type);
      const r = await b.transcribe(bytes, this.chatLanguage(m.chatId));
      bus.log('info', `Sesli mesaj yazıya döküldü: ${Math.round(r.seconds ?? 0)} sn ses, ${((Date.now() - t0) / 1000).toFixed(1)} sn, dil ${r.lang ?? '?'} (${type.split('/')[1] ?? 'ses'})`);
      return saveTranscript(this.store, { messageId, status: 'done', text: r.text, lang: r.lang ?? undefined, seconds: r.seconds });
    }, priority)
      .catch((e: unknown) => {
        const msg = e instanceof MlError ? e.message : `Yazıya dökülemedi: ${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 160)}`;
        bus.log('warn', `Sesli mesaj yazıya dökülemedi: ${msg}`);
        return saveTranscript(this.store, { messageId, status: 'error', text: '', error: msg });
      })
      .then((t) => {
        this.emit(m.chatId, t);
        return t;
      })
      .finally(() => this.inflight.delete(messageId));
    this.inflight.set(messageId, p);
    return p;
  }
}
