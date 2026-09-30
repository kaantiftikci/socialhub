import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// gün sınırı yerel saatle: testler İstanbul saatinde (UTC+3) koşar
process.env.TZ = 'Europe/Istanbul';
const { addDays, dayKey, digestText, formatMoney, orderState, parseAmount, summarizeMarket } = await import('../src/market-calc.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`).toISOString();
const order = (id: string, dateCreated: string, total: string | number, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'Created',
  dateCreated,
  currency: 'TRY',
  totals: { total },
  items: [{ title: 'Keten gömlek', quantity: 1, total }],
  ...extra,
});
const DAY = '2026-09-30';

test('parseAmount: nokta/virgül biçimleri ve para simgesi', () => {
  assert.equal(parseAmount('1249.90'), 1249.9);
  assert.equal(parseAmount('1.249,90'), 1249.9);
  assert.equal(parseAmount('1,249.90'), 1249.9);
  assert.equal(parseAmount('12,50 $'), 12.5);
  assert.equal(parseAmount('1.250.000'), 1250000);
  assert.equal(parseAmount(349), 349);
  assert.equal(parseAmount('—'), 0);
  assert.equal(parseAmount(undefined), 0);
});

test('orderState: platform durum adları beş sınıfa', () => {
  const st = (status: string, statusLabel = '', paymentStatus?: string) => orderState({ status, statusLabel, paymentStatus });
  assert.equal(st('Picking', 'Hazırlanıyor'), 'open');
  assert.equal(st('Created'), 'open');
  assert.equal(st('Unshipped', 'kargolanacak'), 'open');
  assert.equal(st('unfulfilled'), 'open');
  assert.equal(st('packaged', 'Paketlendi'), 'open');
  assert.equal(st('Awaiting', 'Ödeme/onay bekleniyor'), 'open');
  assert.equal(st('Shipped', 'Kargoya verildi'), 'shipped');
  assert.equal(st('UnDelivered', 'Teslim edilemedi'), 'shipped');
  assert.equal(st('AtCollectionPoint', 'Teslimat noktasında'), 'shipped');
  assert.equal(st('fulfilled'), 'shipped');
  assert.equal(st('Delivered', 'Teslim edildi'), 'delivered');
  assert.equal(st('completed'), 'delivered');
  assert.equal(st('Cancelled', 'İptal edildi'), 'cancelled');
  assert.equal(st('cancelledbycustomer', 'Müşteri iptal etti'), 'cancelled');
  assert.equal(st('Canceled'), 'cancelled');
  assert.equal(st('UnSupplied', 'Tedarik edilemedi'), 'cancelled');
  assert.equal(st('Returned', 'İade talebi'), 'returned');
  assert.equal(st('claimcreated', 'Talep açıldı'), 'returned');
  assert.equal(st('fully refunded'), 'returned');
  assert.equal(st('paid', '', 'refunded'), 'returned');
});

