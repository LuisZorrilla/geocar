import { useMemo, useState, type ComponentProps } from 'react';
import { Cctv, Search, ShieldCheck, Wifi } from 'lucide-react';
import { DashcamConfigPanel } from './DashcamConfigPanel.tsx';
import { ConnectionView } from './ConnectionView.tsx';
import { ObdTelemetryView, type ObdAssignPayload } from './ObdTelemetryView.tsx';
import { PhoneTrackingView } from './PhoneTrackingView.tsx';
import type { Vehicle } from '../shared/types.ts';

type CameraConfigViewProps = ComponentProps<typeof DashcamConfigPanel> &
  Pick<ComponentProps<typeof ConnectionView>, 'deviceConnection' | 'unmatchedDevices' | 'onUpdateConnection'> & {
    vehicles: Vehicle[];
    onAssignObd: (vehicleId: string, payload: ObdAssignPayload) => Promise<boolean>;
    onRemoveObd: (vehicleId: string) => Promise<boolean>;
    onRefreshObd: (vehicleId: string) => Promise<void>;
    onSyncObd: (vehicleId: string) => Promise<boolean>;
    onObdCommand: (vehicleId: string, commandId: string, option?: string) => Promise<boolean>;
    onNotify: (kind: 'ok' | 'err', message: string) => void;
    onDeviceConnectionChange: (dc: ComponentProps<typeof ConnectionView>['deviceConnection']) => void;
  };

/**
 * Sidebar section "Configuración de Cámaras". Wraps DashcamConfigPanel
 * (bulk matrix, per-device inspector and driver catalog) with a header,
 * a fleet summary and the device search that the panel itself lacks.
 */
export function CameraConfigView(props: CameraConfigViewProps) {
  const { deviceConnection, unmatchedDevices, onUpdateConnection, vehicles, onAssignObd, onRemoveObd, onRefreshObd, onSyncObd, onObdCommand, onNotify, onDeviceConnectionChange, ...panelProps } =
    props;
  const { dashcamDrivers, tenant, activeRole } = panelProps;
  // OBD-II trackers are devices too, but they are managed in their own tab.
  const allDevices = panelProps.devices;
  const devices = useMemo(() => allDevices.filter((d) => d.role !== 'telemetria'), [allDevices]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'configuracion' | 'conexion' | 'obd' | 'smartphone'>('configuracion');

  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter(
      (d) =>
        d.unitCode.toLowerCase().includes(q) ||
        d.imei.toLowerCase().includes(q) ||
        d.model.toLowerCase().includes(q) ||
        d.firmware.toLowerCase().includes(q) ||
        d.dashcamConfig.driverCode.toLowerCase().includes(q)
    );
  }, [devices, search]);

  const summary = useMemo(
    () => ({
      total: devices.length,
      validated: devices.filter((d) => d.hardwareValidated).length,
      connected: devices.filter((d) => d.linkStatus === 'conectado').length,
      pendingSync: devices.filter((d) => d.dashcamConfig.syncStatus !== 'sincronizado').length,
    }),
    [devices]
  );

  const readOnly = activeRole.permissions.dashcams_config === 'read';

  return (
    <div className="space-y-5">
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-sky-600/15 border border-sky-500/30 flex items-center justify-center shrink-0">
            <Cctv className="w-5 h-5 text-sky-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100">Configuración de Cámaras</h2>
            <p className="text-xs text-slate-400 truncate">
              Drivers, canales, resolución y prestaciones ADAS/DMS de las dashcams de {tenant.name}
              {readOnly ? ' · solo lectura' : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-md bg-[#0B1120] border border-slate-800 text-slate-300">
            {summary.total} equipos
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0B1120] border border-slate-800 text-emerald-300">
            <Wifi className="w-3.5 h-3.5" />
            {summary.connected} conectados
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0B1120] border border-slate-800 text-sky-300">
            <ShieldCheck className="w-3.5 h-3.5" />
            {summary.validated} validados
          </span>
          {summary.pendingSync > 0 && (
            <span className="px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300">
              {summary.pendingSync} pendientes de sincronizar
            </span>
          )}
          <span className="px-2.5 py-1 rounded-md bg-[#0B1120] border border-slate-800 text-slate-300">
            {dashcamDrivers.length} drivers
          </span>
        </div>

        {view === 'configuracion' && (
        <div className="relative w-full sm:w-auto">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar unidad, IMEI, modelo, firmware..."
            aria-label="Buscar equipos de cámara"
            className="pl-8 pr-3 py-1.5 w-full sm:w-64 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>
        )}
      </div>

      <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 w-fit" role="tablist">
        {(
          [
            { id: 'configuracion', label: 'Configuración del equipo' },
            { id: 'conexion', label: 'Conexión (Starlink → servidor)' },
            { id: 'obd', label: 'Telemetría OBD-II' },
            { id: 'smartphone', label: 'Conexión Smartphone' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view === t.id}
            onClick={() => setView(t.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              view === t.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'configuracion' ? (
        <DashcamConfigPanel {...panelProps} devices={filteredDevices} />
      ) : view === 'smartphone' ? (
        <PhoneTrackingView
          deviceConnection={deviceConnection}
          activeRole={activeRole}
          isGlobalSuperadmin={panelProps.isGlobalSuperadmin}
          scopeKey={tenant.id}
          companyName={tenant.id === 'all' ? undefined : tenant.name}
          onNotify={onNotify}
          onDeviceConnectionChange={onDeviceConnectionChange}
        />
      ) : view === 'obd' ? (
        <ObdTelemetryView
          vehicles={vehicles}
          devices={allDevices}
          deviceConnection={deviceConnection}
          unmatchedDevices={unmatchedDevices}
          activeRole={activeRole}
          isGlobalSuperadmin={panelProps.isGlobalSuperadmin}
          onAssign={onAssignObd}
          onRemove={onRemoveObd}
          onRefresh={onRefreshObd}
          onSync={onSyncObd}
          onCommand={onObdCommand}
          onNotify={onNotify}
          onDeviceConnectionChange={onDeviceConnectionChange}
        />
      ) : (
        <ConnectionView
          devices={devices}
          deviceConnection={deviceConnection}
          unmatchedDevices={unmatchedDevices}
          activeRole={activeRole}
          isGlobalSuperadmin={panelProps.isGlobalSuperadmin}
          onUpdateConnection={onUpdateConnection}
          onNotify={onNotify}
          onDeviceConnectionChange={onDeviceConnectionChange}
        />
      )}
    </div>
  );
}
