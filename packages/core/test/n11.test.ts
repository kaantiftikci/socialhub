import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-n11-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { N11Connector, parseConfig, parseDate, xmlBlocks, xmlText } = await import('../src/connectors/n11.js');

const CONFIG = JSON.stringify({ orders: true, appKey: 'my-app-key-1234', appSecret: 'my-secret' });
const NOW = Date.now();

// ---- n11 dokümanındaki örneklere benzer sahte yanıtlar ----
const PACKAGE = (over: Record<string, unknown> = {}) => ({
  orderNumber: '203872347637',
  id: '112999455244259',
  customerfullName: 'Ayşe Yılmaz',
  customerEmail: 'ayse@example.com',
  cargoTrackingNumber: '',
  cargoProviderName: 'MNG Kargo',
  cargoTrackingLink: '',
  shipmentPackageStatus: 'Created',
  shipmentMethod: 1,
  orderDate: NOW - 3_600_000,
  lastModifiedDate: NOW - 3_600_000,
  totalAmount: 585.6,
  totalDiscountAmount: 5.8,
  shipmentAddress: { firstName: 'Ayşe', lastName: 'Yılmaz', company: '', address1: 'Bağdat Cad. No:1', district: 'Kadıköy', city: 'İstanbul', gsm: '5551112233' },
  lines: [{ quantity: 2, productName: 'Erkek Spor Ayakkabı', price: 292.8, sellerDiscount: 2.9, orderLineId: 415490391, orderItemLineItemStatusName: 'Created', stockCode: 'AYK-01', totalAmount: 585.6 }],
  ...over,
});
const page = (content: unknown[]) => ({ pageCount: 1, totalPages: 1, page: 0, size: 100, content });

const ENV = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const LIST = (answer = '') =>
  ENV(
    `<ns3:GetProductQuestionListResponse xmlns:ns3="http://www.n11.com/ws/schemas"><result><status>success</status></result>` +
      `<productQuestions><productQuestion><id>456</id><productId>789</productId><productTitle>Erkek Spor Ayakkabı Uzun Açıklamalı Ürün Adı Burada</productTitle>` +
      `<questionSubject>Ürün özellikleri</questionSubject><question>Bu ürün 43 numara &amp; geniş kalıp mı?</question><answer>${answer}</answer><images/></productQuestion></productQuestions>` +
      `<pagingData><currentPage>0</currentPage><pageSize>50</pageSize><totalCount>1</totalCount><pageCount>1</pageCount></pagingData></ns3:GetProductQuestionListResponse>`,
  );
const DETAIL = (answer = '') =>
  ENV(
    `<ns3:GetProductQuestionDetailResponse xmlns:ns3="http://www.n11.com/ws/schemas"><result><status>success</status></result>` +
      `<productQuestion><productId>789</productId><productTitle>Erkek Spor Ayakkabı Uzun Açıklamalı Ürün Adı Burada</productTitle><questionSubject>Ürün özellikleri</questionSubject>` +
      `<question>Bu ürün 43 numara &amp; geniş kalıp mı?</question><answer>${answer}</answer><fullName>Mehmet K.</fullName><email>mehmet@example.com</email>` +
      `<status>${answer ? 'ANSWERED' : 'WAITING_FOR_ANSWER'}</status><questionDate>24/08/2026 14:05</questionDate><answeredDate>${answer ? '25/08/2026 09:00' : ''}</answeredDate></productQuestion></ns3:GetProductQuestionDetailResponse>`,
  );
