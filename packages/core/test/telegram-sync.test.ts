import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-tgsync-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { MEDIA_MAX } = await import('../src/media-hosts.js');
const tg = await import('../src/connectors/telegram.js');
const { Api } = await import('teleproto');
const bigInt = (await import('big-integer')).default;

type Priv = {
  ingest(m: unknown, rid: string, name: string, live: boolean, sender?: string, kind?: string): void;
  onDeleted(ev: unknown): void;
  onEdited(ev: unknown): Promise<void>;
  onNew(ev: unknown): Promise<void>;
  poll(): Promise<void>;
  backfill(client: unknown): Promise<void>;
  client: unknown;
  lastDialogScan: number;
  liveAt: Map<string, number>;
};

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `telegram:${n}`, platform: 'telegram' as const, label: 'x', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new tg.TelegramConnector(account, store);
  return { store, account, c, priv: c as unknown as Priv };
}
function chat(store: InstanceType<typeof Store>, accId: string, rid: string, kind: 'direct' | 'group' | 'channel' = 'direct', unread = 0) {
  store.upsertChat({ id: `${accId}/${rid}`, accountId: accId, platform: 'telegram', remoteId: rid, name: `S${rid}`, kind, unread, lastMessageAt: 0, lastPreview: '', tags: [] });
}
const userPeer = (id: number) => new Api.PeerUser({ userId: bigInt(id) });
const msg = (id: number, text: string, extra: Record<string, unknown> = {}) =>
  new Api.Message({ id, peerId: userPeer(42), date: 1_700_000_000 + id, message: text, ...extra } as never);

test('onDeleted: kanal dışı silme süpergruptaki aynı kimliğe takılmaz, birebirdeki mesaj silinir', () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '-100777', 'group');
  chat(store, account.id, '42');
  // süpergrup mesajı ÖNCE yazılır (LIMIT 1 onu bulurdu)
  priv.ingest(new Api.Message({ id: 7, peerId: new Api.PeerChannel({ channelId: bigInt(777) }), date: 1_700_000_000, message: 'grup' } as never), '-100777', 'Grup', false);
  priv.ingest(msg(7, 'birebir'), '42', 'Ayşe', false);
  priv.onDeleted({ deletedIds: [7, 999], originalUpdate: new Api.UpdateDeleteMessages({ messages: [7, 999], pts: 1, ptsCount: 2 }) });
  assert.equal(store.getMessage(`${account.id}/42#7`)?.deleted, true);
  assert.notEqual(store.getMessage(`${account.id}/-100777#7`)?.deleted, true);
});

test('onDeleted: 2000 kimlikli toplu silme hızlı (dizinli arama + tek işlem)', () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '42');
  store.transaction(() => {
    for (let i = 1; i <= 2000; i++) priv.ingest(msg(i, `m${i}`), '42', 'Ayşe', false);
  });
  const ids = Array.from({ length: 2000 }, (_, i) => i + 1).concat(Array.from({ length: 2000 }, (_, i) => 100_000 + i));
  const t0 = performance.now();
  priv.onDeleted({ deletedIds: ids, originalUpdate: new Api.UpdateDeleteMessages({ messages: ids, pts: 1, ptsCount: ids.length }) });
  const ms = performance.now() - t0;
  assert.equal(store.getMessage(`${account.id}/42#1500`)?.deleted, true);
  assert.ok(ms < 5000, `toplu silme ${ms.toFixed(0)} ms`);
});

test('onEdited: açık sohbete message.upsert yayınlanır; birebirde yeni tepki önizlemesi', async () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '42');
  priv.ingest(msg(5, 'selam', { out: true }), '42', 'Ayşe', false);
  const events: Array<{ type: string }> = [];
  const off = bus.on((e) => void events.push(e));
  const reactions = new Api.MessageReactions({ results: [new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '❤️' }), count: 1 })] } as never);
  await priv.onEdited({ message: msg(5, 'selam', { out: true, editDate: 1_700_000_100, editHide: true, reactions }) });
  off();
  const up = events.find((e) => e.type === 'message.upsert') as { message: { reactions?: unknown[] } } | undefined;
  assert.ok(up, 'message.upsert yayınlanmalı');
  assert.equal(up!.message.reactions?.length, 1);
  const c = store.getChat(`${account.id}/42`)!;
  assert.match(c.lastPreview, /❤️ S42 mesajına tepki verdi/);
});

