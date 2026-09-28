import { useEffect, useState } from 'react';
import { isTauri, openExternal } from './desktop';
import { Icon } from './ui';

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
 * varsa alt köşede küçük kart ("İndir" → indirme sayfası). "Sonra" o sürümü bir daha göstermez. Veri gönderilmez (yalnız GET).
 */
export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
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
    return () => window.clearInterval(t);
  }, []);
  if (!latest) return null;
  return (
    <div className="update-card" role="status">
      <Icon name="download" size={16} sw={2} />
      <div>
        <b>Mivelo {latest} hazır</b>
        <span>Yeni sürümü indirip kur; verilerin ve bağlı hesapların korunur.</span>
      </div>
      <button className="btn sm primary b b2" onClick={() => void openExternal(DOWNLOAD_URL)}>
        İndir
      </button>
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
    </div>
  );
}