const SAVE_OK = ENV(`<ns3:SaveProductAnswerResponse xmlns:ns3="http://www.n11.com/ws/schemas"><result><status>success</status></result></ns3:SaveProductAnswerResponse>`);
const SAVE_FAIL = ENV(`<ns3:SaveProductAnswerResponse xmlns:ns3="http://www.n11.com/ws/schemas"><result><status>failure</status><errorCode>QUESTION_ALREADY_ANSWERED</errorCode><errorMessage>Soru zaten cevaplanmış</errorMessage></result></ns3:SaveProductAnswerResponse>`);

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
/** globalThis.fetch'i sahte yanıtlarla değiştirir; yapılan çağrıları toplar. SOAP işlemleri gövdedeki `<sch:XRequest>` adıyla ayrılır. */
function fakeFetch(handler: (url: string, op: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const h = (init.headers ?? {}) as Record<string, string>;
    const body = init.body as string | undefined;
    const op = /<sch:(\w+)Request>/.exec(body ?? '')?.[1] ?? '';
    calls.push({ url, method: init.method ?? 'GET', headers: h, body });
    const res = handler(url, op, init) ?? { status: 404, body: '' };
    const status = res.status ?? 200;
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(text, { status, headers: { 'content-type': text.startsWith('<') ? 'text/xml' : 'application/json' } });
  }) as typeof fetch;
  return calls;
}

let n = 0;
function setup(config = CONFIG) {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `n11:t${n}`, platform: 'n11' as const, label: 'n11', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new N11Connector(account, store, config);
  return { store, account, c, orderChat: `${account.id}/order-203872347637`, qChat: `${account.id}/q-456` };
}

test('parseConfig / parseDate / xml yardımcıları', () => {
  assert.equal(parseConfig('{}'), undefined);
  assert.equal(parseConfig('bozuk'), undefined);
  assert.equal(parseConfig('{"appKey":"a"}'), undefined);
  assert.deepEqual(parseConfig(JSON.stringify({ orders: true, appkey: ' a ', appsecret: 'b' })), { appKey: 'a', appSecret: 'b' });
  assert.equal(parseDate('24/08/2026 14:05'), new Date(2026, 7, 24, 14, 5).getTime());
  assert.equal(parseDate('24/08/2026'), new Date(2026, 7, 24).getTime());
  assert.equal(parseDate(1724323386203), 1724323386203);
  assert.equal(parseDate(1724323386), 1724323386000);
  assert.equal(parseDate(''), undefined);
  const xml = '<ns2:productQuestions><ns2:productQuestion><ns2:id>1</ns2:id><ns2:productId>9</ns2:productId><ns2:question>A &amp; B</ns2:question></ns2:productQuestion><ns2:productQuestion><ns2:id>2</ns2:id></ns2:productQuestion></ns2:productQuestions>';
  const blocks = xmlBlocks(xml, 'productQuestion');
  assert.equal(blocks.length, 2, 'productQuestions sarmalayıcısı bloğa sayılmaz');
  assert.equal(xmlText(blocks[0], 'id'), '1', 'productId, id sayılmaz');
  assert.equal(xmlText(blocks[0], 'question'), 'A & B');
  assert.equal(xmlText(blocks[1], 'question'), undefined);
});

test('bozuk yapılandırma → error durumu, ağ isteği yok', async () => {
  const calls = fakeFetch(() => ({ body: page([]) }));
  const { c, account } = setup('{"appKey":"x"}');
  await c.start();
  assert.equal(account.status, 'error');
  assert.equal(account.detail, 'n11 App Key / App Secret girilmedi');
  assert.equal(calls.length, 0);
});

