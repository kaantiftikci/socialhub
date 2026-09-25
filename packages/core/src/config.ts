import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Tüm veriler kullanıcının makinesinde, ~/.kavsak altında tutulur. */
export const DATA_DIR = process.env.KAVSAK_DATA_DIR ?? path.join(os.homedir(), '.kavsak');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const DB_PATH = path.join(DATA_DIR, 'kavsak.db');

export const PORT = Number(process.env.KAVSAK_PORT ?? 7788);

/** Telegram için my.telegram.org'dan alınan ücretsiz kimlikler. */
// Varsayılan: Telegram Desktop'ın açık kaynak kodunda yayımlanan herkese açık api_id/api_hash; kullanıcı isterse
// Bağlan formundan kendi kimliğini verebilir (my.telegram.org). Böylece giriş WhatsApp gibi yalnızca QR ile olur.
export const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID ?? 2040);
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH ?? 'b18441a1ff607e10a989891a5462e627';

/** İsteğe bağlı: taslak üretimi için Anthropic API anahtarı. Yoksa taslak özelliği kapalı kalır. */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

export const DEMO_MODE = process.argv.includes('--demo') || process.env.KAVSAK_DEMO === '1';

export function ensureDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function sessionDir(accountId: string): string {
  // savunma derinliği: '..' gibi bir kimlik ~/.kavsak'ın kendisine çözülüp registry.remove ile silinebilirdi
  const name = accountId.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (!name || name === '.' || name === '..' || !/^[a-z0-9]+:[A-Za-z0-9_.-]{1,64}$/i.test(name)) throw new Error(`Geçersiz hesap kimliği: ${accountId}`);
  const dir = path.join(SESSIONS_DIR, name);
  if (path.dirname(dir) !== SESSIONS_DIR) throw new Error('Geçersiz oturum dizini');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
