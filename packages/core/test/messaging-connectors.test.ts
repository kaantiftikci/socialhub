import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri (names.json vb.) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const im = await import('../src/connectors/imessage.js');
const tg = await import('../src/connectors/telegram.js');
const wa = await import('../src/connectors/whatsapp.js');
const { Api } = await import('telegram');
const bigInt = (await import('big-integer')).default;

let n = 0;
function setup(platform: 'imessage' | 'telegram' | 'whatsapp') {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `${platform}:t${n}`, platform, label: 'x', status: 'connected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  return { store, account };
}

// ---------------- iMessage ----------------

type ImRow = Record<string, unknown>;

function imRow(over: Record<string, unknown>): ImRow {
  return {
    rowid: 1,
    guid: 'g1',
    text: 'merhaba',
    attributedBody: null,
    date: 700_000_000_000_000_000,
    is_from_me: 0,
    handle: '+905321234567',
    chat_identifier: '+905321234567',
    chat_guid: 'any;-;+905321234567',
    display_name: null,
    cache_has_attachments: 0,
    item_type: 0,
    is_filtered: 0,
    date_retracted: null,
    associated_message_type: 0,
    ...over,
  };
}

test('iMessage phoneKeys: rehberdeki 0532… ile +90532… aynı kişi; e-posta küçük harf', () => {
  assert.deepEqual(im.phoneKeys('0532 123 45 67'), ['+905321234567', '#5321234567']);
  assert.ok(im.phoneKeys('+90 (532) 123-4567').includes('#5321234567'));
  assert.ok(im.phoneKeys('532 123 45 67').includes('#5321234567'));
  assert.deepEqual(im.phoneKeys('Ali@Example.com'), ['ali@example.com']);
  assert.deepEqual(im.phoneKeys('1234'), []);
});

test('iMessage tapback ve klasör eşlemesi', () => {
  for (const t of [2000, 2001, 2005, 3000, 3005]) assert.equal(im.isAssociatedReaction(t), true, String(t));
  for (const t of [0, null, undefined, 1000]) assert.equal(im.isAssociatedReaction(t as number), false, String(t));
  assert.equal(im.imessageFolder(0), undefined);
  assert.equal(im.imessageFolder(1), 'unknown');
  assert.equal(im.imessageFolder(4), 'unknown');
  assert.equal(im.imessageFolder(2), 'junk');
});

test('iMessage ingest: tapback mesaj olmaz, klasör güncellenir, (smsft) eki ada girmez, rehber adı kullanılır', () => {
  const { store, account } = setup('imessage');
  const c = new im.IMessageConnector(account, store);
  const priv = c as unknown as { names: Map<string, string>; ingest(r: ImRow, live: boolean): void };
  for (const k of im.phoneKeys('0532 123 45 67')) priv.names.set(k, 'Ayşe Yılmaz');
  const cid = `${account.id}/any;-;+905321234567`;

  // eski sürümün yazdığı "sms" klasörü + bilinen kişiye taşınmış sohbet
  store.upsertChat({ id: cid, accountId: account.id, platform: 'imessage', remoteId: 'any;-;+905321234567', name: '+905321234567', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [], meta: { folder: 'sms', pinned: true } });
  priv.ingest(imRow({}), false);
  let chat = store.getChat(cid)!;
  assert.equal(chat.name, 'Ayşe Yılmaz');
  assert.equal(chat.meta?.folder, undefined, 'bilinen kişi: klasör kaldırılmalı');
  assert.equal(chat.meta?.pinned, true, 'diğer meta alanları korunur');

  priv.ingest(imRow({ guid: 'g2', is_filtered: 2, date: 700_000_001_000_000_000 }), false);
  chat = store.getChat(cid)!;
  assert.equal(chat.meta?.folder, 'junk');

  // tapback ("❤️ ile beğendi") ayrı mesaj değil
  priv.ingest(imRow({ guid: 'g3', text: 'Loved “merhaba”', associated_message_type: 2000 }), false);
  assert.equal(store.getMessage(`${cid}#g3`), undefined);
  assert.ok(store.getMessage(`${cid}#g1`));

  // gönderen numarasız kendi mesajı + filtre ekli tanımlayıcı → ad ekten arındırılır
  const cid2 = `${account.id}/any;-;+905559449797(smsft)`;
  priv.ingest(imRow({ guid: 'g4', is_from_me: 1, handle: null, chat_identifier: '+905559449797(smsft)', chat_guid: 'any;-;+905559449797(smsft)', is_filtered: 4 }), false);
  assert.equal(store.getChat(cid2)?.name, '+905559449797');
  assert.equal(store.getChat(cid2)?.meta?.folder, 'unknown');
});

