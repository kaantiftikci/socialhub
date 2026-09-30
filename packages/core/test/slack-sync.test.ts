import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-slsync-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BrowserConnector } = await import('../src/connectors/browser/bridge.js');
const { slackStrategy, _resetSlackState } = await import('../src/connectors/browser/slack.js');

/**
 * Uçtan uca (köprü + Slack stratejisi, sayfasız sahte API): sohbet listesi gelir; önizleme ve mesajlar da depoya yazılmalı.
 * Kaan (29.09): "Slack'te kişiler geliyor ama önizlemeler ve konuşma içerikleri hiç yüklenmiyor".
 */
test('slack köprü: ilk yoklamada mesajlar ve önizleme; iş parçacığı yanıtındaki hız sınırı kanalın geçmişini atmaz', async () => {
  _resetSlackState();
  const store = new Store(path.join(tmp, 's.db'));
  const account = { id: 'slack:e2e', platform: 'slack' as const, label: 't', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const conn = new BrowserConnector(account, store, slackStrategy, 30_000);
  const c = conn as unknown as Record<string, unknown>;
  const cfg = JSON.stringify({ teams: { T1: { token: 'xoxc-t', domain: 'ws', name: 'WS', user_id: 'U_ME', url: 'https://ws.slack.com/' } }, lastActiveTeamId: 'T1' });
  const state = { cookies: [{ name: 'd', value: 'x', domain: '.slack.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://app.slack.com', localStorage: [{ name: 'localConfig_v2', value: cfg }] }] };
  const replies: string[] = [];
  const resp: Record<string, (p: Record<string, string>) => object> = {
    'client.counts': () => ({
      ims: [{ id: 'D1', latest: '1700000010.000100', has_unreads: true, mention_count: 1 }],
      mpims: [],
      // kanalın son etkinliği bir iş parçacığı yanıtı (history'de görünmez)
      channels: [{ id: 'C1', latest: '1700000090.000000', has_unreads: false }],
    }),
    'conversations.list': () => ({ channels: [{ id: 'D1', is_im: true, user: 'U_A' }, { id: 'C1', name: 'genel' }] }),
    'users.info': (p) => ({ user: { id: p.user, name: p.user === 'U_A' ? 'ayse' : 'kaan', real_name: p.user === 'U_A' ? 'Ayşe Yılmaz' : 'Kaan' } }),
    'conversations.history': (p) =>
      p.channel === 'D1'
        ? { messages: [{ ts: '1700000010.000100', user: 'U_A', text: 'selam' }, { ts: '1700000005.000100', user: 'U_ME', text: 'naber' }] }
        : { messages: [{ ts: '1700000050.000000', user: 'U_A', text: 'duyuru', reply_count: 3, latest_reply: '1700000090.000000' }] },
    'conversations.replies': (p) => (replies.push(p.ts), { ok: false, error: 'ratelimited' }),
  };
  c.pageless = true;
  c.state = state;
  c.api = {
    storageState: async () => state,
    dispose: async () => undefined,
    post: async (url: string, o: { multipart: Record<string, string> }) => {
      const m = url.match(/api\/([\w.]+)/)![1];
      const j = { ok: true, ...(resp[m]?.(o.multipart) ?? {}) };
      return { status: () => (j.ok ? 200 : 429), headers: () => ({}), json: async () => j };
    },
  };
  await slackStrategy.me(new Proxy({}, { get: (_t, k) => (k === '__api' ? { api: c.api, state } : undefined) }) as never, {});
  await (c.pollInner as (f: boolean) => Promise<void>).call(conn, true);

  const dm = store.getChat('slack:e2e/D1')!;
  assert.equal(dm.name, 'Ayşe Yılmaz');
  assert.equal(dm.lastPreview, 'selam', 'DM önizlemesi');
  assert.deepEqual(store.listMessages('slack:e2e/D1', 10).map((m) => [m.text, m.fromMe]), [['naber', true], ['selam', false]]);
  // yanıt hız sınırına rağmen kanalın mesajı depoda
  assert.deepEqual(store.listMessages('slack:e2e/C1', 10).map((m) => m.text), ['duyuru']);
  assert.equal(replies.length, 1);
  // son etkinliği yanıt olan kanal: önizleme sonraki turda son üst mesajdan
  await (c.pollInner as (f: boolean) => Promise<void>).call(conn, false);
  assert.equal(store.getChat('slack:e2e/C1')!.lastPreview, 'Ayşe: duyuru');
  _resetSlackState();
});
