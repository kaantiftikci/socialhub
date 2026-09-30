import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-people-api-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { createServer } = await import('../src/server.js');

const store = new Store(path.join(tmp, 'test.db'));
const port = 43000 + Math.floor(Math.random() * 2000);
const server = createServer(store, new Registry(store), port);
await new Promise<void>((r) => server.once('listening', () => r()));
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

const enc = encodeURIComponent;

test('uçlar: öneri → birleştir → zaman çizelgesi → ayır; grup sohbeti bağlanamaz', async () => {
  for (const [id, platform] of [['whatsapp:a', 'whatsapp'], ['imessage:a', 'imessage']] as const) store.upsertAccount({ id, platform, label: id, status: 'connected', createdAt: 1 });
  const wa = 'whatsapp:a/905000000099@s.whatsapp.net';
  const im = 'imessage:a/iMessage;-;+905000000099';
  store.upsertChat({ id: wa, accountId: 'whatsapp:a', platform: 'whatsapp', remoteId: '905000000099@s.whatsapp.net', name: 'Örnek Kişi', kind: 'direct', unread: 0, lastMessageAt: 2, lastPreview: '', tags: [] });
  store.upsertChat({ id: im, accountId: 'imessage:a', platform: 'imessage', remoteId: 'iMessage;-;+905000000099', name: 'Örnek', kind: 'direct', unread: 0, lastMessageAt: 3, lastPreview: '', tags: [] });
  store.upsertChat({ id: 'whatsapp:a/g@g.us', accountId: 'whatsapp:a', platform: 'whatsapp', remoteId: 'g@g.us', name: 'Grup', kind: 'group', unread: 0, lastMessageAt: 1, lastPreview: '', tags: [] });
  store.upsertMessage({ id: `${wa}#1`, chatId: wa, remoteId: '1', senderId: 'o', senderName: 'O', fromMe: false, text: 'wa', ts: 10, status: 'read' });
  store.upsertMessage({ id: `${im}#1`, chatId: im, remoteId: '1', senderId: 'o', senderName: 'O', fromMe: true, text: 'im', ts: 20, status: 'read' });

  const sg = await req('GET', '/api/people/suggestions');
  assert.equal(sg.status, 200);
  assert.equal(sg.json.suggestions.length, 1);
  assert.equal(sg.json.suggestions[0].strong, true);

  const bad = await req('POST', '/api/people', { chatIds: [wa, 'whatsapp:a/g@g.us'] });
  assert.equal(bad.status, 400);

  const merged = await req('POST', `/api/people/suggestions/${enc(sg.json.suggestions[0].key)}/merge`);
  assert.equal(merged.status, 200);
  assert.equal(merged.json.name, 'Örnek Kişi');
  const list = await req('GET', '/api/people');
  assert.equal(list.json.length, 1);

  const tl = await req('GET', `/api/people/${enc(merged.json.id)}/timeline?limit=10`);
  assert.deepEqual(tl.json.messages.map((m: { text: string; platform: string }) => `${m.platform}:${m.text}`), ['whatsapp:wa', 'imessage:im']);

  const ren = await req('POST', `/api/people/${enc(merged.json.id)}`, { name: 'Yeni Ad' });
  assert.equal(ren.json.name, 'Yeni Ad');

  const un = await req('POST', `/api/people/${enc(merged.json.id)}/unlink`, { chatId: im });
  assert.equal(un.status, 200);
  assert.equal(un.json.person, null, 'tek sohbet kalınca kişi silinir');
  assert.equal((await req('GET', '/api/people')).json.length, 0);
  assert.equal((await req('GET', '/api/people/nope/timeline')).status, 404);
});
