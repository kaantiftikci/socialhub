import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-slackp-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { SlackConnector } = await import('../src/connectors/slack.js');

/** users.conversations imleçle tüm sayfalar; imleci olmayan sohbetin eski mesajları canlı sayılmaz; gönderim lastTs'i ilerletmez */
test('slack xoxp: sayfalı liste, eski mesaj canlı değil, gönderim imleci oynatmaz', async () => {
  const store = new Store(path.join(tmp, 's.db'));
  const account = { id: 'slack:2', platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new SlackConnector(account, store, 'xoxp-test');
  const cursors: Array<string | undefined> = [];
  const now = Date.now() / 1000;
  (c as unknown as { meId: string }).meId = 'UME';
  (c as unknown as { startedAt: number }).startedAt = Date.now() - 60_000;
  (c as unknown as { web: unknown }).web = {
    users: {
      info: async () => ({ user: { real_name: 'Ayşe', name: 'ayse' } }),
      conversations: async (a: { cursor?: string }) => (
        cursors.push(a.cursor),
        a.cursor ? { channels: [{ id: 'C2', is_channel: true, name: 'genel' }] } : { channels: [{ id: 'D1', is_im: true, user: 'U1' }], response_metadata: { next_cursor: 'p2' } }
      ),
    },
    conversations: {
      history: async () => ({
        messages: [
          { ts: now.toFixed(6), user: 'U1', text: 'yeni' },
          { ts: (now - 86_400).toFixed(6), user: 'U1', text: 'eski' },
        ],
      }),
    },
    chat: { postMessage: async () => ({ ts: (now + 5).toFixed(6) }) },
  };
  await (c as unknown as { refreshList: () => Promise<void> }).refreshList();
  assert.deepEqual(cursors, [undefined, 'p2']);
  assert.deepEqual((c as unknown as { convs: Array<{ id: string }> }).convs.map((x) => x.id), ['D1', 'C2']);

  await (c as unknown as { fetchHistory: (x: { id: string }, first: boolean) => Promise<void> }).fetchHistory({ id: 'C2' }, false);
  assert.equal(store.getChat('slack:2/C2')!.unread, 1, 'yalnız bağlandıktan sonraki mesaj sayılır');

  const lastTs = (c as unknown as { lastTs: Map<string, string> }).lastTs;
  const before = lastTs.get('C2');
  await c.sendText('C2', 'selam');
  assert.equal(lastTs.get('C2'), before);
});

/** Tek sohbetin geçmiş hatası turun geri kalanını durdurmaz; metni boş (yalnız bloklu) mesaj da alınır */
test('slack xoxp: bir sohbetin hatası diğerlerini engellemez; bloklu mesaj metni', async () => {
  const store = new Store(path.join(tmp, 's2.db'));
  const account = { id: 'slack:3', platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new SlackConnector(account, store, 'xoxp-test');
  const now = Date.now() / 1000;
  (c as unknown as { meId: string }).meId = 'UME';
  (c as unknown as { web: unknown }).web = {
    users: {
      info: async () => ({ user: { real_name: 'Ayşe', name: 'ayse' } }),
      conversations: async () => ({ channels: [{ id: 'D1', is_im: true, user: 'U1' }, { id: 'C2', is_channel: true, name: 'genel' }] }),
    },
    conversations: {
      history: async (a: { channel: string }) => {
        if (a.channel === 'D1') throw Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } });
        return { messages: [{ ts: now.toFixed(6), user: 'U1', text: '', blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'blok metni' }] }] }] }] };
      },
    },
  };
  await (c as unknown as { poll: (first: boolean) => Promise<void> }).poll(true);
  assert.deepEqual(store.listMessages('slack:3/C2', 5).map((m) => m.text), ['blok metni']);
  assert.equal(store.getChat('slack:3/C2')!.lastPreview, 'Ayşe: blok metni');
});
