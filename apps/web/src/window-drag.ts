import { isMac, isTauri } from './desktop';

/**
 * Masaüstü (macOS, başlık çubuğu uygulamanın içinde: titleBarStyle Overlay): pencere üst kenardan (≈52 px şerit) ve kenar
 * çubuğunun boş yerlerinden tutulup sürüklenir; çift tık = büyüt/küçült (macOS başlık çubuğu davranışı). Eskiden yalnız
 * sol üstteki logo alanı (data-tauri-drag-region, çocuk öğeleri hariç) sürükleniyordu (Kaan, 01.10).
 * Sürükleme fare ≥4 px kayınca başlar: tıklamalar (sekme, sohbet satırı, pencere kapatma alanı) olduğu gibi çalışır.
 * Windows'ta yerel başlık çubuğu var → kurulmaz.
 */
const BAND = 52;
const INTERACTIVE =
  'button, a, input, textarea, select, option, label, summary, video, audio, iframe, canvas, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="slider"], [role="checkbox"], [role="switch"], [draggable="true"], .grip, .no-drag';
const ZONE = '[data-tauri-drag-region], .sidebar';

function draggableAt(t: EventTarget | null, y: number): boolean {
  const el = t instanceof Element ? t : null;
  if (!el || el.closest(INTERACTIVE)) return false;
  // açılır pencere içi (Ayarlar, Bağlan…) pencere taşımaz; arka planı (karartma) taşır
  if (el.closest('[role="dialog"], [aria-modal="true"]')) return false;
  if (y <= BAND) return true;
  // kenar çubuğunun boş yerleri (menü öğeleri ve kanal satırları düğme/bağlantı → yukarıda elendi)
  const zone = el.closest(ZONE);
  return !!zone && (zone === el || !el.closest('.nav-item, .chan, li, [data-id]'));
}

export function installWindowDrag(): void {
  if (!isTauri || !isMac || typeof window === 'undefined') return;
  let armed: { x: number; y: number } | null = null;
  const win = import('@tauri-apps/api/window').then((m) => m.getCurrentWindow());
  window.addEventListener(
    'mousedown',
    (e) => {
      armed = e.button === 0 && !e.ctrlKey && draggableAt(e.target, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
    },
    true,
  );
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!armed) return;
      if (!(e.buttons & 1)) {
        armed = null;
        return;
      }
      if (Math.abs(e.clientX - armed.x) + Math.abs(e.clientY - armed.y) < 4) return;
      armed = null;
      window.getSelection()?.removeAllRanges();
      void win.then((w) => w.startDragging()).catch(() => undefined);
    },
    true,
  );
  window.addEventListener('mouseup', () => (armed = null), true);
  window.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || e.clientY > BAND || !draggableAt(e.target, e.clientY)) return;
    void win.then((w) => w.toggleMaximize()).catch(() => undefined);
  });
}
