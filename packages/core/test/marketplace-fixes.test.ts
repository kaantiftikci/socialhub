import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pazaryeri denetim düzeltmeleri (Eylül 2026): PollTimer tek zincir, Trendyol paket birleştirme + yetki yalıtımı, cevap işareti,
// Hepsiburada servis yalıtımı + local-ans, Etsy artımlı yoklama + x-api-key, köprülerde göreli zamanla kararlı kimlik.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-mkt-fix-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { PollTimer } = await import('../src/connectors/poll-timer.js');
const { TrendyolConnector, mergePackages } = await import('../src/connectors/trendyol.js');
const { HepsiburadaConnector } = await import('../src/connectors/hepsiburada.js');
const { EtsyConnector, apiKeyHeader } = await import('../src/connectors/etsy.js');
const { toMessages: shopifyToMessages } = await import('../src/connectors/browser/shopify.js');
const { toMessages: amazonToMessages } = await import('../src/connectors/browser/amazon.js');
const { rowsToMessages } = await import('../src/connectors/browser/etsy.js');

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method: init.method ?? 'GET', headers, body: init.body });
    const r = handler(url, init) ?? { status: 404, body: '' };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

let n = 0;
function account(platform: 'trendyol' | 'hepsiburada' | 'etsy') {
  const store = new Store(path.join(tmp, `m${++n}.db`));
  const acc = { id: `${platform}:m${n}`, platform, label: platform, status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(acc);
  return { store, acc };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// ───────────── PollTimer ─────────────

test('PollTimer: tur sırasında gelen backoff ikinci zincir doğurmaz; stop() tümüyle durdurur', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let calls = 0;
    let running = 0;
    let maxRunning = 0;
    const t: InstanceType<typeof PollTimer> = new PollTimer(async () => {
      calls++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      if (calls === 1) t.backoff(1); // 429 tur içinde (API katmanı böyle çağırır)
      running--;
    }, () => 1000);
    t.start();
    mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 1);
    // bekleme (≥30 sn) bitene dek tur yok
    for (let i = 0; i < 29; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.equal(calls, 1, 'backoff süresince yoklama yok');
    const base = calls;
    // bekleme sonrası 1 sn aralık: 100 sn'de ~100 tur (çift zincirde ~200 olurdu)
    for (let i = 0; i < 100 + 15; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    const perTick = calls - base;
    assert.ok(perTick >= 95 && perTick <= 116, `tek zincir beklenir, tur sayısı ${perTick}`);
    t.stop();
    const stopped = calls;
    for (let i = 0; i < 50; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.equal(calls, stopped, 'stop sonrası tur yok');
    assert.equal(maxRunning, 1);
  } finally {
    mock.timers.reset();
  }
});

test('PollTimer: tur sürerken stop() → tur bitince yeniden planlanmaz', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let calls = 0;
    let release!: () => void;
    const t = new PollTimer(async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
    }, () => 1000);
    t.start();
    mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 1);
    t.stop();
    release();
    await flush();
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(1000);
      await flush();
    }
    assert.equal(calls, 1);
  } finally {
    mock.timers.reset();
  }
});

// ───────────── Trendyol ─────────────

const NOW = Date.now();
const PKG = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: '900',
  customerFirstName: 'Ali',
  customerLastName: 'Veli',
  totalPrice: 100,
  status: 'Created',
  shipmentPackageStatus: 'Created',
  orderDate: NOW - 3_600_000,
  lastModifiedDate: NOW - 3_600_000,
  currencyCode: 'TRY',
  shipmentAddress: { fullName: 'Ali Veli', fullAddress: 'Adres 1', city: 'Ankara', unusedField: 'x' },
  lines: [{ productName: `Ürün ${id}`, quantity: 1, amount: 100, orderLineItemStatusName: 'Created', unusedLineField: 'y' }],
  packageHistories: [{ createdDate: NOW - 3_600_000, status: 'Created', extra: 1 }],
  ...over,
});
const QUESTION = (over: Record<string, unknown> = {}) => ({ id: 456, text: 'Pamuk mu?', creationDate: NOW - 1000, status: 'WAITING_FOR_ANSWER', productName: 'Tişört', ...over });
const tyPage = (content: unknown[]) => ({ content, totalPages: 1 });

