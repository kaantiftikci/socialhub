/** Statik herkese açık site: çekirdek yok, her kullanıcının paneli sunucuda durur. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
/** Tek dosyalık HTML demo (scripts/demo-html.mjs): giriş/sunucu yok, tüm demo uygulamaları bağlı başlar */
export const DEMO_OFFLINE = import.meta.env.VITE_DEMO_OFFLINE === '1';
/**
 * Profil adı. Web demoda oturumdaki üye; masaüstünde lisans sahibi (lisans sunucusu anahtarın e-postası + üye kaydındaki ad soyad),
 * o yoksa işletim sistemindeki tam ad (/api/health `user`). Eskiden yerelde sabit "Kaan" yazıyordu → her kurulumda aynı ad.
 */
export let PROFILE_NAME = '';
/** Ayarlar → Profil kullanıcı adı (@'sız) ve e-posta: kenar çubuğu ve Ayarlar kartında görünür */
export let PROFILE_HANDLE = '';
export let PROFILE_EMAIL = '';
/** Ayarlar → Profil fotoğrafı (data: adresi) */
export let PROFILE_PHOTO: string | undefined;
let nameFromLicense = false;
/** Kullanıcının Ayarlar → Profil'de yazdığı ad: lisans/işletim sistemi adının önüne geçer */
let customName = '';
let baseName = '';

export function setProfileName(name: string, fromLicense = false): void {
  baseName = name;
  if (fromLicense) nameFromLicense = true;
  PROFILE_NAME = customName || baseName;
}
/** İşletim sistemi adı: lisans sahibi bilinmiyorsa kullanılır */
export function setFallbackProfileName(name: string | undefined): void {
  if (!nameFromLicense && name && !STATIC_DEMO) {
    baseName = name;
    PROFILE_NAME = customName || baseName;
  }
}
/** Ayarlar → Profil (çekirdekteki profile.json) uygulanır; arayüz 'mivelo-profile' olayıyla yeniden çizilir */
export function applyProfile(p: { name?: string; photo?: string; username?: string; email?: string } | null | undefined): void {
  customName = p?.name?.trim() ?? '';
  PROFILE_PHOTO = p?.photo || undefined;
  PROFILE_HANDLE = p?.username?.trim().replace(/^@/, '') ?? '';
  PROFILE_EMAIL = p?.email?.trim() ?? '';
  PROFILE_NAME = customName || baseName;
  try {
    window.dispatchEvent(new Event('mivelo-profile'));
  } catch {
    /* pencere yok (test) */
  }
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
