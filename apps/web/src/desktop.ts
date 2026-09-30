/**
 * Tauri masaüstü kabuğu köprüsü. Tarayıcıda çalışırken hepsi sessizce no-op olur;
 * paketler yalnızca Tauri içinde dinamik olarak yüklenir.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Arayüzün çalıştığı cihaz macOS/iOS mu (kısayol ipuçları: ⌘ / Ctrl). Çekirdeğin OS'u için /api/health `os` alanına bak. */
export const isMac: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
})();
/** Kısayol ipuçlarında değiştirici tuş: Mac'te ⌘, Windows/Linux'ta Ctrl */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';
// Mac dışı masaüstünde başlık çubuğu yerel (styles.css .os-other): trafik ışıkları boşluğu kalkar
if (isTauri && !isMac && typeof document !== 'undefined') document.documentElement.classList.add('os-other');

/**
 * Uzak çekirdek: statik/demo site gerçek çekirdeğe (Mac'teki core, HTTPS tünelle) bağlanabilir.
 * Kurulum adres parçasıyla: https://site/#core=https://xxx.trycloudflare.com&token=… ; kaldırmak için #core=off
 */
function readRemoteCore(): string {
  if (isTauri || typeof location === 'undefined') return '';
  try {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const core = h.get('core');
    if (core === 'off') {
      localStorage.removeItem('kavsak.core');
      localStorage.removeItem('kavsak.token');
      history.replaceState(null, '', location.pathname + location.search);
    } else if (core && /^https?:\/\//.test(core)) {
      localStorage.setItem('kavsak.core', core.replace(/\/+$/, ''));
      const t = h.get('token');
      if (t) localStorage.setItem('kavsak.token', t);
      history.replaceState(null, '', location.pathname + location.search);
    } else if (h.get('token')) {
      // LAN QR bağlantısı: belirteç adres parçasında (sunucuya/tarihçeye gitmez), sakla ve temizle
      localStorage.setItem('kavsak.token', h.get('token') as string);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return localStorage.getItem('kavsak.core') ?? '';
  } catch {
    return '';
  }
}
export const REMOTE_CORE = readRemoteCore();
export function clearRemoteCore(): void {
  try {
    localStorage.removeItem('kavsak.core');
    localStorage.removeItem('kavsak.token');
  } catch {
    /* yok */
  }
}

/** Çekirdek API kökü: tarayıcıda Vite proxy'si (göreli), Tauri'de doğrudan yerel port, uzak çekirdek ayarlıysa o. */
export const API_BASE = isTauri ? 'http://127.0.0.1:7788' : REMOTE_CORE;

/** Çekirdek API belirteci: paketli uygulamada Tauri komutundan okunur (çekirdek 1-3 sn geç kalkabilir; birkaç kez dene). */
/** Çözülmüş belirteç (senkron erişim: <img src> gibi yerler için) */
let tokenValue = '';
/** "/api/…" göreli medya adresini çekirdeğe yönlendir (Tauri: 127.0.0.1:7788; telefon: ?token= eklenir) */
export function mediaUrl(u?: string): string | undefined {
  if (!u || !u.startsWith('/')) return u;
  const full = API_BASE + u;
  return tokenValue && u.startsWith('/api/') ? `${full}${full.includes('?') ? '&' : '?'}token=${encodeURIComponent(tokenValue)}` : full;
}

/**
 * Çekirdeğin yerel API belirteci. Masaüstünde (Tauri) belirteç dosyasını çekirdek yazar; ilk açılışta (yeni kullanıcı, macOS'un
 * ilk çalıştırmada gömülü node'u ve yerel modülleri taraması, veritabanı/Anahtar Zinciri kurulumu) bu 15 sn'yi aşabiliyor.
 * Eskiden 15 sn sonra boş belirteç KALICI önbelleğe alınıyordu → tüm istekler "Yetkisiz kaynak" → arayüz dakikalarca
 * "Çekirdek başlatılıyor"da kalıyordu (Kaan, 29.09, M1). Şimdi: belirteç gelene dek beklenir; boşsa ve istek 403 alırsa
 * `refreshCoreToken()` yeniden okur.
 */
async function readToken(waitMs: number): Promise<string> {
  if (!isTauri) {
    // Telefondan erişim: bağlantı ?token=… ile gelir; sakla ve adresten temizle
    try {
      const u = new URL(location.href);
      const t = u.searchParams.get('token');
      if (t) {
        localStorage.setItem('kavsak.token', t);
        u.searchParams.delete('token');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      }
      return localStorage.getItem('kavsak.token') ?? '';
    } catch {
      return '';
    }
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const t0 = Date.now();
    for (;;) {
      const t = await invoke<string>('core_token').catch(() => '');
      if (t || Date.now() - t0 >= waitMs) return t;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    return '';
  }
}
let tokenPromise: Promise<string> = readToken(15_000);
tokenPromise.then((t) => (tokenValue = t));
/** Güncel belirteç (istekler her seferinde bunu bekler; ilk açılışta en çok 15 sn) */
export function coreToken(): Promise<string> {
  return tokenPromise;
}
/** Belirteç boş kaldıysa ya da çekirdek yeniden kurulduysa (403) yeniden oku; aynı anda tek okuma */
let refreshing: Promise<string> | null = null;
export function refreshCoreToken(): Promise<string> {
  if (!isTauri) return tokenPromise;
  refreshing ??= readToken(2_000).then((t) => {
    refreshing = null;
    if (t) {
      tokenValue = t;
      tokenPromise = Promise.resolve(t);
    }
    return t;
  });
  return refreshing;
}

export async function setBadge(count: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_badge', { count });
  } catch {
    /* yok say */
  }
}

/** Paketli uygulamada çekirdek başlatma günlüğü (~/.mivelo/desktop.log + core.log son satırları) */
export async function coreInfo(): Promise<string> {
  if (!isTauri) return '';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('core_info');
  } catch {
    return '';
  }
}

