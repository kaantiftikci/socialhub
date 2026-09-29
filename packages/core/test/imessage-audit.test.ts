import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-imsg-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { IMessageConnector } = await import('../src/connectors/imessage.js');
type CoreEvent = Parameters<Parameters<typeof bus.on>[0]>[0];

const EPOCH = 978_307_200_000;
const apple = (ms: number) => BigInt(Math.floor(ms - EPOCH)) * 1_000_000n;

/** Sahte chat.db (yalnız connector'ın okuduğu sütunlar) */
function fakeChatDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER DEFAULT 0,
      cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 1, is_read INTEGER DEFAULT 0,
      date_read INTEGER DEFAULT 0, error INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_emoji TEXT, handle_id INTEGER);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, is_filtered INTEGER DEFAULT 0, service_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE chat_recoverable_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, total_bytes INTEGER, transfer_name TEXT, uti TEXT, hide_attachment INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle (ROWID, id) VALUES (1, '+905000000099');
    INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, 'iMessage;-;+905000000099', '+905000000099');
  `);
  const ins = db.prepare(
    `INSERT INTO message (ROWID, guid, text, date, is_from_me, is_read, handle_id, associated_message_type, associated_message_guid, cache_has_attachments)
     VALUES (@rowid, @guid, @text, @date, @me, @read, 1, @assoc, @assocGuid, @att)`,
  );
  const join = db.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)');
  const add = (rowid: number, o: { text?: string | null; ms?: number; me?: boolean; read?: boolean; assoc?: number; assocGuid?: string; att?: boolean; joined?: boolean } = {}) => {
    const date = apple(o.ms ?? Date.now());
    ins.run({ rowid, guid: `G${rowid}`, text: o.text === undefined ? `mesaj ${rowid}` : o.text, date, me: o.me ? 1 : 0, read: o.read ? 1 : 0, assoc: o.assoc ?? 0, assocGuid: o.assocGuid ?? null, att: o.att ? 1 : 0 });
    if (o.joined !== false) join.run(1, rowid, date);
  };
  return { db, add };
}

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `s${++n}.db`));
  const account = { id: `imessage:${n}`, platform: 'imessage' as const, label: 'x', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const chat = fakeChatDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = new IMessageConnector(account, store) as any;
  c.db = chat.db;
  c.retractedCol = 'm.date_retracted';
  c.editedCol = 'm.date_edited';
  c.filteredCol = 'c.is_filtered';
  c.assocCol = 'm.associated_message_type';
  c.assocGuidCol = 'm.associated_message_guid';
  c.assocEmojiCol = 'NULL';
  c.attStmt = chat.db.prepare(
    `SELECT a.ROWID AS rowid, a.filename, a.mime_type, a.total_bytes, a.transfer_name, a.uti, a.hide_attachment
       FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ? ORDER BY a.ROWID`,
  );
  c.retractAt = Date.now();
  c.unreadAt = Date.now();
  const cid = `${account.id}/iMessage;-;+905000000099`;
  return { store, c, chat, cid, account };
}

function capture() {
  const evs: CoreEvent[] = [];
  const off = bus.on((e) => {
    if (e.type !== 'log') evs.push(e);
  });
  return { evs, off };
}

test('poll: birikmiş satırlar dilimli işlemle yazılır, tapback hedefinden sonra uygulanır, imleç ilerler, yeniden giriş tek tur', async () => {
  const { store, c, chat, cid } = setup();
  const old = Date.now() - 86400e3;
  // tapback (ROWID 5) hedefi (ROWID 3) bağsız kalmış: bu turda recheckUnjoined ile listenin sonuna eklenir
  chat.add(3, { ms: old, joined: false });
  chat.add(5, { ms: old + 1000, text: null, assoc: 2000, assocGuid: 'p:0/G3' });
  for (let i = 10; i < 1510; i++) chat.add(i, { ms: old + i * 1000 });
  c.lastRowId = 2;
  await c.poll('test');
  assert.equal(c.lastRowId, 1509);
  assert.ok(store.hasMessage(`${cid}#G1509`));
  assert.ok(!store.hasMessage(`${cid}#G3`), 'bağsız satır bu turda yok');
  chat.db.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (1, 3, 0)').run();
  // tapback'i yeniden işlemek için: bağsız satır geldikten sonra aynı turda tapback'ten önce yazılmalı → tapback'i de yeniden sun
  chat.db.prepare('UPDATE message SET ROWID = 2000 WHERE ROWID = 5').run();
  chat.db.prepare('UPDATE chat_message_join SET message_id = 2000 WHERE message_id = 5').run();
  const p1 = c.poll('a');
  const p2 = c.poll('b'); // sürerken gelen tetik: ayrı tur değil, bittiğinde bir tur daha
  await Promise.all([p1, p2]);
  const m = store.getMessage(`${cid}#G3`);
  assert.ok(m, 'hedef mesaj yazıldı');
  assert.equal(m!.reactions?.[0]?.emoji, '❤️', 'tapback hedefinden sonra uygulandı');
  assert.equal(c.polling, false);
});

