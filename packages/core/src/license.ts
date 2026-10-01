import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { bus } from './bus.js';
import { acceptedTermsVersion } from './consent.js';

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

/** Lisans sahibi (sunucu anahtarın e-postası + üye kaydındaki ad soyad ile döner; arayüzde profil adı) */
export interface LicenseOwner {
  name?: string;
  email?: string;
}
interface Saved {
  key: string;
  activation: string;
  device: string;
  lastOk: number;
  expiresAt?: string | null;
  owner?: LicenseOwner;
  /** Donanım kimliği (hardwareId): yerel "bu cihaz mı" denetimi; eski kayıtlarda yok (ilk başarılı denetimde yazılır) */
  hw?: string;
}
export interface LicenseStatus {
  required: boolean;
  valid: boolean;
  key?: string;
  expiresAt?: string | null;
  reason?: string;
  owner?: LicenseOwner;
}

/** Makine kimliği okunamazsa: MAC'siz (ağ durumuna bağlı olmasın) */
function fallbackId(): string {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    /* yok */
  }
  return createHash('sha256').update(['mivelo', os.hostname(), user, process.platform, process.arch].join('|')).digest('hex').slice(0, 40);
}

/** Makinenin kalıcı kimliği (ağ durumundan / bilgisayar adından bağımsız): macOS IOPlatformUUID, Windows MachineGuid, Linux machine-id */
function readMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? '';
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return /MachineGuid\s+REG_\w+\s+(\S+)/i.exec(out)?.[1] ?? '';
    }
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (v) return v;
      } catch {
        /* yok */
      }
    }
  } catch {
    /* okunamadı */
  }
  return '';
}

/**
 * Cihaz kimliği (29.09 denetimi): eskisi ilk etkin ağ kartının MAC'ine bağlıydı → Wi-Fi kapalı açılış, VPN/USB Ethernet, "Özel Wi-Fi
 * adresi" kimliği değiştiriyor, lisans geçersiz sayılıp sunucu denetiminde siliniyordu. Şimdi makinenin kalıcı kimliğinden; okunamazsa
 * ağdan bağımsız yedek (bilgisayar adı + kullanıcı). Süreç boyunca bir kez hesaplanır (her /api isteğinde licenseStatus çağrılıyor). Özet; ham değer gitmez.
 */
let hwCache: string | undefined;
export function hardwareId(): string {
  if (hwCache !== undefined) return hwCache;
  const m = process.env.MIVELO_TEST_MACHINE_ID ?? readMachineId();
  hwCache = m ? createHash('sha256').update(['mivelo', process.platform, process.arch, m].join('|')).digest('hex').slice(0, 40) : fallbackId();
  return hwCache;
}
export const deviceId = hardwareId;

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
  // kayıtta hw yoksa (eski etkinleştirme) bir kerelik hoşgörü: ilk başarılı denetim hw'yi yazar
  const sameDevice = !!s && (s.hw ? s.hw === hardwareId() : true);
  const valid = !!s && sameDevice && Date.now() - s.lastOk < GRACE_MS && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now());
  return { required: true, valid, key: s ? mask(s.key) : undefined, expiresAt: s?.expiresAt, owner: valid ? s?.owner : undefined, reason: valid ? undefined : reason ?? (s && Date.now() - s.lastOk >= GRACE_MS ? 'Lisans 14 gündür doğrulanamadı; internete bağlanıp yeniden dene' : undefined) };
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

/** Sunucunun döndürdüğü sahip bilgisi: yalnız kısa düz metin alanlar */
function cleanOwner(o: unknown): LicenseOwner | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const pick = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, n) : '');
  const name = pick((o as LicenseOwner).name, 80);
  const email = pick((o as LicenseOwner).email, 120);
  return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined;
}

async function call(action: string, body: Record<string, unknown>): Promise<{ activation?: string; expiresAt?: string | null; owner?: unknown }> {
  let res: Response;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new LicenseError('Lisans sunucusuna ulaşılamadı; internet bağlantını kontrol et', false);
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string; invalid?: boolean; ok?: boolean; activation?: string; expiresAt?: string | null; owner?: unknown };
  if (!res.ok || !j.ok) throw new LicenseError(j.error || `Lisans sunucusu hatası (${res.status})`, !!j.invalid, res.status);
  return j;
}

const version = () => process.env.MIVELO_APP_VERSION || '';

export async function activateLicense(rawKey: string): Promise<LicenseStatus> {
  // boşluk/tire/küçük harf fark etmez: MVL-XXXX-XXXX-XXXX-XXXX biçimine getir
  const raw = rawKey.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MVL/, '');
  if (raw.length !== 16) throw new LicenseError('Anahtarı MVL-XXXX-XXXX-XXXX-XXXX biçiminde yaz', true, 400);
  const key = `MVL-${raw.match(/.{4}/g)!.join('-')}`;
  const device = hardwareId();
  const r = await call('activate', { key, device, name: os.hostname().slice(0, 60), os: `${process.platform} ${os.release()}`, version: version(), terms: acceptedTermsVersion() });
  write({ key, activation: String(r.activation), device, hw: device, lastOk: Date.now(), expiresAt: r.expiresAt ?? null, owner: cleanOwner(r.owner) });
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
    // sunucuya kayıttaki kimlik gider (etkinleştirme bu dizeyle eşli): ağ değişince "bu cihaza ait değil" deyip lisansı silmesin;
    // kopyalamaya karşı denetimi yerel hw karşılaştırması yapar
    if (s.hw && s.hw !== hardwareId()) return;
    const r = await call('check', { key: s.key, activation: s.activation, device: s.device, version: version(), terms: acceptedTermsVersion() });
    const owner = cleanOwner(r.owner) ?? s.owner;
    const changed = JSON.stringify(owner) !== JSON.stringify(s.owner);
    const was = licensed();
    write({ ...s, hw: s.hw ?? hardwareId(), lastOk: Date.now(), expiresAt: r.expiresAt ?? null, owner });
    reason = undefined;
    // geçersizken (14 günlük pay doldu / süre yenilendi) başarılı denetim: whenLicensed bekleyicileri uyansın → kanallar açılır
    if (!was && licensed()) onChange();
    else if (changed) bus.emit({ type: 'license.update', license: licenseStatus() });
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
