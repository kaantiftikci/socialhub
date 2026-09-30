import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { clearOpening, markOpening } from './login-opening';
import { api, USE_STATIC } from './api';
import { DEMO_OFFLINE, STATIC_DEMO } from './profile';
import { openDemoLoginWindow, staticApi } from './static-demo';
import { MAC_ONLY, MAIL_LOGIN_WHO, PLATFORMS, type Account, type CoreOs, type Platform } from './types';
import { Chip, Icon, PasswordInput, SyncBar, syncPercent } from './ui';
import { EASE, animate, reducedMotion } from './motion/motion';

const ORDER: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger', 'tiktok'];
const MAIL_ORDER: Platform[] = ['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap'];
/**
 * Bağlan akışı: uygulamaya kullanıcı adı / şifre YAZILMAZ (Kaan, 29.09). Sosyal medya ve e-posta kendi giriş penceresinde
 * (tarayıcı girişi) ya da QR ile bağlanır; ara form, seçim kutusu ve "Gelişmiş" yollar yok. Yalnız pazaryerlerinin API'si
 * satıcı panelindeki entegrasyon bilgileriyle (API anahtarı) çalışır: o formlar kalır.
 */
const SHOP_ORDER: Platform[] = ['trendyol', 'hepsiburada', 'n11', 'pttavm', 'etsy', 'shopify', 'amazon'];
/** Pazaryeri formlarının zorunlu alanları (satıcı panelindeki entegrasyon bilgileri) */
const SHOP_FIELDS: Partial<Record<Platform, string[]>> = { trendyol: ['sellerId', 'apiKey', 'apiSecret'], hepsiburada: ['merchantId', 'serviceKey', 'userAgent'], etsy: ['keystring', 'sharedSecret'], shopify: ['shop'], n11: ['appKey', 'appSecret'], pttavm: ['username', 'password'], amazon: ['clientId', 'clientSecret', 'refreshToken'] };

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
  // focus "edit:<hesap>" → pazaryeri hesabının entegrasyon bilgileri formu (API anahtarı yenileme)
  const editOf = focus?.startsWith('edit:') ? accounts.find((a) => a.id === focus.slice(5) && PLATFORMS[a.platform].category === 'shop') : undefined;
  const [active, setActive] = useState<string | null>(editOf ? `${editOf.platform}:new` : focus?.startsWith('edit:') ? focus.slice(5) : (focus ?? null)); // account id
  /** pazaryeri hesabının API bilgilerini yeniden gir: yeni hesap formu açılır (kaydedince çekirdek var olan hesabı günceller) */
  const editCredentials = (a: Account) => setActive(`${a.platform}:new`);
  const [pat, setPat] = useState('');
  /** Pazar yeri formları (Trendyol/Hepsiburada/Etsy/Shopify): alan adı → değer */
  const [shop, setShop] = useState<Record<string, string>>({});
  const sf = (k: string) => shop[k] ?? '';
  const setSf = (k: string, v: string) => setShop((p) => ({ ...p, [k]: v }));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const activeAccount = accounts.find((a) => a.id === active);

  // ---- hareket (s11 + s4b): pencere yükselerek açılır, kartlar dalga halinde; kapanışta hızlanarak iner ----
  const ovRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const ov = ovRef.current;
    animate(ov, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE.std });
    animate(ov?.querySelector('.modal'), [{ opacity: 0, transform: 'translateY(14px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE.in });
    // yalnız görünen ilk ~24 kart; toplam yayılım < 500 ms
    const cards = [...(gridRef.current?.querySelectorAll('.pcard') ?? [])].slice(0, 24);
    cards.forEach((c, i) =>
      animate(c, [{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 80 + Math.min(i, 18) * 22, easing: EASE.in, fill: 'backwards' }),
    );
  }, []);
  const exit = useRef<Array<Animation | null>>([]);
  useLayoutEffect(() => {
    exit.current.forEach((a) => a?.cancel()); // kapanırken yeniden açıldıysa soluk kalmasın
    exit.current = [];
    if (!closing) return;
    const ov = ovRef.current;
    exit.current = [
      animate(ov?.querySelector('.modal'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.98)' }], { duration: 180, easing: EASE.out, fill: 'forwards' }),
      animate(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE.out, fill: 'forwards' }),
    ];
  }, [closing]);
  // Kart durumu geçişleri: bağlanıyor/eşleşme → bağlı = yeşil onay çizilir + pop + parçacıklar; → hata = kısa sallanma.
  // Önceki durum ref'te; ilk çizimde (pencere açılırken zaten bağlı) animasyon yok.
  const prevStatus = useRef<Map<Platform, Account['status']> | null>(null);
  useLayoutEffect(() => {
    const now = new Map<Platform, Account['status']>();
    for (const a of accounts) {
      const cur = now.get(a.platform);
      if (!cur || STATUS_RANK[a.status] < STATUS_RANK[cur]) now.set(a.platform, a.status);
    }
    const prev = prevStatus.current;
    prevStatus.current = now;
    if (!prev || reducedMotion()) return;
    for (const [p, s] of now) {
      const was = prev.get(p);
      if (!was || was === s) continue;
      const card = gridRef.current?.querySelector<HTMLElement>(`.pcard[data-p="${p}"]`);
      if (!card) continue;
      if (s === 'connected' && (was === 'connecting' || was === 'pairing')) celebrate(card);
      else if (s === 'error') shake(card);
    }
  }, [accounts]);
  /**
   * Bu pencerede "Bağlan" ile başlatılan hesaplar: pencere kapanınca hâlâ QR/giriş bekleyen QR'lı hesap (WhatsApp, Telegram;
   * demoda tüm bekleyenler) iptal edilir — hiç bağlanmamış yeni hesap kaldırılır, Bağlan kartı ilk haline döner. Tarayıcıyla
   * girilen uygulamaların ayrı giriş penceresi bağımsızdır: onu kapatmak çekirdekte iptal eder.
   */
  const startedHere = useRef(new Set<string>());
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  useEffect(
    () => () => {
      for (const id of startedHere.current) {
        const a = accountsRef.current.find((x) => x.id === id);
        if (!a || a.status === 'connected') continue;
        // tek dosya demoda tarayıcı girişi de bu pencerenin içindeki formda (DemoLogin): pencere kapanınca o da iptal
        if (QR_CANCEL.has(a.platform) || (DEMO_OFFLINE && PLATFORMS[a.platform].mode === 'browser')) void api.cancelLogin(id).catch(() => undefined);
      }
    },
    [],
  );
  // Başka bir pazaryerinin formuna geçince alanlar sıfırlansın ve açılan panel görünür alana kaydırılsın
  useEffect(() => {
    setShop({});
    setPat('');
    if (!active) return;
    requestAnimationFrame(() => document.querySelector('.overlay .pairbox')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [active]);
  /** Çekirdeğin OS'u: iMessage gibi yalnız Mac kanalları Windows/Linux çekirdeğinde pasif */
  const [coreOs, setCoreOs] = useState<CoreOs | undefined>();
  useEffect(() => {
    api.health().then((h) => setCoreOs(h.os)).catch(() => undefined);
  }, []);
  const macOnlyOff = (p: Platform) => MAC_ONLY.has(p) && !!coreOs && coreOs !== 'darwin';

  /**
   * Bağlan: WhatsApp/Telegram QR, sosyal medya ve e-posta sağlayıcıları kendi giriş penceresi (hemen açılır), iMessage bu Mac.
   * Pazaryerleri: önce entegrasyon bilgileri formu, doldurulunca bağlanır.
   */
  async function add(platform: Platform) {
    setBusy(true);
    try {
      if (platform === 'shopier' && (active !== 'shopier:new' || !pat.trim())) {
        setActive('shopier:new');
        return;
      }
      const shopFields = SHOP_FIELDS[platform];
      // Shopify: yeni Dev Dashboard uygulaması (istemci kimliği + gizli anahtar) ya da eski shpat_ erişim anahtarı
      if (platform === 'shopify' && active === 'shopify:new' && sf('shop').trim() && !sf('accessToken').trim() && !(sf('clientId').trim() && sf('clientSecret').trim())) {
        notify('İstemci kimliği + gizli anahtar ya da erişim anahtarı gir', true);
        return;
      }
      if (shopFields && (active !== `${platform}:new` || shopFields.some((k) => !sf(k).trim()))) {
        setActive(`${platform}:new`);
        return;
      }
      // Demo sitesi: pazaryeri formu doldurulunca hesap örnek veriyle bağlanır (girilenler saklanmaz); diğerlerinde QR / giriş penceresi
      if (USE_STATIC) {
        const filled = !!shopFields || platform === 'shopier';
        const a = await api.addAccount(platform, filled ? 'demo-form' : undefined);
        if (a.status !== 'connected') startedHere.current.add(a.id);
        setActive(a.id);
        // gerçek uygulamadaki gibi giriş penceresi hemen açılır (engellenirse "Giriş ekranını aç" düğmesi)
        if (!DEMO_OFFLINE && a.status === 'pairing' && PLATFORMS[platform].mode === 'browser' && !openDemoLoginWindow(a)) notify('Giriş penceresi engellendi; "Giriş ekranını aç"a bas', true);
        setShop({});
        setPat('');
        await onChanged();
        return;
      }
      let token: string | undefined;
      if (platform === 'shopier') token = pat.trim();
      if (shopFields) {
        const cfg: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(shop)) if (v.trim()) cfg[k] = v.trim();
        if (shop.ordersOff === 'true') cfg.ordersOff = true; // varsayılan: siparişler + müşteri soruları
        token = JSON.stringify(cfg);
      }
      // token'sız e-posta/sosyal medya: çekirdek sağlayıcının kendi giriş penceresini hemen açar (tarayıcı girişi)
      const a = await api.addAccount(platform, token);
      if (a.status !== 'connected') startedHere.current.add(a.id);
      setActive(a.id);
      await onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  async function remove(id: string) {
    if (removingId) return;
    if (confirmId !== id) {
      setConfirmId(id);
      window.setTimeout(() => setConfirmId((c) => (c === id ? null : c)), 4000);
      return;
    }
    setConfirmId(null);
    setRemovingId(id);
    try {
      // çekirdek hesabı hemen listeden kaldırıp yanıt verir (çıkış/silme arka planda); account.removed olayı kartı günceller
      await api.removeAccount(id);
      if (active === id) setActive(null);
      notify('Kaldırıldı');
      void onChanged();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setRemovingId(null);
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
        {active === 'shopier:new' && (
          <div className="pairbox">
            <div style={{ flexGrow: 1 }}>
              <h3>Shopier’i bağla</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                Shopier panelinde <b>Hesap Yönetimi → Kişisel Erişim Anahtarı</b>'ndan bir anahtar oluştur ve buraya yapıştır.
              </p>
              <div className="field" style={{ marginTop: 12 }}>
                <PasswordInput value={pat} onChange={(e) => setPat(e.target.value)} placeholder="API erişim anahtarı" autoComplete="off" />
                <button className="btn lime b" onClick={() => add('shopier')} disabled={busy || !pat.trim()}>
                  Bağlan
                </button>
              </div>
            </div>
          </div>
        )}

        {(['trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm'] as Platform[]).map((p) =>
          active === `${p}:new` ? (
            <div className="pairbox" key={p}>
              <div style={{ flexGrow: 1 }}>
                <h3>{PLATFORMS[p].name}’{p === 'etsy' ? 'yi' : p === 'shopify' ? 'ı' : p === 'trendyol' ? 'u' : p === 'n11' ? 'i' : p === 'amazon' ? 'u' : p === 'pttavm' ? 'i' : 'yı'} bağla</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {p === 'trendyol' && (
                    <>
                      Trendyol Satıcı Paneli → <b>Hesap Bilgilerim → Entegrasyon Bilgileri</b>'ndeki üç API bilgisini gir.
                    </>
                  )}
                  {p === 'hepsiburada' && (
                    <>
                      Hepsiburada Satıcı Paneli → <b>Entegrasyon → Entegrasyon bilgileri</b>'ndeki Merchant ID, servis anahtarı ve kullanıcı adını gir.
                    </>
                  )}
                  {p === 'etsy' && (
                    <>
                      Etsy geliştirici sayfasında oluşturduğun uygulamanın anahtarını gir; Bağlan deyince Etsy girişi açılır.
                    </>
                  )}
                  {p === 'pttavm' && (
                    <>
                      ePttAVM Satıcı Paneli → <b>Hesap Yönetimi → Entegrasyon Bilgileri</b>'ndeki iki API bilgisini gir. Siparişlerin burada görünür.
                    </>
                  )}
                  {p === 'n11' && (
                    <>
                      n11 Mağaza Paneli → <b>Ayarlar → API Bilgileri</b>'ndeki iki API bilgisini gir.
                    </>
                  )}
                  {p === 'amazon' && (
                    <>
                      Seller Central → <b>Uygulamalar ve Hizmetler → Uygulama geliştir</b>'den aldığın API bilgilerini gir.
                    </>
                  )}
                  {p === 'shopify' && (
                    <>
                      Shopify <b>Dev Dashboard</b>'da uygulama oluştur, mağazana kur; istemci kimliği ve gizli anahtarı gir (eski özel uygulaman varsa shpat_ anahtarı da olur).
                    </>
                  )}
                </p>
                <div className="field" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  {p === 'trendyol' && (
                    <>
                      <input value={sf('sellerId')} onChange={(e) => setSf('sellerId', e.target.value)} placeholder="Satıcı ID" autoComplete="off" />
                      <input value={sf('apiKey')} onChange={(e) => setSf('apiKey', e.target.value)} placeholder="API Key" autoComplete="off" />
                      <PasswordInput value={sf('apiSecret')} onChange={(e) => setSf('apiSecret', e.target.value)} placeholder="API Secret" autoComplete="off" />
                    </>
                  )}
                  {p === 'hepsiburada' && (
                    <>
                      <input value={sf('merchantId')} onChange={(e) => setSf('merchantId', e.target.value)} placeholder="Merchant ID" autoComplete="off" />
                      <PasswordInput value={sf('serviceKey')} onChange={(e) => setSf('serviceKey', e.target.value)} placeholder="Servis anahtarı" autoComplete="off" />
                      <input value={sf('userAgent')} onChange={(e) => setSf('userAgent', e.target.value)} placeholder="Entegratör kullanıcı adı" autoComplete="off" />
                    </>
                  )}
                  {p === 'etsy' && (
                    <>
                      <input value={sf('keystring')} onChange={(e) => setSf('keystring', e.target.value)} placeholder="Uygulama anahtarı (Keystring)" autoComplete="off" />
                      <PasswordInput value={sf('sharedSecret')} onChange={(e) => setSf('sharedSecret', e.target.value)} placeholder="Paylaşılan gizli anahtar (Shared secret)" autoComplete="off" />
                      <input value={sf('shopId')} onChange={(e) => setSf('shopId', e.target.value)} placeholder="Shop ID (isteğe bağlı)" autoComplete="off" />
                    </>
                  )}
                  {p === 'pttavm' && (
                    <>
                      <input value={sf('username')} onChange={(e) => setSf('username', e.target.value)} placeholder="Entegrasyon kullanıcı adı" autoComplete="off" />
                      <PasswordInput value={sf('password')} onChange={(e) => setSf('password', e.target.value)} placeholder="Entegrasyon anahtarı" autoComplete="off" />
                    </>
                  )}
                  {p === 'n11' && (
                    <>
                      <input value={sf('appKey')} onChange={(e) => setSf('appKey', e.target.value)} placeholder="App Key" autoComplete="off" />
                      <PasswordInput value={sf('appSecret')} onChange={(e) => setSf('appSecret', e.target.value)} placeholder="App Secret" autoComplete="off" />
                    </>
                  )}
                  {p === 'amazon' && (
                    <>
                      <input value={sf('clientId')} onChange={(e) => setSf('clientId', e.target.value)} placeholder="LWA Client ID" autoComplete="off" />
                      <PasswordInput value={sf('clientSecret')} onChange={(e) => setSf('clientSecret', e.target.value)} placeholder="LWA Client Secret" autoComplete="off" />
                      <PasswordInput value={sf('refreshToken')} onChange={(e) => setSf('refreshToken', e.target.value)} placeholder="Refresh Token" autoComplete="off" />
                      <input value={sf('marketplaceId')} onChange={(e) => setSf('marketplaceId', e.target.value)} placeholder="Pazar yeri (boş bırak: Türkiye)" autoComplete="off" />
                    </>
                  )}
                  {p === 'shopify' && (
                    <>
                      <input value={sf('shop')} onChange={(e) => setSf('shop', e.target.value)} placeholder="magaza.myshopify.com" autoComplete="off" />
                      <input value={sf('clientId')} onChange={(e) => setSf('clientId', e.target.value)} placeholder="İstemci kimliği (Client ID)" autoComplete="off" />
                      <PasswordInput value={sf('clientSecret')} onChange={(e) => setSf('clientSecret', e.target.value)} placeholder="Gizli anahtar (Client secret)" autoComplete="off" />
                      <PasswordInput value={sf('accessToken')} onChange={(e) => setSf('accessToken', e.target.value)} placeholder="ya da eski erişim anahtarı (shpat_…)" autoComplete="off" />
                    </>
                  )}
                  <button className="btn lime b" onClick={() => add(p)} disabled={busy}>
                    Bağlan
                  </button>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.5 }}>
                  Bunlar mağaza hesabının giriş bilgileri değil; satıcı panelinin API için verdiği entegrasyon bilgileri. Yalnız bu bilgisayarda saklanır.
                </p>
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
                {accountLabel(activeAccount) && ` · ${accountLabel(activeAccount)}`}
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

              {USE_STATIC && (activeAccount.platform === 'whatsapp' || activeAccount.platform === 'telegram') && activeAccount.status === 'pairing' && (
                <DemoQrDone account={activeAccount} onDone={onChanged} />
              )}

              {activeAccount.platform === 'telegram' && activeAccount.status === 'pairing' && !prompts[activeAccount.id] && (
                <ol>
                  <li>Telefonunda Telegram’ı aç</li>
                  <li>
                    <b>Ayarlar → Cihazlar → Masaüstü Cihazı Bağla</b>
                  </li>
                  <li>Kamerayı bu koda tut</li>
                </ol>
              )}

              {DEMO_OFFLINE && PLATFORMS[activeAccount.platform].mode === 'browser' && activeAccount.status === 'pairing' && <DemoLogin account={activeAccount} onDone={onChanged} />}
              {!DEMO_OFFLINE && PLATFORMS[activeAccount.platform].mode === 'browser' && activeAccount.status !== 'connected' && (
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
                      if (USE_STATIC) {
                        if (!openDemoLoginWindow(activeAccount)) notify('Giriş penceresi engellendi; tarayıcıda açılır pencerelere izin ver', true);
                        return;
                      }
                      setBusy(true);
                      markOpening(activeAccount.id, 'Giriş penceresi açılıyor');
                      // e-posta: uygulama şifreli eski hesap da sağlayıcının giriş penceresine geçer
                      api.restartAccount(activeAccount.id, MAIL_LOGIN_WHO[activeAccount.platform] ? { browserLogin: true } : undefined).catch((e) => (clearOpening(activeAccount.id), notify(e.message, true), onChanged())).finally(() => setBusy(false));
                    }}
                  >
                    <Icon name="refresh" size={14} sw={2} color="#fff" /> Giriş ekranını aç
                  </button>
                  <ol>
                    <li>Açılan giriş ekranında {PLATFORMS[activeAccount.platform].name} hesabına giriş yap</li>
                    <li>Giriş tamamlanınca ekran kendiliğinden kapanır</li>
                  </ol>
                </>
              )}
              {activeAccount.platform === 'imessage' && activeAccount.status === 'error' && !macOnlyOff('imessage') && (
                <ol>
                  <li>Sistem Ayarları → Gizlilik ve Güvenlik → <b>Tam Disk Erişimi</b>'ni aç</li>
                  <li>Listede <b>Mivelo</b>'yu (yoksa Terminal'i) aç</li>
                  <li>Mivelo'yu yeniden başlatıp <b>Yeniden dene</b>'ye bas</li>
                </ol>
              )}
              {activeAccount.platform === 'telegram' && prompts[activeAccount.id] && activeAccount.status === 'pairing' && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13.5 }}>{prompts[activeAccount.id].message}</p>
                  <div className="field">
                    <InputOrPassword
                      password={prompts[activeAccount.id].prompt === 'password'}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
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
                  {PLATFORMS[activeAccount.platform].category === 'shop' && (
                    <button className="btn primary b" onClick={() => editCredentials(activeAccount)}>
                      <Icon name="lock" size={14} sw={2} /> API bilgilerini güncelle
                    </button>
                  )}
                  <button className="btn darksec b" onClick={() => api.restartAccount(activeAccount.id).catch((e) => notify(e.message, true))}>
                    <Icon name="refresh" size={14} sw={2} /> Yeniden dene
                  </button>
                </div>
              )}
              {activeAccount.status === 'connected' && activeAccount.attention && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--danger)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <Icon name="alert" size={15} sw={2.2} /> {activeAccount.attention}
                </p>
              )}
              {activeAccount.status === 'connected' && !activeAccount.attention && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--text2)' }}>Bağlı. {PLATFORMS[activeAccount.platform].category === 'shop' ? 'Siparişler ve müşteri soruları' : 'Sohbetler'} gelen kutusuna geliyor.</p>
              )}
            </div>
          </div>
        )}

    </>
  );

  return (
    <div className={`overlay connect-ov ${closing ? 'closing' : ''}`} ref={ovRef} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Uygulama bağla">
        {/* kapatma düğmesi kaydırılan alanın DIŞINDA: aşağı inince de görünür */}
        <button className="btn icon b b2 modal-x" onClick={onClose} aria-label="Kapat">
          <Icon name="x" size={15} sw={2} />
        </button>
        <div className="modal-scroll">
        <div style={{ paddingRight: 52 }}>
          <h2>
            Bütün sohbetlerin, <mark>tek bir yerde.</mark>
          </h2>
        </div>

        <div className="grid3" ref={gridRef}>
          {[...ORDER, ...MAIL_ORDER, ...SHOP_ORDER].map((p) => {
            const meta = PLATFORMS[p];
            // kartın durumu en iyi durumdaki hesaptan (bağlı olan önde); ilk kaydı göstermek bağlı hesabın yanında "Bağlı değil" yazıyordu
            const acc = accounts.filter((a) => a.platform === p).sort((x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status]);
            // Diğer e-posta (IMAP): web girişi yok, şifre uygulamaya yazılmaz → yeni bağlantı yok; eskiden kalan hesap kaldırılabilsin
            if (p === 'imap' && acc.length === 0) return null;
            const isConn = connected.includes(p);
            const isActive = acc.some((a) => a.id === active) || active === `${p}:new`;
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
                      Bu uygulamalara kendi hesabınla giriş yaparak bağlanırsın. Toplu ya da otomatik mesaj göndermek için kullanma.
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
              <div className={`pcard ${!available ? 'soon' : ''} ${isActive ? 'active' : ''}`} data-p={p}>
                <div className="top">
                  <Chip platform={p} size={44} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{meta.name}</div>
                    <div className="mt" title={meta.method}>{macOnly ? 'Yalnız macOS · Mesajlar uygulaması' : accountLabel(acc[0]) ?? meta.method}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {available && (acc.length ? (
                    <span className="st" style={{ color: isConn ? 'var(--green-txt)' : undefined, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexGrow: 1 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span className={`dot ${acc[0].status === 'connected' ? 'on' : acc[0].status}`} />
                        {sync[acc[0].id] ? (sync[acc[0].id].label ?? 'Eşitleniyor') : statusText(acc[0])}
                        {acc.length > 1 && <span style={{ color: 'var(--text3)' }}>· {acc.length} hesap</span>}
                      </span>
                      {sync[acc[0].id] && <SyncBar progress={syncPercent(sync[acc[0].id])} since={sync[acc[0].id].since} />}
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
                      {/* ikinci tık onayı düğmenin kendisinde görünür (eskiden yalnız köşedeki bildirimdeydi → "Kaldır çalışmıyor" sanılıyordu) */}
                      <button
                        className={`btn sm b b2 ${confirmId === acc[0].id ? 'danger-solid' : 'icon'}`}
                        onClick={() => remove(acc[0].id)}
                        disabled={removingId === acc[0].id}
                        aria-label={confirmId === acc[0].id ? 'Kaldırmayı onayla' : 'Kaldır'}
                        title={confirmId === acc[0].id ? 'Onaylamak için tekrar tıkla' : 'Kaldır'}
                      >
                        <Icon name="trash" size={13} />
                        {removingId === acc[0].id ? ' Kaldırılıyor…' : confirmId === acc[0].id ? ' Emin misin? Kaldır' : null}
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

/** Bağlandı: kanal logosunun üstünde yeşil daire pop'la belirir, onay çizilir, 8 parçacık saçılır; sonra kendiliğinden kalkar */
function celebrate(card: HTMLElement): void {
  const chip = card.querySelector('.top > :first-child');
  if (!chip) return;
  card.querySelector('.pc-burst')?.remove();
  const cr = card.getBoundingClientRect(),
    r = chip.getBoundingClientRect();
  const burst = document.createElement('span');
  burst.className = 'pc-burst';
  burst.setAttribute('aria-hidden', 'true');
  burst.style.left = `${r.left - cr.left - card.clientLeft}px`;
  burst.style.top = `${r.top - cr.top - card.clientTop}px`;
  burst.style.width = `${r.width}px`;
  burst.style.height = `${r.height}px`;
  burst.innerHTML =
    '<span class="pc-done"><svg width="60%" height="60%" viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="pc-bits"></span>';
  card.appendChild(burst);
  const done = burst.querySelector('.pc-done'),
    ck = burst.querySelector('path'),
    bits = burst.querySelector('.pc-bits')!;
  animate(done, [{ transform: 'scale(0)' }, { transform: 'none' }], { duration: 320, easing: EASE.pop, fill: 'forwards' });
  if (ck) {
    const l = ck.getTotalLength();
    ck.style.strokeDasharray = String(l);
    animate(ck, [{ strokeDashoffset: l }, { strokeDashoffset: 0 }], { duration: 220, delay: 180, easing: EASE.std, fill: 'both' });
  }
  const cols = ['var(--v)', 'var(--lime)', 'var(--green-txt)', '#27A7E7'];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2,
      d = r.width * 0.75 + (i % 2) * 8,
      b = document.createElement('i');
    b.style.background = cols[i % 4];
    bits.appendChild(b);
    animate(b, [{ opacity: 0, transform: 'translate(0,0) scale(.4)' }, { opacity: 1, offset: 0.2 }, { opacity: 0, transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(1)` }], { duration: 520, delay: 200, easing: EASE.in, fill: 'both' });
  }
  // onay bir süre görünür, sonra solar ve gerçek logo geri gelir
  const out = animate(burst, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 1400, easing: EASE.out, fill: 'forwards' });
  const rm = () => burst.remove();
  if (out) out.finished.then(rm, rm);
  else rm();
}

/** Hata: kart ±8 px kısa sallanır (360 ms; yalnız transform, taşma yok) */
function shake(card: HTMLElement): void {
  animate(card, [{ transform: 'none' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], { duration: 360, easing: 'ease-in-out' });
}

/** Eski sürümlerin yazdığı hatalı etiketler (Facebook hata sayfası başlığı, Outlook localStorage anahtarı) */
export const BAD_LABEL = /^(error|hata)$|^olk-|pivot/i;

/** Bağlı hesabın adresi / kullanıcı adı (etiket platform adından ibaretse yok) */
function accountLabel(a: Account | undefined): string | undefined {
  if (!a?.label) return undefined;
  const name = PLATFORMS[a.platform]?.name ?? '';
  const l = a.label.trim().replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·\\s*`, 'i'), '');
  const generic = [a.platform, PLATFORMS[a.platform]?.name, 'Gmail', 'Outlook', 'Yahoo Mail', 'iCloud Mail', 'Messenger', 'Instagram', 'X', 'LinkedIn', 'Slack', 'WhatsApp', 'Telegram', 'iMessage'];
  return l && !BAD_LABEL.test(l) && !generic.some((g) => g && g.toLowerCase() === l.toLowerCase()) ? l : undefined;
}

const STATUS_RANK: Record<Account['status'], number> = { connected: 0, connecting: 1, pairing: 2, error: 3, disconnected: 4 };
/** Bağlan penceresi kapanınca bekleyen bağlanması iptal edilen (eşleştirmesi bu pencerede görünen) QR'lı uygulamalar */
const QR_CANCEL = new Set<Platform>(['whatsapp', 'telegram']);

function statusText(a: Account): string {
  if (a.autoRetry && a.status !== 'connected') return 'Yeniden bağlanılıyor…';
  return { connected: 'Bağlı', connecting: 'Bağlanıyor…', pairing: 'Eşleşme bekleniyor', disconnected: 'Bağlı değil', error: 'Hata' }[a.status];
}

/** Hesap istemi (telefon/kod/2FA): parola isteniyorsa göz düğmeli alan */
function InputOrPassword({ password, ...rest }: { password: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return password ? <PasswordInput {...rest} /> : <input {...rest} type="text" />;
}

/**
 * Tek dosya demo (açılır giriş penceresi yok): gerçek uygulamada sağlayıcının KENDİ giriş penceresi açılır ve giriş orada yapılır.
 * Mivelo içinde kullanıcı adı / şifre alanı YOK (Kaan, 29.09); düğme girişi tamamlanmış sayıp hesabı örnek veriyle bağlar.
 */
function DemoLogin({ account, onDone }: { account: Account; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const name = PLATFORMS[account.platform].name;
  const finish = async () => {
    setBusy(true);
    try {
      await (staticApi as { demoLogin: (id: string) => Promise<void> }).demoLogin(account.id);
      await onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="demo-login">
      <div className="demo-login-head">
        <Chip platform={account.platform} size={22} />
        <b>{name} giriş penceresi</b>
      </div>
      <p className="demo-login-note">Uygulamada {name}’in kendi giriş penceresi açılır; giriş orada yapılır, şifren Mivelo’ya yazılmaz.</p>
      <button className="btn primary sm b" type="button" disabled={busy} onClick={() => void finish()}>
        {busy ? <span className="spin" /> : 'Girişi tamamla (demo)'}
      </button>
    </div>
  );
}

/** Demo QR: örnek kod telefonla okutulamaz; eşleşme kullanıcı onaylayınca tamamlanır (kendiliğinden bağlanmaz) */
function DemoQrDone({ account, onDone }: { account: Account; onDone: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="demo-qr-done">
      <button
        className="btn primary sm b"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await (staticApi as { demoLogin: (id: string) => Promise<void> }).demoLogin(account.id);
            await onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <span className="spin" /> : 'Kodu okuttum'}
      </button>
      <span>Demo: bu örnek kod telefonla okutulamaz; eşleştirmeyi tamamlamak için bas.</span>
    </div>
  );
}
