import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMailHtml } from '../src/connectors/mail-html.js';

test('cleanMailHtml: betik, olay ve tehlikeli adresler atılır; biçim kalır', () => {
  const out = cleanMailHtml(
    '<style>p{color:red}</style><p onclick="x()" style="font-weight:bold">Merhaba <a href="javascript:alert(1)">tık</a></p><script>alert(1)</script><iframe src="https://x"></iframe><img src="https://a/b.png" onerror="y()"><form action="/z"><input></form>',
    'https://mail.google.com/',
  )!;
  assert.match(out, /^<base href="https:\/\/mail\.google\.com\/">/);
  assert.match(out, /<style>p\{color:red\}<\/style>/);
  assert.match(out, /style="font-weight:bold"/);
  assert.doesNotMatch(out, /script|onclick|onerror|iframe|javascript:|<form/i);
  assert.match(out, /<img src="https:\/\/a\/b\.png">/);
});

test('cleanMailHtml: boş gövde yok sayılır', () => {
  assert.equal(cleanMailHtml('  '), undefined);
  assert.equal(cleanMailHtml(undefined), undefined);
});

import { fillListTimes, parseMailDate } from '../src/connectors/browser/outlook.js';

test('parseMailDate: Türkçe/İngilizce/Rusça biçimler, okunamayan undefined (asla NaN / şimdi değil)', () => {
  const now = new Date(2026, 8, 28, 15, 0);
  const d = (s: string) => {
    const t = parseMailDate(s, now);
    return t === undefined ? undefined : new Date(t).toISOString().slice(0, 16);
  };
  const iso = (y: number, mo: number, day: number, h = 0, mi = 0) => new Date(y, mo, day, h, mi).toISOString().slice(0, 16);
  assert.equal(d('12:45'), iso(2026, 8, 28, 12, 45));
  assert.equal(d('Dün 09:05'), iso(2026, 8, 27, 9, 5));
  assert.equal(d('Bugün 10:00'), iso(2026, 8, 28, 10, 0));
  assert.equal(d('Вчера в 9:05'), iso(2026, 8, 27, 9, 5));
  assert.equal(d('27 сент.'), iso(2026, 8, 27));
  assert.equal(d('3 мая 2025 г. в 14:20'), iso(2025, 4, 3, 14, 20));
  assert.equal(d('26 Eyl'), iso(2026, 8, 26));
  assert.equal(d('Sat, 27 Sep 2026 12:45:00 +0300') !== undefined, true);
  assert.equal(d('2026-09-20T08:00:00Z') !== undefined, true);
  assert.equal(d('Konu yok'), undefined);
  assert.equal(d(''), undefined);
});

test('fillListTimes: okunamayan satırlar komşudan, sıra korunur', () => {
  assert.deepEqual(fillListTimes([undefined, 1000_000, undefined, undefined, 500_000]), [1060_000, 1000_000, 940_000, 880_000, 500_000]);
  assert.deepEqual(fillListTimes([undefined, undefined]), [undefined, undefined]);
});
