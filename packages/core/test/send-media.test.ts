import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-media-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { sessionDir } = await import('../src/config.js');
const wa = await import('../src/connectors/whatsapp.js');
const tg = await import('../src/connectors/telegram.js');
const im = await import('../src/connectors/imessage.js');
const mail = await import('../src/connectors/mail.js');
const { Api } = await import('telegram');
const bigInt = (await import('big-integer')).default;

let n = 0;
function setup(platform: 'imessage' | 'telegram' | 'whatsapp' | 'imap') {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `${platform}:t${n}`, platform, label: 'x', status: 'connected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  return { store, account };
}

function outboxFile(name: string, content = 'x'.repeat(10)): { path: string; name: string; mime: string; size: number } {
  const dir = path.join(tmp, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${name}`);
  fs.writeFileSync(p, content);
  const ext = path.extname(name).slice(1);
  const mime = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', mp4: 'video/mp4', m4a: 'audio/mp4', pdf: 'application/pdf' }[ext] ?? 'application/octet-stream';
  return { path: p, name, mime, size: content.length };
}

// ---------------- WhatsApp ----------------

test('WhatsApp waMediaContent: MIME → Baileys içeriği (fotoğraf/video/ses/belge; GIF belge)', () => {
  const f = (name: string) => outboxFile(name);
  const img = wa.waMediaContent(f('a.jpg'), 'selam') as { image: { url: string }; caption?: string; mimetype?: string };
  assert.equal(img.image.url, f('a.jpg').path.replace(/\d+-a\.jpg$/, '') + path.basename(img.image.url));
  assert.equal(img.caption, 'selam');
  assert.equal(img.mimetype, 'image/jpeg');
  const vid = wa.waMediaContent(f('b.mp4'), 'v') as { video: { url: string }; caption?: string };
  assert.ok(vid.video.url.endsWith('b.mp4'));
  assert.equal(vid.caption, 'v');
  const aud = wa.waMediaContent(f('c.m4a'), 'altyazı') as { audio: { url: string }; ptt: boolean; mimetype: string; caption?: string };
  assert.ok(aud.audio.url.endsWith('c.m4a'));
  assert.equal(aud.ptt, false);
  assert.equal(aud.mimetype, 'audio/mp4');
  assert.equal('caption' in aud, false, 'ses altyazı taşımaz');
  const doc = wa.waMediaContent(f('d.pdf'), 'bak') as { document: { url: string }; mimetype: string; fileName: string; caption?: string };
  assert.ok(doc.document.url.endsWith('d.pdf'));
  assert.equal(doc.mimetype, 'application/pdf');
  assert.equal(doc.fileName, 'd.pdf');
  assert.equal(doc.caption, 'bak');
  const gif = wa.waMediaContent(f('e.gif')) as { document?: unknown; image?: unknown };
  assert.ok(gif.document && !gif.image, 'GIF belge olarak gider');
  const unknown = wa.waMediaContent({ ...f('x'), mime: '' }) as { document: unknown; mimetype: string };
  assert.equal(unknown.mimetype, 'application/octet-stream');
});

test('WhatsApp waMediaContent: voice → sesli mesaj (ptt:true, ogg/opus mimetype); altyazı taşımaz', () => {
  const v = wa.waMediaContent({ ...outboxFile('ses.ogg'), mime: 'audio/ogg; codecs=opus', voice: true }, 'not') as { audio: { url: string }; ptt: boolean; mimetype: string; caption?: string };
  assert.ok(v.audio.url.endsWith('ses.ogg'));
  assert.equal(v.ptt, true);
  assert.equal(v.mimetype, 'audio/ogg; codecs=opus');
  assert.equal('caption' in v, false);
  // ffmpeg yoksa kayıt olduğu gibi (webm/mp4) ama yine ptt
  const raw = wa.waMediaContent({ ...outboxFile('ses.webm'), mime: 'audio/webm;codecs=opus', voice: true }) as { ptt: boolean; mimetype: string };
  assert.equal(raw.ptt, true);
  assert.equal(raw.mimetype, 'audio/webm;codecs=opus');
});

test('WhatsApp sendMedia: sock.sendMessage hedefi sohbet jid; dönen WAMessage ingest ile eke dönüşür; ses altyazısı ayrı metin', async () => {
  const { store, account } = setup('whatsapp');
  const c = new wa.WhatsAppConnector(account, store);
  const calls: Array<{ jid: string; content: Record<string, unknown> }> = [];
  const jid = '15550100007@s.whatsapp.net';
  (c as unknown as { sock: unknown }).sock = {
    sendMessage: async (j: string, content: Record<string, unknown>) => {
      calls.push({ jid: j, content });
      const id = `SENT${calls.length}`;
      const message = content.image
        ? { imageMessage: { mimetype: 'image/jpeg', fileLength: 10, caption: content.caption, url: 'https://mmg.whatsapp.net/x', mediaKey: Buffer.from('k') } }
        : content.audio
          ? { audioMessage: { mimetype: 'audio/mp4', fileLength: 10, seconds: 3, ptt: false } }
          : { conversation: content.text };
      return { key: { remoteJid: j, fromMe: true, id }, message, messageTimestamp: 1_700_000_000 };
    },
  };
  const file = outboxFile('foto.jpg');
  const r = await c.sendMedia(jid, file, 'bak şuna');
  assert.equal(r.remoteId, 'SENT1');
  assert.equal(calls[0].jid, jid);
  assert.deepEqual(calls[0].content.image, { url: file.path });
  const m = store.getMessage(`${account.id}/${jid}#SENT1`)!;
  assert.ok(m, 'gönderilen mesaj depoda');
  assert.equal(m.fromMe, true);
  assert.equal(m.status, 'sent');
  assert.equal(m.text, 'bak şuna');
  assert.equal(m.attachments?.[0].kind, 'image');
  assert.ok(m.attachments?.[0].url?.includes(encodeURIComponent(`wa:${jid}/SENT1`)), 'medya vekili wa:<jid>/<id>');
  // rememberMedia: protokol nesnesi diske yazıldı (fetchMedia sonra indirir)
  assert.ok(fs.existsSync(path.join(sessionDir(account.id), 'media-index', `${jid}__SENT1.json`)));

  // ses: altyazı olmadığından ayrı metin mesajı gider
  await c.sendMedia(jid, outboxFile('ses.m4a'), 'dinle');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].content.ptt, false);
  assert.equal(calls[1].content.mimetype, 'audio/mp4');
  assert.deepEqual(calls[2].content, { text: 'dinle' });
  assert.equal(store.getMessage(`${account.id}/${jid}#SENT2`)?.attachments?.[0].kind, 'audio');
  assert.equal(store.getMessage(`${account.id}/${jid}#SENT3`)?.text, 'dinle');

  // bağlı değilken hata
  (c as unknown as { sock: unknown }).sock = undefined;
  await assert.rejects(() => c.sendMedia(jid, file), /bağlı değil/);
  await c.stop();
});

