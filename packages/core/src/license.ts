import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { bus } from './bus.js';

/**
 * Masaüstü paketi lisansı (Kaan'ın yönetim panelinde ürettiği anahtarlar; doğrulama mivelo.app/api/license.php).
 * Yalnız paketli uygulamada zorunlu: masaüstü kabuğu çekirdeği MIVELO_REQUIRE_LICENSE=1 ile başlatır (yerel geliştirme,
 * `npm run dev`, demo etkilenmez). Lisans yokken çekirdek hiçbir kanalı başlatmaz ve /api uçları 402 döner (yalnız sağlık ve
 * lisans uçları açık). ~/.mivelo/license.json: anahtar + etkinleştirme kimliği + cihaz + son başarılı denetim;
 * sunucuya sorulur (30 dk'da bir + arayüz öne gelince, en çok dakikada bir). Sunucu "geçersiz" derse (iptal, süre sonu, cihaz kaldırıldı) hemen kilitlenir; ağ hatasında son başarılı
 * denetimden sonra 14 gün çevrimdışı çalışır. İstemci tarafı denetimdir: kararlı biri paketi değiştirip aşabilir, amaç
 * anahtarsız dağıtımı engellemek.
 */
export const LICENSE_REQUIRED = process.env.MIVELO_REQUIRE_LICENSE === '1';
const API = process.env.MIVELO_LICENSE_API || 'https://mivelo.app/api/license.php';
const FILE = path.join(DATA_DIR, 'license.json');
const GRACE_MS = 14 * 86_400_000;
const CHECK_MS = 30 * 60_000;

interface Saved {
  key: string;
  activation: string;
  device: string;
  lastOk: number;
  expiresAt?: string | null;
}
export interface LicenseStatus {
  required: boolean;
  valid: boolean;
  key?: string;
  expiresAt?: string | null;
  reason?: string;
}

/** Cihaz kimliği: ana bilgisayar adı + kullanıcı + işletim sistemi + ilk fiziksel ağ kartı (MAC); özet, ham değer gitmez */
export function deviceId(): string {
  let mac = '';
  for (const list of Object.values(os.networkInterfaces())) {
    const m = list?.find((i) => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00');
    if (m) {
      mac = m.mac;
      break;
    }
  }
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    /* yok */
  }
  return createHash('sha256').update(['mivelo', os.hostname(), user, process.platform, process.arch, mac].join('|')).digest('hex').slice(0, 40);
}

const mask = (k: string) => k.replace(/^(MVL-)?(.{4}).*(.{4})$/i, (_m, p = '', a, b) => `${p}${a}-••••-••••-${b}`);

function read(): Saved | null {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Saved;
    return s && typeof s.key === 'string' && typeof s.activation === 'string' ? s : null;
  } catch {
    return null;
  }
}
function write(s: Saved | null): void {
  if (!s) return void fs.rmSync(FILE, { force: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

let reason: string | undefined;
const waiters: Array<() => void> = [];

export function licenseStatus(): LicenseStatus {
  if (!LICENSE_REQUIRED) return { required: false, valid: true };
  const s = read();
  const valid = !!s && s.device === deviceId() && Date.now() - s.lastOk < GRACE_MS && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now());
  return { required: true, valid, key: s ? mask(s.key) : undefined, expiresAt: s?.expiresAt, reason: valid ? undefined : reason ?? (s && Date.now() - s.lastOk >= GRACE_MS ? 'Lisans 14 gündür doğrulanamadı; internete bağlanıp yeniden dene' : undefined) };
}
export const licensed = () => licenseStatus().valid;

/** Lisans geçerli olana dek bekle (çekirdek açılışında kanalları başlatmadan önce) */
export function whenLicensed(): Promise<void> {
  return licensed() ? Promise.resolve() : new Promise((r) => waiters.push(r));
}

class LicenseError extends Error {
  constructor(
    msg: string,
    readonly invalid: boolean,
    readonly status = 0,
  ) {
    super(msg);
  }
}

async function call(action: string, body: Record<string, unknown>): Promise<{ activation?: string; expiresAt?: string | null }> {
  let res: Response;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new LicenseError('Lisans sunucusuna ulaşılamadı; internet bağlantını kontrol et', false);
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string; invalid?: boolean; ok?: boolean; activation?: string; expiresAt?: string | null };
  if (!res.ok || !j.ok) throw new LicenseError(j.error || `Lisans sunucusu hatası (${res.status})`, !!j.invalid, res.status);
  return j;
}

const version = () => process.env.MIVELO_APP_VERSION || '';

export async function activateLicense(rawKey: string): Promise<LicenseStatus> {
  // boşluk/tire/küçük harf fark etmez: MVL-XXXX-XXXX-XXXX-XXXX biçimine getir
  const raw = rawKey.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MVL/, '');
  if (raw.length !== 16) throw new LicenseError('Anahtarı MVL-XXXX-XXXX-XXXX-XXXX biçiminde yaz', true, 400);
  const key = `MVL-${raw.match(/.{4}/g)!.join('-')}`;
  const device = deviceId();
  const r = await call('activate', { key, device, name: os.hostname().slice(0, 60), os: `${process.platform} ${os.release()}`, version: version() });
  write({ key, activation: String(r.activation), device, lastOk: Date.now(), expiresAt: r.expiresAt ?? null });
  reason = undefined;
  bus.log('info', 'Lisans etkinleştirildi');
  onChange();
  return licenseStatus();
}

export async function releaseLicense(): Promise<void> {
  const s = read();
  if (s) await call('release', { key: s.key, activation: s.activation }).catch(() => undefined);
  write(null);
  reason = 'Lisans bu bilgisayardan kaldırıldı';
  onChange();
}

/** Sunucuya sor: geçersizse kaydı sil (kilitlenir); ağ hatası çevrimdışı payına bırakılır */
let lastCheck = 0;
/** Arayüz öne gelince / açılınca: en çok dakikada bir sunucuya sor (iptal hızlı yansısın) */
export async function checkLicenseSoon(): Promise<void> {
  if (Date.now() - lastCheck < 60_000) return;
  await checkLicense();
}

export async function checkLicense(): Promise<void> {
  lastCheck = Date.now();
  const s = read();
  if (!LICENSE_REQUIRED || !s) return;
  try {
    const r = await call('check', { key: s.key, activation: s.activation, device: deviceId(), version: version() });
    write({ ...s, lastOk: Date.now(), expiresAt: r.expiresAt ?? null });
  } catch (e) {
    if (e instanceof LicenseError && e.invalid) {
      write(null);
      reason = e.message;
      bus.log('warn', `Lisans geçersiz: ${e.message}`);
      onChange();
    }
  }
}

const listeners: Array<(valid: boolean) => void> = [];
/** Lisans durumu değişince (etkinleşti / kilitlendi) */
export function onLicenseChange(fn: (valid: boolean) => void): void {
  listeners.push(fn);
}
function onChange(): void {
  const v = licensed();
  if (v) waiters.splice(0).forEach((r) => r());
  listeners.forEach((f) => f(v));
  bus.emit({ type: 'license.update', license: licenseStatus() });
}

/** Açılışta bir kez, sonra 12 saatte bir denetim */
export function startLicenseChecks(): void {
  if (!LICENSE_REQUIRED) return;
  void checkLicense();
  setInterval(() => void checkLicense(), CHECK_MS).unref();
}
export { LicenseError };