test('ilk yoklama: REST sipariş sohbeti + yeni sipariş mesajı; SOAP soru sohbeti unread=1; kimlik başlıkları ve zarf', async () => {
  const calls = fakeFetch((url, op) => {
    if (url.startsWith('https://api.n11.com/rest/delivery/v1/shipmentPackages?')) return { body: page([PACKAGE()]) };
    if (url === 'https://api.n11.com/ws/productService/' && op === 'GetProductQuestionList') return { body: LIST() };
    if (url === 'https://api.n11.com/ws/productService/' && op === 'GetProductQuestionDetail') return { body: DETAIL() };
    return undefined;
  });
  const { c, store, account, orderChat, qChat } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.equal(account.label, 'n11 · my-app-k…');

  // REST istek: appkey/appsecret başlıkları, 14 günlük pencere, size 100, status yok
  const orderCall = calls.find((x) => x.url.includes('/shipmentPackages'))!;
  assert.equal(orderCall.headers.appkey, 'my-app-key-1234');
  assert.equal(orderCall.headers.appsecret, 'my-secret');
  const u = new URL(orderCall.url);
  assert.equal(u.searchParams.get('size'), '100');
  assert.equal(u.searchParams.get('orderByDirection'), 'DESC');
  assert.equal(u.searchParams.get('status'), null);
  const start = Number(u.searchParams.get('startDate'));
  const end = Number(u.searchParams.get('endDate'));
  assert.ok(end - start <= 14 * 86_400_000 && end - start > 13 * 86_400_000, 'pencere ~14 gün');

  // SOAP zarf: auth + paging; ayrıntı çağrısı yapıldı
  const list = calls.find((x) => x.body?.includes('GetProductQuestionListRequest'))!;
  assert.equal(list.method, 'POST');
  assert.match(list.headers['content-type'], /text\/xml/);
  assert.match(list.body!, /<sch:auth><sch:appKey>my-app-key-1234<\/sch:appKey><sch:appSecret>my-secret<\/sch:appSecret><\/sch:auth>/);
  assert.match(list.body!, /<sch:pagingData><sch:currentPage>0<\/sch:currentPage><sch:pageSize>50<\/sch:pageSize><\/sch:pagingData>/);
  assert.match(list.body!, /xmlns:sch="http:\/\/www\.n11\.com\/ws\/schemas"/);
  const detail = calls.find((x) => x.body?.includes('GetProductQuestionDetailRequest'))!;
  assert.match(detail.body!, /<sch:productQuestionId>456<\/sch:productQuestionId>/);

  // sipariş sohbeti
  const chat = store.getChat(orderChat)!;
  assert.equal(chat.name, '#203872347637 · Ayşe Yılmaz');
  assert.equal(chat.unread, 1, 'açık sipariş ilgi bekliyor');
  assert.equal(chat.handle, '5551112233');
  const order = chat.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(order.id, '203872347637');
  assert.equal(order.status, 'Created');
  assert.equal(order.statusLabel, 'Sipariş oluşturuldu');
  assert.equal(order.currency, 'TRY');
  assert.equal(order.totals.total, 585.6);
  assert.equal(order.totals.discount, 5.8);
  assert.deepEqual(order.items[0], { title: 'Erkek Spor Ayakkabı', quantity: 2, total: 585.6, sku: 'AYK-01', status: 'Created', selection: [], lineId: 415490391 });
  assert.equal(order.shipping.name, 'Ayşe Yılmaz');
  assert.equal(order.shipping.address, 'Bağdat Cad. No:1, Kadıköy, İstanbul');
  assert.equal(order.fulfillments[0].company, 'MNG Kargo');
  assert.equal(order.fulfillments[0].trackingNumber, undefined);
  const msgs = store.listMessages(orderChat);
  assert.equal(msgs.length, 1, 'Created durumu ayrı mesaj üretmez');
  assert.equal(msgs[0].fromMe, false);
  assert.equal(msgs[0].text, '🛍️ Yeni sipariş #203872347637 — 585,60 ₺\n• 2 × Erkek Spor Ayakkabı — 585,60 ₺\nTeslimat: Bağdat Cad. No:1, Kadıköy, İstanbul\nTelefon: 5551112233');
  assert.equal(msgs[0].ts, NOW - 3_600_000);

  // soru sohbeti
  const q = store.getChat(qChat)!;
  assert.equal(q.name, 'Soru · Erkek Spor Ayakkabı Uzun Açıklamalı Ürü…');
  assert.equal(q.unread, 1);
  assert.equal(q.participants?.[0].name, 'Mehmet K.');
  assert.equal(q.link, 'https://www.n11.com/urun/789');
  const qm = store.getChat(qChat)!.meta?.question as Record<string, unknown>;
  assert.equal(qm.status, 'WAITING_FOR_ANSWER');
  assert.equal(qm.buyerEmail, 'mehmet@example.com');
  const qmsgs = store.listMessages(qChat);
  assert.equal(qmsgs.length, 1);
  assert.equal(qmsgs[0].fromMe, false);
  assert.equal(qmsgs[0].text, 'Ürün özellikleri\nBu ürün 43 numara & geniş kalıp mı?');
  assert.equal(qmsgs[0].ts, new Date(2026, 7, 24, 14, 5).getTime());

  // durum dosyası
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', account.id, 'n11-state.json'), 'utf8'));
  assert.ok(st.seen['order-203872347637'] && st.seen['q-456'] && st.questions['456'].fullName === 'Mehmet K.');
  await c.stop();
});

