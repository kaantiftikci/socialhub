import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri (amazon-state.json) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-amazon-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { AmazonConnector, parseAmazonConfig, marketplaceOf, fromOrderV2, messagingActionNames, MESSAGE_TEMPLATES } = await import('../src/connectors/amazon.js');
const { bus } = await import('../src/bus.js');

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
const CFG = { orders: true, clientId: 'amzn1.application-oa2-client.x', clientSecret: 'sec', refreshToken: 'Atzr|x' };
function setup(config: J = CFG) {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `amazon:t${n}`, platform: 'amazon' as const, label: 'Amazon', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new AmazonConnector(account, store, JSON.stringify({ orders: true, ...config }));
  return { store, account, c, priv: c as unknown as { poll(first: boolean): Promise<void> } };
}

/** Orders API v0 sipariş örneğine benzer sabit */
function order(over: J = {}): J {
  return {
    AmazonOrderId: '403-1234567-7654321',
    PurchaseDate: '2026-09-20T07:15:00Z',
    LastUpdateDate: '2026-09-20T07:15:00Z',
    OrderStatus: 'Unshipped',
    FulfillmentChannel: 'MFN',
    SalesChannel: 'Amazon.com.tr',
    OrderTotal: { CurrencyCode: 'TRY', Amount: '1234.50' },
    NumberOfItemsShipped: 0,
    NumberOfItemsUnshipped: 2,
    MarketplaceId: 'A33AVAJ2PDY3EV',
    BuyerInfo: { BuyerEmail: 'abc123@marketplace.amazon.com.tr', BuyerName: 'Bob Norman' },
    ShippingAddress: { Name: 'Bob Norman', AddressLine1: 'Bağdat Cad. 12', City: 'İstanbul', StateOrRegion: 'İstanbul', PostalCode: '34000', CountryCode: 'TR', Phone: '+905321234567' },
    ...over,
  };
}
const ITEMS = [{ OrderItemId: '1', Title: 'Keten Gömlek', ASIN: 'B0001', SellerSKU: 'GOM-M-BEJ', QuantityOrdered: 2, QuantityShipped: 0, ItemPrice: { CurrencyCode: 'TRY', Amount: '1200.00' } }];

interface Hit {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
/** fetch sahtesi: URL → yanıt; istekleri (yöntem, başlık, gövde) kaydeder */
function fakeFetch(handler: (url: string, hit: Hit) => { status?: number; body?: unknown; headers?: Record<string, string> }, hits: Hit[] = []) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit: Hit = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: typeof init?.body === 'string' ? init.body : undefined };
    hits.push(hit);
    const r = handler(url, hit);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return hits;
}

const LWA = 'https://api.amazon.com/auth/o2/token';
const EU = 'https://sellingpartnerapi-eu.amazon.com';
const lwaOk = { body: { access_token: 'Atza|access', token_type: 'bearer', expires_in: 3600, refresh_token: 'Atzr|x' } };

test('parseAmazonConfig: varsayılan Türkiye pazar yeri, bölge pazar yerinden türer', () => {
  const p = parseAmazonConfig(JSON.stringify(CFG));
  assert.equal(p.marketplace.id, 'A33AVAJ2PDY3EV');
  assert.equal(p.marketplace.host, 'sellercentral.amazon.com.tr');
  assert.equal(p.region, 'eu');
  assert.equal('messaging' in p, false, 'Seller Central köprüsü kaldırıldı');
  assert.equal(parseAmazonConfig(JSON.stringify({ orders: true, ...CFG, marketplaceId: 'ATVPDKIKX0DER' })).region, 'na');
  assert.equal(parseAmazonConfig(JSON.stringify({ orders: true, ...CFG, marketplaceId: 'A1VC38T7YXB528', region: 'eu' })).region, 'eu', 'açık bölge baskın');
  assert.equal(parseAmazonConfig('bozuk').clientId, '');
  assert.equal(marketplaceOf('A1PA6795UKMFR9').host, 'sellercentral-europe.amazon.com');
  assert.equal(marketplaceOf('bilinmiyor').host, 'sellercentral.amazon.com.tr');
});

test('eksik yapılandırma → error durumu', async () => {
  const { c, account } = setup({ clientId: 'x' });
  await c.start({ interactive: false });
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /Client ID \/ Client Secret \/ Refresh Token girilmedi/);
});

const V2_PATH = `${EU}/orders/2026-01-01/orders`;

