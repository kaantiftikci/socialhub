import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { bus } from '../../bus.js';
import { DATA_DIR } from '../../config.js';

/**
 * Mivelo köprüsü (apps/bridge, Go): Beeper'ın açık kaynak mautrix köprüleri (WhatsApp, Instagram, Messenger, X, LinkedIn,
 * Slack) Matrix sunucusu olmadan bu yardımcı süreçte çalışır. Çekirdek süreci başlatır, stdin/stdout JSON satırlarıyla konuşur:
 *   istek {"id","m","p"} → yanıt {"id","r"|"e"}; olay {"ev", ...}
 * Tek süreç tüm hesaplara hizmet eder; çökerse üstel beklemeyle yeniden başlar, bağlı hesaplar yeniden bağlanır.
 *
 * İkili sırası: MIVELO_BRIDGE_BIN → paketin kendi ikilisi (core/bin) → geliştirmede apps/bridge'de derlenmiş ikili (Go varsa
 * gerektiğinde derlenir) → mivelo.app/indir/files'dan indirilen ikili (sha256 doğrulamalı, ~/.mivelo/bin). Hiçbiri yoksa
 * `available()` false: registry eski (tarayıcı/Baileys) bağlayıcılara döner.
 */

export type BridgeEvent = { ev: string; net?: string; login?: string; room?: string; [k: string]: unknown };
type Listener = (e: BridgeEvent) => void;

const EXE = process.platform === 'win32' ? 'mivelo-bridge.exe' : 'mivelo-bridge';
const LATEST_URL = process.env.MIVELO_LATEST_URL ?? 'https://mivelo.app/indir/files/latest.json';
const FILES_BASE = LATEST_URL.replace(/[^/]+$/, '');

function coreRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function platformKey(): string {
  const osName = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${osName}-${arch}`;
}

function devSource(): string | undefined {
  const src = path.resolve(coreRoot(), '..', '..', 'apps', 'bridge');
  return fs.existsSync(path.join(src, 'go.mod')) ? src : undefined;
}

/** Geliştirme ikilisi (apps/bridge/mivelo-bridge): kaynaklar ikiliden yeni değilse */
function devBinary(fresh: boolean): string | undefined {
  const src = devSource();
  if (!src) return undefined;
  const bin = path.join(src, EXE);
  if (!fs.existsSync(bin)) return undefined;
  if (!fresh) return bin;
  const newest = fs
    .readdirSync(src)
    .filter((f) => f.endsWith('.go') || f === 'go.mod' || f === 'go.sum')
    .reduce((m, f) => Math.max(m, fs.statSync(path.join(src, f)).mtimeMs), 0);
  return fs.statSync(bin).mtimeMs >= newest ? bin : undefined;
}

/** Go kuruluysa apps/bridge'i derle (arka planda; olay döngüsünü bekletmez) */
function buildDev(): Promise<string | undefined> {
  const src = devSource();
  if (!src) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    bus.log('info', 'Köprü (apps/bridge) derleniyor — ilk seferde 1-2 dk sürebilir');
    let err = '';
    const child = spawn('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', EXE, '.'], {
      cwd: src,
      env: { ...process.env, CGO_ENABLED: '1', GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'auto' },
      windowsHide: true,
    });
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-600)));
    const t = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', () => (clearTimeout(t), resolve(undefined)));
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve(path.join(src, EXE));
      bus.log('warn', `Köprü derlenemedi: ${err.split('\n').slice(-3).join(' ').slice(0, 300)}`);
      resolve(undefined);
    });
  });
}

function hasGo(): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', ['go'], { encoding: 'utf8' }).status === 0;
}

/** Yerelde hazır ikili (indirme/derleme yapmaz) */
export function localBinary(): string | undefined {
  const env = process.env.MIVELO_BRIDGE_BIN;
  if (env) return fs.existsSync(env) ? env : undefined;
  if (process.env.MIVELO_ENGINE === 'legacy') return undefined;
  const bundled = path.join(coreRoot(), 'bin', EXE);
  if (fs.existsSync(bundled)) return bundled;
  const dev = devBinary(false);
  if (dev) return dev;
  const dl = path.join(DATA_DIR, 'bin', EXE);
  return fs.existsSync(dl) ? dl : undefined;
}

let downloading: Promise<string | undefined> | undefined;

/** İkili yoksa mivelo.app'ten indir (CI'nın latest.json'a yazdığı sha256 ile doğrulanır) */
export function ensureBinary(): Promise<string | undefined> {
  if (process.env.MIVELO_ENGINE === 'legacy') return Promise.resolve(undefined);
  if (process.env.MIVELO_BRIDGE_BIN) return Promise.resolve(localBinary());
  // geliştirme: kaynak ikiliden yeniyse (git pull) ve Go varsa yeniden derle
  if (devSource() && !devBinary(true) && hasGo()) return (downloading ??= buildDev().then((b) => b ?? localBinary() ?? download()).finally(() => (downloading = undefined)));
  const have = localBinary();
  if (have) return Promise.resolve(have);
  return (downloading ??= download().finally(() => (downloading = undefined)));
}

async function download(): Promise<string | undefined> {
  try {
    const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return undefined;
    const latest = (await res.json()) as { bridge?: Record<string, { file?: string; sha256?: string; size?: number }> };
    const item = latest.bridge?.[platformKey()];
    if (!item?.file || !/^[\w.-]+$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) return undefined;
    bus.log('info', `Köprü bileşeni indiriliyor (${item.file}, ${Math.round((item.size ?? 0) / 1e6)} MB)`);
    const bin = await fetch(FILES_BASE + item.file, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!bin.ok) throw new Error(`HTTP ${bin.status}`);
    const buf = Buffer.from(await bin.arrayBuffer());
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (sum !== item.sha256) throw new Error('sha256 tutmadı');
    const dir = path.join(DATA_DIR, 'bin');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, EXE);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, dest);
    if (process.platform === 'darwin') spawnSync('xattr', ['-d', 'com.apple.quarantine', dest]);
    bus.log('info', 'Köprü bileşeni indirildi');
    return dest;
  } catch (e) {
    bus.log('warn', `Köprü bileşeni indirilemedi: ${(e as Error).message}`);
    return undefined;
  }
}

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

class Sidecar {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private restarts = 0;
  private stopped = false;
  private bin?: string;
  version?: string;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Süreç hazır (gerekirse başlatır) */
  ready(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return Promise.resolve();
    return (this.starting ??= this.start().finally(() => (this.starting = undefined)));
  }

  private async start(): Promise<void> {
    this.stopped = false;
    this.bin ??= await ensureBinary();
    if (!this.bin) throw new BridgeError('no_binary', 'Köprü bileşeni bulunamadı');
    const child = spawn(this.bin, ['--data', DATA_DIR, '--log', process.env.MIVELO_BRIDGE_LOG ?? 'warn'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GOMAXPROCS: String(Math.max(2, Math.min(8, os.cpus().length))) },
    });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new BridgeError('timeout', 'Köprü 30 sn içinde açılmadı')), 30_000);
      const off = this.on((e) => {
        if (e.ev === 'ready') {
          clearTimeout(t);
          off();
          this.version = String(e.version ?? '');
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(t);
        off();
        reject(new BridgeError('exited', `Köprü açılırken kapandı (${code})`));
      });
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => this.onLog(line));
    child.on('exit', (code, sig) => this.onExit(child, code, sig));
    child.stdin.on('error', () => undefined);
    await ready;
    bus.log('info', `Köprü hazır (sürüm ${this.version}, pid ${child.pid})`);
    this.restarts = 0;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; r?: unknown; e?: { code: string; msg: string }; ev?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && !msg.ev) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.e) p.reject(new BridgeError(msg.e.code, msg.e.msg));
      else p.resolve(msg.r ?? {});
      return;
    }
    if (msg.ev) {
      if (msg.ev === 'log') return this.onLog(`${(msg as { level?: string }).level ?? 'info'} ${(msg as { msg?: string }).msg ?? ''}`);
      for (const fn of [...this.listeners]) {
        try {
          fn(msg as BridgeEvent);
        } catch (e) {
          bus.log('warn', `köprü olayı işlenemedi (${msg.ev}): ${(e as Error).message}`);
        }
      }
    }
  }

  /** Köprü günlüğü (zerolog konsol biçimi: "15:04:05 INF mesaj alan=değer") → çekirdek günlüğü; ayrıntı düzeyleri atlanır */
  private onLog(line: string): void {
    const m = /\b(DBG|INF|WRN|ERR|FTL|PNC|debug|info|warn|error)\b/.exec(line);
    const lvl = m?.[1] ?? 'INF';
    if (/DBG|debug/.test(lvl)) return;
    const level = /WRN|warn/.test(lvl) ? 'warn' : /ERR|FTL|PNC|error/.test(lvl) ? 'error' : 'info';
    // yalnız anlamlı satırlar: köprünün bilgi günlüğü çok ayrıntılı (her olay); uyarı/hata her zaman
    if (level === 'info' && !/started|connected|logged in|login|disconnect|backfill|error|failed|Bridge/i.test(line)) return;
    bus.log(level, `köprü: ${line.replace(/^\d\d:\d\d:\d\d\s+/, '').slice(0, 400)}`);
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, sig: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new BridgeError('exited', 'Köprü kapandı'));
    }
    this.pending.clear();
    if (this.stopped) return;
    const delay = Math.min(60_000, 2_000 * 2 ** this.restarts++);
    bus.log('error', `Köprü beklenmedik şekilde kapandı (${code ?? sig}); ${Math.round(delay / 1000)} sn sonra yeniden başlatılıyor`);
    for (const fn of [...this.listeners]) fn({ ev: 'bridge.exit' });
    setTimeout(() => {
      if (this.stopped) return;
      void this.ready()
        .then(() => {
          for (const fn of [...this.listeners]) fn({ ev: 'bridge.restart' });
        })
        .catch((e) => bus.log('error', `Köprü yeniden başlatılamadı: ${(e as Error).message}`));
    }, delay).unref?.();
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    await this.ready();
    const child = this.child;
    if (!child) throw new BridgeError('exited', 'Köprü çalışmıyor');
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BridgeError('timeout', `köprü ${method}: ${Math.round(timeoutMs / 1000)} sn içinde yanıt gelmedi`));
        }, timeoutMs);
        p.timer.unref?.();
      }
      this.pending.set(id, p);
      child.stdin.write(JSON.stringify({ id, m: method, p: params }) + '\n');
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    await this.call('shutdown', {}, 5_000).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 12_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.stdin.end();
    });
  }
}

export const sidecar = new Sidecar();

/** Test: yapay köprü (ör. sahte ikili) */
export function __setBinaryForTest(bin: string | undefined): void {
  (sidecar as unknown as { bin?: string }).bin = bin;
}
