import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH } from './config.js';
import { MAIL_PLATFORMS } from './model.js';
import { bus } from './bus.js';
import type { Store } from './store.js';

/**
 * Ayarlar → Depolama: Mivelo'nun bu bilgisayarda kapladığı yer (veritabanı, indirilmiş medya türlerine göre, e-posta ekleri,
 * tarayıcı oturumları, yerel AI modelleri) + en çok yer kaplayan sohbetler; ve medya önbelleğini temizleme.
 * Temizlenen yalnız YENİDEN İNDİRİLEBİLEN önbellek dosyalarıdır (sessions/<hesap>/media/<sha1> + .type): mesajlar, WhatsApp
 * media-index'i (medyanın tek kaynağı), e-posta ekleri (IMAP'ten yalnız orada) ve iMessage'da gönderilen eklerin kopyaları (`out-`) silinmez.
 * Tümü eşzamansız ve dilimli (on binlerce dosyada canlı mesajlar beklemesin).
 */
export type MediaKind = 'images' | 'videos' | 'audio' | 'files';
export const MEDIA_KINDS: MediaKind[] = ['images', 'videos', 'audio', 'files'];

export interface StorageReport {
  total: number;
  parts: { messages: number; images: number; videos: number; audio: number; files: number; mail: number; sessions: number; models: number; other: number };
  chats: Array<{ chatId: string; name: string; platform: string; avatarUrl?: string; messages: number; files: number; bytes: number }>;
  at: number;
}

const yieldLoop = () => new Promise((r) => setImmediate(r));

export function kindOfType(type: string): MediaKind {
  const t = type.trim().toLowerCase();
  if (t.startsWith('image/')) return 'images';
  if (t.startsWith('video/')) return 'videos';
  if (t.startsWith('audio/')) return 'audio';
  return 'files';
}

async function dirSize(dir: string, budget = { n: 0 }): Promise<number> {
  let total = 0;
  let ents: fs.Dirent[];
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    if (++budget.n % 400 === 0) await yieldLoop();
    const fp = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(fp, budget);
      else if (e.isFile()) total += (await fs.promises.stat(fp)).size;
    } catch {
      /* yarışta silinmiş */
    }
  }
  return total;
}

const isMailAccount = (dirName: string) => (MAIL_PLATFORMS as string[]).includes(dirName.split(/[:_]/)[0]);

/** Önbellek dosyası mı (sha1 adlı + .type eşi); tür .type içeriğinden */
async function cacheEntries(mediaDir: string, visit: (file: string, kind: MediaKind, size: number, mtime: number) => Promise<void> | void, budget = { n: 0 }): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(mediaDir);
  } catch {
    return;
  }
  const set = new Set(names);
  for (const f of names) {
    if (++budget.n % 300 === 0) await yieldLoop();
    if (f.endsWith('.type') || f.startsWith('out-') || !set.has(`${f}.type`)) continue;
    const fp = path.join(mediaDir, f);
    try {
      const st = await fs.promises.stat(fp);
      if (!st.isFile()) continue;
      const type = await fs.promises.readFile(`${fp}.type`, 'utf8').catch(() => '');
      await visit(fp, kindOfType(type), st.size, st.mtimeMs);
    } catch {
      /* yok */
    }
  }
}

let cached: { at: number; v: StorageReport } | undefined;