test('siparişler (v0 yedeği: v2026 ucu 404): LWA belirteci, NextToken sayfalama, kalemler, sipariş sohbeti + mesajı; değişmeyen sipariş tekrar mesaj üretmez; durum olayları; şablonlu gönderim', async () => {
  const { c, store, account, priv } = setup();
  const second = order({ AmazonOrderId: '403-0000001-0000001', PurchaseDate: '2026-09-21T06:00:00Z', LastUpdateDate: '2026-09-21T09:00:00Z', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN', NumberOfItemsShipped: 2, NumberOfItemsUnshipped: 0 });
  const hits = fakeFetch((url, hit) => {
    if (url === LWA) {
      assert.equal(hit.method, 'POST');
      assert.match(hit.body ?? '', /grant_type=refresh_token&refresh_token=Atzr%7Cx&client_id=amzn1\.application-oa2-client\.x&client_secret=sec/);
      return lwaOk;
    }
    assert.equal(hit.headers['x-amz-access-token'], 'Atza|access', 'SP-API çağrıları LWA belirteciyle');
    if (url.startsWith(`${EU}/sellers/v1/marketplaceParticipations`)) return { body: { payload: [{ marketplace: { id: 'A33AVAJ2PDY3EV', countryCode: 'TR', name: 'Amazon.com.tr' } }] } };
    if (url.includes('/orderItems')) return { body: { payload: { AmazonOrderId: 'x', OrderItems: ITEMS } } };
    if (url.includes('NextToken=P2')) return { body: { payload: { Orders: [second] } } };
    if (url.startsWith(`${EU}/orders/v0/orders?`)) return { body: { payload: { Orders: [order()], NextToken: 'P2' } } };
    return { status: 404, body: { errors: [{ code: 'NotFound', message: 'Not Found' }] } };
  });
  await c.start({ interactive: false });
  assert.equal(account.status, 'connected');
  assert.equal(account.label, 'Amazon.com.tr');
  assert.equal(account.detail, 'Türkiye');
  const first = hits.find((h) => h.url.startsWith(`${EU}/orders/v0/orders?`))!;
  assert.match(first.url, /MarketplaceIds=A33AVAJ2PDY3EV/);
  assert.match(first.url, /CreatedAfter=\d{4}-/, 'ilk yoklama CreatedAfter (14 gün)');
  assert.ok(!first.url.includes('LastUpdatedAfter'), 'CreatedAfter ile LastUpdatedAfter birlikte olmaz');
  assert.ok(hits.some((h) => h.url.includes('NextToken=P2')), 'NextToken ile sonraki sayfa istendi');
  assert.equal(hits.filter((h) => h.url.includes('/orderItems')).length, 2, 'her yeni sipariş için kalemler');
  assert.equal(hits.filter((h) => h.url === LWA).length, 1, 'belirteç bir kez alındı, bellekte');
  assert.ok(hits.every((h) => !h.url.includes('sec') && !h.url.includes('Atza')), 'gizli değerler URL\'de değil');

  const cid = `${account.id}/order-403-1234567-7654321`;
  const chat = store.getChat(cid)!;
  assert.equal(chat.name, '#403-1234567-7654321 · Bob Norman');
  assert.equal(chat.unread, 1, 'açık (Unshipped) sipariş ilk görüldüğünde ilgi bekliyor');
  assert.equal(chat.handle, 'abc123@marketplace.amazon.com.tr');
  assert.equal(chat.link, 'https://sellercentral.amazon.com.tr/orders-v3/order/403-1234567-7654321');
  const meta = chat.meta?.order as J;
  assert.equal(meta.status, 'Unshipped');
  assert.equal(meta.statusLabel, 'kargolanacak');
  assert.equal(meta.totals.total, '1234.50');
  assert.equal(meta.currency, 'TRY');
  assert.deepEqual(meta.items[0], { title: 'Keten Gömlek', quantity: 2, total: '1200.00', sku: 'GOM-M-BEJ', asin: 'B0001', selection: [] });
  assert.match(meta.shipping.address, /Bağdat Cad\. 12, İstanbul/);
  assert.equal(meta.fulfillments[0].status, 'kargolanacak · Satıcı kargolar (FBM)');
  assert.ok(meta.messageTemplates.some((t: J) => t.type === 'confirmDeliveryDetails'));
  const msgs = store.listMessages(cid);
  assert.equal(msgs.length, 1, 'Unshipped ilk görüşte durum mesajı üretmez');
  assert.equal(msgs[0].fromMe, false);
  assert.match(msgs[0].text, /^🛍️ Yeni sipariş #403-1234567-7654321 — 1\.234,50 ₺ \(kargolanacak\)/);
  assert.match(msgs[0].text, /• 2 × Keten Gömlek — 1\.200,00 ₺/);
  assert.match(msgs[0].text, /Kargo: Satıcı kargolar \(FBM\)/);
  assert.match(msgs[0].text, /Telefon: \+905321234567/);

  const cid2 = `${account.id}/order-403-0000001-0000001`;
  const chat2 = store.getChat(cid2)!;
  assert.equal(chat2.unread, 0, 'kargolanmış sipariş ilgi beklemez');
  assert.deepEqual(
    store.listMessages(cid2).map((m) => [m.fromMe, m.text.split('\n')[0]]),
    [
      [false, '🛍️ Yeni sipariş #403-0000001-0000001 — 1.234,50 ₺ (kargolandı)'],
      [true, '📦 Kargoya verildi'],
    ],
  );
  assert.equal(store.listMessages(cid2)[1].ts, Date.parse('2026-09-21T09:00:00Z'), 'durum mesajı LastUpdateDate zamanında');

  // ikinci yoklama: LastUpdatedAfter ile; aynı siparişler yeni mesaj/kalem isteği üretmez
  assert.equal(hits.filter((h) => h.url.startsWith(V2_PATH)).length, 1, 'v2026 bir kez denendi, 404 → v0');
  hits.length = 0;
  await priv.poll(false);
  assert.ok(!hits.some((h) => h.url.startsWith(V2_PATH)), 'v0\'a dönüldükten sonra v2026 yeniden denenmez');
  assert.match(hits[0].url, /LastUpdatedAfter=\d{4}-/, 'değişenler için LastUpdatedAfter');
  assert.ok(!hits[0].url.includes('CreatedAfter'));
  assert.equal(hits.filter((h) => h.url.includes('/orderItems')).length, 0, 'görülmüş siparişler için kalem isteği yok');
  assert.equal(store.listMessages(cid).length, 1);
  assert.equal(store.listMessages(cid2).length, 2);

  // kargoya verildi ve iptal → durum olayları; kalemler depodan korunur
  fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.includes('/orderItems')) throw new Error('görülmüş sipariş için kalem istenmemeli');
    return { body: { payload: { Orders: [order({ OrderStatus: 'Shipped', LastUpdateDate: '2026-09-22T10:00:00Z', NumberOfItemsShipped: 2, NumberOfItemsUnshipped: 0 }), { ...second, OrderStatus: 'Canceled', LastUpdateDate: '2026-09-23T10:00:00Z' }] } } };
  });
  await priv.poll(false);
  const texts1 = store.listMessages(cid).map((m) => m.text.split('\n')[0]);
  assert.deepEqual(texts1, ['🛍️ Yeni sipariş #403-1234567-7654321 — 1.234,50 ₺ (kargolanacak)', '📦 Kargoya verildi']);
  assert.equal((store.getChat(cid)!.meta?.order as J).items.length, 1, 'kalemler korunur');
  assert.equal((store.getChat(cid)!.meta?.order as J).statusLabel, 'kargolandı');
  const texts2 = store.listMessages(cid2).map((m) => m.text.split('\n')[0]);
  assert.equal(texts2[2], '❌ Sipariş iptal edildi');
  assert.equal((store.getChat(cid2)!.meta?.order as J).status, 'Canceled');

  // durum dosyası: yeni bağlayıcı aynı siparişleri yeniden mesajlamaz
  const c2 = new AmazonConnector(account, store, JSON.stringify(CFG));
  await c2.start({ interactive: false });
  assert.equal(store.listMessages(cid).length, 2);
  await c2.stop();

  // yerel not (serbest metin şablonsuz gönderilemez)
  const r = await c.sendText('order-403-1234567-7654321', 'Müşteri aradı');
  assert.ok(r.remoteId.startsWith('note-'));
  assert.equal(store.listMessages(cid).pop()!.text, '📝 Müşteri aradı');

  // şablonlu gönderim: Messaging API
  const sent = fakeFetch((url, hit) => {
    if (url === LWA) return lwaOk;
    if (url.includes('/messaging/v1/orders/403-1234567-7654321/messages/confirmDeliveryDetails')) {
      assert.equal(hit.method, 'POST');
      assert.match(url, /marketplaceIds=A33AVAJ2PDY3EV/);
      assert.deepEqual(JSON.parse(hit.body ?? '{}'), { text: 'Kargonuz yarın teslim edilecek' });
      return { status: 201, body: {} };
    }
    return { status: 404, body: { errors: [{ code: 'NotFound', message: 'x' }] } };
  });
  await c.action('order-403-1234567-7654321', { kind: 'message', type: 'confirmDeliveryDetails', text: 'Kargonuz yarın teslim edilecek' });
  assert.ok(sent.some((h) => h.url.includes('/messages/confirmDeliveryDetails')));
  assert.equal(store.listMessages(cid).pop()!.text, '✉️ [Teslimat ayrıntılarını onayla] Kargonuz yarın teslim edilecek');
  await assert.rejects(c.action('order-403-1234567-7654321', { kind: 'message', type: 'invoice', text: 'x' }), /yalnız ek/);
  await assert.rejects(c.action('order-403-1234567-7654321', { kind: 'message', type: 'yok', text: 'x' }), /Bilinmeyen Amazon mesaj şablonu/);
  await c.stop();
  assert.equal(account.status, 'disconnected');
});

