import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-heal-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { bus } = await import('../src/bus.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('geçici kopma: uyarısız arka planda yeniden denenir; kalıcı hata (şifre/eksik bilgi) denenmez ve uyarı görünür', async () => {
  const store = new Store(path.join(tmp, 'h.db'));
  const reg = new Registry(store);
  (Registry as unknown as { HEAL_DELAYS: number[] }).HEAL_DELAYS = [30, 30, 30];
  const acc = { id: 'shopier:h', platform: 'shopier' as const, label: 'shopier', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  let stops = 0;
  const fake = { account: acc, start: async () => undefined, stop: async () => void stops++, sendText: async () => undefined };
  (reg as unknown as { connectors: Map<string, unknown> }).connectors.set(acc.id, fake);
  const seen: Array<{ status: string; autoRetry?: boolean }> = [];
  const off = bus.on((ev) => ev.type === 'account.status' && seen.push({ status: ev.account.status, autoRetry: ev.account.autoRetry }));

  // ağ hatası → autoRetry, list() de gösterir
  const ev = { ...acc, status: 'error' as const, detail: 'getaddrinfo ENOTFOUND api.shopier.com' };
  store.upsertAccount(ev);
  bus.emit({ type: 'account.status', account: ev });
  assert.equal(seen.at(-1)?.autoRetry, true);
  assert.equal(reg.list()[0].autoRetry, true);
  // deneme: eski connector durdurulur, gerçek connector (PAT yok → kalıcı hata) başlar → yeniden deneme biter, uyarı görünür
  for (let i = 0; i < 100 && !seen.some((s) => s.status === 'error' && !s.autoRetry); i++) await sleep(10);
  assert.equal(stops, 1);
  const last = seen.at(-1)!;
  assert.equal(last.status, 'error');
  assert.equal(last.autoRetry, undefined, 'kalıcı hata: uyarı görünür');
  assert.equal(reg.list()[0].autoRetry, undefined);

  // şifre reddi hiç denenmez
  const bad = { ...acc, status: 'error' as const, detail: 'Giriş reddedildi: uygulama şifresini kontrol et' };
  bus.emit({ type: 'account.status', account: bad });
  assert.equal(seen.at(-1)?.autoRetry, undefined);
  off();
  await reg.stopAll();
  store.close();
});
