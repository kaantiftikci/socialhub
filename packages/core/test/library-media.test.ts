import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-lib-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const lib = await import('../src/library.js');
const { saveDownload } = await import('../src/downloads.js');
type Attachment = import('../src/model.js').Attachment;
type Platform = import('../src/model.js').Platform;

let seq = 0;
const mk = () => new Store(path.join(tmp, `l${++seq}.db`));
function chat(store: InstanceType<typeof Store>, acc: string, platform: Platform, remote: string, name: string): string {
  store.upsertAccount({ id: acc, platform, label: acc, status: 'connected', createdAt: 1 });
  const id = `${acc}/${remote}`;
  store.upsertChat({ id, accountId: acc, platform, remoteId: remote, name, kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
  return id;
}
let n = 0;
function msg(store: InstanceType<typeof Store>, chatId: string, ts: number, text: string, attachments?: Attachment[], fromMe = false): string {
  const r = `r${++n}`;
  const id = `${chatId}#${r}`;
  store.upsertMessage({ id, chatId, remoteId: r, senderId: fromMe ? 'me' : 'o', senderName: fromMe ? 'Ben' : 'Ayşe', fromMe, text, ts, status: 'read', attachments });
  return id;
}
const drain = (s: InstanceType<typeof Store>) => {
  while (!lib.backfillStep(s) || lib.indexDirty(s, 500) > 0) {
    /* bitene dek */
  }
};

test('ek türleri ve metindeki bağlantılar (saf)', () => {
  assert.equal(lib.kindOfAttachment({ kind: 'image', url: '/api/media/a?u=1' }), 'image');
  assert.equal(lib.kindOfAttachment({ kind: 'file', name: 'x.pdf', link: '/api/media/a?u=2' }), 'file');
  assert.equal(lib.kindOfAttachment({ kind: 'other', page: 'https://instagram.com/p/abc' }), 'link');
  assert.equal(lib.kindOfAttachment({ kind: 'image' }), undefined, 'adressiz ek gösterilemez');
  assert.deepEqual(lib.extractLinks('bak: https://ornek.com/a, ve https://ornek.com/a. sonra http://x.co/yol!', 'whatsapp'), ['https://ornek.com/a', 'http://x.co/yol']);
  // e-postada izleme/abonelik bağlantıları elenir
  assert.deepEqual(lib.extractLinks('https://site.com/haber https://site.com/unsubscribe?id=1 https://x.list-manage.com/track/click?u=1', 'gmail'), ['https://site.com/haber']);
  const items = lib.itemsOfMessage({ text: 'gönderi https://instagram.com/p/abc ve https://ornek.com', attachments: [{ kind: 'other', page: 'https://instagram.com/p/abc', url: '/api/media/k?u=t' }], platform: 'instagram' });
  assert.deepEqual(items.map((i) => [i.idx, i.kind]), [[0, 'link'], [100, 'link']], 'ekteki bağlantı metinde tekrar sayılmaz');
});

test('tetikleyiciler + dizinleyici: ekleme, düzenleme, silme, sohbet birleştirme; süzgeç ve imleç', () => {
  const s = mk();
  // kurulumdan ÖNCE yazılan mesaj: dolum (backfill) ile gelir
  const wa = chat(s, 'whatsapp:1', 'whatsapp', 'ayse', 'Ayşe Demir');
  const old = msg(s, wa, 1000, 'eski foto', [{ kind: 'image', name: 'eski.jpg', url: '/api/media/whatsapp:1?u=wa:1' }]);
  lib.resetLibraryInstall();
  lib.installLibrary(s);
  const tg = chat(s, 'telegram:1', 'telegram', 'bora', 'Bora');
  const gm = chat(s, 'gmail:1', 'gmail', 't1', 'Fatura');
  msg(s, wa, 2000, 'rapor ektedir', [{ kind: 'file', name: 'Rapor-Eylül.pdf', mime: 'application/pdf', size: 1234, link: '/api/media/whatsapp:1?u=wa:2' }], true);
  msg(s, tg, 3000, '', [{ kind: 'video', name: 'klip.mp4', link: '/api/media/telegram:1?u=v', url: '/api/media/telegram:1?u=p' }]);
  msg(s, tg, 4000, '', [{ kind: 'audio', name: 'Sesli mesaj', link: '/api/media/telegram:1?u=a' }]);
  const withLink = msg(s, gm, 5000, 'Faturanız: https://fatura.ornek.com/2026/09 — abonelikten çık https://ornek.com/unsubscribe');
  msg(s, tg, 6000, 'düz metin, bağlantı yok');
  drain(s);

  let all = lib.queryLibrary(s, {});
  assert.deepEqual(all.items.map((i) => i.kind), ['link', 'audio', 'video', 'file', 'image']);
  assert.equal(all.items[0].name, 'fatura.ornek.com/2026/09');
  assert.equal(all.items[3].senderName, 'Ben');
  assert.equal(all.items[3].fromMe, true);
  assert.equal(all.items[3].chatName, 'Ayşe Demir');
  assert.equal(all.items[4].messageId, old, 'kurulum öncesi mesaj dolumla geldi');

  // süzgeçler
  assert.deepEqual(lib.queryLibrary(s, { kind: 'file' }).items.map((i) => i.name), ['Rapor-Eylül.pdf']);
  assert.deepEqual(lib.queryLibrary(s, { platform: 'telegram' }).items.map((i) => i.kind), ['audio', 'video']);
  assert.deepEqual(lib.queryLibrary(s, { chat: wa }).items.length, 2);
  assert.deepEqual(lib.queryLibrary(s, { q: 'rapor-eylül' }).items.map((i) => i.name), ['Rapor-Eylül.pdf'], 'Türkçe küçük harf araması');
  assert.deepEqual(lib.queryLibrary(s, { q: 'ayşe' }).items.length, 2, 'sohbet adında da arar');

  // imleçli sayfalama
  const p1 = lib.queryLibrary(s, { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = lib.queryLibrary(s, { limit: 2, before: p1.next! });
  const p3 = lib.queryLibrary(s, { limit: 2, before: p2.next! });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.id), all.items.map((i) => i.id));
  assert.equal(p3.next, null);

  // sayılar
  const f = lib.libraryFacets(s);
  assert.deepEqual(f.kinds, { link: 1, audio: 1, video: 1, file: 1, image: 1 });
  assert.equal(f.progress.ready, true);
  assert.deepEqual(f.chats.map((c) => c.name), ['Fatura', 'Bora', 'Ayşe Demir']);

  // düzenleme: bağlantı metinden kalkınca öğe de gider
  s.applyEdit(withLink, 'bağlantısız metin');
  lib.indexDirty(s);
  assert.equal(lib.queryLibrary(s, { kind: 'link' }).items.length, 0);
  // herkesten silinen mesajın eki kütüphaneden çıkar
  const vid = lib.queryLibrary(s, { kind: 'video' }).items[0].messageId;
  s.applyEdit(vid, null);
  assert.equal(lib.queryLibrary(s, { kind: 'video' }).items.length, 0);
  // sohbet birleştirme: öğe yeni sohbete taşınır
  const tg2 = chat(s, 'telegram:1', 'telegram', 'bora2', 'Bora (2)');
  s.mergeChats(tg, tg2);
  assert.deepEqual(lib.queryLibrary(s, { chat: tg2 }).items.map((i) => i.kind), ['audio']);
  // hesap silinince (mesajlar silinir) öğeler de gider
  s.deleteAccount('whatsapp:1');
  lib.indexDirty(s);
  assert.equal(lib.queryLibrary(s, { platform: 'whatsapp' }).items.length, 0);
});

test('büyük dolum: dilimli kuyruk, sonuç tam', () => {
  const s = mk();
  const c = chat(s, 'whatsapp:5', 'whatsapp', 'g', 'Grup');
  s.transaction(() => {
    for (let i = 0; i < 12_000; i++) msg(s, c, i, i % 4 === 0 ? `bak https://ornek.com/${i}` : 'x', i % 10 === 0 ? [{ kind: 'image', url: `/api/media/whatsapp:5?u=${i}` }] : undefined);
  });
  lib.resetLibraryInstall();
  lib.installLibrary(s);
  let steps = 0;
  while (!lib.backfillStep(s, 5000)) steps++;
  assert.ok(steps >= 2, 'rowid aralıklarıyla dilimli');
  assert.equal(lib.libraryProgress(s).ready, false);
  while (lib.indexDirty(s, 400) > 0);
  const f = lib.libraryFacets(s);
  assert.equal(f.kinds.image, 1200);
  assert.equal(f.kinds.link, 3000);
  assert.equal(f.progress.ready, true);
});

test('dosya kaydetme: aynı ad varsa numaralanır, ad temizlenir', () => {
  const dir = path.join(tmp, 'indirilenler');
  const a = saveDownload('Mivelo Raporum.png', Buffer.from('a'), { dir, reveal: false });
  const b = saveDownload('Mivelo Raporum.png', Buffer.from('b'), { dir, reveal: false });
  const c = saveDownload('../../kötü/ad?.png', Buffer.from('c'), { dir, reveal: false });
  assert.equal(path.basename(a), 'Mivelo Raporum.png');
  assert.equal(path.basename(b), 'Mivelo Raporum (2).png');
  assert.equal(path.dirname(c), dir, 'klasör dışına yazılmaz');
  assert.throws(() => saveDownload('x', Buffer.alloc(0), { dir, reveal: false }));
});
