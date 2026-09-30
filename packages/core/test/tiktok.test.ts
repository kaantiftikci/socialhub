import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTime, resetTikTokState, rowIds, sepTime, toMessages, toThreads, type RawItem } from '../src/connectors/browser/tiktok.js';

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

test('TikTok liste zamanı: ay/gün ↔ gün/ay, ay adlı tarih, ISO, geçersiz tarih, gelecek şimdiye çekilir', () => {
  const noon = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime();
  assert.equal(listTime('3/27/2025', NOW), noon(2025, 2, 27), '12\'den büyük olan gün');
  assert.equal(listTime('12/27/2024', NOW), noon(2024, 11, 27));
  assert.equal(listTime('5/3/2025', NOW, true), noon(2025, 4, 3), 'İngilizce sayfa: ay/gün');
  assert.equal(listTime('5/3/2025', NOW, false), noon(2025, 2, 5), 'Türkçe sayfa: gün/ay');
  assert.equal(listTime('Sep 12', NOW), noon(2026, 8, 12));
  assert.equal(listTime('12 Eyl', NOW), noon(2026, 8, 12));
  assert.equal(listTime('12 Eylül 2025', NOW), noon(2025, 8, 12));
  assert.equal(listTime('Oct 3', NOW), noon(2025, 9, 3), 'yılsız ve gelecekte kalan ay adlı tarih geçen yıl');
  assert.equal(listTime('2026-9-12', NOW), noon(2026, 8, 12));
  assert.equal(listTime('13/13/2025', NOW), 0);
  assert.equal(listTime('31.02.2026', NOW), 0);
  assert.equal(listTime('3/27/2027', NOW), NOW.getTime(), 'gelecek yıl → şimdi');
  assert.equal(listTime('3s', NOW), NOW.getTime() - 3000);
  assert.equal(listTime('2 days ago', NOW), NOW.getTime() - 2 * 86_400_000);
  assert.equal(listTime('5 dk önce', NOW), NOW.getTime() - 5 * 60_000);
  assert.equal(listTime('şimdi', NOW), NOW.getTime());
  assert.equal(listTime('3 gün', NOW), NOW.getTime() - 3 * 86_400_000, '"3 gün" ay adı sanılmaz');
});

test('TikTok liste sırası: çakışan/okunamayan zamanlar sayfa sırasını bozmaz; kararlı; sabitlenmiş eski sohbet alttakini ezmez', () => {
  resetTikTokState();
  const now = NOW.getTime();
  const rows = (times: string[], prefix: string) => times.map((time, i) => ({ name: `${prefix}${i}`, preview: `p${i}`, time, unread: 0 }));
  const a = toThreads(rows(['14:32', '', '2 g', '2 g', 'bilinmiyor'], 'S'), now);
  assert.ok(a.every((t, i) => i === 0 || t.lastTs < a[i - 1].lastTs), `kesin azalan: ${a.map((t) => t.lastTs).join(',')}`);
  assert.equal(a[0].lastTs, new Date(2026, 8, 28, 14, 32).getTime());
  assert.equal(a[2].lastTs, now - 2 * 86_400_000);
  assert.ok(a[1].lastTs > a[2].lastTs && a[1].lastTs < a[0].lastTs, 'okunamayan zaman alttakinin hemen üstünde');
  const b = toThreads(rows(['14:32', '', '2 g', '2 g', 'bilinmiyor'], 'S'), now + 3_600_000);
  assert.deepEqual(b.map((t) => t.lastTs), a.map((t) => t.lastTs), 'değişmeyen satırlar sonraki turda aynı zaman (köprü yeniden açmaz)');
  // göreli yuvarlama: alttaki satır üsttekinden biraz yeni görünse de altında kalır
  const c = toThreads(rows(['1 sa', '45 dk'], 'R'), now);
  assert.ok(c[1].lastTs < c[0].lastTs);
  // en üstte sabitlenmiş eski sohbet: alttaki yeni sohbetin zamanı ona çekilmez
  const d = toThreads(rows(['10.08.2026', '14:32'], 'P'), now);
  assert.equal(d[1].lastTs, new Date(2026, 8, 28, 14, 32).getTime());
  // önizleme değişmedi ama kesin saat ilerledi (aynı metinli yeni mesaj) → yeni zaman
  toThreads([{ name: 'V', preview: 'Bir video paylaştı', time: '10:05', unread: 0 }], now);
  const e = toThreads([{ name: 'V', preview: 'Bir video paylaştı', time: '14:40', unread: 0 }], now);
  assert.equal(e[0].lastTs, Math.min(new Date(2026, 8, 28, 14, 40).getTime(), now));
  // eski sohbetin önizlemesi değişti (okundu biçimi vb.): "şimdi"ye sıçramaz
  toThreads([{ name: 'O', preview: 'x', time: '3 g', unread: 0 }], now);
  const o = toThreads([{ name: 'O', preview: 'x (görüldü)', time: '3 g', unread: 0 }], now + 60_000);
  assert.equal(o[0].lastTs, now - 3 * 86_400_000);
  // grup: kolaj → 'group'
  assert.equal(toThreads([{ name: 'Ekip', preview: 'a', time: '14:00', unread: 0, group: true }], now)[0].kind, 'group');
});

