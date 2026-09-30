/**
 * Tanıtım videosu sesi: telifsiz, tamamen kodla üretilen müzik + arayüz efektleri (48 kHz stereo WAV).
 * Apple çerçevesine göre: 120 BPM (zarif, kinetik), yumuşak piyano-pad tınısı, az ve yerinde efekt.
 * Müzik: Am7 – Fmaj7 – Cadd9 – G6 (her ölçü 2 sn), 4 sn giriş → vuruşlu ana bölüm → 40. sn'de sadeleşme → 44. sn final akoru.
 * Efektler render.mjs'in topladığı ipuçlarından (tıklama, tuş, gönder, bildirim, geçiş) tam karesinde.
 *   renderAudio({dur, cues:[{t,k}]}, 'out.wav')
 */
import fs from 'node:fs';

const SR = 48000;
const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class Bus {
  constructor(n) {
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  add(i, l, r = l) {
    if (i >= 0 && i < this.L.length) (this.L[i] += l), (this.R[i] += r);
  }
}

/** Tek kutuplu alçak geçiren (kesme frekansı örnek başına değişebilir) */
function lp(x, fc) {
  let y = 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const f = typeof fc === 'function' ? fc(i) : fc;
    const a = 1 - Math.exp((-2 * Math.PI * f) / SR);
    y += a * (x[i] - y);
    out[i] = y;
  }
  return out;
}

/** Basit Schroeder yankısı (4 tarak + 2 tüm geçiren), stereo için farklı gecikmeler */
function reverb(inp, mix = 0.3, size = 1) {
  const combs = (delays) => {
    const out = new Float32Array(inp.length);
    for (const d0 of delays) {
      const d = Math.round(d0 * size);
      const buf = new Float32Array(d);
      let k = 0, f = 0;
      for (let i = 0; i < inp.length; i++) {
        const y = buf[k];
        f = y * 0.72 + f * 0.28; // sönümleme
        buf[k] = inp[i] + f * 0.8;
        out[i] += y;
        k = (k + 1) % d;
      }
    }
    return out;
  };
  const allp = (x, d, g = 0.5) => {
    const buf = new Float32Array(d);
    const out = new Float32Array(x.length);
    let k = 0;
    for (let i = 0; i < x.length; i++) {
      const b = buf[k];
      const y = -g * x[i] + b;
      buf[k] = x[i] + g * y;
      out[i] = y;
      k = (k + 1) % d;
    }
    return out;
  };
  const l = allp(allp(combs([1557, 1617, 1491, 1422]), 225), 556);
  const r = allp(allp(combs([1277, 1356, 1188, 1116]), 341), 441);
  return { l: l.map((v) => v * mix * 0.25), r: r.map((v) => v * mix * 0.25) };
}

