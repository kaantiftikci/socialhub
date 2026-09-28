import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { STATIC_DEMO } from './profile';
import { MAC_ONLY, PLATFORMS, type Account, type CoreOs, type Platform } from './types';
import { Chip, Icon, SyncBar } from './ui';

const ORDER: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger'];
const MAIL_ORDER: Platform[] = ['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap'];
// Alışveriş kanalları yalnızca müşteri sorularını/mesajlarını görmek ve yanıtlamak için; Shopier'de mesajlaşma ucu olmadığından listede yok
/** Resmi (kişisel hesaba açık) API'si olmayan, web oturumu/bağlı cihazla çalışan kanallar: kartta şeffaflık etiketi */
/**
 * Slack uygulama bildirimi (çekirdekteki connectors/slack.ts SLACK_MANIFEST ile aynı tutulmalı): yalnız kullanıcı kapsamları
 * (xoxp), kullanıcı olayları Socket Mode ile. "Create app from manifest" bağlantısı formu hazır doldurur.
 */
const SLACK_MANIFEST = {
  display_information: { name: 'Mivelo', description: 'Mivelo birleşik gelen kutusu — yalnız bu bilgisayarda, kişisel kullanım', background_color: '#6c47ff' },
  oauth_config: {
    scopes: {
      user: [
        'channels:history', 'groups:history', 'im:history', 'mpim:history',
        'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write',
        'reactions:read', 'reactions:write', 'files:read', 'files:write', 'channels:write', 'groups:write', 'im:write', 'mpim:write',
      ],
    },
  },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added', 'reaction_removed'] },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};
const SLACK_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}`;

/** Tarayıcı yolu olsa da önce uygulama şifresi (IMAP + anlık IDLE) formu açılan e-posta sağlayıcıları; tarayıcı girişi formda yedek */
const MAIL_FORM_FIRST = new Set<Platform>(['gmail', 'icloud']);
const usesMailForm = (p: Platform) => PLATFORMS[p]?.mode === 'mail' || MAIL_FORM_FIRST.has(p);

const UNOFFICIAL: Partial<Record<Platform, string>> = {
  whatsapp: 'WhatsApp kişisel hesaplar için API sunmaz; Mivelo WhatsApp Web gibi "bağlı cihaz" olarak bağlanır.',
  instagram: 'Instagram kişisel hesaplar için mesaj API’si sunmaz; Mivelo kendi web oturumunla bağlanır.',
  messenger: 'Messenger kişisel hesaplar için API sunmaz; Mivelo kendi web oturumunla bağlanır.',
  linkedin: 'LinkedIn mesaj API’sini yalnız onaylı iş ortaklarına açar; Mivelo kendi web oturumunla bağlanır.',
  x: 'X’in DM API’si ücretli ve şifreli sohbetleri göstermez; Mivelo kendi web oturumunla bağlanır.',
};
const SHOP_ORDER: Platform[] = ['trendyol', 'hepsiburada', 'n11', 'etsy', 'shopify', 'amazon'];

interface MailForm {
  /** Diğer e-posta: sunucuyu elle gir (varsayılan: adresten otomatik bulunur) */
  manual: boolean;
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
const EMPTY_MAIL: MailForm = { user: '', pass: '', clientId: '', clientSecret: '', useOAuth: false, host: '', port: '993', smtpHost: '', smtpPort: '465', smtpSecure: true, manual: false };

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
  focus,
}: {
  /** Açılışta doğrudan bu hesabın eşleştirme alanı açık gelsin (uyarıdaki "QR'ı göster") */
  focus?: string | null;
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
  // focus "edit:<hesap>" → o hesabın bilgi formu (şifre/API anahtarı yenileme); e-posta adresi önceden doldurulur
  const editOf = focus?.startsWith('edit:') ? accounts.find((a) => a.id === focus.slice(5)) : undefined;
  const [active, setActive] = useState<string | null>(editOf ? `${editOf.platform}:new` : (focus ?? null)); // account id
  const prefill = useRef<{ active: string; user: string } | null>(editOf ? { active: `${editOf.platform}:new`, user: editOf.label && editOf.label.includes('@') ? editOf.label : '' } : null);
  /** hesabın bilgilerini yeniden gir: yeni hesap formu açılır (kaydedince çekirdek var olan hesabı günceller) */
  const editCredentials = (a: Account) => {
    prefill.current = { active: `${a.platform}:new`, user: a.label && a.label.includes('@') ? a.label : '' };
    setActive(`${a.platform}:new`);
  };
  const [tg, setTg] = useState({ apiId: '', apiHash: '' });
  /** Slack resmi uygulama: User OAuth Token (xoxp) + isteğe bağlı App-Level Token (xapp, Socket Mode) */
  const [slackTok, setSlackTok] = useState({ user: '', app: '' });
  const [pat, setPat] = useState('');
  /** Pazar yeri formları (Trendyol/Hepsiburada/Etsy/Shopify): alan adı → değer */
  const [shop, setShop] = useState<Record<string, string>>({});
  const sf = (k: string) => shop[k] ?? '';
  const setSf = (k: string, v: string) => setShop((p) => ({ ...p, [k]: v }));
  const [mail, setMail] = useState<MailForm>(EMPTY_MAIL);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const activeAccount = accounts.find((a) => a.id === active);
  // Başka bir sağlayıcının formuna geçince alanlar sıfırlansın (Yahoo'ya yazılan adres/şifre "Diğer e-posta"da görünmesin)
  // ve açılan panel görünür alana kaydırılsın
  useEffect(() => {
    const pf = prefill.current;
    prefill.current = null;
    setMail(pf && pf.active === active ? { ...EMPTY_MAIL, user: pf.user } : EMPTY_MAIL);
    setShop({});
    setPat('');
    setSlackTok({ user: '', app: '' });
    if (!active) return;
    requestAnimationFrame(() => document.querySelector('.overlay .pairbox')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [active]);
  /** Çekirdeğin OS'u: iMessage gibi yalnız Mac kanalları Windows/Linux çekirdeğinde pasif */
  const [coreOs, setCoreOs] = useState<CoreOs | undefined>();
  useEffect(() => {
    api.health().then((h) => setCoreOs(h.os)).catch(() => undefined);
  }, []);
  const macOnlyOff = (p: Platform) => MAC_ONLY.has(p) && !!coreOs && coreOs !== 'darwin';

  /** opts.browser: Slack'i resmi uygulama yerine tarayıcı oturumuyla bağla (yedek yol) */
  async function add(platform: Platform, opts: { browser?: boolean; form?: boolean } = {}) {
    setBusy(true);
    try {
      if (platform === 'slack' && !opts.browser && (active !== 'slack:new' || !slackTok.user.trim())) {
        setActive('slack:new');
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
      const SHOP_FIELDS: Partial<Record<Platform, string[]>> = { trendyol: ['sellerId', 'apiKey', 'apiSecret'], hepsiburada: ['merchantId', 'username', 'password'], etsy: ['keystring'], shopify: ['shop', 'accessToken'], n11: ['appKey', 'appSecret'], amazon: ['clientId', 'clientSecret', 'refreshToken'] };
      const shopFields = SHOP_FIELDS[platform];
      if (shopFields && (active !== `${platform}:new` || shopFields.some((k) => !sf(k).trim()))) {
        setActive(`${platform}:new`);
        return;
      }
      // Gmail / iCloud: varsayılan yol kendi giriş sayfasında normal e-posta + şifre (tarayıcı); uygulama şifresi isteğe bağlı
      if (MAIL_FORM_FIRST.has(platform) && !opts.browser && !opts.form && active !== `${platform}:new`) {
        setActive(`${platform}:choose`);
        return;
      }
      const isMail = usesMailForm(platform) && !opts.browser;
      if (isMail && (active !== `${platform}:new` || !mail.user.trim())) {
        setActive(`${platform}:new`);
        return;
      }
      // Demo sitesi: formlar gerçek uygulamadaki gibi açılır, doldurulunca hesap örnek veriyle bağlanır (girilenler saklanmaz)
      if (STATIC_DEMO) {
        const a = await api.addAccount(platform);
        setActive(a.id);
        setShop({});
        setPat('');
        await onChanged();
        return;
      }
      let token: string | undefined;
      if (platform === 'telegram' && tg.apiId.trim() && tg.apiHash.trim()) token = JSON.stringify({ apiId: Number(tg.apiId.trim()), apiHash: tg.apiHash.trim() });
      if (platform === 'shopier') token = pat.trim();
      if (platform === 'slack' && !opts.browser) token = JSON.stringify({ token: slackTok.user.trim(), appToken: slackTok.app.trim() || undefined });
      if (shopFields) {
        const cfg: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(shop)) if (v.trim()) cfg[k] = v.trim();
        if (shop.ordersOff === 'true') cfg.ordersOff = true; // varsayılan: siparişler + müşteri soruları
        token = JSON.stringify(cfg);
      }
      if (isMail) {
        const oauth = platform === 'outlook' || (platform === 'gmail' && mail.useOAuth);
        const cfg: Record<string, unknown> = { user: mail.user.trim(), pass: oauth ? undefined : mail.pass || undefined, clientId: oauth ? mail.clientId.trim() || undefined : undefined, clientSecret: oauth ? mail.clientSecret.trim() || undefined : undefined };
        if (platform === 'imap' && mail.manual && mail.host.trim()) {
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
        {active?.endsWith(':choose') && (() => {
          const p = active.split(':')[0] as Platform;
          const who = p === 'gmail' ? 'Google' : 'Apple';
          return (
            <div className="pairbox">
              <div style={{ flexGrow: 1 }}>
                <h3>{PLATFORMS[p].name} hesabını bağla</h3>
                <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {who} giriş sayfası açılır; her zamanki e-posta adresin ve şifrenle giriş yap (doğrulama isterse tamamla). Giriş algılanınca pencere kendiliğinden kapanır. Şifren Mivelo'ya girilmez.
                </p>
                <div className="field" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn lime b" onClick={() => void add(p, { browser: true })} disabled={busy}>
                    {who} ile giriş yap
                  </button>
                </div>
                <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text3, var(--text2))', lineHeight: 1.5 }}>
                  E-postaların saniyesinde gelsin ve arka planda tarayıcı açılmasın istersen{' '}
                  <a href="#form" onClick={(e) => (e.preventDefault(), setActive(`${p}:new`))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                    uygulama şifresiyle bağlan (gelişmiş)
                  </a>
                  .
                </p>
              </div>
            </div>
          );
        })()}
        {active?.endsWith(':new') && usesMailForm(active.split(':')[0] as Platform) && (() => {
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
                  {p === 'yandex' && (
                    <>
                      <a href="https://id.yandex.com/security/app-passwords" target="_blank" rel="noreferrer" style={{ color: 'var(--v-txt)' }}><b>Yandex uygulama şifresi sayfasını aç</b></a> → "E-posta" türünde bir şifre üret ve buraya gir (Yandex, posta uygulamalarında normal şifreyi kabul etmiyor).
                    </>
                  )}
                  {isImap && <>E-posta adresini ve şifreni gir; sunucu ayarları adresten otomatik bulunur. Bazı sağlayıcılar (GMX, Zoho…) normal şifre yerine uygulama şifresi ister.</>}
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
                    <input value={mail.pass} onChange={(e) => setMail({ ...mail, pass: e.target.value })} placeholder={isImap ? 'şifre' : 'uygulama şifresi'} type="password" autoComplete="new-password" style={{ flex: '1 1 200px' }} />
                  )}
                  {isImap && mail.manual && (
                    <>
                      <input value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} placeholder="IMAP sunucusu (imap.…)" style={{ flex: '1 1 200px' }} />
                      <input value={mail.port} onChange={(e) => setMail({ ...mail, port: e.target.value })} placeholder="993" style={{ flex: '0 0 70px' }} />
                      <input value={mail.smtpHost} onChange={(e) => setMail({ ...mail, smtpHost: e.target.value })} placeholder="SMTP sunucusu (smtp.…)" style={{ flex: '1 1 200px' }} />
                      <input value={mail.smtpPort} onChange={(e) => setMail({ ...mail, smtpPort: e.target.value, smtpSecure: e.target.value === '465' })} placeholder="465" style={{ flex: '0 0 70px' }} />
                    </>
                  )}
                  <button className="btn lime b" onClick={() => add(p)} disabled={busy || !mail.user.trim() || (isOutlook ? !mail.clientId.trim() : p === 'gmail' && mail.useOAuth ? !mail.clientId.trim() || !mail.clientSecret.trim() : !mail.pass) || (isImap && mail.manual && !mail.host.trim())}>
                    Bağlan
                  </button>
                </div>
                {isImap && (
                  <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text3, var(--text2))' }}>
                    <a href="#manual" onClick={(e) => (e.preventDefault(), setMail({ ...mail, manual: !mail.manual }))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                      {mail.manual ? 'Sunucuyu otomatik bul' : 'Sunucuyu elle gir (gelişmiş)'}
                    </a>
                  </p>
                )}
                {MAIL_FORM_FIRST.has(p) && (
                  <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text3, var(--text2))', lineHeight: 1.5 }}>
                    Uygulama şifresiyle yeni e-postalar anında (~2 sn) gelir ve tarayıcı açılmaz. Şifre üretmek istemiyorsan{' '}
                    <a href="#browser" onClick={(e) => (e.preventDefault(), void add(p, { browser: true }))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                      tarayıcı girişiyle bağlan
                    </a>{' '}
                    (Mivelo açıkken ~15 sn, arka planda ~50 sn gecikmeyle).
                  </p>
                )}
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

        {(['trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon'] as Platform[]).map((p) =>
          active === `${p}:new` ? (
            <div className="pairbox" key={p}>
              <div style={{ flexGrow: 1 }}>
                <h3>{PLATFORMS[p].name}’{p === 'etsy' ? 'yi' : p === 'shopify' ? 'ı' : p === 'trendyol' ? 'u' : p === 'n11' ? 'i' : p === 'amazon' ? 'u' : 'yı'} bağla</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {p === 'trendyol' && (
                    <>
                      Trendyol Partner → <b>Hesap Bilgilerim → Entegrasyon Bilgileri</b>: Satıcı ID, API Key ve API Secret. Siparişler ve müşteri soruları sohbet olarak akar; sorulara buradan yanıt verirsin (yanıt Trendyol’a gider).
                    </>
                  )}
                  {p === 'hepsiburada' && (
                    <>
                      Hepsiburada Satıcı Paneli → <b>Entegrasyon</b>: Merchant ID ile entegrasyon kullanıcı adı/şifresi. Siparişler ve müşteri soruları sohbet olarak akar; sorulara buradan yanıt verirsin.
                    </>
                  )}
                  {p === 'etsy' && (
                    <>
                      etsy.com/developers’ta bir uygulama oluştur, <b>Keystring</b>’i gir; uygulamanın geri dönüş adresine <code>http://127.0.0.1:7788/oauth/callback</code> ekle. Bağlan deyince Etsy girişi açılır. Siparişler resmi API’den gelir. Etsy Mesajları API’de olmadığından okunmaz (hesabını riske atmamak için tarayıcıyla okuma varsayılan kapalı).
                    </>
                  )}
                  {p === 'n11' && (
                    <>
                      n11 Mağaza Paneli → <b>Ayarlar → API Bilgileri</b>: App Key ve App Secret. Siparişler ve müşteri soruları sohbet olarak akar; sorulara buradan yanıt verirsin.
                    </>
                  )}
                  {p === 'amazon' && (
                    <>
                      Seller Central → <b>Uygulamalar ve Hizmetler → Uygulama geliştir</b> (SP-API, kendi kendine yetkilendirme): LWA Client ID, Client Secret ve Refresh Token. Siparişler resmi API’den gelir. Alıcı mesajları Amazon’un e-posta bildirimleriyle gelir: Amazon e-posta adresini Mivelo’ya bağlaman yeterli (Seller Central’ı tarayıcıyla okumak Amazon politikası gereği kapalı). Pazar yeri varsayılan Türkiye.
                    </>
                  )}
                  {p === 'shopify' && (
                    <>
                      Shopify yönetici → <b>Ayarlar → Uygulamalar → Uygulama geliştir</b>: read_orders, read_customers, read_fulfillments kapsamlarıyla Admin API erişim belirteci (shpat_…). Siparişler resmi API’den gelir. Shopify Inbox sohbetleri API’de olmadığından okunmaz (hesabını riske atmamak için tarayıcıyla okuma varsayılan kapalı).
                    </>
                  )}
                </p>
                <div className="field" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  {p === 'trendyol' && (
                    <>
                      <input value={sf('sellerId')} onChange={(e) => setSf('sellerId', e.target.value)} placeholder="Satıcı ID" autoComplete="off" />
                      <input value={sf('apiKey')} onChange={(e) => setSf('apiKey', e.target.value)} placeholder="API Key" autoComplete="off" />
                      <input value={sf('apiSecret')} onChange={(e) => setSf('apiSecret', e.target.value)} placeholder="API Secret" type="password" autoComplete="off" />
                    </>
                  )}
                  {p === 'hepsiburada' && (
                    <>
                      <input value={sf('merchantId')} onChange={(e) => setSf('merchantId', e.target.value)} placeholder="Merchant ID" autoComplete="off" />
                      <input value={sf('username')} onChange={(e) => setSf('username', e.target.value)} placeholder="Entegrasyon kullanıcı adı" autoComplete="off" />
                      <input value={sf('password')} onChange={(e) => setSf('password', e.target.value)} placeholder="Şifre" type="password" autoComplete="off" />
                    </>
                  )}
                  {p === 'etsy' && (
                    <>
                      <input value={sf('keystring')} onChange={(e) => setSf('keystring', e.target.value)} placeholder="Keystring (API key)" autoComplete="off" />
                      <input value={sf('shopId')} onChange={(e) => setSf('shopId', e.target.value)} placeholder="Shop ID (isteğe bağlı)" autoComplete="off" />
                    </>
                  )}
                  {p === 'n11' && (
                    <>
                      <input value={sf('appKey')} onChange={(e) => setSf('appKey', e.target.value)} placeholder="App Key" autoComplete="off" />
                      <input value={sf('appSecret')} onChange={(e) => setSf('appSecret', e.target.value)} placeholder="App Secret" type="password" autoComplete="off" />
                    </>
                  )}
                  {p === 'amazon' && (
                    <>
                      <input value={sf('clientId')} onChange={(e) => setSf('clientId', e.target.value)} placeholder="LWA Client ID" autoComplete="off" />
                      <input value={sf('clientSecret')} onChange={(e) => setSf('clientSecret', e.target.value)} placeholder="LWA Client Secret" type="password" autoComplete="off" />
                      <input value={sf('refreshToken')} onChange={(e) => setSf('refreshToken', e.target.value)} placeholder="Refresh Token" type="password" autoComplete="off" />
                      <input value={sf('marketplaceId')} onChange={(e) => setSf('marketplaceId', e.target.value)} placeholder="Marketplace ID (boş: Türkiye A33AVAJ2PDY3EV)" autoComplete="off" />
                    </>
                  )}
                  {p === 'shopify' && (
                    <>
                      <input value={sf('shop')} onChange={(e) => setSf('shop', e.target.value)} placeholder="magaza.myshopify.com" autoComplete="off" />
                      <input value={sf('accessToken')} onChange={(e) => setSf('accessToken', e.target.value)} placeholder="Admin API erişim belirteci (shpat_…)" type="password" autoComplete="off" />
                    </>
                  )}
                  <button className="btn lime b" onClick={() => add(p)} disabled={busy}>
                    Bağlan
                  </button>
                </div>
                {/* yalnız soru-cevap kanalı olan pazaryerlerinde: Etsy/Shopify/Amazon'da siparişler kapanırsa hesap boş kalır */}
                {(p === 'trendyol' || p === 'hepsiburada' || p === 'n11') && (
                  <label className="row-toggle" style={{ marginTop: 10, gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text2)' }}>Siparişleri de göster (kapatırsan yalnız müşteri soruları gelir)</span>
                    <input type="checkbox" checked={sf('ordersOff') !== 'true'} onChange={(e) => setSf('ordersOff', e.target.checked ? '' : 'true')} />
                  </label>
                )}
              </div>
            </div>
          ) : null,
        )}

        {active === 'slack:new' && (
          <div className="pairbox">
            <div style={{ flexGrow: 1 }}>
              <h3>Slack’i bağla</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                Önerilen yol resmi Slack API’si: kendi çalışma alanında yalnız sana ait küçük bir uygulama oluşturursun (ücretsiz, ~1 dk; çalışma alanı ayarlarına göre yönetici onayı isteyebilir).
              </p>
              <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.6 }}>
                <li>
                  <span>
                    <a href={SLACK_APP_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--v-txt)' }}>
                      <b>Slack’te Mivelo uygulamasını oluştur</b>
                    </a>{' '}
                    → çalışma alanını seç → <b>Next</b> → <b>Create</b> (izinler hazır gelir)
                  </span>
                </li>
                <li>
                  <span>
                    Sol menüde <b>Install App → Install to Workspace</b> → İzin ver
                  </span>
                </li>
                <li>
                  <span>
                    Çıkan <b>User OAuth Token</b>’ı (<code>xoxp-…</code>) aşağıya yapıştır
                  </span>
                </li>
                <li>
                  <span>
                    İsteğe bağlı, mesajların anında gelmesi için: <b>Basic Information → App-Level Tokens → Generate</b> (kapsam: <code>connections:write</code>) → <code>xapp-…</code>
                  </span>
                </li>
              </ol>
              <div className="field" style={{ marginTop: 12, gap: 8 }}>
                <input value={slackTok.user} onChange={(e) => setSlackTok({ ...slackTok, user: e.target.value })} placeholder="User OAuth Token (xoxp-…)" type="password" autoComplete="off" />
                <input value={slackTok.app} onChange={(e) => setSlackTok({ ...slackTok, app: e.target.value })} placeholder="App-Level Token (xapp-…, isteğe bağlı)" type="password" autoComplete="off" />
                <button className="btn lime b" onClick={() => add('slack')} disabled={busy || !slackTok.user.trim().startsWith('xoxp-') || (!!slackTok.app.trim() && !slackTok.app.trim().startsWith('xapp-'))}>
                  Bağlan
                </button>
              </div>
              <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text3, var(--text2))', lineHeight: 1.5 }}>
                Uygulama oluşturamıyorsan{' '}
                <a href="#browser" onClick={(e) => (e.preventDefault(), void add('slack', { browser: true }))} style={{ color: 'var(--v-txt)', fontWeight: 600 }}>
                  tarayıcı girişiyle bağlan
                </a>{' '}
                (resmi değil, yedek yol: Slack web oturumun kullanılır).
              </p>
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
                {PLATFORMS[activeAccount.platform].name}
                {activeAccount.label && activeAccount.label !== PLATFORMS[activeAccount.platform].name && ` · ${activeAccount.label}`}
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
              {activeAccount.platform === 'imessage' && activeAccount.status === 'error' && !macOnlyOff('imessage') && (
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

              {(activeAccount.status === 'error' || activeAccount.status === 'disconnected') && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(PLATFORMS[activeAccount.platform].mode === 'mail' || PLATFORMS[activeAccount.platform].category === 'shop' || /uygulama şifresi|giriş reddedildi/i.test(activeAccount.detail ?? '')) && (
                    <button className="btn primary b" onClick={() => editCredentials(activeAccount)}>
                      <Icon name="lock" size={14} sw={2} /> {PLATFORMS[activeAccount.platform].category === 'shop' ? 'Bilgileri güncelle' : 'Şifreyi güncelle'}
                    </button>
                  )}
                  <button className="btn darksec b" onClick={() => api.restartAccount(activeAccount.id).catch((e) => notify(e.message, true))}>
                    <Icon name="refresh" size={14} sw={2} /> Yeniden dene
                  </button>
                </div>
              )}
              {activeAccount.status === 'connected' && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--text2)' }}>Bağlı. {PLATFORMS[activeAccount.platform].category === 'shop' ? 'Siparişler ve müşteri soruları' : 'Sohbetler'} gelen kutusuna akıyor{PLATFORMS[activeAccount.platform].mode === 'browser' ? '; tarayıcı arka planda görünmez çalışıyor' : ''}.</p>
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
            // ':choose' (Gmail/iCloud giriş yolu seçimi) de bu kartın panelini açar
            const isActive = acc.some((a) => a.id === active) || active === `${p}:new` || active === `${p}:choose`;
            const macOnly = macOnlyOff(p);
            // yalnız Mac kanalı: yeni bağlantı kapalı; eskiden kalan hesap varsa kaldırılabilsin
            const available = meta.available && (!macOnly || acc.length > 0);
            return (
              <div key={p} style={{ display: 'contents' }}>
                {p === 'whatsapp' && (
                  <>
                    <div className="grid-head">
                      <Icon name="users" size={16} sw={2} /> Sosyal Medya
                    </div>
                    <p className="grid-note">
                      “Resmi değil” etiketli kanallar kişisel hesaplar için API sunmadığı için senin oturumunla, kendi bilgisayarından bağlanır. Mivelo istekleri seyrek ve düzensiz tutar,
                      toplu ya da aşırı gönderimi kendiliğinden durdurur. Yine de bu uygulamaların kurallarına göre otomatik veya toplu mesaj gönderme.
                    </p>
                  </>
                )}
                {p === 'gmail' && (
                  <div className="grid-head">
                    <Icon name="mail" size={16} sw={2} /> E-posta
                  </div>
                )}
                {p === 'trendyol' && (
                  <div className="grid-head">
                    <Icon name="bag" size={16} sw={2} /> Alışveriş
                  </div>
                )}
              <div className={`pcard ${!available ? 'soon' : ''} ${isActive ? 'active' : ''}`}>
                <div className="top">
                  <Chip platform={p} size={44} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {meta.name}
                      {meta.experimental && <span className="pill" style={{ background: 'var(--amber-bg)', color: 'var(--amber-txt)' }}>deneysel</span>}
                      {UNOFFICIAL[p] && (
                        <span className="pill" style={{ background: 'var(--tabs-bg)', color: 'var(--text2)' }} title={UNOFFICIAL[p]}>
                          resmi değil
                        </span>
                      )}
                    </div>
                    <div className="mt">{macOnly ? 'Yalnız macOS · Mesajlar uygulaması' : meta.method}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {available && (acc.length ? (
                    <span className="st" style={{ color: isConn ? 'var(--green-txt)' : undefined, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexGrow: 1 }}>
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
                  {available && acc.length > 0 && (
                    <>
                      <button className="btn sm b b2" onClick={() => setActive(acc[0].id)}>
                        Ayrıntı
                      </button>
                      <button className={`btn sm icon b b2 ${confirmId === acc[0].id ? 'danger-solid' : ''}`} onClick={() => remove(acc[0].id)} aria-label="Kaldır" title={confirmId === acc[0].id ? 'Onaylamak için tekrar tıkla' : 'Kaldır'}>
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                  {available && acc.length === 0 && (
                    <button className="btn sm primary b" onClick={() => add(p)} disabled={busy}>
                      Bağlan
                    </button>
                  )}
                  {!available && (
                    <button className="btn sm b b2" disabled title={macOnly ? 'iMessage yalnızca macOS’teki Mesajlar uygulamasıyla çalışır' : undefined}>
                      {macOnly ? 'Yalnız Mac' : 'Yakında'}
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
