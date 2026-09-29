import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-lic2-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_REQUIRE_LICENSE = '1';
process.env.MIVELO_TEST_MACHINE_ID = 'test-makine-1';

// sahte lisans sunucusu: etkinleştirmedeki cihaz dizesini tutar, denetimde farklı cihaz gelirse "bu cihaza ait değil"
let activeDevice = '';
const checks: string[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body) as { action: string; device?: string };
    res.setHeader('content-type', 'application/json');
    if (b.action === 'activate') {
      activeDevice = b.device ?? '';
      return res.end(JSON.stringify({ ok: true, activation: 'a'.repeat(32), expiresAt: null }));
    }
    if (b.action === 'check') {
      checks.push(b.device ?? '');
      if (b.device !== activeDevice) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, invalid: true, error: 'Lisans bu cihaza ait değil' }));
      }
      return res.end(JSON.stringify({ ok: true, expiresAt: null }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.MIVELO_LICENSE_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lic = await import('../src/license.js');
const file = path.join(tmp, 'license.json');

test('cihaz kimliği ağ kartından bağımsız: arayüzler değişince lisans geçerli kalır, sunucu denetimi silmez', async () => {
  const orig = os.networkInterfaces;
  await lic.activateLicense('MVL-ABCD-EFGH-JKLM-NPQR');
  assert.equal(lic.licensed(), true);
  try {
    // Wi-Fi kapalı (yalnız lo) ve başka bir kart öne geçti
    (os as { networkInterfaces: typeof os.networkInterfaces }).networkInterfaces = () => ({});
    assert.equal(lic.licensed(), true, 'Wi-Fi kapalı: geçerli');
    (os as { networkInterfaces: typeof os.networkInterfaces }).networkInterfaces = () =>
      ({ en7: [{ address: '10.0.0.2', netmask: '255.0.0.0', family: 'IPv4', mac: '02:11:22:33:44:55', internal: false, cidr: null }] }) as ReturnType<typeof os.networkInterfaces>;
    await lic.checkLicense();
    assert.equal(lic.licensed(), true, 'ağ değişti: geçerli');
    assert.equal(fs.existsSync(file), true, 'lisans silinmedi');
    assert.equal(checks.at(-1), activeDevice, 'sunucuya kayıttaki cihaz dizesi gider');
  } finally {
    (os as { networkInterfaces: typeof os.networkInterfaces }).networkInterfaces = orig;
  }
});

test('14 günlük pay dolmuşken başarılı denetim whenLicensed bekleyicisini ve dinleyicileri uyandırır', async () => {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { lastOk: number };
  fs.writeFileSync(file, JSON.stringify({ ...s, lastOk: Date.now() - 15 * 86_400_000 }));
  assert.equal(lic.licensed(), false);
  let resolved = false;
  const wait = lic.whenLicensed().then(() => (resolved = true));
  const seen: boolean[] = [];
  lic.onLicenseChange((v) => seen.push(v));
  await lic.checkLicense();
  await wait;
  assert.equal(resolved, true);
  assert.deepEqual(seen, [true]);
  // zaten geçerliyken başarılı denetim dinleyiciyi yeniden çağırmaz
  await lic.checkLicense();
  assert.deepEqual(seen, [true]);
});

test('eski kayıt (hw yok) geçerli sayılır ve ilk başarılı denetimde hw yazılır', async () => {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { hw?: string };
  delete s.hw;
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(lic.licensed(), true);
  await lic.checkLicense();
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { hw?: string }).hw, lic.hardwareId());
  // başka makineye kopyalanmış kayıt: yerelde geçersiz, sunucuya sorulmaz, silinmez
  const n = checks.length;
  fs.writeFileSync(file, JSON.stringify({ ...s, hw: 'baska-makine' }));
  assert.equal(lic.licensed(), false);
  await lic.checkLicense();
  assert.equal(checks.length, n);
});
