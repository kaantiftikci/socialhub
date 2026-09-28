#!/usr/bin/env node
/**
 * Yerel otomatik güncelleme (macOS): main'e gelen her değişikliği Mac'e kendiliğinden alır.
 *
 *   npm run autodeploy -- install     # LaunchAgent kur (2 dk'da bir denetler, oturum açılınca başlar)
 *   npm run autodeploy -- uninstall   # kaldır
 *   npm run autodeploy -- run         # bir kez şimdi denetle
 *   npm run autodeploy -- status      # durum + son günlük satırları
 *
 * Her turda: origin/main'de yeni commit var mı → `git pull --ff-only` → (bağımlılık değiştiyse) npm install →
 * çekirdek derlemesi → paketli uygulama (Mivelo.app) kuruluysa yeniden paketleyip açıksa yeniden başlatır.
 * `npm run dev` açıksa ek bir şey gerekmez: tsx watch çekirdeği, Vite arayüzü kendiliğinden yeniler.
 * Güvenlik: main dışındaki dalda ya da izlenen dosyalarda kaydedilmemiş değişiklik varken DOKUNMAZ (yalnız günlüğe yazar).
 * Günlük: ~/.kavsak/autodeploy.log
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(os.homedir(), '.kavsak');
const LOG = path.join(DATA, 'autodeploy.log');
const LOCK = path.join(DATA, 'autodeploy.lock');
const LABEL = 'app.mivelo.autodeploy';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const APP = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Mivelo.app');
const BRANCH = 'main';

fs.mkdirSync(DATA, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
  // günlük şişmesin: 1 MB'ı geçince son yarısı kalır
  try {
    if (fs.statSync(LOG).size > 1_000_000) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-500_000));
  } catch {
    /* yok */
  }
}

// aynı "atlandı" nedeni 2 dk'da bir günlüğü doldurmasın: yalnız değişince yazılır
const SKIP = path.join(DATA, 'autodeploy.skip');
function skip(msg) {
  let prev = '';
  try {
    prev = fs.readFileSync(SKIP, 'utf8');
  } catch {
    /* yok */
  }
  if (prev !== msg) log(msg);
  fs.writeFileSync(SKIP, msg);
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sh(cmd, args, timeoutMs = 20 * 60_000) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    log(`  başarısız (${r.status ?? r.signal}): ${out.split('\n').slice(-15).join('\n  ')}`);
    return false;
  }
  return true;
}

function notify(title, text) {
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
}

const appRunning = () => process.platform === 'darwin' && spawnSync('pgrep', ['-f', 'Mivelo.app/Contents/MacOS']).status === 0;

