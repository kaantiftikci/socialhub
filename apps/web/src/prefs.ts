import { useEffect, useState } from 'react';

/**
 * Ayarlar → Genel / Görünüm / Bildirimler'deki cihaza özel tercihler (localStorage `mivelo.prefs`). Değişince `mivelo-prefs`
 * olayı yayılır; bileşenler `usePrefs()` ile, olay işleyicileri `getPrefs()` ile okur.
 */
export interface Prefs {
  /** Enter gönderir (false: ⌘/Ctrl+Enter gönderir, Enter yeni satır) */
  enterSends: boolean;
  /** Yazma alanında yazım denetimi */
  spellcheck: boolean;
  /** Gizli okuma: sohbet açılınca karşı tarafa okundu bilgisi gitmez (yalnız Mivelo'da okundu) */
  silentRead: boolean;
  /** Dock / tepsi rozeti: okunmamış mesaj sayısı, okunmamış sohbet sayısı ya da kapalı */
  badge: 'messages' | 'chats' | 'off';
  /** Arayüz ölçeği (%) */
  zoom: 90 | 100 | 110 | 120;
  /** Hareketleri azalt (animasyonlar kısalır) */
  reduceMotion: boolean;
  /** Mivelo öndeyken de bildirim kartı + ses */
  notifyInFocus: boolean;
  /** Aynı sohbetten art arda gelen mesajları N sn biriktirip tek bildirim (0 = kapalı) */
  batchSec: 0 | 10 | 30 | 60;
  /** Bildirimi gelen sohbet N dk sonra hâlâ okunmadıysa bir kez daha hatırlat (0 = hiç) */
  repeatMin: 0 | 5 | 15 | 30 | 60;
  /** Gönderimi geri al penceresi (sn): Enter'dan sonra bu süre içinde "Geri al" (0 = hemen gönder) */
  undoSec: 0 | 5 | 10;
  /** Rahatsız etme: bu saatler arasında (ve isteğe bağlı hafta sonu) bildirim kartı ve ses yok; rozet sayılır */
  dnd: { on: boolean; from: string; to: string; weekend: boolean };
  /** Odak modu: yalnız seçili uygulamalardan bildirim (boş liste = hepsi) */
  focus: { on: boolean; platforms: string[] };
}

export const DEFAULT_PREFS: Prefs = { enterSends: true, spellcheck: true, silentRead: false, badge: 'messages', zoom: 100, reduceMotion: false, notifyInFocus: true, batchSec: 0, repeatMin: 0, undoSec: 5, dnd: { on: false, from: '23:00', to: '08:00', weekend: false }, focus: { on: false, platforms: [] } };
const KEY = 'mivelo.prefs';

let cache: Prefs | null = null;
export function getPrefs(): Prefs {
  if (cache) return cache;
  try {
    cache = { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    cache = { ...DEFAULT_PREFS };
  }
  return cache;
}

/** Rahatsız etme ya da Odak modu şu an bildirimi susturuyor mu? ('dnd' | 'focus' | null) */
export function quietReason(platform?: string, now = new Date()): 'dnd' | 'focus' | null {
  const p = getPrefs();
  if (p.dnd.on) {
    const day = now.getDay();
    if (p.dnd.weekend && (day === 0 || day === 6)) return 'dnd';
    const hm = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const cur = now.getHours() * 60 + now.getMinutes(), a = hm(p.dnd.from), b = hm(p.dnd.to);
    if (a === b ? false : a < b ? cur >= a && cur < b : cur >= a || cur < b) return 'dnd';
  }
  if (p.focus.on && platform && p.focus.platforms.length && !p.focus.platforms.includes(platform)) return 'focus';
  return null;
}

export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* depo kapalı */
  }
  applyLookPrefs();
  window.dispatchEvent(new Event('mivelo-prefs'));
}

// başka sekme/pencere (ör. web'de iki sekme) tercihi değiştirirse bu sekme de hemen uygular
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    applyLookPrefs();
    window.dispatchEvent(new Event('mivelo-prefs'));
  });

export function usePrefs(): Prefs {
  const [p, setP] = useState(getPrefs);
  useEffect(() => {
    const on = () => setP(getPrefs());
    window.addEventListener('mivelo-prefs', on);
    return () => window.removeEventListener('mivelo-prefs', on);
  }, []);
  return p;
}

/** Görünüm tercihleri <html>'e: ölçek (zoom) ve hareketleri azalt sınıfı. Açılışta main.tsx'ten de çağrılır. */
export function applyLookPrefs(): void {
  const p = getPrefs();
  const root = document.documentElement;
  root.style.zoom = p.zoom === 100 ? '' : String(p.zoom / 100);
  root.classList.toggle('reduce-motion', p.reduceMotion);
}
