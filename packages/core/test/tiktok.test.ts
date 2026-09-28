import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTime, rowIds, toMessages, toThreads, type RawItem } from '../src/connectors/browser/tiktok.js';

const NOW = new Date(2026, 8, 28, 15, 0); // 28 Eylül 2026 Pazartesi 15:00

test('TikTok liste zamanı: saat, dün, gün adı, göreli, gün.ay; okunamazsa 0', () => {
  assert.equal(listTime('14:32', NOW), new Date(2026, 8, 28, 14, 32).getTime());
  assert.equal(listTime('Dün', NOW), new Date(2026, 8, 27, 12, 0).getTime());
  assert.equal(listTime('Yesterday', NOW), new Date(2026, 8, 27, 12, 0).getTime());
  assert.equal(listTime('Cum', NOW), new Date(2026, 8, 25, 12, 0).getTime(), 'geçen cuma');
  assert.equal(listTime('3 g', NOW), NOW.getTime() - 3 * 86_400_000);
  assert.equal(listTime('2h', NOW), NOW.getTime() - 2 * 3_600_000);
  assert.equal(listTime('12.10', NOW), new Date(2025, 9, 12, 12).getTime(), 'gelecekte kalan gün.ay geçen yıl');
  assert.equal(listTime('05.09.2026', NOW), new Date(2026, 8, 5, 12).getTime());
  assert.equal(listTime('', NOW), 0);
  assert.equal(listTime('çevrimiçi', NOW), 0);
});

test('TikTok sohbet kimliği addan; aynı adlı ikinci sohbet ayrı kimlik; önizleme değişince "şimdi"', () => {
  const ids = rowIds([{ name: 'Ayşe' }, { name: 'Mert' }, { name: 'ayşe' }]);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(rowIds([{ name: 'Mert' }]), [ids[1]], 'aynı ad her turda aynı kimlik');
  const now = NOW.getTime();
  let t = toThreads([{ name: 'Zeynep', preview: 'selam', time: '14:32', unread: 0 }], now);
  assert.equal(t[0].lastTs, new Date(2026, 8, 28, 14, 32).getTime(), 'ilk görüşte listedeki zaman');
  t = toThreads([{ name: 'Zeynep', preview: 'selam', time: '14:32', unread: 0 }], now + 60_000);
  assert.equal(t[0].lastTs, new Date(2026, 8, 28, 14, 32).getTime(), 'önizleme aynı: zaman değişmez');
  t = toThreads([{ name: 'Zeynep', preview: 'yarın görüşelim', time: '14:59', unread: 2 }], now + 120_000);
  assert.equal(t[0].lastTs, now + 120_000, 'önizleme değişti: yeni etkinlik');
  assert.equal(t[0].unread, 2);
  assert.equal(t[0].kind, 'direct');
});

test('TikTok mesajları: ayırıcı zamanı taban; "Bugün" ertesi gün "Dün" olsa da kimlik aynı; ben/karşı taraf; video kartı', () => {
  const items = (sepToday: string): RawItem[] => [
    { sep: sepToday },
    { text: 'Merhaba', me: false, avatar: 'https://p16.tiktokcdn.com/a.jpeg' },
    { text: 'Selam!', me: true },
    { text: '', me: false, attachments: [{ kind: 'other', name: 'TikTok videosu', link: 'https://www.tiktok.com/@a/video/1', url: 'https://p16.tiktokcdn.com/c.jpeg' }] },
    { text: 'Selam!', me: true },
  ];
  const day1 = new Date(2026, 8, 28, 16, 0);
  const a = toMessages('t1', 'Ayşe', items('Bugün 14:32'), day1);
  const day2 = new Date(2026, 8, 29, 9, 0);
  const b = toMessages('t1', 'Ayşe', items('Dün 14:32'), day2);
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id), 'kimlikler günler arasında kararlı');
  assert.equal(a.length, 4);
  assert.equal(new Set(a.map((m) => m.id)).size, 4, 'aynı metnin tekrarı ayrı kimlik');
  assert.equal(a[0].ts, new Date(2026, 8, 28, 14, 32).getTime() + 1);
  assert.ok(a[1].ts > a[0].ts && a[3].ts > a[2].ts, 'sıra korunur');
  assert.equal(a[0].senderName, 'Ayşe');
  assert.equal(a[0].senderAvatarUrl, 'https://p16.tiktokcdn.com/a.jpeg');
  assert.equal(a[1].fromMe, true);
  assert.equal(a[1].status, 'sent');
  assert.equal(a[2].attachments?.[0].name, 'TikTok videosu');
});
