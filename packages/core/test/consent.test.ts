import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-consent-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { CONSENT_VERSIONS, CONSENT_FILE, ConsentError, acceptedTermsVersion, consentState, readConsent, saveConsent } = await import('../src/consent.js');

test('ilk durumda tüm zorunlu onaylar eksik, AI rızası yok', () => {
  const s = consentState();
  assert.deepEqual(s.needed, ['terms', 'kvkk', 'risk']);
  assert.equal(s.ai, false);
  assert.equal(acceptedTermsVersion(), '');
});

test('zorunlu onaylar kaydedilir (0600), sürüm ve zaman tutulur; koşul sürümü lisansa gider', () => {
  const s = saveConsent({ accept: ['terms', 'kvkk', 'risk'] }, 1_000);
  assert.deepEqual(s.needed, []);
  assert.deepEqual(readConsent().terms, { v: CONSENT_VERSIONS.terms, at: 1_000 });
  assert.equal(acceptedTermsVersion(), CONSENT_VERSIONS.terms);
  if (process.platform !== 'win32') assert.equal(fs.statSync(CONSENT_FILE()).mode & 0o777, 0o600);
});

test('sürüm değişince yeniden sorulur', () => {
  const r = JSON.parse(fs.readFileSync(CONSENT_FILE(), 'utf8'));
  r.terms.v = '2020-01-01';
  fs.writeFileSync(CONSENT_FILE(), JSON.stringify(r));
  assert.deepEqual(consentState().needed, ['terms']);
  assert.equal(acceptedTermsVersion(), '');
  saveConsent({ accept: ['terms'] });
  assert.deepEqual(consentState().needed, []);
});

test('AI açık rızası verilir ve geri çekilir (geri çekme zamanı kalır)', () => {
  assert.equal(saveConsent({ ai: true }, 2_000).ai, true);
  const s = saveConsent({ ai: false }, 3_000);
  assert.equal(s.ai, false);
  assert.equal(s.accepted.ai, undefined);
  assert.equal(s.accepted.aiRevokedAt, 3_000);
  // zorunlular etkilenmez
  assert.deepEqual(s.needed, []);
  assert.equal(saveConsent({ accept: ['ai'] }, 4_000).accepted.aiRevokedAt, undefined);
});

test('geçersiz istekler reddedilir', () => {
  assert.throws(() => saveConsent(null), ConsentError);
  assert.throws(() => saveConsent({ accept: ['yok'] }), ConsentError);
  assert.throws(() => saveConsent({ accept: 'terms' }), ConsentError);
  assert.throws(() => saveConsent({ ai: 'evet' }), ConsentError);
});

test('bozuk dosya boş sayılır (uygulama yeniden sorar)', () => {
  fs.writeFileSync(CONSENT_FILE(), '{bozuk');
  assert.deepEqual(consentState().needed, ['terms', 'kvkk', 'risk']);
});
