import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri gerçek ~/.mivelo'ya yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mail-limit-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { MailConnector } = await import('../src/connectors/mail.js');

let n = 0;
function make() {
  const store = new Store(path.join(tmp, `l${++n}.db`));
  const account = { id: `gmail:l${n}`, platform: 'gmail' as const, label: 'Gmail', status: 'connected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new MailConnector(account, store, { user: 'ornek@example.com', pass: 'p', host: 'imap.example.com' });
  const priv = c as unknown as { classify(e: unknown): void; authFailed: boolean };
  return { c, priv };
}

test('LOGIN NO [ALERT] Too many simultaneous connections yanlış şifre sayılmaz, 15 dk bekleme', () => {
  const { c, priv } = make();
  assert.equal(c.retryAfterMs, 0);
  priv.classify({ authenticationFailed: true, message: 'Command failed', responseText: 'Too many simultaneous connections. (Failure)' });
  assert.equal(priv.authFailed, false);
  assert.ok(c.retryAfterMs > 14 * 60_000 && c.retryAfterMs <= 15 * 60_000);
});

test('karşılama BYE metni err.reason\'dan okunur', () => {
  const { c, priv } = make();
  priv.classify({ message: 'Unexpected close', reason: 'Too many simultaneous connections' });
  assert.ok(c.retryAfterMs > 14 * 60_000);
});

test('gerçek şifre reddi hâlâ authFailed; yalın [ALERT] kimlik reddini ezmez', () => {
  const { c, priv } = make();
  priv.classify({ authenticationFailed: true, message: 'Command failed', responseText: '[ALERT] Invalid credentials (Failure)' });
  assert.equal(priv.authFailed, true);
  assert.equal(c.retryAfterMs, 0);
});

test('ETHROTTLE throttleReset kadar bekletir', () => {
  const { c, priv } = make();
  priv.classify({ code: 'ETHROTTLE', throttleReset: 120_000 });
  assert.ok(c.retryAfterMs > 110_000 && c.retryAfterMs <= 120_000);
});

test('serverResponseCode LIMIT (metinde kod yok) de 15 dk bekletir, yanlış şifre sayılmaz', () => {
  const { c, priv } = make();
  priv.classify({ authenticationFailed: true, message: 'Command failed', serverResponseCode: 'LIMIT', responseText: 'Server Unavailable. 15' });
  assert.equal(priv.authFailed, false);
  assert.ok(c.retryAfterMs > 14 * 60_000);
});

test('ayrıştırılmamış response nesnesindeki LIMIT kodu okunur', () => {
  const { c, priv } = make();
  priv.classify({ message: 'Command failed', response: { attributes: [{ section: [{ value: 'limit' }] }] } });
  assert.ok(c.retryAfterMs > 14 * 60_000);
});
