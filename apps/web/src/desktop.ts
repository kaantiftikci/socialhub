/**
 * Tauri masaüstü kabuğu köprüsü. Tarayıcıda çalışırken hepsi sessizce no-op olur;
 * paketler yalnızca Tauri içinde dinamik olarak yüklenir.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Çekirdek API kökü: tarayıcıda Vite proxy'si (göreli), Tauri'de doğrudan yerel port. */
export const API_BASE = isTauri ? 'http://127.0.0.1:7788' : '';

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
