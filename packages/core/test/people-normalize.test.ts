import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatIdentity, nameKey, normalizeEmail, normalizePhone, normalizeUsername } from '../src/people.js';

test('telefon E.164: TR varsayılan ülke kodu, biçim farkları', () => {
  assert.equal(normalizePhone('+90 500 000 00 99'), '+905000000099');
  assert.equal(normalizePhone('0500 000 00 99'), '+905000000099');
  assert.equal(normalizePhone('500 000 0099'), '+905000000099');
  assert.equal(normalizePhone('00905000000099'), '+905000000099');
  assert.equal(normalizePhone('(0500) 000-00-99'), '+905000000099');
  assert.equal(normalizePhone('+1 555 000 0099'), '+15550000099');
  assert.equal(normalizePhone('ornek@example.com'), undefined);
  assert.equal(normalizePhone('12'), undefined);
  assert.equal(normalizePhone(''), undefined);
});

test('e-posta ve kullanıcı adı normalleştirme', () => {
  assert.equal(normalizeEmail(' Ornek@Example.COM '), 'ornek@example.com');
  assert.equal(normalizeEmail('Örnek Kişi <ornek@example.com>'), 'ornek@example.com');
  assert.equal(normalizeEmail('ornek@googlemail.com'), 'ornek@gmail.com');
  assert.equal(normalizeEmail('yok@'), undefined);
  assert.equal(normalizeUsername('@Ornek.Kisi'), 'ornek.kisi');
  assert.equal(normalizeUsername('@ab'), undefined);
  assert.equal(normalizeUsername('123456'), undefined);
});

test('ad anahtarı: Türkçe karakter, büyük/küçük harf, emoji, unvan ve sıra farkı yok; en az iki kelime', () => {
  const k = nameKey('Ayşe Yılmaz');
  assert.equal(k, 'ayse yilmaz');
  assert.equal(nameKey('AYŞE YILMAZ 🌸'), k);
  assert.equal(nameKey('Dr. Ayşe Yılmaz'), k);
  assert.equal(nameKey('Yılmaz, Ayşe'), k);
  assert.equal(nameKey('ayse yilmaz'), k);
  assert.equal(nameKey('Ayşe Hanım Yılmaz'), k);
  assert.equal(nameKey('Ayşe'), undefined);
  assert.equal(nameKey('Ayşe Y.'), undefined);
  assert.equal(nameKey('+90 500 000 00 99'), undefined);
  assert.equal(nameKey('WhatsApp kişisi'), undefined);
  assert.equal(nameKey('Bu bir e-posta konu satırı ve çok uzun'), undefined);
});

test('sohbet kimlikleri: WhatsApp jid, iMessage tanıtıcısı, e-posta karşı adresi, Instagram @, Telegram telefonu', () => {
  const wa = chatIdentity({ platform: 'whatsapp', remote_id: '905000000099@s.whatsapp.net', name: 'Ayşe Yılmaz', handle: '+905000000099', meta: null, pjson: null });
  assert.deepEqual(wa.phones, ['+905000000099']);
  assert.equal(wa.name, 'ayse yilmaz');
  const im = chatIdentity({ platform: 'imessage', remote_id: 'iMessage;-;+905000000099', name: 'Ayşe', handle: null, meta: null, pjson: null });
  assert.deepEqual(im.phones, ['+905000000099']);
  const im2 = chatIdentity({ platform: 'imessage', remote_id: 'iMessage;-;ornek@example.com', name: 'Ayşe', handle: null, meta: null, pjson: null });
  assert.deepEqual(im2.emails, ['ornek@example.com']);
  const mail = chatIdentity({ platform: 'gmail', remote_id: 'gm:1', name: 'Toplantı notları', handle: 'Ornek@example.com', meta: null, pjson: JSON.stringify([{ id: 'ornek@example.com', name: 'Ayşe Yılmaz', handle: 'ornek@example.com' }]) });
  assert.equal(mail.mailAddr, 'ornek@example.com');
  assert.equal(mail.name, 'ayse yilmaz', 'e-postada ad konudan değil karşı taraftan');
  const noreply = chatIdentity({ platform: 'gmail', remote_id: 'gm:2', name: 'Kampanya', handle: 'noreply@example.com', meta: null, pjson: JSON.stringify([{ id: 'noreply@example.com', name: 'Ayşe Yılmaz' }]) });
  assert.equal(noreply.name, undefined);
  const ig = chatIdentity({ platform: 'instagram', remote_id: '123', name: 'Ayşe Yılmaz 🌸', handle: '@ayse.yilmaz', meta: null, pjson: null });
  assert.deepEqual(ig.users, ['ayse.yilmaz']);
  const tg = chatIdentity({ platform: 'telegram', remote_id: '42', name: 'Ayşe', handle: '@ayse', meta: JSON.stringify({ phone: '+905000000099' }), pjson: null });
  assert.deepEqual(tg.phones, ['+905000000099']);
  assert.deepEqual(tg.users, ['ayse']);
});
