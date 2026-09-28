import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-lic-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_REQUIRE_LICENSE = '1';

// sahte lisans sunucusu (mivelo.app/api/license.php yerine)
let owner: unknown = { name: 'Ayşe Yılmaz', email: 'ayse@example.com' };
const calls: string[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body) as { action: string };
    calls.push(b.action);
    res.setHeader('content-type', 'application/json');
    if (b.action === 'activate') return res.end(JSON.stringify({ ok: true, activation: 'a'.repeat(32), expiresAt: null, owner }));
    if (b.action === 'check') return res.end(JSON.stringify({ ok: true, expiresAt: null, owner }));
    return res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.MIVELO_LICENSE_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { activateLicense, checkLicense, licenseStatus, releaseLicense } = await import('../src/license.js');

test('lisans sahibi: etkinleştirmede ve denetimde gelir, arayüze döner; çıkışta silinir', async () => {
  assert.equal(licenseStatus().valid, false);
  const st = await activateLicense('mvl abcd-efgh jklm-npqr');
  assert.equal(st.valid, true);
  assert.deepEqual(st.owner, { name: 'Ayşe Yılmaz', email: 'ayse@example.com' });
  assert.match(st.key ?? '', /^MVL-ABCD-••••-••••-NPQR$/);
  // sunucu adı değiştirdi (üye kaydı güncellendi); kontrol karakteri ve aşırı uzunluk temizlenir
  owner = { name: `Ayşe\u0007 Kaya${'x'.repeat(200)}`, email: 'ayse@example.com' };
  await checkLicense();
  const o = licenseStatus().owner!;
  assert.equal(o.name?.startsWith('Ayşe Kaya'), true);
  assert.equal(o.name!.length, 80);
  // sahip bilgisi gelmezse önceki kalır
  owner = undefined;
  await checkLicense();
  assert.equal(licenseStatus().owner?.email, 'ayse@example.com');
  // dosyada saklanır (0600)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'license.json'), 'utf8')) as { owner?: { email?: string } };
  assert.equal(saved.owner?.email, 'ayse@example.com');
  await releaseLicense();
  const out = licenseStatus();
  assert.equal(out.valid, false);
  assert.equal(out.owner, undefined, 'çıkıştan sonra sahip bilgisi arayüze gitmez');
  assert.deepEqual(calls, ['activate', 'check', 'check', 'release']);
});
