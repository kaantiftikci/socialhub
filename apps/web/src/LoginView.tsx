import { useEffect, useRef, useState } from 'react';
import { api, connectEvents } from './api';
import { REMOTE_CORE } from './desktop';
import { PLATFORMS, type Account, type CoreEvent, type LoginInput, type Platform } from './types';
import { Chip, Icon } from './ui';

type Frame = Extract<CoreEvent, { type: 'login.frame' }>;

/* Kare akışı App'in durumundan geçmez (saniyede onlarca kare koca listeyi yeniden çizdirirdi): küçük yayıncı */
let current: Frame | null = null;
const subs = new Set<() => void>();
export function pushLoginEvent(ev: CoreEvent): boolean {
  if (ev.type === 'login.frame') current = ev;
  // giriş ekranı hemen açılsın: ilk kare gelene dek "açılıyor…"
  else if (ev.type === 'login.start') current = { type: 'login.frame', accountId: ev.accountId, data: '', width: 820, height: 700, host: '' };
  else if (ev.type === 'login.end') {
    if (current?.accountId !== ev.accountId) return true;
    current = null;
  } else return false;
  subs.forEach((f) => f());
  return true;
}

/**
 * Sunucu çekirdeği (demo üyeleri): giriş sayfası sunucudaki tarayıcıda açılır ve görüntüsü AYRI bir sekmede gösterilir
 * (yereldeki gibi harici giriş; Mivelo'nun içinde DEĞİL). Tarayıcılar tıklamadan sonra (await'ten sonra) açılan sekmeyi engellediği
 * için sekme TIKLAMA ANINDA açılır: hesap kimliği biliniyorsa doğrudan, bilinmiyorsa boş sekme (preopenLogin) + sonra bindLogin.
 */
const popups = new Map<string, Window>();
const loginUrl = (accountId: string) => `${location.pathname}?loginview=${encodeURIComponent(accountId)}`;
export function openLoginPopup(accountId: string): boolean {
  const old = popups.get(accountId);
  if (old && !old.closed) {
    old.focus();
    return true;
  }
  const win = window.open(loginUrl(accountId), `mivelo-login-${accountId}`);
  if (!win) return false;
  popups.set(accountId, win);
  return true;
}

/** Tıklama anında (ilk await'ten ÖNCE) çağrılır: yalnız sunucu çekirdeğinde ve tarayıcıyla girilen kanallarda sekme açar */
export function preopenLogin(platform: Platform, accountId?: string): Window | null {
  if (!REMOTE_CORE || PLATFORMS[platform]?.mode !== 'browser') return null;
  if (accountId) return openLoginPopup(accountId) ? (popups.get(accountId) ?? null) : null;
  const w = window.open('', '_blank');
  try {
    if (w) {
      w.document.title = 'Giriş';
      w.document.body.innerHTML = '<p style="font:15px system-ui,sans-serif;padding:40px;color:#777">Giriş sayfası açılıyor…</p>';
    }
  } catch {
    /* erişilemedi */
  }
  return w;
}
/** preopenLogin'in boş sekmesini hesabın giriş görüntüsüne yönlendir */
export function bindLogin(w: Window | null, accountId: string) {
  if (!w || w.closed) return;
  w.location.href = loginUrl(accountId);
  popups.set(accountId, w);
}

/** Ayrı giriş penceresinin sayfası (?loginview=<hesap>): yalnız giriş görüntüsü; giriş bitince pencere kapanır */
export function LoginPopup({ accountId }: { accountId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    document.title = 'Giriş';
    pushLoginEvent({ type: 'login.start', accountId });
    void api.accounts().then(setAccounts).catch(() => undefined);
    // sonradan bağlanan izleyici: çekirdek görüntüyü yeniden göndersin
    void api.loginInput(accountId, []).catch(() => undefined);
    const off = connectEvents((ev) => {
      if ('accountId' in ev && ev.accountId !== accountId) return;
      if (ev.type === 'login.end') window.close();
      // oturum zaten geçerliydi (giriş gerekmedi) ya da giriş bitti: sekme kendiliğinden kapansın
      if (ev.type === 'account.status' && ev.account?.id === accountId && ev.account.status === 'connected') window.close();
      pushLoginEvent(ev);
    });
    // yeniden bağlanırken giriş gerekmediyse (oturum geçerli) görüntü hiç gelmez: boş sekme açık kalmasın
    const idle = window.setTimeout(() => {
      if (current?.accountId === accountId && current.data) return;
      void api.accounts().then((list) => {
        if (list.find((a) => a.id === accountId)?.status !== 'pairing') window.close();
      }).catch(() => undefined);
    }, 30_000);
    return () => (off(), window.clearTimeout(idle));
  }, [accountId]);
  return <LoginView accounts={accounts} popup />;
}

/** DOM tuş adı → Playwright tuş adı (yalnız yazı dışı tuşlar) */
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Mivelo içi giriş: çekirdekteki görünmez tarayıcının giriş sayfası canlı görüntü olarak gösterilir; fare, tekerlek, klavye ve
 * yapıştırma o sayfaya aktarılır. Oturum Mivelo'nun kendi tarayıcı profilinde oluşur (site Mivelo'ya gömülemez: iframe engeli).
 */
