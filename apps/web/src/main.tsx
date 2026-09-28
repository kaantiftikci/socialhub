import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LicenseGate } from './LicenseGate';
import { DemoGate } from './Auth';
import { DEMO_OFFLINE, STATIC_DEMO, setProfileName } from './profile';
import { loadDemoAccounts } from './static-demo';
import './styles.css';
import { initSentry } from './sentry';
import { applyTheme, watchSystemTheme } from './theme';

applyTheme();
watchSystemTheme();
void initSentry(); // yalnız demo derlemesinde ve DSN varsa etkin

/**
 * Yayındaki demo (demo.mivelo.app): barındırma index.html'i önbellekten verebiliyor → yeni sürüm yayınlansa da tarayıcı eski
 * sayfayı (eski JS'i) açıyordu ("düzeldi dendi ama bende hâlâ eski"). Açılışta ve sekmeye uzun aradan sonra dönülünce sayfanın
 * güncel hâli önbelleksiz istenir; ana betik adı farklıysa bir kez yenilenir (aynı sürüm için döngü olmaz).
 */
async function reloadIfStale(): Promise<void> {
  const cur = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/"]')?.getAttribute('src');
  if (!cur) return;
  try {
    const html = await fetch(`${location.pathname}?v=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
    const next = html.match(/<script[^>]*type="module"[^>]*src="([^"]*assets\/[^"]+)"/)?.[1];
    const key = `mivelo.reloadedFor:${next}`;
    if (next && next !== cur && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
    }
  } catch {
    /* çevrimdışı: sonra */
  }
}
if (STATIC_DEMO && !DEMO_OFFLINE && import.meta.env.PROD) {
  void reloadIfStale();
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10 * 60_000) void reloadIfStale();
  });
}

if (DEMO_OFFLINE) {
  setProfileName('Mivelo');
  loadDemoAccounts([]); // tüm demo uygulamaları bağlı
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {STATIC_DEMO && !DEMO_OFFLINE ? <DemoGate /> : <LicenseGate><App /></LicenseGate>}
  </StrictMode>,
);