test('TikTok grup mesajları: gönderen etiketi ad ve kimlik olur; birebirde sohbet adıyla aynı etiket yok sayılır', () => {
  const g = toMessages('g1', 'Kod Ekibi', [{ text: 'a', sender: 'Mert' }, { text: 'b', sender: 'Zeynep' }, { text: 'c', me: true }], NOW);
  assert.deepEqual(g.map((m) => m.senderName), ['Mert', 'Zeynep', 'Ben']);
  assert.notEqual(g[0].senderId, g[1].senderId);
  const d = toMessages('d1', 'Ayşe', [{ text: 'a', sender: 'Ayşe' }], NOW);
  assert.equal(d[0].senderId, 'd1');
});

test('TikTok ayırıcı zamanı: sayfanın kabul ettiği (TIMEISH) her biçim çözülür; ABD tarihi gelecekte okunmaz', () => {
  const now = new Date(2026, 8, 29, 18, 0); // Salı
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
  const cases: Array<[string, number, boolean?]> = [
    ['14:32', at(2026, 8, 29, 14, 32)],
    ['2:32 PM', at(2026, 8, 29, 14, 32)],
    ['Bugün 14:32', at(2026, 8, 29, 14, 32)],
    ['Today at 3:05 PM', at(2026, 8, 29, 15, 5)],
    ['Dün 14:32', at(2026, 8, 28, 14, 32)],
    ['Yesterday 2:32 PM', at(2026, 8, 28, 14, 32)],
    ['Sal 14:32', at(2026, 8, 22, 14, 32)],
    ['Pazartesi 14:32', at(2026, 8, 28, 14, 32)],
    ['Cumartesi 10:00', at(2026, 8, 26, 10, 0)],
    ['Monday 14:32', at(2026, 8, 28, 14, 32)],
    ['Tue 2:32 PM', at(2026, 8, 22, 14, 32)],
    ['12 Eyl 14:32', at(2026, 8, 12, 14, 32)],
    ['12 Eyl 2026 14:05', at(2026, 8, 12, 14, 5)],
    ['28 Eyl 2026 14:05', at(2026, 8, 28, 14, 5)],
    ['12 Eylül 2026, 14:32', at(2026, 8, 12, 14, 32)],
    ['Sep 12, 2026 2:32 PM', at(2026, 8, 12, 14, 32)],
    ['Sep 12 at 2:32 PM', at(2026, 8, 12, 14, 32)],
    ['9/28/2026 3:05 PM', at(2026, 8, 28, 15, 5), true],
    ['9/12/2026 2:32 PM', at(2026, 8, 12, 14, 32), true],
    ['9/12/2026 2:32 PM', at(2026, 8, 12, 14, 32), false], // Türkçe sayfada gün/ay → Aralık (gelecek) → ay/gün
    ['12.09.2026 14:32', at(2026, 8, 12, 14, 32)],
    ['12.09.2026', new Date(2026, 8, 12, 12).getTime()],
    ['Dün', new Date(2026, 8, 28, 12).getTime()],
    ['2026-09-12', new Date(2026, 8, 12, 12).getTime()],
  ];
  for (const [s, want, mdy] of cases) assert.equal(sepTime(s, now, mdy), want, s);
  assert.equal(sepTime('Bugün 23:00', now), 0, 'gelecek saat yanlış okuma');
  assert.equal(sepTime('31.02.2026 10:00', now), 0);
  assert.equal(sepTime('Yarın', now), 0);
});

