import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js (DATA_DIR) içe aktarılmadan önce: gerçek ~/.mivelo'ya dokunulmasın
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mlauto-'));
process.env.KAVSAK_DATA_DIR = tmpData;
process.env.MIVELO_DATA_DIR = tmpData;
after(() => fs.rmSync(tmpData, { recursive: true, force: true }));

const { AutoInstaller, planAutoInstall, retryDelay, RETRY_BASE_MS, RETRY_MAX_MS, NOSPACE_RECHECK_MS } = await import('../src/ml/auto-install.js');
const { MlError } = await import('../src/ml/config.js');
type MlSettings = import('../src/ml/config.js').MlSettings;
type ModelKey = import('../src/ml/config.js').ModelKey;

const BASE: MlSettings = { autoTranscribe: false, semanticIndex: false, translateTarget: 'tr', autoInstall: true, declined: [] };

/** Ağsız sahte ortam: indirici, disk, saat ve zamanlayıcı elle sürülür */
function harness(opts: { settings?: Partial<MlSettings>; ready?: ModelKey[]; freeMb?: number; allowed?: boolean; fail?: (k: ModelKey, n: number) => Error | undefined } = {}) {
  let settings: MlSettings = { ...BASE, ...opts.settings };
  const ready = new Set<ModelKey>(opts.ready ?? []);
  let runtime = ready.size > 0;
  const installs: ModelKey[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let now = 1_000_000;
  const tries = new Map<ModelKey, number>();
  const cancelled: ModelKey[] = [];
  const inst = new AutoInstaller({
    settings: () => settings,
    save: (p) => (settings = { ...settings, ...p }),
    modelReady: (k) => ready.has(k),
    runtimeReady: () => runtime,
    install: async (k) => {
      installs.push(k);
      const n = (tries.get(k) ?? 0) + 1;
      tries.set(k, n);
      const err = opts.fail?.(k, n);
      if (err) throw err;
      runtime = true;
      ready.add(k);
    },
    cancel: (k) => cancelled.push(k),
    modelPct: (k) => (ready.has(k) ? 100 : 0),
    freeMb: async () => opts.freeMb,
    allowed: () => opts.allowed ?? true,
    emit: () => undefined,
    log: () => undefined,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = {
        fn: () => {
          t.live = false;
          fn();
        },
        ms,
        live: true,
      };
      timers.push(t);
      return { clear: () => (t.live = false) };
    },
  });
  const pending = () => timers.filter((t) => t.live);
  return { inst, installs, ready, cancelled, pending, settings: () => settings, advance: (ms: number) => (now += ms) };
}

test('ml otomatik kurulum: plan kararları (saf)', () => {
  const none = () => false;
  assert.deepEqual(planAutoInstall({ settings: BASE, ready: none, runtimeReady: false, allowed: true, freeMb: 100_000 }), { action: 'install', keys: ['whisper', 'embed'], needMb: 250 + 135 + 36 });
  assert.deepEqual(planAutoInstall({ settings: { ...BASE, autoInstall: false }, ready: none, runtimeReady: false, allowed: true }), { action: 'skip', reason: 'off' });
  assert.deepEqual(planAutoInstall({ settings: BASE, ready: () => true, runtimeReady: true, allowed: true }), { action: 'skip', reason: 'ready' });
  assert.deepEqual(planAutoInstall({ settings: BASE, ready: none, runtimeReady: false, allowed: false }), { action: 'skip', reason: 'license' });
  // reddedilen model yeniden indirilmez
  assert.deepEqual(planAutoInstall({ settings: { ...BASE, declined: ['whisper'] }, ready: none, runtimeReady: true, allowed: true }), { action: 'install', keys: ['embed'], needMb: 135 });
  assert.deepEqual(planAutoInstall({ settings: { ...BASE, declined: ['whisper', 'embed'] }, ready: none, runtimeReady: true, allowed: true }), { action: 'skip', reason: 'ready' });
  // disk: gereken × 1,2 + 500 MB
  const p = planAutoInstall({ settings: BASE, ready: none, runtimeReady: false, allowed: true, freeMb: 900 });
  assert.equal(p.action, 'nospace');
  assert.equal(planAutoInstall({ settings: BASE, ready: none, runtimeReady: false, allowed: true, freeMb: 1100 }).action, 'install');
  // disk ölçülemezse engellemez
  assert.equal(planAutoInstall({ settings: BASE, ready: none, runtimeReady: false, allowed: true }).action, 'install');
});

test('ml otomatik kurulum: yeniden deneme süresi 5 dk → katlanarak ≤ 6 sa', () => {
  assert.equal(retryDelay(1), RETRY_BASE_MS);
  assert.equal(retryDelay(2), 2 * RETRY_BASE_MS);
  assert.equal(retryDelay(3), 4 * RETRY_BASE_MS);
  assert.equal(retryDelay(20), RETRY_MAX_MS);
  assert.equal(RETRY_MAX_MS, 6 * 3_600_000);
});

test('ml otomatik kurulum: ilk açılış → ikisi de kurulur, özellikler açılır', async () => {
  const h = harness({ freeMb: 50_000 });
  h.inst.schedule(75_000);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, 75_000);
  assert.equal(h.inst.status().phase, 'scheduled');
  const readyFired: ModelKey[] = [];
  h.inst.onModelReady((k) => readyFired.push(k));
  h.pending()[0].fn();
  await h.inst.run(); // tek uçuş: süren çalışmaya katılır
  assert.deepEqual(h.installs, ['whisper', 'embed']);
  assert.deepEqual(readyFired, ['whisper', 'embed']);
  assert.equal(h.settings().autoTranscribe, true);
  assert.equal(h.settings().semanticIndex, true);
  const st = h.inst.status();
  assert.equal(st.phase, 'done');
  assert.equal(st.pct, 100);
});

