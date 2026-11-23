import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';

registerSW({ immediate: true });

// Three entry points share this bundle; each one loads only its own code.
const App = lazy(() => import('./App.tsx'));
const DriverApp = lazy(() => import('./driver/DriverApp.tsx').then((m) => ({ default: m.DriverApp })));
const TrackingPage = lazy(() => import('./public/TrackingPage.tsx').then((m) => ({ default: m.TrackingPage })));

const path = window.location.pathname;
const tracking = path.match(/^\/seguimiento\/([A-Za-z0-9_-]{20,})\/?$/);

function Root() {
  if (path === '/chofer' || path.startsWith('/chofer/')) return <DriverApp />;
  if (tracking) return <TrackingPage token={tracking[1]} />;
  return <App />;
}

// In development Vite may re-run this module (dependency re-optimization): reuse the root.
const holder = window as unknown as { __geocarRoot?: ReturnType<typeof createRoot> };
holder.__geocarRoot ??= createRoot(document.getElementById('root')!);
holder.__geocarRoot.render(
  <Suspense fallback={<div className="min-h-screen bg-[#0B1120]" />}>
    <Root />
  </Suspense>
);
