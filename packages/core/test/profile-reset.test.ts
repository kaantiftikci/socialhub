import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-profile-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { validateProfile, saveProfile, readProfile, ProfileError, PROFILE_FILE } = await import('../src/profile.js');
const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');

test('profil doğrulama: geçerli alanlar temizlenir, boşlar atılır', () => {
  const p = validateProfile({ name: '  Örnek Kişi ', username: '@ornek.kisi', email: 'ornek@example.com', phone: '+90 500 000 00 99', photo: '' });
  assert.deepEqual(p, { name: 'Örnek Kişi', username: 'ornek.kisi', email: 'ornek@example.com', phone: '+90 500 000 00 99' });
});

test('profil doğrulama: hatalı e-posta/telefon/kullanıcı adı/fotoğraf reddedilir', () => {
  assert.throws(() => validateProfile({ email: 'yok@' }), ProfileError);
  assert.throws(() => validateProfile({ phone: 'abc' }), ProfileError);
  assert.throws(() => validateProfile({ username: 'boşluk var' }), ProfileError);
  assert.throws(() => validateProfile({ photo: 'data:image/svg+xml;base64,AAAA' }), ProfileError);
  assert.throws(() => validateProfile({ name: 'x'.repeat(61) }), ProfileError);
});

test('profil kaydedilir (0600) ve geri okunur', () => {
  saveProfile({ name: 'Örnek', photo: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(readProfile(), { name: 'Örnek', photo: 'data:image/png;base64,iVBORw0KGgo=' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(PROFILE_FILE()).mode & 0o777, 0o600);
});

test('removeAll her hesabı kaldırır ve bitince döner; wipeAll kalan her şeyi siler', async () => {
  const store = new Store(path.join(tmp, 'w.db'));
  const reg = new Registry(store);
  for (const id of ['telegram:a1', 'whatsapp:b2']) {
    store.upsertAccount({ id, platform: id.split(':')[0] as 'telegram', label: 'x', status: 'disconnected', createdAt: 1 });
    store.upsertChat({ id: `${id}/c`, accountId: id, platform: id.split(':')[0] as 'telegram', remoteId: 'c', name: 'Sohbet', kind: 'direct', unread: 0, lastMessageAt: 1, lastPreview: 'örnek', tags: [] });
    store.upsertMessage({ id: `${id}/c/m`, chatId: `${id}/c`, remoteId: 'm', senderId: 'o', senderName: 'Kişi', fromMe: false, text: 'örnek', ts: 1, status: 'read' });
  }
  store.setFlag('boot_ms:genel', '5');
  const n = await reg.removeAll();
  assert.equal(n, 2);
  assert.deepEqual(store.listAccounts(), []);
  store.wipeAll();
  assert.equal(store.meta('boot_ms:genel'), undefined);
  assert.equal(store.search('örnek', 10).length, 0);
});
