import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetGoogleKeyCache, viaGoogle } from '../src/ml/google-translate.js';
import { MlError } from '../src/ml/config.js';

const KEY = 'AIza' + 'x'.repeat(35);
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('Google çeviri: istek biçimi, varlık çözme, algılanan dil', async () => {
  resetGoogleKeyCache(KEY);
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Merhaba &amp; &#39;hoş geldin&#39;', detectedSourceLanguage: 'en' }] } }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await viaGoogle(['Hello & welcome'], 'tr', null, f);
  assert.equal(r.texts[0], "Merhaba & 'hoş geldin'");
  assert.equal(r.source, 'en');
  assert.match(seen!.url, /translation\.googleapis\.com\/language\/translate\/v2\?key=AIza/);
  assert.deepEqual(seen!.body, { q: ['Hello & welcome'], target: 'tr', format: 'text' });
});

test('Google çeviri: hatalar anlaşılır', async () => {
  resetGoogleKeyCache(KEY);
  await assert.rejects(viaGoogle(['a'], 'tr', 'en', reply(400, { error: { message: 'API key not valid', errors: [{ reason: 'badRequest' }] } })), (e: MlError) => /geçersiz/.test(e.message));
  await assert.rejects(viaGoogle(['a'], 'tr', 'en', reply(403, { error: { message: 'This API method requires billing to be enabled' } })), (e: MlError) => /faturalandırma/.test(e.message));
  await assert.rejects(viaGoogle(['a'], 'tr', 'en', reply(429, {})), (e: MlError) => e.status === 429);
  resetGoogleKeyCache(null);
  await assert.rejects(viaGoogle(['a'], 'tr', 'en', reply(200, {})), (e: MlError) => e.status === 409);
});