test('ikinci yoklama: değişmeyen sipariş/soru mesaj üretmez ve ayrıntı yeniden çekilmez; kargoya verilince 📦, cevaplanınca fromMe cevap', async () => {
  let shipped = false;
  const calls = fakeFetch((url, op) => {
    if (url.includes('/shipmentPackages')) return { body: page([shipped ? PACKAGE({ shipmentPackageStatus: 'Shipped', cargoTrackingNumber: '7240011111', cargoTrackingLink: 'https://kargo/7240011111', lastModifiedDate: NOW }) : PACKAGE()]) };
    if (op === 'GetProductQuestionList') return { body: LIST(shipped ? 'Evet, geniş kalıptır.' : '') };
    if (op === 'GetProductQuestionDetail') return { body: DETAIL(shipped ? 'Evet, geniş kalıptır.' : '') };
    return undefined;
  });
  const { c, store, orderChat, qChat } = setup();
  const priv = c as unknown as { poll(first: boolean): Promise<void> };
  await c.start();
  const before = store.listMessages(orderChat).length + store.listMessages(qChat).length;
  const details = () => calls.filter((x) => x.body?.includes('GetProductQuestionDetailRequest')).length;
  assert.equal(details(), 1);
  await priv.poll(false);
  assert.equal(store.listMessages(orderChat).length + store.listMessages(qChat).length, before, 'değişmeyen kayıt tekrar mesaj üretmemeli');
  assert.equal(details(), 1, 'liste imzası aynıyken ayrıntı çekilmez');

  shipped = true;
  await priv.poll(false);
  const om = store.listMessages(orderChat).sort((a, b) => a.ts - b.ts);
  assert.equal(om.length, 2);
  assert.ok(om[1].fromMe);
  assert.equal(om[1].text, '📦 Kargoya verildi · MNG Kargo · takip: 7240011111\nhttps://kargo/7240011111');
  const order = store.getChat(orderChat)!.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(order.status, 'Shipped');
  assert.equal(order.fulfillments[0].trackingNumber, '7240011111');
  assert.equal(order.fulfillments[0].trackingUrl, 'https://kargo/7240011111');
  assert.equal(details(), 2, 'cevap gelince ayrıntı yenilendi');
  const qm = store.listMessages(qChat).sort((a, b) => a.ts - b.ts);
  assert.equal(qm.length, 2);
  assert.equal(qm[1].fromMe, true);
  assert.equal(qm[1].text, 'Evet, geniş kalıptır.');
  assert.equal(qm[1].ts, new Date(2026, 7, 25, 9, 0).getTime());
  assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).status, 'ANSWERED');
  await c.stop();
});

