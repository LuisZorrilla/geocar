import { useMemo, useState } from 'react';
import {
  Download,
  Plus,
  Search,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import type {
  AssetType,
  ChecklistItem,
  DashcamDriverProfile,
  DashcamVendorFamily,
  Device,
  DeviceDashcamConfig,
  Driver,
  MaintenanceDashboardMetrics,
  MaintenanceRecord,
  PartInventoryItem,
  PreOpChecklist,
  PreventivePlan,
  ProtocolType,
  RoleDefinition,
  Tenant,
  Vehicle,
  WorkOrder,
  WorkOrderPartCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from '../shared/types.ts';
import {
  ASSET_TYPE_LABELS,
  downloadWithAuth,
  MAINTENANCE_META,
  STATUS_META,
} from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { MaintenanceWorkbench } from './MaintenanceWorkbench.tsx';
import { DashcamConfigPanel } from './DashcamConfigPanel.tsx';

interface FleetDevicesViewProps {
  vehicles: Vehicle[];
  devices: Device[];
  maintenanceRecords: MaintenanceRecord[];
  maintenanceDashboard?: MaintenanceDashboardMetrics;
  workOrders: WorkOrder[];
  preventivePlans: PreventivePlan[];
  partsInventory: PartInventoryItem[];
  checklists: PreOpChecklist[];
  dashcamDrivers: DashcamDriverProfile[];
  tenant: Tenant;
  availableTenants?: Tenant[];
  drivers: Driver[];
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  onCreateVehicle: (payload: {
    tenantId?: string;
    branch: string;
    group: string;
    assetType: AssetType;
    unitCode: string;
    plate: string;
    brandModel: string;
    year: number;
    driverName: string;
    imei: string;
    protocol: ProtocolType;
    deviceModel: string;
    engineHours: number;
  }) => Promise<void>;
  onValidateDevice: (deviceId: string) => Promise<void>;
  onUpdateDeviceConfig: (
    deviceId: string,
    payload: {
      driverId: string;
      tcpPort: number;
      activeChannels: string[];
      resolution: DeviceDashcamConfig['resolution'];
      bitrateKbps: number;
      gpsIntervalSec: number;
      preEventSec: number;
      postEventSec: number;
      gSensorThresholdG: number;
      features: DeviceDashcamConfig['features'];
    }
  ) => Promise<void>;
  onBatchUpdateDeviceConfig: (
    deviceIds: string[],
    payload: {
      driverId: string;
      tcpPort: number;
      activeChannels: string[];
      resolution: DeviceDashcamConfig['resolution'];
      bitrateKbps: number;
      gpsIntervalSec: number;
      preEventSec: number;
      postEventSec: number;
      gSensorThresholdG: number;
      features: DeviceDashcamConfig['features'];
    }
  ) => Promise<void>;
  onCreateDashcamDriver: (payload: {
    vendorFamily: DashcamVendorFamily;
    vendorName: string;
    modelSeries: string;
    driverCode: string;
    driverVersion: string;
    protocol: ProtocolType;
    defaultPort: number;
    maxChannels: number;
    defaultBitrateKbps: number;
    supportedFeatures: DashcamDriverProfile['supportedFeatures'];
    notes: string;
  }) => Promise<void>;
  onCreateWorkOrder: (payload: {
    vehicleId: string;
    planId?: string;
    type: WorkOrder['type'];
    priority: WorkOrder['priority'];
    title: string;
    workshopOrTech: string;
    scheduledDate: string;
    parts: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCostMxn: number }>;
    laborCostMxn: number;
    notes: string;
    clearFaultsOnClose?: boolean;
  }) => Promise<void>;
  onUpdateWorkOrder: (
    workOrderId: string,
    patch: {
      status?: WorkOrderStatus;
      priority?: WorkOrderPriority;
      workshopOrTech?: string;
      scheduledDate?: string;
      notes?: string;
      laborCostMxn?: number;
      parts?: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCostMxn: number }>;
      clearFaultsOnClose?: boolean;
      nextServiceDate?: string;
    }
  ) => Promise<void>;
  onCreatePreventivePlan: (payload: {
    name: string;
    assetType: AssetType | 'ambos';
    intervalHours: number;
    intervalKm: number;
    intervalDays: number;
    estimatedCostMxn: number;
    checklistFocus: string;
  }) => Promise<void>;
  onUpdatePreventivePlan: (
    planId: string,
    patch: {
      name?: string;
      assetType?: AssetType | 'ambos';
      intervalHours?: number;
      intervalKm?: number;
      intervalDays?: number;
      estimatedCostMxn?: number;
      checklistFocus?: string;
    }
  ) => Promise<void>;
  onAssignPreventivePlan: (planId: string, vehicleIds: string[]) => Promise<void>;
  onEvaluateMaintenancePlans: () => Promise<void>;
  onTogglePreventivePlan: (planId: string) => Promise<void>;
  onUpsertPartInventory: (payload: {
    sku: string;
    name: string;
    category: PartInventoryItem['category'];
    unit: string;
    stockQty: number;
    minStock: number;
    unitCostMxn: number;
    warehouseLocation: string;
  }) => Promise<void>;
  onAdjustPartStock: (itemId: string, deltaQty: number, reason: string) => Promise<void>;
  onCreateChecklist: (payload: {
    vehicleId: string;
    driverName: string;
    shift: PreOpChecklist['shift'];
    items: ChecklistItem[];
    summaryNote: string;
    createWorkOrderIfFailed: boolean;
  }) => Promise<void>;
  onOpenDossier: (vehicleId: string) => void;
}

