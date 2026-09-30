import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { quantize, dequantize, packVector, unpackVector, VectorIndex, rrf, normalize, cosine } from '../src/ml/vector.js';
import { parseQuery, keywords } from '../src/ml/query.js';
import { detectLanguage, dominantLanguage } from '../src/ml/lang.js';
import { JobQueue } from '../src/ml/queue.js';
import { decodeAudio, decodeWav, parseOgg, parseOpusHead, isOgg, resample } from '../src/ml/audio.js';
import { TarExtract } from '../src/ml/tar.js';

// config.js (DATA_DIR) içe aktarılmadan önce: gerçek ~/.mivelo'ya dokunulmasın
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mlu-'));
process.env.KAVSAK_DATA_DIR = tmpData;
process.env.MIVELO_DATA_DIR = tmpData;
after(() => fs.rmSync(tmpData, { recursive: true, force: true }));
const { audioSourceOf } = await import('../src/ml/transcribe.js');
const { indexable, passage, queryText } = await import('../src/ml/semantic.js');

const here = path.dirname(fileURLToPath(import.meta.url));

// 0,5 sn 440 Hz, 16 kHz mono, Ogg/Opus (libsndfile ile üretildi)
const TINY_OGG = Buffer.from('T2dnUwACAAAAAAAAAAA0EXRHAAAAAEXfxpcBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAADQRdEcBAAAA98xNeAT///8aT3B1c1RhZ3MLAAAAbGlib3B1cyAxLjQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABPZ2dTAAT4XgAAAAAAADQRdEcCAAAAr8d0/RoPFhAQFBATEhUQEBMREA8WDRMTDhIRERQUCgiE5HULn4wvWR0gzSt5wAi0r7nspIiCA2UUTNUE8YBd/qHsyQoIrOeK+v7iyMiWqH9u4Z5ACKznivr6ZyjegygWlPCI4Ais54r6/uLJGXVodZdLNi9acgqACK6NYvsyoSVv2Qeeg/JSMAiumkr6/uK+vllJdqefluokxrAIro1i+zKhJW/vrlhglYpFA8AIrppJBPq1rQ9kNaEo5DVZYPvb554IrppK+v7iyRl2n+L352OoCK6aSvr6ZyorFW+nciRn6giujWL7MqCx6/uGavbnkFWrkHAIro1i+49KgovJOwOA/YBpFQiumkr6/uK+vItZkZ9zpRoIrppK+v7iyMiBn/DhXHAIrq5qMlk+tYdKy12mOYQLlVOdrCoMCK6aSvr+4sX4oE8nPAiujWL7MqEj9LQHLJlM4xiu9kAIrppK+v7ivrfirNGTNfKGDYvICK6aSvr+4skZoOqYb8AIrppK+vpnKOMAYBTvZ+yk2YAIrppK+v7ixfjdxFnCbkx7gAiujWL7MqEj9M1wgoZ8BpfwCK7FnO7l+i21BGeLIIimnteoOcYIsE0JBPVQmMWepY1O02ut6BCf5QC9UIHoOsTFqKs=', 'base64');

test('ml vektör: int8 nicemleme, BLOB paketleme, kosinüs', () => {
  const v = normalize(Float32Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.37) + (i % 7) * 0.05));
  const q = quantize(v);
  assert.equal(q.q.length, 384);
  const back = dequantize(q);
  assert.ok(cosine(v, back) > 0.999, 'nicemleme kaybı küçük');
  const u = unpackVector(packVector(q));
  assert.deepEqual([...u.q], [...q.q]);
  assert.ok(Math.abs(u.scale - q.scale) < 1e-6);
  assert.equal(quantize([0, 0, 0]).q.every((x) => x === 0), true, 'sıfır vektör bozulmaz');
});

test('ml vektör: bellek içi dizin sıralama, süzgeçler, silme, büyüme', async () => {
  const idx = new VectorIndex(4, 2);
  const unit = (a: number[]) => normalize(Float32Array.from(a));
  idx.add('a', 'acc/1', 1000, quantize(unit([1, 0, 0, 0])));
  idx.add('b', 'acc/1', 2000, quantize(unit([0.9, 0.1, 0, 0])));
  idx.add('c', 'acc/2', 3000, quantize(unit([0, 1, 0, 0])));
  idx.add('d', 'oth/1', 4000, quantize(unit([0.7, 0.7, 0, 0])));
  assert.equal(idx.size, 4);
  const qv = unit([1, 0, 0, 0]);
  const all = await idx.search(qv, 3, undefined, 2);
  assert.deepEqual(all.map((x) => x.id), ['a', 'b', 'd']);
  assert.ok(all[0].score > 0.99);
  const ranged = await idx.search(qv, 5, { from: 1500, to: 3500 });
  assert.deepEqual(ranged.map((x) => x.id), ['b', 'c']);
  const inChat = await idx.search(qv, 5, { chats: new Set(['acc/2']) });
  assert.deepEqual(inChat.map((x) => x.id), ['c']);
  assert.equal(idx.removeWhere((c) => c.startsWith('acc/')), 3);
  assert.deepEqual((await idx.search(qv, 5)).map((x) => x.id), ['d']);
  // aynı kimlik yeniden eklenince güncellenir (kopya yok)
  idx.add('d', 'oth/1', 4000, quantize(unit([1, 0, 0, 0])));
  assert.equal(idx.size, 1);
  // çok sayıda kayıtta en iyi k doğru (O(k) yerleştirme)
  const big = new VectorIndex(2, 4);
  for (let i = 0; i < 500; i++) big.add(String(i), 'x/1', i, quantize(unit([Math.cos(i / 100), Math.sin(i / 100)])));
  const top = await big.search(unit([1, 0]), 5, undefined, 64);
  assert.deepEqual(top.map((x) => x.id), ['0', '1', '2', '3', '4']);
});

