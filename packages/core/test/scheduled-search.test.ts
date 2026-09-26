import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-sched-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { ScheduledQueue, LATE_MS } = await import('../src/scheduled.js');
const { Store } = await import('../src/store.js');

test('zamanlanmış gönderim: zamanı gelen gider, kalıcı; geç kalan gönderilmez; geçici hata yeniden, kalıcı hata kaçırıldı', async () => {
  const file = path.join(tmp, 'scheduled.json');
  const q = new ScheduledQueue(file);
  const now = 1_800_000_000_000;
  const due = q.add('a/1', 'şimdi', now - 1000);
  const future = q.add('a/1', 'sonra', now + 3_600_000);
  const late = q.add('a/2', 'geç', now - LATE_MS - 60_000);
  const flaky = q.add('a/3', 'ağ', now - 500);
  const blocked = q.add('a/4', 'sınır', now - 400);
  // dosyadan yeniden okunur (çekirdek yeniden başlasa da kaybolmaz)
  assert.equal(new ScheduledQueue(file).list().length, 5);

  const sentIds: string[] = [];
  const r = await q.flush(async (s) => {
    if (s.id === flaky.id) throw Object.assign(new Error('bağlantı yok'), { status: 409 });
    if (s.id === blocked.id) throw Object.assign(new Error('günlük sınır'), { status: 429 });
    sentIds.push(s.id);
  }, now);
  assert.deepEqual(sentIds, [due.id]);
  assert.deepEqual(r.missed.map((m) => m.id).sort(), [late.id, blocked.id].sort());
  const left = q.list();
  assert.ok(!left.some((s) => s.id === due.id), 'gönderilen listeden çıkar');
  assert.ok(left.some((s) => s.id === future.id && !s.missed));
  const f = left.find((s) => s.id === flaky.id)!;
  assert.equal(f.tries, 1);
  assert.equal(f.at, now + 60_000, 'geçici hata: 1 dk sonra yeniden');
  // 3. hatada kaçırıldı sayılır (yeniden denemedeki gecikme "geç kaldı" sayılmaz)
  await q.flush(async () => Promise.reject(new Error('yok')), now + 60_000);
  const r3 = await q.flush(async () => Promise.reject(new Error('yok')), now + 30 * 60_000);
  assert.deepEqual(r3.missed.map((m) => m.id), [flaky.id]);
  // iptal
  assert.equal(q.remove(future.id), true);
  // kaçırılanlar 7 gün sonra temizlenir
  await q.flush(async () => undefined, now + 8 * 86_400_000);
  assert.equal(q.list().length, 0);
});

test('arama: ek (dosya) adlarında da bulur, sonuçlar yeniden eskiye', () => {
  const store = new Store(path.join(tmp, 's.db'));
  store.upsertAccount({ id: 'demo:1', platform: 'demo', label: 'd', status: 'connected', createdAt: 1 });
  store.upsertChat({ id: 'demo:1/c', accountId: 'demo:1', platform: 'demo', remoteId: 'c', name: 'C', kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  store.upsertMessage({ id: 'demo:1/c#1', chatId: 'demo:1/c', remoteId: '1', senderId: 'u', senderName: 'U', fromMe: false, text: 'faturayı ekledim', ts: 1000, status: 'delivered' });
  store.upsertMessage({ id: 'demo:1/c#2', chatId: 'demo:1/c', remoteId: '2', senderId: 'u', senderName: 'U', fromMe: false, text: '', ts: 2000, status: 'delivered', attachments: [{ kind: 'file', name: 'Fatura-1042.pdf', mime: 'application/pdf' }] });
  store.upsertMessage({ id: 'demo:1/c#3', chatId: 'demo:1/c', remoteId: '3', senderId: 'u', senderName: 'U', fromMe: false, text: 'ilgisiz', ts: 3000, status: 'delivered', attachments: [{ kind: 'image', name: 'foto.jpg', mime: 'image/jpeg' }] });
  const hits = store.search('fatura');
  assert.deepEqual(hits.map((h) => h.message.remoteId), ['2', '1']);
  assert.equal(store.search('fatura', 1).length, 1, 'sınır uygulanır');
});

test('takvim: etkinlik kaydet/güncelle/sil, aralıkla listele; hatırlatma bir kez ve yalnız zamanında', () => {
  const store = new Store(path.join(tmp, 'e.db'));
  const base = { title: 'Görüşme', durationMin: 30, createdAt: 1 };
  store.saveEvent({ ...base, id: 'e1', start: '2026-10-02T14:00', remindMin: 10 });
  store.saveEvent({ ...base, id: 'e2', title: 'KDV', start: '2026-10-05', allDay: true });
  store.saveEvent({ ...base, id: 'e3', title: 'Eski', start: '2026-09-01T09:00', remindMin: 5 });
  assert.deepEqual(store.listEvents('2026-10-01', '2026-10-03').map((e) => e.id), ['e1']);
  assert.equal(store.listEvents().length, 3);
  // hatırlatma: 13:49'da yok, 13:50'de bir kez; geçmişte kalan (çekirdek kapalıydı) etkinlik geç bildirilmez
  assert.deepEqual(store.dueEventReminders(new Date(2026, 9, 2, 13, 49)).map((e) => e.id), []);
  assert.deepEqual(store.dueEventReminders(new Date(2026, 9, 2, 13, 50)).map((e) => e.id), ['e1']);
  assert.deepEqual(store.dueEventReminders(new Date(2026, 9, 2, 13, 55)).map((e) => e.id), [], 'tekrar bildirilmez');
  // saat değişince hatırlatma yeniden kurulur
  store.saveEvent({ ...base, id: 'e1', start: '2026-10-02T16:00', remindMin: 10 });
  assert.deepEqual(store.dueEventReminders(new Date(2026, 9, 2, 15, 50)).map((e) => e.id), ['e1']);
  assert.equal(store.getEvent('e1')?.start, '2026-10-02T16:00');
  assert.equal(store.deleteEvent('e2'), true);
  assert.equal(store.getEvent('e2'), undefined);
});
