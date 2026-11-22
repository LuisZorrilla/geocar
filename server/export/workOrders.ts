import type { AssetType, Tenant, WorkOrder, WorkOrderPriority, WorkOrderStatus } from '../../src/shared/types.ts';
import { toCsv, type CsvValue } from './csv.ts';

const PRIORITY: Record<WorkOrderPriority, string> = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja' };
const STATUS: Record<WorkOrderStatus, string> = {
  abierta: 'Abierta',
  en_taller: 'En taller',
  esperando_refacciones: 'Esperando refacciones',
  completada: 'Completada',
  cancelada: 'Cancelada',
};
const ORDER_TYPE: Record<WorkOrder['type'], string> = { preventivo: 'Preventivo', correctivo: 'Correctivo', inspeccion: 'Inspección' };
const ASSET: Record<AssetType, string> = { vehiculo: 'Vehículo', maquinaria_pesada: 'Maquinaria pesada' };

export const WORK_ORDER_CSV_HEADER = [
  'ID_OT',
  'Empresa',
  'ID_Activo',
  'Placa',
  'Tipo_Activo',
  'Tipo_OT',
  'Prioridad',
  'Estado',
  'Titulo',
  'Taller_Tecnico',
  'Fecha_Programada',
  'Fecha_Completada',
  'Costo_Mano_Obra',
  'Costo_Piezas',
  'Costo_Total',
  'Piezas_Consumidas',
  'Cantidad_Piezas',
  'Stock_Descontado',
  // Last, so the earlier columns keep their position for existing imports.
  'Moneda',
];

/** "SKU Nombre x2 | SKU2 Nombre x18" — quantities without trailing zeros. */
function describeParts(order: WorkOrder): string {
  return order.parts.map((p) => `${p.sku} ${p.name} x${Number(p.quantity.toFixed(2))}`).join(' | ');
}

/** Whole quantities without decimals ("2"); fractional ones (liters) with decimal comma ("18,5"). */
function formatQuantity(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))).replace('.', ',');
}

/** One row per work order, all statuses (open and closed). */
export function workOrdersToCsv(
  orders: WorkOrder[],
  tenantName: (tenantId: string) => string,
  currencyOf: (tenantId: string) => string | null = () => null
): string {
  const rows: CsvValue[][] = orders.map((o) => [
    o.id,
    tenantName(o.tenantId),
    o.unitCode,
    o.plate,
    ASSET[o.assetType] ?? o.assetType,
    ORDER_TYPE[o.type] ?? o.type,
    PRIORITY[o.priority] ?? o.priority,
    STATUS[o.status] ?? o.status,
    o.title,
    o.workshopOrTech,
    o.scheduledDate,
    o.completedAt ? o.completedAt.slice(0, 10) : '',
    o.laborCost,
    o.partsCost,
    o.totalCost,
    describeParts(o),
    formatQuantity(o.parts.reduce((sum, p) => sum + p.quantity, 0)),
    Boolean(o.stockDeducted),
    currencyOf(o.tenantId) ?? 'Sin moneda',
  ]);
  return toCsv(WORK_ORDER_CSV_HEADER, rows);
}

export function tenantNameResolver(tenants: Tenant[], fallback: string) {
  const byId = new Map(tenants.map((t) => [t.id, t.name]));
  return (tenantId: string) => byId.get(tenantId) ?? fallback;
}
