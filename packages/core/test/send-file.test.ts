import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { acceptsMime, pickFileInput } from '../src/connectors/browser/outlook.js';
import { slackStrategy, completedShareTs, _resetSlackState } from '../src/connectors/browser/slack.js';

// ───────────── Dosya girişi seçimi (accept özniteliği) ─────────────

test('acceptsMime: boş accept her şeyi alır; image/*, uzantı ve tam mime kuralları', () => {
  const png = { name: 'ekran.PNG', mime: 'image/png' };
  const pdf = { name: 'fatura.pdf', mime: 'application/pdf' };
  assert.equal(acceptsMime('', png), true);
  assert.equal(acceptsMime(undefined, pdf), true);
  assert.equal(acceptsMime('image/*', png), true);
  assert.equal(acceptsMime('image/*', pdf), false);
  // Instagram DM girişi
  assert.equal(acceptsMime('audio/*,.mp4,.mov,.png,.jpg,.jpeg', png), true);
  assert.equal(acceptsMime('audio/*,.mp4,.mov,.png,.jpg,.jpeg', pdf), false);
  assert.equal(acceptsMime('audio/*,.mp4,.mov,.png,.jpg,.jpeg', { name: 'ses.m4a', mime: 'audio/mp4' }), true);
  // LinkedIn genel girişi
  assert.equal(acceptsMime('image/*,.ai,.psd,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.eml,.mov,.mp4', pdf), true);
  assert.equal(acceptsMime('image/*,.pdf', { name: 'arsiv.zip', mime: 'application/zip' }), false);
  assert.equal(acceptsMime('application/pdf', pdf), true);
});

test('pickFileInput: özel kural her şeyi alan girişe yeğlenir; kabul eden yoksa -1', () => {
  const png = { name: 'a.png', mime: 'image/png' };
  const pdf = { name: 'a.pdf', mime: 'application/pdf' };
  // LinkedIn: [resim, genel]
  const li = [{ accept: 'image/*' }, { accept: 'image/*,.pdf,.docx,.mp4' }];
  assert.equal(pickFileInput(li, png), 1); // ikisi de özel kural: sonuncusu
  assert.equal(pickFileInput(li, pdf), 1);
  assert.equal(pickFileInput(li, { name: 'a.zip', mime: 'application/zip' }), -1);
  // Outlook: [image/*, "", "", ""] → resimde image/* girişi, PDF'te boş accept'li son giriş
  const ow = [{ accept: 'image/*' }, { accept: '' }, { accept: '' }, { accept: '' }];
  assert.equal(pickFileInput(ow, png), 0);
  assert.equal(pickFileInput(ow, pdf), 3);
  // Instagram: tek giriş, PDF kabul etmez
  assert.equal(pickFileInput([{ accept: 'audio/*,.mp4,.mov,.png,.jpg,.jpeg' }], pdf), -1);
  assert.equal(pickFileInput([{ accept: null }], pdf), 0);
  assert.equal(pickFileInput([], pdf), -1);
});

// ───────────── Slack: iki adımlı yükleme ─────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-sendfile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Sahte sayfa: slack() çağrılarını (args.method) yanıtlar, yükleme fetch'ini (args.url) kaydeder; context() yok → sayfa fetch yolu */
function fakePage(handlers: Record<string, (params: Record<string, unknown>) => unknown>, calls: Array<{ method: string; params: Record<string, unknown> }>, uploads: Array<{ url: string; bytes: number; mime: string }>): Page {
  return {
    isClosed: () => false,
    url: () => 'https://app.slack.com/client/T1/C1',
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, args?: { method?: string; params?: Record<string, unknown>; url?: string; b64?: string; mime?: string }) => {
      if (args?.url) {
        uploads.push({ url: args.url, bytes: Buffer.from(args.b64 ?? '', 'base64').length, mime: args.mime ?? '' });
        return { ok: true, status: 200 };
      }
      if (!args?.method) return { token: 'xoxc-test', domain: 'ws', name: 'Test WS', userId: 'U_ME', url: 'https://ws.slack.com/' };
      calls.push({ method: args.method, params: args.params ?? {} });
      const h = handlers[args.method];
      if (!h) throw new Error(`Slack ${args.method}: beklenmeyen çağrı`);
      return { j: { ok: true, ...(h(args.params ?? {}) as object) }, idx: 0 };
    },
  } as unknown as Page;
}

test('slack sendFile: getUploadURLExternal → baytlar upload_url\'ye → completeUploadExternal (channel_id, initial_comment); paylaşım ts döner', async () => {
  _resetSlackState();
  const file = path.join(tmp, 'rapor.pdf');
  fs.writeFileSync(file, Buffer.alloc(1234, 7));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const uploads: Array<{ url: string; bytes: number; mime: string }> = [];
  const page = fakePage(
    {
      'files.getUploadURLExternal': (p) => {
        assert.equal(p.filename, 'rapor.pdf');
        assert.equal(p.length, 1234);
        return { upload_url: 'https://files.slack.com/upload/v1/ABC', file_id: 'F123' };
      },
      'files.completeUploadExternal': () => ({ files: [{ id: 'F123', shares: { public: { C1: [{ ts: '1790000000.000100' }] } } }] }),
    },
    calls,
    uploads,
  );
  const id = await slackStrategy.sendFile!(page, {}, 'C1', { path: file, name: 'rapor.pdf', mime: 'application/pdf', size: 1234 }, 'buyrun');
  assert.equal(id, '1790000000.000100');
  assert.deepEqual(uploads, [{ url: 'https://files.slack.com/upload/v1/ABC', bytes: 1234, mime: 'application/pdf' }]);
  const done = calls.find((c) => c.method === 'files.completeUploadExternal')!;
  assert.equal(done.params.channel_id, 'C1');
  assert.equal(done.params.initial_comment, 'buyrun');
  assert.deepEqual(JSON.parse(String(done.params.files)), [{ id: 'F123', title: 'rapor.pdf' }]);
  assert.deepEqual(calls.map((c) => c.method), ['files.getUploadURLExternal', 'files.completeUploadExternal']);
});

test('slack sendFile: açıklama yoksa initial_comment gönderilmez; paylaşım ts yoksa dosya kimliği döner', async () => {
  _resetSlackState();
  const file = path.join(tmp, 'a.png');
  fs.writeFileSync(file, Buffer.alloc(10));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const page = fakePage({ 'files.getUploadURLExternal': () => ({ upload_url: 'https://files.slack.com/u', file_id: 'F9' }), 'files.completeUploadExternal': () => ({ files: [{ id: 'F9' }] }) }, calls, []);
  const id = await slackStrategy.sendFile!(page, {}, 'D1', { path: file, name: 'a.png', mime: 'image/png', size: 10 });
  assert.equal(id, 'F9');
  assert.equal('initial_comment' in calls[1].params, false);
});

test('slack completedShareTs: public/private paylaşımlar, başka kanal yok sayılır', () => {
  assert.equal(completedShareTs({ files: [{ shares: { private: { D1: [{ ts: '1.2' }] } } }] }, 'D1'), '1.2');
  assert.equal(completedShareTs({ files: [{ shares: { public: { C2: [{ ts: '1.2' }] } } }] }, 'C1'), undefined);
  assert.equal(completedShareTs({}, 'C1'), undefined);
});