test('onNew: depoda olmayan süpergrup "group" türüyle açılır (eskiden direct)', async () => {
  const { store, account, priv } = setup();
  const ch = new Api.Channel({ id: bigInt(888), title: 'Aile', megagroup: true, broadcast: false, photo: new Api.ChatPhotoEmpty(), date: 1, accessHash: bigInt(1) } as never);
  const m = new Api.Message({ id: 3, peerId: new Api.PeerChannel({ channelId: bigInt(888) }), fromId: userPeer(5), date: 1_700_000_000, message: 'merhaba' } as never);
  Object.defineProperty(m, 'chatId', { value: bigInt(-1000000000888) });
  Object.assign(m, { getChat: async () => ch, getSender: async () => new Api.User({ id: bigInt(5), firstName: 'Veli' } as never) });
  await priv.onNew({ message: m, isPrivate: false });
  const c = store.getChat(`${account.id}/-1000000000888`)!;
  assert.equal(c.kind, 'group');
  assert.equal(c.name, 'Aile');
  assert.equal(tg.tgEntityKind(new Api.Channel({ id: bigInt(1), title: 'K', broadcast: true, photo: new Api.ChatPhotoEmpty(), date: 1 } as never)), 'channel');
  assert.equal(tg.tgEntityKind(new Api.User({ id: bigInt(1) } as never)), 'direct');
});

test('poll: hizmet mesajlı diyalog boşuna çekilmez; tarama sırasında gelen canlı mesajın sayacı ezilmez', async () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '42');
  chat(store, account.id, '43');
  priv.ingest(msg(1, 'eski'), '43', 'B', false);
  let getMessages = 0;
  const service = new Api.MessageService({ id: 9, peerId: userPeer(43), date: 1_700_000_100, action: new Api.MessageActionPinMessage() } as never);
  priv.client = {
    connected: true,
    getDialogs: async () => {
      // anlık görüntü alınırken 42'ye canlı mesaj geliyor (sayaç 1 olur; görüntü onu saymıyor → 0)
      priv.liveAt.set('42', Date.now());
      priv.ingest(msg(50, 'yeni'), '42', 'A', true);
      return [
        { id: bigInt(42), entity: {}, message: msg(50, 'yeni'), unreadCount: 0, isUser: true, dialog: {} },
        { id: bigInt(43), entity: {}, message: service, unreadCount: 0, isUser: true, dialog: {} },
      ];
    },
    getMessages: async () => {
      getMessages++;
      return [];
    },
  };
  priv.lastDialogScan = 0;
  await priv.poll();
  assert.equal(getMessages, 0);
  assert.equal(store.getChat(`${account.id}/42`)!.unread, 1);
});

/** Sahte sohbet geçmişi: getMessages minId/offsetId/limit'e uyar (en yeni önce) */
function history(ids: number[], rid: number) {
  const calls: Array<Record<string, number>> = [];
  const get = async (_e: unknown, p: { minId?: number; offsetId?: number; limit?: number }) => {
    calls.push(p as Record<string, number>);
    const out = ids
      .filter((i) => i > (p.minId ?? 0) && (!p.offsetId || i < p.offsetId))
      .sort((a, b) => b - a)
      .slice(0, p.limit ?? 100)
      .map((i) => new Api.Message({ id: i, peerId: userPeer(rid), date: 1_700_000_000 + Math.floor(i / 5), message: `m${i}` } as never));
    return out;
  };
  return { get, calls };
}

test('backfill: kapalıyken biriken 250 mesajın tamamı (sayfa sayfa) alınır; arşivdeki sohbet arka planda doldurulur; sıra eskiden yeniye', async () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '42');
  chat(store, account.id, '44');
  priv.ingest(new Api.Message({ id: 10, peerId: userPeer(42), date: 1_700_000_002, message: 'önceki' } as never), '42', 'A', false);
  priv.ingest(new Api.Message({ id: 1000, peerId: userPeer(44), date: 1_700_000_000, message: 'ar' } as never), '44', 'C', false);
  const h42 = history(Array.from({ length: 260 }, (_, i) => i + 1), 42);
  const h44 = history(Array.from({ length: 40 }, (_, i) => 1000 + i), 44);
  const e42 = { id: 42 };
  const e44 = { id: 44 };
  const last42 = new Api.Message({ id: 260, peerId: userPeer(42), date: 1_700_000_052, message: 'm260' } as never);
  const last44 = new Api.Message({ id: 1039, peerId: userPeer(44), date: 1_700_000_207, message: 'm1039' } as never);
  const client = {
    connected: true,
    getDialogs: async (p: { archived?: boolean }) =>
      p.archived
        ? [{ id: bigInt(44), entity: e44, message: last44, unreadCount: 39, isUser: true, archived: true, folderId: 1, dialog: {} }]
        : [{ id: bigInt(42), entity: e42, message: last42, unreadCount: 250, isUser: true, dialog: {} }],
    getMessages: (e: unknown, p: never) => (e === e44 ? h44.get(e, p) : h42.get(e, p)),
  };
  priv.client = client;
  await priv.backfill(client);
  const cid = `${account.id}/42`;
  for (const id of [11, 100, 150, 259, 260]) assert.ok(store.hasMessage(`${cid}#${id}`), `42#${id} eksik`);
  assert.ok(h42.calls.every((c) => c.minId === 10), 'boşluk depodaki son kimlikten sonra istenmeli');
  assert.equal(store.getChat(cid)!.unread, 250);
  // aynı saniyedeki (date = id/5) mesajlar eskiden yeniye: listede artan kimlik sırası
  const listed = store.listMessages(cid, 300).map((m) => Number(m.remoteId));
  assert.deepEqual(listed, [...listed].sort((a, b) => a - b));
  // arşivdeki sohbet: arka plan kuyruğu
  for (let i = 0; i < 40 && !store.hasMessage(`${account.id}/44#1001`); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(store.hasMessage(`${account.id}/44#1001`));
  assert.ok(store.hasMessage(`${account.id}/44#1038`));
});

