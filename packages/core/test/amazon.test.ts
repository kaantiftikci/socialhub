import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

// Oturum klasörleri (amazon-state.json) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-amazon-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { AmazonConnector, combineStatus, parseAmazonConfig } = await import('../src/connectors/amazon.js');
const { makeAmazonMessaging, sellerCentralHost, toMessages, _resetAmazonMessagingState } = await import('../src/connectors/browser/amazon.js');

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
const CFG = { orders: true, clientId: 'amzn1.application-oa2-client.x', clientSecret: 'sec', refreshToken: 'Atzr|x', messaging: false };
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
  assert.equal(p.messaging, false);
  assert.equal(parseAmazonConfig(JSON.stringify({ orders: true, ...CFG, marketplaceId: 'ATVPDKIKX0DER' })).region, 'na');
  assert.equal(parseAmazonConfig(JSON.stringify({ orders: true, ...CFG, marketplaceId: 'A1VC38T7YXB528', region: 'eu' })).region, 'eu', 'açık bölge baskın');
  assert.equal(parseAmazonConfig('{}').messaging, false); // köprü varsayılan kapalı (Amazon ajan politikası)
  assert.equal(parseAmazonConfig('{"messaging":true}').messaging, true);
  assert.equal(parseAmazonConfig('bozuk').clientId, '');
  assert.equal(sellerCentralHost('A1PA6795UKMFR9'), 'sellercentral-europe.amazon.com');
  assert.equal(sellerCentralHost('bilinmiyor'), 'sellercentral.amazon.com.tr');
});

test('eksik yapılandırma → error durumu', async () => {
  const { c, account } = setup({ clientId: 'x' });
  await c.start({ interactive: false });
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /Client ID \/ Client Secret \/ Refresh Token girilmedi/);
});

test('siparişler: LWA belirteci, NextToken sayfalama, kalemler, sipariş sohbeti + mesajı; değişmeyen sipariş tekrar mesaj üretmez; durum olayları; şablonlu gönderim', async () => {
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
  hits.length = 0;
  await priv.poll(false);
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
    return ++orderHits === 1 ? { status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] }, headers: { 'retry-after': '1', 'x-amzn-ratelimit-limit': '0.0167' } } : { body: { payload: { Orders: [order()] } } };
  });
  await s2.c.start({ interactive: false });
  assert.equal(s2.account.status, 'connected');
  assert.equal(orderHits, 2, '429 sonrası bir kez yeniden denendi');
  assert.ok(s2.store.getChat(`${s2.account.id}/order-403-1234567-7654321`));
  await s2.c.stop();
});

test('combineStatus: API baskın; köprü durumu ayrıntıda', () => {
  assert.deepEqual(combineStatus({ status: 'error', detail: 'x' }, { status: 'connected' }), { status: 'error', detail: 'x' });
  assert.deepEqual(combineStatus({ status: 'connected', detail: 'Türkiye' }, undefined), { status: 'connected', detail: 'Türkiye' });
  assert.deepEqual(combineStatus({ status: 'connected' }, { status: 'pairing' }), { status: 'connected', detail: 'Alıcı mesajları için Seller Central girişi gerekli (Yeniden bağlan)' });
  assert.deepEqual(combineStatus({ status: 'connected', detail: 'Türkiye' }, { status: 'connected' }), { status: 'connected', detail: 'Türkiye' });
  assert.equal(combineStatus({ status: 'connected' }, { status: 'error', detail: 'Chromium açılamadı' }).detail, 'Mesajlar: Chromium açılamadı');
});

// ───────────── Mesajlaşma stratejisi (sahte sayfa) ─────────────

const HOST = 'sellercentral.amazon.com.tr';

