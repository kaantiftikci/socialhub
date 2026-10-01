import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type LicenseStatus } from './api';
import { isTauri, openExternal } from './desktop';
import { SetupScreen, Splash, SplashMark, setupDone } from './Onboarding';
import { setProfileName } from './profile';
import { Icon, Logo } from './ui';
import { loadConsent, saveConsent, useConsent } from './consent-store';
import { AiConsentHost, ConsentChecks, ConsentScreen, allRequiredChecked, type ConsentChecked } from './Consent';

const SIGNED_OUT = 'mivelo.signedOut';
function readSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT) === '1';
  } catch {
    return false;
  }
}
function writeSignedOut(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGNED_OUT, '1');
    else localStorage.removeItem(SIGNED_OUT);
  } catch {
    /* depolama yok */
  }
}

/**
 * Ayarlar → Çıkış yap. Masaüstü (lisans zorunlu): lisans bu bilgisayardan kaldırılır (cihaz hakkı boşalır, kanallar durur),
 * yeniden girmek için anahtar istenir. Lisans istenmeyen yerel sürümde (npm run dev / localhost) yalnız arayüzden çıkılır:
 * aynı veri klasörünü paylaşan masaüstü uygulamasının lisansına DOKUNULMAZ. Mesajlar ve bağlı uygulamalar silinmez.
 */
export async function signOut(): Promise<void> {
  const st = await api.license().catch(() => null);
  if (st?.required) await api.releaseLicense();
  writeSignedOut(true);
  window.dispatchEvent(new Event('mivelo:signout'));
}

/** Lisans sahibinin adı profil adı olur (yoksa App işletim sistemindeki adı kullanır) */
function applyOwner(s: LicenseStatus): LicenseStatus {
  const o = s.owner;
  if (o?.name || o?.email) setProfileName(o.name || o.email!.split('@')[0], true);
  return s;
}

/**
 * Paketli masaüstü uygulaması (DMG/EXE): çekirdek lisans istiyorsa (MIVELO_REQUIRE_LICENSE) uygulama açılır açılmaz anahtar
 * ekranı. Anahtarı Kaan yönetim panelinde (Lisanslar) üretip iletiyor; doğrulama çekirdek → mivelo.app/api/license.php.
 * Açıkken 10 dakikada bir ve pencere öne gelince yeniden sorulur: iptal edilen lisans bu ekrana döner.
 *
 * Masaüstünde sıra: açılış animasyonu (lisans durumu gelene dek) → [lisans ekranı] → [ilk kurulum: izinler, bir kez] →
 * açılış animasyonu → uygulama. Etkinleştirme / kurulumdan sonra uzun animasyon (≈2,8 sn), sonraki açılışlarda kısa (≈1 sn).
 * Uygulama animasyonun ALTINDA hemen çizilir (veriler bu sırada yüklenir); katman saydamlaşınca görünür.
 * Çıkış yapılmışsa (Ayarlar → Çıkış yap) giriş ekranı; yeniden girişte uzun animasyon.
 */
export function LicenseGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<LicenseStatus | null>(isTauri ? null : { required: false, valid: true });
  const [setup, setSetup] = useState(() => isTauri && !setupDone());
  const [splash, setSplash] = useState<'full' | 'quick' | null>(isTauri ? 'quick' : null);
  const [signedOut, setSignedOut] = useState(readSignedOut);
  // yasal onaylar (Koşullar/EULA, KVKK, risk): yalnız masaüstünde zorunlu; yüklenene dek açılış animasyonu sürer
  const consent = useConsent();
  const [csReady, setCsReady] = useState(!isTauri);
  useEffect(() => {
    if (isTauri) void loadConsent().finally(() => setCsReady(true));
    else void loadConsent(); // yerel web: AI rızası kapısı için önbellek
  }, []);
  const refresh = useCallback((check = false) => {
    api
      .license(check)
      .then((s) => setSt(applyOwner(s)))
      // çekirdek henüz kalkmadıysa ya da eski çekirdekte uç yoksa uygulamayı engelleme (App kendi "başlatılıyor" ekranını gösterir)
      .catch(() => setSt((s) => s ?? { required: false, valid: true }));
  }, []);
  useEffect(() => {
    const onOut = () => {
      setSignedOut(true);
      if (isTauri) refresh();
    };
    window.addEventListener('mivelo:signout', onOut);
    if (!isTauri) return () => window.removeEventListener('mivelo:signout', onOut);
    refresh(true);
    // çekirdek açılırken ilk istek düşebilir: birkaç kez dene
    const t1 = window.setTimeout(refresh, 2500);
    const t2 = window.setTimeout(refresh, 8000);
    const iv = window.setInterval(() => refresh(true), 10 * 60_000);
    const onFocus = () => refresh(true);
    window.addEventListener('focus', onFocus);
    return () => (window.clearTimeout(t1), window.clearTimeout(t2), window.clearInterval(iv), window.removeEventListener('focus', onFocus), window.removeEventListener('mivelo:signout', onOut));
  }, [refresh]);

  const enter = () => {
    writeSignedOut(false);
    setSignedOut(false);
    setSplash('full');
  };
  const ok = !!st && (!st.required || st.valid) && csReady;
  const needConsent = isTauri && csReady && consent.needed.length > 0;
  if (st && csReady && !(!st.required || st.valid))
    return (
      <LicenseScreen
        status={st}
        signedOut={signedOut}
        onDone={(s) => {
          // etkinleşti: düz arayüz yerine logolu açılış (kurulum gerekiyorsa ondan sonra)
          if (!s.required || s.valid) enter();
          setSt(applyOwner(s));
        }}
      />
    );
  if (ok && signedOut) return <SignedOutScreen onEnter={enter} />;
  // lisans geçerli ama koşulların yeni sürümü onaylanmamış (güncelleme sonrası ya da eski kurulum)
  if (ok && needConsent) return <ConsentScreen needed={consent.needed} onDone={() => setSplash('quick')} />;
  if (ok && setup)
    return (
      <SetupScreen
        onDone={() => {
          setSetup(false);
          setSplash('full');
        }}
      />
    );
  return (
    <>
      {ok && children}
      {splash && <Splash key={splash} mode={splash} ready={ok} onDone={() => setSplash(null)} />}
      <AiConsentHost />
    </>
  );
}

