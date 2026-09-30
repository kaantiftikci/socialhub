import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { api } from './api';
import { PLATFORMS } from './types';
import type { StatsRange, WrappedPerson, WrappedStats } from './insights-types';
import { Avatar, Chip, Icon, Logo } from './ui';
import { DAY_NAMES, DAY_SHORT, fmtChange, fmtDur, fmtNum, hourLabel, hourRange, personName, profileText } from './wrapped-format';
import { renderCard, type CardFormat } from './wrapped-card';
import { saveBlob, shareFile } from './save-file';

/**
 * Raporum (Mivelo Wrapped): aylık / yıllık iletişim raporu. Özet ızgarası + tam ekran "hikâye" modu + paylaşılabilir PNG kart.
 * Veri çekirdekte yerel SQLite'tan hesaplanır (packages/core/src/stats.ts); demoda demo-insights.ts. Mesaj içeriği hiçbir yerde yok.
 */

type PeriodKey = 'this-month' | 'last-month' | 'this-year' | 'all';
const PERIODS: Array<[PeriodKey, string]> = [
  ['this-month', 'Bu ay'],
  ['last-month', 'Geçen ay'],
  ['this-year', 'Bu yıl'],
  ['all', 'Tüm zamanlar'],
];
const MIN_MESSAGES = 20;
const PERIOD_KEY = 'mivelo.wrapped.period';
const HIDE_KEY = 'mivelo.wrapped.hide';

