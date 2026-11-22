import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Edit3,
  Link2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Warehouse,
  Wrench,
} from 'lucide-react';
import type {
  AssetType,
  ChecklistItem,
  ChecklistItemStatus,
  MaintenanceDashboardMetrics,
  MaintenanceRecord,
  PartInventoryItem,
  PreOpChecklist,
  PreventivePlan,
  Vehicle,
  WorkOrder,
  WorkOrderPartCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from '../shared/types.ts';
import {
  ASSET_TYPE_LABELS,
  CHECKLIST_RESULT_META,
  DEFAULT_MACHINERY_CHECKLIST_LABELS,
  DEFAULT_VEHICLE_CHECKLIST_LABELS,
  formatRelativeTime,
  formatServiceDate,
  MAINTENANCE_META,
  sortWorkOrdersByPriority,
  WORK_ORDER_PRIORITY_META,
  WORK_ORDER_STATUS_META,
} from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { MaintenanceDashboardView } from './MaintenanceDashboardView.tsx';
import { ExportMenu } from './ExportMenu.tsx';
import { Money, useMoney } from '../lib/money.tsx';

/** Currency of an amount: empty = the company's; any other enabled currency is converted on the server. */
function CurrencySelect({
  value,
  companyCode,
  onChange,
  className,
}: {
  value: string;
  companyCode: string | null;
  onChange: (code: string) => void;
  className?: string;
}) {
  const money = useMoney();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Moneda del importe" title="Moneda del importe">
      <option value="">{companyCode ?? 'Empresa'}</option>
      {money.enabled
        .filter((c) => c.code !== companyCode)
        .map((c) => (
          <option key={c.code} value={c.code}>
            {c.code}
          </option>
        ))}
    </select>
  );
}

/** "= $ 160.000,00 ARS al TC del 22/11 (manual)" under an amount loaded in another currency. */
function ConversionHint({ amount, from, to, date }: { amount: number; from: string; to: string | null; date?: string }) {
  const money = useMoney();
  if (!from || from === to) return null;
  if (!to) return <p className="mt-1 text-[11px] text-amber-300">La empresa no tiene moneda definida: no se puede convertir.</p>;
  const f = money.factor(from, to, date);
  if (f === null) return <p className="mt-1 text-[11px] text-rose-300">Falta el tipo de cambio {from}/{to}: el superadmin debe cargarlo en «Monedas».</p>;
  return (
    <p className="mt-1 text-[11px] text-amber-300">
      = {money.fmtIn(amount * f, to, { withCode: true })} al tipo de cambio {date ? 'de la fecha de la orden' : 'vigente'} (1 {from} = {Number(f.toPrecision(6))} {to})
    </p>
  );
}

interface PartDraft {
  sku: string;
  name: string;
  category: WorkOrderPartCategory;
  quantity: number;
  unitCost: number;
  /** Currency of unitCost when it isn't the company's (the server converts it). */
  currency?: string;
}