// ---------------- Telegram ----------------

test('Telegram tgSendFileParams: voice → voiceNote (sesli mesaj balonu)', () => {
  assert.deepEqual(tg.tgSendFileParams({ path: '/x/s.ogg', name: 's.ogg', mime: 'audio/ogg', voice: true }), { file: '/x/s.ogg', caption: undefined, forceDocument: false, voiceNote: true });
  assert.equal('voiceNote' in tg.tgSendFileParams({ path: '/x/s.m4a', name: 's.m4a', mime: 'audio/mp4' }), false);
});

test('Telegram tgSendFileParams: görsel/video/ses doğal, diğerleri forceDocument; boş altyazı verilmez', () => {
  assert.deepEqual(tg.tgSendFileParams({ path: '/x/a.jpg', name: 'a.jpg', mime: 'image/jpeg' }, 'c'), { file: '/x/a.jpg', caption: 'c', forceDocument: false });
  assert.equal(tg.tgSendFileParams({ path: '/x/a.mp4', name: 'a.mp4', mime: 'video/mp4' }).forceDocument, false);
  assert.equal(tg.tgSendFileParams({ path: '/x/a.mp3', name: 'a.mp3', mime: 'audio/mpeg' }).forceDocument, false);
  assert.equal(tg.tgSendFileParams({ path: '/x/a.pdf', name: 'a.pdf', mime: 'application/pdf' }).forceDocument, true);
  assert.equal(tg.tgSendFileParams({ path: '/x/a.gif', name: 'a.gif', mime: 'image/gif' }).forceDocument, true);
  assert.equal(tg.tgSendFileParams({ path: '/x/a.jpg', name: 'a.jpg', mime: 'image/jpeg' }, '').caption, undefined);
});

