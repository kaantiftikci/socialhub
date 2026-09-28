#!/usr/bin/env node
/**
 * Yerel otomatik güncelleme + web servisi (macOS).
 *
 *   npm run autodeploy -- install           # iki LaunchAgent: güncelleyici (2 dk) + web servisi (npm run dev, arka planda)
 *   npm run autodeploy -- install --app     # + paketli masaüstü uygulamasını da her güncellemede yeniden paketle
 *   npm run autodeploy -- install --no-web  # yalnız güncelleyici (web servisini kendin başlatırsın)
 *   npm run autodeploy -- uninstall         # ikisini de kaldır
 *   npm run autodeploy -- run               # bir kez şimdi denetle
 *   npm run autodeploy -- restart           # web servisini yeniden başlat
 *   npm run autodeploy -- status            # durum + son günlük satırları
 *
 * Güncelleyici her turda: origin/main'de yeni commit var mı → `git pull --ff-only` → (bağımlılık değiştiyse) npm install +
 * web servisini yeniden başlat → çekirdek derlemesi. Web servisinde tsx watch çekirdeği, Vite arayüzü kendiliğinden yeniler.
 * Masaüstü paketleme yalnız `--app` ile kurulduysa.
 * Güvenlik: main dışındaki dalda ya da izlenen dosyalarda kaydedilmemiş değişiklik varken DOKUNMAZ (yalnız günlüğe yazar);
 * yerel npm'in yeniden yazdığı package-lock.json istisna.
 * Günlükler: ~/.kavsak/autodeploy.log (güncelleyici), ~/.kavsak/web.log (web servisi, 5 MB'ta kırpılır)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const DATA = path.join(os.homedir(), '.kavsak');
const LOG = path.join(DATA, 'autodeploy.log');
const WEB_LOG = path.join(DATA, 'web.log');
const LOCK = path.join(DATA, 'autodeploy.lock');
const CONF = path.join(DATA, 'autodeploy.json');
const AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LABEL = 'app.mivelo.autodeploy';
const WEB_LABEL = 'app.mivelo.web';
const PLIST = path.join(AGENTS, `${LABEL}.plist`);
const WEB_PLIST = path.join(AGENTS, `${WEB_LABEL}.plist`);
const APP = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Mivelo.app');
const BRANCH = 'main';
const WEB_URL = 'http://localhost:5173';

fs.mkdirSync(DATA, { recursive: true });

function readConf() {
  try {
    return { web: false, app: false, ...JSON.parse(fs.readFileSync(CONF, 'utf8')) };
  } catch {
    return { web: false, app: false };
  }
}

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
const uid = () => (process.getuid ? process.getuid() : 0);
const webInstalled = () => fs.existsSync(WEB_PLIST);
/** web servisini yeniden başlat (launchd süreci öldürüp hemen yeniden açar) */
function restartWeb() {
  if (!webInstalled()) return false;
  return spawnSync('launchctl', ['kickstart', '-k', `gui/${uid()}/${WEB_LABEL}`]).status === 0;
}

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
    if (git('merge-base', head, remote) !== head) return skip("atlandı: yerel main origin/main'den ayrışmış (hızlı ileri alınamaz)");
    // package-lock.json'u yerel npm kendisi yeniden yazar (sürüm farkı); senin emeğin değil → yalnız çekilecek commit varken geri alınır,
    // çekimden sonra npm install yeniden üretir
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
    const deps = lockReset || any(/(^|\/)package(-lock)?\.json$/);
    if (deps && !sh('npm', ['install', '--no-audit', '--no-fund'])) return notify('Mivelo güncellenemedi', 'npm install başarısız');
    // çekirdek derlemesi (dist) masaüstü paketi ve verify-strategy için; web servisi kaynaktan (tsx) çalışır
    if (any(/^packages\/core\//) && !sh('npm', ['run', 'build', '-w', 'packages/core'])) log('  çekirdek derlemesi başarısız (web servisi etkilenmez)');

    let note = '';
    // bağımlılık ya da Vite/tsconfig değiştiyse izleyiciler bunu kendisi almaz → web servisini yeniden başlat
    if (deps || any(/(^|\/)(vite\.config\.[jt]s|tsconfig[^/]*\.json)$/)) {
      if (restartWeb()) note = ' · web servisi yeniden başlatıldı';
    }
    // paketli masaüstü uygulaması yalnız `install --app` ile istendiyse
    if (readConf().app && process.platform === 'darwin' && fs.existsSync(APP) && any(/^(apps\/(web|desktop)|packages\/core)\//)) {
      const wasRunning = appRunning();
      if (!sh('npm', ['run', 'desktop:build'], 40 * 60_000)) return notify('Mivelo güncellenemedi', 'Uygulama paketlenemedi — ~/.kavsak/autodeploy.log');
      if (wasRunning) {
        spawnSync('osascript', ['-e', 'quit app "Mivelo"']);
        for (let i = 0; i < 20 && appRunning(); i++) spawnSync('sleep', ['0.5']);
        spawnSync('open', [APP]);
        note += ' · uygulama yeniden başlatıldı';
      } else note += ' · uygulama paketlendi';
    }
    log(`güncellendi → ${remote.slice(0, 7)}${note}`);
    notify('Mivelo güncellendi', `${subjects[0] ?? remote.slice(0, 7)}${subjects.length > 1 ? ` (+${subjects.length - 1})` : ''}${note}`);
  } catch (e) {
    log(`hata: ${e.message}`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

/**
 * Web servisi (LaunchAgent içinden çağrılır): `npm run dev` (çekirdek tsx watch + Vite) çalıştırır, çıktıyı
 * ~/.kavsak/web.log'a yazar (5 MB'ı geçince son 1 MB kalır). Süreç biterse çıkar; launchd yeniden başlatır.
 */
function serve() {
  const out = fs.openSync(WEB_LOG, 'a');
  const write = (buf) => {
    try {
      fs.writeSync(out, buf);
      if (fs.fstatSync(out).size > 5_000_000) {
        const tail = fs.readFileSync(WEB_LOG).subarray(-1_000_000);
        fs.ftruncateSync(out, 0);
        fs.writeSync(out, tail, 0, tail.length, 0);
      }
    } catch {
      /* günlük yazılamadı: servisi düşürme */
    }
  };
  write(`\n[${new Date().toISOString()}] web servisi başlıyor (${ROOT})\n`);
  // FORCE_COLOR=0: günlükte renk kodu olmasın
  const child = spawn('npm', ['run', 'dev'], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  let stopping = false;
  const stop = () => {
    stopping = true;
    try {
      process.kill(-child.pid, 'SIGTERM'); // concurrently + tsx + vite hepsi (süreç grubu)
    } catch {
      /* zaten bitti */
    }
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code, sig) => {
    write(`[${new Date().toISOString()}] web servisi durdu (${code ?? sig})\n`);
    process.exit(stopping ? 0 : (code ?? 1)); // kendiliğinden düştüyse ≠0 → launchd yeniden başlatır
  });
}

function plist(label, args, extra) {
  // launchd kısıtlı PATH ile çalışır: node, npm, git (ve --app için cargo) bulunabilsin
  const PATHS = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.cargo', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${[process.execPath, SELF, ...args].map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc([...new Set(PATHS)].join(':'))}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
${extra}
</dict>
</plist>
`;
}

function load(file, content) {
  spawnSync('launchctl', ['unload', file], { stdio: 'ignore' });
  fs.writeFileSync(file, content);
  const r = spawnSync('launchctl', ['load', '-w', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`launchctl load başarısız (${file}): ${r.stderr}`);
    process.exit(1);
  }
}

const portBusy = (port) => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout?.toString().trim();

function install(flags) {
  if (process.platform !== 'darwin') {
    console.error('Otomatik kurulum yalnız macOS (LaunchAgent). Diğer sistemlerde `npm run autodeploy -- run` komutunu zamanlayıcıya ekle.');
    process.exit(1);
  }
  const conf = { web: !flags.includes('--no-web'), app: flags.includes('--app') };
  fs.mkdirSync(AGENTS, { recursive: true });

  if (conf.web) {
    // elle açılmış `npm run dev` / `npm run desktop` portları tutuyorsa servis açılamaz
    const busy = webInstalled() ? [] : [7788, 5173].filter(portBusy);
    if (busy.length) {
      console.error(`\nPort ${busy.join(', ')} kullanımda: başka bir Terminal'de açık "npm run dev" / "npm run desktop" varsa önce onu kapat (Ctrl+C), sonra komutu tekrarla.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(CONF, JSON.stringify(conf, null, 2));
  if (conf.web) {
    load(
      WEB_PLIST,
      plist(
        WEB_LABEL,
        ['serve'],
        `  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${WEB_LOG}</string>`,
      ),
    );
  } else if (webInstalled()) {
    spawnSync('launchctl', ['unload', '-w', WEB_PLIST], { stdio: 'ignore' });
    fs.rmSync(WEB_PLIST, { force: true });
  }

  load(
    PLIST,
    plist(
      LABEL,
      ['run'],
      `  <key>StartInterval</key><integer>120</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${LOG}</string>`,
    ),
  );
  log(`kuruldu: güncelleyici (2 dk'da bir ${BRANCH})${conf.web ? ' + web servisi' : ''}${conf.app ? ' + masaüstü paketleme' : ''}`);

  if (conf.web) {
    process.stdout.write('\nWeb servisi başlatılıyor');
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      spawnSync('sleep', ['1']);
      up = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '1', WEB_URL]).status === 0;
      if (i % 3 === 0) process.stdout.write('.');
    }
    console.log(up ? ` hazır: ${WEB_URL}` : `\nHenüz yanıt yok; birkaç saniye sonra ${WEB_URL} adresini aç. Sorun olursa: tail -50 ${WEB_LOG}`);
    if (up) spawnSync('open', [WEB_URL]);
  }
  console.log(`\nTamam. Günlükler: ${LOG}${conf.web ? `, ${WEB_LOG}` : ''}\nKaldırmak için: npm run autodeploy -- uninstall`);
}

function uninstall() {
  for (const f of [WEB_PLIST, PLIST]) {
    spawnSync('launchctl', ['unload', '-w', f], { stdio: 'ignore' });
    fs.rmSync(f, { force: true });
  }
  log('kaldırıldı (güncelleyici + web servisi)');
}

function status() {
  const conf = readConf();
  const core = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '2', 'http://127.0.0.1:7788/api/health']).status === 0;
  const ui = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '2', WEB_URL]).status === 0;
  console.log(`Güncelleyici:   ${fs.existsSync(PLIST) ? 'KURULU (2 dk)' : 'kurulu değil'}`);
  console.log(`Web servisi:    ${webInstalled() ? 'KURULU' : 'kurulu değil'} · çekirdek ${core ? 'çalışıyor' : 'yanıt yok'} · arayüz ${ui ? `çalışıyor → ${WEB_URL}` : 'yanıt yok'}`);
  console.log(`Masaüstü paket: ${conf.app ? (fs.existsSync(APP) ? 'her güncellemede yeniden paketlenir' : 'istendi ama paket yok (bir kez npm run app)') : 'kapalı'}`);
  console.log(`Sürüm:          ${git('log', '-1', '--format=%h %s')}`);
  try {
    console.log(`\nSon güncelleyici günlüğü:\n${fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-10).join('\n')}`);
  } catch {
    console.log('\nGüncelleyici günlüğü henüz yok.');
  }
}

const [cmd = 'run', ...flags] = process.argv.slice(2);
if (cmd === 'install') install(flags);
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'status') status();
else if (cmd === 'run') runOnce();
else if (cmd === 'serve') serve();
else if (cmd === 'restart') console.log(restartWeb() ? 'Web servisi yeniden başlatıldı.' : 'Web servisi kurulu değil (npm run autodeploy -- install).');
else {
  console.log('Kullanım: npm run autodeploy -- install [--app] [--no-web] | uninstall | run | restart | status');
  process.exit(1);
}
