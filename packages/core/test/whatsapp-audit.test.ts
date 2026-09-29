import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-wa-audit-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { WhatsAppConnector, groupSig } = await import('../src/connectors/whatsapp.js');
const { sessionDir } = await import('../src/config.js');
type Message = import('../src/model.js').Message;

const JID = '905000000099@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
type Wa = {
  queueHistory: (m: unknown[], done?: () => void) => void;
  readSelfUpTo: (m: Message) => void;
  receiptFallback: (id: string) => Message | undefined;
  upsertMessage: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Message | undefined;
  learnContact: (c: Record<string, unknown>) => boolean;
  fetchMedia: (u: string) => Promise<{ body: Buffer; type: string } | undefined>;
  rememberMedia: (m: unknown, jid: string) => void;
  mediaPending: Map<string, string>;
};

function setup(name: string) {
  const store = new Store(path.join(tmp, `${name}.db`));
  const account = { id: `whatsapp:${name}`, platform: 'whatsapp' as const, label: 'WhatsApp', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const wa = new WhatsAppConnector({ ...account }, store) as unknown as Wa;
  return { store, wa, account, cid: `${account.id}/${JID}` };
}

function seedChat(store: InstanceType<typeof Store>, accountId: string, remote: string, n: number, t0: number) {
  const cid = `${accountId}/${remote}`;
  store.upsertChat({ id: cid, accountId, platform: 'whatsapp', remoteId: remote, name: 'Grup', kind: 'group', unread: 0, lastMessageAt: 0, lastPreview: '' });
  for (let i = 0; i < n; i++) {
    store.upsertMessage(
      { id: `${cid}#M${i}`, chatId: cid, remoteId: `M${i}`, senderId: JID, senderName: 'Ayşe', fromMe: false, text: `mesaj ${i}`, ts: t0 + i * 60_000, status: 'delivered' },
      { bumpUnread: true },
    );
  }
  return cid;
}

test('read-self alındısı yalnız okunan mesaja kadarını okundu yapar (aynı demette sonra gelen yeniler okunmamış kalır)', () => {
  const { store, wa, account } = setup('rs');
  const cid = seedChat(store, account.id, GROUP, 21, 1_700_000_000_000);
  assert.equal(store.getChat(cid)!.unread, 21);
  // telefonda M0 okunmuş; M1..M20 sonra geldi (uykudan uyanınca tek demet)
  wa.readSelfUpTo(store.getMessage(`${cid}#M0`)!);
  assert.equal(store.getChat(cid)!.unread, 20, 'okunan mesajdan sonraki 20 mesaj okunmamış kalır');
  // daha eski bir alındı sayacı artırmaz
  wa.readSelfUpTo(store.getMessage(`${cid}#M0`)!);
  assert.equal(store.getChat(cid)!.unread, 20);
  wa.readSelfUpTo(store.getMessage(`${cid}#M15`)!);
  assert.equal(store.getChat(cid)!.unread, 5);
  // en yeni mesajın alındısı: tamamı okundu (eski davranış)
  wa.readSelfUpTo(store.getMessage(`${cid}#M20`)!);
  assert.equal(store.getChat(cid)!.unread, 0);
  store.close();
});

test('bulunamayan alındı hedefi tekrar tekrar tüm hesapta aranmaz; kimlik sonradan yazılınca bulunur', () => {
  const { store, wa } = setup('rm');
  let calls = 0;
  const orig = store.findMessageByRemote.bind(store);
  store.findMessageByRemote = (a: string, r: string) => (calls++, orig(a, r));
  for (let i = 0; i < 100; i++) assert.equal(wa.receiptFallback('TEPKI1'), undefined);
  assert.equal(calls, 1, '100 üyenin alındısı tek arama');
  // aynı kimlik başka sohbet kimliğiyle (LID) yazılınca önbellek düşer
  wa.upsertMessage({ remoteChatId: '12345@lid', remoteId: 'TEPKI1', senderId: 'me', senderName: 'Ben', fromMe: true, text: 'selam', ts: 1_700_000_000_000, status: 'sent' });
  assert.equal(wa.receiptFallback('TEPKI1')?.remoteId, 'TEPKI1');
  store.close();
});

test('değişmeyen profil adı olayı ad yenilemesi gerektirmez; yeni ad ve yeni lid eşlemesi gerektirir', () => {
  const { store, wa } = setup('lc');
  assert.equal(wa.learnContact({ id: JID, notify: 'Ayşe' }), true);
  assert.equal(wa.learnContact({ id: JID, notify: 'Ayşe' }), false, 'her gelen mesajın aynı pushName olayı');
  assert.equal(wa.learnContact({ id: JID, notify: 'Ayşe Y.' }), true);
  assert.equal(wa.learnContact({ id: '777@lid', phoneNumber: JID }), true, 'yeni eşleme');
  assert.equal(wa.learnContact({ id: '777@lid', phoneNumber: JID }), false);
  store.close();
});

test('grup imzası: üye sırası önemsiz; ad, üye ve yöneticilik değişimi algılanır', () => {
  const a = { subject: 'Aile', addressingMode: 'lid', participants: [{ id: '1@lid', phoneNumber: '1@s.whatsapp.net' }, { id: '2@lid', admin: 'admin' }] };
  const b = { ...a, participants: [...a.participants].reverse() };
  assert.equal(groupSig(a as never), groupSig(b as never));
  assert.notEqual(groupSig(a as never), groupSig({ ...a, subject: 'Aile 2' } as never));
  assert.notEqual(groupSig(a as never), groupSig({ ...a, participants: [a.participants[0], { id: '2@lid' }] } as never));
  assert.notEqual(groupSig(a as never), groupSig({ ...a, participants: [a.participants[0]] } as never));
});

test('medya kaydı yoksa daha önce indirilmiş dosya yine gösterilir; ikisi de yoksa hata', async () => {
  const { store, wa, account } = setup('fm');
  const mediaDir = path.join(sessionDir(account.id), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const key = `${JID}__OLD1`;
  fs.writeFileSync(path.join(mediaDir, key), 'jpeg');
  fs.writeFileSync(path.join(mediaDir, key + '.type'), 'image/jpeg');
  const got = await wa.fetchMedia(`wa:${JID}/OLD1`);
  assert.equal(got?.type, 'image/jpeg');
  assert.equal(got?.body.toString(), 'jpeg');
  await assert.rejects(() => wa.fetchMedia(`wa-thumb:${JID}/OLD1`), /medya kaydı yok/, 'önizleme kaydın içinde: kayıt yoksa yok');
  await assert.rejects(() => wa.fetchMedia(`wa:${JID}/NONE`), /medya kaydı yok/);
  store.close();
});

test('çok sayıda bekleyen medya kaydı eksiksiz yazılır (haritayı kopyalamadan partiler)', async () => {
  const { store, wa, account } = setup('mp');
  const N = 300;
  for (let i = 0; i < N; i++) wa.rememberMedia({ key: { remoteJid: JID, id: `P${i}`, fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } }, JID);
  const dir = path.join(sessionDir(account.id), 'media-index');
  for (let t = 0; t < 100 && wa.mediaPending.size; t++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(wa.mediaPending.size, 0);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, N);
  store.close();
});

test('eski fotoğraf tek seferliğe çevrilince aynı gönderimin ikiz yer tutucusu hemen birleşir', async () => {
  const { store, wa, cid } = setup('tw');
  const ts = 1_700_000_000;
  const history = (msgs: unknown[]) => new Promise<void>((r) => wa.queueHistory(msgs, r));
  const img = { imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.from('k').toString('base64'), url: 'https://mmg.whatsapp.net/x' } };
  // eski sürüm: aynı gönderim biri yer tutucu (A), biri normal fotoğraf (B, 3 sn sonra)
  await history([
    { key: { remoteJid: JID, id: 'A', fromMe: false }, message: { viewOnceMessageV2: { message: img } }, messageTimestamp: ts },
    { key: { remoteJid: JID, id: 'B', fromMe: false }, message: img, messageTimestamp: ts + 3 },
  ]);
  assert.equal(store.getMessage(`${cid}#B`)!.attachments?.length, 1);
  // B yeniden tek seferlik olarak gelir → yerinde çevrilir → A ile ikiz → biri silinir
  await history([{ key: { remoteJid: JID, id: 'B', fromMe: false }, message: { viewOnceMessageV2: { message: img } }, messageTimestamp: ts + 3 }]);
  const left = ['A', 'B'].filter((id) => store.getMessage(`${cid}#${id}`));
  assert.equal(left.length, 1, 'tek balon kalır');
  store.close();
});
