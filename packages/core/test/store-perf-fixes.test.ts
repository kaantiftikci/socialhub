import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-storefix-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BaseConnector } = await import('../src/connectors/base.js');
const { DELETED_TEXT } = await import('../src/model.js');
const Database = (await import('better-sqlite3-multiple-ciphers')).default;
type Chat = import('../src/model.js').Chat;
type Message = import('../src/model.js').Message;
type StoreT = InstanceType<typeof Store>;

const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, accountId: 'demo:1', platform: 'demo', remoteId: id.split('/')[1] ?? id, name: id, kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [], ...extra });
const msg = (chatId: string, id: string, extra: Partial<Message> = {}): Message => ({ id: `${chatId}#${id}`, chatId, remoteId: id, senderId: 'u', senderName: 'Ali Veli', fromMe: false, text: 't', ts: 1, status: 'delivered', ...extra });

let n = 0;
function fresh(): StoreT {
  const s = new Store(path.join(tmp, `s${n++}.db`));
  s.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  return s;
}
/** Store'un özel bağlantısında sorgu planı (yalnız test) */
function plan(s: StoreT, sql: string, ...args: unknown[]): string {
  const db = (s as unknown as { db: InstanceType<typeof Database> }).db;
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
}

test('store: findMessageByRemote remote_id dizinini kullanır, sonuç aynı', () => {
  const s = fresh();
  s.upsertChat(chat('demo:1/a'));
  s.upsertMessage(msg('demo:1/a', 'R1', { ts: 5 }));
  assert.equal(s.findMessageByRemote('demo:1', 'R1')?.id, 'demo:1/a#R1');
  assert.equal(s.findMessageByRemote('demo:1', 'yok'), undefined);
  assert.equal(s.findMessageByRemote('demo:2', 'R1'), undefined, 'başka hesap');
  assert.match(plan(s, "SELECT id FROM messages WHERE remote_id = ? AND chat_id LIKE ? ESCAPE '\\' LIMIT 1", 'R1', 'demo:1/%'), /messages_remote/);
  s.close();
});

test('store: dropLocalDuplicates aralık araması, anlam aynı (±10 dk sınırı, yalnız benden)', () => {
  const s = fresh();
  const cid = 'demo:1/a';
  s.upsertChat(chat(cid));
  const T = 10_000_000;
  s.upsertMessage(msg(cid, 'local-1', { fromMe: true, text: 'selam', ts: T }));
  s.upsertMessage(msg(cid, 'local-2', { fromMe: true, text: 'uzak', ts: T }));
  s.upsertMessage(msg(cid, 'local-3', { fromMe: true, text: 'gelen', ts: T }));
  s.upsertMessage(msg(cid, 'locale', { fromMe: true, text: 'selam', ts: T }));
  s.upsertMessage(msg(cid, 'real1', { fromMe: true, text: 'selam', ts: T + 599_999 }));
  s.upsertMessage(msg(cid, 'real2', { fromMe: true, text: 'uzak', ts: T + 600_000 }));
  s.upsertMessage(msg(cid, 'real3', { fromMe: false, text: 'gelen', ts: T + 1 }));
  assert.deepEqual(s.dropLocalDuplicates(cid), [`${cid}#local-1`]);
  assert.ok(s.hasMessage(`${cid}#local-2`) && s.hasMessage(`${cid}#local-3`) && s.hasMessage(`${cid}#locale`));
  const p = plan(s, "SELECT l.id FROM messages l WHERE l.chat_id = ? AND l.remote_id >= 'local-' AND l.remote_id < 'local.' AND l.from_me = 1", cid);
  assert.match(p, /remote_id>\? AND remote_id<\?/, p);
  s.close();
});

