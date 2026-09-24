import { useState } from 'react';
import { api } from './api';
import { STATIC_DEMO } from './profile';
import { PLATFORMS, type Account, type Platform } from './types';
import { Chip, Icon, SyncBar } from './ui';

const ORDER: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger'];
const MAIL_ORDER: Platform[] = ['gmail', 'outlook', 'yahoo', 'icloud', 'imap'];
const SHOP_ORDER: Platform[] = ['shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify'];

interface MailForm {
  user: string;
  pass: string;
  clientId: string;
  clientSecret: string;
  useOAuth: boolean;
  host: string;
  port: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
}
const EMPTY_MAIL: MailForm = { user: '', pass: '', clientId: '', clientSecret: '', useOAuth: false, host: '', port: '993', smtpHost: '', smtpPort: '465', smtpSecure: true };

export function ConnectModal({
  accounts,
  qr,
  prompts,
  connected,
  onClose,
  closing,
  notify,
  onChanged,
  sync = {},
}: {
  /** hesap → eşitleme ilerlemesi (App'ten) */
  sync?: Record<string, { progress: number; since: number; label?: string }>;
  accounts: Account[];
  qr: Record<string, string>;
  prompts: Record<string, { prompt: 'phone' | 'code' | 'password'; message: string }>;
  connected: Platform[];
  onClose: () => void;
  /** kapanış animasyonu (useClosing) */
  closing?: boolean;
  notify: (t: string, err?: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [active, setActive] = useState<string | null>(null); // account id
  const [tg, setTg] = useState({ apiId: '', apiHash: '' });
  const [pat, setPat] = useState('');
  const [mail, setMail] = useState<MailForm>(EMPTY_MAIL);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const activeAccount = accounts.find((a) => a.id === active);

  async function add(platform: Platform) {
    setBusy(true);
    try {
      if (STATIC_DEMO) {
        const a = await api.addAccount(platform);
        setActive(a.id);
        await onChanged();
        return;
      }
      if (platform === 'telegram' && active !== 'telegram:new') {
        setActive('telegram:new');
        return;
      }
      if (platform === 'shopier' && (active !== 'shopier:new' || !pat.trim())) {
        setActive('shopier:new');
        return;
      }
      const isMail = PLATFORMS[platform].mode === 'mail';
      if (isMail && (active !== `${platform}:new` || !mail.user.trim())) {
        setActive(`${platform}:new`);
        return;
      }
      let token: string | undefined;
      if (platform === 'telegram' && tg.apiId.trim() && tg.apiHash.trim()) token = JSON.stringify({ apiId: Number(tg.apiId.trim()), apiHash: tg.apiHash.trim() });
      if (platform === 'shopier') token = pat.trim();
      if (isMail) {
        const oauth = platform === 'outlook' || (platform === 'gmail' && mail.useOAuth);
        const cfg: Record<string, unknown> = { user: mail.user.trim(), pass: oauth ? undefined : mail.pass || undefined, clientId: oauth ? mail.clientId.trim() || undefined : undefined, clientSecret: oauth ? mail.clientSecret.trim() || undefined : undefined };
        if (platform === 'imap') {
          Object.assign(cfg, { host: mail.host.trim(), port: Number(mail.port) || 993, secure: (Number(mail.port) || 993) === 993, smtpHost: mail.smtpHost.trim() || mail.host.trim().replace(/^imap\./, 'smtp.'), smtpPort: Number(mail.smtpPort) || 465, smtpSecure: mail.smtpSecure });
        }
        token = JSON.stringify(cfg);
      }
      const a = await api.addAccount(platform, token);
      setActive(a.id);
      setMail(EMPTY_MAIL);
      await onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const [confirmId, setConfirmId] = useState<string | null>(null);
  async function remove(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      notify('Kaldırmak için bir kez daha tıkla');
      window.setTimeout(() => setConfirmId((c) => (c === id ? null : c)), 4000);
      return;
    }
    setConfirmId(null);
    try {
      await api.removeAccount(id);
      if (active === id) setActive(null);
      await onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function sendInput() {
    if (!activeAccount) return;
    const p = prompts[activeAccount.id];
    if (!p || !input.trim()) return;
    try {
      await api.accountInput(activeAccount.id, p.prompt, input.trim());
      setInput('');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  // Etkin kartın hemen altında açılan panel (form / QR / durum) — kullanıcı aşağı kaydırmak zorunda kalmasın
  const panel = (
    <>
        {active?.endsWith(':new') && PLATFORMS[active.split(':')[0] as Platform]?.mode === 'mail' && (() => {
          const p = active.split(':')[0] as Platform;
          const isOutlook = p === 'outlook';
          const isImap = p === 'imap';
          return (
            <div className="pairbox">
              <div style={{ flexGrow: 1 }}>
                <h3>{PLATFORMS[p].name} hesabını bağla</h3>
                <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {p === 'gmail' && !mail.useOAuth && (
                    <>
                      Google hesabında 2 adımlı doğrulama açık olmalı. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: 'var(--v-txt)' }}><b>Uygulama şifreleri sayfasını aç</b></a>, 16 haneli bir şifre üret ve buraya yapıştır (normal şifren
                      çalışmaz).{' '}
                      <a href="#oauth" onClick={(e) => (e.preventDefault(), setMail({ ...mail, useOAuth: true }))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                        Şifresiz, Google giriş penceresiyle bağlan →
                      </a>
                    </>
                  )}
                  {p === 'gmail' && mail.useOAuth && (
                    <>
                      Google giriş penceresiyle bağlanmak için bir kez ücretsiz OAuth istemcisi gerekir: <b>console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID → Desktop app</b>; OAuth consent
                      screen'de kendini "test user" olarak ekle. Oluşan <b>Client ID</b> ve <b>Client secret</b>'ı gir; Bağlan deyince Google penceresi açılır, giriş yapınca kapanır.{' '}
                      <a href="#pass" onClick={(e) => (e.preventDefault(), setMail({ ...mail, useOAuth: false }))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                        Uygulama şifresiyle bağlan →
                      </a>
                    </>
                  )}
                  {isOutlook && (
                    <>
                      Microsoft kişisel hesaplarda şifreyle IMAP kapalı; ücretsiz bir Azure uygulama kimliği gerekir: <b>portal.azure.com → App registrations → New</b> (Hesap türü: kişisel + kurumsal, Mobile/desktop
                      platform, "Allow public client flows" = Yes). Oluşan <b>Application (client) ID</b>'yi gir; bağlanınca sana bir kod ve microsoft.com/devicelogin adresi verilecek.
                    </>
                  )}
                  {p === 'yahoo' && (
                    <>
                      <a href="https://login.yahoo.com/myaccount/security/app-password/" target="_blank" rel="noreferrer" style={{ color: 'var(--v-txt)' }}><b>Yahoo uygulama şifresi sayfasını aç</b></a>, bir şifre üret ve buraya gir.
                    </>
                  )}
                  {p === 'icloud' && (
                    <>
                      <a href="https://account.apple.com/account/manage" target="_blank" rel="noreferrer" style={{ color: 'var(--v-txt)' }}><b>Apple hesabı sayfasını aç</b></a> → Oturum açma ve güvenlik → <b>Uygulamaya özel şifreler</b>; kullanıcı adı iCloud e-posta adresin.
                    </>
                  )}
                  {isOutlook && <> Bağlan deyince Microsoft giriş penceresi kod önceden dolu açılır; giriş yapınca kendiliğinden kapanır.</>}
                  {isImap && <>Sağlayıcının IMAP/SMTP sunucularını gir (Yandex: imap.yandex.com / smtp.yandex.com, Fastmail: imap.fastmail.com / smtp.fastmail.com). Çoğu sağlayıcı uygulama şifresi ister.</>}
                </p>
                <div className="field" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
                  <input value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} placeholder="e-posta adresi" type="email" autoComplete="off" style={{ flex: '1 1 220px' }} />
                  {isOutlook ? (
                    <input value={mail.clientId} onChange={(e) => setMail({ ...mail, clientId: e.target.value })} placeholder="Azure Application (client) ID" style={{ flex: '1 1 260px' }} />
                  ) : p === 'gmail' && mail.useOAuth ? (
                    <>
                      <input value={mail.clientId} onChange={(e) => setMail({ ...mail, clientId: e.target.value })} placeholder="Google Client ID (…apps.googleusercontent.com)" style={{ flex: '1 1 260px' }} />
                      <input value={mail.clientSecret} onChange={(e) => setMail({ ...mail, clientSecret: e.target.value })} placeholder="Client secret" type="password" autoComplete="off" style={{ flex: '1 1 200px' }} />
                    </>
                  ) : (
                    <input value={mail.pass} onChange={(e) => setMail({ ...mail, pass: e.target.value })} placeholder="uygulama şifresi" type="password" autoComplete="new-password" style={{ flex: '1 1 200px' }} />
                  )}
                  {isImap && (
                    <>
                      <input value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} placeholder="IMAP sunucusu (imap.…)" style={{ flex: '1 1 200px' }} />
                      <input value={mail.port} onChange={(e) => setMail({ ...mail, port: e.target.value })} placeholder="993" style={{ flex: '0 0 70px' }} />
                      <input value={mail.smtpHost} onChange={(e) => setMail({ ...mail, smtpHost: e.target.value })} placeholder="SMTP sunucusu (smtp.…)" style={{ flex: '1 1 200px' }} />
                      <input value={mail.smtpPort} onChange={(e) => setMail({ ...mail, smtpPort: e.target.value, smtpSecure: e.target.value === '465' })} placeholder="465" style={{ flex: '0 0 70px' }} />
                    </>
                  )}
                  <button className="btn lime b" onClick={() => add(p)} disabled={busy || !mail.user.trim() || (isOutlook ? !mail.clientId.trim() : p === 'gmail' && mail.useOAuth ? !mail.clientId.trim() || !mail.clientSecret.trim() : !mail.pass) || (isImap && !mail.host.trim())}>
                    Bağlan
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {active === 'shopier:new' && (
          <div className="pairbox">
            <div style={{ flexGrow: 1 }}>
              <h3>Shopier’i bağla</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                Shopier satıcı panelinde <b>Hesap Yönetimi → Kişisel Erişim Anahtarı</b> ile bir anahtar üret (hesapta iki adımlı doğrulama açık olmalı; anahtar yalnızca bir kez gösterilir) ve buraya yapıştır.
                Siparişler her sipariş bir sohbet olacak şekilde akar; kargoya verme / kapatma sağ panelden yapılır. Shopier API’sinde alıcı-satıcı mesajlaşması yok, DM bu yüzden sunulmaz.
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <input value={pat} onChange={(e) => setPat(e.target.value)} placeholder="Kişisel Erişim Anahtarı (PAT)" type="password" autoComplete="off" />
                <button className="btn lime b" onClick={() => add('shopier')} disabled={busy || !pat.trim()}>
                  Bağlan
                </button>
              </div>
            </div>
          </div>
        )}

        {active === 'telegram:new' && (
          <div className="pairbox">
            <div style={{ flexGrow: 1 }}>
              <h3>Telegram’ı bağla</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                WhatsApp gibi QR ile bağlanır: Bağlan deyince çıkan kodu telefondaki Telegram → <b>Ayarlar → Cihazlar → Masaüstü Cihazı Bağla</b> ile okut. Alanları boş bırakırsan Mivelo’nun
                varsayılan uygulama kimliği kullanılır; istersen <b>my.telegram.org → API development tools</b>’dan kendi <b>api_id</b> / <b>api_hash</b>’ini gir.
              </p>
              <div className="field" style={{ marginTop: 12, gap: 8 }}>
                <input value={tg.apiId} onChange={(e) => setTg({ ...tg, apiId: e.target.value })} placeholder="api_id (isteğe bağlı)" style={{ flex: '0 0 160px' }} />
                <input value={tg.apiHash} onChange={(e) => setTg({ ...tg, apiHash: e.target.value })} placeholder="api_hash (isteğe bağlı)" type="password" autoComplete="off" />
                <button className="btn lime b" onClick={() => add('telegram')} disabled={busy}>
                  Bağlan
                </button>
              </div>
            </div>
          </div>
        )}


        {activeAccount && (
          <div className="pairbox">
            {(activeAccount.platform === 'whatsapp' || activeAccount.platform === 'telegram') && qr[activeAccount.id] && activeAccount.status === 'pairing' && (
              <div className="qr">
                <img src={qr[activeAccount.id]} alt="Eşleştirme kodu" />
              </div>
            )}
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <h3>
                {PLATFORMS[activeAccount.platform].name} · {activeAccount.label}
              </h3>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text2)' }}>
                <span className={`dot ${activeAccount.status === 'connected' ? 'on' : activeAccount.status}`} />
                {statusText(activeAccount)}
                {activeAccount.detail && <span style={{ color: 'var(--text3)' }}>— {activeAccount.detail}</span>}
              </div>

              {activeAccount.platform === 'whatsapp' && activeAccount.status === 'pairing' && (
                <ol>
                  <li>Telefonunda WhatsApp’ı aç</li>
                  <li>
                    <b>Ayarlar → Bağlı cihazlar → Cihaz bağla</b>
                  </li>
                  <li>Kamerayı bu koda tut; son sohbetlerin otomatik gelir</li>
                </ol>
              )}

              {activeAccount.platform === 'telegram' && activeAccount.status === 'pairing' && !prompts[activeAccount.id] && (
                <ol>
                  <li>Telefonunda Telegram’ı aç</li>
                  <li>
                    <b>Ayarlar → Cihazlar → Masaüstü Cihazı Bağla</b>
                  </li>
                  <li>Kamerayı bu koda tut (kod ~30 sn’de bir yenilenir); iki adımlı doğrulaman varsa parola sorulur</li>
                </ol>
              )}

              {PLATFORMS[activeAccount.platform].mode === 'browser' && activeAccount.status !== 'connected' && (
                <>
                  {(activeAccount.detail ?? '').includes('Yeniden bağlan') ? (
                    <p style={{ margin: '6px 0 10px', fontSize: 13.5 }}>
                      Kayıtlı oturum yok ya da düşmüş. Giriş penceresini açmak için:
                    </p>
                  ) : null}
                  <button
                    className="btn primary sm b b2"
                    style={{ alignSelf: 'flex-start', marginBottom: 10 }}
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      api.restartAccount(activeAccount.id).then(() => notify('Giriş penceresi açılıyor')).catch((e) => (notify(e.message, true), onChanged())).finally(() => setBusy(false));
                    }}
                  >
                    <Icon name="refresh" size={14} sw={2} color="#fff" /> Giriş penceresini aç
                  </button>
                  <ol>
                    <li>Açılan Chromium penceresinde {PLATFORMS[activeAccount.platform].name} hesabına normal şekilde giriş yap (ilk seferde <code>npx playwright install chromium</code> gerekebilir)</li>
                    <li>Giriş (ve varsa izin adımları) tamamlanınca pencere kendiliğinden kapanır; bağlantı arka planda sürer</li>
                  </ol>
                </>
              )}
              {activeAccount.platform === 'imessage' && activeAccount.status === 'error' && (
                <ol>
                  <li>Sistem Ayarları → Gizlilik ve Güvenlik → <b>Tam Disk Erişimi</b> bölmesi otomatik açıldı (açılmadıysa ⌘K ile arat)</li>
                  <li>Listede <b>Mivelo</b> yoksa “+” ile ekle — geliştirme modunda (<code>npm run desktop</code>) <b>Terminal</b>’i ekle; anahtarı aç</li>
                  <li>Terminal’i/uygulamayı yeniden başlat ve aşağıdaki <b>Yeniden dene</b>’ye bas</li>
                </ol>
              )}
              {false && (
                <ol>
                  <li>Sistem Ayarları → Gizlilik ve Güvenlik → <b>Tam Disk Erişimi</b></li>
                  <li>Çekirdeği çalıştıran uygulamayı (Terminal / iTerm / Node) listeye ekle</li>
                  <li>Çekirdeği yeniden başlat ve “Yeniden dene”ye bas</li>
                </ol>
              )}
              {activeAccount.platform === 'telegram' && prompts[activeAccount.id] && activeAccount.status === 'pairing' && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13.5 }}>{prompts[activeAccount.id].message}</p>
                  <div className="field">
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      type={prompts[activeAccount.id].prompt === 'password' ? 'password' : 'text'}
                      placeholder={prompts[activeAccount.id].prompt === 'phone' ? '+90…' : prompts[activeAccount.id].prompt === 'code' ? '12345' : '••••••'}
                      onKeyDown={(e) => e.key === 'Enter' && sendInput()}
                      autoFocus
                    />
                    <button className="btn lime b" onClick={sendInput} disabled={!input.trim()}>
                      Gönder
                    </button>
                  </div>
                </div>
              )}

              {activeAccount.status === 'error' && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="btn darksec b" onClick={() => api.restartAccount(activeAccount.id).catch((e) => notify(e.message, true))}>
                    <Icon name="refresh" size={14} sw={2} /> Yeniden dene
                  </button>
                </div>
              )}
              {activeAccount.status === 'connected' && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--text2)' }}>Bağlı. Sohbetler gelen kutusuna akıyor; tarayıcı arka planda görünmez çalışıyor.</p>
              )}
            </div>
          </div>
        )}

    </>
  );

  return (
    <div className={`overlay ${closing ? 'closing' : ''}`} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Uygulama bağla">
        <div className="modal-scroll">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flexGrow: 1 }}>
            <h2>
              Bütün sohbetlerin, <mark>tek bir yerde.</mark>
            </h2>
          </div>
          <button className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>

        <div className="grid3">
          {[...ORDER, ...MAIL_ORDER, ...SHOP_ORDER].map((p) => {
            const meta = PLATFORMS[p];
            const acc = accounts.filter((a) => a.platform === p);
            const isConn = connected.includes(p);
            const isActive = acc.some((a) => a.id === active) || active === `${p}:new`;
            void 0;
            return (
              <div key={p} style={{ display: 'contents' }}>
                {p === 'whatsapp' && (
                  <div className="grid-head">
                    <Icon name="users" size={16} sw={2} /> Sosyal Medya
                  </div>
                )}
                {p === 'gmail' && (
                  <div className="grid-head">
                    <Icon name="mail" size={16} sw={2} /> E-posta
                  </div>
                )}
                {p === 'shopier' && (
                  <div className="grid-head">
                    <Icon name="bag" size={16} sw={2} /> Alışveriş
                  </div>
                )}
              <div className={`pcard ${!meta.available ? 'soon' : ''} ${isActive ? 'active' : ''}`}>
                <div className="top">
                  <Chip platform={p} size={44} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {meta.name}
                      {meta.experimental && <span className="pill" style={{ background: '#FFF3D6', color: '#8A5300' }}>deneysel</span>}
                    </div>
                    <div className="mt">{meta.method}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {meta.available && (acc.length ? (
                    <span className="st" style={{ color: isConn ? '#15803d' : undefined, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexGrow: 1 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span className={`dot ${acc[0].status === 'connected' ? 'on' : acc[0].status}`} />
                        {sync[acc[0].id] ? (sync[acc[0].id].label ?? 'Eşitleniyor') : statusText(acc[0])}
                      </span>
                      {sync[acc[0].id] && <SyncBar progress={sync[acc[0].id].progress} since={sync[acc[0].id].since} />}
                    </span>
                  ) : (
                    <span className="st">
                      <span className="dot" /> Bağlı değil
                    </span>
                  ))}
                  <span style={{ flexGrow: 1 }} />
                  {meta.available && acc.length > 0 && (
                    <>
                      <button className="btn sm b b2" onClick={() => setActive(acc[0].id)}>
                        Ayrıntı
                      </button>
                      <button className={`btn sm icon b b2 ${confirmId === acc[0].id ? 'danger-solid' : ''}`} onClick={() => remove(acc[0].id)} aria-label="Kaldır" title={confirmId === acc[0].id ? 'Onaylamak için tekrar tıkla' : 'Kaldır'}>
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                  {meta.available && acc.length === 0 && (
                    <button className="btn sm primary b" onClick={() => add(p)} disabled={busy}>
                      Bağlan
                    </button>
                  )}
                  {!meta.available && (
                    <button className="btn sm b b2" disabled>
                      Yakında
                    </button>
                  )}
                </div>
              </div>
              {isActive && <div className="inline-panel" style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 12 }}>{panel}</div>}
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text3)' }}>
          Mivelo bağımsız bir uygulamadır; WhatsApp, Telegram, Slack, Apple (iMessage), LinkedIn, X, Instagram veya Messenger tarafından geliştirilmemiş, onaylanmamış ya da desteklenmemiştir.
          Adlar ve logolar ilgili sahiplerinin tescilli markalarıdır ve yalnızca uyumluluğu belirtmek için kullanılır.
        </div>
        </div>
      </div>
    </div>
  );
}

function statusText(a: Account): string {
  return { connected: 'Bağlı', connecting: 'Bağlanıyor…', pairing: 'Eşleşme bekleniyor', disconnected: 'Bağlı değil', error: 'Hata' }[a.status];
}
