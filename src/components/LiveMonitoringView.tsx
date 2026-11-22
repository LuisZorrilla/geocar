import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  MapPin,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  Search,
  Video,
  Wrench,
} from 'lucide-react';
import type {
  AlertEvent,
  AssetType,
  Device,
  OperationalStatus,
  RoleDefinition,
  Tenant,
  Vehicle,
} from '../shared/types.ts';
import {
  ASSET_TYPE_LABELS,
  formatRelativeTime,
  LINK_META,
  MAINTENANCE_META,
  STATUS_META,
} from '../lib/api.ts';
import { FleetMap } from './FleetMap.tsx';
import { Pagination, usePagination } from './Pagination.tsx';
import { ExportMenu } from './ExportMenu.tsx';

interface LiveMonitoringViewProps {
  vehicles: Vehicle[];
  devices: Device[];
  alerts: AlertEvent[];
  tenant: Tenant;
  activeRole: RoleDefinition;
  livePolling: boolean;
  onToggleLivePolling: () => void;
  onTickNow: () => void;
  onRequestVideo: (vehicleId: string) => void;
  onOpenDossier: (vehicleId: string) => void;
  /** Opens «Alertas e Incidentes»; with an id, that alert is shown highlighted. */
  onGoToAlerts: (alertId?: string) => void;
}

