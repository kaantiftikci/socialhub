import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörü (hepsiburada-state.json) gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-hb-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { HepsiburadaConnector } = await import('../src/connectors/hepsiburada.js');

const CFG = JSON.stringify({ merchantId: 'b2910839-83b9-4d45-adb6-86bad457edcb', username: 'magaza_dev', password: 'gizli' });

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `hepsiburada:t${n}`, platform: 'hepsiburada' as const, label: 'Hepsiburada', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  return { store, account };
}

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Route = (u: URL, init: RequestInit) => { status?: number; body?: unknown } | undefined;

/** Sahte fetch: yol desenine göre yanıt; tüm çağrıları kaydeder */
function fakeFetch(route: Route, calls: Call[] = []) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init.method ?? 'GET', url: url.toString(), headers, body: init.body });
    const r = route(url, init) ?? { status: 404, body: { message: 'not found' } };
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const openItems = (over: Record<string, unknown> = {}) => ({
  totalCount: 2,
  limit: 100,
  offset: 0,
  pageCount: 1,
  items: [
    {
      id: 'li-1', sku: 'HBV0000106NM0', orderId: 'o-1', orderNumber: '1001', orderDate: '2026-09-20T10:00:00', quantity: 1, status: 'Open', customerName: 'Ayşe Yılmaz', customerId: 'cust-1',
      productName: 'Pamuklu Tişört', totalPrice: { amount: 301.4, currency: 'TRY' }, unitPrice: { amount: 301.4, currency: 'TRY' },
      shippingAddress: { name: 'Ayşe Yılmaz', address: 'Çiçek Sk. 5', district: 'Kuştepe', town: 'Şişli', city: 'İstanbul', phoneNumber: '905321234567', email: 'ayse@example.com' },
      ...over,
    },
    { id: 'li-2', sku: 'HBV0000106NLG', orderId: 'o-1', orderNumber: '1001', orderDate: '2026-09-20T10:00:00', quantity: 2, status: 'Open', customerName: 'Ayşe Yılmaz', customerId: 'cust-1', productName: 'Çorap', totalPrice: { amount: 50, currency: 'TRY' }, shippingAddress: { name: 'Ayşe Yılmaz', address: 'Çiçek Sk. 5', city: 'İstanbul' } },
  ],
});

const waitingIssue = {
  issueNumber: 500,
  createdAt: '2026-09-21T09:00:00',
  customerId: 'cust-9',
  orderNumber: null,
  status: 'WaitingForAnswer',
  subject: { id: 3, description: 'Ürün özellikleri' },
  lastContent: 'Bu tişört %100 pamuk mu?',
  conversations: [{ id: 77, createdAt: '2026-09-21T09:00:00', content: 'Bu tişört %100 pamuk mu?', from: 'Customer', files: [] }],
  merchant: { id: 'b2910839', name: 'Mağaza' },
  product: { sku: 'HBV0000106NM0', name: 'Pamuklu Tişört Uzun Kollu Basic Erkek Modeli 2026', imageUrl: 'https://img.example/t.jpg' },
  expireDate: '2026-09-22T09:00:00',
  lastModifiedAt: '2026-09-21T09:00:00',
};

/** Varsayılan yönlendirme: açık kalemler, boş paket/kargo listeleri, bir bekleyen soru */
function baseRoute(state: { shipped?: unknown[]; delivered?: unknown[]; issues?: unknown[]; done?: unknown[] } = {}): Route {
  return (u) => {
    const p = u.pathname;
    if (u.host === 'oms-external.hepsiburada.com') {
      if (p === '/orders/merchantid/b2910839-83b9-4d45-adb6-86bad457edcb') return { body: u.searchParams.get('offset') === '0' ? openItems() : { items: [] } };
      if (p.endsWith('/shipped')) return { body: u.searchParams.get('offset') === '0' ? state.shipped ?? [] : [] };
      if (p.endsWith('/delivered')) return { body: u.searchParams.get('offset') === '0' ? state.delivered ?? [] : [] };
      if (/\/packagenumber\/5000031611$/.test(p)) return { body: { packageNumber: 5000031611, barcode: 'BRK1', status: 'Intransit', cargoCompany: 'HepsiJET', trackingInfoCode: 'TRK123', trackingInfoUrl: 'https://track.example/TRK123' } };
      if (p === '/packages/merchantid/b2910839-83b9-4d45-adb6-86bad457edcb') return { body: [] };
    }
    if (u.host === 'api-asktoseller-merchant.hepsiburada.com' && p === '/api/v1.0/issues') {
      const st = u.searchParams.getAll('status');
      return { body: { items: st.includes('1') ? (state.issues ?? [waitingIssue]) : (state.done ?? []) } };
    }
    return undefined;
  };
}

