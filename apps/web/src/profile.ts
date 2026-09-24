/** Statik herkese açık site: çekirdek yok, her kullanıcının paneli sunucuda durur. */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
export let PROFILE_NAME = STATIC_DEMO ? '' : 'Kaan';

export function setProfileName(name: string): void {
  PROFILE_NAME = name;
}
