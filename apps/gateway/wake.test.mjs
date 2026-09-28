// node --test apps/gateway/wake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextScheduled, dueForWake, holdForSend, WAKE_LEAD_MS, WAKE_LATE_MS } from './wake.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-wake-'));
const NOW = 1_790_000_000_000;

test('en erken bekleyen gönderim; kaçırılanlar ve bozuk kayıtlar sayılmaz', () => {
  const dir = tmp();
  assert.equal(nextScheduled(dir), null); // dosya yok
  fs.writeFileSync(path.join(dir, 'scheduled.json'), 'bozuk');
  assert.equal(nextScheduled(dir), null);
  fs.writeFileSync(
    path.join(dir, 'scheduled.json'),
    JSON.stringify([
      { id: 'a', at: NOW + 50_000, missed: { reason: 'x', at: NOW } },
      { id: 'b', at: NOW + 90_000 },
      { id: 'c', at: 'yarın' },
      null,
      { id: 'd', at: NOW + 60_000 },
    ]),
  );
  assert.equal(nextScheduled(dir), NOW + 60_000);
  fs.writeFileSync(path.join(dir, 'scheduled.json'), '[]');
  assert.equal(nextScheduled(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uyandırma penceresi: az önce ile kaçırılma sınırı arası', () => {
  assert.equal(dueForWake(null, NOW), false);
  assert.equal(dueForWake(NOW + WAKE_LEAD_MS + 1000, NOW), false); // daha erken
  assert.equal(dueForWake(NOW + WAKE_LEAD_MS, NOW), true);
  assert.equal(dueForWake(NOW - 5 * 60_000, NOW), true); // gecikmiş ama hâlâ gönderilebilir
  assert.equal(dueForWake(NOW - WAKE_LATE_MS - 1000, NOW), false); // çekirdek zaten "kaçırıldı" sayar
});

test('yakında gönderim varken boşta durdurma ertelenir', () => {
  assert.equal(holdForSend(null, NOW), false);
  assert.equal(holdForSend(NOW + 4 * 60_000, NOW), true);
  assert.equal(holdForSend(NOW + 60 * 60_000, NOW), false); // uzak: durdur, zamanı gelince uyandırılır
  assert.equal(holdForSend(NOW - 60_000, NOW), true);
});