test('iMessage decodeAttributedBody: NSString yükü (kısa ve 0x81 uzun uzunluk)', () => {
  const mk = (s: string) => {
    const body = Buffer.from(s, 'utf8');
    const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([body.length & 0xff, body.length >> 8])]);
    return Buffer.concat([Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1'), len, body, Buffer.from([0x86])]);
  };
  assert.equal(im.decodeAttributedBody(mk('Selam 👋')), 'Selam 👋');
  const long = 'ç'.repeat(200);
  assert.equal(im.decodeAttributedBody(mk(long)), long);
  assert.equal(im.decodeAttributedBody(null), '');
});

// ---------------- Telegram ----------------

test('Telegram entityName', () => {
  assert.equal(tg.entityName({ firstName: 'Ali', lastName: 'Veli' }), 'Ali Veli');
  assert.equal(tg.entityName({ title: 'Grup' }), 'Grup');
  assert.equal(tg.entityName({ username: 'ali' }), '@ali');
  assert.equal(tg.entityName({}), '');
  assert.equal(tg.entityName(undefined), '');
});

test('Telegram ingest: grup geçmişinde gönderen adı grubun adı değil kişinin adı; bağlantı önizlemesi boş ek bırakmaz', () => {
  const { store, account } = setup('telegram');
  const c = new tg.TelegramConnector(account, store);
  const priv = c as unknown as { ingest(m: unknown, rid: string, name: string, live: boolean, sender?: string): void };
  store.upsertChat({ id: `${account.id}/-100123`, accountId: account.id, platform: 'telegram', remoteId: '-100123', name: 'Test Grubu', kind: 'group', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  const m = new Api.Message({ id: 5, peerId: new Api.PeerChannel({ channelId: bigInt(123) }), date: 1_700_000_000, message: 'selam' });
  (m as unknown as { _sender: unknown })._sender = new Api.User({ id: bigInt(42), firstName: 'Ayşe', lastName: 'Kaya' });
  priv.ingest(m, '-100123', 'Test Grubu', false);
  assert.equal(store.getMessage(`${account.id}/-100123#5`)?.senderName, 'Ayşe Kaya');

  // eski sürümün bıraktığı içi boş {kind:'other'} eki, önizlemesiz bağlantı mesajı yeniden alınınca temizlenir
  store.upsertMessage({ id: `${account.id}/-100123#6`, chatId: `${account.id}/-100123`, remoteId: '6', senderId: '1', senderName: 'x', fromMe: false, text: 'https://t.me/x', ts: 1, status: 'delivered', attachments: [{ kind: 'other' }] });
  const w = new Api.Message({ id: 6, peerId: new Api.PeerUser({ userId: bigInt(1) }), date: 1_700_000_001, message: 'https://t.me/x', media: new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: bigInt(1) }) }) });
  priv.ingest(w, '-100123', 'Test Grubu', false);
  assert.deepEqual(store.getMessage(`${account.id}/-100123#6`)?.attachments ?? [], []);
});

// ---------------- WhatsApp (Baileys 7) ----------------

type WaPriv = {
  learnContact(c: Record<string, unknown>): void;
  nameOf(jid: string): string;
  canon(jid: string): string;
  applyGroup(id: string, subject: string | undefined, parts: Array<Record<string, unknown>> | undefined, mode?: string): void;
  participantOf(group: string, sender: string): string;
  wireOf(jid: string): string;
  meIds: Set<string>;
};

