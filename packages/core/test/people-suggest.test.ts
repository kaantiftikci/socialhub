import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-people-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { People } = await import('../src/people.js');
type Platform = import('../src/model.js').Platform;
type Kind = import('../src/model.js').ChatKind;

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `p${++n}.db`));
  const people = new People(store);
  const acc = (id: string, platform: Platform) => store.upsertAccount({ id, platform, label: id, status: 'connected', createdAt: 1 });
  const chat = (accountId: string, platform: Platform, remoteId: string, name: string, o: { handle?: string; kind?: Kind; at?: number; participants?: Array<{ id: string; name: string; handle?: string }>; meta?: Record<string, unknown> } = {}) => {
    const id = `${accountId}/${remoteId}`;
    store.upsertChat({ id, accountId, platform, remoteId, name, kind: o.kind ?? 'direct', unread: 0, lastMessageAt: o.at ?? 1000, lastPreview: '', tags: [], handle: o.handle, participants: o.participants, meta: o.meta });
    return id;
  };
  const msg = (chatId: string, rid: string, ts: number, text = rid) =>
    store.upsertMessage({ id: `${chatId}#${rid}`, chatId, remoteId: rid, senderId: 'o', senderName: 'O', fromMe: false, text, ts, status: 'read' });
  return { store, people, acc, chat, msg };
}

test('öneriler: aynı telefon güçlü, aynı ad orta; gruplar/pazaryeri ve aynı platformda ad eşleşmesi önerilmez', async () => {
  const { store, people, acc, chat } = setup();
  acc('whatsapp:a', 'whatsapp');
  acc('imessage:a', 'imessage');
  acc('instagram:a', 'instagram');
  acc('trendyol:a', 'trendyol');
  const wa = chat('whatsapp:a', 'whatsapp', '905000000099@s.whatsapp.net', 'Ayşe Yılmaz', { handle: '+905000000099' });
  const im = chat('imessage:a', 'imessage', 'iMessage;-;+905000000099', 'Ayşe Yılmaz');
  const ig = chat('instagram:a', 'instagram', '111', 'AYŞE YILMAZ 🌸', { handle: '@ayse.y' });
  chat('whatsapp:a', 'whatsapp', 'grup@g.us', 'Ayşe Yılmaz', { kind: 'group' });
  chat('whatsapp:a', 'whatsapp', '905000000098@s.whatsapp.net', 'Ayşe Yılmaz', { handle: '+905000000098' }); // aynı platformda ikinci Ayşe
  chat('trendyol:a', 'trendyol', 'q1', 'Ayşe Yılmaz');
  await people.recompute();
  const { suggestions } = await people.listSuggestions();
  const strong = suggestions.find((s) => s.chatIds.includes(im));
  assert.ok(strong, 'iMessage önerisi var');
  assert.deepEqual(new Set(strong!.chatIds), new Set([wa, im]), 'önce güçlü alt grup (aynı telefon) ayrı önerilir');
  assert.equal(strong!.strong, true);
  assert.deepEqual(strong!.reasons, ['Aynı telefon numarası', 'Aynı ad']);
  assert.ok(!suggestions.some((s) => s.chatIds.includes(ig)), 'yalnız adla bağlı Instagram güçlü grup birleşince önerilir');
  assert.ok(!suggestions.some((s) => s.chatIds.some((c) => c.includes('g.us') || c.startsWith('trendyol:'))));
  // güçlü grup birleşti → Instagram artık kişiye adla önerilir (orta güven)
  const person = people.mergeSuggestion(strong!.key);
  await people.recompute();
  const next = (await people.listSuggestions()).suggestions.find((s) => s.chatIds.includes(ig));
  assert.ok(next, 'Instagram önerildi');
  assert.equal(next!.personId, person.id);
  assert.equal(next!.strong, false);
  assert.deepEqual(next!.reasons, ['Aynı ad']);
  store.close();
});

