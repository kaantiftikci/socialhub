import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Sunucu modu (MIVELO_SERVER=1): modüller ortamı yüklenirken okur → içe aktarmadan önce ayarla
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-server-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_SERVER = '1';
delete process.env.DISPLAY;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { IS_SERVER } = await import('../src/platform.js');
const { deviceCalendarApp, listDeviceCalendars } = await import('../src/calendar-device.js');
const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { createServer } = await import('../src/server.js');

const store = new Store(path.join(tmp, 'test.db'));
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sunucu modu: cihaz takvimi yok', async () => {
  assert.equal(IS_SERVER, true);
  assert.equal(deviceCalendarApp(), null);
  await assert.rejects(listDeviceCalendars(), (e: Error & { code?: string }) => e.code === 'unsupported');
});

test('sunucu modu: her istek belirteç ister; hesap işlemleri ağ geçidinden yapılır; LAN ve ayrı giriş penceresi kapalı', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const reg = new Registry(store);
  const restarts: Array<{ id: string; opts: unknown }> = [];
  (reg as unknown as { spawn: () => Promise<void> }).spawn = async () => undefined;
  (reg as unknown as { restart: (id: string, opts?: unknown) => Promise<void> }).restart = async (id, opts) => void restarts.push({ id, opts });
  const server = createServer(store, reg, port);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();
  // ağ geçidinin gönderdiği biçim: Host 127.0.0.1:<port>, X-Forwarded-For, çekirdeğin kendi belirteci
  const gw = { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-kavsak-token': token };
  const req = (method: string, p: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    // yerelden (masaüstünde belirteçsiz geçerdi) belirteçsiz istek reddedilir
    assert.equal((await req('GET', '/api/health', { host: `127.0.0.1:${port}` })).status, 403);
    assert.equal((await req('GET', '/api/health', { host: `localhost:5173` })).status, 403);
    assert.equal((await req('GET', '/api/health', { ...gw, 'x-kavsak-token': 'yanlis' })).status, 403);
    const h = await req('GET', '/api/health', gw);
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.body).server, true);
    // hesap ekleme uzaktan (ağ geçidi) yapılabilir; iMessage yok
    assert.equal((await req('POST', '/api/accounts', gw, { platform: 'imessage' })).status, 400);
    const add = await req('POST', '/api/accounts', gw, { platform: 'telegram' });
    assert.equal(add.status, 200, add.body);
    const acc = JSON.parse(add.body) as { id: string };
    // ayrı giriş penceresi istense de Mivelo içi girişle yeniden başlar
    assert.equal((await req('POST', `/api/accounts/${encodeURIComponent(acc.id)}/login-window`, gw)).status, 200);
    assert.deepEqual(restarts.at(-1), { id: acc.id, opts: { external: false } });
    assert.equal((await req('DELETE', `/api/accounts/${encodeURIComponent(acc.id)}`, gw)).status, 200);
    // telefondan erişim açılamaz, ağ adresleri verilmez
    assert.equal((await req('POST', '/api/lan', gw, { enabled: true })).status, 403);
    assert.deepEqual(JSON.parse((await req('GET', '/api/lan', gw)).body), { enabled: false, urls: [] });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
