import { useState } from 'react';
import { Check, CheckCircle2, Copy, Download, ExternalLink, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from './usePWAInstall.ts';

interface PWAInstallButtonProps {
  variant?: 'header' | 'card';
}

export function PWAInstallButton({ variant = 'header' }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, isAndroid, isBrave, isInIframe, swReady, install } =
    usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const directUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/vigiant` : '/vigiant';

  const handleAction = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuide(true);
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(directUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Ignore clipboard restriction
    }
  };

  if (isInstalled) {
    if (variant === 'header') return null;
    return (
      <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 flex items-center gap-3 text-xs text-emerald-900">
        <CheckCircle2 className="w-5 h-5 text-[#2E7D32] shrink-0" />
        <div>
          <div className="font-semibold">Vigiant ya está instalada como aplicación</div>
          <div className="text-emerald-700 mt-0.5">
            Ejecutándose en modo independiente (standalone) con soporte sin conexión.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {variant === 'header' ? (
        <button
          type="button"
          onClick={handleAction}
          className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 transition-colors"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>Instalar App</span>
        </button>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 p-4 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-[#1565C0] flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">
                Instalar Vigiant en este dispositivo
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {isInstallable
                  ? 'Lista para instalar en 1 toque como aplicación independiente.'
                  : 'Instálala como aplicación nativa PWA en Android, iPhone o escritorio sin APK.'}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleAction}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#1565C0] hover:bg-[#0D47A1] text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 transition-colors"
          >
            <Download className="w-4 h-4 shrink-0" />
            <span>Instalar App</span>
          </button>
        </div>
      )}

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white p-6 text-slate-900 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Instalar Vigiant en tu dispositivo
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {isIOS
                    ? 'Safari en iPhone / iPad'
                    : isBrave
                      ? 'Navegador Brave detectado'
                      : isAndroid
                        ? 'Android (Chrome / Edge / Brave)'
                        : 'Navegador de escritorio (Chrome / Edge / Brave)'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Cerrar instrucciones de instalación"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isInIframe && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
                <div className="font-semibold">
                  Estás viendo la app dentro de una vista embebida
                </div>
                <p>
                  Los navegadores bloquean el instalador PWA dentro de iframes. Abre Vigiant directamente en una pestaña nueva para activar la instalación:
                </p>
                <a
                  href={directUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#1565C0] text-white font-medium hover:bg-[#0D47A1]"
                >
                  <span>Abrir Vigiant en pestaña nueva</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            {isIOS ? (
              <ol className="space-y-2 text-sm text-slate-700 list-decimal pl-5">
                <li>
                  Abre esta página en <strong>Safari</strong> (iOS requiere Safari para instalar apps web).
                </li>
                <li>
                  Pulsa el botón <strong>Compartir</strong> en la barra inferior.
                </li>
                <li>
                  Desplázate y elige <strong>Agregar a inicio</strong> → <strong>Agregar</strong>.
                </li>
              </ol>
            ) : isBrave ? (
              <ol className="space-y-2 text-sm text-slate-700 list-decimal pl-5">
                <li>
                  En <strong>Brave</strong>, pulsa el ícono de <strong>Instalar</strong> en la barra de direcciones (a la derecha de la URL), o abre el menú <strong>☰ / ⋮</strong>.
                </li>
                <li>
                  Selecciona <strong>Guardar y compartir → Instalar página como aplicación…</strong> (en Android: <strong>Instalar aplicación</strong> o <strong>Añadir a pantalla de inicio</strong>).
                </li>
                <li>
                  Confirma <strong>Instalar</strong> para abrir Vigiant en su propia ventana independiente.
                </li>
              </ol>
            ) : isAndroid ? (
              <ol className="space-y-2 text-sm text-slate-700 list-decimal pl-5">
                <li>
                  Abre el menú <strong>⋮</strong> en la esquina superior derecha de Chrome o Edge.
                </li>
                <li>
                  Pulsa <strong>Instalar aplicación</strong> (o <strong>Añadir a pantalla de inicio</strong>).
                </li>
                <li>
                  Confirma <strong>Instalar</strong> y Vigiant aparecerá en tu cajón de aplicaciones con su propio ícono.
                </li>
              </ol>
            ) : (
              <ol className="space-y-2 text-sm text-slate-700 list-decimal pl-5">
                <li>
                  Haz clic en el ícono de <strong>Instalar aplicación</strong> en la barra de direcciones de Chrome o Edge.
                </li>
                <li>
                  Si no aparece en la barra, abre el menú <strong>⋮ → Guardar y compartir → Instalar Vigiant…</strong>
                </li>
                <li>
                  Confirma <strong>Instalar</strong> para usar Vigiant como aplicación independiente.
                </li>
              </ol>
            )}

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-2">
              <div className="flex items-center justify-between gap-2 text-slate-600">
                <span>Enlace directo de instalación</span>
                <span className={swReady ? 'text-[#2E7D32] font-medium' : 'text-slate-500'}>
                  {swReady ? 'Service Worker listo' : 'Manifiesto PWA activo'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={directUrl}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white font-mono text-[11px] text-slate-700"
                />
                <button
                  type="button"
                  onClick={handleCopyUrl}
                  className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium cursor-pointer shrink-0"
                >
                  {copiedUrl ? <Check className="w-3.5 h-3.5 text-[#2E7D32]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedUrl ? 'Copiado' : 'Copiar'}</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full min-h-[44px] rounded-xl bg-[#1565C0] text-white text-sm font-medium hover:bg-[#0D47A1] cursor-pointer"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
}
