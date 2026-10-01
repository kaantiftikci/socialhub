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

test('wipeAll büyük veritabanında hızlı; tetikleyiciler geri kurulur, eklenen mesaj yine aranır', async () => {
  const { installLibrary } = await import('../src/library.js');
  const store = new Store(path.join(tmp, 'big.db'));
  installLibrary(store);
  const id = 'telegram:big';
  store.upsertAccount({ id, platform: 'telegram', label: 'x', status: 'connected', createdAt: 1 });
  for (let c = 0; c < 40; c++) {
    store.upsertChat({ id: `${id}/c${c}`, accountId: id, platform: 'telegram', remoteId: `c${c}`, name: 'Sohbet', kind: 'direct', unread: 0, lastMessageAt: 1, lastPreview: 'örnek', tags: [] });
    store.transaction(() => {
      for (let i = 0; i < 1000; i++)
        store.upsertMessage({ id: `${id}/c${c}/m${i}`, chatId: `${id}/c${c}`, remoteId: `m${i}`, senderId: 'o', senderName: 'Kişi', fromMe: false, text: `örnek mesaj ${i} https://example.com/${i}`, ts: i + 1, status: 'read' });
    });
  }
  const triggersBefore = (store.sql("SELECT count(*) n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }).n;
  const t0 = Date.now();
  store.hideAccounts([id]);
  assert.deepEqual(store.listAccounts(), []);
  store.wipeAll();
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `wipeAll ${ms} ms`);
  const triggersAfter = (store.sql("SELECT count(*) n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }).n;
  assert.equal(triggersAfter, triggersBefore);
  assert.equal((store.sql('SELECT count(*) n FROM messages').get() as { n: number }).n, 0);
  assert.equal((store.sql('SELECT count(*) n FROM library_dirty').get() as { n: number }).n, 0);
  // silinen hesap geç gelen yazımla geri dirilmez
  store.upsertAccount({ id, platform: 'telegram', label: 'x', status: 'connected', createdAt: 1 });
  assert.deepEqual(store.listAccounts(), []);
  // yeni hesap normal çalışır, FTS tetikleyicisi geri kurulmuş
  const nid = 'telegram:new';
  store.upsertAccount({ id: nid, platform: 'telegram', label: 'y', status: 'connected', createdAt: 2 });
  store.upsertChat({ id: `${nid}/c`, accountId: nid, platform: 'telegram', remoteId: 'c', name: 'Yeni', kind: 'direct', unread: 0, lastMessageAt: 1, lastPreview: '', tags: [] });
  store.upsertMessage({ id: `${nid}/c/m`, chatId: `${nid}/c`, remoteId: 'm', senderId: 'o', senderName: 'Kişi', fromMe: false, text: 'yepyeni kelime', ts: 5, status: 'read' });
  assert.equal(store.search('yepyeni', 10).length, 1);
  assert.equal(store.listAccounts().length, 1);
});
