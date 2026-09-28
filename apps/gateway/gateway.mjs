#!/usr/bin/env node
// Mivelo sunucu çekirdeği ağ geçidi (demo üyeleri için; bağımlılıksız: node:http, node:net, node:crypto, node:child_process)
//
// Her demo üyesine AYRI bir Mivelo çekirdeği (packages/core/dist/index.js, MIVELO_SERVER=1) ve ayrı veri klasörü
// (<USERS_DIR>/<uid>). İstemci (demo.mivelo.app) demo PHP arka ucunun imzaladığı belirteci x-kavsak-token başlığında ya da
// ?token= ile yollar; ağ geçidi doğrular, üyenin çekirdeğini gerekirse başlatır ve isteği o çekirdeğin KENDİ belirteciyle
// aktarır (gelen belirteç çekirdeğe gitmez).
//
//   GET  /gw/health       → {ok:true, cores:<çalışan çekirdek>}  (yetkisiz)
//   POST /gw/delete-user  → üyenin çekirdeğini durdurur, veri klasörünü siler (x-gw-sig imzalı; sunucudan sunucuya)
//   *    /api/*           → çekirdeğe olduğu gibi
//   GET  /ws (upgrade)    → çekirdeğin olay akışı
//
// Ortam: CORE_SECRET (≥32, zorunlu), ALLOWED_ORIGINS (virgüllü; varsayılan https://demo.mivelo.app), USERS_DIR
// (/var/lib/mivelo/users), GATEWAY_HOST (127.0.0.1), GATEWAY_PORT (8787), CORE_PORT_BASE (17000), CORE_PORT_COUNT (1000),
// MAX_CORES (12), IDLE_MINUTES (720), DISPLAY (Xvfb, ör. :99), PLAYWRIGHT_BROWSERS_PATH, CORE_ENTRY, NODE_BIN,
// CORE_EXTRA_ENV (çekirdeğe ayrıca geçirilecek değişken adları, virgüllü).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UID_RE, verify, verifyDelete } from './token.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../..');
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const CFG = {
  secret: env.CORE_SECRET ?? '',
  host: env.GATEWAY_HOST || '127.0.0.1',
  port: num(env.GATEWAY_PORT, 8787),
  usersDir: path.resolve(env.USERS_DIR || '/var/lib/mivelo/users'),
  entry: path.resolve(env.CORE_ENTRY || path.join(REPO, 'packages/core/dist/index.js')),
  nodeBin: env.NODE_BIN || process.execPath,
  portBase: num(env.CORE_PORT_BASE, 17000),
  portCount: Math.max(1, num(env.CORE_PORT_COUNT, 1000)),
  maxCores: Math.max(1, num(env.MAX_CORES, 12)),
  idleMs: Math.max(0.05, num(env.IDLE_MINUTES, 720)) * 60_000,
  origins: new Set((env.ALLOWED_ORIGINS ?? 'https://demo.mivelo.app').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)),
  startTimeoutMs: 60_000,
  stopGraceMs: 10_000,
  logMax: 5 * 1024 * 1024,
};

const MSG = {
  unauthorized: 'Oturum geçersiz ya da süresi dolmuş; sayfayı yenile',
  full: 'Sunucu şu an dolu; birkaç dakika sonra yeniden dene',
  starting: 'Çekirdek başlatılamadı; birazdan yeniden dene',
  backoff: 'Çekirdek yeniden başlatılıyor; birkaç saniye sonra yeniden dene',
  deleting: 'Bu üyenin verileri siliniyor',
  unreachable: 'Çekirdeğe ulaşılamadı; sayfayı yenile',
  origin: 'Bu kaynaktan erişim yok',
  notFound: 'Yol yok',
};

const log = (text) => console.log(`${new Date().toISOString()} ${text}`);
const secs = (ms) => (ms / 1000).toFixed(1).replace('.', ',');

class GwError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/* ---------------- çekirdek yönetimi ---------------- */

