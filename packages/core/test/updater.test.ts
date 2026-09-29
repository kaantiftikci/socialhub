import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appLocation, assetName, macScript, winScript } from '../src/updater.js';

test('paket adı işletim sistemi ve işlemciye göre', () => {
  assert.equal(assetName('darwin', 'arm64'), 'Mivelo-mac-arm64.dmg');
  assert.equal(assetName('darwin', 'x64'), 'Mivelo-mac-intel.dmg');
  assert.equal(assetName('win32', 'x64'), 'Mivelo-windows-x64-setup.exe');
  assert.equal(assetName('linux', 'x64'), undefined);
});

test('uygulama konumu: Mac .app paketi, Windows Mivelo.exe klasörü; geliştirmede yok', () => {
  assert.equal(appLocation('/Applications/Mivelo.app/Contents/Resources/core/bin/node', 'darwin'), '/Applications/Mivelo.app');
  assert.equal(appLocation('/usr/local/bin/node', 'darwin'), undefined);
  const win = 'C:\\Users\\ornek\\AppData\\Local\\Mivelo';
  assert.equal(appLocation(`${win}\\core\\bin\\node.exe`, 'win32', (p) => p === `${win}\\Mivelo.exe`), win);
  assert.equal(appLocation('C:\\Program Files\\nodejs\\node.exe', 'win32', () => false), undefined);
});

test('betikler yolları güvenli tırnaklar ve sözdizimi geçerli', () => {
  const app = "/Applications/Ali'nin Mivelo.app";
  const s = macScript(app, '/tmp/a b.dmg', '/tmp/log');
  assert.ok(s.includes(`APP='/Applications/Ali'\\''nin Mivelo.app'`));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), 'k.sh');
  fs.writeFileSync(f, s);
  execFileSync('bash', ['-n', f]); // yalnız sözdizimi denetimi (çalıştırmaz)
  const w = winScript("C:\\Users\\O'Neil\\Mivelo", 'C:\\x\\setup.exe', 'C:\\x\\log');
  assert.ok(w.includes("$dir = 'C:\\Users\\O''Neil\\Mivelo'"));
  assert.ok(w.includes("-ArgumentList '/S'"));
});
