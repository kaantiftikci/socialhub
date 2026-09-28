import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Tüm veriler kullanıcının makinesinde, ~/.mivelo altında tutulur (eski adı ~/.mivelo; ilk açılışta taşınır). */
export const DATA_DIR = process.env.MIVELO_DATA_DIR ?? process.env.KAVSAK_DATA_DIR ?? migrateDataDir(path.join(os.homedir(), '.mivelo'), path.join(os.homedir(), '.kavsak'));
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const DB_PATH = migrateDb(path.join(DATA_DIR, 'mivelo.db'), path.join(DATA_DIR, 'kavsak.db'));

/**
 * Eski veri klasörü (~/.mivelo) → ~/.mivelo. Öğe öğe taşınır (aynı disk: anlık rename, açık dosyalar etkilenmez); eski yol
 * ~/.mivelo'ya sembolik bağ olur — eski betikler/LaunchAgent/masaüstü kabuğu eski yolu kullansa da aynı yere yazar. Yeni
 * klasörde aynı adlı öğe varsa eskisi yerinde kalır (bir sonraki açılışta yeniden denenir); hata taşımayı durdurur, veri silinmez.
 */
function migrateDataDir(dir: string, old: string): string {
  try {
    const st = fs.lstatSync(old, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(old)) {
      if (fs.existsSync(path.join(dir, name))) {
        // günlükler ve kilitler yenide zaten var (güncelleyici/masaüstü kabuğu önce yazmış olabilir): eskisi atılır
        if (/\.(log|lock|skip)$/.test(name)) fs.rmSync(path.join(old, name), { force: true });
        continue;
      }
      fs.renameSync(path.join(old, name), path.join(dir, name));
    }
    if (fs.readdirSync(old).length === 0) {
      fs.rmdirSync(old);
      if (process.platform !== 'win32') fs.symlinkSync(dir, old);
    }
    console.log(`Veri klasörü taşındı: ${old} → ${dir}`);
  } catch (e) {
    console.warn(`Veri klasörü taşınamadı (${(e as Error).message}); kalan öğeler bir sonraki açılışta denenir`);
  }
  return dir;
}

/** Veritabanı dosyası kavsak.db → mivelo.db (WAL/SHM eşleriyle; çekirdek açmadan önce) */
function migrateDb(file: string, old: string): string {
  try {
    if (!fs.existsSync(file) && fs.existsSync(old)) {
      for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(old + ext)) fs.renameSync(old + ext, file + ext);
    }
  } catch (e) {
    console.warn(`Veritabanı adı değiştirilemedi (${(e as Error).message}); eski ad kullanılıyor`);
    return old;
  }
  return file;
}

export const PORT = Number(process.env.KAVSAK_PORT ?? 7788);

/** Telegram için my.telegram.org'dan alınan ücretsiz kimlikler. */
// Varsayılan: Mivelo'nun kendi uygulama kimliği (my.telegram.org, "Mivelo", Desktop). Başka bir istemcinin (ör. Telegram
// Desktop 2040) kimliğini kullanmak Telegram API şartlarına aykırı ve hesap riskini artırıyordu. Masaüstü istemcilerde
// olduğu gibi pakete gömülür; ortam değişkeni ya da Bağlan formundaki kendi kimlik alanları bunu geçersiz kılar.
export const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 31111230);
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? 'c0573504f4020d3af5a3bec44d33eda8';

/** İsteğe bağlı: taslak üretimi için Anthropic API anahtarı. Yoksa taslak özelliği kapalı kalır. */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

export const DEMO_MODE = process.argv.includes('--demo') || process.env.KAVSAK_DEMO === '1';

export function ensureDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function sessionDir(accountId: string): string {
  // savunma derinliği: '..' gibi bir kimlik ~/.mivelo'nun kendisine çözülüp registry.remove ile silinebilirdi
  const name = accountId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (!name || name === '.' || name === '..' || !/^[a-z0-9]+:[A-Za-z0-9_.-]{1,64}$/i.test(name)) throw new Error(`Geçersiz hesap kimliği: ${accountId}`);
  // Windows: ':' dosya/klasör adında geçersiz (NTFS alternatif veri akışı) → '_'; macOS/Linux'ta mevcut klasör adları korunur
  const dir = path.join(SESSIONS_DIR, process.platform === 'win32' ? name.replace(/:/g, '_') : name);
  if (path.dirname(dir) !== SESSIONS_DIR) throw new Error('Geçersiz oturum dizini');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
