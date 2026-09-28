import { claimUserLocalData, wipeUserLocalData } from './demo-isolation';
import { useEffect, useState } from 'react';
import { authCoreToken, authLoadAccounts, authLogin, authLogout, authMe, authRegister, authSignupConfig, type SessionUser } from './auth-api';
import { setLeaveDemoPanel } from './demo-session';
import { setProfileName, setProfileUser } from './profile';
import { clearDemoAccounts, loadDemoAccounts } from './static-demo';
import { Logo, PasswordInput } from './ui';
import { REMOTE_CORE, clearRemoteCore, coreToken, setRemoteCore } from './desktop';
import App from './App';

/**
 * Sunucu çekirdeği (Admin → Demo → Sunucu çekirdeği açık): üyenin gerçek bağlantıları ağ geçidindeki kendi çekirdeğinde. Her açılışta
 * taze belirteç alınır; API kökü modül yüklenirken seçildiği için çekirdek adresi değişince sayfa bir kez yenilenir. true = yenileniyor.
 */
function tokenUid(t: string): string {
  try {
    return String((JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))) as { u?: string }).u ?? '');
  } catch {
    return '';
  }
}

async function syncRemoteCore(): Promise<boolean> {
  let c: { core: string | null; token?: string };
  try {
    c = await authCoreToken();
  } catch {
    return false; // okunamadı: olduğu gibi devam
  }
  if (c.core && c.token) {
    // açılışta yüklenen belirteç başka bir üyeninse (aynı tarayıcı, farklı hesap) o belirteçle TEK istek bile gitmesin: yenile
    const loadedUid = tokenUid(await coreToken);
    setRemoteCore(c.core, c.token);
    if (REMOTE_CORE !== c.core.replace(/\/+$/, '') || loadedUid !== tokenUid(c.token)) {
      location.reload();
      return true;
    }
    return false;
  }
  if (REMOTE_CORE) {
    clearRemoteCore();
    location.reload();
    return true;
  }
  return false;
}

export function DemoGate() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    authMe()
      .then(async (u) => {
        if (cancelled) return;
        if (u) {
          claimUserLocalData(u.id);
          setProfileName(u.name);
          setProfileUser(u.username);
          if (await syncRemoteCore()) return;
          // kayıtlı kanallar okunamazsa oturum geçerli kalır (giriş ekranına atılmaz), demo varsayılan kanallarla açılır
          if (!REMOTE_CORE) loadDemoAccounts(await authLoadAccounts().catch(() => []), { fresh: u.fresh });
        }
        setUser(u);
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message);
          setUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setLeaveDemoPanel(() => {
      const wasRemote = !!REMOTE_CORE;
      clearRemoteCore();
      clearDemoAccounts();
      wipeUserLocalData();
      setProfileName('');
      // sunucu çekirdeğindeyken API kökü uzak: çıkıştan sonra sayfa yenilenir (sonraki giriş örnek veriyle ya da kendi çekirdeğiyle açılır)
      void authLogout()
        .catch(() => undefined)
        .finally(() => (wasRemote ? location.reload() : setUser(null)));
    });
    return () => setLeaveDemoPanel(null);
  }, []);

  async function enter(u: SessionUser) {
    claimUserLocalData(u.id);
    setProfileName(u.name);
    setProfileUser(u.username);
    if (await syncRemoteCore()) return;
    if (REMOTE_CORE) return setUser(u);
    loadDemoAccounts(await authLoadAccounts().catch(() => []), { fresh: u.fresh });
    setUser(u);
  }

  if (user === undefined) {
    return (
      <div className="booting" role="status">
        <span className="spin" /> Oturum kontrol ediliyor…
      </div>
    );
  }
  if (!user) return <AuthScreen error={error} onClearError={() => setError('')} onEnter={enter} />;
  return <App key={user.id} />;
}