function periodArgs(k: PeriodKey, now = new Date()): [StatsRange, string | undefined] {
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (k === 'this-month') return ['month', ym(now)];
  if (k === 'last-month') return ['month', ym(new Date(now.getFullYear(), now.getMonth() - 1, 1))];
  if (k === 'this-year') return ['year', String(now.getFullYear())];
  return ['all', undefined];
}
const ls = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* gizli mod */
    }
  },
};
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Sayı sayarak artar (azaltılmış harekette doğrudan son değer) */
function useCountUp(target: number, run = true, ms = 1300): number {
  const [v, setV] = useState(() => (reduceMotion() ? target : 0));
  useEffect(() => {
    if (!run) return;
    if (reduceMotion() || target <= 0) return void setV(target);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    setV(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return v;
}
function CountUp({ value, run = true, ms, format = fmtNum }: { value: number; run?: boolean; ms?: number; format?: (n: number) => string }) {
  const v = useCountUp(value, run, ms);
  return <span className="wr-num">{format(v)}</span>;
}

/* ───────────────────────── grafikler (kütüphanesiz SVG) ───────────────────────── */

function Donut({ parts, size = 168, stroke = 20, children, glow, onPick }: { parts: Array<{ key: string; value: number; color: string; dim?: boolean }>; size?: number; stroke?: number; children?: ReactNode; glow?: boolean; onPick?: (key: string) => void }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  let acc = 0;
  return (
    <div className={`wr-donut ${glow ? 'glow' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" className={onPick ? 'pick' : undefined}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="wr-donut-track" strokeWidth={stroke} />
        {parts.map((p, i) => {
          const len = (C * p.value) / total;
          const gap = parts.length > 1 ? Math.min(3, len / 3) : 0;
          const el = (
            <circle
              key={p.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={p.color}
              strokeWidth={stroke}
              strokeLinecap="butt"
              strokeDasharray={`${Math.max(0.01, len - gap)} ${C}`}
              strokeDashoffset={-acc}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className={`wr-arc ${p.dim ? 'dim' : ''}`}
              style={{ '--c': C, animationDelay: `${i * 90}ms` } as CSSProperties}
              onClick={onPick ? () => onPick(p.key) : undefined}
            />
          );
          acc += len;
          return el;
        })}
      </svg>
      {children && <div className="wr-donut-in">{children}</div>}
    </div>
  );
}

/** Isı haritasında seçilen gün+saat: o saatte hangi uygulama, kim (Raporum → hücreye tıkla) */
function CellDetail({ s, cell, onClose, onOpenChat }: { s: WrappedStats; cell: number; onClose: () => void; onOpenChat: (chatId: string) => void }) {
  const n = s.heat[cell] ?? 0;
  const d = s.cells?.[cell];
  const day = Math.floor(cell / 24);
  const hour = cell % 24;
  const tot = d ? d.platforms.reduce((a, p) => a + p.n, 0) || 1 : 1;
  return (
    <div className="wr-cell" role="region" aria-label="Seçilen saat">
      <div className="wr-cell-head">
        <b>
          {DAY_NAMES[day]} · {hourRange(hour)}
        </b>
        <span className="wr-muted">
          {fmtNum(n)} mesaj{d ? ` · ${fmtNum(d.sent)} gönderdin` : ''}
        </span>
        <button className="wr-cell-x b" aria-label="Kapat" onClick={onClose}>
          <Icon name="x" size={12} sw={2} />
        </button>
      </div>
      {d ? (
        <div className="wr-cell-body">
          <div className="wr-cell-col">
            <span className="wr-k sm">Uygulamalar</span>
            {d.platforms.map((p) => (
              <div key={p.platform} className="wr-cell-plat">
                <Chip platform={p.platform as keyof typeof PLATFORMS} size={16} />
                <span className="n">{PLATFORMS[p.platform as keyof typeof PLATFORMS]?.name ?? p.platform}</span>
                <span className="wr-part-bar">
                  <span style={{ width: `${Math.max(4, Math.round((p.n / tot) * 100))}%` }} />
                </span>
                <span className="v">%{Math.round((p.n / tot) * 100)}</span>
              </div>
            ))}
          </div>
          <div className="wr-cell-col">
            <span className="wr-k sm">Kiminle</span>
            {d.people.map((p) => (
              <button key={p.chatId} className="wr-grp b" onClick={() => onOpenChat(p.chatId)} title={`${p.name}: ${fmtNum(p.n)} mesaj`}>
                <span className="avwrap">
                  <Avatar name={p.name} size={26} url={p.avatarUrl} />
                  <Chip platform={p.platform as keyof typeof PLATFORMS} size={12} ring="var(--card)" />
                </span>
                <span className="n">{p.name}</span>
                <span className="v">{fmtNum(p.n)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="wr-muted">Bu saat için ayrıntı yok; rapor yenilenince gelir.</p>
      )}
    </div>
  );
}

/** Isı haritasının altı: gün dilimleri + hafta içi / hafta sonu (ısı haritasından; gün 0 = Pazartesi) */
const PARTS: Array<[string, number, number, string]> = [
  ['Sabah', 6, 12, '06–12'],
  ['Öğle', 12, 18, '12–18'],
  ['Akşam', 18, 24, '18–24'],
  ['Gece', 0, 6, '00–06'],
];
function DayParts({ heat }: { heat: number[] }) {
  const total = heat.reduce((a, b) => a + b, 0) || 1;
  const part = (lo: number, hi: number) => {
    let n = 0;
    for (let d = 0; d < 7; d++) for (let h = lo; h < hi; h++) n += heat[d * 24 + h] ?? 0;
    return n;
  };
  const parts = PARTS.map(([name, lo, hi, range]) => ({ name, range, n: part(lo, hi) }));
  const top = parts.reduce((a, b) => (b.n > a.n ? b : a), parts[0]);
  let wk = 0;
  for (let d = 5; d < 7; d++) for (let h = 0; h < 24; h++) wk += heat[d * 24 + h] ?? 0;
  const perWeekday = (total - wk) / 5;
  const perWeekend = wk / 2;
  const pct = (n: number) => Math.round((n / total) * 100);
  return (
    <div className="wr-parts">
      <div className="wr-parts-grid">
        {parts.map((p) => (
          <div key={p.name} className={`wr-part ${p === top ? 'top' : ''}`}>
            <span className="wr-part-n">
              {p.name} <em>{p.range}</em>
            </span>
            <b>%{pct(p.n)}</b>
            <span className="wr-part-bar">
              <span style={{ width: `${Math.max(3, pct(p.n))}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="wr-week">
        <span>
          Hafta içi günde <b>{fmtNum(Math.round(perWeekday))}</b>
        </span>
        <span>
          Hafta sonu günde <b>{fmtNum(Math.round(perWeekend))}</b>
        </span>
        <span className="wr-muted">{perWeekend > perWeekday * 1.1 ? 'Hafta sonları daha konuşkansın' : perWeekday > perWeekend * 1.1 ? 'Hafta içi daha yoğunsun' : 'Her gün benzer tempodasın'}</span>
      </div>
    </div>
  );
}

/**
 * Isı haritası kartının altı (Kaan: boşluk kalmasın): haftanın günlerine göre çubuklar + en sessiz saat. Kart ızgarada yandaki
 * kişiler kartının boyuna uzar; bu blok kalan yüksekliği doldurur (çubuklar esner).
 */
function WeekBars({ heat }: { heat: number[] }) {
  const days = DAY_NAMES.map((name, d) => ({ name, n: heat.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0) }));
  const max = Math.max(1, ...days.map((d) => d.n));
  const avg = days.reduce((a, d) => a + d.n, 0) / 7 || 1;
  const top = days.reduce((a, b) => (b.n > a.n ? b : a), days[0]);
  const hours = Array.from({ length: 24 }, (_, h) => days.reduce((a, _d, d) => a + (heat[d * 24 + h] ?? 0), 0));
  const quietH = hours.indexOf(Math.min(...hours));
  const topPct = Math.round((top.n / avg - 1) * 100);
  return (
    <div className="wr-wbars">
      <div className="wr-row-head">
        <span className="wr-k sm">Günlere göre</span>
        <span className="wr-muted">
          <b>{top.name}</b> ortalamadan %{Math.max(0, topPct)} yoğun · en sessiz saatin <b>{hourRange(quietH)}</b>
        </span>
      </div>
      <div className="wr-wbars-cols">
        {days.map((d, i) => (
          <div key={d.name} className={`wr-wcol ${d === top ? 'top' : ''}`} title={`${d.name}: ${fmtNum(d.n)} mesaj`}>
            <span className="v">{fmtNum(d.n)}</span>
            <span className="bar">
              <i style={{ height: `${Math.max(4, (d.n / max) * 100)}%`, animationDelay: `${i * 60}ms` }} />
            </span>
            <span className="d">{DAY_SHORT[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ heat, dark, sel, onSel }: { heat: number[]; dark?: boolean; sel?: number | null; onSel?: (cell: number | null) => void }) {
  const max = Math.max(1, ...heat);
  return (
    <div className={`wr-heat ${dark ? 'dark' : ''} ${onSel ? 'live' : ''} ${sel != null ? 'has-sel' : ''}`} role={onSel ? 'grid' : 'img'} aria-label="Güne ve saate göre mesaj yoğunluğu">
      {DAY_SHORT.map((d, di) => (
        <div key={d} className="wr-heat-row">
          <span className="wr-hd">{d}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const v = heat[di * 24 + h] ?? 0;
            const idx = di * 24 + h;
            const style = v ? ({ '--o': (0.14 + 0.86 * (v / max)).toFixed(3), animationDelay: `${idx * 3}ms` } as CSSProperties) : undefined;
            const title = `${DAY_NAMES[di]} ${hourLabel(h)} · ${fmtNum(v)} mesaj`;
            if (!onSel) return <i key={h} className={v ? '' : 'z'} style={style} title={title} />;
            return (
              <i
                key={h}
                role="gridcell"
                tabIndex={v ? 0 : -1}
                aria-selected={sel === idx}
                className={`${v ? '' : 'z'} ${sel === idx ? 'on' : ''}`}
                style={style}
                title={title}
                onClick={() => v && onSel(sel === idx ? null : idx)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && v && (e.preventDefault(), onSel(sel === idx ? null : idx))}
              />
            );
          })}
        </div>
      ))}
      <div className="wr-heat-row wr-heat-axis" aria-hidden="true">
        <span className="wr-hd" />
        {Array.from({ length: 24 }, (_, h) => (
          <b key={h}>{String(h).padStart(2, '0')}</b>
        ))}
      </div>
    </div>
  );
}

function ChangePill({ v, label, onDark }: { v: number | null | undefined; label?: string; onDark?: boolean }) {
  const t = fmtChange(v);
  if (!t) return null;
  return (
    <span className={`wr-change ${v! >= 0 ? 'up' : 'down'} ${onDark ? 'on-dark' : ''}`} title={label ? `${label} ile kıyasla` : undefined}>
      <Icon name={v! >= 0 ? 'chevup' : 'chev'} size={12} sw={2.4} />
      {t}
      {label && <em>{label} ile kıyasla</em>}
    </span>
  );
}

/* ───────────────────────── ana görünüm ───────────────────────── */

export function WrappedView({ notify, onMenu, onOpenChat, onWaiting }: { notify: (t: string, err?: boolean) => void; onMenu?: () => void; onOpenChat: (chatId: string) => void; onWaiting?: () => void }) {
  const [period, setPeriod] = useState<PeriodKey>(() => (PERIODS.some(([k]) => k === ls.get(PERIOD_KEY)) ? (ls.get(PERIOD_KEY) as PeriodKey) : 'this-month'));
  const [data, setData] = useState<WrappedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState(false);
  const [share, setShare] = useState(false);
  const [hide, setHide] = useState(() => ls.get(HIDE_KEY) !== '0');
  const [reload, setReload] = useState(0);
  // uygulama seçimi: null = tüm uygulamalar; çip listesi son "tümü" raporundaki platformlardan
  const [platform, setPlatform] = useState<string | null>(null);
  const [allPlats, setAllPlats] = useState<string[]>([]);
  // Platformlar kartı: bir uygulama seçiliyken de tüm uygulamaların payı görünsün (son "tümü" raporundan, aynı dönem)
  const [allShares, setAllShares] = useState<{ period: string; list: WrappedStats['platforms'] } | null>(null);
  const [cell, setCell] = useState<number | null>(null);
  const setHideP = (v: boolean) => (setHide(v), ls.set(HIDE_KEY, v ? '1' : '0'));

  useEffect(() => {
    let alive = true;
    const [range, at] = periodArgs(period);
    setLoading(true);
    setError(null);
    ls.set(PERIOD_KEY, period);
    api
      .stats(range, at, platform ?? undefined)
      .then((s) => {
        if (!alive) return;
        setData(s);
        if (!platform) {
          setAllPlats(s.platforms.filter((p) => p.total > 0).map((p) => p.platform));
          setAllShares({ period, list: s.platforms });
        }
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [period, reload, platform]);
  useEffect(() => setCell(null), [period, platform]);

  const s = data;
  const empty = !!s && s.totals.total < MIN_MESSAGES;
  const prof = s ? profileText(s) : null;
  // kart verisi: seçim varken aynı döneme ait tüm uygulama payları (yoksa raporun kendi listesi)
  const shares = s ? (platform && allShares?.period === period ? allShares.list : s.platforms) : [];
  const platTotal = shares.reduce((a, p) => a + p.total, 0) || 1;
  const pickPlatform = (p: string) => (setPlatform(platform === p ? null : p), setCell(null));

  return (
    <section className="wrapped" aria-label="Miveloji">
      <div className="wr-head">
        {onMenu && (
          <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={onMenu}>
            <Icon name="grip" size={16} sw={2} />
          </button>
        )}
        <div className="wr-title">
          <h1>Miveloji</h1>
          <span>{s ? `${s.label}${platform ? ` · ${PLATFORMS[platform as keyof typeof PLATFORMS]?.name ?? platform}` : ''}` : ' '}</span>
        </div>
        <span style={{ flexGrow: 1 }} />
        <div className="tabs wr-periods" role="tablist" aria-label="Dönem">
          {PERIODS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={period === k} className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {allPlats.length > 1 && (
        <div className="wr-apps" role="group" aria-label="Uygulama">
          <button className={`ml-pchip b ${!platform ? 'on' : ''}`} onClick={() => setPlatform(null)}>
            Tüm uygulamalar
          </button>
          {allPlats.map((p) => (
            <button key={p} className={`ml-pchip b ${platform === p ? 'on' : ''}`} onClick={() => setPlatform(platform === p ? null : p)}>
              <Chip platform={p as keyof typeof PLATFORMS} size={15} /> {PLATFORMS[p as keyof typeof PLATFORMS]?.name ?? p}
            </button>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="wr-empty">
          <Icon name="alert" size={26} />
          <b>Rapor hazırlanamadı</b>
          <span>{error}</span>
          <button className="btn b" onClick={() => setReload((x) => x + 1)}>
            Yeniden dene
          </button>
        </div>
      )}
      {loading && !s && (
        <div className="wr-grid wr-skel" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={`wr-card ${i === 0 || i === 4 ? 'span2' : ''}`} />
          ))}
        </div>
      )}
      {s && empty && !error && (
        <div className="wr-empty">
          <span className="wr-empty-ic">
            <Icon name="chart" size={28} />
          </span>
          <b>Rapor için yeterli mesaj yok</b>
          <span>
            {s.label} döneminde {s.totals.total ? `yalnız ${fmtNum(s.totals.total)} mesaj var` : 'henüz mesaj yok'}. Uygulamalarını bağlayıp mesajlaştıkça raporun burada oluşur; başka bir dönemi de seçebilirsin.
          </span>
        </div>
      )}
      {s && !empty && !error && (
        <div className={`wr-grid ${loading ? 'loading' : ''}`}>
          {/* Toplam */}
          <div className="wr-card span2 wr-hero">
            <span className="wr-k on-dark">{s.label} boyunca</span>
            <div className="wr-big">
              <CountUp key={`${s.range}${s.at}`} value={s.totals.total} />
              <span className="wr-unit">mesaj</span>
            </div>
            <div className="wr-hero-row">
              <span>
                <Icon name="send" size={14} /> <b>{fmtNum(s.totals.sent)}</b> gönderdin
              </span>
              <span>
                <Icon name="inbox" size={14} /> <b>{fmtNum(s.totals.received)}</b> aldın
              </span>
              <span>
                <Icon name="users" size={14} /> <b>{fmtNum(s.totals.people)}</b> kişi
              </span>
              <ChangePill v={s.change?.total} label={s.change?.prevLabel} onDark />
            </div>
            <div className="wr-hero-act">
              <button className="btn primary b" onClick={() => setStory(true)}>
                <Icon name="play" size={14} /> Hikâyeyi oynat
              </button>
              <button className="btn b wr-glass" onClick={() => setShare(true)}>
                <Icon name="download" size={15} /> Kartı paylaş
              </button>
            </div>
            <span className="wr-hero-logo" aria-hidden="true">
              <Logo size={120} />
            </span>
          </div>

          {/* Platformlar: dilime ya da satıra basınca tüm rapor o uygulamaya göre (yeniden basınca tümü) */}
          <div className="wr-card">
            <div className="wr-row-head">
              <span className="wr-k">Platformlar</span>
              {platform && (
                <button className="wr-link b" onClick={() => setPlatform(null)}>
                  Tümünü göster
                </button>
              )}
            </div>
            <div className="wr-plat">
              <Donut
                parts={shares.map((p) => ({ key: p.platform, value: p.total, color: PLATFORMS[p.platform]?.color ?? 'var(--v)', dim: !!platform && p.platform !== platform }))}
                size={132}
                stroke={16}
                onPick={pickPlatform}
              >
                {platform ? (
                  <>
                    <Chip platform={platform as keyof typeof PLATFORMS} size={26} />
                    <span>%{Math.round(((shares.find((x) => x.platform === platform)?.total ?? 0) / platTotal) * 100)}</span>
                  </>
                ) : (
                  <>
                    <b>{shares.length}</b>
                    <span>uygulama</span>
                  </>
                )}
              </Donut>
              <ul className="wr-legend">
                {shares.slice(0, 6).map((p) => (
                  <li key={p.platform}>
                    <button className={`wr-leg b ${platform === p.platform ? 'on' : ''} ${platform && platform !== p.platform ? 'dim' : ''}`} onClick={() => pickPlatform(p.platform)} aria-pressed={platform === p.platform} title={`Yalnız ${PLATFORMS[p.platform]?.name ?? p.platform} istatistikleri`}>
                      <Chip platform={p.platform} size={16} />
                      <span className="n">{PLATFORMS[p.platform]?.name ?? p.platform}</span>
                      <span className="v">%{Math.round((p.total / platTotal) * 100)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Kişiler */}
          <div className="wr-card wr-people">
            <span className="wr-k">En çok yazıştıkların</span>
            {s.people.length ? (
              <ol>
                {s.people.slice(0, 8).map((p, i) => (
                  <PersonRow key={p.chatId} p={p} i={i} max={s.people[0].total} onOpen={() => onOpenChat(p.chatId)} />
                ))}
              </ol>
            ) : (
              <p className="wr-muted">Bu dönemde birebir yazışma yok.</p>
            )}
            {s.groups.length > 0 && (
              <div className="wr-groups">
                <span className="wr-k sm">Gruplar</span>
                {/* kişilerle aynı satır bileşeni: sıra, avatar ve sayılar üstteki listeyle aynı hizada */}
                <ol>
                  {s.groups.slice(0, 4).map((g, i) => (
                    <PersonRow key={g.chatId} p={g} i={i} max={s.groups[0].total} onOpen={() => onOpenChat(g.chatId)} />
                  ))}
                </ol>
              </div>
            )}
          </div>

          {/* Isı haritası */}
          <div className="wr-card span2">
            <div className="wr-row-head">
              <span className="wr-k">Ne zaman konuşuyorsun</span>
              {s.busiestHour && s.busiestDay && (
                <span className="wr-muted">
                  En yoğun: <b>{DAY_NAMES[s.busiestDay.day]}</b> · <b>{hourRange(s.busiestHour.hour)}</b>
                </span>
              )}
            </div>
            <Heatmap heat={s.heat} sel={cell} onSel={setCell} />
            {cell != null && <CellDetail s={s} cell={cell} onClose={() => setCell(null)} onOpenChat={onOpenChat} />}
            <DayParts heat={s.heat} />
            <WeekBars heat={s.heat} />
          </div>

          {/* Yanıt süresi */}
          <div className="wr-card wr-stat">
            <span className="wr-k">Yanıt süren</span>
            {s.reply ? (
              <>
                <div className="wr-mid">{fmtDur(s.reply.medianMs)}</div>
                <span className="wr-muted">ortanca · ortalama {fmtDur(s.reply.avgMs)} · {fmtNum(s.reply.count)} yanıt</span>
                {s.reply.fastest && (
                  <button className="wr-fast b" onClick={() => onOpenChat(s.reply!.fastest!.chatId)}>
                    <Icon name="sparkle" size={14} />
                    <span>
                      En hızlı <b>{s.reply.fastest.name}</b> için · {fmtDur(s.reply.fastest.medianReplyMs ?? 0)}
                    </span>
                  </button>
                )}
              </>
            ) : (
              <p className="wr-muted">Birebir sohbetlerde yanıt verisi yok.</p>
            )}
          </div>

          {/* Seri */}
          <div className="wr-card wr-stat">
            <span className="wr-k">En uzun seri</span>
            <div className="wr-mid">
              <CountUp key={`st${s.range}${s.at}`} value={s.streak.longest} ms={900} /> <small>gün</small>
            </div>
            <span className="wr-muted">
              {s.streak.from && s.streak.to ? `${fmtDay(s.streak.from)} – ${fmtDay(s.streak.to)} arası her gün yazdın` : 'Art arda yazdığın günler'}
            </span>
            <StreakBar active={s.totals.activeDays} days={s.totals.days} current={s.streak.current} showCurrent={s.current || s.range === 'all'} />
          </div>

          {/* Emojiler */}
          <div className="wr-card wr-stat">
            <span className="wr-k">Emojilerin</span>
            {s.emojis.length ? (
              <div className="wr-emojis">
                {s.emojis.slice(0, 6).map((e, i) => (
                  <span key={e.emoji} className={i === 0 ? 'top' : ''} title={`${fmtNum(e.count)} kez`}>
                    <i>{e.emoji}</i>
                    <small>{fmtNum(e.count)}</small>
                  </span>
                ))}
              </div>
            ) : (
              <p className="wr-muted">Bu dönem emoji kullanmadın.</p>
            )}
          </div>

          {/* Profil */}
          {prof && (
            <div className={`wr-card wr-stat wr-prof ${s.profile.kind}`}>
              <span className="wr-k">Profilin</span>
              <div className="wr-prof-t">
                <Icon name={prof.icon} size={26} />
                {prof.title}
              </div>
              <span className="wr-muted">{prof.long}</span>
              {s.night.hour != null && s.night.count > 0 && <span className="wr-muted">En çok gece {hourRange(s.night.hour)} arası mesajlaştın.</span>}
            </div>
          )}

          {/* Bekleyen */}
          <div className="wr-card wr-stat">
            <span className="wr-k">Şu an yanıt bekleyen</span>
            <div className="wr-mid">
              {fmtNum(s.waiting)} <small>sohbet</small>
            </div>
            <span className="wr-muted">{s.waiting ? 'Son 14 günde son sözü karşı taraf söyledi.' : 'Herkese yanıt vermişsin.'}</span>
            {s.waiting > 0 && onWaiting && (
              <button className="btn sm b b2" onClick={onWaiting}>
                Bekleyenleri aç <Icon name="arrow" size={13} />
              </button>
            )}
          </div>
        </div>
      )}
      {s && !empty && <p className="wr-foot">Rapor yalnız bu cihazda, yerel veritabanından hesaplanır; hiçbir yere gönderilmez.</p>}

      {story && s && !empty && <Story s={s} hide={hide} setHide={setHideP} onClose={() => setStory(false)} onShare={() => (setStory(false), setShare(true))} />}
      {share && s && !empty && <ShareDialog s={s} hide={hide} setHide={setHideP} notify={notify} onClose={() => setShare(false)} />}
    </section>
  );
}

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function PersonRow({ p, i, max, onOpen }: { p: WrappedPerson; i: number; max: number; onOpen: () => void }) {
  return (
    <li>
      <button className="wr-person b" onClick={onOpen} title={`${p.name}: ${fmtNum(p.sent)} gönderdin · ${fmtNum(p.received)} aldın`}>
        <span className="rank">{i + 1}</span>
        <span className="av">
          <Avatar name={p.name} url={p.avatarUrl} size={30} />
          <span className="ch">
            <Chip platform={p.platform} size={13} />
          </span>
        </span>
        <span className="who">
          <span className="n">{p.name}</span>
          <span className="bar">
            <i style={{ width: `${Math.max(4, (p.total / max) * 100)}%`, animationDelay: `${i * 80}ms` }} />
          </span>
        </span>
        <span className="v">{fmtNum(p.total)}</span>
      </button>
    </li>
  );
}

function StreakBar({ active, days, current, showCurrent }: { active: number; days: number; current: number; showCurrent: boolean }) {
  return (
    <div className="wr-streak">
      <span className="bar">
        <i style={{ width: `${Math.min(100, (active / Math.max(1, days)) * 100)}%` }} />
      </span>
      <span className="wr-muted">
        {fmtNum(active)}/{fmtNum(days)} gün aktif{showCurrent && current > 0 ? ` · şu an ${current} günlük seri` : ''}
      </span>
    </div>
  );
}

/* ───────────────────────── Hikâye modu ───────────────────────── */

type Slide = { key: string; ms: number; tone: 'v' | 'lime' | 'ink' | 'deep'; body: (on: boolean) => ReactNode };

function buildSlides(s: WrappedStats, hide: boolean): Slide[] {
  const out: Slide[] = [];
  const prof = profileText(s);
  const platTotal = s.platforms.reduce((a, p) => a + p.total, 0) || 1;
  out.push({
    key: 'intro',
    ms: 3600,
    tone: 'deep',
    body: () => (
      <div className="st-center">
        <span className="st-logo st-in">
          <Logo size={88} />
        </span>
        <span className="st-kicker st-in d1">mivelo · raporum</span>
        <h2 className="st-h st-in d2">{s.label}</h2>
        <p className="st-p st-in d3">Bu dönem nasıl iletişim kurduğuna birlikte bakalım.</p>
      </div>
    ),
  });
  out.push({
    key: 'total',
    ms: 5200,
    tone: 'lime',
    body: (on) => (
      <div className="st-center">
        <span className="st-kicker st-in">{s.label} boyunca</span>
        <div className="st-giant st-in d1">
          <CountUp value={s.totals.total} run={on} ms={1600} />
        </div>
        <span className="st-h2 st-in d2">mesaj</span>
        <div className="st-split st-in d3">
          <span>
            <b>{fmtNum(s.totals.sent)}</b> gönderdin
          </span>
          <span>
            <b>{fmtNum(s.totals.received)}</b> aldın
          </span>
        </div>
        {s.change?.total != null && (
          <span className="st-pill st-in d4">
            {fmtChange(s.change.total)} · {s.change.prevLabel} ile kıyasla
          </span>
        )}
      </div>
    ),
  });
  if (s.platforms.length) {
    const top = s.platforms[0];
    out.push({
      key: 'plat',
      ms: 5600,
      tone: 'v',
      body: () => (
        <div className="st-center">
          <span className="st-kicker st-in">En çok burada konuştun</span>
          <h2 className="st-h st-in d1">
            <Chip platform={top.platform} size={44} /> {PLATFORMS[top.platform]?.name ?? top.platform}
          </h2>
          <div className="st-in d2">
            <Donut glow parts={s.platforms.map((p) => ({ key: p.platform, value: p.total, color: PLATFORMS[p.platform]?.color ?? '#fff' }))} size={210} stroke={24}>
              <b>%{Math.round((top.total / platTotal) * 100)}</b>
              <span>{PLATFORMS[top.platform]?.name}</span>
            </Donut>
          </div>
          <ul className="st-legend st-in d3">
            {s.platforms.slice(1, 5).map((p) => (
              <li key={p.platform}>
                <Chip platform={p.platform} size={18} /> {PLATFORMS[p.platform]?.name} <b>%{Math.round((p.total / platTotal) * 100)}</b>
              </li>
            ))}
          </ul>
        </div>
      ),
    });
  }
  if (s.people.length) {
    const [first, ...rest] = s.people;
    out.push({
      key: 'people',
      ms: 6000,
      tone: 'deep',
      body: (on) => (
        <div className="st-center">
          <span className="st-kicker st-in">En çok yazıştığın kişi</span>
          <span className="st-avatar st-in d1">
            {hide ? <span className="st-anon">1</span> : <Avatar name={first.name} url={first.avatarUrl} size={112} />}
            <span className="ch">
              <Chip platform={first.platform} size={30} />
            </span>
          </span>
          <h2 className="st-h st-in d2">{personName(first.name, 0, hide)}</h2>
          <p className="st-p st-in d3">
            <CountUp value={first.total} run={on} ms={1100} /> mesaj
          </p>
          {rest.length > 0 && (
            <ol className="st-list st-in d4">
              {rest.slice(0, 4).map((p, i) => (
                <li key={p.chatId}>
                  <span className="r">{i + 2}</span>
                  <Chip platform={p.platform} size={18} />
                  <span className="n">{personName(p.name, i + 1, hide)}</span>
                  <b>{fmtNum(p.total)}</b>
                </li>
              ))}
            </ol>
          )}
        </div>
      ),
    });
  }
  if (s.reply) {
    const r = s.reply;
    const fi = r.fastest ? s.people.findIndex((p) => p.chatId === r.fastest!.chatId) : -1;
    out.push({
      key: 'reply',
      ms: 5200,
      tone: 'v',
      body: () => (
        <div className="st-center">
          <span className="st-kicker st-in">Ortanca yanıt süren</span>
          <div className="st-giant sm st-in d1">{fmtDur(r.medianMs)}</div>
          <p className="st-p st-in d2">Karşıdan gelen mesaja ilk yanıtın. Ortalaması {fmtDur(r.avgMs)}.</p>
          {r.fastest && (
            <span className="st-pill lime st-in d3">
              <Icon name="sparkle" size={15} /> En hızlı {personName(r.fastest.name, fi >= 0 ? fi : 9, hide)} için · {fmtDur(r.fastest.medianReplyMs ?? 0)}
            </span>
          )}
        </div>
      ),
    });
  }
  if (s.busiestHour) {
    out.push({
      key: 'time',
      ms: 5800,
      tone: 'ink',
      body: () => (
        <div className="st-center">
          <span className="st-kicker st-in">En yoğun saatin</span>
          <div className="st-giant sm st-in d1">{hourLabel(s.busiestHour!.hour)}</div>
          {s.busiestDay && <p className="st-p st-in d2">Özellikle {DAY_NAMES[s.busiestDay.day]} günleri.</p>}
          <div className="st-in d3 st-heat">
            <Heatmap heat={s.heat} dark />
          </div>
        </div>
      ),
    });
  }
  if (s.streak.longest > 1) {
    out.push({
      key: 'streak',
      ms: 4800,
      tone: 'lime',
      body: (on) => (
        <div className="st-center">
          <span className="st-kicker st-in">Hiç ara vermeden</span>
          <div className="st-giant st-in d1">
            <CountUp value={s.streak.longest} run={on} ms={1000} />
          </div>
          <span className="st-h2 st-in d2">gün üst üste yazıştın</span>
          <p className="st-p st-in d3">
            {fmtNum(s.totals.activeDays)} / {fmtNum(s.totals.days)} gün aktiftin.
          </p>
        </div>
      ),
    });
  }
  if (s.emojis.length) {
    out.push({
      key: 'emoji',
      ms: 5000,
      tone: 'v',
      body: () => (
        <div className="st-center">
          <span className="st-kicker st-in">Senin emojilerin</span>
          <div className="st-emojis">
            {s.emojis.slice(0, 3).map((e, i) => (
              <span key={e.emoji} className={`st-in d${i + 1}`}>
                <i>{e.emoji}</i>
                <small>{fmtNum(e.count)} kez</small>
              </span>
            ))}
          </div>
        </div>
      ),
    });
  }
  out.push({
    key: 'profile',
    ms: 5200,
    tone: 'deep',
    body: () => (
      <div className="st-center">
        <span className="st-kicker st-in">Profilin</span>
        <span className="st-prof-ic st-in d1">
          <Icon name={prof.icon} size={64} sw={1.6} />
        </span>
        <h2 className="st-h st-in d2">{prof.title}</h2>
        <p className="st-p st-in d3">{prof.long}</p>
        {s.night.hour != null && s.night.count > 0 && <span className="st-pill st-in d4">En çok gece {hourRange(s.night.hour)}</span>}
      </div>
    ),
  });
  out.push({
    key: 'outro',
    ms: 7000,
    tone: 'lime',
    body: () => (
      <div className="st-center">
        <span className="st-kicker st-in">Hepsi bu kadar</span>
        <h2 className="st-h st-in d1">{s.label} raporun hazır</h2>
        <p className="st-p st-in d2">Kartını indir, hikâyende paylaş. İsimler istersen gizli kalır.</p>
        <span className="st-sign st-in d3">mivelo.app</span>
      </div>
    ),
  });
  return out;
}

function Story({ s, hide, setHide, onClose, onShare }: { s: WrappedStats; hide: boolean; setHide: (v: boolean) => void; onClose: () => void; onShare: () => void }) {
  const slides = useMemo(() => buildSlides(s, hide), [s, hide]);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const holdRef = useRef<{ t: number; timer?: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const slide = slides[Math.min(i, slides.length - 1)];
  const next = useCallback(() => setI((x) => (x + 1 < slides.length ? x + 1 : x)), [slides.length]);
  const prev = useCallback(() => setI((x) => Math.max(0, x - 1)), []);
  const last = i >= slides.length - 1;

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose());
      else if (e.key === 'ArrowRight') (e.preventDefault(), e.stopPropagation(), next());
      else if (e.key === 'ArrowLeft') (e.preventDefault(), e.stopPropagation(), prev());
      else if (e.key === ' ') (e.preventDefault(), e.stopPropagation(), setPaused((p) => !p));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, prev, onClose]);

  const down = () => {
    holdRef.current = { t: Date.now(), timer: window.setTimeout(() => setPaused(true), 220) };
  };
  const up = (e: RPointerEvent) => {
    const h = holdRef.current;
    holdRef.current = null;
    if (h?.timer) clearTimeout(h.timer);
    if (h && Date.now() - h.t >= 220) return setPaused(false); // basılı tut = duraklat, bırakınca devam
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.3) prev();
    else next();
  };

  return (
    <div className="st-overlay" role="dialog" aria-modal="true" aria-label={`Miveloji hikâyesi: ${s.label}`}>
      <div ref={boxRef} tabIndex={-1} className={`st-box tone-${slide.tone} ${paused ? 'paused' : ''}`}>
        <div className="st-bars" aria-hidden="true">
          {slides.map((sl, k) => (
            <span key={sl.key} className="st-bar">
              <i
                key={k === i ? `${sl.key}-${i}` : sl.key}
                className={k < i ? 'done' : k === i ? 'run' : ''}
                style={k === i ? ({ animationDuration: `${sl.ms}ms` } as CSSProperties) : undefined}
                onAnimationEnd={k === i && !last ? next : undefined}
              />
            </span>
          ))}
        </div>
        <div className="st-top">
          <span className="st-brand">
            <Logo size={22} /> Miveloji
          </span>
          <span style={{ flexGrow: 1 }} />
          <button className="st-btn" onClick={() => setHide(!hide)} aria-pressed={hide} title={hide ? 'İsimleri göster' : 'İsimleri gizle'} aria-label={hide ? 'İsimleri göster' : 'İsimleri gizle'}>
            <Icon name={hide ? 'eyeoff' : 'eye'} size={17} />
          </button>
          <button className="st-btn" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Devam et' : 'Duraklat'} title={paused ? 'Devam et (boşluk)' : 'Duraklat (boşluk)'}>
            <Icon name={paused ? 'play' : 'pause'} size={16} />
          </button>
          <button className="st-btn" onClick={onClose} aria-label="Kapat" title="Kapat (Esc)">
            <Icon name="x" size={17} sw={2} />
          </button>
        </div>
        <div className="st-stage" onPointerDown={down} onPointerUp={up} onPointerCancel={() => (holdRef.current = null, setPaused(false))}>
          <div key={slide.key} className="st-slide">
            {slide.body(true)}
          </div>
        </div>
        {last && (
          <div className="st-cta">
            <button className="btn primary b" onClick={onShare}>
              <Icon name="download" size={15} /> Kartı paylaş
            </button>
            <button className="st-btn wide" onClick={() => setI(0)}>
              <Icon name="refresh" size={15} /> Baştan izle
            </button>
          </div>
        )}
        <span className="st-hint" aria-hidden="true">
          Dokun: ileri · sola dokun: geri · basılı tut: duraklat
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── Paylaşım kartı ───────────────────────── */

function ShareDialog({ s, hide, setHide, notify, onClose }: { s: WrappedStats; hide: boolean; setHide: (v: boolean) => void; notify: (t: string, err?: boolean) => void; onClose: () => void }) {
  const [format, setFormat] = useState<CardFormat>('story');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBlob(null);
    renderCard(s, format, hide)
      .then((b) => {
        if (!alive) return;
        setBlob(b);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(b);
        });
      })
      .catch((e) => notify((e as Error).message, true));
    return () => {
      alive = false;
    };
  }, [s, format, hide, notify]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const fileName = `Miveloji ${s.label}${format === 'square' ? ' kare' : ''}.png`;
  const download = async () => {
    if (!blob) return;
    setBusy(true);
    try {
      notify(await saveBlob(fileName, blob));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const shareIt = async () => {
    if (!blob) return;
    const ok = await shareFile(fileName, blob, 'Mivelo raporum · mivelo.app');
    if (!ok) await download();
  };
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator && 'canShare' in navigator;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wr-share" role="dialog" aria-label="Kartı paylaş" onClick={(e) => e.stopPropagation()}>
        <button className="btn icon b b2 modal-x" onClick={onClose} aria-label="Kapat">
          <Icon name="x" size={14} sw={2} />
        </button>
        <div className="wr-share-in">
          <div className={`wr-share-prev ${format}`}>{url && blob ? <img src={url} alt="Paylaşım kartı önizlemesi" /> : <span className="spin" />}</div>
          <div className="wr-share-side">
            <h3>Kartı paylaş</h3>
            <p className="wr-muted">Kartta mesaj içeriği yok: yalnız sayılar ve platformlar. İsimleri gizlersen kişiler “Kişi 1, 2…” olarak görünür.</p>
            <div className="tabs" role="tablist" aria-label="Biçim">
              <button role="tab" aria-selected={format === 'story'} className={format === 'story' ? 'active' : ''} onClick={() => setFormat('story')}>
                Hikâye 9:16
              </button>
              <button role="tab" aria-selected={format === 'square'} className={format === 'square' ? 'active' : ''} onClick={() => setFormat('square')}>
                Kare 1:1
              </button>
            </div>
            <label className="wr-switch">
              <span>
                <b>İsimleri gizle</b>
                <small>Paylaşmadan önce önerilir</small>
              </span>
              <button type="button" role="switch" aria-checked={hide} className={`sw ${hide ? 'on' : ''}`} onClick={() => setHide(!hide)}>
                <span />
              </button>
            </label>
            <span style={{ flexGrow: 1 }} />
            <button className="btn primary b" disabled={!blob || busy} onClick={() => void download()}>
              <Icon name="download" size={15} /> PNG indir
            </button>
            {canShare && (
              <button className="btn b" disabled={!blob || busy} onClick={() => void shareIt()}>
                <Icon name="send" size={14} /> Paylaş…
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
