import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { clearOpening, markOpening } from './login-opening';
import { api, USE_STATIC, type FlowView } from './api';
import { isTauri, openExternal } from './desktop';
import { DEMO_OFFLINE, STATIC_DEMO } from './profile';
import { openDemoLoginWindow, staticApi } from './static-demo';
import { MAC_ONLY, MAIL_LOGIN_WHO, PLATFORMS, type Account, type CoreOs, type Platform } from './types';
import { Chip, Icon, PasswordInput, SyncBar, syncPercent } from './ui';
import { EASE, animate, reducedMotion } from './motion/motion';

const ORDER: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger', 'tiktok'];
const MAIL_ORDER: Platform[] = ['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap'];
/**
 * Bağlan akışı: sağlayıcının resmi girişi açıksa (Gmail/Outlook/Yahoo/Yandex, Slack, Instagram/Messenger profesyonel) giriş
 * sağlayıcının kendi sayfasında, varsayılan tarayıcıda yapılır; hesap giriş bitince eklenir. Kapalıysa eski yol: tarayıcı girişi
 * ya da QR. Şifre yalnız iCloud (uygulamaya özel parola) ve Diğer e-posta (IMAP) formunda, pazaryerlerinde API bilgileri.
 */
const SHOP_ORDER: Platform[] = ['trendyol', 'hepsiburada', 'n11', 'pttavm', 'etsy', 'shopify', 'amazon'];
/** Pazaryeri formlarının zorunlu alanları (satıcı panelindeki entegrasyon bilgileri) */
const SHOP_FIELDS: Partial<Record<Platform, string[]>> = { trendyol: ['sellerId', 'apiKey', 'apiSecret'], hepsiburada: ['merchantId', 'serviceKey', 'userAgent'], etsy: ['keystring', 'sharedSecret'], shopify: ['shop'], n11: ['appKey', 'appSecret'], pttavm: ['username', 'password'], amazon: ['clientId', 'clientSecret', 'refreshToken'] };
/** Resmi giriş (OAuth) adayı uygulamalar → giriş sayfasının sahibi; hangilerinin açık olduğunu çekirdek söyler (/api/oauth/providers) */
const OFFICIAL_WHO: Partial<Record<Platform, string>> = { gmail: 'Google', outlook: 'Microsoft', yahoo: 'Yahoo', yandex: 'Yandex', slack: 'Slack', instagram: 'Instagram', messenger: 'Facebook', whatsapp: 'Meta' };
/**
 * Meta uygulamaları (WhatsApp, Instagram, Messenger) YALNIZ kurumsal/resmi yolla bağlanır (Kaan, 14.10: "normal girişleri kaldır, direkt
 * kurumsal giriş"): kişisel hesap/QR/köprü seçeneği ve açma-kapama ayarı yok. Mivelo'nun Meta uygulaması henüz hazır değilse düğme hata
 * paneli gösterir (eski yola DÜŞMEZ). Eskiden bağlanmış kişisel hesaplar çalışmaya devam eder (yalnız yeni bağlantı kapalı).
 */
