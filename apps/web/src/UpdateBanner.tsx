import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type UpdateStatus } from './api';
import { isTauri, openExternal } from './desktop';
import { Icon, useClosing } from './ui';
import { DUR, EASE, animate } from './motion/motion';

/** Masaüstü paketi (DMG/EXE) sürümü: CI'da VITE_APP_VERSION ile gömülür (build-desktop.yml) */
export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';
const LATEST_URL = 'https://mivelo.app/indir/files/latest.json';
const DOWNLOAD_URL = 'https://mivelo.app/indir/';
const SKIP_KEY = 'mivelo.updateSkip';

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/**
 * Paketli uygulamada yeni sürüm denetimi: açılışta ve 6 saatte bir mivelo.app/indir/files/latest.json okunur; daha yeni sürüm
 * varsa alt köşede küçük kart. "Güncelle" (29.09, Kaan: indirme sayfasına gitmesin, arka planda kursun): çekirdek paketi
 * arka planda indirir + doğrular (ilerleme çubuğu), bitince kendiliğinden kurar — Mivelo kapanır, yenisiyle açılır; veriler ve
 * bağlı hesaplar ~/.mivelo'da kalır. Uygulama içi kurulum desteklenmiyorsa (ör. elle taşınmış paket) indirme sayfasına gider.
 * "Sonra" o sürümü bir daha göstermez.
 */
export function UpdateBanner() {
  const [latestNow, setLatest] = useState<string | null>(null);
  // "Sonra" deyince kart 150 ms'de solarak kalkar (değer kapanış boyunca tutulur)
  const shown = useClosing(latestNow, DUR.quick);
  const latest = shown.value;
  const cardRef = useRef<HTMLDivElement>(null);
  const visible = !!latest;
  useLayoutEffect(() => {
    if (!visible) return;
    animate(cardRef.current, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.std, easing: EASE.in });
  }, [visible]);
  const exit = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    exit.current?.cancel(); // kapanırken yeniden göründüyse soluk kalmasın
    exit.current = shown.closing ? animate(cardRef.current, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: DUR.quick, easing: EASE.out, fill: 'forwards' }) : null;
  }, [shown.closing]);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const poll = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!isTauri || !APP_VERSION) return;
    const check = () =>
      fetch(LATEST_URL, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { version?: string } | null) => {
          const v = j?.version;
          let skip = '';
          try {
            skip = localStorage.getItem(SKIP_KEY) ?? '';
          } catch {
            /* yok */
          }
          if (v && newer(v, APP_VERSION) && v !== skip) setLatest(v);
        })
        .catch(() => undefined);
    void check();
    const t = window.setInterval(check, 6 * 3600_000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(poll.current);
    };
  }, []);
  if (!latest) return null;

  const follow = () => {
    window.clearInterval(poll.current);
    poll.current = window.setInterval(() => {
      api
        .updateStatus()
        .then((s) => {
          setSt(s);
          if (s.state === 'ready') {
            window.clearInterval(poll.current);
            // indirme bitti: hemen kur (Mivelo kapanıp yeni sürümle açılır)
            api.installUpdate().then(setSt).catch((e) => setSt({ ...s, state: 'error', error: (e as Error).message }));
          } else if (s.state === 'error' || s.state === 'idle') window.clearInterval(poll.current);
        })
        .catch(() => undefined);
    }, 600);
  };
  const start = async () => {
    try {
      const s = await api.updateStatus();
      if (!s.supported) return void openExternal(DOWNLOAD_URL);
      setSt(await api.startUpdate());
      follow();
    } catch (e) {
      setSt({ state: 'error', supported: true, pct: 0, error: (e as Error).message });
    }
  };
  const busy = st?.state === 'downloading' || st?.state === 'ready' || st?.state === 'installing';
  const title =
    st?.state === 'downloading'
      ? `Mivelo ${latest} indiriliyor… %${st.pct}`
      : st?.state === 'ready' || st?.state === 'installing'
        ? `Mivelo ${latest} kuruluyor…`
        : st?.state === 'error'
          ? 'Güncelleme yapılamadı'
          : `Mivelo ${latest} hazır`;
  const sub =
    st?.state === 'downloading'
      ? 'Arka planda iniyor; kullanmaya devam edebilirsin.'
      : st?.state === 'ready' || st?.state === 'installing'
        ? 'Mivelo birazdan kapanıp yeni sürümle açılacak. Verilerin ve bağlı hesapların korunur.'
        : st?.state === 'error'
          ? `${st.error ?? 'Bilinmeyen hata'}`
          : 'Güncelle deyince arka planda iner ve kurulur; verilerin ve bağlı hesapların korunur.';
  return (
    <div className="update-card" role="status" ref={cardRef} style={shown.closing ? { pointerEvents: 'none' } : undefined}>
      <Icon name="download" size={16} sw={2} />
      <div>
        <b>{title}</b>
        <span>{sub}</span>
        {st?.state === 'downloading' && (
          <i className="update-bar">
            <i style={{ width: `${Math.max(3, st.pct)}%` }} />
          </i>
        )}
      </div>
      {!busy && (
        <button className="btn sm primary b b2" onClick={() => void start()}>
          {st?.state === 'error' ? 'Tekrar dene' : 'Güncelle'}
        </button>
      )}
      {st?.state === 'error' && (
        <button className="btn sm b b2" onClick={() => void openExternal(DOWNLOAD_URL)}>
          İndirme sayfası
        </button>
      )}
      {!busy && st?.state !== 'error' && (
        <button
          className="btn sm b b2"
          onClick={() => {
            try {
              localStorage.setItem(SKIP_KEY, latest);
            } catch {
              /* yok */
            }
            setLatest(null);
          }}
        >
          Sonra
        </button>
      )}
    </div>
  );
}
