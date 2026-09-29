import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pazaryeri + Slack (xoxp) eşitleme doğruluğu: kayıpsız imleç, uyku telafisi, LRU kırpma, zaman damgaları, dilimli ingest
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-market-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { SlackConnector } = await import('../src/connectors/slack.js');
const { TrendyolConnector } = await import('../src/connectors/trendyol.js');
const { PttAvmConnector } = await import('../src/connectors/pttavm.js');
const { N11Connector } = await import('../src/connectors/n11.js');
const { EtsyConnector } = await import('../src/connectors/etsy.js');
const { ingestChunked } = await import('../src/connectors/market-state.js');
const { sessionDir } = await import('../src/config.js');

let n = 0;
const newStore = () => new Store(path.join(tmp, `m${++n}.db`));
type Priv = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ───────────── Slack ─────────────

/** Slack conversations.history davranışı: oldest/latest aralığında EN YENİ `limit` mesaj, imleç daha eskiye gider */
function fakeSlack(msgs: Array<{ ts: string; user: string; text: string }>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    web: {
      users: { info: async () => ({ user: { real_name: 'Ayşe', name: 'ayse' } }) },
      conversations: {
        history: async (a: { oldest?: string; latest?: string; limit: number; cursor?: string }) => {
          calls.push(a);
          const list = msgs.filter((m) => (!a.oldest || Number(m.ts) > Number(a.oldest)) && (!a.latest || Number(m.ts) < Number(a.latest))).sort((x, y) => Number(y.ts) - Number(x.ts));
          const off = a.cursor ? Number(a.cursor) : 0;
          const more = off + a.limit < list.length;
          return { messages: list.slice(off, off + a.limit), has_more: more, response_metadata: { next_cursor: more ? String(off + a.limit) : '' } };
        },
      },
    },
  };
}