test('birleştir, zaman çizelgesi sıralı ve sayfalı; ayır → reddedilmiş sayılır', async () => {
  const { store, people, acc, chat, msg } = setup();
  acc('whatsapp:a', 'whatsapp');
  acc('telegram:a', 'telegram');
  acc('gmail:a', 'gmail');
  const wa = chat('whatsapp:a', 'whatsapp', '905000000099@s.whatsapp.net', 'Ayşe Yılmaz', { handle: '+905000000099' });
  const tg = chat('telegram:a', 'telegram', '42', 'Ayşe', { handle: '@ayse', meta: { phone: '+905000000099' } });
  const p = [{ id: 'ornek@example.com', name: 'Ayşe Yılmaz', handle: 'ornek@example.com' }];
  const m1 = chat('gmail:a', 'gmail', 'gm:1', 'Konu 1', { handle: 'ornek@example.com', participants: p });
  const m2 = chat('gmail:a', 'gmail', 'gm:2', 'Konu 2', { handle: 'ornek@example.com', participants: p });
  for (let i = 0; i < 5; i++) {
    msg(wa, `w${i}`, 1000 + i * 30);
    msg(tg, `t${i}`, 1010 + i * 30);
    msg(m1, `e${i}`, 1020 + i * 30);
  }
  await people.recompute();
  let { suggestions } = await people.listSuggestions();
  const s = suggestions.find((x) => x.chatIds.includes(wa) && x.chatIds.includes(tg));
  assert.ok(s && s.strong, 'aynı telefon: güçlü öneri');
  const person = people.mergeSuggestion(s!.key);
  assert.equal(person.name, 'Ayşe Yılmaz', 'ad rehber platformundan');
  // e-posta: aynı adresli diziler tek birim, adla önerilir; birleştirince iki dizi birden bağlanır
  await people.recompute();
  ({ suggestions } = await people.listSuggestions());
  const ms = suggestions.find((x) => x.chatIds.includes(m1));
  assert.ok(ms, 'e-posta adla önerildi');
  assert.equal(ms!.personId, person.id);
  assert.ok(ms!.chatIds.includes(m2));
  const merged = people.merge([m1], { personId: person.id });
  assert.deepEqual(new Set(merged.chats.map((c) => c.id)), new Set([wa, tg, m1, m2]));

  const t1 = people.timeline(person.id, undefined, 6);
  assert.equal(t1.messages.length, 6);
  assert.ok(t1.hasMore);
  for (let i = 1; i < t1.messages.length; i++) assert.ok(t1.messages[i - 1].ts <= t1.messages[i].ts);
  assert.deepEqual(new Set(t1.messages.map((m) => m.platform)), new Set(['whatsapp', 'telegram', 'gmail']));
  const t2 = people.timeline(person.id, t1.messages[0].ts, 100);
  assert.equal(t2.messages.length, 15 - 6);
  assert.ok(t2.messages.every((m) => m.ts < t1.messages[0].ts));

  // ayır: e-posta dizilerinin hepsi ayrılır ve aynı kişiyle bir daha önerilmez
  const left = people.unlink(person.id, m1)!;
  assert.deepEqual(new Set(left.chats.map((c) => c.id)), new Set([wa, tg]));
  await people.recompute();
  ({ suggestions } = await people.listSuggestions());
  assert.ok(!suggestions.some((x) => x.chatIds.includes(m1)), 'ayrılan dizi yeniden önerilmedi');
  store.close();
});

test('reddetme kalıcı: yeni People örneği (yeniden açılış) de önermez', async () => {
  const { store, people, acc, chat } = setup();
  acc('instagram:a', 'instagram');
  acc('x:a', 'x');
  chat('instagram:a', 'instagram', '1', 'Mehmet Kaya', { handle: '@mkaya' });
  chat('x:a', 'x', '2', 'Mehmet Kaya', { handle: '@mkaya' });
  await people.recompute();
  let { suggestions } = await people.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].reasons.some((r) => r.startsWith('Aynı kullanıcı adı')));
  assert.ok(suggestions[0].score > 0.8, 'ad + kullanıcı adı birlikte daha güvenilir');
  assert.ok(people.dismiss(suggestions[0].key));
  const again = new People(store);
  await again.recompute();
  ({ suggestions } = await again.listSuggestions());
  assert.equal(suggestions.length, 0);
  store.close();
});

test('hesap kaldırma, sohbet birleştirme ve Tüm verileri sil ile uyum', async () => {
  const { store, people, acc, chat } = setup();
  acc('whatsapp:a', 'whatsapp');
  acc('instagram:a', 'instagram');
  acc('telegram:a', 'telegram');
  const wa = chat('whatsapp:a', 'whatsapp', '905000000099@s.whatsapp.net', 'Ayşe Yılmaz');
  const lid = chat('whatsapp:a', 'whatsapp', '123@lid', 'Ayşe Yılmaz');
  const ig = chat('instagram:a', 'instagram', '1', 'Ayşe Yılmaz');
  const tg = chat('telegram:a', 'telegram', '2', 'Ayşe Yılmaz');
  const p = people.merge([lid, ig, tg]);
  // WhatsApp lid → numara birleşmesi: bağ hedef sohbete taşınır
  store.mergeChats(lid, wa);
  assert.deepEqual(new Set(people.get(p.id)!.chats.map((c) => c.id)), new Set([wa, ig, tg]));
  // Instagram hesabı kaldırıldı: kişi iki sohbetle sürer
  await store.purgeAccount('instagram:a');
  assert.equal(people.get(p.id)!.chats.length, 2);
  // Telegram da gidince tek sohbet kalır → kişi silinir
  await store.purgeAccount('telegram:a');
  assert.equal(people.get(p.id), undefined);
  assert.equal(people.list().length, 0);
  // Tüm verileri sil
  acc('x:a', 'x');
  const x = chat('x:a', 'x', '3', 'Ayşe Yılmaz');
  people.merge([wa, x]);
  store.wipeAll();
  assert.equal(people.list().length, 0);
  assert.equal((store.sql('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n, 0);
  store.close();
});

test('büyük liste: 6000 sohbette öneri hesabı hızlı (O(n) gruplama)', async () => {
  const { store, people, acc, chat } = setup();
  acc('whatsapp:a', 'whatsapp');
  acc('instagram:a', 'instagram');
  store.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      const num = `90500${String(i).padStart(7, '0')}`;
      chat('whatsapp:a', 'whatsapp', `${num}@s.whatsapp.net`, `Kisi${i} Soyad${i}`, { handle: '+' + num });
      chat('instagram:a', 'instagram', `ig${i}`, i % 3 === 0 ? `Kisi${i} Soyad${i}` : `Baska${i} Ad${i}`, { handle: `@k${i}` });
    }
  });
  const t0 = Date.now();
  await people.recompute();
  const ms = Date.now() - t0;
  const { suggestions } = await people.listSuggestions();
  assert.equal(suggestions.length, 0, 'rakamlı adlar ad anahtarı sayılmaz');
  assert.ok(ms < 3000, `hesap ${ms} ms`);
  store.close();
});
