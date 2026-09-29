import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-gap-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BrowserConnector } = await import('../src/connectors/browser/bridge.js');
type Strategy = ConstructorParameters<typeof BrowserConnector>[2];

/** 1 eski (depoda) + 60 yeni mesaj; yoklama yalnız en yeni 15'i alır → aradaki 45 boşluk */
const all = [{ id: 'old', text: 'eski', ts: 1000, fromMe: false, senderId: 'u', senderName: 'U' }].concat(
  Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, text: `yeni ${i}`, ts: 2000 + i * 10, fromMe: false, senderId: 'u', senderName: 'U' })),
);
const newest = all.at(-1)!.ts;

function make(name: string, withBefore: boolean) {
  const store = new Store(path.join(tmp, `${name}.db`));
  const account = { id: `instagram:${name}`, platform: 'instagram' as const, label: 't', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const calls: (number | undefined)[] = [];
  const pick = (limit: number, before?: number) => all.filter((m) => before === undefined || m.ts < before).slice(-limit);
  const strategy = {
    home: 'https://example.com/',
    loginHint: '',
    pageless: true,
    parallel: true,
    async loggedIn() {
      return true;
    },
    async threads() {
      return [{ id: 'c', name: 'C', kind: 'group' as const, unread: 1, lastTs: newest, preview: 'x' }];
    },
    messages: withBefore
      ? async (_p: unknown, _c: unknown, _id: string, limit: number, before?: number) => (calls.push(before), pick(limit, before))
      : async (_p: unknown, _c: unknown, _id: string, limit: number) => (calls.push(undefined), pick(limit)),
    async send() {
      return 'x';
    },
  } as unknown as Strategy;
  const conn = new BrowserConnector(account, store, strategy, 60_000);
  const c = conn as unknown as Record<string, unknown>;
  c.pageless = true;
  c.state = { cookies: [], origins: [] };
  c.api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => undefined };
  // depoda boşluğun öncesindeki eski mesaj var
  (c.upsertChat as (x: unknown) => void).call(conn, { remoteId: 'c', name: 'C', kind: 'group', unread: 0, lastMessageAt: 1000 });
  (c.ingest as (t: string, m: unknown, live: boolean) => void).call(conn, 'c', all[0], false);
  return { store, conn, c, calls, chat: `${account.id}/c` };
}

test('köprü: yoklamada kalan boşluk before ile geriye sayfalanarak kapanır', async () => {
  const { store, c, conn, calls, chat } = make('a', true);
  await (c.pollInner as (f: boolean) => Promise<void>).call(conn, false);
  assert.equal(store.listMessages(chat, 500).length, 61, 'aradaki 45 mesaj da alındı');
  assert.equal(calls[0], undefined);
  assert.ok(calls.length >= 2 && calls.length <= 6, `sayfa sayısı sınırlı (${calls.length})`);
  assert.equal((c.gapFill as Map<string, unknown>).size, 0, 'boşluk kapandı');
});

test('köprü: before desteklemeyen stratejide boşluk doldurma atlanır', async () => {
  const { store, c, conn, calls, chat } = make('b', false);
  await (c.pollInner as (f: boolean) => Promise<void>).call(conn, false);
  assert.equal(calls.length, 1);
  assert.equal(store.listMessages(chat, 500).length, 16);
});
