/**
 * Web demoda aynı tarayıcıyı paylaşan kullanıcılar birbirinin verisini görmesin: tarayıcı deposundaki kullanıcıya özel kayıtlar
 * (zamanlanmış mesajlar, gezinme durumu/açık sohbet, söz onayları, son emojiler, kanal sırası, ayrıntı paneli…) başka bir üye
 * giriş yaptığında ve çıkışta silinir. Yalnız cihaz tercihleri kalır (tema, Ayarlar → Genel/Görünüm/Bildirimler `mivelo.prefs`, ses düzeyi/zil sesleri, grup bildirimi,
 * panel genişlikleri, AI anahtarları).
 */
const OWNER = 'mivelo.demoOwner';
const KEEP = /^(mivelo\.(theme|aiPrefs|prefs)|kavsak\.(token|core|volume|panes|soundsOn|bannersOn|groupsOn|sound|sound\..+|vol\..+|tone\..+))$/;

function wipe(store: Storage): void {
  const drop: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && /^(mivelo|kavsak)\./.test(k) && !KEEP.test(k)) drop.push(k);
  }
  for (const k of drop) store.removeItem(k);
}

/** Kullanıcıya özel yerel verileri sil (çıkışta) */
export function wipeUserLocalData(): void {
  try {
    wipe(localStorage);
    wipe(sessionStorage);
    localStorage.removeItem(OWNER);
  } catch {
    /* depo kapalı */
  }
}

/** Girişte: yerel veriler başka bir üyeye aitse (ya da sahibi bilinmiyorsa) sil, sonra bu üyeyi sahip yap */
export function claimUserLocalData(userId: string): void {
  try {
    if (localStorage.getItem(OWNER) !== userId) {
      wipeUserLocalData();
      localStorage.setItem(OWNER, userId);
    }
  } catch {
    /* depo kapalı */
  }
}
