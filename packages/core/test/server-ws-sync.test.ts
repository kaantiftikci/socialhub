import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-srvws-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { createServer, isLite, streamBodyToFile } = await import('../src/server.js');
const { EventBatcher } = await import('../src/ws-batch.js');
const { bus } = await import('../src/bus.js');
const { WebSocket } = await import('ws');
type Chat = import('../src/model.js').Chat;
type Message = import('../src/model.js').Message;

const store = new Store(path.join(tmp, 'test.db'));
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const chatOf = (id: string, over: Partial<Chat> = {}): Chat => ({
  id,
  accountId: 'telegram:a',
  platform: 'telegram',
  remoteId: id.split('/')[1],
  name: 'Ayşe',
  kind: 'direct',
  unread: 0,
  lastMessageAt: 1000,
  lastPreview: 'Sen: merhaba',
  lastFromMe: true,
  tags: [],
  ...over,
});

test('ws-batch: aynı demette messages.read varsa sohbetin son hali olayların SONUNA da eklenir (taze hal ezilmez)', () => {
  const b = new EventBatcher();
  const fresh = chatOf('telegram:a/1', { unread: 1, lastFromMe: false, lastPreview: 'yanıt', lastMessageAt: 2000 });
  const msg = { id: 'telegram:a/1/m2', chatId: 'telegram:a/1', fromMe: false, ts: 2000, text: 'yanıt' } as unknown as Message;
  b.push({ type: 'message.upsert', message: msg, chat: fresh, live: true });
  b.push({ type: 'messages.read', chatId: 'telegram:a/1', before: 1000 });
  b.push({ type: 'chat.upsert', chat: fresh });
  const out = b.take()!;
  assert.equal(out.chats.length, 1);
  const types = out.events.map((e) => e.type);
  assert.deepEqual(types, ['message.upsert', 'messages.read', 'chat.upsert']);
  const last = out.events.at(-1) as { type: 'chat.upsert'; chat: Chat };
  assert.equal(last.chat.unread, 1);
  assert.equal(last.chat.lastPreview, 'yanıt');
  // messages.read olmayan demette ek olay yok (eski biçim)
  b.push({ type: 'chat.upsert', chat: fresh });
  assert.deepEqual(b.take()!.events, []);
  // sohbet aynı demette silindiyse eklenmez
  b.push({ type: 'chat.upsert', chat: fresh });
  b.push({ type: 'messages.read', chatId: 'telegram:a/1', before: 1 });
  b.push({ type: 'chat.delete', chatId: 'telegram:a/1' });
  assert.deepEqual(b.take()!.events.map((e) => e.type), ['messages.read']);
});

test('isLite: getChat (tembel katılımcı) tam, getChatLite hafif sayılır', () => {
  store.upsertAccount({ id: 'whatsapp:g', platform: 'whatsapp', label: 'wa', status: 'connected', createdAt: 1 });
  store.upsertChat({ ...chatOf('whatsapp:g/grp'), accountId: 'whatsapp:g', platform: 'whatsapp', kind: 'group', participants: [{ id: 'u1', name: 'Ali' }] as Chat['participants'] });
  assert.equal(isLite(store.getChat('whatsapp:g/grp')!), false);
  assert.equal(isLite(store.getChatLite('whatsapp:g/grp')!), true);
  assert.equal(isLite(chatOf('x/y')), true);
});

