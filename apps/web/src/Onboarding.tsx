import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { isMac, notify as desktopNotify } from './desktop';
import { Icon } from './ui';

/**
 * İlk açılış (paketli masaüstü): lisans → İZİNLER (bir kez) → logolu açılış animasyonu → uygulama.
 * Eskiden izinler dağınık istendi: ilk bildirimde bildirim izni, iMessage her açılışta Tam Disk Erişimi bölmesini açıyordu.
 * Kurulumda hepsi bir arada, açıklamalı istenir; verilmeyenler sonradan Ayarlar'dan ya da kanalın Bağlan panelinden verilebilir.
 */
export const SETUP_KEY = 'mivelo.setup';
const SETUP_VERSION = '1';
const STATE_KEY = 'mivelo.setupPerms';

export function setupDone(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) === SETUP_VERSION;
  } catch {
    return true; // depolama yoksa kurulumu her açılışta göstermeyelim
  }
}

type PermKey = 'notifications' | 'microphone' | 'fulldisk' | 'messages' | 'calendar';
/** Kalıcı (localStorage) yanıt: yalnız canlı denetimin bilemediği durumlarda kullanılır */
type Stored = 'granted' | 'denied' | 'requested';
/** Ekranda gösterilen durum */
type PermState = 'granted' | 'denied' | 'idle' | 'asking';

interface Row {
  key: PermKey;
  icon: string;
  title: string;
  desc: string;
  /** yalnız macOS */
  mac?: boolean;
  optional?: boolean;
}

const ROWS: Row[] = [
  { key: 'notifications', icon: 'bell', title: 'Bildirimler', desc: 'Yeni mesajlarda uyarı ve ses' },
  { key: 'fulldisk', icon: 'lock', title: 'Tam Disk Erişimi', desc: 'iMessage mesajları ve rehberdeki adlar', mac: true },
  { key: 'messages', icon: 'send', title: 'Mesajlar', desc: 'iMessage yanıtlarını gönderme', mac: true },
  { key: 'microphone', icon: 'mic', title: 'Mikrofon', desc: 'Sesli mesaj kaydı' },
  { key: 'calendar', icon: 'calendar', title: 'Takvim', desc: 'Randevuları Takvim’e ekleme', mac: true, optional: true },
];

function loadStored(): Partial<Record<PermKey, Stored>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') as Record<string, string>;
    const out: Partial<Record<PermKey, Stored>> = {};
    for (const [k, v] of Object.entries(raw)) if (v === 'granted' || v === 'denied' || v === 'requested') out[k as PermKey] = v;
    return out;
  } catch {
    return {};
  }
}

type Tcc = 'granted' | 'denied' | 'unknown';
interface Live {
  notifications?: boolean | null;
  fullDisk?: boolean | null;
  tcc?: { microphone: Tcc; messages: Tcc; calendar: Tcc } | null;
  micQuery?: PermissionState | null;
}

async function readLive(): Promise<Live> {
  const live: Live = {};
  try {
    const n = await import('@tauri-apps/plugin-notification');
    live.notifications = await n.isPermissionGranted();
  } catch {
    live.notifications = 'Notification' in window ? Notification.permission === 'granted' : null;
  }
  const p = await api.permissions().catch(() => undefined);
  live.fullDisk = p?.fullDisk ?? null;
  live.tcc = p?.tcc ?? null;
  try {
    live.micQuery = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state ?? null;
  } catch {
    live.micQuery = null; // WebKit sorgulamayı desteklemeyebilir
  }
  return live;
}

/**
 * İzin durumları + isteme işlemleri (kurulum ekranı ve Ayarlar → İzinler ortak).
 * 29.09 (Kaan: "izin vermeme rağmen vermemiş gibi görünüyor"): eskiden durum yalnız istek anındaki tahminden geliyordu (deneme
 * bildirimi → "İstendi", getUserMedia hatası → "Reddedildi"). Artık her 2 sn'de ve pencere öne gelince GERÇEK kaynak okunur:
 * bildirim eklentisi, macOS izin kaydı (TCC.db; Tam Disk Erişimi varsa mikrofon/Mesajlar/Takvim), FDA denemesi; kayıtlı yanıt yalnız yedek.
 */
