import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-sec-'));
process.env.KAVSAK_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { privateIp } = await import('../src/link-preview.js');
const { parseStart, formatStart } = await import('../src/calendar.js');
const { Store } = await import('../src/store.js');
const { checkSend, resetSendGuard, persistSendGuard } = await import('../src/send-guard.js');
const { Registry } = await import('../src/registry.js');
const { createServer } = await import('../src/server.js');

const store = new Store(path.join(tmp, 'test.db'));
after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('privateIp: IPv6 içine gömülü IPv4 ve yerel aralıklar engellenir', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '100.64.0.1', '198.18.0.5', '169.254.1.1', '::1', '::', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:c0a8:101', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001:0:1::1', 'zzz'])
    assert.equal(privateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:808:808', '2606:4700::1111', '64:ff9b::808:808', '2002:808:808::1'])
    assert.equal(privateIp(ip), false, ip);
  // URL ayrıştırıcısı [::ffff:127.0.0.1] adresini onaltılı yazar: yine yakalanmalı
  assert.equal(privateIp(new URL('http://[::ffff:127.0.0.1]/').hostname.replace(/^\[|\]$/g, '')), true);
});

test('parseStart saat/dakika sınırı; formatStart kanonik biçim', () => {
  assert.equal(parseStart('2026-10-02T24:00'), null);
  assert.equal(parseStart('2026-10-02T10:60'), null);
  assert.equal(formatStart(parseStart(' 2026-10-02 09:05 ')!), '2026-10-02T09:05');
  assert.equal(formatStart(parseStart('2026-10-02')!), '2026-10-02');
});

test('dueEventReminders: boşluklu eski kayıt da hatırlatılır', () => {
  store.saveEvent({ id: 'sp', title: 'X', start: '2026-10-02 14:00', durationMin: 30, remindMin: 10, createdAt: 1 });
  assert.deepEqual(store.dueEventReminders(new Date(2026, 9, 2, 13, 50)).map((e) => e.id), ['sp']);
});

test('send-guard: tekrar anahtarı metin değil özet; dosyada mesaj metni yok, eski düz anahtarlar atılır', async () => {
  const file = path.join(tmp, 'sg.json');
  const secret = 'Gizli sipariş numaram 99887766 ve adresim burada';
  fs.writeFileSync(file, JSON.stringify({ recent: [[`a|${secret}`, [{ at: Date.now(), chat: 'c1' }]]] }));
  resetSendGuard();
  persistSendGuard(file);
  checkSend({ accountId: 'a', platform: 'instagram', chatId: 'c1', text: secret });
  await new Promise((r) => setTimeout(r, 2300));
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('99887766'), raw);
  assert.match(raw, /a\|[0-9a-f]{64}/);
});

test('registry: aynı hesaba eşzamanlı restart sıralı çalışır', async () => {
  const reg = new Registry(store);
  store.upsertAccount({ id: 'demo:abcd', platform: 'demo', label: 'd', status: 'disconnected', createdAt: 1 });
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  (reg as unknown as { spawn: () => Promise<void> }).spawn = async () => {
    running++;
    calls++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
  };
  await Promise.all([reg.restart('demo:abcd'), reg.restart('demo:abcd'), reg.restart('demo:abcd')]);
  assert.equal(calls, 3);
  assert.equal(maxRunning, 1);
  store.deleteAccount('demo:abcd');
});

test('sunucu: yabancı Host (DNS rebinding) reddedilir; /api/lan uzak isteğe belirteç vermez', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = createServer(store, new Registry(store), port);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const req = (p: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end();
    });
  try {
    assert.equal((await req('/api/health', { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await req('/api/health', { host: `localhost:5173` })).status, 200, 'Vite vekili');
    assert.equal((await req('/api/health', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await req('/api/health', { host: `localhost:9999` })).status, 403);
    const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();
    // yerel: belirteç (varsa ağ arayüzü) QR bağlantısında
    const local = JSON.parse((await req('/api/lan', { host: `127.0.0.1:${port}` })).body) as { urls: string[] };
    for (const u of local.urls) assert.ok(u.includes(`#token=${token}`));
    // tünel (forwarded) + belirteç: yanıt belirteç içermez
    const remote = await req('/api/lan', { host: 'tunnel.example', 'x-forwarded-for': '1.2.3.4', 'x-kavsak-token': token });
    assert.equal(remote.status, 200);
    assert.ok(!remote.body.includes(token));
    assert.equal((await req('/api/lan', { host: 'tunnel.example', 'x-forwarded-for': '1.2.3.4', 'x-kavsak-token': 'yanlis' })).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('sunucu: olmayan hesap 404 (500 değil); etiketler yalnız metin/sayı, olmayan sohbet 404', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = createServer(store, new Registry(store), port);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const req = (method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    assert.equal((await req('DELETE', '/api/accounts/yok')).status, 404);
    assert.equal((await req('POST', '/api/accounts/yok/restart')).status, 404);
    assert.equal((await req('POST', '/api/chats/yok/tags', { tags: ['a'] })).status, 404);
    store.upsertAccount({ id: 'demo:t', platform: 'demo', label: 'T', status: 'connected', createdAt: Date.now() });
    store.upsertChat({ id: 'demo:t/c', accountId: 'demo:t', platform: 'demo', remoteId: 'c', name: 'C', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
    const r = await req('POST', `/api/chats/${encodeURIComponent('demo:t/c')}/tags`, { tags: [1, null, {}, ' iş ', 'iş', ['x']] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body).tags, ['1', 'iş']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('registry: aynı e-posta adresi yeniden eklenince kopya açılmaz, var olan hesabın şifresi güncellenir (Yahoo "Şifreyi güncelle")', async () => {
  const reg = new Registry(store);
  // gerçek IMAP bağlantısı kurulmasın
  (reg as unknown as { spawn: () => Promise<void> }).spawn = async () => undefined;
  const a = await reg.add('yahoo', { token: JSON.stringify({ user: 'kaan@yahoo.com', pass: 'eski', host: 'imap.elle.example' }) });
  const b = await reg.add('yahoo', { token: JSON.stringify({ user: 'Kaan@Yahoo.com', pass: 'yeni' }) });
  assert.equal(b.id, a.id);
  assert.equal(store.listAccounts().filter((x) => x.platform === 'yahoo').length, 1);
  const tok = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', a.id, 'token'), 'utf8'));
  assert.equal(tok.pass, 'yeni');
  assert.equal(tok.host, 'imap.elle.example', 'formda verilmeyen alan korunur');
  // farklı adres → ayrı hesap
  const c = await reg.add('yahoo', { token: JSON.stringify({ user: 'baska@yahoo.com', pass: 'p' }) });
  assert.notEqual(c.id, a.id);
  store.deleteAccount(a.id);
  store.deleteAccount(c.id);
});
