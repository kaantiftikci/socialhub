import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-consent-lic-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_REQUIRE_LICENSE = '1';
process.env.MIVELO_TEST_MACHINE_ID = 'test-makine-onay';

// sahte lisans sunucusu: gelen gövdeleri saklar (kişisel veri yerine yalnız koşul sürümü gitmeli)
const bodies: Array<Record<string, unknown>> = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, activation: 'b'.repeat(32), expiresAt: null }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.MIVELO_LICENSE_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lic = await import('../src/license.js');
const { saveConsent, CONSENT_VERSIONS } = await import('../src/consent.js');

test('etkinleştirme ve denetim kabul edilen koşul sürümünü lisans sunucusuna iletir', async () => {
  saveConsent({ accept: ['terms', 'kvkk', 'risk'] });
  await lic.activateLicense('MVL-ABCD-EFGH-JKLM-NPQR');
  await lic.checkLicense();
  const act = bodies.find((b) => b.action === 'activate');
  const chk = bodies.find((b) => b.action === 'check');
  assert.equal(act?.terms, CONSENT_VERSIONS.terms);
  assert.equal(chk?.terms, CONSENT_VERSIONS.terms);
  // onay kaydının kendisi (zamanlar vb.) gönderilmez
  assert.equal(JSON.stringify(bodies).includes('kvkk'), false);
});
