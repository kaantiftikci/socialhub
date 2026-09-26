/**
 * Tanıtım videosu varlıkları — tek dosya demodan (apps/web/dist-single/mivelo-demo.html) gerçek MASAÜSTÜ arayüz ekranları
 * (açık tema, 1440×900 @2×) ve köşeleri saydam marka simgeleri.
 *   npm run demo:html && node scripts/promo/capture-assets.mjs <çıktı klasörü>
 * CHROMIUM=/yol ile tarayıcı verilebilir. Pazaryeri logoları ayrıca scripts/promo/brand-tiles.py ile temizlenir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(HERE, '../../packages/core/package.json'));
const { chromium } = req('playwright');
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, 'assets'));
const DEMO = 'file://' + path.join(HERE, '../../apps/web/dist-single/mivelo-demo.html');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' });
const wait = (p, ms) => p.waitForTimeout(ms);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function open(opts) {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  await p.goto(DEMO);
  await wait(p, 2600);
  return p;
}
const shot = async (p, name, clip) => (log(name), p.screenshot({ path: path.join(OUT, name + '.png'), ...(clip ? { clip } : {}) }));
const nav = async (p, label) => (await p.locator('.nav-item', { hasText: label }).first().click(), wait(p, 900));
const chan = async (p, label) => (await p.locator('.chan', { hasText: label }).first().click(), wait(p, 800));

// ── marka simgeleri: sayfa/kart zeminleri saydam → köşeler gerçekten saydam (4×) ──
{
  const p = await open({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 4 });
  await p.locator('text=Uygulama bağla').first().click();
  await wait(p, 900);
  await p.addStyleTag({ content: '*{background-color:transparent!important;box-shadow:none!important;backdrop-filter:none!important;border-color:transparent!important} .plat{box-shadow:none!important}' });
  // .plat kendi zemini inline style ile (marka rengi / gradyan) — !important onu ezmesin diye geri yaz
  await p.evaluate(() => document.querySelectorAll('.plat').forEach((el) => el.style.setProperty('background', el.style.background, 'important')));
  await wait(p, 200);
  const chips = p.locator('.pcard .plat[title]');
  const n = await chips.count();
  for (let i = 0; i < n; i++) {
    const chip = chips.nth(i);
    const name = ((await chip.getAttribute('title')) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!name || (await chip.locator('img').count())) continue; // pazaryeri logoları brand-tiles.py ile
    log('chip', name);
    await chip.screenshot({ path: path.join(OUT, `chip-${name}.png`), omitBackground: true }).catch((e) => log('  atlandı', e.message.split('\n')[0]));
  }
  await p.context().close();
}

// ── masaüstü ekranlar (açık tema, 1440×900 @2×) ──
const desk = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' };
{
  const p = await open(desk);
  await shot(p, 'dt-inbox');
  // WhatsApp · Ayşe: sohbet + sağ panel (AI özet, takip, not)
  await p.locator('.row', { hasText: 'Ayşe Demir' }).first().click();
  await wait(p, 1000);
  await shot(p, 'dt-chat');
  // mesaj üstü düğmeler (tepki · takvim · takip)
  const bub = p.locator('.bwrap:not(.me)').last();
  await bub.hover();
  await wait(p, 300);
  const bb = await bub.boundingBox();
  await shot(p, 'dt-hover', { x: bb.x - 70, y: bb.y - 24, width: bb.width + 200, height: bb.height + 48 });
  // Takvime ekle
  await bub.locator('.rtrig[title="Takvime ekle"]').click();
  await wait(p, 600);
  await shot(p, 'dt-caleditor-full');
  await shot(p, 'dt-caleditor', await p.locator('.cal-modal').boundingBox());
  await p.keyboard.press('Escape');
  await wait(p, 300);
  // ⌘K genel arama
  await p.keyboard.press('Control+k');
  await wait(p, 300);
  await p.keyboard.type('fatura', { delay: 40 });
  await wait(p, 1000);
  await shot(p, 'dt-search');
  await p.keyboard.press('Escape');
  // Takvim
  await nav(p, 'Takvim');
  await shot(p, 'dt-calendar');
  // Odak
  await nav(p, 'Odak');
  await wait(p, 600);
  await shot(p, 'dt-focus');
  // Trendyol: liste + sipariş sayfası
  await chan(p, 'Trendyol');
  await shot(p, 'dt-trendyol');
  await p.locator('.row', { hasText: '#1042931' }).first().click();
  await wait(p, 900);
  await shot(p, 'dt-order');
  // Gmail
  await chan(p, 'Gmail');
  await p.locator('.row').first().click();
  await wait(p, 900);
  await shot(p, 'dt-mail');
  // Uygulama bağla (tüm kanallar)
  await p.locator('text=Uygulama bağla').first().click();
  await wait(p, 900);
  await shot(p, 'dt-connect');
  await p.keyboard.press('Escape');
  await wait(p, 400);
  // Ayarlar → Uygulama ayarları (zil sesi / ses düzeyi / bildirim)
  await p.click('button[aria-label="Ayarlar"]');
  await wait(p, 500);
  await shot(p, 'dt-settings-full');
  await p.locator('text=Uygulama ayarları').first().click();
  await wait(p, 700);
  await shot(p, 'dt-appsettings');
  await p.context().close();
}
await browser.close();
console.log('varlıklar:', fs.readdirSync(OUT).length, OUT);