test('poll: 5000 satır tek parça kilit oluşturmaz (dilimler arası olay döngüsü döner)', async () => {
  const { store, c, chat, cid } = setup();
  const old = Date.now() - 86400e3;
  chat.db.transaction(() => {
    for (let i = 1; i <= 5000; i++) chat.add(i, { ms: old + i });
  })();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  const t0 = Date.now();
  await c.poll('test');
  clearInterval(iv);
  assert.ok(store.hasMessage(`${cid}#G5000`));
  assert.ok(ticks >= 3, `olay döngüsü dilimler arasında döndü (${ticks})`);
  assert.ok(Date.now() - t0 < 20_000);
});

test('syncUnread: Mivelo okuma noktasından eski okunmamışlar sayılmaz, değişmeyen sayaç yeniden yazılmaz', async () => {
  const { store, c, chat, cid } = setup();
  const old = Date.now() - 3600e3;
  for (let i = 1; i <= 4; i++) chat.add(i, { ms: old + i * 1000 });
  c.lastRowId = 0;
  await c.poll('ilk');
  c.syncUnread();
  assert.equal(store.getChat(cid)!.unread, 4);
  store.markRead(cid); // Mivelo'da okundu; chat.db'de is_read=0 kalır
  const cap = capture();
  c.syncUnread();
  c.syncUnread();
  cap.off();
  assert.equal(store.getChat(cid)!.unread, 0);
  assert.equal(cap.evs.length, 0, 'her turda chat.upsert yayılmaz');
  chat.add(10, { ms: Date.now() });
  await c.poll('izleyici');
  c.syncUnread();
  assert.equal(store.getChat(cid)!.unread, 1, 'yalnız okuma noktasından sonraki');
  chat.db.prepare('UPDATE message SET is_read = 1').run(); // telefonda okundu
  c.syncUnread();
  assert.equal(store.getChat(cid)!.unread, 0);
});

test('scanRecoverable: işlenmiş Son Silinenler dakikada bir yeniden yazılmaz; sohbet silindi işareti korunur', () => {
  const { store, c, chat, cid } = setup();
  const old = Date.now() - 86400e3;
  for (let i = 1; i <= 50; i++) {
    chat.add(i, { ms: old + i * 1000, joined: false });
    chat.db.prepare('INSERT INTO chat_recoverable_message_join (chat_id, message_id) VALUES (1, ?)').run(i);
  }
  c.scanRecoverable();
  assert.ok(store.getMessage(`${cid}#G1`)!.text.startsWith('🗑'));
  assert.equal(store.getChat(cid)!.meta?.deleted, true);
  const cap = capture();
  c.scanRecoverable();
  cap.off();
  assert.equal(cap.evs.length, 0, 'ikinci taramada yazım/yayın yok');
  chat.db.prepare('DELETE FROM chat_recoverable_message_join').run(); // kalıcı silindi / geri alındı
  c.scanRecoverable();
  assert.equal(store.getChat(cid)!.meta?.deleted, undefined);
});

