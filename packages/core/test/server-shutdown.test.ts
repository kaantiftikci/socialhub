import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-srvshut-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
process.env.MIVELO_APP_VERSION = '0.1.99';
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { createServer } = await import('../src/server.js');

const store = new Store(path.join(tmp, 'test.db'));
const port = 41000 + Math.floor(Math.random() * 2000);
const server = createServer(store, new Registry(store), port);
await new Promise<void>((r) => server.once('listening', () => r()));
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();

function req(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('/api/health appVersion ve execPath döndürür', async () => {
  const r = await req('GET', '/api/health');
  const j = JSON.parse(r.body);
  assert.equal(j.appVersion, '0.1.99');
  assert.equal(j.execPath, process.execPath);
  assert.equal(j.pid, process.pid);
});

test('/api/shutdown: belirteçsiz, yanlış belirteçli ve Origin başlıklı istek reddedilir', async () => {
  let sig = 0;
  const onSig = () => sig++;
  process.on('SIGTERM', onSig);
  try {
    assert.equal((await req('POST', '/api/shutdown')).status, 403);
    assert.equal((await req('POST', '/api/shutdown', { 'x-kavsak-token': 'yanlis' })).status, 403);
    assert.equal((await req('POST', '/api/shutdown', { 'x-kavsak-token': token, origin: `http://localhost:${port}` })).status, 403);
    assert.equal((await req('POST', '/api/shutdown', { 'x-kavsak-token': token, 'x-forwarded-for': '1.2.3.4' })).status, 403);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sig, 0);
    // doğru belirteç: {ok:true} önce yazılır, sonra SIGTERM yayılır
    const ok = await req('POST', '/api/shutdown', { 'x-kavsak-token': token });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sig, 1);
  } finally {
    process.off('SIGTERM', onSig);
  }
});
