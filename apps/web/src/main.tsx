import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DemoGate } from './Auth';
import { STATIC_DEMO } from './profile';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {STATIC_DEMO ? <DemoGate /> : <App />}
  </StrictMode>,
);
