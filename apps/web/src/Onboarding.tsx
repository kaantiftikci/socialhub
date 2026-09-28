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
type PermState = 'idle' | 'asking' | 'granted' | 'denied' | 'requested';

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
  { key: 'notifications', icon: 'bell', title: 'Bildirimler', desc: 'Yeni mesaj gelince sistem bildirimi ve ses. Çıkan pencerede "İzin Ver"e bas.' },
  { key: 'microphone', icon: 'mic', title: 'Mikrofon', desc: 'Sohbetlerden sesli mesaj kaydedip göndermek için.' },
  { key: 'fulldisk', icon: 'lock', title: 'Tam Disk Erişimi', desc: "iMessage mesajlarını ve rehberindeki adları okumak için. Sistem Ayarları'nda listeden Mivelo'yu aç.", mac: true },
  { key: 'messages', icon: 'send', title: 'Mesajlar ile gönderme', desc: "iMessage yanıtlarını Mac'teki Mesajlar uygulaması üzerinden göndermek için.", mac: true },
  { key: 'calendar', icon: 'calendar', title: 'Takvim', desc: "Mesajdaki randevuyu Mac'in Takvim uygulamasına eklemek için.", mac: true, optional: true },
];

function loadStates(): Partial<Record<PermKey, PermState>> {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') as Partial<Record<PermKey, PermState>>;
  } catch {
    return {};
  }
}

