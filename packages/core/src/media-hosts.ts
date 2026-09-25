import type { Platform } from './model.js';

/** Vekilden indirilebilecek uzak medya sunucuları (oturum çerezleriyle istek yapıldığı için sınırlı) */
// fbsbx.com: Instagram/Messenger sesli mesaj ve dosyaları; giphy/tenor: DM GIF'leri
export const MEDIA_HOSTS = /(^|\.)(twimg\.com|twitter\.com|x\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com|licdn\.com|linkedin\.com|slack-edge\.com|slack-files\.com|files\.slack\.com|whatsapp\.net|telegram\.org|shopier\.com|giphy\.com|tenor\.com|mail\.google\.com|googleusercontent\.com|outlook\.live\.com|outlook\.office\.com|icloud\.com|icloud-content\.com)$/i;

/** Platform bazlı: bir hesabın çerezleriyle yalnızca kendi platformunun CDN'lerinden indirilir (SSRF/veri çekme önlemi) */
export const PLATFORM_MEDIA_HOSTS: Partial<Record<Platform, RegExp>> = {
  x: /(^|\.)(twimg\.com|twitter\.com|x\.com|giphy\.com|tenor\.com)$/i,
  instagram: /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com|giphy\.com|tenor\.com)$/i,
  messenger: /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com|giphy\.com|tenor\.com)$/i,
  linkedin: /(^|\.)(licdn\.com|linkedin\.com)$/i,
  slack: /(^|\.)(slack-edge\.com|slack-files\.com|files\.slack\.com|giphy\.com|tenor\.com)$/i,
  whatsapp: /(^|\.)(whatsapp\.net)$/i,
  telegram: /(^|\.)(telegram\.org)$/i,
  gmail: /(^|\.)(mail\.google\.com|googleusercontent\.com)$/i,
  outlook: /(^|\.)(outlook\.live\.com|outlook\.office\.com)$/i,
  icloud: /(^|\.)(icloud\.com|icloud-content\.com)$/i,
  shopier: /(^|\.)(shopier\.com)$/i,
};

export function mediaHostAllowed(platform: Platform | undefined, host: string): boolean {
  return ((platform && PLATFORM_MEDIA_HOSTS[platform]) ?? MEDIA_HOSTS).test(host);
}

/** En fazla vekilden geçecek medya boyutu */
export const MEDIA_MAX = 200 * 1024 * 1024;
