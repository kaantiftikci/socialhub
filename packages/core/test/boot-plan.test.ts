import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootOrder, browserSlots, type BootInfo } from '../src/boot-plan.js';

const NOW = Date.UTC(2026, 8, 29, 12);
const acc = (id: string, platform: string) => ({ id, platform, label: id, status: 'disconnected', createdAt: 1 }) as BootInfo['account'];

test('açılış sırası: hafifler önce; tarayıcılarda okunmamış + yakın etkinlik + kısa açılış önde', () => {
  const list: BootInfo[] = [
    { account: acc('li', 'linkedin'), browser: true, unread: 0, lastAt: NOW - 20 * 86_400_000 },
    { account: acc('wa', 'whatsapp'), browser: false, unread: 3, lastAt: NOW },
    { account: acc('ig', 'instagram'), browser: true, unread: 5, lastAt: NOW - 3_600_000 },
    { account: acc('x', 'x'), browser: true, unread: 0, lastAt: NOW - 3_600_000, estMs: 60_000 },
    { account: acc('ms', 'messenger'), browser: true, unread: 0, lastAt: NOW - 3_600_000, estMs: 8_000 },
  ];
  // ağırlıklı en kısa iş önce: 8 sn süren Messenger, okunmamışlı ama 18 sn süren Instagram'ı yalnız 8 sn bekletir
  assert.deepEqual(bootOrder(list, NOW).map((b) => b.account.id), ['wa', 'ms', 'ig', 'x', 'li']);
});

test('aynı anda açılacak tarayıcı sayısı makineye göre 1–4', () => {
  delete process.env.MIVELO_BOOT_SLOTS;
  const GB = 1024 ** 3;
  assert.equal(browserSlots(8, 4 * GB), 2);
  assert.equal(browserSlots(16, 16 * GB), 4);
  assert.equal(browserSlots(2, 8 * GB), 1);
  assert.equal(browserSlots(12, 1 * GB), 1, 'bellek az');
});
