import { flushSync } from 'react-dom';
import { EASE, reducedMotion } from './motion/motion';

/** Görünüm: Sistem / Açık / Koyu (gece modu). Seçim cihaza özel (localStorage), <html data-theme> ile uygulanır. */
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'mivelo.theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref = getThemePref()): 'light' | 'dark' {
  return pref === 'dark' || (pref === 'system' && media?.matches) ? 'dark' : 'light';
}

let listeners: Array<(t: 'light' | 'dark') => void> = [];
export function onThemeChange(fn: (t: 'light' | 'dark') => void): () => void {
  listeners.push(fn);
  return () => (listeners = listeners.filter((x) => x !== fn));
}

export function applyTheme(pref = getThemePref()): void {
  const t = resolvedTheme(pref);
  const root = document.documentElement;
  if (root.dataset.theme !== t) {
    // tema geçişinde her öğenin kendi transition'ı çalışmasın (yarım yarım renk değişimi) — tek karede geçilir
    root.classList.add('theme-switching');
    root.dataset.theme = t;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = t === 'dark' ? '#0e0d13' : '#f7f6fa';
  void syncWindowTheme(pref);
  for (const fn of listeners) fn(t);
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* yok */
  }
  if (!switchWithCircle(pref)) applyTheme(pref);
}

/*
 * Tema değişimi dairesel açılır: yeni tema tıklanan noktadan daire olarak yayılır (View Transitions, 480 ms). Yalnız kullanıcı
 * eylemiyle (setThemePref); ilk yükleme ve sistem teması değişimi (applyTheme) animasyonsuz. Tıklama konumu belgeye yakalama
 * aşamasında kurulan pointerdown dinleyicisinden; klavyeyle seçildiyse odaktaki öğenin ortası, o da yoksa ekran ortası.
 */
let lastPointer: { x: number; y: number; t: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => (lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() }), { capture: true, passive: true });
}
type VTDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };

function switchWithCircle(pref: ThemePref): boolean {
  const doc = document as VTDoc;
  const root = document.documentElement;
  if (!doc.startViewTransition || reducedMotion() || document.hidden || root.dataset.theme === resolvedTheme(pref)) return false;
  let x = innerWidth / 2,
    y = innerHeight / 2;
  if (lastPointer && performance.now() - lastPointer.t < 1500) ({ x, y } = lastPointer);
  else if (document.activeElement && document.activeElement !== document.body) {
    const r = document.activeElement.getBoundingClientRect();
    (x = r.left + r.width / 2), (y = r.top + r.height / 2);
  }
  const R = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.classList.add('theme-vt');
  let vt: ReturnType<NonNullable<VTDoc['startViewTransition']>>;
  try {
    // dinleyicilerin React durum güncellemesi (düğme simgesi) yeni anlık görüntüye girsin diye eşzamanlı çizilir
    vt = doc.startViewTransition(() => flushSync(() => applyTheme(pref)));
  } catch {
    root.classList.remove('theme-vt');
    return false;
  }
  vt.ready
    .then(() =>
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${R}px at ${x}px ${y}px)`] }, { duration: 480, easing: EASE.std, pseudoElement: '::view-transition-new(root)' }),
    )
    .catch(() => undefined);
  vt.finished.finally(() => root.classList.remove('theme-vt')).catch(() => undefined);
  return true;
}

/** Masaüstü: pencere çerçevesi / başlık çubuğu da aynı temada olsun (Tauri 2 Window.setTheme; null = sistem) */
async function syncWindowTheme(pref: ThemePref): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow() as unknown as { setTheme?: (t: 'light' | 'dark' | null) => Promise<void> };
    await w.setTheme?.(pref === 'system' ? null : pref);
  } catch {
    /* eski sürüm: yok say */
  }
}

/** Sistem teması değişince (macOS otomatik koyu mod, akşam geçişi) "Sistem" seçiliyse izle */
export function watchSystemTheme(): void {
  media?.addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}