test('historyOffset: aynı saniyedeki en küçük kimlikten geriye; kimlik yoksa o saniyeyi kapsayan offsetDate', () => {
  const before = 1_700_000_005_000;
  assert.deepEqual(tg.historyOffset([{ remoteId: '30', ts: before - 1000 }, { remoteId: '32', ts: before }, { remoteId: '31', ts: before }], before), { offsetId: 31 });
  assert.deepEqual(tg.historyOffset([], before), { offsetDate: 1_700_000_006 });
  assert.deepEqual(tg.historyOffset([{ remoteId: 'local-1', ts: before }], before), { offsetDate: 1_700_000_006 });
});

test('fetchMedia: sınırı aşan belge indirilmeden reddedilir; eşzamanlı istekler tek indirme paylaşır', async () => {
  const { priv, c } = setup();
  let downloads = 0;
  const big = new Api.Message({
    id: 1,
    peerId: userPeer(42),
    date: 1,
    message: '',
    media: new Api.MessageMediaDocument({ document: new Api.Document({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 1, mimeType: 'video/mp4', size: bigInt(MEDIA_MAX + 1), dcId: 1, attributes: [] } as never) } as never),
  } as never);
  const small = new Api.Message({ id: 2, peerId: userPeer(42), date: 1, message: '', media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) } as never) } as never);
  priv.client = {
    getInputEntity: async () => ({}),
    getMessages: async (_e: unknown, p: { ids: number[] }) => [p.ids[0] === 1 ? big : small],
    downloadMedia: async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, 30));
      return Buffer.from('jpeg');
    },
  };
  await assert.rejects(c.fetchMedia('tg:42/1'), /413/);
  assert.equal(downloads, 0);
  const [a, b] = await Promise.all([c.fetchMedia('tg:42/2'), c.fetchMedia('tg:42/2')]);
  assert.equal(downloads, 1);
  assert.equal(a?.body.toString(), 'jpeg');
  assert.equal(b?.type, 'image/jpeg');
  // önbellekten (indirme yok)
  assert.equal((await c.fetchMedia('tg:42/2'))?.body.toString(), 'jpeg');
  assert.equal(downloads, 1);
});

test('backfill: son öğesi hizmet mesajı olan süpergrupta kapalıyken gelen mesajlar da doldurulur', async () => {
  const { store, account, priv } = setup();
  chat(store, account.id, '-100555', 'group');
  const peer = new Api.PeerChannel({ channelId: bigInt(555) });
  priv.ingest(new Api.Message({ id: 10, peerId: peer, date: 1_700_000_000, message: 'önceki' } as never), '-100555', 'G', false);
  const e = { id: 555 };
  const svc = new Api.MessageService({ id: 14, peerId: peer, date: 1_700_000_100, action: new Api.MessageActionPinMessage() } as never);
  const calls: Array<{ minId?: number }> = [];
  const client = {
    connected: true,
    getDialogs: async (p: { archived?: boolean }) => (p.archived ? [] : [{ id: bigInt(-100555), entity: e, message: svc, unreadCount: 3, isGroup: true, isChannel: true, dialog: {} }]),
    getMessages: async (_e: unknown, p: { minId?: number }) => {
      calls.push(p);
      if (!p.minId) return [];
      return [13, 12, 11].map((id) => new Api.Message({ id, peerId: peer, date: 1_700_000_000 + id, message: `m${id}` } as never));
    },
  };
  priv.client = client;
  await priv.backfill(client);
  assert.ok(calls.some((c) => c.minId === 10), 'hizmet mesajlı süpergrupta boşluk istenmeli');
  for (const id of [11, 12, 13]) assert.ok(store.hasMessage(`${account.id}/-100555#${id}`));
});
