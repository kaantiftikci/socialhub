import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-trendyol-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { TrendyolConnector, parseConfig } = await import('../src/connectors/trendyol.js');

const SELLER = '123';
const CONFIG = JSON.stringify({ orders: true, sellerId: SELLER, apiKey: 'key', apiSecret: 'secret' });
const NOW = Date.now();

// ---- Trendyol dokümanındaki örneklere benzer sahte yanıtlar ----
const PACKAGE = (over: Record<string, unknown> = {}) => ({
  id: 11650604,
  shipmentNumber: 'SN1',
  orderNumber: '80249000',
  customerId: 99,
  customerFirstName: 'Ayşe',
  customerLastName: 'Yılmaz',
  customerEmail: 'pf+abc@trendyolmail.com',
  grossAmount: 250,
  totalDiscount: 50,
  totalTyDiscount: 0,
  totalPrice: 200,
  status: 'Created',
  shipmentPackageStatus: 'Created',
  deliveryType: 'normal',
  orderDate: NOW - 3_600_000,
  lastModifiedDate: NOW - 3_600_000,
  currencyCode: 'TRY',
  shipmentAddress: { fullName: 'Ayşe Yılmaz', address1: 'Bağdat Cad. No:1', city: 'İstanbul', district: 'Kadıköy', fullAddress: 'Bağdat Cad. No:1 Kadıköy/İstanbul' },
  lines: [{ id: 1, productName: 'Pamuklu Tişört', merchantSku: 'TS-01', barcode: '869000', quantity: 2, price: 100, amount: 200, currencyCode: 'TRY', productSize: 'M', productColor: 'Siyah', orderLineItemStatusName: 'Created' }],
  cargoProviderName: 'Yurtiçi Kargo',
  packageHistories: [{ createdDate: NOW - 3_600_000, status: 'Created' }],
  ...over,
});
const QUESTION = (over: Record<string, unknown> = {}) => ({
  id: 456,
  text: 'Bu ürün %100 pamuk mu acaba?',
  creationDate: NOW - 1_800_000,
  status: 'WAITING_FOR_ANSWER',
  productName: 'Pamuklu Tişört Erkek Bisiklet Yaka Uzun Açıklamalı Ürün Adı',
  productMainId: 'TS',
  imageUrl: 'https://cdn.dsmcdn.com/x.jpg',
  webUrl: 'https://www.trendyol.com/x/y-p-1',
  public: true,
  customerId: 77,
  userName: 'M** K**',
  showUserName: true,
  ...over,
});
const page = (content: unknown[]) => ({ content, page: 0, size: 200, totalPages: 1, totalElements: content.length });

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
/** globalThis.fetch'i sahte yanıtlarla değiştirir; yapılan çağrıları toplar. */
function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const h = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', headers: h, body: init.body as string | undefined });
    const res = handler(url, init) ?? { status: 404, body: '' };
    const status = res.status ?? 200;
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

let n = 0;
function setup(config = CONFIG) {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `trendyol:t${n}`, platform: 'trendyol' as const, label: 'Trendyol', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new TrendyolConnector(account, store, config);
  return { store, account, c, orderChat: `${account.id}/order-80249000`, qChat: `${account.id}/q-456` };
}

test('parseConfig: eksik alan → undefined; supplierId takma adı kabul', () => {
  assert.equal(parseConfig('{}'), undefined);
  assert.equal(parseConfig('bozuk'), undefined);
  assert.deepEqual(parseConfig(JSON.stringify({ orders: true, supplierId: 5, apiKey: 'a', apiSecret: 'b' })), { sellerId: '5', apiKey: 'a', apiSecret: 'b' });
});

test('bozuk yapılandırma → error durumu, ağ isteği yok', async () => {
  const calls = fakeFetch(() => ({ body: page([]) }));
  const { c, account } = setup('{"sellerId":"1"}');
  await c.start();
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /girilmedi/);
  assert.equal(calls.length, 0);
});