test('TikTok mesajları: okunamayan ayırıcı yeni blok — sonrasındaki mesajlar ATILMAZ, sıra korunur', () => {
  const now = new Date(2026, 8, 29, 18);
  const a = toMessages('t', 'n', [{ sep: '9/20/2026 3:05 PM' }, { text: 'old1' }, { sep: '9/27/2026 1:00 PM' }, { text: 'old2' }, { sep: 'Today 3:05 PM' }, { text: 'new' }], now, undefined, true);
  assert.deepEqual(a.map((m) => m.text), ['old1', 'old2', 'new']);
  assert.equal(a[0].ts, new Date(2026, 8, 20, 15, 5).getTime() + 1);
  const b = toMessages('t', 'n', [{ sep: 'Garip biçim' }, { text: 'x1' }, { text: 'x2' }, { sep: 'Dün 14:32' }, { text: 'y' }], now);
  assert.deepEqual(b.map((m) => m.text), ['x1', 'x2', 'y'], 'okunamayan ayırıcının mesajları atılmaz');
  assert.ok(b[0].ts < b[1].ts && b[1].ts < b[2].ts, 'sonraki çözülen ayırıcının hemen öncesi');
  assert.ok(b[1].ts < new Date(2026, 8, 28, 14, 32).getTime());
  const c = toMessages('t', 'n', [{ sep: 'Dün 14:32' }, { text: 'y' }, { sep: '???' }, { text: 'z' }], now);
  assert.deepEqual(c.map((m) => m.text), ['y', 'z']);
  assert.ok(c[1].ts > c[0].ts);
  // kimlik ayırıcının yazısından (kararlı)
  const c2 = toMessages('t', 'n', [{ sep: 'Dün 14:32' }, { text: 'y' }, { sep: '???' }, { text: 'z' }], new Date(2026, 8, 29, 19));
  assert.deepEqual(c2.map((m) => m.id), c.map((m) => m.id));
});

test('TikTok liste sırası: üstte (sabitlenmiş) yeni olmayan sohbetin altındaki sohbete yeni mesaj gelince zamanı İLERLER', () => {
  resetTikTokState();
  const now = new Date(2026, 8, 29, 18, 0).getTime();
  const t1 = toThreads([{ name: 'Pinned', preview: 'a', time: '13:00', unread: 0 }, { name: 'Ali', preview: 'x', time: '17:00', unread: 0 }], now);
  const t2 = toThreads([{ name: 'Pinned', preview: 'a', time: '13:00', unread: 0 }, { name: 'Ali', preview: 'NEW', time: '17:59', unread: 1 }], now + 60_000);
  assert.ok(t2[1].lastTs > t1[1].lastTs, `değişen sohbet yeniden açılmalı: ${t1[1].lastTs} → ${t2[1].lastTs}`);
  const t3 = toThreads([{ name: 'Pinned', preview: 'a', time: '13:00', unread: 0 }, { name: 'Ali', preview: 'NEW', time: '17:59', unread: 1 }], now + 120_000);
  assert.equal(t3[1].lastTs, t2[1].lastTs, 'sonraki turda değişmeden kalır');
});
