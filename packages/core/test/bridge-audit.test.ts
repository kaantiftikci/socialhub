import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-bridge-audit-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { BrowserConnector } = await import('../src/connectors/browser/bridge.js');
type Strategy = ConstructorParameters<typeof BrowserConnector>[2];
type Thread = { id: string; name: string; kind: 'direct'; unread: number; lastTs: number; preview: string };
type M = { id: string; text: string; ts: number; fromMe: boolean; senderId: string; senderName: string; reactions?: unknown[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

/** Sayfasız sahte bağlantılı köprü; strateji çağrıları kayda geçer */
function setup(store: InstanceType<typeof Store>, platform: 'linkedin' | 'slack', strat: Partial<Record<string, unknown>>) {
  const account = { id: `${platform}:a${++n}`, platform, label: 't', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  return make(store, account, strat);
}
function make(store: InstanceType<typeof Store>, account: { id: string; platform: 'linkedin' | 'slack'; label: string; status: 'connected'; createdAt: number }, strat: Partial<Record<string, unknown>>) {
  const strategy = { home: 'https://example.com/', loginHint: '', pageless: true, async loggedIn() { return true; }, async send() { return 'sent1'; }, ...strat } as unknown as Strategy;
  const conn = new BrowserConnector({ ...account }, store, strategy, 60_000);
  const c = conn as unknown as Record<string, unknown>;
  c.pageless = true;
  c.state = { cookies: [], origins: [] };
  c.api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => undefined };
  const poll = (first: boolean) => (c.pollInner as (f: boolean) => Promise<void>).call(conn, first);
  return { conn, c, poll, account };
}

test('köprü: yeniden başlatmada mesajları depoda güncel olan sohbetler yeniden çekilmez (yalnız eksik/yeni olanlar)', async () => {
  const store = new Store(path.join(tmp, 'seed.db'));
  const threads: Thread[] = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: 'direct', unread: 0, lastTs: 10_000 + i * 1000, preview: `m${i}` }));
  const msgsOf = (id: string): M[] => {
    const t = threads.find((x) => x.id === id)!;
    return [{ id: `${id}-m`, text: t.preview, ts: t.lastTs, fromMe: false, senderId: 'u', senderName: 'U' }];
  };
  const asked: string[] = [];
  const strat = {
    async threads() {
      return threads.map((t) => ({ ...t }));
    },
    async messages(_p: unknown, _c: unknown, id: string) {
      asked.push(id);
      return msgsOf(id);
    },
  };
  const a = setup(store, 'slack', strat);
  // ilk oturum: 16 + 8 + 8 tur → hepsi alınır
  await a.poll(true);
  await a.poll(false);
  await a.poll(false);
  assert.equal(new Set(asked).size, 30);
  // c29 mesajı çekirdek kapalıyken geldi; c28'in mesajları hiç alınmamış (depoda yok)
  threads[29] = { ...threads[29], lastTs: 99_000, preview: 'yeni' };
  (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db.prepare('DELETE FROM messages WHERE chat_id = ?').run(`${a.account.id}/c28`);
  asked.length = 0;
  const b = make(store, a.account, strat); // yeni connector (yeniden başlatma): known boş
  await b.poll(true);
  assert.deepEqual(asked.sort(), ['c28', 'c29'], 'yalnız eksik ve yeni etkinlikli sohbetler');
  assert.equal((b.c.backlogLeft as number), 0, 'hızlandırılmış backfill turu yok');
  store.close();
});

test('köprü: önizleme değişimine dayalı lastTs (0 sonraki turda) — tur sınırı dışında kalan / düşen sohbet yine çekilir', async () => {
  const store = new Store(path.join(tmp, 'pend.db'));
  const previews = new Map<string, string>();
  const last = new Map<string, string>(); // stratejinin kendi bellekteki önizleme haritası (messenger.ts rowToThread gibi)
  for (let i = 0; i < 12; i++) previews.set(`c${i}`, 'a');
  let failing = new Set<string>();
  const asked: string[] = [];
  const strat = {
    async threads() {
      return [...previews].map(([id, pv]) => {
        const prev = last.get(id);
        last.set(id, pv);
        return { id, name: id, kind: 'direct', unread: 0, lastTs: prev !== undefined && prev !== pv ? Date.now() : 0, preview: pv };
      });
    },
    async messages(_p: unknown, _c: unknown, id: string) {
      asked.push(id);
      if (failing.has(id)) throw new Error('mesajlar: 60 sn içinde yanıt gelmedi');
      return [{ id: `${id}-${previews.get(id)}`, text: previews.get(id)!, ts: Date.now(), fromMe: false, senderId: 'u', senderName: 'U' }];
    },
  };
  const { poll, c } = setup(store, 'linkedin', strat);
  await poll(true);
  // 12 değişim birden: 8'lik tur, 4'ü dışarıda kalır
  for (let i = 0; i < 12; i++) previews.set(`c${i}`, 'b');
  failing = new Set(['c0']);
  asked.length = 0;
  await poll(false);
  assert.equal(asked.length, 8);
  // sonraki turda strateji lastTs=0 veriyor: kalan 4 yine çekilmeli; hata alan c0 bekleme süresinde
  asked.length = 0;
  await poll(false);
  const pend = c.pendingFetch as Map<string, { tries: number; next: number }>;
  assert.equal(asked.length, 4, `kalan 4 sohbet çekildi (${asked.join(',')})`);
  assert.ok(!asked.some((id) => pend.has(id)));
  const failed = [...pend.entries()];
  assert.equal(failed.length, 1, 'yalnız hata alan beklemede');
  assert.equal(failed[0][1].tries, 1);
  assert.ok(failed[0][1].next > Date.now() + 30_000, 'üstel bekleme');
  // bekleme bitince (ve hata geçince) alınır
  failing = new Set();
  failed[0][1].next = 0;
  asked.length = 0;
  await poll(false);
  assert.deepEqual(asked, [failed[0][0]]);
  assert.equal(pend.size, 0);
  store.close();
});