test('Telegram sendMedia: client.sendFile hedefi bilinen varlık; dönen mesaj ingest ile tg:<sohbet>/<id> ekine dönüşür', async () => {
  const { store, account } = setup('telegram');
  const c = new tg.TelegramConnector(account, store);
  const rid = '4242';
  const entity = new Api.User({ id: bigInt(4242), firstName: 'Ayşe' });
  (c as unknown as { entities: Map<string, unknown> }).entities.set(rid, entity);
  store.upsertChat({ id: `${account.id}/${rid}`, accountId: account.id, platform: 'telegram', remoteId: rid, name: 'Ayşe', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  const calls: Array<{ entity: unknown; params: Record<string, unknown> }> = [];
  (c as unknown as { client: unknown }).client = {
    sendFile: async (e: unknown, params: Record<string, unknown>) => {
      calls.push({ entity: e, params });
      const doc = new Api.Document({
        id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.from('r'), date: 1_700_000_000, mimeType: 'application/pdf', size: bigInt(10), dcId: 1,
        attributes: [new Api.DocumentAttributeFilename({ fileName: 'rapor.pdf' })],
      });
      return new Api.Message({ id: 99, out: true, peerId: new Api.PeerUser({ userId: bigInt(4242) }), date: 1_700_000_000, message: String(params.caption ?? ''), media: new Api.MessageMediaDocument({ document: doc }) });
    },
  };
  const file = outboxFile('rapor.pdf');
  const r = await c.sendMedia(rid, file, 'rapor ekte');
  assert.equal(r.remoteId, '99');
  assert.equal(calls[0].entity, entity, 'entityOf: önbellekteki varlık kullanılır (getInputEntity çağrılmaz)');
  assert.deepEqual(calls[0].params, { file: file.path, caption: 'rapor ekte', forceDocument: true });
  const m = store.getMessage(`${account.id}/${rid}#99`)!;
  assert.equal(m.fromMe, true);
  assert.equal(m.text, 'rapor ekte');
  assert.equal(m.senderName, 'Ben');
  assert.equal(m.attachments?.[0].kind, 'file');
  assert.equal(m.attachments?.[0].name, 'rapor.pdf');
  assert.ok(m.attachments?.[0].link?.includes(encodeURIComponent(`tg:${rid}/99`)));
});

// ---------------- iMessage ----------------

test('iMessage imessageScripts: metin ve POSIX dosya; chat id / participant hedefi; SMS hizmeti; tırnak kaçışı', () => {
  const t = im.imessageScripts('any;-;+905321234567', { text: 'de "selam" \\ yaz' }, 'iMessage');
  assert.ok(t.byChat.includes('send "de \\"selam\\" \\\\ yaz" to chat id "any;-;+905321234567"'));
  assert.ok(t.byBuddy.includes('service type = iMessage'));
  assert.ok(t.byBuddy.includes('participant "+905321234567" of svc'));
  const f = im.imessageScripts('SMS;-;+905321234567', { file: '/tmp/a "b".jpg' }, 'SMS');
  assert.ok(f.byChat.includes('send POSIX file "/tmp/a \\"b\\".jpg" to chat id "SMS;-;+905321234567"'));
  assert.ok(f.byBuddy.includes('service type = SMS'));
  assert.ok(f.byBuddy.includes('send POSIX file "/tmp/a \\"b\\".jpg" to tgt'));
  const g = im.imessageScripts('iMessage;+;chat123', { file: '/tmp/x.pdf' }, 'iMessage');
  assert.ok(g.byBuddy.includes('participant "chat123"'));
});

test('iMessage sendMedia: dosya oturum klasörüne kopyalanır, yerel ek kaydı metinsiz (kopya temizliği için), altyazı ayrı metin; im-out vekili', async () => {
  const { store, account } = setup('imessage');
  const c = new im.IMessageConnector(account, store);
  const delivered: Array<{ chat: string; payload: Record<string, string> }> = [];
  (c as unknown as { deliver: unknown }).deliver = async (chat: string, payload: Record<string, string>) => {
    delivered.push({ chat, payload });
  };
  const guid = 'any;-;+905321234567';
  const file = outboxFile('foto.jpg', 'JPEGDATA');
  const r = await c.sendMedia(guid, file, 'bak');
  assert.ok(r.remoteId.startsWith('local-'));
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].chat, guid);
  const sentPath = delivered[0].payload.file;
  assert.ok(sentPath.startsWith(path.join(sessionDir(account.id), 'media')), 'gönderilen yol oturum klasöründeki kopya');
  assert.equal(fs.readFileSync(sentPath, 'utf8'), 'JPEGDATA');
  assert.deepEqual(delivered[1].payload, { text: 'bak' });
  const msgs = store.listMessages(`${account.id}/${guid}`, 10);
  assert.equal(msgs.length, 2);
  const media = msgs.find((m) => m.attachments)!;
  assert.equal(media.text, '', 'ek satırının chat.db metni boş olacağından yerel kayıt da boş');
  assert.equal(media.attachments?.[0].kind, 'image');
  assert.ok(media.attachments?.[0].url?.includes(encodeURIComponent('im-out:')));
  assert.equal(msgs.find((m) => !m.attachments)?.text, 'bak');
  // vekil: im-out:<ad>
  const u = decodeURIComponent(media.attachments![0].url!.split('u=')[1]);
  const got = await c.fetchMedia(u);
  assert.equal(got?.body.toString(), 'JPEGDATA');
  assert.equal(got?.type, 'image/jpeg');
  await assert.rejects(() => c.fetchMedia('im-out:../../yok'), /kopyası yok/);
  // yoklama gerçek eki guid ile getirince yerel kayıt düşer (metin boş ↔ boş)
  (c as unknown as { ingest(r: Record<string, unknown>, live: boolean): void }).ingest(
    { rowid: 5, guid: 'REAL-1', text: '￼', attributedBody: null, date: (Date.now() - 978_307_200_000) * 1e6, is_from_me: 1, handle: null, chat_identifier: '+905321234567', chat_guid: guid, display_name: null, cache_has_attachments: 1, item_type: 0, is_filtered: 0, date_retracted: null, associated_message_type: 0 },
    false,
  );
  const after = store.listMessages(`${account.id}/${guid}`, 10);
  assert.ok(!after.some((m) => m.remoteId === media.remoteId), 'yerel ek kaydı temizlendi');
  await c.stop();
});

