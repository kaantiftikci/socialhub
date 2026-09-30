/**
 * Ortak hareket yardımcıları (Mivelo hareket kimliği; .claude/skills/motion-design). Yalnız transform/opacity; hareketleri azalt
 * (sistem ayarı ya da Ayarlar → Görünüm → `html.reduce-motion`) açıksa animasyon süresi 1 ms olur, son durum yine uygulanır.
 */
export const EASE = {
  std: 'cubic-bezier(.2,0,0,1)',
  in: 'cubic-bezier(.05,.7,.1,1)',
  out: 'cubic-bezier(.3,0,1,1)',
  pop: 'cubic-bezier(.175,.885,.32,1.275)',
} as const;
export const DUR = { quick: 150, std: 260, slow: 400 } as const;

export function reducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return document.documentElement.classList.contains('reduce-motion') || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Web Animations sarmalayıcı: azaltılmış harekette 1 ms. Öğe yoksa ya da API yoksa null. */
export function animate(el: Element | null | undefined, keyframes: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return null;
  const reduce = reducedMotion();
  return (el as HTMLElement).animate(keyframes, { ...opts, duration: reduce ? 1 : opts.duration, delay: reduce ? 0 : opts.delay });
}

/**
 * FLIP: `measure` öncesi konumlar alınır, `mutate` (DOM/React değişikliği sonrası) çağrılınca yeni konumlarla fark kadar geriden
 * kaydırılır. React'te: önce `const f = flipFirst(nodes)`, render sonrası (useLayoutEffect) `flipPlay(f, …)`.
 */
export type FlipFirst = Map<Element, DOMRect>;
export function flipFirst(nodes: Iterable<Element>): FlipFirst {
  const m: FlipFirst = new Map();
  for (const n of nodes) m.set(n, n.getBoundingClientRect());
  return m;
}
export function flipPlay(first: FlipFirst, nodes: Iterable<Element>, opts: { duration?: number; stagger?: number; easing?: string } = {}): void {
  if (reducedMotion()) return;
  let i = 0;
  for (const n of nodes) {
    const a = first.get(n);
    if (!a || !n.isConnected) continue;
    const b = n.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    (n as HTMLElement).animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: opts.duration ?? DUR.std, delay: (opts.stagger ?? 0) * i++, easing: opts.easing ?? EASE.std,
    });
  }
}
