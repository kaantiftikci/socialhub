import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { PLATFORMS, type Account } from './types';
import { Avatar, Chip, Icon, PasswordInput } from './ui';
import { SOUNDS, getPlatformSound, getPlatformTone, getPlatformVolume, getVolume, groupsNotify, bannersEnabled, soundsEnabled, playNotifySound, playPing, setBannersEnabled, setGroupsNotify, setPlatformSound, setPlatformTone, setPlatformVolume, setSoundsEnabled, setVolume, webNotifyPermission, requestWebNotify, testNotify } from './desktop';
import { MarketDigestSettings } from './MarketSummary';
import { setAiPrefs, useAiPrefs } from './ai-prefs';
import { DEMO_OFFLINE, PROFILE_NAME, STATIC_DEMO, applyProfile } from './profile';
import { wipeUserLocalData } from './demo-isolation';
import { leaveDemoPanel } from './demo-session';
import { isTauri } from './desktop';
import { signOut } from './LicenseGate';
import { PermissionSettings } from './Onboarding';
import { LocalAiPane } from './LocalAiPane';
import type { LicenseStatus, Profile } from './api';

type Tab = 'profile' | 'notify' | 'apps' | 'ai' | 'localai' | 'phone' | 'perms' | 'account' | 'logout' | 'reset';
type Lan = { enabled: boolean; urls: string[]; qr?: string } | null;