test('ilk yoklama: sipariş sohbeti + yeni sipariş mesajı; soru sohbeti unread=1; kimlik başlıkları ve güncel geçit', async () => {
  const calls = fakeFetch((url) => {
    if (url.includes('/order/sellers/123/orders')) return { body: page([PACKAGE()]) };
    if (url.includes('/qna/sellers/123/questions/filter')) return { body: page([QUESTION()]) };
    return undefined;
  });
  const { c, store, account, orderChat, qChat } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.equal(account.label, 'Trendyol · 123');

  // istekler: apigw + Basic auth + User-Agent
  const orderCall = calls.find((x) => x.url.includes('/orders'))!;
  assert.ok(orderCall.url.startsWith('https://apigw.trendyol.com/integration/order/sellers/123/orders?'), orderCall.url);
  assert.equal(orderCall.headers.authorization, `Basic ${Buffer.from('key:secret').toString('base64')}`);
  assert.equal(orderCall.headers['user-agent'], '123 - SelfIntegration');
  const u = new URL(orderCall.url);
  assert.equal(u.searchParams.get('size'), '200');
  assert.equal(u.searchParams.get('orderByField'), 'PackageLastModifiedDate');
  const start = Number(u.searchParams.get('startDate'));
  const end = Number(u.searchParams.get('endDate'));
  assert.ok(end - start <= 14 * 86_400_000 && end - start > 13 * 86_400_000, 'ilk pencere ~14 gün');

  // sipariş sohbeti
  const chat = store.getChat(orderChat)!;
  assert.equal(chat.name, '#80249000 · Ayşe Yılmaz');
  assert.equal(chat.unread, 1, 'açık sipariş ilgi bekliyor');
  const order = chat.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(order.id, '80249000');
  assert.equal(order.status, 'Created');
  assert.equal(order.totals.total, 200);
  assert.equal(order.items[0].title, 'Pamuklu Tişört');
  assert.equal(order.shipping.address, 'Bağdat Cad. No:1 Kadıköy/İstanbul, Kadıköy, İstanbul');
  assert.equal(order.fulfillments[0].company, 'Yurtiçi Kargo');
  const msgs = store.listMessages(orderChat);
  assert.equal(msgs.length, 1, 'Created durumu ayrı mesaj üretmez');
  assert.equal(msgs[0].fromMe, false);
  assert.match(msgs[0].text, /^🛍️ Yeni sipariş #80249000 — 200,00 ₺\n• 2 × Pamuklu Tişört \(Siyah \/ M\)/);

  // soru sohbeti
  const q = store.getChat(qChat)!;
  assert.equal(q.name, 'Soru · Pamuklu Tişört Erkek Bisiklet Yaka Uzun…');
  assert.equal(q.unread, 1);
  assert.equal(q.kind, 'direct');
  assert.equal(q.participants?.[0].name, 'M** K**');
  assert.equal(q.link, 'https://www.trendyol.com/x/y-p-1');
  const qm = store.listMessages(qChat);
  assert.equal(qm.length, 1);
  assert.equal(qm[0].fromMe, false);
  assert.equal(qm[0].text, 'Bu ürün %100 pamuk mu acaba?');
  assert.equal(qm[0].ts, NOW - 1_800_000);
  await c.stop();
});

test('ikinci yoklama: değişmeyen sipariş/soru mesaj üretmez; kargoya verilince 📦 mesajı, cevaplanınca fromMe cevap', async () => {
  let shipped = false;
  fakeFetch((url) => {
    if (url.includes('/orders')) return { body: page([shipped ? PACKAGE({ status: 'Shipped', shipmentPackageStatus: 'Shipped', cargoTrackingNumber: 7240011111, cargoTrackingLink: 'https://kargo/7240011111', lastModifiedDate: NOW, packageHistories: [{ createdDate: NOW - 3_600_000, status: 'Created' }, { createdDate: NOW - 1000, status: 'Picking' }, { createdDate: NOW, status: 'Shipped' }] }) : PACKAGE()]) };
    if (url.includes('/questions/filter')) return { body: page([shipped ? QUESTION({ status: 'ANSWERED', answer: { text: 'Evet, ürünümüz %100 pamuktur.', creationDate: NOW } }) : QUESTION()]) };
    return undefined;
  });
  const { c, store, orderChat, qChat } = setup();
  const priv = c as unknown as { poll(first: boolean): Promise<void> };
  await c.start();
  const before = store.listMessages(orderChat).length + store.listMessages(qChat).length;
  await priv.poll(false);
  assert.equal(store.listMessages(orderChat).length + store.listMessages(qChat).length, before, 'değişmeyen kayıt tekrar mesaj üretmemeli');

  shipped = true;
  await priv.poll(false);
  const om = store.listMessages(orderChat).sort((a, b) => a.ts - b.ts);
  assert.equal(om.length, 3);
  assert.equal(om[1].text, '📦 Gönderi hazırlanıyor');
  assert.ok(om[1].fromMe);
  assert.equal(om[2].text, '📦 Kargoya verildi · Yurtiçi Kargo · takip: 7240011111\nhttps://kargo/7240011111');
  assert.equal((store.getChat(orderChat)!.meta?.order as Record<string, any>).fulfillments[0].trackingNumber, '7240011111'); // eslint-disable-line @typescript-eslint/no-explicit-any
  const qm = store.listMessages(qChat).sort((a, b) => a.ts - b.ts);
  assert.equal(qm.length, 2);
  assert.equal(qm[1].fromMe, true);
  assert.equal(qm[1].text, 'Evet, ürünümüz %100 pamuktur.');
  assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).status, 'ANSWERED');
  await c.stop();
});

