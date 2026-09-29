import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killProcessesMatching } from '../src/platform.js';

// Profil kilidi kurtarması: `--user-data-dir=…` kalıbı pkill'e seçenek sanılmamalı, süreç gerçekten kapanmalı
test('killProcessesMatching: --user-data-dir=… kalıplı süreci öldürür (regex karakterleri kaçırılır)', { skip: process.platform === 'win32' }, async () => {
  const profile = `/tmp/mv-test-${process.pid}/sessions/ig:a(b)+c.d/profile`;
  const frag = `--user-data-dir=${profile}`;
  const child = spawn('bash', ['-c', `exec -a "fakechrome ${frag}" sleep 60`], { stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'sahte süreç çalışıyor olmalı');
  // benzer ama farklı profil öldürülmemeli: kaçırılmamış `a(b)+c.d` regex'i "abbcXd"yi de eşlerdi
  const other = spawn('bash', ['-c', `exec -a "fakechrome --user-data-dir=/tmp/mv-test-${process.pid}/sessions/ig:abbcXd/profile" sleep 60`], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const ok = await killProcessesMatching(frag);
    assert.equal(ok, true);
    await exited;
    assert.notEqual(child.signalCode ?? child.exitCode, null);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null, 'benzer adlı başka profil öldürülmemeli');
  } finally {
    other.kill('SIGKILL');
    child.kill('SIGKILL');
  }
});

test('killProcessesMatching: eşleşen süreç yoksa hemen true', { skip: process.platform === 'win32' }, async () => {
  const t0 = Date.now();
  assert.equal(await killProcessesMatching(`--user-data-dir=/yok/${process.pid}/profile`), true);
  assert.ok(Date.now() - t0 < 3000);
});
