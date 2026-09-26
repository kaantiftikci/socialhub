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

  private next(): void {
    if (!this.on) return;
    this.t = setTimeout(async () => {
      await this.fn().catch(() => undefined);
      this.next();
    }, Math.round(this.delay()));
    this.t.unref?.();
  }
}

/**
 * Pazaryeri yoklama aralığı (Eylül 2026 araştırması): belgelenen sınırlar bir sohbet kutusunun ihtiyacının çok üstünde
 * (Trendyol aynı uca 10 sn'de 50 / sipariş ve soru 1000/dk, Hepsiburada OMS ~240/dk, n11 REST 1000/dk, Shopify REST 2/sn).
 * Webhook'lar herkese açık HTTPS adresi istediği için yerel uygulamada yok. Mivelo açık ve odaktayken 30 sn, boşta 60 sn.
 */
export function marketDelay(activeMs = 30_000, idleMs = 60_000): number {
  return (isUiActive() ? activeMs : idleMs) * (0.7 + Math.random() * 0.6);
}