// ---------------- E-posta (IMAP/SMTP) ----------------

test('Mail olderPage: en büyük N UID (silinmiş boşluklar sayfayı küçültmez)', () => {
  assert.deepEqual(mail.olderPage([5, 1, 9, 3, 7], 3), [5, 7, 9]);
  assert.deepEqual(mail.olderPage([], 3), []);
  assert.deepEqual(mail.olderPage([2], 3), [2]);
});

function rawMail(uid: number, from = 'ali@example.com', subject = `Konu ${uid}`, extra = ''): Buffer {
  return Buffer.from(
    `From: Ali <${from}>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nMessage-ID: <m${uid}@example.com>\r\nDate: ${new Date(1_700_000_000_000 + uid * 3_600_000).toUTCString()}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\nmerhaba ${uid}\r\n`,
  );
}

test('Mail loadMoreChats: en küçük UID’den geriye 100’lük sayfa; thread=sohbet; kalmayınca 0', async () => {
  const { store, account } = setup('imap');
  const c = new mail.MailConnector(account, store, { user: 'me@example.com', pass: 'p', host: 'imap.example.com', port: 993, smtpHost: 'smtp.example.com', smtpPort: 465 });
  const searches: Array<Record<string, unknown>> = [];
  const all = Array.from({ length: 230 }, (_, i) => i + 1); // kutuda 1..230
  const fake = {
    search: async (q: Record<string, unknown>) => {
      searches.push(q);
      if (q.since) return all.slice(-150); // ilk eşitleme: son 150 (81..230)
      const m = /^(\d+):(\d+|\*)$/.exec(String(q.uid));
      const lo = Number(m![1]);
      const hi = m![2] === '*' ? Infinity : Number(m![2]);
      return all.filter((u) => u >= lo && u <= hi);
    },
    async *fetch(uids: number[]) {
      for (const uid of uids) yield { uid, source: rawMail(uid), flags: new Set<string>() };
    },
  };
  (c as unknown as { withInbox: unknown }).withInbox = async (fn: (client: unknown) => Promise<unknown>) => fn(fake);
  // ilk eşitleme
  await (c as unknown as { poll(first: boolean): Promise<void> }).poll(true);
  const priv = c as unknown as { lastUid: number; oldestUid: number };
  assert.equal(priv.lastUid, 230);
  assert.equal(priv.oldestUid, 81);
  assert.equal(store.listChatsOf(account.id).length, 150);
  // sonraki sayfa: 80'den geriye 100 → 1..80 aralığından en büyük 100 = hepsi (80)
  const added = await c.loadMoreChats();
  assert.equal(added, 80);
  assert.equal(priv.oldestUid, 1);
  assert.equal(store.listChatsOf(account.id).length, 230);
  assert.ok(searches.some((q) => q.uid === '1:80'), 'eski aralık en küçük UID’den geriye sorgulanır');
  assert.equal(await c.loadMoreChats(), 0, 'kutunun başı: daha yok');
  // durum dosyasına yazıldı
  const st = JSON.parse(fs.readFileSync(path.join(sessionDir(account.id), 'mail-state.json'), 'utf8'));
  assert.equal(st.oldestUid, 1);
  assert.equal(st.lastUid, 230);
});

