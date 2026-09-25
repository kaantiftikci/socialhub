/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STATIC_DEMO?: string;
  /** Tek dosyalık çevrimdışı demo */
  readonly VITE_DEMO_OFFLINE?: string;
  /** Sentry DSN: yalnız demo derlemesinde (GitHub secret SENTRY_DSN) */
  readonly VITE_SENTRY_DSN?: string;
  /** Derlenen commit (release etiketi) */
  readonly VITE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
