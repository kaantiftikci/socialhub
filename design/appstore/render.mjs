// App Store ekran görüntüleri: template.html → out/NN-*.png (1290×2796, iPhone 6,9"/6,7").
// Kullanım: node design/appstore/render.mjs   (kökten; Playwright Chromium gerekir)
// Marka simgeleri web arayüzüyle (apps/web/src/ui.tsx) aynı kaynaktan: simple-icons + Font Awesome brands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(dir, '../../package.json'));
const si = req('simple-icons');
const fab = req('@fortawesome/free-brands-svg-icons');
const fa = (i) => ({ path: Array.isArray(i.icon[4]) ? i.icon[4].join(' ') : i.icon[4], vb: `0 0 ${i.icon[0]} ${i.icon[1]}` });

const BRANDS = {
  whatsapp: { path: si.siWhatsapp.path, bg: '#25D366', ratio: 0.62 },
  telegram: { path: si.siTelegram.path, bg: '#26A5E4', ratio: 0.62 },
  instagram: { path: si.siInstagram.path, bg: 'linear-gradient(45deg,#FFD600 0%,#FF7A00 25%,#FF0069 50%,#D300C5 75%,#7638FA 100%)', ratio: 0.6 },
  messenger: { path: si.siMessenger.path, bg: 'linear-gradient(45deg,#0099FF 0%,#A033FF 40%,#FF5280 75%,#FF7061 100%)', ratio: 0.62 },
  x: { path: si.siX.path, bg: '#000000', ratio: 0.45 },
  gmail: { path: si.siGmail.path, bg: '#EA4335', ratio: 0.6 },
  icloud: { path: si.siIcloud.path, bg: '#3693F3', ratio: 0.62 },
  shopify: { path: si.siShopify.path, bg: '#7AB55C', ratio: 0.62 },
  slack: { ...fa(fab.faSlack), bg: '#4A154B', ratio: 0.6 },
  linkedin: { ...fa(fab.faLinkedinIn), bg: '#0A66C2', ratio: 0.58 },
  outlook: { ...fa(fab.faMicrosoft), bg: '#0F6CBD', ratio: 0.52 },
};

const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const built = path.join(dir, '.build.html');
fs.writeFileSync(built, tpl.replace('/*BRANDS*/{}', JSON.stringify(BRANDS)));

const NAMES = ['gelen-kutusu', 'ai-ozet', 'odak', 'pazaryeri', 'takvim', 'kanallar'];
const out = path.join(dir, 'out');
fs.mkdirSync(out, { recursive: true });
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('requestfailed', (r) => errs.push('yüklenemedi: ' + r.url()));
await page.goto('file://' + built);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
for (let i = 0; i < NAMES.length; i++) {
  const file = path.join(out, `${String(i + 1).padStart(2, '0')}-${NAMES[i]}.png`);
  await page.locator(`#s${i + 1}`).screenshot({ path: file });
  console.log(file);
}
await browser.close();
fs.rmSync(built, { force: true });
if (errs.length) {
  console.error(errs.join('\n'));
  process.exitCode = 1;
}
