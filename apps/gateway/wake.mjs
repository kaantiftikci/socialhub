// Zamanlanmış gönderim uyandırması: boşta durdurulan üyenin çekirdeği, bekleyen zamanlanmış mesajı gönderilebilsin diye
// zamanından az önce yeniden başlatılır. Çekirdeğin kendi kuyruğu (<veri>/scheduled.json, packages/core/src/scheduled.ts)
// okunur; çekirdeğe değişiklik gerekmez. Bağımlılıksız.
import fs from 'node:fs';
import path from 'node:path';

/** Çekirdek bu kadar önce uyandırılır (açılış + tarayıcı oturumları) */
export const WAKE_LEAD_MS = 3 * 60_000;
/** Çekirdek 15 dk'dan fazla geciken gönderimi "kaçırıldı" sayar (scheduled.ts LATE_MS); o pencere geçtiyse uyandırmaya değmez */
export const WAKE_LATE_MS = 14 * 60_000;

/** Kuyruktaki en erken bekleyen (kaçırılmamış) gönderimin zamanı; yoksa null */
export function nextScheduled(dir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'scheduled.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  let next = null;
  for (const s of raw) {
    if (!s || typeof s.at !== 'number' || !Number.isFinite(s.at) || s.missed) continue;
    if (next === null || s.at < next) next = s.at;
  }
  return next;
}

/** Şimdi uyandırılmalı mı: zamanı yakın (≤ WAKE_LEAD) ve kaçırılma penceresi geçmemiş */
export const dueForWake = (at, now) => at !== null && at - now <= WAKE_LEAD_MS && now - at <= WAKE_LATE_MS;

/** Çekirdek durdurulmamalı mı: yakında (boşta süresi içinde değil, uyandırma payı + 2 dk içinde) gönderim var ya da gecikmiş gönderim sürüyor */
export const holdForSend = (at, now) => at !== null && at - now <= WAKE_LEAD_MS + 2 * 60_000 && now - at <= WAKE_LATE_MS;
