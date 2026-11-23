/**
 * TMS (transport management): customers, places, transport orders and trips.
 *
 * Pure types and rules shared by server and browser. The server (server/tms/service.ts) owns the
 * state; everything here is deterministic so it can be unit-tested without a database.
 */
import { distanceMeters } from './geo.ts';
import { computeDriverAuthorization } from './drivers.ts';
import type { OrderCharge } from './costs.ts';
import type { Driver, PreOpChecklist, Vehicle, WorkOrder } from './types.ts';

// ---------------------------------------------------------------- types

export interface CustomerContact {
  name: string;
  phone?: string;
  email?: string;
}

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  /** CUIT / RUT / RIF as typed (validated with src/shared/cuit.ts when it looks like a CUIT). */
  taxId: string;
  taxCondition?: string;
  contacts: CustomerContact[];
  notes?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PlaceKind = 'deposito' | 'planta' | 'cliente' | 'puerto' | 'otro';

export interface Place {
  id: string;
  tenantId: string;
  customerId?: string;
  name: string;
  kind: PlaceKind;
  address: string;
  lat: number;
  lng: number;
  /** Circular geofence radius used for automatic arrival / departure. */
  radiusM: number;
  /** Minutes to load / unload here (route planning and ETAs; 20 by default). */
  serviceMinutes?: number;
  openingHours?: string;
  notes?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TimeWindow {
  /** ISO date-time. */
  from: string;
  to: string;
}

export interface Cargo {
  description: string;
  weightKg?: number;
  volumeM3?: number;
  pallets?: number;
  dangerous?: boolean;
  refrigerated?: boolean;
}

export type OrderStatus = 'borrador' | 'confirmado' | 'planificado' | 'en_curso' | 'entregado' | 'cancelado';

export interface TransportOrder {
  id: string;
  tenantId: string;
  customerId: string;
  originPlaceId: string;
  destinationPlaceId: string;
  cargo: Cargo;
  pickupWindow?: TimeWindow;
  deliveryWindow?: TimeWindow;
  /** Customer's own reference (purchase order, shipment number). */
  reference?: string;
  notes?: string;
  status: OrderStatus;
  tripId?: string;
  /** Capability for the public tracking page (/seguimiento/<token>); read-only, minimal data. */
  trackingToken?: string;
  /** What the customer is charged (priced with the tariff on delivery, adjustable by hand). */
  charge?: OrderCharge;
  cancelReason?: string;
  deliveredAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type TripStatus = 'planificado' | 'en_curso' | 'finalizado' | 'cancelado';
export type StopKind = 'carga' | 'descarga' | 'paso';
export type StopStatus = 'pendiente' | 'en_lugar' | 'completada' | 'omitida';

export interface TripStop {
  id: string;
  seq: number;
  placeId: string;
  kind: StopKind;
  orderIds: string[];
  window?: TimeWindow;
  status: StopStatus;
  arrivedAt?: string;
  departedAt?: string;
  /** auto = geofence, manual = from the panel, app = the driver's app. */
  detection?: 'auto' | 'manual' | 'app';
  note?: string;
  /** Proof of delivery (unloading stops completed from the driver's app). */
  pod?: ProofOfDelivery;
  /** Set when the "late delivery" alert was raised (once per stop). */
  delayAlertedAt?: string;
  /** Estimated arrival (live while the trip is running). */
  eta?: string;
  /** Set when the "expected delay" alert was raised (once per stop). */
  etaLateAlertedAt?: string;
}

export interface ProofOfDelivery {
  receiverName: string;
  receiverDni: string;
  /** tms_files id of the signature (PNG). */
  signatureFileId: string;
  /** tms_files ids of optional photos (JPEG/PNG). */
  photoFileIds: string[];
  note?: string;
  /** Where the phone was when the delivery was signed (when it allowed geolocation). */
  lat?: number;
  lng?: number;
  accuracyM?: number;
  at: string;
  by: string;
}

export type DriverReportType = 'rechazo' | 'faltante' | 'averia' | 'demora' | 'acceso' | 'otro';

export const DRIVER_REPORT_TYPES: Record<DriverReportType, { label: string; priority: 'critica' | 'alta' | 'media' | 'informativa' }> = {
  averia: { label: 'Avería de la unidad', priority: 'alta' },
  rechazo: { label: 'Rechazo de mercadería', priority: 'alta' },
  faltante: { label: 'Faltante o daño de carga', priority: 'alta' },
  demora: { label: 'Demora en el lugar', priority: 'media' },
  acceso: { label: 'Problema de acceso al lugar', priority: 'media' },
  otro: { label: 'Otra novedad', priority: 'informativa' },
};

/** Personal link that opens the driver's app (only the hash of the token is stored). */
export interface DriverAppAccess {
  tokenHash: string;
  createdAt: string;
  createdBy: string;
  lastSeenAt?: string;
}

/** Public tracking page data: only what the receiver needs, never the driver's contact or other orders. */
export interface PublicTracking {
  orderId: string;
  reference?: string;
  carrier: string;
  status: OrderStatus;
  statusLabel: string;
  cargo: string;
  origin: { name: string };
  destination: { name: string; address: string; lat: number; lng: number; radiusM: number };
  deliveryWindow?: TimeWindow;
  /** Only while the trip is heading to this order's destination. */
  unit?: { lat: number; lng: number; at: string; distanceKm: number; etaMinutes: number };
  delivered?: { at: string; receiverName: string; hasProof: boolean };
  events: Array<{ at: string; label: string }>;
}

export const DNI_RE = /^\d{7,8}$/;

/** Rough ETA: straight line × 1.25 (roads) at 50 km/h. Shown as approximate. */
export function roughEtaMinutes(distanceM: number): number {
  return Math.max(1, Math.round(((distanceM * 1.25) / 1000 / 50) * 60));
}

export interface TripHistoryEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface Trip {
  id: string;
  tenantId: string;
  vehicleId: string;
  driverId: string;
  plannedStart: string;
  status: TripStatus;
  stops: TripStop[];
  startedAt?: string;
  finishedAt?: string;
  notes?: string;
  /** Warnings accepted at assignment time and why (audited). */
  overrides?: { warnings: string[]; reason: string; by: string; at: string };
  cancelReason?: string;
  /** Planned route (road km/minutes when OSRM is configured, estimate otherwise). */
  route?: { km: number; minutes: number; engine: 'osrm' | 'estimado'; computedAt: string };
  /** Last time the live ETAs were computed. */
  etaComputedAt?: string;
  /** Odometer at start and end (real km of the trip). */
  startOdometerKm?: number;
  endOdometerKm?: number;
  history: TripHistoryEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- labels

export const PLACE_KIND_LABELS: Record<PlaceKind, string> = {
  deposito: 'Depósito',
  planta: 'Planta',
  cliente: 'Cliente',
  puerto: 'Puerto',
  otro: 'Otro',
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  borrador: 'Borrador',
  confirmado: 'Confirmado',
  planificado: 'Planificado',
  en_curso: 'En curso',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  planificado: 'Planificado',
  en_curso: 'En curso',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};

export const STOP_KIND_LABELS: Record<StopKind, string> = { carga: 'Carga', descarga: 'Descarga', paso: 'Paso' };

export const STOP_STATUS_LABELS: Record<StopStatus, string> = {
  pendiente: 'Pendiente',
  en_lugar: 'En el lugar',
  completada: 'Completada',
  omitida: 'Omitida',
};

export const PLACE_RADIUS = { min: 50, max: 2000, default: 150 } as const;

// ---------------------------------------------------------------- stops

const minIso = (a?: string, b?: string) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a?: string, b?: string) => (!a ? b : !b ? a : a > b ? a : b);

/** Union of windows (earliest from, latest to). */
function mergeWindow(a: TimeWindow | undefined, b: TimeWindow | undefined): TimeWindow | undefined {
  if (!a) return b;
  if (!b) return a;
  return { from: minIso(a.from, b.from)!, to: maxIso(a.to, b.to)! };
}

/**
 * Builds the stops of a trip from its orders: one loading stop per origin and one unloading stop
 * per destination (orders sharing a place share the stop). Loadings first, each group sorted by
 * its window. `newId` makes ids deterministic in tests.
 */
export function buildStops(
  orders: Array<Pick<TransportOrder, 'id' | 'originPlaceId' | 'destinationPlaceId' | 'pickupWindow' | 'deliveryWindow'>>,
  newId: () => string
): TripStop[] {
  const group = (kind: StopKind) => {
    const byPlace = new Map<string, TripStop>();
    for (const o of orders) {
      const placeId = kind === 'carga' ? o.originPlaceId : o.destinationPlaceId;
      const window = kind === 'carga' ? o.pickupWindow : o.deliveryWindow;
      const existing = byPlace.get(placeId);
      if (existing) {
        existing.orderIds.push(o.id);
        existing.window = mergeWindow(existing.window, window);
      } else {
        byPlace.set(placeId, { id: newId(), seq: 0, placeId, kind, orderIds: [o.id], window, status: 'pendiente' });
      }
    }
    return [...byPlace.values()].sort((a, b) => (a.window?.from ?? '').localeCompare(b.window?.from ?? ''));
  };
  return [...group('carga'), ...group('descarga')].map((s, i) => ({ ...s, seq: i + 1 }));
}

/** First stop still to be done (pending or currently at it). */
export const currentStop = (trip: Pick<Trip, 'stops'>) =>
  trip.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');

// ---------------------------------------------------------------- geofence detection

/** Extra meters outside the radius before a departure counts (GPS jitter). */
export const EXIT_MARGIN_M = 30;
/** Minimum time inside before leaving counts as a real stop (drive-by otherwise). */
export const MIN_DWELL_MS = 2 * 60_000;
/** Positions older than this are ignored. */
export const STALE_POSITION_MS = 10 * 60_000;

export type StopTransition =
  | { type: 'arrived'; at: string; distanceM: number }
  | { type: 'departed'; at: string; distanceM: number }
  | { type: 'drive_by'; distanceM: number }
  | null;

/**
 * What happens to a stop given the unit's position. Pending + inside the radius → arrived.
 * At the place + beyond radius + margin → departed if it stayed MIN_DWELL_MS, otherwise it was a
 * drive-by (back to pending).
 */
export function evaluateStop(
  stop: Pick<TripStop, 'status' | 'arrivedAt'>,
  place: Pick<Place, 'lat' | 'lng' | 'radiusM'>,
  position: { lat: number; lng: number; at: string },
  now: Date
): StopTransition {
  if (now.getTime() - Date.parse(position.at) > STALE_POSITION_MS) return null;
  const d = distanceMeters(position, place);
  if (stop.status === 'pendiente') {
    return d <= place.radiusM ? { type: 'arrived', at: position.at, distanceM: d } : null;
  }
  if (stop.status === 'en_lugar' && d > place.radiusM + EXIT_MARGIN_M) {
    const dwell = Date.parse(position.at) - Date.parse(stop.arrivedAt ?? position.at);
    return dwell >= MIN_DWELL_MS ? { type: 'departed', at: position.at, distanceM: d } : { type: 'drive_by', distanceM: d };
  }
  return null;
}

/** An unloading stop whose window closed with no arrival (alert once). */
export const isStopLate = (stop: TripStop, now: Date) =>
  stop.kind === 'descarga' && stop.status === 'pendiente' && !stop.delayAlertedAt && Boolean(stop.window?.to) && Date.parse(stop.window!.to) < now.getTime();

// ---------------------------------------------------------------- assignment validation

export interface AssignmentIssue {
  code: string;
  message: string;
}

export interface AssignmentCheck {
  /** Can't be overridden. */
  blocks: AssignmentIssue[];
  /** Can be accepted with a reason. */
  warnings: AssignmentIssue[];
}

/** Planned time range of a trip: from the planned start to the latest window end (or +12 h). */
export function tripRange(plannedStart: string, orders: Array<Pick<TransportOrder, 'pickupWindow' | 'deliveryWindow'>>): { from: number; to: number } {
  const from = Date.parse(plannedStart);
  let to = from + 12 * 3600_000;
  for (const o of orders) {
    for (const w of [o.pickupWindow, o.deliveryWindow]) if (w?.to) to = Math.max(to, Date.parse(w.to));
  }
  return { from, to };
}

const OPEN_WO = new Set(['abierta', 'en_taller', 'esperando_refacciones']);

export interface AssignmentInput {
  vehicle: Vehicle;
  driver: Driver;
  orders: TransportOrder[];
  plannedStart: string;
  workOrders: WorkOrder[];
  checklists: PreOpChecklist[];
  /** Other trips (any status) of the same company, to detect overlaps. */
  trips: Array<Trip & { orders?: TransportOrder[] }>;
  /** Trip being edited (excluded from the overlap check). */
  tripId?: string;
  now?: Date;
}

/** Checks a unit + driver assignment for a set of orders. */
export function validateAssignment(input: AssignmentInput): AssignmentCheck {
  const { vehicle, driver, orders } = input;
  const blocks: AssignmentIssue[] = [];
  const warnings: AssignmentIssue[] = [];
  const now = input.now ?? new Date();

  // Driver.
  const auth = computeDriverAuthorization(driver, now);
  if (auth.state === 'no_autorizado' || auth.state === 'deshabilitado') {
    blocks.push({ code: 'driver_not_authorized', message: `${driver.name} no está autorizado para conducir: ${auth.reasons[0] ?? auth.state}.` });
  } else if (auth.state === 'pendiente') {
    blocks.push({ code: 'driver_pending', message: `${driver.name} tiene documentos pendientes de verificación.` });
  } else if (auth.state === 'por_vencer') {
    warnings.push({ code: 'driver_expiring', message: `${driver.name}: ${auth.reasons[0] ?? 'documentación por vencer'}.` });
  }
  if (orders.some((o) => o.cargo.dangerous)) {
    const hasClass = (driver.licenseClasses ?? []).includes('E.3');
    const hasDoc = (driver.documents ?? []).some((d) => d.type === 'cargas_peligrosas');
    if (!hasClass || !hasDoc) {
      blocks.push({
        code: 'dangerous_goods',
        message: `La carga es peligrosa y ${driver.name} no tiene ${!hasClass ? 'la clase E.3' : 'el curso de cargas peligrosas'} cargado.`,
      });
    }
  }

  // Vehicle.
  const criticalWo = input.workOrders.find((w) => w.vehicleId === vehicle.id && OPEN_WO.has(w.status) && w.priority === 'critica');
  if (criticalWo) blocks.push({ code: 'critical_work_order', message: `${vehicle.unitCode} tiene la OT crítica ${criticalWo.id} abierta.` });
  const lastChecklist = input.checklists
    .filter((c) => c.vehicleId === vehicle.id)
    .reduce<PreOpChecklist | null>((best, c) => (!best || c.submittedAt > best.submittedAt ? c : best), null);
  if (lastChecklist?.review?.decision === 'no_apto') {
    blocks.push({ code: 'checklist_not_fit', message: `El último checklist de ${vehicle.unitCode} (${lastChecklist.id}) fue revisado como «No apto».` });
  } else if (lastChecklist && !lastChecklist.review && lastChecklist.items.some((i) => i.status === 'falla')) {
    warnings.push({ code: 'checklist_unreviewed', message: `El último checklist de ${vehicle.unitCode} tiene fallas sin revisar.` });
  }
  if (vehicle.maintenanceStatus === 'vencido') warnings.push({ code: 'maintenance_overdue', message: `${vehicle.unitCode} tiene el servicio preventivo vencido.` });

  // Capacity.
  const sum = (k: 'weightKg' | 'volumeM3' | 'pallets') => orders.reduce((acc, o) => acc + (o.cargo[k] ?? 0), 0);
  const capChecks: Array<[number, number | undefined, string, string]> = [
    [sum('weightKg'), vehicle.capacityKg, 'kg', 'peso'],
    [sum('volumeM3'), vehicle.capacityM3, 'm³', 'volumen'],
    [sum('pallets'), vehicle.capacityPallets, 'pallets', 'pallets'],
  ];
  for (const [total, cap, unit, label] of capChecks) {
    if (total <= 0) continue;
    if (cap === undefined) warnings.push({ code: `capacity_unknown_${label}`, message: `${vehicle.unitCode} no tiene cargada su capacidad de ${label}.` });
    else if (total > cap) warnings.push({ code: `over_capacity_${label}`, message: `La carga (${total} ${unit}) supera la capacidad de ${vehicle.unitCode} (${cap} ${unit}).` });
  }
  if (orders.some((o) => o.cargo.refrigerated) && !vehicle.refrigerated) {
    warnings.push({ code: 'not_refrigerated', message: `La carga requiere frío y ${vehicle.unitCode} no figura como refrigerada.` });
  }

  // Overlaps with other trips of the same unit or driver.
  const range = tripRange(input.plannedStart, orders);
  for (const t of input.trips) {
    if (t.id === input.tripId || t.status === 'finalizado' || t.status === 'cancelado') continue;
    if (t.vehicleId !== vehicle.id && t.driverId !== driver.id) continue;
    const other = tripRange(t.plannedStart, t.orders ?? []);
    if (range.from < other.to && other.from < range.to) {
      const who = t.vehicleId === vehicle.id ? vehicle.unitCode : driver.name;
      blocks.push({ code: 'overlap', message: `${who} ya está asignado al viaje ${t.id} en ese horario.` });
    }
  }
  return { blocks, warnings };
}
