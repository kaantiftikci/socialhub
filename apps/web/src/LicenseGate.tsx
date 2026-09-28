import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type LicenseStatus } from './api';
import { isTauri, openExternal } from './desktop';
import { Icon, Logo } from './ui';

/**
 * Paketli masaüstü uygulaması (DMG/EXE): çekirdek lisans istiyorsa (MIVELO_REQUIRE_LICENSE) uygulama açılır açılmaz anahtar
 * ekranı. Anahtarı Kaan yönetim panelinde (Lisanslar) üretip iletiyor; doğrulama çekirdek → mivelo.app/api/license.php.
 * Açıkken 10 dakikada bir ve pencere öne gelince yeniden sorulur: iptal edilen lisans bu ekrana döner.
 */
export function LicenseGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<LicenseStatus | null>(isTauri ? null : { required: false, valid: true });
  const refresh = useCallback(() => {
    api
      .license()
      .then(setSt)
      // çekirdek henüz kalkmadıysa ya da eski çekirdekte uç yoksa uygulamayı engelleme (App kendi "başlatılıyor" ekranını gösterir)
      .catch(() => setSt((s) => s ?? { required: false, valid: true }));
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    refresh();
    // çekirdek açılırken ilk istek düşebilir: birkaç kez dene
    const t1 = window.setTimeout(refresh, 2500);
    const t2 = window.setTimeout(refresh, 8000);
    const iv = window.setInterval(refresh, 10 * 60_000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => (window.clearTimeout(t1), window.clearTimeout(t2), window.clearInterval(iv), window.removeEventListener('focus', onFocus));
  }, [refresh]);

  if (!st) return <div className="auth-screen" />;
  if (!st.required || st.valid) return <>{children}</>;
  return <LicenseScreen status={st} onDone={setSt} />;
}

function LicenseScreen({ status, onDone }: { status: LicenseStatus; onDone: (s: LicenseStatus) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(status.reason ?? '');
  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      onDone(await api.activateLicense(key.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // yapıştırılan anahtarı biçimle: MVL-XXXX-XXXX-XXXX-XXXX
  const format = (v: string) => {
    const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MVL/, '').slice(0, 16);
    return raw ? 'MVL-' + raw.match(/.{1,4}/g)!.join('-') : '';
  };
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="brand">
          <Logo size={36} />
          <span>mivelo</span>
        </div>
        <h1>Lisans anahtarın</h1>
        <p>Mivelo'yu kullanmak için sana iletilen lisans anahtarını gir. Anahtar bir kez girilir; bu bilgisayarda hatırlanır.</p>
        <input
          className="lic-input"
          value={key}
          onChange={(e) => setKey(format(e.target.value))}
          placeholder="MVL-XXXX-XXXX-XXXX-XXXX"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label="Lisans anahtarı"
        />
        {err && (
          <div className="auth-error" role="alert">
            <Icon name="alert" size={14} sw={2} /> {err}
          </div>
        )}
        <button className="btn primary b" type="submit" disabled={busy || key.replace(/[^A-Z0-9]/g, '').length < 19}>
          {busy ? 'Doğrulanıyor…' : 'Etkinleştir'}
        </button>
        <p className="lic-help">
          Anahtarın yok mu?{' '}
          <a
            href="https://mivelo.app"
            onClick={(e) => {
              e.preventDefault();
              void openExternal('https://mivelo.app');
            }}
          >
            mivelo.app
          </a>{' '}
          üzerinden bekleme listesine katıl ya da <b>hello@mivelo.app</b>'e yaz.
        </p>
      </form>
    </div>
  );
}