test('401 → belirteç yenilenir, yine 401 → error; LWA invalid_grant → error; 429 → Retry-After sonra yeniden dener', async () => {
  const { c, account } = setup();
  const hits = fakeFetch((url) => (url === LWA ? lwaOk : { status: 401, body: { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] } }));
  await c.start({ interactive: false });
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /reddedildi \(401\)/);
  assert.equal(hits.filter((h) => h.url === LWA).length, 2, '401 sonrası belirteç bir kez yenilendi');

  const s1 = setup();
  fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'The request has an invalid grant parameter' } }));
  await s1.c.start({ interactive: false });
  assert.equal(s1.account.status, 'error');
  assert.match(s1.account.detail ?? '', /LWA belirteci reddedildi \(invalid_grant\)/);

  const s2 = setup();
  let orderHits = 0;
  fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.includes('/sellers/')) return { body: { payload: [] } };
    if (url.includes('/orderItems')) return { body: { payload: { OrderItems: ITEMS } } };
    if (url.startsWith(V2_PATH)) return { status: 404, body: { errors: [{ code: 'NotFound', message: 'x' }] } };
    return ++orderHits === 1 ? { status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] }, headers: { 'retry-after': '1', 'x-amzn-ratelimit-limit': '0.0167' } } : { body: { payload: { Orders: [order()] } } };
  });
  await s2.c.start({ interactive: false });
  assert.equal(s2.account.status, 'connected');
  assert.equal(orderHits, 2, '429 sonrası bir kez yeniden denendi');
  assert.ok(s2.store.getChat(`${s2.account.id}/order-403-1234567-7654321`));
  await s2.c.stop();
});

