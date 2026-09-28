import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { PLATFORMS, type Account } from './types';
import { Chip, Icon, PasswordInput } from './ui';
import { SOUNDS, getPlatformSound, getPlatformTone, getPlatformVolume, getVolume, groupsNotify, bannersEnabled, soundsEnabled, playNotifySound, playPing, setBannersEnabled, setGroupsNotify, setPlatformSound, setPlatformTone, setPlatformVolume, setSoundsEnabled, setVolume, webNotifyPermission, requestWebNotify, testNotify } from './desktop';
import { setAiPrefs, useAiPrefs } from './ai-prefs';
import { DEMO_OFFLINE, STATIC_DEMO } from './profile';
import { leaveDemoPanel } from './demo-session';

type Tab = 'notify' | 'apps' | 'ai' | 'phone';
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
    ['notify', 'Bildirimler', 'bell'],
    ['apps', 'Uygulama sesleri', 'volume'],
    ['ai', 'AI özellikleri', 'sparkle'],
    ['phone', 'Telefondan erişim', 'link'],
  ];

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
          {/* web demo: çıkış doğrudan menüde (eskiden Hesap bölümünün içindeydi); basınca hemen çıkar */}
          {STATIC_DEMO && !DEMO_OFFLINE && (
            <button type="button" className="set-tab set-logout b" onClick={() => leaveDemoPanel()}>
              <Icon name="logout" size={16} />
              <span>Çıkış yap</span>
            </button>
          )}
        </aside>
        <section className="set-body">
          <header className="set-head">
            <h3>{TABS.find(([k]) => k === tab)?.[1]}</h3>
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
