import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSend, resetSendGuard, SendBlocked, DAILY_LIMIT } from '../src/send-guard.js';

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
  assert.throws(() => checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'x', text: 'bir tane daha', now: day1 }), /yarına kadar/);
  checkSend({ accountId: 'li', platform: 'linkedin', chatId: 'x', text: 'bir tane daha', now: day1 + 24 * 3_600_000 });
});
