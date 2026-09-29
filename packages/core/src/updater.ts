import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { bus } from './bus.js';

/**
 * Uygulama içi güncelleme (29.09, Kaan: "İndir deyince indirme sayfasına gitmesin, arka planda indirip kursun").
 * Yalnız paketli masaüstü uygulamasında (kabuk MIVELO_APP_VERSION verir, çekirdek .app / kurulum klasöründen çalışır).
 * 1) mivelo.app/indir/files/latest.json → bu işletim sistemi + işlemciye uygun dosya (Mac arm64/intel DMG, Windows kurulum)
 * 2) ~/.mivelo/update/ altına indirilir; boyut ve (varsa) sha256 doğrulanır
 * 3) ayrı (kopuk) betik: Mivelo'yu kapatır → Mac: DMG bağlanır, Mivelo.app yenisiyle değiştirilir (sorun olursa eskisi geri konur)
 *    / Windows: NSIS kurulumu sessiz (/S) → Mivelo yeniden açılır. Günlük ~/.mivelo/update.log.
 * Dosya adı ve adres latest.json'dan körlemesine alınmaz: yalnız bilinen adlar, yalnız mivelo.app.
 * Tauri'nin kendi güncelleyicisi imza anahtarı ister (CI gizlisi); bu yol ek gizli gerektirmez. İmza (Apple) olmadığı için Mac'te
 * Tam Disk Erişimi gibi izinler, elle güncellemedeki gibi yeniden istenebilir.
 */
const BASE = 'https://mivelo.app/indir/files/';
const LATEST = `${BASE}latest.json`;
const DIR = () => path.join(DATA_DIR, 'update');

export type UpdateState = 'idle' | 'downloading' | 'ready' | 'installing' | 'error';
interface Status {
  state: UpdateState;
  supported: boolean;
  current?: string;
  version?: string;
  pct: number;
  error?: string;
}
let status: Status = { state: 'idle', supported: false, pct: 0 };
let file: string | undefined;
/** `file` hangi sürümün paketi (yalnız o sürüm yeniden indirilmez) */
let fileVersion: string | undefined;

/** Bu makine için paket adı */
export function assetName(platform = process.platform, arch = process.arch): string | undefined {
  if (platform === 'darwin') return arch === 'arm64' ? 'Mivelo-mac-arm64.dmg' : 'Mivelo-mac-intel.dmg';
  if (platform === 'win32') return 'Mivelo-windows-x64-setup.exe';
  return undefined;
}

