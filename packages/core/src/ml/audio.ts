/**
 * Ses çözme (Whisper 16 kHz mono Float32 ister). Saf JS/wasm, işletim sisteminden bağımsız:
 * - Ogg/Opus (WhatsApp/Telegram sesli mesajı): Ogg sayfaları → paketler (kendi ayrıştırıcımız) → opus-decoder (MIT, libopus wasm;
 *   doğrudan 16 kHz çözer, yeniden örnekleme gerekmez).
 * - WAV (PCM 8/16/24/32 bit, float32): başlık ayrıştırılır, mono'ya indirilir, 16 kHz'e örneklenir.
 * Diğer biçimler (iMessage .caf/.m4a, ffmpeg varken mp3'e çevrilmiş WhatsApp sesi) çağıran tarafta sistem aracıyla WAV'a çevrilir
 * (macOS afconvert, varsa ffmpeg) — bkz. transcribe.ts `toWav`.
 * Bu modül ML işçisinde (worker_thread) çalışır; ana döngüde değil.
 */

export const SAMPLE_RATE = 16000;

export function isOgg(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53; // "OggS"
}

export function isWav(b: Uint8Array): boolean {
  const s = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  return b.length > 12 && s(0) === 'RIFF' && s(8) === 'WAVE';
}

export interface OggStream {
  /** İlk mantıksal akışın paketleri (başlık paketleri dahil) */
  packets: Uint8Array[];
  serial: number;
}

/** Ogg kabı → ilk mantıksal akışın paketleri (lacing değerleri 255 ise paket sonraki segmente/sayfaya devam eder) */
export function parseOgg(b: Uint8Array): OggStream {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const packets: Uint8Array[] = [];
  let serial: number | undefined;
  let partial: Uint8Array[] = [];
  let off = 0;
  while (off + 27 <= b.length) {
    if (!(b[off] === 0x4f && b[off + 1] === 0x67 && b[off + 2] === 0x67 && b[off + 3] === 0x53)) {
      // bozuk bayt: sonraki "OggS"yi ara
      const next = indexOfOggS(b, off + 1);
      if (next < 0) break;
      off = next;
      continue;
    }
    const pageSerial = dv.getUint32(off + 14, true);
    const nseg = b[off + 26];
    if (off + 27 + nseg > b.length) break;
    const lacing = b.subarray(off + 27, off + 27 + nseg);
    let dataOff = off + 27 + nseg;
    const pageLen = lacing.reduce((s, v) => s + v, 0);
    if (dataOff + pageLen > b.length) break; // yarım sayfa
    serial ??= pageSerial;
    if (pageSerial === serial) {
      for (const len of lacing) {
        partial.push(b.subarray(dataOff, dataOff + len));
        dataOff += len;
        if (len < 255) {
          packets.push(concat(partial));
          partial = [];
        }
      }
    }
    off = off + 27 + nseg + pageLen;
  }
  return { packets, serial: serial ?? 0 };
}

function indexOfOggS(b: Uint8Array, from: number): number {
  for (let i = from; i + 3 < b.length; i++) if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) return i;
  return -1;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface OpusHead {
  channels: number;
  preSkip: number;
  inputRate: number;
  mappingFamily: number;
  streamCount?: number;
  coupledStreamCount?: number;
  mapping?: number[];
}

export function parseOpusHead(p: Uint8Array): OpusHead | undefined {
  if (p.length < 19 || String.fromCharCode(...p.subarray(0, 8)) !== 'OpusHead') return undefined;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const head: OpusHead = { channels: p[9], preSkip: dv.getUint16(10, true), inputRate: dv.getUint32(12, true), mappingFamily: p[18] };
  if (head.mappingFamily !== 0 && p.length >= 21 + head.channels) {
    head.streamCount = p[19];
    head.coupledStreamCount = p[20];
    head.mapping = [...p.subarray(21, 21 + head.channels)];
  }
  return head;
}