function slackSetup(store = newStore(), id = `slack:${++n}`) {
  const account = { id, platform: 'slack' as const, label: 's', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new SlackConnector(account, store, 'xoxp-test') as unknown as Priv;
  c.meId = 'UME';
  c.startedAt = Date.now() - 3600_000;
  return { store, account, c };
}

test('slack xoxp: iki yoklama arasında 50 mesaj → hepsi alınır; >1000 birikimde boşluk sonraki turda kapanır; yeniden açılışta kalıcı imleç', async () => {
  const base = Date.now() / 1000 - 3000;
  const msgs: Array<{ ts: string; user: string; text: string }> = [];
  const add = (k: number) => {
    for (let i = 0; i < k; i++) msgs.push({ ts: (base + msgs.length).toFixed(6), user: 'U1', text: `m${msgs.length}` });
  };
  add(25);
  const { store, account, c } = slackSetup();
  const fake = fakeSlack(msgs);
  c.web = fake.web;
  const chat = `${account.id}/C1`;
  await c.fetchHistory({ id: 'C1' }, true);
  assert.equal(store.listMessages(chat, 5000).length, 25, 'ilk kurulum: son mesajlar');

  add(50);
  await c.fetchHistory({ id: 'C1' }, false);
  assert.equal(store.listMessages(chat, 5000).length, 75, 'aradaki 50 mesajın hiçbiri kaybolmaz');

  // tur sınırını (5 × 200) aşan birikim: imleç ilerlemez, kalan aralık bir sonraki turda
  add(1300);
  await c.fetchHistory({ id: 'C1' }, false);
  assert.equal(store.listMessages(chat, 5000).length, 75 + 1000);
  assert.ok(c.gaps.has('C1'), 'boşluk kaydı');
  add(3);
  await c.fetchHistory({ id: 'C1' }, false); // kalan 300
  assert.equal(store.listMessages(chat, 5000).length, 75 + 1300);
  assert.ok(!c.gaps.has('C1'));
  await c.fetchHistory({ id: 'C1' }, false); // boşluk kapanınca en yeniler
  assert.equal(store.listMessages(chat, 5000).length, msgs.length);

  // kapat → uygulama kapalıyken 40 mesaj → yeniden aç: imleç depodan, ilk turda oldest=imleç
  c.saveCursors();
  const unreadBefore = store.getChat(chat)!.unread;
  add(40);
  const r = slackSetup(store, account.id);
  r.c.web = fakeSlack(msgs).web;
  r.c.loadCursors();
  await r.c.fetchHistory({ id: 'C1' }, true);
  assert.equal(store.listMessages(chat, 5000).length, msgs.length, 'yeniden açılışta kayıp yok');
  assert.equal(store.getChat(chat)!.unread, unreadBefore, 'birikmiş eskiler ilk turda canlı (bildirim) sayılmaz');
});

// ───────────── Trendyol ─────────────

const DAY = 86_400_000;
const NOW = Date.now();
type Call = { url: string };
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url });
    const res = handler(url) ?? { status: 404, body: '' };
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return new Response(text, { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const page = (content: unknown[]) => ({ content, page: 0, size: 200, totalPages: 1, totalElements: content.length });
const PKG = (no: number, t: number) => ({ id: no, orderNumber: String(no), status: 'Created', orderDate: t, lastModifiedDate: t, customerFirstName: 'A', lines: [{ productName: 'X', quantity: 1, amount: 10 }] });
const Q = (id: number, t: number, over: Record<string, unknown> = {}) => ({ id, text: 'Soru metni burada', creationDate: t, status: 'WAITING_FOR_ANSWER', productName: 'Ürün', userName: 'M', ...over });

function tySetup(orders = true) {
  const store = newStore();
  const account = { id: `trendyol:m${n}`, platform: 'trendyol' as const, label: 'Trendyol', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new TrendyolConnector(account, store, JSON.stringify({ orders, sellerId: '1', apiKey: 'k', apiSecret: 's' }));
  return { store, account, c, p: c as unknown as Priv };
}
const inRange = (url: string, t: number) => {
  const u = new URL(url);
  return Number(u.searchParams.get('startDate')) <= t && t <= Number(u.searchParams.get('endDate'));
};

test('trendyol: 3 günü aşan uykudan sonra aradaki soru alınır; yarım kalan ilk eşitleme toplananları atmaz ve sonraki turda tamamlanır', async () => {
  const oldQ = Q(1, NOW - 60 * DAY); // ilk eşitlemede ≈2 ay önceki dilim
  let failOld = true;
  fakeFetch((url) => {
    if (url.includes('/questions/filter')) {
      if (inRange(url, oldQ.creationDate)) return failOld ? { status: 500, body: 'x' } : { body: page([oldQ]) };
      if (inRange(url, NOW - 5 * DAY)) return { body: page([Q(2, NOW - 5 * DAY)]) };
      return { body: page([]) };
    }
    return { body: page([]) };
  });
  const { c, p, store, account, } = tySetup(false);
  await c.start();
  assert.equal(account.status, 'connected');
  assert.ok(store.getChat(`${account.id}/q-2`), 'hatasız dilimlerin soruları atılmaz');
  assert.ok(!store.getChat(`${account.id}/q-1`));
  assert.equal(p.lastOkQ, 0, 'yarım eşitleme imleci ilerletmez');
  failOld = false;
  await p.poll(false);
  assert.ok(store.getChat(`${account.id}/q-1`), 'sonraki tur tam eşitlemeyi tamamlar');
  assert.ok(p.lastOkQ > 0);

  // 5 gün uyku: sonraki tur son başarılıdan beri (2 haftalık dilimle) ister
  const sleepQ = Q(3, NOW - 4 * DAY);
  p.lastOkQ = NOW - 5 * DAY;
  const calls = fakeFetch((url) => (url.includes('/questions/filter') && inRange(url, sleepQ.creationDate) ? { body: page([sleepQ]) } : { body: page([]) }));
  await p.poll(false);
  assert.ok(store.getChat(`${account.id}/q-3`), 'uykuda gelen soru kaçmaz');
  const qCalls = calls.filter((x) => x.url.includes('/questions/filter'));
  for (const x of qCalls) {
    const u = new URL(x.url);
    assert.ok(Number(u.searchParams.get('endDate')) - Number(u.searchParams.get('startDate')) <= 14 * DAY, '2 haftalık sınır aşılmaz');
  }
  // normal turda eskisi gibi tek istek (son 3 gün)
  await p.poll(false);
  assert.equal(calls.filter((x) => x.url.includes('/questions/filter')).length - qCalls.length, 1);
});

test('trendyol: kalıcı hata veren eski dilim her turda tam eşitlemeyi yinelemez (geniş istek aralıklı)', async () => {
  const oldT = NOW - 60 * DAY;
  const calls = fakeFetch((url) => (url.includes('/questions/filter') && inRange(url, oldT) ? { status: 500, body: 'x' } : { body: page([]) }));
  const { c, p } = tySetup(false);
  await c.start();
  const qn = () => calls.filter((x) => x.url.includes('/questions/filter')).length;
  const afterFirst = qn();
  await p.poll(false); // ilk turun hatası hemen bir kez daha geniş denenir
  assert.ok(qn() - afterFirst > 1);
  const afterRetry = qn();
  await p.poll(false);
  await p.poll(false);
  assert.equal(qn() - afterRetry, 2, 'arada yalnız son 3 gün (tur başına tek istek)');
  assert.equal(p.lastOkQ, 0, 'dar tur imleci ilerletmez');
});

test('trendyol: 2500 siparişlik ilk turda kırpma en yenileri tutar, ikinci açılış 0 güncelleme; değişiklik yoksa durum dosyası yazılmaz', async () => {
  // v2 sayfası DESC (en yeni önce); tek dilimde döner
  const all = Array.from({ length: 2500 }, (_, i) => PKG(100000 + i, NOW - 20 * DAY + i * 60_000)).reverse();
  fakeFetch((url) => {
    if (url.includes('/v2/orders')) {
      const u = new URL(url);
      const pg = Number(u.searchParams.get('page'));
      if (!inRange(url, NOW - DAY)) return { body: page([]) };
      return { body: { content: all.slice(pg * 200, pg * 200 + 200), totalPages: Math.ceil(all.length / 200) } };
    }
    return { body: page([]) };
  });
  const { c, p, store, account } = tySetup(true);
  await c.start();
  assert.equal(account.status, 'connected');
  const pk = p.packages as Map<string, unknown>;
  assert.equal(pk.size, 2000);
  assert.ok(pk.has('102499'), 'en yeni sipariş tutulur');
  assert.ok(!pk.has('100000'), 'en eskisi atılır');
  assert.ok((p.seen as Map<string, string>).has('order-102499'));

  // yeniden açılış: aynı durum dosyasıyla yeni connector → hiçbir sipariş "yeni" sayılmaz
  const c2 = new TrendyolConnector(account, store, JSON.stringify({ orders: true, sellerId: '1', apiKey: 'k', apiSecret: 's' })) as unknown as Priv;
  let changed = -1;
  const orig = c2.ingestOrder.bind(c2);
  changed = 0;
  c2.ingestOrder = (...a: unknown[]) => {
    const r = orig(...a);
    if (r) changed++;
    return r;
  };
  await c2.poll(true);
  assert.equal(changed, 0);

  // değişiklik yoksa (ilk olmayan tur) dosya yeniden yazılmaz
  const file = path.join(sessionDir(account.id), 'trendyol-state.json');
  fs.rmSync(file);
  await c2.poll(false);
  assert.ok(!fs.existsSync(file), 'değişmeyen turda yazım yok');
});

test('trendyol: ilk görülen raporlanmış soru "şimdi"ye sıçramaz; ePttAVM ilk görülen durum sipariş zamanına yakın', async () => {
  fakeFetch((url) => (url.includes('/questions/filter') && inRange(url, NOW - 10 * DAY) ? { body: page([Q(9, NOW - 10 * DAY, { status: 'REPORTED', reportReason: 'spam' })]) } : { body: page([]) }));
  const { c, store, account } = tySetup(false);
  await c.start();
  const chat = store.getChat(`${account.id}/q-9`)!;
  assert.ok(chat.lastMessageAt < NOW - 9 * DAY, 'sohbet sırası soru zamanında kalır');

  const RESP = (no: string, durum: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SiparisKontrolListesiV2Response xmlns="http://tempuri.org/"><SiparisKontrolListesiV2Result xmlns:a="x"><a:TedarikciSiparisKontrolV2><a:IslemTarihi>2026-09-10T14:05:00</a:IslemTarihi><a:MusteriAdi>A</a:MusteriAdi><a:SiparisNo>${no}</a:SiparisNo><a:SiparisUrunler><a:SiparisUrun><a:KdvDahilToplamTutar>10</a:KdvDahilToplamTutar><a:SiparisDurumu>${durum}</a:SiparisDurumu><a:ToplamIslemAdedi>1</a:ToplamIslemAdedi><a:Urun>K</a:Urun></a:SiparisUrun></a:SiparisUrunler></a:TedarikciSiparisKontrolV2></SiparisKontrolListesiV2Result></SiparisKontrolListesiV2Response></s:Body></s:Envelope>`;
  globalThis.fetch = (async () => new Response(RESP('P-1', 'Teslim Edildi'), { status: 200 })) as typeof fetch;
  const store2 = newStore();
  const acc = { id: `pttavm:m${n}`, platform: 'pttavm' as const, label: 'ePttAVM', status: 'disconnected' as const, createdAt: 1 };
  store2.upsertAccount(acc);
  const pc = new PttAvmConnector(acc, store2, JSON.stringify({ username: 'u', password: 'p' }));
  await pc.start();
  const msgs = store2.listMessages(`${acc.id}/order-P-1`);
  const created = msgs.find((m) => m.remoteId === 'new-P-1')!;
  const st = msgs.find((m) => m.remoteId.startsWith('st-P-1'))!;
  assert.equal(st.ts, created.ts + 1);
  assert.ok(store2.getChat(`${acc.id}/order-P-1`)!.lastMessageAt < Date.now() - DAY);
});

test('ePttAVM: uyku sonrası son başarılıdan beri haftalık dilimler (en çok 4 hafta)', async () => {
  const bodies: string[] = [];
  globalThis.fetch = (async (_u: unknown, init: RequestInit = {}) => (bodies.push(String(init.body)), new Response('<x/>', { status: 200 }))) as typeof fetch;
  const store = newStore();
  const acc = { id: `pttavm:s${n}`, platform: 'pttavm' as const, label: 'ePttAVM', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const pc = new PttAvmConnector(acc, store, JSON.stringify({ username: 'u', password: 'p' })) as unknown as Priv;
  pc.lastOk = Date.now() - 10 * DAY;
  await pc.poll(false);
  assert.equal(bodies.length, 2, '10 gün → 2 haftalık dilim');
  bodies.length = 0;
  await pc.poll(false);
  assert.equal(bodies.length, 1, 'normal turda tek istek (son 3 gün)');
});

// ───────────── n11 ─────────────

test('n11: tarihi bilinmeyen soru ayrıntı gelene dek işlenmez; denenip alınamazsa "şimdi" değil tarihsiz', () => {
  const store = newStore();
  const acc = { id: `n11:m${n}`, platform: 'n11' as const, label: 'n11', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const c = new N11Connector(acc, store, JSON.stringify({ appKey: 'a', appSecret: 'b' })) as unknown as Priv;
  assert.equal(c.ingestQuestion({ id: '5', question: 'Soru?' }, false), false);
  assert.equal(store.getChat(`${acc.id}/q-5`), undefined);
  assert.equal(c.state.seen['q-5'], undefined, 'seen yazılmaz, sonra işlenir');
  assert.equal(c.ingestQuestion({ id: '5', question: 'Soru?', detailTried: Date.now() }, false), true);
  assert.ok(store.getChat(`${acc.id}/q-5`)!.lastMessageAt < Date.now() - 365 * DAY);
  const t = Date.now() - 30 * DAY;
  assert.equal(c.ingestQuestion({ id: '6', question: 'Soru?', questionDate: t }, false), true);
  assert.equal(store.getChat(`${acc.id}/q-6`)!.lastMessageAt, t);
});

// ───────────── Etsy ─────────────

test('etsy: since durum dosyasında saklanır; eski düz biçim okunur', () => {
  const store = newStore();
  const acc = { id: `etsy:m${n}`, platform: 'etsy' as const, label: 'Etsy', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const file = path.join(sessionDir(acc.id), 'etsy-state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ '123': 'sig' }));
  const old = new EtsyConnector(acc, store, '{}') as unknown as Priv;
  assert.equal(old.seen.get('123'), 'sig');
  assert.equal(old.since, undefined);
  old.since = 1700000000000;
  old.saveState();
  const again = new EtsyConnector(acc, store, '{}') as unknown as Priv;
  assert.equal(again.seen.get('123'), 'sig');
  assert.equal(again.since, 1700000000000);
});

// ───────────── dilimli ingest ─────────────

test('ingestChunked: olay döngüsü dilimler arasında döner, sıra korunur, durdurulunca kalanlar işlenmez', async () => {
  const store = newStore();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  const seenOrder: number[] = [];
  const items = Array.from({ length: 1000 }, (_, i) => i);
  await ingestChunked(store, items, (i) => {
    const until = Date.now() + (i % 200 === 0 ? 5 : 0);
    while (Date.now() < until);
    seenOrder.push(i);
  });
  clearInterval(iv);
  assert.deepEqual(seenOrder, items);
  assert.ok(ticks >= 1, 'dilimler arasında zamanlayıcılar çalışır');
  const partial: number[] = [];
  const ok = await ingestChunked(store, items, (i) => partial.push(i), () => partial.length >= 200);
  assert.equal(ok, false);
  assert.equal(partial.length, 200);
});
