/**
 * Mivelo tanıtım videosu: reel.html'i kare kare çizer, içindeki GERÇEK demo uygulamasını (tek dosya demo) sanal saatle sürer
 * ve MP4'e çevirir (1080×1920, 30 fps, H.264 + AAC; Instagram/TikTok uyumlu).
 *
 *   npm run demo:html                                  # apps/web/dist-single/mivelo-demo.html
 *   node scripts/promo/render.mjs <varlık klasörü> <çıktı.mp4> [--fps 30] [--scale 2] [--to 46] [--no-audio]
 *   node scripts/promo/render.mjs <varlık klasörü> <kare klasörü> --stills 1,4.5,10    # yalnız seçili anlar (JPEG)
 *
 * Nasıl çalışır: Playwright sayfanın saatini (Date, setTimeout, rAF) sanal saate bağlar; her karede saat 1/fps ilerler,
 * window.render(t) kompozisyonu çizer ve o karede yapılacak gerçek girişleri döndürür (fare bas/bırak, tuş, yazı) — bunlar
 * Playwright'ın gerçek fare/klavyesiyle uygulanır. iframe'deki CSS geçişleri de video zamanına bağlanır (syncAnims), böylece
 * her kare birebir tekrar üretilebilir. Ses: audio.mjs, sahnedeki ipuçlarından (tıklama, tuş, geçiş) müzik + efekt üretir.
 * FFMPEG=/yol (H.264 destekli; ör. `npx ffmpeg-static`), CHROMIUM=/yol isteğe bağlı. Mac'te başlıklar SF Pro ile çizilir.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderAudio } from './audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const req = createRequire(path.join(ROOT, 'packages/core/package.json'));
const { chromium } = req('playwright');
const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const [assets, out = 'mivelo-reel.mp4'] = pos;
const flag = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const FPS = Number(arg('fps', 30));
const SCALE = Number(arg('scale', 1));
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const STILLS = arg('stills') ? String(arg('stills')).split(',').map(Number) : null;
if (!assets) {
  console.error('Kullanım: node scripts/promo/render.mjs <varlık klasörü> <çıktı.mp4> [--scale 2] [--stills 1,2,3]');
  process.exit(1);
}
const DEMO = path.join(ROOT, 'apps/web/dist-single/mivelo-demo.html');
if (!fs.existsSync(DEMO)) {
  console.error('Önce tek dosya demoyu üret: npm run demo:html');
  process.exit(1);
}

// reel.html + varlıklar + demo aynı kökten sunulur (iframe aynı köken olsun: DOM'a erişim ve gerçek girişler)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-reel-'));
const COMP = arg('comp', 'reel.html'); // kompozisyon: reel.html (ilk film) · reel2.html (48 sn, AI ağırlıklı)
fs.copyFileSync(path.join(HERE, COMP), path.join(work, 'reel.html'));
fs.symlinkSync(path.resolve(assets), path.join(work, 'assets'));
fs.mkdirSync(path.join(work, 'app'));
fs.copyFileSync(DEMO, path.join(work, 'app/index.html'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
const server = http
  .createServer((q, s) => {
    const f = path.join(work, decodeURIComponent(new URL(q.url, 'http://x').pathname));
    if (!f.startsWith(work) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return s.writeHead(404).end();
    s.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(s);
  })
  .listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }), args: ['--lang=tr-TR', '--font-render-hinting=none'] });
const ctx = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: SCALE,
  locale: 'tr-TR',
  timezoneId: 'Europe/Istanbul',
  colorScheme: 'light',
  // uygulama kendini Mac'te sanar: kısayol ipuçları ⌘ ile, ⌘K/⌘1… çalışır
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
});
// dış istek yok (Google Fonts vb.): her şey yerel, kareler tekrar üretilebilir
await ctx.route((u) => !u.href.startsWith(base) && !u.href.startsWith('data:') && !u.href.startsWith('blob:'), (r) => r.abort());
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  let seed = 20260927;
  Math.random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  try {
    localStorage.setItem('mivelo.theme', 'light');
    localStorage.setItem('mivelo.seenChangelog', '2026-10-01d'); // Yenilikler penceresi çıkmasın (changelog.ts'teki en üst kaydın id'si)
    localStorage.setItem('mivelo.searchSemantic', '1');
  } catch {}
  if (location.pathname.startsWith('/app/')) {
    // uygulama penceresi öndeymiş gibi: bildirim kartları arka plan kuyruğuna değil ekrana düşsün
    Document.prototype.hasFocus = () => true;
    // uygulamanın yazı tipi Inter: çevrimdışı çizimde yerel dosyadan
    const css = ['latin', 'latin-ext']
      .map((r) => `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:block;src:url(/assets/fonts/inter-${r}-wght-normal.woff2) format('woff2');unicode-range:${r === 'latin' ? 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' : 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'}}`)
      .join('');
    const inject = () => {
      if (document.getElementById('mivelo-reel-font')) return;
      const st = document.createElement('style');
      st.id = 'mivelo-reel-font';
      st.textContent = css + '::-webkit-scrollbar{display:none} body{user-select:none} textarea,input{user-select:text}';
      (document.head ?? document.documentElement).appendChild(st);
      // Inter'i hemen istet (appReady yazı tiplerinin yüklendiğini bekler)
      document.fonts.load("500 14px 'Inter'");
      document.fonts.load("700 14px 'Inter'");
    };
    if (document.documentElement) inject();
    addEventListener('DOMContentLoaded', inject);
  }
});
// Salı sabahı, sabit saat: demo verisinin göreli zamanları her çizimde aynı
await ctx.clock.install({ time: new Date('2026-10-06T10:24:00+03:00') });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('sayfa hatası:', e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|ERR_FAILED/.test(m.text()) && console.error('konsol:', m.text()));
await page.goto(`${base}/reel.html`);
for (let waited = 0; !(await page.evaluate(() => window.appReady?.())); waited += 100) {
  if (waited > 30_000) throw new Error('Demo uygulaması açılmadı');
  await ctx.clock.runFor(100);
}
await ctx.clock.runFor(1500); // açılış animasyonları otursun
// --warm N: kayıttan önce N sn sanal zaman geçir (ör. bildirim kartı açılıştan 60 sn sonra çıkar)
if (Number(arg('warm', 0)) > 0) await ctx.clock.runFor(Number(arg('warm', 0)) * 1000);
const fontOk = await page.evaluate(() => window.ready);
console.log('uygulama:', await page.evaluate(() => { const w = document.getElementById('app').contentWindow; const d = w.document; const r = (s) => { const e = d.querySelector(s); if (!e) return '-'; const b = e.getBoundingClientRect(); return `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}`; }; return `${w.innerWidth}×${w.innerHeight} dpr=${w.devicePixelRatio} .app=${r('.app')} conv=${r('section.conv')} Inter=${d.fonts.check("500 14px 'Inter'")} font=${getComputedStyle(d.body).fontFamily}`; }));
if (!fontOk) console.warn('Uyarı: başlık yazı tipi yüklenemedi');
const DUR = await page.evaluate(() => window.DUR);
const TO = Number(arg('to', DUR));
const frames = Math.round(TO * FPS);

let ff = null;
const stillDir = STILLS ? path.resolve(out) : null;
if (stillDir) fs.mkdirSync(stillDir, { recursive: true });
const videoTmp = flag('no-audio') ? out : out.replace(/\.mp4$/, '') + '.video.mp4';
if (!STILLS) {
  ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', ...(SCALE !== 1 ? ['-vf', 'scale=1080:1920:flags=lanczos'] : []), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-r', String(FPS), videoTmp], { stdio: ['pipe', 'inherit', 'inherit'] });
}
const stillFrames = new Set((STILLS ?? []).map((s) => Math.round(s * FPS)));
const lastStill = Math.max(-1, ...stillFrames);

const cues = [];
const t0 = Date.now();
let mouseDown = false;
for (let i = 0; i < frames; i++) {
  if (STILLS && i > lastStill) break;
  const t = i / FPS;
  if (i) await ctx.clock.runFor(Math.round((i * 1000) / FPS) - Math.round(((i - 1) * 1000) / FPS));
  const r = await page.evaluate((tt) => window.render(tt), t);
  if (r.cursor) await page.mouse.move(r.cursor.x, r.cursor.y);
  else if (!mouseDown) await page.mouse.move(1079, 1919);
  for (const a of r.acts) {
    if (a.k === 'down') {
      cues.push({ t, k: a.sfx ?? 'click' });
      if (!a.stage && !a.skip && r.cursor) (await page.mouse.down(), (mouseDown = true));
    } else if (a.k === 'up') {
      if (mouseDown) (await page.mouse.up(), (mouseDown = false));
    } else if (a.k === 'key') {
      cues.push({ t, k: a.key === 'Enter' ? 'enter' : 'key' });
      await page.keyboard.press(a.key);
    } else if (a.k === 'text') {
      const chars = [...a.text];
      chars.forEach((c, j) => c.trim() && cues.push({ t: t + j / (FPS * chars.length), k: 'type' }));
      await page.keyboard.type(a.text);
    }
  }
  await page.evaluate((tt) => window.syncAnims(tt), t);
  if (STILLS) {
    if (stillFrames.has(i)) await page.screenshot({ path: path.join(stillDir, `t${t.toFixed(2).padStart(6, '0')}.jpg`), type: 'jpeg', quality: 88 });
    continue;
  }
  const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
  if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res));
  if (i % 60 === 0) process.stdout.write(`\r${Math.round((i / frames) * 100)}% · ${t.toFixed(1)} sn · ${((Date.now() - t0) / 1000).toFixed(0)} sn geçti   `);
}
const staticCues = await page.evaluate(() => window.CUES_STATIC);
const audioOpts = await page.evaluate(() => window.AUDIO ?? {});
await browser.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });
if (STILLS) {
  console.log(`\nKareler: ${stillDir}`);
  process.exit(0);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
const allCues = [...staticCues, ...cues].sort((a, b) => a.t - b.t);
fs.writeFileSync(out.replace(/\.mp4$/, '') + '.cues.json', JSON.stringify({ dur: TO, cues: allCues }, null, 1));
if (!flag('no-audio')) {
  const wav = out.replace(/\.mp4$/, '') + '.wav';
  renderAudio({ dur: TO, cues: allCues, ...audioOpts }, wav);
  // ses: -14 LUFS (Instagram/TikTok), video kopyalanır
  await new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-i', videoTmp, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.2:LRA=9', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg mux ' + c))));
  });
  fs.rmSync(videoTmp, { force: true });
}
console.log(`\nHazır: ${out} (${frames} kare, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} sn)`);
