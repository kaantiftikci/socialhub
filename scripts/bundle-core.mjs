#!/usr/bin/env node
/**
 * Paketlenmiş masaüstü uygulaması için çekirdeği kendi node_modules'üyle birlikte hazırlar:
 *   apps/desktop/src-tauri/core-bundle/{dist, package.json, node_modules}
 * Tauri bu klasörü uygulama kaynaklarına (Resources/core) kopyalar; uygulama açılınca
 * `node Resources/core/dist/index.js` çalıştırılır.
 *
 * Çapraz platform (macOS/Windows/Linux): yalnızca Node fs kullanılır (cp/du/ditto yok). Yerel modüller
 * (better-sqlite3, better-sqlite3-multiple-ciphers) `npm install` sırasında o makinenin OS/mimarisi için hazır ikili
 * (prebuild) indirir, yoksa node-gyp ile derlenir — Windows paketi bu yüzden Windows'ta (CI: windows-latest) üretilmeli.
 * KAVSAK_BUNDLE_NODE=1: bu betiği çalıştıran node ikilisi de core-bundle/bin/node[.exe] olarak eklenir; masaüstü
 * kabuğu önce onu kullanır (kullanıcıda Node kurulu olmasa da çalışır; yerel modüllerin ABI'si aynı node'la uyumlu).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// Aralıklar (^7.0.0-rc14 …) yerine testlerin ve geliştirmenin kullandığı, kök kilitten (`npm ci`) kurulu TAM sürümler: paket
// her derlemede o günün en yeni sürümlerini çözmesin (denenmemiş Baileys/imapflow sürümü DMG/EXE'ye girmesin, matris işleri
// aynı sürümü taşısın). Kurulu değilse aralık kalır.
const dependencies = {};
for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
  const f = [path.join(coreDir, 'node_modules', dep, 'package.json'), path.join(root, 'node_modules', dep, 'package.json')].find((p) => fs.existsSync(p));
  let version = null;
  try {
    version = f ? JSON.parse(fs.readFileSync(f, 'utf8')).version : null;
  } catch {
    /* okunamadı: aralık */
  }
  dependencies[dep] = typeof version === 'string' && version ? version : range;
  if (dependencies[dep] === range) console.warn(`[bundle-core] uyarı: ${dep} kurulu bulunamadı, aralık kullanılıyor (${range})`);
}
const bundlePkg = { name: 'kavsak-core-bundle', version: pkg.version, private: true, type: 'module', main: 'dist/index.js', dependencies };
const pkgPath = path.join(out, 'package.json');
const prev = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf8') : '';
const next = JSON.stringify(bundlePkg, null, 2);
// Yerel modüller (better-sqlite3…) bu node'un ABI'siyle kurulur. Masaüstü kabuğu core/node-abi.json'u okuyup ABI'si
// tutan node'u seçer (önce execPath). Node sürümü değişince (ABI farklı) node_modules yeniden kurulur.
const abiPath = path.join(out, 'node-abi.json');
const abi = { modules: process.versions.modules, version: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath };
let prevAbi = null;
try {
  prevAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
} catch {
  /* ilk paketleme */
}
const abiChanged = !prevAbi || prevAbi.modules !== abi.modules || prevAbi.platform !== abi.platform || prevAbi.arch !== abi.arch;
const depsChanged = prev !== next || abiChanged || !fs.existsSync(path.join(out, 'node_modules'));
fs.writeFileSync(pkgPath, next);

if (depsChanged) {
  console.log(`[bundle-core] üretim bağımlılıkları kuruluyor (node ${process.version}, ABI ${abi.modules}; ilk seferde birkaç dakika sürebilir)…`);
  fs.rmSync(path.join(out, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'package-lock.json'), { force: true });
  fs.rmSync(abiPath, { force: true }); // kurulum yarıda kalırsa bir sonraki çalıştırma yeniden kursun
  // npm, PATH'teki node ile değil bu betiği çalıştıran node ile derlesin/ikili seçsin (ABI tutarlılığı)
  // (Windows'ta anahtar "Path" olabilir: var olan adla yaz, ikinci bir PATH ekleme)
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  env[pathKey] = [path.dirname(process.execPath), process.env[pathKey] ?? ''].join(path.delimiter);
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: out, stdio: 'inherit', env });
} else {
  console.log('[bundle-core] bağımlılıklar güncel, yalnızca dist kopyalandı');
}
// .bin altındaki sembolik bağlar paketlemede sorun çıkarabilir; çalışma zamanında gerekmez
for (const dir of ['node_modules/.bin']) fs.rmSync(path.join(out, dir), { recursive: true, force: true });

fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2));

// İsteğe bağlı gömülü node (Windows CI paketi): kabuk Resources/core/bin/node[.exe]'yi önce dener
const nodeOut = path.join(out, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
if (process.env.KAVSAK_BUNDLE_NODE === '1') {
  fs.mkdirSync(path.dirname(nodeOut), { recursive: true });
  fs.copyFileSync(process.execPath, nodeOut);
  if (process.platform !== 'win32') fs.chmodSync(nodeOut, 0o755);
  console.log(`[bundle-core] node ${process.version} eklendi: ${nodeOut}`);
} else {
  fs.rmSync(path.join(out, 'bin'), { recursive: true, force: true });
}

// Beeper (mautrix) köprüsü (apps/bridge, Go): core/bin/mivelo-bridge[.exe]. Go yoksa atlanır (çekirdek ilk açılışta
// mivelo.app'ten indirir); MIVELO_BUNDLE_BRIDGE=1 (CI) derlenemezse paketlemeyi durdurur, =0 hiç denemez.
if (process.env.MIVELO_BUNDLE_BRIDGE !== '0') {
  const goos = process.env.GOOS || { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const bridgeOut = path.join(out, 'bin', goos === 'windows' ? 'mivelo-bridge.exe' : 'mivelo-bridge');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-bridge.mjs'), bridgeOut], { stdio: 'inherit' });
  if (r.status !== 0) {
    if (process.env.MIVELO_BUNDLE_BRIDGE === '1') {
      console.error('[bundle-core] köprü derlenemedi');
      process.exit(1);
    }
    console.warn('[bundle-core] köprü pakete eklenmedi (Go yok ya da derleme hatası); uygulama ilk açılışta indirir');
  }
}

/** Klasör boyutu (du yerine; Windows'ta da çalışır). Sembolik bağlar izlenmez. */
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}
const size = `${Math.round(dirSize(out) / 1048576)} MB`;
console.log(`[bundle-core] hazır: ${out} (${size})`);
