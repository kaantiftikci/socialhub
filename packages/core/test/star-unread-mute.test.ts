import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-star-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `s${++n}.db`));
  const account = { id: `demo:${n}`, platform: 'demo' as const, label: 'x', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const cid = `${account.id}/c`;
  store.upsertChat({ id: cid, accountId: account.id, platform: 'demo', remoteId: 'c', name: 'Sohbet', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  return { store, account, cid };
}

test('yıldız: setStarred kalıcı, listStarred en yeni önce, eşitleme (upsert) yıldızı silmez', () => {
  const { store, cid } = setup();
  const base = { chatId: cid, senderId: 'a', senderName: 'A', fromMe: false, status: 'delivered' as const };
  store.upsertMessage({ ...base, id: `${cid}#1`, remoteId: '1', text: 'eski', ts: 1000 });
  store.upsertMessage({ ...base, id: `${cid}#2`, remoteId: '2', text: 'yeni', ts: 2000 });
  assert.equal(store.setStarred(`${cid}#1`, true)?.starred, true);
  assert.equal(store.setStarred(`${cid}#2`, true)?.starred, true);
  assert.deepEqual(store.listStarred().map((x) => x.message.remoteId), ['2', '1']);
  store.upsertMessage({ ...base, id: `${cid}#1`, remoteId: '1', text: 'eski', ts: 1000, status: 'read' });
  assert.equal(store.getMessage(`${cid}#1`)?.starred, true, 'yeniden eşitleme yıldızı korur');
  assert.equal(store.setStarred(`${cid}#1`, false)?.starred, undefined);
  assert.deepEqual(store.listStarred().map((x) => x.message.remoteId), ['2']);
});

test('okunmadı olarak işaretle: en az 1 okunmamış, markRead geri sıfırlar', () => {
  const { store, cid } = setup();
  store.upsertMessage({ chatId: cid, id: `${cid}#1`, remoteId: '1', senderId: 'a', senderName: 'A', fromMe: false, text: 'selam', ts: 5000, status: 'delivered' });
  store.markRead(cid);
  assert.equal(store.getChat(cid)?.unread, 0);
  assert.equal(store.setUnread(cid)?.unread, 1);
  assert.equal(store.setUnread(cid)?.unread, 1, 'ikinci kez artmaz');
  store.markRead(cid);
  assert.equal(store.getChat(cid)?.unread, 0);
  assert.equal(store.setUnread('yok'), undefined);
});

test('süreli sessiz: mutedUntil saklanır, süre dolunca okurken muted kalkar; sesi aç süreyi de siler', () => {
  const { store, cid } = setup();
  const until = Date.now() + 60_000;
  let c = store.setFlags(cid, { muted: true, mutedUntil: until })!;
  assert.equal(c.muted, true);
  assert.equal(c.mutedUntil, until);
  c = store.setFlags(cid, { muted: true, mutedUntil: Date.now() - 1 })!;
  assert.equal(c.muted, undefined, 'geçmiş bitiş: yazılırken bile sessiz sayılmaz');
  // geçmiş bir bitişi doğrudan DB'ye yaz (uygulama kapalıyken süre doldu senaryosu)
  store.sql('UPDATE chats SET flags = ? WHERE id = ?').run(JSON.stringify({ muted: true, mutedUntil: Date.now() - 5 }), cid);
  c = store.getChat(cid)!;
  assert.equal(c.muted, undefined);
  assert.equal(c.mutedUntil, undefined);
  c = store.setFlags(cid, { muted: true })!;
  assert.equal(c.muted, true);
  c = store.setFlags(cid, { muted: false })!;
  assert.equal(c.muted, undefined);
  assert.equal(c.mutedUntil, undefined);
});
