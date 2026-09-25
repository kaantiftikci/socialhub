import { STATIC_DEMO } from './profile';
import { REMOTE_CORE } from './desktop';

/**
 * Sentry yalnızca herkese açık DEMO'da (VITE_STATIC_DEMO=1 derlemesi, DSN derleme ortamından) çalışır.
 * Localhost/Tauri (gerçek hesaplar) ve demo üzerinden uzak çekirdeğe bağlanılan (#core=…) oturumlarda hiç yüklenmez.
 * Gizlilik: PII kapalı, replay/tracing yok; adresler, breadcrumb'lar ve hata mesajlarındaki e-posta/numara/belirteç temizlenir.
 */
const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

function scrub(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-posta]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[numara]')
    .replace(/(token|key|secret|password|sessionid|xoxc|xoxp)=[^&\s]+/gi, '$1=[gizli]')
    .replace(/#core=[^\s]+/g, '#core=[gizli]');
}

export async function initSentry(): Promise<void> {
  if (!DSN || !STATIC_DEMO || REMOTE_CORE) return;
  const Sentry = await import('@sentry/react');
  Sentry.init({
    dsn: DSN,
    environment: 'demo',
    release: (import.meta.env.VITE_COMMIT as string | undefined) || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: [],
    maxBreadcrumbs: 30,
    beforeSend(event) {
      if (event.request?.url) event.request.url = scrub(event.request.url);
      if (event.request?.headers) delete event.request.headers;
      if (event.message) event.message = scrub(event.message);
      for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
      delete event.user;
      return event;
    },
    beforeBreadcrumb(b) {
      // XHR/fetch adresleri ve konsol satırları sohbet kimliği/metin taşıyabilir
      if (b.category === 'console') return null;
      if (b.data?.url) b.data.url = scrub(String(b.data.url));
      if (b.message) b.message = scrub(b.message);
      return b;
    },
  });
}
