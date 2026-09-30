import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

/**
 * En küçük akışlı tar (ustar + pax/GNU uzun ad) açıcı: npm paketlerinin (.tgz) yalnız istenen dosyalarını diske yazar.
 * Güvenlik: mutlak yol, "..", sembolik bağ ve cihaz dosyaları yazılmaz; hedef her zaman `dest` altında kalır.
 * gzip çözme çağıranda (zlib.createGunzip) — bu yazılabilir akış ham tar baytlarını alır.
 */
export class TarExtract extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private pad = 0;
  private file: fs.WriteStream | null = null;
  private fileName = '';
  private longName: string | null = null;
  private paxPath: string | null = null;
  private meta: Buffer[] | null = null;
  private metaKind: 'pax' | 'gnu' | null = null;
  private done = false;
  readonly written: string[] = [];

  /**
   * @param dest hedef klasör
   * @param map tar içindeki yol → hedefe göre göreli yol (undefined = atla). npm paketlerinde yollar "package/…" ile başlar.
   */
  constructor(
    private dest: string,
    private map: (name: string) => string | undefined,
  ) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.drain()
      .then(() => cb())
      .catch((e: Error) => cb(e));
  }

  override _final(cb: (e?: Error | null) => void): void {
    if (this.file) this.file.end(() => cb());
    else cb();
  }

  private async drain(): Promise<void> {
    while (!this.done) {
      if (this.remaining > 0) {
        if (!this.buf.length) return;
        const n = Math.min(this.remaining, this.buf.length);
        const part = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        if (this.meta) this.meta.push(Buffer.from(part));
        else if (this.file && !this.file.write(part)) await new Promise<void>((r) => this.file!.once('drain', () => r()));
        if (this.remaining === 0) await this.endEntry();
        continue;
      }
      if (this.pad > 0) {
        if (!this.buf.length) return;
        const n = Math.min(this.pad, this.buf.length);
        this.buf = this.buf.subarray(n);
        this.pad -= n;
        continue;
      }
      if (this.buf.length < 512) return;
      const h = this.buf.subarray(0, 512);
      this.buf = this.buf.subarray(512);
      if (h.every((x) => x === 0)) {
        // arşiv sonu (iki boş blok); kalan baytlar yok sayılır
        this.done = true;
        return;
      }
      await this.startEntry(h);
    }
  }

  private async startEntry(h: Buffer): Promise<void> {
    const str = (o: number, n: number) => h.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = str(345, 155);
    let name = this.paxPath ?? this.longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    this.paxPath = null;
    this.longName = null;
    this.remaining = size;
    this.pad = (512 - (size % 512)) % 512;
    this.meta = null;
    this.metaKind = null;
    this.file = null;
    if (type === 'x' || type === 'L') {
      this.meta = [];
      this.metaKind = type === 'x' ? 'pax' : 'gnu';
      if (!size) await this.endEntry();
      return;
    }
    if (type === 'g') {
      this.meta = []; // genel pax başlığı: yok say
      this.metaKind = null;
      if (!size) await this.endEntry();
      return;
    }
    name = name.replace(/\\/g, '/');
    const rel = type === '0' || type === '\0' || type === '7' ? this.map(name) : undefined;
    if (rel && isSafe(rel)) {
      const target = path.join(this.dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this.file = fs.createWriteStream(target);
      this.fileName = rel;
      if (!size) await this.endEntry();
    } else if (!size) {
      await this.endEntry();
    }
  }

  private async endEntry(): Promise<void> {
    if (this.meta) {
      const body = Buffer.concat(this.meta).toString('utf8');
      if (this.metaKind === 'gnu') this.longName = body.replace(/\0.*$/s, '');
      else if (this.metaKind === 'pax') {
        // "<uzunluk> anahtar=değer\n" kayıtları
        for (const line of body.split('\n')) {
          const m = /^\d+ path=(.*)$/.exec(line);
          if (m) this.paxPath = m[1];
        }
      }
      this.meta = null;
      this.metaKind = null;
      return;
    }
    if (this.file) {
      const f = this.file;
      this.file = null;
      await new Promise<void>((resolve, reject) => {
        f.once('error', reject);
        f.end(() => resolve());
      });
      this.written.push(this.fileName);
    }
  }
}

function isSafe(rel: string): boolean {
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return !rel.split(/[\\/]/).some((p) => p === '..');
}