/** Sahte Seller Central sayfası: evaluate çağrılarını etiketli argümanın `op` alanına göre yanıtlar */
function scPage(threadId: string | undefined, data: { threads?: unknown[]; messages?: unknown[] }, ops: string[] = []): Page {
  const url = `https://${HOST}/messaging/${threadId ? `thread/${threadId}` : 'inbox'}`;
  return {
    url: () => url,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
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

test('amazon mesajları: loggedIn URL\'ye bakar (Seller Central → evet, /ap/signin → hayır)', async () => {
  const s = makeAmazonMessaging(HOST, () => 'Amazon.com.tr');
  assert.equal(s.home, `https://${HOST}/messaging/inbox`);
  assert.equal(await s.loggedIn({ url: () => `https://${HOST}/messaging/inbox?ref=x` } as unknown as Page, {}, true), true);
  assert.equal(await s.loggedIn({ url: () => `https://${HOST}/ap/signin?openid.return_to=x` } as unknown as Page, {}, true), false);
  assert.equal(await s.loggedIn({ url: () => `https://${HOST}/ap/mfa?x=1` } as unknown as Page, {}, true), false);
  assert.equal(await s.loggedIn({ url: () => 'about:blank' } as unknown as Page, {}, true), false, 'pasif: yönlendirme yok');
  assert.deepEqual(await s.me({} as Page, {}), { id: HOST, label: 'Amazon.com.tr' });
});

test('amazon mesajları threads: satırlar sohbete çevrilir; sipariş no handle; zaman çözülemezse lastTs=0', async () => {
  _resetAmazonMessagingState();
  const s = makeAmazonMessaging(HOST);
  const now = Date.now();
  const page = scPage(undefined, {
    threads: [
      { id: 'T1', href: '/messaging/thread/T1', name: 'Ayşe Yılmaz', preview: 'Kargom nerede? · Sipariş 403-1234567-7654321', when: '5 dk', unread: true, orderId: '403-1234567-7654321' },
      { id: 'h99', name: 'Alıcı', preview: 'Merhaba', when: 'bilinmiyor', unread: false },
    ],
  });
  const th = await s.threads(page, {});
  assert.equal(th.length, 2);
  assert.equal(th[0].id, 'T1');
  assert.equal(th[0].name, 'Ayşe Yılmaz');
  assert.equal(th[0].unread, 1);
  assert.equal(th[0].handle, '403-1234567-7654321');
  assert.ok(Math.abs(th[0].lastTs - (now - 5 * 60_000)) < 5000);
  assert.equal(th[0].link, `https://${HOST}/messaging/thread/T1`);
  assert.equal(th[1].lastTs, 0);
  assert.equal(th[1].unread, 0);
  assert.equal(th[1].link, `https://${HOST}/messaging/inbox`);
  assert.deepEqual(await s.threads(scPage(undefined, { threads: [] }), {}), [], 'liste okunamazsa boş (uyarı bir kez)');
});

test('amazon mesajları messages: açık sohbet okunur, sıra/gönderen/kimlik kararlı; send yerel kimlik bırakır', async () => {
  _resetAmazonMessagingState();
  const s = makeAmazonMessaging(HOST);
  await s.threads(scPage(undefined, { threads: [{ id: 'T1', name: 'Ayşe Yılmaz', preview: 'x', when: '', unread: false }] }), {});
  const rows = [
    { text: 'Kargom nerede?', when: '2026-09-24T11:20:00Z', me: false },
    { text: 'Bugün çıkıyor', when: '', me: true },
    { text: 'Teşekkürler', when: '2026-09-24T11:25:00Z', me: false },
    { text: 'Teşekkürler', when: '2026-09-24T11:25:00Z', me: false },
  ];
  const ops: string[] = [];
  const msgs = await s.messages(scPage('T1', { messages: rows }, ops), {}, 'T1', 20);
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
  assert.deepEqual(toMessages('T1', 'Ayşe Yılmaz', rows).map((m) => m.id), msgs.map((m) => m.id), 'kimlikler yeniden okumada aynı');
  assert.equal((await s.messages(scPage('T1', { messages: rows }), {}, 'T1', 2)).length, 2, 'limit');

  // başka sohbet açıkken: satıra tıklanır
  const ops2: string[] = [];
  await s.messages(scPage('T9', { messages: rows }, ops2), {}, 'T1', 20);
  assert.ok(ops2.includes('open'));

  const ops3: string[] = [];
  assert.equal(await s.send(scPage('T1', { messages: rows }, ops3), {}, 'T1', 'Selam'), undefined);
  assert.ok(ops3.includes('focusComposer') && ops3.includes('clickSend'));
});
