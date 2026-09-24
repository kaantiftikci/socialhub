import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

// Oturum klasörleri (shopify-state.json) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-shopify-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { ShopifyConnector, combineStatus, nextLink, parseShopifyConfig } = await import('../src/connectors/shopify.js');
const { makeShopifyInbox, parseWhen, toMessages, _resetShopifyInboxState } = await import('../src/connectors/browser/shopify.js');

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
function setup(config: J = { shop: 'mivelo-test', accessToken: 'shpat_x', inbox: false }) {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `shopify:t${n}`, platform: 'shopify' as const, label: 'x', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new ShopifyConnector(account, store, JSON.stringify(config));
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

const ORDERS = 'https://mivelo-test.myshopify.com/admin/api/2025-07/orders.json';

test('parseShopifyConfig: mağaza tanıtıcısı ve ana bilgisayar türetilir', () => {
  assert.deepEqual(parseShopifyConfig('{"shop":"Magaza.myshopify.com","accessToken":" shpat_1 "}'), { handle: 'magaza', host: 'magaza.myshopify.com', token: 'shpat_1', inbox: true });
  assert.equal(parseShopifyConfig('{"shop":"https://magaza.myshopify.com/admin","accessToken":"t","inbox":false}').inbox, false);
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
  assert.match(account.detail ?? '', /erişim belirteci girilmedi/);
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
  const c2 = new ShopifyConnector(account, store, JSON.stringify({ shop: 'mivelo-test', accessToken: 'shpat_x', inbox: false }));
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

test('combineStatus: API baskın; Inbox durumu ayrıntıda', () => {
  assert.deepEqual(combineStatus({ status: 'error', detail: 'x' }, { status: 'connected' }), { status: 'error', detail: 'x' });
  assert.deepEqual(combineStatus({ status: 'connected', detail: 'a@b' }, undefined), { status: 'connected', detail: 'a@b' });
  assert.deepEqual(combineStatus({ status: 'connected' }, { status: 'pairing', detail: 'Giriş gerekli' }), { status: 'connected', detail: 'Inbox için Shopify\'a giriş gerekli (Yeniden bağlan)' });
  assert.deepEqual(combineStatus({ status: 'connected', detail: 'a@b' }, { status: 'connected' }), { status: 'connected', detail: 'a@b' });
  assert.equal(combineStatus({ status: 'connected' }, { status: 'error', detail: 'Chromium açılamadı' }).detail, 'Inbox: Chromium açılamadı');
});

// ───────────── Inbox stratejisi (sahte sayfa) ─────────────

test('parseWhen: göreli ve kısa zamanlar', () => {
  const now = new Date(2026, 8, 25, 15, 0).getTime();
  assert.equal(parseWhen('14:32', now), new Date(2026, 8, 25, 14, 32).getTime());
  assert.equal(parseWhen('Dün 09:05', now), new Date(2026, 8, 24, 9, 5).getTime());
  assert.equal(parseWhen('5 dk', now), now - 5 * 60_000);
  assert.equal(parseWhen('2 sa', now), now - 2 * 3_600_000);
  assert.equal(parseWhen('3 Eyl', now), new Date(2026, 8, 3, 12, 0).getTime());
  assert.equal(parseWhen('Sep 3', now), new Date(2026, 8, 3, 12, 0).getTime());
  assert.equal(parseWhen('2026-09-24T11:20:00Z', now), Date.parse('2026-09-24T11:20:00Z'));
  assert.equal(parseWhen('', now), undefined);
  assert.equal(parseWhen('Ayşe', now), undefined);
});

/** Sahte Inbox sayfası: evaluate çağrılarını etiketli argümanın `op` alanına göre yanıtlar */
function inboxPage(handle: string, threadId: string | undefined, data: { threads?: unknown[]; messages?: unknown[] }, ops: string[] = []): Page {
  const url = `https://admin.shopify.com/store/${handle}/apps/inbox${threadId ? `/conversations/${threadId}` : ''}`;
  return {
    url: () => url,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    frames: () => [],
    mainFrame: () => undefined,
    keyboard: { type: async () => undefined, press: async () => undefined },
    evaluate: async (_fn: unknown, arg?: { op?: string }) => {
      ops.push(arg?.op ?? '?');
      switch (arg?.op) {
        case 'probe':
          return true;
        case 'threads':
          return data.threads ?? [];
        case 'messages':
          return data.messages ?? [];
        case 'open':
        case 'focusComposer':
        case 'clickSend':
          return true;
        default:
          return false;
      }
    },
  } as unknown as Page;
}

test('shopify inbox: loggedIn URL\'ye bakar (admin/store → evet, accounts.shopify.com → hayır)', async () => {
  const s = makeShopifyInbox('mivelo-test', () => 'Mivelo Test');
  assert.equal(s.home, 'https://admin.shopify.com/store/mivelo-test/apps/inbox');
  assert.equal(await s.loggedIn({ url: () => 'https://admin.shopify.com/store/mivelo-test/apps/inbox' } as unknown as Page, {}, true), true);
  assert.equal(await s.loggedIn({ url: () => 'https://accounts.shopify.com/lookup?rid=1' } as unknown as Page, {}, true), false);
  assert.equal(await s.loggedIn({ url: () => 'about:blank' } as unknown as Page, {}, true), false, 'pasif: yönlendirme yok');
  assert.deepEqual(await s.me({} as Page, {}), { id: 'mivelo-test', label: 'Mivelo Test' });
});

test('shopify inbox threads: satırlar sohbete çevrilir; zaman çözülemezse lastTs=0, okunmamış 1', async () => {
  _resetShopifyInboxState();
  const s = makeShopifyInbox('mivelo-test');
  const now = Date.now();
  const page = inboxPage('mivelo-test', undefined, {
    threads: [
      { id: '123', href: '/store/mivelo-test/apps/inbox/conversations/123', name: 'Ayşe Yılmaz', preview: 'Kargom nerede?', when: '5 dk', unread: true },
      { id: 'h99', name: 'Ziyaretçi', preview: 'Merhaba', when: 'bilinmiyor', unread: false },
    ],
  });
  const th = await s.threads(page, {});
  assert.equal(th.length, 2);
  assert.equal(th[0].id, '123');
  assert.equal(th[0].name, 'Ayşe Yılmaz');
  assert.equal(th[0].preview, 'Kargom nerede?');
  assert.equal(th[0].unread, 1);
  assert.ok(Math.abs(th[0].lastTs - (now - 5 * 60_000)) < 5000);
  assert.equal(th[0].link, 'https://admin.shopify.com/store/mivelo-test/apps/inbox/conversations/123');
  assert.equal(th[1].lastTs, 0);
  assert.equal(th[1].unread, 0);
  assert.deepEqual(await s.threads(inboxPage('mivelo-test', undefined, { threads: [] }), {}), [], 'liste okunamazsa boş (uyarı bir kez)');
});

test('shopify inbox messages: açık sohbet okunur, sıra/gönderen/kimlik kararlı; send yerel kimlik bırakır', async () => {
  _resetShopifyInboxState();
  const s = makeShopifyInbox('mivelo-test');
  await s.threads(inboxPage('mivelo-test', undefined, { threads: [{ id: '123', name: 'Ayşe Yılmaz', preview: 'x', when: '', unread: false }] }), {});
  const rows = [
    { text: 'Kargom nerede?', when: '2026-09-24T11:20:00Z', me: false },
    { text: 'Bugün çıkıyor', when: '', me: true },
    { text: 'Teşekkürler', when: '2026-09-24T11:25:00Z', me: false },
    { text: 'Teşekkürler', when: '2026-09-24T11:25:00Z', me: false },
  ];
  const ops: string[] = [];
  const page = inboxPage('mivelo-test', '123', { messages: rows }, ops);
  const msgs = await s.messages(page, {}, '123', 20);
  assert.ok(!ops.includes('open'), 'sohbet zaten açık: tıklama yok');
  assert.deepEqual(
    msgs.map((m) => [m.fromMe, m.senderName, m.text]),
    [
      [false, 'Ayşe Yılmaz', 'Kargom nerede?'],
      [true, 'Ben', 'Bugün çıkıyor'],
      [false, 'Ayşe Yılmaz', 'Teşekkürler'],
      [false, 'Ayşe Yılmaz', 'Teşekkürler'],
    ],
  );
  assert.equal(msgs[1].ts, Date.parse('2026-09-24T11:20:00Z') + 1, 'zamanı çözülemeyen mesaj öncekinin +1 ms');
  assert.equal(new Set(msgs.map((m) => m.id)).size, 4, 'özdeş iki mesaj ayrı kimlik alır');
  assert.deepEqual(toMessages('123', 'Ayşe Yılmaz', rows).map((m) => m.id), msgs.map((m) => m.id), 'kimlikler yeniden okumada aynı');
  assert.equal((await s.messages(page, {}, '123', 2)).length, 2, 'limit');

  // başka sohbet açıkken: satıra tıklanır
  const ops2: string[] = [];
  await s.messages(inboxPage('mivelo-test', '999', { messages: rows }, ops2), {}, '123', 20);
  assert.ok(ops2.includes('open'));

  const ops3: string[] = [];
  assert.equal(await s.send(inboxPage('mivelo-test', '123', { messages: rows }, ops3), {}, '123', 'Selam'), undefined);
  assert.ok(ops3.includes('focusComposer') && ops3.includes('clickSend'));
});
