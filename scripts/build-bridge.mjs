#!/usr/bin/env node
/**
 * Mivelo köprüsünü (apps/bridge, Go) derler.
 *   node scripts/build-bridge.mjs [çıktı yolu]
 * Varsayılan çıktı apps/bridge/mivelo-bridge[.exe] (geliştirmede çekirdek bunu kullanır). Hedef GOOS/GOARCH ortamdan;
 * CGO gerekir (SQLite + webp): macOS'ta Xcode araçları, Windows'ta MinGW gcc, Linux'ta gcc.
 * Sürüm -ldflags ile gömülür (MIVELO_BRIDGE_VERSION ya da git kısa özeti).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'apps', 'bridge');
const goos = process.env.GOOS || { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
const exe = goos === 'windows' ? '.exe' : '';
const out = path.resolve(process.argv[2] || path.join(src, `mivelo-bridge${exe}`));

const go = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['go']);
if (go.status !== 0) {
  console.error('Go bulunamadı (https://go.dev/dl) — köprü derlenmedi');
  process.exit(2);
}
let version = process.env.MIVELO_BRIDGE_VERSION;
if (!version) {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  version = git.status === 0 ? git.stdout.trim() : 'dev';
}
fs.mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
const r = spawnSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'], {
  cwd: src,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '1', GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'auto' },
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`köprü derlendi: ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} sn, sürüm ${version})`);