test('store: dropTwins zaman aralığıyla (chat_ts dizini), en iyi durumlu kalır', () => {
  const s = fresh();
  const cid = 'demo:1/a';
  s.upsertChat(chat(cid));
  const V = '🔒 tek seferlik';
  s.upsertMessage(msg(cid, 'A', { fromMe: true, senderId: 'me', text: V, ts: 1000, status: 'sent' }));
  s.upsertMessage(msg(cid, 'B', { fromMe: true, senderId: 'me', text: V, ts: 5000, status: 'read' }));
  s.upsertMessage(msg(cid, 'C', { fromMe: true, senderId: 'me', text: V, ts: 50_000, status: 'sent' }));
  assert.deepEqual(s.dropTwins(V), [`${cid}#A`]);
  assert.ok(s.hasMessage(`${cid}#C`), '10 sn dışı ikiz değil');
  s.close();
});

test('store: FTS tetikleyicisi yalnız metin değişince (eski kurulum göçü dahil)', () => {
  const file = path.join(tmp, 'fts-old.db');
  const s0 = new Store(file);
  s0.close();
  // eski kurulumu taklit et: koşulsuz tetikleyici + bayrak yok
  const raw = new Database(file);
  raw.exec(`DROP TRIGGER messages_au; CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
  raw.prepare("DELETE FROM meta WHERE key = 'fts_au_when_v1'").run();
  raw.close();
  const s = new Store(file);
  const sql = (s as unknown as { db: InstanceType<typeof Database> }).db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_au'").get() as { sql: string };
  assert.match(sql.sql, /WHEN old\.text IS NOT new\.text/);
  s.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  s.upsertChat(chat('demo:1/a'));
  s.upsertMessage(msg('demo:1/a', 'm1', { text: 'toplantı yarın', ts: 5 }));
  s.upsertMessage(msg('demo:1/a', 'm1', { text: 'toplantı yarın', ts: 5 }));
  assert.equal(s.search('toplantı').length, 1);
  s.upsertMessage(msg('demo:1/a', 'm1', { text: 'görüşme yarın', ts: 5 }));
  assert.equal(s.search('toplantı').length, 0, 'metin değişince FTS güncel');
  assert.equal(s.search('görüşme').length, 1);
  s.close();
});

test('store: arama ts dizini + ek adı kısmi dizini, sonuçlar yeniden eskiye', () => {
  const s = fresh();
  s.upsertChat(chat('demo:1/a'));
  for (let i = 0; i < 50; i++) s.upsertMessage(msg('demo:1/a', `m${i}`, { text: i % 2 ? `fatura ${i}` : 'başka', ts: 1000 + ((i * 37) % 50) }));
  s.upsertMessage(msg('demo:1/a', 'f1', { text: '', ts: 5000, attachments: [{ kind: 'file', name: 'Fatura-1042.pdf' }] }));
  const top = s.search('fatura', 10);
  assert.equal(top.length, 10);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].message.ts >= top[i].message.ts, 'ts sırası');
  const r = s.search('fatura', 100);
  assert.equal(r.length, 26, '25 metin + 1 ek adı');
  assert.equal(r[0].message.remoteId, 'f1', 'ek adıyla eşleşen en yeni');
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].message.ts >= r[i].message.ts, 'ts sırası');
  // en yeni 10 metin eşleşmesi, tamamının en yeni 10'u
  assert.deepEqual(top.map((x) => x.message.id), r.slice(1, 11).map((x) => x.message.id));
  assert.match(plan(s, 'SELECT m.* FROM messages m INDEXED BY messages_ts WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.ts DESC LIMIT ?', 'x', 5), /messages_ts/);
  s.close();
});

test('store: myTexts / styleSamples kendi mesajlarım dizininden, sonuç eskisiyle aynı', () => {
  const s = fresh();
  s.upsertChat(chat('demo:1/a'));
  s.upsertChat(chat('demo:1/b'));
  s.upsertChat(chat('demo:1/g', { kind: 'group' }));
  const now = Date.now();
  let t = now - 100_000;
  for (const cid of ['demo:1/a', 'demo:1/b', 'demo:1/g'])
    for (let i = 0; i < 6; i++) {
      s.upsertMessage(msg(cid, `q${i}`, { text: `soru ${cid} ${i}`, ts: t++ }));
      s.upsertMessage(msg(cid, `r${i}`, { fromMe: true, text: `yanıt ${cid} ${i}`, ts: t++ }));
    }
  const mt = s.myTexts('demo', 5);
  assert.equal(mt.length, 5);
  assert.equal(mt[0], 'yanıt demo:1/g 5', 'en yeni önce');
  assert.equal(s.myTexts(undefined, 3)[0], 'yanıt demo:1/g 5');
  assert.deepEqual(s.myTexts('whatsapp'), []);
  const ss = s.styleSamples('demo:1/a', 'demo');
  assert.equal(ss.filter((x) => x.scope === 'chat').length, 6);
  assert.deepEqual(ss.find((x) => x.scope === 'chat'), { them: 'soru demo:1/a 5', me: 'yanıt demo:1/a 5', scope: 'chat' });
  const plat = ss.filter((x) => x.scope === 'platform');
  assert.equal(plat.length, 4);
  assert.ok(plat.every((x) => x.me.startsWith('yanıt demo:1/b') && x.them === x.me.replace('yanıt', 'soru')), 'grup sohbeti yok, çift doğru');
  const p = plan(s, "SELECT m.rowid FROM messages m INDEXED BY messages_mine CROSS JOIN chats c ON c.id = m.chat_id WHERE m.from_me = 1 AND c.platform = ? ORDER BY m.ts DESC LIMIT ?", 'demo', 5);
  assert.match(p, /COVERING INDEX messages_mine/, p);
  s.close();
});

test('store: silinen/düzenlenen son mesaj özgün metinle yeniden eşitlenince önizleme sızmaz; tepki önizlemesi kalır', () => {
  const s = fresh();
  const cid = 'demo:1/g';
  s.upsertChat(chat(cid, { kind: 'group' }));
  s.upsertMessage(msg(cid, 'm1', { text: 'gizli içerik', ts: 10 }));
  s.applyEdit(`${cid}#m1`, null);
  s.upsertMessage(msg(cid, 'm1', { text: 'gizli içerik', ts: 10 }));
  assert.equal(s.getChat(cid)!.lastPreview, `Ali: ${DELETED_TEXT}`);
  const d = 'demo:1/d';
  s.upsertChat(chat(d));
  s.upsertMessage(msg(d, 'm1', { text: 'ilk hâli', ts: 10 }));
  s.applyEdit(`${d}#m1`, 'düzeltilmiş');
  s.upsertMessage(msg(d, 'm1', { text: 'ilk hâli', ts: 10 }));
  assert.equal(s.getChat(d)!.lastPreview, 'düzeltilmiş');
  // sonradan gelen ek (açıklama) önizlemeye yansır
  s.upsertMessage(msg(d, 'm2', { text: '', ts: 20 }));
  s.upsertMessage(msg(d, 'm2', { text: '', ts: 20, attachments: [{ kind: 'image', name: 'Fotoğraf' }] }));
  assert.equal(s.getChat(d)!.lastPreview, '[Fotoğraf]');
  s.setReactionPreview(d, '❤️ Ali mesajına tepki verdi');
  s.upsertMessage(msg(d, 'm2', { text: '', ts: 20, attachments: [{ kind: 'image', name: 'Fotoğraf' }] }));
  let c = s.getChat(d)!;
  assert.equal(c.lastReaction, true, 'yeniden yazım tepki önizlemesini silmez');
  assert.equal(c.lastPreview, '❤️ Ali mesajına tepki verdi');
  s.upsertMessage(msg(d, 'm3', { text: 'yeni', ts: 30 }), { bumpUnread: true });
  c = s.getChat(d)!;
  assert.equal(c.lastReaction, undefined);
  assert.equal(c.lastPreview, 'yeni');
  assert.equal(c.unread, 1);
  // eski mesajın yeniden yazımı özeti değiştirmez
  s.upsertMessage(msg(d, 'm1', { text: 'ilk hâli', ts: 10, status: 'read' }), { bumpUnread: true });
  c = s.getChat(d)!;
  assert.equal(c.lastPreview, 'yeni');
  assert.equal(c.unread, 1);
  s.close();
});

test('store: katılımcılar ayrı tabloda (göç, koruma, silmede kaskad), mesaj yazımı dokunmaz', () => {
  const file = path.join(tmp, 'parts-old.db');
  const s0 = new Store(file);
  s0.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  s0.upsertChat(chat('demo:1/g', { kind: 'group' }));
  s0.close();
  // eski kurulum: katılımcılar chats sütununda, bayrak yok
  const parts = [{ id: 'u1', name: 'Ali' }, { id: 'u2', name: 'Veli' }];
  const raw = new Database(file);
  raw.prepare('UPDATE chats SET participants = ? WHERE id = ?').run(JSON.stringify(parts), 'demo:1/g');
  raw.exec("DELETE FROM chat_participants; DELETE FROM meta WHERE key = 'participants_table_v1'");
  raw.close();
  const s = new Store(file);
  assert.deepEqual(s.getChat('demo:1/g')!.participants, parts, 'göç edildi');
  const db = (s as unknown as { db: InstanceType<typeof Database> }).db;
  assert.equal((db.prepare('SELECT participants FROM chats WHERE id = ?').get('demo:1/g') as { participants: string | null }).participants, null, 'eski sütun boşaltıldı');
  s.upsertChat(chat('demo:1/g', { kind: 'group', name: 'Grup' }));
  assert.deepEqual(s.getChat('demo:1/g')!.participants, parts, 'verilmezse korunur');
  assert.deepEqual(s.listChats().find((c) => c.id === 'demo:1/g')!.participants, parts);
  assert.deepEqual(s.listChatsOf('demo:1')[0].participants, parts);
  const p2 = [{ id: 'u3', name: 'Ayşe' }];
  s.upsertChat(chat('demo:1/g', { kind: 'group', participants: p2 }));
  assert.deepEqual(s.getChat('demo:1/g')!.participants, p2);
  s.upsertMessage(msg('demo:1/g', 'm1', { text: 'x', ts: 5 }));
  assert.deepEqual(s.getChat('demo:1/g')!.participants, p2);
  assert.equal(s.getChatLite('demo:1/g')!.participants, undefined);
  s.upsertChat(chat('demo:1/h', { kind: 'group', participants: parts }));
  s.mergeChats('demo:1/h', 'demo:1/g');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chat_participants').get() as { n: number }).n, 1, 'birleşen sohbetin listesi silindi');
  s.deleteAccount('demo:1');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chat_participants').get() as { n: number }).n, 0, 'hesap silinince kaskad');
  s.close();
});

class Probe extends BaseConnector {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendText(): Promise<{ remoteId: string }> {
    return { remoteId: 'x' };
  }
  put(input: Parameters<BaseConnector['upsertMessage']>[0]) {
    return this.upsertMessage(input, { live: true });
  }
}

test('base: yankı süzgeci WhatsApp grubunda başkasının aynı metinli mesajını yutmaz; köprü kanallarında sürer', () => {
  const s = new Store(path.join(tmp, 'echo.db'));
  for (const platform of ['whatsapp', 'instagram'] as const) {
    const account = { id: `${platform}:1`, platform, label: platform, status: 'connected' as const, createdAt: 1 };
    s.upsertAccount(account);
    const c = new Probe({ ...account }, s);
    const T = Date.now();
    const text = 'Hayırlı cumalar herkese';
    c.put({ remoteChatId: 'g', remoteId: 'me1', senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: T, status: 'sent' });
    const r = c.put({ remoteChatId: 'g', remoteId: 'o1', senderId: 'ayse', senderName: 'Ayşe', fromMe: false, text, ts: T + 40_000, status: 'delivered' });
    if (platform === 'whatsapp') assert.ok(r && s.hasMessage(`${platform}:1/g#o1`), 'WhatsApp: yazıldı');
    else assert.equal(r, undefined, 'köprü: yankı atıldı');
  }
  s.close();
});
