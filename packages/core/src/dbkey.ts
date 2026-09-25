import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './config.js';

/**
 * Veritabanı şifreleme anahtarı (SQLCipher, 32 bayt hex).
 * macOS: Anahtar Zinciri'nde ("mivelo-db" hizmeti) tutulur; diskte anahtar dosyası yok. Anahtar Zinciri kullanılamazsa
 * (başka OS, security komutu yok) ~/.kavsak/db.key (0600) yedek. Anahtar kaybolursa veritabanı açılamaz.
 */
const SERVICE = 'mivelo-db';
const KEY_FILE = path.join(DATA_DIR, 'db.key');

/** Anahtar Zinciri sonucu: anahtar | 'missing' (kayıt yok) | 'denied' (izin verilmedi / okunamadı) | 'none' (macOS değil) */
function fromKeychain(): string | 'missing' | 'denied' | 'none' {
  if (process.platform !== 'darwin') return 'none';
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', os.userInfo().username, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return /^[0-9a-f]{64}$/i.test(out) ? out : 'denied';
  } catch (e) {
    // 44 = "could not be found" (kayıt yok); diğer her şey (kullanıcı Reddet dedi, anahtar zinciri kilitli…) → denied
    return (e as { status?: number }).status === 44 ? 'missing' : 'denied';
  }
}

/**
 * Yeni anahtarı Anahtar Zinciri'ne yaz. -T /usr/bin/security: anahtarı okuyan `security` aracı güvenilir uygulama olarak
 * kaydedilir; yoksa her çekirdek açılışında izin penceresi çıkar ("Her Zaman İzin Ver" ile aynı sonuç). Var olan kayıt
 * ASLA üstüne yazılmaz (-U yok): anahtar değişirse veritabanı bir daha açılamaz.
 */
function toKeychain(key: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', os.userInfo().username, '-w', key, '-T', '/usr/bin/security'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Şifrelenmiş (SQLCipher) bir veritabanı zaten var mı: başlığı düz SQLite değilse evet */
function encryptedDbExists(dbPath: string): boolean {
  try {
    const fd = fs.openSync(dbPath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    return !head.toString('latin1').startsWith('SQLite format 3');
  } catch {
    return false;
  }
}

export function getDbKey(dbPath = path.join(DATA_DIR, 'kavsak.db')): string {
  if (process.env.KAVSAK_DB_KEY && /^[0-9a-f]{64}$/i.test(process.env.KAVSAK_DB_KEY)) return process.env.KAVSAK_DB_KEY;
  const kc = fromKeychain();
  if (kc !== 'missing' && kc !== 'denied' && kc !== 'none') return kc;
  try {
    const f = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(f)) return f;
  } catch {
    /* yok */
  }
  // Anahtar okunamadıysa ve şifreli veritabanı varsa yeni anahtar ÜRETME: veri kalıcı olarak kaybolur
  if (kc === 'denied') {
    throw new Error('Veritabanı anahtarı Anahtar Zinciri\'nden okunamadı (izin verilmedi). Mivelo\'yu yeniden başlatıp Anahtar Zinciri penceresinde "Her Zaman İzin Ver"i seçin.');
  }
  if (encryptedDbExists(dbPath)) {
    throw new Error(`Veritabanı şifreli ama anahtarı yok (Anahtar Zinciri "${SERVICE}" kaydı ve ${KEY_FILE} bulunamadı). Anahtar yedeğin varsa KAVSAK_DB_KEY ile ver; yoksa veritabanı açılamaz.`);
  }
  const key = randomBytes(32).toString('hex');
  if (!toKeychain(key)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  }
  return key;
}
