import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  Battery,
  BatteryCharging,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Database,
  ExternalLink,
  Gauge,
  LocateFixed,
  Navigation,
  QrCode,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  ShieldAlert,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { VigiantAccuracyLevel, VigiantLogEntry } from '../shared/types.ts';
import { getDefaultServerUrl } from './storage.ts';
import { useVigiantEngine } from './useVigiantEngine.ts';
import { PWAInstallButton } from './PWAInstallButton.tsx';
import { VigiantQrPanel } from './VigiantQrPanel.tsx';

type VigiantTab = 'principal' | 'estado' | 'ajustes' | 'qr';

const ACCURACY_LABELS: Record<VigiantAccuracyLevel, { title: string; desc: string }> = {
  highest: { title: 'Máxima (GPS continuo)', desc: 'Desbloquea ángulo y máxima precisión' },
  high: { title: 'Alta (GPS + red)', desc: 'Equilibrio estándar recomendado' },
  medium: { title: 'Media (Wi-Fi / Celda)', desc: 'Ahorro energético en ciudad' },
  low: { title: 'Baja (Solo torre celular)', desc: 'Mínimo consumo de batería' },
};

function formatTimeOnly(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoStr.slice(11, 19);
  }
}

export function VigiantApp() {
  const engine = useVigiantEngine();
  const [activeTab, setActiveTab] = useState<VigiantTab>('principal');
  const [logFilter, setLogFilter] = useState<'all' | VigiantLogEntry['level']>('all');
  const [sosConfirmOpen, setSosConfirmOpen] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  // Handle PWA shortcut deep links (?tab=estado or ?action=sos)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'estado' || tabParam === 'ajustes' || tabParam === 'qr' || tabParam === 'principal') {
      setActiveTab(tabParam);
    }
    if (params.get('action') === 'sos') {
      setSosConfirmOpen(true);
    }
  }, []);

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return engine.logs;
    return engine.logs.filter((l) => l.level === logFilter);
  }, [engine.logs, logFilter]);

  const handleCopyDiagnostics = async () => {
    const lines = [
      `Vigiant Mobile Client · Diagnóstico`,
      `ID Dispositivo: ${engine.config.deviceId}`,
      `Servidor: ${engine.config.serverUrl}`,
      `Servicio: ${engine.config.serviceEnabled ? 'Activo' : 'Detenido'}`,
      `Red: ${engine.isOnline ? 'En línea' : 'Sin conexión'}`,
      `Cola Offline: ${engine.offlineQueue.length}`,
      `--- Últimos registros ---`,
      ...engine.logs.slice(0, 30).map(
        (l) => `[${formatTimeOnly(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}${l.httpStatus ? ` (HTTP ${l.httpStatus})` : ''}${l.detail ? ` — ${l.detail}` : ''}`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedDiag(true);
      window.setTimeout(() => setCopiedDiag(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleTriggerSos = async () => {
    setSosConfirmOpen(false);
    await engine.sendSos();
  };

  const renderPrincipalPanel = () => (
    <div className="space-y-4">
      {/* Primary Service Switch Card (Traccar MainFragment Parity) */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-500">Estado del servicio</div>
            <div className="text-lg font-bold text-slate-900 mt-0.5">
              {engine.config.serviceEnabled ? 'Servicio en ejecución' : 'Servicio detenido'}
            </div>
            <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-1.5">
              <span className={engine.config.serviceEnabled ? 'text-[#2E7D32] font-medium' : 'text-slate-600'}>
                {engine.config.serviceEnabled ? 'Transmitiendo telemetría' : 'Rastreo pausado'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700">ID {engine.config.deviceId}</span>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={engine.config.serviceEnabled}
            aria-label="Activar o detener servicio Vigiant"
            onClick={() => engine.updateConfig({ serviceEnabled: !engine.config.serviceEnabled })}
            className={`relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1565C0] ${
              engine.config.serviceEnabled ? 'bg-[#2E7D32]' : 'bg-slate-300'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow-sm transition-transform ${
                engine.config.serviceEnabled ? 'translate-x-6' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {engine.gpsError && (
          <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
            {engine.gpsError}
          </div>
        )}
      </section>

      {/* Quick Action Shortcuts (SOS, Send Now, Scan QR, Sync Buffer) */}
      <section className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          disabled={engine.sendingSos}
          onClick={() => setSosConfirmOpen(true)}
          className="min-h-[52px] flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[#D32F2F] hover:bg-[#B71C1C] active:scale-[0.99] text-white text-sm font-semibold shadow-xs cursor-pointer transition-all disabled:opacity-60"
        >
          <AlertOctagon className="w-5 h-5 shrink-0" />
          <span>{engine.sendingSos ? 'Enviando SOS...' : 'Enviar SOS'}</span>
        </button>

        <button
          type="button"
          onClick={() => engine.sendPositionNow()}
          className="min-h-[52px] flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[#1565C0] hover:bg-[#0D47A1] active:scale-[0.99] text-white text-sm font-semibold shadow-xs cursor-pointer transition-all"
        >
          <Send className="w-4 h-4 shrink-0" />
          <span>Enviar ubicación</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('qr')}
          className="min-h-[44px] flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-800 text-xs font-medium cursor-pointer"
        >
          <QrCode className="w-4 h-4 text-[#1565C0] shrink-0" />
          <span>Escanear QR</span>
        </button>

        <button
          type="button"
          disabled={engine.offlineQueue.length === 0 || !engine.isOnline || engine.syncingQueue}
          onClick={() => engine.flushOfflineQueue()}
          className="min-h-[44px] flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-medium cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 text-[#1565C0] shrink-0 ${engine.syncingQueue ? 'animate-spin' : ''}`} />
          <span className="tabular-nums">
            Sincronizar búfer ({engine.offlineQueue.length})
          </span>
        </button>
      </section>

      {/* Live GPS & Device Telemetry Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Telemetría del dispositivo</h2>
          <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none min-h-[36px]">
            <input
              type="checkbox"
              checked={engine.simulateRoute}
              onChange={(e) => engine.setSimulateRoute(e.target.checked)}
              className="rounded border-slate-300 text-[#1565C0] focus:ring-[#1565C0]"
            />
            <span>Simular ruta GPS (San Juan)</span>
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              <LocateFixed className="w-3.5 h-3.5 text-[#1565C0]" />
              <span>Coordenadas</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1 text-[11px]">
              {engine.currentFix
                ? `${engine.currentFix.lat.toFixed(5)}, ${engine.currentFix.lon.toFixed(5)}`
                : 'Sin fijación aún'}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              <Gauge className="w-3.5 h-3.5 text-[#1565C0]" />
              <span>Velocidad</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              {engine.currentFix ? `${engine.currentFix.speedKmh} km/h` : '0 km/h'}
              <span className="text-[11px] font-normal text-slate-500 ml-1">
                ({engine.currentFix ? engine.currentFix.speedKnots.toFixed(1) : '0.0'} kn)
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              <Compass className="w-3.5 h-3.5 text-[#1565C0]" />
              <span>Rumbo / Precisión</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              {engine.currentFix ? `${Math.round(engine.currentFix.bearing)}° · ±${engine.currentFix.accuracy} m` : '--'}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              {engine.battery.charging ? (
                <BatteryCharging className="w-3.5 h-3.5 text-[#2E7D32]" />
              ) : (
                <Battery className="w-3.5 h-3.5 text-[#1565C0]" />
              )}
              <span>Batería</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              {engine.battery.levelPct}% {engine.battery.charging ? '· Cargando' : ''}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              <Database className="w-3.5 h-3.5 text-[#ED6C02]" />
              <span>Búfer offline</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              {engine.offlineQueue.length} pendiente(s)
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
            <div className="text-slate-500 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-[#1565C0]" />
              <span>Último envío</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              {engine.lastSyncAt ? formatTimeOnly(engine.lastSyncAt) : 'Pendiente'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 pt-1">
          <span>
            Estado: {engine.motionState === 'moving' ? 'En movimiento' : 'Estacionario'}
          </span>
          <span aria-hidden="true">·</span>
          <span>Wake Lock: {engine.wakeLockActive ? 'Activo' : engine.config.wakeLock ? 'En espera' : 'Desactivado'}</span>
          <span aria-hidden="true">·</span>
          <span>Origen: {engine.currentFix?.source === 'simulado' ? 'Ruta simulada' : 'GPS nativo'}</span>
        </div>
      </section>

      {/* Traccar Client Preference Summary Rows */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs divide-y divide-slate-100">
        {[
          {
            title: 'Identificador del dispositivo',
            subtitle: engine.config.deviceId,
            tab: 'ajustes' as VigiantTab,
          },
          {
            title: 'URL del servidor',
            subtitle: engine.config.serverUrl,
            tab: 'ajustes' as VigiantTab,
          },
          {
            title: 'Precisión y frecuencia',
            subtitle: `${ACCURACY_LABELS[engine.config.accuracy].title} · ${engine.config.intervalSec}s · ${engine.config.distanceMeters}m`,
            tab: 'ajustes' as VigiantTab,
          },
          {
            title: 'Búfer offline y Wake Lock',
            subtitle: `Búfer: ${engine.config.offlineBuffer ? 'Activado' : 'Desactivado'} · Wake Lock: ${engine.config.wakeLock ? 'Sí' : 'No'} · Parada: ${engine.config.stopDetection ? 'Sí' : 'No'}`,
            tab: 'ajustes' as VigiantTab,
          },
          {
            title: 'Estado y registros de transmisión',
            subtitle: `${engine.logs.length} evento(s) registrados`,
            tab: 'estado' as VigiantTab,
          },
        ].map((row) => (
          <button
            key={row.title}
            type="button"
            onClick={() => setActiveTab(row.tab)}
            className="w-full min-h-[58px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900">{row.title}</div>
              <div className="text-xs font-mono text-slate-500 truncate mt-0.5">{row.subtitle}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>
        ))}
      </section>

      <PWAInstallButton variant="card" />
    </div>
  );

  const renderStatusLogsPanel = () => (
    <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
      <div className="p-4 border-b border-slate-200 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Estado y registros</h2>
            <p className="text-xs text-slate-500">
              Bitácora de servicio, respuestas OsmAnd HTTP y cola offline ({engine.offlineQueue.length} pendiente).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyDiagnostics}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              {copiedDiag ? 'Copiado' : 'Copiar'}
            </button>
            <button
              type="button"
              onClick={() => engine.clearLogs()}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Limpiar
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: `Todos (${engine.logs.length})` },
              { id: 'ok', label: 'Envíos OK' },
              { id: 'warn', label: 'Búfer / Red' },
              { id: 'sos', label: 'SOS' },
              { id: 'error', label: 'Errores' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setLogFilter(f.id)}
              className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                logFilter === f.id
                  ? 'bg-[#1565C0] border-[#1565C0] text-white'
                  : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {engine.offlineQueue.length > 0 && (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-amber-900">
              <strong>{engine.offlineQueue.length}</strong> posición(es) guardadas en IndexedDB esperando sincronización.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!engine.isOnline || engine.syncingQueue}
                onClick={() => engine.flushOfflineQueue()}
                className="min-h-[36px] px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium cursor-pointer"
              >
                {engine.syncingQueue ? 'Enviando...' : 'Sincronizar ahora'}
              </button>
              <button
                type="button"
                onClick={() => engine.clearQueue()}
                className="min-h-[36px] px-2.5 py-1 rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-100 font-medium cursor-pointer"
              >
                Vaciar
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="max-h-[480px] overflow-y-auto divide-y divide-slate-100">
        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No hay eventos en esta categoría. Activa el servicio o pulsa "Enviar ubicación" para ver la bitácora en vivo.
          </div>
        ) : (
          filteredLogs.map((log) => {
            const levelText =
              log.level === 'ok'
                ? 'text-[#2E7D32]'
                : log.level === 'sos'
                  ? 'text-[#D32F2F] font-bold'
                  : log.level === 'warn'
                    ? 'text-[#ED6C02]'
                    : log.level === 'error'
                      ? 'text-rose-700'
                      : 'text-[#1565C0]';

            return (
              <div key={log.id} className="px-4 py-3 text-xs space-y-0.5 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-medium ${levelText}`}>{log.message}</span>
                  <span className="font-mono tabular-nums text-slate-400 shrink-0">
                    {log.httpStatus ? `HTTP ${log.httpStatus} · ` : ''}
                    {formatTimeOnly(log.timestamp)}
                  </span>
                </div>
                {log.detail && <div className="font-mono text-[11px] text-slate-500">{log.detail}</div>}
              </div>
            );
          })
        )}
      </div>
    </section>
  );

  const renderSettingsPanel = () => (
    <div className="space-y-4">
      <PWAInstallButton variant="card" />

      {/* Group 1: Device & Server */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        <h2 className="text-sm font-semibold text-[#1565C0]">Identificación y servidor</h2>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-700">Identificador del dispositivo (ID / IMEI)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={engine.config.deviceId}
              onChange={(e) => engine.updateConfig({ deviceId: e.target.value.trim() || '000000' })}
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
            <button
              type="button"
              onClick={() =>
                engine.updateConfig({ deviceId: String(Math.floor(100000 + Math.random() * 900000)) })
              }
              className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap"
            >
              Nuevo ID
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Debe coincidir con el IMEI o código de unidad registrado, o creará una unidad móvil Vigiant automáticamente.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-700">URL del servidor OsmAnd</label>
          <input
            type="url"
            value={engine.config.serverUrl}
            onChange={(e) => engine.updateConfig({ serverUrl: e.target.value })}
            placeholder="https://servidor:5055"
            className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono text-xs text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">Protocolo HTTP OsmAnd (puerto 5055 o /api/osmand)</span>
            <button
              type="button"
              onClick={() => engine.updateConfig({ serverUrl: getDefaultServerUrl() })}
              className="text-xs font-medium text-[#1565C0] hover:underline cursor-pointer"
            >
              Usar servidor local
            </button>
          </div>
        </div>
      </section>

      {/* Group 2: Tracking & Accuracy */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        <h2 className="text-sm font-semibold text-[#1565C0]">Ubicación y frecuencia</h2>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-700">Precisión de ubicación</label>
          <select
            value={engine.config.accuracy}
            onChange={(e) => engine.updateConfig({ accuracy: e.target.value as VigiantAccuracyLevel })}
            className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
          >
            {(Object.keys(ACCURACY_LABELS) as VigiantAccuracyLevel[]).map((acc) => (
              <option key={acc} value={acc}>
                {ACCURACY_LABELS[acc].title} — {ACCURACY_LABELS[acc].desc}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Intervalo (segundos)</label>
            <input
              type="number"
              min={1}
              max={86400}
              value={engine.config.intervalSec}
              onChange={(e) => engine.updateConfig({ intervalSec: Math.max(1, Number(e.target.value) || 30) })}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Distancia (metros · 0 = desact.)</label>
            <input
              type="number"
              min={0}
              max={50000}
              value={engine.config.distanceMeters}
              onChange={(e) => engine.updateConfig({ distanceMeters: Math.max(0, Number(e.target.value) || 0) })}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Ángulo de giro (° · solo Máxima)
            </label>
            <input
              type="number"
              min={0}
              max={180}
              disabled={engine.config.accuracy !== 'highest'}
              value={engine.config.angleDegrees}
              onChange={(e) =>
                engine.updateConfig({ angleDegrees: Math.max(0, Math.min(180, Number(e.target.value) || 0)) })
              }
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 disabled:opacity-50 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Latido estacionario (segundos)</label>
            <input
              type="number"
              min={5}
              max={86400}
              value={engine.config.stationaryHeartbeatSec}
              onChange={(e) =>
                engine.updateConfig({ stationaryHeartbeatSec: Math.max(5, Number(e.target.value) || 300) })
              }
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Intervalo más rápido (segundos mínimos entre envíos)
            </label>
            <input
              type="number"
              min={1}
              max={3600}
              value={engine.config.fastestIntervalSec}
              onChange={(e) =>
                engine.updateConfig({ fastestIntervalSec: Math.max(1, Number(e.target.value) || 5) })
              }
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-[#1565C0] focus:bg-white"
            />
          </div>
        </div>
      </section>

      {/* Group 3: Advanced Power & Buffering */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs divide-y divide-slate-100">
        <div className="px-4 py-3 bg-slate-50/70">
          <h2 className="text-sm font-semibold text-[#1565C0]">Energía, resiliencia y detección</h2>
        </div>

        {(
          [
            {
              key: 'offlineBuffer' as const,
              title: 'Búfer sin conexión',
              desc: 'Almacena ubicaciones en IndexedDB si falla la red y sincroniza al reconectar.',
            },
            {
              key: 'wakeLock' as const,
              title: 'Wake Lock (mantener despierto)',
              desc: 'Evita suspensión del dispositivo mientras el servicio de rastreo está activo.',
            },
            {
              key: 'stopDetection' as const,
              title: 'Detección de detención',
              desc: 'Cambia al intervalo estacionario cuando la unidad permanece inmóvil.',
            },
          ]
        ).map((item) => {
          const checked = engine.config[item.key];
          return (
            <div key={item.key} className="min-h-[64px] px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">{item.title}</div>
                <div className="text-xs text-slate-500 mt-0.5">{item.desc}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={item.title}
                onClick={() => engine.updateConfig({ [item.key]: !checked })}
                className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                  checked ? 'bg-[#1565C0]' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-xs transition-transform ${
                    checked ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </section>

      {/* Reset & About */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <button
          type="button"
          onClick={() => engine.resetConfig()}
          className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          Restablecer ajustes
        </button>

        <div className="text-xs text-slate-500">
          Vigiant PWA · Protocolo OsmAnd compatible con Traccar
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F4F6F9] text-slate-900 pb-20 lg:pb-8">
      {/* Material Top App Bar (52px height) */}
      <header className="sticky top-0 z-30 h-[52px] bg-[#1565C0] text-white shadow-sm px-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
            <Navigation className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold tracking-tight leading-none">Vigiant</div>
            <div className="text-[11px] text-blue-100 flex items-center gap-1.5 mt-0.5 truncate">
              <span>{engine.config.serviceEnabled ? 'Servicio activo' : 'Detenido'}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                {engine.isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {engine.isOnline ? 'En línea' : 'Sin red'}
              </span>
            </div>
          </div>
        </div>

        {/* Desktop Nav Tabs + Actions */}
        <nav className="hidden lg:flex items-center gap-1">
          {(
            [
              { id: 'principal', label: 'Principal' },
              { id: 'estado', label: 'Estado' },
              { id: 'ajustes', label: 'Ajustes' },
              { id: 'qr', label: 'QR' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
                activeTab === t.id ? 'bg-white text-[#1565C0]' : 'text-blue-100 hover:bg-white/10'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton variant="header" />
          <a
            href="/"
            className="hidden sm:inline-flex items-center gap-1 min-h-[36px] px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white whitespace-nowrap"
          >
            <span>Panel</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      {/* Main Content Container: Mobile 1-col / Desktop 2-col balanced layout */}
      <main className="max-w-6xl mx-auto p-4 lg:p-6">
        {/* Mobile Tab Switch */}
        <div className="lg:hidden">
          {activeTab === 'principal' && renderPrincipalPanel()}
          {activeTab === 'estado' && renderStatusLogsPanel()}
          {activeTab === 'ajustes' && renderSettingsPanel()}
          {activeTab === 'qr' && <VigiantQrPanel config={engine.config} onApplyQrText={engine.applyQrText} />}
        </div>

        {/* Desktop Multi-Column Presence (No narrow strip trapped in void) */}
        <div className="hidden lg:grid lg:grid-cols-12 lg:gap-6 items-start">
          <div className="lg:col-span-6 space-y-4">
            {renderPrincipalPanel()}
            {activeTab === 'qr' && <VigiantQrPanel config={engine.config} onApplyQrText={engine.applyQrText} />}
          </div>
          <div className="lg:col-span-6 space-y-4">
            {activeTab === 'ajustes' ? (
              renderSettingsPanel()
            ) : activeTab === 'estado' ? (
              renderStatusLogsPanel()
            ) : (
              <>
                {renderStatusLogsPanel()}
                {renderSettingsPanel()}
              </>
            )}
          </div>
        </div>
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (56px height) */}
      <nav
        aria-label="Navegación principal Vigiant"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-[56px] bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-4 items-center"
      >
        {(
          [
            { id: 'principal', label: 'Principal', icon: Smartphone },
            { id: 'estado', label: 'Estado', icon: Activity },
            { id: 'ajustes', label: 'Ajustes', icon: Settings },
            { id: 'qr', label: 'QR', icon: QrCode },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium cursor-pointer ${
                active ? 'text-[#1565C0]' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* SOS Confirmation Sheet / Modal */}
      {sosConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-white p-6 text-slate-900 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-100 text-[#D32F2F] flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Confirmar alerta SOS</h3>
                <p className="text-xs text-slate-600 mt-1">
                  Se enviará de inmediato una trama de emergencia <span className="font-mono">alarm=sos</span> con tu posición actual al centro de monitoreo.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setSosConfirmOpen(false)}
                className="min-h-[44px] rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleTriggerSos}
                className="min-h-[44px] rounded-xl bg-[#D32F2F] hover:bg-[#B71C1C] text-sm font-semibold text-white cursor-pointer"
              >
                Enviar SOS ahora
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
