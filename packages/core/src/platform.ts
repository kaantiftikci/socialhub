import { execFile, spawn } from 'node:child_process';
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
 * macOS/Linux: pkill -f; Windows: PowerShell + Win32_Process (pkill yok). Hata sessizce yutulur.
 */
export function killProcessesMatching(fragment: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (IS_WINDOWS) {
      // tek tırnak PowerShell dizesi: ' → '' ; -like jokerleri ([ ] * ?) kaçırılır
      const pat = fragment.replace(/'/g, "''").replace(/([[\]*?])/g, '`$1');
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pat}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => resolve());
    } else {
      execFile('pkill', ['-f', fragment], () => resolve());
    }
  });
}