// ───────────── Orders API v2026-01-01 ─────────────

/** orders_2026-01-01.json örneğine benzer sipariş */
function orderV2(over: J = {}): J {
  return {
    orderId: '403-1234567-7654321',
    createdTime: '2026-09-20T07:15:00Z',
    lastUpdatedTime: '2026-09-20T07:15:00Z',
    programs: ['PRIME'],
    salesChannel: { channelName: 'AMAZON', marketplaceId: 'A33AVAJ2PDY3EV', marketplaceName: 'Amazon.com.tr' },
    buyer: { buyerName: 'Bob Norman', buyerEmail: 'abc123@marketplace.amazon.com.tr' },
    recipient: { deliveryAddress: { name: 'Bob Norman', addressLine1: 'Bağdat Cad. 12', city: 'İstanbul', stateOrRegion: 'İstanbul', postalCode: '34000', countryCode: 'TR', phone: '+905000000099' } },
    proceeds: { grandTotal: { amount: '1234.50', currencyCode: 'TRY' } },
    fulfillment: { fulfillmentStatus: 'UNSHIPPED', fulfilledBy: 'MERCHANT', fulfillmentServiceLevel: 'STANDARD', shipByWindow: { latestDateTime: '2026-09-22T20:59:59Z' } },
    orderItems: [
      {
        orderItemId: '1',
        quantityOrdered: 2,
        product: { asin: 'B0001', title: 'Keten Gömlek', sellerSku: 'GOM-M-BEJ', price: { unitPrice: { amount: '600.00', currencyCode: 'TRY' } } },
        fulfillment: { quantityFulfilled: 0, quantityUnfulfilled: 2 },
      },
    ],
    ...over,
  };
}

