import fs from 'node:fs';
import type { Store } from '../store.js';

/**
 * Pazaryeri connector'larının ortak yardımcıları: durum dosyası atomik yazımı ve olay döngüsünü kilitlemeyen toplu ingest.
 */

/**
 * JSON'u önce geçici dosyaya yaz, sonra rename: çekirdek yazım sırasında öldürülürse (bekçi SIGKILL, disk dolu) dosya ya eski
 * ya da tam yeni hâliyle kalır. Yarım dosya sonraki açılışta "ilk çalıştırma" sayılıp her şeyi yeniden okunmamış yapıyordu.
 */
export function writeJsonAtomic(file: string, obj: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/**
 * Kayıtları dilim dilim tek işlemde işle, dilimler arasında olay döngüsüne nefes aldır: ilk eşitlemede binlerce sipariş/soru
 * tek senkron döngüde (her kayıt ayrı SQLite işlemi) REST/WS'yi saniyelerce kilitliyordu. Sıra ve fn'nin davranışı aynı.
 * stop() dönerse kalan dilimler işlenmez (false döner).
 */
export async function ingestChunked<T>(store: Store, items: T[], fn: (item: T) => void, stopped: () => boolean = () => false, size = 200): Promise<boolean> {
  for (let i = 0; i < items.length; i += size) {
    const part = items.slice(i, i + size);
    store.transaction(() => {
      for (const it of part) fn(it);
    });
    if (i + size < items.length) {
      await new Promise((r) => setImmediate(r));
      if (stopped()) return false;
    }
  }
  return true;
}
