import { useEffect, useState } from 'react';
import { authLoadAccounts, authLogin, authLogout, authMe, type SessionUser } from './auth-api';
import { setLeaveDemoPanel } from './demo-session';
import { setProfileName } from './profile';
import { clearDemoAccounts, loadDemoAccounts } from './static-demo';
import { Logo } from './ui';
import { REMOTE_CORE, clearRemoteCore } from './desktop';
import App from './App';

export function DemoGate() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    authMe()
      .then(async (u) => {
        if (cancelled) return;
        if (u) {
          setProfileName(u.name);
          // kayıtlı kanallar okunamazsa oturum geçerli kalır (giriş ekranına atılmaz), demo varsayılan kanallarla açılır
          loadDemoAccounts(await authLoadAccounts().catch(() => []));
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
      setProfileName('');
      setUser(null);
    });
    return () => setLeaveDemoPanel(null);
  }, []);

  async function enter(u: SessionUser) {
    setProfileName(u.name);
    loadDemoAccounts(await authLoadAccounts().catch(() => []));
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
        <h1>Giriş yap</h1>
        <label>
          Kullanıcı adı
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required minLength={2} maxLength={40} pattern=".*\S.*\S.*" title="En az 2 karakter" />
        </label>
        <label>
          Şifre
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
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
