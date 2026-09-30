import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type StorageKind, type StorageReport } from './api';
import { PLATFORMS, type Account } from './types';
import { Avatar, Chip, Icon, Logo } from './ui';
import { MOD_KEY, isTauri, openExternal } from './desktop';
import { getThemePref, setThemePref, type ThemePref } from './theme';
import { setPrefs, usePrefs, type Prefs } from './prefs';
import { STATIC_DEMO } from './profile';

/* Ayarlar penceresinin bölümleri (Settings.tsx kabuğu). Satırlar arama için başlıklarıyla SETTINGS_INDEX'te de listelenir. */

/** Aramada seçilen satır: o satır vurgulanır ve görünür alana kaydırılır */
export const HighlightCtx = createContext<string | null>(null);

/** Açma/kapama anahtarı (checkbox yerine; tüm ayarlarda aynı görünüm) */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`sw ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/** Ayar satırı: solda başlık + açıklama, sağda denetim */
export function Row({ title, hint, children, dim }: { title: string; hint?: ReactNode; children: ReactNode; dim?: boolean }) {
  const hl = useContext(HighlightCtx);
  const ref = useRef<HTMLDivElement>(null);
  const on = hl === title;
  useLayoutEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [on]);
  return (
    <div ref={ref} className={`set-row ${dim ? 'dim' : ''} ${on ? 'hl' : ''}`}>
      <span className="set-txt">
        <b>{title}</b>
        {hint && <em>{hint}</em>}
      </span>
      <span className="set-ctl">{children}</span>
    </div>
  );
}

export function GroupTitle({ children }: { children: ReactNode }) {
  return <h4 className="set-gt">{children}</h4>;
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <span className="set-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </span>
  );
}

const pref = <K extends keyof Prefs>(k: K) => (v: Prefs[K]) => setPrefs({ [k]: v } as Partial<Prefs>);

// ---------------- Hesaplar ----------------
const STATUS_TXT: Record<string, string> = { connected: 'Bağlı', connecting: 'Bağlanıyor…', pairing: 'Giriş bekleniyor', error: 'Sorun var', disconnected: 'Bağlı değil' };

export function AccountsPane({ accounts, handleOf, onConnect }: { accounts: Account[]; handleOf: (a: Account) => string; onConnect: (focus?: string) => void }) {
  const list = [...accounts].sort((a, b) => (PLATFORMS[a.platform]?.name ?? '').localeCompare(PLATFORMS[b.platform]?.name ?? '', 'tr'));
  return (
    <>
      <div className="set-group">
        {list.length === 0 && <p className="set-empty">Henüz bağlı uygulama yok.</p>}
        {list.map((a) => {
          const st = a.autoRetry ? 'connecting' : a.status;
          return (
            <div key={a.id} className="set-acc">
              <Chip platform={a.platform} size={34} />
              <span className="nm">
                <b>{PLATFORMS[a.platform]?.name ?? a.platform}</b>
                {(() => {
                  const h = handleOf(a) || a.label;
                  return h && h !== PLATFORMS[a.platform]?.name ? <em>{h}</em> : null;
                })()}
              </span>
              <span className={`set-st ${st}`}>
                <i />
                {a.attention ? 'İşlem bekliyor' : (STATUS_TXT[st] ?? st)}
              </span>
              <button type="button" className="btn ghost xs b b2" onClick={() => onConnect(a.id)}>
                Yönet
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn primary b set-wide" onClick={() => onConnect()}>
        <Icon name="plus" size={14} sw={2} /> Uygulama bağla
      </button>
      <p className="set-note">Her uygulama kendi hesabınla, bu bilgisayardan bağlanır. Bir hesabı kaldırmak ya da yeniden bağlamak için “Yönet”.</p>
    </>
  );
}

// ---------------- Genel ----------------
export function GeneralPane() {
  const p = usePrefs();
  return (
    <>
      <GroupTitle>Yazma alanı</GroupTitle>
      <div className="set-group">
        <Row title="Enter ile gönder" hint={p.enterSends ? 'Enter gönderir, Shift+Enter yeni satır' : `${MOD_KEY}+Enter gönderir, Enter yeni satır (uzun mesajlar için)`}>
          <Switch label="Enter ile gönder" on={p.enterSends} onChange={pref('enterSends')} />
        </Row>
        <Row title="Yazım denetimi" hint="Yanlış yazılan kelimelerin altı çizilir">
          <Switch label="Yazım denetimi" on={p.spellcheck} onChange={pref('spellcheck')} />
        </Row>
      </div>
      <GroupTitle>Gizlilik</GroupTitle>
      <div className="set-group">
        <Row title="Gizli okuma" hint="Sohbeti açtığında karşı tarafa “görüldü” gitmez; mesajlar yalnız Mivelo’da okundu sayılır. Yanıt yazınca uygulama yine okundu gösterebilir.">
          <Switch label="Gizli okuma" on={p.silentRead} onChange={pref('silentRead')} />
        </Row>
      </div>
      {isTauri && (
        <>
          <GroupTitle>Uygulama simgesi</GroupTitle>
          <div className="set-group">
            <Row title="Rozet sayısı" hint="Dock / görev çubuğundaki simgenin üstündeki sayı">
              <select value={p.badge} aria-label="Rozet sayısı" onChange={(e) => setPrefs({ badge: e.target.value as Prefs['badge'] })}>
                <option value="messages">Okunmamış mesajlar</option>
                <option value="chats">Okunmamış sohbetler</option>
                <option value="off">Gösterme</option>
              </select>
            </Row>
          </div>
        </>
      )}
    </>
  );
}

// ---------------- Görünüm ----------------
function ThemeCard({ kind, on, onPick }: { kind: ThemePref; on: boolean; onPick: () => void }) {
  const label = kind === 'light' ? 'Açık' : kind === 'dark' ? 'Koyu' : 'Sistem';
  return (
    <button type="button" className={`set-theme ${on ? 'on' : ''}`} onClick={onPick} aria-pressed={on}>
      <span className={`tp ${kind}`} aria-hidden="true">
        {(kind === 'system' ? ['light', 'dark'] : [kind]).map((k) => (
          <span key={k} className={`tp-win ${k}`}>
            <i className="side" />
            <i className="l1" />
            <i className="l2" />
            <i className="bub" />
          </span>
        ))}
      </span>
      <b>{label}</b>
    </button>
  );
}

export function LookPane() {
  const p = usePrefs();
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const pick = (t: ThemePref) => (setThemePref(t), setTheme(t));
  return (
    <>
      <GroupTitle>Tema</GroupTitle>
      <div className="set-group set-themes">
        {(['light', 'dark', 'system'] as ThemePref[]).map((t) => (
          <ThemeCard key={t} kind={t} on={theme === t} onPick={() => pick(t)} />
        ))}
      </div>
      <div className="set-group">
        <Row title="Yazı ve arayüz boyutu" hint="Tüm pencereyi büyütür ya da küçültür">
          <Seg label="Arayüz boyutu" value={p.zoom} onChange={pref('zoom')} options={[[90, 'Küçük'], [100, 'Normal'], [110, 'Büyük'], [120, 'En büyük']]} />
        </Row>
        <Row title="Hareketleri azalt" hint="Geçiş ve açılış animasyonları kısalır">
          <Switch label="Hareketleri azalt" on={p.reduceMotion} onChange={pref('reduceMotion')} />
        </Row>
      </div>
    </>
  );
}

// ---------------- Bildirim davranışı (Bildirimler bölümünün altı) ----------------
export function NotifyBehavior() {
  const p = usePrefs();
  return (
    <>
      <GroupTitle>Davranış</GroupTitle>
      <div className="set-group">
        <Row title="Mivelo öndeyken de bildir" hint="Kapalıyken uygulama açıkken kart çıkmaz, ses çalmaz">
          <Switch label="Mivelo öndeyken de bildir" on={p.notifyInFocus} onChange={pref('notifyInFocus')} />
        </Row>
        <Row title="Art arda gelenleri birleştir" hint="Aynı kişiden peş peşe gelen mesajlar tek bildirimde toplanır (“3 yeni mesaj”)">
          <select value={p.batchSec} aria-label="Bildirim biriktirme süresi" onChange={(e) => setPrefs({ batchSec: Number(e.target.value) as Prefs['batchSec'] })}>
            <option value={0}>Kapalı</option>
            <option value={10}>10 saniye</option>
            <option value={30}>30 saniye</option>
            <option value={60}>1 dakika</option>
          </select>
        </Row>
        <Row title="Okunmadıysa yeniden hatırlat" hint="Bildirimi gelen sohbet bu süre sonunda hâlâ okunmamışsa bir kez daha">
          <select value={p.repeatMin} aria-label="Yeniden hatırlatma" onChange={(e) => setPrefs({ repeatMin: Number(e.target.value) as Prefs['repeatMin'] })}>
            <option value={0}>Hiçbir zaman</option>
            <option value={5}>5 dakika</option>
            <option value={15}>15 dakika</option>
            <option value={30}>30 dakika</option>
            <option value={60}>1 saat</option>
          </select>
        </Row>
      </div>
    </>
  );
}

// ---------------- Kısayollar ----------------
const M = MOD_KEY === '⌘' ? '⌘' : 'Ctrl';
export const HOTKEYS: Array<[string, Array<[string, string[]]>]> = [
  [
    'Genel',
    [
      ['Her yerde ara', [M, 'K']],
      ['Hızlı gönder (her yerden)', [M, '⇧', 'K']],
      ['Ayarlar', [M, ',']],
      ['Tümü görünümü', [M, '1']],
      ['Etiket görünümleri', [M, '2…9']],
      ['Pencereyi / paneli kapat', ['Esc']],
    ],
  ],
  [
    'Sohbet listesi',
    [
      ['Sonraki sohbet', ['J']],
      ['Önceki sohbet', ['K']],
      ['Aşağı / yukarı', ['↓', '↑']],
    ],
  ],
  [
    'Yazma alanı',
    [
      ['Gönder', ['Enter']],
      ['Yeni satır', ['⇧', 'Enter']],
      ['AI taslağını kabul et', ['Tab']],
      ['Yanıtı / düzenlemeyi iptal et', ['Esc']],
    ],
  ],
  [
    'Medya ve takvim',
    [
      ['Önceki / sonraki medya', ['←', '→']],
      ['Takvimde önceki / sonraki ay', ['←', '→']],
      ['Takvimde bugüne dön', ['T']],
      ['Takvimde yeni etkinlik', ['N']],
    ],
  ],
];

export function KeysPane() {
  const [q, setQ] = useState('');
  const fold = (s: string) => s.toLocaleLowerCase('tr');
  const groups = HOTKEYS.map(([g, rows]) => [g, rows.filter(([l]) => !q || fold(l).includes(fold(q)))] as const).filter(([, r]) => r.length);
  const p = usePrefs();
  return (
    <>
      <label className="set-find">
        <Icon name="search" size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Kısayollarda ara…" aria-label="Kısayollarda ara" />
      </label>
      {groups.map(([g, rows]) => (
        <div key={g}>
          <GroupTitle>{g}</GroupTitle>
          <div className="set-group">
            {rows.map(([l, keys]) => (
              <div key={l} className="set-key">
                <span>{l}</span>
                <span className="kbds">
                  {(l === 'Gönder' && !p.enterSends ? [M, 'Enter'] : l === 'Yeni satır' && !p.enterSends ? ['Enter'] : keys).map((k, i) => (
                    <kbd key={i}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="set-empty">Eşleşen kısayol yok.</p>}
    </>
  );
}

// ---------------- Depolama ----------------
export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toLocaleString('tr-TR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
};

const PART_META: Array<[keyof StorageReport['parts'], string, string]> = [
  ['messages', 'Mesajlar', '#6c47ff'],
  ['images', 'Görseller', '#2fb3e8'],
  ['videos', 'Videolar', '#f2a93b'],
  ['audio', 'Sesler', '#ef5da8'],
  ['files', 'Dosyalar', '#35c28b'],
  ['mail', 'E-posta ekleri', '#8a8ff0'],
  ['sessions', 'Oturumlar', '#9d98ad'],
  ['models', 'Yerel AI modelleri', '#c9a2ff'],
  ['other', 'Diğer', '#cfcbd9'],
];

function Donut({ report }: { report: StorageReport }) {
  const R = 58;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const parts = PART_META.filter(([k]) => report.parts[k] > 0);
  return (
    <svg className="set-donut" viewBox="0 0 150 150" aria-hidden="true">
      <circle cx="75" cy="75" r={R} fill="none" stroke="var(--line2)" strokeWidth="16" />
      {parts.map(([k, , color]) => {
        const len = (report.parts[k] / Math.max(1, report.total)) * C;
        const el = <circle key={k} cx="75" cy="75" r={R} fill="none" stroke={color} strokeWidth="16" strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 75 75)" />;
        acc += len;
        return el;
      })}
    </svg>
  );
}

const KIND_LABEL: Array<[StorageKind, string]> = [
  ['images', 'Görseller'],
  ['videos', 'Videolar'],
  ['audio', 'Sesler'],
  ['files', 'Dosyalar'],
];

export function StoragePane({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const [rep, setRep] = useState<StorageReport | null>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState(30);
  const [kinds, setKinds] = useState<StorageKind[]>(['images', 'videos', 'audio', 'files']);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) =>
    api
      .storage(fresh)
      .then((r) => (setRep(r), setErr('')))
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => setConfirm(false), [days, kinds]);
  const clear = () => {
    if (!confirm) return setConfirm(true);
    setBusy(true);
    api
      .clearStorage(days, kinds)
      .then((r) => {
        notify(r.files ? `${r.files} dosya silindi${r.bytes ? ` · ${fmtBytes(r.bytes)} boşaldı` : ''}` : 'Silinecek dosya yok');
        return load(true);
      })
      .catch((e) => notify((e as Error).message, true))
      .finally(() => (setBusy(false), setConfirm(false)));
  };
  const temp = () =>
    api
      .clearTemp()
      .then((r) => (notify(r.bytes ? `${fmtBytes(r.bytes)} geçici dosya silindi` : 'Geçici dosya yok'), load(true)))
      .catch((e) => notify((e as Error).message, true));
  if (err) return <p className="set-empty">Depolama bilgisi alınamadı: {err}</p>;
  if (!rep) return <p className="set-empty">Hesaplanıyor…</p>;
  const legend = PART_META.filter(([k]) => rep.parts[k] > 0);
  const maxChat = Math.max(1, ...rep.chats.map((c) => c.bytes));
  return (
    <>
      <div className="set-group set-store">
        <div className="set-donut-wrap">
          <Donut report={rep} />
          <span className="tot">
            <b>{fmtBytes(rep.total)}</b>
            <em>bu bilgisayarda</em>
          </span>
        </div>
        <ul className="set-legend">
          {legend.map(([k, l, c]) => (
            <li key={k}>
              <span>
                <i style={{ background: c }} />
                {l}
              </span>
              <b>{fmtBytes(rep.parts[k])}</b>
            </li>
          ))}
        </ul>
      </div>
      <GroupTitle>İndirilen medyayı temizle</GroupTitle>
      <div className="set-group set-clear">
        <div className="set-clear-in">
          <span className="lbl">Şundan eski olanlar</span>
          <Seg label="Gün" value={days} onChange={setDays} options={[[0, 'Tümü'], [30, '30 gün'], [90, '90 gün'], [120, '120 gün']]} />
          <span className="set-checks">
            {KIND_LABEL.map(([k, l]) => (
              <label key={k}>
                <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds((ks) => (e.target.checked ? [...ks, k] : ks.filter((x) => x !== k)))} />
                {l}
              </label>
            ))}
          </span>
          <p className="warn">
            <Icon name="alert" size={13} /> Mesajların silinmez; yalnız bu bilgisayara indirilmiş kopyalar gider ve açtığında yeniden indirilir. E-posta ekleri ve tek kaynağı bu bilgisayar olan dosyalar korunur.
          </p>
          <button type="button" className={`btn ${confirm ? 'danger-solid' : 'ghost'} sm b`} disabled={busy || !kinds.length} onClick={clear}>
            {busy ? 'Siliniyor…' : confirm ? 'Emin misin? Temizle' : 'Temizle…'}
          </button>
        </div>
      </div>
      <div className="set-group">
        <Row title="Geçici dosyaları temizle" hint="Yarım kalmış güncelleme indirmeleri ve gönderim kopyaları. Mesajlar ve ayarlar etkilenmez.">
          <button type="button" className="btn ghost xs b b2" onClick={temp}>
            Temizle
          </button>
        </Row>
      </div>
      {rep.chats.length > 0 && (
        <>
          <GroupTitle>Sohbetlere göre</GroupTitle>
          <div className="set-group">
            {rep.chats.slice(0, 15).map((c) => (
              <div key={c.chatId} className="set-chatsz">
                <span className="avwrap">
                  <Avatar name={c.name} size={30} url={c.avatarUrl} />
                  <span className="qr-badge">
                    <Chip platform={c.platform as Account['platform']} size={15} />
                  </span>
                </span>
                <span className="nm">
                  <b>{c.name}</b>
                  <em>
                    {c.files ? `${c.files.toLocaleString('tr-TR')} dosya · ` : ''}
                    {c.messages.toLocaleString('tr-TR')} mesaj
                  </em>
                  <span className="bar">
                    <i style={{ width: `${Math.max(3, (c.bytes / maxChat) * 100)}%` }} />
                  </span>
                </span>
                <b className="sz">{fmtBytes(c.bytes)}</b>
              </div>
            ))}
          </div>
          <p className="set-note">Sohbet boyutları mesaj metinleri ve ek bilgisine göre yaklaşıktır.</p>
        </>
      )}
    </>
  );
}

// ---------------- Cihazlar ----------------
function osName(): string {
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  return 'Linux';
}
export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';

export function DevicesPane({ lan, onLan }: { lan: { enabled: boolean; urls: string[]; qr?: string } | null; onLan: (on: boolean) => void }) {
  const os = osName();
  return (
    <>
      <div className={`set-hero ${lan?.enabled ? 'on' : ''}`}>
        {lan?.enabled && lan.qr ? <img src={lan.qr} alt="Bağlantı QR kodu" /> : (
          <span className="ph" aria-hidden="true">
            <Icon name="phone" size={30} />
          </span>
        )}
        <div>
          <b>{lan?.enabled ? 'Telefonunun kamerasıyla QR’ı okut' : 'Mivelo’yu telefonunda da kullan'}</b>
          <p>{lan?.enabled ? 'Aynı Wi‑Fi’dayken telefonun tarayıcısında açılır. Bağlantı gizli bir anahtar içerir; yalnız kendi cihazlarına ver.' : 'Aynı Wi‑Fi’daki telefonundan, uygulama kurmadan tüm sohbetlerine ulaş. Mesajlar yine bu bilgisayardan gider.'}</p>
          {lan?.enabled && lan.urls.map((u) => <code key={u}>{u}</code>)}
          <button type="button" className={`btn ${lan?.enabled ? 'ghost' : 'primary'} sm b`} disabled={STATIC_DEMO} onClick={() => onLan(!lan?.enabled)}>
            {STATIC_DEMO ? 'Masaüstü uygulamasında' : lan?.enabled ? 'Telefondan erişimi kapat' : 'Telefondan erişimi aç'}
          </button>
        </div>
      </div>
      <GroupTitle>Bu cihaz</GroupTitle>
      <div className="set-group">
        <div className="set-acc">
          <span className="set-dev">
            <Icon name="monitor" size={18} />
          </span>
          <span className="nm">
            <b>{isTauri ? `Mivelo Masaüstü (${os})` : STATIC_DEMO ? `Mivelo Demo (${os})` : `Mivelo Web (${os})`}</b>
            <em>{isTauri ? 'Bilgisayar' : 'Tarayıcı'}{APP_VERSION ? ` · Sürüm ${APP_VERSION}` : ''}</em>
          </span>
          <span className="set-st connected">
            <i />
            Bu cihaz
          </span>
        </div>
        {lan?.enabled && (
          <div className="set-acc">
            <span className="set-dev">
              <Icon name="phone" size={18} />
            </span>
            <span className="nm">
              <b>Telefon (tarayıcı)</b>
              <em>Aynı Wi‑Fi’dan bağlantıyla</em>
            </span>
            <span className="set-st connected">
              <i />
              Açık
            </span>
          </div>
        )}
      </div>
      <p className="set-note">Mesajların ve oturumların yalnız bu bilgisayarda durur. Bilgisayar uyurken telefondan erişim de durur.</p>
    </>
  );
}

// ---------------- Yardım ----------------
const FAQ: Array<[string, string]> = [
  ['Mesajlarım nerede saklanıyor?', 'Yalnız bu bilgisayarda, şifreli bir veritabanında. Mivelo’nun sunucusu mesajlarını görmez; AI özelliklerini kullandığında yalnız o sohbetin son mesajları senin anahtarınla Anthropic’e gider.'],
  ['Hesabım kapatılır mı (ban)?', 'Mivelo her uygulamaya senin bilgisayarından ve IP adresinden, normal bir kullanıcı gibi bağlanır; yoklama aralıkları ve gönderim sınırları uygulamaların kurallarına göre ayarlıdır. Toplu mesaj ya da çok sayıda yabancıya ilk mesaj göndermekten kaçın.'],
  ['Bir uygulama bağlanmıyor ya da mesajlar gelmiyor', 'Ayarlar → Hesaplar’dan o uygulamada “Yönet”e bas ve yeniden bağlan. Kanal satırında kırmızı uyarı varsa üzerine gel; ne yapman gerektiği yazar. Slack’in ücretsiz planı 90 günden eski mesajları hiçbir uygulamaya vermez.'],
  ['Bildirim gelmiyor', 'Ayarlar → Bildirimler’de bildirimlerin açık olduğundan ve “Deneme bildirimi”nin çıktığından emin ol. Mac’te Sistem Ayarları → Bildirimler → Mivelo açık olmalı; uygulama başına ayar Uygulama sesleri’nde.'],
  ['Lisansımı başka bilgisayara nasıl taşırım?', 'Bu bilgisayarda Çıkış yap: cihaz hakkın boşalır. Sonra yeni bilgisayarda aynı anahtarla giriş yap. Mesajlar bilgisayara özel olduğu için uygulamaları orada yeniden bağlaman gerekir.'],
  ['Mivelo’yu nasıl güncellerim?', 'Yeni sürüm çıkınca sağ altta bir kart görünür; “Güncelle”ye basman yeterli. Mivelo kendini kapatıp yeni sürümle yeniden açar, sonra yenilikleri gösterir.'],
];

export function HelpPane({ onKeys }: { onKeys: () => void }) {
  return (
    <>
      <div className="set-group set-faq">
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>
              <Icon name="help" size={15} />
              <span>{q}</span>
              <Icon name="chev" size={14} sw={2} />
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <div className="set-help-acts">
        <button type="button" className="set-help-card b" onClick={() => window.dispatchEvent(new Event('mivelo-feedback'))}>
          <span className="t" style={{ background: '#ef5da8' }}>
            <Icon name="alert" size={16} />
          </span>
          <b>Sorun bildir</b>
          <em>Ekran görüntüsüyle birlikte bize yaz</em>
        </button>
        <button type="button" className="set-help-card b" onClick={() => window.dispatchEvent(new Event('mivelo-feedback'))}>
          <span className="t" style={{ background: '#35c28b' }}>
            <Icon name="sparkle" size={16} />
          </span>
          <b>Öneride bulun</b>
          <em>Eksik gördüğün bir özelliği söyle</em>
        </button>
        <button type="button" className="set-help-card b" onClick={onKeys}>
          <span className="t" style={{ background: '#f2a93b' }}>
            <Icon name="keyboard" size={16} />
          </span>
          <b>Kısayollar</b>
          <em>Klavyeyle daha hızlı</em>
        </button>
      </div>
    </>
  );
}

// ---------------- Hakkında ----------------
const cmpVer = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

export function AboutPane() {
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isTauri || !APP_VERSION) return;
    let off = false;
    fetch('https://mivelo.app/indir/files/latest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { version?: string } | null) => !off && setLatest(j?.version ?? null))
      .catch(() => !off && setLatest(null));
    return () => {
      off = true;
    };
  }, []);
  const status = useMemo(() => {
    if (!isTauri) return { ok: true, text: STATIC_DEMO ? 'Demo her zaman en yeni sürümü gösterir' : 'Web sürümü her açılışta günceldir' };
    if (latest === undefined) return { ok: true, text: 'Güncellemeler denetleniyor…' };
    if (!latest || !APP_VERSION) return { ok: true, text: 'Güncelleme bilgisi alınamadı' };
    return cmpVer(latest, APP_VERSION) > 0 ? { ok: false, text: `Yeni sürüm hazır: ${latest} — sağ alttaki kartla güncelleyebilirsin` } : { ok: true, text: 'En güncel sürümü kullanıyorsun' };
  }, [latest]);
  const links: Array<[string, string, () => void]> = [
    ['Yenilikler', 'sparkle', () => window.dispatchEvent(new Event('mivelo-whats-new'))],
    ['Sorun bildir', 'alert', () => window.dispatchEvent(new Event('mivelo-feedback'))],
    ['Gizlilik politikası', 'lock', () => void openExternal('https://mivelo.app/gizlilik.html')],
    ['Kullanım koşulları', 'file', () => void openExternal('https://mivelo.app/kosullar.html')],
    ['mivelo.app', 'external', () => void openExternal('https://mivelo.app')],
  ];
  return (
    <>
      <div className="set-about">
        <span className="lg">
          <Logo size={44} />
        </span>
        <div>
          <b>Mivelo</b>
          <em>{APP_VERSION ? `Sürüm ${APP_VERSION}` : isTauri ? 'Geliştirme sürümü' : STATIC_DEMO ? 'Demo' : 'Web'}</em>
        </div>
      </div>
      <div className={`set-upd ${status.ok ? 'ok' : 'new'}`}>
        <Icon name={status.ok ? 'check' : 'download'} size={14} sw={2.2} /> {status.text}
      </div>
      <div className="set-group">
        {links.map(([l, ic, fn]) => (
          <button key={l} type="button" className="set-linkrow b" onClick={fn}>
            <Icon name={ic} size={15} />
            <span>{l}</span>
            <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
              <Icon name="chev" size={13} sw={2} />
            </span>
          </button>
        ))}
      </div>
      <p className="set-note">Mivelo tüm mesajlaşma uygulamalarını tek yerde toplar; verilerin yalnız bu bilgisayarda durur. © 2026 Mivelo</p>
    </>
  );
}
