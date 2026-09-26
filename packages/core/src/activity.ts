/**
 * Arayüz etkinliği: Mivelo penceresi açık ve odaktayken arayüz dakikada bir `POST /api/activity {active:true}` gönderir,
 * gizlenince/odak kaybedince `{active:false}`. Uyarlamalı yoklama yapan kanallar (Instagram) buna göre sık ya da seyrek sorar;
 * boştan etkine geçişte dinleyiciler hemen haber alır (bekleyen uzun turu kısaltmak için).
 */
const ACTIVE_FOR = 150_000; // son sinyalden bu kadar sonra (kapanan pencere sinyal gönderemeyebilir) boşta sayılır
let lastActive = 0;
const listeners = new Set<() => void>();

export function markActive(active: boolean, now = Date.now()): void {
  const was = isUiActive(now);
  lastActive = active ? now : 0;
  if (active && !was) for (const fn of listeners) fn();
}

export function isUiActive(now = Date.now()): boolean {
  return lastActive > 0 && now - lastActive < ACTIVE_FOR;
}

/** Boştan etkine geçişte çağrılır; dönen işlev aboneliği kaldırır */
export function onUiActive(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
