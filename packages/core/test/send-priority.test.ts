import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-prio-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BrowserConnector } = await import('../src/connectors/browser/bridge.js');
type Strategy = ConstructorParameters<typeof BrowserConnector>[2];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('köprü: gönderim yoklama turunun bitmesini beklemez, tur içindeki ilk güvenli noktada araya girer', async () => {
  const store = new Store(path.join(tmp, 'p.db'));
  const account = { id: 'linkedin:t', platform: 'linkedin' as const, label: 't', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const log: string[] = [];
  const threads = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: 'direct' as const, unread: 0, lastTs: 1000 + i, preview: 'x' }));
  const strategy = {
    home: 'https://example.com/',
    loginHint: '',
    pageless: true,
    async loggedIn() {
      return true;
    },
    async threads() {
      log.push('threads');
      await sleep(80);
      return threads;
    },
    async messages(_p: unknown, _c: unknown, id: string) {
      log.push('messages ' + id);
      await sleep(80);
      return [];
    },
    async send(_p: unknown, _c: unknown, id: string, text: string) {
      log.push(`send ${id} ${text}`);
      return 'm1';
    },
  } as unknown as Strategy;
  const conn = new BrowserConnector(account, store, strategy, 60_000);
  const c = conn as unknown as Record<string, unknown>;
  c.pageless = true;
  c.state = { cookies: [], origins: [] };
  c.api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => undefined };

  const poll = (c.pollInner as (first: boolean) => Promise<void>).bind(conn);
  const serial = (c.serial as (fn: () => Promise<void>) => Promise<void>).bind(conn);
  const turn = serial(async () => {
    c.inPoll = true;
    try {
      await poll(false);
    } finally {
      await (c.runUrgent as () => Promise<void>).call(conn);
      c.inPoll = false;
    }
  });
  await sleep(20); // tur sohbet listesini alırken kullanıcı gönderir
  const t0 = Date.now();
  await conn.sendText('c3', 'merhaba');
  const waited = Date.now() - t0;
  await turn;
  assert.ok(waited < 250, `gönderim tüm turu beklememeli (${waited} ms)`);
  assert.equal(log[0], 'threads');
  assert.equal(log[1], 'send c3 merhaba', 'liste bitince, mesaj istekleri başlamadan araya girer');
  assert.equal(log.filter((l) => l.startsWith('messages')).length, 6, 'tur yine tamamlanır');

  // tur yokken normal sıra
  await conn.sendText('c1', 'ikinci');
  assert.equal(log.at(-1), 'send c1 ikinci');
  assert.equal(store.listMessages('linkedin:t/c3', 10).filter((m) => m.fromMe).length, 1);
});
