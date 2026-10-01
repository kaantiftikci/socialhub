import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../bus.js';
import { DATA_DIR } from '../config.js';
import { MODEL_KEYS, MODEL_SPECS, MODELS_DIR, MlError, mlSettings, saveMlSettings, type MlSettings, type ModelKey } from './config.js';
import { cancelDownload, emitMlStatus, installModel, modelReady, modelStatus, RUNTIME_APPROX_MB, runtimeReady } from './models.js';

/**
 * Yerel AI otomatik kurulumu (Kaan, 01.10): çalışma zamanı + konuşma tanıma + anlamsal arama modelleri ilk açılışta, kanallar
 * açıldıktan sonra (index.ts ~75 sn) arka planda kendiliğinden iner; her model bitince ilgili özellik (sesli mesajı yazıya dökme /
 * anlamsal dizin) açılır. Kurallar:
 *  - tek uçuş; yarıda kalırsa sonraki açılışta yeniden (boyutu tutan dosyalar yeniden inmez, sha256/sha512 denetimi models.ts'te)
 *  - ağ/sunucu hatasında üstel yeniden deneme 5 dk → 10 → 20 … ≤ 6 sa
 *  - diskte (yaklaşık boyut × 1,2 + 500 MB) yer yoksa inmez; durum arayüzde, 6 sa sonra yeniden bakılır
 *  - Ayarlar → Yerel AI'da kapatılabilir (ml.json `autoInstall`); kullanıcının sildiği/iptal ettiği model (`declined`) yeniden inmez
 *  - lisans zorunlu pakette lisans geçerli değilken başlamaz (index.ts zaten whenLicensed sonrası çağırır; burada da denetlenir)
 *  - `MIVELO_ML_AUTO=0` ortamı tümden kapatır (duman testi vb.)
 */

export const RETRY_BASE_MS = 5 * 60_000;
export const RETRY_MAX_MS = 6 * 3_600_000;
export const NOSPACE_RECHECK_MS = 6 * 3_600_000;
const SPACE_MARGIN_MB = 500;

export type AutoPhase = 'off' | 'idle' | 'scheduled' | 'running' | 'retry' | 'nospace' | 'done';

export interface AutoStatus {
  enabled: boolean;
  phase: AutoPhase;
  /** Planlanan modellerin toplam ilerlemesi (0-100) */
  pct: number;
  keys: ModelKey[];
  error?: string;
  nextAt?: number;
  needMb?: number;
  freeMb?: number;
}

export type AutoPlan =
  | { action: 'install'; keys: ModelKey[]; needMb: number }
  | { action: 'skip'; reason: 'off' | 'ready' | 'license' }
  | { action: 'nospace'; keys: ModelKey[]; needMb: number; freeMb: number };

/** Saf karar: ne kurulmalı, yer var mı (freeMb bilinmiyorsa engellemez) */
export function planAutoInstall(input: { settings: Pick<MlSettings, 'autoInstall' | 'declined'>; ready: (k: ModelKey) => boolean; runtimeReady: boolean; freeMb?: number; allowed: boolean }): AutoPlan {
  if (!input.settings.autoInstall) return { action: 'skip', reason: 'off' };
  if (!input.allowed) return { action: 'skip', reason: 'license' };
  const keys = MODEL_KEYS.filter((k) => !input.ready(k) && !input.settings.declined.includes(k));
  if (!keys.length) return { action: 'skip', reason: 'ready' };
  const needMb = keys.reduce((s, k) => s + MODEL_SPECS[k].approxMb, 0) + (input.runtimeReady ? 0 : RUNTIME_APPROX_MB);
  if (input.freeMb !== undefined && input.freeMb < needMb * 1.2 + SPACE_MARGIN_MB) return { action: 'nospace', keys, needMb, freeMb: Math.floor(input.freeMb) };
  return { action: 'install', keys, needMb };
}

/** n. ardışık hatadan sonra bekleme: 5 dk · 2^(n-1), en çok 6 sa */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export interface AutoDeps {
  settings: () => MlSettings;
  save: (p: Partial<MlSettings>) => void;
  modelReady: (k: ModelKey) => boolean;
  runtimeReady: () => boolean;
  /** Modeli indir + kur (gerekirse çalışma zamanıyla); hata MlError (499 = iptal) */
  install: (k: ModelKey) => Promise<void>;
  cancel: (k: ModelKey) => void;
  /** Modelin indirme yüzdesi (0-100) */
  modelPct: (k: ModelKey) => number;
  /** Boş disk (MB); ölçülemezse undefined */
  freeMb: () => Promise<number | undefined>;
  allowed: () => boolean;
  emit: () => void;
  log: (level: 'info' | 'warn', text: string) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear: () => void };
}

