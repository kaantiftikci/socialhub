import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-official-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_OAUTH_REMOTE = '0';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('resmi girişli hesap list() ve durum kaydında official; uygulama şifreli hesap değil', async () => {
  const store = new Store(path.join(tmp, 'o.db'));
  const reg = new Registry(store);
  // ağa çıkmasın: süresi geçerli belirteç + olmayan sunucu (bağlantı hatası olur, sorun değil)
  const tok = { user: 'ornek@example.com', oauth: 'google', accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000, host: '127.0.0.1', port: 1, secure: false };
  const a = await reg.add('gmail', { token: JSON.stringify(tok), label: 'ornek@example.com' });
  await sleep(50);
  assert.equal(reg.list().find((x) => x.id === a.id)?.official, true);
  const b = await reg.add('imap', { token: JSON.stringify({ user: 'baska@example.com', pass: 'p', host: '127.0.0.1', port: 1, secure: false, smtpHost: '127.0.0.1', smtpPort: 1 }) });
  await sleep(50);
  assert.equal(reg.list().find((x) => x.id === b.id)?.official, undefined);
  await reg.stopAll();
});