test('mergePackages: kimliğe göre birleşir, ilk liste kazanır, sıra kararlı', () => {
  const a = [{ id: 2, status: 'Shipped' }];
  const b = [{ id: 1, status: 'Created' }, { id: 2, status: 'Created' }];
  assert.deepEqual(mergePackages(a, b), [{ id: 1, status: 'Created' }, { id: 2, status: 'Shipped' }]);
});

test('Trendyol: yalnız bir paketi değişen çok paketli sipariş meta\'sı eksik paketle ezilmez; paketler durum dosyasında (sade)', async () => {
  let phase = 0;
  const { restore } = fakeFetch((url) => {
    if (url.includes('/orders')) {
      // ilk eşitleme: iki paket farklı 2 haftalık dilimlere düşer (en yeni dilimde 1, bir sonrakinde 2)
      if (phase === 0) return { body: tyPage(new URL(url).searchParams.get('endDate') && Number(new URL(url).searchParams.get('endDate')) > NOW - 60_000 ? [PKG(1)] : [PKG(2)]) };
      return { body: tyPage([PKG(1, { status: 'Shipped', shipmentPackageStatus: 'Shipped', cargoTrackingNumber: 'TR1', lastModifiedDate: NOW })]) };
    }
    if (url.includes('/questions/filter')) return { body: tyPage([]) };
    return undefined;
  });
  try {
    const { store, acc } = account('trendyol');
    const cfg = JSON.stringify({ sellerId: '1', apiKey: 'k', apiSecret: 's' });
    const c = new TrendyolConnector(acc, store, cfg);
    await c.start();
    const chatId = `${acc.id}/order-900`;
    let order = store.getChat(chatId)!.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(order.items.length, 2, 'ilk eşitlemede dilimler birleşir');
    phase = 1;
    await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
    order = store.getChat(chatId)!.meta?.order as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(order.items.length, 2, 'değişmeyen paket korunur');
    assert.equal(order.fulfillments.length, 2);
    assert.equal(order.status, 'Open', 'bir paket açıkken sipariş açık');
    assert.equal(order.totals.total, 200);
    await c.stop();
    const st = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', acc.id, 'trendyol-state.json'), 'utf8'));
    const pk = st.packages['900'];
    assert.equal(pk.length, 2);
    assert.equal(pk[0].shipmentAddress.unusedField, undefined, 'yalnız gereken alanlar saklanır');
    assert.equal(pk[0].lines[0].unusedLineField, undefined);
    assert.equal(pk.find((p: { id: number }) => p.id === 1).cargoTrackingNumber, 'TR1');
    assert.equal(pk.find((p: { id: number }) => p.id === 2).status, 'Created');
  } finally {
    restore();
  }
});

test('Trendyol: yalnız sipariş ucu 403 → sorular çalışır, hesap bağlı; soru ucu da 403 ise hata', async () => {
  let questionsAuth = false;
  const { restore } = fakeFetch((url) => {
    if (url.includes('/orders')) return { status: 403, body: '' };
    if (url.includes('/questions/filter')) return questionsAuth ? { status: 403, body: '' } : { body: tyPage([QUESTION()]) };
    return undefined;
  });
  try {
    const { store, acc } = account('trendyol');
    const c = new TrendyolConnector(acc, store, JSON.stringify({ sellerId: '1', apiKey: 'k', apiSecret: 's' }));
    await c.start();
    assert.equal(acc.status, 'connected', acc.detail);
    assert.ok(store.getChat(`${acc.id}/q-456`));
    await c.stop();

    questionsAuth = true;
    const b = account('trendyol');
    const c2 = new TrendyolConnector(b.acc, b.store, JSON.stringify({ sellerId: '1', apiKey: 'k', apiSecret: 's' }));
    await c2.start();
    assert.equal(b.acc.status, 'error');
    await c2.stop();
  } finally {
    restore();
  }
});

