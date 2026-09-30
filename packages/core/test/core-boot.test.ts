import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-coreboot-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { Registry } = await import('../src/registry.js');
const { bus } = await import('../src/bus.js');
const { browserSlots, memForBrowsers } = await import('../src/boot-plan.js');
const { pruneMediaCache } = await import('../src/media-prune.js');
const GB = 1024 ** 3;

test('browserSlots: macOS belleği free_count yerine toplamdan (8 çekirdek/8-16 GB → 2 yuva)', () => {
  delete process.env.MIVELO_BOOT_SLOTS;
  assert.equal(memForBrowsers('darwin'), os.totalmem() * 0.35);
  assert.ok(memForBrowsers('linux') > 0, 'Linux/Windows: os.freemem() (gerçekçi)');
  assert.equal(browserSlots(8, 8 * GB * 0.35), 2);
  assert.equal(browserSlots(8, 16 * GB * 0.35), 2);
  assert.equal(browserSlots(10, 16 * GB * 0.35), 3);
});

test('bootAll: sıradaki tarayıcı kanalları kopuk/yeşil kalmaz, "connecting" görünür; pairing korunur', async () => {
  process.env.MIVELO_BOOT_SLOTS = '1';
  // eski motor (köprü ikilisi yokken): Instagram/LinkedIn/X tarayıcı kanalı olarak açılış sırasına girer
  process.env.MIVELO_ENGINE = 'legacy';
  const store = new Store(path.join(tmp, 'b.db'));
  const reg = new Registry(store);
  const mk = (id: string, platform: 'instagram' | 'linkedin' | 'x' | 'whatsapp', status: 'disconnected' | 'connected' | 'pairing') =>
    store.upsertAccount({ id, platform, label: platform, status, createdAt: 1 });
  mk('instagram:1', 'instagram', 'disconnected');
  mk('linkedin:1', 'linkedin', 'connected'); // çökme sonrası kalan sahte yeşil
  mk('x:1', 'x', 'pairing');
  mk('whatsapp:1', 'whatsapp', 'disconnected');
  const spawned: string[] = [];
  (reg as unknown as { spawn: (a: { id: string }) => Promise<void> }).spawn = async (a) => void spawned.push(a.id);
  const evs: string[] = [];
  const off = bus.on((ev) => ev.type === 'account.status' && evs.push(`${ev.account.id}:${ev.account.status}`));
  await reg.bootAll();
  off();
  const st = Object.fromEntries(reg.list().map((a) => [a.id, a]));
  assert.equal(st['instagram:1'].status, 'connecting');
  assert.equal(st['linkedin:1'].status, 'connecting');
  assert.equal(st['x:1'].status, 'pairing');
  assert.equal(st['whatsapp:1'].status, 'disconnected', 'hafif kanal kendi start()ında yazar');
  const queued = [st['instagram:1'], st['linkedin:1']].filter((a) => a.detail === 'Açılış sırası bekleniyor');
  assert.equal(queued.length, 1, 'yuvayı alan sırada değil, ikinci sırada');
  assert.ok(evs.includes('instagram:1:connecting') && evs.includes('linkedin:1:connecting'));
  assert.equal(spawned.length, 4);
  delete process.env.MIVELO_BOOT_SLOTS;
  delete process.env.MIVELO_ENGINE;
  await reg.stopAll();
  store.close();
});

test('kendiliğinden iyileşme: sağlayıcının istediği bekleme (retryAfterMs) beklenir, uyarı görünür kalır', async () => {
  const store = new Store(path.join(tmp, 'h.db'));
  const reg = new Registry(store);
  const acc = { id: 'imap:1', platform: 'imap' as const, label: 'imap', status: 'disconnected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const fake = { account: acc, retryAfterMs: 15 * 60_000, start: async () => undefined, stop: async () => undefined, sendText: async () => undefined };
  (reg as unknown as { connectors: Map<string, unknown> }).connectors.set(acc.id, fake);
  let heals = 0;
  (reg as unknown as { healNow: () => Promise<void> }).healNow = async () => void heals++;
  const ev = { ...acc, status: 'error' as const, detail: 'Command failed — SELECT Server Unavailable. 15' };
  store.upsertAccount(ev);
  bus.emit({ type: 'account.status', account: ev });
  assert.equal((ev as { autoRetry?: boolean }).autoRetry, undefined, 'uzun bekleme: uyarı gizlenmez');
  assert.equal(reg.list()[0].autoRetry, undefined);
  const h = (reg as unknown as { heal: Map<string, { timer?: NodeJS.Timeout & { _idleTimeout?: number } }> }).heal.get(acc.id)!;
  assert.ok(h.timer, 'yine de arka planda denenecek');
  assert.ok((h.timer._idleTimeout ?? 0) >= 15 * 60_000, 'en erken 15 dk sonra');
  assert.equal(heals, 0);
  await reg.stopAll();
  store.close();
});

test('medya budaması: WhatsApp media-index, e-posta ekleri ve out- dosyaları kalır; tarayıcı önbelleği silinir; günde bir', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'prune-'));
  const old = new Date(Date.now() - 61 * 86_400_000);
  const put = (rel: string) => {
    const fp = path.join(dir, 'sessions', rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'x');
    fs.utimesSync(fp, old, old);
    return fp;
  };
  const keep = [put('whatsapp_1/media-index/ABC.json'), put('gmail_1/media/ek.pdf'), put('imap:2/media/cid.png'), put('imessage_1/media/out-1.jpg'), put('instagram_1/media/new.jpg')];
  fs.utimesSync(keep[4], new Date(), new Date());
  const gone = put('instagram_1/media/old.jpg');
  const meta = new Map<string, string>();
  const store = { meta: (k: string) => meta.get(k), setFlag: (k: string, v = '1') => void meta.set(k, v) };
  assert.equal(await pruneMediaCache(store as never, dir), 1);
  for (const f of keep) assert.equal(fs.existsSync(f), true, f);
  assert.equal(fs.existsSync(gone), false);
  // 24 saat dolmadan yeniden taranmaz
  put('instagram_1/media/old2.jpg');
  assert.equal(await pruneMediaCache(store as never, dir), 0);
  assert.equal(await pruneMediaCache(store as never, dir, Date.now() + 25 * 3_600_000), 1);
});
