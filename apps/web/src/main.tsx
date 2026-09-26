import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DemoGate } from './Auth';
import { DEMO_OFFLINE, STATIC_DEMO, setProfileName } from './profile';
import { loadDemoAccounts } from './static-demo';
import './styles.css';
import { initSentry } from './sentry';

void initSentry(); // yalnız demo derlemesinde ve DSN varsa etkin

if (DEMO_OFFLINE) {
  setProfileName('Mivelo');
  loadDemoAccounts([]); // tüm demo uygulamaları bağlı
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {STATIC_DEMO && !DEMO_OFFLINE ? <DemoGate /> : <App />}
  </StrictMode>,
);
