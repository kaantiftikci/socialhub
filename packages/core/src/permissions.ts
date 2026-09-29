import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';

/**
 * İlk açılış kurulumu (arayüz Onboarding) için macOS izin denetimleri. Değer yazdırılmaz, yalnız "var/yok".
 *
 * Tam Disk Erişimi: TCC korumalı bir dosya açılabiliyor mu (Mesajlar veritabanı; yoksa kullanıcının TCC / Safari dosyası).
 * Erişim yoksa macOS EPERM verir (istem göstermez; izin yalnız Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi'nden).
 * iMessage (chat.db) ve rehber adları (AddressBook veritabanı) bu izinle okunur.
 */
export function fullDiskAccess(): boolean | null {
  if (process.platform !== 'darwin') return null;
  const home = os.homedir();
  const probes = [path.join(home, 'Library/Messages/chat.db'), path.join(home, 'Library/Application Support/com.apple.TCC/TCC.db'), path.join(home, 'Library/Safari/Bookmarks.plist')];
  for (const f of probes) {
    try {
      fs.closeSync(fs.openSync(f, 'r'));
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return false;
      // ENOENT: bu dosya yok, sıradakini dene
    }
  }
  return false;
}

export type TccState = 'granted' | 'denied' | 'unknown';
export interface TccStatus {
  microphone: TccState;
  messages: TccState;
  calendar: TccState;
}

/**
 * macOS'un kendi izin kaydı (kullanıcı TCC.db; okumak için Tam Disk Erişimi gerekir). Arayüzün "izin verdim ama verilmemiş gibi
 * görünüyor" sorunu: getUserMedia/deneme bildirimi/osascript sonucunu tahmin etmek yerine sistemin kaydı okunur. İstemci Mivelo
 * paketidir (kimlik `app.kavsak.desktop`; çekirdek/osascript alt süreçleri de sorumlu uygulama olarak ona yazılır) ya da paket içi yol.
 * auth_value: 0 reddedildi, 2 izin verildi, 3 sınırlı; kayıt yoksa henüz sorulmadı. FDA yoksa null (arayüz kendi bildiğiyle yetinir).
 * Yalnız servis/durum okunur; başka uygulamaların kayıtları döndürülmez.
 */
export function tccStatus(bundleIds = ['app.kavsak.desktop']): TccStatus | null {
  if (process.platform !== 'darwin') return null;
  const file = path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db');
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const marks = bundleIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT service, auth_value AS v, indirect_object_identifier AS target FROM access WHERE client IN (${marks}) OR client LIKE '%/Mivelo.app/%'`)
      .all(...bundleIds) as Array<{ service: string; v: number; target: string | null }>;
    return tccFromRows(rows);
  } catch {
    return null; // FDA yok ya da şema farklı
  } finally {
    db?.close();
  }
}

/** TCC satırlarından durum (test edilebilir saf işlev). Aynı izne birden çok satır varsa izin verilen kazanır. */
export function tccFromRows(rows: Array<{ service: string; v: number; target?: string | null }>): TccStatus {
  const pick = (match: (r: { service: string; target?: string | null }) => boolean): TccState => {
    const hits = rows.filter(match);
    if (hits.some((r) => r.v === 2 || r.v === 3)) return 'granted';
    if (hits.some((r) => r.v === 0)) return 'denied';
    return 'unknown';
  };
  return {
    microphone: pick((r) => r.service === 'kTCCServiceMicrophone'),
    messages: pick((r) => r.service === 'kTCCServiceAppleEvents' && r.target === 'com.apple.MobileSMS'),
    calendar: pick((r) => r.service === 'kTCCServiceCalendar' || (r.service === 'kTCCServiceAppleEvents' && r.target === 'com.apple.iCal')),
  };
}

/**
 * Mesajlar'ı denetleme izni (iMessage yanıtları AppleScript ile gönderilir). İlk Apple Event'te macOS "Mivelo, Mesajlar'ı
 * denetlemek istiyor" sorar; kurulumda bu istemi baştan çıkarmak için zararsız bir okuma yapılır (Mesajlar kısa süre açılabilir).
 */
export function messagesAutomation(): Promise<'granted' | 'denied' | 'error'> {
  if (process.platform !== 'darwin') return Promise.resolve('error');
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application id "com.apple.MobileSMS" to get name'], { timeout: 60_000 }, (err, _out, stderr) => {
      if (!err) return resolve('granted');
      // -1743: errAEEventNotPermitted (kullanıcı reddetti / izin kapalı)
      resolve(/-1743|not authori[sz]ed|izin/i.test(`${stderr} ${err.message}`) ? 'denied' : 'error');
    });
  });
}

/** Sistem Ayarları'nın ilgili gizlilik bölmesi (macOS) */
export const PRIVACY_PANES: Record<string, string> = {
  fulldisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};
