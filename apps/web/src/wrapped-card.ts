import { brandSvgMarkup } from './brand-icons';
import { PLATFORMS, type Platform } from './types';
import type { WrappedStats } from './insights-types';
import { DAY_NAMES, fmtDur, fmtNum, hourLabel, personName, profileText } from './wrapped-format';

/**
 * Raporum paylaşım kartı: 1080×1920 (hikâye) ya da 1080×1080 (kare) PNG, yalnız canvas ile (harici kütüphane yok).
 * İçinde mesaj İÇERİĞİ yok: sayılar, platformlar, (isteğe bağlı gizlenmiş) kişi adları. Marka renkleri sabit (tema bağımsız görsel).
 */

export type CardFormat = 'story' | 'square';

const V = '#6c47ff';
const V_DARK = '#1d1147';
const LIME = '#d4ff3f';
const INK = '#0f0b24';
const FONT = `Inter, -apple-system, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif`;

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImg(src: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = src;
    });
    imgCache.set(src, p);
  }
  return p;
}
function logoOf(platform: Platform): Promise<HTMLImageElement | null> {
  const svg = brandSvgMarkup(platform);
  return svg ? loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`) : Promise.resolve(null);
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function font(ctx: CanvasRenderingContext2D, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}
/** Sığmayan metni … ile kısalt */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

/** Metni sığdırmak için yazı boyunu küçült (en az `min`), yine sığmazsa … ile kısalt */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number, min = 24): string {
  let z = size;
  font(ctx, weight, z);
  while (z > min && ctx.measureText(text).width > max) font(ctx, weight, (z -= 2));
  return fit(ctx, text, max);
}

/** Mivelo logosu: mor kare + kıvrım + lime nokta (ui.tsx Logo ile aynı çizim), s = kenar */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const k = s / 28;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  rr(ctx, 0, 0, 28, 28, 9);
  ctx.fill();
  ctx.strokeStyle = V;
  ctx.lineWidth = 2.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(8, 8);
  ctx.bezierCurveTo(12.5, 8, 14, 11, 14, 14);
  ctx.bezierCurveTo(14, 17, 15.5, 20, 20, 20);
  ctx.moveTo(8, 20);
  ctx.bezierCurveTo(12.5, 20, 14, 17, 14, 14);
  ctx.stroke();
  ctx.fillStyle = LIME;
  ctx.beginPath();
  ctx.arc(20, 8, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function background(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
  g.addColorStop(0, V);
  g.addColorStop(0.55, '#3a1fb0');
  g.addColorStop(1, V_DARK);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // lime ve mor ışık halkaları
  const glow = (cx: number, cy: number, r: number, color: string) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, color);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  };
  glow(w * 0.95, h * 0.04, w * 0.55, 'rgba(212,255,63,0.35)');
  glow(w * 0.05, h * 0.9, w * 0.7, 'rgba(155,120,255,0.35)');
  // ince ızgara dokusu
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 2;
  for (let x = 60; x < w; x += 120) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

/** Kartı çiz ve PNG Blob döndür */
export async function renderCard(s: WrappedStats, format: CardFormat, hideNames: boolean): Promise<Blob> {
  const w = 1080;
  const h = format === 'story' ? 1920 : 1080;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* yazı tipi yüklenemedi: sistem yazı tipi */
  }
  const plats = s.platforms.slice(0, 5);
  const people = s.people.slice(0, 3);
  const logos = new Map<Platform, HTMLImageElement | null>();
  await Promise.all([...new Set([...plats.map((p) => p.platform), ...people.map((p) => p.platform)])].map(async (p) => logos.set(p, await logoOf(p))));

  background(ctx, w, h);
  const pad = 84;
  ctx.textBaseline = 'alphabetic';
  // başlık: logo + mivelo + dönem
  drawLogo(ctx, pad, pad, 64);
  ctx.fillStyle = '#fff';
  font(ctx, 700, 44);
  ctx.fillText('mivelo', pad + 84, pad + 47);
  font(ctx, 600, 30);
  const tag = `RAPORUM · ${s.label.toLocaleUpperCase('tr-TR')}`;
  const tw = ctx.measureText(tag).width + 44;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  rr(ctx, w - pad - tw, pad + 6, tw, 54, 27);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(tag, w - pad - tw + 22, pad + 44);

  const story = format === 'story';
  let y = story ? 300 : 250;
  // büyük sayı
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  font(ctx, 600, story ? 40 : 34);
  ctx.fillText(`${s.label} boyunca`, pad, y);
  y += story ? 182 : 150;
  ctx.fillStyle = LIME;
  font(ctx, 800, story ? 210 : 164);
  const big = fmtNum(s.totals.total);
  ctx.fillText(big, pad - 6, y);
  const bw = ctx.measureText(big).width;
  ctx.fillStyle = '#fff';
  font(ctx, 700, story ? 56 : 46);
  ctx.fillText('mesaj', pad + bw + 18, y);
  if (s.change?.total != null) {
    const up = s.change.total >= 0;
    const t = `${up ? '▲' : '▼'} %${Math.abs(s.change.total).toLocaleString('tr-TR')} · ${s.change.prevLabel} ile kıyasla`;
    font(ctx, 600, 30);
    const cw = ctx.measureText(t).width + 40;
    y += story ? 66 : 58;
    ctx.fillStyle = up ? LIME : 'rgba(255,255,255,0.18)';
    rr(ctx, pad, y - 38, cw, 54, 27);
    ctx.fill();
    ctx.fillStyle = up ? INK : '#fff';
    ctx.fillText(t, pad + 20, y - 2);
  }

  // istatistik kutuları
  const tiles: Array<[string, string]> = [
    [fmtNum(s.totals.sent), 'gönderdin'],
    [fmtNum(s.totals.received), 'aldın'],
    [s.reply ? fmtDur(s.reply.medianMs) : '—', 'ortanca yanıt'],
    [`${s.streak.longest} gün`, 'en uzun seri'],
  ];
  y += story ? 58 : 50;
  const cols = story ? 2 : 4;
  const gap = 20;
  const tWidth = (w - pad * 2 - gap * (cols - 1)) / cols;
  const tH = 150;
  tiles.forEach(([v, l], i) => {
    const tx = pad + (i % cols) * (tWidth + gap);
    const ty = y + Math.floor(i / cols) * (tH + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    rr(ctx, tx, ty, tWidth, tH, 32);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(fitFont(ctx, v, 800, story ? 56 : 46, tWidth - 48, 28), tx + 28, ty + 78);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    font(ctx, 600, story ? 28 : 24);
    ctx.fillText(l, tx + 28, ty + 120);
  });
  y += (story ? 2 : 1) * (tH + gap) + (story ? 36 : 20);

  // platform çubuğu
  // yüzdeler TÜM platformlara göre (arayüzdeki halka grafikle aynı); ilk 5 dışındakiler çubukta soluk "diğer"
  const pTotal = s.platforms.reduce((a, p) => a + p.total, 0) || 1;
  if (plats.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    font(ctx, 600, 30);
    ctx.fillText('Platformlar', pad, y);
    y += 26;
    let x = pad;
    const barW = w - pad * 2;
    ctx.save();
    rr(ctx, pad, y, barW, 28, 14);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(pad, y, barW, 28);
    for (const p of plats) {
      const pw = (p.total / pTotal) * barW;
      ctx.fillStyle = PLATFORMS[p.platform]?.color ?? '#999';
      ctx.fillRect(x, y, pw + 1, 28);
      x += pw;
    }
    ctx.restore();
    y += 72;
    let lx = pad;
    font(ctx, 600, 28);
    for (const p of plats.slice(0, story ? 5 : 4)) {
      const label = `${PLATFORMS[p.platform]?.name ?? p.platform} %${Math.round((p.total / pTotal) * 100)}`;
      const lw = ctx.measureText(label).width + 56;
      if (lx + lw > w - pad) break;
      const img = logos.get(p.platform);
      if (img) ctx.drawImage(img, lx, y - 30, 38, 38);
      else {
        ctx.fillStyle = PLATFORMS[p.platform]?.color ?? '#999';
        rr(ctx, lx, y - 30, 38, 38, 10);
        ctx.fill();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 48, y);
      lx += lw + 22;
    }
    y += story ? 64 : 44;
  }

  if (story) {
    // en çok yazıştıkların
    if (people.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      font(ctx, 600, 30);
      ctx.fillText('En çok yazıştıkların', pad, y);
      y += 30;
      people.forEach((p, i) => {
        const ry = y + i * 96;
        ctx.fillStyle = i === 0 ? 'rgba(212,255,63,0.16)' : 'rgba(255,255,255,0.08)';
        rr(ctx, pad, ry, w - pad * 2, 82, 24);
        ctx.fill();
        ctx.fillStyle = i === 0 ? LIME : '#fff';
        font(ctx, 800, 40);
        ctx.fillText(String(i + 1), pad + 30, ry + 55);
        const img = logos.get(p.platform);
        if (img) ctx.drawImage(img, pad + 84, ry + 19, 44, 44);
        ctx.fillStyle = '#fff';
        font(ctx, 700, 36);
        const cnt = `${fmtNum(p.total)} mesaj`;
        font(ctx, 600, 30);
        const cntW = ctx.measureText(cnt).width;
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(cnt, w - pad - 30 - cntW, ry + 53);
        font(ctx, 700, 36);
        ctx.fillStyle = '#fff';
        ctx.fillText(fit(ctx, personName(p.name, i, hideNames), w - pad * 2 - 170 - cntW - 40), pad + 146, ry + 54);
      });
      y += people.length * 96 + 30;
    }
    // en yoğun an · profil · emojiler (üç kutu)
    const prof = profileText(s);
    const boxH = 210;
    const bw3 = (w - pad * 2 - 40) / 3;
    const boxes: Array<[string, () => void]> = [
      [
        'En yoğun an',
        () => {
          ctx.fillStyle = '#fff';
          font(ctx, 800, 58);
          ctx.fillText(s.busiestHour ? hourLabel(s.busiestHour.hour) : '—', 0, 126);
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.fillText(fitFont(ctx, s.busiestDay ? DAY_NAMES[s.busiestDay.day] : '', 600, 26, bw3 - 56, 20), 0, 172);
        },
      ],
      [
        'Profilin',
        () => {
          ctx.fillStyle = LIME;
          ctx.fillText(fitFont(ctx, prof.title, 800, 46, bw3 - 56, 26), 0, 122);
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          font(ctx, 600, 24);
          ctx.fillText(fit(ctx, prof.short, bw3 - 56), 0, 170);
        },
      ],
      [
        'Emojilerin',
        () => {
          const em = s.emojis.slice(0, 3);
          ctx.fillStyle = '#fff';
          font(ctx, 400, 60);
          if (!em.length) ctx.fillText('—', 0, 128);
          em.forEach((e, i) => ctx.fillText(e.emoji, i * 78, 132));
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          font(ctx, 600, 24);
          if (em[0]) ctx.fillText(fit(ctx, `${em[0].emoji} ×${fmtNum(em[0].count)}`, bw3 - 56), 0, 176);
        },
      ],
    ];
    boxes.forEach(([title, draw], i) => {
      const bx = pad + i * (bw3 + 20);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      rr(ctx, bx, y, bw3, boxH, 30);
      ctx.fill();
      ctx.save();
      ctx.translate(bx + 28, y);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      font(ctx, 600, 25);
      ctx.fillText(title, 0, 52);
      draw();
      ctx.restore();
    });
  } else if (people[0]) {
    // kare: en çok yazıştığın tek kişi
    ctx.fillStyle = 'rgba(212,255,63,0.16)';
    rr(ctx, pad, y - 10, w - pad * 2, 96, 28);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    font(ctx, 600, 26);
    ctx.fillText('En çok yazıştığın', pad + 30, y + 30);
    ctx.fillStyle = '#fff';
    font(ctx, 800, 34);
    ctx.fillText(fit(ctx, `${personName(people[0].name, 0, hideNames)} · ${fmtNum(people[0].total)} mesaj`, w - pad * 2 - 60), pad + 30, y + 70);
  }

  // imza
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  font(ctx, 600, 28);
  ctx.fillText('Tüm mesajların tek yerde', pad, h - pad + 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  font(ctx, 800, 32);
  ctx.fillText('mivelo.app', w - pad, h - pad + 4);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Görsel oluşturulamadı'))), 'image/png'));
}