/** @typedef {{ uid: string, dir: string, port: number, child?: import('node:child_process').ChildProcess, token: string, state: 'starting'|'ready'|'stopping', ready: Promise<any>, exited: Promise<void>, startedAt: number, lastActive: number, inflight: number, ws: number, stopReason?: string, failed?: boolean }} Core */
/** @type {Map<string, Core>} */
const cores = new Map();
/** Çöken çekirdekler: art arda hızlı çöküşte üstel bekleme (uid → {fails, until}) */
const crashes = new Map();
/** Verisi silinmekte olan üyeler: bu sırada çekirdek başlatılmaz */
const deleting = new Set();
/** Açık WebSocket soketleri (kapanışta kesilir) */
const sockets = new Set();
let nextPort = 0;
let lastFullLog = 0;
let closing = false;

const userDir = (uid) => {
  const dir = path.resolve(CFG.usersDir, uid);
  // yol kaçışına karşı: yalnız USERS_DIR'in doğrudan alt klasörü
  if (!UID_RE.test(uid) || path.dirname(dir) !== CFG.usersDir || path.basename(dir) !== uid) throw new GwError(400, 'Geçersiz üye');
  return dir;
};
const runningCount = () => [...cores.values()].filter((c) => c.state !== 'stopping').length;
const readyCount = () => [...cores.values()].filter((c) => c.state === 'ready').length;

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Aralıktan boş port (sırayla dönerek: yeni kapanan port hemen yeniden verilmez) */
async function allocPort() {
  const used = new Set([...cores.values()].map((c) => c.port));
  for (let i = 0; i < CFG.portCount; i++) {
    const off = (nextPort + i) % CFG.portCount;
    const port = CFG.portBase + off;
    if (used.has(port) || !(await portFree(port))) continue;
    nextPort = (off + 1) % CFG.portCount;
    return port;
  }
  throw new GwError(503, MSG.full);
}

/**
 * Çekirdek günlüğü <dir>/core.log: çekirdeğin stdout/stderr'i doğrudan dosyaya (O_APPEND; boru yok → ağ geçidi yeniden
 * başlasa da çekirdek EPIPE'e düşmez). 5 MB'ı geçince içeriği core.log.1'e kopyalanıp dosya kırpılır (en çok ~10 MB).
 */
function rotateLog(dir) {
  const file = path.join(dir, 'core.log');
  try {
    if (fs.statSync(file).size <= CFG.logMax) return;
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
  } catch {
    /* yok / yazılamadı */
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Linux: komut satırında `needle` geçen süreçler (ör. üyenin Chromium'ları: --user-data-dir=<dir>/sessions/…) */
function pidsMatching(needle) {
  if (process.platform !== 'linux') return [];
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(needle)) out.push(Number(d));
    } catch {
      /* süreç bitti / erişim yok */
    }
  }
  return out;
}

/** Üyenin klasörünü kullanan artık süreçleri (çekirdek + Chromium) öldür: önceki ağ geçidinden kalmış olabilir.
 *  Üye başına tek uçuş: açılış taraması sürerken gelen istek de kapanmanın bitmesini bekler (aynı klasörde iki çekirdek olmasın). */
const staleKills = new Map();
function killStale(uid, dir) {
  let p = staleKills.get(uid);
  if (!p) {
    p = killStaleNow(uid, dir).finally(() => staleKills.delete(uid));
    staleKills.set(uid, p);
  }
  return p;
}
async function killStaleNow(uid, dir) {
  const pidFile = path.join(dir, 'core.pid');
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  } catch {
    /* yok */
  }
  if (pid > 1 && alive(pid)) {
    let ours = process.platform !== 'linux';
    try {
      // pid yeniden kullanılmış olabilir: yalnız bu üyenin çekirdeğiyse (komut + veri klasörü) dokun
      ours = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(CFG.entry) && fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`MIVELO_DATA_DIR=${dir}`);
    } catch {
      /* okunamadı */
    }
    if (ours) {
      log(`${uid}: önceki oturumdan kalan çekirdek (pid ${pid}) kapatılıyor`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* bitti */
      }
      for (let i = 0; i < CFG.stopGraceMs / 250 && alive(pid); i++) await sleep(250);
      if (alive(pid)) killGroup(pid, 'SIGKILL');
    }
  }
  fs.rmSync(pidFile, { force: true });
  killBrowsers(dir);
}

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig); // çekirdek kendi süreç grubunda (detached): ffmpeg vb. çocuklar da
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* bitti */
    }
  }
}