test('köprü: tepki durumu çekirdek yeniden başlayınca da korunur (okunmamış + eski önizleme geri gelmez)', async () => {
  const store = new Store(path.join(tmp, 'rx.db'));
  let thread: Thread = { id: 'c1', name: 'Ayşe Yılmaz', kind: 'direct', unread: 0, lastTs: 1000, preview: 'merhaba' };
  let msgs: M[] = [{ id: 'm1', text: 'merhaba', ts: 1000, fromMe: true, senderId: 'me', senderName: 'Ben' }];
  const strat = {
    async threads() {
      return [thread];
    },
    async messages() {
      return msgs;
    },
  };
  const a = setup(store, 'linkedin', strat);
  await a.poll(true);
  thread = { ...thread, unread: 1, lastTs: 2000 };
  msgs = [{ ...msgs[0], reactions: [{ emoji: '👍', senderId: 'u1', senderName: 'Ayşe Yılmaz', fromMe: false }] }];
  await a.poll(false);
  const cid = `${a.account.id}/c1`;
  assert.equal(store.getChat(cid)!.lastReaction, true);
  // yeniden başlatma: platform hâlâ okunmamış diyor
  const b = make(store, a.account, strat);
  await b.poll(true);
  const chat = store.getChat(cid)!;
  assert.equal(chat.unread, 0, 'tepki okunmamış sayılmaz');
  assert.equal(chat.lastReaction, true);
  assert.equal(chat.lastPreview, '👍 Ayşe mesajına tepki verdi');
  // gerçek mesaj gelince olağan
  thread = { ...thread, unread: 1, lastTs: 3000, preview: 'nasılsın' };
  msgs = [...msgs, { id: 'm2', text: 'nasılsın', ts: 3000, fromMe: false, senderId: 'u1', senderName: 'Ayşe Yılmaz' }];
  await b.poll(false);
  assert.equal(store.getChat(cid)!.unread, 1);
  assert.equal(store.getChat(cid)!.lastPreview, 'nasılsın');
  store.close();
});

test('köprü: değişmeyen sohbetler her turda yeniden yazılıp yayınlanmaz (ölçüm: 1000 sohbet)', async () => {
  const store = new Store(path.join(tmp, 'noop.db'));
  const threads: Thread[] = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: 'direct', unread: i % 7 === 0 ? 1 : 0, lastTs: 10_000 + i, preview: `m${i}` }));
  const strat = {
    async threads() {
      return threads.map((t) => ({ ...t }));
    },
    async messages(_p: unknown, _c: unknown, id: string) {
      const t = threads.find((x) => x.id === id)!;
      return [{ id: `${id}-m`, text: t.preview, ts: t.lastTs, fromMe: false, senderId: 'u', senderName: 'U' }];
    },
  };
  const { poll, c } = setup(store, 'slack', strat);
  // tüm sohbetlerin mesajları alınmış say (bu test yalnız liste yazımını ölçer)
  await poll(true);
  for (const t of threads) (c.known as Map<string, number>).set(t.id, t.lastTs);
  let upserts = 0;
  const off = bus.on((ev) => {
    if (ev.type === 'chat.upsert') upserts++;
  });
  const t0 = performance.now();
  await poll(false);
  const ms = performance.now() - t0;
  assert.equal(upserts, 0, 'değişiklik yokken chat.upsert yok');
  // tek sohbet değişince yalnız o yazılır
  threads[5] = { ...threads[5], name: 'Yeni ad' };
  await poll(false);
  off();
  assert.equal(upserts, 1);
  assert.equal(store.getChat(`${(c.account as { id: string }).id}/c5`)!.name, 'Yeni ad');
  console.log(`# değişikliksiz tur (1000 sohbet): ${ms.toFixed(1)} ms`);
  store.close();
});

