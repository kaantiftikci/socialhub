import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSend, resetSendGuard, SendBlocked, DAILY_LIMIT, NEW_LIMIT, sendUsage, persistSendGuard } from '../src/send-guard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('send-guard: aynı uzun metin 5 farklı sohbete gider, 6.sı engellenir; aynı sohbete tekrar serbest', () => {
  resetSendGuard();
  const text = 'Merhaba, yeni koleksiyonumuz yayında, göz atmak ister misin?';
  const now = 1_800_000_000_000;
  for (let i = 0; i < 5; i++) checkSend({ accountId: 'a', platform: 'instagram', chatId: `c${i}`, text, now: now + i });
  checkSend({ accountId: 'a', platform: 'instagram', chatId: 'c0', text, now: now + 10 }); // aynı kişiye yeniden: sorun değil
  assert.throws(() => checkSend({ accountId: 'a', platform: 'instagram', chatId: 'c9', text: text + '  ', now: now + 20 }), SendBlocked);
  // 30 dk sonra pencere boşalır
  checkSend({ accountId: 'a', platform: 'instagram', chatId: 'c9', text, now: now + 31 * 60_000 });
});

test('send-guard: kısa metinler ("tamam") tekrar sayılmaz; e-posta/pazaryeri kısıtlanmaz', () => {
  resetSendGuard();
  for (let i = 0; i < 20; i++) checkSend({ accountId: 'a', platform: 'whatsapp', chatId: `c${i}`, text: 'Teşekkürler!' });
  for (let i = 0; i < 1000; i++) checkSend({ accountId: 'm', platform: 'gmail', chatId: `c${i}`, text: 'Aynı uzun toplu e-posta metni burada' });
});

test('send-guard: günlük sınır dolunca durur, ertesi gün sıfırlanır', () => {
  resetSendGuard();
  const limit = DAILY_LIMIT.linkedin!;
  const day1 = Date.UTC(2026, 8, 26, 10);
  for (let i = 0; i < limit; i++) checkSend({ accountId: 'li', platform: 'linkedin', chatId: `c${i}`, text: `mesaj ${i}`, now: day1 });
  assert.throws(() => checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'x', text: 'bir tane daha', now: day1 }), /gece yarısına kadar/);
  checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'x', text: 'bir tane daha', now: day1 + 24 * 3_600_000 });
});

test('send-guard: ilk temas (soğuk mesaj) ayrı ve sıkı; yanıtlar ve aynı kişiye ikinci mesaj bu sınırı tüketmez', () => {
  resetSendGuard();
  const now = new Date(2026, 8, 26, 12).getTime();
  const lim = NEW_LIMIT.linkedin!;
  for (let i = 0; i < lim; i++) checkSend({ accountId: 'li', platform: 'linkedin', chatId: `yeni${i}`, text: `merhaba ${i}`, now, isNew: true });
  // aynı yeni kişiye ikinci mesaj serbest
  checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'yeni0', text: 'devam', now, isNew: true });
  assert.throws(() => checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'baska', text: 'selam', now, isNew: true }), /ilk mesaj/);
  // sana yazmış kişilere yanıt devam eder
  for (let i = 0; i < 50; i++) checkSend({ accountId: 'li', platform: 'linkedin', chatId: `yanit${i}`, text: `yanıt ${i}`, now, isNew: false });
  const u = sendUsage('li', 'linkedin', now);
  assert.equal(u.newChats, lim);
  assert.equal(u.sent, lim + 1 + 50);
  // yerel gece yarısında sıfırlanır
  const next = new Date(2026, 8, 27, 0, 0, 1).getTime();
  checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'baska', text: 'selam', now: next, isNew: true });
});

test('send-guard: sayaçlar dosyaya yazılır ve yeniden yüklenince korunur', async () => {
  resetSendGuard();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'send-guard.json');
  persistSendGuard(file);
  for (let i = 0; i < 3; i++) checkSend({ accountId: 'ig', platform: 'instagram', chatId: `c${i}`, text: `mesaj numara ${i}`, isNew: true });
  await new Promise((r) => setTimeout(r, 2300));
  assert.ok(fs.existsSync(file));
  resetSendGuard();
  assert.equal(sendUsage('ig', 'instagram').sent, 0);
  persistSendGuard(file);
  assert.equal(sendUsage('ig', 'instagram').sent, 3);
  assert.equal(sendUsage('ig', 'instagram').newChats, 3);
  resetSendGuard();
  assert.ok(DAILY_LIMIT.whatsapp! > 1000);
});