/** Çekirdek öldürüldüyse Chromium'ları (Playwright kendi grubunda açar) sahipsiz kalmasın */
function killBrowsers(dir) {
  for (const pid of pidsMatching(`--user-data-dir=${path.join(dir, 'sessions')}${path.sep}`)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* bitti */
    }
  }
}

/** Çekirdeğe iç istek (sağlık denetimi) */
function coreHealth(port, token) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `127.0.0.1:${port}`, 'x-kavsak-token': token }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(false));
  });
}

/** Çekirdeğe geçen ortam: yalnız izin listesi (CORE_SECRET, ANTHROPIC_API_KEY gibi ağ geçidi değişkenleri GİTMEZ) */
function coreEnv(dir, port) {
  const e = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    // Chromium'un ~/.pki, ~/.cache, ~/.config yazıları da üyeye ayrı kalsın
    HOME: path.join(dir, 'home'),
    LANG: env.LANG || 'C.UTF-8',
    TZ: env.TZ || 'Europe/Istanbul',
    NODE_ENV: 'production',
    MIVELO_DATA_DIR: dir,
    KAVSAK_PORT: String(port),
    MIVELO_SERVER: '1',
    MIVELO_LOGIN_EMBED: '1',
    // HOME değiştiği için Playwright'ın varsayılan (~/.cache/ms-playwright) yolu ağ geçidi kullanıcısınınkine sabitlenir
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'),
  };
  const pass = ['DISPLAY', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'KAVSAK_CHROMIUM', 'KAVSAK_HEADLESS', 'MIVELO_HEADFUL', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'MIVELO_WA_GAPFILL'];
  for (const k of [...pass, ...(env.CORE_EXTRA_ENV ?? '').split(',').map((s) => s.trim())]) if (k && env[k] !== undefined && !(k in e)) e[k] = env[k];
  return e;
}

/** Üyenin çekirdeği hazır olana dek bekle (gerekirse başlat). Aynı üyenin eşzamanlı ilk istekleri tek başlatmayı paylaşır. */
async function ensureCore(uid) {
  for (;;) {
    if (closing) throw new GwError(503, MSG.backoff, 5);
    if (deleting.has(uid)) throw new GwError(409, MSG.deleting);
    const c = cores.get(uid);
    if (c?.state === 'ready') return c;
    if (c?.state === 'starting') return c.ready;
    if (c?.state === 'stopping') {
      await c.exited;
      continue;
    }
    const cr = crashes.get(uid);
    if (cr && cr.until > Date.now()) throw new GwError(503, MSG.backoff, Math.ceil((cr.until - Date.now()) / 1000));
    if (runningCount() >= CFG.maxCores) {
      if (Date.now() - lastFullLog > 60_000) {
        lastFullLog = Date.now();
        log(`Sunucu dolu (${runningCount()}/${CFG.maxCores} çekirdek): yeni üyeler bekletiliyor (MAX_CORES)`);
      }
      throw new GwError(503, MSG.full, 60);
    }
    return startCore(uid).ready;
  }
}

