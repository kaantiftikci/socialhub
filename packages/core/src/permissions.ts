import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

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
