import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-rxp-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BrowserConnector, REACTION_PREVIEW_RE } = await import('../src/connectors/browser/bridge.js');
const { tapbackOf } = await import('../src/connectors/imessage.js');
const { igReactionPreview } = await import('../src/connectors/browser/instagram.js');
type Strategy = ConstructorParameters<typeof BrowserConnector>[2];

test('iMessage tapback → hedef mesaja tepki (ekleme/geri alma, özel emoji, hedef öneki)', () => {
  assert.deepEqual(tapbackOf({ associated_message_type: 2000, associated_message_guid: 'p:0/ABC-1', associated_message_emoji: null }), { target: 'ABC-1', emoji: '❤️', remove: false });
  assert.deepEqual(tapbackOf({ associated_message_type: 2003, associated_message_guid: 'bp:XYZ', associated_message_emoji: null }), { target: 'XYZ', emoji: '😂', remove: false });
  assert.deepEqual(tapbackOf({ associated_message_type: 3001, associated_message_guid: 'p:1/ABC-2', associated_message_emoji: null }), { target: 'ABC-2', emoji: '👍', remove: true });
  assert.deepEqual(tapbackOf({ associated_message_type: 2006, associated_message_guid: 'p:0/E', associated_message_emoji: '🔥' }), { target: 'E', emoji: '🔥', remove: false });
  assert.equal(tapbackOf({ associated_message_type: 0, associated_message_guid: 'p:0/A', associated_message_emoji: null }), undefined, 'normal mesaj');
  assert.equal(tapbackOf({ associated_message_type: 2001, associated_message_guid: null, associated_message_emoji: null }), undefined, 'hedefsiz');
});

test('Instagram: eski bir mesaja gelen beğeni de "tepki verdi" önizlemesi olur (yalnız son mesaj değil)', () => {
  const us = (ms: number) => ms * 1000; // IG öğe zamanı µs
  const items = [
    { item_id: '3', user_id: 'me', timestamp: us(3000), item_type: 'text', text: 'son mesajım' },
    { item_id: '2', user_id: 'u1', timestamp: us(2000), item_type: 'text', text: 'onun mesajı' },
    // eski mesajım (1) 5000'de beğenildi
    { item_id: '1', user_id: 'me', timestamp: us(1000), item_type: 'text', text: 'eski mesajım', reactions: { likes: [{ sender_id: 'u1', timestamp: us(5000) }] } },
  ];
  assert.match(igReactionPreview(items, 5000) ?? '', /tepki verdi$/);
  // tepki son mesajdan eskiyse etkinlik mesajdır
  const older = [{ ...items[0], timestamp: us(6000) }, items[1], items[2]];
  assert.equal(igReactionPreview(older, 6000), undefined);
  // tepki kaydı satırı (action_log) en yeni öğe
  const logged = [{ item_id: 'L', user_id: 'u1', timestamp: us(7000), item_type: 'action_log', action_log: { description: 'Ayşe mesajınızı beğendi' } }, ...older];
  assert.equal(igReactionPreview(logged, 7000), 'Ayşe mesajınızı beğendi');
  assert.ok(REACTION_PREVIEW_RE.test('Ayşe mesajına ❤ ile tepki verdi'));
  assert.ok(REACTION_PREVIEW_RE.test('John reacted 👍 to your message'));
  assert.ok(!REACTION_PREVIEW_RE.test('Yarın görüşürüz'));
});

test('köprü: turda yeni mesaj gelmeden yalnız tepki değiştiyse okunmamış artmaz, önizleme tepkiyi anlatır, tik yok', async () => {
  const store = new Store(path.join(tmp, 'b.db'));
  const account = { id: 'linkedin:r', platform: 'linkedin' as const, label: 'r', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  let thread = { id: 'c1', name: 'Ayşe Yılmaz', kind: 'direct' as const, unread: 0, lastTs: 1000, preview: 'merhaba' };
  let msgs: Array<Record<string, unknown>> = [{ id: 'm1', text: 'merhaba', ts: 1000, fromMe: true, senderId: 'me', senderName: 'Ben' }];
  const strategy = {
    home: 'https://example.com/',
    loginHint: '',
    pageless: true,
    async loggedIn() {
      return true;
    },
    async threads() {
      return [thread];
    },
    async messages() {
      return msgs;
    },
  } as unknown as Strategy;
  const conn = new BrowserConnector(account, store, strategy, 60_000);
  const c = conn as unknown as Record<string, unknown>;
  c.pageless = true;
  c.state = { cookies: [], origins: [] };
  c.api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => undefined };
  const poll = (first: boolean) => (c.pollInner as (f: boolean) => Promise<void>).call(conn, first);
  await poll(true);
  let chat = store.getChat('linkedin:r/c1')!;
  assert.equal(chat.lastFromMe, true);
  assert.equal(chat.unread, 0);
  // karşı taraf mesajımı beğendi: platform sohbeti "okunmamış" ve yeni etkinlikli gösteriyor, önizleme değişmedi
  thread = { ...thread, unread: 1, lastTs: 2000 };
  msgs = [{ ...msgs[0], reactions: [{ emoji: '👍', senderId: 'u1', senderName: 'Ayşe Yılmaz', fromMe: false }] }];
  await poll(false);
  chat = store.getChat('linkedin:r/c1')!;
  assert.equal(chat.unread, 0, 'tepki okunmamış sayılmaz');
  assert.equal(chat.lastPreview, '👍 Ayşe mesajına tepki verdi');
  assert.equal(chat.lastReaction, true, 'listede tik gösterilmez');
  assert.equal(chat.lastFromMe, true, '"Bekleyen"e düşmez');
  // sonraki turda platform hâlâ okunmamış diyor ama yeni etkinlik yok → yine 0
  await poll(false);
  assert.equal(store.getChat('linkedin:r/c1')!.unread, 0);
  // gerçek mesaj gelince olağan davranış
  thread = { ...thread, unread: 1, lastTs: 3000, preview: 'nasılsın' };
  msgs = [...msgs, { id: 'm2', text: 'nasılsın', ts: 3000, fromMe: false, senderId: 'u1', senderName: 'Ayşe Yılmaz' }];
  await poll(false);
  chat = store.getChat('linkedin:r/c1')!;
  assert.equal(chat.unread, 1);
  assert.equal(chat.lastPreview, 'nasılsın');
  assert.equal(chat.lastReaction, undefined);
  store.close();
});
