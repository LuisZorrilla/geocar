import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, ShieldCheck, X } from 'lucide-react';
import type { MaintenanceRecord, Tenant, Vehicle, WorkOrder } from '../shared/types.ts';
import { getAuthToken, getTenantScope } from '../lib/api.ts';

interface MaintenanceAuditPdfModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: Tenant;
  availableTenants?: Tenant[];
  vehicles: Vehicle[];
  workOrders: WorkOrder[];
  maintenanceRecords: MaintenanceRecord[];
  initialVehicleId?: string;
  initialType?: 'all' | WorkOrder['type'];
  onExported?: (info: { folio: string; sha256: string; fileName: string }) => void;
}

function getDefaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 180);
  return d.toISOString().slice(0, 10);
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MaintenanceAuditPdfModal({
  isOpen,
  onClose,
  tenant,
  availableTenants,
  vehicles,
  workOrders,
  maintenanceRecords,
  initialVehicleId,
  initialType,
  onExported,
}: MaintenanceAuditPdfModalProps) {
  const canSwitchCompany = Boolean(availableTenants && availableTenants.length > 0 && tenant.id === 'all');

  const resolveInitialTenantId = () => {
    if (initialVehicleId) {
      const found = vehicles.find((v) => v.id === initialVehicleId);
      if (found) return found.tenantId;
    }
    if (tenant.id !== 'all') return tenant.id;
    return availableTenants?.[0]?.id ?? 'ten-norte';
  };

  const [selectedTenantId, setSelectedTenantId] = useState<string>(resolveInitialTenantId);
  const [fromDate, setFromDate] = useState<string>(getDefaultFromDate);
  const [toDate, setToDate] = useState<string>(getTodayDate);
  const [vehicleId, setVehicleId] = useState<string>(initialVehicleId ?? 'all');
  const [orderType, setOrderType] = useState<'all' | WorkOrder['type']>(initialType ?? 'all');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    const nextTenantId = resolveInitialTenantId();
    setSelectedTenantId(nextTenantId);
    setVehicleId(initialVehicleId ?? 'all');
    setOrderType(initialType ?? 'all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialVehicleId, initialType, tenant.id]);

  const activeCompany = useMemo(() => {
    if (tenant.id !== 'all' && tenant.id === selectedTenantId) return tenant;
    return availableTenants?.find((t) => t.id === selectedTenantId) ?? availableTenants?.[0] ?? tenant;
  }, [tenant, availableTenants, selectedTenantId]);

  const companyVehicles = useMemo(
    () => vehicles.filter((v) => v.tenantId === activeCompany.id),
    [vehicles, activeCompany.id]
  );

  const previewStats = useMemo(() => {
    const filteredOrders = workOrders.filter((wo) => {
      if (wo.tenantId !== activeCompany.id) return false;
      if (wo.status !== 'completada') return false;
      if (vehicleId !== 'all' && wo.vehicleId !== vehicleId) return false;
      if (orderType !== 'all' && wo.type !== orderType) return false;
      const effectiveDate = (wo.completedAt ?? wo.scheduledDate).slice(0, 10);
      if (fromDate && effectiveDate < fromDate) return false;
      if (toDate && effectiveDate > toDate) return false;
      return true;
    });

    const filteredRecords = maintenanceRecords.filter((mr) => {
      if (mr.tenantId !== activeCompany.id) return false;
      if (mr.status !== 'completado') return false;
      if (vehicleId !== 'all' && mr.vehicleId !== vehicleId) return false;
      if (orderType !== 'all' && mr.type !== orderType) return false;
      const performed = mr.performedAt.slice(0, 10);
      if (fromDate && performed < fromDate) return false;
      if (toDate && performed > toDate) return false;
      return true;
    });

    let refaccionesMxn = 0;
    let insumosMxn = 0;
    let manoObraMxn = 0;
    for (const wo of filteredOrders) {
      let labor = Number(wo.laborCost || 0);
      for (const p of wo.parts) {
        if (p.category === 'refaccion') refaccionesMxn += Number(p.subtotal || 0);
        else if (p.category === 'insumo') insumosMxn += Number(p.subtotal || 0);
        else labor += Number(p.subtotal || 0);
      }
      manoObraMxn += labor;
    }

    const totalWorkOrdersMxn = refaccionesMxn + insumosMxn + manoObraMxn;
    const totalLogbookMxn = filteredRecords.reduce((s, r) => s + Number(r.cost || 0), 0);

    return {
      closedOrdersCount: filteredOrders.length,
      logbookCount: filteredRecords.length,
      refaccionesMxn,
      insumosMxn,
      manoObraMxn,
      totalWorkOrdersMxn,
      totalLogbookMxn,
    };
  }, [workOrders, maintenanceRecords, activeCompany.id, vehicleId, orderType, fromDate, toDate]);

  if (!isOpen) return null;

  const handleApplyPreset = (daysBack: number | 'all') => {
    if (daysBack === 'all') {
      setFromDate('');
      setToDate('');
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - daysBack);
    setFromDate(start.toISOString().slice(0, 10));
    setToDate(end.toISOString().slice(0, 10));
  };

  const handleDownloadPdf = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (fromDate && toDate && fromDate > toDate) {
      setError('La fecha inicial no puede ser posterior a la fecha final.');
      return;
    }

    setDownloading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('tenantId', activeCompany.id);
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', toDate);
      if (vehicleId && vehicleId !== 'all') qs.set('vehicleId', vehicleId);
      if (orderType && orderType !== 'all') qs.set('type', orderType);

      const token = getAuthToken();
      const scope = getTenantScope();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (scope) headers['X-Tenant-Scope'] = scope;

      const res = await fetch(`/api/reports/maintenance-audit.pdf?${qs.toString()}`, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || `Error ${res.status} al generar el PDF de auditoría.`);
      }

      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="?([^"]+)"?/.exec(disp);
      const folio = res.headers.get('X-Audit-Folio') ?? `AUD-${Date.now().toString().slice(-6)}`;
      const sha256 = res.headers.get('X-Audit-Sha256') ?? '';
      const fileName = match?.[1] || `Auditoria_Mantto_${activeCompany.id}_${folio}.pdf`;

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

      onExported?.({ folio, sha256, fileName });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo descargar el reporte PDF.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl bg-[#0F172A] border border-slate-800 rounded-2xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-sky-400">Expediente PDF para auditoría externa</div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5 truncate">
              Exportar órdenes cerradas e historial de mantenimiento
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer shrink-0"
            aria-label="Cerrar configurador PDF"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleDownloadPdf} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
              {error}
            </div>
          )}

          {/* Company / Fiscal Letterhead Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Empresa a auditar (Membrete fiscal)</label>
              {canSwitchCompany && availableTenants ? (
                <select
                  value={activeCompany.id}
                  onChange={(e) => {
                    setSelectedTenantId(e.target.value);
                    setVehicleId('all');
                  }}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 cursor-pointer"
                >
                  {availableTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.taxId})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100">
                  {activeCompany.name} · <span className="font-mono text-slate-400">{activeCompany.taxId}</span>
                </div>
              )}
              <div className="text-[11px] text-slate-400 mt-1">
                Sede: {activeCompany.city} · {activeCompany.branches.join(', ')}
              </div>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Unidad o flota</label>
              <select
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 cursor-pointer"
              >
                <option value="all">Todas las unidades ({companyVehicles.length})</option>
                {companyVehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.unitCode} · {v.plate} — {v.brandModel}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Date Range + Type */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Fecha desde</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-medium mb-1">Fecha hasta</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-medium mb-1">Tipo de orden / servicio</label>
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'all' | WorkOrder['type'])}
                className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 cursor-pointer"
              >
                <option value="all">Todos los tipos</option>
                <option value="preventivo">Preventivo</option>
                <option value="correctivo">Correctivo</option>
                <option value="inspeccion">Inspección técnica</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-400">Periodo rápido:</span>
            <button
              type="button"
              onClick={() => handleApplyPreset(30)}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Últimos 30 días
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset(90)}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Últimos 90 días
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset(180)}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Últimos 6 meses
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset('all')}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Histórico completo
            </button>
          </div>

          {/* Live Financial & Records Preview */}
          <div className="rounded-xl bg-[#11192C] border border-slate-800/90 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-sky-400" />
                Vista previa del alcance a exportar
              </div>
              <span className="text-[11px] font-mono tabular-nums text-slate-400">
                Solo órdenes cerradas (completada) + bitácora técnica
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
                <div className="text-[11px] text-slate-400">OT cerradas</div>
                <div className="text-base font-semibold font-mono tabular-nums text-sky-400 mt-0.5">
                  {previewStats.closedOrdersCount}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
                <div className="text-[11px] text-slate-400">Reg. bitácora</div>
                <div className="text-base font-semibold font-mono tabular-nums text-slate-100 mt-0.5">
                  {previewStats.logbookCount}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
                <div className="text-[11px] text-slate-400">Refacciones + Insumos</div>
                <div className="text-base font-semibold font-mono tabular-nums text-slate-100 mt-0.5">
                  ${(previewStats.refaccionesMxn + previewStats.insumosMxn).toLocaleString('es-MX')}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
                <div className="text-[11px] text-slate-400">Total OT cerradas</div>
                <div className="text-base font-semibold font-mono tabular-nums text-emerald-400 mt-0.5">
                  ${previewStats.totalWorkOrdersMxn.toLocaleString('es-MX')}
                </div>
              </div>
            </div>

            {previewStats.closedOrdersCount === 0 && previewStats.logbookCount === 0 ? (
              <div className="text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                No hay órdenes cerradas ni registros en bitácora dentro del rango seleccionado. Puedes ampliar el periodo o emitir la constancia oficial sin movimientos.
              </div>
            ) : (
              <div className="flex items-start gap-2 text-slate-300 pt-1">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  El documento incluirá membrete fiscal de <strong>{activeCompany.name}</strong>, folio único de auditoría, desglose de SKUs y mano de obra (<strong>${previewStats.manoObraMxn.toLocaleString('es-MX')} MXN</strong>), historial por unidad, hash SHA-256 de integridad y bloque de firmas.
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={downloading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {downloading ? 'Generando PDF...' : 'Generar y descargar PDF'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
