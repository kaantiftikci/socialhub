import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-follow-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { analyzeStyle, describeStyle } = await import('../src/style.js');
const { buildIcs, parseStart } = await import('../src/calendar.js');

function seed(store: InstanceType<typeof Store>, remoteId: string, platform: 'demo' = 'demo') {
  store.upsertChat({ id: `demo:1/${remoteId}`, accountId: 'demo:1', platform, remoteId, name: remoteId, kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
}

test('takip hatırlatıcısı: süresi dolunca bir kez due, karşı taraf yazınca kendiliğinden kapanır', () => {
  const store = new Store(path.join(tmp, 'f.db'));
  store.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  seed(store, 'a');
  seed(store, 'b');
  const now = Date.now();
  let c = store.setFollowUp('demo:1/a', now + 2 * 86_400_000)!;
  assert.equal(c.followUp?.at, now + 2 * 86_400_000);
  store.setFollowUp('demo:1/b', now + 1000);

  let r = store.checkFollowUps(now);
  assert.equal(r.due.length + r.resolved.length, 0, 'süre dolmadan hiçbir şey olmaz');

  r = store.checkFollowUps(now + 5000);
  assert.deepEqual(r.due.map((x) => x.id), ['demo:1/b']);
  assert.equal(store.getChat('demo:1/b')?.followUp?.due, true);
  r = store.checkFollowUps(now + 6000);
  assert.equal(r.due.length, 0, 'bildirim bir kez');

  // benim mesajım hatırlatmayı kapatmaz, karşı tarafın mesajı kapatır
  store.upsertMessage({ id: 'demo:1/a#m1', chatId: 'demo:1/a', remoteId: 'm1', senderId: 'me', senderName: 'Ben', fromMe: true, text: 'dönüş bekliyorum', ts: Date.now() + 10, status: 'sent' });
  assert.equal(store.checkFollowUps(now + 7000).resolved.length, 0);
  store.upsertMessage({ id: 'demo:1/a#m2', chatId: 'demo:1/a', remoteId: 'm2', senderId: 'u', senderName: 'Ali', fromMe: false, text: 'tamam', ts: Date.now() + 20, status: 'delivered' });
  r = store.checkFollowUps(now + 8000);
  assert.deepEqual(r.resolved.map((x) => x.id), ['demo:1/a']);
  assert.equal(store.getChat('demo:1/a')?.followUp, undefined);

  c = store.setFollowUp('demo:1/b', null)!;
  assert.equal(c.followUp, undefined);
  // platform yoklaması sohbeti yeniden yazınca hatırlatma silinmez
  store.setFollowUp('demo:1/b', now + 1000);
  seed(store, 'b');
  assert.ok(store.getChat('demo:1/b')?.followUp);
  store.close();
});

test('üslup örnekleri: gelen → benim yanıtım çiftleri, önce aynı sohbet', () => {
  const store = new Store(path.join(tmp, 's.db'));
  store.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  seed(store, 'x');
  seed(store, 'y');
  const t = Date.now() - 10_000;
  const msg = (chat: string, id: string, fromMe: boolean, text: string, ts: number) =>
    store.upsertMessage({ id: `demo:1/${chat}#${id}`, chatId: `demo:1/${chat}`, remoteId: id, senderId: fromMe ? 'me' : 'u', senderName: fromMe ? 'Ben' : 'Ali', fromMe, text, ts, status: 'sent' });
  msg('y', '1', false, 'naber', t);
  msg('y', '2', true, 'iyidir sen', t + 1);
  msg('x', '1', false, 'kargo ne zaman?', t + 2);
  msg('x', '2', true, 'yarın çıkıyor 📦', t + 3);
  msg('x', '3', true, 'takip no atarım', t + 4); // önceki de benim: çift değil
  const pairs = store.styleSamples('demo:1/x', 'demo');
  assert.deepEqual(pairs[0], { them: 'kargo ne zaman?', me: 'yarın çıkıyor 📦', scope: 'chat' });
  assert.ok(pairs.some((p) => p.me === 'iyidir sen'), 'diğer sohbetlerden de örnek');
  assert.ok(!pairs.some((p) => p.me === 'takip no atarım'));
  assert.equal(new Set(pairs.map((p) => p.me)).size, pairs.length, 'tekrar yok');
  assert.ok(store.myTexts('demo').includes('takip no atarım'));
  store.close();
});

test('üslup profili: kısa, samimi, emojili, küçük harfli yazarı tanır', () => {
  const casual = ['selam naber 😄', 'tamam kanka', 'yarın gelirsin di mi 😄', 'olur 👍', 'sen bilirsin', 'süper 😄', 'geliyorum'];
  const p = analyzeStyle(casual);
  assert.equal(p.samples, 7);
  assert.equal(p.address, 'sen');
  assert.ok(p.emojiRate > 0.25);
  assert.equal(p.topEmojis[0], '😄');
  const d = describeStyle(p);
  assert.ok(d.includes('çok kısa yazar'));
  assert.ok(d.some((l) => l.startsWith('sık emoji')));
  assert.ok(d.includes('cümleye küçük harfle başlar'));

  const formal = [
    'Merhaba, siparişiniz yarın kargoya verilecektir. Teşekkürler.',
    'Merhaba, iade talebinizi aldık, en kısa sürede dönüş yapacağız. Teşekkürler.',
    'Merhaba, ürün stokta mevcuttur. İyi çalışmalar.',
    'Bilginize sunarız. Teşekkürler.',
    'Merhaba, fatura bilgilerinizi iletebilir misiniz? Teşekkürler.',
  ];
  const f = analyzeStyle(formal);
  assert.equal(f.address, 'siz');
  assert.equal(f.emojiRate, 0);
  assert.deepEqual(f.greetings, ['Merhaba']);
  assert.equal(f.signoffs[0], 'Teşekkürler');
  assert.ok(describeStyle(f).includes('emoji kullanmaz'));
  assert.deepEqual(describeStyle(analyzeStyle(['tamam'])), [], 'az örnekle profil yok');
});

test('takvim: .ics tarihli ve tüm gün etkinlik, kaçış ve katlama', () => {
  assert.equal(parseStart('2026-02-30T10:00'), null, 'olmayan gün');
  assert.equal(parseStart('yarın'), null);
  const ics = buildIcs({ title: 'Toplantı; Ayşe, kargo', start: '2026-10-02T14:30', durationMin: 45, notes: 'satır1\nsatır2' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261002T143000\r\n/);
  assert.match(ics, /DTEND:20261002T151500\r\n/);
  assert.match(ics, /SUMMARY:Toplantı\\; Ayşe\\, kargo\r\n/);
  assert.match(ics, /DESCRIPTION:satır1\\nsatır2\r\n/);
  const allDay = buildIcs({ title: 'Teslim', start: '2026-12-31' });
  assert.match(allDay, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
  const long = buildIcs({ title: 'ş'.repeat(120), start: '2026-10-02' });
  for (const line of long.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'satır 75 sekizliği aşmaz');
  assert.throws(() => buildIcs({ title: 'x', start: 'bozuk' }));
});
