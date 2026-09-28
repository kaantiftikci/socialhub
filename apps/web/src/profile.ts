/** Statik herkese açık site: çekirdek yok, her kullanıcının paneli sunucuda durur. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
/** Tek dosyalık HTML demo (scripts/demo-html.mjs): giriş/sunucu yok, tüm demo uygulamaları bağlı başlar */
export const DEMO_OFFLINE = import.meta.env.VITE_DEMO_OFFLINE === '1';
/**
 * Profil adı. Web demoda oturumdaki üye; masaüstünde lisans sahibi (lisans sunucusu anahtarın e-postası + üye kaydındaki ad soyad),
 * o yoksa işletim sistemindeki tam ad (/api/health `user`). Eskiden yerelde sabit "Kaan" yazıyordu → her kurulumda aynı ad.
 */
export let PROFILE_NAME = '';
let nameFromLicense = false;

export function setProfileName(name: string, fromLicense = false): void {
  PROFILE_NAME = name;
  if (fromLicense) nameFromLicense = true;
}
/** İşletim sistemi adı: lisans sahibi bilinmiyorsa kullanılır */
export function setFallbackProfileName(name: string | undefined): void {
  if (!nameFromLicense && name && !STATIC_DEMO) PROFILE_NAME = name;
}
/** Selamlamada ilk ad ("Günaydın, Kaan.") */
export function profileFirstName(): string {
  return PROFILE_NAME.includes('@') ? PROFILE_NAME.split('@')[0] : PROFILE_NAME.split(/\s+/)[0] ?? '';
}

/** Web demoda oturum açan kullanıcı adı (geri bildirime eklenir) */
export let PROFILE_USER = '';
export function setProfileUser(username: string): void {
  PROFILE_USER = username;
}
