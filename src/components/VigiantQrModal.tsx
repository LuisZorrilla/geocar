import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, ExternalLink, QrCode, Smartphone, X } from 'lucide-react';
import type { Device, VigiantAccuracyLevel } from '../shared/types.ts';
import { buildVigiantShareUrl } from '../vigiant/storage.ts';

interface VigiantQrModalProps {
  open: boolean;
  device: Device | null;
  onClose: () => void;
}

export function VigiantQrModal({ open, device, onClose }: VigiantQrModalProps) {
  const [deviceId, setDeviceId] = useState('');
  const [accuracy, setAccuracy] = useState<VigiantAccuracyLevel>('high');
  const [intervalSec, setIntervalSec] = useState(15);
  const [distanceMeters, setDistanceMeters] = useState(25);
  const [offlineBuffer, setOfflineBuffer] = useState(true);
  const [wakeLock, setWakeLock] = useState(true);
  const [qrUrl, setQrUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDeviceId(device?.imei || `VIG-${Math.floor(100000 + Math.random() * 900000)}`);
    setIntervalSec(device?.dashcamConfig.gpsIntervalSec || 15);
  }, [open, device]);

  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  const provisioningUrl = buildVigiantShareUrl(
    {
      deviceId: deviceId || '000000',
      serverUrl: `${origin}/api/osmand`,
      accuracy,
      intervalSec,
      distanceMeters,
      angleDegrees: accuracy === 'highest' ? 25 : 0,
      stationaryHeartbeatSec: 300,
      fastestIntervalSec: 5,
      offlineBuffer,
      wakeLock,
      stopDetection: true,
      serviceEnabled: false,
    },
    origin
  );

  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(provisioningUrl, {
      width: 260,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then(setQrUrl)
      .catch(() => setQrUrl(''));
  }, [open, provisioningUrl]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(provisioningUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl bg-[#11192C] border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <QrCode className="w-5 h-5 text-sky-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100 truncate">
                Aprovisionamiento App Móvil Vigiant (QR OsmAnd)
              </h3>
              <p className="text-xs text-slate-400 truncate">
                {device
                  ? `Vinculado a ${device.unitCode} · IMEI/ID ${device.imei}`
                  : 'Generar perfil móvil Vigiant independiente'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer"
            aria-label="Cerrar modal QR"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-12 gap-5 text-xs">
          {/* Left: QR Preview */}
          <div className="md:col-span-5 flex flex-col items-center justify-center bg-[#0B1120] border border-slate-800 rounded-xl p-4 space-y-3">
            {qrUrl ? (
              <img
                src={qrUrl}
                alt={`QR Vigiant ${deviceId}`}
                className="w-48 h-48 rounded-lg bg-white p-1.5"
              />
            ) : (
              <div className="w-48 h-48 rounded-lg bg-slate-900 flex items-center justify-center text-slate-500">
                Generando QR...
              </div>
            )}
            <div className="text-center text-[11px] text-slate-400">
              Escanea desde <span className="text-sky-300 font-medium">Vigiant → QR</span> en el smartphone del operador.
            </div>
          </div>

          {/* Right: Parameters & Launch */}
          <div className="md:col-span-7 space-y-3">
            <div>
              <label className="block text-slate-300 mb-1">Identificador del dispositivo (id)</label>
              <input
                type="text"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 mb-1">Precisión GPS</label>
                <select
                  value={accuracy}
                  onChange={(e) => setAccuracy(e.target.value as VigiantAccuracyLevel)}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="highest">Máxima</option>
                  <option value="high">Alta</option>
                  <option value="medium">Media</option>
                  <option value="low">Baja</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-300 mb-1">Intervalo (seg)</label>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(Math.max(1, Number(e.target.value) || 15))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 mb-1">Distancia (metros)</label>
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={distanceMeters}
                  onChange={(e) => setDistanceMeters(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="flex flex-col justify-end gap-1.5 pb-1">
                <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={offlineBuffer}
                    onChange={(e) => setOfflineBuffer(e.target.checked)}
                  />
                  <span>Búfer offline IndexedDB</span>
                </label>
                <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wakeLock}
                    onChange={(e) => setWakeLock(e.target.checked)}
                  />
                  <span>Wake Lock activo</span>
                </label>
              </div>
            </div>

            <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800 text-[11px] font-mono text-slate-400 break-all">
              Endpoint OsmAnd: {origin}/api/osmand
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Enlace copiado' : 'Copiar enlace QR'}
              </button>

              <a
                href={provisioningUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium cursor-pointer"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Abrir App Vigiant</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