test('ml vektör: karşılıklı sıra füzyonu iki listede de olanı öne alır', () => {
  const r = rrf([['x', 'y', 'z'], ['y', 'q']]);
  assert.equal(r[0].id, 'y');
  assert.deepEqual(new Set(r.map((x) => x.id)), new Set(['x', 'y', 'z', 'q']));
});

test('ml sorgu: tarih ve kişi ipuçları', () => {
  const now = new Date(2026, 8, 30, 15, 0); // 30 Eylül 2026
  const a = parseQuery("geçen ay Ahmet'in gönderdiği fatura", now);
  assert.equal(a.dateLabel, 'geçen ay');
  assert.equal(new Date(a.from!).getMonth(), 7); // ağustos
  assert.equal(new Date(a.to!).getMonth(), 7);
  assert.deepEqual(a.people, ['ahmet']);
  assert.deepEqual(keywords(a.rest), ['fatura']);
  const b = parseQuery('dün toplantı', now);
  assert.equal(new Date(b.from!).getDate(), 29);
  assert.ok(b.to! < new Date(2026, 8, 30).getTime());
  assert.equal(b.rest, 'toplantı');
  const c = parseQuery('son 2 hafta kargo', now);
  assert.ok(Math.abs(c.from! - (now.getTime() - 14 * 86400e3)) < 1000);
  const d = parseQuery('mart 2025 kira sözleşmesi', now);
  assert.equal(new Date(d.from!).getFullYear(), 2025);
  assert.equal(new Date(d.from!).getMonth(), 2);
  assert.deepEqual(keywords(d.rest), ['kira', 'sözleşmesi']);
  // yıl verilmemiş gelecek ay → geçen yılın o ayı
  const e = parseQuery('aralıkta konuştuğumuz fiyat', now);
  assert.equal(new Date(e.from!).getFullYear(), 2025);
  const f = parseQuery('Mehmet ile konuştuğumuz tatil', now);
  assert.deepEqual(f.people, ['mehmet']);
  assert.deepEqual(keywords(f.rest), ['tatil']);
  const g = parseQuery('fatura', now);
  assert.equal(g.from, undefined);
  assert.equal(g.people.length, 0);
});

test('ml dil algılama: yazı sistemi + kelime/harf puanı; kısa metinde karar yok', () => {
  const cases: Array<[string, string | null]> = [
    ['Merhaba, siparişim ne zaman kargoya verilecek?', 'tr'],
    ['Hello, when will my order ship? Thanks!', 'en'],
    ['Is this product in stock?', 'en'],
    ['Hallo, wann wird meine Bestellung verschickt? Danke', 'de'],
    ['Bonjour, quand est-ce que ma commande sera expédiée ?', 'fr'],
    ['Hola, ¿cuándo llega mi pedido?', 'es'],
    ['Привет, когда будет доставка?', 'ru'],
    ['مرحبا متى سيصل طلبي', 'ar'],
    ['ご注文ありがとうございます', 'ja'],
    ['Bu ürün stokta var mı?', 'tr'],
    ['ok', null],
    ['👍👍', null],
  ];
  for (const [s, want] of cases) assert.equal(detectLanguage(s).lang, want, s);
  assert.equal(dominantLanguage(['Hi there, is it available?', 'ok', 'Can you ship to Berlin?']).lang, 'en');
});

test('ml dil algılama: arayüz kopyası (apps/web/src/lang-detect.ts) çekirdekle aynı', () => {
  const core = fs.readFileSync(path.join(here, '../src/ml/lang.ts'), 'utf8');
  const web = fs.readFileSync(path.join(here, '../../../apps/web/src/lang-detect.ts'), 'utf8');
  assert.equal(web, core);
});

