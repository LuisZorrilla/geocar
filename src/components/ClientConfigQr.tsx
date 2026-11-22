import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { AlertTriangle, Download, Printer, QrCode, X } from 'lucide-react';
import type { PhonePlatform } from '../shared/types.ts';
import { buildClientConfigUri, CLIENT_QR_MIN_VERSION, PLATFORM_LABELS } from '../shared/phone.ts';
import { CopyField } from './ConnectionView.tsx';

interface QrProps {
  identifier: string;
  serverUrl: string | null | undefined;
  platform: PhonePlatform;
  driverName: string;
  /** Smaller layout (inside the wizard). */
  compact?: boolean;
}

const QR_OPTIONS = { errorCorrectionLevel: 'M' as const, margin: 2, color: { dark: '#0F172A', light: '#FFFFFF' } };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * QR with the whole Traccar Client configuration (Server URL, identifier and recommended settings).
 * The driver scans it from the app and it is configured without typing anything.
 */
export function ClientConfigQr({ identifier, serverUrl, platform, driverName, compact }: QrProps) {
  const uri = buildClientConfigUri({ identifier, serverUrl, platform });
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let alive = true;
    if (!uri) {
      setSvg('');
      return;
    }
    QRCode.toString(uri, { ...QR_OPTIONS, type: 'svg' })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [uri]);

  if (!uri) {
    return (
      <p className="flex items-start gap-1.5 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
        Falta la Server URL de los celulares: configúrala en «Datos para Traccar Client» para generar el QR.
      </p>
    );
  }

  const downloadPng = async () => {
    const url = await QRCode.toDataURL(uri, { ...QR_OPTIONS, width: 640 });
    const a = document.createElement('a');
    a.href = url;
    a.download = `QR-${identifier}.png`;
    a.click();
  };

  const print = () => {
    const w = window.open('', '_blank', 'width=520,height=720');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>QR ${escapeHtml(identifier)}</title>
<style>body{font-family:system-ui,sans-serif;color:#0F172A;text-align:center;padding:24px}svg{width:300px;height:300px}
h1{font-size:18px;margin:0 0 4px}p{font-size:13px;margin:4px 0}ol{text-align:left;font-size:13px;max-width:380px;margin:16px auto}
code{font-size:14px}</style></head><body>
<h1>Traccar Client · ${escapeHtml(driverName)}</h1>
<p>Identificador <code>${escapeHtml(identifier)}</code> · ${PLATFORM_LABELS[platform]}</p>
${svg}
<ol><li>Instalá <b>Traccar Client</b> (${CLIENT_QR_MIN_VERSION} o posterior).</li>
<li>En la app: <b>Ajustes → Escanear código QR</b> y apuntá a este código.</li>
<li>Permití la ubicación «Siempre» y activá el rastreo continuo.</li></ol>
<script>window.onload=()=>{window.print()}</script></body></html>`);
    w.document.close();
  };

  return (
    <div className={`flex ${compact ? 'flex-col sm:flex-row' : 'flex-col'} items-center gap-3`}>
      <div
        role="img"
        aria-label={`Código QR de configuración de Traccar Client para ${identifier}`}
        className={`shrink-0 bg-white rounded-lg p-1 ${compact ? 'w-40 h-40' : 'w-56 h-56'} [&>svg]:w-full [&>svg]:h-full`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="min-w-0 w-full space-y-2 text-[11px] text-slate-400">
        <p className="text-slate-300">
          En Traccar Client ({CLIENT_QR_MIN_VERSION} o posterior): <b>Ajustes → Escanear código QR</b>. Carga el identificador, la Server URL y los ajustes
          recomendados de {PLATFORM_LABELS[platform]}.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void downloadPng()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-slate-200 border border-slate-700 hover:bg-slate-800 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden /> Descargar PNG
          </button>
          <button
            type="button"
            onClick={print}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-slate-200 border border-slate-700 hover:bg-slate-800 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" aria-hidden /> Imprimir
          </button>
        </div>
        <CopyField label="Enlace de configuración (se abre en el celular)" value={uri} />
      </div>
    </div>
  );
}

/** Button + dialog with the configuration QR (phone table, driver panel). */
export function ClientConfigQrButton(props: Omit<QrProps, 'compact'> & { className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="QR de configuración de Traccar Client"
        aria-label={`QR de configuración del celular de ${props.driverName}`}
        className={props.className ?? 'p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer'}
      >
        <QrCode className="w-3.5 h-3.5" aria-hidden />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-dialog-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#0F172A] border border-slate-800 rounded-2xl p-5 space-y-3 text-left whitespace-normal"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="qr-dialog-title" className="text-sm font-semibold text-slate-100">
                  QR de configuración
                </h3>
                <p className="text-xs text-slate-400">
                  {props.driverName} · <span className="font-mono">{props.identifier}</span>
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar" className="p-1 rounded hover:bg-slate-800 text-slate-400 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ClientConfigQr {...props} />
          </div>
        </div>
      )}
    </>
  );
}
