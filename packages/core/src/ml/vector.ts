/**
 * Gömme vektörleri: int8 nicemleme (vektör başına ölçek) + kaba kuvvet benzerlik. Gömmeler birim uzunlukta (normalize) olduğu
 * için kosinüs = iç çarpım. Belge vektörü int8 (384 bayt), sorgu float32 kalır → skor = ölçek × Σ q[i]·sorgu[i].
 * 100 bin × 384 çarpım ≈ 40 M işlem: tek çekirdekte onlarca ms; yine de dilimlenir (olay döngüsü kilitlenmesin).
 */

export interface Quantized {
  q: Int8Array;
  scale: number;
}

/** float → int8 (simetrik; en büyük mutlak değer 127'ye) */
export function quantize(v: ArrayLike<number>): Quantized {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max > 0 ? max / 127 : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
  return { q, scale };
}

export function dequantize(x: Quantized): Float32Array {
  const out = new Float32Array(x.q.length);
  for (let i = 0; i < out.length; i++) out[i] = x.q[i] * x.scale;
  return out;
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/** SQLite BLOB ↔ vektör: [4 bayt float32 ölçek][int8 × boyut] */
export function packVector(x: Quantized): Buffer {
  const buf = Buffer.alloc(4 + x.q.length);
  buf.writeFloatLE(x.scale, 0);
  Buffer.from(x.q.buffer, x.q.byteOffset, x.q.byteLength).copy(buf, 4);
  return buf;
}

export function unpackVector(buf: Uint8Array): Quantized {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const scale = b.readFloatLE(0);
  const q = new Int8Array(b.length - 4);
  q.set(new Int8Array(b.buffer, b.byteOffset + 4, b.length - 4));
  return { q, scale };
}

/**
 * Bellek içi dizin: tüm vektörler tek Int8Array'de (bitişik), yanlarında ölçek/zaman/sohbet. Ekleme O(1) (kapasite ikiye katlanır),
 * silme işaretle (kimlik haritadan kalkar, satır boş kalır; yeniden kurulunca sıkışır).
 */
export class VectorIndex {
  readonly dim: number;
  private data: Int8Array;
  private scales: Float32Array;
  private tss: Float64Array;
  private ids: Array<string | null> = [];
  private chats: Array<string | null> = [];
  private pos = new Map<string, number>();
  private n = 0;

  constructor(dim: number, capacity = 1024) {
    this.dim = dim;
    this.data = new Int8Array(dim * capacity);
    this.scales = new Float32Array(capacity);
    this.tss = new Float64Array(capacity);
  }

  get size(): number {
    return this.pos.size;
  }

  has(id: string): boolean {
    return this.pos.has(id);
  }

  private grow(): void {
    const cap = this.scales.length * 2;
    const d = new Int8Array(this.dim * cap);
    d.set(this.data);
    this.data = d;
    const s = new Float32Array(cap);
    s.set(this.scales);
    this.scales = s;
    const t = new Float64Array(cap);
    t.set(this.tss);
    this.tss = t;
  }

  add(id: string, chatId: string, ts: number, v: Quantized): void {
    if (v.q.length !== this.dim) return;
    const at = this.pos.get(id);
    const i = at ?? this.n;
    if (at === undefined) {
      if (this.n >= this.scales.length) this.grow();
      this.n++;
      this.pos.set(id, i);
    }
    this.data.set(v.q, i * this.dim);
    this.scales[i] = v.scale;
    this.tss[i] = ts;
    this.ids[i] = id;
    this.chats[i] = chatId;
  }

  remove(id: string): void {
    const i = this.pos.get(id);
    if (i === undefined) return;
    this.pos.delete(id);
    this.ids[i] = null;
    this.chats[i] = null;
    this.scales[i] = 0;
  }

  /** Bir sohbetin (ya da hesabın: önek) tüm vektörlerini at */
  removeWhere(pred: (chatId: string) => boolean): number {
    let n = 0;
    for (let i = 0; i < this.n; i++) {
      const c = this.chats[i];
      if (c !== null && pred(c)) {
        this.remove(this.ids[i]!);
        n++;
      }
    }
    return n;
  }

  /**
   * En benzer `k` kayıt. Dilim başına `slice` satır işlenir, aralarda olay döngüsüne dönülür.
   * filter: zaman aralığı / sohbet kümesi (null = hepsi)
   */
  async search(
    query: Float32Array,
    k: number,
    filter?: { from?: number; to?: number; chats?: Set<string> | null; minScore?: number },
    slice = 20000,
  ): Promise<Array<{ id: string; chatId: string; ts: number; score: number }>> {
    const dim = this.dim;
    const top: Array<{ i: number; score: number }> = [];
    let worst = -Infinity;
    const from = filter?.from ?? -Infinity;
    const to = filter?.to ?? Infinity;
    const chats = filter?.chats ?? null;
    const min = filter?.minScore ?? -Infinity;
    for (let start = 0; start < this.n; start += slice) {
      const end = Math.min(this.n, start + slice);
      for (let i = start; i < end; i++) {
        const sc = this.scales[i];
        if (!sc) continue;
        const ts = this.tss[i];
        if (ts < from || ts > to) continue;
        if (chats && !chats.has(this.chats[i]!)) continue;
        let d = 0;
        const off = i * dim;
        for (let j = 0; j < dim; j++) d += this.data[off + j] * query[j];
        const score = d * sc;
        if (score < min) continue;
        if (top.length < k) {
          top.push({ i, score });
          if (top.length === k) {
            top.sort((a, b) => a.score - b.score);
            worst = top[0].score;
          }
        } else if (score > worst) {
          // artan sıralı listede en kötüyü at, yenisini yerine kaydır (O(k))
          let p = 0;
          while (p + 1 < top.length && top[p + 1].score < score) {
            top[p] = top[p + 1];
            p++;
          }
          top[p] = { i, score };
          worst = top[0].score;
        }
      }
      if (end < this.n) await new Promise((r) => setImmediate(r));
    }
    return top
      .sort((a, b) => b.score - a.score)
      .map(({ i, score }) => ({ id: this.ids[i]!, chatId: this.chats[i]!, ts: this.tss[i], score }));
  }
}

/** Birden çok sıralı listeyi karşılıklı sıra füzyonuyla birleştir (RRF, k=60): anlamsal + tam metin */
export function rrf(lists: string[][], k = 60): Array<{ id: string; score: number }> {
  const s = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => s.set(id, (s.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...s.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