test('ml kuyruk: eşzamanlılık 1, kullanıcı işi arka plan işinin önüne geçer', async () => {
  const q = new JobQueue();
  const order: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const job = (name: string) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    order.push(name);
    running--;
    return name;
  };
  const ps = [q.add(job('b1')), q.add(job('b2')), q.add(job('b3')), q.add(job('i1'), 'interactive')];
  assert.equal(await ps[3], 'i1');
  await Promise.all(ps);
  assert.equal(maxRunning, 1);
  // b1 zaten başlamıştı; i1 bekleyen b2/b3'ün önüne geçti
  assert.deepEqual(order, ['b1', 'i1', 'b2', 'b3']);
  const bad = q.add(async () => {
    throw new Error('x');
  });
  await assert.rejects(bad, /x/);
  const after = q.add(job('ok'));
  assert.equal(await after, 'ok', 'hata kuyruğu durdurmaz');
});

test('ml ses: Ogg/Opus → 16 kHz mono (opus-decoder), WAV ayrıştırma, yeniden örnekleme', async () => {
  assert.ok(isOgg(TINY_OGG));
  const { packets } = parseOgg(TINY_OGG);
  const head = parseOpusHead(packets[0]);
  assert.equal(head?.channels, 1);
  const pcm = await decodeAudio(TINY_OGG);
  const secs = pcm.length / 16000;
  assert.ok(secs > 0.4 && secs < 0.6, `süre ${secs}`);
  // 440 Hz: sıfır geçişlerinden frekans
  let zc = 0;
  for (let i = 1600; i < pcm.length; i++) if (pcm[i - 1] < 0 !== pcm[i] < 0) zc++;
  const hz = zc / 2 / ((pcm.length - 1600) / 16000);
  assert.ok(Math.abs(hz - 440) < 25, `frekans ${hz}`);

  // 44,1 kHz stereo 16 bit WAV → 16 kHz mono
  const rate = 44100;
  const n = rate / 2;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 16000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  const wav = decodeWav(Buffer.concat([hdr, data]));
  assert.equal(wav.length, 8000);
  assert.ok(Math.abs(Math.max(...wav) - 16000 / 32768) < 0.05);
  assert.equal(resample(new Float32Array([1, 1, 1, 1]), 16000).length, 4);
  await assert.rejects(decodeAudio(Buffer.from('ID3 mp3 değil')), /tanınmadı/);
});

/** Testte küçük bir .tgz üret: npm paketi düzeni ("package/…") + tehlikeli yollar */
function makeTar(entries: Array<{ name: string; body: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('ml tar: yalnız istenen dosyalar açılır, yol aşımı ve bağlar yazılmaz', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-tar-'));
  try {
    const big = 'x'.repeat(1300);
    const tgz = makeTar([
      { name: 'package/package.json', body: '{"name":"t"}' },
      { name: 'package/dist/a.mjs', body: big },
      { name: 'package/dist/skip.map', body: 'nope' },
      { name: 'package/../../evil.txt', body: 'evil' },
      { name: 'package/dist/link', body: '', type: '2' },
    ]);
    const tar = new TarExtract(dest, (n) => (n.startsWith('package/') && !n.endsWith('.map') ? n.slice(8) : undefined));
    // küçük parçalarla besle (başlık/veri parçalar arasında bölünsün)
    const chunks: Buffer[] = [];
    for (let i = 0; i < tgz.length; i += 97) chunks.push(tgz.subarray(i, i + 97));
    await pipeline(Readable.from(chunks), createGunzip(), tar);
    assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"t"}');
    assert.equal(fs.readFileSync(path.join(dest, 'dist/a.mjs'), 'utf8'), big);
    assert.ok(!fs.existsSync(path.join(dest, 'dist/skip.map')));
    assert.ok(!fs.existsSync(path.join(dest, 'dist/link')));
    assert.ok(!fs.existsSync(path.join(path.dirname(dest), 'evil.txt')));
    assert.deepEqual(tar.written.sort(), ['dist/a.mjs', 'package.json']);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('ml yardımcılar: ses kaynağı, dizinlenebilir metin, e5 önekleri', () => {
  const src = audioSourceOf({ attachments: [{ kind: 'image', url: 'x' }, { kind: 'audio', name: 'Sesli mesaj', mime: 'audio/ogg', link: '/api/media/whatsapp%3A905000000099?u=' + encodeURIComponent('wa:905000000099@s.whatsapp.net/ABC') }] });
  assert.deepEqual(src, { accountId: 'whatsapp:905000000099', u: 'wa:905000000099@s.whatsapp.net/ABC', mime: 'audio/ogg' });
  assert.equal(audioSourceOf({ attachments: [{ kind: 'audio', link: 'https://cdn.example.com/a.mp4' }] }), undefined);
  assert.equal(indexable('tamam'), false);
  assert.equal(indexable('🔒 Mesajlar uçtan uca şifrelidir'), false);
  assert.equal(indexable('Faturayı yarın gönderirim, merak etme'), true);
  assert.equal(passage('  a\n b '), 'passage: a b');
  assert.equal(queryText(' fatura '), 'query: fatura');
});
