import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-qdraft-'));
process.env.MIVELO_DATA_DIR = tmp;
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { buildQuestionPrompt, MARKET_RULES, questionDraft, sanitizeAnswer } = await import('../src/question-draft.js');
type Params = Parameters<NonNullable<Parameters<typeof questionDraft>[1]>>[0];

const input = {
  platform: 'trendyol',
  question: 'Merhaba 170 cm 62 kg için hangi beden olur?',
  customerName: 'Deniz K.',
  product: { name: 'Keten elbise · kırmızı', id: 'KE-38', price: '1.890,00 ₺' },
  sameProduct: [{ question: 'Kalıbı dar mı?', answer: 'Merhaba, kalıbı regular; normal bedeninizi alabilirsiniz.' }],
  sellerAnswers: [{ them: 'Kargo ne zaman?', me: 'Merhaba, siparişler aynı gün kargoya verilir. İyi günler dileriz.' }],
  style: ['kısa-orta uzunlukta yazar', 'açılışta "Merhaba" der'],
};

test('istem: pazaryeri kuralları, ürün bilgisi, aynı ürünün önceki cevapları ve üslup', () => {
  const { system, user } = buildQuestionPrompt(input);
  for (const r of MARKET_RULES) assert.ok(system.includes(r), `kural istemde: ${r}`);
  assert.match(system, /Telefon numarası, e-posta adresi, web sitesi/);
  assert.match(system, /bağlantı/);
  assert.match(user, /Pazaryeri: Trendyol/);
  assert.match(user, /Ürün: Keten elbise · kırmızı/);
  assert.match(user, /Satış fiyatı \(son siparişlerden\): 1\.890,00 ₺/);
  assert.match(user, /"Kalıbı dar mı\?" → "Merhaba, kalıbı regular/);
  assert.match(user, /Kargo ne zaman\?/);
  assert.match(user, /açılışta "Merhaba" der/);
  assert.match(user, /Müşterinin sorusu: "Merhaba 170 cm 62 kg/);
  assert.doesNotMatch(user, /Deniz K\./, 'müşterinin adı istemde yok (cevapta tekrarlanmasın)');
  const empty = buildQuestionPrompt({ ...input, sameProduct: [], sellerAnswers: [], style: [], product: {} });
  assert.match(empty.user, /daha önce verilmiş cevap yok/);
  assert.match(empty.user, /Ürün adı bilinmiyor/);
});

test('süzgeç: telefon, e-posta, bağlantı ve hesap adı silinir; sipariş numarası ve ölçüler kalır', () => {
  const r = sanitizeAnswer('Merhaba, detay için 0532 000 00 99 numarasını arayın ya da ornek@example.com adresine yazın, www.ornek-magaza.com.tr sitemize ve @ornekmagaza hesabımıza bakın. Siparişiniz #1042931001, beden 38, 170 cm.');
  assert.doesNotMatch(r.text, /0532|ornek@|ornek-magaza|@ornekmagaza/);
  assert.match(r.text, /#1042931001/);
  assert.match(r.text, /beden 38, 170 cm/);
  assert.deepEqual(r.removed.sort(), ['bağlantı', 'e-posta adresi', 'sosyal medya hesabı', 'telefon numarası'].sort());
  assert.match(sanitizeAnswer('Bize +90 532 000 00 99 üzerinden ulaşın').removed.join(), /telefon/);
  assert.deepEqual(sanitizeAnswer('Merhaba, ürün stokta. İyi günler dileriz.').removed, []);
});

test('sahte AI: yapılandırılmış çıktı istenir, yanıt süzülüp döner (otomatik gönderim yok)', async () => {
  let seen: Params | undefined;
  const fake = async (p: Params) => {
    seen = p;
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: p.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify({ draft: 'Merhaba, 170 cm / 62 kg için 38 beden uygundur. Sorularınız için 0532 000 00 99.', notes: ['Stok bilgisini doğrulayın'] }) }],
    } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof questionDraft>[1]>>>;
  };
  const r = await questionDraft(input, fake);
  assert.ok(r);
  assert.equal(r.draft, 'Merhaba, 170 cm / 62 kg için 38 beden uygundur. Sorularınız için.');
  assert.deepEqual(r.notes, ['Stok bilgisini doğrulayın']);
  assert.deepEqual(r.removed, ['telefon numarası']);
  assert.equal(r.sameProduct, 1);
  const fmt = (seen?.output_config as { format?: { type?: string; schema?: { required?: string[] } } } | undefined)?.format;
  assert.equal(fmt?.type, 'json_schema');
  assert.deepEqual(fmt?.schema?.required, ['draft', 'notes']);
  assert.equal(typeof seen?.system, 'string');
});