test('sendText: soru sohbetinde doğru uca POST + fromMe mesaj; sipariş sohbetinde yerel not; kısa cevap reddedilir', async () => {
  const calls = fakeFetch((url, init) => {
    if (url.includes('/orders')) return { body: page([PACKAGE()]) };
    if (url.includes('/questions/filter')) return { body: page([QUESTION()]) };
    if (url.endsWith('/qna/sellers/123/questions/456/answers') && init.method === 'POST') return { body: 'Cevabınız başarıyla kaydedilmiştir.' };
    return undefined;
  });
  const { c, store, orderChat, qChat } = setup();
  await c.start();
  const r = await c.sendText('q-456', 'Merhaba, ürünümüz %100 pamuktur.');
  const post = calls.find((x) => x.method === 'POST')!;
  assert.equal(post.url, 'https://apigw.trendyol.com/integration/qna/sellers/123/questions/456/answers');
  assert.deepEqual(JSON.parse(post.body!), { text: 'Merhaba, ürünümüz %100 pamuktur.' });
  assert.equal(post.headers['content-type'], 'application/json');
  const sent = store.getMessage(`${qChat}#${r.remoteId}`)!;
  assert.equal(sent.fromMe, true);
  assert.equal(sent.text, 'Merhaba, ürünümüz %100 pamuktur.');
  assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).status, 'ANSWERED');

  await assert.rejects(() => c.sendText('q-456', 'kısa'), /en az 10 karakter/);

  const note = await c.sendText('order-80249000', 'Kargo yarın çıkacak');
  assert.equal(store.getMessage(`${orderChat}#${note.remoteId}`)?.text, '📝 Kargo yarın çıkacak');
  assert.equal(calls.filter((x) => x.method === 'POST').length, 1, 'sipariş notu ağa gitmez');
  await c.stop();
});

test('401 → "kimlik bilgileri reddedildi" hata durumu', async () => {
  fakeFetch(() => ({ status: 401, body: { errors: [{ message: 'Unauthorized' }] } }));
  const { c, account } = setup();
  await c.start();
  assert.equal(account.status, 'error');
  assert.equal(account.detail, 'Trendyol kimlik bilgileri reddedildi');
});

test('429 ilk yoklamada bağlantıyı düşürmez; 404 gelirse eski sapigw geçidine düşer', async () => {
  const calls = fakeFetch((url) => {
    if (url.startsWith('https://apigw.trendyol.com/')) return { status: 404, body: '' };
    if (url.includes('api.trendyol.com/sapigw/suppliers/123/orders')) return { status: 429, body: '' };
    if (url.includes('api.trendyol.com/sapigw/suppliers/123/questions/filter')) return { body: page([QUESTION()]) };
    return undefined;
  });
  const { c, account, store, qChat } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.ok(calls.some((x) => x.url.startsWith('https://api.trendyol.com/sapigw/suppliers/123/orders')), 'yedek geçit denendi');
  assert.ok(store.getChat(qChat), 'yedek geçitten gelen soru işlendi');
  await c.stop();
});