test('Mail loadMoreChats: eski durum dosyası (oldestUid yok) → ilk pencere yeniden hesaplanır; aynı thread yeni sohbet sayılmaz', async () => {
  const { store, account } = setup('imap');
  fs.mkdirSync(sessionDir(account.id), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(account.id), 'mail-state.json'), JSON.stringify({ lastUid: 300, threads: {} }));
  const c = new mail.MailConnector(account, store, { user: 'me@example.com', pass: 'p', host: 'h', smtpHost: 's' });
  const all = Array.from({ length: 300 }, (_, i) => i + 1);
  const fake = {
    search: async (q: Record<string, unknown>) => {
      if (q.since) return all.slice(-20); // 281..300
      const m = /^(\d+):(\d+)$/.exec(String(q.uid))!;
      return all.filter((u) => u >= Number(m[1]) && u <= Number(m[2]));
    },
    async *fetch(uids: number[]) {
      // 5 e-posta aynı thread'de (References ile), gerisi ayrı
      for (const uid of uids) yield { uid, source: uid > 275 ? rawMail(uid, 'ali@example.com', 'Ortak', 'References: <root@example.com>\r\n') : rawMail(uid), flags: new Set<string>() };
    },
  };
  (c as unknown as { withInbox: unknown }).withInbox = async (fn: (client: unknown) => Promise<unknown>) => fn(fake);
  const added = await c.loadMoreChats();
  // 181..280 → 100 e-posta; 276..280 tek thread → 96 sohbet
  assert.equal(added, 96);
  assert.equal((c as unknown as { oldestUid: number }).oldestUid, 181);
  assert.equal(await c.loadMoreChats(), 100);
  assert.equal(await c.loadMoreChats(), 80);
  assert.equal(await c.loadMoreChats(), 0);
});

