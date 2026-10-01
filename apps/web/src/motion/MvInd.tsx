import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { DUR, EASE, animate } from './motion';

/** Sekme geçişinin yönü (içerik o yöne kayarak gelir): gösterge kaydığında yazılır, içerik aynı çizimde okur (`recentSlideDir`) */
let tabSlide = { dir: 0, at: 0 };
/** Son 250 ms içinde `track`'li bir gösterge kaydıysa yönü (-1 sola, 1 sağa), yoksa 0 */
export function recentSlideDir(): number {
  return performance.now() - tabSlide.at < 250 ? tabSlide.dir : 0;
}

/**
 * Kayan seçim göstergesi: kapsayıcıdaki (üst öğe) `sel` öğesinin arkasında durur; seçim (`dep`) değişince oraya kayar ve boyunu
 * alır (FLIP: yeni yerde çizilir, eski konum/ölçekten gelir). Sekme/menü genişliği değişirse (sayaç) yeniden yerleşir (animasyonsuz).
 * Kapsayıcıda seçili öğenin kendi zemini motion/app.css'te kapatılır (`:has(> .mv-ind)`). `variant="chip"`: hap süzgeç grupları
 * (Medya/Miveloji uygulama çipleri, ⌘K sonuç çipleri) — mor çerçeveli açık zemin.
 */
export function MvInd({ sel, dep, track = false, variant }: { sel: string; dep: string; track?: boolean; variant?: 'chip' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const place = useCallback(
    (anim: boolean) => {
      const ind = ref.current;
      const box = ind?.parentElement;
      if (!ind || !box) return;
      const t = box.querySelector<HTMLElement>(sel);
      if (!t) {
        ind.style.opacity = '0';
        last.current = null;
        return;
      }
      const r = { x: t.offsetLeft, y: t.offsetTop, w: t.offsetWidth, h: t.offsetHeight };
      const p = last.current;
      last.current = r;
      ind.style.width = `${r.w}px`;
      ind.style.height = `${r.h}px`;
      ind.style.transform = `translate(${r.x}px, ${r.y}px)`;
      ind.style.opacity = '1';
      if (!anim) return;
      if (!p) {
        animate(ind, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.quick, easing: EASE.std });
        return;
      }
      if (p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h) return;
      if (track) tabSlide = { dir: Math.sign(r.x - p.x), at: performance.now() };
      animate(ind, [{ transform: `translate(${p.x}px, ${p.y}px) scale(${p.w / r.w}, ${p.h / r.h})` }, { transform: `translate(${r.x}px, ${r.y}px)` }], { duration: 280, easing: EASE.std });
    },
    [sel, track],
  );
  useLayoutEffect(() => place(true), [dep, place]);
  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box);
    for (const c of Array.from(box.children)) if (c !== ref.current) ro.observe(c);
    return () => ro.disconnect();
  }, [dep, place]);
  return <span ref={ref} className={`mv-ind${variant ? ` ${variant}` : ''}`} aria-hidden="true" />;
}
