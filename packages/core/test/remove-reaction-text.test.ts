import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-remove-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { bus } = await import('../src/bus.js');
const { trReactionText } = await import('../src/reaction-text.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('tepki metinleri Türkçe: platform önizlemesi ve SMS tepkileri; olağan metin aynen', () => {
  assert.equal(trReactionText('Liked a message'), '👍 Bir mesajı beğendi');
  assert.equal(trReactionText('Ayşe liked your message'), '👍 Ayşe mesajını beğendi');
  assert.equal(trReactionText('You liked a message'), '👍 Bir mesajı beğendin');
  assert.equal(trReactionText('Laughed at a message'), '😂 Bir mesaja güldü');
  assert.equal(trReactionText('Ayşe reacted ❤️ to your message'), '❤️ Ayşe mesajına tepki verdi');
  assert.equal(trReactionText('Reacted 😂 to a message'), '😂 Bir mesaja tepki verdi');
  assert.equal(trReactionText('Liked “yarın görüşelim”'), '👍 “yarın görüşelim” mesajını beğendi');
  assert.equal(trReactionText('Removed a like from “selam”'), '“selam” mesajındaki tepkisini geri aldı');
  for (const s of ['I liked a message yesterday lol', 'Merhaba', 'liked', '']) assert.equal(trReactionText(s), s);
});

test('kaldır: hesap hemen listeden ve aramadan kalkar, mesajlar dilimlerle silinir, geri dirilmez; yarıda kalan açılışta biter', async () => {
  const store = new Store(path.join(tmp, 'r.db'));
  const reg = new Registry(store);
  const removed: string[] = [];
  const off = bus.on((ev) => ev.type === 'account.removed' && removed.push(ev.accountId));
  const acc = { id: 'x:1', platform: 'x' as const, label: 'x', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  store.upsertChat({ id: 'x:1/c', accountId: 'x:1', platform: 'x', remoteId: 'c', name: 'Ali', kind: 'direct', unread: 0, lastMessageAt: 1, lastPreview: '', tags: [] });
  store.transaction(() => {
    for (let i = 0; i < 4500; i++) store.upsertMessage({ id: `x:1/c/${i}`, chatId: 'x:1/c', remoteId: String(i), senderId: 'a', senderName: 'Ali', fromMe: false, status: 'read' as const, text: `kaldirmatesti ${i}`, ts: i });
  });
  assert.equal(store.search('kaldirmatesti').length > 0, true);
  await reg.remove('x:1');
  assert.deepEqual(removed, ['x:1'], 'olay hemen');
  assert.equal(store.getAccount('x:1'), undefined, 'hesap hemen gizli');
  assert.equal(store.listChats().filter((c) => c.accountId === 'x:1').length, 0);
  assert.equal(store.search('kaldirmatesti').length, 0);
  store.upsertAccount({ ...acc, status: 'connected' });
  for (let i = 0; i < 100 && store.pendingPurges().length; i++) await sleep(10);
  assert.deepEqual(store.pendingPurges(), []);
  store.upsertAccount({ ...acc, status: 'connected' });
  assert.equal(store.listAccounts().length, 0, 'durdurulan connector durum yazınca hesap geri gelmez');
  assert.equal(store.listMessages('x:1/c', 10).length, 0);

  // yarıda kalmış kaldırma (bayrak duruyor): bootAll hesabı başlatmaz, verisini siler
  store.upsertAccount({ ...acc, id: 'x:2' });
  store.setFlag('removing:x:2');
  const reg2 = new Registry(store);
  await reg2.bootAll();
  for (let i = 0; i < 100 && store.pendingPurges().length; i++) await sleep(10);
  assert.equal(reg2.get('x:2'), undefined);
  assert.equal(store.listAccounts().length, 0);
  off();
  await reg.stopAll();
  store.close();
});