test('streamBodyToFile: gövde dosyaya akar; sınır aşılınca 413 ve kısmi dosya silinir', async () => {
  const f1 = path.join(tmp, 'ok.bin');
  const req1 = new PassThrough();
  const p1 = streamBodyToFile(req1 as unknown as http.IncomingMessage, f1, 1000);
  req1.write(Buffer.alloc(300, 1));
  req1.end(Buffer.alloc(200, 2));
  assert.equal(await p1, 500);
  assert.equal(fs.statSync(f1).size, 500);

  const f2 = path.join(tmp, 'big.bin');
  const req2 = new PassThrough();
  const p2 = streamBodyToFile(req2 as unknown as http.IncomingMessage, f2, 1000);
  req2.write(Buffer.alloc(800));
  req2.write(Buffer.alloc(800));
  await assert.rejects(p2, (e: Error & { status?: number }) => e.status === 413);
  assert.equal(fs.existsSync(f2), false);

  // yarıda kesilen yükleme: tanıtıcı kapanıp kısmi dosya silinir
  const f3 = path.join(tmp, 'cut.bin');
  const req3 = new PassThrough();
  const p3 = streamBodyToFile(req3 as unknown as http.IncomingMessage, f3, 1000);
  req3.write(Buffer.alloc(100));
  setTimeout(() => req3.emit('error', new Error('kesildi')), 10);
  await assert.rejects(p3, /kesildi/);
  assert.equal(fs.existsSync(f3), false);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Sunucu + WS istemcisi: gelen demetleri toplar. Yollar modül düzeyinde kaydedildiği için tek sunucu paylaşılır. */
const port = 39000 + Math.floor(Math.random() * 2000);
const sharedRegistry = new Registry(store);
const sharedServer = createServer(store, sharedRegistry, port);
await new Promise<void>((r) => sharedServer.once('listening', () => r()));
after(() => new Promise<void>((r) => sharedServer.close(() => r())));
async function withServer(fn: (ctx: { port: number; registry: InstanceType<typeof Registry>; connect: () => Promise<{ ws: InstanceType<typeof WebSocket>; frames: unknown[] }> }) => Promise<void>) {
  const sockets: Array<InstanceType<typeof WebSocket>> = [];
  const connect = async () => {
    const frames: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    await new Promise<void>((r, j) => (ws.once('open', () => r()), ws.once('error', j)));
    sockets.push(ws);
    return { ws, frames };
  };
  try {
    await fn({ port, registry: sharedRegistry, connect });
  } finally {
    for (const s of sockets) s.terminate();
    await wait(30);
  }
}
const eventsOf = (frames: unknown[]) => frames.flatMap((f) => ((f as { type: string }).type === 'batch' ? (f as { events: Array<{ type: string }> }).events : [f as { type: string }]));

test('WS: yeniden bağlanan arayüze süren eşitleme ilerlemesi ve bekleyen istem gönderilir; bitmiş olanlar gönderilmez', async () => {
  await withServer(async ({ connect }) => {
    // arayüz bağlı değilken yayılan olaylar (kesinti)
    bus.emit({ type: 'account.sync', accountId: 'whatsapp:s1', progress: 70, label: 'eşitleniyor' });
    bus.emit({ type: 'account.sync', accountId: 'whatsapp:s2', progress: 40 });
    bus.emit({ type: 'account.sync', accountId: 'whatsapp:s2', progress: 100 });
    bus.emit({ type: 'account.prompt', accountId: 'telegram:p', prompt: 'password', message: '2FA' });
    const { frames } = await connect();
    await wait(80);
    const evs = eventsOf(frames) as Array<{ type: string; accountId?: string; progress?: number }>;
    assert.ok(evs.some((e) => e.type === 'account.sync' && e.accountId === 'whatsapp:s1' && e.progress === 70));
    assert.ok(!evs.some((e) => e.type === 'account.sync' && e.accountId === 'whatsapp:s2'));
    assert.ok(evs.some((e) => e.type === 'account.prompt' && e.accountId === 'telegram:p'));
    bus.emit({ type: 'account.sync', accountId: 'whatsapp:s1', progress: 100 });
    bus.emit({ type: 'account.status', account: { id: 'telegram:p', platform: 'telegram', label: 't', status: 'connected', createdAt: 1 } });
    await wait(80);
    const again = await connect();
    await wait(80);
    assert.ok(!eventsOf(again.frames).some((e) => e.type === 'account.sync' || e.type === 'account.prompt'));
  });
});

test('WS: kaldırılan hesabın sonradan gelen durum/QR/ilerleme olayları arayüze gitmez (hayalet hesap yok)', async () => {
  await withServer(async ({ connect }) => {
    const { frames } = await connect();
    const acc = { id: 'x:gone1', platform: 'x' as const, label: 'X', status: 'disconnected' as const, createdAt: 1 };
    bus.emit({ type: 'account.removed', accountId: acc.id });
    bus.emit({ type: 'account.status', account: acc });
    bus.emit({ type: 'account.qr', accountId: acc.id, qrDataUrl: 'data:' });
    bus.emit({ type: 'account.sync', accountId: acc.id, progress: 20 });
    bus.emit({ type: 'log', level: 'info', text: 'işaret' });
    await wait(100);
    const evs = eventsOf(frames) as Array<{ type: string; accountId?: string; account?: { id: string } }>;
    assert.ok(evs.some((e) => e.type === 'log'));
    assert.ok(evs.some((e) => e.type === 'account.removed'), 'account.removed geçer');
    assert.ok(!evs.some((e) => e.type === 'account.status' && e.account?.id === acc.id));
    assert.ok(!evs.some((e) => (e.type === 'account.qr' || e.type === 'account.sync') && e.accountId === acc.id));
  });
});

test('WS: hafif sohbet (mesaj olayı) tam haliyle, chat.upsert olduğu gibi gider', async () => {
  await withServer(async ({ connect }) => {
    const { frames } = await connect();
    const lite = store.getChatLite('whatsapp:g/grp')!;
    const msg = { id: 'whatsapp:g/grp/m1', chatId: 'whatsapp:g/grp', fromMe: false, ts: 3000, text: 'selam' } as unknown as Message;
    bus.emit({ type: 'message.upsert', message: msg, chat: lite, live: true });
    await wait(100);
    const batch = frames.find((f) => (f as { type: string }).type === 'batch') as { chats: Chat[] };
    assert.equal(batch.chats[0].id, 'whatsapp:g/grp');
    assert.deepEqual(batch.chats[0].participants, [{ id: 'u1', name: 'Ali' }]);
  });
});

test('/read: okunmamış yoksa sohbet yeniden yayınlanmaz; watch sohbet başına dakikada en çok bir kez', async () => {
  await withServer(async ({ port, registry, connect }) => {
    store.upsertAccount({ id: 'whatsapp:r', platform: 'whatsapp', label: 'wa', status: 'connected', createdAt: 1 });
    store.upsertChat({ ...chatOf('whatsapp:r/1'), accountId: 'whatsapp:r', platform: 'whatsapp', unread: 2 });
    let watches = 0;
    let marks = 0;
    (registry as unknown as { connectors: Map<string, unknown> }).connectors.set('whatsapp:r', {
      watch: async () => void watches++,
      markRead: async () => void marks++,
    });
    const { frames } = await connect();
    const post = (p: string) =>
      new Promise<number>((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        r.on('error', reject);
        r.end('{}');
      });
    for (let i = 0; i < 5; i++) assert.equal(await post('/api/chats/' + encodeURIComponent('whatsapp:r/1') + '/read'), 200);
    await wait(100);
    assert.equal(watches, 1);
    assert.equal(marks, 1);
    assert.equal(store.getChat('whatsapp:r/1')!.unread, 0);
    const ups = eventsOf(frames).length + frames.flatMap((f) => (f as { chats?: Chat[] }).chats ?? []).length;
    assert.equal(ups, 1, 'yalnız ilk /read sohbeti yayınlar');
  });
});

test('send-file: ham (octet-stream) gövde dosyaya akıtılır, ad/açıklama sorgu dizesinden', async () => {
  await withServer(async ({ port, registry }) => {
    store.upsertAccount({ id: 'telegram:f', platform: 'telegram', label: 'tg', status: 'connected', createdAt: 1 });
    store.upsertChat({ ...chatOf('telegram:f/1'), accountId: 'telegram:f' });
    let got: { size: number; name: string; content: Buffer; caption?: string; voice: boolean } | undefined;
    (registry as unknown as { connectors: Map<string, unknown> }).connectors.set('telegram:f', {
      sendMedia: async (_r: string, f: { path: string; name: string; size: number; voice?: boolean }, caption?: string) => {
        got = { size: f.size, name: f.name, content: fs.readFileSync(f.path), caption, voice: f.voice === true };
        return { ok: true };
      },
    });
    const data = Buffer.from('merhaba dünya dosyası');
    const status = await new Promise<number>((resolve, reject) => {
      const q = new URLSearchParams({ name: 'not.txt', mime: 'text/plain', caption: 'açıklama', voice: '1' });
      const r = http.request(
        { host: '127.0.0.1', port, path: '/api/chats/' + encodeURIComponent('telegram:f/1') + '/send-file?' + q, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/octet-stream' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      r.on('error', reject);
      r.end(data);
    });
    assert.equal(status, 200);
    assert.ok(got);
    assert.equal(got.size, data.length);
    assert.equal(got.name, 'not.txt');
    assert.equal(got.caption, 'açıklama');
    assert.equal(got.voice, true);
    assert.deepEqual(got.content, data);
  });
});