test('WhatsApp kişi: Baileys 7 id=LID + phoneNumber eşlenir; profil adı (notify) rehber adını ezmez', async () => {
  const { store, account } = setup('whatsapp');
  const c = new wa.WhatsAppConnector(account, store);
  const p = c as unknown as WaPriv;
  const pn = '15550100001@s.whatsapp.net';
  const lid = '111222333@lid';
  // uygulama durumundaki contactAction: id LID, karşılığı phoneNumber
  p.learnContact({ id: lid, phoneNumber: pn, name: 'Rehberdeki Ad' });
  assert.equal(p.canon(lid), pn);
  assert.equal(p.nameOf(pn), 'Rehberdeki Ad');
  // her gelen mesajın contacts.update{notify} olayı
  p.learnContact({ id: pn, notify: 'Profil Adı' });
  assert.equal(p.nameOf(pn), 'Rehberdeki Ad');
  assert.equal(p.nameOf(lid), 'Rehberdeki Ad');
  // rehberde olmayan kişi: profil adı kullanılır, sonra güncellenir
  const other = '15550100002@s.whatsapp.net';
  p.learnContact({ id: other, notify: 'Eski Profil' });
  p.learnContact({ id: other, notify: 'Yeni Profil' });
  assert.equal(p.nameOf(other), 'Yeni Profil');
  // kendi numaram
  p.meIds.add('15550100009@s.whatsapp.net');
  assert.equal(p.nameOf('15550100009@s.whatsapp.net'), 'Ben (kendime)');
  await c.stop();
});

test('WhatsApp grup üyeleri (Baileys 7: id + phoneNumber/lid) ve LID gruplarında alındı katılımcısı', async () => {
  const { store, account } = setup('whatsapp');
  const c = new wa.WhatsAppConnector(account, store);
  const p = c as unknown as WaPriv;
  const g = '120363000000000001@g.us';
  p.applyGroup(
    g,
    'Test',
    [
      { id: '444555666@lid', phoneNumber: '15550100003@s.whatsapp.net', admin: 'admin' },
      { id: '15550100004@s.whatsapp.net', lid: '777888999@lid', admin: null },
    ],
    'lid',
  );
  assert.equal(p.canon('444555666@lid'), '15550100003@s.whatsapp.net');
  assert.equal(p.canon('777888999@lid'), '15550100004@s.whatsapp.net');
  const chat = store.getChat(`${account.id}/${g}`)!;
  assert.deepEqual(chat.participants?.map((m) => m.id), ['15550100003@s.whatsapp.net', '15550100004@s.whatsapp.net']);
  assert.equal(chat.participants?.[0].admin, true);
  // LID grubunda okundu alındısının katılımcısı @lid olmalı; numara grubunda numara
  assert.equal(p.participantOf(g, '15550100003@s.whatsapp.net'), '444555666@lid');
  assert.equal(p.participantOf('120363000000000002@g.us', '15550100003@s.whatsapp.net'), '15550100003@s.whatsapp.net');
  assert.equal(p.wireOf('15550100003@s.whatsapp.net'), '15550100003@s.whatsapp.net');
  await c.stop();
});

test('WhatsApp errorText: Baileys günlüğündeki hata nesneleri "[object Object]" olmasın', () => {
  assert.equal(wa.errorText({ message: 'Invalid PreKey ID', output: { statusCode: 500 } }), 'Invalid PreKey ID (500)');
  assert.equal(wa.errorText('Error: x\n at y'), 'Error: x\n at y');
  assert.equal(wa.errorText({}), '');
  assert.equal(wa.errorText({ type: 'SessionError' }), '{"type":"SessionError"}');
  assert.equal(wa.errorText(undefined), '');
});

test('WhatsApp düzenleme ve herkesten silme mevcut mesajı günceller', async () => {
  const { store, account } = setup('whatsapp');
  const c = new wa.WhatsAppConnector(account, store);
  const p = c as unknown as { applyEdit(jid: string, id: string, update: Record<string, unknown>): void };
  const jid = '15550100005@s.whatsapp.net';
  const cid = `${account.id}/${jid}`;
  store.upsertChat({ id: cid, accountId: account.id, platform: 'whatsapp', remoteId: jid, name: 'X', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  store.upsertMessage({ id: `${cid}#A1`, chatId: cid, remoteId: 'A1', senderId: jid, senderName: 'X', fromMe: false, text: 'ilk', ts: 1000, status: 'delivered' });
  p.applyEdit(jid, 'A1', { message: { editedMessage: { message: { conversation: 'düzeltilmiş' } } } });
  assert.equal(store.getMessage(`${cid}#A1`)?.text, 'düzeltilmiş');
  p.applyEdit(jid, 'A1', { message: null, messageStubType: 1 });
  assert.equal(store.getMessage(`${cid}#A1`)?.text, '🚫 Bu mesaj silindi');
  p.applyEdit(jid, 'YOK', { message: { conversation: 'x' } });
  assert.equal(store.getMessage(`${cid}#YOK`), undefined);
  await c.stop();
});
