import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mautrix köprüsü bağlayıcısı: köprü olaylarının Mivelo modeline çevrilmesi (köprü süreci taklit edilir)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mx-'));
process.env.KAVSAK_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { Store } = await import('../src/store.js');
const { sidecar } = await import('../src/connectors/mautrix/sidecar.js');
const { MautrixConnector, roomOf } = await import('../src/connectors/mautrix/connector.js');
const { sessionDir } = await import('../src/config.js');
const { bus } = await import('../src/bus.js');

const store = new Store(path.join(tmp, 't.db'));
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Ev = Record<string, unknown>;
const calls: Array<{ m: string; p: Record<string, unknown> }> = [];
const replies: Record<string, (p: Record<string, unknown>) => unknown> = {
  connect: () => ({ name: 'kaan.ig' }),
  chats: () => ({ chats: [] }),
  send: () => ({ rid: 'mid.sent1', ts: 1_700_000_100_000 }),
  react: () => ({}),
  unreact: () => ({ removed: '$r' }),
  read: () => ({}),
  disconnect: () => ({}),
};
const sc = sidecar as unknown as { ready: () => Promise<void>; call: (m: string, p: Record<string, unknown>) => Promise<unknown>; listeners: Set<(e: Ev) => void> };
sc.ready = async () => undefined;
sc.call = async (m, p) => {
  calls.push({ m, p });
  const f = replies[m];
  if (!f) throw new Error('beklenmeyen çağrı ' + m);
  return f(p);
};
const fire = (e: Ev) => {
  for (const fn of [...sc.listeners]) fn({ net: 'instagram', login: 'L1', ...e } as never);
};

const account = { id: 'instagram:t1', platform: 'instagram' as const, label: 'instagram', status: 'disconnected' as const, createdAt: 1 };
store.upsertAccount(account);
fs.mkdirSync(sessionDir(account.id), { recursive: true });
fs.writeFileSync(path.join(sessionDir(account.id), 'mautrix.json'), JSON.stringify({ login: 'L1', migrated: true }));
const room = roomOf('thread-1', 'L1');
const cid = 'instagram:t1/thread-1';

