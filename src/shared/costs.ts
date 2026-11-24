/**
 * TMS T3: tariffs, fuel, trip expenses, trip cost / profitability, pre-invoices and driver
 * settlements. Pure types and rules (server and browser); amounts are in the company's currency.
 */
import { distanceMeters } from './geo.ts';

// ---------------------------------------------------------------- tariffs

export type TariffRuleKind = 'tramo' | 'km' | 'tonelada' | 'pallet';

export interface TariffRule {
  id: string;
  kind: TariffRuleKind;
  /** tramo: fixed price per order from origin to destination (either direction when `bothWays`). */
  originPlaceId?: string;
  destinationPlaceId?: string;
  bothWays?: boolean;
  /** Price per order (tramo), per km, per tonne or per pallet. */
  price: number;
  /** Minimum charge per order for km / tonelada / pallet. */
  minimum?: number;
}

export interface TariffExtras {
  /** Waiting at a stop beyond the free minutes, charged per started hour. */
  waitingPerHour?: number;
  waitingFreeMinutes?: number;
  /** Surcharges in % over the base price. */
  dangerousPct?: number;
  refrigeratedPct?: number;
  /** Tolls paid on the trip are passed on to the customer (split between the trip's orders). */
  tollsPassThrough?: boolean;
}

export interface Tariff {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  active: boolean;
  /** Order in which rule kinds are tried (first that applies wins). */
  priority: TariffRuleKind[];
  rules: TariffRule[];
  extras: TariffExtras;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export const TARIFF_RULE_LABELS: Record<TariffRuleKind, string> = {
  tramo: 'Precio fijo por tramo',
  km: 'Por kilómetro',
  tonelada: 'Por tonelada',
  pallet: 'Por pallet',
};
export const DEFAULT_PRIORITY: TariffRuleKind[] = ['tramo', 'pallet', 'tonelada', 'km'];

export interface ChargeLine {
  label: string;
  amount: number;
}

/** What an order is charged (frozen when the order is delivered; can be adjusted by hand). */
export interface OrderCharge {
  amount: number;
  currency: string | null;
  lines: ChargeLine[];
  tariffId?: string;
  rule?: TariffRuleKind | 'manual';
  /** Road km estimate used for "por kilómetro". */
  distanceKm?: number;
  computedAt: string;
  /** Set when someone changed the amount by hand. */
  adjustedBy?: string;
  adjustReason?: string;
  /** Pre-invoice that billed it (orders are billed once). */
  preInvoiceId?: string;
}

/** Road distance estimate: straight line × 1.25. */
export const roadKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round((distanceMeters(a, b) * 1.25) / 100) / 10;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PriceInput {
  originPlaceId: string;
  destinationPlaceId: string;
  weightKg?: number;
  pallets?: number;
  dangerous?: boolean;
  refrigerated?: boolean;
  distanceKm: number;
  /** Minutes the unit waited at this order's stops (loading + unloading). */
  waitingMinutes?: number;
  /** Tolls of the trip that correspond to this order. */
  tolls?: number;
}

/** Prices an order with a tariff. Null when no rule applies (the order then needs a manual price). */
export function priceOrder(tariff: Pick<Tariff, 'rules' | 'extras' | 'priority'>, input: PriceInput): { amount: number; lines: ChargeLine[]; rule: TariffRuleKind } | null {
  const tryKind = (kind: TariffRuleKind): { base: number; label: string } | null => {
    for (const r of tariff.rules.filter((x) => x.kind === kind)) {
      if (kind === 'tramo') {
        const direct = r.originPlaceId === input.originPlaceId && r.destinationPlaceId === input.destinationPlaceId;
        const reverse = r.bothWays && r.originPlaceId === input.destinationPlaceId && r.destinationPlaceId === input.originPlaceId;
        if (direct || reverse) return { base: r.price, label: 'Flete por tramo' };
        continue;
      }
      const qty = kind === 'km' ? input.distanceKm : kind === 'tonelada' ? (input.weightKg ?? 0) / 1000 : (input.pallets ?? 0);
      if (!(qty > 0)) continue;
      const raw = qty * r.price;
      const base = Math.max(raw, r.minimum ?? 0);
      const unit = kind === 'km' ? `${qty.toLocaleString('es-AR')} km` : kind === 'tonelada' ? `${round2(qty).toLocaleString('es-AR')} t` : `${qty} pallets`;
      return { base, label: `Flete ${unit} × ${r.price.toLocaleString('es-AR')}${base > raw ? ' (mínimo)' : ''}` };
    }
    return null;
  };
  let found: { base: number; label: string } | null = null;
  let rule: TariffRuleKind | null = null;
  for (const kind of tariff.priority.length ? tariff.priority : DEFAULT_PRIORITY) {
    found = tryKind(kind);
    if (found) {
      rule = kind;
      break;
    }
  }
  if (!found || !rule) return null;
  const lines: ChargeLine[] = [{ label: found.label, amount: round2(found.base) }];
  const ex = tariff.extras;
  if (input.dangerous && ex.dangerousPct) lines.push({ label: `Recargo carga peligrosa ${ex.dangerousPct}%`, amount: round2((found.base * ex.dangerousPct) / 100) });
  if (input.refrigerated && ex.refrigeratedPct) lines.push({ label: `Recargo frío ${ex.refrigeratedPct}%`, amount: round2((found.base * ex.refrigeratedPct) / 100) });
  if (ex.waitingPerHour && (input.waitingMinutes ?? 0) > (ex.waitingFreeMinutes ?? 0)) {
    const hours = Math.ceil(((input.waitingMinutes ?? 0) - (ex.waitingFreeMinutes ?? 0)) / 60);
    lines.push({ label: `Estadía ${hours} h × ${ex.waitingPerHour.toLocaleString('es-AR')}`, amount: round2(hours * ex.waitingPerHour) });
  }
  if (ex.tollsPassThrough && (input.tolls ?? 0) > 0) lines.push({ label: 'Peajes', amount: round2(input.tolls!) });
  return { amount: round2(lines.reduce((a, l) => a + l.amount, 0)), lines, rule };
}

// ---------------------------------------------------------------- fuel

export interface FuelLoad {
  id: string;
  tenantId: string;
  vehicleId: string;
  driverId?: string;
  /** Trip in progress when it was loaded (assigned automatically). */
  tripId?: string;
  at: string;
  liters: number;
  pricePerLiter: number;
  total: number;
  odometerKm?: number;
  station?: string;
  fullTank?: boolean;
  source: 'manual' | 'app' | 'importacion';
  receiptFileId?: string;
  importBatch?: string;
  /** Anomalies found when it was recorded (see fuelAnomalies). */
  flags: FuelFlag[];
  createdBy: string;
  createdAt: string;
}

export type FuelFlagCode = 'excede_tanque' | 'consumo_alto' | 'odometro_incoherente' | 'obd_no_sube';
export interface FuelFlag {
  code: FuelFlagCode;
  message: string;
}
export const FUEL_FLAG_LABELS: Record<FuelFlagCode, string> = {
  excede_tanque: 'Más litros que el tanque',
  consumo_alto: 'Consumo alto',
  odometro_incoherente: 'Odómetro incoherente',
  obd_no_sube: 'El nivel (OBD) no subió',
};

/** L/100 km of each load against the previous one with odometer (needs both readings). */
export function fuelEfficiency(loads: Array<Pick<FuelLoad, 'id' | 'at' | 'liters' | 'odometerKm'>>): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...loads].filter((l) => typeof l.odometerKm === 'number').sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 1; i < sorted.length; i++) {
    const km = sorted[i].odometerKm! - sorted[i - 1].odometerKm!;
    if (km > 20) out.set(sorted[i].id, Math.round((sorted[i].liters / km) * 1000) / 10);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Anomalies of a new load against the unit's history: more liters than the tank, odometer going
 * back, consumption 30 % above the unit's usual (with at least 3 previous measurements) and, when
 * there's OBD data, a fuel level that didn't rise as much as the liters loaded.
 */
export function fuelAnomalies(
  load: Pick<FuelLoad, 'id' | 'at' | 'liters' | 'odometerKm'>,
  history: Array<Pick<FuelLoad, 'id' | 'at' | 'liters' | 'odometerKm'>>,
  vehicle: { tankLiters?: number },
  obd?: { before: number; after: number } | null
): FuelFlag[] {
  const flags: FuelFlag[] = [];
  if (vehicle.tankLiters && load.liters > vehicle.tankLiters * 1.05) {
    flags.push({ code: 'excede_tanque', message: `Se cargaron ${load.liters} L y el tanque es de ${vehicle.tankLiters} L.` });
  }
  const prev = [...history].filter((h) => h.id !== load.id && h.at < load.at && typeof h.odometerKm === 'number').sort((a, b) => b.at.localeCompare(a.at))[0];
  if (prev && typeof load.odometerKm === 'number' && load.odometerKm < prev.odometerKm!) {
    flags.push({ code: 'odometro_incoherente', message: `El odómetro (${load.odometerKm} km) es menor que en la carga anterior (${prev.odometerKm} km).` });
  }
  const all = fuelEfficiency([...history.filter((h) => h.id !== load.id), load]);
  const mine = all.get(load.id);
  const others = [...all.entries()].filter(([id]) => id !== load.id).map(([, v]) => v);
  if (mine !== undefined && others.length >= 3) {
    const usual = median(others);
    if (mine > usual * 1.3) flags.push({ code: 'consumo_alto', message: `Rendimiento ${mine} L/100 km contra ${Math.round(usual * 10) / 10} habitual.` });
  }
  if (obd && vehicle.tankLiters) {
    const expected = (load.liters / vehicle.tankLiters) * 100;
    const rose = obd.after - obd.before;
    if (expected >= 10 && rose < expected * 0.5) {
      flags.push({ code: 'obd_no_sube', message: `El nivel subió ${Math.round(rose)} % y con ${load.liters} L debería subir ~${Math.round(expected)} %.` });
    }
  }
  return flags;
}

// ---------------------------------------------------------------- import (fleet card statements)

/** "1.234,56" / "1234.56" / "1,234.56" → number. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (lastComma < 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "98.500": dots are thousands
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "23/11/2026 14:05", "2026-11-23T14:05", Excel dates → ISO. */
export function parseDateTime(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString() : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const ar = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ar) {
    const year = ar[3].length === 2 ? 2000 + Number(ar[3]) : Number(ar[3]);
    const d = new Date(year, Number(ar[2]) - 1, Number(ar[1]), Number(ar[4] ?? 12), Number(ar[5] ?? 0), Number(ar[6] ?? 0));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Column names used by fleet card statements (YPF Ruta, Shell Fleet, Axion…). */
const HEADERS: Record<'date' | 'plate' | 'liters' | 'total' | 'price' | 'odometer' | 'station', string[]> = {
  date: ['fecha', 'fechahora', 'fechadeconsumo', 'fechaconsumo', 'date'],
  plate: ['patente', 'dominio', 'vehiculo', 'unidad', 'plate'],
  liters: ['litros', 'cantidad', 'volumen', 'lts', 'liters'],
  total: ['importe', 'total', 'monto', 'importetotal', 'neto'],
  price: ['precio', 'preciounitario', 'preciolitro', 'ppu'],
  odometer: ['odometro', 'kilometraje', 'km', 'kms', 'odometer'],
  station: ['estacion', 'establecimiento', 'comercio', 'ubicacion', 'station'],
};

export interface FuelImportRow {
  line: number;
  at: string | null;
  plate: string;
  liters: number | null;
  total: number | null;
  pricePerLiter: number | null;
  odometerKm: number | null;
  station: string;
  error?: string;
}

/** Maps a statement's rows (header → value) to fuel loads; rows with problems carry `error`. */
export function parseFuelRows(rows: Array<Record<string, unknown>>): { rows: FuelImportRow[]; missingColumns: string[] } {
  const keys = Object.keys(rows[0] ?? {});
  const col = (k: keyof typeof HEADERS) => keys.find((h) => HEADERS[k].includes(fold(h)));
  const map = Object.fromEntries((Object.keys(HEADERS) as Array<keyof typeof HEADERS>).map((k) => [k, col(k)])) as Record<keyof typeof HEADERS, string | undefined>;
  const missingColumns = (['date', 'plate', 'liters'] as const).filter((k) => !map[k]).map((k) => ({ date: 'fecha', plate: 'patente', liters: 'litros' })[k]);
  if (!map.total && !map.price) missingColumns.push('importe o precio');
  const out = rows.map((r, i) => {
    const liters = map.liters ? parseAmount(r[map.liters]) : null;
    let total = map.total ? parseAmount(r[map.total]) : null;
    let price = map.price ? parseAmount(r[map.price]) : null;
    if (liters && total && !price) price = Math.round((total / liters) * 100) / 100;
    if (liters && price && !total) total = Math.round(liters * price * 100) / 100;
    const row: FuelImportRow = {
      line: i + 2,
      at: map.date ? parseDateTime(r[map.date]) : null,
      plate: map.plate ? String(r[map.plate] ?? '').trim().toUpperCase().replace(/\s+/g, '') : '',
      liters,
      total,
      pricePerLiter: price,
      odometerKm: map.odometer ? parseAmount(r[map.odometer]) : null,
      station: map.station ? String(r[map.station] ?? '').trim() : '',
    };
    if (!row.at) row.error = 'fecha inválida';
    else if (!row.plate) row.error = 'falta la patente';
    else if (!(row.liters && row.liters > 0 && row.liters < 5000)) row.error = 'litros inválidos';
    else if (!(row.total && row.total > 0)) row.error = 'importe inválido';
    return row;
  });
  return { rows: out, missingColumns };
}

// ---------------------------------------------------------------- trip expenses

export type ExpenseType = 'peaje' | 'comida' | 'alojamiento' | 'estacionamiento' | 'lavado' | 'otro';
export const EXPENSE_LABELS: Record<ExpenseType, string> = {
  peaje: 'Peaje',
  comida: 'Comida',
  alojamiento: 'Alojamiento',
  estacionamiento: 'Estacionamiento',
  lavado: 'Lavado',
  otro: 'Otro',
};

export interface TripExpense {
  id: string;
  tenantId: string;
  tripId: string;
  driverId: string;
  type: ExpenseType;
  amount: number;
  at: string;
  note?: string;
  /** chofer = paid by the driver (reimbursed in the settlement); empresa = paid by the company. */
  paidBy: 'chofer' | 'empresa';
  receiptFileId?: string;
  source: 'panel' | 'app';
  status: 'pendiente' | 'aprobado' | 'rechazado';
  reviewedBy?: string;
  reviewedAt?: string;
  rejectReason?: string;
  /** Driver settlement that paid it. */
  settlementId?: string;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------- trip cost

export interface TripCostInput {
  km: number;
  kmSource: 'odometro' | 'estimado';
  /** Fuel bought during the trip; when there is none, estimated from km × usual L/100 km × last price. */
  fuelLoadsTotal: number;
  fuelEstimate?: { litersPer100: number; pricePerLiter: number } | null;
  expenses: number;
  maintenancePerKm: number;
  driverHourlyCost: number;
  hours: number;
}

export interface TripCost {
  lines: ChargeLine[];
  total: number;
  km: number;
  kmSource: 'odometro' | 'estimado';
  fuelEstimated: boolean;
}

export function tripCost(i: TripCostInput): TripCost {
  const lines: ChargeLine[] = [];
  let fuelEstimated = false;
  if (i.fuelLoadsTotal > 0) lines.push({ label: 'Combustible (cargas del viaje)', amount: round2(i.fuelLoadsTotal) });
  else if (i.fuelEstimate && i.km > 0) {
    fuelEstimated = true;
    lines.push({
      label: `Combustible estimado (${i.km} km × ${i.fuelEstimate.litersPer100} L/100 km)`,
      amount: round2((i.km * i.fuelEstimate.litersPer100 * i.fuelEstimate.pricePerLiter) / 100),
    });
  }
  if (i.expenses > 0) lines.push({ label: 'Gastos del viaje', amount: round2(i.expenses) });
  if (i.maintenancePerKm > 0 && i.km > 0) lines.push({ label: `Mantenimiento (${i.km} km × ${round2(i.maintenancePerKm)})`, amount: round2(i.km * i.maintenancePerKm) });
  if (i.driverHourlyCost > 0 && i.hours > 0) lines.push({ label: `Chofer (${round2(i.hours)} h)`, amount: round2(i.hours * i.driverHourlyCost) });
  return { lines, total: round2(lines.reduce((a, l) => a + l.amount, 0)), km: i.km, kmSource: i.kmSource, fuelEstimated };
}

/** Hours a monthly salary is spread over (≈ 22 days × 8 h). */
export const MONTHLY_HOURS = 176;

// ---------------------------------------------------------------- billing

export interface PreInvoiceLine {
  orderId: string;
  date: string;
  description: string;
  reference?: string;
  amount: number;
}

export interface PreInvoice {
  id: string;
  tenantId: string;
  customerId: string;
  periodFrom: string;
  periodTo: string;
  lines: PreInvoiceLine[];
  total: number;
  currency: string | null;
  status: 'borrador' | 'emitida' | 'anulada';
  notes?: string;
  createdBy: string;
  createdAt: string;
  issuedAt?: string;
  voidReason?: string;
  /** ARCA invoice issued from this pre-invoice (T5). */
  invoiceId?: string;
}

export interface DriverSettlement {
  id: string;
  tenantId: string;
  driverId: string;
  periodFrom: string;
  periodTo: string;
  expenseIds: string[];
  total: number;
  currency: string | null;
  status: 'borrador' | 'pagada' | 'anulada';
  createdBy: string;
  createdAt: string;
  paidAt?: string;
  paidBy?: string;
}
