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

function fromKeychain(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', os.userInfo().username, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return /^[0-9a-f]{64}$/i.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function toKeychain(key: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', os.userInfo().username, '-w', key, '-U', '-T', ''], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getDbKey(): string {
  if (process.env.KAVSAK_DB_KEY && /^[0-9a-f]{64}$/i.test(process.env.KAVSAK_DB_KEY)) return process.env.KAVSAK_DB_KEY;
  const kc = fromKeychain();
  if (kc) return kc;
  try {
    const f = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(f)) return f;
  } catch {
    /* yok */
  }
  const key = randomBytes(32).toString('hex');
  if (!toKeychain(key)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  }
  return key;
}