test('günlük toplamlar: ciro, ortalama sepet, iptal/iade ayrı, en çok satan, platform kırılımı', () => {
  const orders = [
    { platform: 'trendyol', order: order('1', at(DAY, '09:00'), '1000.00') },
    { platform: 'trendyol', order: order('2', at(DAY, '12:30'), '500,00', { items: [{ title: 'Seramik kupa', quantity: 2, total: '500,00' }] }) },
    { platform: 'hepsiburada', order: order('3', at(DAY, '15:00'), 250, { status: 'shipped', statusLabel: 'Kargoda' }) },
    // aynı gün oluşturulup iptal edilen: sipariş sayılır, ciroya girmez, iptal tutarı
    { platform: 'trendyol', order: order('4', at(DAY, '16:00'), 700, { status: 'Cancelled', statusLabel: 'İptal edildi' }) },
    // dün oluşturulan, bugün iade (olay tarihi fulfillments'tan)
    { platform: 'n11', order: order('5', at(addDays(DAY, -1), '10:00'), 300, { status: 'Returned', fulfillments: [{ status: 'returned', date: at(DAY, '11:00') }] }) },
    // bugün teslim edilen eski sipariş
    { platform: 'trendyol', order: order('6', at(addDays(DAY, -3), '10:00'), 100, { status: 'Delivered', fulfillments: [{ status: 'Delivered', date: at(DAY, '13:00') }] }) },
    // başka para birimi (Etsy)
    { platform: 'etsy', order: order('7', at(DAY, '18:00'), '12,50 $', { currency: 'USD', status: 'paid' }) },
    // geçen haftanın aynı günü
    { platform: 'trendyol', order: order('8', at(addDays(DAY, -7), '10:00'), 400) },
  ];
  const questions = [
    { platform: 'trendyol', question: { status: 'WAITING_FOR_ANSWER', statusLabel: 'Cevap bekliyor', dateCreated: at(DAY, '10:00') } },
    { platform: 'hepsiburada', question: { status: 'WaitingForAnswer', statusLabel: 'Cevap bekliyor', dateCreated: at(addDays(DAY, -2), '10:00') } },
    { platform: 'trendyol', question: { status: 'ANSWERED', statusLabel: 'Cevaplandı', dateCreated: at(DAY, '08:00') } },
  ];
  const now = new Date(`${DAY}T21:00:00+03:00`).getTime();
  const s = summarizeMarket(orders, questions, DAY, { now });
  assert.equal(s.orders, 5, '1,2,3,4,7 bugün oluşturuldu');
  assert.deepEqual(s.revenue, [{ currency: 'TRY', amount: 1750 }, { currency: 'USD', amount: 12.5 }]);
  assert.deepEqual(s.avgBasket.find((m) => m.currency === 'TRY'), { currency: 'TRY', amount: 583.33 });
  assert.equal(s.cancelled.count, 1);
  assert.deepEqual(s.cancelled.amount, [{ currency: 'TRY', amount: 700 }]);
  assert.equal(s.returned.count, 1);
  assert.deepEqual(s.returned.amount, [{ currency: 'TRY', amount: 300 }]);
  assert.equal(s.delivered, 1);
  assert.equal(s.shipped, 1);
  assert.equal(s.awaitingShipment, 4, 'açık: 1, 2, 7 ve geçen haftanın 8 numarası');
  assert.deepEqual(s.questions, { received: 2, waiting: 2 });
  // Keten gömlek: 1, 3 ve 7 numaralı siparişler (iptal edilen 4 sayılmaz) → 3 adet, iki para biriminde ciro
  assert.equal(s.topProducts[0].title, 'Keten gömlek');
  assert.equal(s.topProducts[0].qty, 3);
  assert.deepEqual(s.topProducts[0].revenue, [{ currency: 'TRY', amount: 1250 }, { currency: 'USD', amount: 12.5 }]);
  assert.deepEqual([s.topProducts[1].title, s.topProducts[1].qty], ['Seramik kupa', 2]);
  assert.equal(s.platforms[0].platform, 'trendyol');
  assert.equal(s.platforms[0].orders, 3);
  assert.equal(s.platforms.find((p) => p.platform === 'n11')?.returned, 1);
  assert.equal(s.currency, 'TRY');
  assert.equal(s.compare.yesterday.orders, 1);
  assert.equal(s.compare.lastWeek.orders, 1);
  assert.deepEqual(s.compare.lastWeek.revenue, [{ currency: 'TRY', amount: 400 }]);
  assert.equal(s.trend.length, 7);
  assert.equal(s.trend[6].day, DAY);
  assert.equal(s.trend[6].revenue, 1750);
  assert.equal(s.trend[0].day, addDays(DAY, -6));

  const only = summarizeMarket(orders, questions, DAY, { now, platform: 'hepsiburada' });
  assert.equal(only.orders, 1);
  assert.deepEqual(only.questions, { received: 0, waiting: 1 });
});

test('gün sınırı yerel saatle: UTC gece yarısı değil İstanbul gece yarısı', () => {
  // 30.09 23:30 İstanbul = 30.09 20:30 UTC → 30.09; 01.10 00:30 İstanbul = 30.09 21:30 UTC → 01.10
  const late = { platform: 'trendyol', order: order('a', '2026-09-30T20:30:00.000Z', 100) };
  const next = { platform: 'trendyol', order: order('b', '2026-09-30T21:30:00.000Z', 200) };
  assert.equal(dayKey(Date.parse('2026-09-30T21:30:00.000Z')), '2026-10-01');
  const s = summarizeMarket([late, next], [], DAY);
  assert.equal(s.orders, 1);
  assert.deepEqual(s.revenue, [{ currency: 'TRY', amount: 100 }]);
  assert.equal(summarizeMarket([late, next], [], '2026-10-01').orders, 1);
  assert.equal(addDays('2026-10-25', 1), '2026-10-26'); // yaz saati geçişi çevresi
});

test('boş gün ve bildirim metni', () => {
  const s = summarizeMarket([], [], DAY, { hasShop: true });
  assert.equal(s.orders, 0);
  assert.deepEqual(s.revenue, []);
  assert.equal(s.currency, 'TRY');
  assert.equal(digestText(s), 'Gün sonu özeti: 0 sipariş · 0 ₺');
  const t = summarizeMarket(
    [
      { platform: 'trendyol', order: order('1', at(DAY, '10:00'), 8000) },
      { platform: 'trendyol', order: order('2', at(DAY, '11:00'), 450) },
    ],
    [{ platform: 'trendyol', question: { status: 'WAITING_FOR_ANSWER' } }],
    DAY,
    { now: new Date(`${DAY}T21:00:00+03:00`).getTime() },
  );
  assert.equal(digestText(t), 'Gün sonu özeti: 2 sipariş · 8.450 ₺ · 1 soru bekliyor · 2 kargo bekliyor');
  assert.equal(formatMoney({ currency: 'EUR', amount: 12.5 }, 2), '12,50 €');
});

test('arayüz kopyası (apps/web/src/market-calc.ts) çekirdektekiyle birebir aynı', () => {
  const core = fs.readFileSync(path.join(here, '../src/market-calc.ts'), 'utf8');
  const web = fs.readFileSync(path.join(here, '../../../apps/web/src/market-calc.ts'), 'utf8');
  assert.equal(web, core);
});
