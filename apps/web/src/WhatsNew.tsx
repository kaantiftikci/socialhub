import { useEffect, useState } from 'react';
import { CHANGELOG, type ChangeEntry } from './changelog';
import { Icon, Logo } from './ui';

/**
 * "Yenilikler" penceresi: güncellemeden sonra (uygulama kapanıp yeniden açılınca) açılış animasyonu ve yükleme bittiğinde
 * bir kez çıkar; kullanıcının son gördüğü kayıttan sonra eklenenleri listeler (changelog.ts).
 * - Son görülen: localStorage `mivelo.seenChangelog` (en üstteki kaydın id'si).
 * - İlk kurulum (hiç kullanılmamış tarayıcı/cihaz) gösterilmez, yalnız işaretlenir; daha önce kullanılmış ama kayıt tutulmamışsa
 *   (bu özellikten önceki sürüm) yalnız en yeni kayıt gösterilir.
 * - Elle açmak: window'a `mivelo-whats-new` olayı.
 */
const SEEN_KEY = 'mivelo.seenChangelog';
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* depolama kapalı */
    }
  },
};

function usedBefore(): boolean {
  try {
    if (localStorage.getItem('mivelo.setup') === '1') return true;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      if (/^(kavsak\.|mivelo\.(nav|theme|aiPrefs|promisesDone|profile))/.test(k)) return true;
    }
  } catch {
    /* yok */
  }
  return false;
}

/** Gösterilecek kayıtlar (boş = gösterme) */
export function pendingEntries(): ChangeEntry[] {
  const top = CHANGELOG[0];
  if (!top) return [];
  const seen = ls.get(SEEN_KEY);
  if (seen === top.id) return [];
  if (!seen) {
    if (!usedBefore()) {
      ls.set(SEEN_KEY, top.id);
      return [];
    }
    return [top];
  }
  const i = CHANGELOG.findIndex((e) => e.id === seen);
  return i < 0 ? [top] : CHANGELOG.slice(0, i);
}

const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

export function WhatsNew({ ready }: { ready: boolean }) {
  const [entries, setEntries] = useState<ChangeEntry[] | null>(null);
  const [closing, setClosing] = useState(false);
  const [older, setOlder] = useState(false);

  // açılış animasyonu (.splash) ve yükleme bitince, kısa bir nefesten sonra
  useEffect(() => {
    if (!ready) return;
    const list = pendingEntries();
    if (!list.length) return;
    let t = 0;
    const tick = () => {
      if (document.querySelector('.splash, .auth-screen, .setup2')) {
        t = window.setTimeout(tick, 400);
        return;
      }
      t = window.setTimeout(() => setEntries(list), 700);
    };
    tick();
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    const open = () => (setClosing(false), setOlder(false), setEntries(CHANGELOG.slice(0, 1)));
    window.addEventListener('mivelo-whats-new', open);
    return () => window.removeEventListener('mivelo-whats-new', open);
  }, []);

  useEffect(() => {
    if (!entries) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  if (!entries || !entries.length) return null;
  const [cur, ...rest] = entries;
  const past = older ? CHANGELOG.filter((e) => !entries.includes(e)) : [];
  function close() {
    if (CHANGELOG[0]) ls.set(SEEN_KEY, CHANGELOG[0].id);
    setClosing(true);
    window.setTimeout(() => setEntries(null), 260);
  }
  let n = 0;
  const Items = ({ e }: { e: ChangeEntry }) => (
    <ul className="wn-list">
      {e.items.map((it) => (
        <li key={it.title} style={{ animationDelay: `${180 + n++ * 70}ms` }}>
          <span className="wn-ic">
            <Icon name={it.icon} size={17} />
          </span>
          <span className="wn-t">
            <b>{it.title}</b>
            <span>{it.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className={`wn-back ${closing ? 'closing' : ''}`} onClick={close} role="presentation">
      <div className="wn" role="dialog" aria-modal="true" aria-label="Yenilikler" onClick={(e) => e.stopPropagation()}>
        <div className="wn-hero">
          <span className="wn-glow" aria-hidden="true" />
          <span className="wn-logo">
            <Logo size={34} />
          </span>
          <span className="wn-kicker">Yenilikler</span>
          <h2>{cur.title}</h2>
          <span className="wn-date">{fmtDate(cur.date)}</span>
          <button className="wn-x b" aria-label="Kapat" onClick={close}>
            <Icon name="x" size={14} sw={2} />
          </button>
        </div>
        <div className="wn-body">
          <Items e={cur} />
          {[...rest, ...past].map((e) => (
            <section key={e.id} className="wn-older">
              <h3>
                {e.title} <em>{fmtDate(e.date)}</em>
              </h3>
              <Items e={e} />
            </section>
          ))}
        </div>
        <div className="wn-foot">
          {!older && CHANGELOG.length > entries.length ? (
            <button className="btn ghost sm b" onClick={() => setOlder(true)}>
              Önceki yenilikler
            </button>
          ) : (
            <span />
          )}
          <button className="btn primary b" onClick={close}>
            Harika, devam et
          </button>
        </div>
      </div>
    </div>
  );
}