function startCore(uid) {
  const dir = userDir(uid);
  /** @type {Core} */
  const c = { uid, dir, port: 0, child: undefined, token: '', state: 'starting', startedAt: Date.now(), lastActive: Date.now(), inflight: 0, ws: 0 };
  let markExited;
  c.exited = new Promise((r) => (markExited = r));
  let isGone = false;
  /** Kayıt defterinden düş (tek sefer): çıkış, çalıştırılamama ya da süreç hiç başlamadan hata */
  const gone = () => {
    if (isGone) return;
    isGone = true;
    if (cores.get(uid) === c) cores.delete(uid);
    markExited();
  };
  cores.set(uid, c);
  c.ready = (async () => {
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    await killStale(uid, dir);
    c.port = await allocPort();
    if (c.state === 'stopping') throw new GwError(503, MSG.backoff, 5); // hazırlık sırasında durduruldu (kapanış/silme)
    log(`${uid}: çekirdek başlatılıyor (port ${c.port})`);
    rotateLog(dir);
    const fd = fs.openSync(path.join(dir, 'core.log'), 'a', 0o600);
    let child;
    try {
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} ağ geçidi başlattı (port ${c.port}) =====\n`);
      // kendi süreç grubunda (detached): durdururken ffmpeg vb. çocuklarıyla birlikte öldürülebilsin; Ctrl+C doğrudan ona gitmez
      child = spawn(CFG.nodeBin, [CFG.entry], { cwd: dir, env: coreEnv(dir, c.port), stdio: ['ignore', fd, fd], detached: true });
    } finally {
      fs.closeSync(fd);
    }
    c.child = child;
    let exitInfo;
    const onExit = (code, signal) => {
      if (exitInfo) return;
      exitInfo = { code, signal };
      fs.rmSync(path.join(dir, 'core.pid'), { force: true });
      if (child.pid) killGroup(child.pid, 'SIGKILL'); // gruptaki artıklar
      killBrowsers(dir);
      const wasReady = c.state === 'ready';
      if (c.stopReason && !c.failed) {
        log(`${uid}: çekirdek durdu (${c.stopReason})`);
      } else {
        // beklenmedik çıkış: sonraki istekte yeniden başlar; art arda hızlı çöküşte bekleme katlanır (5 sn → … ≤5 dk)
        const quick = Date.now() - c.startedAt < 10 * 60_000;
        const fails = quick ? (crashes.get(uid)?.fails ?? 0) + 1 : 1;
        const wait = fails <= 1 ? 0 : Math.min(5_000 * 2 ** (fails - 2), 300_000);
        crashes.set(uid, { fails, until: Date.now() + wait });
        log(`${uid}: çekirdek ${wasReady ? 'çöktü' : 'açılamadı'} (${signal ?? `kod ${code}`})${wait ? ` — ${fails}. kez, ${secs(wait)} sn sonra yeniden` : ' — sonraki istekte yeniden başlar'}; ayrıntı ${path.join(dir, 'core.log')}`);
      }
      gone();
    };
    child.on('exit', onExit);
    child.on('error', (e) => {
      log(`${uid}: çekirdek çalıştırılamadı: ${e.message}`);
      if (!child.pid) onExit(null, null); // spawn başarısız: 'exit' gelmeyebilir
    });
    // ağ geçidi yeniden başlarsa artık çekirdek bulunabilsin (killStale)
    if (child.pid) {
      try {
        fs.writeFileSync(path.join(dir, 'core.pid'), String(child.pid), { mode: 0o600 });
      } catch {
        /* yazılamadı: çekirdek yine çalışır */
      }
    }
    // hazır: belirteç dosyası yazıldı ve /api/health yanıt veriyor
    const deadline = Date.now() + CFG.startTimeoutMs;
    for (let wait = 150; ; wait = Math.min(wait * 1.5, 1000)) {
      if (exitInfo) throw new GwError(503, MSG.starting);
      if (c.state === 'stopping') throw new GwError(503, MSG.backoff, 5);
      if (!c.token) {
        try {
          const t = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
          if (t.length >= 32) c.token = t;
        } catch {
          /* henüz yazılmadı */
        }
      }
      if (c.token && (await coreHealth(c.port, c.token))) break;
      if (Date.now() > deadline) {
        log(`${uid}: çekirdek ${CFG.startTimeoutMs / 1000} sn içinde hazır olmadı; durduruluyor`);
        c.failed = true;
        void stopCore(c, 'açılış zaman aşımı');
        throw new GwError(503, MSG.starting);
      }
      await sleep(wait);
    }
    if (c.state !== 'starting') throw new GwError(503, MSG.backoff, 5);
    c.state = 'ready';
    c.lastActive = Date.now();
    log(`${uid}: çekirdek hazır (${secs(Date.now() - c.startedAt)} sn, pid ${child.pid})`);
    return c;
  })();
  c.ready.catch((e) => {
    // süreç hiç başlamadı (port yok, klasör yazılamadı, çalıştırılamadı): kaydı bırak
    if (!c.child?.pid) {
      if (!c.child) log(`${uid}: çekirdek başlatılamadı: ${e.message}`);
      gone();
    }
  });
  return c;
}

/** SIGTERM → en çok 10 sn → SIGKILL (grup + Chromium'lar) */
function stopCore(c, reason) {
  if (c.state === 'stopping') return c.exited;
  c.state = 'stopping';
  c.stopReason = reason;
  const pid = c.child?.pid;
  if (!pid || c.child.exitCode !== null || c.child.signalCode !== null) return c.exited;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* bitti */
  }
  const t = setTimeout(() => {
    log(`${c.uid}: çekirdek ${CFG.stopGraceMs / 1000} sn içinde kapanmadı, öldürülüyor`);
    killGroup(pid, 'SIGKILL');
  }, CFG.stopGraceMs);
  t.unref();
  return c.exited.finally(() => clearTimeout(t));
}

// Boşta kalan çekirdekler (açık WebSocket = etkin): IDLE_MINUTES sonra durdurulur
setInterval(() => {
  const now = Date.now();
  for (const c of cores.values()) {
    if (c.state === 'ready' && c.ws === 0 && c.inflight === 0 && now - c.lastActive > CFG.idleMs) void stopCore(c, `${+(CFG.idleMs / 60_000).toFixed(1)} dk boşta`);
  }
  // eski çöküş kayıtları
  for (const [uid, cr] of crashes) if (cr.until < now - 3_600_000) crashes.delete(uid);
}, Math.min(60_000, Math.max(1000, CFG.idleMs / 2))).unref();
setInterval(() => {
  for (const c of cores.values()) rotateLog(c.dir);
}, 30_000).unref();

/* ---------------- HTTP ---------------- */

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** Çekirdeğe gitmeyen istek başlıkları: tarayıcı kimliği (çekirdek kendi CORS/Origin kuralını uygulamasın), çerez, gelen belirteç, vekil başlıkları (yeniden yazılır) */
const DROP_REQ = new Set(['host', 'origin', 'cookie', 'x-kavsak-token', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port']);

function corsHeaders(req) {
  const o = req.headers.origin;
  return o && CFG.origins.has(o) ? { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-expose-headers': 'retry-after' } : {};
}

function sendJson(req, res, status, body, extra = {}) {
  if (res.headersSent) return void res.destroy();
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', ...corsHeaders(req), ...extra });
  res.end(data);
}

const sendError = (req, res, e) =>
  e instanceof GwError ? sendJson(req, res, e.status, { error: e.message }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {}) : (log(`İç hata: ${e?.stack ?? e}`), sendJson(req, res, 500, { error: 'Ağ geçidi hatası' }));

/** İsteğin yol + sorgu parçaları: yol normalleştirilir ('..' kaçışı yok), sorgu olduğu gibi kalır (yalnız token atılır) */
function splitUrl(raw) {
  const q = raw.indexOf('?');
  let pathname;
  try {
    pathname = new URL(q < 0 ? raw : raw.slice(0, q), 'http://gw').pathname;
  } catch {
    throw new GwError(400, 'Geçersiz adres');
  }
  const query = q < 0 ? '' : raw.slice(q + 1);
  return { pathname, query };
}

/** Sorgudan token parametresini at (diğer parametreler bayt bayt korunur) */
function stripToken(query) {
  const keyOf = (part) => {
    const k = part.split('=')[0];
    try {
      return decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      return k;
    }
  };
  return query.split('&').filter((p) => p && keyOf(p) !== 'token');
}

function queryToken(query) {
  for (const p of query.split('&')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === 'token') {
      try {
        return decodeURIComponent(p.slice(i + 1));
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Gelen belirteç: başlık öncelikli (çekirdekle aynı), yoksa ?token= */
const givenToken = (req, query) => {
  const h = req.headers['x-kavsak-token'];
  return (Array.isArray(h) ? h[0] : h) || queryToken(query);
};

function forwardedFor(req) {
  const prev = req.headers['x-forwarded-for'];
  const me = req.socket.remoteAddress ?? '';
  return prev ? `${prev}, ${me}` : me || '127.0.0.1';
}

function proxyHttp(req, res, c, pathname, query) {
  const headers = {};
  const connList = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim()));
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !DROP_REQ.has(k) && !connList.has(k)) headers[k] = v;
  if (/chunked/i.test(String(req.headers['transfer-encoding'] ?? ''))) headers['transfer-encoding'] = 'chunked';
  headers.host = `127.0.0.1:${c.port}`;
  headers['x-kavsak-token'] = c.token;
  headers['x-forwarded-for'] = forwardedFor(req);
  headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] ?? 'http');
  const rest = stripToken(query);
  c.inflight++;
  c.lastActive = Date.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    c.inflight--;
    c.lastActive = Date.now();
  };
  const preq = http.request({ host: '127.0.0.1', port: c.port, method: req.method, path: pathname + (rest.length ? `?${rest.join('&')}` : ''), headers });
  preq.on('response', (pres) => {
    const h = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k) && !k.startsWith('access-control-') && k !== 'vary') h[k] = v;
    Object.assign(h, corsHeaders(req));
    res.writeHead(pres.statusCode ?? 502, h);
    pres.pipe(res);
    pres.on('error', () => res.destroy());
  });
  preq.on('error', () => {
    if (!res.headersSent) sendJson(req, res, 502, { error: MSG.unreachable });
    else res.destroy();
  });
  req.on('error', () => preq.destroy());
  res.on('close', () => {
    if (!res.writableFinished) preq.destroy();
    finish();
  });
  req.pipe(preq);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (b) => {
      n += b.length;
      if (n > max) {
        reject(new GwError(413, 'İstek gövdesi çok büyük'));
        req.destroy();
      } else chunks.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Üye silme (KVKK): çekirdeği durdur, <USERS_DIR>/<uid> klasörünü tamamen sil */
async function deleteUser(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 4096));
  } catch (e) {
    if (e instanceof GwError) throw e;
    throw new GwError(400, 'Geçersiz JSON');
  }
  const uid = body?.uid;
  const ts = body?.ts;
  const sig = req.headers['x-gw-sig'];
  if (!verifyDelete(uid, ts, Array.isArray(sig) ? sig[0] : sig, CFG.secret)) throw new GwError(401, 'İmza geçersiz ya da süresi dolmuş');
  const dir = userDir(uid);
  if (deleting.has(uid)) throw new GwError(409, MSG.deleting);
  deleting.add(uid);
  try {
    const c = cores.get(uid);
    // açılıyor olsa da hemen durdur (deleting: bu arada yeni başlatma yok); açılış yarıda kalır, klasör aşağıda silinir
    if (c) await stopCore(c, 'üye silindi');
    await killStale(uid, dir).catch(() => undefined);
    crashes.delete(uid);
    let existed = false;
    try {
      const st = fs.lstatSync(dir);
      existed = true;
      // bağlantıysa yalnız bağlantı silinir (hedefe gidilmez); klasörse tamamı
      if (st.isSymbolicLink()) fs.unlinkSync(dir);
      else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    log(`${uid}: ${existed ? 'veriler silindi' : 'silinecek veri yoktu'}`);
    sendJson(req, res, 200, { ok: true, deleted: existed });
  } finally {
    deleting.delete(uid);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, query } = splitUrl(req.url ?? '/');
    if (pathname === '/gw/health' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(req, res, 200, { ok: true, cores: readyCount() });
    if (pathname === '/gw/delete-user' && req.method === 'POST') return await deleteUser(req, res);
    if (!pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: MSG.notFound });
    // tarayıcı isteği yalnız izinli kaynaklardan (CORS'un yanında savunma derinliği)
    const origin = req.headers.origin;
    if (origin && !CFG.origins.has(origin)) return sendJson(req, res, 403, { error: MSG.origin });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(req),
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type, x-kavsak-token, x-mivelo-client',
        'access-control-max-age': '600',
      });
      return void res.end();
    }
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(req.method ?? '')) return sendJson(req, res, 405, { error: 'Yöntem desteklenmiyor' });
    const claims = verify(givenToken(req, query), CFG.secret);
    if (!claims) return sendJson(req, res, 401, { error: MSG.unauthorized });
    const c = await ensureCore(claims.u);
    if (req.destroyed) return;
    proxyHttp(req, res, c, pathname, query);
  } catch (e) {
    sendError(req, res, e);
  }
});
// büyük dosya gönderimi (≤60 MB base64 JSON) yavaş bağlantıda da bitsin; Caddy'nin boşta bağlantısından uzun keep-alive
server.requestTimeout = 15 * 60_000;
server.keepAliveTimeout = 130_000;
server.headersTimeout = 135_000;

/* ---------------- WebSocket ---------------- */

function rejectUpgrade(req, socket, status, message) {
  const body = JSON.stringify({ error: message });
  const cors = Object.entries(corsHeaders(req)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${cors}connection: close\r\n\r\n${body}`);
}

server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  try {
    const { pathname, query } = splitUrl(req.url ?? '/');
    if (pathname !== '/ws') return rejectUpgrade(req, socket, 404, MSG.notFound);
    const origin = req.headers.origin;
    if (origin && !CFG.origins.has(origin)) return rejectUpgrade(req, socket, 403, MSG.origin);
    const claims = verify(givenToken(req, query), CFG.secret);
    if (!claims) return rejectUpgrade(req, socket, 401, MSG.unauthorized);
    const c = await ensureCore(claims.u);
    if (socket.destroyed) return;
    const upstream = net.connect(c.port, '127.0.0.1');
    c.ws++;
    c.lastActive = Date.now();
    sockets.add(socket);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      c.ws--;
      c.lastActive = Date.now();
      sockets.delete(socket);
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
    upstream.on('connect', () => {
      const lines = [`GET /ws?${[...stripToken(query), `token=${encodeURIComponent(c.token)}`].join('&')} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const k = raw[i].toLowerCase();
        if (DROP_REQ.has(k) || k === 'content-length' || k === 'transfer-encoding') continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      lines.push(`Host: 127.0.0.1:${c.port}`, `X-Kavsak-Token: ${c.token}`, `X-Forwarded-For: ${forwardedFor(req)}`, `X-Forwarded-Proto: ${String(req.headers['x-forwarded-proto'] ?? 'http')}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  } catch (e) {
    if (e instanceof GwError) rejectUpgrade(req, socket, e.status, e.message);
    else {
      log(`İç hata (ws): ${e?.stack ?? e}`);
      rejectUpgrade(req, socket, 500, 'Ağ geçidi hatası');
    }
  }
});

/* ---------------- açılış / kapanış ---------------- */

async function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`Kapatılıyor (${sig}): ${cores.size} çekirdek durduruluyor`);
  setTimeout(() => process.exit(0), CFG.stopGraceMs + 15_000).unref();
  server.close();
  server.closeAllConnections?.();
  for (const s of sockets) s.destroy();
  await Promise.all([...cores.values()].map((c) => stopCore(c, 'kapanış')));
  process.exit(0);
}

