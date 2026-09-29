import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-purge-meta-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');

const KEYS = (id: string) => [`slack_last:${id}`, `boot_ms:${id}`, `wa_twins_v1:${id}`, `wa_viewonce_v1:${id}`];

test('purgeAccount hesabın meta anahtarlarını siler; başka hesabınkiler ve genel bayraklar kalır', async () => {
  const store = new Store(path.join(tmp, 'p.db'));
  const id = 'slack:ab12cd34';
  const other = 'slack:ab12cd345'; // öneki aynı, farklı hesap
  for (const a of [id, other]) store.upsertAccount({ id: a, platform: 'slack', label: 'Slack', status: 'disconnected', createdAt: 1 });
  for (const k of [...KEYS(id), ...KEYS(other)]) store.setFlag(k, '42');
  store.setFlag('fts_au_when_v1');
  store.setFlag(`x${id}`); // ':'+id ile bitmiyor → kalmalı

  await store.purgeAccount(id);

  for (const k of KEYS(id)) assert.equal(store.meta(k), undefined, k);
  for (const k of KEYS(other)) assert.equal(store.meta(k), '42', k);
  assert.equal(store.meta('fts_au_when_v1'), '1');
  assert.equal(store.meta(`x${id}`), '1');
  assert.equal(store.meta(`removing:${id}`), undefined);
  assert.deepEqual(store.pendingPurges(), []);
});

test('deleteAccount meta anahtarlarını siler ama removing: bayrağına dokunmaz; joker karakterli kimlik taşmaz', () => {
  const store = new Store(path.join(tmp, 'd.db'));
  const id = 'x:a_%';
  store.upsertAccount({ id, platform: 'x', label: 'X', status: 'disconnected', createdAt: 1 });
  store.setFlag(`boot_ms:${id}`, '900');
  store.setFlag(`removing:${id}`);
  store.setFlag('boot_ms:x:abc%'); // LIKE olsaydı '_' eşleşirdi
  store.deleteAccount(id);
  assert.equal(store.meta(`boot_ms:${id}`), undefined);
  assert.equal(store.meta(`removing:${id}`), '1');
  assert.equal(store.meta('boot_ms:x:abc%'), '1');
});

test('kaldırma sürerken/sonra durdurulan connector hesabın meta anahtarını geri yazamaz', async () => {
  const store = new Store(path.join(tmp, 'r.db'));
  const id = 'slack:ee11ff22';
  store.upsertAccount({ id, platform: 'slack', label: 'Slack', status: 'disconnected', createdAt: 1 });
  store.setFlag(`slack_last:${id}`, '{}');
  const p = store.purgeAccount(id);
  store.setFlag(`boot_ms:${id}`, '900'); // purge sürerken
  await p;
  store.setFlag(`slack_last:${id}`, '{"C1":"1.2"}'); // stop() sonrası imleç yazımı
  assert.equal(store.meta(`slack_last:${id}`), undefined);
  assert.equal(store.meta(`boot_ms:${id}`), undefined);
  store.setFlag(`boot_ms:slack:other`, '5'); // başka hesap etkilenmez
  assert.equal(store.meta('boot_ms:slack:other'), '5');
});
