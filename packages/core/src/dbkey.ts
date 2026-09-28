import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, DB_PATH } from './config.js';
import { IS_MAC, IS_WINDOWS } from './platform.js';

/**
 * Veritabanı şifreleme anahtarı (SQLCipher, 32 bayt hex).
 * macOS: Anahtar Zinciri'nde ("mivelo-db" hizmeti) tutulur; diskte anahtar dosyası yok.
 * Windows: DPAPI (CurrentUser) ile şifrelenip ~/.mivelo/db.key.dpapi'ye yazılır; yalnızca aynı Windows kullanıcısı çözebilir
 * (PowerShell + System.Security.Cryptography.ProtectedData; ek bağımlılık yok).
 * Güvenli depo kullanılamazsa (Linux, security/powershell yok) ~/.mivelo/db.key (0600) yedek. Anahtar kaybolursa veritabanı açılamaz.
 */
const SERVICE = 'mivelo-db';
const KEY_FILE = path.join(DATA_DIR, 'db.key');
const DPAPI_FILE = path.join(DATA_DIR, 'db.key.dpapi');

/** Güvenli depo sonucu: anahtar | 'missing' (kayıt yok) | 'denied' (izin verilmedi / okunamadı) | 'none' (bu OS'ta depo yok) */
type SecretResult = string | 'missing' | 'denied' | 'none';

/** Anahtar Zinciri (macOS) */
function fromKeychain(): SecretResult {
  if (!IS_MAC) return 'none';
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
  if (!IS_MAC) return false;
  try {
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', os.userInfo().username, '-w', key, '-T', '/usr/bin/security'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows DPAPI: PowerShell betiği stdin'den okur, stdout'a yazar (anahtar komut satırında görünmez). Betik -EncodedCommand
 * (UTF-16LE base64) ile verilir: tırnak/kaçış sorunu yok. Ek entropi: DPAPI'yi çağıran başka bir uygulama da "mivelo-db"yi bilmeli.
 */
const DPAPI_PRELUDE =
  "Add-Type -AssemblyName System.Security; $e = [System.Text.Encoding]::UTF8.GetBytes('mivelo-db'); $s = [System.Security.Cryptography.DataProtectionScope]::CurrentUser; $in = [Console]::In.ReadToEnd().Trim(); ";
function powershell(script: string, input: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(DPAPI_PRELUDE + script, 'utf16le').toString('base64')], {
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 30_000,
  })
    .toString()
    .trim();
}

function fromDpapi(): SecretResult {
  if (!IS_WINDOWS) return 'none';
  let blob: string;
  try {
    blob = fs.readFileSync(DPAPI_FILE, 'utf8').trim();
  } catch {
    return 'missing';
  }
  try {
    const out = powershell(
      "$b = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $e, $s); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))",
      blob,
    );
    return /^[0-9a-f]{64}$/i.test(out) ? out : 'denied';
  } catch {
    return 'denied';
  }
}

/** Yeni anahtarı DPAPI ile şifreleyip yaz; var olan dosya ASLA üstüne yazılmaz (anahtar değişirse veritabanı açılamaz). */
function toDpapi(key: string): boolean {
  if (!IS_WINDOWS || fs.existsSync(DPAPI_FILE)) return false;
  try {
    const blob = powershell(
      "$b = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($in), $e, $s); [Console]::Out.Write([Convert]::ToBase64String($b))",
      key,
    );
    if (!/^[A-Za-z0-9+/=]{40,}$/.test(blob)) return false;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DPAPI_FILE, blob, { flag: 'wx' });
    // geri okuma denetimi: çözülemiyorsa dosyayı bırakma (düz dosya yedeğine düşülür)
    if (fromDpapi() !== key) {
      fs.rmSync(DPAPI_FILE, { force: true });
      return false;
    }
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

export function getDbKey(dbPath = DB_PATH): string {
  if (process.env.KAVSAK_DB_KEY && /^[0-9a-f]{64}$/i.test(process.env.KAVSAK_DB_KEY)) return process.env.KAVSAK_DB_KEY;
  const kc = IS_WINDOWS ? fromDpapi() : fromKeychain();
  if (kc !== 'missing' && kc !== 'denied' && kc !== 'none') return kc;
  try {
    const f = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(f)) return f;
  } catch {
    /* yok */
  }
  // Anahtar okunamadıysa ve şifreli veritabanı varsa yeni anahtar ÜRETME: veri kalıcı olarak kaybolur
  if (kc === 'denied' && IS_WINDOWS) {
    throw new Error(`Veritabanı anahtarı çözülemedi (${DPAPI_FILE}; DPAPI yalnızca anahtarı oluşturan Windows kullanıcısında çalışır). Anahtar yedeğin varsa KAVSAK_DB_KEY ile ver.`);
  }
  if (kc === 'denied') {
    throw new Error('Veritabanı anahtarı Anahtar Zinciri\'nden okunamadı (izin verilmedi). Mivelo\'yu yeniden başlatıp Anahtar Zinciri penceresinde "Her Zaman İzin Ver"i seçin.');
  }
  if (encryptedDbExists(dbPath)) {
    throw new Error(`Veritabanı şifreli ama anahtarı yok (${IS_WINDOWS ? DPAPI_FILE : `Anahtar Zinciri "${SERVICE}" kaydı`} ve ${KEY_FILE} bulunamadı). Anahtar yedeğin varsa KAVSAK_DB_KEY ile ver; yoksa veritabanı açılamaz.`);
  }
  const key = randomBytes(32).toString('hex');
  if (!(IS_WINDOWS ? toDpapi(key) : toKeychain(key))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  }
  return key;
}
