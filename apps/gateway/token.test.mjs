// node --test apps/gateway/token.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sign, verify, signDelete, verifyDelete, safeEqual } from './token.mjs';

const SECRET = 'a'.repeat(16) + 'B9-_x'.repeat(4);
const NOW = 1_790_000_000;

/** PHP arka ucunun yaptığının birebir karşılığı (base64 → +/ yerine -_, = dolgusu atılır) */
function phpToken(payloadJson, secret) {
  const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const p = b64u(Buffer.from(payloadJson));
  return `${p}.${b64u(createHmac('sha256', secret).update(p).digest())}`;
}

test('geçerli belirteç: PHP biçimiyle üretilen de doğrulanır', () => {
  assert.deepEqual(verify(sign({ u: 'u-admin', e: NOW + 60 }, SECRET), SECRET, NOW), { u: 'u-admin', e: NOW + 60 });
  // PHP json_encode çıktısı (anahtar sırası/boşluk fark etmez)
  assert.deepEqual(verify(phpToken('{"u":"u-b1f2e37fe2b5","e":1790000100}', SECRET), SECRET, NOW), { u: 'u-b1f2e37fe2b5', e: 1790000100 });
  assert.deepEqual(verify(phpToken('{"e":1790000100, "u":"u-abc"}', SECRET), SECRET, NOW), { u: 'u-abc', e: 1790000100 });
});

test('süresi dolmuş, yanlış sır, oynanmış imza/yük reddedilir', () => {
  const t = sign({ u: 'u-test1', e: NOW + 60 }, SECRET);
  assert.equal(verify(t, SECRET, NOW + 60), null, 'bitiş anında geçersiz');
  assert.equal(verify(t, SECRET, NOW + 3600), null);
  assert.equal(verify(t, SECRET.replace('a', 'b'), NOW), null);
  const [p, s] = t.split('.');
  assert.equal(verify(`${p}.${s.slice(0, -1)}${s.at(-1) === 'A' ? 'B' : 'A'}`, SECRET, NOW), null);
  // yük değiştirilip eski imza kullanılırsa
  const p2 = Buffer.from(JSON.stringify({ u: 'u-admin', e: NOW + 60 })).toString('base64url');
  assert.equal(verify(`${p2}.${s}`, SECRET, NOW), null);
});

test('biçim: dolgu, fazladan parça, geçersiz kimlik, bozuk JSON, boş sır reddedilir', () => {
  const t = sign({ u: 'u-test1', e: NOW + 60 }, SECRET);
  assert.equal(verify(`${t}=`, SECRET, NOW), null);
  assert.equal(verify(`${t}.x`, SECRET, NOW), null);
  assert.equal(verify('', SECRET, NOW), null);
  assert.equal(verify(undefined, SECRET, NOW), null);
  assert.equal(verify('a'.repeat(2000), SECRET, NOW), null);
  assert.equal(verify(t, '', NOW), null);
  for (const u of ['admin', 'u-AB', 'u-ab', 'u-../x', 'u-a_b_c', `u-${'a'.repeat(41)}`, 5])
    assert.equal(verify(sign({ u, e: NOW + 60 }, SECRET), SECRET, NOW), null, String(u));
  for (const e of ['9999999999', null, Infinity]) assert.equal(verify(sign({ u: 'u-test1', e }, SECRET), SECRET, NOW), null, String(e));
  const bad = Buffer.from('{"u":"u-test1",').toString('base64url');
  assert.equal(verify(`${bad}.${createHmac('sha256', SECRET).update(bad).digest('base64url')}`, SECRET, NOW), null);
  const arr = Buffer.from('["u-test1"]').toString('base64url');
  assert.equal(verify(`${arr}.${createHmac('sha256', SECRET).update(arr).digest('base64url')}`, SECRET, NOW), null);
});

test('üye silme imzası: "delete:<uid>:<ts>", ±300 sn, kimlik biçimi', () => {
  const sig = signDelete('u-test1', NOW, SECRET);
  assert.equal(sig, createHmac('sha256', SECRET).update(`delete:u-test1:${NOW}`).digest('base64url'));
  assert.equal(verifyDelete('u-test1', NOW, sig, SECRET, NOW + 299), true);
  assert.equal(verifyDelete('u-test1', NOW, sig, SECRET, NOW - 299), true);
  assert.equal(verifyDelete('u-test1', NOW, sig, SECRET, NOW + 301), false);
  assert.equal(verifyDelete('u-test2', NOW, sig, SECRET, NOW), false);
  assert.equal(verifyDelete('u-test1', NOW + 1, sig, SECRET, NOW), false);
  assert.equal(verifyDelete('u-test1', String(NOW), sig, SECRET, NOW), false, 'ts sayı olmalı');
  assert.equal(verifyDelete('u-test1', NOW + 0.5, sig, SECRET, NOW), false);
  assert.equal(verifyDelete('../etc', NOW, signDelete('../etc', NOW, SECRET), SECRET, NOW), false);
  assert.equal(verifyDelete('u-test1', NOW, `${sig}=`, SECRET, NOW), false);
  assert.equal(verifyDelete('u-test1', NOW, undefined, SECRET, NOW), false);
  assert.equal(verifyDelete('u-test1', NOW, sig, '', NOW), false);
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
