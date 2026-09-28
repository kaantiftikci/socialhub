import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-edit-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { DELETED_TEXT } = await import('../src/model.js');
const tg = await import('../src/connectors/telegram.js');
const wa = await import('../src/connectors/whatsapp.js');
const { slackStrategy, _resetSlackState } = await import('../src/connectors/browser/slack.js');
const { Api } = await import('teleproto');
const bigInt = (await import('big-integer')).default;

let n = 0;
function setup(platform: 'telegram' | 'whatsapp' | 'demo', remoteChat: string, kind: 'direct' | 'group' = 'direct') {
  const store = new Store(path.join(tmp, `e${++n}.db`));
  const account = { id: `${platform}:${n}`, platform, label: 'x', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const cid = `${account.id}/${remoteChat}`;
  store.upsertChat({ id: cid, accountId: account.id, platform, remoteId: remoteChat, name: 'Sohbet', kind, unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  return { store, account, cid };
}

test('store.applyEdit: düzenleme kalıcı, özgün metinli yeniden eşitleme ezmez; silme metni/ekleri değiştirir ve geri gelmez', () => {
  const { store, cid } = setup('demo', 'c');
  const base = { chatId: cid, senderId: 'me', senderName: 'Ben', fromMe: true, status: 'sent' as const };
  store.upsertMessage({ ...base, id: `${cid}#m1`, remoteId: 'm1', text: 'ilk hâli', ts: 1000 });
  let m = store.applyEdit(`${cid}#m1`, 'düzeltilmiş')!;
  assert.equal(m.text, 'düzeltilmiş');
  assert.equal(m.edited, true);
  assert.equal(store.getChat(cid)?.lastPreview, 'düzeltilmiş', 'son mesajsa önizleme de değişir');
  assert.equal(store.applyEdit(`${cid}#m1`, 'düzeltilmiş'), undefined, 'değişiklik yoksa undefined');
  // geçmiş yeniden gelir (düzenleme bilgisi yok, özgün metin): düzenlenmiş metin korunur
  store.upsertMessage({ ...base, id: `${cid}#m1`, remoteId: 'm1', text: 'ilk hâli', ts: 1000, status: 'read' });
  m = store.getMessage(`${cid}#m1`)!;
  assert.equal(m.text, 'düzeltilmiş');
  assert.equal(m.edited, true);
  assert.equal(m.status, 'read');
  // düzenleme bilgisiyle gelen yeni metin yazılır (Telegram/Slack geçmişi)
  store.upsertMessage({ ...base, id: `${cid}#m1`, remoteId: 'm1', text: 'ikinci düzenleme', ts: 1000, edited: true });
  assert.equal(store.getMessage(`${cid}#m1`)?.text, 'ikinci düzenleme');

  store.upsertMessage({ ...base, id: `${cid}#m2`, remoteId: 'm2', text: 'fotoğraf', ts: 2000, attachments: [{ kind: 'image', name: 'a.jpg' }] });
  m = store.applyEdit(`${cid}#m2`, null)!;
  assert.equal(m.deleted, true);
  assert.equal(m.text, DELETED_TEXT);
  assert.deepEqual(m.attachments, []);
  store.upsertMessage({ ...base, id: `${cid}#m2`, remoteId: 'm2', text: 'fotoğraf', ts: 2000, attachments: [{ kind: 'image', name: 'a.jpg' }] });
  m = store.getMessage(`${cid}#m2`)!;
  assert.equal(m.text, DELETED_TEXT, 'silinen mesaj yeniden eşitlemede geri gelmez');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.deleted, true);
  assert.equal(store.applyEdit(`${cid}#m2`, 'yeniden'), undefined, 'silinen mesaj düzenlenemez');
  assert.equal(store.applyEdit(`${cid}#yok`, null), undefined);
});

test('WhatsApp: herkesten sil / düzenle anahtarı fromMe + grupta katılımcı; gelen REVOKE ve düzenleme depoya işlenir', async () => {
  const { store, account, cid } = setup('whatsapp', '120363000000000001@g.us', 'group');
  const c = new wa.WhatsAppConnector(account, store);
  const sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const priv = c as unknown as {
    sock: unknown;
    gateSend(): Promise<void>;
    afterActivity(r: string): void;
    meIds: Set<string>;
    applyEdit(jid: string, id: string, update: Record<string, unknown>): void;
  };
  priv.sock = { sendMessage: async (jid: string, content: Record<string, unknown>) => (sent.push({ jid, content }), { key: { id: 'X' }, message: { conversation: 'x' } }), user: { id: '905550000000:1@s.whatsapp.net' } };
  priv.gateSend = async () => undefined;
  priv.afterActivity = () => undefined;
  await c.deleteMessage('120363000000000001@g.us', 'ABC');
  await c.editMessage('120363000000000001@g.us', 'ABC', 'yeni metin');
  const del = sent[0].content.delete as { id: string; fromMe: boolean; remoteJid: string };
  assert.equal(sent[0].jid, '120363000000000001@g.us');
  assert.deepEqual([del.id, del.fromMe, del.remoteJid], ['ABC', true, '120363000000000001@g.us']);
  assert.equal(sent[1].content.text, 'yeni metin');
  assert.equal((sent[1].content.edit as { id: string; fromMe: boolean }).fromMe, true);

  store.upsertMessage({ id: `${cid}#IN1`, chatId: cid, remoteId: 'IN1', senderId: 'x', senderName: 'Ali', fromMe: false, text: 'ilk', ts: 5, status: 'delivered' });
  priv.applyEdit('120363000000000001@g.us', 'IN1', { message: { editedMessage: { message: { conversation: 'düzeltme' } } } });
  assert.equal(store.getMessage(`${cid}#IN1`)?.text, 'düzeltme');
  assert.equal(store.getMessage(`${cid}#IN1`)?.edited, true);
  priv.applyEdit('120363000000000001@g.us', 'IN1', { messageStubType: 1 /* REVOKE */ });
  assert.equal(store.getMessage(`${cid}#IN1`)?.deleted, true);
  assert.equal(store.getMessage(`${cid}#IN1`)?.text, DELETED_TEXT);
});

test('Telegram: silme olayı (kanal dışı: kimlikle arama, kanal: kanal kimliği) ve düzenleme bayrağı', async () => {
  const { store, account, cid } = setup('telegram', '42');
  const c = new tg.TelegramConnector(account, store);
  const priv = c as unknown as {
    ingest(m: unknown, rid: string, name: string, live: boolean, sender?: string): void;
    onDeleted(ev: unknown): void;
    onEdited(ev: unknown): Promise<void>;
  };
  priv.ingest(new Api.Message({ id: 7, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1_700_000_000, message: 'selam', out: true }), '42', 'Ayşe', false);
  // düzenleme olayı: editDate varsa "düzenlendi"
  const edited = new Api.Message({ id: 7, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1_700_000_000, message: 'selam, nasılsın?', out: true, editDate: 1_700_000_100 });
  await priv.onEdited({ message: edited });
  let m = store.getMessage(`${cid}#7`)!;
  assert.equal(m.text, 'selam, nasılsın?');
  assert.equal(m.edited, true);
  // bilinmeyen mesajın düzenlemesi kayıt açmaz
  await priv.onEdited({ message: new Api.Message({ id: 99, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: 'x', editDate: 2 }) });
  assert.equal(store.getMessage(`${cid}#99`), undefined);

  priv.onDeleted({ deletedIds: [7], originalUpdate: new Api.UpdateDeleteMessages({ messages: [7], pts: 1, ptsCount: 1 }) });
  m = store.getMessage(`${cid}#7`)!;
  assert.equal(m.deleted, true);
  assert.equal(m.text, DELETED_TEXT);

  // kanal: sohbet kimliği -100<kanal>
  store.upsertChat({ id: `${account.id}/-100555`, accountId: account.id, platform: 'telegram', remoteId: '-100555', name: 'Kanal', kind: 'channel', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  store.upsertMessage({ id: `${account.id}/-100555#3`, chatId: `${account.id}/-100555`, remoteId: '3', senderId: 'k', senderName: 'Kanal', fromMe: false, text: 'duyuru', ts: 1, status: 'delivered' });
  priv.onDeleted({ deletedIds: [3], originalUpdate: new Api.UpdateDeleteChannelMessages({ channelId: bigInt(555), messages: [3], pts: 1, ptsCount: 1 }) });
  assert.equal(store.getMessage(`${account.id}/-100555#3`)?.deleted, true);
});

test('Slack (tarayıcı): unsend → chat.delete, edit → chat.update; geçmişteki edited alanı "düzenlendi"', async () => {
  _resetSlackState();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const page = {
    isClosed: () => false,
    url: () => 'https://app.slack.com/client/T1/C1',
    goto: async () => undefined,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, args?: { method?: string; params?: Record<string, unknown> }) => {
      if (!args?.method) return { token: 'xoxc-test', domain: 'ws', name: 'Test WS', userId: 'U_ME', url: 'https://ws.slack.com/' };
      calls.push({ method: args.method, params: args.params ?? {} });
      const j =
        args.method === 'conversations.history'
          ? { messages: [{ ts: '1700000001.000000', user: 'U_ME', text: 'düzeltildi', edited: { user: 'U_ME', ts: '1700000009.000000' } }] }
          : args.method === 'users.info'
            ? { user: { id: 'U_ME', name: 'kaan', real_name: 'Kaan' } }
            : {};
      return { j: { ok: true, ...j }, idx: 0 };
    },
  } as unknown as Page;
  await slackStrategy.unsend!(page, {}, 'C1', '1700000001.000000');
  await slackStrategy.edit!(page, {}, 'C1', '1700000001.000000', 'yeni');
  assert.deepEqual(calls[0], { method: 'chat.delete', params: { channel: 'C1', ts: '1700000001.000000' } });
  assert.equal(calls[1].method, 'chat.update');
  assert.equal(calls[1].params.text, 'yeni');
  await slackStrategy.me(page, {});
  const msgs = await slackStrategy.messages(page, {}, 'C1', 20);
  assert.equal(msgs[0].edited, true);
});