export class AutoInstaller {
  private phase: AutoPhase = 'idle';
  private keys: ModelKey[] = [];
  private current?: ModelKey;
  private failures = 0;
  private error?: string;
  private nextAt?: number;
  private needMb?: number;
  private free?: number;
  private timer?: { clear: () => void };
  private running: Promise<void> | null = null;
  private readyListeners: Array<(k: ModelKey) => void> = [];

  constructor(private deps: AutoDeps) {}

  /** Bir model otomatik kurulumla hazır olunca (ör. anlamsal dizinlemeyi dürtmek için) */
  onModelReady(fn: (k: ModelKey) => void): void {
    this.readyListeners.push(fn);
  }

  /** delayMs sonra dene (bekleyen zamanlayıcıyı değiştirir; çalışıyorsa dokunmaz) */
  schedule(delayMs: number): void {
    if (this.running) return;
    this.arm(delayMs);
  }

  private arm(delayMs: number): void {
    this.timer?.clear();
    this.nextAt = this.deps.now() + delayMs;
    if (this.phase !== 'retry' && this.phase !== 'nospace') this.setPhase('scheduled');
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  /** Tek uçuş: süren çalışmaya katılır */
  run(): Promise<void> {
    this.running ??= this.loop().finally(() => (this.running = null));
    return this.running;
  }

  /** Kullanıcı ayarı değiştirdi: kapatınca süren otomatik indirme durur; açınca reddedilenler sıfırlanıp kısa süre sonra başlar */
  setEnabled(on: boolean): void {
    if (on) {
      this.deps.save({ autoInstall: true, declined: [] });
      this.failures = 0;
      this.error = undefined;
      this.phase = 'idle';
      this.schedule(2_000);
    } else {
      this.deps.save({ autoInstall: false });
      this.timer?.clear();
      this.timer = undefined;
      this.nextAt = undefined;
      if (this.current) this.deps.cancel(this.current);
      this.setPhase('off');
    }
  }

  /** Kullanıcı modeli sildi / indirmesini iptal etti: otomatik kurulum onu bir daha indirmez */
  decline(k: ModelKey): void {
    const d = this.deps.settings().declined;
    if (!d.includes(k)) this.deps.save({ declined: [...d, k] });
  }

  /** Kullanıcı modeli elle indirdi: reddedilenlerden çıkar */
  accept(k: ModelKey): void {
    const d = this.deps.settings().declined;
    if (d.includes(k)) this.deps.save({ declined: d.filter((x) => x !== k) });
  }

  status(): AutoStatus {
    const enabled = this.deps.settings().autoInstall;
    const keys = this.keys;
    const total = keys.reduce((s, k) => s + MODEL_SPECS[k].approxMb, 0);
    const done = keys.reduce((s, k) => s + MODEL_SPECS[k].approxMb * (this.deps.modelReady(k) ? 1 : this.deps.modelPct(k) / 100), 0);
    const pct = total ? Math.min(this.phase === 'done' ? 100 : 99, Math.floor((done / total) * 100)) : this.phase === 'done' ? 100 : 0;
    return {
      enabled,
      phase: enabled ? this.phase : 'off',
      pct,
      keys,
      error: this.error,
      nextAt: this.phase === 'retry' || this.phase === 'nospace' || this.phase === 'scheduled' ? this.nextAt : undefined,
      needMb: this.needMb,
      freeMb: this.free,
    };
  }

  private setPhase(p: AutoPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.deps.emit();
  }

  private async plan(): Promise<AutoPlan> {
    const s = this.deps.settings();
    const pre = planAutoInstall({ settings: s, ready: this.deps.modelReady, runtimeReady: this.deps.runtimeReady(), allowed: this.deps.allowed() });
    if (pre.action !== 'install') return pre;
    const freeMb = await this.deps.freeMb().catch(() => undefined);
    return planAutoInstall({ settings: s, ready: this.deps.modelReady, runtimeReady: this.deps.runtimeReady(), allowed: this.deps.allowed(), freeMb });
  }

  private async loop(): Promise<void> {
    this.timer?.clear();
    this.timer = undefined;
    const installed: ModelKey[] = [];
    for (let guard = 0; guard < MODEL_KEYS.length * 3; guard++) {
      const p = await this.plan();
      if (p.action === 'skip') {
        if (p.reason === 'license') {
          // lisans geçersiz: sonra yeniden bak (kanallar gibi indirme de lisansla)
          this.setPhase('idle');
          this.arm(10 * 60_000);
          return;
        }
        this.nextAt = undefined;
        this.error = undefined;
        this.failures = 0;
        this.setPhase(p.reason === 'off' ? 'off' : this.keys.length ? 'done' : 'idle');
        if (installed.length) this.deps.log('info', `Yerel AI: otomatik kurulum bitti (${installed.map((k) => MODEL_SPECS[k].title).join(', ')})`);
        return;
      }
      if (p.action === 'nospace') {
        this.keys = p.keys;
        this.needMb = p.needMb;
        this.free = p.freeMb;
        this.error = `Diskte yer yok: yerel AI modelleri için ≈${Math.ceil(p.needMb * 1.2 + SPACE_MARGIN_MB)} MB boş alan gerekli (şu an ${p.freeMb} MB). Yer açınca kendiliğinden kurulur.`;
        this.deps.log('warn', `Yerel AI: otomatik kurulum ertelendi — diskte yer yok (${p.freeMb} MB boş, ≈${p.needMb} MB gerekli)`);
        this.setPhase('nospace');
        this.arm(NOSPACE_RECHECK_MS);
        return;
      }
      if (this.phase !== 'running') {
        this.keys = [...new Set([...this.keys.filter((k) => !this.deps.modelReady(k)), ...p.keys])];
        this.needMb = p.needMb;
        this.free = undefined;
        this.error = undefined;
        this.nextAt = undefined;
        this.deps.log('info', `Yerel AI: modeller arka planda kuruluyor (≈${p.needMb} MB)`);
        this.setPhase('running');
      }
      const k = p.keys[0];
      this.current = k;
      try {
        await this.deps.install(k);
        this.current = undefined;
        installed.push(k);
        this.failures = 0;
        // model hazır: ilgili özellik varsayılan AÇIK
        this.deps.save(k === 'whisper' ? { autoTranscribe: true } : { semanticIndex: true });
        for (const fn of this.readyListeners) fn(k);
        this.deps.emit();
      } catch (e) {
        this.current = undefined;
        const err = e instanceof MlError ? e : new MlError(502, (e as Error)?.message ?? String(e));
        if (err.status === 499) {
          // kullanıcı iptal etti / otomatik kurulumu kapattı: model reddedildiyse sıradakine geç, değilse dur
          if (this.deps.settings().autoInstall && this.deps.settings().declined.includes(k)) continue;
          this.setPhase(this.deps.settings().autoInstall ? 'idle' : 'off');
          return;
        }
        this.failures++;
        this.error = err.message;
        const wait = retryDelay(this.failures);
        this.deps.log('warn', `Yerel AI: otomatik kurulum başarısız (${this.failures}. deneme), ${Math.round(wait / 60_000)} dk sonra yeniden — ${err.message}`);
        this.setPhase('retry');
        this.arm(wait);
        return;
      }
    }
  }
}

/** Veri klasörünün (ya da var olan en yakın üst klasörün) bulunduğu diskteki boş alan */
async function freeMbAt(dir: string): Promise<number | undefined> {
  let d = dir;
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  const statfs = (fs.promises as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs;
  if (!statfs) return undefined;
  const s = await statfs(d);
  return (Number(s.bavail) * Number(s.bsize)) / 1048576;
}

let licenseCheck: () => boolean = () => true;
/** index.ts: lisans zorunlu pakette lisans geçerli mi */
export function setMlLicenseCheck(fn: () => boolean): void {
  licenseCheck = fn;
}

export const mlAutoInstaller = new AutoInstaller({
  settings: mlSettings,
  save: (p) => void saveMlSettings(p),
  modelReady,
  runtimeReady,
  install: installModel,
  cancel: cancelDownload,
  modelPct: (k) => modelStatus(k).pct,
  freeMb: () => freeMbAt(MODELS_DIR.startsWith(DATA_DIR) ? DATA_DIR : MODELS_DIR),
  allowed: () => licenseCheck(),
  emit: () => emitMlStatus(true),
  log: (level, text) => bus.log(level, text),
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { clear: () => clearTimeout(t) };
  },
});

/** index.ts: kanallar açıldıktan sonra çağrılır */
export function startMlAutoInstall(delayMs = 75_000): void {
  if (process.env.MIVELO_ML_AUTO === '0') return;
  if (!mlSettings().autoInstall) return;
  mlAutoInstaller.schedule(delayMs);
}