test('var olan oturum: connect çağrılır, ad hesap etiketine yazılır, CONNECTED → bağlı', async () => {
  const c = new MautrixConnector({ ...account }, store);
  await c.start({ interactive: false });
  assert.deepEqual(calls.find((x) => x.m === 'connect')?.p, { net: 'instagram', login: 'L1' });
  assert.equal(store.getAccount(account.id)?.label, 'kaan.ig');
  fire({ ev: 'status', state: 'CONNECTED' });
  assert.equal(store.getAccount(account.id)?.status, 'connected');

  // sohbet + canlı mesaj (okunmamış artar) + köprü odası kimliği Go ile aynı biçimde
  assert.equal(room, `!${Buffer.from('thread-1').toString('base64url')}~${Buffer.from('L1').toString('base64url')}:mivelo.local`);
  fire({ ev: 'chat', room, portal: 'thread-1', name: 'Ayşe', type: 'dm', other: 'u1', otherIds: ['username:ayse'], avatar: 'mxc://d/abc' });
  const chat = store.getChat(cid)!;
  assert.equal(chat.name, 'Ayşe');
  assert.equal(chat.kind, 'direct');
  assert.equal(chat.handle, '@ayse');
  assert.match(chat.avatarUrl ?? '', /^\/api\/media\/instagram%3At1\?u=mx%3Amxc%3A%2F%2Fd%2Fabc$/);
  fire({ ev: 'message', room, portal: 'thread-1', rid: 'mid.1', ts: 1_700_000_000_000, live: true, sender: { id: 'u1', name: 'Ayşe' }, content: { msgtype: 'm.text', body: 'merhaba' } });
  const m = store.getMessage(`${cid}#mid.1`)!;
  assert.equal(m.text, 'merhaba');
  assert.equal(m.fromMe, false);
  assert.equal(store.getChat(cid)!.unread, 1);

  // fotoğraf + başlık, alıntılı yanıt
  fire({
    ev: 'message', room, portal: 'thread-1', rid: 'mid.2', ts: 1_700_000_001_000, live: true, reply: 'mid.1', sender: { id: 'u1', name: 'Ayşe' },
    content: { msgtype: 'm.image', body: 'bak', filename: 'a.jpg', url: 'mxc://d/img', info: { mimetype: 'image/jpeg', size: 10 } },
  });
  const img = store.getMessage(`${cid}#mid.2`)!;
  assert.equal(img.text, 'bak');
  assert.equal(img.attachments?.[0].kind, 'image');
  assert.equal(img.attachments?.[0].name, 'a.jpg');
  assert.equal(img.replyTo?.remoteId, 'mid.1');
  assert.equal(img.replyTo?.text, 'merhaba');

  // tepki / tepkiyi geri alma / düzenleme / herkesten silme
  fire({ ev: 'reaction', room, portal: 'thread-1', target: 'mid.1', key: '❤️', live: true, sender: { id: 'u1', name: 'Ayşe' } });
  assert.equal(store.getMessage(`${cid}#mid.1`)!.reactions?.[0].emoji, '❤️');
  fire({ ev: 'redact', room, portal: 'thread-1', kind: 'reaction', target: 'mid.1', key: '❤️', sender: { id: 'u1' } });
  assert.equal(store.getMessage(`${cid}#mid.1`)!.reactions?.length ?? 0, 0);
  fire({ ev: 'edit', room, portal: 'thread-1', target: 'mid.1', content: { msgtype: 'm.text', body: 'merhabalar' } });
  assert.equal(store.getMessage(`${cid}#mid.1`)!.text, 'merhabalar');
  assert.equal(store.getMessage(`${cid}#mid.1`)!.edited, true);
  fire({ ev: 'redact', room, portal: 'thread-1', kind: 'message', target: 'mid.2', sender: { id: 'u1' } });
  assert.equal(store.getMessage(`${cid}#mid.2`)!.deleted, true);

  // başka cihazımda okudum → Mivelo'da okundu
  fire({ ev: 'receipt', room, portal: 'thread-1', rid: 'mid.2', sender: { me: true } });
  assert.equal(store.getChat(cid)!.unread, 0);

  // gönderim: köprüye oda + yanıt kimliği gider, kendi mesajım kaydedilir
  const sent = await c.sendText('thread-1', 'selam', { replyTo: 'mid.1' });
  assert.equal(sent.remoteId, 'mid.sent1');
  const sendCall = calls.find((x) => x.m === 'send')!.p;
  assert.equal(sendCall.room, room);
  assert.equal(sendCall.replyTo, 'mid.1');
  const mine = store.getMessage(`${cid}#mid.sent1`)!;
  assert.equal(mine.fromMe, true);
  assert.equal(mine.status, 'sent');

  // karşı taraf gördü → kendi mesajım "görüldü"
  fire({ ev: 'receipt', room, portal: 'thread-1', rid: 'mid.sent1', sender: { id: 'u1' } });
  assert.equal(store.getMessage(`${cid}#mid.sent1`)!.status, 'read');

  // tepki ver / geri al
  await c.react('thread-1', 'mid.1', '👍', false);
  assert.ok(store.getMessage(`${cid}#mid.1`)!.reactions?.some((r) => r.fromMe && r.emoji === '👍'));
  await c.react('thread-1', 'mid.1', '👍', true);
  assert.ok(!store.getMessage(`${cid}#mid.1`)!.reactions?.some((r) => r.fromMe));

  // geçmiş (toplu, canlı değil): okunmamış yalnız son kendi mesajımdan sonra gelenler
  fire({ ev: 'chat', room: roomOf('g1', 'L1'), portal: 'g1', name: 'Grup', type: 'default' });
  for (const [i, me] of [[1, false], [2, true], [3, false], [4, false]] as const)
    fire({ ev: 'message', room: roomOf('g1', 'L1'), portal: 'g1', rid: `g.${i}`, ts: 1_700_000_000_000 + i, live: false, sender: me ? { me: true } : { id: 'u2', name: 'Ali' }, content: { msgtype: 'm.text', body: `m${i}` } });
  fire({ ev: 'batch', room: roomOf('g1', 'L1'), portal: 'g1', forward: true, markRead: false, count: 4 });
  const g = store.getChat('instagram:t1/g1')!;
  assert.equal(g.kind, 'group');
  assert.equal(g.unread, 2);

  // oturum düştü → kullanıcı eylemi gerekir
  fire({ ev: 'status', state: 'BAD_CREDENTIALS', message: 'checkpoint' });
  assert.equal(store.getAccount(account.id)?.status, 'pairing');
  await c.stop();
});

test('başka hesabın olayları işlenmez', async () => {
  const c = new MautrixConnector({ ...account }, store);
  await c.start({ interactive: false });
  const before = store.listChatsOf(account.id).length;
  for (const fn of [...sc.listeners]) fn({ ev: 'chat', net: 'instagram', login: 'BASKA', portal: 'x9', room: roomOf('x9', 'BASKA'), name: 'Yabancı', type: 'dm' } as never);
  for (const fn of [...sc.listeners]) fn({ ev: 'chat', net: 'x', login: 'L1', portal: 'x8', room: roomOf('x8', 'L1'), name: 'Yabancı', type: 'dm' } as never);
  assert.equal(store.listChatsOf(account.id).length, before);
  await c.stop();
  bus.emit({ type: 'log', level: 'info', text: 'bitti' });
});
