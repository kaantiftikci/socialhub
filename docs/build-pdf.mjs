/**
 * Dokümantasyonu PDF'e çevirir: docs/dokumantasyon.html → docs/Mivelo-Dokumantasyon.pdf (A4, altta sayfa numarası).
 *   node docs/build-pdf.mjs
 * Playwright'ın Chromium'unu kullanır (yoksa: npx playwright install chromium). CHROMIUM=/yol ile başka bir ikili verilebilir.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'dokumantasyon.html');
const out = path.join(here, 'Mivelo-Dokumantasyon.pdf');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(src).href, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#8a8598;padding:0 15mm;display:flex;justify-content:space-between;font-family:-apple-system,'Segoe UI',Inter,Roboto,Arial,'Liberation Sans',sans-serif">
      <span>Mivelo · Teknik ve Ürün Dokümantasyonu · 0.1.24</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`,
  });
  console.log(`PDF yazıldı: ${path.relative(process.cwd(), out)}`);
} finally {
  await browser.close();
}
