import { useEffect, useLayoutEffect, useRef } from 'react';
import { EASE, animate, reducedMotion } from './motion/motion';

/**
 * Açılış bekleme ekranı (Varyant A, "Akış"): uygulama renklerindeki noktalar kesik çizgilerden logoya akar, logodan tek mor hat
 * çıkar; her varışta logo hafifçe nabız atar. Aşama yazısı yalnız GERÇEK durumu söyler (core: çekirdek bekleniyor, data: sohbetler
 * yükleniyor); çubuk geri gitmez. ready gelince nokta üretimi durur, lime nokta pop, logo kenar çubuğundaki logonun yerine uçar
 * (FLIP) ve katman saydamlaşır → onDone. Takıldıktan sonraki 350 ms içinde ready gelirse animasyonsuz hemen onDone (flaş olmasın).
 * Hareketleri azalt açıksa nokta akışı yok, yalnız solma.
 */
export function BootScreen({ stage, slowHint, ready, onDone }: { stage: 'core' | 'data'; slowHint: boolean; ready: boolean; onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const txtRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const mountedAt = useRef(0);
  if (!mountedAt.current) mountedAt.current = performance.now();
  const done = useRef(onDone);
  done.current = onDone;
  const finished = useRef(false);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    done.current();
  };
  // nokta döngüsü ve ilerleme durumu (render'dan bağımsız; ref'te)
  const st = useRef({ spawning: true, target: 0, val: 0, stageAt: 0, stage: stage as 'core' | 'data', ready: false, base: 0 });

  // ---- kurulum: raylar, giriş animasyonu, nokta + ilerleme döngüsü (bir kez) ----
  useEffect(() => {
    const root = rootRef.current,
      svg = svgRef.current,
      mark = markRef.current;
    if (!root || !svg || !mark) return;
    const reduce = reducedMotion();
    const NS = 'http://www.w3.org/2000/svg';
    const COLORS = ['#25D366', '#dd2a7b', '#27A7E7', '#EA4335', '#0A66C2', '#4A154B', '#f27a1a', '#0866FF'];
    const sq = mark.querySelector('svg');
    let rails: SVGPathElement[] = [];
    let out: SVGPathElement | null = null;
    type Dot = { c: SVGCircleElement; p: SVGPathElement; L: number; t0: number; dur: number; kind: 'in' | 'out' };
    let dots: Dot[] = [];
    let alive = true;
    let raf = 0;
    let last = 0,
      lastOut = 0,
      ci = 0;
    let pulse: Animation | null = null;

    // raylar pencere boyutuna göre (yeniden boyutlanınca yeniden kurulur; yoldaki noktalar atılır)
    const build = (first: boolean) => {
      const W = root.clientWidth,
        H = root.clientHeight;
      if (!W || !H) return;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      for (const d of dots) d.c.remove();
      dots = [];
      svg.replaceChildren();
      const cx = W / 2,
        cy = H * 0.42,
        half = mark.offsetWidth / 2;
      rails = [];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const y = H * (0.14 + (0.56 * i) / (n - 1));
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M -10 ${y} C ${W * 0.22} ${y}, ${cx - half * 3.2} ${cy + (y - cy) * 0.15}, ${cx - half * 0.55} ${cy}`);
        p.setAttribute('class', 'bs-rail');
        svg.appendChild(p);
        rails.push(p);
        if (first) animate(p, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: i * 40, easing: EASE.std, fill: 'backwards' });
      }
      out = document.createElementNS(NS, 'path');
      out.setAttribute('d', `M ${cx + half * 0.55} ${cy} C ${cx + W * 0.14} ${cy}, ${W * 0.8} ${cy}, ${W + 10} ${cy}`);
      out.setAttribute('class', 'bs-out');
      svg.appendChild(out);
      if (first) animate(out, [{ strokeDasharray: `0 ${W}` }, { strokeDasharray: `${W} 0` }], { duration: 600, delay: 300, easing: EASE.std, fill: 'backwards' });
    };
    build(true);

    // giriş: logo pop, yazı yükselir; tüm katman kısa gecikmeyle belirir (hemen hazır olursa hiç görünmesin)
    animate(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 120, easing: EASE.std, fill: 'backwards' });
    animate(mark, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.7)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], { duration: 420, easing: EASE.pop, fill: 'backwards' });
    animate(root.querySelector('.bs-word'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 180, easing: EASE.in, fill: 'backwards' });
    const glow = reduce ? null : animate(root.querySelector('.bs-glow'), [{ opacity: 0.6, transform: 'translateY(-50%) scale(.95)' }, { opacity: 1, transform: 'translateY(-50%) scale(1.05)' }], { duration: 2400, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });

    const ease = (t: number) => t * t * (3 - 2 * t) * 0.35 + t * t * 0.65; // sona doğru hızlanır
    const s = st.current;
    s.stageAt = performance.now();
    const frame = (ts: number) => {
      if (!alive) return;
      // ilerleme: geri gitmez; core'da 0,55'e, data'da 0,9'a asimptotik yaklaşır, ready'de 1
      const el = (ts - s.stageAt) / 1000;
      const goal = s.ready ? 1 : s.stage === 'core' ? s.base + (0.55 - s.base) * (1 - Math.exp(-el / 7)) : s.base + (0.9 - s.base) * (1 - Math.exp(-el / 1.6));
      s.target = Math.max(s.target, goal);
      s.val += (s.target - s.val) * (s.ready ? 0.2 : 0.1);
      if (Math.abs(s.target - s.val) < 0.002) s.val = s.target;
      if (barRef.current) barRef.current.style.transform = `scaleX(${s.val})`;
      // noktalar: sekme gizliyken üretilmez
      if (!reduce && s.spawning && !document.hidden && rails.length && ts - last > 230) {
        last = ts;
        const p = rails[(Math.random() * rails.length) | 0];
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', '3.6');
        c.setAttribute('fill', COLORS[ci++ % COLORS.length]);
        svg.appendChild(c);
        dots.push({ c, p, L: p.getTotalLength(), t0: ts, dur: 1500 + Math.random() * 700, kind: 'in' });
      }
      for (let i = dots.length - 1; i >= 0; i--) {
        const d = dots[i];
        const t = Math.min(1, (ts - d.t0) / d.dur);
        const pt = d.p.getPointAtLength(d.L * (d.kind === 'in' ? ease(t) : t));
        d.c.setAttribute('cx', String(pt.x));
        d.c.setAttribute('cy', String(pt.y));
        d.c.setAttribute('opacity', String(d.kind === 'in' ? (t < 0.1 ? t * 10 : t > 0.9 ? (1 - t) * 10 : 1) : t > 0.85 ? (1 - t) / 0.15 : 1));
        if (t < 1) continue;
        d.c.remove();
        dots.splice(i, 1);
        if (d.kind === 'in') {
          // varış: logo nabzı (öncekini kesip yeniden; üst üste binmesin) + seyrek çıkış noktası
          pulse?.cancel();
          pulse = sq?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.045)' }, { transform: 'scale(1)' }], { duration: 220, easing: EASE.std }) ?? null;
          if (out && s.spawning && ts - lastOut > 380) {
            lastOut = ts;
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('r', '3.2');
            c.setAttribute('fill', '#6c47ff');
            svg.appendChild(c);
            dots.push({ c, p: out, L: out.getTotalLength(), t0: ts, dur: 1100, kind: 'out' });
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    let rt = 0;
    const onResize = () => {
      window.clearTimeout(rt);
      rt = window.setTimeout(() => alive && build(false), 120);
    };
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(rt);
      window.removeEventListener('resize', onResize);
      glow?.cancel();
      pulse?.cancel();
      for (const d of dots) d.c.remove();
      dots = [];
    };
  }, []);

  // ---- aşama yazısı: yukarı kayarak değişir; ilerleme tabanı yeni aşamaya taşınır ----
  useLayoutEffect(() => {
    const box = txtRef.current;
    if (!box) return;
    const s = st.current;
    if (s.stage !== stage) {
      s.base = s.target;
      s.stage = stage;
      s.stageAt = performance.now();
    }
    const text = stage === 'data' ? 'Sohbetler yükleniyor…' : 'Çekirdek başlatılıyor…';
    const old = box.lastElementChild as HTMLElement | null;
    if (old?.textContent === text) return;
    const nu = document.createElement('span');
    nu.textContent = text;
    box.appendChild(nu);
    if (old) {
      const a = animate(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: 160, easing: EASE.out, fill: 'forwards' });
      if (a) a.finished.then(() => old.remove(), () => old.remove());
      else old.remove();
      animate(nu, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 60, easing: EASE.in, fill: 'backwards' });
    }
  }, [stage]);

  // ---- yavaş açılış notu ----
  useLayoutEffect(() => {
    const h = hintRef.current;
    if (!h) return;
    if (slowHint) animate(h, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE.in, fill: 'forwards' });
    else h.getAnimations().forEach((a) => a.cancel());
  }, [slowHint]);

  // ---- hazır: devir teslim ----
  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current,
      mark = markRef.current;
    const s = st.current;
    s.ready = true;
    s.spawning = false;
    if (!root || !mark || performance.now() - mountedAt.current < 350) return finish();
    root.style.pointerEvents = 'none'; // devir sırasında uygulama hemen kullanılabilir
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    if (reducedMotion()) {
      const a = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'linear', fill: 'forwards' });
      a.finished.then(finish, finish);
      later(finish, 400);
      return () => timers.forEach(clearTimeout);
    }
    // lime nokta pop, ardından logo uçar
    const dot = mark.querySelector<SVGCircleElement>('.bs-dot');
    animate(dot, [{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 320, easing: EASE.pop });
    later(() => {
      for (const n of root.querySelectorAll(':scope > :not(.bs-mark):not(.bs-bg)')) animate(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE.out, fill: 'forwards' });
      animate(bgRef.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 120, easing: EASE.std, fill: 'forwards' });
      const tgt = sidebarLogo();
      const a = mark.getBoundingClientRect();
      let fly: Animation | null;
      if (tgt) {
        const b = tgt.getBoundingClientRect();
        const dx = b.left + b.width / 2 - (a.left + a.width / 2),
          dy = b.top + b.height / 2 - (a.top + a.height / 2),
          sc = b.width / a.width;
        fly = animate(mark, [{ transform: 'translate(-50%,-50%)' }, { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${sc})` }], { duration: 420, easing: EASE.std, fill: 'forwards' });
      } else {
        // hedef yok / görünmüyor (mobil): yerinde küçülüp solar
        fly = animate(mark, [{ transform: 'translate(-50%,-50%)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 }], { duration: 320, easing: EASE.out, fill: 'forwards' });
      }
      // varışta gerçek logo altta; kopya hızla kaybolur
      const end = () => {
        const f = animate(mark, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: EASE.out, fill: 'forwards' });
        if (f) f.finished.then(finish, finish);
        else finish();
      };
      if (fly) fly.finished.then(end, finish);
      else finish();
      later(finish, 1200); // güvence: animasyon olayı gelmezse
    }, 180);
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="boot-screen" ref={rootRef} role="status" aria-live="polite" data-testid="boot-screen">
      <div className="bs-bg" ref={bgRef} />
      <div className="bs-glow" />
      <svg className="bs-flow" ref={svgRef} preserveAspectRatio="none" aria-hidden="true" />
      <div className="bs-mark" ref={markRef}>
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <rect width="28" height="28" rx="9" fill="#6C47FF" />
          <path d="M8 8c4.5 0 6 3 6 6s1.5 6 6 6M8 20c4.5 0 6-3 6-6" stroke="#FFFFFF" strokeWidth="2.3" fill="none" strokeLinecap="round" />
          <circle className="bs-dot" cx="20" cy="8" r="2.5" fill="#D4FF3F" />
        </svg>
      </div>
      <div className="bs-word">mivelo</div>
      <div className="bs-stat">
        <div className="bs-txt" ref={txtRef} />
        <div className="bs-track">
          <i ref={barRef} />
        </div>
        <div className="bs-hint" ref={hintRef}>
          İlk açılışta 1-2 dakika sürebilir.
        </div>
      </div>
    </div>
  );
}

/** Kenar çubuğundaki marka logosu; görünür değilse (mobilde kapalı menü) null */
function sidebarLogo(): Element | null {
  const el = document.querySelector('.sidebar .brand > svg');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
  return el;
}