function usePermissions() {
  const rows = ROWS.filter((r) => !r.mac || isMac);
  const [stored, setStored] = useState<Partial<Record<PermKey, Stored>>>(loadStored);
  const [asking, setAsking] = useState<Partial<Record<PermKey, boolean>>>({});
  const [live, setLive] = useState<Live>({});
  const [busyAll, setBusyAll] = useState(false);
  const store = (k: PermKey, v: Stored) =>
    setStored((prev) => {
      const next = { ...prev, [k]: v };
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(next));
      } catch {
        /* depolama yok */
      }
      return next;
    });

  const refresh = async () => setLive(await readLive());
  useEffect(() => {
    let alive = true;
    const tick = () => void readLive().then((l) => alive && setLive(l));
    tick();
    const t = window.setInterval(tick, 2000);
    window.addEventListener('focus', tick);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener('focus', tick);
    };
  }, []);

  const state = (k: PermKey): PermState => {
    if (asking[k]) {
      // Sistem Ayarları'nda verilen izin gelince bekleme kendiliğinden biter
      if (k === 'fulldisk' && live.fullDisk) return 'granted';
      return 'asking';
    }
    const s = stored[k];
    if (k === 'notifications') {
      if (live.notifications === true) return 'granted';
      return s === 'denied' || s === 'requested' ? 'denied' : 'idle';
    }
    if (k === 'fulldisk') return live.fullDisk ? 'granted' : s === 'requested' || s === 'denied' ? 'denied' : 'idle';
    const t = live.tcc?.[k];
    if (t === 'granted') return 'granted';
    if (t === 'denied') return 'denied';
    if (k === 'microphone') {
      if (live.micQuery === 'granted') return 'granted';
      if (live.micQuery === 'denied') return 'denied';
    }
    return s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'idle';
  };

  const ask = async (k: PermKey): Promise<void> => {
    setAsking((a) => ({ ...a, [k]: true }));
    try {
      if (k === 'notifications') {
        let res: string = 'default';
        try {
          const n = await import('@tauri-apps/plugin-notification');
          res = (await n.isPermissionGranted()) ? 'granted' : await n.requestPermission();
        } catch {
          if ('Notification' in window) res = await Notification.requestPermission();
        }
        if (res === 'granted') {
          store(k, 'granted');
          await desktopNotify('Mivelo', 'Bildirimler açık. Yeni mesajlar burada görünecek.', true);
        } else store(k, res === 'denied' ? 'denied' : 'requested');
      } else if (k === 'microphone') {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          store(k, 'granted');
        } catch {
          store(k, 'denied');
        }
      } else if (k === 'fulldisk') {
        store(k, 'requested');
        await api.openPermissionPane('fulldisk');
        // kullanıcı Sistem Ayarları'nda anahtarı açana dek "Bekleniyor" (2 sn'lik denetim görür); 3 dk sonra bırak
        await new Promise<void>((resolve) => {
          const t0 = Date.now();
          const iv = window.setInterval(async () => {
            const p = await api.permissions().catch(() => undefined);
            if (p?.fullDisk || Date.now() - t0 > 180_000) {
              window.clearInterval(iv);
              resolve();
            }
          }, 1500);
        });
      } else if (k === 'messages') {
        const r = await api.messagesPermission();
        store(k, r.result === 'granted' ? 'granted' : 'denied');
      } else if (k === 'calendar') {
        const r = await api.calendars(true);
        store(k, r.denied ? 'denied' : 'granted');
      }
    } catch {
      if (k !== 'fulldisk') store(k, 'denied');
    } finally {
      setAsking((a) => ({ ...a, [k]: false }));
      void refresh();
    }
  };

  /** Reddedilmiş izin yalnız Sistem Ayarları'ndan açılır (macOS ikinci kez sormaz) */
  const openSettings = (k: PermKey) => {
    if (!isMac) return void ask(k);
    const pane = k === 'notifications' ? 'notifications' : k === 'microphone' ? 'microphone' : k === 'fulldisk' ? 'fulldisk' : 'automation';
    void api.openPermissionPane(pane).catch(() => undefined);
  };

  const askAll = async () => {
    setBusyAll(true);
    // Sistem Ayarları'nı açan adım en sonda: öncekilerin pencereleri ekrandayken ayarlar öne gelmesin
    for (const r of rows.filter((x) => x.key !== 'fulldisk' && !x.optional)) if (state(r.key) === 'idle') await ask(r.key);
    if (rows.some((r) => r.key === 'fulldisk') && state('fulldisk') === 'idle') await ask('fulldisk');
    setBusyAll(false);
  };
  const required = rows.filter((r) => !r.optional);
  const granted = required.filter((r) => state(r.key) === 'granted').length;
  const pending = required.filter((r) => state(r.key) === 'idle').length;
  return { rows, state, ask, askAll, openSettings, busyAll, granted, total: required.length, pending };
}

