import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-storage-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const st = await import('../src/storage.js');

const DAY = 86_400_000;
function put(acc: string, name: string, type: string | null, bytes: number, ageDays: number) {
  const dir = path.join(tmp, 'sessions', acc, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(bytes));
  if (type !== null) fs.writeFileSync(`${f}.type`, type);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(f, t, t);
  return f;
}

test('türlere göre boyut; e-posta ekleri ayrı; sohbet boyutları', async () => {
  const store = new Store(path.join(tmp, 's.db'));
  store.upsertAccount({ id: 'whatsapp:1', platform: 'whatsapp', label: 'wa', status: 'connected', createdAt: 1 });
  store.upsertChat({ id: 'whatsapp:1/a', accountId: 'whatsapp:1', platform: 'whatsapp', remoteId: 'a', name: 'Ayşe', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  for (let i = 0; i < 3; i++) store.upsertMessage({ id: `whatsapp:1/a#m${i}`, chatId: 'whatsapp:1/a', remoteId: `m${i}`, senderId: 'o', senderName: 'Ayşe', fromMe: false, text: 'merhaba', ts: i + 1, status: 'read' });
  put('whatsapp:1', 'aaa', 'image/jpeg', 1000, 1);
  put('whatsapp:1', 'bbb', 'video/mp4', 5000, 100);
  put('whatsapp:1', 'ccc', 'audio/ogg', 300, 100);
  put('whatsapp:1', 'ddd', 'application/pdf', 700, 100);
  put('whatsapp:1', 'out-x.jpg', null, 50, 100);
  put('gmail:ornek@example.com', 'eee', 'image/png', 900, 100);
  const r = await st.storageReport(store, { fresh: true, dbPath: path.join(tmp, 's.db') });
  assert.equal(r.parts.images, 1000);
  assert.equal(r.parts.videos, 5000);
  assert.equal(r.parts.audio, 300);
  assert.equal(r.parts.files, 700);
  assert.ok(r.parts.mail >= 900, 'e-posta ekleri ayrı sayılır');
  assert.ok(r.parts.messages > 0);
  assert.equal(r.chats[0].chatId, 'whatsapp:1/a');
  assert.equal(r.chats[0].messages, 3);
  store.close();
});

test('temizleme: yalnız seçilen türler, gün sınırı, e-posta ve gönderilen kopyalar korunur', async () => {
  const r1 = await st.clearMediaCache({ olderThanDays: 30, kinds: ['images', 'videos'] });
  assert.equal(r1.files, 1, 'yalnız 100 günlük video (1 günlük görsel kalır)');
  assert.equal(r1.bytes, 5000);
  const media = path.join(tmp, 'sessions', 'whatsapp:1', 'media');
  assert.ok(fs.existsSync(path.join(media, 'aaa')));
  assert.ok(!fs.existsSync(path.join(media, 'bbb')) && !fs.existsSync(path.join(media, 'bbb.type')));
  const r2 = await st.clearMediaCache({ olderThanDays: 0, kinds: ['images', 'videos', 'audio', 'files'] });
  assert.equal(r2.files, 3);
  assert.ok(fs.existsSync(path.join(media, 'out-x.jpg')), 'iMessage gönderilen kopyası silinmez');
  assert.ok(fs.existsSync(path.join(tmp, 'sessions', 'gmail:ornek@example.com', 'media', 'eee')), 'e-posta eki silinmez');
});

test('tür tahmini', () => {
  assert.equal(st.kindOfType('image/webp'), 'images');
  assert.equal(st.kindOfType('video/quicktime'), 'videos');
  assert.equal(st.kindOfType('audio/mpeg'), 'audio');
  assert.equal(st.kindOfType(''), 'files');
});