function runOnce() {
  // üst üste binmesin (uzun paketleme sürerken sonraki tur atlanır); 40 dk'dan eski kilit bayat sayılır
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 40 * 60_000) return;
  } catch {
    /* kilit yok */
  }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== BRANCH) return skip(`atlandı: '${branch}' dalındasın (yalnız ${BRANCH} güncellenir)`);
    try {
      git('fetch', '--quiet', 'origin', BRANCH);
    } catch (e) {
      return skip(`fetch başarısız (ağ?): ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    }
    const head = git('rev-parse', 'HEAD');
    const remote = git('rev-parse', `origin/${BRANCH}`);
    if (head === remote) return;
    if (git('merge-base', head, remote) !== head) return skip('atlandı: yerel main origin/main\'den ayrışmış (hızlı ileri alınamaz)');
    // package-lock.json'u yerel npm kendisi yeniden yazar (sürüm farkı); senin emeğin değil → yalnız çekilecek commit varken geri alınır, çekimden sonra npm install yeniden üretir
    const dirty = [...new Set([...git('diff', '--name-only').split('\n'), ...git('diff', '--name-only', '--cached').split('\n')].filter(Boolean))];
    const REGEN = new Set(['package-lock.json']);
    let lockReset = false;
    if (dirty.length && dirty.every((f) => REGEN.has(f))) {
      git('checkout', '--', ...dirty);
      lockReset = true;
    } else if (dirty.length) return skip(`atlandı: kaydedilmemiş yerel değişiklik var (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? '…' : ''}) — git stash ya da commit et`);
    fs.rmSync(SKIP, { force: true });
    const changed = git('diff', '--name-only', head, remote).split('\n').filter(Boolean);
    const subjects = git('log', '--format=%s', `${head}..${remote}`).split('\n').filter(Boolean);
    log(`${subjects.length} yeni commit: ${subjects.join(' | ')}`);
    if (!sh('git', ['pull', '--ff-only', '--quiet', 'origin', BRANCH])) return notify('Mivelo güncellenemedi', 'git pull başarısız — ~/.kavsak/autodeploy.log');

    const any = (re) => changed.some((f) => re.test(f));
    if ((lockReset || any(/(^|\/)package(-lock)?\.json$/)) && !sh('npm', ['install', '--no-audit', '--no-fund'])) return notify('Mivelo güncellenemedi', 'npm install başarısız');
    if (any(/^packages\/core\//) && !sh('npm', ['run', 'build', '-w', 'packages/core'])) return notify('Mivelo güncellenemedi', 'Çekirdek derlemesi başarısız');

    let appNote = '';
    // paketli uygulama kuruluysa ve uygulamayı etkileyen bir şey değiştiyse yeniden paketle
    if (process.platform === 'darwin' && fs.existsSync(APP) && any(/^(apps\/(web|desktop)|packages\/core)\//)) {
      const wasRunning = appRunning();
      if (!sh('npm', ['run', 'desktop:build'], 40 * 60_000)) return notify('Mivelo güncellenemedi', 'Uygulama paketlenemedi — ~/.kavsak/autodeploy.log');
      if (wasRunning) {
        spawnSync('osascript', ['-e', 'quit app "Mivelo"']);
        for (let i = 0; i < 20 && appRunning(); i++) spawnSync('sleep', ['0.5']);
        spawnSync('open', [APP]);
        appNote = ' · uygulama yeniden başlatıldı';
      } else appNote = ' · uygulama paketlendi';
    }
    log(`güncellendi → ${remote.slice(0, 7)}${appNote}`);
    notify('Mivelo güncellendi', `${subjects[0] ?? remote.slice(0, 7)}${subjects.length > 1 ? ` (+${subjects.length - 1})` : ''}${appNote}`);
  } catch (e) {
    log(`hata: ${e.message}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

function install() {
  if (process.platform !== 'darwin') {
    console.error('Otomatik kurulum yalnız macOS (LaunchAgent). Diğer sistemlerde `npm run autodeploy -- run` komutunu zamanlayıcıya ekle.');
    process.exit(1);
  }
  // launchd kısıtlı PATH ile çalışır: node, npm, git, cargo (Tauri) bulunabilsin
  const PATHS = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.cargo', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(fileURLToPath(import.meta.url))}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc([...new Set(PATHS)].join(':'))}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  spawnSync('launchctl', ['unload', PLIST], { stdio: 'ignore' });
  fs.writeFileSync(PLIST, plist);
  const r = spawnSync('launchctl', ['load', '-w', PLIST], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`launchctl load başarısız: ${r.stderr}`);
    process.exit(1);
  }
  log(`kuruldu: ${PLIST} (2 dk'da bir ${BRANCH} denetlenir)`);
  console.log(`\nTamam. Günlük: ${LOG}\nKaldırmak için: npm run autodeploy -- uninstall`);
}

function uninstall() {
  spawnSync('launchctl', ['unload', '-w', PLIST], { stdio: 'ignore' });
  fs.rmSync(PLIST, { force: true });
  log('kaldırıldı');
}

function status() {
  const on = fs.existsSync(PLIST);
  console.log(`Otomatik güncelleme: ${on ? 'KURULU' : 'kurulu değil'}${on ? ` (${PLIST})` : ''}`);
  console.log(`Paketli uygulama: ${fs.existsSync(APP) ? APP : 'yok (yalnız kaynak + çekirdek derlemesi güncellenir)'}`);
  try {
    console.log(`\nSon günlük:\n${fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-12).join('\n')}`);
  } catch {
    console.log('\nGünlük henüz yok.');
  }
}

const cmd = process.argv[2] ?? 'run';
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'status') status();
else if (cmd === 'run') runOnce();
else {
  console.log('Kullanım: npm run autodeploy -- install | uninstall | run | status');
  process.exit(1);
}
