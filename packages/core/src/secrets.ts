import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { IS_MAC, IS_WINDOWS } from './platform.js';

/**
 * Uygulama gizli değerleri (ör. kullanıcının Anthropic API anahtarı). Veritabanı anahtarıyla aynı depolar:
 * macOS Anahtar Zinciri ("mivelo-<ad>" hizmeti), Windows DPAPI (CurrentUser, ~/.mivelo/<ad>.dpapi), diğerlerinde
 * ~/.mivelo/<ad>.secret (0600). dbkey.ts'ten farkı: değer güncellenebilir ve silinebilir.
 */
const safeName = (name: string) => name.replace(/[^a-z0-9-]/gi, '');

function ps(script: string, input: string, entropy: string): string {
  const prelude = `Add-Type -AssemblyName System.Security; $e = [System.Text.Encoding]::UTF8.GetBytes('${entropy}'); $s = [System.Security.Cryptography.DataProtectionScope]::CurrentUser; $in = [Console]::In.ReadToEnd().Trim(); `;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(prelude + script, 'utf16le').toString('base64')], {
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 30_000,
  })
    .toString()
    .trim();
}

export function getSecret(name: string): string | null {
  const n = safeName(name);
  if (IS_MAC) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', `mivelo-${n}`, '-a', os.userInfo().username, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      return out || null;
    } catch {
      /* yok ya da izin verilmedi → dosya yedeğine bak */
    }
  }
  if (IS_WINDOWS) {
    try {
      const blob = fs.readFileSync(path.join(DATA_DIR, `${n}.dpapi`), 'utf8').trim();
      const out = ps("$b = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $e, $s); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))", blob, `mivelo-${n}`);
      if (out) return out;
    } catch {
      /* yok */
    }
  }
  try {
    return fs.readFileSync(path.join(DATA_DIR, `${n}.secret`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Değeri yaz (null → sil). Güvenli depo kullanılamazsa 0600 dosyaya yazılır. */
export function setSecret(name: string, value: string | null): void {
  const n = safeName(name);
  const file = path.join(DATA_DIR, `${n}.secret`);
  const dp = path.join(DATA_DIR, `${n}.dpapi`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // önce eski kayıtları temizle (depo değişmiş olabilir)
  fs.rmSync(file, { force: true });
  if (IS_MAC) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', `mivelo-${n}`, '-a', os.userInfo().username], { stdio: 'ignore' });
    } catch {
      /* zaten yok */
    }
  }
  if (IS_WINDOWS) fs.rmSync(dp, { force: true });
  if (value === null) return;
  if (IS_MAC) {
    try {
      execFileSync('security', ['add-generic-password', '-s', `mivelo-${n}`, '-a', os.userInfo().username, '-w', value, '-T', '/usr/bin/security', '-U'], { stdio: 'ignore' });
      return;
    } catch {
      /* dosya yedeğine düş */
    }
  }
  if (IS_WINDOWS) {
    try {
      const blob = ps("$b = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($in), $e, $s); [Console]::Out.Write([Convert]::ToBase64String($b))", value, `mivelo-${n}`);
      if (/^[A-Za-z0-9+/=]{40,}$/.test(blob)) {
        fs.writeFileSync(dp, blob);
        return;
      }
    } catch {
      /* dosya yedeğine düş */
    }
  }
  fs.writeFileSync(file, value, { mode: 0o600 });
}