/** İzin satırları: simge, ad + kısa açıklama, sağda durum ya da tek eylem */
function PermRows({ p }: { p: ReturnType<typeof usePermissions> }) {
  const { rows, state, ask, openSettings, busyAll } = p;
  // yalnız sıradaki adım dolu düğme; ötekiler çerçeveli (dikkat tek yerde toplansın)
  const next = rows.find((r) => !r.optional && state(r.key) === 'idle')?.key ?? rows.find((r) => state(r.key) === 'idle')?.key;
  return (
    <div className="perm-list" role="list">
      {rows.map((r) => {
        const s = state(r.key);
        return (
          <div key={r.key} role="listitem" className={`perm-row is-${s}`}>
            <span className="perm-ic">
              <Icon name={r.icon} size={16} sw={2} />
            </span>
            <span className="perm-body">
              <b>
                {r.title}
                {r.optional && <em>İsteğe bağlı</em>}
              </b>
              <span>
                {s === 'asking' && r.key === 'fulldisk'
                  ? 'Sistem Ayarları’nda Mivelo’yu açıp buraya dön'
                  : s === 'denied'
                    ? 'Kapalı · Sistem Ayarları’ndan açılabilir'
                    : r.desc}
              </span>
            </span>
            <span className="perm-act">
              {s === 'granted' ? (
                <span className="perm-on">
                  <Icon name="check" size={13} sw={2.6} /> Açık
                </span>
              ) : s === 'asking' ? (
                <span className="perm-wait">
                  <span className="spin" /> Bekleniyor
                </span>
              ) : s === 'denied' ? (
                <button className="btn sm b perm-btn" type="button" onClick={() => openSettings(r.key)} disabled={busyAll}>
                  Ayarları aç
                </button>
              ) : (
                <button className={`btn sm b perm-btn ${r.key === next ? 'primary-soft' : ''}`} type="button" onClick={() => void ask(r.key)} disabled={busyAll}>
                  {r.key === 'fulldisk' ? 'Ayarları aç' : 'İzin ver'}
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Ayarlar → İzinler (masaüstü): kurulumdaki satırların aynısı; durumlar canlı */
export function PermissionSettings() {
  const p = usePermissions();
  return (
    <>
      <PermRows p={p} />
      <p className="set-note">Bir izni kapatmak için Sistem Ayarları → Gizlilik ve Güvenlik (Windows: Ayarlar → Gizlilik) bölümünü kullan.</p>
    </>
  );
}

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const p = usePermissions();
  const finish = () => {
    try {
      localStorage.setItem(SETUP_KEY, SETUP_VERSION);
    } catch {
      /* depolama yok */
    }
    onDone();
  };
  const allOn = p.granted === p.total;
  return (
    <div className="auth-screen setup-screen">
      <div className="setup2">
        <aside className="s2-side">
          <SplashMark size={44} animate />
          <div className="s2-eyebrow">Kurulum</div>
          <h1>Mivelo’yu {isMac ? 'Mac’ine' : 'bilgisayarına'} hazırla</h1>
          <p>Birkaç izinle mesajların anında gelir, bildirimler çalışır.</p>
          <ul className="s2-points">
            <li>
              <Icon name="shield" size={15} sw={2} /> Mesajların bu cihazdan çıkmaz
            </li>
            <li>
              <Icon name="sliders" size={15} sw={2} /> İzinleri istediğin an Ayarlar’dan değiştirebilirsin
            </li>
          </ul>
        </aside>
        <section className="s2-main">
          <header className="s2-head">
            <h2>İzinler</h2>
            <span className="s2-count">
              {p.granted} / {p.total} açık
            </span>
          </header>
          <div className="s2-bar" aria-hidden="true">
            <i style={{ width: `${Math.round((p.granted / Math.max(1, p.total)) * 100)}%` }} />
          </div>
          <PermRows p={p} />
          <footer className="s2-foot">
            {p.pending > 1 ? (
              <button className="btn b s2-all" type="button" onClick={() => void p.askAll()} disabled={p.busyAll}>
                {p.busyAll ? 'İsteniyor…' : 'Tümüne izin ver'}
              </button>
            ) : (
              <span />
            )}
            <button className="btn primary b s2-go" type="button" onClick={finish} disabled={p.busyAll}>
              {allOn ? 'Devam et' : 'Şimdilik geç'}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}

/** Ekranda açık açılış animasyonu sayısı ve kipi (App'in bekleme logosu bunu devralır) */
export const splashLive: { n: number; mode: 'full' | 'quick' } = { n: 0, mode: 'quick' };

/** Animasyonlu Mivelo işareti (kare büyür, kıvrım çizilir, lime nokta belirir) */
export function SplashMark({ size = 96, animate = true }: { size?: number; animate?: boolean }) {
  return (
    <svg className={`sp-mark ${animate ? 'anim' : ''}`} width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect className="sp-sq" width="28" height="28" rx="9" fill="#6C47FF" />
      <path className="sp-path" pathLength={1} d="M8 8c4.5 0 6 3 6 6s1.5 6 6 6M8 20c4.5 0 6-3 6-6" stroke="#FFFFFF" strokeWidth="2.3" fill="none" strokeLinecap="round" />
      <circle className="sp-dot" cx="20" cy="8" r="2.5" fill="#D4FF3F" />
    </svg>
  );
}

/**
 * Açılış animasyonu: ortada logo (kare → kıvrım → nokta), altında "mivelo"; sonra katman yumuşakça büyüyüp saydamlaşırken
 * alttaki uygulama görünür. full: lisans etkinleşince / kurulumdan sonra (≈3,8 sn); quick: sonraki açılışlarda (≈1,8 sn). Alt yazı yok (Kaan).
 * ready=false iken (lisans durumu daha gelmedi) en kısa süre dolsa da kapanmaz.
 */
export function Splash({ mode, ready = true, formed = false, slowOut = false, onDone }: { mode: 'full' | 'quick'; ready?: boolean; formed?: boolean; slowOut?: boolean; onDone: () => void }) {
  // açık açılış animasyonları (App kendi bekleme logosunu bunun üstüne çizmesin, devralsın)
  useEffect(() => {
    splashLive.n++;
    splashLive.mode = mode;
    return () => void splashLive.n--;
  }, [mode]);
  const [minDone, setMinDone] = useState(false);
  const [out, setOut] = useState(false);
  // iki kare bekle: uygulama altta ilk çizimini bitirsin, animasyon akan karelerle başlasın
  const [go, setGo] = useState(false);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setGo(true))));
    return () => (cancelAnimationFrame(r1), cancelAnimationFrame(r2));
  }, []);
  const done = useRef(onDone);
  done.current = onDone;
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    // 29.09 (Kaan): önce 2,8 sn kısa, 5,5 sn uzun geldi → full ≈3,8 sn, quick ≈1,8 sn
    const hold = formed ? 0 : reduce ? (mode === 'full' ? 1000 : 350) : mode === 'full' ? 3100 : 1400;
    const t = window.setTimeout(() => setMinDone(true), hold);
    return () => window.clearTimeout(t);
  }, [mode, reduce]);
  useEffect(() => {
    if (!minDone || !ready) return;
    setOut(true);
    const t = window.setTimeout(() => done.current(), reduce ? 250 : mode === 'full' || slowOut ? 700 : 420);
    return () => window.clearTimeout(t);
  }, [minDone, ready, mode, reduce, slowOut]);
  return (
    <div className={`splash ${mode} ${go ? 'go' : ''} ${out ? 'out' : ''} ${formed ? 'formed' : ''} ${slowOut ? 'slow-out' : ''}`} role="presentation" data-testid="splash">
      <div className="sp-stage">
        <span className="sp-ring" />
        <SplashMark size={mode === 'full' ? 104 : 84} animate={!formed} />
      </div>
      <div className="sp-word">mivelo</div>
    </div>
  );
}