const META_ONLY = new Set<Platform>(['instagram', 'messenger', 'whatsapp']);
/** Adres + parolayla bağlanan e-posta: iCloud (uygulamaya özel parola), Diğer e-posta (IMAP; sunucu çekirdekte bulunur) */
const PASS_MAIL = new Set<Platform>(['icloud', 'imap']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const APPLE_PW_URL = 'https://account.apple.com/account/manage/section/security';
/**
 * Resmi girişli hesap yeniden giriş istiyor: çekirdek "<Sağlayıcı> oturumu sona erdi — yeniden giriş yap" ya da (Meta) "… erişim izni
 * yok — yeniden giriş yapıp izin ver" yazar. Yalnız resmi girişi olan uygulamalarda (öteki kanallarda oauthStart yok).
 */
export const RELOGIN_RE = /oturumu sona erdi|yeniden giriş yap/i;
export function needsRelogin(a: Pick<Account, 'platform' | 'detail'>): boolean {
  return !!OFFICIAL_WHO[a.platform] && RELOGIN_RE.test(a.detail ?? '');
}
/** Arayüzdeki resmi giriş akışı: 'starting' = çekirdek giriş adresini hazırlıyor; from = akış bir hesabın panelinden başladıysa o hesap */
type UiFlow = Partial<Omit<FlowView, 'state'>> & { platform: Platform; state: FlowView['state'] | 'starting'; from?: string | null; hint?: string };

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
  // focus "edit:<hesap>" → pazaryeri hesabının entegrasyon bilgileri formu (API anahtarı yenileme) ya da iCloud/IMAP şifre formu
  const editOf = focus?.startsWith('edit:') ? accounts.find((a) => a.id === focus.slice(5) && (PLATFORMS[a.platform].category === 'shop' || PASS_MAIL.has(a.platform))) : undefined;
  const [active, setActive] = useState<string | null>(editOf ? `${editOf.platform}:new` : focus?.startsWith('edit:') ? focus.slice(5) : (focus ?? null)); // account id
  /** Form açılınca dolu gelecek alanlar (iCloud/IMAP şifre güncelleme: e-posta adresi) */
  const prefill = useRef<Record<string, string>>(editOf && PASS_MAIL.has(editOf.platform) ? { user: mailOf(editOf) ?? '' } : {});
  /** Bilgileri yeniden gir: yeni hesap formu açılır (kaydedince çekirdek aynı adresli / aynı mağazalı var olan hesabı günceller) */
  const editCredentials = (a: Account) => {
    if (PASS_MAIL.has(a.platform)) prefill.current = { user: mailOf(a) ?? '' };
    setActive(`${a.platform}:new`);
  };
  const [pat, setPat] = useState('');
  /** Pazar yeri formları (Trendyol/Hepsiburada/Etsy/Shopify): alan adı → değer */
  const [shop, setShop] = useState<Record<string, string>>({});
  const sf = (k: string) => shop[k] ?? '';
  const setSf = (k: string, v: string) => setShop((p) => ({ ...p, [k]: v }));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const activeAccount = accounts.find((a) => a.id === active);

  // ---- resmi giriş (OAuth) ----
  const [official, setOfficial] = useState<Set<Platform>>(() => new Set());
  const officialP = useRef<Promise<Set<Platform>> | null>(null);
  useEffect(() => {
    if (USE_STATIC) return; // demo eski akışla
    const p = api
      .oauthProviders(true)
      .then((l) => new Set(l))
      .catch(() => new Set<Platform>());
    officialP.current = p;
    void p.then(setOfficial);
  }, []);
  /** Bağlan'a liste gelmeden basıldıysa en çok 5 sn bekle (gelmezse eski akış) */
  const officialNow = (): Promise<Set<Platform>> =>
    officialP.current ? Promise.race([officialP.current, new Promise<Set<Platform>>((r) => window.setTimeout(() => r(official), 5000))]) : Promise.resolve(official);
  const [flow, setFlow] = useState<UiFlow | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const closedRef = useRef(false);
  /** Resmi girişi başlat: panel hemen açılır, çekirdek giriş sayfasını varsayılan tarayıcıda açınca akış izlenir */
  async function startOfficial(platform: Platform, opts: { hint?: string; from?: string | null } = {}) {
    const prev = flowRef.current;
    if (prev?.id && prev.state === 'waiting' && prev.platform !== platform) void api.oauthCancel(prev.id).catch(() => undefined);
    const base: UiFlow = { platform, state: 'starting', from: opts.from ?? null, hint: opts.hint };
    flowRef.current = base;
    setFlow(base);
    setActive(`${platform}:oauth`);
    try {
      const f = await api.oauthStart(platform, opts.hint);
      // bu arada iptal edildi / pencere kapandı / başka akış başladı: tarayıcıda bekleyen giriş bırakılır
      if (closedRef.current || flowRef.current !== base) {
        if (f.state === 'waiting') void api.oauthCancel(f.id).catch(() => undefined);
        return;
      }
      setFlow({ ...base, ...f });
    } catch (e) {
      // Meta uygulaması henüz onaylı/yapılandırılmış değil (çekirdek 409): eski yola düşülmez, kullanıcıya nedeni söylenir
      const msg = /etkin değil/i.test((e as Error).message) && META_ONLY.has(platform) ? `${PLATFORMS[platform].name} kurumsal girişi henüz hazır değil; Mivelo’nun Meta uygulaması onaylanınca burada açılacak.` : (e as Error).message;
      if (!closedRef.current && flowRef.current === base) setFlow({ ...base, state: 'error', error: msg });
    }
  }
  const cancelFlow = () => {
    const f = flowRef.current;
    if (f?.id && (f.state === 'waiting' || f.state === 'exchanging')) void api.oauthCancel(f.id).catch(() => undefined);
    flowRef.current = null;
    setFlow(null);
    setActive(f?.from ?? null);
  };
  /** Oturumu düşen / eski yolla bağlı hesabı resmi girişle yeniden bağla (çekirdek aynı adresli hesabın yerine geçirir) */
  const relogin = (a: Account) => void startOfficial(a.platform, { hint: mailOf(a), from: a.id });
  // akışı saniyede bir izle (geçici ağ hatası akışı bitirmez; 404 = akış yok)
  useEffect(() => {
    const id = flow?.id;
    if (!id || (flow.state !== 'waiting' && flow.state !== 'exchanging')) return;
    let inflight = false;
    let fails = 0;
    const t = window.setInterval(() => {
      if (inflight) return;
      inflight = true;
      api
        .oauthFlow(id)
        .then((v) => ((fails = 0), setFlow((cur) => (cur?.id === id ? { ...cur, ...v } : cur))))
        .catch((e: Error) => {
          if (++fails >= 5 || /bulunamad/i.test(e.message)) setFlow((cur) => (cur?.id === id ? { ...cur, state: 'error', error: e.message } : cur));
        })
        .finally(() => (inflight = false));
    }, 1000);
    return () => window.clearInterval(t);
  }, [flow?.id, flow?.state]);
  // bitti → hesabın paneli + pencere öne; iptal (başka yerden) → panel kapanır
  useEffect(() => {
    const f = flow;
    if (!f) return;
    if (f.state === 'done' && f.accountId) {
      const id = f.accountId;
      rememberOfficial(id, true);
      flowRef.current = null;
      setFlow(null);
      if (active === `${f.platform}:oauth`) setActive(id);
      else notify(`${PLATFORMS[f.platform].name} bağlandı`);
      void onChanged();
      void bringToFront();
    } else if (f.state === 'cancelled') {
      flowRef.current = null;
      setFlow(null);
      setActive((cur) => (cur === `${f.platform}:oauth` ? (f.from ?? null) : cur));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.state]);
  // pencere kapanınca tarayıcıda bekleyen giriş iptal (bağlanmakta olan sürer); StrictMode'un deneme sökümünden sonra yeniden açık sayılır
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      const f = flowRef.current;
      if (f?.id && f.state === 'waiting') void api.oauthCancel(f.id).catch(() => undefined);
    };
  }, []);

  // ---- Telegram: QR ya da telefon numarası + kod ----
  /** hesap → giriş yolu; geçişte o anki istem eskimiş sayılır (App istemleri silmez, eski "telefon" istemi QR'da görünmesin) */
  const [tgMode, setTgMode] = useState<Record<string, 'qr' | 'phone'>>({});
  const stalePrompt = useRef<Record<string, unknown>>({});
  const tgPrompt = activeAccount?.platform === 'telegram' && prompts[activeAccount.id] !== stalePrompt.current[activeAccount.id] ? prompts[activeAccount.id] : undefined;
  /** Telefonla giriş: seçildiyse ya da (pencere yeniden açıldı) çekirdek telefon/kod istiyorsa; QR yolunda yalnız 2FA parolası istenir */
  const tgPhone = !!activeAccount && activeAccount.platform === 'telegram' && (tgMode[activeAccount.id] ?? (tgPrompt && tgPrompt.prompt !== 'password' ? 'phone' : 'qr')) === 'phone';
  // bağlanan hesabın son istemi eskidir: sonraki eşleşmede (QR) görünmesin
  useEffect(() => {
    for (const a of accounts) if (a.platform === 'telegram' && a.status === 'connected' && prompts[a.id]) stalePrompt.current[a.id] = prompts[a.id];
  }, [accounts, prompts]);
  const tgRestart = (a: Account, mode: 'qr' | 'phone') => {
    stalePrompt.current[a.id] = prompts[a.id];
    setTgMode((m) => ({ ...m, [a.id]: mode }));
    setInput('');
    api.restartAccount(a.id, mode === 'phone' ? { phone: true } : undefined).catch((e) => notify(e.message, true));
  };

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
  // Başka bir pazaryerinin formuna geçince alanlar sıfırlansın (şifre güncellemede e-posta dolu) ve açılan panel görünür alana kaydırılsın
  useEffect(() => {
    setShop(prefill.current);
    prefill.current = {};
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
   * Bağlan: Meta uygulamaları her zaman resmi (kurumsal) giriş; resmi girişi açık öteki sağlayıcılar kendi sayfasında;
   * Telegram QR, diğer sosyal medya ve e-posta kendi giriş penceresi, iMessage bu Mac.
   * iCloud / Diğer e-posta ve pazaryerleri: önce form, doldurulunca bağlanır.
   */
  async function add(platform: Platform) {
    setBusy(true);
    try {
      if (!USE_STATIC && OFFICIAL_WHO[platform]) {
        const off = await officialNow();
        if (META_ONLY.has(platform) || off.has(platform)) {
          await startOfficial(platform);
          return;
        }
      }
      // iCloud: uygulamaya özel parola; Diğer e-posta: adres + şifre (IMAP/SMTP sunucusu çekirdekte bulunur)
      const mailUser = sf('user').trim();
      const mailPass = platform === 'icloud' ? sf('pass').replace(/\s+/g, '') : sf('pass');
      if (PASS_MAIL.has(platform)) {
        if (active !== `${platform}:new`) {
          setActive(`${platform}:new`);
          return;
        }
        if (!EMAIL_RE.test(mailUser)) {
          notify('Geçerli bir e-posta adresi gir', true);
          return;
        }
        if (!mailPass) {
          notify(platform === 'icloud' ? 'Uygulamaya özel parolayı yapıştır' : 'Şifreni gir', true);
          return;
        }
      }
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
        const filled = !!shopFields || platform === 'shopier' || PASS_MAIL.has(platform);
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
      if (PASS_MAIL.has(platform)) token = JSON.stringify({ user: mailUser, pass: mailPass });
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
      rememberOfficial(id, false);
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
    const p = tgPrompt;
    if (!p || !input.trim()) return;
    try {
      await api.accountInput(activeAccount.id, p.prompt, input.trim());
      setInput('');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  /** Resmi girişli hesap yeniden giriş istiyor (oturum sona erdi / izin eksik; bkz. RELOGIN_RE) */
  const expired = !!activeAccount && activeAccount.status !== 'connected' && needsRelogin(activeAccount);
  const offAcc = !!activeAccount && isOfficialAccount(activeAccount);

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

        {flow && active === `${flow.platform}:oauth` && (
          <div className="pairbox">
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <h3>{OFFICIAL_WHO[flow.platform]} ile giriş</h3>
              {flow.state === 'error' ? (
                <p className="cn-err">
                  <Icon name="alert" size={15} sw={2.2} />
                  <span>Giriş tamamlanamadı{flow.error ? `: ${flow.error}` : ''}</span>
                </p>
              ) : (
                <p className="cn-wait">
                  <span className="spin" />
                  <span>
                    {flow.state === 'starting'
                      ? 'Giriş sayfası açılıyor…'
                      : flow.state === 'exchanging' || flow.state === 'done'
                        ? 'Hesap bağlanıyor…'
                        : `${OFFICIAL_WHO[flow.platform]} giriş sayfası tarayıcında açıldı. Girişi orada tamamla; hesap burada kendiliğinden görünür.`}
                  </span>
                </p>
              )}
              <div className="cn-row">
                {flow.state === 'error' ? (
                  <button className="btn primary sm b" onClick={() => void startOfficial(flow.platform, { hint: flow.hint, from: flow.from })}>
                    <Icon name="refresh" size={14} sw={2} /> Tekrar dene
                  </button>
                ) : (
                  <button className="btn sm b b2" disabled={flow.state !== 'waiting'} onClick={() => flow.id && api.oauthOpen(flow.id).catch((e) => notify(e.message, true))}>
                    <Icon name="external" size={13} sw={2} /> Sayfayı tekrar aç
                  </button>
                )}
                <button className="btn sm b ghost" onClick={cancelFlow}>
                  {flow.state === 'error' ? 'Kapat' : 'İptal'}
                </button>
              </div>
              <p className="cn-note">
                <Icon name="shield" size={14} sw={1.8} /> Şifren Mivelo’ya yazılmaz; giriş doğrudan {OFFICIAL_WHO[flow.platform]} sayfasında yapılır.
              </p>
            </div>
          </div>
        )}

        {(['icloud', 'imap'] as Platform[]).map((p) =>
          active === `${p}:new` ? (
            <div className="pairbox" key={p}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <h3>{p === 'icloud' ? 'iCloud Mail’i bağla' : 'E-posta hesabını bağla'}</h3>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.5 }}>
                  {p === 'icloud' ? (
                    <>
                      Apple, e-posta uygulamaları için <b>uygulamaya özel parola</b> ister. Bir kez oluştur, buraya yapıştır.
                    </>
                  ) : (
                    <>E-posta adresini ve şifreni gir; sunucu ayarları kendiliğinden bulunur.</>
                  )}
                </p>
                {p === 'icloud' && (
                  <>
                    <button className="btn sm b b2" style={{ marginTop: 12 }} onClick={() => void openExternal(APPLE_PW_URL)}>
                      <Icon name="external" size={13} sw={2} /> Apple Hesabı’nda parola oluştur
                    </button>
                    {/* li esnek kutu: metin tek span'de (yoksa kalın kısmın iki yanında boşluk açılır) */}
                    <ol>
                      <li>
                        <span>
                          Apple Hesabı’nda <b>Giriş ve Güvenlik</b>’e gir
                        </span>
                      </li>
                      <li>
                        <span>
                          <b>Uygulamaya özel parolalar</b>’dan yeni bir parola oluştur
                        </span>
                      </li>
                      <li>
                        <span>Parolayı kopyalayıp aşağıya yapıştır</span>
                      </li>
                    </ol>
                  </>
                )}
                <div className="field cn-mailform">
                  <input type="email" value={sf('user')} onChange={(e) => setSf('user', e.target.value)} placeholder="E-posta adresin" autoComplete="off" autoFocus={!sf('user')} />
                  <PasswordInput
                    value={sf('pass')}
                    onChange={(e) => setSf('pass', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void add(p)}
                    placeholder={p === 'icloud' ? 'Uygulamaya özel parola' : 'Şifre'}
                    autoComplete="off"
                    autoFocus={!!sf('user')}
                  />
                  <button className="btn lime b" onClick={() => void add(p)} disabled={busy || !sf('user').trim() || !sf('pass')}>
                    Bağlan
                  </button>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.5 }}>
                  {p === 'icloud' ? 'Bu parola yalnız e-postana erişir; Apple Hesabı şifren değildir.' : 'Sağlayıcın uygulama şifresi istiyorsa onu gir.'} Yalnız bu bilgisayarda saklanır.
                </p>
              </div>
            </div>
          ) : null,
        )}

        {activeAccount && (
          <div className="pairbox">
            {(activeAccount.platform === 'whatsapp' || (activeAccount.platform === 'telegram' && !tgPhone && !tgPrompt)) && qr[activeAccount.id] && activeAccount.status === 'pairing' && (
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

              {activeAccount.platform === 'telegram' && activeAccount.status === 'pairing' && !tgPrompt && !tgPhone && (
                <>
                  <ol>
                    <li>Telefonunda Telegram’ı aç</li>
                    <li>
                      <b>Ayarlar → Cihazlar → Masaüstü Cihazı Bağla</b>
                    </li>
                    <li>Kamerayı bu koda tut</li>
                  </ol>
                  {!USE_STATIC && (
                    <button className="cn-link" onClick={() => tgRestart(activeAccount, 'phone')}>
                      <Icon name="phone" size={14} sw={2} /> Telefon numarasıyla giriş yap
                    </button>
                  )}
                </>
              )}
              {tgPhone && activeAccount.status !== 'connected' && !tgPrompt && (
                <p className="cn-wait" style={{ marginTop: 10 }}>
                  <span className="spin" />
                  <span>Telefon numarası isteniyor…</span>
                </p>
              )}
              {/* resmi girişli hesabın oturumu düştü (yenileme belirteci geçersiz): sağlayıcının sayfasında yeniden giriş */}
              {expired && (
                <div className="cn-row">
                  <button className="btn primary sm b" onClick={() => relogin(activeAccount)}>
                    <Icon name="refresh" size={14} sw={2} /> Yeniden giriş yap
                  </button>
                </div>
              )}
              {/* iCloud: uygulamaya özel parolayla (IMAP) bağlanır; tarayıcıyla bağlanmış eski hesap da bu yola geçebilir */}
              {activeAccount.platform === 'icloud' && activeAccount.status !== 'connected' && !(DEMO_OFFLINE && activeAccount.status === 'pairing') && (
                <div className="cn-row">
                  <button className="btn primary sm b" onClick={() => editCredentials(activeAccount)}>
                    <Icon name="lock" size={14} sw={2} /> Uygulamaya özel parolayla bağlan
                  </button>
                </div>
              )}

              {DEMO_OFFLINE && PLATFORMS[activeAccount.platform].mode === 'browser' && activeAccount.status === 'pairing' && <DemoLogin account={activeAccount} onDone={onChanged} />}
              {!DEMO_OFFLINE && PLATFORMS[activeAccount.platform].mode === 'browser' && activeAccount.status !== 'connected' && !expired && !offAcc && (activeAccount.platform !== 'icloud' || activeAccount.status === 'pairing') && (
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
              {activeAccount.platform === 'telegram' && tgPrompt && (activeAccount.status === 'pairing' || activeAccount.status === 'connecting') && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13.5 }}>{tgPrompt.message}</p>
                  <div className="field">
                    <InputOrPassword
                      key={tgPrompt.prompt}
                      password={tgPrompt.prompt === 'password'}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={tgPrompt.prompt === 'phone' ? '+90…' : tgPrompt.prompt === 'code' ? '12345' : '••••••'}
                      onKeyDown={(e) => e.key === 'Enter' && sendInput()}
                      autoFocus
                    />
                    <button className="btn lime b" onClick={sendInput} disabled={!input.trim()}>
                      Gönder
                    </button>
                  </div>
                </div>
              )}

              {/* telefonla girişten QR'a dönüş (istem kutusunun altında) */}
              {tgPhone && activeAccount.status !== 'connected' && (
                <button className="cn-link" onClick={() => tgRestart(activeAccount, 'qr')}>
                  <Icon name="grid" size={14} sw={2} /> QR ile giriş yap
                </button>
              )}
              {(activeAccount.status === 'error' || activeAccount.status === 'disconnected') && !expired && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {PLATFORMS[activeAccount.platform].category === 'shop' && (
                    <button className="btn primary b" onClick={() => editCredentials(activeAccount)}>
                      <Icon name="lock" size={14} sw={2} /> API bilgilerini güncelle
                    </button>
                  )}
                  {activeAccount.platform === 'imap' && (
                    <button className="btn primary b" onClick={() => editCredentials(activeAccount)}>
                      <Icon name="lock" size={14} sw={2} /> Şifreyi güncelle
                    </button>
                  )}
                  {offAcc && (
                    <button className="btn primary b" onClick={() => relogin(activeAccount)}>
                      <Icon name="refresh" size={14} sw={2} /> Yeniden giriş yap
                    </button>
                  )}
                  <button
                    className="btn darksec b"
                    onClick={() => {
                      // Telegram telefonla girişteyse yine telefonla (yeni istem gelecek: eskisi gizlensin)
                      const phone = tgPhone;
                      if (phone) stalePrompt.current[activeAccount.id] = prompts[activeAccount.id];
                      api.restartAccount(activeAccount.id, phone ? { phone: true } : undefined).catch((e) => notify(e.message, true));
                    }}
                  >
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
              {/* tarayıcıyla / uygulama şifresiyle bağlı e-posta hesabı: resmi giriş açıksa ona geçebilir (aynı adresli hesap güncellenir) */}
              {!expired && !offAcc && PLATFORMS[activeAccount.platform].category === 'mail' && official.has(activeAccount.platform) && (
                <div className="cn-switch">
                  <button className="btn sm b b2" onClick={() => relogin(activeAccount)}>
                    <Icon name="shield" size={14} sw={2} /> Resmi girişe geç
                  </button>
                  <span>{OFFICIAL_WHO[activeAccount.platform]} sayfasıyla giriş; e-postalar doğrudan sunucudan gelir, arka planda tarayıcı çalışmaz.</span>
                </div>
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
            const isConn = connected.includes(p);
            const isActive = acc.some((a) => a.id === active) || active === `${p}:new` || active === `${p}:oauth`;
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
                    <button className="btn sm primary b" onClick={() => add(p)} disabled={busy || (flow?.platform === p && flow.state !== 'error')}>
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

/**
 * Resmi girişle bağlanan hesaplar (bu cihazda hatırlanır; çekirdek Account.official gönderirse o geçerli): bunlarda "Giriş ekranını aç"
 * (tarayıcı girişine geçirir) gösterilmez, sorun olunca "Yeniden giriş yap" resmi girişi açar.
 */
const OFFICIAL_KEY = 'mivelo.officialAccounts';
let officialCache: Set<string> | null = null;
function officialIds(): Set<string> {
  if (officialCache) return officialCache;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OFFICIAL_KEY) || '[]');
    officialCache = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    officialCache = new Set();
  }
  return officialCache;
}
function rememberOfficial(id: string, on: boolean): void {
  const ids = new Set(officialIds());
  if (on) ids.add(id);
  else ids.delete(id);
  officialCache = ids;
  try {
    localStorage.setItem(OFFICIAL_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    /* depolama kapalı: bu oturumda bellekte */
  }
}
export function isOfficialAccount(a: Account): boolean {
  return a.official ?? officialIds().has(a.id);
}

/** Hesabın e-posta adresi (resmi girişte loginHint, şifre formunda dolu alan) */
function mailOf(a: Account): string | undefined {
  const l = accountLabel(a);
  return l && EMAIL_RE.test(l) ? l : undefined;
}

/** Resmi giriş tamamlandı: kullanıcı tarayıcıdan Mivelo'ya dönsün (masaüstünde pencere öne gelir) */
async function bringToFront(): Promise<void> {
  if (!isTauri) {
    try {
      window.focus();
    } catch {
      /* yok */
    }
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('focus_window');
  } catch {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFocus();
    } catch {
      /* eski kabuk */
    }
  }
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
