import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-cancel-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('bağlanma iptali: hiç bağlanmamış yeni hesap kaldırılır, var olan hesap durdurulur, giriş penceresi kapanınca kendiliğinden', async () => {
  const store = new Store(path.join(tmp, 'c.db'));
  const reg = new Registry(store);
  const events: string[] = [];
  const off = bus.on((ev) => events.push(ev.type));
  // iMessage Linux'ta hata durumunda kalır (bağlanmaz): "hiç bağlanmamış yeni hesap" için yeterli
  const a = await reg.add('imessage');
  await sleep(30);
  assert.equal(await reg.cancelLogin(a.id), 'removed');
  assert.equal(store.getAccount(a.id), undefined);
  assert.ok(events.includes('account.removed'));

  // bu oturumda eklenmemiş (var olan) hesap: kaldırılmaz, "Bağlı değil"
  const b = await reg.add('imessage');
  await sleep(30);
  const reg2 = new Registry(store);
  assert.equal(await reg2.cancelLogin(b.id), 'stopped');
  assert.equal(store.getAccount(b.id)?.status, 'disconnected');

  // giriş penceresi girişsiz kapatıldı olayı → yeni hesap kendiliğinden kaldırılır
  const c = await reg.add('telegram');
  await sleep(30);
  bus.emit({ type: 'account.login-cancelled', accountId: c.id });
  for (let i = 0; i < 50 && store.getAccount(c.id); i++) await sleep(20);
  assert.equal(store.getAccount(c.id), undefined);
  off();
  await reg.stopAll();
  await reg2.stopAll();
  store.close();
});
