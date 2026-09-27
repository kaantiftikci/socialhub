import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-slackx-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { SlackConnector } = await import('../src/connectors/slack.js');

/** Resmi (xoxp) Slack connector'ı sahte WebClient ile: biçimlendirme, dosya vekili, tepkiler, iş parçacığı, eski mesaj, okundu */
test('slack xoxp: mesaj/iş parçacığı/tepki/okundu/eski mesaj', async () => {
  const store = new Store(path.join(tmp, 's.db'));
  const account = { id: 'slack:1', platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new SlackConnector(account, store, 'xoxp-test');
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rec = (name: string, out: unknown = { ok: true }) => async (a: Record<string, unknown>) => (calls.push([name, a]), out);
  (c as unknown as { meId: string }).meId = 'UME';
  (c as unknown as { web: unknown }).web = {
    users: { info: async ({ user }: { user: string }) => ({ user: { real_name: user === 'U1' ? 'Ayşe' : 'Kaan', name: user.toLowerCase() } }) },
    bots: { info: async () => ({ bot: { name: 'bot' } }) },
    conversations: {
      history: async (a: Record<string, unknown>) => (
        calls.push(['history', a]),
        {
          messages: [
            { ts: '1700000002.000200', user: 'U1', text: 'Selam <@UME> bak <https://x.com|burası>', reply_count: 1, latest_reply: '1700000003.0', reactions: [{ name: 'thumbsup', users: ['UME'], count: 2 }], files: [{ mimetype: 'image/png', name: 'a.png', url_private: 'https://files.slack.com/a.png' }] },
            { ts: '1700000001.000100', subtype: 'channel_join', user: 'U1', text: 'katıldı' },
          ],
        }
      ),
      replies: rec('replies', { messages: [{ ts: '1700000002.000200', latest_reply: '1700000003.0' }, { ts: '1700000003.000000', user: 'UME', text: 'tamam' }] }),
      mark: rec('mark'),
      open: rec('open', { channel: { id: 'D9' } }),
    },
    reactions: { add: rec('reactions.add'), remove: rec('reactions.remove') },
    chat: { postMessage: rec('postMessage', { ts: '1700000009.000000' }) },
  };
  await (c as unknown as { fetchHistory: (x: { id: string }, first: boolean) => Promise<void> }).fetchHistory({ id: 'C1' }, true);
  const msgs = store.listMessages('slack:1/C1', 50);
  const parent = msgs.find((m) => m.remoteId === '1700000002.000200')!;
  assert.equal(parent.text, 'Selam @ume bak burası (https://x.com)');
  assert.ok(parent.attachments?.[0].url?.startsWith('/api/media/slack%3A1?u=https%3A%2F%2Ffiles.slack.com'), 'dosya vekilden');
  assert.deepEqual(parent.reactions?.map((r) => [r.emoji, r.fromMe]), [['👍', true], ['👍', false]]);
  assert.equal(parent.replyCount, 1);
  assert.ok(!msgs.some((m) => m.text === 'katıldı'), 'sistem alt türü atlanır');
  const reply = msgs.find((m) => m.remoteId === '1700000003.000000')!;
  assert.equal(reply.threadId, '1700000002.000200');
  assert.equal(reply.fromMe, true);

  await c.sendText('C1', 'yanıt', { threadId: '1700000002.000200' });
  assert.deepEqual(calls.find((x) => x[0] === 'postMessage')![1], { channel: 'C1', text: 'yanıt', thread_ts: '1700000002.000200' });
  await c.react('C1', '1700000002.000200', '❤️', false);
  assert.deepEqual(calls.find((x) => x[0] === 'reactions.add')![1], { channel: 'C1', timestamp: '1700000002.000200', name: 'heart' });
  await c.markRead('C1');
  assert.equal(calls.find((x) => x[0] === 'mark')![1].channel, 'C1');
  await c.loadHistory('C1', 50, 1700000002000);
  assert.equal(calls.filter((x) => x[0] === 'history').at(-1)![1].latest, '1700000002.000000');
  assert.equal(await c.openDirect({ id: 'U1', name: 'Ayşe' }), 'D9');
});
