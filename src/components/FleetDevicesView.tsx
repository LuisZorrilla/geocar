import { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Wrench,
} from 'lucide-react';
import type {
  AssetType,
  ChecklistItem,
  Device,
  Driver,
  MaintenanceDashboardMetrics,
  MaintenanceRecord,
  PartInventoryItem,
  PreOpChecklist,
  PreventivePlan,
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
  MAINTENANCE_META,
  STATUS_META,
} from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import type { ReviewChecklistHandler } from '../shared/checklist.ts';
import { MaintenanceWorkbench } from './MaintenanceWorkbench.tsx';
import { MaintenancePanelView } from './MaintenancePanelView.tsx';
import { RegisterAssetDrawer, type CreateVehiclePayload } from './RegisterAssetDrawer.tsx';
import { AuthBadge } from './DriverBadges.tsx';
import { computeDriverAuthorization } from '../shared/drivers.ts';
import { ExportMenu } from './ExportMenu.tsx';

interface FleetDevicesViewProps {
  vehicles: Vehicle[];
  devices: Device[];
  maintenanceRecords: MaintenanceRecord[];
  maintenanceDashboard?: MaintenanceDashboardMetrics;
  workOrders: WorkOrder[];
  preventivePlans: PreventivePlan[];
  partsInventory: PartInventoryItem[];
  checklists: PreOpChecklist[];
  tenant: Tenant;
  availableTenants?: Tenant[];
  drivers: Driver[];
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  onCreateVehicle: (payload: CreateVehiclePayload) => Promise<void>;
  onCreateWorkOrder: (payload: {
    vehicleId: string;
    planId?: string;
    type: WorkOrder['type'];
    priority: WorkOrder['priority'];
    title: string;
    workshopOrTech: string;
    scheduledDate: string;
    parts: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCost: number; currency?: string }>;
    laborCost: number;
    laborCurrency?: string;
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
      laborCost?: number;
      laborCurrency?: string;
      parts?: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCost: number; currency?: string }>;
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
    estimatedCost: number;
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
      estimatedCost?: number;
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
    unitCost: number;
    unitCostCurrency?: string;
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
  onReviewChecklist: ReviewChecklistHandler;
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
  tenant,
  availableTenants,
  drivers,
  activeRole,
  isGlobalSuperadmin,
  onCreateVehicle,
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
  onReviewChecklist,
  onOpenDossier,
}: FleetDevicesViewProps) {
  const [subTab, setSubTab] = useState<'vehiculos' | 'mantenimiento' | 'panel' | 'conductores'>('vehiculos');
  const [assetFilter, setAssetFilter] = useState<'all' | AssetType>('all');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const canWriteFleet = activeRole.permissions.flotas === 'full' || activeRole.permissions.flotas === 'write';

  const deviceMap = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const tenantNameMap = useMemo(
    () => new Map((availableTenants ?? [tenant]).map((t) => [t.id, t.name])),
    [availableTenants, tenant]
  );
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

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 overflow-x-auto">
          {(
            [
              { id: 'vehiculos', label: `Vehículos y Maquinaria (${vehicles.length})` },
              { id: 'mantenimiento', label: `Mantenimiento (${workOrders.length} OT)` },
              { id: 'panel', label: 'Panel de mantenimiento' },
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
              placeholder="Buscar unidad, placa, operador..."
              className="pl-8 pr-3 py-1.5 w-56 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>

          <ExportMenu url="/api/reports/export" label="Exportar flota" count={vehicles.length} fileName="flota" />

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
                              {v.branch} · {dev ? (dev.role === 'telemetria' ? 'OBD-II' : dev.protocol) : 'Celular del chofer'}
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
          onReviewChecklist={onReviewChecklist}
          onOpenDossier={onOpenDossier}
        />
      )}

      {/* Sub-view: maintenance panel (Recharts) */}
      {subTab === 'panel' && <MaintenancePanelView workOrders={workOrders} partsInventory={partsInventory} />}

      {/* Sub-view 4: Drivers / Operators */}
      {subTab === 'conductores' && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-200">
              Padrón de choferes de {tenant.name} ({drivers.length})
            </span>
            {(activeRole.isSystemAdminRole || isGlobalSuperadmin) && (
              <span className="text-[11px] text-slate-400">La documentación y la habilitación se gestionan en el menú «Choferes».</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                  <th className="py-2.5 px-4">Operador</th>
                  <th className="py-2.5 px-4">Sucursal</th>
                  <th className="py-2.5 px-4">Clases de licencia</th>
                  <th className="py-2.5 px-4">Unidad</th>
                  <th className="py-2.5 px-4">Habilitación</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {driversPagination.pagedItems.map((drv) => (
                  <tr key={drv.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 px-4 font-medium text-slate-100">{drv.name}</td>
                    <td className="py-2.5 px-4 text-slate-300">{drv.branch}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-300">{drv.licenseClasses?.join(', ') || drv.licenseNumber}</td>
                    <td className="py-2.5 px-4 text-slate-300">{vehicles.find((v) => v.driverId === drv.id)?.unitCode ?? '—'}</td>
                    <td className="py-2.5 px-4">
                      <AuthBadge state={drv.documents ? computeDriverAuthorization(drv).state : (drv.lastAuthState ?? 'habilitado')} />
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

      {drawerOpen && (
        <RegisterAssetDrawer
          tenant={tenant}
          availableTenants={availableTenants}
          drivers={drivers}
          vehicles={vehicles}
          onCreateVehicle={onCreateVehicle}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