export function LoginView({ accounts, popup = false }: { accounts: Account[]; popup?: boolean }) {
  const [frame, setFrame] = useState<Frame | null>(current);
  const [err, setErr] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const keyRef = useRef<HTMLTextAreaElement>(null);
  const queue = useRef<LoginInput[]>([]);
  const sending = useRef(false);
  const lastMove = useRef(0);
  const down = useRef(false);

  useEffect(() => {
    const on = () => setFrame(current);
    subs.add(on);
    return () => void subs.delete(on);
  }, []);
  const id = frame?.accountId;
  // sunucu çekirdeği: ana pencerede gösterme, ayrı pencere aç (engellenirse burada göster)
  const [popped, setPopped] = useState<string | null>(null);
  useEffect(() => {
    if (id) requestAnimationFrame(() => keyRef.current?.focus());
    setErr('');
    if (id && REMOTE_CORE && !popup) setPopped(openLoginPopup(id) ? id : null);
  }, [id, popup]);

  if (!frame) return null;
  // sunucu çekirdeği: giriş ASLA Mivelo'nun içinde gösterilmez; sekme engellendiyse tek tıkla açılır
  if (REMOTE_CORE && !popup) {
    const open = popped === frame.accountId;
    return (
      <div className="login-opening" role="status">
        {open ? <span className="spin" /> : <Icon name="alert" size={14} sw={2} />} {open ? 'Giriş ayrı sekmede açık' : 'Giriş sekmesi engellendi'}
        <button className="btn xs b b2" onClick={() => setPopped(openLoginPopup(frame.accountId) ? frame.accountId : null)}>
          {open ? 'Sekmeye git' : 'Giriş sekmesini aç'}
        </button>
      </div>
    );
  }
  const acc = accounts.find((a) => a.id === frame.accountId);
  const platform = acc?.platform;

  // girdiler sırayla, birikenler tek istekte
  const flush = async () => {
    if (sending.current || !queue.current.length) return;
    sending.current = true;
    const batch = queue.current.splice(0, queue.current.length);
    try {
      await api.loginInput(frame.accountId, batch);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      sending.current = false;
      if (queue.current.length) void flush();
    }
  };
  const send = (ev: LoginInput) => {
    queue.current.push(ev);
    void flush();
  };
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * frame.width), y: Math.round(((e.clientY - r.top) / r.height) * frame.height) };
  };
  const btn = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left') as 'left' | 'right' | 'middle';

  return (
    <div className={`overlay login-ov ${popup ? 'popup' : ''}`}>
      <div className="login-box" role="dialog" aria-label="Giriş">
        <div className="login-head">
          {platform && <Chip platform={platform} size={26} />}
          <div className="login-title">
            <b>{platform ? PLATFORMS[platform].name : 'Hesap'} girişi</b>
            <span>
              <Icon name="lock" size={11} sw={2} /> {frame.host || 'yükleniyor…'}
            </span>
          </div>
          <span style={{ flexGrow: 1 }} />
          {!popup && (
            <button
              className="btn sm b b2"
              onClick={() => (REMOTE_CORE ? setPopped(openLoginPopup(frame.accountId) ? frame.accountId : null) : void api.loginWindow(frame.accountId).catch((e) => setErr((e as Error).message)))}
              title="Giriş sayfası burada çalışmazsa"
            >
              Ayrı pencerede aç
            </button>
          )}
          <button className="btn icon b b2" aria-label="Girişi iptal et" title="İptal" onClick={() => void api.loginCancel(frame.accountId)}>
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>
        <div className="login-screen" onClick={() => keyRef.current?.focus()}>
          {!frame.data && (
            <div className="login-loading" style={{ width: `min(100%, calc((94vh - 100px) * ${frame.width} / ${frame.height}))`, aspectRatio: `${frame.width} / ${frame.height}` }}>
              <span className="spin" /> Giriş sayfası açılıyor…
            </div>
          )}
          <img
            ref={imgRef}
            hidden={!frame.data}
            src={frame.data ? `data:image/jpeg;base64,${frame.data}` : undefined}
            alt=""
            draggable={false}
            style={{ width: `min(100%, calc((94vh - 100px) * ${frame.width} / ${frame.height}))` }}
            onPointerDown={(e) => {
              e.preventDefault();
              down.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              keyRef.current?.focus();
              send({ type: 'down', ...pos(e), button: btn(e.button), clicks: e.detail || 1 });
            }}
            onPointerUp={(e) => {
              down.current = false;
              send({ type: 'up', ...pos(e), button: btn(e.button), clicks: e.detail || 1 });
            }}
            onPointerMove={(e) => {
              const now = Date.now();
              if (now - lastMove.current < (down.current ? 30 : 90)) return;
              lastMove.current = now;
              send({ type: 'move', ...pos(e) });
            }}
            onWheel={(e) => send({ type: 'wheel', ...pos(e), dx: e.deltaX, dy: e.deltaY })}
            onContextMenu={(e) => e.preventDefault()}
          />
          {/* görünmez klavye yakalayıcı: yazı, özel tuşlar ve yapıştırma */}
          <textarea
            ref={keyRef}
            className="login-keys"
            aria-label="Giriş sayfasına yaz"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (mod && ['v', 'V'].includes(e.key)) return; // paste olayı işler
              if (mod && /^[acxzy]$/i.test(e.key)) {
                e.preventDefault();
                send({ type: 'key', key: `ControlOrMeta+${e.key.toLowerCase()}` });
                return;
              }
              if (KEYS.has(e.key)) {
                e.preventDefault();
                send({ type: 'key', key: (e.shiftKey && e.key === 'Tab' ? 'Shift+' : '') + e.key });
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              const t = e.clipboardData.getData('text');
              if (t) send({ type: 'text', text: t });
            }}
            onInput={(e) => {
              const t = e.currentTarget.value;
              e.currentTarget.value = '';
              if (t) send({ type: 'text', text: t });
            }}
          />
        </div>
        <div className="login-foot">
          {err ? <span className="login-err">{err}</span> : <span>Giriş yapınca bu pencere kendiliğinden kapanır. Şifren Mivelo'da saklanmaz.</span>}
        </div>
      </div>
    </div>
  );
}
