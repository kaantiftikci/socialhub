import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-sync-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { EventBatcher, QUIET_MSG_MAX } = await import('../src/ws-batch.js');
const { WhatsAppConnector } = await import('../src/connectors/whatsapp.js');
type Chat = import('../src/model.js').Chat;
type Message = import('../src/model.js').Message;

const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, accountId: 'a', platform: 'demo', remoteId: id, name: id, kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [], ...extra });
const msg = (chatId: string, id: string, extra: Partial<Message> = {}): Message => ({ id: `${chatId}#${id}`, chatId, remoteId: id, senderId: 'u', senderName: 'U', fromMe: false, text: 't', ts: 1, status: 'delivered', ...extra });

test('EventBatcher: sohbet bir kez (son hali), mesaj olayı sohbetsiz, hesap durumu birleştirilir', () => {
  const b = new EventBatcher();
  assert.equal(b.take(), undefined, 'boş demet yok');
  b.push({ type: 'chat.upsert', chat: chat('c1', { unread: 1 }) });
  b.push({ type: 'message.upsert', message: msg('c1', 'm1'), chat: chat('c1', { unread: 2 }), live: true });
  b.push({ type: 'message.upsert', message: msg('c1', 'm2'), chat: chat('c1', { unread: 3 }) });
  b.push({ type: 'account.status', account: { id: 'a', platform: 'demo', label: 'x', status: 'connecting', createdAt: 1 } });
  b.push({ type: 'account.status', account: { id: 'a', platform: 'demo', label: 'x', status: 'connected', createdAt: 1 } });
  const out = b.take()!;
  assert.equal(out.chats.length, 1);
  assert.equal(out.chats[0].unread, 3, 'sohbetin en son hali');
  const msgs = out.events.filter((e) => e.type === 'message.upsert');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((e) => !('chat' in e)), 'mesaj olayı sohbeti taşımaz');
  assert.equal((msgs[0] as { live?: boolean }).live, true);
  const st = out.events.filter((e) => e.type === 'account.status');
  assert.equal(st.length, 1, 'aynı hesabın durumundan yalnız sonuncusu');
  assert.equal((st[0] as { account: { status: string } }).account.status, 'connected');
  assert.equal(b.take(), undefined, 'alınan demet sıfırlanır');
});

test('EventBatcher: silme/yeniden ekleme sırası ve geçmiş mesaj sınırı (refetch)', () => {
  const b = new EventBatcher();
  b.push({ type: 'chat.upsert', chat: chat('c1') });
  b.push({ type: 'chat.delete', chatId: 'c1' });
  b.push({ type: 'chat.delete', chatId: 'c2' });
  b.push({ type: 'chat.upsert', chat: chat('c2') });
  let out = b.take()!;
  assert.deepEqual(out.deletes, ['c1'], 'eklenip silinen: yalnız silme');
  assert.deepEqual(out.chats.map((c) => c.id), ['c2'], 'silinip yeniden eklenen: yalnız ekleme');
  for (let i = 0; i < QUIET_MSG_MAX + 20; i++) b.push({ type: 'message.upsert', message: msg(i < QUIET_MSG_MAX ? 'c1' : 'c9', `m${i}`), chat: chat(i < QUIET_MSG_MAX ? 'c1' : 'c9') });
  // aynı mesajın güncellemesi yeni olay saymaz
  b.push({ type: 'message.upsert', message: msg('c1', 'm0', { status: 'read' }), chat: chat('c1') });
  out = b.take()!;
  const msgs = out.events.filter((e) => e.type === 'message.upsert') as Array<{ message: Message }>;
  assert.equal(msgs.length, QUIET_MSG_MAX, 'fazlası tek tek gitmez');
  assert.deepEqual(out.refetch, ['c9'], 'fazlası olan sohbet yeniden okunur');
  assert.equal(msgs.find((e) => e.message.id === 'c1#m0')?.message.status, 'read', 'aynı mesajdan son hali');
});

test('store: son mesaj durumu (lastStatus), katılımcılar okununca çözülür, en eski gerçek mesaj, hasChat', () => {
  const store = new Store(path.join(tmp, 's.db'));
  store.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  const parts = [{ id: 'u1', name: 'Ali' }, { id: 'u2', name: 'Veli' }];
  store.upsertChat({ ...chat('demo:1/g', { accountId: 'demo:1', remoteId: 'g', kind: 'group' }), participants: parts });
  assert.equal(store.hasChat('demo:1/g'), true);
  assert.equal(store.hasChat('demo:1/yok'), false);
  store.upsertMessage({ ...msg('demo:1/g', 'local-1', { fromMe: true, ts: 5, status: 'pending' }) });
  store.upsertMessage({ ...msg('demo:1/g', 'r1', { ts: 10 }) });
  store.upsertMessage({ ...msg('demo:1/g', 'r2', { fromMe: true, ts: 20, status: 'sent' }) });
  let c = store.getChat('demo:1/g')!;
  assert.equal(c.lastFromMe, true);
  assert.equal(c.lastStatus, 'sent');
  store.updateStatus('demo:1/g#r2', 'read');
  c = store.getChat('demo:1/g')!;
  assert.equal(c.lastStatus, 'read', 'alındı gelince listedeki tik de');
  assert.equal(store.listChats().find((x) => x.id === 'demo:1/g')?.lastStatus, 'read');
  assert.deepEqual(c.participants, parts);
  assert.deepEqual(JSON.parse(JSON.stringify(c)).participants, parts, 'JSON yayınında katılımcılar var');
  assert.deepEqual({ ...c }.participants, parts, 'kopyada katılımcılar var');
  c.participants = [];
  assert.deepEqual(c.participants, [], 'yazılabilir');
  assert.equal(store.oldestRealMessage('demo:1/g')?.remoteId, 'r1', 'yerel kayıt sayılmaz');
  assert.equal(store.oldestRealMessage('demo:1/g', 15)?.remoteId, 'r1');
  assert.equal(store.oldestRealMessage('demo:1/g', 10), undefined);
  store.close();
});

test('WhatsApp: geçmiş paketi mesajları arka planda dilimlerle yazılır, bekleyici sonra çözülür', async () => {
  const store = new Store(path.join(tmp, 'wa.db'));
  const account = { id: 'whatsapp:t', platform: 'whatsapp' as const, label: 'WhatsApp', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const wa = new WhatsAppConnector({ ...account }, store) as unknown as { queueHistory: (m: unknown[], done?: () => void) => void; histQueue: unknown[] };
  const jid = '905551112233@s.whatsapp.net';
  const msgs = Array.from({ length: 1200 }, (_, i) => ({
    key: { remoteJid: jid, id: `ID${i}`, fromMe: i % 2 === 0 },
    message: { conversation: `mesaj ${i}` },
    messageTimestamp: 1_700_000_000 + i,
  }));
  let done = false;
  wa.queueHistory(msgs, () => (done = true));
  assert.equal(done, false, 'eşzamanlı yazılmaz (olay döngüsü kilitlenmesin)');
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 10_000) await new Promise((r) => setImmediate(r));
  assert.equal(done, true);
  assert.equal(wa.histQueue.length, 0);
  const cid = `whatsapp:t/${jid}`;
  assert.equal(store.listMessages(cid, 5000).length, 1200);
  const c = store.getChat(cid)!;
  assert.equal(c.lastPreview, 'mesaj 1199');
  assert.equal(c.unread, 0, 'geçmiş mesajı okunmamış saymaz');
  store.close();
});
