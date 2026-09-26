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
  applyTheme(pref);
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
