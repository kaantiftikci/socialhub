import { isUiActive } from '../activity.js';

/**
 * Resmi API connector'ları için yoklama zamanlayıcısı: sabit setInterval yerine her tur ±%30 sapmalı setTimeout,
 * önceki tur bitmeden yenisi planlanmaz; stop() sonrası çalışan tur yeniden planlamaz.
 */
export class PollTimer {
  private t?: NodeJS.Timeout;
  private on = false;

  constructor(
    private fn: () => Promise<void>,
    private delay: () => number,
  ) {}

  start(): this {
    this.on = true;
    this.next();
    return this;
  }

  stop(): void {
    this.on = false;
    if (this.t) clearTimeout(this.t);
    this.t = undefined;
  }

  private pauseUntil = 0;
  private hits = 0;
  private hitAt = 0;

  /**
   * 429 geldi: sunucunun istediği süre (Retry-After / X-RateLimit-Reset) kadar, art arda gelirse katlanarak (≤30 dk)
   * bekle. Bekleme bitince normal aralığa dönülür; 10 dk sorunsuz geçerse sayaç sıfırlanır.
   */
  backoff(sec: number): void {
    const now = Date.now();
    this.hits = now - this.hitAt < 10 * 60_000 ? this.hits + 1 : 1;
    this.hitAt = now;
    const ms = Math.min(30 * 60_000, Math.max(sec, 30) * 1000 * 2 ** (this.hits - 1)) * (1 + Math.random() * 0.3);
    this.pauseUntil = Math.max(this.pauseUntil, now + ms);
    if (this.on) {
      if (this.t) clearTimeout(this.t);
      this.next();
    }
  }

  private next(): void {
    if (!this.on) return;
    const wait = Math.max(this.delay(), this.pauseUntil - Date.now());
    this.t = setTimeout(async () => {
      await this.fn().catch(() => undefined);
      this.next();
    }, Math.round(wait));
    this.t.unref?.();
  }
}

/** Retry-After / X-RateLimit-Reset başlığından saniye (Unix zamanı ya da HTTP tarihi de olabilir); yoksa def */
export function retryAfterSec(v: string | null | undefined, def = 60, now = Date.now()): number {
  if (!v) return def;
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.max(1, Math.round((n - now) / 1000)); // ms zaman damgası
    if (n > 1e9) return Math.max(1, Math.round(n - now / 1000)); // sn zaman damgası
    return Math.max(1, n);
  }
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(1, Math.round((d - now) / 1000)) : def;
}

/**
 * Pazaryeri yoklama aralığı (Eylül 2026 araştırması): belgelenen sınırlar bir sohbet kutusunun ihtiyacının çok üstünde
 * (Trendyol aynı uca 10 sn'de 50 / sipariş ve soru 1000/dk, Hepsiburada OMS ~240/dk, n11 REST 1000/dk, Shopify REST 2/sn).
 * Webhook'lar herkese açık HTTPS adresi istediği için yerel uygulamada yok. Mivelo açık ve odaktayken 30 sn, boşta 60 sn.
 */
export function marketDelay(activeMs = 30_000, idleMs = 60_000): number {
  return (isUiActive() ? activeMs : idleMs) * (0.7 + Math.random() * 0.6);
}
