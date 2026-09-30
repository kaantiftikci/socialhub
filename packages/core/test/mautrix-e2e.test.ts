import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Gerçek köprü süreci (apps/bridge, Go) + sahte ağ ("fake", MIVELO_FAKE_NET=1) ile uçtan uca: giriş → canlı mesaj →
 * gönderim/yanıt → tepki → eski mesajlar → yeniden başlatma → çıkış. Go yoksa ve MIVELO_TEST_BRIDGE_BIN verilmemişse atlanır.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mxe2e-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_FAKE_NET = '1';
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', '..', 'apps', 'bridge');
let bin = process.env.MIVELO_TEST_BRIDGE_BIN;
let skip: string | false = false;
if (!bin) {
  const hasGo = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['go']).status === 0;
  if (!hasGo) skip = 'Go yok (MIVELO_TEST_BRIDGE_BIN ile hazır ikili verilebilir)';
  else {
    bin = path.join(tmp, process.platform === 'win32' ? 'mivelo-bridge.exe' : 'mivelo-bridge');
    const r = spawnSync('go', ['build', '-o', bin, '.'], { cwd: src, env: { ...process.env, CGO_ENABLED: '1', GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'auto' }, encoding: 'utf8', timeout: 8 * 60_000 });
    if (r.status !== 0) skip = `köprü derlenemedi: ${(r.stderr || '').slice(-300)}`;
  }
}
if (bin) process.env.MIVELO_BRIDGE_BIN = bin;

const { Store } = await import('../src/store.js');
const { sidecar } = await import('../src/connectors/mautrix/sidecar.js');
const { MautrixConnector, MAUTRIX_NET } = await import('../src/connectors/mautrix/connector.js');

const store = new Store(path.join(tmp, 't.db'));
(MAUTRIX_NET as Record<string, string>).demo = 'fake';
const account = { id: 'demo:mx', platform: 'demo' as const, label: 'demo', status: 'disconnected' as const, createdAt: 1 };

before(() => store.upsertAccount(account));
after(async () => {
  await sidecar.stop().catch(() => undefined);
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until<T>(what: string, fn: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} gelmedi`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const cid = 'demo:mx/dm-ayse';

test('gerçek köprü süreciyle uçtan uca', { skip }, async () => {
  const c = new MautrixConnector({ ...account }, store);
  await c.start({ interactive: true });
  await until('bağlantı', () => store.getAccount(account.id)?.status === 'connected');
  const m1 = await until('canlı mesaj', () => store.getMessage(`${cid}#m1`));
  assert.equal(m1.text, 'merhaba');
  const chat = await until('sohbet adı', () => {
    const ch = store.getChat(cid);
    return ch?.name === 'Ayşe Yılmaz' ? ch : undefined;
  });
  assert.equal(chat.kind, 'direct');
  assert.ok(chat.unread >= 1);

  const sent = await c.sendText('dm-ayse', 'selam', { replyTo: 'm1' });
  assert.equal(sent.remoteId, 'sent1');
  assert.equal(store.getMessage(`${cid}#sent1`)?.replyTo?.remoteId, 'm1');

  await c.react('dm-ayse', 'm1', '👍', false);
  await c.react('dm-ayse', 'm1', '👍', true);
  await c.editMessage('dm-ayse', 'sent1', 'selamlar');
  await c.deleteMessage('dm-ayse', 'sent1');
  await c.markRead('dm-ayse');

  const r = await c.loadHistory('dm-ayse');
  assert.ok(!r || !('timedOut' in r && r.timedOut), 'geçmiş zaman aşımına uğramamalı');
  const old = await until('eski mesaj', () => store.getMessage(`${cid}#old2`));
  assert.equal(old.fromMe, true);
  assert.equal(old.text, 'eski yanıt');

  // bağlayıcı yeniden başlatılınca aynı köprü oturumuyla bağlanır (yeniden giriş yok)
  await c.stop();
  const c2 = new MautrixConnector({ ...account }, store);
  await c2.start({ interactive: false });
  await until('yeniden bağlantı', () => store.getAccount(account.id)?.status === 'connected');
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'demo_mx', 'mautrix.json').replace('demo_mx', process.platform === 'win32' ? 'demo_mx' : 'demo:mx'), 'utf8'));
  assert.equal(state.login, 'L1');

  await c2.logout();
  await c2.stop();
});