test('sendText: soru sohbetinde SaveProductAnswer zarfı + fromMe mesaj; başarısız sonuç hata; sipariş sohbetinde yerel not', async () => {
  let fail = false;
  const calls = fakeFetch((url, op) => {
    if (url.includes('/shipmentPackages')) return { body: page([PACKAGE()]) };
    if (op === 'GetProductQuestionList') return { body: LIST() };
    if (op === 'GetProductQuestionDetail') return { body: DETAIL() };
    if (op === 'SaveProductAnswer') return { body: fail ? SAVE_FAIL : SAVE_OK };
    return undefined;
  });
  const { c, store, orderChat, qChat } = setup();
  await c.start();
  const r = await c.sendText('q-456', 'Merhaba, ürün geniş kalıptır & 43 numara mevcut.');
  const post = calls.find((x) => x.body?.includes('SaveProductAnswerRequest'))!;
  assert.equal(post.url, 'https://api.n11.com/ws/productService/');
  assert.match(post.body!, /<sch:productQuestionId>456<\/sch:productQuestionId><sch:answer>Merhaba, ürün geniş kalıptır &amp; 43 numara mevcut\.<\/sch:answer>/);
  const sent = store.getMessage(`${qChat}#${r.remoteId}`)!;
  assert.equal(sent.fromMe, true);
  assert.equal(sent.text, 'Merhaba, ürün geniş kalıptır & 43 numara mevcut.');
  assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).status, 'ANSWERED');

  fail = true;
  await assert.rejects(() => c.sendText('q-456', 'Tekrar cevap'), /Soru zaten cevaplanmış/);
  await assert.rejects(() => c.sendText('q-456', '   '), /boş olamaz/);

  const saves = calls.filter((x) => x.body?.includes('SaveProductAnswerRequest')).length;
  const note = await c.sendText('order-203872347637', 'Kargo yarın çıkacak');
  assert.equal(store.getMessage(`${orderChat}#${note.remoteId}`)?.text, '📝 Kargo yarın çıkacak');
  assert.equal(calls.filter((x) => x.body?.includes('SaveProductAnswerRequest')).length, saves, 'sipariş notu ağa gitmez');
  await c.stop();
});

test('401 → "kimlik bilgileri reddedildi" hata durumu', async () => {
  fakeFetch(() => ({ status: 401, body: { message: 'Unauthorized' } }));
  const { c, account } = setup();
  await c.start();
  assert.equal(account.status, 'error');
  assert.equal(account.detail, 'n11 kimlik bilgileri reddedildi');
});

test('429 ilk yoklamada bağlantıyı düşürmez; SOAP çökse de siparişler işlenir', async () => {
  fakeFetch((url, op) => {
    if (url.includes('/shipmentPackages')) return { body: page([PACKAGE()]) };
    if (op === 'GetProductQuestionList') return { status: 429, body: '' };
    return undefined;
  });
  const { c, account, store, orderChat } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.ok(store.getChat(orderChat), 'sipariş işlendi');
  await c.stop();
});

test('status parametresiz istek 400 verirse durum durum sorgulanır ve seçim kalıcı olur', async () => {
  const calls = fakeFetch((url, op) => {
    if (url.includes('/shipmentPackages')) {
      const st = new URL(url).searchParams.get('status');
      if (!st) return { status: 400, body: { errors: [{ message: 'status is required' }] } };
      return { body: page(st === 'Created' ? [PACKAGE()] : []) };
    }
    if (op === 'GetProductQuestionList') return { body: LIST().replace(/<productQuestions>.*<\/productQuestions>/, '<productQuestions/>') };
    return undefined;
  });
  const { c, account, store, orderChat } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.ok(store.getChat(orderChat));
  const statuses = calls.filter((x) => x.url.includes('/shipmentPackages')).map((x) => new URL(x.url).searchParams.get('status'));
  assert.deepEqual(statuses, [null, 'Created', 'Picking', 'Shipped', 'Cancelled', 'Delivered', 'UnPacked', 'UnSupplied']);
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', account.id, 'n11-state.json'), 'utf8'));
  assert.equal(st.perStatus, true);
  await c.stop();
});