function AuthScreen({
  error,
  onClearError,
  onEnter,
}: {
  error: string;
  onClearError: () => void;
  onEnter: (user: SessionUser) => Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'signup' | 'sent'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password2, setPassword2] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  // otomatik onay (Admin → Demo): açıksa kayıt olan hemen girer, metinler "talep" demez
  const [autoApprove, setAutoApprove] = useState(false);
  useEffect(() => {
    void authSignupConfig().then((c) => setAutoApprove(!!c.autoApprove));
  }, []);

  const switchTo = (m: 'login' | 'signup') => {
    setMode(m);
    setLocalError('');
    onClearError();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError('');
    onClearError();
    setBusy(true);
    try {
      if (mode === 'signup') {
        if (password !== password2) throw new Error('Şifreler aynı değil');
        const reg = await authRegister({ name: `${firstName.trim()} ${lastName.trim()}`.trim(), firstName: firstName.trim(), lastName: lastName.trim(), username: username.trim().toLowerCase(), email: email.trim(), password, website });
        if (reg.pending === false) {
          // otomatik onay: doğrudan giriş
          const res = await authLogin(username.trim().toLowerCase(), password);
          setPassword('');
          setPassword2('');
          await onEnter(res.user);
          return;
        }
        setPassword('');
        setPassword2('');
        setMode('sent');
        return;
      }
      const res = await authLogin(username.trim(), password);
      await onEnter(res.user);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = localError || error;

  if (mode === 'sent')
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand">
            <Logo size={36} />
            <span>mivelo</span>
          </div>
          <h1>Talebin alındı</h1>
          <p className="auth-note">
            Üyelik talebin incelemeye gönderildi. Onaylanınca <b>{email.trim()}</b> adresine e-posta gelecek; sonra <b>{username.trim().toLowerCase()}</b> kullanıcı adı ve belirlediğin şifreyle giriş yapabilirsin.
          </p>
          <button className="btn primary b" type="button" onClick={() => switchTo('login')}>
            Giriş ekranına dön
          </button>
        </div>
      </div>
    );

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <Logo size={36} />
          <span>mivelo</span>
        </div>
        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>
            Giriş yap
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchTo('signup')}>
            Üyelik oluştur
          </button>
        </div>
        {mode === 'signup' && (
          <>
            {!autoApprove && <p className="auth-note">Demoyu denemek için üyelik talebi gönder. Onaylanınca e-posta ile haber veririz; demo sana özel olur.</p>}
            <div className="auth-row">
              <label>
                Ad
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required minLength={1} maxLength={40} />
              </label>
              <label>
                Soyad
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required minLength={1} maxLength={40} />
              </label>
            </div>
            <label>
              E-posta
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" autoCapitalize="none" required maxLength={120} />
            </label>
          </>
        )}
        <label>
          Kullanıcı adı
          {mode === 'signup' ? (
            <input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" autoCapitalize="none" required pattern="[a-z0-9._\-]{3,24}" title="3-24 karakter: küçük harf, rakam, nokta, tire, alt çizgi" maxLength={24} />
          ) : (
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required minLength={2} maxLength={120} pattern=".*\S.*\S.*" title="En az 2 karakter" />
          )}
        </label>
        <label>
          Şifre
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : undefined} />
        </label>
        {mode === 'signup' && (
          <>
            <label>
              Şifre (tekrar)
              <PasswordInput value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            {/* bot tuzağı: görünmez alan */}
            <input className="auth-hp" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" />
          </>
        )}
        {shown && <div className="auth-error">{shown}</div>}
        <button className="btn primary b" type="submit" disabled={busy}>
          {busy ? <span className="spin" /> : mode === 'signup' ? (autoApprove ? 'Üye ol' : 'Üyelik talebi gönder') : 'Giriş yap'}
        </button>
        {REMOTE_CORE && (
          <div className="auth-remote">
            Gerçek çekirdek: <code>{REMOTE_CORE.replace(/^https?:\/\//, '')}</code>
            <button type="button" className="btn ghost xs b" onClick={() => (clearRemoteCore(), location.reload())}>
              Bağlantıyı kes
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