export function LiveMonitoringView({
  vehicles,
  devices,
  alerts,
  tenant,
  activeRole,
  livePolling,
  onToggleLivePolling,
  onTickNow,
  onRequestVideo,
  onOpenDossier,
  onGoToAlerts,
}: LiveMonitoringViewProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | OperationalStatus>('all');
  const [assetFilter, setAssetFilter] = useState<'all' | AssetType>('all');
  const [search, setSearch] = useState('');
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(
    vehicles[2]?.id ?? vehicles[0]?.id ?? null
  );

  const stats = useMemo(() => {
    const enRuta = vehicles.filter((v) => v.operationalStatus === 'en_ruta').length;
    const heavyCount = vehicles.filter((v) => v.assetType === 'maquinaria_pesada').length;
    const maintDue = vehicles.filter((v) => v.maintenanceStatus !== 'al_dia').length;
    const pendingAlerts = alerts.filter((a) => a.status === 'pendiente').length;
    return { total: vehicles.length, enRuta, heavyCount, maintDue, pendingAlerts };
  }, [vehicles, alerts]);

  const filteredVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (statusFilter !== 'all' && v.operationalStatus !== statusFilter) return false;
      if (assetFilter !== 'all' && v.assetType !== assetFilter) return false;
      if (!q) return true;
      return (
        v.unitCode.toLowerCase().includes(q) ||
        v.plate.toLowerCase().includes(q) ||
        v.driverName.toLowerCase().includes(q) ||
        v.brandModel.toLowerCase().includes(q) ||
        v.branch.toLowerCase().includes(q)
      );
    });
  }, [vehicles, statusFilter, assetFilter, search]);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selectedVehicleId) ?? filteredVehicles[0] ?? null,
    [vehicles, selectedVehicleId, filteredVehicles]
  );

  const selectedDevice = useMemo(
    () => (selectedVehicle ? devices.find((d) => d.id === selectedVehicle.deviceId) ?? null : null),
    [devices, selectedVehicle]
  );

  const rosterPagination = usePagination(
    filteredVehicles,
    `${tenant.id}|${search}|${assetFilter}|${statusFilter}`,
    5
  );

  /** The alert behind «En alerta»: the newest pending one of the unit, else its newest one. */
  const alertOf = (vehicleId: string): AlertEvent | undefined => {
    const own = alerts.filter((a) => a.vehicleId === vehicleId);
    const newest = (list: AlertEvent[]) =>
      list.reduce<AlertEvent | undefined>((best, a) => (!best || Date.parse(a.timestamp) > Date.parse(best.timestamp) ? a : best), undefined);
    return newest(own.filter((a) => a.status === 'pendiente')) ?? newest(own);
  };
  const openAlertOf = (vehicleId: string) => onGoToAlerts(alertOf(vehicleId)?.id);

  const canRequestVideo = activeRole.permissions.video === 'full' || activeRole.permissions.video === 'write';

  return (
    <div className="space-y-5">
      {/* Operational KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400">Activos de {tenant.name}</div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-slate-100">{stats.total}</span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">{stats.heavyCount} maquinaria</span>
          </div>
        </div>
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400">En operación / ruta</div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-emerald-400">{stats.enRuta}</span>
            <span className="text-xs text-slate-400">motor encendido</span>
          </div>
        </div>
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400">Alertas sin confirmar</div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-rose-400">{stats.pendingAlerts}</span>
            <button
              type="button"
              onClick={() => onGoToAlerts()}
              className="text-xs text-sky-400 hover:text-sky-300 transition-colors cursor-pointer whitespace-nowrap"
            >
              Atender bandeja
            </button>
          </div>
        </div>
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400">Mantenimiento próximo/vencido</div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-amber-400">{stats.maintDue}</span>
            <span className="text-xs text-slate-400">revisar horómetro</span>
          </div>
        </div>
      </div>

      {/* Main split workspace: Map + Collapsible Right Operational Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-stretch">
        {/* Left: Esri Map Viewport */}
        <div className={`${rightCollapsed ? 'xl:col-span-12' : 'xl:col-span-8'} flex flex-col gap-3`}>
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#11192C] border border-slate-800/80 rounded-xl px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
              <MapPin className="w-4 h-4 text-sky-400" />
              <span>Monitoreo cartográfico ArcGIS</span>
              <span className="text-slate-600">·</span>
              <span className="text-xs text-slate-400 font-mono tabular-nums">
                {filteredVehicles.length} visibles
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onToggleLivePolling}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                  livePolling
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:text-slate-100'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                {livePolling ? 'Telemetría activa (4s)' : 'Telemetría pausada'}
              </button>
              <button
                type="button"
                onClick={onTickNow}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Activity className="w-3.5 h-3.5 text-sky-400" />
                Simular GPS
              </button>
              {rightCollapsed && (
                <button
                  type="button"
                  onClick={() => setRightCollapsed(false)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors cursor-pointer whitespace-nowrap"
                >
                  <PanelRightOpen className="w-3.5 h-3.5" />
                  Mostrar panel derecho
                </button>
              )}
            </div>
          </div>

          <div className="h-[540px] xl:h-[600px]">
            <FleetMap
              vehicles={filteredVehicles}
              selectedVehicleId={selectedVehicle?.id ?? null}
              onSelectVehicle={(id) => {
                setSelectedVehicleId(id);
                if (rightCollapsed) setRightCollapsed(false);
              }}
            />
          </div>
        </div>

        {/* Right: Collapsible Operational Inspector & Unit Roster */}
        {!rightCollapsed && (
          <div className="xl:col-span-4 flex flex-col gap-4">
            {/* Selected Unit Inspector with Maintenance & Extraction */}
            {selectedVehicle ? (
              <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-sky-400">
                      {ASSET_TYPE_LABELS[selectedVehicle.assetType]} · {selectedVehicle.branch}
                    </div>
                    <h3 className="text-base font-semibold text-slate-100 mt-0.5 truncate">
                      {selectedVehicle.unitCode} · {selectedVehicle.plate}
                    </h3>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">
                      {selectedVehicle.brandModel} · {selectedVehicle.driverName}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedVehicle.operationalStatus === 'alerta' ? (
                      <button
                        type="button"
                        onClick={() => openAlertOf(selectedVehicle.id)}
                        title="Ver la alerta en Alertas e Incidentes"
                        className={`text-xs font-medium whitespace-nowrap underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer ${STATUS_META.alerta.colorClass}`}
                      >
                        {STATUS_META.alerta.label}
                      </button>
                    ) : (
                      <span className={`text-xs font-medium whitespace-nowrap ${STATUS_META[selectedVehicle.operationalStatus].colorClass}`}>
                        {STATUS_META[selectedVehicle.operationalStatus].label}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setRightCollapsed(true)}
                      className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer"
                      title="Minimizar panel derecho"
                      aria-label="Minimizar panel derecho"
                    >
                      <PanelRightClose className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Telemetry + Horómetro + Maintenance Metrics */}
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-xs">
                  <div>
                    <div className="text-slate-400">Horómetro</div>
                    <div className="font-mono tabular-nums text-sm font-medium text-slate-100 mt-0.5">
                      {selectedVehicle.engineHours} h
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Próx. servicio</div>
                    <div className={`font-mono tabular-nums text-sm font-medium mt-0.5 ${MAINTENANCE_META[selectedVehicle.maintenanceStatus].colorClass}`}>
                      {selectedVehicle.nextServiceHours} h
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">
                      Combustible{selectedVehicle.telemetrySourceEngine === 'obd' ? <span className="text-emerald-300"> · OBD-II</span> : null}
                    </div>
                    <div className="font-mono tabular-nums text-sm font-medium text-slate-100 mt-0.5">
                      {selectedVehicle.fuelLevelPct}% · {selectedVehicle.coolantTempC}°C
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
                  <div>
                    Velocidad: <strong className="font-mono tabular-nums text-slate-200">{selectedVehicle.speedKmh} km/h</strong>
                  </div>
                  <div>
                    Fallas DTC:{' '}
                    <strong className={selectedVehicle.faultCodes.length > 0 ? 'text-rose-400 font-mono' : 'text-emerald-400 font-mono'}>
                      {selectedVehicle.faultCodes.length > 0 ? selectedVehicle.faultCodes[0].code : '0 activas'}
                    </strong>
                  </div>
                </div>

                {selectedDevice && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">
                        {selectedDevice.protocol} · {selectedDevice.imei}
                      </span>
                      <span className={LINK_META[selectedDevice.linkStatus].colorClass}>
                        {LINK_META[selectedDevice.linkStatus].label}
                      </span>
                    </div>
                    <div className="text-slate-500">
                      Último reporte: {formatRelativeTime(selectedVehicle.lastReportAt)} · {selectedVehicle.geofenceName}
                      {selectedVehicle.positionSource === 'smartphone' && (
                        <span className="text-sky-300"> · Posición: {(selectedVehicle.positionSourceLabel ?? 'celular del chofer').toLowerCase()}</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="pt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenDossier(selectedVehicle.id)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    Ficha y Mantenimiento
                  </button>
                  <ExportMenu url={`/api/vehicles/${selectedVehicle.id}/export`} label="Ficha" fileName={`ficha-${selectedVehicle.unitCode}`} />
                  <button
                    type="button"
                    disabled={!canRequestVideo}
                    onClick={() => onRequestVideo(selectedVehicle.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
                    title="Solicitar transmisión JT1078"
                  >
                    <Video className="w-3.5 h-3.5 text-emerald-400" />
                    Video
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex items-center justify-between text-xs text-slate-400">
                <span>Selecciona una unidad en el mapa</span>
                <button
                  type="button"
                  onClick={() => setRightCollapsed(true)}
                  className="p-1 text-slate-400 hover:text-slate-100 cursor-pointer"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Roster search & filter */}
            <div className="flex-1 bg-[#11192C] border border-slate-800/80 rounded-xl flex flex-col overflow-hidden min-h-[300px]">
              <div className="p-3 border-b border-slate-800/80 space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar unidad, máquina, placa..."
                    className="w-full pl-8 pr-3 py-1.5 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div className="flex items-center gap-1 overflow-x-auto">
                  {(
                    [
                      { id: 'all', label: 'Todos' },
                      { id: 'vehiculo', label: 'Vehículos' },
                      { id: 'maquinaria_pesada', label: 'Maquinaria' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setAssetFilter(tab.id)}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        assetFilter === tab.id
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                  <span className="text-slate-700 px-0.5">|</span>
                  {(
                    [
                      { id: 'all', label: 'Cualquier estado' },
                      { id: 'alerta', label: 'Alerta' },
                      { id: 'en_ruta', label: 'Operando' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStatusFilter(tab.id)}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        statusFilter === tab.id
                          ? 'bg-slate-700 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 divide-y divide-slate-800/60">
                {filteredVehicles.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400">
                    No se encontraron unidades con los filtros aplicados.
                  </div>
                ) : (
                  rosterPagination.pagedItems.map((v) => {
                    const isSelected = v.id === selectedVehicle?.id;
                    const meta = STATUS_META[v.operationalStatus];
                    const maint = MAINTENANCE_META[v.maintenanceStatus];
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setSelectedVehicleId(v.id)}
                        className={`w-full text-left px-3.5 py-2.5 transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                          isSelected ? 'bg-sky-500/10' : 'hover:bg-slate-800/40'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-slate-100">{v.unitCode}</span>
                            <span className="text-[11px] text-slate-400 truncate">
                              {v.assetType === 'maquinaria_pesada' ? 'Maquinaria' : v.plate}
                            </span>
                            {v.faultCodes.length > 0 && (
                              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate mt-0.5">
                            {v.brandModel} · <span className={maint.colorClass}>{maint.label}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {v.operationalStatus === 'alerta' ? (
                            <span
                              role="link"
                              tabIndex={0}
                              title="Ver la alerta en Alertas e Incidentes"
                              onClick={(e) => {
                                e.stopPropagation();
                                openAlertOf(v.id);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openAlertOf(v.id);
                                }
                              }}
                              className={`block text-[11px] font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer ${meta.colorClass}`}
                            >
                              {meta.label}
                            </span>
                          ) : (
                            <div className={`text-[11px] font-medium ${meta.colorClass}`}>{meta.label}</div>
                          )}
                          <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5 inline-flex items-center gap-1">
                            <Camera className="w-3 h-3 text-slate-500" />
                            {v.engineHours}h
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              <Pagination
                page={rosterPagination.page}
                totalItems={rosterPagination.totalItems}
                pageSize={5}
                onPageChange={rosterPagination.setPage}
                compact
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
