import type { AssetType, PartInventoryItem, WorkOrder } from '../shared/types.ts';

/** Today's date as YYYY-MM-DD in the browser's local time zone (scheduledDate is a local date). */
export function localToday(): string {
  return new Date().toLocaleDateString('en-CA');
}

export interface ScheduledVsOverdueRow {
  assetType: AssetType;
  label: string;
  programado: number;
  vencido: number;
}

const ASSET_ORDER: Array<{ assetType: AssetType; label: string }> = [
  { assetType: 'vehiculo', label: 'Vehículos' },
  { assetType: 'maquinaria_pesada', label: 'Maquinaria pesada' },
];

const isOpen = (w: WorkOrder) => w.status !== 'completada' && w.status !== 'cancelada';

/**
 * Open work orders per asset type: scheduled for today or later = «programado»,
 * scheduled before today = «vencido». Both categories are always present, in a fixed order.
 */
export function scheduledVsOverdueByAssetType(workOrders: WorkOrder[], today: string): ScheduledVsOverdueRow[] {
  return ASSET_ORDER.map(({ assetType, label }) => {
    const open = workOrders.filter((w) => w.assetType === assetType && isOpen(w));
    const vencido = open.filter((w) => w.scheduledDate < today).length;
    return { assetType, label, programado: open.length - vencido, vencido };
  });
}

export interface ConsumedPart {
  sku: string;
  name: string;
  value: number;
  quantity: number;
  unit: string;
  /** Share of the total consumed value (0-1). */
  share: number;
}

export interface TopConsumedParts {
  items: ConsumedPart[];
  total: number;
  /** Value of every part outside the top N. */
  other: number;
  otherCount: number;
}

/**
 * Parts consumed from the warehouse: those of completed work orders (or with stock already
 * deducted), excluding labor lines, ranked by value (company currency; `convert` puts several companies in one currency). Value, not quantity, because units
 * differ (pza, cubeta, kit…) and can't be added together.
 */
export function topConsumedParts(
  workOrders: WorkOrder[],
  inventory: PartInventoryItem[],
  n = 5,
  /** Consolidated view: factor of an order to the common currency (null = can't convert, left out). */
  convert?: (order: WorkOrder) => number | null
): TopConsumedParts {
  const units = new Map(inventory.map((p) => [p.sku.toUpperCase(), p.unit]));
  const bySku = new Map<string, { sku: string; name: string; value: number; quantity: number }>();

  for (const order of workOrders) {
    if (order.status !== 'completada' && !order.stockDeducted) continue;
    const factor = convert ? convert(order) : 1;
    if (factor === null) continue;
    for (const part of order.parts) {
      if (part.category === 'mano_obra') continue;
      const key = part.sku.toUpperCase();
      const acc = bySku.get(key) ?? { sku: part.sku, name: part.name, value: 0, quantity: 0 };
      acc.value += (part.subtotal ?? part.quantity * part.unitCost) * factor;
      acc.quantity += part.quantity;
      bySku.set(key, acc);
    }
  }

  const ranked = [...bySku.values()].sort((a, b) => b.value - a.value || a.sku.localeCompare(b.sku));
  const total = ranked.reduce((sum, p) => sum + p.value, 0);
  const top = ranked.slice(0, n);
  const rest = ranked.slice(n);
  return {
    items: top.map((p) => ({
      ...p,
      unit: units.get(p.sku.toUpperCase()) ?? 'u.',
      share: total > 0 ? p.value / total : 0,
    })),
    total,
    other: rest.reduce((sum, p) => sum + p.value, 0),
    otherCount: rest.length,
  };
}