/** Açma/kapama anahtarı (checkbox yerine; tüm ayarlarda aynı görünüm) */
function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`sw ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/** Ayar satırı: solda başlık + açıklama, sağda denetim */
function Row({ title, hint, children, dim }: { title: string; hint?: ReactNode; children: ReactNode; dim?: boolean }) {
  return (
    <div className={`set-row ${dim ? 'dim' : ''}`}>
      <span className="set-txt">
        <b>{title}</b>
        {hint && <em>{hint}</em>}
      </span>
      <span className="set-ctl">{children}</span>
    </div>
  );
}

/**
 * Ayarlar penceresi: sol menüde bölümler (Bildirimler · Uygulamalar · AI · Telefondan erişim),
 * sağda o bölümün satırları. Görünüm (gece/gündüz) burada değil, kenar çubuğundaki düğmede.
 */
export function SettingsModal({ closing, onClose, accounts, handleOf, ai, setAi, notify, lan, setLan, initialTab = 'notify' }: {
  closing: boolean;
  onClose: () => void;
  accounts: Account[];
  handleOf: (a: Account) => string;
  ai: boolean;
  setAi: (on: boolean) => void;
  notify: (t: string, err?: boolean) => void;
  lan: Lan;
  setLan: (l: Lan) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const aiPrefs = useAiPrefs();
  const [sndOn, setSndOn] = useState(soundsEnabled);
  const [bnrOn, setBnrOn] = useState(bannersEnabled);
  const [grpOn, setGrpOn] = useState(groupsNotify);
  const [vol, setVol] = useState(getVolume);
  const [pSounds, setPSounds] = useState<Record<string, string>>({});
  const [pVols, setPVols] = useState<Record<string, number>>({});
  const [pTones, setPTones] = useState<Record<string, string>>({});
  const [perm, setPerm] = useState(webNotifyPermission);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);

  const changeTone = (platform: string, id: string) => {
    setPlatformTone(platform, id);
    setPTones((p) => ({ ...p, [platform]: id }));
    if ((pSounds[platform] ?? getPlatformSound(platform)) !== 'off') {
      setPlatformSound(platform, id);
      setPSounds((p) => ({ ...p, [platform]: id }));
    }
    playPing(id, true);
  };
  const changeNotify = (platform: string, on: boolean) => {
    const tone = getPlatformTone(platform);
    const id = on ? tone : 'off';
    setPlatformSound(platform, id);
    setPSounds((p) => ({ ...p, [platform]: id }));
    if (on) playPing(tone, true);
  };

  // aynı platformdan birden çok hesap olabilir; ses ayarları platform başına → tek satır
  const platforms = [...new Map(accounts.map((a) => [a.platform, a])).values()];
  const TABS: Array<[Tab, string, string]> = [
    ...(!DEMO_OFFLINE ? ([['profile', 'Profil', 'user']] as Array<[Tab, string, string]>) : []),
    ['notify', 'Bildirimler', 'bell'],
    ['apps', 'Uygulama sesleri', 'volume'],
    ['ai', 'AI özellikleri', 'sparkle'],
    ['localai', 'Yerel AI modelleri', 'cpu'],
    ['phone', 'Telefondan erişim', 'link'],
    // masaüstü: ilk kurulumdaki izinler (verilmeyenler buradan yeniden istenir)
    ...(isTauri ? ([['perms', 'İzinler', 'shield']] as Array<[Tab, string, string]>) : []),
    // yerel / masaüstü: profil + lisans (web demoda hesap = demo oturumu, çıkış doğrudan menüde)
    ...(!STATIC_DEMO ? ([['account', 'Hesap ve veriler', 'shield']] as Array<[Tab, string, string]>) : []),
  ];
  const heading = tab === 'logout' ? 'Çıkış yap' : tab === 'reset' ? 'Tüm verileri sil' : TABS.find(([k]) => k === tab)?.[1];

  return (
    <div className={`overlay set-ov ${closing ? 'closing' : ''}`} onClick={onClose}>
      <div className="modal set-modal" role="dialog" aria-label="Ayarlar" onClick={(e) => e.stopPropagation()}>
        <aside className="set-nav" role="tablist" aria-label="Ayar bölümleri">
          <h2>Ayarlar</h2>
          {TABS.map(([k, l, ic]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`set-tab b ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              <Icon name={ic} size={16} />
              <span>{l}</span>
            </button>
          ))}
          {/* web demo: çıkış doğrudan menüde, basınca hemen çıkar. Yerel / masaüstü: önce ne olacağını anlatan onay */}
          {!DEMO_OFFLINE && (
            <button type="button" className={`set-tab set-logout b ${tab === 'logout' ? 'on' : ''}`} onClick={() => (STATIC_DEMO ? leaveDemoPanel() : setTab('logout'))}>
              <Icon name="logout" size={16} />
              <span>Çıkış yap</span>
            </button>
          )}
        </aside>
        <section className="set-body">
          <header className="set-head">
            <h3>{heading}</h3>
            <button className="btn icon b b2" onClick={onClose} aria-label="Kapat">
              <Icon name="x" size={15} sw={2} />
            </button>
          </header>

          {tab === 'notify' && (
            <div className="set-group">
              <Row title="Bildirim sesleri" hint="Yeni mesaj gelince ses çal">
                <Switch label="Bildirim sesleri" on={sndOn} onChange={(v) => (setSoundsEnabled(v), setSndOn(v), v && playPing(undefined, true, vol / 100))} />
              </Row>
              <Row title="Ses düzeyi" hint="Tüm uygulamalar için ana düzey" dim={!sndOn}>
                <span className="vol">
                  <Icon name={vol === 0 ? 'mute' : 'volume'} size={14} />
                  <input type="range" min={0} max={100} step={5} value={vol} disabled={!sndOn} aria-label="Genel ses düzeyi" onChange={(e) => (setVolume(+e.target.value), setVol(+e.target.value))} onPointerUp={() => playPing(undefined, true, vol / 100)} onKeyUp={() => playPing(undefined, true, vol / 100)} />
                  <em>{vol}</em>
                </span>
              </Row>
              <Row title="Masaüstü bildirimleri" hint="Mivelo arka plandayken sistem bildirim kartı göster">
                <Switch label="Masaüstü bildirimleri" on={bnrOn} onChange={(v) => (setBannersEnabled(v), setBnrOn(v))} />
              </Row>
              {perm !== 'granted' && (
                <Row
                  title="Tarayıcı bildirim izni"
                  hint={
                    perm === 'denied'
                      ? 'Engellenmiş: adres çubuğundaki site ayarlarından (kilit/ⓘ simgesi) Bildirimler → İzin ver, sonra sayfayı yenile. Mac: Sistem Ayarları → Bildirimler → tarayıcın açık olsun.'
                      : perm === 'unsupported'
                        ? 'Bu tarayıcı bildirim desteklemiyor'
                        : 'Verilmedi — sağ üstte bildirim kartı çıkması için izin gerekli'
                  }
                >
                  {perm === 'default' && (
                    <button type="button" className="btn primary xs b b2" onClick={() => void requestWebNotify().then(setPerm)}>
                      İzin ver
                    </button>
                  )}
                </Row>
              )}
              <Row title="Deneme bildirimi" hint="Sağ üstte kart çıkıyorsa bildirimler çalışıyor">
                <button type="button" className="btn ghost xs b b2" disabled={perm !== 'granted'} onClick={() => void testNotify().then((ok) => !ok && notify('Bildirim gösterilemedi: izin yok', true))}>
                  Gönder
                </button>
              </Row>
              <Row title="Grup ve kanal bildirimleri" hint="Kapalıyken yalnız birebir sohbetler bildirir">
                <Switch label="Grup ve kanal bildirimleri" on={grpOn} onChange={(v) => (setGroupsNotify(v), setGrpOn(v))} />
              </Row>
              {/* pazaryeri gün sonu özeti (MarketSummary.tsx): yalnız pazaryeri hesabı bağlıysa */}
              {accounts.some((a) => PLATFORMS[a.platform]?.category === 'shop') && <MarketDigestSettings notify={notify} />}
              <button type="button" className="set-link b" onClick={() => setTab('apps')}>
                Uygulama başına zil sesi ve ses düzeyi
                <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
                  <Icon name="chev" size={14} sw={2} />
                </span>
              </button>
            </div>
          )}

          {tab === 'apps' &&
            (platforms.length === 0 ? (
              <p className="set-empty">Bağlı uygulama yok.</p>
            ) : (
              <>
                {!sndOn && <p className="set-note">Bildirim sesleri kapalı; buradaki ayarlar sesler açılınca geçerli olur.</p>}
                <div className="set-group">
                  {platforms.map((a) => {
                    const on = (pSounds[a.platform] ?? getPlatformSound(a.platform)) !== 'off';
                    const tone = pTones[a.platform] ?? getPlatformTone(a.platform);
                    const pv = pVols[a.platform] ?? getPlatformVolume(a.platform);
                    const handle = handleOf(a);
                    return (
                      <div key={a.platform} className={`set-app ${on ? '' : 'off'}`}>
                        <div className="who">
                          <Chip platform={a.platform} size={32} />
                          <span className="nm">
                            <b>{PLATFORMS[a.platform].name}</b>
                            {handle && <em>{handle}</em>}
                          </span>
                          <Switch label={`${PLATFORMS[a.platform].name} bildirimleri`} on={on} onChange={(v) => changeNotify(a.platform, v)} />
                        </div>
                        {on && (
                          <div className="ctl">
                            <select value={tone} aria-label={`${PLATFORMS[a.platform].name} zil sesi`} onChange={(e) => changeTone(a.platform, e.target.value)}>
                              {SOUNDS.map((sn) => (
                                <option key={sn.id} value={sn.id}>
                                  {sn.name}
                                </option>
                              ))}
                            </select>
                            <span className="vol">
                              <Icon name={pv === 0 ? 'mute' : 'volume'} size={14} />
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={5}
                                value={pv}
                                disabled={!sndOn}
                                aria-label={`${PLATFORMS[a.platform].name} ses düzeyi`}
                                onChange={(e) => (setPlatformVolume(a.platform, +e.target.value), setPVols((p) => ({ ...p, [a.platform]: +e.target.value })))}
                                onPointerUp={() => playNotifySound(a.platform)}
                                onKeyUp={() => playNotifySound(a.platform)}
                              />
                              <em>{pv}</em>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="set-note">Ses düzeyi, genel düzeyin yüzdesidir. Kapalı uygulama ne ses çalar ne bildirim kartı gösterir.</p>
              </>
            ))}

          {tab === 'ai' && (
            <>
              <div className="set-group">
                <AiKeyRow ai={ai} onChange={setAi} notify={notify} />
              </div>
              <div className={`set-group ${ai ? '' : 'dim'}`}>
                {(
                  [
                    ['summary', 'Özetler', 'Sağ panelde "Özetle" ile uzun sohbetin kısa özeti'],
                    ['drafts', 'Taslaklar', 'Senin yazma tarzında yanıt taslağı önerir'],
                    ['actions', 'Aksiyon çıkarma', 'Mesajlardaki söz, tarih ve görevleri bulur; takvime eklemeyi önerir'],
                    ['focusAuto', "Odak'ta taslakları kendiliğinden hazırla", 'Odak açılınca ilk 3 sohbet için taslak hazırlanır'],
                  ] as const
                ).map(([k, l, h]) => (
                  <Row key={k} title={l} hint={h}>
                    <Switch label={l} on={aiPrefs[k]} onChange={(v) => setAiPrefs({ [k]: v })} />
                  </Row>
                ))}
              </div>
              <p className="set-note">Sohbet içeriği yalnız sen bir AI özelliğini kullandığında, o sohbetin son mesajlarıyla Anthropic'e gider.{!ai && ' Özellikleri kullanmak için önce anahtar ekle.'}</p>
            </>
          )}

          {tab === 'localai' && <LocalAiPane notify={notify} />}

          {tab === 'perms' && <PermissionSettings />}

          {tab === 'profile' && <ProfilePane notify={notify} />}

          {(tab === 'account' || tab === 'logout' || tab === 'reset') && (
            <AccountPane mode={tab === 'logout' ? 'logout' : tab === 'reset' ? 'reset' : 'view'} onReset={() => setTab('reset')} onCancel={() => setTab('account')} notify={notify} />
          )}

          {tab === 'phone' && (
            <>
              <div className="set-group">
                <Row title="Aynı Wi‑Fi'daki telefondan aç" hint={STATIC_DEMO ? 'Masaüstü uygulamasında kullanılabilir' : 'Telefonun tarayıcısından Mivelo’yu kullan'}>
                  <Switch label="Telefondan erişim" disabled={STATIC_DEMO} on={!!lan?.enabled} onChange={(v) => api.setLan(v).then(setLan).catch((err) => notify((err as Error).message, true))} />
                </Row>
              </div>
              {lan?.enabled && (
                <div className="set-lan">
                  {lan.qr && <img src={lan.qr} alt="Bağlantı QR kodu" />}
                  <div>
                    <b>Telefonun kamerasıyla QR'ı okut</b>
                    {lan.urls.map((u) => (
                      <code key={u}>{u}</code>
                    ))}
                    <em>Bağlantı gizli bir anahtar içerir; yalnızca kendi cihazlarına ver. Bilgisayar uyurken erişim durur.</em>
                  </div>
                </div>
              )}
            </>
          )}

        </section>
      </div>
    </div>
  );
}

function AiKeyRow({ ai, onChange, notify }: { ai: boolean; onChange: (on: boolean) => void; notify: (t: string, err?: boolean) => void }) {
  const [info, setInfo] = useState<{ set: boolean; source: 'settings' | 'env' | null; hint: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.aiKey().then(setInfo).catch(() => setInfo(null));
  }, [ai]);
  const save = (key: string | null) => {
    setBusy(true);
    api
      .setAiKey(key)
      .then((r) => {
        onChange(r.ai);
        setEditing(false);
        setVal('');
        notify(key ? 'AI anahtarı kaydedildi' : 'AI anahtarı kaldırıldı');
        return api.aiKey().then(setInfo);
      })
      .catch((e) => notify((e as Error).message, true))
      .finally(() => setBusy(false));
  };
  if (editing)
    return (
      <form className="ai-key-form" onSubmit={(e) => (e.preventDefault(), val.trim() && save(val.trim()))}>
        <b>Anthropic anahtarı</b>
        <PasswordInput autoFocus placeholder="sk-ant-…" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Anthropic API anahtarı" autoComplete="off" spellCheck={false} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="submit" className="btn primary xs b b2" disabled={busy || !val.trim()}>
            Kaydet
          </button>
          <button type="button" className="btn ghost xs b b2" onClick={() => (setEditing(false), setVal(''))}>
            Vazgeç
          </button>
        </div>
        <span className="ai-key-note">Anahtar bu bilgisayarda güvenli depoda saklanır ve hiçbir zaman geri gösterilmez.</span>
      </form>
    );
  return (
    <Row title="Anthropic anahtarı" hint={info?.set ? (info.source === 'env' ? 'Ortam değişkeninden okunuyor' : `Kayıtlı · ${info.hint ?? ''}`) : 'AI özellikleri için gerekli (isteğe bağlı)'}>
      {info?.source === 'settings' ? (
        <button type="button" className="btn ghost xs b b2" onClick={() => save(null)} disabled={busy}>
          Kaldır
        </button>
      ) : (
        <button type="button" className="btn soft xs b b2" onClick={() => setEditing(true)}>
          {info?.set ? 'Değiştir' : 'Ekle'}
        </button>
      )}
    </Row>
  );
}

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';

/** Kalan gün: "12 gün kaldı · 10 Ekim 2026" */
function licenseLeft(exp?: string | null): string {
  if (!exp) return 'Süresiz';
  const t = Date.parse(exp);
  if (!Number.isFinite(t)) return '';
  const days = Math.max(0, Math.ceil((t - Date.now()) / 86_400_000));
  return `${days} gün kaldı · ${new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

/**
 * Ayarlar → Hesap (yerel / masaüstü): profil adı (lisans sahibi ya da bilgisayardaki ad), lisans anahtarı (maskeli) ve süresi,
 * sürüm, "Tüm verileri sil". Çıkış yalnız menünün altındaki "Çıkış yap"tan (Kaan, 29.09: bu bölümdeki satır kaldırıldı);
 * mode 'logout': çıkışın ne yapacağını anlatan onay (Tauri'de confirm() çalışmaz).
 */
function AccountPane({ mode, onReset, onCancel, notify }: { mode: 'view' | 'logout' | 'reset'; onReset: () => void; onCancel: () => void; notify: (t: string, err?: boolean) => void }) {
  const logout = mode === 'logout';
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.license().then(setLic).catch(() => setLic(null));
  }, []);
  const required = !!lic?.required;
  const doLogout = () => {
    setBusy(true);
    signOut().catch((e) => {
      setBusy(false);
      notify((e as Error).message, true);
    });
  };
  const doReset = () => {
    setBusy(true);
    api
      .resetAll()
      .then(() => {
        // arayüzün bu bilgisayardaki kullanıcı kayıtları da (gezinme, taslaklar, zamanlanmış…) gider; cihaz izinleri ve tema kalır
        let setup: string | null = null;
        let perms: string | null = null;
        try {
          setup = localStorage.getItem('mivelo.setup');
          perms = localStorage.getItem('mivelo.setupPerms');
        } catch {
          /* depo kapalı */
        }
        wipeUserLocalData();
        try {
          if (setup) localStorage.setItem('mivelo.setup', setup);
          if (perms) localStorage.setItem('mivelo.setupPerms', perms);
        } catch {
          /* depo kapalı */
        }
        location.reload();
      })
      .catch((e) => {
        setBusy(false);
        notify((e as Error).message, true);
      });
  };
  if (mode === 'reset')
    return (
      <div className="set-logout-card">
        <span className="ic">
          <Icon name="trash" size={20} sw={2} />
        </span>
        <b>Tüm veriler silinsin mi?</b>
        <p>Bu işlem geri alınamaz. Mivelo önce her uygulamadan çıkış yapar (WhatsApp bağlı cihazlardan, Telegram oturumlardan düşer), sonra bu bilgisayardaki şunları siler:</p>
        <ul className="set-reset-list">
          <li>Bağlı uygulamalar ve oturumları</li>
          <li>Tüm mesajlar, sohbetler, ekler ve arama dizini</li>
          <li>Takvim etkinlikleri, takip hatırlatıcıları ve zamanlanmış mesajlar</li>
          <li>Profil bilgilerin, AI anahtarın ve ayarlar</li>
        </ul>
        <p>Lisansın bu bilgisayarda kalır; uygulamaları yeniden bağlayarak baştan başlayabilirsin.</p>
        <div className="row">
          <button type="button" className="btn ghost b b2" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn danger-solid b" onClick={doReset} disabled={busy}>
            <Icon name="trash" size={14} sw={2} /> {busy ? 'Çıkış yapılıyor ve siliniyor…' : 'Evet, hepsini sil'}
          </button>
        </div>
      </div>
    );
  if (logout)
    return (
      <div className="set-logout-card">
        <span className="ic">
          <Icon name="logout" size={20} sw={2} />
        </span>
        <b>Mivelo'dan çıkılsın mı?</b>
        <p>
          {required
            ? 'Bu bilgisayardaki lisans oturumu kapanır ve bağlı uygulamalar eşitlemeyi durdurur; cihaz hakkın boşalır. Mesajların ve bağlı uygulamaların silinmez — lisans anahtarınla yeniden girdiğinde kaldığın yerden sürer.'
            : 'Mivelo arayüzünden çıkarsın. Mesajların ve bağlı uygulamaların bu bilgisayarda kalır; yeniden girdiğinde kaldığın yerden sürer.'}
        </p>
        <div className="row">
          <button type="button" className="btn ghost b b2" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn danger-solid b" onClick={doLogout} disabled={busy}>
            <Icon name="logout" size={14} sw={2} /> {busy ? 'Çıkılıyor…' : 'Çıkış yap'}
          </button>
        </div>
      </div>
    );
  return (
    <>
      <div className="set-group">
        {lic?.owner?.name && (
          <Row title="Lisans sahibi" hint="Lisans kaydındaki ad (profil adını Profil bölümünden değiştirebilirsin)">
            <span className="set-val">{lic.owner.name}</span>
          </Row>
        )}
        {lic?.owner?.email && (
          <Row title="Lisans e-postası" hint="Lisansın gönderildiği adres">
            <span className="set-val">{lic.owner.email}</span>
          </Row>
        )}
        <Row title="Lisans" hint={required ? (lic?.valid ? licenseLeft(lic.expiresAt) : 'Geçersiz') : 'Bu sürümde lisans gerekmiyor (yerel / geliştirme)'}>
          <span className="set-val mono">{required ? (lic?.key ?? '—') : 'Yerel sürüm'}</span>
        </Row>
        {APP_VERSION && (
          <Row title="Sürüm" hint="Yeni sürüm çıkınca uygulama içinde haber verilir">
            <span className="set-val">{APP_VERSION}</span>
          </Row>
        )}
        <Row title="Yenilikler" hint="Son güncellemelerde neler değişti">
          <button type="button" className="btn xs b" onClick={() => window.dispatchEvent(new Event('mivelo-whats-new'))}>
            Göster
          </button>
        </Row>
      </div>
      <div className="set-group">
        <Row title="Tüm verileri sil" hint="Her uygulamadan çıkış yapar; mesajlar, oturumlar, profil ve ayarlar bu bilgisayardan silinir">
          <button type="button" className="btn danger-solid xs b" onClick={onReset}>
            Verileri sil
          </button>
        </Row>
      </div>
      <p className="set-note">Mesajların ve oturumların yalnız bu bilgisayarda saklanır; Mivelo sunucularına gitmez.</p>
    </>
  );
}

/** Seçilen görseli ortadan kare kırpıp 256 px JPEG'e küçült (profile.json küçük kalsın) */
function squarePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      if (!ctx || !side) return reject(new Error('Görsel okunamadı'));
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Bu dosya görsel olarak açılamadı'));
    };
    img.src = url;
  });
}

const PROFILE_FIELDS: Array<[keyof Profile, string, string, string, string]> = [
  ['name', 'Ad soyad', 'Uygulamada görünen adın', 'Adın ve soyadın', 'name'],
  ['username', 'Kullanıcı adı', 'Harf, rakam, nokta, alt çizgi', 'kullaniciadi', 'username'],
  ['email', 'E-posta', 'İletişim adresin', 'ornek@example.com', 'email'],
  ['phone', 'Telefon', 'Ülke koduyla', '+90 5xx xxx xx xx', 'tel'],
];

/**
 * Ayarlar → Profil (29.09, Kaan: profil fotoğrafı, ad, kullanıcı adı, e-posta, telefon). Yalnız bu bilgisayarda (çekirdek
 * ~/.mivelo/profile.json; web demoda tarayıcı); ad ve fotoğraf kenar çubuğunda ve Odak'ta görünür. Lisans e-postası değişmez.
 */
function ProfilePane({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const [saved, setSaved] = useState<Profile | null>(null);
  const [form, setForm] = useState<Profile>({});
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api
      .profile()
      .then((p) => (setSaved(p), setForm(p)))
      .catch(() => (setSaved({}), setForm({})));
  }, []);
  const dirty = !!saved && (['name', 'username', 'email', 'phone', 'photo'] as const).some((k) => (form[k] ?? '') !== (saved[k] ?? ''));
  const set = (k: keyof Profile, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pick = async (f?: File) => {
    if (!f) return;
    try {
      set('photo', await squarePhoto(f));
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const save = () => {
    setBusy(true);
    api
      .saveProfile(form)
      .then((p) => {
        setSaved(p);
        setForm(p);
        applyProfile(p);
        notify('Profil kaydedildi');
      })
      .catch((e) => notify((e as Error).message, true))
      .finally(() => setBusy(false));
  };
  const shownName = form.name?.trim() || PROFILE_NAME || 'Mivelo';
  return (
    <>
      <div className="set-group set-profile">
        <div className="set-profile-head">
          <Avatar name={shownName} size={64} url={form.photo || undefined} />
          <div className="who">
            <b>{shownName}</b>
            <em>{form.username ? `@${form.username.replace(/^@/, '')}` : 'Kullanıcı adı yok'}</em>
          </div>
          <div className="pacts">
            <button type="button" className="btn ghost xs b b2" onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={13} /> {form.photo ? 'Değiştir' : 'Fotoğraf yükle'}
            </button>
            {form.photo && (
              <button type="button" className="btn ghost xs b b2" onClick={() => set('photo', '')}>
                Kaldır
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {PROFILE_FIELDS.map(([k, title, hint, ph, type]) => (
          <Row key={k} title={title} hint={hint}>
            <input
              className="set-inp"
              type={type === 'username' || type === 'name' ? 'text' : type}
              value={form[k] ?? ''}
              placeholder={ph}
              autoComplete={type === 'username' ? 'username' : type === 'tel' ? 'tel' : type}
              maxLength={type === 'email' ? 120 : type === 'name' ? 60 : 30}
              onChange={(e) => set(k, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && !busy && save()}
            />
          </Row>
        ))}
      </div>
      <div className="set-actions">
        <button type="button" className="btn ghost b b2" disabled={!dirty || busy} onClick={() => saved && setForm(saved)}>
          Vazgeç
        </button>
        <button type="button" className="btn primary b" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>
      <p className="set-note">Profil bilgilerin yalnız bu bilgisayarda saklanır; bağlı uygulamalardaki profillerini ve lisans e-postanı değiştirmez.</p>
    </>
  );
}
