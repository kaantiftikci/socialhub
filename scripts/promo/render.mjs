/**
 * reel.html'i kare kare çizip MP4'e çevirir (1080×1920, 30 fps, H.264, Instagram/TikTok uyumlu).
 *   node scripts/promo/render.mjs <varlık klasörü> <çıktı.mp4> [--fps 30] [--from 0] [--to 48]
 * FFMPEG=/yol (H.264 destekli; ör. `npx ffmpeg-static`), CHROMIUM=/yol isteğe bağlı.
 * Hareketin tamamı window.render(t) ile zamanın fonksiyonu olduğundan her kare birebir tekrar üretilebilir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(HERE, '../../packages/core/package.json'));
const { chromium } = req('playwright');
const [assets, out = 'mivelo-reel.mp4'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const FPS = arg('fps', 30);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
if (!assets) {
  console.error('Kullanım: node scripts/promo/render.mjs <varlık klasörü> <çıktı.mp4>');
  process.exit(1);
}
const html = path.join(HERE, 'reel.html');
const assetsAbs = path.resolve(assets);
// reel.html varlıklara göreli yol ister: sayfa ile varlıkları aynı geçici klasörde topla
const work = fs.mkdtempSync(path.join(path.dirname(assetsAbs), 'reel-'));
fs.copyFileSync(html, path.join(work, 'reel.html'));
fs.symlinkSync(assetsAbs, path.join(work, 'assets'));

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('sayfa hatası:', e.message));
await page.goto('file://' + path.join(work, 'reel.html') + '?a=assets');
await page.evaluate(() => window.ready);
const dur = await page.evaluate(() => window.DUR);
const from = arg('from', 0);
const to = arg('to', dur);
const frames = Math.round((to - from) * FPS);

// kareler ffmpeg'e doğrudan akar (diske yazılmaz)
const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  const t = from + i / FPS;
  await page.evaluate((tt) => window.render(tt), t);
  const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 60 === 0) process.stdout.write(`\r${Math.round((i / frames) * 100)}% · ${t.toFixed(1)} sn · ${((Date.now() - t0) / 1000).toFixed(0)} sn geçti   `);
}
ff.stdin.end();
await new Promise((r, j) => ff.on('close', (c) => (c === 0 ? r() : j(new Error('ffmpeg ' + c)))));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\nHazır: ${out} (${frames} kare, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