test('ml otomatik kurulum: tek uçuş (aynı anda iki çalıştırma tek indirme)', async () => {
  const h = harness();
  await Promise.all([h.inst.run(), h.inst.run()]);
  assert.deepEqual(h.installs, ['whisper', 'embed']);
});

test('ml otomatik kurulum: kullanıcı kapattıysa başlamaz', async () => {
  const h = harness({ settings: { autoInstall: false } });
  await h.inst.run();
  assert.deepEqual(h.installs, []);
  assert.equal(h.inst.status().phase, 'off');
});

test('ml otomatik kurulum: kurulu → başlamaz; silinen model yeniden inmez', async () => {
  const h = harness({ ready: ['whisper', 'embed'] });
  await h.inst.run();
  assert.deepEqual(h.installs, []);
  assert.equal(h.inst.status().phase, 'idle');
  const h2 = harness({ ready: ['embed'], settings: { declined: ['whisper'] } });
  await h2.inst.run();
  assert.deepEqual(h2.installs, []);
});

test('ml otomatik kurulum: disk yetersiz → başlamaz, durum söylenir, sonra yeniden bakılır', async () => {
  const h = harness({ freeMb: 300 });
  await h.inst.run();
  assert.deepEqual(h.installs, []);
  const st = h.inst.status();
  assert.equal(st.phase, 'nospace');
  assert.match(st.error ?? '', /Diskte yer yok/);
  assert.equal(st.freeMb, 300);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, NOSPACE_RECHECK_MS);
});

test('ml otomatik kurulum: lisans yokken başlamaz', async () => {
  const h = harness({ allowed: false });
  await h.inst.run();
  assert.deepEqual(h.installs, []);
  assert.equal(h.pending().length, 1, 'sonra yeniden bakar');
});

test('ml otomatik kurulum: ağ hatası → üstel yeniden deneme, sonra kaldığı yerden', async () => {
  const h = harness({ fail: (k, n) => (k === 'embed' && n <= 2 ? new MlError(503, 'internet yok') : undefined) });
  await h.inst.run();
  assert.deepEqual(h.installs, ['whisper', 'embed']);
  assert.equal(h.settings().autoTranscribe, true, 'biten model hemen açılır');
  assert.equal(h.settings().semanticIndex, false);
  let st = h.inst.status();
  assert.equal(st.phase, 'retry');
  assert.match(st.error ?? '', /internet yok/);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, RETRY_BASE_MS);
  assert.equal(st.nextAt, 1_000_000 + RETRY_BASE_MS);
  // ikinci hata: 10 dk
  h.pending()[0].fn();
  await h.inst.run();
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, 2 * RETRY_BASE_MS);
  // üçüncü deneme başarılı: yalnız eksik model iner
  h.pending()[0].fn();
  await h.inst.run();
  assert.deepEqual(h.installs, ['whisper', 'embed', 'embed', 'embed']);
  st = h.inst.status();
  assert.equal(st.phase, 'done');
  assert.equal(st.error, undefined);
  assert.equal(h.settings().semanticIndex, true);
});

test('ml otomatik kurulum: kullanıcı iptal/kapatma', async () => {
  // iptal edilen model reddedilir, sıradaki kurulur
  // eslint-disable-next-line prefer-const
  let h: ReturnType<typeof harness>;
  h = harness({
    fail: (k) => {
      if (k !== 'whisper') return undefined;
      h.inst.decline('whisper'); // rota: önce reddet, sonra iptal et
      return new MlError(499, 'İndirme iptal edildi');
    },
  });
  await h.inst.run();
  assert.deepEqual(h.installs, ['whisper', 'embed']);
  assert.deepEqual(h.settings().declined, ['whisper']);
  assert.equal(h.settings().autoTranscribe, false);
  // kapatınca süren iş iptal edilir, ayar kaydedilir
  const h2 = harness();
  h2.inst.setEnabled(false);
  assert.equal(h2.settings().autoInstall, false);
  assert.equal(h2.inst.status().phase, 'off');
  await h2.inst.run();
  assert.deepEqual(h2.installs, []);
  // yeniden açınca reddedilenler sıfırlanır ve kısa süre sonra başlar
  h2.inst.decline('embed');
  h2.inst.setEnabled(true);
  assert.deepEqual(h2.settings().declined, []);
  assert.equal(h2.pending().at(-1)?.ms, 2_000);
});

test('ml ayarları: otomatik kurulum varsayılan açık, reddedilenler süzülür ve kalıcı', async () => {
  const { mlSettings, saveMlSettings, resetMlSettingsCache } = await import('../src/ml/config.js');
  resetMlSettingsCache();
  assert.equal(mlSettings().autoInstall, true);
  assert.deepEqual(mlSettings().declined, []);
  saveMlSettings({ autoInstall: false, declined: ['embed', 'nope' as ModelKey, 'embed'] });
  resetMlSettingsCache();
  assert.equal(mlSettings().autoInstall, false);
  assert.deepEqual(mlSettings().declined, ['embed']);
});