test('Hepsiburada: sipariş sohbeti + yeni sipariş mesajı; soru sohbeti unread=1; kimlik başlıkları', async () => {
  const { store, account } = setup();
  const { calls, restore } = fakeFetch(baseRoute());
  try {
    const c = new HepsiburadaConnector(account, store, CFG);
    await c.start();
    assert.equal(account.status, 'connected');

    const cid = `${account.id}/order-1001`;
    const chat = store.getChat(cid)!;
    assert.ok(chat, 'sipariş sohbeti oluşmalı');
    assert.equal(chat.name, '#1001 · Ayşe Yılmaz');
    assert.equal(chat.unread, 1, 'açık sipariş ilk görüldüğünde ilgi bekliyor');
    assert.equal(chat.participants?.[0].id, 'cust-1');
    const order = chat.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(order.items.length, 2);
    assert.equal(order.status, 'open');
    assert.equal(order.totals.total, 351.4);
    assert.match(order.shipping.address, /Çiçek Sk\. 5, Kuştepe, Şişli, İstanbul/);
    const m = store.getMessage(`${cid}#new-1001`)!;
    assert.ok(m.text.startsWith('🛍️ Yeni sipariş #1001 — 351,40 ₺'), m.text);
    assert.match(m.text, /• 2 × Çorap/);
    assert.equal(m.fromMe, false);
    assert.equal(m.senderName, 'Ayşe Yılmaz');

    const qid = `${account.id}/q-500`;
    const q = store.getChat(qid)!;
    assert.ok(q, 'soru sohbeti oluşmalı');
    assert.equal(q.unread, 1, 'yanıtlanmamış soru okunmamış');
    assert.match(q.name, /^Soru · Pamuklu Tişört Uzun Kollu Basic Erkek M?…$/, 'ürün adı kısaltılır');
    assert.equal((q.meta?.question as Record<string, unknown>).status, 'WaitingForAnswer');
    const qm = store.getMessage(`${qid}#c-77`)!;
    assert.equal(qm.fromMe, false);
    assert.match(qm.text, /Bu tişört %100 pamuk mu\?/);
    assert.match(qm.text, /🛒 Pamuklu Tişört/);

    // kimlik: Basic auth + zorunlu User-Agent; soru ucunda merchantId başlığı
    const orders = calls.find((x) => x.url.includes('/orders/merchantid/'))!;
    assert.equal(orders.headers.authorization, 'Basic ' + Buffer.from('magaza_dev:gizli').toString('base64'));
    assert.equal(orders.headers['user-agent'], 'b2910839-83b9-4d45-adb6-86bad457edcb - magaza_dev');
    const ask = calls.find((x) => x.url.includes('api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues?'))!;
    assert.equal(ask.headers.merchantid, 'b2910839-83b9-4d45-adb6-86bad457edcb');
    assert.ok(ask.url.includes('status=1'));
    await c.stop();
  } finally {
    restore();
  }
});

