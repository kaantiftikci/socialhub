#!/usr/bin/env node
/**
 * Tek dosyalık, etkileşimli Mivelo demosu: apps/web'i çevrimdışı demo kipinde (VITE_STATIC_DEMO=1, VITE_DEMO_OFFLINE=1)
 * tek JS parçası olarak derler; CSS, JS ve public/demo altındaki görsel/video/PDF'leri tek bir HTML'e gömer.
 * Sunucu, giriş ya da internet gerekmez (yalnız Inter yazı tipi Google Fonts'tan; yoksa sistem yazı tipi).
 *   node scripts/demo-html.mjs            → apps/web/dist-single/mivelo-demo.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'apps/web');
const out = path.join(web, 'dist-single');
const tmp = path.join(out, '.build');

process.env.VITE_STATIC_DEMO = '1';
process.env.VITE_DEMO_OFFLINE = '1';
delete process.env.VITE_SENTRY_DSN;

const { build } = await import('vite');
await build({
  root: web,
  logLevel: 'warn',
  build: {
    outDir: tmp,
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

let html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(tmp, href.replace(/^\//, '')), 'utf8');
// </script> dizisi satır içi betiği erken kapatmasın
const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script');

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${read(href)}</style>`);
const scripts = [];
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  scripts.push(read(src));
  return '';
});
if (!scripts.length) throw new Error('JS paketi bulunamadı');

// public/demo/** ve public/brands → { "demo/avatars/ayse.jpg": { t: "image/jpeg", d: "<base64>" }, "brands/n11.png": … }
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', pdf: 'application/pdf', csv: 'text/csv', wav: 'audio/wav' };
const assets = {};
const pub = path.join(web, 'public');
const walk = (rel) => {
  for (const f of fs.readdirSync(path.join(pub, rel))) {
    const r = `${rel}/${f}`;
    if (fs.statSync(path.join(pub, r)).isDirectory()) walk(r);
    else if (TYPES[f.split('.').pop().toLowerCase()]) assets[r] = { t: TYPES[f.split('.').pop().toLowerCase()], d: fs.readFileSync(path.join(pub, r)).toString('base64') };
  }
};
walk('demo');
walk('brands');

const body = `<script>window.__MIVELO_ASSETS=${JSON.stringify(assets)};</script>\n<script type="module">${safeJs(scripts.join('\n'))}</script>`;
// fonksiyonlu değiştirici: JS içindeki $' / $& dizileri replace kalıbı sayılmasın
html = html.replace('</body>', () => `${body}\n</body>`);
html = html.replace('<title>Mivelo</title>', '<title>Mivelo · Demo</title>');

fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'mivelo-demo.html');
fs.writeFileSync(file, html);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(root, file)} · ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB · ${Object.keys(assets).length} gömülü dosya`);
