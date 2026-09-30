import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri (shopify-state.json) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-shopify-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { ShopifyConnector, nextLink, parseShopifyConfig } = await import('../src/connectors/shopify.js');

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
function setup(config: J = { shop: 'mivelo-test', accessToken: 'shpat_x' }) {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `shopify:t${n}`, platform: 'shopify' as const, label: 'x', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new ShopifyConnector(account, store, JSON.stringify({ orders: true, ...config }));
  return { store, account, c, priv: c as unknown as { poll(first: boolean): Promise<void> } };
}

/** Shopify Admin REST sipariş örneğine benzer sabit */
function order(over: J = {}): J {
  return {
    id: 450789469,
    name: '#1001',
    order_number: 1001,
    email: 'bob.norman@example.com',
    phone: '+905321234567',
    created_at: '2026-09-20T10:15:00+03:00',
    updated_at: '2026-09-20T10:15:00+03:00',
    cancelled_at: null,
    closed_at: null,
    financial_status: 'paid',
    fulfillment_status: null,
    currency: 'TRY',
    total_price: '1234.50',
    subtotal_price: '1200.00',
    total_tax: '0.00',
    total_discounts: '0.00',
    note: 'Kapıya bırakın',
    tags: '',
    customer: { id: 207119551, first_name: 'Bob', last_name: 'Norman', email: 'bob.norman@example.com' },
    line_items: [{ id: 1, title: 'Keten Gömlek', variant_title: 'M / Bej', quantity: 2, price: '600.00', sku: 'GOM-M-BEJ' }],
    shipping_address: { name: 'Bob Norman', address1: 'Bağdat Cad. 12', city: 'İstanbul', province: 'İstanbul', zip: '34000', country: 'Türkiye', phone: '+905321234567' },
    shipping_lines: [{ price: '34.50' }],
    fulfillments: [],
    refunds: [],
    order_status_url: 'https://mivelo-test.myshopify.com/orders/abc/authenticate?key=1',
    ...over,
  };
}

/** fetch sahtesi: URL → yanıt; istenen adresleri kaydeder */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }, urls: string[] = []) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const r = handler(url);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return urls;
}

const ORDERS = 'https://mivelo-test.myshopify.com/admin/api/2026-07/orders.json';

test('parseShopifyConfig: mağaza tanıtıcısı ve ana bilgisayar türetilir', () => {
  assert.deepEqual(parseShopifyConfig('{"shop":"Magaza.myshopify.com","accessToken":" shpat_1 "}'), { handle: 'magaza', host: 'magaza.myshopify.com', token: 'shpat_1', clientId: '', clientSecret: '' });
  assert.deepEqual(parseShopifyConfig('{"shop":"https://magaza.myshopify.com/admin","clientId":" cid ","clientSecret":"csec","inbox":true}'), { handle: 'magaza', host: 'magaza.myshopify.com', token: '', clientId: 'cid', clientSecret: 'csec' }, 'eski inbox alanı yok sayılır');
  assert.equal(parseShopifyConfig('{"shop":"magaza","accessToken":"t"}').host, 'magaza.myshopify.com');
  assert.equal(parseShopifyConfig('bozuk').host, '');
});

test('nextLink: Link başlığından rel=next', () => {
  assert.equal(nextLink('<https://x.myshopify.com/admin/api/2025-07/orders.json?limit=50&page_info=abc>; rel="previous", <https://x.myshopify.com/admin/api/2025-07/orders.json?limit=50&page_info=def>; rel="next"'), 'https://x.myshopify.com/admin/api/2025-07/orders.json?limit=50&page_info=def');
  assert.equal(nextLink('<https://x/orders.json?page_info=abc>; rel="previous"'), undefined);
  assert.equal(nextLink(null), undefined);
});

test('eksik yapılandırma → error durumu', async () => {
  const { c, account } = setup({ shop: 'magaza' });
  await c.start({ interactive: false });
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /erişim belirteci\) girilmedi/);
});