let permissionOk: boolean | null = null;

/** Web (tarayıcı) bildirim izni: 'granted' | 'denied' | 'default' | 'unsupported'; Tauri'de izin kabukta */
export function webNotifyPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  if (isTauri) return 'granted';
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
/** İzni iste (tarayıcılar yalnız kullanıcı tıklamasıyla gelen isteğe pencere açar; sayfa açılışında istenen sessizce engelleniyordu) */
export async function requestWebNotify(): Promise<'granted' | 'denied' | 'default' | 'unsupported'> {
  if (isTauri || !('Notification' in window)) return webNotifyPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}
/** Deneme bildirimi: odak durumundan bağımsız gösterir (ayarlardan sınamak için) */
export async function testNotify(): Promise<boolean> {
  if (isTauri) {
    await notify('Mivelo', 'Deneme bildirimi — bildirimler çalışıyor', true);
    return true;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  new Notification('Mivelo', { body: 'Deneme bildirimi — bildirimler çalışıyor', tag: 'mivelo-test' });
  return true;
}

/**
 * Sistem bildirimi. Tarayıcıda `onClick` bildirime tıklanınca çalışır (pencere öne alınır; Mivelo o sohbetin hızlı yanıt kartını
 * açar). Tauri'de bildirim eklentisi (2.4) masaüstünde tıklama/eylem olayı VERMEZ (eylemler yalnız mobil): orada yerine pencere
 * öne gelince son bildirimin hızlı yanıt kartı gösterilir (QuickSend.tsx).
 */
export async function notify(title: string, body: string, force = false, opts: { onClick?: () => void; tag?: string } = {}): Promise<void> {
  if (!isTauri) {
    if ('Notification' in window && Notification.permission === 'granted' && (force || !document.hasFocus())) {
      const n = new Notification(title, { body, ...(opts.tag ? { tag: opts.tag } : {}) });
      if (opts.onClick)
        n.onclick = () => {
          try {
            window.focus();
          } catch {
            /* yok */
          }
          n.close();
          opts.onClick?.();
        };
    }
    return;
  }
  try {
    const n = await import('@tauri-apps/plugin-notification');
    if (permissionOk === null) {
      permissionOk = await n.isPermissionGranted();
      if (!permissionOk) permissionOk = (await n.requestPermission()) === 'granted';
    }
    if (permissionOk) n.sendNotification({ title, body });
  } catch {
    /* yok say */
  }
}

/** Masaüstü: pencereyi gizle (⌘⇧K ikinci kez basılınca hızlı gönder kapanır ve Mivelo arka plana döner) */
export async function hideWindow(): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('hide_window');
  } catch {
    /* eski kabuk */
  }
}

