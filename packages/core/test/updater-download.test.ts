import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-upd-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_APP_VERSION = '0.1.20';
const real = { platform: process.platform, arch: process.arch, execPath: process.execPath, fetch: globalThis.fetch };
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
Object.defineProperty(process, 'execPath', { value: '/Applications/Mivelo.app/Contents/Resources/core/bin/node', configurable: true });
after(() => {
  Object.defineProperty(process, 'platform', { value: real.platform });
  Object.defineProperty(process, 'arch', { value: real.arch });
  Object.defineProperty(process, 'execPath', { value: real.execPath });
  globalThis.fetch = real.fetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { downloadUpdate, updateStatus } = await import('../src/updater.js');
const body = Buffer.alloc(300_000, 7);
function serve(sha: string, version = '0.1.22') {
  globalThis.fetch = (async (u: string) => {
    if (String(u).endsWith('latest.json')) return new Response(JSON.stringify({ version, files: { 'Mivelo-mac-arm64.dmg': { size: body.length, sha256: sha } } }));
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

test('indirir, sha256 doğrular, hazır olur', async () => {
  serve(createHash('sha256').update(body).digest('hex'));
  assert.equal(updateStatus().supported, true);
  await downloadUpdate();
  await until(() => updateStatus().state !== 'downloading');
  const s = updateStatus();
  assert.equal(s.state, 'ready', s.error);
  assert.equal(s.version, '0.1.22');
  assert.equal(fs.statSync(path.join(tmp, 'update', 'Mivelo-mac-arm64.dmg')).size, body.length);
});

test('sha256 tutmazsa hata, dosya kurulmaya hazır sayılmaz', async () => {
  serve('0'.repeat(64), '0.1.23');
  await downloadUpdate();
  await until(() => updateStatus().state !== 'downloading');
  assert.equal(updateStatus().state, 'error');
  assert.match(updateStatus().error ?? '', /sha256/);
});

test('kurulu sürümden yeni değilse indirmez', async () => {
  serve('x', '0.1.20');
  await downloadUpdate();
  await until(() => updateStatus().state !== 'downloading');
  assert.match(updateStatus().error ?? '', /en yeni/);
});