test('ingest: depoda aynı duran mesaj açılışta yeniden yazılmaz; alındı değişince yazılır', async () => {
  const { store, c, chat, cid } = setup();
  const old = Date.now() - 86400e3;
  for (let i = 1; i <= 20; i++) chat.add(i, { ms: old + i * 1000, me: i % 2 === 0 });
  const rows = chat.db.prepare(`${c.selectSql} ORDER BY m.ROWID`).all();
  await c.ingestChunked(rows);
  const cap = capture();
  await c.ingestChunked(chat.db.prepare(`${c.selectSql} ORDER BY m.ROWID`).all());
  cap.off();
  assert.equal(cap.evs.length, 0, 'değişmeyen mesajlarda olay yok');
  chat.db.prepare('UPDATE message SET is_read = 1, date_read = 1 WHERE ROWID = 2').run();
  await c.ingestChunked(chat.db.prepare(`${c.selectSql} ORDER BY m.ROWID`).all());
  assert.equal(store.getMessage(`${cid}#G2`)!.status, 'read');
});

test('syncEdits: yerinde düzenleme canlı yansır (düzenlendi); gönderimi geri alma mesajı siler, sohbet "silinmiş" olmaz', async () => {
  const { store, c, chat, cid } = setup();
  chat.add(1, { ms: Date.now() - 60_000, text: 'ilk hâli' });
  chat.add(2, { ms: Date.now() - 30_000, text: 'geri alınacak' });
  await c.poll('ilk');
  chat.db.prepare('UPDATE message SET text = ?, date_edited = ? WHERE ROWID = 1').run('düzeltilmiş', apple(Date.now()));
  chat.db.prepare('UPDATE message SET text = NULL, attributedBody = NULL, date_retracted = ? WHERE ROWID = 2').run(apple(Date.now()));
  c.syncEdits();
  const m1 = store.getMessage(`${cid}#G1`)!;
  assert.equal(m1.text, 'düzeltilmiş');
  assert.equal(m1.edited, true);
  const m2 = store.getMessage(`${cid}#G2`)!;
  assert.equal(m2.deleted, true);
  assert.equal(store.getChat(cid)!.meta?.deleted, undefined);
  const cap = capture();
  c.syncEdits();
  cap.off();
  assert.equal(cap.evs.length, 0, 'değişmeyen düzenleme yeniden işlenmez');
});

test('sendText/sendMedia: gerçek satır osascript dönmeden yazıldıysa yerel kopya kalmaz', async () => {
  const { store, c, chat, cid } = setup();
  let row = 100;
  c.deliver = async (_chat: string, payload: { text?: string; file?: string }) => {
    row++;
    chat.add(row, { me: true, text: payload.text ?? null, att: !!payload.file });
    if (payload.file) {
      chat.db.prepare('INSERT INTO attachment (ROWID, filename, mime_type, transfer_name) VALUES (?, ?, ?, ?)').run(row, '/yok/foto.jpg', 'image/jpeg', 'foto.jpg');
      chat.db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(row, row);
    }
    await c.poll('izleyici'); // izleyici gerçek satırı osascript dönmeden yazar
  };
  c.lastRowId = 100;
  await c.sendText('iMessage;-;+905000000099', 'merhaba');
  const ids = () => store.listMessages(cid, 50).map((m) => m.remoteId);
  assert.deepEqual(ids().filter((x) => x.startsWith('local-')), [], 'metinde yerel kopya düştü');
  assert.ok(store.hasMessage(`${cid}#G101`));
  const f = path.join(tmp, 'foto.jpg');
  fs.writeFileSync(f, 'x');
  await c.sendMedia('iMessage;-;+905000000099', { path: f, name: 'foto.jpg', mime: 'image/jpeg', size: 1 });
  assert.ok(store.hasMessage(`${cid}#G102`));
  assert.deepEqual(ids().filter((x) => x.startsWith('local-')), [], 'ekte yerel kopya düştü');
});