test('fromOrderV2: v0 biçimine çevirir; durum eşlemesi, tüm paketler teslimse Delivered, satır toplamı', () => {
  const { order: o, items } = fromOrderV2(orderV2());
  assert.equal(o.AmazonOrderId, '403-1234567-7654321');
  assert.equal(o.OrderStatus, 'Unshipped');
  assert.equal(o.FulfillmentChannel, 'MFN');
  assert.equal(o.IsPrime, true);
  assert.deepEqual(o.OrderTotal, { CurrencyCode: 'TRY', Amount: '1234.50' });
  assert.equal(o.ShippingAddress.City, 'İstanbul');
  assert.equal(o.BuyerInfo.BuyerName, 'Bob Norman');
  assert.equal(o.NumberOfItemsUnshipped, 2);
  assert.equal(o.LatestShipDate, '2026-09-22T20:59:59Z');
  assert.deepEqual(items, [{ OrderItemId: '1', Title: 'Keten Gömlek', ASIN: 'B0001', SellerSKU: 'GOM-M-BEJ', QuantityOrdered: 2, ItemPrice: { CurrencyCode: 'TRY', Amount: '1200.00' } }]);
  assert.equal(fromOrderV2(orderV2({ fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'AMAZON' } })).order.OrderStatus, 'Canceled');
  assert.equal(fromOrderV2(orderV2({ fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'AMAZON' } })).order.FulfillmentChannel, 'AFN');
  const delivered = fromOrderV2(orderV2({ fulfillment: { fulfillmentStatus: 'SHIPPED' }, packages: [{ packageReferenceId: '1', packageStatus: { status: 'DELIVERED' }, carrier: 'Yurtiçi', trackingNumber: 'TR1' }] }));
  assert.equal(delivered.order.OrderStatus, 'Delivered');
  const partial = fromOrderV2(orderV2({ fulfillment: { fulfillmentStatus: 'SHIPPED' }, packages: [{ packageStatus: { status: 'DELIVERED' } }, { packageStatus: { status: 'IN_TRANSIT' } }] }));
  assert.equal(partial.order.OrderStatus, 'Shipped');
  // ITEM kırılımı birim fiyattan önce gelir; kalemsiz sipariş → items undefined
  const withProceeds = fromOrderV2(orderV2({ orderItems: [{ orderItemId: '2', quantityOrdered: 1, product: { title: 'X' }, proceeds: { breakdowns: [{ type: 'ITEM', subtotal: { amount: '99.90', currencyCode: 'TRY' } }] } }] }));
  assert.equal(withProceeds.items![0].ItemPrice.Amount, '99.90');
  assert.equal(fromOrderV2(orderV2({ orderItems: undefined })).items, undefined);
  // PII yoksa alıcı/adres yok → ingest "Amazon alıcısı" der
  const noPii = fromOrderV2(orderV2({ buyer: undefined, recipient: undefined }));
  assert.equal(noPii.order.BuyerInfo, undefined);
  assert.equal(noPii.order.ShippingAddress, undefined);
});

