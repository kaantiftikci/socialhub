/**
 * Tauri masaüstü kabuğu köprüsü. Tarayıcıda çalışırken hepsi sessizce no-op olur;
 * paketler yalnızca Tauri içinde dinamik olarak yüklenir.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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

export const coreToken: Promise<string> = (async () => {
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
    for (let i = 0; i < 30; i++) {
      const t = await invoke<string>('core_token').catch(() => '');
      if (t) return t;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    /* tarayıcıda */
  }
  return '';
})();
void coreToken.then((t) => (tokenValue = t));

export async function setBadge(count: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_badge', { count });
  } catch {
    /* yok say */
  }
}

/** Paketli uygulamada çekirdek başlatma günlüğü (~/.kavsak/desktop.log + core.log son satırları) */
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

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri) {
    if ('Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) new Notification(title, { body });
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

type Note = [freq: number, at: number, dur: number, type?: OscillatorType, gain?: number];
const PATTERNS: Record<string, Note[]> = {
  cinlama: [[880, 0, 0.18, 'sine'], [1174.66, 0.11, 0.26, 'sine']],
  damla: [[1400, 0, 0.06, 'sine', 0.6], [700, 0.03, 0.22, 'sine']],
  marimba: [[659.25, 0, 0.22, 'triangle'], [783.99, 0.14, 0.22, 'triangle'], [1046.5, 0.28, 0.3, 'triangle']],
  tik: [[2200, 0, 0.035, 'square', 0.35]],
  kus: [[1760, 0, 0.09, 'sine'], [2093, 0.09, 0.09, 'sine'], [1760, 0.18, 0.12, 'sine']],
};

/** Kısa bildirim sesi (dosya gerekmez; Web Audio ile üretilir). force=true ayar "kapalı" olsa da çalar (deneme). */
export function playPing(id?: string, force = false): void {
  try {
    const chosen = id ?? getSound();
    if (chosen === 'off' && !force) return;
    const notes = PATTERNS[chosen === 'off' ? 'cinlama' : chosen] ?? PATTERNS.cinlama;
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.18;
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
