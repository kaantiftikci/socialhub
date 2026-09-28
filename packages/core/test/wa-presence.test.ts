import test from 'node:test';
import assert from 'node:assert/strict';
import { markActive, onUiInactive } from '../src/activity.js';

test('activity: etkinden boşa geçişte onUiInactive bir kez çağrılır (WhatsApp çevrimdışı bildirimi)', () => {
  const now = Date.now();
  markActive(false, now);
  let idle = 0;
  const off = onUiInactive(() => idle++);
  markActive(false, now + 1); // zaten boşta: çağrı yok
  assert.equal(idle, 0);
  markActive(true, now + 2);
  markActive(true, now + 3);
  assert.equal(idle, 0);
  markActive(false, now + 4);
  assert.equal(idle, 1);
  off();
  markActive(true, now + 5);
  markActive(false, now + 6);
  assert.equal(idle, 1, 'abonelik kaldırıldı');
});
