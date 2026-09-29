import fs from 'node:fs';
import path from 'node:path';
import { bus } from './bus.js';
import { DATA_DIR } from './config.js';
import { MAIL_PLATFORMS } from './model.js';
import type { Store } from './store.js';

/**
 * 60 günden eski medya önbelleği dosyalarını sil (sessions/<hesap>/media): disk sınırsız büyümesin. Eşzamansız, dinlemeden ve kanallar
 * açıldıktan sonra, günde en çok bir kez. Silinmeyenler (29.09 denetimi: kalıcı kayıptı):
 * - media-index (WhatsApp medyası ve küçük önizlemelerinin TEK kaynağı; önbellek değil — hesap kaldırılınca zaten silinir)
 * - e-posta hesaplarının media/ klasörü (IMAP ekleri ve gömülü cid görselleri yalnız orada)
 * - `out-` dosyaları (iMessage'da gönderilen eklerin yerel kopyası)
 */
export async function pruneMediaCache(store: Pick<Store, 'meta' | 'setFlag'>, dataDir = DATA_DIR, now = Date.now()): Promise<number> {
  const last = Number(store.meta('media_prune_at')) || 0;
  if (now - last < 86_400_000) return 0;
  const sessions = path.join(dataDir, 'sessions');
  const cutoff = now - 60 * 86_400_000;
  let n = 0;
  let seen = 0;
  try {
    for (const acc of await fs.promises.readdir(sessions).catch(() => [] as string[])) {
      if ((MAIL_PLATFORMS as string[]).includes(acc.split(/[:_]/)[0])) continue;
      const dir = path.join(sessions, acc, 'media');
      for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
        // olay döngüsüne yol ver (on binlerce dosyada canlı mesajlar beklemesin)
        if (++seen % 500 === 0) await new Promise((r) => setImmediate(r));
        if (f.startsWith('out-')) continue;
        const fp = path.join(dir, f);
        try {
          if ((await fs.promises.stat(fp)).mtimeMs < cutoff) {
            await fs.promises.rm(fp, { force: true });
            n++;
          }
        } catch {
          /* yok */
        }
      }
    }
    store.setFlag('media_prune_at', String(now));
    if (n) bus.log('info', `Medya önbelleği: ${n} eski dosya silindi`);
  } catch {
    /* yok */
  }
  return n;
}
