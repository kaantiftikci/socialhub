import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlookRow, parseOutlookDate } from '../src/connectors/browser/outlook.js';

// 24 Eylül 2026 Perşembe 12:00
const now = new Date(2026, 8, 24, 12, 0);
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();

test('parseOutlookDate: OWA tam tarih (title) biçimleri', () => {
  assert.equal(parseOutlookDate('Çar 23.09.2026 14:32', now), at(2026, 8, 23, 14, 32));
  assert.equal(parseOutlookDate('23.09.2026 14:32', now), at(2026, 8, 23, 14, 32));
  assert.equal(parseOutlookDate('19.09.2026', now), at(2026, 8, 19));
  assert.equal(parseOutlookDate('Wed 9/23/2026 2:32 PM', now), at(2026, 8, 23, 14, 32));
  assert.equal(parseOutlookDate('Wed 9/23/2026 12:05 AM', now), at(2026, 8, 23, 0, 5));
  // görünmez yön işaretleri (RTL/LTR) ve fazla boşluk
  assert.equal(parseOutlookDate('‎Çar 23.09.2026  14:32‏', now), at(2026, 8, 23, 14, 32));
});

test('parseOutlookDate: liste satırı kısa biçimleri', () => {
  assert.equal(parseOutlookDate('14:32', now), at(2026, 8, 24, 14, 32));
  assert.equal(parseOutlookDate('2:32 PM', now), at(2026, 8, 24, 14, 32));
  assert.equal(parseOutlookDate('Çar 14:32', now), at(2026, 8, 23, 14, 32)); // bu haftanın çarşambası
  assert.equal(parseOutlookDate('Per 09:00', now), at(2026, 8, 24, 9, 0)); // bugün
  assert.equal(parseOutlookDate('Cum 10:00', now), at(2026, 8, 18, 10, 0)); // geçen cuma
  assert.equal(parseOutlookDate('Mon 4:05 PM', now), at(2026, 8, 21, 16, 5));
  assert.equal(parseOutlookDate('Dün 09:05', now), at(2026, 8, 23, 9, 5));
  assert.equal(parseOutlookDate('Yesterday 9:05 PM', now), at(2026, 8, 23, 21, 5));
  assert.equal(parseOutlookDate('19.09', now), at(2026, 8, 19));
  assert.equal(parseOutlookDate('30.12', now), at(2025, 11, 30)); // gelecek → geçen yıl
  assert.equal(parseOutlookDate('24 Eyl 14:32', now), at(2026, 8, 24, 14, 32));
  assert.equal(parseOutlookDate('3 Eylül 2025 09:05', now), at(2025, 8, 3, 9, 5));
  assert.equal(parseOutlookDate('Sep 23, 2026 2:32 PM', now), at(2026, 8, 23, 14, 32));
  assert.equal(parseOutlookDate('2026-09-23T10:00:00Z', now), Date.UTC(2026, 8, 23, 10));
});

test('parseOutlookDate: tarih olmayan metinler', () => {
  assert.equal(parseOutlookDate('', now), undefined);
  assert.equal(parseOutlookDate(undefined, now), undefined);
  assert.equal(parseOutlookDate('kaan@outlook.com', now), undefined);
  assert.equal(parseOutlookDate('Toplantı 5', now), undefined); // V8 Date.parse bunu tarih sayardı
  assert.equal(parseOutlookDate('Siparişiniz kargoya verildi', now), undefined);
});

test('outlookRow: okunmamış satır, title\'daki tam tarih, satır metinleri', () => {
  const r = outlookRow(
    {
      id: 'AQQk',
      label: 'Okunmamış, Shopier, Siparişiniz alındı, Merhaba Kaan siparişin hazırlanıyor, Çar 14:32',
      unread: true,
      senderName: 'Shopier',
      senderEmail: 'noreply@shopier.com',
      titles: ['noreply@shopier.com', 'Çar 23.09.2026 14:32'],
      lines: ['Shopier', 'Siparişiniz alındı', 'Çar 14:32', 'Merhaba Kaan siparişin hazırlanıyor'],
    },
    now,
  );
  assert.deepEqual(r, { subject: 'Siparişiniz alındı', sender: 'Shopier', email: 'noreply@shopier.com', preview: 'Merhaba Kaan siparişin hazırlanıyor', ts: at(2026, 8, 23, 14, 32), unread: true });
});

test('outlookRow: DOM satırı yoksa aria-label yedeği', () => {
  const r = outlookRow({ id: 'x', label: 'Ali Veli, Toplantı, yarın 10da, 19.09.2026', unread: false, senderName: '', senderEmail: '', titles: [], lines: [] }, now);
  assert.equal(r.sender, 'Ali Veli');
  assert.equal(r.subject, 'Toplantı');
  assert.equal(r.preview, 'yarın 10da');
  assert.equal(r.ts, at(2026, 8, 19));
  assert.equal(r.unread, false);
});

test('outlookRow: adres span\'ı yok, aria-label virgülsüz → gönderen/konu satır metninden', () => {
  const now = new Date(2026, 8, 24, 15, 0);
  const r = outlookRow(
    { id: 'y', label: "X X'e Mac işletim sisteminde yeni giriş 03:34 @kaan hesabına yeni bir cihazdan giriş Öğe seçilmedi", unread: false, senderName: '', senderEmail: '', titles: [], lines: ['X', 'X', "X'e Mac işletim sisteminde yeni giriş", '@kaan hesabına yeni bir cihazdan giriş', '03:34'] },
    now,
  );
  assert.equal(r.sender, 'X');
  assert.equal(r.subject, "X'e Mac işletim sisteminde yeni giriş");
  assert.match(r.preview, /@kaan hesabına/);
  const k = outlookRow({ id: 'z', label: 'Kaan Tiftikçi hk 14:23 denemee Öğe seçilmedi', unread: true, senderName: '', senderEmail: '', titles: [], lines: ['KT', 'Kaan Tiftikçi', 'hk', 'denemee', '14:23'] }, now);
  assert.equal(k.sender, 'Kaan Tiftikçi');
  assert.equal(k.subject, 'hk');
  assert.equal(k.preview, 'denemee');
});
