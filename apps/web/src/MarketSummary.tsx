import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type MarketDigest, type MarketSummary } from './api';
import { addDays, dayKey, formatMoney, formatMoneyList, type Money } from './market-calc';
import { PLATFORMS, type Platform } from './types';
import { Chip, Icon } from './ui';
import { EASE, animate } from './motion/motion';

/**
 * Pazaryeri gün sonu özeti (arayüz): kanal listesinin üstünde katlanabilir "Bugün" kartı + ayrıntılı gün sonu paneli
 * (tarih ←/→, metrik kartları, 7 günlük çubuk grafik, en çok satanlar, pazaryeri kırılımı) + Ayarlar'daki bildirim satırı.
 * Hesap çekirdekte (GET /api/market/summary); statik demoda aynı hesap tarayıcıda (demo-market.ts).
 */

const COLLAPSE_KEY = 'mivelo.marketCard';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

const money = (list: Money[], cur?: string) => (cur ? formatMoney(list.find((m) => m.currency === cur) ?? { currency: cur, amount: 0 }) : formatMoneyList(list));
const amountOf = (list: Money[], cur: string) => list.find((m) => m.currency === cur)?.amount ?? 0;
const DAY_FMT = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
const SHORT_FMT = new Intl.DateTimeFormat('tr-TR', { weekday: 'short' });
const dateOf = (day: string) => new Date(`${day}T12:00:00`);
function dayLabel(day: string): string {
  const today = dayKey(Date.now());
  if (day === today) return 'Bugün';
  if (day === addDays(today, -1)) return 'Dün';
  return DAY_FMT.format(dateOf(day));
}

/** Önceki değere göre değişim: "+%12" / "−%5" / "yeni" */
function Delta({ cur, prev, label, compact }: { cur: number; prev: number; label: string; compact?: boolean }) {
  const lead = compact ? '' : `${label}: `;
  if (!prev && !cur) return <span className="ms-delta flat">{lead}—</span>;
  if (!prev) return <span className="ms-delta up" title={`${label}: 0`}>{lead}yeni</span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  return (
    <span className={`ms-delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}`} title={`${label}: ${prev.toLocaleString('tr-TR')}`}>
      {lead}
      {pct > 0 ? '↑' : pct < 0 ? '↓' : '±'}%{Math.abs(pct)}
    </span>
  );
}

function useSummary(day: string, platform: Platform | null, refreshMs = 60_000) {
  const [data, setData] = useState<MarketSummary | null>(null);
  // verinin hangi güne ait olduğu (gün değişiminde sayı animasyonu yalnız yeni günün verisi gelince oynar)
  const [dataDay, setDataDay] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .marketSummary(day, platform)
      .then((s) => (setData(s), setDataDay(day), setErr(null)))
      .catch((e: Error) => setErr(e.message));
  }, [day, platform]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, refreshMs);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', load);
    };
  }, [load, refreshMs]);
  return { data, dataDay, err, reload: load };
}

