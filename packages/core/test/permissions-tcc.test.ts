import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { tccFromRows } = await import('../src/permissions.js');

test('TCC kaydından izin durumu: verilen kazanır, kayıt yoksa bilinmiyor, başka hedefe Apple Event sayılmaz', () => {
  assert.deepEqual(tccFromRows([]), { microphone: 'unknown', messages: 'unknown', calendar: 'unknown' });
  const s = tccFromRows([
    { service: 'kTCCServiceMicrophone', v: 0 },
    { service: 'kTCCServiceMicrophone', v: 2 },
    { service: 'kTCCServiceAppleEvents', v: 2, target: 'com.apple.finder' },
    { service: 'kTCCServiceAppleEvents', v: 0, target: 'com.apple.MobileSMS' },
    { service: 'kTCCServiceAppleEvents', v: 2, target: 'com.apple.iCal' },
  ]);
  assert.deepEqual(s, { microphone: 'granted', messages: 'denied', calendar: 'granted' });
});

test('gerçek şemaya benzer TCC.db satırları okunabilir (sorgu sözdizimi)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-'));
  const db = new Database(path.join(dir, 'TCC.db'));
  db.exec('CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER, indirect_object_identifier TEXT)');
  db.prepare('INSERT INTO access VALUES (?,?,?,?,?)').run('kTCCServiceMicrophone', 'app.kavsak.desktop', 0, 2, 'UNUSED');
  db.prepare('INSERT INTO access VALUES (?,?,?,?,?)').run('kTCCServiceMicrophone', 'com.baska.uygulama', 0, 0, 'UNUSED');
  const rows = db.prepare(`SELECT service, auth_value AS v, indirect_object_identifier AS target FROM access WHERE client IN (?) OR client LIKE '%/Mivelo.app/%'`).all('app.kavsak.desktop') as Array<{ service: string; v: number; target: string }>;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(tccFromRows(rows).microphone, 'granted');
});
