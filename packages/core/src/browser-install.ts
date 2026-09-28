import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { bus } from './bus.js';

/**
 * Paketli uygulamada (DMG/EXE) kullanıcının bilgisayarında Playwright Chromium'u yoktur: tarayıcıyla bağlanan ilk kanalda
 * bir kez indirilir (~150 MB, Playwright'ın kendi CDN'inden; varsayılan önbellek: macOS ~/Library/Caches/ms-playwright,
 * Windows %LOCALAPPDATA%\ms-playwright). Aynı anda birden çok kanal isterse tek indirme paylaşılır; ilerleme her bekleyene gider.
 * KAVSAK_CHROMIUM verilmişse (elle tarayıcı yolu) hiçbir şey yapılmaz.
 */
type Progress = (pct: number | null) => void;

let inflight: Promise<boolean> | null = null;
const listeners = new Set<Progress>();

export async function chromiumReady(): Promise<boolean> {
  if (process.env.KAVSAK_CHROMIUM) return true;
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** Chromium yoksa indir; true = kullanılabilir */
export async function ensureChromium(onProgress?: Progress): Promise<boolean> {
  if (await chromiumReady()) return true;
  if (onProgress) listeners.add(onProgress);
  try {
    if (!inflight) {
      inflight = install().finally(() => {
        inflight = null;
      });
    }
    return await inflight;
  } finally {
    if (onProgress) listeners.delete(onProgress);
  }
}

function playwrightCli(): string {
  const req = createRequire(import.meta.url);
  return path.join(path.dirname(req.resolve('playwright/package.json')), 'cli.js');
}

async function install(): Promise<boolean> {
  bus.log('info', 'Tarayıcı bileşeni (Chromium) indiriliyor — ilk seferde bir kez, birkaç dakika sürebilir');
  const emit = (p: number | null) => listeners.forEach((f) => f(p));
  emit(null);
  const ok = await new Promise<boolean>((resolve) => {
    let child;
    try {
      // headless-shell gerekmez: köprü tam Chromium'u (channel 'chromium') kullanır
      child = spawn(process.execPath, [playwrightCli(), 'install', '--no-shell', 'chromium'], {
        env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      bus.log('error', `Tarayıcı bileşeni indirilemedi: ${(e as Error).message}`);
      return resolve(false);
    }
    let last = -1;
    let tail = '';
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      tail = (tail + s).slice(-600);
      // "|■■■■      |  34% of 162.3 MiB"
      const all = [...s.matchAll(/(\d{1,3})%/g)];
      const pct = all.length ? Number(all[all.length - 1][1]) : NaN;
      if (Number.isFinite(pct) && pct !== last && pct <= 100) {
        last = pct;
        emit(pct);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => child.kill(), 20 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      bus.log('error', `Tarayıcı bileşeni indirilemedi: ${e.message}`);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) bus.log('error', `Tarayıcı bileşeni indirilemedi (kod ${code}): ${tail.replace(/\s+/g, ' ').trim().slice(-300)}`);
      resolve(code === 0);
    });
  });
  const ready = ok && (await chromiumReady());
  if (ready) bus.log('info', 'Tarayıcı bileşeni hazır');
  return ready;
}