test('sahte AI reddi → anlamlı hata', async () => {
  const fake = async () => ({ stop_reason: 'refusal', content: [] }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof questionDraft>[1]>>>;
  await assert.rejects(() => questionDraft(input, fake), /reddetti/);
});

test('depo: aynı ürüne verilmiş cevaplar (ad ya da ürün kodu), sistem satırları cevap sayılmaz', () => {
  const store = new Store(path.join(tmp, 'q.db'));
  store.upsertAccount({ id: 'trendyol:1', platform: 'trendyol', label: 'T', status: 'connected', createdAt: 1 });
  store.upsertAccount({ id: 'hepsiburada:1', platform: 'hepsiburada', label: 'H', status: 'connected', createdAt: 1 });
  const chat = (acc: string, rid: string, question: Record<string, unknown>, lines: Array<[boolean, string]>, ts = 1000) => {
    const id = `${acc}/${rid}`;
    store.upsertChat({ id, accountId: acc, platform: acc.split(':')[0] as 'trendyol', remoteId: rid, name: rid, kind: 'direct', unread: 0, lastMessageAt: ts, lastPreview: '', tags: [], meta: { question } });
    lines.forEach(([fromMe, text], i) => store.upsertMessage({ id: `${id}#${i}`, chatId: id, remoteId: `m${i}`, senderId: fromMe ? 'me' : 'c', senderName: fromMe ? 'Ben' : 'Müşteri', fromMe, text, ts: ts + i, status: 'sent' }));
    return id;
  };
  const cur = chat('trendyol:1', 'q-now', { productName: 'Keten elbise', productMainId: 'KE-38' }, [[false, 'Beden?']]);
  chat('trendyol:1', 'q-a', { productName: 'Keten elbise', productMainId: 'KE-38' }, [[false, 'Kalıbı dar mı?'], [true, 'Kalıbı regular.']], 2000);
  chat('trendyol:1', 'q-b', { productName: 'Eski ad', productMainId: 'KE-38' }, [[false, 'Yıkanır mı?'], [true, '📝 yerel not'], [true, '30 derecede yıkanır.']], 3000);
  chat('trendyol:1', 'q-c', { productName: 'Başka ürün' }, [[false, 'Stok?'], [true, 'Var.']]);
  chat('trendyol:1', 'q-d', { productName: 'Keten elbise' }, [[false, 'Renk?']]); // cevapsız
  chat('hepsiburada:1', 'q-e', { product: { name: 'Keten elbise' } }, [[false, 'Başka hesap'], [true, 'Sayılmaz']]);
  const got = store.productAnswers('trendyol:1', { name: 'Keten elbise', id: 'KE-38' }, cur);
  assert.deepEqual(got, [
    { question: 'Yıkanır mı?', answer: '30 derecede yıkanır.' },
    { question: 'Kalıbı dar mı?', answer: 'Kalıbı regular.' },
  ]);
  assert.equal(store.productAnswers('hepsiburada:1', { name: 'Keten elbise' }, 'x').length, 1, 'HB product.name alanı');
  assert.deepEqual(store.productAnswers('trendyol:1', {}, cur), []);
  assert.equal(store.marketMeta('trendyol:1').length, 5);
  store.close();
});