test('Mail sendMedia: alıcı/konu/In-Reply-To sendText ile aynı, nodemailer attachments [{filename,path,contentType}], ek mail: vekilinden görünür', async () => {
  const { store, account } = setup('imap');
  const c = new mail.MailConnector(account, store, { user: 'me@example.com', pass: 'p', host: 'h', smtpHost: 's' });
  const rid = 'msg:<root@example.com>';
  const cid = `${account.id}/${rid}`;
  store.upsertChat({ id: cid, accountId: account.id, platform: 'imap', remoteId: rid, name: 'Fatura', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [], participants: [{ id: 'ali@example.com', name: 'Ali' }, { id: 'me@example.com', name: 'Ben' }] });
  store.upsertMessage({ id: `${cid}#<in@example.com>`, chatId: cid, remoteId: '<in@example.com>', senderId: 'ali@example.com', senderName: 'Ali', fromMe: false, text: 'fatura?', ts: 1000, status: 'delivered' });
  const sent: Array<Record<string, unknown>> = [];
  (c as unknown as { createTransport: unknown }).createTransport = () => ({
    sendMail: async (o: Record<string, unknown>) => {
      sent.push(o);
      return { messageId: '<out1@example.com>' };
    },
  });
  const file = outboxFile('fatura.pdf', '%PDF');
  const r = await c.sendMedia(rid, file, 'ekte');
  assert.equal(r.remoteId, '<out1@example.com>');
  assert.deepEqual(sent[0].to, ['ali@example.com']);
  assert.equal(sent[0].subject, 'Re: Fatura');
  assert.equal(sent[0].inReplyTo, '<in@example.com>');
  assert.equal(sent[0].text, 'ekte');
  assert.deepEqual(sent[0].attachments, [{ filename: 'fatura.pdf', path: file.path, contentType: 'application/pdf' }]);
  const m = store.getMessage(`${cid}#<out1@example.com>`)!;
  assert.equal(m.text, 'ekte');
  assert.equal(m.attachments?.[0].kind, 'file');
  assert.equal(m.attachments?.[0].name, 'fatura.pdf');
  const u = decodeURIComponent(m.attachments![0].link!.split('u=')[1]);
  const got = await c.fetchMedia(u);
  assert.equal(got?.body.toString(), '%PDF');
  assert.equal(got?.type, 'application/pdf');
  // sendText hâlâ aynı yoldan (ek yok)
  await c.sendText(rid, 'teşekkürler');
  assert.equal(sent[1].attachments, undefined);
  assert.equal(sent[1].inReplyTo, '<in@example.com>');
  await assert.rejects(() => c.sendMedia('yok', file), /Sohbet yok/);
});

test('Mail IMAP IDLE: yeni e-posta bildirimi (exists) 1 sn içinde yoklatır; açıkken yoklama yedeğe iner, kopunca yeniden bağlanır', async () => {
  const { EventEmitter } = await import('node:events');
  const { store, account } = setup('imap');
  const c = new mail.MailConnector(account, store, { user: 'me@example.com', pass: 'p', host: 'h', smtpHost: 's' });
  let box = [1, 2];
  const fake = {
    search: async (q: Record<string, unknown>) => {
      if (q.since) return box;
      const lo = Number(/^(\d+):/.exec(String(q.uid))![1]);
      return box.filter((u) => u >= lo);
    },
    async *fetch(uids: number[]) {
      for (const uid of uids) yield { uid, source: rawMail(uid), flags: new Set<string>() };
    },
  };
  const priv = c as unknown as { withInbox: unknown; pollFolders: unknown; createIdleClient: unknown; idleUp: boolean; lastUid: number; timer?: NodeJS.Timeout; idleRetry?: NodeJS.Timeout };
  priv.withInbox = async (fn: (client: unknown) => Promise<unknown>) => fn(fake);
  priv.pollFolders = async () => undefined;
  const clients: Array<InstanceType<typeof EventEmitter> & { opened?: string }> = [];
  priv.createIdleClient = () => {
    const e = Object.assign(new EventEmitter(), {
      connect: async () => undefined,
      mailboxOpen: async (p: string) => void ((e as { opened?: string }).opened = p),
      logout: async () => undefined,
      close: () => undefined,
    });
    clients.push(e);
    return e;
  };
  await c.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clients.length, 1);
  assert.equal(clients[0].opened, 'INBOX');
  assert.equal(priv.idleUp, true);
  assert.equal(priv.lastUid, 2);
  // yeni e-posta
  box = [1, 2, 3];
  clients[0].emit('exists', { path: 'INBOX', count: 3, prevCount: 2 });
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(priv.lastUid, 3, 'bildirimden sonra yeni UID çekildi');
  // kopma → idleUp düşer, yeniden bağlanma planlanır
  clients[0].emit('close');
  assert.equal(priv.idleUp, false);
  assert.ok(priv.idleRetry, 'yeniden bağlanma planlandı');
  await c.stop();
});