export function renderAudio({ dur, cues, out: outAt = 40, final: finalAt = 44 }, outPath) {
  const N = Math.ceil((dur + 0.2) * SR);
  const music = new Bus(N);
  const send = new Float32Array(N); // yankıya giden (pad, pluck, çan)
  const duck = new Float32Array(N).fill(1); // kick'e bağlı sıkıştırma (pad/bas nefes alsın)

  const INTRO = 2 * BAR; // 0–4 sn
  const OUT = outAt; // sadeleşme
  const FINAL = finalAt;
  const CH = [
    { root: 45, notes: [57, 60, 64, 67] }, // Am7
    { root: 41, notes: [57, 60, 64, 65] }, // Fmaj7
    { root: 48, notes: [55, 60, 62, 64] }, // Cadd9
    { root: 43, notes: [55, 59, 62, 64] }, // G6
  ];
  const chordAt = (t) => CH[Math.floor(t / BAR) % 4];

  // ── kick ──
  const kick = (t0, g = 1) => {
    const s = Math.round(t0 * SR);
    let ph = 0;
    for (let i = 0; i < 0.42 * SR; i++) {
      const t = i / SR;
      const f = 45 + 110 * Math.exp(-t * 28);
      ph += (2 * Math.PI * f) / SR;
      const v = Math.sin(ph) * Math.exp(-t * 7.5) * 0.9 * g + (i < 60 ? rnd() * 0.25 * (1 - i / 60) * g : 0);
      music.add(s + i, v);
    }
    for (let i = 0; i < 0.3 * SR; i++) {
      const k = s + i;
      if (k < N) duck[k] = Math.min(duck[k], 1 - 0.55 * Math.exp(-(i / SR) * 9));
    }
  };
  // ── clap ──
  const clapNoise = (t0, g = 1) => {
    const s = Math.round(t0 * SR);
    const len = Math.round(0.22 * SR);
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.5 : 1) : 1;
      x[i] = rnd() * Math.exp(-t * 18) * burst;
    }
    const hp = x.map((v, i) => v - (i ? x[i - 1] * 0.85 : 0));
    const b = lp(hp, 5200);
    for (let i = 0; i < len; i++) music.add(s + i, b[i] * 0.32 * g, b[i] * 0.3 * g), (send[s + i] += b[i] * 0.12 * g);
  };
  // ── hi-hat ──
  const hat = (t0, open = false, g = 1) => {
    const s = Math.round(t0 * SR);
    const len = Math.round((open ? 0.22 : 0.05) * SR);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const n = rnd();
      const h = n - prev;
      prev = n;
      const v = h * Math.exp(-(i / SR) * (open ? 16 : 70)) * 0.05 * g;
      music.add(s + i, v * 0.8, v);
    }
  };
  // ── pad (yumuşak, çok sesli) ──
  const pad = new Float32Array(N);
  for (let bar = 0; bar * BAR < dur; bar++) {
    const t0 = bar * BAR;
    const ch = CH[bar % 4];
    const s = Math.round(t0 * SR);
    const len = Math.round((BAR + 0.6) * SR);
    for (const m of ch.notes) {
      for (const det of [-0.08, 0, 0.07]) {
        const f = mtof(m + det);
        let ph = (rnd() + 1) * 3.14;
        for (let i = 0; i < len; i++) {
          const t = i / SR;
          const env = Math.min(1, t / 0.35) * (t > BAR ? Math.max(0, 1 - (t - BAR) / 0.6) : 1);
          ph += (2 * Math.PI * f) / SR;
          // yumuşatılmış testere: temel + birkaç harmonik
          const v = Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.18 * Math.sin(3 * ph) + 0.08 * Math.sin(4 * ph);
          if (s + i < N) pad[s + i] += v * env * 0.018;
        }
      }
    }
  }
  const padF = lp(pad, (i) => {
    const t = i / SR;
    if (t < INTRO) return 500 + (t / INTRO) * 1600; // girişte filtre açılır
    if (t > OUT && t < FINAL) return 1400;
    return 2600;
  });
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const g = t < FINAL ? 1 : Math.exp(-(t - FINAL) * 0.45) * 1.3;
    const v = padF[i] * duck[i] * g;
    music.add(i, v * 1.0, v * 0.92);
    send[i] += v * 0.5;
  }
  // ── bas ──
  const bass = new Float32Array(N);
  for (let bar = 2; bar * BAR < FINAL; bar++) {
    const ch = CH[bar % 4];
    const f = mtof(ch.root - 12 + 12);
    const hits = bar * BAR >= OUT ? [0] : [0, 1.5, 2, 3, 3.5];
    for (const b of hits) {
      const s = Math.round((bar * BAR + b * BEAT) * SR);
      const len = Math.round(BEAT * 0.9 * SR);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * f) / SR;
        const env = Math.min(1, t / 0.008) * Math.exp(-t * 2.2);
        const v = (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph)) * env * 0.22;
        if (s + i < N) bass[s + i] += v;
      }
    }
  }
  const bassF = lp(bass, 900);
  for (let i = 0; i < N; i++) music.add(i, bassF[i] * duck[i]);
  // ── pluck arpej (16'lık) ──
  const arpOrder = [0, 2, 1, 3, 2, 0, 3, 1];
  for (let step = 0; step * BEAT / 2 < FINAL; step++) {
    const t0 = (step * BEAT) / 2;
    if (t0 < 1) continue;
    const ch = chordAt(t0);
    const m = ch.notes[arpOrder[step % 8]] + 12;
    const f = mtof(m);
    const g = t0 < INTRO ? 0.5 : t0 > OUT ? 0.55 : 0.8;
    const s = Math.round(t0 * SR);
    const len = Math.round(0.45 * SR);
    let ph = 0;
    const pan = step % 2 ? 0.75 : 1;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * f) / SR;
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 9);
      const v = (Math.sin(ph) * 0.8 + Math.sin(2 * ph + 0.3) * 0.25 * Math.exp(-t * 20)) * env * 0.05 * g;
      music.add(s + i, v * pan, v * (1.75 - pan));
      send[s + i] += v * 0.9;
    }
  }
  // ── davul düzeni ──
  for (let b = 0; b * BEAT < dur; b++) {
    const t = b * BEAT;
    if (t >= INTRO && t < OUT) {
      kick(t);
      if (b % 2 === 1) clapNoise(t, 0.9);
      hat(t + BEAT / 2, b % 8 === 7, 1);
      hat(t + BEAT / 4, false, 0.45);
      hat(t + (3 * BEAT) / 4, false, 0.45);
    } else if (t >= BAR && t < INTRO) {
      hat(t + BEAT / 2, false, 0.6); // girişte yalnız hafif hi-hat
    } else if (t >= OUT && t < FINAL) {
      if (b % 4 === 0) kick(t, 0.7);
      hat(t + BEAT / 2, false, 0.5);
    }
  }
  // girişteki yükselen gürültü (3.0 → 4.3 sn), düşüş anında vurgu
  riser(music, send, 2.9, 4.32, 0.09);

  // ── efektler ──
  const fx = new Bus(N);
  const tone = (t0, f0, f1, len, g, decay = 18, type = 'sin') => {
    const s = Math.round(t0 * SR);
    let ph = 0;
    for (let i = 0; i < len * SR; i++) {
      const t = i / SR;
      const f = f0 + (f1 - f0) * Math.min(1, t / len);
      ph += (2 * Math.PI * f) / SR;
      const w = type === 'tri' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
      const v = w * Math.min(1, t / 0.002) * Math.exp(-t * decay) * g;
      fx.add(s + i, v);
      send[s + i] += v * 0.35;
    }
  };
  const noiseSweep = (t0, len, f0, f1, g) => {
    const s = Math.round(t0 * SR);
    const n = Math.round(len * SR);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      x[i] = rnd() * Math.sin(Math.PI * p) ** 2;
    }
    const y = lp(x, (i) => f0 + (f1 - f0) * (i / n));
    const z = lp(y.map((v, i) => v - (i ? y[i - 1] * 0.6 : 0)), 9000);
    for (let i = 0; i < n; i++) {
      const pan = 0.5 + 0.5 * Math.sin((i / n) * Math.PI - Math.PI / 2);
      fx.add(s + i, z[i] * g * (1.2 - pan * 0.4), z[i] * g * (0.8 + pan * 0.4));
      send[s + i] += z[i] * g * 0.4;
    }
  };
  for (const c of cues) {
    const t = c.t;
    switch (c.k) {
      case 'click':
        tone(t, 2400, 1800, 0.03, 0.07, 120);
        tone(t, 900, 700, 0.04, 0.05, 90);
        break;
      case 'type':
        tone(t, 3000 + rnd() * 900, 2600, 0.018, 0.022 + rnd() * 0.006, 200);
        break;
      case 'key':
        tone(t, 1800, 1400, 0.03, 0.05, 110);
        tone(t, 420, 380, 0.05, 0.04, 70);
        break;
      case 'enter':
      case 'send':
        tone(t, 1600, 1300, 0.03, 0.05, 100);
        noiseSweep(t + 0.01, 0.32, 800, 6000, 0.12);
        tone(t + 0.09, 880, 1320, 0.14, 0.05, 22, 'tri');
        break;
      case 'notif':
      case 'pop': {
        const up = [0, 3, 5, 7, 10, 12][(c.v ?? 0) % 6];
        tone(t, mtof(84 + up), mtof(84 + up), 0.18, 0.05, 24, 'tri');
        tone(t + 0.045, mtof(91 + up), mtof(91 + up), 0.16, 0.035, 26, 'tri');
        break;
      }
      case 'whoosh':
        noiseSweep(t, 0.6, 300, 7000, 0.22);
        break;
      case 'swish':
        noiseSweep(t, 0.45, 2500, 600, 0.12);
        break;
      case 'morph':
      case 'morph2':
        noiseSweep(t, 0.7, 400, 3500, 0.13);
        tone(t, 220, 330, 0.7, 0.05, 3, 'tri');
        break;
      case 'impact':
        for (let i = 0; i < 1.2 * SR; i++) {
          const tt = i / SR;
          const v = Math.sin(2 * Math.PI * (38 + 60 * Math.exp(-tt * 10)) * tt) * Math.exp(-tt * 3) * 0.35;
          fx.add(Math.round(t * SR) + i, v);
        }
        noiseSweep(t, 0.5, 5000, 400, 0.12);
        break;
      case 'success':
        [72, 76, 79].forEach((m, j) => tone(t + j * 0.07, mtof(m + 12), mtof(m + 12), 0.5, 0.045, 7, 'tri'));
        break;
      case 'riser':
        riser(music, send, t - 1.3, t, 0.09);
        break;
      case 'final':
        for (let i = 0; i < 2 * SR; i++) {
          const tt = i / SR;
          const v = Math.sin(2 * Math.PI * (36 + 50 * Math.exp(-tt * 8)) * tt) * Math.exp(-tt * 2) * 0.35;
          fx.add(Math.round(t * SR) + i, v);
        }
        [60, 64, 67, 71, 74].forEach((m) => tone(t, mtof(m + 12), mtof(m + 12), 1.8, 0.03, 1.6, 'tri'));
        break;
    }
  }

  // ── yankı + miks + yumuşak sınırlayıcı ──
  const rv = reverb(send, 0.9, 1.15);
  const L = new Float32Array(N), R = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const fadeIn = Math.min(1, t / 0.25);
    const fadeOut = t > dur - 0.8 ? Math.max(0, (dur - t) / 0.8) : 1;
    L[i] = (music.L[i] * 0.85 + fx.L[i] + rv.l[i]) * fadeIn * fadeOut;
    R[i] = (music.R[i] * 0.85 + fx.R[i] + rv.r[i]) * fadeIn * fadeOut;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = 0.9 / (peak || 1);
  const sat = (v) => Math.tanh(v * norm * 1.2) / Math.tanh(1.2);
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + N * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(L[i]))) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(R[i]))) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(outPath, buf);
}

function riser(bus, send, t0, t1, g) {
  const s = Math.round(t0 * SR), n = Math.round((t1 - t0) * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rnd() * Math.pow(i / n, 2);
  const y = lp(x, (i) => 300 + 7000 * Math.pow(i / n, 2));
  for (let i = 0; i < n; i++) bus.add(s + i, y[i] * g * 3, y[i] * g * 3), (send[s + i] += y[i] * g);
}
