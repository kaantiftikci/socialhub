import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

// Oturum klasörleri gerçek ~/.kavsak'a yazılmasın: config içe aktarılmadan önce
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-etsy-test-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { EtsyConnector, pkcePair, authorizeUrl, money } = await import('../src/connectors/etsy.js');
const { etsy, parseEtsyTime, rowsToMessages, rowToThread, sentMessageId, isSignedOutUrl } = await import('../src/connectors/browser/etsy.js');
const { OAUTH_CALLBACK } = await import('../src/connectors/mail.js');

let n = 0;
function setup() {
  const store = new Store(path.join(tmp, `t${++n}.db`));
  const account = { id: `etsy:t${n}`, platform: 'etsy' as const, label: 'x', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  return { store, account };
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined;
/** globalThis.fetch'i sahteyle değiştir; çağrılan adresleri kaydeder */
function mockFetch(handler: Handler): { calls: Array<{ url: string; body?: string }>; restore: () => void } {
  const calls: Array<{ url: string; body?: string }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    const r = handler(url, init) ?? { status: 404, body: { error: 'yok' } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const T = 1_790_000_000; // saniye
const receipt = (over: Record<string, unknown> = {}) => ({
  receipt_id: 3100001,
  status: 'Paid',
  name: 'Jane Doe',
  buyer_email: 'jane@example.com',
  buyer_user_id: 55,
  formatted_address: 'Jane Doe\n1 Main St\nAustin, TX 78701\nUnited States',
  country_iso: 'US',
  is_paid: true,
  is_shipped: false,
  is_gift: false,
  message_from_buyer: 'Lütfen hediye paketi yapın',
  create_timestamp: T,
  grandtotal: { amount: 4550, divisor: 100, currency_code: 'USD' },
  subtotal: { amount: 4000, divisor: 100, currency_code: 'USD' },
  total_shipping_cost: { amount: 550, divisor: 100, currency_code: 'USD' },
  transactions: [
    { transaction_id: 1, title: 'El yapımı seramik kupa', quantity: 2, price: { amount: 2000, divisor: 100, currency_code: 'USD' }, variations: [{ formatted_name: 'Renk', formatted_value: 'Mavi' }], sku: 'KUPA-M' },
  ],
  shipments: [],
  refunds: [],
  ...over,
});

const cfg = (over: Record<string, unknown> = {}) => JSON.stringify({ orders: true, keystring: 'KEY123', shopId: '777', accessToken: '55.tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, ...over });

test('etsy siparişler: receipt → sipariş sohbeti, yeni sipariş + alıcı notu mesajları; kargo olayı sonraki yoklamada', async () => {
  const { store, account } = setup();
  let ship = false;
  const fx = mockFetch((url) => {
    if (url.includes('/shops/777/receipts')) return { body: { count: 1, results: [receipt(ship ? { is_shipped: true, status: 'Completed', shipments: [{ receipt_shipping_id: 9, carrier_name: 'USPS', tracking_code: '9400', shipment_notification_timestamp: T + 86400 }] } : {})] } };
    if (url.endsWith('/shops/777')) return { body: { shop_id: 777, shop_name: 'KaanCrafts' } };
    return undefined;
  });
  try {
    const c = new EtsyConnector(account, store, cfg(), false);
    await c.start({ interactive: false });
    assert.equal(account.status, 'connected');
    assert.equal(account.label, 'Etsy · KaanCrafts');
    const cid = `${account.id}/order-3100001`;
    const chat = store.getChat(cid)!;
    assert.ok(chat, 'sipariş sohbeti oluştu');
    assert.equal(chat.name, '#3100001 · Jane Doe');
    assert.equal(chat.unread, 1, 'açık sipariş ilk görüldüğünde ilgi bekliyor');
    const order = (chat.meta as { order: Record<string, any> }).order; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(order.currency, 'USD');
    assert.equal(order.totals.total, '45,50 $');
    assert.deepEqual(order.items[0], { title: 'El yapımı seramik kupa', quantity: 2, total: '40,00 $', sku: 'KUPA-M', type: 'physical', selection: ['Mavi'] });
    assert.equal(order.shipping.address, 'Jane Doe, 1 Main St, Austin, TX 78701, United States');
    assert.deepEqual(chat.participants, [{ id: 'jane@example.com', name: 'Jane Doe', handle: 'jane@example.com' }]);
    const msgs = store.listMessages(cid, 20);
    assert.deepEqual(
      msgs.map((m) => [m.remoteId, m.fromMe, m.text.split('\n')[0]]),
      [
        ['order-3100001', false, '🛍️ Yeni sipariş #3100001 — 45,50 $'],
        ['note-3100001', false, '💬 Lütfen hediye paketi yapın'],
      ],
    );
    assert.ok(msgs[0].text.includes('• 2 × El yapımı seramik kupa (Mavi) — 40,00 $'));
    // ilk yoklama 3 sayfaya kadar bakar; tek sayfa 50'den az → tek istek
    assert.equal(fx.calls.filter((x) => x.url.includes('/receipts')).length, 1);
    assert.ok(fx.calls.find((x) => x.url.includes('/receipts'))!.url.includes('/shops/777/receipts?limit=50&offset=0&sort_on=created&sort_order=desc'));

    // kargo: ikinci yoklamada olay mesajı + fulfillments meta
    ship = true;
    await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
    const after2 = store.listMessages(cid, 20);
    assert.ok(after2.some((m) => m.remoteId === 'ship-3100001-9' && m.fromMe && m.text === '📦 Kargoya verildi · USPS · takip: 9400'));
    assert.ok(after2.some((m) => m.remoteId === 'status-3100001-completed' && m.text === '✅ Sipariş tamamlandı'));
    const o2 = (store.getChat(cid)!.meta as { order: Record<string, any> }).order; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(o2.fulfillments[0], { status: 'shipped', company: 'USPS', trackingNumber: '9400', date: new Date((T + 86400) * 1000).toISOString() });
    // aynı durum yeniden gelirse değişiklik yok (imza)
    await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
    assert.equal(store.listMessages(cid, 20).length, after2.length);
    // durum dosyası yazıldı
    assert.ok(fs.existsSync(path.join(tmp, 'sessions', account.id, 'etsy-state.json')));

    // sipariş sohbetine yazılan metin yerel not
    const r = await c.sendText('order-3100001', 'kargo yarın');
    assert.ok(r.remoteId.startsWith('note-'));
    assert.ok(store.listMessages(cid, 30).some((m) => m.text === '📝 kargo yarın' && m.fromMe));
    await c.stop();
    assert.equal(account.status, 'disconnected');
  } finally {
    fx.restore();
  }
});

test('etsy belirteç: süresi dolmuşsa yenileme çağrısı yapılır ve token dosyası güncellenir', async () => {
  const { store, account } = setup();
  const fx = mockFetch((url, init) => {
    if (url === 'https://api.etsy.com/v3/public/oauth/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), 'KEY123');
      assert.equal(body.get('refresh_token'), 'ref');
      return { body: { access_token: '55.yeni', refresh_token: 'ref2', expires_in: 3600, token_type: 'Bearer' } };
    }
    if (url.includes('/receipts')) {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer 55.yeni');
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'KEY123');
      return { body: { count: 0, results: [] } };
    }
    return undefined;
  });
  try {
    const c = new EtsyConnector(account, store, cfg({ expiresAt: Date.now() - 1000 }), false);
    await c.start({ interactive: false });
    assert.equal(account.status, 'connected');
    assert.equal(fx.calls.filter((x) => x.url.endsWith('/oauth/token')).length, 1);
    const tokenFile = path.join(tmp, 'sessions', account.id, 'token');
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.accessToken, '55.yeni');
    assert.equal(saved.refreshToken, 'ref2');
    assert.ok(Number(saved.expiresAt) > Date.now() + 3_000_000);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    await c.stop();
  } finally {
    fx.restore();
  }
});

test('etsy 401: bir kez yenileme denenir, yine 401 ise hata durumu ("Yeniden bağlan")', async () => {
  const { store, account } = setup();
  const fx = mockFetch((url) => {
    if (url.endsWith('/oauth/token')) return { body: { access_token: '55.x', expires_in: 3600 } };
    if (url.includes('/receipts')) return { status: 401, body: { error: 'invalid_token' } };
    return undefined;
  });
  try {
    const c = new EtsyConnector(account, store, cfg(), false);
    await c.start({ interactive: false });
    assert.equal(account.status, 'error');
    assert.match(account.detail ?? '', /401.*Yeniden bağlan/);
    assert.equal(fx.calls.filter((x) => x.url.endsWith('/oauth/token')).length, 1, 'yenileme bir kez');
    assert.equal(fx.calls.filter((x) => x.url.includes('/receipts')).length, 2, 'yenileme sonrası bir kez daha denenir');
  } finally {
    fx.restore();
  }
});

test('etsy: keystring yoksa hata; erişim belirteci yok + etkileşimsiz açılış → pairing (pencere açılmaz)', async () => {
  const { store, account } = setup();
  const c0 = new EtsyConnector(account, store, '{}', false);
  await c0.start();
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /keystring/);

  const c1 = new EtsyConnector(account, store, JSON.stringify({ orders: true, keystring: 'KEY123' }), false);
  await c1.start({ interactive: false });
  assert.equal(account.status, 'pairing');
  assert.match(account.detail ?? '', /Yeniden bağlan/);
});

test('etsy OAuth PKCE: S256 challenge ve izin adresi (OAUTH_CALLBACK geri dönüşü)', () => {
  const { verifier, challenge } = pkcePair('abc-verifier');
  assert.equal(verifier, 'abc-verifier');
  assert.equal(challenge, createHash('sha256').update('abc-verifier').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  const u = new URL(authorizeUrl('KEY123', 'ST', challenge));
  assert.equal(u.origin + u.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'KEY123');
  assert.equal(u.searchParams.get('redirect_uri'), OAUTH_CALLBACK);
  assert.equal(u.searchParams.get('scope'), 'transactions_r shops_r listings_r email_r');
  assert.equal(u.searchParams.get('state'), 'ST');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.equal(money({ amount: 1234, divisor: 100, currency_code: 'EUR' }), '12,34 €');
  assert.equal(money(undefined), '—');
});

test('etsy OAuth akışı: pencere kapanınca code belirtece çevrilir, dükkân users/me ile bulunur', async () => {
  const { store, account } = setup();
  const fx = mockFetch((url, init) => {
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'CODE1');
      assert.equal(body.get('redirect_uri'), OAUTH_CALLBACK);
      assert.ok(body.get('code_verifier'));
      return { body: { access_token: '55.ilk', refresh_token: 'r1', expires_in: 3600 } };
    }
    if (url.endsWith('/users/me')) return { body: { user_id: 55, shop_id: 777 } };
    if (url.endsWith('/shops/777')) return { body: { shop_name: 'KaanCrafts' } };
    if (url.includes('/receipts')) return { body: { count: 0, results: [] } };
    return undefined;
  });
  try {
    const c = new EtsyConnector(account, store, JSON.stringify({ orders: true, keystring: 'KEY123' }), false);
    let opened = '';
    // giriş penceresi yerine: adresi kaydet, geri dönüş bekleyicisini (waitOAuth) atlayıp code'u doğrudan ver
    (c as unknown as { authWindow: (url: string, done: Promise<string>) => Promise<string> }).authWindow = async (url, done) => {
      opened = url;
      void done.catch(() => undefined);
      return 'CODE1';
    };
    await c.start({ interactive: true });
    assert.equal(account.status, 'connected');
    assert.ok(opened.startsWith('https://www.etsy.com/oauth/connect?'));
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', account.id, 'token'), 'utf8')) as Record<string, unknown>;
    assert.equal(saved.shopId, '777');
    assert.equal(saved.accessToken, '55.ilk');
    await c.stop();
  } finally {
    fx.restore();
  }
});

// ───────────── tarayıcı stratejisi (sahte sayfa) ─────────────

const now = new Date(2026, 8, 25, 12, 0);
test('parseEtsyTime: ISO, saat, AM/PM, dün, ay-gün (EN/TR), relatif', () => {
  assert.equal(parseEtsyTime('2026-09-24T10:15:00.000Z'), Date.parse('2026-09-24T10:15:00.000Z'));
  assert.equal(parseEtsyTime('14:32', now), new Date(2026, 8, 25, 14, 32).getTime());
  assert.equal(parseEtsyTime('2:32 PM', now), new Date(2026, 8, 25, 14, 32).getTime());
  assert.equal(parseEtsyTime('12:05 AM', now), new Date(2026, 8, 25, 0, 5).getTime());
  assert.equal(parseEtsyTime('Yesterday', now), new Date(2026, 8, 24).getTime());
  assert.equal(parseEtsyTime('Dün 09:10', now), new Date(2026, 8, 24, 9, 10).getTime());
  assert.equal(parseEtsyTime('Sep 24', now), new Date(2026, 8, 24).getTime());
  assert.equal(parseEtsyTime('Sep 24, 2025', now), new Date(2025, 8, 24).getTime());
  assert.equal(parseEtsyTime('24 Eyl 2025', now), new Date(2025, 8, 24).getTime());
  assert.equal(parseEtsyTime('30 Ara', now), new Date(2025, 11, 30).getTime(), 'yılsız gelecek → geçen yıl');
  assert.equal(parseEtsyTime('3h', now), now.getTime() - 3 * 3_600_000);
  assert.equal(parseEtsyTime('2d', now), now.getTime() - 2 * 86_400_000);
  assert.equal(parseEtsyTime(''), undefined);
  assert.equal(parseEtsyTime('anlamsız'), undefined);
});

/** Etsy sahte sayfası: evaluate çağrısının {mode} bağımsız değişkenine göre sabit veriler döner */
function etsyPage(url: string, data: { threads?: unknown[]; messages?: unknown[]; me?: { name: string; id: string }; inbox?: boolean; redirectTo?: string }): Page & { gotos: string[] } {
  const gotos: string[] = [];
  return {
    gotos,
    url: () => url,
    // redirectTo: her gezinme o adrese düşer (oturum düşmüşse Etsy /signin'e yönlendirir)
    goto: async (u: string) => {
      gotos.push(u);
      url = data.redirectTo ?? u;
    },
    waitForTimeout: async () => undefined,
    evaluate: async (_fn: unknown, arg?: { mode?: string }) => {
      switch (arg?.mode) {
        case 'threads':
          return data.threads ?? [];
        case 'messages':
          return data.messages ?? [];
        case 'me':
          return data.me ?? { name: '', id: '' };
        case 'inbox':
          return data.inbox ?? (data.threads?.length ?? 0) > 0;
        case 'session':
          return !!data.me;
        default:
          return false;
      }
    },
  } as unknown as Page & { gotos: string[] };
}

test('etsy threads: liste satırları sohbete çevrilir (okunmamış, zaman, bağlantı); giriş sayfasındaysa hata', async () => {
  const page = etsyPage('https://www.etsy.com/messages', {
    threads: [
      { id: '9001', name: 'Jane Doe', preview: 'Merhaba,  kupa ne zaman  kargolanır?', time: '2026-09-24T10:15:00.000Z', unread: true, avatarUrl: 'https://i.etsystatic.com/a.jpg' },
      { id: '9002', name: '', preview: 'ok', time: 'saçma', unread: false },
    ],
  });
  const th = await etsy.threads(page, {});
  assert.deepEqual(
    th.map((t) => [t.id, t.name, t.preview, t.unread, t.lastTs, t.link]),
    [
      ['9001', 'Jane Doe', 'Merhaba, kupa ne zaman kargolanır?', 1, Date.parse('2026-09-24T10:15:00.000Z'), 'https://www.etsy.com/messages/9001'],
      ['9002', 'Etsy sohbeti 9002', 'ok', 0, 0, 'https://www.etsy.com/messages/9002'],
    ],
  );
  assert.equal(page.gotos.length, 0, 'zaten /messages: gezinme yok');
  // başka sayfadaysa /messages'a gider
  const p2 = etsyPage('https://www.etsy.com/', { threads: [{ id: '1', name: 'A', preview: '', time: '', unread: false }] });
  await etsy.threads(p2, {});
  assert.deepEqual(p2.gotos, ['https://www.etsy.com/messages']);
  // oturum düşmüş
  const p3 = etsyPage('https://www.etsy.com/signin?from_page=https://www.etsy.com/messages', { redirectTo: 'https://www.etsy.com/signin?from_page=https://www.etsy.com/messages' });
  await assert.rejects(() => etsy.threads(p3, {}), /oturumu düşmüş/);
  assert.equal(isSignedOutUrl('https://www.etsy.com/messages/9001'), false);
});

test('etsy messages: balonlar → mesajlar (ben/karşı, zaman imleci, kararlı kimlik, görsel eki, before/limit)', async () => {
  const me = { name: 'Kaan', id: '55' };
  const rows = [
    { id: '', sender: 'Jane Doe', text: 'Merhaba, kupa ne zaman kargolanır?', time: '2026-09-24T10:15:00.000Z', me: undefined, images: [] },
    { id: '', sender: 'Kaan', text: 'Yarın kargoda!', time: '', me: undefined, images: [] },
    { id: 'm77', sender: 'Jane Doe', text: '', time: '2026-09-24T11:00:00.000Z', me: false, images: ['https://i.etsystatic.com/msg/1.jpg'] },
    { id: '', sender: '', text: 'Teşekkürler', time: '2026-09-24T11:05:00.000Z', me: true, images: [] },
  ];
  const page = etsyPage('https://www.etsy.com/messages', { threads: [], messages: rows, me });
  await etsy.me(page, {}); // meName öğrenilir
  const a = await etsy.messages(page, {}, '9001', 20);
  assert.deepEqual(page.gotos, ['https://www.etsy.com/messages/9001']);
  assert.deepEqual(
    a.map((m) => [m.fromMe, m.senderName, m.ts, m.text, m.attachments?.length ?? 0]),
    [
      [false, 'Jane Doe', Date.parse('2026-09-24T10:15:00.000Z'), 'Merhaba, kupa ne zaman kargolanır?', 0],
      [true, 'Ben', Date.parse('2026-09-24T10:15:00.000Z') + 1, 'Yarın kargoda!', 0],
      [false, 'Jane Doe', Date.parse('2026-09-24T11:00:00.000Z'), '', 1],
      [true, 'Ben', Date.parse('2026-09-24T11:05:00.000Z'), 'Teşekkürler', 0],
    ],
  );
  assert.equal(a[2].id, 'm77', 'data-message-id varsa o kullanılır');
  // ikinci okuma aynı kimlikleri üretir (yoklamalar arası kopya yok)
  const b = await etsy.messages(etsyPage('https://www.etsy.com/messages/9001', { messages: rows, me }), {}, '9001', 20);
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
  assert.equal(new Set(a.map((m) => m.id)).size, 4);
  // before: yalnızca daha eskiler; limit: sondan
  const older = await etsy.messages(etsyPage('https://www.etsy.com/messages/9001', { messages: rows, me }), {}, '9001', 1, Date.parse('2026-09-24T11:00:00.000Z'));
  assert.deepEqual(older.map((m) => m.text), ['Yarın kargoda!']);
  // send() sonrası verilen kimlik, aynı dakikadaki DOM satırıyla aynı
  const t0 = new Date(2026, 8, 25, 12, 0, 30);
  const sent = sentMessageId('9001', 'selam', t0);
  const [row] = rowsToMessages('9001', [{ id: '', sender: 'Kaan', text: 'selam', time: '12:00', me: true, images: [] }], 'Kaan', t0);
  assert.equal(row.id, sent);
  // aynı dakikada özdeş iki mesaj ayrı kimlik alır
  const dup = rowsToMessages('9001', [
    { id: '', sender: 'Kaan', text: 'selam', time: '12:00', me: true, images: [] },
    { id: '', sender: 'Kaan', text: 'selam', time: '12:00', me: true, images: [] },
  ], 'Kaan', t0);
  assert.notEqual(dup[0].id, dup[1].id);
  assert.equal(rowToThread({ id: '1', name: 'A', preview: 'x', time: '', unread: false }).kind, 'direct');
});

test('etsy loggedIn: signin adresi → hayır; pasifte yalnızca URL; aktifte /messages\'a gidip DOM izine bakar', async () => {
  assert.equal(await etsy.loggedIn(etsyPage('https://www.etsy.com/signin', {}), { etala: '1', uaid: 'x' }, true), false);
  assert.equal(await etsy.loggedIn(etsyPage('https://www.etsy.com/messages', {}), {}, true), true);
  assert.equal(await etsy.loggedIn(etsyPage('https://www.etsy.com/', {}), {}, true), false, 'pasif: ana sayfa oturum kanıtı değil');
  const p = etsyPage('https://www.etsy.com/', { me: { name: 'Kaan', id: '55' } });
  assert.equal(await etsy.loggedIn(p, {}, false), true);
  assert.deepEqual(p.gotos, ['https://www.etsy.com/messages']);
  // gezinme /signin'e düşerse hayır
  const p2 = etsyPage('https://www.etsy.com/', { redirectTo: 'https://www.etsy.com/signin?from_page=x' });
  assert.equal(await etsy.loggedIn(p2, {}, false), false);
});
