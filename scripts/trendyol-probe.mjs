#!/usr/bin/env node
/**
 * Trendyol soru tanısı (salt okunur GET istekleri): sipariş sorularının API'de hangi alanla / hangi uçtan geldiğini bulmak için.
 *   node scripts/trendyol-probe.mjs
 * Mivelo'ya bağlı Trendyol hesabının kimliğini ~/.kavsak/sessions/trendyol*\/token dosyasından okur. Çıktıda YALNIZ alan adları,
 * türler, sayılar ve HTTP durum kodları var — müşteri adı, soru metni, anahtar gibi değerler yazdırılmaz. Çıktıyı Claude'a yapıştır.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESS = path.join(process.env.KAVSAK_DATA_DIR ?? path.join(os.homedir(), '.kavsak'), 'sessions');
const dir = fs.existsSync(SESS) ? fs.readdirSync(SESS).find((d) => /^trendyol[:_]/.test(d)) : undefined;
if (!dir) {
  console.error(`Trendyol hesabı bulunamadı (${SESS}). Önce Mivelo'da Trendyol'u bağla.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(SESS, dir, 'token'), 'utf8'));
const s = String(cfg.sellerId);
const headers = {
  authorization: `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64')}`,
  'user-agent': `${s} - SelfIntegration`,
  accept: 'application/json',
};
const now = Date.now();
const win = `startDate=${now - 14 * 86400e3 + 60e3}&endDate=${now}&page=0&size=50`;

/** değerleri gizleyerek yapı özeti: alan → tür (dizi/nesne içi bir seviye) */
function shape(o, depth = 0) {
  if (Array.isArray(o)) return o.length ? `[${shape(o[0], depth)}] ×${o.length}` : '[]';
  if (o && typeof o === 'object') {
    if (depth > 1) return '{…}';
    return `{ ${Object.entries(o).map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(', ')} }`;
  }
  return o === null ? 'null' : typeof o;
}

async function get(label, url) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
    console.log(`\n## ${label}\nHTTP ${r.status}  ${url.replace(s, '<satıcı>').replace(/\?.*/, '?…')}`);
    if (j && typeof j === 'object') {
      const list = Array.isArray(j.content) ? j.content : Array.isArray(j) ? j : null;
      console.log(`üst alanlar: ${Object.keys(j).join(', ')}${j.totalElements != null ? ` · toplam ${j.totalElements}` : ''}`);
      // hata yanıtı: sunucunun açıklaması (kişisel veri içermez) — uç var mı / hangi parametre bekleniyor anlamak için
      if (!r.ok) for (const k of ['message', 'title', 'exception', 'errors', 'error']) if (j[k]) console.log(`${k}: ${JSON.stringify(j[k]).slice(0, 300)}`);
      if (list?.length) {
        const keys = new Map();
        for (const q of list) for (const [k, v] of Object.entries(q)) keys.set(k, (keys.get(k) ?? 0) + (v !== null && v !== undefined && v !== '' ? 1 : 0));
        console.log(`kayıt alanları (dolu/${list.length}): ${[...keys].map(([k, n]) => `${k}(${n})`).join(', ')}`);
        console.log(`ilk kaydın yapısı: ${shape(list[0])}`);
        const orderish = [...keys.keys()].filter((k) => /order|sipari|package|shipment|claim/i.test(k));
        console.log(`siparişle ilgili görünen alanlar: ${orderish.length ? orderish.join(', ') : 'YOK'}`);
      }
    } else if (r.status !== 404) console.log(`yanıt JSON değil (${text.length} bayt)`);
    return j;
  } catch (e) {
    console.log(`\n## ${label}\nhata: ${e.message}`);
  }
}

const Q = `https://apigw.trendyol.com/integration/qna/sellers/${s}`;
console.log(`Trendyol soru tanısı · hesap ${dir.replace(/[:_].*/, '')} · son 14 gün`);
await get('Sorular (tümü)', `${Q}/questions/filter?${win}`);
await get('Sorular (cevap bekleyen)', `${Q}/questions/filter?${win}&status=WAITING_FOR_ANSWER`);
// Belgesiz aday uçlar: 404 = yok. 200/400 dönen varsa sipariş soruları oradan geliyor olabilir.
const winS = `startDate=${now - 14 * 86400e3 + 60e3}&endDate=${now}`;
for (const [label, url] of [
  ['Aday: order-questions', `${Q}/order-questions/filter?${win}`],
  ['order-questions (parametresiz)', `${Q}/order-questions/filter`],
  ['order-questions (yalnız tarih)', `${Q}/order-questions/filter?${winS}`],
  ['order-questions (sayfa 0, boyut 10)', `${Q}/order-questions/filter?page=0&size=10`],
  ['order-questions (kök)', `${Q}/order-questions`],
  ['order-questions (cevap bekleyen)', `${Q}/order-questions/filter?${win}&status=WAITING_FOR_ANSWER`],
  ['sapigw order-questions', `https://api.trendyol.com/sapigw/suppliers/${s}/order-questions/filter?${win}`],
  ['Aday: questions/filter?questionType=ORDER', `${Q}/questions/filter?${win}&questionType=ORDER`],
  ['Aday: orders/questions', `${Q}/orders/questions/filter?${win}`],
  ['Aday: order entegrasyonu sorular', `https://apigw.trendyol.com/integration/order/sellers/${s}/questions?${win}`],
]) {
  await get(label, url);
  await new Promise((r) => setTimeout(r, 400));
}
console.log('\nBitti. Bu çıktıyı olduğu gibi Claude\'a yapıştır.');