/** Kanal listesinin üstündeki "Bugün" kartı (yalnız pazaryeri kanalında) */
export function MarketTodayCard({ platform }: { platform: Platform }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [open, setOpen] = useState(false);
  const { data } = useSummary(dayKey(Date.now()), platform);
  if (!data || !data.hasShop) return null;
  const cur = data.currency;
  const toggle = () => {
    const v = !collapsed;
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* gizli mod */
    }
  };
  return (
    <>
      <div className={`ms-card ${collapsed ? 'collapsed' : ''}`}>
        <div className="ms-card-top">
          <button type="button" className="ms-card-open b" onClick={() => setOpen(true)} title="Gün sonu özetini aç">
            <Icon name="chart" size={14} sw={2} />
            <b>Bugün</b>
            <span className="ms-card-sum">
              {data.orders} sipariş · {money(data.revenue, cur)}
            </span>
          </button>
          <button type="button" className="btn ghost xs icon b b2" aria-label={collapsed ? 'Özeti genişlet' : 'Özeti daralt'} aria-expanded={!collapsed} onClick={toggle}>
            <span className="ms-chev" style={{ display: 'inline-flex', transform: collapsed ? 'none' : 'rotate(180deg)' }}>
              <Icon name="chev" size={13} sw={2} />
            </span>
          </button>
        </div>
        {/* katlanır alan: yükseklik (grid satırı 0fr⇄1fr) + solma 260 ms, motion/extras.css */}
        <div className={`ms-fold ${collapsed ? 'shut' : ''}`} inert={collapsed} aria-hidden={collapsed}>
          <button type="button" className="ms-card-grid b" onClick={() => setOpen(true)}>
            <span title="Bugünkü sipariş · dünle karşılaştırma">
              <em>Sipariş</em>
              <b>{data.orders}</b>
              <Delta cur={data.orders} prev={data.compare.yesterday.orders} label="dün" compact />
            </span>
            <span title="Bugünkü ciro (iptal/iade hariç) · dünle karşılaştırma">
              <em>Ciro</em>
              <b>{money(data.revenue, cur)}</b>
              <Delta cur={amountOf(data.revenue, cur)} prev={amountOf(data.compare.yesterday.revenue, cur)} label="dün" compact />
            </span>
            <span className={data.awaitingShipment ? 'warn' : ''} title="Kargoya verilmeyi bekleyen siparişler">
              <em>Kargo</em>
              <b>{data.awaitingShipment}</b>
              <span className="ms-delta flat">bekliyor</span>
            </span>
            <span className={data.questions.waiting ? 'warn' : ''} title="Cevap bekleyen müşteri soruları">
              <em>Soru</em>
              <b>{data.questions.waiting}</b>
              <span className="ms-delta flat">bekliyor</span>
            </span>
          </button>
        </div>
      </div>
      {open && <MarketSummaryPanel initialPlatform={platform} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Ayrıntılı gün sonu paneli */
export function MarketSummaryPanel({ initialPlatform, onClose }: { initialPlatform: Platform | null; onClose: () => void }) {
  const today = dayKey(Date.now());
  const [day, setDay] = useState(today);
  const [scope, setScope] = useState<Platform | null>(initialPlatform);
  const { data, dataDay, err } = useSummary(day, scope);
  // ilk veri: 7 gün çubukları alttan büyür (25 ms kademeli); gün değişimi: sayılar yeni yönde kayarak değişir
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = useRef<{ day: string | null; bars: boolean }>({ day: null, bars: false });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !data || !dataDay) return;
    const prev = shown.current.day;
    shown.current.day = dataDay;
    if (!shown.current.bars) {
      shown.current.bars = true;
      body.querySelectorAll('.ms-bar .fill').forEach((n, i) => animate(n, [{ transform: 'scaleY(0)' }, { transform: 'none' }], { duration: 400, delay: i * 25, easing: EASE.in, fill: 'backwards' }));
      return;
    }
    if (prev === dataDay) return;
    const up = dataDay > (prev ?? '') ? 1 : -1;
    body.querySelectorAll('.ms-m b, .ms-m .ms-cmp, .ms-m .ms-sub').forEach((n) =>
      animate(n, [{ opacity: 0, transform: `translateY(${up * 10}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE.in }),
    );
    body.querySelectorAll('.ms-two .ms-list > li').forEach((n, i) => animate(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: Math.min(i, 6) * 20, easing: EASE.std, fill: 'backwards' }));
  }, [data, dataDay]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') (e.stopPropagation(), onClose());
      else if (e.key === 'ArrowLeft') setDay((d) => addDays(d, -1));
      else if (e.key === 'ArrowRight') setDay((d) => (d < today ? addDays(d, 1) : d));
      else if (e.key.toLowerCase() === 't') setDay(today);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose, today]);

  const cur = data?.currency ?? 'TRY';
  const maxRev = Math.max(1, ...(data?.trend ?? []).map((t) => t.revenue));
  const maxPlat = Math.max(1, ...(data?.platforms ?? []).map((p) => p.orders));
  const maxQty = Math.max(1, ...(data?.topProducts ?? []).map((p) => p.qty));
  return (
    <div className="overlay ms-ov" onMouseDown={onClose}>
      <div className="modal ms-panel" role="dialog" aria-label="Gün sonu özeti" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ms-head">
          <div className="ms-title">
            <h3>Gün sonu özeti</h3>
            <span>{dayLabel(day)}{day !== today && day !== addDays(today, -1) ? '' : ` · ${DAY_FMT.format(dateOf(day))}`}</span>
          </div>
          <div className="ms-nav">
            <button type="button" className="btn ghost sm icon b b2" aria-label="Önceki gün" onClick={() => setDay(addDays(day, -1))}>
              <Icon name="back" size={15} sw={2} />
            </button>
            <input type="date" className="ms-date" value={day} max={today} onChange={(e) => e.target.value && e.target.value <= today && setDay(e.target.value)} aria-label="Gün seç" />
            <button type="button" className="btn ghost sm icon b b2" aria-label="Sonraki gün" disabled={day >= today} onClick={() => setDay(addDays(day, 1))}>
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
                <Icon name="back" size={15} sw={2} />
              </span>
            </button>
            {day !== today && (
              <button type="button" className="btn ghost sm b b2" onClick={() => setDay(today)}>
                Bugün
              </button>
            )}
          </div>
          <button type="button" className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </header>
        {initialPlatform && (
          <div className="ms-scope" role="tablist" aria-label="Kapsam">
            <button type="button" role="tab" aria-selected={scope === initialPlatform} className={scope === initialPlatform ? 'on' : ''} onClick={() => setScope(initialPlatform)}>
              <Chip platform={initialPlatform} size={14} /> {PLATFORMS[initialPlatform].name}
            </button>
            <button type="button" role="tab" aria-selected={scope === null} className={scope === null ? 'on' : ''} onClick={() => setScope(null)}>
              Tüm pazaryerleri
            </button>
          </div>
        )}
        <div ref={bodyRef} className="ms-body">
          {err && <p className="ms-err">{err}</p>}
          {!data ? (
            <div className="ms-loading">
              <span className="spin" /> Hesaplanıyor…
            </div>
          ) : (
            <>
              <div className="ms-metrics">
                <div className="ms-m">
                  <em>Sipariş</em>
                  <b>{data.orders}</b>
                  <span className="ms-cmp">
                    <Delta cur={data.orders} prev={data.compare.yesterday.orders} label="önceki gün" />
                    <Delta cur={data.orders} prev={data.compare.lastWeek.orders} label="geçen hafta" />
                  </span>
                </div>
                <div className={`ms-m ${data.revenue.length > 1 ? 'multi' : ''}`}>
                  <em>Ciro</em>
                  <b>{formatMoneyList(data.revenue)}</b>
                  <span className="ms-cmp">
                    <Delta cur={amountOf(data.revenue, cur)} prev={amountOf(data.compare.yesterday.revenue, cur)} label="önceki gün" />
                    <Delta cur={amountOf(data.revenue, cur)} prev={amountOf(data.compare.lastWeek.revenue, cur)} label="geçen hafta" />
                  </span>
                </div>
                <div className="ms-m">
                  <em>Ortalama sepet</em>
                  <b>{data.avgBasket.length ? data.avgBasket.map((m) => formatMoney(m)).join(' · ') : '—'}</b>
                </div>
                <div className={`ms-m ${data.cancelled.count + data.returned.count ? 'bad' : ''}`}>
                  <em>İptal / iade</em>
                  <b>
                    {data.cancelled.count} / {data.returned.count}
                  </b>
                  <span className="ms-sub">{data.cancelled.count + data.returned.count ? formatMoneyList([...data.cancelled.amount, ...data.returned.amount].reduce<Money[]>((acc, m) => {
                    const x = acc.find((a) => a.currency === m.currency);
                    if (x) x.amount += m.amount;
                    else acc.push({ ...m });
                    return acc;
                  }, [])) : 'yok'}</span>
                </div>
                <div className={`ms-m ${data.awaitingShipment ? 'warn' : ''}`}>
                  <em>Kargo bekleyen</em>
                  <b>{data.awaitingShipment}</b>
                  <span className="ms-sub">şu an · kargolanan {data.shipped}</span>
                </div>
                <div className="ms-m">
                  <em>Teslim edilen</em>
                  <b>{data.delivered}</b>
                </div>
                <div className={`ms-m ${data.questions.waiting ? 'warn' : ''}`}>
                  <em>Cevap bekleyen soru</em>
                  <b>{data.questions.waiting}</b>
                  <span className="ms-sub">bu gün gelen {data.questions.received}</span>
                </div>
              </div>

              <section className="ms-sec">
                <h4>Son 7 gün · ciro ({cur === 'TRY' ? '₺' : cur})</h4>
                <div className="ms-bars" role="img" aria-label={`Son 7 günün cirosu: ${data.trend.map((t) => `${dayLabel(t.day)} ${formatMoney({ currency: cur, amount: t.revenue })}`).join(', ')}`}>
                  {data.trend.map((t) => (
                    <button type="button" key={t.day} className={`ms-bar b ${t.day === day ? 'on' : ''}`} onClick={() => setDay(t.day)} title={`${DAY_FMT.format(dateOf(t.day))}: ${t.orders} sipariş · ${formatMoney({ currency: cur, amount: t.revenue })}`}>
                      <span className="v">{t.orders}</span>
                      <span className="col">
                        <span className="fill" style={{ height: `${Math.max(t.revenue ? 4 : 0, (t.revenue / maxRev) * 100)}%` }} />
                      </span>
                      <span className="d">{SHORT_FMT.format(dateOf(t.day))}</span>
                    </button>
                  ))}
                </div>
              </section>

              <div className="ms-two">
                <section className="ms-sec">
                  <h4>En çok satanlar</h4>
                  {data.topProducts.length === 0 ? (
                    <p className="ms-none">Bu gün satış yok.</p>
                  ) : (
                    <ol className="ms-list">
                      {data.topProducts.map((p) => (
                        <li key={p.title}>
                          <span className="nm" title={p.title}>
                            {p.title}
                          </span>
                          <span className="hbar">
                            <span style={{ width: `${(p.qty / maxQty) * 100}%` }} />
                          </span>
                          <b>{p.qty} adet</b>
                          <em>{formatMoneyList(p.revenue)}</em>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <section className="ms-sec">
                  <h4>Pazaryerleri</h4>
                  {data.platforms.length === 0 ? (
                    <p className="ms-none">Bu gün hareket yok.</p>
                  ) : (
                    <ul className="ms-list">
                      {data.platforms.map((p) => (
                        <li key={p.platform}>
                          <span className="nm">
                            <Chip platform={p.platform as Platform} size={14} /> {PLATFORMS[p.platform as Platform]?.name ?? p.platform}
                          </span>
                          <span className="hbar">
                            <span style={{ width: `${(p.orders / maxPlat) * 100}%` }} />
                          </span>
                          <b>{p.orders} sipariş</b>
                          <em>
                            {formatMoneyList(p.revenue)}
                            {p.waitingQuestions ? ` · ${p.waitingQuestions} soru` : ''}
                            {p.cancelled + p.returned ? ` · ${p.cancelled + p.returned} iptal/iade` : ''}
                          </em>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
              <p className="ms-foot">Ciro iptal ve iadeler düşülerek hesaplanır. Veriler yalnız bu cihazda, bağlı pazaryeri hesaplarından. ←/→ gün değiştirir, T bugüne döner.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Ayarlar → Bildirimler: gün sonu özeti bildirimi + saati (Ayarlar'daki satır görünümüyle) */
export function MarketDigestSettings({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const [s, setS] = useState<MarketDigest | null>(null);
  useEffect(() => {
    api
      .marketDigest()
      .then(setS)
      .catch(() => setS(null));
  }, []);
  if (!s) return null;
  const save = (patch: Partial<MarketDigest>) => {
    const prev = s;
    setS({ ...s, ...patch });
    api
      .setMarketDigest(patch)
      .then(setS)
      .catch((e: Error) => (setS(prev), notify(e.message, true)));
  };
  return (
    <div className="set-row">
      <span className="set-txt">
        <b>Gün sonu özeti bildirimi</b>
        <em>Pazaryeri hesabın varsa her gün seçtiğin saatte: sipariş sayısı, ciro, bekleyen sorular</em>
      </span>
      <span className="set-ctl ms-set">
        <input type="time" className="ms-time" value={s.time} disabled={!s.enabled} aria-label="Özet saati" onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && save({ time: e.target.value })} />
        <button type="button" role="switch" aria-checked={s.enabled} aria-label="Gün sonu özeti bildirimi" className={`sw ${s.enabled ? 'on' : ''}`} onClick={() => save({ enabled: !s.enabled })} />
      </span>
    </div>
  );
}
