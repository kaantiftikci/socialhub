import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-stats-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { computeStats, getStats, extractEmojis, periodOf, REPLY_CAP_MS, clearStatsCache } = await import('../src/stats.js');
type Chat = import('../src/model.js').Chat;
type Platform = import('../src/model.js').Platform;

let seq = 0;
function mkStore() {
  const s = new Store(path.join(tmp, `s${++seq}.db`));
  return s;
}
function chat(store: InstanceType<typeof Store>, acc: string, platform: Platform, remote: string, name: string, kind: Chat['kind'] = 'direct'): string {
  store.upsertAccount({ id: acc, platform, label: acc, status: 'connected', createdAt: 1 });
  const id = `${acc}/${remote}`;
  store.upsertChat({ id, accountId: acc, platform, remoteId: remote, name, kind, unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  return id;
}
let mid = 0;
function msg(store: InstanceType<typeof Store>, chatId: string, fromMe: boolean, ts: number, text = 'metin') {
  const r = `m${++mid}`;
  store.upsertMessage({ id: `${chatId}#${r}`, chatId, remoteId: r, senderId: fromMe ? 'me' : 'o', senderName: fromMe ? 'Ben' : 'O', fromMe, text, ts, status: 'read' });
}
/** Yerel saat (testler saat diliminden bağımsız) */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

test('emoji sayımı: ten rengi, ZWJ, bayrak; sistem baş emojisi ve tepki metni sayılmaz', () => {
  assert.deepEqual(extractEmojis('harika 😂😂 👍🏽'), ['😂', '😂', '👍🏽']);
  assert.deepEqual(extractEmojis('aile 👨‍👩‍👧 ve 🇹🇷'), ['👨‍👩‍👧', '🇹🇷']);
  assert.deepEqual(extractEmojis('❤️ tamam'), ['❤']);
  assert.deepEqual(extractEmojis('📷 Fotoğraf'), [], 'bağlayıcının yazdığı baş emoji');
  assert.deepEqual(extractEmojis('👍 Ayşe mesajına tepki verdi'), [], 'tepki olayı');
  assert.deepEqual(extractEmojis('© 2026 ™ düz metin'), []);
  assert.deepEqual(extractEmojis('sade metin'), []);
});

test('dönem sınırları: ay/yıl ve önceki dönem', () => {
  const now = at(2026, 9, 30, 10);
  const m = periodOf('month', undefined, now);
  assert.equal(m.at, '2026-09');
  assert.equal(m.label, 'Eylül 2026');
  assert.equal(m.from, at(2026, 9, 1, 0));
  assert.equal(m.end, at(2026, 10, 1, 0));
  assert.equal(m.prev!.label, 'Ağustos 2026');
  const jan = periodOf('month', '2026-01', now);
  assert.equal(jan.prev!.label, 'Aralık 2025');
  const y = periodOf('year', '2025', now);
  assert.equal(y.from, at(2025, 1, 1, 0));
  assert.equal(y.prev!.label, '2024');
});

test('rapor: sayılar, platformlar, kişiler/gruplar, yanıt süresi, ısı haritası, seri, emoji, değişim', async () => {
  const s = mkStore();
  const ali = chat(s, 'whatsapp:1', 'whatsapp', 'ali', 'Ali Yılmaz');
  const ece = chat(s, 'telegram:1', 'telegram', 'ece', 'Ece Kaya');
  const grp = chat(s, 'whatsapp:1', 'whatsapp', 'grp', 'Aile', 'group');
  const bulten = chat(s, 'gmail:1', 'gmail', 'bulten', 'Bülten');
  const shop = chat(s, 'trendyol:1', 'trendyol', 'sip', 'Sipariş 1');

  // Eylül 2026 (yerel saat)
  // Ali: gelen 10:00, benim yanıtım 10:05 (5 dk); gelen 14:00 + 14:01, yanıt 14:21 (ilk gelenden 21 dk); gelen 20:00, yanıt 20:02 (2 dk)
  msg(s, ali, false, at(2026, 9, 1, 10, 0));
  msg(s, ali, true, at(2026, 9, 1, 10, 5), 'tamam 😂😂');
  msg(s, ali, false, at(2026, 9, 2, 14, 0));
  msg(s, ali, false, at(2026, 9, 2, 14, 1));
  msg(s, ali, true, at(2026, 9, 2, 14, 21), 'olur 👍🏽');
  msg(s, ali, false, at(2026, 9, 3, 20, 0));
  msg(s, ali, true, at(2026, 9, 3, 20, 2), '😂');
  // Ece: gece 01:30 gelen, 13 sa sonra yanıt → üst sınırı aşar, yanıt süresi sayılmaz; sonra 1 dk'lık üç yanıt
  msg(s, ece, false, at(2026, 9, 5, 1, 30));
  msg(s, ece, true, at(2026, 9, 5, 14, 31), 'geç kaldım');
  for (const d of [10, 11, 12]) {
    msg(s, ece, false, at(2026, 9, d, 23, 0));
    msg(s, ece, true, at(2026, 9, d, 23, 1), 'gece 🌙');
  }
  // grup: 3 gelen + 1 benim (yanıt süresine girmez)
  msg(s, grp, false, at(2026, 9, 4, 9, 0));
  msg(s, grp, false, at(2026, 9, 4, 9, 1));
  msg(s, grp, true, at(2026, 9, 4, 9, 2), 'selam');
  msg(s, grp, false, at(2026, 9, 4, 9, 3));
  // tek yönlü bülten: kişilerde yok ama toplamda var
  msg(s, bulten, false, at(2026, 9, 6, 8, 0));
  // pazaryeri olayları hiç sayılmaz
  msg(s, shop, true, at(2026, 9, 6, 8, 0));
  msg(s, shop, false, at(2026, 9, 6, 8, 5));
  // Ağustos (önceki dönem, aynı süre içinde): 5 mesaj
  for (let i = 0; i < 5; i++) msg(s, ali, i % 2 === 0, at(2026, 8, 2 + i, 12));
  // Ekim: dönem dışı
  msg(s, ali, true, at(2026, 10, 1, 9));

  const now = at(2026, 9, 30, 18);
  const r = await computeStats(s, 'month', '2026-09', now);
  const sentExpected = 3 + 4 + 1; // Ali 3, Ece 4, grup 1
  const recvExpected = 4 + 4 + 3 + 1; // Ali 4, Ece 4, grup 3, bülten 1
  assert.equal(r.totals.sent, sentExpected);
  assert.equal(r.totals.received, recvExpected);
  assert.equal(r.totals.total, sentExpected + recvExpected);
  assert.equal(r.current, true);
  assert.equal(r.label, 'Eylül 2026');

  // platformlar: whatsapp (ali 7 + grup 4 = 11), telegram 8, gmail 1; trendyol yok
  assert.deepEqual(r.platforms.map((p) => [p.platform, p.total]), [['whatsapp', 11], ['telegram', 8], ['gmail', 1]]);
  // kişiler: iki yönlü birebirler (bülten yok), çoktan aza
  assert.deepEqual(r.people.map((p) => p.name), ['Ece Kaya', 'Ali Yılmaz']);
  assert.equal(r.totals.people, 2);
  assert.deepEqual(r.groups.map((g) => g.name), ['Aile']);

  // yanıt süreleri: Ali 5, 21, 2 dk; Ece 1, 1, 1 dk (13 sa'lik yanıt üst sınırı aştı)
  assert.ok(13 * 3_600_000 > REPLY_CAP_MS);
  assert.equal(r.reply!.count, 6);
  assert.equal(r.reply!.medianMs, Math.round((1 * MIN + 2 * MIN) / 2));
  assert.equal(r.reply!.avgMs, Math.round(((5 + 21 + 2 + 1 + 1 + 1) * MIN) / 6));
  assert.equal(r.reply!.fastest!.name, 'Ece Kaya');
  assert.equal(r.reply!.fastest!.medianReplyMs, MIN);
  assert.equal(r.people.find((p) => p.name === 'Ali Yılmaz')!.medianReplyMs, 5 * MIN);

  // ısı haritası: 1 Eylül 2026 Salı 10:00 → gün 1 (Pzt=0), saat 10
  const tue = (new Date(at(2026, 9, 1)).getDay() + 6) % 7;
  assert.equal(r.heat[tue * 24 + 10], 2);
  assert.equal(r.heat.reduce((a, b) => a + b, 0), r.totals.total);
  assert.equal(r.busiestHour!.hour, 23, 'en yoğun saat 23 (Ece gece yazışmaları)');

  // seri: gönderdiğim günler 1,2,3,4,5 (ardışık 5) ve 10,11,12 → en uzun 5
  assert.equal(r.streak.longest, 5);
  assert.equal(r.streak.from, '2026-09-01');
  assert.equal(r.streak.to, '2026-09-05');
  assert.equal(r.totals.activeDays, 8);
  assert.equal(r.streak.current, 0, 'son gönderim 12 Eylül: güncel seri yok');

  // emojiler: yalnız benimkiler; 😂 3 (ikisi aynı mesajda), 🌙 3, 👍🏽 1
  assert.deepEqual(r.emojis.map((e) => [e.emoji, e.count]), [['🌙', 3], ['😂', 3], ['👍🏽', 1]]);

  // gece: 00-05 arası en yoğun saat 01 (Ece'nin 01:30 mesajı)
  assert.equal(r.night.hour, 1);
  // profil: benim 8 mesajımın 3'ü 22-05 arası (23:01) → gece kuşu
  assert.equal(r.profile.kind, 'night');

  // değişim: Ağustos'un ilk 29,75 günü (5 mesaj) ile karşılaştırılır
  assert.equal(r.change!.prevTotal, 5);
  assert.equal(r.change!.total, Math.round(((20 - 5) / 5) * 1000) / 10);
  assert.equal(r.change!.prevLabel, 'Ağustos 2026');
});

test('güncel seri, bekleyen sohbetler, tüm zamanlar ve önbellek', async () => {
  const s = mkStore();
  const a = chat(s, 'imessage:1', 'imessage', 'a', 'Ayşe');
  const b = chat(s, 'whatsapp:2', 'whatsapp', 'b', 'Bora');
  const now = at(2026, 9, 30, 18);
  // son 4 gün (bugün dahil) her gün gönderim → güncel seri 4
  for (let i = 0; i < 4; i++) {
    msg(s, a, false, now - i * 86_400_000 - 3_600_000);
    msg(s, a, true, now - i * 86_400_000 - 3_000_000, 'ok');
  }
  // Bora son mesajı gönderdi, yanıtlamadım → bekleyen 1
  msg(s, b, false, now - 7_200_000);
  const r = await computeStats(s, 'all', undefined, now);
  assert.equal(r.streak.current, 4);
  assert.equal(r.streak.longest, 4);
  assert.equal(r.waiting, 1);
  assert.equal(r.change, null, 'tüm zamanlarda karşılaştırma yok');
  assert.equal(r.label, 'Tüm zamanlar');
  // yıl dönemi
  const y = await computeStats(s, 'year', '2026', now);
  assert.equal(y.totals.total, 9);

  clearStatsCache();
  const c1 = await getStats(s, 'month', '2026-09', { now });
  msg(s, a, true, now - 1000, 'yeni');
  const c2 = await getStats(s, 'month', '2026-09', { now: now + 1000 });
  assert.equal(c2.computedAt, c1.computedAt, 'süren dönem 10 dk önbellekte');
  assert.equal(c2.totals.total, c1.totals.total);
  const c3 = await getStats(s, 'month', '2026-09', { now: now + 11 * MIN });
  assert.equal(c3.totals.total, c1.totals.total + 1, 'süre dolunca yeniden hesaplanır');
  // kalıcı önbellek (meta): bellek boşalsa da okunur
  clearStatsCache();
  const c4 = await getStats(s, 'month', '2026-09', { now: now + 12 * MIN });
  assert.equal(c4.computedAt, c3.computedAt);
});

test('büyük veri: dilimli tarama doğru sayar ve olay döngüsünü uzun kilitlemez', async () => {
  const s = mkStore();
  const ids = Array.from({ length: 40 }, (_, i) => chat(s, 'whatsapp:9', 'whatsapp', `k${i}`, `Kişi ${i}`));
  const base = at(2026, 6, 1, 0);
  const N = 60_000;
  s.transaction(() => {
    for (let i = 0; i < N; i++) msg(s, ids[i % ids.length], i % 3 === 0, base + i * 37_000, i % 50 === 0 ? 'hey 🔥' : 'x');
  });
  let maxGap = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
  }, 5);
  const r = await computeStats(s, 'all', undefined, base + N * 37_000 + 1);
  clearInterval(iv);
  assert.equal(r.totals.total, N);
  assert.equal(r.totals.sent, Math.ceil(N / 3));
  assert.equal(r.emojis[0].emoji, '🔥');
  assert.ok(maxGap < 400, `olay döngüsü en çok ${Math.round(maxGap)} ms kilitlendi`);
});
