#!/usr/bin/env node
/**
 * Paketlenmiş masaüstü uygulaması için çekirdeği kendi node_modules'üyle birlikte hazırlar:
 *   apps/desktop/src-tauri/core-bundle/{dist, package.json, node_modules}
 * Tauri bu klasörü uygulama kaynaklarına (Resources/core) kopyalar; uygulama açılınca
 * `node Resources/core/dist/index.js` çalıştırılır.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(root, 'packages', 'core');
const out = path.join(root, 'apps', 'desktop', 'src-tauri', 'core-bundle');
const pkg = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(coreDir, 'dist', 'index.js'))) {
  console.error('Önce çekirdeği derle: npm run build -w packages/core');
  process.exit(1);
}

// dist'i her seferinde tazele; node_modules bağımlılıklar değişmediyse kalsın (hızlı yeniden paketleme)
fs.rmSync(path.join(out, 'dist'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(coreDir, 'dist'), path.join(out, 'dist'), { recursive: true });
// derlenmiş arayüz: çekirdek bunu http://<ip>:7788/ altında sunar (telefondan erişim)
const webDist = path.join(root, 'apps', 'web', 'dist');
fs.rmSync(path.join(out, 'web'), { recursive: true, force: true });
if (fs.existsSync(webDist)) fs.cpSync(webDist, path.join(out, 'web'), { recursive: true });

const bundlePkg = { name: 'kavsak-core-bundle', version: pkg.version, private: true, type: 'module', main: 'dist/index.js', dependencies: pkg.dependencies };
const pkgPath = path.join(out, 'package.json');
const prev = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
const next = JSON.stringify(bundlePkg, null, 2);
const depsChanged = prev !== next || !fs.existsSync(path.join(out, 'node_modules'));
fs.writeFileSync(pkgPath, next);

if (depsChanged) {
  console.log('[bundle-core] üretim bağımlılıkları kuruluyor (ilk seferde birkaç dakika sürebilir)…');
  fs.rmSync(path.join(out, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'package-lock.json'), { force: true });
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: out, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
} else {
  console.log('[bundle-core] bağımlılıklar güncel, yalnızca dist kopyalandı');
}
// .bin altındaki sembolik bağlar paketlemede sorun çıkarabilir; çalışma zamanında gerekmez
for (const dir of ['node_modules/.bin']) fs.rmSync(path.join(out, dir), { recursive: true, force: true });
const size = execSync(`du -sh "${out}" | cut -f1`).toString().trim();
console.log(`[bundle-core] hazır: ${out} (${size})`);