test('siparişler: sayfalama (Link), sipariş sohbeti + mesajı, fulfillment mesajı; değişmeyen sipariş tekrar mesaj üretmez', async () => {
  const { c, store, account, priv } = setup();
  const second = order({ id: 450789470, name: '#1002', order_number: 1002, created_at: '2026-09-21T09:00:00+03:00', note: null, fulfillment_status: 'fulfilled', fulfillments: [{ id: 99, status: 'success', shipment_status: 'in_transit', tracking_company: 'Yurtiçi Kargo', tracking_number: 'YK123', tracking_url: 'https://yurticikargo.com/YK123', created_at: '2026-09-21T12:00:00+03:00' }] });
  const urls = fakeFetch((url) => {
    if (url.endsWith('/shop.json')) return { body: { shop: { name: 'Mivelo Test', email: 'kaan@example.com' } } };
    if (url.includes('page_info=P2')) return { body: { orders: [second] } };
    if (url.startsWith(ORDERS)) return { body: { orders: [order()] }, headers: { link: `<${ORDERS}?limit=50&page_info=P2>; rel="next"` } };
    return { status: 404, body: { errors: 'Not Found' } };
  });
  await c.start({ interactive: false });
  assert.equal(account.status, 'connected');
  assert.equal(account.label, 'Mivelo Test');
  assert.equal(account.detail, 'kaan@example.com');
  assert.ok(urls.some((u) => u.startsWith(`${ORDERS}?status=any&limit=50&order=created_at%20desc`)), 'ilk yoklama created_at desc');
  assert.ok(urls.some((u) => u.includes('page_info=P2')), 'Link başlığındaki sonraki sayfa istendi');
  assert.ok(urls.every((u) => !u.includes('shpat_')), 'belirteç URL\'de değil');

  const cid = `${account.id}/order-450789469`;
  const chat = store.getChat(cid)!;
  assert.equal(chat.name, '#1001 · Bob Norman');
  assert.equal(chat.unread, 1, 'açık sipariş ilk görüldüğünde ilgi bekliyor');
  assert.equal(chat.handle, '+905321234567');
  const meta = chat.meta?.order as J;
  assert.equal(meta.totals.total, '1234.50');
  assert.equal(meta.paymentStatus, 'paid');
  assert.deepEqual(meta.items[0], { title: 'Keten Gömlek', quantity: 2, total: '1200.00', sku: 'GOM-M-BEJ', selection: ['M / Bej'] });
  assert.match(meta.shipping.address, /Bağdat Cad\. 12, İstanbul/);
  const msgs = store.listMessages(cid);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].fromMe, false);
  assert.match(msgs[0].text, /^🛍️ Yeni sipariş #1001 — 1\.234,50 ₺ \(ödendi\)/);
  assert.match(msgs[0].text, /• 2 × Keten Gömlek \(M \/ Bej\) — 1\.200,00 ₺/);
  assert.match(msgs[0].text, /Not: Kapıya bırakın/);

  const cid2 = `${account.id}/order-450789470`;
  const chat2 = store.getChat(cid2)!;
  assert.equal(chat2.unread, 0, 'tamamlanmış sipariş ilgi beklemez');
  const msgs2 = store.listMessages(cid2);
  assert.deepEqual(msgs2.map((m) => [m.fromMe, m.text.split('\n')[0]]), [
    [false, '🛍️ Yeni sipariş #1002 — 1.234,50 ₺ (ödendi)'],
    [true, '📦 Yolda · Yurtiçi Kargo · takip: YK123'],
  ]);
  assert.ok(msgs2[1].text.includes('https://yurticikargo.com/YK123'));
  assert.equal((chat2.meta?.order as J).fulfillments[0].trackingNumber, 'YK123');

  // ikinci yoklama: updated_at_min ile; aynı siparişler yeni mesaj üretmez
  urls.length = 0;
  await priv.poll(false);
  assert.ok(urls[0].includes('updated_at_min='), 'değişenler için updated_at_min');
  assert.equal(store.listMessages(cid).length, 1);
  assert.equal(store.listMessages(cid2).length, 2);

  // teslim edildi → yeni fulfillment mesajı; iade ve iptal olayları
  fakeFetch(() => ({
    body: {
      orders: [
        { ...second, fulfillments: [{ ...second.fulfillments[0], shipment_status: 'delivered', updated_at: '2026-09-23T12:00:00+03:00' }] },
        order({ cancelled_at: '2026-09-24T08:00:00+03:00', cancel_reason: 'customer', financial_status: 'refunded', refunds: [{ id: 5, created_at: '2026-09-24T08:01:00+03:00', note: 'Vazgeçti', transactions: [{ amount: '1234.50', kind: 'refund' }] }] }),
      ],
    },
  }));
  await priv.poll(false);
  const texts2 = store.listMessages(cid2).map((m) => m.text.split('\n')[0]);
  assert.equal(texts2.length, 3);
  assert.equal(texts2[2], '📦 Teslim edildi · Yurtiçi Kargo · takip: YK123');
  const texts1 = store.listMessages(cid).map((m) => m.text);
  assert.equal(texts1.length, 3);
  assert.ok(texts1.includes('↩️ İade 1.234,50 ₺ — Vazgeçti'));
  assert.ok(texts1.includes('❌ Sipariş iptal edildi (müşteri isteği)'));
  assert.equal((store.getChat(cid)!.meta?.order as J).status, 'cancelled');

  // durum dosyası: yeni bağlayıcı aynı siparişleri yeniden mesajlamaz
  const c2 = new ShopifyConnector(account, store, JSON.stringify({ orders: true, shop: 'mivelo-test', accessToken: 'shpat_x' }));
  await c2.start({ interactive: false });
  assert.equal(store.listMessages(cid).length, 3);
  await c2.stop();

  // yerel not
  const r = await c.sendText('order-450789469', 'Müşteri aradı');
  assert.ok(r.remoteId.startsWith('note-'));
  assert.equal(store.listMessages(cid).pop()!.text, '📝 Müşteri aradı');
  await c.stop();
  assert.equal(account.status, 'disconnected');
});

