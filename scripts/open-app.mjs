#!/usr/bin/env node
/**
 * `npm run app`: paketlenmiş masaüstü uygulamasını aç (desktop:build'den sonra).
 * macOS: bundle/macos/Mivelo.app · Windows: target/release/kavsak-desktop.exe (yoksa NSIS kurulumu) · Linux: ikili.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release');

function run(cmd, args) {
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

if (process.platform === 'darwin') {
  run('open', [path.join(release, 'bundle', 'macos', 'Mivelo.app')]);
} else if (process.platform === 'win32') {
  const exe = path.join(release, 'kavsak-desktop.exe');
  const nsisDir = path.join(release, 'bundle', 'nsis');
  const setup = fs.existsSync(nsisDir) ? fs.readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe')) : undefined;
  if (fs.existsSync(exe)) run(exe, []);
  else if (setup) run(path.join(nsisDir, setup), []);
  else {
    console.error(`Paket bulunamadı: ${exe}`);
    process.exit(1);
  }
} else {
  run(path.join(release, 'kavsak-desktop'), []);
}