/** İzin satırlarının durumu + isteme işlemleri (kurulum ekranı ve Ayarlar → İzinler ortak) */
function usePermissions() {
  const rows = ROWS.filter((r) => !r.mac || isMac);
  const [st, setSt] = useState<Partial<Record<PermKey, PermState>>>(loadStates);
  const [busyAll, setBusyAll] = useState(false);
  const stRef = useRef(st);
  stRef.current = st;
  const set = (k: PermKey, v: PermState) =>
    setSt((prev) => {
      const next = { ...prev, [k]: v };
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(next));
      } catch {
        /* depolama yok */
      }
      return next;
    });

  // Tam Disk Erişimi Sistem Ayarları'nda verilir: açılışta ve bölme açıkken 1,5 sn'de bir denetlenir (macOS "Çık ve Yeniden Aç"
  // derse uygulama yeniden açılınca kurulum kaldığı yerden sürer)
  useEffect(() => {
    if (!isMac) return;
    let alive = true;
    const check = () =>
      api
        .permissions()
        .then((p) => {
          if (!alive) return;
          if (p.fullDisk === true && stRef.current.fulldisk !== 'granted') set('fulldisk', 'granted');
          // Ayarlar'dan sonradan kaldırıldıysa
          else if (p.fullDisk === false && stRef.current.fulldisk === 'granted') set('fulldisk', 'idle');
        })
        .catch(() => undefined);
    check();
    const t = window.setInterval(() => {
      if (stRef.current.fulldisk !== 'granted') check();
    }, 1500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const ask = async (k: PermKey): Promise<void> => {
    set(k, 'asking');
    try {
      if (k === 'notifications') {
        // macOS izni ilk bildirimde sorar: karşılama bildirimi o pencereyi şimdi çıkarır
        await desktopNotify('Mivelo', 'Bildirimler açık — yeni mesajlar burada görünecek', true);
        set(k, 'requested');
      } else if (k === 'microphone') {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        set(k, 'granted');
      } else if (k === 'fulldisk') {
        await api.openPermissionPane('fulldisk');
        const p = await api.permissions().catch(() => undefined);
        if (p?.fullDisk) set(k, 'granted');
      } else if (k === 'messages') {
        const r = await api.messagesPermission();
        set(k, r.result === 'granted' ? 'granted' : r.result === 'denied' ? 'denied' : 'requested');
      } else if (k === 'calendar') {
        const r = await api.calendars(true);
        set(k, r.denied ? 'denied' : 'granted');
      }
    } catch {
      set(k, k === 'fulldisk' ? 'asking' : 'denied');
    }
  };

  const askAll = async () => {
    setBusyAll(true);
    // Sistem Ayarları'nı açan adım en sonda: öncekilerin pencereleri ekrandayken ayarlar öne gelmesin
    for (const r of rows.filter((x) => x.key !== 'fulldisk')) if (stRef.current[r.key] !== 'granted') await ask(r.key);
    if (rows.some((r) => r.key === 'fulldisk') && stRef.current.fulldisk !== 'granted') await ask('fulldisk');
    setBusyAll(false);
  };
  // her satır yanıtlandıysa (verildi / istendi / reddedildi) "Hepsine izin ver" gizlenir, düğme "Mivelo'yu aç" olur
  const allDone = rows.every((r) => r.optional || (st[r.key] && st[r.key] !== 'idle' && st[r.key] !== 'asking'));
  return { rows, st, ask, askAll, busyAll, allDone };
}

/** İzin satırları (durum rozeti ya da "İzin ver" düğmesi; reddedilende Sistem Ayarları bağlantısı) */
function PermRows({ p, again }: { p: ReturnType<typeof usePermissions>; again?: boolean }) {
  const { rows, st, ask, busyAll } = p;
  const label = (k: PermKey): { text: string; cls: string } => {
    const s = st[k];
    if (s === 'granted') return { text: 'Verildi', cls: 'ok' };
    if (s === 'requested') return { text: 'İstendi', cls: 'ok' };
    if (s === 'denied') return { text: 'Reddedildi', cls: 'bad' };
    if (s === 'asking') return { text: k === 'fulldisk' ? 'Ayarlarda bekleniyor…' : 'Bekleniyor…', cls: 'wait' };
    return { text: '', cls: '' };
  };
  return (
    <div className="perm-list">
      {rows.map((r) => {
        const l = label(r.key);
        const done = st[r.key] === 'granted';
        // Ayarlar'da: verilmemiş (reddedilmiş / istenmiş) izin yeniden istenebilir
        const retry = again && !done && st[r.key] !== 'asking';
        return (
          <div key={r.key} className={`perm-row ${done ? 'done' : ''}`}>
            <span className="perm-ic">
              <Icon name={done ? 'check' : r.icon} size={17} sw={2.2} />
            </span>
            <span className="perm-body">
              <b>
                {r.title}
                {r.optional && <em> · isteğe bağlı</em>}
              </b>
              <span>{r.desc}</span>
              {r.key === 'fulldisk' && st.fulldisk === 'asking' && (
                <span className="perm-hint">
                  Listede Mivelo'nun anahtarını aç (listede yoksa + ile Uygulamalar'dan Mivelo'yu ekle). macOS "Çık ve Yeniden Aç" derse kabul et;
                  kurulum kaldığı yerden sürer.
                </span>
              )}
              {st[r.key] === 'denied' && r.key !== 'notifications' && isMac && (
                <span className="perm-hint">
                  Sonradan açmak için{' '}
                  <a
                    href="#ayarlar"
                    onClick={(e) => {
                      e.preventDefault();
                      void api.openPermissionPane(r.key === 'microphone' ? 'microphone' : r.key === 'fulldisk' ? 'fulldisk' : 'automation').catch(() => undefined);
                    }}
                  >
                    Sistem Ayarları'nı aç
                  </a>
                  .
                </span>
              )}
            </span>
            {l.text && !retry ? (
              <span className={`perm-st ${l.cls}`}>{l.text}</span>
            ) : (
              <span className="perm-act">
                {l.text && <span className={`perm-st ${l.cls}`}>{l.text}</span>}
                <button className="btn sm soft b" type="button" onClick={() => void ask(r.key)} disabled={busyAll}>
                  {r.key === 'fulldisk' ? 'Ayarları aç' : l.text ? 'Yeniden iste' : 'İzin ver'}
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Ayarlar → İzinler (masaüstü): kurulumdaki satırların aynısı, verilmeyenler yeniden istenebilir */
export function PermissionSettings() {
  const p = usePermissions();
  return (
    <>
      <PermRows p={p} again />
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
  return (
    <div className="auth-screen setup-screen">
      <div className="auth-card setup-card">
        <div className="setup-hero" aria-hidden="true">
          <SplashMark size={56} animate />
        </div>
        <h1>Mivelo'yu hazırlayalım</h1>
        <p>İzinleri şimdi bir kez ver; sonra seni rahatsız etmeyelim. İstemediğini atlayabilirsin, sonradan Ayarlar → İzinler'den açılır.</p>
        <PermRows p={p} />
        <div className="setup-actions">
          {!p.allDone && (
            <button className="btn soft b" type="button" onClick={() => void p.askAll()} disabled={p.busyAll}>
              {p.busyAll ? 'İzinler isteniyor…' : 'Hepsine izin ver'}
            </button>
          )}
          <button className="btn primary b" type="button" onClick={finish} disabled={p.busyAll}>
            {p.allDone ? 'Mivelo’yu aç' : 'Şimdilik atla ve aç'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
 * alttaki uygulama görünür. full: lisans etkinleşince / kurulumdan sonra (≈2,8 sn); quick: sonraki açılışlarda (≈1 sn).
 * ready=false iken (lisans durumu daha gelmedi) en kısa süre dolsa da kapanmaz.
 */
export function Splash({ mode, ready = true, onDone }: { mode: 'full' | 'quick'; ready?: boolean; onDone: () => void }) {
  const [minDone, setMinDone] = useState(false);
  const [out, setOut] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    const hold = reduce ? (mode === 'full' ? 900 : 250) : mode === 'full' ? 2150 : 620;
    const t = window.setTimeout(() => setMinDone(true), hold);
    return () => window.clearTimeout(t);
  }, [mode, reduce]);
  useEffect(() => {
    if (!minDone || !ready) return;
    setOut(true);
    const t = window.setTimeout(() => done.current(), reduce ? 250 : mode === 'full' ? 700 : 420);
    return () => window.clearTimeout(t);
  }, [minDone, ready, mode, reduce]);
  return (
    <div className={`splash ${mode} ${out ? 'out' : ''}`} role="presentation" data-testid="splash">
      <div className="sp-stage">
        <span className="sp-ring" />
        <SplashMark size={mode === 'full' ? 104 : 84} />
      </div>
      <div className="sp-word">mivelo</div>
      {mode === 'full' && <div className="sp-sub">Tüm mesajların hazırlanıyor</div>}
    </div>
  );
}