export function FleetDevicesView({
  vehicles,
  devices,
  maintenanceRecords,
  maintenanceDashboard,
  workOrders,
  preventivePlans,
  partsInventory,
  checklists,
  dashcamDrivers,
  tenant,
  availableTenants,
  drivers,
  activeRole,
  isGlobalSuperadmin,
  onCreateVehicle,
  onValidateDevice,
  onUpdateDeviceConfig,
  onBatchUpdateDeviceConfig,
  onCreateDashcamDriver,
  onCreateWorkOrder,
  onUpdateWorkOrder,
  onCreatePreventivePlan,
  onUpdatePreventivePlan,
  onAssignPreventivePlan,
  onEvaluateMaintenancePlans,
  onTogglePreventivePlan,
  onUpsertPartInventory,
  onAdjustPartStock,
  onCreateChecklist,
  onOpenDossier,
}: FleetDevicesViewProps) {
  const [subTab, setSubTab] = useState<'vehiculos' | 'mantenimiento' | 'dispositivos' | 'conductores'>('vehiculos');
  const [assetFilter, setAssetFilter] = useState<'all' | AssetType>('all');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const initialTargetTenant = tenant.id === 'all' ? (availableTenants?.[0]?.id ?? 'ten-norte') : tenant.id;
  const [form, setForm] = useState({
    tenantId: initialTargetTenant,
    branch: (availableTenants?.find((t) => t.id === initialTargetTenant) ?? tenant).branches[0] ?? 'Centro',
    group: 'Tractocamión / Obra',
    assetType: 'vehiculo' as AssetType,
    unitCode: '',
    plate: '',
    brandModel: 'Kenworth T680',
    year: 2025,
    driverName: '',
    imei: '',
    protocol: 'JT808/JT1078' as ProtocolType,
    deviceModel: 'Howen Hero-ME40-04',
    engineHours: 120,
  });

  const canWriteFleet = activeRole.permissions.flotas === 'full' || activeRole.permissions.flotas === 'write';

  const deviceMap = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const tenantNameMap = useMemo(
    () => new Map((availableTenants ?? [tenant]).map((t) => [t.id, t.name])),
    [availableTenants, tenant]
  );
  const drawerBranches = useMemo(() => {
    const target = availableTenants?.find((t) => t.id === form.tenantId) ?? tenant;
    return target.branches;
  }, [availableTenants, form.tenantId, tenant]);

  const filteredVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (assetFilter !== 'all' && v.assetType !== assetFilter) return false;
      if (!q) return true;
      return (
        v.unitCode.toLowerCase().includes(q) ||
        v.plate.toLowerCase().includes(q) ||
        v.driverName.toLowerCase().includes(q) ||
        v.brandModel.toLowerCase().includes(q)
      );
    });
  }, [vehicles, assetFilter, search]);

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

  const filteredDrivers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drivers;
    return drivers.filter(
      (drv) =>
        drv.name.toLowerCase().includes(q) ||
        drv.licenseNumber.toLowerCase().includes(q) ||
        drv.branch.toLowerCase().includes(q)
    );
  }, [drivers, search]);

  const vehiclesPagination = usePagination(filteredVehicles, `${tenant.id}|${assetFilter}|${search}`, 5);
  const driversPagination = usePagination(filteredDrivers, `${tenant.id}|${search}`, 5);

  const handleSubmitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.unitCode.trim() || !form.plate.trim() || form.imei.trim().length < 10) {
      setFormError('Completa código de unidad, placa/serie e IMEI de al menos 10 dígitos.');
      return;
    }
    setSubmitting(true);
    try {
      await onCreateVehicle({
        ...form,
        driverName: form.driverName.trim() || 'Operador Asignado',
      });
      setDrawerOpen(false);
      setForm((prev) => ({ ...prev, unitCode: '', plate: '', driverName: '', imei: '' }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No fue posible registrar la unidad.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportAll = () => {
    downloadWithAuth('/api/reports/export', 'flota_mantenimiento.csv').catch((err) =>
      window.alert(err instanceof Error ? err.message : 'No se pudo descargar el reporte.')
    );
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 overflow-x-auto">
          {(
            [
              { id: 'vehiculos', label: `Vehículos y Maquinaria (${vehicles.length})` },
              { id: 'mantenimiento', label: `Mantenimiento (${workOrders.length} OT)` },
              { id: 'dispositivos', label: `Dispositivos y Dashcams (${devices.length})` },
              { id: 'conductores', label: `Operadores (${drivers.length})` },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                subTab === t.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar unidad, máquina, IMEI..."
              className="pl-8 pr-3 py-1.5 w-56 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>

          <button
            type="button"
            onClick={handleExportAll}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            Extraer flota CSV
          </button>

          <button
            type="button"
            disabled={!canWriteFleet}
            onClick={() => setDrawerOpen(true)}
            title={!canWriteFleet ? 'Tu perfil no permite registrar activos' : undefined}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Registrar activo
          </button>
        </div>
      </div>

      {/* Sub-view 1: Vehicles & Heavy Machinery */}
      {subTab === 'vehiculos' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {(
              [
                { id: 'all', label: 'Todos los activos' },
                { id: 'vehiculo', label: 'Vehículos' },
                { id: 'maquinaria_pesada', label: 'Maquinaria Pesada' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAssetFilter(opt.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                  assetFilter === opt.id
                    ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                    : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-3 px-4">Unidad / Tipo</th>
                    <th className="py-3 px-4">Sucursal / Operador</th>
                    <th className="py-3 px-4">Estado Operativo</th>
                    <th className="py-3 px-4 text-right">Horómetro</th>
                    <th className="py-3 px-4">Mantenimiento y DTC</th>
                    <th className="py-3 px-4 text-right">Ficha</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {vehiclesPagination.pagedItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 px-4 text-center text-slate-400">
                        No se encontraron unidades con los filtros aplicados.
                      </td>
                    </tr>
                  ) : (
                    vehiclesPagination.pagedItems.map((v) => {
                      const status = STATUS_META[v.operationalStatus];
                      const maint = MAINTENANCE_META[v.maintenanceStatus];
                      const dev = deviceMap.get(v.deviceId);
                      return (
                        <tr key={v.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 px-4">
                            <div className="font-semibold text-slate-100">
                              {v.unitCode} · <span className="text-sky-300 font-normal">{ASSET_TYPE_LABELS[v.assetType]}</span>
                            </div>
                            <div className="text-slate-400 font-mono">
                              {v.plate} · {v.brandModel}
                            </div>
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="text-slate-200">{v.driverName}</div>
                            <div className="text-slate-400">
                              {tenant.id === 'all' ? `${tenantNameMap.get(v.tenantId) ?? v.tenantId} · ` : ''}
                              {v.branch} · {dev?.protocol ?? 'JT808/JT1078'}
                            </div>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className={`font-medium ${status.colorClass}`}>{status.label}</span>
                            <div className="text-slate-500 font-mono tabular-nums">
                              {v.speedKmh} km/h · {v.fuelLevelPct}% comb
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-200">
                            <div>{v.engineHours} h</div>
                            <div className="text-slate-500">Próx: {v.nextServiceHours} h</div>
                          </td>
                          <td className="py-2.5 px-4">
                            <div className={`font-medium ${maint.colorClass}`}>{maint.label}</div>
                            <div className="text-slate-400 font-mono">
                              {v.faultCodes.length > 0 ? v.faultCodes[0].code : 'Sin códigos de falla'}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => onOpenDossier(v.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
                            >
                              <Wrench className="w-3.5 h-3.5 text-sky-400" />
                              Abrir ficha
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              page={vehiclesPagination.page}
              totalItems={vehiclesPagination.totalItems}
              pageSize={5}
              onPageChange={vehiclesPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* Sub-view 2: Full Fleet Maintenance Module */}
      {subTab === 'mantenimiento' && (
        <MaintenanceWorkbench
          tenantId={tenant.id}
          vehicles={vehicles}
          workOrders={workOrders}
          preventivePlans={preventivePlans}
          partsInventory={partsInventory}
          checklists={checklists}
          maintenanceRecords={maintenanceRecords}
          maintenanceDashboard={maintenanceDashboard}
          canWriteFleet={canWriteFleet}
          onCreateWorkOrder={onCreateWorkOrder}
          onUpdateWorkOrder={onUpdateWorkOrder}
          onCreatePreventivePlan={onCreatePreventivePlan}
          onUpdatePreventivePlan={onUpdatePreventivePlan}
          onAssignPreventivePlan={onAssignPreventivePlan}
          onEvaluateMaintenancePlans={onEvaluateMaintenancePlans}
          onTogglePreventivePlan={onTogglePreventivePlan}
          onUpsertPartInventory={onUpsertPartInventory}
          onAdjustPartStock={onAdjustPartStock}
          onCreateChecklist={onCreateChecklist}
          onOpenDossier={onOpenDossier}
        />
      )}

      {/* Sub-view 3: Devices & Dashcam Drivers / Capabilities Config */}
      {subTab === 'dispositivos' && (
        <DashcamConfigPanel
          tenant={tenant}
          availableTenants={availableTenants}
          devices={filteredDevices}
          dashcamDrivers={dashcamDrivers}
          activeRole={activeRole}
          isGlobalSuperadmin={isGlobalSuperadmin}
          onValidateDevice={onValidateDevice}
          onUpdateDeviceConfig={onUpdateDeviceConfig}
          onBatchUpdateDeviceConfig={onBatchUpdateDeviceConfig}
          onCreateDashcamDriver={onCreateDashcamDriver}
        />
      )}

      {/* Sub-view 4: Drivers / Operators */}
      {subTab === 'conductores' && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/80 text-sm font-medium text-slate-200">
            Padrón de operadores de {tenant.name} ({drivers.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                  <th className="py-2.5 px-4">Operador</th>
                  <th className="py-2.5 px-4">Sucursal</th>
                  <th className="py-2.5 px-4">Licencia / Certificación</th>
                  <th className="py-2.5 px-4">Teléfono</th>
                  <th className="py-2.5 px-4">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {driversPagination.pagedItems.map((drv) => (
                  <tr key={drv.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 px-4 font-medium text-slate-100">{drv.name}</td>
                    <td className="py-2.5 px-4 text-slate-300">{drv.branch}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-300">{drv.licenseNumber}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-400">{drv.phone}</td>
                    <td className="py-2.5 px-4">
                      <span className={drv.status === 'activo' ? 'text-emerald-400' : 'text-amber-400'}>
                        {drv.status === 'activo' ? 'Activo' : 'En descanso'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={driversPagination.page}
            totalItems={driversPagination.totalItems}
            pageSize={5}
            onPageChange={driversPagination.setPage}
          />
        </div>
      )}

      {/* Slide-over drawer for registering new vehicle or heavy machinery */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-md bg-[#0F172A] border-l border-slate-800 h-full overflow-y-auto p-6 flex flex-col justify-between">
            <form onSubmit={handleSubmitNew} className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Truck className="w-4 h-4 text-sky-400" />
                  <h3 className="text-base font-semibold text-slate-100">Registrar vehículo o maquinaria</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {formError && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                  {formError}
                </div>
              )}

              <div className="space-y-3 text-xs">
                {availableTenants && tenant.id === 'all' && (
                  <div>
                    <label className="block text-slate-300 mb-1">Empresa destino</label>
                    <select
                      value={form.tenantId}
                      onChange={(e) => {
                        const nextTenant = availableTenants.find((t) => t.id === e.target.value);
                        setForm((p) => ({
                          ...p,
                          tenantId: e.target.value,
                          branch: nextTenant?.branches[0] ?? p.branch,
                        }));
                      }}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    >
                      {availableTenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Tipo de activo</label>
                    <select
                      value={form.assetType}
                      onChange={(e) => {
                        const at = e.target.value as AssetType;
                        setForm((p) => ({
                          ...p,
                          assetType: at,
                          brandModel: at === 'maquinaria_pesada' ? 'Excavadora CAT 320 GC' : 'Kenworth T680',
                        }));
                      }}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    >
                      <option value="vehiculo">Vehículo / Transporte</option>
                      <option value="maquinaria_pesada">Maquinaria Pesada</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Sucursal</label>
                    <select
                      value={form.branch}
                      onChange={(e) => setForm((p) => ({ ...p, branch: e.target.value }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    >
                      {drawerBranches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Código de unidad</label>
                    <input
                      type="text"
                      placeholder="Ej. MQ-210"
                      value={form.unitCode}
                      onChange={(e) => setForm((p) => ({ ...p, unitCode: e.target.value }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Placa o N° de serie</label>
                    <input
                      type="text"
                      placeholder="Ej. CAT-9012"
                      value={form.plate}
                      onChange={(e) => setForm((p) => ({ ...p, plate: e.target.value }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1">Marca / Modelo</label>
                    <input
                      type="text"
                      value={form.brandModel}
                      onChange={(e) => setForm((p) => ({ ...p, brandModel: e.target.value }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1">Horómetro actual (h)</label>
                    <input
                      type="number"
                      value={form.engineHours}
                      onChange={(e) => setForm((p) => ({ ...p, engineHours: Number(e.target.value) }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">Operador asignado</label>
                  <input
                    type="text"
                    placeholder="Nombre completo"
                    value={form.driverName}
                    onChange={(e) => setForm((p) => ({ ...p, driverName: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>

                <div className="pt-2 border-t border-slate-800">
                  <div className="text-slate-200 font-medium mb-2">Aprovisionamiento GPS / Dashcam / CAN</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-300 mb-1">Protocolo</label>
                      <select
                        value={form.protocol}
                        onChange={(e) => setForm((p) => ({ ...p, protocol: e.target.value as ProtocolType }))}
                        className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                      >
                        <option value="JT808/JT1078">JT808/JT1078 (Dashcam)</option>
                        <option value="Traccar">Traccar (GPS + CAN)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-300 mb-1">Modelo de equipo</label>
                      <input
                        type="text"
                        value={form.deviceModel}
                        onChange={(e) => setForm((p) => ({ ...p, deviceModel: e.target.value }))}
                        className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="block text-slate-300 mb-1">IMEI del equipo (15 dígitos)</label>
                    <input
                      type="text"
                      placeholder="864201051009911"
                      value={form.imei}
                      onChange={(e) => setForm((p) => ({ ...p, imei: e.target.value }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? 'Guardando...' : 'Guardar activo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