interface MaintenanceWorkbenchProps {
  tenantId: string;
  vehicles: Vehicle[];
  workOrders: WorkOrder[];
  preventivePlans: PreventivePlan[];
  partsInventory: PartInventoryItem[];
  checklists: PreOpChecklist[];
  maintenanceRecords: MaintenanceRecord[];
  maintenanceDashboard?: MaintenanceDashboardMetrics;
  canWriteFleet: boolean;
  onCreateWorkOrder: (payload: {
    vehicleId: string;
    planId?: string;
    type: WorkOrder['type'];
    priority: WorkOrder['priority'];
    title: string;
    workshopOrTech: string;
    scheduledDate: string;
    parts: PartDraft[];
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
      parts?: PartDraft[];
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
  onOpenDossier: (vehicleId: string) => void;
}

type MaintSubTab =
  | 'dashboard'
  | 'ordenes'
  | 'planes'
  | 'almacen'
  | 'checklists'
  | 'pendientes'
  | 'bitacora';

export function MaintenanceWorkbench({
  tenantId,
  vehicles,
  workOrders,
  preventivePlans,
  partsInventory,
  checklists,
  maintenanceRecords,
  maintenanceDashboard,
  canWriteFleet,
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
}: MaintenanceWorkbenchProps) {
  const money = useMoney();
  /** Amount in `from` → the company's currency (estimate with the latest rate; NaN when a rate is missing). */
  const toCompany = (amount: number, from: string | undefined, companyCur: string | null, dateIso?: string) => {
    if (!from || from === companyCur) return amount;
    if (!companyCur) return NaN;
    const f = money.factor(from, companyCur, dateIso);
    return f === null ? NaN : amount * f;
  };
  const showAmount = (n: number, cur: string | null) => (Number.isNaN(n) ? 'sin TC' : money.fmtIn(n, cur));
  const [tab, setTab] = useState<MaintSubTab>('dashboard');
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | WorkOrderPriority>('all');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(workOrders[0]?.id ?? null);

  // New Work Order Form
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [orderForm, setOrderForm] = useState({
    vehicleId: vehicles[0]?.id ?? '',
    planId: '',
    type: 'preventivo' as WorkOrder['type'],
    priority: 'media' as WorkOrder['priority'],
    title: 'Servicio preventivo programado · Cambio de aceite y filtros',
    workshopOrTech: 'Taller Central Certificado',
    scheduledDate: new Date().toISOString().slice(0, 10),
    laborCost: 1850,
    laborCurrency: '',
    notes: '',
    clearFaultsOnClose: true,
  });
  const [partDrafts, setPartDrafts] = useState<PartDraft[]>([
    {
      sku: 'LUB-15W40-19L',
      name: 'Aceite Diésel Sintético 15W-40 (19L)',
      category: 'insumo',
      quantity: 1,
      unitCost: 2650,
    },
  ]);
  const [selectedInvSkuNew, setSelectedInvSkuNew] = useState('');
  const [newPartRow, setNewPartRow] = useState<PartDraft>({
    sku: '',
    name: '',
    category: 'refaccion',
    quantity: 1,
    unitCost: 850,
  });
  const [savingOrder, setSavingOrder] = useState(false);

  // Edit Existing Selected Work Order State
  const [editDraft, setEditDraft] = useState<{
    priority: WorkOrderPriority;
    workshopOrTech: string;
    scheduledDate: string;
    laborCost: number;
    laborCurrency: string;
    notes: string;
    nextServiceDate: string;
    clearFaultsOnClose: boolean;
    parts: PartDraft[];
  } | null>(null);
  const [editSelectedInvSku, setEditSelectedInvSku] = useState('');
  const [editCustomPart, setEditCustomPart] = useState<PartDraft>({
    sku: '',
    name: '',
    category: 'refaccion',
    quantity: 1,
    unitCost: 750,
  });
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);

  // Preventive Plans Form & Edit / Assign
  const [showNewPlan, setShowNewPlan] = useState(false);
  const [planForm, setPlanForm] = useState({
    name: '',
    assetType: 'ambos' as AssetType | 'ambos',
    intervalHours: 250,
    intervalKm: 10000,
    intervalDays: 45,
    estimatedCost: 6500,
    checklistFocus: '',
  });
  const [savingPlan, setSavingPlan] = useState(false);
  const [evaluatingPlans, setEvaluatingPlans] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [editPlanForm, setEditPlanForm] = useState({
    name: '',
    assetType: 'ambos' as AssetType | 'ambos',
    intervalHours: 250,
    intervalKm: 10000,
    intervalDays: 45,
    estimatedCost: 6500,
    checklistFocus: '',
  });
  const [assigningPlanId, setAssigningPlanId] = useState<string | null>(null);
  const [assignVehicleIds, setAssignVehicleIds] = useState<string[]>([]);

  // Warehouse Inventory Form & Filters
  const [showNewPartInv, setShowNewPartInv] = useState(false);
  const [invSearch, setInvSearch] = useState('');
  const [invFilter, setInvFilter] = useState<'all' | 'refaccion' | 'insumo' | 'low'>('all');
  const [invForm, setInvForm] = useState({
    sku: '',
    name: '',
    category: 'refaccion' as PartInventoryItem['category'],
    unit: 'pza',
    stockQty: 8,
    minStock: 3,
    unitCost: 950,
    unitCostCurrency: '',
    warehouseLocation: 'Almacén Central · Rack B2',
  });
  const [savingInv, setSavingInv] = useState(false);

  // New Pre-op Checklist Form
  const [showNewChecklist, setShowNewChecklist] = useState(false);
  const defaultChecklistVehicle = vehicles[0];
  const [chkVehicleId, setChkVehicleId] = useState(defaultChecklistVehicle?.id ?? '');
  const [chkDriverName, setChkDriverName] = useState(defaultChecklistVehicle?.driverName ?? '');
  const [chkShift, setChkShift] = useState<PreOpChecklist['shift']>('Matutino');
  const [chkItems, setChkItems] = useState<ChecklistItem[]>(() => {
    const labels =
      defaultChecklistVehicle?.assetType === 'maquinaria_pesada'
        ? DEFAULT_MACHINERY_CHECKLIST_LABELS
        : DEFAULT_VEHICLE_CHECKLIST_LABELS;
    return labels.map((label, idx) => ({ id: `it-${idx}`, label, status: 'ok' }));
  });
  const [chkSummary, setChkSummary] = useState('');
  const [chkAutoWo, setChkAutoWo] = useState(true);
  const [savingChk, setSavingChk] = useState(false);

  const inventoryMap = useMemo(
    () => new Map(partsInventory.map((item) => [item.sku.toUpperCase(), item])),
    [partsInventory]
  );

  const maintenancePending = useMemo(() => {
    const rank = (v: Vehicle) => {
      if (v.maintenanceStatus === 'vencido') return 0;
      if (v.faultCodes.some((f) => f.severity === 'critica')) return 1;
      if (v.maintenanceStatus === 'proximo') return 2;
      return 3;
    };
    return [...vehicles]
      .filter((v) => v.maintenanceStatus !== 'al_dia' || v.faultCodes.length > 0)
      .sort((a, b) => rank(a) - rank(b) || a.nextServiceDate.localeCompare(b.nextServiceDate));
  }, [vehicles]);

  const filteredOrders = useMemo(() => {
    const filtered = workOrders.filter((w) => {
      if (statusFilter !== 'all' && w.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && w.priority !== priorityFilter) return false;
      return true;
    });
    return sortWorkOrdersByPriority(filtered, vehicles);
  }, [workOrders, vehicles, statusFilter, priorityFilter]);

  const filteredInventory = useMemo(() => {
    const q = invSearch.trim().toLowerCase();
    return partsInventory.filter((item) => {
      if (invFilter === 'refaccion' && item.category !== 'refaccion') return false;
      if (invFilter === 'insumo' && item.category !== 'insumo') return false;
      if (invFilter === 'low' && item.stockQty > item.minStock) return false;
      if (!q) return true;
      return (
        item.sku.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.warehouseLocation.toLowerCase().includes(q)
      );
    });
  }, [partsInventory, invSearch, invFilter]);

  const ordersPagination = usePagination(
    filteredOrders,
    `${tenantId}|wo|${statusFilter}|${priorityFilter}|${filteredOrders.length}`,
    5
  );
  const plansPagination = usePagination(preventivePlans, `${tenantId}|plans|${preventivePlans.length}`, 5);
  const inventoryPagination = usePagination(
    filteredInventory,
    `${tenantId}|inv|${invFilter}|${invSearch}|${filteredInventory.length}`,
    5
  );
  const checklistsPagination = usePagination(checklists, `${tenantId}|chk|${checklists.length}`, 5);
  const pendingPagination = usePagination(maintenancePending, `${tenantId}|pend|${maintenancePending.length}`, 5);
  const recordsPagination = usePagination(maintenanceRecords, `${tenantId}|rec|${maintenanceRecords.length}`, 5);

  const selectedOrder =
    workOrders.find((w) => w.id === selectedOrderId) ?? ordersPagination.pagedItems[0] ?? null;

  useEffect(() => {
    if (!selectedOrder) {
      setEditDraft(null);
      return;
    }
    setEditDraft({
      priority: selectedOrder.priority,
      workshopOrTech: selectedOrder.workshopOrTech,
      scheduledDate: selectedOrder.scheduledDate,
      laborCost: selectedOrder.laborOriginal?.amount ?? selectedOrder.laborCost,
      laborCurrency: selectedOrder.laborOriginal?.currency ?? '',
      notes: selectedOrder.notes,
      nextServiceDate: '',
      clearFaultsOnClose: Boolean(selectedOrder.clearFaultsOnClose),
      parts: selectedOrder.parts.map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        quantity: p.quantity,
        unitCost: p.original?.amount ?? p.unitCost,
        ...(p.original ? { currency: p.original.currency } : {}),
      })),
    });
  }, [
    selectedOrder?.id,
    selectedOrder?.status,
    selectedOrder?.priority,
    selectedOrder?.parts.length,
    selectedOrder?.totalCost,
  ]);

  const activeOrdersCount = workOrders.filter(
    (w) => w.status === 'abierta' || w.status === 'en_taller' || w.status === 'esperando_refacciones'
  ).length;
  // Global view: each company's amounts converted to the scope currency (orders without a rate are left out).
  const totalWorkOrders = workOrders
    .filter((w) => w.status !== 'cancelada')
    .reduce((sum, w) => sum + w.totalCost * (money.toScope(w.tenantId, w.completedAt || w.createdAt) ?? 0), 0);
  const flaggedChecklistsCount = checklists.filter((c) => c.result !== 'aprobado').length;
  const lowStockItems = useMemo(
    () => partsInventory.filter((i) => i.stockQty <= i.minStock),
    [partsInventory]
  );
  const totalInventoryValue = useMemo(
    () => partsInventory.reduce((s, i) => s + i.stockQty * i.unitCost * (money.toScope(i.tenantId) ?? 0), 0),
    [partsInventory, money]
  );

  const orderVehicle = vehicles.find((v) => v.id === orderForm.vehicleId);
  const draftCur = money.currencyOf(orderVehicle?.tenantId)?.code ?? null;
  const draftPartsTotal = partDrafts.reduce((s, p) => s + toCompany(p.quantity * p.unitCost, p.currency, draftCur), 0);
  const draftGrandTotal = draftPartsTotal + toCompany(Number(orderForm.laborCost || 0), orderForm.laborCurrency, draftCur);

  const handleSelectPlanForOrder = (planId: string) => {
    const plan = preventivePlans.find((p) => p.id === planId);
    setOrderForm((prev) => ({
      ...prev,
      planId,
      title: plan ? plan.name : prev.title,
      laborCost: plan ? Math.round(plan.estimatedCost * 0.35) : prev.laborCost,
      notes: plan ? plan.checklistFocus : prev.notes,
    }));
  };

  const handlePickInventorySkuForNewOrder = (sku: string) => {
    setSelectedInvSkuNew(sku);
    const inv = partsInventory.find((i) => i.sku === sku);
    if (!inv) return;
    setPartDrafts((prev) => {
      const existingIdx = prev.findIndex((p) => p.sku === inv.sku);
      if (existingIdx >= 0) {
        return prev.map((p, idx) => (idx === existingIdx ? { ...p, quantity: p.quantity + 1 } : p));
      }
      return [
        ...prev,
        {
          sku: inv.sku,
          name: inv.name,
          category: inv.category,
          quantity: 1,
          unitCost: inv.unitCost,
        },
      ];
    });
    setSelectedInvSkuNew('');
  };

  const handleAddPartDraft = () => {
    if (!newPartRow.name.trim()) return;
    setPartDrafts((prev) => [
      ...prev,
      {
        ...newPartRow,
        sku: (newPartRow.sku.trim() || `REF-${100 + prev.length}`).toUpperCase(),
        name: newPartRow.name.trim(),
        quantity: Math.max(1, Number(newPartRow.quantity || 1)),
        unitCost: Math.max(0, Number(newPartRow.unitCost || 0)),
      },
    ]);
    setNewPartRow({ sku: '', name: '', category: 'refaccion', quantity: 1, unitCost: 650 });
  };

  const handleCreateOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderForm.vehicleId || !orderForm.title.trim()) return;
    setSavingOrder(true);
    try {
      await onCreateWorkOrder({
        ...orderForm,
        laborCurrency: orderForm.laborCurrency || undefined,
        planId: orderForm.planId || undefined,
        parts: partDrafts,
      });
      setShowNewOrder(false);
    } finally {
      setSavingOrder(false);
    }
  };

  const handlePickInventorySkuForEdit = (sku: string) => {
    setEditSelectedInvSku(sku);
    const inv = partsInventory.find((i) => i.sku === sku);
    if (!inv || !editDraft) return;
    setEditDraft((prev) => {
      if (!prev) return prev;
      const idx = prev.parts.findIndex((p) => p.sku === inv.sku);
      if (idx >= 0) {
        return {
          ...prev,
          parts: prev.parts.map((p, i) => (i === idx ? { ...p, quantity: p.quantity + 1 } : p)),
        };
      }
      return {
        ...prev,
        parts: [
          ...prev.parts,
          {
            sku: inv.sku,
            name: inv.name,
            category: inv.category,
            quantity: 1,
            unitCost: inv.unitCost,
          },
        ],
      };
    });
    setEditSelectedInvSku('');
  };

  const handleAddCustomPartToEdit = () => {
    if (!editDraft || !editCustomPart.name.trim()) return;
    setEditDraft((prev) =>
      prev
        ? {
            ...prev,
            parts: [
              ...prev.parts,
              {
                ...editCustomPart,
                sku: (editCustomPart.sku.trim() || `REF-${200 + prev.parts.length}`).toUpperCase(),
                name: editCustomPart.name.trim(),
                quantity: Math.max(1, Number(editCustomPart.quantity || 1)),
                unitCost: Math.max(0, Number(editCustomPart.unitCost || 0)),
              },
            ],
          }
        : prev
    );
    setEditCustomPart({ sku: '', name: '', category: 'refaccion', quantity: 1, unitCost: 750 });
  };

  const handleSaveSelectedOrderEdits = async (nextStatus?: WorkOrderStatus) => {
    if (!selectedOrder || !editDraft) return;
    setUpdatingOrderId(selectedOrder.id);
    try {
      await onUpdateWorkOrder(selectedOrder.id, {
        status: nextStatus,
        priority: editDraft.priority,
        workshopOrTech: editDraft.workshopOrTech,
        scheduledDate: editDraft.scheduledDate,
        laborCost: editDraft.laborCost,
        laborCurrency: editDraft.laborCurrency || undefined,
        notes: editDraft.notes,
        clearFaultsOnClose: editDraft.clearFaultsOnClose,
        nextServiceDate: editDraft.nextServiceDate || undefined,
        parts: editDraft.parts,
      });
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleCreatePlanSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planForm.name.trim()) return;
    setSavingPlan(true);
    try {
      await onCreatePreventivePlan(planForm);
      setPlanForm({
        name: '',
        assetType: 'ambos',
        intervalHours: 250,
        intervalKm: 10000,
        intervalDays: 45,
        estimatedCost: 6500,
        checklistFocus: '',
      });
      setShowNewPlan(false);
    } finally {
      setSavingPlan(false);
    }
  };

  const handleOpenEditPlan = (pl: PreventivePlan) => {
    setAssigningPlanId(null);
    setEditingPlanId(pl.id);
    setEditPlanForm({
      name: pl.name,
      assetType: pl.assetType,
      intervalHours: pl.intervalHours,
      intervalKm: pl.intervalKm,
      intervalDays: pl.intervalDays,
      estimatedCost: pl.estimatedCost,
      checklistFocus: pl.checklistFocus,
    });
  };

  const handleSaveEditPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPlanId || !editPlanForm.name.trim()) return;
    setSavingPlan(true);
    try {
      await onUpdatePreventivePlan(editingPlanId, editPlanForm);
      setEditingPlanId(null);
    } finally {
      setSavingPlan(false);
    }
  };

  const handleOpenAssignPlan = (pl: PreventivePlan) => {
    setEditingPlanId(null);
    setAssigningPlanId(pl.id);
    const currentAssigned = vehicles.filter((v) => v.assignedPlanId === pl.id).map((v) => v.id);
    setAssignVehicleIds(currentAssigned);
  };

  const handleSaveAssignPlan = async () => {
    if (!assigningPlanId || assignVehicleIds.length === 0) return;
    setSavingPlan(true);
    try {
      await onAssignPreventivePlan(assigningPlanId, assignVehicleIds);
      setAssigningPlanId(null);
    } finally {
      setSavingPlan(false);
    }
  };

  const handleEvaluatePlansNow = async () => {
    setEvaluatingPlans(true);
    try {
      await onEvaluateMaintenancePlans();
    } finally {
      setEvaluatingPlans(false);
    }
  };

  const handleSubmitInventory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invForm.sku.trim() || !invForm.name.trim()) return;
    setSavingInv(true);
    try {
      await onUpsertPartInventory({ ...invForm, unitCostCurrency: invForm.unitCostCurrency || undefined });
      setInvForm({
        sku: '',
        name: '',
        category: 'refaccion',
        unit: 'pza',
        stockQty: 8,
        minStock: 3,
        unitCost: 950,
        unitCostCurrency: '',
        warehouseLocation: 'Almacén Central · Rack B2',
      });
      setShowNewPartInv(false);
    } finally {
      setSavingInv(false);
    }
  };

  const handleChecklistVehicleChange = (nextVehicleId: string) => {
    setChkVehicleId(nextVehicleId);
    const veh = vehicles.find((v) => v.id === nextVehicleId);
    if (veh) {
      setChkDriverName(veh.driverName);
      const labels =
        veh.assetType === 'maquinaria_pesada'
          ? DEFAULT_MACHINERY_CHECKLIST_LABELS
          : DEFAULT_VEHICLE_CHECKLIST_LABELS;
      setChkItems(labels.map((label, idx) => ({ id: `it-${idx}`, label, status: 'ok' })));
    }
  };

  const handleChecklistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chkVehicleId) return;
    setSavingChk(true);
    try {
      await onCreateChecklist({
        vehicleId: chkVehicleId,
        driverName: chkDriverName,
        shift: chkShift,
        items: chkItems,
        summaryNote: chkSummary,
        createWorkOrderIfFailed: chkAutoWo,
      });
      setChkSummary('');
      setShowNewChecklist(false);
    } finally {
      setSavingChk(false);
    }
  };

  const isSelectedOrderEditable = Boolean(
    canWriteFleet &&
      selectedOrder &&
      selectedOrder.status !== 'completada' &&
      selectedOrder.status !== 'cancelada'
  );

  const editCur = money.currencyOf(selectedOrder?.tenantId)?.code ?? null;
  const editDate = selectedOrder?.createdAt;
  const editPartsSubtotal = editDraft
    ? editDraft.parts.reduce((s, p) => s + toCompany(p.quantity * p.unitCost, p.currency, editCur, editDate), 0)
    : 0;
  const editLabor = editDraft ? toCompany(Number(editDraft.laborCost || 0), editDraft.laborCurrency, editCur, editDate) : 0;
  const editGrandTotal = editDraft ? editPartsSubtotal + editLabor : 0;

  return (
    <div className="space-y-4">
      {/* Sub-navigation bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#11192C] border border-slate-800/80 rounded-xl p-2.5">
        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 overflow-x-auto">
          {(
            [
              { id: 'dashboard', label: 'Dashboard de Mantenimiento' },
              { id: 'ordenes', label: `Órdenes de trabajo (${workOrders.length})` },
              { id: 'planes', label: `Planes preventivos (${preventivePlans.length})` },
              {
                id: 'almacen',
                label:
                  lowStockItems.length > 0
                    ? `Almacén (${partsInventory.length} · ${lowStockItems.length} bajo mín.)`
                    : `Almacén (${partsInventory.length})`,
              },
              { id: 'checklists', label: `Checklists pre-op (${checklists.length})` },
              { id: 'pendientes', label: `Por atender (${maintenancePending.length})` },
              { id: 'bitacora', label: `Bitácora (${maintenanceRecords.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                tab === item.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {tab === 'ordenes' && (
            <ExportMenu url="/api/work-orders/export" label="Exportar órdenes" count={workOrders.length} fileName="ordenes-trabajo" />
          )}
          {tab === 'ordenes' && canWriteFleet && (
            <button
              type="button"
              onClick={() => setShowNewOrder((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {showNewOrder ? 'Cerrar formulario' : 'Nueva orden de trabajo'}
            </button>
          )}
          {tab === 'planes' && canWriteFleet && (
            <>
              <button
                type="button"
                disabled={evaluatingPlans}
                onClick={handleEvaluatePlansNow}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${evaluatingPlans ? 'animate-spin' : ''}`} />
                {evaluatingPlans ? 'Evaluando...' : 'Evaluar umbrales ahora'}
              </button>
              <button
                type="button"
                onClick={() => setShowNewPlan((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {showNewPlan ? 'Cancelar plan' : 'Nuevo plan preventivo'}
              </button>
            </>
          )}
          {tab === 'almacen' && canWriteFleet && (
            <button
              type="button"
              onClick={() => setShowNewPartInv((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {showNewPartInv ? 'Cancelar captura' : 'Registrar SKU en almacén'}
            </button>
          )}
          {tab === 'checklists' && (
            <button
              type="button"
              onClick={() => setShowNewChecklist((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer whitespace-nowrap shrink-0"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              {showNewChecklist ? 'Cancelar inspección' : 'Registrar checklist'}
            </button>
          )}
        </div>
      </div>

      {/* KPI strip for operational workbench sub-tabs */}
      {tab !== 'dashboard' && tab !== 'almacen' && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
            <div className="text-xs text-slate-400">Órdenes activas / taller</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-sky-400 mt-1">
              {activeOrdersCount} <span className="text-xs font-normal text-slate-500">/ {workOrders.length}</span>
            </div>
          </div>
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
            <div className="text-xs text-slate-400">Inversión órdenes {money.currencyOf()?.code ?? ''}</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
              <Money amount={totalWorkOrders} showEquivalent={!money.consolidated} />
            </div>
          </div>
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
            <div className="text-xs text-slate-400">Unidades por atender</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-amber-400 mt-1">
              {maintenancePending.length}
            </div>
          </div>
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
            <div className="text-xs text-slate-400">Checklists / Stock almacén</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-rose-400 mt-1">
              {flaggedChecklistsCount}{' '}
              <span className="text-xs font-normal text-slate-400">
                hallazgos · {lowStockItems.length} SKU mín.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 0: MAINTENANCE DASHBOARD */}
      {tab === 'dashboard' && (
        <MaintenanceDashboardView
          tenantId={tenantId}
          vehicles={vehicles}
          workOrders={workOrders}
          metrics={maintenanceDashboard}
          onOpenDossier={onOpenDossier}
          onGoToOrders={(woId) => {
            if (woId) setSelectedOrderId(woId);
            setTab('ordenes');
          }}
          onGoToPending={() => setTab('pendientes')}
        />
      )}

      {/* TAB 1: WORK ORDERS + PARTS & COST BREAKDOWN */}
      {tab === 'ordenes' && (
        <div className="space-y-4">
          {showNewOrder && canWriteFleet && (
            <form
              onSubmit={handleCreateOrderSubmit}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-4 text-xs"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                <div className="font-semibold text-slate-100 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-sky-400" />
                  Apertura de orden de trabajo y presupuesto de refacciones
                </div>
                <div className="font-mono tabular-nums text-emerald-400 font-semibold">
                  Total estimado: {showAmount(draftGrandTotal, draftCur)} {draftCur ?? ''}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Unidad / Maquinaria</label>
                  <select
                    value={orderForm.vehicleId}
                    onChange={(e) => setOrderForm((p) => ({ ...p, vehicleId: e.target.value }))}
                    className="w-full px-2.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.unitCode} · {v.brandModel} ({v.engineHours} h)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Vincular plan preventivo</label>
                  <select
                    value={orderForm.planId}
                    onChange={(e) => handleSelectPlanForOrder(e.target.value)}
                    className="w-full px-2.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  >
                    <option value="">Orden libre / Correctiva</option>
                    {preventivePlans.map((pl) => (
                      <option key={pl.id} value={pl.id}>
                        {pl.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Tipo / Prioridad</label>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={orderForm.type}
                      onChange={(e) => setOrderForm((p) => ({ ...p, type: e.target.value as WorkOrder['type'] }))}
                      className="px-2 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    >
                      <option value="preventivo">Preventivo</option>
                      <option value="correctivo">Correctivo</option>
                      <option value="inspeccion">Inspección</option>
                    </select>
                    <select
                      value={orderForm.priority}
                      onChange={(e) =>
                        setOrderForm((p) => ({ ...p, priority: e.target.value as WorkOrder['priority'] }))
                      }
                      className="px-2 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    >
                      <option value="critica">Crítica</option>
                      <option value="alta">Alta</option>
                      <option value="media">Media</option>
                      <option value="baja">Baja</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Fecha programada</label>
                  <input
                    type="date"
                    value={orderForm.scheduledDate}
                    onChange={(e) => setOrderForm((p) => ({ ...p, scheduledDate: e.target.value }))}
                    className="w-full px-2.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Descripción del trabajo</label>
                  <input
                    type="text"
                    value={orderForm.title}
                    onChange={(e) => setOrderForm((p) => ({ ...p, title: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Taller o técnico responsable</label>
                  <input
                    type="text"
                    value={orderForm.workshopOrTech}
                    onChange={(e) => setOrderForm((p) => ({ ...p, workshopOrTech: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
              </div>

              {/* Warehouse catalog picker + custom part builder */}
              <div className="p-3 rounded-lg bg-[#0B1120] border border-slate-800 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300 font-medium">
                  <span className="flex items-center gap-1.5">
                    <Package className="w-3.5 h-3.5 text-sky-400" />
                    Refacciones e insumos asignados ({partDrafts.length})
                  </span>
                  <div className="flex items-center gap-3">
                    <select
                      value={selectedInvSkuNew}
                      onChange={(e) => handlePickInventorySkuForNewOrder(e.target.value)}
                      className="px-2.5 py-1 bg-[#11192C] border border-sky-500/40 rounded text-sky-300"
                    >
                      <option value="">+ Agregar desde almacén...</option>
                      {partsInventory.map((inv) => (
                        <option key={inv.id} value={inv.sku}>
                          {inv.sku} · {inv.name} (Stock: {inv.stockQty} {inv.unit} · {money.fmt(inv.unitCost, inv.tenantId)})
                        </option>
                      ))}
                    </select>
                    <span className="font-mono tabular-nums text-slate-300">
                      Materiales: {showAmount(draftPartsTotal, draftCur)}
                    </span>
                  </div>
                </div>

                {partDrafts.map((pt, idx) => {
                  const inv = inventoryMap.get(pt.sku.toUpperCase());
                  const lowStockWarn = inv && pt.quantity > inv.stockQty;
                  return (
                    <div
                      key={`${pt.sku}-${idx}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#11192C] border border-slate-800/80"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sky-300">{pt.sku}</span>
                        <span className="text-slate-200 truncate">{pt.name}</span>
                        <span className="text-slate-500">· {pt.category}</span>
                        {inv && (
                          <span className={`font-mono ${lowStockWarn ? 'text-rose-400' : 'text-slate-400'}`}>
                            (Almacén: {inv.stockQty} {inv.unit})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 font-mono tabular-nums">
                        <span className="text-slate-300">
                          {pt.quantity} × {money.fmtIn(pt.unitCost, pt.currency ?? draftCur)} ={' '}
                          {money.fmtIn(pt.quantity * pt.unitCost, pt.currency ?? draftCur)}
                          {pt.currency && pt.currency !== draftCur && (
                            <span className="text-amber-300"> ≈ {showAmount(toCompany(pt.quantity * pt.unitCost, pt.currency, draftCur), draftCur)}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPartDrafts((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-slate-500 hover:text-rose-400 cursor-pointer"
                          aria-label="Eliminar partida"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="SKU libre"
                    value={newPartRow.sku}
                    onChange={(e) => setNewPartRow((p) => ({ ...p, sku: e.target.value }))}
                    className="px-2 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100 font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Descripción refacción / insumo"
                    value={newPartRow.name}
                    onChange={(e) => setNewPartRow((p) => ({ ...p, name: e.target.value }))}
                    className="sm:col-span-2 px-2 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100"
                  />
                  <select
                    value={newPartRow.category}
                    onChange={(e) =>
                      setNewPartRow((p) => ({ ...p, category: e.target.value as WorkOrderPartCategory }))
                    }
                    className="px-2 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100"
                  >
                    <option value="refaccion">Refacción</option>
                    <option value="insumo">Insumo</option>
                    <option value="mano_obra">Subcontrato</option>
                  </select>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      type="number"
                      min={1}
                      value={newPartRow.quantity}
                      onChange={(e) => setNewPartRow((p) => ({ ...p, quantity: Number(e.target.value) }))}
                      className="px-2 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100 font-mono"
                      title="Cantidad"
                    />
                    <input
                      type="number"
                      min={0}
                      value={newPartRow.unitCost}
                      onChange={(e) => setNewPartRow((p) => ({ ...p, unitCost: Number(e.target.value) }))}
                      className="px-2 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100 font-mono"
                      title={`Costo unitario (${newPartRow.currency ?? draftCur ?? 'moneda de la empresa'})`}
                    />
                    <CurrencySelect
                      value={newPartRow.currency ?? ''}
                      companyCode={draftCur}
                      onChange={(c) => setNewPartRow((p) => ({ ...p, currency: c || undefined }))}
                      className="px-1 py-1.5 bg-[#11192C] border border-slate-800 rounded text-slate-100"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddPartDraft}
                    className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 font-medium cursor-pointer"
                  >
                    + Agregar ítem
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-slate-400 mb-1">Mano de obra taller ({orderForm.laborCurrency || draftCur || 'sin moneda'})</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min={0}
                      value={orderForm.laborCost}
                      onChange={(e) => setOrderForm((p) => ({ ...p, laborCost: Number(e.target.value) }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                    />
                    <CurrencySelect
                      value={orderForm.laborCurrency}
                      companyCode={draftCur}
                      onChange={(c) => setOrderForm((p) => ({ ...p, laborCurrency: c }))}
                      className="px-1.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    />
                  </div>
                  <ConversionHint amount={Number(orderForm.laborCost || 0)} from={orderForm.laborCurrency} to={draftCur} />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Notas técnicas</label>
                  <input
                    type="text"
                    placeholder="Observaciones para bahía o almacén"
                    value={orderForm.notes}
                    onChange={(e) => setOrderForm((p) => ({ ...p, notes: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={orderForm.clearFaultsOnClose}
                      onChange={(e) => setOrderForm((p) => ({ ...p, clearFaultsOnClose: e.target.checked }))}
                    />
                    Limpiar fallas DTC al cerrar
                  </label>
                  <button
                    type="submit"
                    disabled={savingOrder}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer whitespace-nowrap"
                  >
                    {savingOrder ? 'Creando...' : 'Abrir orden'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Status & Priority filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'Todas' },
                  { id: 'abierta', label: 'Abiertas' },
                  { id: 'en_taller', label: 'En taller' },
                  { id: 'esperando_refacciones', label: 'Esperando refacciones' },
                  { id: 'completada', label: 'Completadas' },
                  { id: 'cancelada', label: 'Canceladas' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                    statusFilter === f.id
                      ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                      : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-slate-400 mr-1">Prioridad:</span>
              {(
                [
                  { id: 'all', label: 'Todas' },
                  { id: 'critica', label: 'Crítica' },
                  { id: 'alta', label: 'Alta' },
                  { id: 'media', label: 'Media' },
                  { id: 'baja', label: 'Baja' },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPriorityFilter(p.id)}
                  className={`px-2.5 py-1 rounded-lg font-medium border cursor-pointer whitespace-nowrap ${
                    priorityFilter === p.id
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
            {/* Work Orders Table (5 per page) */}
            <div className="xl:col-span-7 bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden flex flex-col justify-between">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                      <th className="py-2.5 px-4">Orden / Prioridad</th>
                      <th className="py-2.5 px-4">Trabajo / Taller</th>
                      <th className="py-2.5 px-4">Estado / Fecha</th>
                      <th className="py-2.5 px-4 text-right">Costo</th>
                      <th className="py-2.5 px-4 text-right">Flujo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {ordersPagination.pagedItems.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                          No hay órdenes de trabajo con este filtro.
                        </td>
                      </tr>
                    ) : (
                      ordersPagination.pagedItems.map((wo) => {
                        const st = WORK_ORDER_STATUS_META[wo.status];
                        const pri = WORK_ORDER_PRIORITY_META[wo.priority];
                        const isSelected = selectedOrder?.id === wo.id;
                        return (
                          <tr
                            key={wo.id}
                            onClick={() => setSelectedOrderId(wo.id)}
                            className={`cursor-pointer transition-colors ${
                              isSelected ? 'bg-sky-500/10' : 'hover:bg-slate-800/30'
                            }`}
                          >
                            <td className="py-2.5 px-4">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-semibold text-slate-100">{wo.id}</span>
                                <span className={`font-semibold ${pri.colorClass}`}>· {pri.label}</span>
                              </div>
                              <div className="text-slate-400">
                                {wo.unitCode} · {ASSET_TYPE_LABELS[wo.assetType]}
                                {wo.autoGenerated && <span className="text-amber-300 font-mono"> · Auto</span>}
                              </div>
                            </td>
                            <td className="py-2.5 px-4">
                              <div className="font-medium text-slate-200 max-w-[220px] truncate">{wo.title}</div>
                              <div className="text-slate-400">
                                {wo.workshopOrTech} · {wo.parts.length} refacc./insumos
                              </div>
                            </td>
                            <td className="py-2.5 px-4">
                              <div className={`font-medium ${st.colorClass}`}>{st.label}</div>
                              <div className="font-mono text-slate-500">{formatServiceDate(wo.scheduledDate)}</div>
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                              <div>{money.fmt(wo.totalCost, wo.tenantId)}</div>
                              <div className="text-slate-500">
                                Ref: {money.fmt(wo.partsCost, wo.tenantId)}
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              {canWriteFleet && wo.status !== 'completada' && wo.status !== 'cancelada' ? (
                                <div className="inline-flex items-center gap-1.5">
                                  {wo.status === 'abierta' && (
                                    <button
                                      type="button"
                                      onClick={() => onUpdateWorkOrder(wo.id, { status: 'en_taller' })}
                                      className="px-2 py-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 cursor-pointer"
                                    >
                                      A taller
                                    </button>
                                  )}
                                  {wo.status !== 'esperando_refacciones' && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onUpdateWorkOrder(wo.id, { status: 'esperando_refacciones' })
                                      }
                                      className="px-2 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 cursor-pointer"
                                    >
                                      Refacciones
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => onUpdateWorkOrder(wo.id, { status: 'completada' })}
                                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                                  >
                                    Completar
                                  </button>
                                </div>
                              ) : (
                                <span className="text-slate-500">
                                  {wo.completedAt ? formatRelativeTime(wo.completedAt) : 'Cerrada'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={ordersPagination.page}
                totalItems={ordersPagination.totalItems}
                pageSize={5}
                onPageChange={ordersPagination.setPage}
              />
            </div>

            {/* Selected Work Order Full Editor & Warehouse Parts Inspector */}
            <div className="xl:col-span-5 bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3 text-xs">
              {selectedOrder && editDraft ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-sky-300">{selectedOrder.id}</span>
                        <span className={`font-semibold ${WORK_ORDER_PRIORITY_META[selectedOrder.priority].colorClass}`}>
                          · {WORK_ORDER_PRIORITY_META[selectedOrder.priority].label}
                        </span>
                        <span className={`font-medium ${WORK_ORDER_STATUS_META[selectedOrder.status].colorClass}`}>
                          · {WORK_ORDER_STATUS_META[selectedOrder.status].label}
                        </span>
                      </div>
                      <div className="text-sm font-semibold text-slate-100 mt-0.5">
                        {selectedOrder.unitCode} · {selectedOrder.plate}
                      </div>
                      <div className="text-slate-400">{selectedOrder.title}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenDossier(selectedOrder.vehicleId)}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      Ver unidad
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-2 font-mono tabular-nums">
                    <div className="p-2 rounded bg-[#0B1120] border border-slate-800">
                      <div className="text-[11px] text-slate-500">Refacciones</div>
                      <div className="text-slate-200 font-semibold mt-0.5">
                        {showAmount(isSelectedOrderEditable ? editPartsSubtotal : selectedOrder.partsCost, editCur)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-[#0B1120] border border-slate-800">
                      <div className="text-[11px] text-slate-500">Mano obra</div>
                      <div className="text-slate-200 font-semibold mt-0.5">
                        {showAmount(isSelectedOrderEditable ? editLabor : selectedOrder.laborCost, editCur)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-[#0B1120] border border-emerald-500/30">
                      <div className="text-[11px] text-slate-500">Total {editCur ?? ''}</div>
                      <div className="text-emerald-400 font-semibold mt-0.5">
                        {isSelectedOrderEditable ? (
                          showAmount(editGrandTotal, editCur)
                        ) : (
                          <Money amount={selectedOrder.totalCost} tenantId={selectedOrder.tenantId} date={selectedOrder.completedAt || selectedOrder.createdAt} showEquivalent />
                        )}
                      </div>
                    </div>
                  </div>

                  {isSelectedOrderEditable ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-slate-400 mb-1">Prioridad</label>
                          <select
                            value={editDraft.priority}
                            onChange={(e) =>
                              setEditDraft((p) =>
                                p ? { ...p, priority: e.target.value as WorkOrderPriority } : p
                              )
                            }
                            className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                          >
                            <option value="critica">Crítica</option>
                            <option value="alta">Alta</option>
                            <option value="media">Media</option>
                            <option value="baja">Baja</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Fecha programada</label>
                          <input
                            type="date"
                            value={editDraft.scheduledDate}
                            onChange={(e) =>
                              setEditDraft((p) => (p ? { ...p, scheduledDate: e.target.value } : p))
                            }
                            className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-slate-400 mb-1">Taller / Técnico</label>
                          <input
                            type="text"
                            value={editDraft.workshopOrTech}
                            onChange={(e) =>
                              setEditDraft((p) => (p ? { ...p, workshopOrTech: e.target.value } : p))
                            }
                            className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Mano de obra ({editDraft.laborCurrency || editCur || 'sin moneda'})</label>
                          <div className="flex gap-1">
                            <input
                              type="number"
                              min={0}
                              value={editDraft.laborCost}
                              onChange={(e) =>
                                setEditDraft((p) =>
                                  p ? { ...p, laborCost: Math.max(0, Number(e.target.value)) } : p
                                )
                              }
                              className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                            />
                            <CurrencySelect
                              value={editDraft.laborCurrency}
                              companyCode={editCur}
                              onChange={(c) => setEditDraft((p) => (p ? { ...p, laborCurrency: c } : p))}
                              className="px-1 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                            />
                          </div>
                          <ConversionHint amount={Number(editDraft.laborCost || 0)} from={editDraft.laborCurrency} to={editCur} date={editDate} />
                        </div>
                      </div>

                      {/* Editable parts list with warehouse SKU picker */}
                      <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-slate-300">
                            Refacciones ({editDraft.parts.length}) · Descuento auto al cerrar
                          </span>
                          <select
                            value={editSelectedInvSku}
                            onChange={(e) => handlePickInventorySkuForEdit(e.target.value)}
                            className="px-2 py-1 bg-[#11192C] border border-sky-500/40 rounded text-sky-300 max-w-[200px]"
                          >
                            <option value="">+ Del almacén...</option>
                            {partsInventory.map((inv) => (
                              <option key={inv.id} value={inv.sku}>
                                {inv.sku} · Stock {inv.stockQty} · {money.fmt(inv.unitCost, inv.tenantId)}
                              </option>
                            ))}
                          </select>
                        </div>

                        {editDraft.parts.length === 0 ? (
                          <div className="text-slate-500 py-1">Sin refacciones capturadas.</div>
                        ) : (
                          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                            {editDraft.parts.map((pt, idx) => {
                              const inv = inventoryMap.get(pt.sku.toUpperCase());
                              const insufficient = inv && pt.quantity > inv.stockQty;
                              return (
                                <div
                                  key={`${pt.sku}-${idx}`}
                                  className="p-2 rounded bg-[#11192C] border border-slate-800/80 flex items-center justify-between gap-2"
                                >
                                  <div className="min-w-0">
                                    <div className="text-slate-200 truncate">{pt.name}</div>
                                    <div className="font-mono text-[11px] text-slate-500">
                                      {pt.sku} · {pt.quantity} × {money.fmtIn(pt.unitCost, pt.currency ?? editCur)}
                                      {inv && (
                                        <span className={insufficient ? ' text-rose-400' : ' text-emerald-400'}>
                                          {' '}
                                          (Stock: {inv.stockQty})
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="font-mono tabular-nums text-slate-200">
                                      {showAmount(toCompany(pt.quantity * pt.unitCost, pt.currency, editCur, editDate), editCur)}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditDraft((p) =>
                                          p ? { ...p, parts: p.parts.filter((_, i) => i !== idx) } : p
                                        )
                                      }
                                      className="text-slate-500 hover:text-rose-400 cursor-pointer"
                                      aria-label="Quitar partida"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <div className="grid grid-cols-4 gap-1.5 pt-1">
                          <input
                            type="text"
                            placeholder="SKU"
                            value={editCustomPart.sku}
                            onChange={(e) => setEditCustomPart((p) => ({ ...p, sku: e.target.value }))}
                            className="px-2 py-1 bg-[#11192C] border border-slate-800 rounded font-mono text-slate-100"
                          />
                          <input
                            type="text"
                            placeholder="Refacción libre"
                            value={editCustomPart.name}
                            onChange={(e) => setEditCustomPart((p) => ({ ...p, name: e.target.value }))}
                            className="col-span-2 px-2 py-1 bg-[#11192C] border border-slate-800 rounded text-slate-100"
                          />
                          <button
                            type="button"
                            onClick={handleAddCustomPartToEdit}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 cursor-pointer"
                          >
                            + Ítem
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-slate-400 mb-1">Notas técnicas</label>
                          <input
                            type="text"
                            value={editDraft.notes}
                            onChange={(e) => setEditDraft((p) => (p ? { ...p, notes: e.target.value } : p))}
                            className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">Próx. fecha al cerrar (opc.)</label>
                          <input
                            type="date"
                            value={editDraft.nextServiceDate}
                            onChange={(e) =>
                              setEditDraft((p) => (p ? { ...p, nextServiceDate: e.target.value } : p))
                            }
                            className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800">
                        <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editDraft.clearFaultsOnClose}
                            onChange={(e) =>
                              setEditDraft((p) =>
                                p ? { ...p, clearFaultsOnClose: e.target.checked } : p
                              )
                            }
                          />
                          Limpiar DTC al cerrar
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={updatingOrderId === selectedOrder.id}
                            onClick={() => handleSaveSelectedOrderEdits('cancelada')}
                            className="px-2.5 py-1.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 cursor-pointer whitespace-nowrap"
                          >
                            Cancelar OT
                          </button>
                          <button
                            type="button"
                            disabled={updatingOrderId === selectedOrder.id}
                            onClick={() => handleSaveSelectedOrderEdits()}
                            className="px-2.5 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-medium cursor-pointer whitespace-nowrap"
                          >
                            Guardar cambios
                          </button>
                          <button
                            type="button"
                            disabled={updatingOrderId === selectedOrder.id}
                            onClick={() => handleSaveSelectedOrderEdits('completada')}
                            className="px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer whitespace-nowrap"
                          >
                            Completar OT
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-300">Desglose de refacciones e insumos</span>
                          {selectedOrder.stockDeducted && (
                            <span className="text-emerald-400 font-mono text-[11px]">
                              ✓ Stock descontado de almacén
                            </span>
                          )}
                        </div>
                        {selectedOrder.parts.length === 0 ? (
                          <div className="text-slate-500 py-2">Sin refacciones capturadas; solo mano de obra.</div>
                        ) : (
                          selectedOrder.parts.map((pt) => (
                            <div
                              key={pt.id}
                              className="p-2 rounded bg-[#0B1120] border border-slate-800/80 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-slate-200 truncate">{pt.name}</div>
                                <div className="font-mono text-[11px] text-slate-500">
                                  {pt.sku} · {pt.category} · {pt.quantity} pza
                                </div>
                              </div>
                              <div className="font-mono tabular-nums text-slate-200 shrink-0">
                                {money.fmt(pt.subtotal, selectedOrder.tenantId)}
                                {pt.original && (
                                  <div className="text-[10px] text-amber-300" title="Cargado en otra moneda; convertido con el TC de la fecha de la orden">
                                    {money.fmtIn(pt.original.amount * pt.quantity, pt.original.currency)}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="p-2.5 rounded bg-[#0B1120] border border-slate-800 text-slate-300">
                        <div className="text-slate-500 mb-0.5">
                          Taller: {selectedOrder.workshopOrTech} · Horómetro: {selectedOrder.engineHoursAtOrder} h
                        </div>
                        <div>{selectedOrder.notes || 'Sin observaciones adicionales.'}</div>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="text-slate-400 py-8 text-center">
                  Selecciona una orden de trabajo para editar o ver su desglose.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PREVENTIVE PLANS BY HOURS / KM / CALENDAR */}
      {tab === 'planes' && (
        <div className="space-y-4">
          {showNewPlan && canWriteFleet && (
            <form
              onSubmit={handleCreatePlanSubmit}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-sky-400" />
                Nuevo plan preventivo por horómetro, odómetro y calendario
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input
                  type="text"
                  placeholder="Nombre del plan (ej. Servicio 500h Excavadoras)"
                  value={planForm.name}
                  onChange={(e) => setPlanForm((p) => ({ ...p, name: e.target.value }))}
                  className="md:col-span-2 px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <select
                  value={planForm.assetType}
                  onChange={(e) =>
                    setPlanForm((p) => ({ ...p, assetType: e.target.value as AssetType | 'ambos' }))
                  }
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="vehiculo">Vehículos</option>
                  <option value="maquinaria_pesada">Maquinaria Pesada</option>
                  <option value="ambos">Toda la flota</option>
                </select>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Cada (horas motor)</label>
                  <input
                    type="number"
                    min={25}
                    value={planForm.intervalHours}
                    onChange={(e) => setPlanForm((p) => ({ ...p, intervalHours: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Cada (kilómetros)</label>
                  <input
                    type="number"
                    min={500}
                    value={planForm.intervalKm}
                    onChange={(e) => setPlanForm((p) => ({ ...p, intervalKm: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Cada (días calendario)</label>
                  <input
                    type="number"
                    min={7}
                    value={planForm.intervalDays}
                    onChange={(e) => setPlanForm((p) => ({ ...p, intervalDays: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Presupuesto base ({money.currencyOf()?.code ?? 'sin moneda'})</label>
                  <input
                    type="number"
                    min={0}
                    value={planForm.estimatedCost}
                    onChange={(e) => setPlanForm((p) => ({ ...p, estimatedCost: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  placeholder="Alcance de inspección (aceites, hidráulico, ADAS, frenos...)"
                  value={planForm.checklistFocus}
                  onChange={(e) => setPlanForm((p) => ({ ...p, checklistFocus: e.target.value }))}
                  className="flex-1 min-w-[240px] px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <button
                  type="submit"
                  disabled={savingPlan}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                >
                  {savingPlan ? 'Guardando...' : 'Guardar plan'}
                </button>
              </div>
            </form>
          )}

          {/* Inline Edit Plan Drawer */}
          {editingPlanId && canWriteFleet && (
            <form
              onSubmit={handleSaveEditPlan}
              className="bg-[#11192C] border border-amber-500/35 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="flex items-center justify-between">
                <div className="font-semibold text-amber-300 flex items-center gap-2">
                  <Edit3 className="w-4 h-4" />
                  Editando intervalos y alcance del plan preventivo
                </div>
                <button
                  type="button"
                  onClick={() => setEditingPlanId(null)}
                  className="text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={editPlanForm.name}
                  onChange={(e) => setEditPlanForm((p) => ({ ...p, name: e.target.value }))}
                  className="md:col-span-2 px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <select
                  value={editPlanForm.assetType}
                  onChange={(e) =>
                    setEditPlanForm((p) => ({ ...p, assetType: e.target.value as AssetType | 'ambos' }))
                  }
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="vehiculo">Vehículos</option>
                  <option value="maquinaria_pesada">Maquinaria Pesada</option>
                  <option value="ambos">Toda la flota</option>
                </select>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Umbral horas</label>
                  <input
                    type="number"
                    min={25}
                    value={editPlanForm.intervalHours}
                    onChange={(e) => setEditPlanForm((p) => ({ ...p, intervalHours: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Umbral km</label>
                  <input
                    type="number"
                    min={500}
                    value={editPlanForm.intervalKm}
                    onChange={(e) => setEditPlanForm((p) => ({ ...p, intervalKm: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Umbral días</label>
                  <input
                    type="number"
                    min={7}
                    value={editPlanForm.intervalDays}
                    onChange={(e) => setEditPlanForm((p) => ({ ...p, intervalDays: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Costo base ({money.currencyOf()?.code ?? 'sin moneda'})</label>
                  <input
                    type="number"
                    min={0}
                    value={editPlanForm.estimatedCost}
                    onChange={(e) =>
                      setEditPlanForm((p) => ({ ...p, estimatedCost: Number(e.target.value) }))
                    }
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={editPlanForm.checklistFocus}
                  onChange={(e) => setEditPlanForm((p) => ({ ...p, checklistFocus: e.target.value }))}
                  className="flex-1 min-w-[240px] px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <button
                  type="submit"
                  disabled={savingPlan}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium cursor-pointer"
                >
                  {savingPlan ? 'Actualizando...' : 'Actualizar plan'}
                </button>
              </div>
            </form>
          )}

          {/* Inline Assign Plan to Vehicles Panel */}
          {assigningPlanId && canWriteFleet && (() => {
            const plan = preventivePlans.find((p) => p.id === assigningPlanId);
            if (!plan) return null;
            const compatible = vehicles.filter(
              (v) =>
                v.tenantId === plan.tenantId &&
                (plan.assetType === 'ambos' || v.assetType === plan.assetType)
            );
            return (
              <div className="bg-[#11192C] border border-sky-500/35 rounded-xl p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-sky-300 flex items-center gap-2">
                    <Link2 className="w-4 h-4" />
                    Asignar "{plan.name}" a unidades compatibles ({compatible.length})
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAssigningPlanId(null)}
                      className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={savingPlan || assignVehicleIds.length === 0}
                      onClick={handleSaveAssignPlan}
                      className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium cursor-pointer"
                    >
                      Guardar asignación ({assignVehicleIds.length})
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {compatible.map((v) => {
                    const checked = assignVehicleIds.includes(v.id);
                    return (
                      <label
                        key={v.id}
                        className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 cursor-pointer ${
                          checked
                            ? 'bg-sky-500/15 border-sky-500/45 text-slate-100'
                            : 'bg-[#0B1120] border-slate-800 text-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setAssignVehicleIds((prev) => [...prev, v.id]);
                              } else {
                                setAssignVehicleIds((prev) => prev.filter((id) => id !== v.id));
                              }
                            }}
                          />
                          <span className="font-semibold truncate">{v.unitCode}</span>
                        </div>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0">
                          {v.engineHours}h · {v.odometerKm.toLocaleString('es-MX')}km
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-2.5 px-4">Plan preventivo / Alcance</th>
                    <th className="py-2.5 px-4">Tipo de activo</th>
                    <th className="py-2.5 px-4 font-mono">Umbrales (h / km / días)</th>
                    <th className="py-2.5 px-4 text-right">Unidades / Costo</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {plansPagination.pagedItems.map((pl) => {
                    const assignedCount = vehicles.filter((v) => v.assignedPlanId === pl.id).length;
                    return (
                      <tr key={pl.id} className="hover:bg-slate-800/30">
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-slate-100">{pl.name}</div>
                          <div className="text-slate-400">{pl.checklistFocus}</div>
                        </td>
                        <td className="py-2.5 px-4 text-sky-300">
                          {pl.assetType === 'ambos' ? 'Toda la flota' : ASSET_TYPE_LABELS[pl.assetType]}
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-slate-200">
                          {pl.intervalHours} h · {pl.intervalKm.toLocaleString('es-MX')} km · {pl.intervalDays} d
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          <div className="text-emerald-400">{money.fmt(pl.estimatedCost, pl.tenantId, { withCode: true })}</div>
                          <div className="text-slate-400">{assignedCount} asignada(s)</div>
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-1.5">
                          <button
                            type="button"
                            disabled={!canWriteFleet}
                            onClick={() => handleOpenEditPlan(pl)}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer disabled:opacity-50"
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            disabled={!canWriteFleet}
                            onClick={() => handleOpenAssignPlan(pl)}
                            className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 cursor-pointer disabled:opacity-50"
                          >
                            Asignar
                          </button>
                          <button
                            type="button"
                            disabled={!canWriteFleet}
                            onClick={() => onTogglePreventivePlan(pl.id)}
                            className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer disabled:opacity-50 ${
                              pl.active
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                            }`}
                          >
                            {pl.active ? 'Activo' : 'Pausado'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={plansPagination.page}
              totalItems={plansPagination.totalItems}
              pageSize={5}
              onPageChange={plansPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* TAB 3: WAREHOUSE SPARE PARTS & SUPPLIES CATALOG */}
      {tab === 'almacen' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
              <div className="text-xs text-slate-400 flex items-center justify-between">
                <span>Catálogo SKUs en almacén</span>
                <Warehouse className="w-4 h-4 text-sky-400" />
              </div>
              <div className="text-xl font-semibold font-mono tabular-nums text-slate-100 mt-1">
                {partsInventory.length} SKUs
              </div>
            </div>
            <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
              <div className="text-xs text-slate-400 flex items-center justify-between">
                <span>Alertas de stock mínimo</span>
                <AlertTriangle className="w-4 h-4 text-rose-400" />
              </div>
              <div
                className={`text-xl font-semibold font-mono tabular-nums mt-1 ${
                  lowStockItems.length > 0 ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                {lowStockItems.length} por resurtir
              </div>
            </div>
            <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
              <div className="text-xs text-slate-400">Valor total en almacén ({money.currencyOf()?.code ?? 'sin moneda'})</div>
              <div className="text-xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
                <Money amount={totalInventoryValue} showEquivalent={!money.consolidated} />
              </div>
            </div>
          </div>

          {showNewPartInv && canWriteFleet && (
            <form
              onSubmit={handleSubmitInventory}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <Package className="w-4 h-4 text-sky-400" />
                Alta o actualización de SKU en almacén de taller
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  type="text"
                  placeholder="SKU (ej. FLT-HID-90)"
                  value={invForm.sku}
                  onChange={(e) => setInvForm((p) => ({ ...p, sku: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
                <input
                  type="text"
                  placeholder="Nombre / Descripción"
                  value={invForm.name}
                  onChange={(e) => setInvForm((p) => ({ ...p, name: e.target.value }))}
                  className="md:col-span-2 px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <select
                  value={invForm.category}
                  onChange={(e) =>
                    setInvForm((p) => ({ ...p, category: e.target.value as PartInventoryItem['category'] }))
                  }
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="refaccion">Refacción</option>
                  <option value="insumo">Insumo / Lubricante</option>
                </select>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
                <div>
                  <label className="block text-slate-400 mb-1">Existencia inicial</label>
                  <input
                    type="number"
                    min={0}
                    value={invForm.stockQty}
                    onChange={(e) => setInvForm((p) => ({ ...p, stockQty: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Stock mínimo</label>
                  <input
                    type="number"
                    min={0}
                    value={invForm.minStock}
                    onChange={(e) => setInvForm((p) => ({ ...p, minStock: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Costo unit. ({invForm.unitCostCurrency || money.currencyOf()?.code || 'sin moneda'})</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min={0}
                      value={invForm.unitCost}
                      onChange={(e) => setInvForm((p) => ({ ...p, unitCost: Number(e.target.value) }))}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                    />
                    <CurrencySelect
                      value={invForm.unitCostCurrency}
                      companyCode={money.currencyOf()?.code ?? null}
                      onChange={(c) => setInvForm((p) => ({ ...p, unitCostCurrency: c }))}
                      className="px-1.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                    />
                  </div>
                  <ConversionHint amount={Number(invForm.unitCost || 0)} from={invForm.unitCostCurrency} to={money.currencyOf()?.code ?? null} />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Unidad / Anaquel</label>
                  <input
                    type="text"
                    value={invForm.warehouseLocation}
                    onChange={(e) => setInvForm((p) => ({ ...p, warehouseLocation: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingInv}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                >
                  {savingInv ? 'Guardando...' : 'Guardar SKU'}
                </button>
              </div>
            </form>
          )}

          {/* Inventory Search & Category Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'Todo el almacén' },
                  { id: 'refaccion', label: 'Refacciones' },
                  { id: 'insumo', label: 'Insumos' },
                  { id: 'low', label: `Bajo stock mínimo (${lowStockItems.length})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setInvFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                    invFilter === f.id
                      ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                      : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                placeholder="Buscar SKU, refacción o anaquel..."
                className="pl-8 pr-3 py-1.5 w-60 bg-[#11192C] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500"
              />
            </div>
          </div>

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-2.5 px-4">SKU / Categoría</th>
                    <th className="py-2.5 px-4">Descripción / Ubicación</th>
                    <th className="py-2.5 px-4 text-right">Stock / Mínimo</th>
                    <th className="py-2.5 px-4 text-right">Costo Unit.</th>
                    <th className="py-2.5 px-4 text-right">Reabasto rápido</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {inventoryPagination.pagedItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                        Sin refacciones o insumos que coincidan con el filtro.
                      </td>
                    </tr>
                  ) : (
                    inventoryPagination.pagedItems.map((item) => {
                      const isLow = item.stockQty <= item.minStock;
                      return (
                        <tr key={item.id} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-4">
                            <div className="font-mono font-semibold text-sky-300">{item.sku}</div>
                            <div className="text-slate-400 capitalize">{item.category}</div>
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-100">{item.name}</div>
                            <div className="text-slate-400">{item.warehouseLocation}</div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                            <div className={isLow ? 'text-rose-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                              {item.stockQty} {item.unit}
                            </div>
                            <div className="text-slate-500">
                              Mín: {item.minStock} {item.unit}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                            {money.fmt(item.unitCost, item.tenantId, { withCode: true })}
                            {item.unitCostOriginal && (
                              <div className="text-[10px] text-amber-300">
                                cargado {money.fmtIn(item.unitCostOriginal.amount, item.unitCostOriginal.currency, { withCode: true })}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              disabled={!canWriteFleet}
                              onClick={() => onAdjustPartStock(item.id, 5, 'Entrada rápida +5 en taller')}
                              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 font-mono cursor-pointer disabled:opacity-50"
                            >
                              +5
                            </button>
                            <button
                              type="button"
                              disabled={!canWriteFleet}
                              onClick={() => onAdjustPartStock(item.id, 10, 'Compra reabasto +10')}
                              className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 font-mono cursor-pointer disabled:opacity-50"
                            >
                              +10
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
              page={inventoryPagination.page}
              totalItems={inventoryPagination.totalItems}
              pageSize={5}
              onPageChange={inventoryPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* TAB 4: PRE-OP CHECKLISTS FOR VEHICLES & HEAVY MACHINERY */}
      {tab === 'checklists' && (
        <div className="space-y-4">
          {showNewChecklist && (
            <form
              onSubmit={handleChecklistSubmit}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-sky-400" />
                Inspección pre-operativa por turno (Vehículo / Maquinaria pesada)
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Unidad / Activo</label>
                  <select
                    value={chkVehicleId}
                    onChange={(e) => handleChecklistVehicleChange(e.target.value)}
                    className="w-full px-2.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.unitCode} · {ASSET_TYPE_LABELS[v.assetType]} · {v.brandModel}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Operador que inspecciona</label>
                  <input
                    type="text"
                    value={chkDriverName}
                    onChange={(e) => setChkDriverName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Turno operativo</label>
                  <select
                    value={chkShift}
                    onChange={(e) => setChkShift(e.target.value as PreOpChecklist['shift'])}
                    className="w-full px-2.5 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                  >
                    <option value="Matutino">Matutino</option>
                    <option value="Vespertino">Vespertino</option>
                    <option value="Nocturno">Nocturno</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                {chkItems.map((item, idx) => (
                  <div
                    key={item.id}
                    className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800 flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="text-slate-200">{item.label}</span>
                    <div className="flex items-center gap-1.5">
                      {(['ok', 'falla', 'na'] as ChecklistItemStatus[]).map((st) => (
                        <button
                          key={st}
                          type="button"
                          onClick={() =>
                            setChkItems((prev) =>
                              prev.map((it, i) => (i === idx ? { ...it, status: st } : it))
                            )
                          }
                          className={`px-2.5 py-1 rounded text-[11px] font-medium border cursor-pointer ${
                            item.status === st
                              ? st === 'ok'
                                ? 'bg-emerald-600 text-white border-emerald-500'
                                : st === 'falla'
                                  ? 'bg-rose-600 text-white border-rose-500'
                                  : 'bg-slate-700 text-white border-slate-600'
                              : 'bg-[#11192C] text-slate-400 border-slate-800'
                          }`}
                        >
                          {st === 'ok' ? 'OK' : st === 'falla' ? 'Falla' : 'N/A'}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <input
                  type="text"
                  placeholder="Notas de inspección o hallazgo..."
                  value={chkSummary}
                  onChange={(e) => setChkSummary(e.target.value)}
                  className="flex-1 min-w-[220px] px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chkAutoWo}
                    onChange={(e) => setChkAutoWo(e.target.checked)}
                  />
                  Generar orden correctiva automática si hay fallas
                </label>
                <button
                  type="submit"
                  disabled={savingChk}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                >
                  {savingChk ? 'Registrando...' : 'Guardar checklist'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-2.5 px-4">Folio / Unidad</th>
                    <th className="py-2.5 px-4">Operador / Turno</th>
                    <th className="py-2.5 px-4">Resultado</th>
                    <th className="py-2.5 px-4">Hallazgos / OT vinculada</th>
                    <th className="py-2.5 px-4 text-right">Horómetro / Fecha</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {checklistsPagination.pagedItems.map((chk) => {
                    const resMeta = CHECKLIST_RESULT_META[chk.result];
                    const failedCount = chk.items.filter((i) => i.status === 'falla').length;
                    return (
                      <tr key={chk.id} className="hover:bg-slate-800/30">
                        <td className="py-2.5 px-4">
                          <div className="font-mono font-semibold text-slate-100">{chk.id}</div>
                          <div className="text-slate-400">
                            {chk.unitCode} · {ASSET_TYPE_LABELS[chk.assetType]}
                          </div>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="text-slate-200">{chk.driverName}</div>
                          <div className="text-slate-400">Turno {chk.shift}</div>
                        </td>
                        <td className="py-2.5 px-4">
                          <span className={`font-semibold ${resMeta.colorClass}`}>{resMeta.label}</span>
                          <div className="text-slate-500">
                            {failedCount === 0 ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <CheckCircle2 className="w-3 h-3" /> {chk.items.length} puntos OK
                              </span>
                            ) : (
                              `${failedCount} punto(s) con falla`
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-slate-300">
                          <div>{chk.summaryNote}</div>
                          {chk.linkedWorkOrderId && (
                            <div className="font-mono text-sky-400">Generó OT: {chk.linkedWorkOrderId}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">
                          <div>{chk.engineHours} h</div>
                          <div className="text-slate-500">{formatRelativeTime(chk.submittedAt)}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={checklistsPagination.page}
              totalItems={checklistsPagination.totalItems}
              pageSize={5}
              onPageChange={checklistsPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* TAB 5: PENDING UNITS */}
      {tab === 'pendientes' && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                  <th className="py-2.5 px-4">Unidad / Activo</th>
                  <th className="py-2.5 px-4">Horómetro / Odómetro / Fecha</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-4">Falla DTC / Motivo</th>
                  <th className="py-2.5 px-4 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {pendingPagination.pagedItems.map((v) => {
                  const m = MAINTENANCE_META[v.maintenanceStatus];
                  return (
                    <tr key={v.id} className="hover:bg-slate-800/30">
                      <td className="py-2.5 px-4">
                        <div className="font-semibold text-slate-100">{v.unitCode}</div>
                        <div className="text-slate-400">
                          {ASSET_TYPE_LABELS[v.assetType]} · {v.brandModel}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-300">
                        <div>
                          {v.engineHours} h / {v.nextServiceHours} h · {v.odometerKm.toLocaleString('es-MX')} /{' '}
                          {v.nextServiceKm.toLocaleString('es-MX')} km
                        </div>
                        <div className="text-slate-500">{formatServiceDate(v.nextServiceDate)}</div>
                      </td>
                      <td className={`py-2.5 px-4 font-medium ${m.colorClass}`}>{m.label}</td>
                      <td className="py-2.5 px-4 text-slate-300">
                        {v.faultCodes.length > 0 ? (
                          <span className="font-mono text-amber-300">
                            {v.faultCodes[0].code} · {v.faultCodes[0].system}
                          </span>
                        ) : (
                          <span className="text-slate-400">Umbral preventivo h/km/fecha</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onOpenDossier(v.id)}
                          className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium cursor-pointer"
                        >
                          Atender servicio
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={pendingPagination.page}
            totalItems={pendingPagination.totalItems}
            pageSize={5}
            onPageChange={pendingPagination.setPage}
          />
        </div>
      )}

      {/* TAB 6: SERVICE LOGBOOK */}
      {tab === 'bitacora' && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="divide-y divide-slate-800/60 text-xs">
            {recordsPagination.pagedItems.map((r) => (
              <div key={r.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-100">
                    {r.unitCode} · {r.title}
                  </div>
                  <div className="text-slate-400">
                    {r.workshopOrTech} · {r.notes}
                  </div>
                </div>
                <div className="text-right font-mono tabular-nums text-slate-300">
                  <div>
                    {r.engineHoursAtService} h · {money.fmt(r.cost, r.tenantId, { withCode: true })}
                  </div>
                  <div className="text-slate-500">{formatRelativeTime(r.performedAt)}</div>
                </div>
              </div>
            ))}
          </div>
          <Pagination
            page={recordsPagination.page}
            totalItems={recordsPagination.totalItems}
            pageSize={5}
            onPageChange={recordsPagination.setPage}
          />
        </div>
      )}
    </div>
  );
}