test('Trendyol: cevap sonrası API hâlâ "bekliyor" derse soru yeniden açılmaz; API cevabı getirince güncellenir', async () => {
  let answered = false;
  const { restore } = fakeFetch((url, init) => {
    if (url.includes('/orders')) return { body: tyPage([]) };
    if (url.includes('/questions/filter')) return { body: tyPage([answered ? QUESTION({ status: 'ANSWERED', answer: { text: 'Evet, pamuktur efendim.', creationDate: NOW } }) : QUESTION()]) };
    if (url.endsWith('/answers') && init.method === 'POST') return { body: '' };
    return undefined;
  });
  try {
    const { store, acc } = account('trendyol');
    const c = new TrendyolConnector(acc, store, JSON.stringify({ sellerId: '1', apiKey: 'k', apiSecret: 's' }));
    await c.start();
    const qChat = `${acc.id}/q-456`;
    store.markRead(qChat);
    await c.sendText('q-456', 'Evet, pamuktur efendim.');
    const poll = (c as unknown as { poll(first: boolean): Promise<void> }).poll.bind(c);
    await poll(false);
    const chat = store.getChat(qChat)!;
    assert.equal(chat.unread, 0, 'okunmamış olarak yeniden işaretlenmez');
    assert.equal((chat.meta?.question as Record<string, unknown>).status, 'ANSWERED');
    answered = true;
    await poll(false);
    const msgs = store.listMessages(qChat).filter((m) => m.fromMe);
    assert.equal(msgs.length, 1, 'aynı a-<id> kimliği: kopya yok');
    assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).statusLabel, 'Cevaplandı');
    await c.stop();
  } finally {
    restore();
  }
});

// ───────────── Hepsiburada ─────────────

const HB_CFG = JSON.stringify({ merchantId: 'm1', username: 'u', password: 'p' });
const hbIssue = (over: Record<string, unknown> = {}) => ({
  issueNumber: 500,
  createdAt: '2026-09-21T09:00:00',
  customerId: 'cust-9',
  status: 'WaitingForAnswer',
  lastContent: 'Pamuk mu?',
  conversations: [{ id: 77, createdAt: '2026-09-21T09:00:00', content: 'Pamuk mu?', from: 'Customer', files: [] }],
  product: { name: 'Tişört' },
  lastModifiedAt: '2026-09-21T09:00:00',
  ...over,
});

test('Hepsiburada: OMS çökse de (500/403) sorular işlenir ve hesap bağlanır', async () => {
  for (const omsStatus of [500, 403]) {
    const { restore } = fakeFetch((url) => {
      const u = new URL(url);
      if (u.host === 'oms-external.hepsiburada.com') return { status: omsStatus, body: { message: 'x' } };
      if (u.pathname === '/api/v1.0/issues') return { body: { items: u.searchParams.getAll('status').includes('1') ? [hbIssue()] : [] } };
      return undefined;
    });
    try {
      const { store, acc } = account('hepsiburada');
      const c = new HepsiburadaConnector(acc, store, HB_CFG);
      await c.start();
      assert.equal(acc.status, 'connected', `${omsStatus}: ${acc.detail}`);
      assert.ok(store.getChat(`${acc.id}/q-500`), 'soru sohbeti oluştu');
      await c.stop();
    } finally {
      restore();
    }
  }
});

test('Hepsiburada: iki servis de 401 → hata', async () => {
  const { restore } = fakeFetch(() => ({ status: 401, body: {} }));
  try {
    const { store, acc } = account('hepsiburada');
    const c = new HepsiburadaConnector(acc, store, HB_CFG);
    await c.start();
    assert.equal(acc.status, 'error');
    await c.stop();
  } finally {
    restore();
  }
});

test('Hepsiburada: gönderilen cevap yoklamadaki gerçek yazışmayla tek balon; API gecikirse soru yeniden açılmaz', async () => {
  let answeredOnApi = false;
  const { restore } = fakeFetch((url, init) => {
    const u = new URL(url);
    if (u.host === 'oms-external.hepsiburada.com') return { body: [] };
    if (u.pathname === '/api/v1.0/issues/500/answer' && init.method === 'POST') return { body: {} };
    if (u.pathname === '/api/v1.0/issues') {
      const waiting = u.searchParams.getAll('status').includes('1');
      const issue = answeredOnApi
        ? hbIssue({ status: 'Answered', lastModifiedAt: '2026-09-21T10:00:00', conversations: [...hbIssue().conversations, { id: 78, createdAt: new Date().toISOString(), content: 'Evet, %100 pamuktur.', from: 'Merchant', files: [] }] })
        : hbIssue();
      return { body: { items: waiting === (issue.status === 'WaitingForAnswer') ? [issue] : [] } };
    }
    return undefined;
  });
  try {
    const { store, acc } = account('hepsiburada');
    const c = new HepsiburadaConnector(acc, store, HB_CFG);
    await c.start();
    const qChat = `${acc.id}/q-500`;
    store.markRead(qChat);
    const { remoteId } = await c.sendText('q-500', 'Evet, %100 pamuktur.');
    assert.ok(remoteId.startsWith('local-'), remoteId);
    const poll = (c as unknown as { poll(first: boolean): Promise<void> }).poll.bind(c);
    await poll(false); // API henüz "bekliyor"
    assert.equal(store.getChat(qChat)!.unread, 0);
    assert.equal((store.getChat(qChat)!.meta?.question as Record<string, unknown>).status, 'Answered');
    answeredOnApi = true;
    await poll(false);
    const mine = store.listMessages(qChat).filter((m) => m.fromMe);
    assert.deepEqual(mine.map((m) => m.text), ['Evet, %100 pamuktur.'], 'yerel kopya gerçek kayıtla değişti');
    await c.stop();
  } finally {
    restore();
  }
});

