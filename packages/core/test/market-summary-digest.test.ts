import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'Europe/Istanbul';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-market-'));
process.env.MIVELO_DATA_DIR = tmp;
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { checkDigest, clearMarketCache, digestDue, marketSummary, readDigestSettings, writeDigestSettings } = await import('../src/market-summary.js');

const DAY = '2026-09-30';
const t = (hm: string, day = DAY) => new Date(`${day}T${hm}:00+03:00`);

test('digestDue: seçilen saatten sonra günde bir kez, kapalıyken hiç', () => {
  const s = { enabled: true, time: '21:00' };
  assert.equal(digestDue(s, t('20:59')), false);
  assert.equal(digestDue(s, t('21:00')), true);
  assert.equal(digestDue({ ...s, lastSent: DAY }, t('22:00')), false);
  assert.equal(digestDue({ ...s, lastSent: '2026-09-29' }, t('23:59')), true);
  assert.equal(digestDue({ ...s, enabled: false }, t('22:00')), false);
  assert.equal(digestDue({ enabled: true, time: '25:00' }, t('22:00')), false);
});

test('ayar dosyası: varsayılan 21:00 açık, bozuk saat varsayılana döner', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 's-'));
  assert.deepEqual(readDigestSettings(dir), { enabled: true, time: '21:00' });
  writeDigestSettings({ enabled: false, time: '18:30' }, dir);
  assert.deepEqual(readDigestSettings(dir), { enabled: false, time: '18:30' });
  fs.writeFileSync(path.join(dir, 'market-digest.json'), JSON.stringify({ enabled: true, time: 'akşam' }));
  assert.equal(readDigestSettings(dir).time, '21:00');
});

test('depodan özet ve gün sonu bildirimi (yalnız pazaryeri hesabı varken, günde bir kez)', () => {
  const store = new Store(path.join(tmp, 'm.db'));
  const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
  // pazaryeri hesabı yok: bildirim yok, dosyaya yazılmaz
  store.upsertAccount({ id: 'wa:1', platform: 'whatsapp', label: 'w', status: 'connected', createdAt: 1 });
  assert.equal(checkDigest(store, t('21:05'), dir), null);
  assert.equal(fs.existsSync(path.join(dir, 'market-digest.json')), false);

  store.upsertAccount({ id: 'trendyol:1', platform: 'trendyol', label: 'Trendyol', status: 'connected', createdAt: 1 });
  const chat = (rid: string, meta: Record<string, unknown>) =>
    store.upsertChat({ id: `trendyol:1/${rid}`, accountId: 'trendyol:1', platform: 'trendyol', remoteId: rid, name: rid, kind: 'direct', unread: 0, lastMessageAt: t('10:00').getTime(), lastPreview: '', tags: [], meta });
  chat('order-1', { order: { id: '1', status: 'Created', dateCreated: t('09:00').toISOString(), currency: 'TRY', totals: { total: 8000 }, items: [{ title: 'Keten gömlek', quantity: 1, total: 8000 }] } });
  chat('order-2', { order: { id: '2', status: 'Picking', dateCreated: t('11:00').toISOString(), currency: 'TRY', totals: { total: '450.00' }, items: [{ title: 'Kupa', quantity: 1, total: '450.00' }] } });
  chat('q-1', { question: { id: 'q1', status: 'WAITING_FOR_ANSWER', statusLabel: 'Cevap bekliyor', productName: 'Keten gömlek', dateCreated: t('12:00').toISOString() } });
  chat('q-2', { question: { id: 'q2', status: 'WAITING_FOR_ANSWER', statusLabel: 'Cevap bekliyor', productName: 'Kupa', dateCreated: t('12:30').toISOString() } });
  chat('q-3', { question: { id: 'q3', status: 'WAITING_FOR_ANSWER', statusLabel: 'Cevap bekliyor', productName: 'Kupa', dateCreated: t('13:00').toISOString() } });
  clearMarketCache();

  const s = marketSummary(store, DAY, null, t('20:00').getTime());
  assert.equal(s.hasShop, true);
  assert.equal(s.orders, 2);
  assert.deepEqual(s.revenue, [{ currency: 'TRY', amount: 8450 }]);
  assert.equal(s.questions.waiting, 3);

  writeDigestSettings({ enabled: true, time: '21:00' }, dir);
  assert.equal(checkDigest(store, t('20:30'), dir), null, 'saatinden önce yok');
  const d = checkDigest(store, t('21:01'), dir);
  assert.ok(d);
  assert.equal(d.day, DAY);
  assert.equal(d.text, 'Gün sonu özeti: 2 sipariş · 8.450 ₺ · 3 soru bekliyor · 2 kargo bekliyor');
  assert.equal(checkDigest(store, t('21:30'), dir), null, 'aynı gün ikinci kez yok');
  assert.equal(readDigestSettings(dir).lastSent, DAY);
  store.close();
});
