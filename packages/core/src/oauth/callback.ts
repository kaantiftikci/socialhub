/**
 * Yerel OAuth geri dönüşü (`/oauth/callback`): bekleyen girişler `state` ile eşleşir. Sistem tarayıcısındaki sağlayıcı sayfası
 * (Google, Microsoft…) ya da mivelo.app'teki HTTPS geri dönüş sayfası (Slack, Meta, Yahoo, Yandex) kullanıcıyı buraya yönlendirir.
 * Eski Gmail/Etsy akışları da aynı tabloyu kullanır (mail.ts yeniden dışa aktarır).
 */
type Result = { code?: string; error?: string };
const pending = new Map<string, (r: Result) => void>();

export function resolveOAuth(state: string, r: Result): boolean {
  const fn = pending.get(state);
  if (!fn) return false;
  pending.delete(state);
  fn(r);
  return true;
}

/** /oauth/callback'e gelen code/error'u bekle (varsayılan 10 dk). signal iptal edilirse "iptal edildi" hatası. */
export function waitOAuth(state: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(state)) reject(new Error('Giriş zaman aşımına uğradı'));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      if (pending.delete(state)) {
        clearTimeout(timer);
        reject(new Error('Giriş iptal edildi'));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(state, (r) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (r.code) resolve(r.code);
      else reject(new Error(friendlyError(r.error)));
    });
  });
}

/** Bekleyen tüm girişleri hata ile kapat (giriş penceresi kapatıldı vb.) */
export function failAllOAuth(error: string): void {
  for (const [k, fn] of [...pending]) {
    pending.delete(k);
    fn({ error });
  }
}

export function hasPendingOAuth(state: string): boolean {
  return pending.has(state);
}

/** Sağlayıcı hata kodları → kullanıcı dili */
export function friendlyError(e: string | undefined): string {
  if (!e) return 'Giriş iptal edildi';
  if (/access_denied|user_denied|denied|cancel/i.test(e)) return 'Giriş iptal edildi ya da izin verilmedi';
  if (/invalid_scope/i.test(e)) return 'Uygulama izinleri sağlayıcıda tanımlı değil (invalid_scope)';
  if (/unauthorized_client|invalid_client/i.test(e)) return 'Mivelo uygulaması sağlayıcıda henüz onaylı değil';
  return e.slice(0, 200);
}
