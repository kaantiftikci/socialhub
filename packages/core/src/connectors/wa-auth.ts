import fs from 'node:fs';
import path from 'node:path';
import * as Baileys from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, CacheStore, SignalDataTypeMap } from '@whiskeysockets/baileys';

const { initAuthCreds, BufferJSON } = Baileys;
const B = Baileys as unknown as Record<string, unknown>;
const proto = (B.proto ?? (B.default as { proto?: unknown })?.proto) as typeof Baileys.proto;

/**
 * Baileys useMultiFileAuthState ile AYNI dosya biçimi (mevcut oturumlar olduğu gibi okunur), ama yazma atomik:
 * geçici dosyaya yaz → fsync → rename. Baileys'in düz writeFile'ı yazma ortasında kapanan süreçte creds.json / oturum
 * anahtarlarını yarım bırakabiliyor → "Bad MAC", "No session", "Bu mesaj bekleniyor" (README: üretimde kullanmayın;
 * Evolution/WAHA kendi depolarını kullanır). Aynı dosyaya eşzamanlı yazımlar sıraya girer.
 */
export async function useAtomicAuthState(folder: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  fs.mkdirSync(folder, { recursive: true });
  const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(file: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(file) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    chains.set(file, tail);
    void tail.then(() => {
      if (chains.get(file) === tail) chains.delete(file);
    });
    return next;
  };

  // Süreç çökmesine karşı güvence geçici dosya + rename'den gelir (yarım dosya asla hedef adla kalmaz). fsync yalnız kimlik
  // dosyasında (creds.json): geçmiş eşitlemesinde Baileys binlerce anahtar (tctoken, lid-mapping, oturum) yazıyor ve her
  // birinde fsync Baileys'in mesaj kilidi altında saniyeler sürüyordu → canlı mesajlar geçmiş paketlerinin arkasında bekliyordu.
  // (macOS'ta fsync zaten diske kalıcılık garantisi vermez; F_FULLFSYNC gerekir.)
  const writeData = (data: unknown, file: string) =>
    serial(file, async () => {
      const target = path.join(folder, fixFileName(file));
      const tmp = `${target}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
      const fh = await fs.promises.open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(JSON.stringify(data, BufferJSON.replacer));
        if (file === 'creds.json') await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmp, target);
    });
  const readData = (file: string) =>
    serial(file, async () => {
      try {
        return JSON.parse(await fs.promises.readFile(path.join(folder, fixFileName(file)), 'utf8'), BufferJSON.reviver) as unknown;
      } catch {
        return null;
      }
    });
  const removeData = (file: string) => serial(file, () => fs.promises.rm(path.join(folder, fixFileName(file)), { force: true }));

  // önceki çökmeden kalan yarım geçici dosyalar
  for (const f of fs.readdirSync(folder)) if (f.endsWith('.tmp')) fs.rmSync(path.join(folder, f), { force: true });

  const creds = ((await readData('creds.json')) as AuthenticationCreds | null) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = (await readData(`${type}-${id}.json`)) as unknown;
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            const byId = data[category as keyof typeof data] as Record<string, unknown> | undefined;
            for (const id in byId) {
              const value = byId[id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

/**
 * Basit TTL önbelleği (Baileys CacheStore). Modül düzeyinde tutulur: yeniden bağlanmada yeni soket aynı önbelleği alır
 * (WAHA: msgRetryCounterCache her sokette sıfırlanırsa şifre çözme/yeniden deneme döngüleri oluşabiliyor).
 */
export class TtlCache implements CacheStore {
  private m = new Map<string, { v: unknown; exp: number }>();
  constructor(
    private ttlMs: number,
    private max = 5000,
  ) {}
  get<T>(key: string): T | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e.v as T;
  }
  set<T>(key: string, value: T): void {
    if (this.m.size >= this.max) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
    this.m.set(key, { v: value, exp: Date.now() + this.ttlMs });
  }
  del(key: string): void {
    this.m.delete(key);
  }
  flushAll(): void {
    this.m.clear();
  }
}

/**
 * WhatsApp Web sürümü: son başarılı bağlantının sürümü saklanır; yeni sürüm önce web.whatsapp.com'dan, olmazsa Baileys
 * deposundan alınır, asla saklanandan eskisi seçilmez. Bayat sürümle sonsuz 405/408/428 döngüsü önlenir (Baileys #2777, #2691).
 */
export function newerVersion(a?: number[], b?: number[]): number[] | undefined {
  if (!a) return b;
  if (!b) return a;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? a : b;
  return a;
}
