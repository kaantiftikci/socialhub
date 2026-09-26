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

test('X gönderi önizlemesi: kimlik, gömme belirteci, gömme verisinden kart (oturumsuz)', async () => {
  const lp = await import('../src/link-preview.js');
  assert.equal(lp.xStatusId(new URL('https://x.com/laonzr4/status/1834567890123456789?s=20')), '1834567890123456789');
  assert.equal(lp.xStatusId(new URL('https://twitter.com/i/status/20')), '20');
  assert.equal(lp.xStatusId(new URL('https://example.com/a/status/20')), undefined);
  assert.equal(lp.syndicationToken('20'), ((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
  const v = lp.parseSyndication('https://x.com/a/status/1', {
    __typename: 'Tweet',
    text: 'Zeytinyağı ile 31 çektim https://t.co/abc123',
    user: { name: 'Laon', screen_name: 'laonzr4', profile_image_url_https: 'https://pbs.twimg.com/p_normal.jpg' },
    photos: [{ url: 'https://pbs.twimg.com/media/x.jpg' }],
  });
  assert.deepEqual(v, { url: 'https://x.com/a/status/1', site: 'X', title: 'Laon (@laonzr4)', description: 'Zeytinyağı ile 31 çektim', image: 'https://pbs.twimg.com/media/x.jpg' });
  const noMedia = lp.parseSyndication('u', { text: 'selam', user: { name: 'A', screen_name: 'a', profile_image_url_https: 'https://pbs.twimg.com/p_normal.jpg' } });
  assert.equal(noMedia?.image, 'https://pbs.twimg.com/p_bigger.jpg', 'medya yoksa profil fotoğrafı');
  assert.equal(lp.parseSyndication('u', { __typename: 'TweetTombstone' }), null);
});

test('X önizleme: salt medya gönderisi (metin yalnız t.co) → video kapağı; alıntılanan gönderiden yedek', async () => {
  const lp = await import('../src/link-preview.js');
  const v = lp.parseSyndication('u', { text: 'https://t.co/abc', user: { name: 'B', screen_name: 'balkolik' }, mediaDetails: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/k.jpg' }], video: { poster: 'https://p/x.jpg' } });
  assert.equal(v?.description, undefined);
  assert.equal(v?.image, 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/k.jpg');
  const q = lp.parseSyndication('u', { text: 'https://t.co/q', user: { name: 'A', screen_name: 'a' }, quoted_tweet: { text: 'alıntı metni', photos: [{ url: 'https://pbs.twimg.com/media/q.jpg' }] } });
  assert.equal(q?.description, 'alıntı metni');
  assert.equal(q?.image, 'https://pbs.twimg.com/media/q.jpg');
});