/** Lisans istenmeyen yerel sürümde çıkıştan sonra: yalnız "Yeniden giriş yap" (çekirdek ve kanallar çalışmayı sürdürür) */
function SignedOutScreen({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="auth-screen">
      <div className="auth-card signed-out">
        <div className="setup-hero" aria-hidden="true">
          <SplashMark size={56} animate />
        </div>
        <h1>Çıkış yaptın</h1>
        <p>Mesajların ve bağlı uygulamaların bu bilgisayarda duruyor; Mivelo arka planda eşitlemeyi sürdürür.</p>
        <button className="btn primary b" type="button" autoFocus onClick={onEnter}>
          Yeniden giriş yap
        </button>
      </div>
    </div>
  );
}

function LicenseScreen({ status, signedOut, onDone }: { status: LicenseStatus; signedOut?: boolean; onDone: (s: LicenseStatus) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // kendi isteğiyle çıkan kullanıcıya "lisans kaldırıldı" hatası gösterilmez
  const [err, setErr] = useState(signedOut ? '' : (status.reason ?? ''));
  // etkinleştirmeden önce zorunlu onaylar (yalnız eksik ya da sürümü değişenler; önceden işaretli değil)
  const needed = useConsent().needed;
  const [checked, setChecked] = useState<ConsentChecked>({});
  const consentOk = allRequiredChecked(checked, needed);
  const submit = async () => {
    if (!key.trim() || busy || !consentOk) return;
    setBusy(true);
    setErr('');
    try {
      // onay önce kaydedilir: çekirdek etkinleştirmede kabul edilen koşul sürümünü lisans sunucusuna iletir
      if (needed.length && (await saveConsent({ accept: needed })).needed.length) throw new Error('Onaylar kaydedilemedi; yeniden dene');
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
        <h1>{signedOut ? 'Çıkış yaptın' : 'Lisans anahtarın'}</h1>
        <p>
          {signedOut
            ? 'Mesajların ve bağlı uygulamaların bu bilgisayarda duruyor. Yeniden girmek için lisans anahtarını gir.'
            : "Mivelo'yu kullanmak için sana iletilen lisans anahtarını gir. Anahtar bir kez girilir; bu bilgisayarda hatırlanır."}
        </p>
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
        {needed.length > 0 && <ConsentChecks value={checked} onChange={setChecked} keys={needed} />}
        {err && (
          <div className="auth-error" role="alert">
            <Icon name="alert" size={14} sw={2} /> {err}
          </div>
        )}
        <button className="btn primary b" type="submit" disabled={busy || !consentOk || key.replace(/[^A-Z0-9]/g, '').length < 19}>
          {busy ? 'Doğrulanıyor…' : signedOut ? 'Giriş yap' : 'Etkinleştir'}
        </button>
        <p className="lic-help">
          Anahtarın, uygulamayı{' '}
          <a
            href="https://mivelo.app/indir/"
            onClick={(e) => {
              e.preventDefault();
              void openExternal('https://mivelo.app/indir/');
            }}
          >
            mivelo.app/indir
          </a>{' '}
          adresinden indirirken kayıt olduğun e-postaya gelir. Gelmediyse <b>hello@mivelo.app</b>'e yaz.
        </p>
      </form>
    </div>
  );
}
