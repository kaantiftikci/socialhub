/** Statik herkese açık site: çekirdek yok, her kullanıcının paneli sunucuda durur. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
/** Tek dosyalık HTML demo (scripts/demo-html.mjs): giriş/sunucu yok, tüm demo uygulamaları bağlı başlar */
export const DEMO_OFFLINE = import.meta.env.VITE_DEMO_OFFLINE === '1';
export let PROFILE_NAME = STATIC_DEMO ? '' : 'Kaan';

export function setProfileName(name: string): void {
  PROFILE_NAME = name;
}

/** Web demoda oturum açan kullanıcı adı (geri bildirime eklenir) */
export let PROFILE_USER = '';
export function setProfileUser(username: string): void {
  PROFILE_USER = username;
}
