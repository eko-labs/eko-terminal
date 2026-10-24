import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/chart.css';
import './styles/ticket.css';
import './styles/pages.css';
import './styles/lab.css';
import './styles/ui.css';
import './styles/shell.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { usePath } from './lib/router';
import { useMainFocus } from './lib/mainFocus';
import { arrive } from './lib/expand';
import Landing from './pages/scan/Landing';
import { initializePwa } from './lib/pwa';
import { ConnectionStatus } from './components/Pwa';

window.addEventListener('error', e => { void import('./lib/telemetry').then(m => m.reportClientError(e.error)); });
window.addEventListener('unhandledrejection', e => { void import('./lib/telemetry').then(m => m.reportClientError(e.reason)); });
window.addEventListener('pagehide', () => { void import('./lib/telemetry').then(m => m.flushTelemetry(true)); });
initializePwa();
const TerminalApp = lazy(() => import('./TerminalApp'));
const UI = import.meta.env.DEV ? lazy(() => import('./pages/UI')) : null;

function Root() {
  const path = usePath();
  useMainFocus(path);
  if (import.meta.env.DEV && path === '/__ui' && UI) return <Suspense fallback={null}><UI /></Suspense>;
  // "/" is the landing site (the EKO scroll story, kept in its own project), served by the host and by vite.config.ts
  // in dev. The Scan landing lives at /scan; if the SPA is ever asked for "/", it shows the Scan landing too.
  if (path === '/' || path === '/scan') return <Landing />;
  return <Suspense fallback={null}><TerminalApp /></Suspense>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionStatus />
    <Root />
  </StrictMode>,
);
arrive();
