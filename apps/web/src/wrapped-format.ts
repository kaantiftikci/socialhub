import type { WrappedStats } from './insights-types';

/** Raporum biçimleyicileri (arayüz + paylaşım kartı ortak) */

export const DAY_NAMES = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
export const DAY_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export const fmtNum = (n: number): string => Math.round(n).toLocaleString('tr-TR');

/** Süre: "42 sn", "4 dk", "1 sa 20 dk" */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} sa ${r} dk` : `${h} sa`;
}

export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;
export const hourRange = (h: number): string => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;

/** "İsimleri gizle": gerçek ad yerine "Kişi 1" */
export const personName = (name: string, i: number, hide: boolean): string => (hide ? `Kişi ${i + 1}` : name);

export function profileText(s: WrappedStats): { title: string; short: string; long: string; icon: 'moon' | 'sun' | 'clock' } {
  const pct = (x: number) => `%${Math.round(x * 100)}`;
  if (s.profile.kind === 'night') return { title: 'Gece kuşu', short: `Gece payı ${pct(s.profile.nightShare)}`, long: `Gönderdiklerinde gece payı ${pct(s.profile.nightShare)} (22:00–05:00). Şehir uyurken sen sohbetteydin.`, icon: 'moon' };
  if (s.profile.kind === 'early') return { title: 'Erkenci', short: `Sabah payı ${pct(s.profile.morningShare)}`, long: `Gönderdiklerinde sabah payı ${pct(s.profile.morningShare)} (05:00–09:00). Güne herkesten önce başlıyorsun.`, icon: 'sun' };
  return { title: 'Gündüz insanı', short: 'Mesajlarının çoğu gün içinde', long: 'Mesajlarının büyük kısmını gün içinde yazdın; gecelerin sessiz.', icon: 'clock' };
}

/** Yüzde değişim metni: "+%12,4" / "−%4,1" */
export function fmtChange(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v >= 0 ? '+' : '−'}%${Math.abs(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
}