export async function storageReport(store: Pick<Store, 'sql'>, opts: { dataDir?: string; dbPath?: string; modelsDir?: string; fresh?: boolean } = {}): Promise<StorageReport> {
  if (!opts.fresh && cached && Date.now() - cached.at < 60_000) return cached.v;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const dbPath = opts.dbPath ?? DB_PATH;
  const parts: StorageReport['parts'] = { messages: 0, images: 0, videos: 0, audio: 0, files: 0, mail: 0, sessions: 0, models: 0, other: 0 };
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) parts.messages += (await fs.promises.stat(f).catch(() => ({ size: 0 }))).size;
  const budget = { n: 0 };
  const sessions = path.join(dataDir, 'sessions');
  for (const acc of await fs.promises.readdir(sessions).catch(() => [] as string[])) {
    const accDir = path.join(sessions, acc);
    const mediaDir = path.join(accDir, 'media');
    const all = await dirSize(accDir, budget);
    const media = await dirSize(mediaDir, budget);
    if (isMailAccount(acc)) {
      parts.mail += media;
    } else {
      let seen = 0;
      await cacheEntries(
        mediaDir,
        (_f, kind, size) => {
          parts[kind] += size;
          seen += size;
        },
        budget,
      );
      parts.other += Math.max(0, media - seen); // .type eşleri, gönderilen ek kopyaları
    }
    parts.sessions += Math.max(0, all - media);
  }
  // Beeper (mautrix) köprüsü: veritabanları + oturum anahtarları "oturumlar", medya önbelleği türlerine göre
  const bridgeRoot = path.join(dataDir, 'bridge');
  for (const net of await fs.promises.readdir(bridgeRoot).catch(() => [] as string[])) {
    const netDir = path.join(bridgeRoot, net);
    const all = await dirSize(netDir, budget);
    let seen = 0;
    await cacheEntries(
      path.join(netDir, 'media'),
      (_f, kind, size) => {
        parts[kind] += size;
        seen += size;
      },
      budget,
    );
    parts.sessions += Math.max(0, all - seen);
  }
  parts.models = (await dirSize(opts.modelsDir ?? path.join(dataDir, 'models'), budget)) + (await dirSize(path.join(dataDir, 'ml'), budget));
  // sohbet başına: mesaj metni + ek bilgisi + e-posta HTML'i (yaklaşık), dosya sayısı kütüphaneden
  let chats: StorageReport['chats'] = [];
  try {
    const rows = store
      .sql(
        `SELECT m.chat_id AS id, COUNT(*) AS n, SUM(length(m.text) + IFNULL(length(m.attachments), 0) + IFNULL(length(m.html), 0) + 120) AS b,
           c.name AS name, c.platform AS platform, c.avatar_url AS av
         FROM messages m JOIN chats c ON c.id = m.chat_id GROUP BY m.chat_id ORDER BY b DESC LIMIT 30`,
      )
      .all() as Array<{ id: string; n: number; b: number; name: string; platform: string; av: string | null }>;
    const files = new Map<string, number>();
    if (rows.length) {
      try {
        const q = store.sql(`SELECT chat_id AS id, COUNT(*) AS n FROM library_items WHERE chat_id IN (${rows.map(() => '?').join(',')}) AND kind <> 'link' GROUP BY chat_id`);
        for (const r of q.all(...rows.map((r) => r.id)) as Array<{ id: string; n: number }>) files.set(r.id, r.n);
      } catch {
        /* kütüphane dizini henüz yok */
      }
    }
    chats = rows.map((r) => ({ chatId: r.id, name: r.name, platform: r.platform, ...(r.av ? { avatarUrl: r.av } : {}), messages: r.n, files: files.get(r.id) ?? 0, bytes: r.b }));
  } catch (e) {
    bus.log('warn', `Depolama: sohbet boyutları okunamadı: ${(e as Error).message.split('\n')[0]}`);
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const v = { total, parts, chats, at: Date.now() };
  cached = { at: Date.now(), v };
  return v;
}

/** Medya önbelleğini temizle: seçilen türler, `olderThanDays` günden eski (0 = hepsi) */
export async function clearMediaCache(opts: { olderThanDays: number; kinds: MediaKind[]; dataDir?: string; now?: number }): Promise<{ files: number; bytes: number }> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const kinds = new Set(opts.kinds.filter((k) => MEDIA_KINDS.includes(k)));
  const cutoff = (opts.now ?? Date.now()) - Math.max(0, opts.olderThanDays) * 86_400_000;
  let files = 0;
  let bytes = 0;
  if (!kinds.size) return { files, bytes };
  const sessions = path.join(dataDir, 'sessions');
  for (const acc of await fs.promises.readdir(sessions).catch(() => [] as string[])) {
    if (isMailAccount(acc)) continue;
    await cacheEntries(path.join(sessions, acc, 'media'), async (fp, kind, size, mtime) => {
      if (!kinds.has(kind) || (opts.olderThanDays > 0 && mtime >= cutoff)) return;
      await fs.promises.rm(fp, { force: true });
      await fs.promises.rm(`${fp}.type`, { force: true });
      files++;
      bytes += size;
    });
  }
  // köprünün istek üzerine indirdiği medya ("d" önekli; yeniden indirilebilir). Köprünün kendi yüklediği dosyalar (tek kopya) silinmez
  for (const net of await fs.promises.readdir(path.join(dataDir, 'bridge')).catch(() => [] as string[])) {
    await cacheEntries(path.join(dataDir, 'bridge', net, 'media'), async (fp, kind, size, mtime) => {
      if (!/^d[0-9a-f]{32}$/.test(path.basename(fp)) || !kinds.has(kind) || (opts.olderThanDays > 0 && mtime >= cutoff)) return;
      await fs.promises.rm(fp, { force: true });
      await fs.promises.rm(`${fp}.type`, { force: true });
      files++;
      bytes += size;
    });
  }
  cached = undefined;
  if (files) bus.log('info', `Depolama: ${files} önbellek dosyası silindi`);
  return { files, bytes };
}

/** Geçici dosyalar: yarım kalmış güncelleme indirmeleri, eski giden dosya kopyaları */
export async function clearTempFiles(dataDir = DATA_DIR): Promise<{ bytes: number }> {
  let bytes = 0;
  for (const sub of ['update', 'outbox']) {
    const dir = path.join(dataDir, sub);
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      const fp = path.join(dir, f);
      try {
        const st = await fs.promises.stat(fp);
        // şu an gönderilen / inen dosya olabilir: yalnız 10 dk'dan eskiler; güncelleme betiği/günlüğü kalsın
        if (!st.isFile() || Date.now() - st.mtimeMs < 600_000 || /\.(sh|ps1|log)$/.test(f)) continue;
        await fs.promises.rm(fp, { force: true });
        bytes += st.size;
      } catch {
        /* yok */
      }
    }
  }
  cached = undefined;
  return { bytes };
}