/** Çalışan uygulamanın konumu: Mac'te .app paketi, Windows'ta Mivelo.exe'nin klasörü (çekirdek kaynaklar altında çalışır) */
export function appLocation(execPath = process.execPath, platform = process.platform, exists = fs.existsSync): string | undefined {
  if (platform === 'darwin') {
    const m = execPath.match(/^(.*?\.app)\/Contents\//);
    return m ? m[1] : undefined;
  }
  if (platform === 'win32') {
    let dir = path.win32.dirname(execPath);
    for (let i = 0; i < 5; i++) {
      if (exists(path.win32.join(dir, 'Mivelo.exe'))) return dir;
      const up = path.win32.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export function updateStatus(): Status {
  const current = process.env.MIVELO_APP_VERSION;
  return { ...status, current, supported: !!current && !!assetName() && !!appLocation() };
}

/** Arka planda indir (tek uçuş); ilerleme updateStatus().pct */
export async function downloadUpdate(): Promise<Status> {
  const s = updateStatus();
  if (!s.supported) throw new Error('Uygulama içi güncelleme yalnız kurulu masaüstü uygulamasında çalışır');
  if (status.state === 'downloading' || status.state === 'installing') return updateStatus();
  const name = assetName()!;
  status = { ...status, state: 'downloading', pct: 0, error: undefined };
  void (async () => {
    try {
      const r = await fetch(LATEST, { cache: 'no-store' } as RequestInit);
      if (!r.ok) throw new Error(`Sürüm bilgisi alınamadı (${r.status})`);
      const j = (await r.json()) as { version?: string; files?: Record<string, { size?: number; sha256?: string }> };
      const version = String(j.version ?? '');
      const meta = j.files?.[name];
      if (!/^\d+\.\d+\.\d+$/.test(version) || !meta) throw new Error('Bu cihaz için paket bulunamadı');
      if (s.current && !newer(version, s.current)) throw new Error('Zaten en yeni sürüm kurulu');
      status.version = version;
      if (file && fileVersion === version && fs.existsSync(file)) {
        status = { ...status, state: 'ready', pct: 100 };
        return;
      }
      fs.mkdirSync(DIR(), { recursive: true });
      for (const f of fs.readdirSync(DIR())) fs.rmSync(path.join(DIR(), f), { force: true, recursive: true }); // eski indirmeler
      file = fileVersion = undefined;
      const dest = path.join(DIR(), name);
      const res = await fetch(`${BASE}${name}`, { cache: 'no-store' } as RequestInit);
      if (!res.ok || !res.body) throw new Error(`İndirilemedi (${res.status})`);
      const total = Number(res.headers.get('content-length')) || meta.size || 0;
      const hash = createHash('sha256');
      const out = fs.createWriteStream(`${dest}.part`);
      let got = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length;
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (total) status.pct = Math.min(99, Math.floor((got / total) * 100));
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      if (meta.size && got !== meta.size) throw new Error('İndirilen dosya eksik (boyut tutmuyor)');
      if (meta.sha256 && hash.digest('hex') !== meta.sha256.toLowerCase()) throw new Error('İndirilen dosya doğrulanamadı (sha256)');
      fs.renameSync(`${dest}.part`, dest);
      file = dest;
      fileVersion = version;
      status = { ...status, state: 'ready', pct: 100 };
      bus.log('info', `Güncelleme indirildi: ${version} (${Math.round(got / 1048576)} MB)`);
    } catch (e) {
      status = { ...status, state: 'error', error: (e as Error).message };
      bus.log('warn', `Güncelleme indirilemedi: ${(e as Error).message}`);
    }
  })();
  return updateStatus();
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Mac: kapat → DMG'den yeni .app → değiştir (hata olursa eskisi geri) → aç */
export function macScript(app: string, dmg: string, log: string): string {
  return `#!/bin/bash
APP=${sh(app)}; DMG=${sh(dmg)}; LOG=${sh(log)}
exec >>"$LOG" 2>&1
echo "[$(date)] güncelleme başlıyor"
osascript -e 'tell application id "app.kavsak.desktop" to quit' || true
for i in $(seq 1 60); do pgrep -f "$APP/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
pkill -f "$APP/Contents/MacOS/" 2>/dev/null; pkill -f "$APP/Contents/Resources/core/" 2>/dev/null; sleep 1
MNT=$(mktemp -d /tmp/mivelo-upd.XXXXXX)
if ! hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG"; then echo "DMG açılamadı"; open "$APP"; exit 1; fi
NEW="$APP.yeni"; rm -rf "$NEW"
if ! ditto "$MNT/Mivelo.app" "$NEW"; then echo "kopyalanamadı"; hdiutil detach "$MNT" -quiet; rm -rf "$NEW"; open "$APP"; exit 1; fi
hdiutil detach "$MNT" -quiet || true
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "$APP.eski"
if mv "$APP" "$APP.eski" && mv "$NEW" "$APP"; then rm -rf "$APP.eski"; rm -f "$DMG"; echo "tamam"
else echo "değiştirilemedi, eski sürüm geri"; [ -d "$APP.eski" ] && [ ! -d "$APP" ] && mv "$APP.eski" "$APP"; rm -rf "$NEW"; fi
open "$APP"
`;
}

/** Windows: kapat → sessiz kurulum (/S) → aç */
export function winScript(dir: string, exe: string, log: string): string {
  return `$ErrorActionPreference = 'Continue'
$dir = ${ps(dir)}; $exe = ${ps(exe)}; $log = ${ps(log)}
Add-Content $log "[$(Get-Date)] güncelleme başlıyor"
Start-Sleep -Seconds 2
Get-Process -Name Mivelo -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" } | Stop-Process -Force
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" } | Stop-Process -Force
Start-Sleep -Seconds 2
$p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
Add-Content $log "kurulum çıkış kodu $($p.ExitCode)"
Remove-Item $exe -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $dir 'Mivelo.exe')
`;
}

/** İndirilen sürümü kur: kopuk betik uygulamayı kapatıp yeniler ve yeniden açar */
export function installUpdate(): Status {
  const app = appLocation();
  if (status.state !== 'ready' || !file || !app) throw new Error('Kurulacak güncelleme hazır değil');
  const log = path.join(DATA_DIR, 'update.log');
  let child;
  if (process.platform === 'darwin') {
    const script = path.join(DIR(), 'kur.sh');
    fs.writeFileSync(script, macScript(app, file, log), { mode: 0o700 });
    child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
  } else {
    const script = path.join(DIR(), 'kur.ps1');
    fs.writeFileSync(script, `﻿${winScript(app, file, log)}`);
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true });
  }
  child.unref();
  status = { ...status, state: 'installing' };
  bus.log('info', `Güncelleme kuruluyor: ${status.version} (Mivelo kapanıp yeniden açılacak)`);
  return updateStatus();
}
