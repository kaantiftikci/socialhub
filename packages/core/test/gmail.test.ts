import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGmailDate } from '../src/connectors/browser/gmail.js';

const now = new Date(2026, 8, 24, 12, 0);
test('parseGmailDate: Türkçe tam tarih, İngilizce, yalnız saat, gün+ay', () => {
  assert.equal(parseGmailDate('24 Eyl 2026 14:32', now), new Date(2026, 8, 24, 14, 32).getTime());
  assert.equal(parseGmailDate('3 Temmuz 2025 Per 09:05', now), new Date(2025, 6, 3, 9, 5).getTime());
  assert.equal(parseGmailDate('Sep 24, 2026, 2:32 PM', now), new Date(2026, 8, 24, 14, 32).getTime());
  assert.equal(parseGmailDate('14:32', now), new Date(2026, 8, 24, 14, 32).getTime());
  assert.equal(parseGmailDate('12 Ağu', now), new Date(2026, 7, 12).getTime());
  assert.equal(parseGmailDate('30 Ara', now), new Date(2025, 11, 30).getTime()); // gelecek → geçen yıl
  assert.equal(parseGmailDate(''), undefined);
});
