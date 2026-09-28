/**
 * Arayüz etkinliği: Mivelo penceresi açık ve odaktayken arayüz dakikada bir `POST /api/activity {active:true}` gönderir,
 * gizlenince/odak kaybedince `{active:false}`. Uyarlamalı yoklama yapan kanallar (Instagram) buna göre sık ya da seyrek sorar;
 * boştan etkine geçişte dinleyiciler hemen haber alır (bekleyen uzun turu kısaltmak için).
 */
const ACTIVE_FOR = 150_000; // son sinyalden bu kadar sonra (kapanan pencere sinyal gönderemeyebilir) boşta sayılır
let lastActive = 0;
const listeners = new Set<() => void>();
const idleListeners = new Set<() => void>();
let idleTimer: NodeJS.Timeout | undefined;

function fireIdle(): void {
  for (const fn of idleListeners) {
    try {
      fn();
    } catch {
      /* dinleyici hatası diğerlerini durdurmasın */
    }
  }
}

export function markActive(active: boolean, now = Date.now()): void {
  const was = isUiActive(now);
  lastActive = active ? now : 0;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  if (active) {
    // sinyal kesilirse (pencere kapandı, Mac uyudu) ACTIVE_FOR sonunda boşa geçiş bildirilir
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (!isUiActive()) fireIdle();
    }, ACTIVE_FOR + 1000);
    idleTimer.unref?.();
  }
  if (active && !was) for (const fn of listeners) fn();
  if (!active && was) fireIdle();
}

export function isUiActive(now = Date.now()): boolean {
  return lastActive > 0 && now - lastActive < ACTIVE_FOR;
}

/** Boştan etkine geçişte çağrılır; dönen işlev aboneliği kaldırır */
export function onUiActive(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Etkinden boşa geçişte (açık {active:false} ya da sinyal kesilmesi) çağrılır; dönen işlev aboneliği kaldırır */
export function onUiInactive(fn: () => void): () => void {
  idleListeners.add(fn);
  return () => void idleListeners.delete(fn);
}
