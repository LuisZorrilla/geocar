import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Download,
  FileJson,
  Gauge,
  Wrench,
  X,
} from 'lucide-react';
import type {
  AlertEvent,
  Device,
  Incident,
  MaintenanceRecord,
  PreventivePlan,
  RoleDefinition,
  Vehicle,
} from '../shared/types.ts';
import {
  apiRequest,
  ASSET_TYPE_LABELS,
  formatRelativeTime,
  formatServiceDate,
  downloadWithAuth,
  getServiceDateDeltaDays,
  MAINTENANCE_META,
  STATUS_META,
  suggestNextServiceDate,
} from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';

interface UnitDossierModalProps {
  vehicleId: string | null;
  liveVehicle?: Vehicle | null;
  preventivePlans?: PreventivePlan[];
  activeRole: RoleDefinition;
  onClose: () => void;
  onMaintenanceAdded: (payload: {
    record: MaintenanceRecord;
    vehicle: Vehicle;
    maintenanceRecords: MaintenanceRecord[];
  }) => void;
}

interface DossierResponse {
  vehicle: Vehicle;
  device: Device | null;
  maintenance: MaintenanceRecord[];
  alerts: AlertEvent[];
  incidents: Incident[];
}

export function UnitDossierModal({
  vehicleId,
  liveVehicle,
  preventivePlans,
  activeRole,
  onClose,
  onMaintenanceAdded,
}: UnitDossierModalProps) {
  const [dossier, setDossier] = useState<DossierResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showMaintForm, setShowMaintForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [maintForm, setMaintForm] = useState({
    type: 'preventivo' as MaintenanceRecord['type'],
    title: 'Servicio preventivo 250h / Revisión general',
    workshopOrTech: 'Taller Central Certificado',
    costMxn: 6500,
    nextServiceDate: '',
    notes: '',
    clearFaults: true,
  });

  const canWriteMaint = activeRole.permissions.flotas === 'full' || activeRole.permissions.flotas === 'write';

  useEffect(() => {
    if (!vehicleId) {
      setDossier(null);
      setShowMaintForm(false);
      return;
    }
    setLoading(true);
    setError(null);
    apiRequest<DossierResponse>(`/api/vehicles/${vehicleId}/dossier`)
      .then((res) => {
        setDossier(res);
        setMaintForm((prev) => ({
          ...prev,
          nextServiceDate: suggestNextServiceDate(res.vehicle.engineHours, res.vehicle.engineHours + 250),
        }));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'No se pudo cargar la ficha.'))
      .finally(() => setLoading(false));
  }, [vehicleId]);

  const activeVehicle = useMemo(
    () => liveVehicle ?? dossier?.vehicle ?? null,
    [liveVehicle, dossier?.vehicle]
  );

  const assignedPlan = useMemo(
    () =>
      activeVehicle?.assignedPlanId
        ? preventivePlans?.find((p) => p.id === activeVehicle.assignedPlanId)
        : undefined,
    [activeVehicle?.assignedPlanId, preventivePlans]
  );

  const faultPagination = usePagination(
    activeVehicle?.faultCodes ?? [],
    `${vehicleId ?? ''}|faults|${activeVehicle?.faultCodes.length ?? 0}`,
    5
  );

  const maintPagination = usePagination(
    dossier?.maintenance ?? [],
    `${vehicleId ?? ''}|maint|${dossier?.maintenance.length ?? 0}`,
    5
  );

  if (!vehicleId) return null;

  const handleExport = (format: 'csv' | 'json') => {
    downloadWithAuth(`/api/vehicles/${vehicleId}/export?format=${format}`, `${vehicleId}.${format}`).catch((err) =>
      window.alert(err instanceof Error ? err.message : 'No se pudo descargar el archivo.')
    );
  };

  const handleToggleForm = () => {
    if (!showMaintForm && activeVehicle) {
      const intervalHours = assignedPlan?.intervalHours ?? 250;
      setMaintForm((prev) => ({
        ...prev,
        nextServiceDate: suggestNextServiceDate(activeVehicle.engineHours, activeVehicle.engineHours + intervalHours),
      }));
    }
    setShowMaintForm((v) => !v);
  };

  const handleSubmitMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!maintForm.title.trim()) return;
    setSubmitting(true);
    try {
      const res = await apiRequest<{
        record: MaintenanceRecord;
        vehicle: Vehicle;
        maintenanceRecords: MaintenanceRecord[];
      }>('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({ vehicleId, ...maintForm }),
      });
      setDossier((prev) =>
        prev
          ? {
              ...prev,
              vehicle: res.vehicle,
              maintenance: [res.record, ...prev.maintenance],
            }
          : prev
      );
      onMaintenanceAdded(res);
      setShowMaintForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar el servicio.');
    } finally {
      setSubmitting(false);
    }
  };

  const remainingHours = activeVehicle
    ? Number((activeVehicle.nextServiceHours - activeVehicle.engineHours).toFixed(1))
    : 0;
  const remainingKm = activeVehicle
    ? Math.round(activeVehicle.nextServiceKm - activeVehicle.odometerKm)
    : 0;
  const serviceDeltaDays = activeVehicle ? getServiceDateDeltaDays(activeVehicle.nextServiceDate) : 0;
  const isServiceOverdue = Boolean(
    activeVehicle &&
      (activeVehicle.maintenanceStatus === 'vencido' || remainingHours <= 0 || remainingKm <= 0 || serviceDeltaDays < 0)
  );
  const isServiceUpcoming = Boolean(
    activeVehicle &&
      !isServiceOverdue &&
      (activeVehicle.maintenanceStatus === 'proximo' || remainingHours <= 24 || remainingKm <= 500)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-3xl max-h-[90vh] bg-[#0F172A] border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <div className="text-xs text-sky-400">
              {activeVehicle ? ASSET_TYPE_LABELS[activeVehicle.assetType] : 'Ficha técnica y mantenimiento'}
            </div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5">
              {activeVehicle
                ? `${activeVehicle.unitCode} · ${activeVehicle.brandModel} (${activeVehicle.plate})`
                : 'Cargando ficha de unidad...'}
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {activeVehicle && (
              <>
                <button
                  type="button"
                  onClick={() => handleExport('csv')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5 text-sky-400" />
                  Extraer CSV
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('json')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer whitespace-nowrap"
                >
                  <FileJson className="w-3.5 h-3.5 text-emerald-400" />
                  Extraer JSON
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer"
              aria-label="Cerrar ficha"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {loading && !activeVehicle && (
            <div className="text-slate-400 py-8 text-center">Consultando telemetría y mantenimientos...</div>
          )}
          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>
          )}

          {activeVehicle && (
            <>
              {/* Dedicated Section: Salud Operativa (live telemetry synced) */}
              <section
                aria-label="Salud Operativa"
                className={`rounded-xl border p-4 space-y-4 ${
                  isServiceOverdue
                    ? 'bg-rose-950/15 border-rose-500/45'
                    : 'bg-[#11192C] border-slate-800/80'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Activity className={`w-4 h-4 ${isServiceOverdue ? 'text-rose-400' : 'text-sky-400'}`} />
                    <h4 className="text-sm font-semibold text-slate-100">Salud Operativa</h4>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className={`font-medium ${STATUS_META[activeVehicle.operationalStatus].colorClass}`}>
                      {STATUS_META[activeVehicle.operationalStatus].label}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="font-mono tabular-nums text-slate-400">
                      Telemetría en vivo ({formatRelativeTime(activeVehicle.lastReportAt)})
                    </span>
                  </div>
                </div>

                {/* Overdue / Upcoming Visual Alert Banner */}
                {isServiceOverdue ? (
                  <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/45 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 text-rose-200">
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      <div>
                        <span className="font-semibold text-rose-300">Servicio preventivo vencido</span>
                        <span className="text-rose-200/90">
                          {' '}
                          · Requiere atención inmediata en taller para evitar desgaste crítico.
                        </span>
                      </div>
                    </div>
                    <span className="font-mono tabular-nums font-semibold text-rose-300">
                      {remainingHours <= 0 ? `Excedido ${Math.abs(remainingHours)} h` : `${remainingHours} h`} ·{' '}
                      {serviceDeltaDays < 0 ? `Vencido hace ${Math.abs(serviceDeltaDays)} d` : 'Fecha vencida'}
                    </span>
                  </div>
                ) : isServiceUpcoming ? (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 flex flex-wrap items-center justify-between gap-2 text-amber-200">
                    <span className="inline-flex items-center gap-2 font-medium text-amber-300">
                      <CalendarClock className="w-4 h-4 shrink-0" />
                      Servicio preventivo próximo por horómetro
                    </span>
                    <span className="font-mono tabular-nums text-amber-300">
                      Restan {remainingHours} h · {serviceDeltaDays} días
                    </span>
                  </div>
                ) : null}

                {/* Key Operational Health Metrics */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl bg-[#0B1120] border border-slate-800/80">
                    <div className="text-slate-400">Horómetro actual</div>
                    <div className="font-mono tabular-nums text-base font-semibold text-slate-100 mt-1">
                      {activeVehicle.engineHours} h
                    </div>
                    <div className="text-slate-500 font-mono tabular-nums mt-0.5">
                      Meta servicio: {activeVehicle.nextServiceHours} h · {activeVehicle.rpm} RPM
                    </div>
                  </div>

                  <div
                    className={`p-3 rounded-xl border ${
                      isServiceOverdue
                        ? 'bg-rose-950/25 border-rose-500/45'
                        : 'bg-[#0B1120] border-slate-800/80'
                    }`}
                  >
                    <div className="text-slate-400">Próximo servicio preventivo</div>
                    <div
                      className={`font-mono tabular-nums text-base font-semibold mt-1 ${
                        isServiceOverdue
                          ? 'text-rose-400'
                          : isServiceUpcoming
                            ? 'text-amber-400'
                            : 'text-emerald-400'
                      }`}
                    >
                      {formatServiceDate(activeVehicle.nextServiceDate)}
                    </div>
                    <div className={`font-mono tabular-nums mt-0.5 ${MAINTENANCE_META[activeVehicle.maintenanceStatus].colorClass}`}>
                      {isServiceOverdue
                        ? `Vencido (${serviceDeltaDays < 0 ? `${Math.abs(serviceDeltaDays)} días atrás` : 'por horómetro'})`
                        : serviceDeltaDays === 0
                          ? 'Programado para hoy'
                          : `En ${serviceDeltaDays} días · ${MAINTENANCE_META[activeVehicle.maintenanceStatus].label}`}
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-[#0B1120] border border-slate-800/80">
                    <div className="text-slate-400">Telemetría CAN / Bus Motor</div>
                    <div className="font-mono tabular-nums text-base font-semibold text-slate-100 mt-1">
                      {activeVehicle.coolantTempC} °C · {activeVehicle.fuelLevelPct}% comb
                    </div>
                    <div className="text-slate-500 font-mono tabular-nums mt-0.5">
                      {activeVehicle.odometerKm.toLocaleString('es-MX')} / {activeVehicle.nextServiceKm.toLocaleString('es-MX')} km
                    </div>
                    {assignedPlan && (
                      <div className="text-sky-400 text-[11px] truncate mt-0.5">
                        Plan: {assignedPlan.name}
                      </div>
                    )}
                  </div>
                </div>

                {/* Live Telemetry-Synced Fault Codes */}
                <div className="rounded-xl bg-[#0B1120] border border-slate-800/80 overflow-hidden">
                  <div className="px-3.5 py-2.5 border-b border-slate-800/80 flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-100 flex items-center gap-2">
                      <AlertOctagon
                        className={`w-4 h-4 ${activeVehicle.faultCodes.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}
                      />
                      Códigos de Falla activos (Telemetría DTC / J1939)
                    </span>
                    <span
                      className={`font-mono tabular-nums font-medium ${
                        activeVehicle.faultCodes.length > 0 ? 'text-rose-400' : 'text-emerald-400'
                      }`}
                    >
                      {activeVehicle.faultCodes.length} activos
                    </span>
                  </div>

                  {activeVehicle.faultCodes.length === 0 ? (
                    <div className="p-3.5 flex items-center gap-2 text-emerald-400">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>Sin códigos de falla activos en el bus CAN/OBD-II.</span>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-slate-800/70">
                        {faultPagination.pagedItems.map((fc) => (
                          <div
                            key={fc.code}
                            className="p-3 flex items-start justify-between gap-3"
                          >
                            <div>
                              <div className="font-mono font-semibold text-slate-100">
                                {fc.code} · <span className="text-slate-400 font-normal">{fc.system}</span>
                              </div>
                              <div className="text-slate-300 mt-0.5">{fc.description}</div>
                            </div>
                            <span
                              className={
                                fc.severity === 'critica'
                                  ? 'text-rose-400 font-medium shrink-0'
                                  : 'text-amber-400 font-medium shrink-0'
                              }
                            >
                              {fc.severity === 'critica' ? 'Crítica' : 'Advertencia'}
                            </span>
                          </div>
                        ))}
                      </div>
                      <Pagination
                        page={faultPagination.page}
                        totalItems={faultPagination.totalItems}
                        pageSize={5}
                        onPageChange={faultPagination.setPage}
                        compact
                      />
                    </>
                  )}
                </div>
              </section>

              {/* Maintenance History & New Service Action */}
              {dossier && (
                <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
                  <div className="p-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-100 flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-sky-400" />
                      Historial y registro de mantenimiento ({dossier.maintenance.length})
                    </span>
                    <button
                      type="button"
                      disabled={!canWriteMaint}
                      onClick={handleToggleForm}
                      className="px-3 py-1.5 rounded-lg font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer whitespace-nowrap"
                    >
                      {showMaintForm ? 'Cancelar registro' : 'Registrar servicio'}
                    </button>
                  </div>

                  {showMaintForm && (
                    <form
                      onSubmit={handleSubmitMaintenance}
                      className="p-4 bg-[#0B1120] border-b border-sky-500/30 space-y-3"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-slate-400 mb-1">Tipo de mantenimiento</label>
                          <select
                            value={maintForm.type}
                            onChange={(e) =>
                              setMaintForm((p) => ({ ...p, type: e.target.value as MaintenanceRecord['type'] }))
                            }
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                          >
                            <option value="preventivo">Preventivo</option>
                            <option value="correctivo">Correctivo</option>
                            <option value="inspeccion">Inspección técnica</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-slate-400 mb-1">Descripción del servicio</label>
                          <input
                            type="text"
                            value={maintForm.title}
                            onChange={(e) => setMaintForm((p) => ({ ...p, title: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-slate-400 mb-1">Taller o técnico</label>
                          <input
                            type="text"
                            value={maintForm.workshopOrTech}
                            onChange={(e) => setMaintForm((p) => ({ ...p, workshopOrTech: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Costo estimado (MXN)</label>
                          <input
                            type="number"
                            value={maintForm.costMxn}
                            onChange={(e) => setMaintForm((p) => ({ ...p, costMxn: Number(e.target.value) }))}
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Próx. servicio (editable)</label>
                          <input
                            type="date"
                            value={maintForm.nextServiceDate}
                            onChange={(e) => setMaintForm((p) => ({ ...p, nextServiceDate: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Notas técnicas</label>
                          <input
                            type="text"
                            placeholder="Observaciones..."
                            value={maintForm.notes}
                            onChange={(e) => setMaintForm((p) => ({ ...p, notes: e.target.value }))}
                            className="w-full px-2.5 py-1.5 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={maintForm.clearFaults}
                            onChange={(e) => setMaintForm((p) => ({ ...p, clearFaults: e.target.checked }))}
                          />
                          Limpiar códigos de falla DTC y recalcular próximo servicio (+{assignedPlan?.intervalHours ?? 250} h / +{(assignedPlan?.intervalKm ?? 10000).toLocaleString('es-MX')} km)
                        </label>
                        <button
                          type="submit"
                          disabled={submitting}
                          className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                        >
                          {submitting ? 'Guardando...' : 'Guardar servicio'}
                        </button>
                      </div>
                    </form>
                  )}

                  {dossier.maintenance.length === 0 ? (
                    <div className="text-slate-400 p-4">
                      Sin órdenes registradas aún para esta unidad. Usa "Registrar servicio" para asentar su primer mantenimiento.
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-slate-800/70 px-4">
                        {maintPagination.pagedItems.map((m) => (
                          <div key={m.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div>
                              <div className="font-medium text-slate-100">
                                {m.title} · <span className="text-sky-400 capitalize">{m.type}</span>
                              </div>
                              <div className="text-slate-400">
                                {m.workshopOrTech} · {m.notes || 'Sin observaciones adicionales'}
                              </div>
                            </div>
                            <div className="text-right font-mono tabular-nums text-slate-300 shrink-0">
                              <div>
                                {m.engineHoursAtService} h · ${m.costMxn.toLocaleString('es-MX')}
                              </div>
                              <div className="text-slate-500">{formatRelativeTime(m.performedAt)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <Pagination
                        page={maintPagination.page}
                        totalItems={maintPagination.totalItems}
                        pageSize={5}
                        onPageChange={maintPagination.setPage}
                      />
                    </>
                  )}
                </div>
              )}

              {/* Device & Location summary */}
              {dossier?.device && (
                <div className="p-3.5 rounded-xl bg-[#11192C] border border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-slate-300">
                    <Gauge className="w-4 h-4 text-sky-400" />
                    <span>
                      Dispositivo <strong className="text-slate-100">{dossier.device.model}</strong> · IMEI{' '}
                      <span className="font-mono">{dossier.device.imei}</span> · {dossier.device.protocol}
                    </span>
                  </div>
                  <span className="text-slate-400 font-mono">
                    Geocerca: {activeVehicle.geofenceName}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
