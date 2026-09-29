import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { bus } from './bus.js';

/**
 * İşletim sistemi farkları tek yerde. Çekirdek macOS, Windows ve Linux'ta çalışır; Mac'e özgü özellikler
 * (iMessage, macOS Kişiler, Anahtar Zinciri) diğer sistemlerde çökmeden atlanır.
 */
export const IS_MAC = process.platform === 'darwin';
export const IS_WINDOWS = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

/** Kullanıcıya gösterilen ffmpeg kurulum ipucu (günlük satırlarında) */
export const FFMPEG_HINT = IS_WINDOWS ? 'winget install ffmpeg' : IS_MAC ? 'brew install ffmpeg' : 'sudo apt install ffmpeg';

/**
 * Dış bağlantıyı / dosyayı / uygulama şemasını (https://, mailto:, whatsapp://, yerel yol…) sistemin varsayılan
 * uygulamasıyla aç. Hata olursa yalnızca günlüğe yazar; çağıranı bekletmez.
 * darwin → `open`, win32 → `rundll32 url.dll,FileProtocolHandler` (cmd'nin `start`ı & ve ^ içeren adresleri bölüyordu),
 * linux → `xdg-open`.
 */
export function openExternal(target: string): void {
  if (!target) return;
  const [cmd, args]: [string, string[]] = IS_MAC
    ? ['open', [target]]
    : IS_WINDOWS
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : ['xdg-open', [target]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => bus.log('warn', `Dış bağlantı açılamadı (${cmd}): ${e.message}`));
    child.unref();
  } catch (e) {
    bus.log('warn', `Dış bağlantı açılamadı (${cmd}): ${(e as Error).message}`);
  }
}

/**
 * Komut satırında `fragment` geçen süreçleri kapat (ör. profil kilidini tutan eski Chromium: `--user-data-dir=<profil>`).
 * macOS/Linux: pkill -f; Windows: PowerShell + Win32_Process (pkill yok). true = eşleşen süreç kalmadı.
 * Unix'te kalıp `--` ardından ve regex olarak kaçırılmış verilir: `--user-data-dir=…` eskiden seçenek sanılıyordu (pkill
 * "unrecognized/illegal option" ile 2 dönüp hiçbir şeyi öldürmüyordu). SIGTERM'den sonra ≤5 sn beklenir, kalan SIGKILL alır.
 */
export function killProcessesMatching(fragment: string): Promise<boolean> {
  if (IS_WINDOWS) {
    return new Promise<boolean>((resolve) => {
      // tek tırnak PowerShell dizesi: ' → '' ; -like jokerleri ([ ] * ?) kaçırılır; PowerShell'in kendisi (komut satırında
      // kalıp geçer) atlanır
      const pat = fragment.replace(/'/g, "''").replace(/([[\]*?])/g, '`$1');
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${pat}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, () => resolve(true));
    });
  }
  const re = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const run = (cmd: string, args: string[]) =>
    new Promise<number>((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (e) => resolve(e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : -1) : 0));
    });
  // pgrep: 0 = eşleşen var, 1 = yok, diğerleri = sorulamadı (araç yok vb.)
  const alive = async () => (await run('pgrep', ['-f', '--', re])) === 0;
  return (async () => {
    await run('pkill', ['-f', '--', re]);
    for (let i = 0; i < 20; i++) {
      if (!(await alive())) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    await run('pkill', ['-KILL', '-f', '--', re]);
    await new Promise((r) => setTimeout(r, 250));
    return !(await alive());
  })();
}

/**
 * Arayüzdeki profil adı için işletim sistemindeki tam ad (lisans sahibinin adı bilinmiyorsa kullanılır; eskiden her kurulumda
 * sabit "Kaan" yazıyordu). İlk çağrıda arka planda bir kez sorulur (macOS `id -F`, Linux GECOS); o gelene dek kullanıcı adı.
 */
let fullName: string | undefined;
let askedName = false;
export function userDisplayName(): string {
  if (!askedName) {
    askedName = true;
    const take = (v: string | undefined) => {
      const n = (v ?? '').replace(/[\u0000-\u001f]/g, '').trim();
      if (n) fullName = n.slice(0, 80);
    };
    try {
      if (process.platform === 'darwin') execFile('id', ['-F'], { timeout: 3000 }, (e, out) => !e && take(String(out).split('\n')[0]));
      else if (process.platform === 'linux') execFile('getent', ['passwd', os.userInfo().username], { timeout: 3000 }, (e, out) => !e && take(String(out).split(':')[4]?.split(',')[0]));
    } catch {
      /* ad yok: kullanıcı adı */
    }
  }
  if (fullName) return fullName;
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