/** Çok kanallı sesi mono'ya indir */
export function toMono(channels: Float32Array[], length?: number): Float32Array {
  if (channels.length === 1) return length === undefined ? channels[0] : channels[0].subarray(0, length);
  const n = length ?? Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/** Doğrusal ara değerlemeli yeniden örnekleme; aşağı örneklemede önce kutu süzgeci (örtüşme azaltılır) */
export function resample(x: Float32Array, from: number, to = SAMPLE_RATE): Float32Array {
  if (from === to || !x.length) return x;
  let src = x;
  if (from > to) {
    const w = Math.max(1, Math.floor(from / to));
    if (w > 1) {
      src = new Float32Array(x.length);
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        acc += x[i];
        if (i >= w) acc -= x[i - w];
        src[i] = acc / Math.min(i + 1, w);
      }
    }
  }
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const a = Math.floor(p);
    const f = p - a;
    out[i] = src[a] * (1 - f) + (src[Math.min(a + 1, src.length - 1)] ?? 0) * f;
  }
  return out;
}

/** RIFF/WAVE (PCM 8/16/24/32, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) → 16 kHz mono */
export function decodeWav(b: Uint8Array): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // extensible: alt biçim GUID'in ilk 2 baytı
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      // bazı araçlar akış yazımında boyutu 0/0xFFFFFFFF bırakır: dosya sonuna kadar
      if (!size || size === 0xffffffff || body + size > b.length) size = b.length - body;
      data = b.subarray(body, body + size);
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV başlığı okunamadı');
  const { format, channels, rate, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(data.length / (bps * channels));
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chans = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bps;
      let v: number;
      if (format === 3) v = bits === 64 ? ddv.getFloat64(o, true) : ddv.getFloat32(o, true);
      else if (bits === 8) v = (data[o] - 128) / 128;
      else if (bits === 16) v = ddv.getInt16(o, true) / 32768;
      else if (bits === 24) v = ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = ddv.getInt32(o, true) / 2147483648;
      else throw new Error(`Desteklenmeyen WAV örnek boyutu: ${bits}`);
      chans[c][i] = v;
    }
  }
  return resample(toMono(chans), rate);
}

type OpusDecoderCtor = new (opts: Record<string, unknown>) => {
  ready: Promise<void>;
  decodeFrame(frame: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number };
  free(): void;
};

/** Ogg/Opus → 16 kHz mono. maxSeconds: çok uzun seste belleği sınırla */
export async function decodeOggOpus(b: Uint8Array, maxSeconds = 15 * 60): Promise<Float32Array> {
  const { packets } = parseOgg(b);
  const head = packets.length ? parseOpusHead(packets[0]) : undefined;
  if (!head) throw new Error('Ogg dosyası Opus değil (Vorbis vb. desteklenmiyor)');
  const { OpusDecoder } = (await import('opus-decoder')) as unknown as { OpusDecoder: OpusDecoderCtor };
  const dec = new OpusDecoder({
    sampleRate: SAMPLE_RATE,
    channels: head.channels,
    // pre-skip 48 kHz örnek cinsinden; 16 kHz çıktıda üçte biri kadar atlanır (kitaplık kendisi dönüştürür)
    preSkip: head.preSkip,
    ...(head.mappingFamily !== 0 ? { streamCount: head.streamCount, coupledStreamCount: head.coupledStreamCount, channelMappingTable: head.mapping } : {}),
  });
  await dec.ready;
  const chunks: Float32Array[] = [];
  let total = 0;
  const limit = maxSeconds * SAMPLE_RATE;
  try {
    // 0: OpusHead, 1: OpusTags (yorum), sonrası ses
    for (let i = 1; i < packets.length && total < limit; i++) {
      const p = packets[i];
      if (i === 1 && p.length >= 8 && String.fromCharCode(...p.subarray(0, 8)) === 'OpusTags') continue;
      if (!p.length) continue;
      const r = dec.decodeFrame(p);
      if (!r.samplesDecoded) continue;
      const mono = toMono(r.channelData, r.samplesDecoded);
      chunks.push(mono.slice());
      total += mono.length;
    }
  } finally {
    dec.free();
  }
  const out = new Float32Array(Math.min(total, limit));
  let o = 0;
  for (const c of chunks) {
    if (o >= out.length) break;
    out.set(c.subarray(0, out.length - o), o);
    o += c.length;
  }
  return out;
}

/** Ses dosyası baytları → 16 kHz mono Float32 (Ogg/Opus ya da WAV; diğerleri önce WAV'a çevrilmeli) */
export async function decodeAudio(b: Uint8Array): Promise<Float32Array> {
  if (isOgg(b)) return decodeOggOpus(b);
  if (isWav(b)) return decodeWav(b);
  throw new Error('Ses biçimi tanınmadı');
}