test('köprü: gönderim kuyrukta bekleyen okundu/yoklama işlerinin önüne geçer', async () => {
  const store = new Store(path.join(tmp, 'urg.db'));
  const log: string[] = [];
  const { conn, c } = setup(store, 'linkedin', {
    async threads() {
      return [];
    },
    async messages() {
      return [];
    },
    async send(_p: unknown, _c: unknown, id: string) {
      log.push('send ' + id);
      return 'x1';
    },
  });
  const serial = (fn: () => Promise<void>) => (c.serial as (f: () => Promise<void>) => Promise<void>).call(conn, fn);
  const a = serial(async () => {
    log.push('A başladı');
    await sleep(80);
    log.push('A bitti');
  });
  const b = serial(async () => {
    log.push('B (kuyrukta bekleyen tur)');
  });
  await sleep(10);
  const s = conn.sendText('c1', 'selam');
  await Promise.all([a, b, s]);
  assert.deepEqual(log, ['A başladı', 'A bitti', 'send c1', 'B (kuyrukta bekleyen tur)']);
  store.close();
});

test('köprü: markRead aynı sohbet için birleşir', async () => {
  const store = new Store(path.join(tmp, 'mr.db'));
  let reads = 0;
  const { conn, c } = setup(store, 'linkedin', {
    async threads() {
      return [];
    },
    async messages() {
      return [];
    },
    async markRead() {
      reads++;
      await sleep(20);
    },
  });
  const serial = (fn: () => Promise<void>) => (c.serial as (f: () => Promise<void>) => Promise<void>).call(conn, fn);
  const hold = serial(() => sleep(40));
  await Promise.all([hold, conn.markRead('c1'), conn.markRead('c1'), conn.markRead('c1'), conn.markRead('c2')]);
  assert.equal(reads, 2);
  store.close();
});

test('köprü: ağ hatası oturum düşmesi sayılmaz (tarayıcı açılmaz, durum bağlı kalır, kısa geri çekilme)', async () => {
  const store = new Store(path.join(tmp, 'net.db'));
  let checks = 0;
  const { conn, c, poll } = setup(store, 'slack', {
    async threads() {
      throw new Error('Slack client.counts: ağ hatası (TypeError: Failed to fetch)');
    },
    async messages() {
      return [];
    },
    async loggedIn() {
      checks++;
      return false;
    },
  });
  let opened = 0;
  c.ensureOpen = async () => {
    opened++;
    return false;
  };
  await poll(false);
  assert.equal(checks, 0);
  assert.equal(opened, 0);
  assert.equal(conn.account.status, 'connected');
  assert.ok((c.backoffUntil as number) > Date.now() + 50_000);
  store.close();
});

test('köprü: oturum düşünce sayfasız kanalın kayıtlı durumu silinir (iyileşme gerçek oturum denetimiyle açılır)', async () => {
  const store = new Store(path.join(tmp, 'drop.db'));
  const { conn, c, poll } = setup(store, 'slack', {
    async threads() {
      throw new Error('Slack client.counts: invalid_auth');
    },
    async messages() {
      return [];
    },
  });
  c.isLoggedIn = async () => false;
  const file = c.stateFile as string;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  await poll(false);
  assert.equal(conn.account.status, 'pairing');
  assert.equal(fs.existsSync(file), false);
  store.close();
});

test('köprü: tarayıcı açılırken stop() gelirse bağlam kapatılır, akış sürmez', async () => {
  const store = new Store(path.join(tmp, 'stop.db'));
  const { conn, c } = setup(store, 'linkedin', {
    async threads() {
      return [];
    },
    async messages() {
      return [];
    },
  });
  let closed = 0;
  let pages = 0;
  const ctx = {
    close: async () => {
      closed++;
    },
    addInitScript: async () => undefined,
    pages: () => [],
    newPage: async () => {
      pages++;
      return {};
    },
    on: () => undefined,
  };
  c.chromium = {
    launchPersistentContext: async () => {
      await sleep(60);
      return ctx;
    },
  };
  const launching = (c.launch as (h: boolean, r: boolean, n: boolean) => Promise<boolean>).call(conn, true, true, false);
  await sleep(10);
  await conn.stop();
  assert.equal(await launching, false);
  assert.equal(closed, 1, 'sahipsiz tarayıcı kalmaz');
  assert.equal(pages, 0, 'sayfa açılmaz');
  assert.equal(c.ctx, undefined);
  store.close();
});

test('köprü: NET_RE yalnız bağlantı hatalarını tanır (giriş sayfasına yönlenip kesilen gezinme oturum denetiminden geçer)', async () => {
  const { NET_RE } = await import('../src/connectors/browser/bridge.js');
  for (const m of ['page.goto: net::ERR_INTERNET_DISCONNECTED at https://x.com', 'getaddrinfo ENOTFOUND slack.com', 'TypeError: fetch failed', 'read ECONNRESET'])
    assert.ok(NET_RE.test(m), m);
  for (const m of ['page.goto: net::ERR_ABORTED at https://x.com/i/chat', 'net::ERR_TOO_MANY_REDIRECTS', 'net::ERR_BLOCKED_BY_RESPONSE', 'invalid_auth'])
    assert.ok(!NET_RE.test(m), m);
});