// ───────────── Etsy ─────────────

test('Etsy x-api-key: shared secret varsa keystring:secret, yoksa keystring', () => {
  assert.equal(apiKeyHeader({ keystring: 'K', sharedSecret: 'S' }), 'K:S');
  assert.equal(apiKeyHeader({ keystring: 'K' }), 'K');
  assert.equal(apiKeyHeader({ keystring: 'K', sharedSecret: '  ' }), 'K');
});

test('Etsy: sonraki yoklamalar min_last_modified + sort_on=updated ile değişenleri ister; başlıkta keystring:secret', async () => {
  const { calls, restore } = fakeFetch((url) => {
    if (url.includes('/receipts')) return { body: { count: 0, results: [] } };
    if (url.includes('/shops/777')) return { body: { shop_name: 'Dükkân' } };
    return undefined;
  });
  try {
    const { store, acc } = account('etsy');
    const cfg = JSON.stringify({ keystring: 'KEY', sharedSecret: 'SEC', shopId: '777', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
    const c = new EtsyConnector(acc, store, cfg, false);
    await c.start({ interactive: false });
    const first = calls.find((x) => x.url.includes('/receipts'))!;
    assert.match(first.url, /sort_on=created/);
    assert.doesNotMatch(first.url, /min_last_modified/);
    assert.equal(first.headers['x-api-key'], 'KEY:SEC');
    const t0 = Math.floor(Date.now() / 1000);
    await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
    const next = calls.filter((x) => x.url.includes('/receipts')).at(-1)!;
    const u = new URL(next.url);
    assert.equal(u.searchParams.get('sort_on'), 'updated');
    const since = Number(u.searchParams.get('min_last_modified'));
    assert.ok(since <= t0 - 290 && since >= t0 - 320, `since ${since} vs ${t0}`);
    await c.stop();
  } finally {
    restore();
  }
});

// ───────────── Köprüler: göreli zamanla kararlı kimlik ─────────────

test('Shopify/Amazon toMessages: "5 dk"/"şimdi" gibi göreli zamanda kimlik yoklamalar arası değişmez; mutlak zamanda eskisi gibi', () => {
  const rows = [
    { text: 'Merhaba', when: '5 dk', me: false },
    { text: 'Selam', when: 'şimdi', me: true },
    { text: 'Eski', when: '2026-09-24T11:20:00Z', me: false },
  ];
  const t = Date.parse('2026-09-28T12:00:00Z');
  for (const fn of [shopifyToMessages, amazonToMessages]) {
    const a = fn('th1', 'Ayşe', rows, t);
    const b = fn('th1', 'Ayşe', rows, t + 7 * 60_000);
    assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
    assert.equal(a[2].ts, Date.parse('2026-09-24T11:20:00Z'));
  }
});

test('Etsy rowsToMessages: "3h" ve zamansız ilk satırda kimlik kararlı', () => {
  const rows = [
    { id: '', sender: 'Jane', text: 'Zamansız', time: '', images: [] },
    { id: '', sender: 'Jane', text: 'Göreli', time: '3h', images: [] },
  ];
  const a = rowsToMessages('c1', rows, 'Me', new Date('2026-09-28T12:00:00Z'));
  const b = rowsToMessages('c1', rows, 'Me', new Date('2026-09-28T12:09:00Z'));
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
});
