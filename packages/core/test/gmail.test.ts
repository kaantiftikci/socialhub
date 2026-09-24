import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGmailDate, parseDownloadUrl, isInboxListUrl, isSignedOutUrl } from '../src/connectors/browser/gmail.js';

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

test('parseGmailDate: canlı Gmail örnekleri (satır title, ileti span.g3 title, İngilizce arayüz)', () => {
  // gelen kutusu satırı td.xW span[title]
  assert.equal(parseGmailDate('24 Eyl 2026 Per 13:08', now), new Date(2026, 8, 24, 13, 8).getTime());
  assert.equal(parseGmailDate('23 Eyl 2026 Çar 22:54', now), new Date(2026, 8, 23, 22, 54).getTime());
  assert.equal(parseGmailDate('20 Eyl 2026 Paz 00:38', now), new Date(2026, 8, 20, 0, 38).getTime());
  // ileti başlığı span.g3[title]
  assert.equal(parseGmailDate('23 Eyl 2026 21:06', now), new Date(2026, 8, 23, 21, 6).getTime());
  // title yoksa innerText: "13:08 (42 dakika önce)" / "23 Eyl Çar 21:06 (16 saat önce)"
  assert.equal(parseGmailDate('23 Eyl Çar 21:06 (16 saat önce)', now), new Date(2026, 8, 23, 21, 6).getTime());
  // İngilizce arayüz: gün adı önde, dar boşluklu (U+202F) AM/PM
  assert.equal(parseGmailDate('Wed, Sep 23, 2026, 9:06 PM', now), new Date(2026, 8, 23, 21, 6).getTime());
});

test('parseDownloadUrl: çift kök önekli Gmail ek adresi, ad içinde ":" ve görsel türü', () => {
  const a = parseDownloadUrl('application/pdf:Invoice_TR2026-17759.pdf:https://mail.google.com/mail/u/0/https://mail.google.com/mail/u/0?ui=2&ik=c84e43ef11&attid=0.1&permmsgid=msg-f:1876797859941651966&th=1a0bb9b5bd0915fe&view=att&zw&disp=safe');
  assert.deepEqual(a, {
    kind: 'file',
    name: 'Invoice_TR2026-17759.pdf',
    mime: 'application/pdf',
    url: undefined,
    link: 'https://mail.google.com/mail/u/0?ui=2&ik=c84e43ef11&attid=0.1&permmsgid=msg-f:1876797859941651966&th=1a0bb9b5bd0915fe&view=att&zw&disp=safe',
  });
  const img = parseDownloadUrl('image/png:ekran 12:30.png:https://mail.google.com/mail/u/0?ui=2&attid=0.2&view=att');
  assert.equal(img?.kind, 'image');
  assert.equal(img?.name, 'ekran 12:30.png');
  assert.equal(img?.url, 'https://mail.google.com/mail/u/0?ui=2&attid=0.2&view=att');
  assert.equal(parseDownloadUrl('bozuk'), undefined);
});

test('isInboxListUrl / isSignedOutUrl: dizi görünümünde liste yok sayılır, giriş sayfası oturum düşmüş', () => {
  assert.equal(isInboxListUrl('https://mail.google.com/mail/u/0/#inbox'), true);
  assert.equal(isInboxListUrl('https://mail.google.com/mail/u/0/'), true);
  assert.equal(isInboxListUrl('https://mail.google.com/mail/u/0/#inbox/p2'), true);
  assert.equal(isInboxListUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgzQhWTmcDznCdWlmTgQnxxHVzhJK'), false);
  assert.equal(isInboxListUrl('https://mail.google.com/mail/u/0/#search/has%3Aattachment'), false);
  assert.equal(isSignedOutUrl('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com'), true);
  assert.equal(isSignedOutUrl('https://workspace.google.com/intl/tr/gmail/'), true);
  assert.equal(isSignedOutUrl('https://mail.google.com/mail/u/0/#inbox'), false);
});