function main() {
  if (CFG.secret.length < 32) {
    console.error('CORE_SECRET ortam değişkeni en az 32 karakter olmalı (Admin → Demo → Sunucu çekirdeği)');
    process.exit(1);
  }
  if (!fs.existsSync(CFG.entry)) {
    console.error(`Çekirdek derlenmemiş: ${CFG.entry} yok (npm run build -w packages/core)`);
    process.exit(1);
  }
  fs.mkdirSync(CFG.usersDir, { recursive: true, mode: 0o700 });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (e) => log(`Yakalanmamış hata: ${e?.stack ?? e}`));
  process.on('unhandledRejection', (e) => log(`Yakalanmamış söz reddi: ${e?.stack ?? e}`));
  server.on('error', (e) => {
    console.error(`Ağ geçidi dinleyemedi (${CFG.host}:${CFG.port}): ${e.message}`);
    process.exit(1);
  });
  // önceki ağ geçidinden (systemd dışında çalıştırılıp öldürülmüşse) sahipsiz kalan çekirdekler: aynı veri klasörüyle ikinci süreç olmasın
  void (async () => {
    for (const uid of fs.readdirSync(CFG.usersDir)) {
      if (UID_RE.test(uid) && !cores.has(uid) && fs.existsSync(path.join(CFG.usersDir, uid, 'core.pid'))) await killStale(uid, path.join(CFG.usersDir, uid)).catch(() => undefined);
    }
  })();
  server.listen(CFG.port, CFG.host, () =>
    log(`Ağ geçidi hazır: http://${CFG.host}:${CFG.port} · kullanıcılar ${CFG.usersDir} · en çok ${CFG.maxCores} çekirdek · boşta ${+(CFG.idleMs / 60_000).toFixed(1)} dk · izinli kaynak: ${[...CFG.origins].join(', ') || '-'}${env.DISPLAY ? ` · ekran ${env.DISPLAY}` : ''}`),
  );
}

main();