export async function windowFocused(): Promise<boolean> {
  if (!isTauri) return document.hasFocus();
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    return (await w.isFocused()) && (await w.isVisible());
  } catch {
    return true;
  }
}

/** Menü çubuğundan gelen "navigate" gibi olayları dinle. */
export async function onDesktopEvent(name: string, fn: (payload: string) => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen<string>(name, (e) => fn(e.payload));
    return un;
  } catch {
    return () => undefined;
  }
}

let audioCtx: AudioContext | undefined;
export const SOUNDS: Array<{ id: string; name: string }> = [
  { id: 'cinlama', name: 'Çınlama' },
  { id: 'damla', name: 'Damla' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'tik', name: 'Tık' },
  { id: 'kus', name: 'Kuş' },
];
export function getSound(): string {
  try {
    return localStorage.getItem('kavsak.sound') || 'cinlama';
  } catch {
    return 'cinlama';
  }
}
/** Uygulama başına ses: '' = genel ayar, 'off' = kapalı, yoksa ses kimliği */
export function getPlatformSound(platform: string): string {
  try {
    return localStorage.getItem(`kavsak.sound.${platform}`) ?? '';
  } catch {
    return '';
  }
}
export function setPlatformSound(platform: string, id: string): void {
  try {
    if (id) localStorage.setItem(`kavsak.sound.${platform}`, id);
    else localStorage.removeItem(`kavsak.sound.${platform}`);
  } catch {
    /* yok */
  }
}

/** Seçili zil sesi; bildirim kapalıyken de hatırlanır. */
export function getPlatformTone(platform: string): string {
  try {
    const saved = localStorage.getItem(`kavsak.tone.${platform}`);
    if (saved && SOUNDS.some((s) => s.id === saved)) return saved;
  } catch {
    /* yok */
  }
  const cur = getPlatformSound(platform);
  if (cur && cur !== 'off') return cur;
  const general = getSound();
  return general === 'off' ? 'cinlama' : general;
}

export function setPlatformTone(platform: string, id: string): void {
  try {
    localStorage.setItem(`kavsak.tone.${platform}`, id);
  } catch {
    /* yok */
  }
}

export function setSound(id: string): void {
  try {
    localStorage.setItem('kavsak.sound', id);
  } catch {
    /* yok */
  }
}

/** Genel ses düzeyi 0–100 (varsayılan 60 = eski sabit seviye) */
export function getVolume(): number {
  try {
    const v = Number(localStorage.getItem('kavsak.volume'));
    return localStorage.getItem('kavsak.volume') === null || !Number.isFinite(v) ? 60 : Math.max(0, Math.min(100, v));
  } catch {
    return 60;
  }
}
export function setVolume(v: number): void {
  try {
    localStorage.setItem('kavsak.volume', String(Math.round(Math.max(0, Math.min(100, v)))));
  } catch {
    /* yok */
  }
}
/** Uygulama başına ses düzeyi 0–100 (genel düzeyin yüzdesi; varsayılan 100) */
export function getPlatformVolume(platform: string): number {
  try {
    const raw = localStorage.getItem(`kavsak.vol.${platform}`);
    const v = Number(raw);
    return raw === null || !Number.isFinite(v) ? 100 : Math.max(0, Math.min(100, v));
  } catch {
    return 100;
  }
}
export function setPlatformVolume(platform: string, v: number): void {
  try {
    localStorage.setItem(`kavsak.vol.${platform}`, String(Math.round(Math.max(0, Math.min(100, v)))));
  } catch {
    /* yok */
  }
}
/** Genel anahtarlar: tüm bildirim sesleri / masaüstü (sistem) bildirim kartları */
function flag(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : v === '1';
  } catch {
    return def;
  }
}
function setFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* yok */
  }
}
export const soundsEnabled = (): boolean => flag('kavsak.soundsOn', true);
export const setSoundsEnabled = (on: boolean): void => setFlag('kavsak.soundsOn', on);
export const bannersEnabled = (): boolean => flag('kavsak.bannersOn', true);
export const setBannersEnabled = (on: boolean): void => setFlag('kavsak.bannersOn', on);
/** Grup ve kanal sohbetlerinden bildirim (kapalıysa yalnız birebir sohbetler bildirir) */
export const groupsNotify = (): boolean => flag('kavsak.groupsOn', true);
export const setGroupsNotify = (on: boolean): void => setFlag('kavsak.groupsOn', on);
/** Uygulamanın bildirimi açık mı ('off' = o uygulamadan ne ses ne kart) */
export const platformNotifyOn = (platform: string): boolean => getPlatformSound(platform) !== 'off';

