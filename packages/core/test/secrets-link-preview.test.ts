import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-secrets-'));
process.env.KAVSAK_DATA_DIR = tmp;
delete process.env.ANTHROPIC_API_KEY;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { getSecret, setSecret } = await import('../src/secrets.js');
const { aiEnabled, aiKey, aiKeySource, setAiKey } = await import('../src/ai.js');
const { fetchPreview } = await import('../src/link-preview.js');

test('gizli değer: yaz, oku, güncelle, sil (Linux dosya yedeği 0600)', () => {
  assert.equal(getSecret('deneme'), null);
  setSecret('deneme', 'birinci');
  assert.equal(getSecret('deneme'), 'birinci');
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    const mode = fs.statSync(path.join(tmp, 'deneme.secret')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  setSecret('deneme', 'ikinci');
  assert.equal(getSecret('deneme'), 'ikinci');
  setSecret('deneme', null);
  assert.equal(getSecret('deneme'), null);
});

test('AI anahtarı Ayarlar deposundan gelir ve kaldırılabilir', () => {
  assert.equal(aiEnabled(), false);
  setAiKey('sk-ant-test-0123456789abcdefghij');
  assert.equal(aiEnabled(), true);
  assert.equal(aiKeySource(), 'settings');
  assert.equal(aiKey(), 'sk-ant-test-0123456789abcdefghij');
  setAiKey(null);
  assert.equal(aiEnabled(), false);
  assert.equal(aiKeySource(), null);
});

test('bağlantı önizlemesi yerel/özel adreslere istek atmaz', async () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.5/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://example.com:8080/', 'file:///etc/passwd']) {
    assert.equal(await fetchPreview(u), null, u);
  }
});
