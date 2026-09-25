import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-react-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const tg = await import('../src/connectors/telegram.js');
const slack = await import('../src/connectors/browser/slack.js');
const { parsePreview } = await import('../src/link-preview.js');
const { Api } = await import('telegram');
const bigInt = (await import('big-integer')).default;

test('store: setReaction kişi başına tek tepki, kaldırma; setFlags yalnız verilen alanları değiştirir', () => {
  const store = new Store(path.join(tmp, 'r.db'));
  store.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  store.upsertChat({ id: 'demo:1/c', accountId: 'demo:1', platform: 'demo', remoteId: 'c', name: 'C', kind: 'group', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  store.upsertMessage({ id: 'demo:1/c#m1', chatId: 'demo:1/c', remoteId: 'm1', senderId: 'u1', senderName: 'Ali', fromMe: false, text: 'selam', ts: 1000, status: 'delivered' });
  let m = store.setReaction('demo:1/c#m1', { emoji: '👍', senderId: 'me', senderName: 'Ben', fromMe: true })!;
  assert.deepEqual(m.reactions?.map((r) => r.emoji), ['👍']);
  m = store.setReaction('demo:1/c#m1', { emoji: '❤️', senderId: 'me', senderName: 'Ben', fromMe: true })!;
  assert.deepEqual(m.reactions?.map((r) => r.emoji), ['❤️'], 'aynı kişinin tepkisi değişir, çoğalmaz');
  m = store.setReaction('demo:1/c#m1', { emoji: '🔥', senderId: 'u1', senderName: 'Ali', fromMe: false })!;
  assert.equal(m.reactions?.length, 2);
  m = store.setReaction('demo:1/c#m1', { emoji: '', senderId: 'me', senderName: 'Ben', fromMe: true }, true)!;
  assert.deepEqual(m.reactions, [{ emoji: '🔥', senderId: 'u1', senderName: 'Ali', fromMe: false }]);
  assert.deepEqual(store.getMessage('demo:1/c#m1')?.reactions?.length, 1, 'diske yazıldı');
  m = store.setReactions('demo:1/c#m1', undefined)!;
  assert.equal(m.reactions, undefined);

  let c = store.setFlags('demo:1/c', { pinned: true, muted: true })!;
  assert.equal(c.pinned, true);
  assert.equal(c.muted, true);
  c = store.setFlags('demo:1/c', { muted: false })!;
  assert.equal(c.pinned, true, 'verilmeyen alan korunur');
  assert.equal(c.muted, undefined);
  // connector upsertChat bayrakları ezmez
  store.upsertChat({ id: 'demo:1/c', accountId: 'demo:1', platform: 'demo', remoteId: 'c', name: 'C', kind: 'group', unread: 1, lastMessageAt: 5, lastPreview: 'x', tags: [] });
  assert.equal(store.getChat('demo:1/c')?.pinned, true);
  store.close?.();
});

test('Telegram tgReactions: recentReactions kişi bazlı (my → benim); results sayaçlarında chosenOrder benim', () => {
  const recent = new Api.MessageReactions({
    results: [new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '👍' }), count: 2, chosenOrder: 0 })],
    recentReactions: [
      new Api.MessagePeerReaction({ peerId: new Api.PeerUser({ userId: bigInt(5) }), reaction: new Api.ReactionEmoji({ emoticon: '👍' }), date: 1, my: true }),
      new Api.MessagePeerReaction({ peerId: new Api.PeerUser({ userId: bigInt(7) }), reaction: new Api.ReactionEmoji({ emoticon: '👍' }), date: 1 }),
    ],
  });
  const a = tg.tgReactions(recent, 'Ayşe')!;
  assert.deepEqual(a.map((r) => [r.emoji, r.fromMe, r.senderId]), [['👍', true, 'me'], ['👍', false, '7']]);
  const counts = new Api.MessageReactions({ results: [new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: '❤️' }), count: 1 })] });
  const b = tg.tgReactions(counts, 'Ayşe')!;
  assert.deepEqual(b, [{ emoji: '❤️', senderId: 'other', senderName: 'Ayşe', fromMe: false }]);
  assert.equal(tg.tgReactions(undefined, ''), undefined);
});

test('Slack emoji adı ↔ karakter', () => {
  assert.equal(slack.slackEmojiName('👍'), '+1');
  assert.equal(slack.slackEmojiName('❤️'), 'heart');
  assert.equal(slack.slackEmojiName('🔥'), 'fire');
  assert.equal(slack.SLACK_EMOJI['+1'], '👍');
  assert.equal(slack.slackEmojiName(':custom:'), 'custom');
});

test('link-preview parsePreview: og etiketleri, göreli görsel, varlık çözümü; başlık yoksa null', () => {
  const html = `<html><head><title>Fallback &amp; Title</title><meta property="og:title" content="quicker.chat &#215; beehiiv"><meta name="description" content="Placement in the newsletter"><meta property="og:image" content="/img/a.png"><meta property="og:site_name" content="beehiiv"></head></html>`;
  const p = parsePreview('https://partners.beehiiv.com/quicker', html)!;
  assert.equal(p.title, 'quicker.chat × beehiiv');
  assert.equal(p.description, 'Placement in the newsletter');
  assert.equal(p.image, 'https://partners.beehiiv.com/img/a.png');
  assert.equal(p.site, 'beehiiv');
  const q = parsePreview('https://x.example.com/a', '<html><head><title>Only &amp; Title</title></head></html>')!;
  assert.equal(q.title, 'Only & Title');
  assert.equal(q.site, 'x.example.com');
  assert.equal(parsePreview('https://e.com', '<html><body>hi</body></html>'), null);
});