/** Gelen mesaj sesi: genel anahtar, uygulama tercihi, zil sesi ve iki ses düzeyi birlikte uygulanır */
export function playNotifySound(platform: string): void {
  if (!soundsEnabled() || !platformNotifyOn(platform)) return;
  const vol = (getVolume() / 100) * (getPlatformVolume(platform) / 100);
  if (vol <= 0) return;
  playPing(getPlatformTone(platform), true, vol);
}

/**
 * Tarayıcı/WKWebView otomatik oynatma kuralı: kullanıcı hareketi olmadan açılan AudioContext "suspended" kalır ve
 * resume() reddedilir → uygulama açılıp hiç tıklanmadan gelen bildirimler sessiz kalıyordu. İlk tıklama/tuşta bağlam
 * açılır ve kilidi kaldırılır; sonraki sesler arka planda da çalar.
 */
export function unlockAudio(): void {
  const go = () => {
    try {
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
    } catch {
      /* ses yok */
    }
    if (audioCtx?.state === 'running') {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
    }
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

type Note = [freq: number, at: number, dur: number, type?: OscillatorType, gain?: number];
const PATTERNS: Record<string, Note[]> = {
  cinlama: [[880, 0, 0.18, 'sine'], [1174.66, 0.11, 0.26, 'sine']],
  damla: [[1400, 0, 0.06, 'sine', 0.6], [700, 0.03, 0.22, 'sine']],
  marimba: [[659.25, 0, 0.22, 'triangle'], [783.99, 0.14, 0.22, 'triangle'], [1046.5, 0.28, 0.3, 'triangle']],
  tik: [[2200, 0, 0.035, 'square', 0.35]],
  kus: [[1760, 0, 0.09, 'sine'], [2093, 0.09, 0.09, 'sine'], [1760, 0.18, 0.12, 'sine']],
};

/** Kısa bildirim sesi (dosya gerekmez; Web Audio ile üretilir). force=true ayar "kapalı" olsa da çalar (deneme). */
export function playPing(id?: string, force = false, volume = getVolume() / 100): void {
  try {
    const chosen = id ?? getSound();
    if (chosen === 'off' && !force) return;
    if (volume <= 0) return;
    const notes = PATTERNS[chosen === 'off' ? 'cinlama' : chosen] ?? PATTERNS.cinlama;
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const master = ctx.createGain();
    // 60 → eski sabit 0,18; algı logaritmik olduğundan kare eğri (düşük düzeyler gerçekten kısık)
    master.gain.value = 0.5 * volume * volume;
    master.connect(ctx.destination);
    for (const [freq, at, dur, type = 'sine', vol = 1] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      if (chosen === 'damla') o.frequency.exponentialRampToValueAtTime(freq / 2, t + at + dur);
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(vol, t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + dur);
      o.connect(g).connect(master);
      o.start(t + at);
      o.stop(t + at + dur + 0.05);
    }
  } catch {
    /* ses yok */
  }
}

/** Dış bağlantıyı sistemde aç (Tauri: uygulama şemaları dahil; web: yeni sekme) */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external', { url });
      return;
    } catch {
      /* eski paket: aşağıya düş */
    }
  }
  window.open(url, '_blank', 'noopener');
}
