import { claimUserLocalData, wipeUserLocalData } from './demo-isolation';
import { useEffect, useState } from 'react';
import { authLoadAccounts, authLogin, authLogout, authMe, type SessionUser } from './auth-api';
import { setLeaveDemoPanel } from './demo-session';
import { setProfileName, setProfileUser } from './profile';
import { clearDemoAccounts, loadDemoAccounts } from './static-demo';
import { Logo, PasswordInput } from './ui';
import { REMOTE_CORE, clearRemoteCore } from './desktop';
import App from './App';
import { Splash } from './Onboarding';

export function DemoGate() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [error, setError] = useState('');
  // giriş yapınca düz arayüz yerine logolu açılış (masaüstündeki lisans etkinleştirmesiyle aynı)
  const [splash, setSplash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authMe()
      .then(async (u) => {
        if (cancelled) return;
        if (u) {
          claimUserLocalData(u.id);
          setProfileName(u.name);
          setProfileUser(u.username);
          // kayıtlı kanallar okunamazsa oturum geçerli kalır (giriş ekranına atılmaz), demo varsayılan kanallarla açılır
          loadDemoAccounts(await authLoadAccounts().catch(() => []), { fresh: u.fresh });
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
      void authLogout().catch(() => undefined);
      clearDemoAccounts();
      wipeUserLocalData();
      setProfileName('');
      setUser(null);
    });
    return () => setLeaveDemoPanel(null);
  }, []);

  async function enter(u: SessionUser) {
    claimUserLocalData(u.id);
    setProfileName(u.name);
    setProfileUser(u.username);
    loadDemoAccounts(await authLoadAccounts().catch(() => []), { fresh: u.fresh });
    setSplash(true);
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
  return (
    <>
      <App key={user.id} />
      {splash && <Splash mode="full" onDone={() => setSplash(false)} />}
    </>
  );
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
  // Demo yalnız giriş: üyelik kapatıldı (Kaan: demoda yalnız admin; uygulamayı indirenler mivelo.app/indir'de kayıt olur)
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError('');
    onClearError();
    setBusy(true);
    try {
      const res = await authLogin(username.trim(), password);
      await onEnter(res.user);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = localError || error;

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <Logo size={36} />
          <span>mivelo</span>
        </div>
        <label>
          Kullanıcı adı
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required minLength={2} maxLength={120} pattern=".*\S.*\S.*" title="En az 2 karakter" />
        </label>
        <label>
          Şifre
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {shown && <div className="auth-error">{shown}</div>}
        <button className="btn primary b" type="submit" disabled={busy}>
          {busy ? <span className="spin" /> : 'Giriş yap'}
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