test('401 → "erişim belirteci reddedildi" hatası; 429 → Retry-After sonra yeniden dener', async () => {
  const { c, account } = setup();
  fakeFetch(() => ({ status: 401, body: { errors: '[API] Invalid API key or access token' } }));
  await c.start({ interactive: false });
  assert.equal(account.status, 'error');
  assert.equal(account.detail, 'Shopify erişim belirteci reddedildi');

  const s2 = setup();
  let hits = 0;
  fakeFetch((url) => {
    if (url.endsWith('/shop.json')) return { body: { shop: { name: 'S' } } };
    return ++hits === 1 ? { status: 429, body: { errors: 'Exceeded 2 calls per second' }, headers: { 'retry-after': '1' } } : { body: { orders: [order()] } };
  });
  await s2.c.start({ interactive: false });
  assert.equal(s2.account.status, 'connected');
  assert.equal(hits, 2, '429 sonrası bir kez yeniden denendi');
  assert.ok(s2.store.getChat(`${s2.account.id}/order-450789469`));
  await s2.c.stop();
});

test('Dev Dashboard uygulaması: client_credentials belirteci (form gövdesi), API 2026-07; süresi dolunca ve 401\'de yenilenir; red → hata', async () => {
  const hits: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let issued = 0;
  let rejectOnce = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    hits.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://mivelo-test.myshopify.com/admin/oauth/access_token') return json(200, { access_token: `tok${++issued}`, scope: 'read_orders', expires_in: 86_399 });
    if (rejectOnce && headers['x-shopify-access-token'] === `tok${issued}` && issued === 2) {
      rejectOnce = false;
      return json(401, { errors: '[API] Invalid API key or access token' });
    }
    if (url.endsWith('/shop.json')) return json(200, { shop: { name: 'Mivelo Test', email: 'ornek@example.com' } });
    if (url.includes('/orders.json')) return json(200, { orders: [] });
    return json(404, {});
  }) as typeof fetch;
  const { c, account, priv } = setup({ shop: 'mivelo-test', clientId: 'cid', clientSecret: 'csec' });
  await c.start({ interactive: false });
  assert.equal(account.status, 'connected', account.detail);
  const tokenReq = hits.filter((h) => h.url.endsWith('/admin/oauth/access_token'));
  assert.equal(tokenReq.length, 1, 'belirteç bir kez alındı, bellekte');
  assert.equal(tokenReq[0].method, 'POST');
  assert.equal(tokenReq[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenReq[0].body)), { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csec' });
  const api = hits.filter((h) => h.url.includes('/admin/api/'));
  assert.ok(api.length > 0 && api.every((h) => h.url.includes('/admin/api/2026-07/')), 'API sürümü 2026-07');
  assert.ok(api.every((h) => h.headers['x-shopify-access-token'] === 'tok1'));
  assert.ok(hits.every((h) => !h.url.includes('csec')), 'gizli anahtar URL\'de değil');

  // süre dolmak üzere (10 dk payı) → yoklama öncesi yenilenir
  (c as unknown as { issued: { token: string; expiresAt: number } }).issued.expiresAt = Date.now() + 5 * 60_000;
  hits.length = 0;
  await priv.poll(false);
  assert.equal(hits.filter((h) => h.url.endsWith('/access_token')).length, 1, 'bitmeden önce yenilendi');
  assert.ok(hits.filter((h) => h.url.includes('/orders.json')).every((h) => h.headers['x-shopify-access-token'] === 'tok2'));

  // 401 → bir kez yeniden alınır, istek yinelenir
  rejectOnce = true;
  hits.length = 0;
  await priv.poll(false);
  assert.equal(hits.filter((h) => h.url.endsWith('/access_token')).length, 1, '401 sonrası yenilendi');
  assert.equal(hits.filter((h) => h.url.includes('/orders.json')).at(-1)!.headers['x-shopify-access-token'], 'tok3');
  await c.stop();

  // istemci kimliği reddi
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const s2 = setup({ shop: 'mivelo-test', clientId: 'cid', clientSecret: 'yanlis' });
  await s2.c.start({ interactive: false });
  assert.equal(s2.account.status, 'error');
  assert.match(s2.account.detail ?? '', /istemci kimliği \/ gizli anahtarı reddedildi \(invalid_client\)/);

  // eksik yapılandırma
  const s3 = setup({ shop: 'mivelo-test' });
  await s3.c.start({ interactive: false });
  assert.equal(s3.account.status, 'error');
  assert.match(s3.account.detail ?? '', /istemci kimliği \+ gizli anahtar/);
});

test('Inbox köprüsü yok: sipariş dışı sohbete gönderim açık hata', async () => {
  const { c } = setup();
  await assert.rejects(c.sendText('conv-1', 'selam'), /Shopify Inbox desteklenmiyor/);
});
