import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { Camera, Check, Copy, ImagePlus, QrCode, StopCircle } from 'lucide-react';
import type { VigiantConfig } from '../shared/types.ts';
import { buildVigiantShareUrl } from './storage.ts';

interface VigiantQrPanelProps {
  config: VigiantConfig;
  onApplyQrText: (rawText: string) => Promise<{ ok: boolean; error?: string; changedKeys: string[] }>;
}

export function VigiantQrPanel({ config, onApplyQrText }: VigiantQrPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanSuccess, setScanSuccess] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const shareUrl = buildVigiantShareUrl(config);

  useEffect(() => {
    QRCode.toDataURL(shareUrl, {
      width: 240,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [shareUrl]);

  const stopCamera = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const handleDecoded = async (text: string) => {
    stopCamera();
    const res = await onApplyQrText(text);
    if (res.ok) {
      setScanError(null);
      setScanSuccess(`Configuración aplicada (${res.changedKeys.join(', ')}).`);
      setManualText('');
    } else {
      setScanSuccess(null);
      setScanError(res.error || 'QR inválido.');
    }
  };

  const startCameraScan = async () => {
    setScanError(null);
    setScanSuccess(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanError('La cámara no está disponible en este navegador. Usa imagen o enlace manual.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setScanning(true);

      window.setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});

        const tick = () => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || !streamRef.current) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imgData.data, imgData.width, imgData.height);
              if (code?.data) {
                handleDecoded(code.data);
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }, 60);
    } catch {
      stopCamera();
      setScanError('Permiso de cámara denegado o cámara no detectada.');
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanError(null);
    setScanSuccess(null);

    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if (code?.data) {
          handleDecoded(code.data);
        } else {
          setScanError('No se detectó un código QR válido en la imagen.');
        }
      }
      URL.revokeObjectURL(objUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      setScanError('No se pudo leer la imagen seleccionada.');
    };
    img.src = objUrl;
    e.target.value = '';
  };

  const handleCopyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="space-y-4">
      <canvas ref={canvasRef} className="hidden" />

      {/* Scanner Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Escanear QR de configuración</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Importa automáticamente el identificador de unidad, URL OsmAnd e intervalos generados desde el panel.
          </p>
        </div>

        {scanError && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
            {scanError}
          </div>
        )}
        {scanSuccess && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
            {scanSuccess}
          </div>
        )}

        {scanning ? (
          <div className="space-y-3">
            <div className="relative rounded-xl overflow-hidden bg-slate-900 aspect-video max-h-[280px] w-full flex items-center justify-center">
              <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
              <div className="absolute inset-0 pointer-events-none border-2 border-[#1565C0]/60 m-6 rounded-xl" />
            </div>
            <button
              type="button"
              onClick={stopCamera}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-medium cursor-pointer"
            >
              <StopCircle className="w-4 h-4" />
              Detener escáner
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={startCameraScan}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#1565C0] hover:bg-[#0D47A1] text-white text-sm font-medium cursor-pointer transition-colors"
            >
              <Camera className="w-4 h-4 shrink-0" />
              Abrir cámara QR
            </button>

            <label className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium cursor-pointer transition-colors">
              <ImagePlus className="w-4 h-4 shrink-0 text-[#1565C0]" />
              <span>Cargar imagen QR</span>
              <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
            </label>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleDecoded(manualText);
          }}
          className="pt-3 border-t border-slate-100 space-y-2"
        >
          <label className="block text-xs font-medium text-slate-700">
            Pegar enlace de configuración, URI (traccar:// / vigiant://) o JSON
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="Ej. https://.../vigiant?id=864201051001001&interval=15"
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
            <button
              type="submit"
              disabled={!manualText.trim()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
            >
              Aplicar enlace
            </button>
          </div>
        </form>
      </section>

      {/* Current Device QR Share Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">QR actual de este dispositivo</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Comparte o clona esta configuración en otro smartphone con Vigiant.
            </p>
          </div>
          <QrCode className="w-5 h-5 text-[#1565C0] shrink-0" />
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR Vigiant ${config.deviceId}`}
              className="w-40 h-40 rounded-xl border border-slate-200 p-1.5 bg-white shrink-0"
            />
          ) : (
            <div className="w-40 h-40 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-400">
              Generando QR...
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-2.5 w-full">
            <div className="text-xs text-slate-600 space-y-1">
              <div>
                Identificador: <span className="font-mono font-semibold text-slate-900">{config.deviceId}</span>
              </div>
              <div className="truncate">
                Servidor: <span className="font-mono text-slate-800">{config.serverUrl}</span>
              </div>
              <div className="font-mono tabular-nums text-slate-500">
                Precisión {config.accuracy} · {config.intervalSec}s · {config.distanceMeters}m · Búfer {config.offlineBuffer ? 'ON' : 'OFF'}
              </div>
            </div>

            <button
              type="button"
              onClick={handleCopyShareUrl}
              className="w-full sm:w-auto min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-800 text-xs font-medium cursor-pointer"
            >
              {copiedLink ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-slate-500" />}
              {copiedLink ? 'Enlace copiado' : 'Copiar enlace de configuración'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