test('Hepsiburada: değişmeyen sipariş tekrar mesaj üretmez; kargoya verilince takip bilgili 📦 mesajı gelir', async () => {
  const { store, account } = setup();
  const state: { shipped?: unknown[] } = {};
  const { calls, restore } = fakeFetch(baseRoute(state));
  try {
    const c = new HepsiburadaConnector(account, store, CFG);
    await c.start();
    const cid = `${account.id}/order-1001`;
    const before = store.listMessages(cid).length;
    assert.equal(before, 1);
    const priv = c as unknown as { poll(first: boolean): Promise<void> };
    calls.length = 0;
    await priv.poll(false);
    assert.equal(store.listMessages(cid).length, before, 'aynı veriyle yeni mesaj olmamalı');
    assert.ok(!calls.some((x) => x.url.includes('/ordernumber/')), 'temel bilgisi olan sipariş için detay istenmez');

    state.shipped = [{ orderNumber: '1001', id: 'd-1', packageNumber: 5000031611, barcode: 'BRK1', merchantId: 'x', shippedDate: '2026-09-22T12:00:00', deci: 2 }];
    await priv.poll(false);
    const msgs = store.listMessages(cid);
    const shipped = msgs.find((m) => m.remoteId === 'pkg-5000031611-shipped')!;
    assert.ok(shipped, 'kargo mesajı');
    assert.equal(shipped.fromMe, true);
    assert.match(shipped.text, /📦 Kargoya verildi · HepsiJET · takip: TRK123/);
    assert.match(shipped.text, /https:\/\/track\.example\/TRK123/);
    const order = store.getChat(cid)!.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(order.status, 'shipped');
    assert.equal(order.fulfillments[0].trackingNumber, 'TRK123');
    // üçüncü yoklama: aynı kargo → mesaj sayısı sabit, takip tekrar sorgulanmaz
    const count = msgs.length;
    calls.length = 0;
    await priv.poll(false);
    assert.equal(store.listMessages(cid).length, count);
    assert.ok(!calls.some((x) => x.url.includes('/packagenumber/')), 'takip bir kez alınır');
    await c.stop();
  } finally {
    restore();
  }
});

test('Hepsiburada: soru cevabı POST /issues/{no}/answer (multipart Answer) + fromMe mesaj; sipariş sohbetine yazılan yerel not', async () => {
  const { store, account } = setup();
  const { calls, restore } = fakeFetch((u, init) => {
    if (u.pathname === '/api/v1.0/issues/500/answer' && init.method === 'POST') return { body: {} };
    return baseRoute()(u, init);
  });
  try {
    const c = new HepsiburadaConnector(account, store, CFG);
    await c.start();
    const qid = `${account.id}/q-500`;
    const { remoteId } = await c.sendText('q-500', 'Evet, %100 pamuktur.');
    const post = calls.find((x) => x.method === 'POST')!;
    assert.equal(post.url, 'https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues/500/answer');
    assert.ok(post.body instanceof FormData, 'gövde multipart/form-data');
    assert.equal((post.body as FormData).get('Answer'), 'Evet, %100 pamuktur.');
    assert.equal(post.headers.merchantid, 'b2910839-83b9-4d45-adb6-86bad457edcb');
    assert.equal(post.headers['content-type'], undefined, 'multipart sınırını fetch koyar');
    const m = store.getMessage(`${qid}#${remoteId}`)!;
    assert.equal(m.fromMe, true);
    assert.equal(m.text, 'Evet, %100 pamuktur.');
    assert.equal((store.getChat(qid)!.meta?.question as Record<string, unknown>).status, 'Answered');

    const note = await c.sendText('order-1001', 'Kargoyu yarın ver');
    const nm = store.getMessage(`${account.id}/order-1001#${note.remoteId}`)!;
    assert.equal(nm.text, '📝 Kargoyu yarın ver');
    assert.equal(calls.filter((x) => x.method === 'POST').length, 1, 'sipariş notu API çağrısı yapmaz');
    await c.stop();
  } finally {
    restore();
  }
});

test('Hepsiburada: 401 → kimlik hatası; eksik yapılandırma → hata', async () => {
  const { store, account } = setup();
  const { restore } = fakeFetch(() => ({ status: 401, body: { message: 'Unauthorized' } }));
  try {
    const c = new HepsiburadaConnector(account, store, CFG);
    await c.start();
    assert.equal(account.status, 'error');
    assert.equal(account.detail, 'Hepsiburada kimlik bilgileri reddedildi');
    await c.stop();

    const s2 = setup();
    const c2 = new HepsiburadaConnector(s2.account, s2.store, JSON.stringify({ merchantId: 'x' }));
    await c2.start();
    assert.equal(s2.account.status, 'error');
    assert.match(s2.account.detail ?? '', /merchant ID \/ kullanıcı adı \/ şifre/);
    const c3 = new HepsiburadaConnector(s2.account, s2.store, 'bozuk json');
    await c3.start();
    assert.equal(s2.account.status, 'error');
  } finally {
    restore();
  }
});
