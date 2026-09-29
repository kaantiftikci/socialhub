import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-heal-stable-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type R = { HEAL_DELAYS: number[]; HEAL_STABLE_MS: number };

function setup(name: string) {
  const store = new Store(path.join(tmp, `${name}.db`));
  const reg = new Registry(store);
  const acc = { id: `shopier:${name}`, platform: 'shopier' as const, label: 'shopier', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const fake = { account: acc, start: async () => undefined, stop: async () => undefined, sendText: async () => undefined };
  (reg as unknown as { connectors: Map<string, unknown> }).connectors.set(acc.id, fake);
  // connector gibi: önce depoya yaz, sonra yayınla
  const emit = (status: 'connected' | 'error' | 'disconnected' | 'connecting', detail?: string) => {
    const a = { ...acc, status, detail };
    store.upsertAccount(a);
    bus.emit({ type: 'account.status', account: a });
  };
  return { store, reg, acc, emit };
}

test("kısa süreli 'connected' sayacı sıfırlamaz: doğrulamadan bağlanıp hemen düşen deneme üçte durur, uyarı görünür", async () => {
  (Registry as unknown as R).HEAL_DELAYS = [20, 20, 20];
  (Registry as unknown as R).HEAL_STABLE_MS = 500;
  const { store, reg, emit } = setup('flap');
  const fail = 'getaddrinfo ENOTFOUND api.shopier.com';
  let heals = 0;
  // sayfasız açılış gibi: eski connector durur, yeni 'connected' der, ilk yoklama yine geçici hatayla düşer
  (reg as unknown as { healNow: (id: string, st: { timer?: NodeJS.Timeout }) => Promise<void> }).healNow = async (_id, st) => {
    st.timer = undefined;
    heals++;
    emit('disconnected');
    emit('connecting');
    emit('connected');
    await sleep(5);
    emit('error', fail);
  };
  let lastRetry: boolean | undefined = true;
  const off = bus.on((ev) => ev.type === 'account.status' && ev.account.status === 'error' && (lastRetry = ev.account.autoRetry));
  emit('error', fail);
  await sleep(400);
  assert.equal(heals, 3, 'tam üç deneme (sonsuz döngü yok)');
  assert.equal(lastRetry, undefined, 'denemeler bitince uyarı görünür');
  off();
  await reg.stopAll();
  store.close();
});

test("kesintisiz bağlı kalınca sayaç sıfırlanır: sonraki kopma yeniden denenir", async () => {
  (Registry as unknown as R).HEAL_DELAYS = [20, 20, 20];
  (Registry as unknown as R).HEAL_STABLE_MS = 80;
  const { store, reg, emit } = setup('stable');
  const fail = 'getaddrinfo ENOTFOUND api.shopier.com';
  let heals = 0;
  (reg as unknown as { healNow: (id: string, st: { timer?: NodeJS.Timeout }) => Promise<void> }).healNow = async (_id, st) => {
    st.timer = undefined;
    heals++;
    emit('error', fail);
  };
  emit('error', fail);
  await sleep(200);
  assert.equal(heals, 3);
  const heal = (reg as unknown as { heal: Map<string, unknown> }).heal;
  // bağlandı ama süre dolmadan düştü → sayaç korunur, deneme yok
  emit('connected');
  await sleep(20);
  assert.ok(heal.has(`shopier:stable`), 'süre dolmadan sayaç silinmez');
  emit('error', fail);
  await sleep(100);
  assert.equal(heals, 3, 'denemeler bitmişti: yeni deneme yok');
  // kesintisiz bağlı → sıfırlanır → sonraki kopma yeniden denenir
  emit('connected');
  await sleep(150);
  assert.ok(!heal.has(`shopier:stable`), 'kararlı bağlantıda sayaç sıfırlanır');
  let retry: boolean | undefined;
  const off = bus.on((ev) => ev.type === 'account.status' && ev.account.status === 'error' && (retry = ev.account.autoRetry));
  emit('error', fail);
  assert.equal(retry, true, 'yeni kopma yine uyarısız denenir');
  off();
  await reg.stopAll();
  store.close();
});