test('siparişler v2026: searchOrders (createdAfter, includedData, paginationToken), kalemler yanıttan (ayrı istek yok), v0 hiç çağrılmaz; paket takibi', async () => {
  const { c, store, account, priv } = setup();
  const second = orderV2({ orderId: '403-0000001-0000001', createdTime: '2026-09-21T06:00:00Z', lastUpdatedTime: '2026-09-21T09:00:00Z', fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'AMAZON' }, packages: [{ packageReferenceId: '1', packageStatus: { status: 'IN_TRANSIT' }, carrier: 'Aras', trackingNumber: 'AR123', shipTime: '2026-09-21T09:00:00Z' }] });
  const hits = fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.startsWith(`${EU}/sellers/`)) return { body: { payload: [] } };
    if (url.startsWith(`${V2_PATH}?`)) {
      const u = new URL(url);
      if (u.searchParams.get('paginationToken') === 'P2') return { body: { orders: [second] } };
      return { body: { orders: [orderV2()], pagination: { nextToken: 'P2' } } };
    }
    return { status: 404, body: { errors: [{ code: 'NotFound', message: 'x' }] } };
  });
  await c.start({ interactive: false });
  assert.equal(account.status, 'connected', account.detail);
  const v2 = hits.filter((h) => h.url.startsWith(V2_PATH));
  assert.equal(v2.length, 2);
  const u1 = new URL(v2[0].url);
  assert.equal(u1.searchParams.get('marketplaceIds'), 'A33AVAJ2PDY3EV');
  assert.match(u1.searchParams.get('createdAfter') ?? '', /^\d{4}-/);
  assert.equal(u1.searchParams.get('lastUpdatedAfter'), null, 'createdAfter ile lastUpdatedAfter birlikte olmaz');
  assert.equal(u1.searchParams.get('maxResultsPerPage'), '100');
  assert.equal(u1.searchParams.get('includedData'), 'BUYER,RECIPIENT,PROCEEDS,FULFILLMENT,PACKAGES');
  const u2 = new URL(v2[1].url);
  assert.equal(u2.searchParams.get('paginationToken'), 'P2');
  assert.ok(u2.searchParams.get('createdAfter'), 'sonraki sayfada da aynı süzgeç');
  assert.ok(!hits.some((h) => h.url.includes('/orders/v0/')), 'v0 çağrılmadı');

  const cid = `${account.id}/order-403-1234567-7654321`;
  const meta = store.getChat(cid)!.meta?.order as J;
  assert.equal(store.getChat(cid)!.name, '#403-1234567-7654321 · Bob Norman');
  assert.equal(meta.status, 'Unshipped');
  assert.deepEqual(meta.items[0], { title: 'Keten Gömlek', quantity: 2, total: '1200.00', sku: 'GOM-M-BEJ', asin: 'B0001', selection: [] });
  assert.equal(meta.isPrime, true);
  const cid2 = `${account.id}/order-403-0000001-0000001`;
  const meta2 = store.getChat(cid2)!.meta?.order as J;
  assert.deepEqual(meta2.fulfillments[0], { status: 'yolda', company: 'Aras', trackingNumber: 'AR123', date: '2026-09-21T09:00:00Z' });
  assert.deepEqual(store.listMessages(cid2).map((m) => m.text.split('\n')[0]), ['🛍️ Yeni sipariş #403-0000001-0000001 — 1.234,50 ₺ (kargolandı)', '📦 Kargoya verildi']);

  // sonraki yoklama: lastUpdatedAfter; paketler teslim edildi → Delivered olayı
  const later = fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.startsWith(`${V2_PATH}?`)) return { body: { orders: [{ ...second, lastUpdatedTime: '2026-09-23T10:00:00Z', packages: [{ ...second.packages[0], packageStatus: { status: 'DELIVERED' } }] }] } };
    return { status: 404, body: {} };
  });
  await priv.poll(false);
  const u3 = new URL(later.find((h) => h.url.startsWith(V2_PATH))!.url);
  assert.ok(u3.searchParams.get('lastUpdatedAfter'));
  assert.equal(u3.searchParams.get('createdAfter'), null);
  assert.equal(store.listMessages(cid2).at(-1)!.text, '📦 Teslim edildi');
  assert.equal((store.getChat(cid2)!.meta?.order as J).statusLabel, 'teslim edildi');
  await c.stop();
});

test('v2026: PII rolü yoksa (403) bir kez PII\'siz yeniden; yanıtta kalem yoksa getOrder (kalemler dahil)', async () => {
  const { c, store, account } = setup();
  const hits = fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.startsWith(`${EU}/sellers/`)) return { body: { payload: [] } };
    if (url.startsWith(`${V2_PATH}?`)) {
      if (new URL(url).searchParams.get('includedData')!.includes('BUYER')) return { status: 403, body: { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] } };
      return { body: { orders: [orderV2({ buyer: undefined, recipient: undefined, orderItems: undefined })] } };
    }
    if (url.startsWith(`${V2_PATH}/403-1234567-7654321?`)) return { body: { order: orderV2({ buyer: undefined, recipient: undefined }) } };
    return { status: 404, body: {} };
  });
  await c.start({ interactive: false });
  assert.equal(account.status, 'connected', account.detail);
  const v2 = hits.filter((h) => h.url.startsWith(`${V2_PATH}?`));
  assert.equal(v2.length, 2, 'önce PII ile, sonra PII\'siz');
  assert.equal(new URL(v2[1].url).searchParams.get('includedData'), 'PROCEEDS,FULFILLMENT,PACKAGES');
  const get = hits.find((h) => h.url.startsWith(`${V2_PATH}/403-1234567-7654321`))!;
  assert.equal(new URL(get.url).searchParams.get('includedData'), 'PROCEEDS,FULFILLMENT,PACKAGES');
  const chat = store.getChat(`${account.id}/order-403-1234567-7654321`)!;
  assert.equal(chat.name, '#403-1234567-7654321 · Amazon alıcısı');
  assert.equal((chat.meta?.order as J).items[0].title, 'Keten Gömlek');
  assert.ok(!hits.some((h) => h.url.includes('/orders/v0/')));
  await c.stop();
});

test('v2026 ucu 403 (PII\'siz de) → tek uyarıyla v0; v0 da 403 → hata', async () => {
  const warns: string[] = [];
  const off = bus.on((ev) => {
    if (ev.type === 'log' && ev.level === 'warn') warns.push(ev.text);
  });
  try {
    const { c, account, store } = setup();
    fakeFetch((url) => {
      if (url === LWA) return lwaOk;
      if (url.startsWith(`${EU}/sellers/`)) return { body: { payload: [] } };
      if (url.startsWith(V2_PATH)) return { status: 403, body: { errors: [{ code: 'Unauthorized', message: 'denied' }] } };
      if (url.includes('/orderItems')) return { body: { payload: { OrderItems: ITEMS } } };
      if (url.includes('/orders/v0/orders?')) return { body: { payload: { Orders: [order()] } } };
      return { status: 404, body: {} };
    });
    await c.start({ interactive: false });
    assert.equal(account.status, 'connected', account.detail);
    assert.ok(store.getChat(`${account.id}/order-403-1234567-7654321`));
    await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
    assert.equal(warns.filter((w) => /Orders API 2026-01-01 kullanılamadı/.test(w)).length, 1, 'tek uyarı');
    await c.stop();

    const s2 = setup();
    fakeFetch((url) => (url === LWA ? lwaOk : url.startsWith(`${EU}/sellers/`) ? { body: { payload: [] } } : { status: 403, body: { errors: [{ code: 'Unauthorized', message: 'denied' }] } }));
    await s2.c.start({ interactive: false });
    assert.equal(s2.account.status, 'error');
    assert.match(s2.account.detail ?? '', /yetkisi yok \(403\)/);
  } finally {
    off();
  }
});

test('Messaging API: şablon adları _embedded.actions[].payload.name / _links.actions[].name; digitalAccessKey ≤400; serbest metin yalnız sipariş sohbetinde', async () => {
  assert.deepEqual(
    messagingActionNames({
      _links: { self: { href: '/x' }, actions: [{ href: '/a', name: 'confirmDeliveryDetails' }, { href: '/b', name: 'unexpectedProblem' }] },
      _embedded: { actions: [{ _links: { self: { href: '/a' }, schema: { href: '/s', name: 'confirmDeliveryDetails' } }, payload: { name: 'confirmDeliveryDetails' } }, { _links: { self: { href: '/c', name: 'warranty' }, schema: { href: '/s' } } }] },
    }),
    ['confirmDeliveryDetails', 'warranty', 'unexpectedProblem'],
  );
  assert.deepEqual(messagingActionNames({}), []);
  assert.equal(MESSAGE_TEMPLATES.digitalAccessKey.max, 400);

  const { c, store, account } = setup();
  fakeFetch((url) => {
    if (url === LWA) return lwaOk;
    if (url.includes('/messaging/v1/orders/403-1234567-7654321?')) return { body: { _links: { self: { href: '/x' }, actions: [{ href: '/a', name: 'confirmOrderDetails' }] }, _embedded: { actions: [{ _links: { self: { href: '/a' }, schema: { href: '/s' } }, payload: { name: 'confirmOrderDetails' } }] } } };
    return { status: 404, body: {} };
  });
  await c.action('order-403-1234567-7654321', { kind: 'actions' });
  assert.deepEqual((store.getChat(`${account.id}/order-403-1234567-7654321`)!.meta?.order as J).messagingActions, ['confirmOrderDetails']);
  await assert.rejects(c.action('order-403-1234567-7654321', { kind: 'message', type: 'digitalAccessKey', text: 'x'.repeat(401) }), /en fazla 400/);
  await assert.rejects(c.sendText('thread-1', 'selam'), /desteklenmiyor/);
});
