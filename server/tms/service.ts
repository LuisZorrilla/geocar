import crypto from 'crypto';
import zlib from 'zlib';
import type { AlertEvent, AuditLog, Driver, FleetStoreState, Incident, Vehicle } from '../../src/shared/types.ts';
import type { StateRepository } from '../db/stateRepository.ts';
import { hashToken } from '../auth/password.ts';
import type { DeliveryNoteInput } from './documents.ts';
import { foldText } from '../../src/shared/drivers.ts';
import { CUIT_MESSAGES, cuitProblem, taxIdKey } from '../../src/shared/cuit.ts';
import { distanceMeters, isValidLatLng } from '../../src/shared/geo.ts';
import {
  buildStops,
  currentStop,
  DNI_RE,
  DRIVER_REPORT_TYPES,
  roughEtaMinutes,
  type DriverReportType,
  type ProofOfDelivery,
  type PublicTracking,
  evaluateStop,
  isStopLate,
  ORDER_STATUS_LABELS,
  PLACE_RADIUS,
  STOP_KIND_LABELS,
  STOP_STATUS_LABELS,
  TRIP_STATUS_LABELS,
  validateAssignment,
  type AssignmentCheck,
  type Cargo,
  type Customer,
  type CustomerContact,
  type OrderStatus,
  type Place,
  type PlaceKind,
  type TimeWindow,
  type TransportOrder,
  type Trip,
  type TripStatus,
  type TripStop,
} from '../../src/shared/tms.ts';

export class TmsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Extra payload for the client (e.g. the assignment check that blocked a trip). */
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface TmsActor {
  name: string;
  role: string;
  hidden?: boolean;
  /** Superadmin / company admin / "operaciones: full": may accept assignment warnings. */
  canOverride: boolean;
}

export type TmsScope = { tenantId: string } | { all: true };

interface Ctx {
  state: FleetStoreState;
  repo: StateRepository;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
  /** An order was delivered (T3 prices it). */
  onOrderDelivered?: (order: TransportOrder) => void;
}

/** Max size of a proof-of-delivery photo or signature. */
export const POD_FILE_MAX_BYTES = 3 * 1024 * 1024;
/**
 * A PNG that actually decodes: chunks in place, IDAT inflates to the size the header announces.
 * (A truncated or forged PNG can hang the PDF library, so it never gets stored.)
 */
export function isDecodablePng(b: Buffer): boolean {
  try {
    if (b.length < 45 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return false;
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat: Buffer[] = [];
    let ended = false;
    while (off + 8 <= b.length) {
      const len = b.readUInt32BE(off);
      const type = b.toString('latin1', off + 4, off + 8);
      if (off + 12 + len > b.length) return false;
      const data = b.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') {
        ended = true;
        break;
      }
      off += 12 + len;
    }
    if (!ended || !width || !height || width * height > 25_000_000 || idat.length === 0) return false;
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) return false;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (interlace) return raw.length > 0;
    return raw.length === height * (1 + Math.ceil((width * channels * bitDepth) / 8));
  } catch {
    return false;
  }
}

const POD_MIMES: Record<string, (b: Buffer) => boolean> = {
  'image/png': isDecodablePng,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
/** 32 random bytes, URL-safe: unguessable capability for links. */
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;

export interface CustomerInput {
  name: string;
  taxId: string;
  taxCondition?: string;
  contacts?: CustomerContact[];
  notes?: string;
  active?: boolean;
}

export interface PlaceInput {
  customerId?: string | null;
  name: string;
  kind: PlaceKind;
  address: string;
  lat: number;
  lng: number;
  radiusM?: number;
  serviceMinutes?: number | null;
  openingHours?: string;
  notes?: string;
  active?: boolean;
}

export interface OrderInput {
  customerId: string;
  originPlaceId: string;
  destinationPlaceId: string;
  cargo: Cargo;
  pickupWindow?: TimeWindow;
  deliveryWindow?: TimeWindow;
  reference?: string;
  notes?: string;
  confirm?: boolean;
}

export interface TripInput {
  vehicleId: string;
  driverId: string;
  plannedStart: string;
  orderIds: string[];
  notes?: string;
  /** Accept the warnings of the assignment check (needs actor.canOverride). */
  acceptWarnings?: { reason: string };
}

export interface TripPatch {
  vehicleId?: string;
  driverId?: string;
  plannedStart?: string;
  notes?: string;
  /** New order of the stops (all stop ids). */
  stopOrder?: string[];
  acceptWarnings?: { reason: string };
}

/** Trip with the names the UI needs (computed, never stored). */
export interface TripView extends Trip {
  unitCode: string;
  plate: string;
  driverName: string;
  tenantName?: string;
  stops: Array<TripStop & { placeName: string; address: string; lat: number; lng: number; radiusM: number }>;
  orders: Array<Pick<TransportOrder, 'id' | 'status' | 'reference' | 'cargo'> & { customerName: string }>;
  /** Some unloading stop is past its window without arrival. */
  late: boolean;
  /** Distance from the unit to the current stop, when known. */
  nextStopDistanceM?: number;
}

export interface OrderView extends TransportOrder {
  customerName: string;
  originName: string;
  destinationName: string;
  tenantName?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function paginate<T>(items: T[], page = 1, pageSize = 25): Page<T> {
  const size = Math.min(100, Math.max(1, pageSize));
  const p = Math.max(1, page);
  return { items: items.slice((p - 1) * size, p * size), total: items.length, page: p, pageSize: size };
}

function checkWindow(w: TimeWindow | undefined, label: string) {
  if (!w) return;
  if (!(Date.parse(w.from) <= Date.parse(w.to))) throw new TmsError(`La ventana de ${label} termina antes de empezar.`);
}

/**
 * TMS: customers, places, transport orders and trips, plus automatic stop tracking by geofence.
 * Shares the store's state and persistence (same pattern as DriverRegistry and CurrencyService).
 */
export class TmsService {
  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }

  private audit(tenantId: string, actor: TmsActor, action: string, targetLabel: string, detail: string) {
    this.ctx().audit({ tenantId, actorName: actor.name, actorRole: actor.role, actorHidden: actor.hidden, module: 'Operaciones', action, targetLabel, detail });
  }

  private tenantName(id: string) {
    return this.state.tenants.find((t) => t.id === id)?.name;
  }

  /** Short company code for folios: "TLN" from unit codes like TLN-101, else from the name. */
  private tenantCode(tenantId: string): string {
    const unit = this.state.vehicles.find((v) => v.tenantId === tenantId)?.unitCode;
    const fromUnit = unit?.split('-')[0];
    if (fromUnit && /^[A-Z0-9]{2,5}$/.test(fromUnit)) return fromUnit;
    const name = this.tenantName(tenantId) ?? tenantId;
    return (foldText(name).replace(/[^a-z]/g, '').slice(0, 3) || 'EMP').toUpperCase();
  }

  private nextFolio(prefix: 'PED' | 'VJ', tenantId: string, existing: Array<{ id: string; tenantId: string }>): string {
    const code = this.tenantCode(tenantId);
    const head = `${prefix}-${code}-`;
    let max = 0;
    for (const e of existing) if (e.tenantId === tenantId && e.id.startsWith(head)) max = Math.max(max, Number(e.id.slice(head.length)) || 0);
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  // ---------------------------------------------------------------- customers

  listCustomers(scope: TmsScope, q = '', includeInactive = true): Customer[] {
    const needle = foldText(q);
    return this.state.customers
      .filter((c) => inScope(scope, c.tenantId) && (includeInactive || c.active))
      .filter((c) => !needle || foldText(`${c.name} ${c.taxId}`).includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private findCustomer(scope: TmsScope, id: string): Customer {
    const c = this.state.customers.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!c) throw new TmsError('Cliente no encontrado.', 404);
    return c;
  }

  private validateCustomer(tenantId: string, input: CustomerInput, selfId?: string) {
    const digits = input.taxId.replace(/\D/g, '');
    // CUIT (11 digits): check digit. Other formats (RUT, RIF) are kept as typed.
    if (digits.length === 11 && /^\d{2}-?\d{8}-?\d$/.test(input.taxId.trim())) {
      const problem = cuitProblem(input.taxId);
      if (problem) throw new TmsError(CUIT_MESSAGES[problem]);
    }
    const key = taxIdKey(input.taxId);
    const dup = this.state.customers.find((c) => c.tenantId === tenantId && c.id !== selfId && key && taxIdKey(c.taxId) === key);
    if (dup) throw new TmsError(`Ya existe el cliente «${dup.name}» con esa identificación fiscal.`, 409);
  }

  createCustomer(tenantId: string, input: CustomerInput, actor: TmsActor): Customer {
    this.validateCustomer(tenantId, input);
    const at = nowIso();
    const customer: Customer = {
      id: `cli-${uid()}`,
      tenantId,
      name: input.name.trim(),
      taxId: input.taxId.trim(),
      taxCondition: input.taxCondition?.trim() || undefined,
      contacts: (input.contacts ?? []).filter((c) => c.name.trim()),
      notes: input.notes?.trim() || undefined,
      active: input.active ?? true,
      createdAt: at,
      updatedAt: at,
    };
    this.state.customers.push(customer);
    this.audit(tenantId, actor, 'Alta de cliente', customer.name, `CUIT/ID ${customer.taxId}.`);
    this.ctx().persist();
    return customer;
  }

  updateCustomer(scope: TmsScope, id: string, patch: Partial<CustomerInput>, actor: TmsActor): Customer {
    const c = this.findCustomer(scope, id);
    const merged = { name: patch.name ?? c.name, taxId: patch.taxId ?? c.taxId };
    this.validateCustomer(c.tenantId, { ...c, ...patch, ...merged }, c.id);
    Object.assign(c, {
      name: merged.name.trim(),
      taxId: merged.taxId.trim(),
      taxCondition: patch.taxCondition !== undefined ? patch.taxCondition.trim() || undefined : c.taxCondition,
      contacts: patch.contacts ? patch.contacts.filter((x) => x.name.trim()) : c.contacts,
      notes: patch.notes !== undefined ? patch.notes.trim() || undefined : c.notes,
      active: patch.active ?? c.active,
      updatedAt: nowIso(),
    });
    this.audit(c.tenantId, actor, 'Edición de cliente', c.name, `Campos: ${Object.keys(patch).join(', ')}.`);
    this.ctx().persist();
    return c;
  }

  // ---------------------------------------------------------------- places

  listPlaces(scope: TmsScope, q = '', includeInactive = true): Array<Place & { customerName?: string }> {
    const needle = foldText(q);
    return this.state.places
      .filter((p) => inScope(scope, p.tenantId) && (includeInactive || p.active))
      .filter((p) => !needle || foldText(`${p.name} ${p.address}`).includes(needle))
      .map((p) => ({ ...p, customerName: p.customerId ? this.state.customers.find((c) => c.id === p.customerId)?.name : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private findPlace(scope: TmsScope, id: string): Place {
    const p = this.state.places.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!p) throw new TmsError('Lugar no encontrado.', 404);
    return p;
  }

  private placeInput(tenantId: string, input: PlaceInput) {
    if (!isValidLatLng(input.lat, input.lng)) throw new TmsError('Elegí la ubicación del lugar en el mapa (latitud/longitud válidas).');
    const radius = Math.round(input.radiusM ?? PLACE_RADIUS.default);
    if (radius < PLACE_RADIUS.min || radius > PLACE_RADIUS.max) {
      throw new TmsError(`El radio de la geocerca debe estar entre ${PLACE_RADIUS.min} y ${PLACE_RADIUS.max} m.`);
    }
    if (input.customerId) this.findCustomer({ tenantId }, input.customerId);
    return radius;
  }

  createPlace(tenantId: string, input: PlaceInput, actor: TmsActor): Place {
    const radiusM = this.placeInput(tenantId, input);
    const at = nowIso();
    const place: Place = {
      id: `lug-${uid()}`,
      tenantId,
      customerId: input.customerId || undefined,
      name: input.name.trim(),
      kind: input.kind,
      address: input.address.trim(),
      lat: Number(input.lat.toFixed(6)),
      lng: Number(input.lng.toFixed(6)),
      radiusM,
      serviceMinutes: input.serviceMinutes ?? undefined,
      openingHours: input.openingHours?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      active: input.active ?? true,
      createdAt: at,
      updatedAt: at,
    };
    this.state.places.push(place);
    this.audit(tenantId, actor, 'Alta de lugar', place.name, `${place.address} · geocerca ${radiusM} m.`);
    this.ctx().persist();
    return place;
  }

  updatePlace(scope: TmsScope, id: string, patch: Partial<PlaceInput>, actor: TmsActor): Place {
    const p = this.findPlace(scope, id);
    const merged: PlaceInput = { ...p, ...patch, customerId: patch.customerId === undefined ? p.customerId : patch.customerId };
    const radiusM = this.placeInput(p.tenantId, merged);
    if (patch.active === false && p.active) {
      const busy = this.state.trips.find(
        (t) => t.tenantId === p.tenantId && (t.status === 'planificado' || t.status === 'en_curso') && t.stops.some((s) => s.placeId === p.id)
      );
      if (busy) throw new TmsError(`No se puede desactivar: el viaje ${busy.id} lo usa.`, 409);
    }
    Object.assign(p, {
      customerId: merged.customerId || undefined,
      name: merged.name.trim(),
      kind: merged.kind,
      address: merged.address.trim(),
      lat: Number(merged.lat.toFixed(6)),
      lng: Number(merged.lng.toFixed(6)),
      radiusM,
      serviceMinutes: merged.serviceMinutes ?? undefined,
      openingHours: merged.openingHours?.trim() || undefined,
      notes: merged.notes?.trim() || undefined,
      active: merged.active ?? true,
      updatedAt: nowIso(),
    });
    this.audit(p.tenantId, actor, 'Edición de lugar', p.name, `Campos: ${Object.keys(patch).join(', ')}.`);
    this.ctx().persist();
    return p;
  }

  // ---------------------------------------------------------------- orders

  private orderView(o: TransportOrder, withTenant: boolean): OrderView {
    const name = (id: string) => this.state.places.find((p) => p.id === id)?.name ?? '—';
    return {
      ...o,
      customerName: this.state.customers.find((c) => c.id === o.customerId)?.name ?? '—',
      originName: name(o.originPlaceId),
      destinationName: name(o.destinationPlaceId),
      tenantName: withTenant ? this.tenantName(o.tenantId) : undefined,
    };
  }

  listOrders(
    scope: TmsScope,
    f: { status?: OrderStatus | 'activos'; customerId?: string; q?: string; page?: number; pageSize?: number } = {}
  ): Page<OrderView> & { counts: Record<OrderStatus, number> } {
    const all = this.state.transportOrders.filter((o) => inScope(scope, o.tenantId));
    const counts = Object.fromEntries(Object.keys(ORDER_STATUS_LABELS).map((k) => [k, 0])) as Record<OrderStatus, number>;
    for (const o of all) counts[o.status] += 1;
    const needle = foldText(f.q ?? '');
    const views = all
      .filter((o) =>
        !f.status ? true : f.status === 'activos' ? o.status !== 'entregado' && o.status !== 'cancelado' : o.status === f.status
      )
      .filter((o) => !f.customerId || o.customerId === f.customerId)
      .map((o) => this.orderView(o, 'all' in scope))
      .filter((o) => !needle || foldText(`${o.id} ${o.reference ?? ''} ${o.customerName} ${o.originName} ${o.destinationName} ${o.cargo.description}`).includes(needle))
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    return { ...paginate(views, f.page, f.pageSize), counts };
  }

  private findOrder(scope: TmsScope, id: string): TransportOrder {
    const o = this.state.transportOrders.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!o) throw new TmsError('Pedido no encontrado.', 404);
    return o;
  }

  private checkOrder(tenantId: string, input: Omit<OrderInput, 'confirm'>) {
    const customer = this.findCustomer({ tenantId }, input.customerId);
    if (!customer.active) throw new TmsError(`El cliente «${customer.name}» está inactivo.`);
    for (const id of [input.originPlaceId, input.destinationPlaceId]) {
      const place = this.findPlace({ tenantId }, id);
      if (!place.active) throw new TmsError(`El lugar «${place.name}» está inactivo.`);
    }
    if (input.originPlaceId === input.destinationPlaceId) throw new TmsError('El origen y el destino deben ser lugares distintos.');
    checkWindow(input.pickupWindow, 'carga');
    checkWindow(input.deliveryWindow, 'entrega');
    if (input.pickupWindow && input.deliveryWindow && Date.parse(input.deliveryWindow.to) < Date.parse(input.pickupWindow.from)) {
      throw new TmsError('La entrega no puede terminar antes de que empiece la carga.');
    }
  }

  createOrder(tenantId: string, input: OrderInput, actor: TmsActor): OrderView {
    this.checkOrder(tenantId, input);
    const at = nowIso();
    const order: TransportOrder = {
      id: this.nextFolio('PED', tenantId, this.state.transportOrders),
      tenantId,
      customerId: input.customerId,
      originPlaceId: input.originPlaceId,
      destinationPlaceId: input.destinationPlaceId,
      cargo: { ...input.cargo, description: input.cargo.description.trim() },
      pickupWindow: input.pickupWindow,
      deliveryWindow: input.deliveryWindow,
      reference: input.reference?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      status: input.confirm ? 'confirmado' : 'borrador',
      trackingToken: newSecret(),
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    this.state.transportOrders.push(order);
    this.audit(tenantId, actor, 'Alta de pedido', order.id, `${ORDER_STATUS_LABELS[order.status]} · ${order.cargo.description}.`);
    this.ctx().persist();
    return this.orderView(order, false);
  }

  updateOrder(scope: TmsScope, id: string, patch: Partial<Omit<OrderInput, 'confirm'>>, actor: TmsActor): OrderView {
    const o = this.findOrder(scope, id);
    if (o.status !== 'borrador' && o.status !== 'confirmado') {
      throw new TmsError(`El pedido está ${ORDER_STATUS_LABELS[o.status].toLowerCase()}: ya no se puede editar.`, 409);
    }
    const merged = { ...o, ...patch, cargo: patch.cargo ? { ...patch.cargo, description: patch.cargo.description.trim() } : o.cargo };
    this.checkOrder(o.tenantId, merged);
    Object.assign(o, {
      customerId: merged.customerId,
      originPlaceId: merged.originPlaceId,
      destinationPlaceId: merged.destinationPlaceId,
      cargo: merged.cargo,
      pickupWindow: merged.pickupWindow,
      deliveryWindow: merged.deliveryWindow,
      reference: merged.reference?.trim() || undefined,
      notes: merged.notes?.trim() || undefined,
      updatedAt: nowIso(),
    });
    this.audit(o.tenantId, actor, 'Edición de pedido', o.id, `Campos: ${Object.keys(patch).join(', ')}.`);
    this.ctx().persist();
    return this.orderView(o, false);
  }

  confirmOrder(scope: TmsScope, id: string, actor: TmsActor): OrderView {
    const o = this.findOrder(scope, id);
    if (o.status !== 'borrador') throw new TmsError('Solo se confirma un pedido en borrador.', 409);
    o.status = 'confirmado';
    o.updatedAt = nowIso();
    this.audit(o.tenantId, actor, 'Pedido confirmado', o.id, 'Queda listo para planificar.');
    this.ctx().persist();
    return this.orderView(o, false);
  }

  /** Cancels an order. If it was in a planned trip it leaves it (an empty trip is cancelled too). */
  cancelOrder(scope: TmsScope, id: string, reason: string, actor: TmsActor): OrderView {
    const o = this.findOrder(scope, id);
    if (o.status === 'entregado' || o.status === 'cancelado') throw new TmsError(`El pedido ya está ${ORDER_STATUS_LABELS[o.status].toLowerCase()}.`, 409);
    if (o.status === 'en_curso') throw new TmsError('El pedido está en un viaje en curso: omití su parada o cancelá el viaje.', 409);
    if (o.tripId) {
      const trip = this.state.trips.find((t) => t.id === o.tripId);
      if (trip) {
        trip.stops = trip.stops
          .map((s) => ({ ...s, orderIds: s.orderIds.filter((x) => x !== o.id) }))
          .filter((s) => s.orderIds.length > 0)
          .map((s, i) => ({ ...s, seq: i + 1 }));
        this.addHistory(trip, actor.name, 'Pedido quitado', `${o.id} cancelado: ${reason}.`);
        if (trip.stops.length === 0) {
          trip.status = 'cancelado';
          trip.cancelReason = 'Se cancelaron todos sus pedidos.';
          this.addHistory(trip, actor.name, 'Viaje cancelado', trip.cancelReason);
        }
      }
    }
    o.status = 'cancelado';
    o.cancelReason = reason.trim();
    o.tripId = undefined;
    o.updatedAt = nowIso();
    this.audit(o.tenantId, actor, 'Pedido cancelado', o.id, reason.trim());
    this.ctx().persist();
    return this.orderView(o, false);
  }

  // ---------------------------------------------------------------- trips

  private addHistory(trip: Trip, actor: string, action: string, detail: string) {
    trip.history = [{ at: nowIso(), actor, action, detail }, ...(trip.history ?? [])].slice(0, 100);
    trip.updatedAt = nowIso();
  }

  private ordersOf(trip: Pick<Trip, 'stops'>): TransportOrder[] {
    const ids = new Set(trip.stops.flatMap((s) => s.orderIds));
    return this.state.transportOrders.filter((o) => ids.has(o.id));
  }

  tripView(t: Trip, withTenant = false): TripView {
    const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
    const d = this.state.drivers.find((x) => x.id === t.driverId);
    const now = new Date();
    const stops = t.stops.map((s) => {
      const p = this.state.places.find((x) => x.id === s.placeId);
      return { ...s, placeName: p?.name ?? '—', address: p?.address ?? '', lat: p?.lat ?? 0, lng: p?.lng ?? 0, radiusM: p?.radiusM ?? 0 };
    });
    const cur = currentStop(t);
    const curPlace = cur ? stops.find((s) => s.id === cur.id) : undefined;
    return {
      ...t,
      unitCode: v?.unitCode ?? '—',
      plate: v?.plate ?? '',
      driverName: d?.name ?? '—',
      tenantName: withTenant ? this.tenantName(t.tenantId) : undefined,
      stops,
      orders: this.ordersOf(t).map((o) => ({
        id: o.id,
        status: o.status,
        reference: o.reference,
        cargo: o.cargo,
        customerName: this.state.customers.find((c) => c.id === o.customerId)?.name ?? '—',
      })),
      late:
        (t.status === 'planificado' || t.status === 'en_curso') &&
        t.stops.some((s) => s.kind === 'descarga' && s.status === 'pendiente' && s.window?.to && Date.parse(s.window.to) < now.getTime()),
      nextStopDistanceM:
        v && curPlace && (t.status === 'en_curso' || t.status === 'planificado') ? Math.round(distanceMeters(v, curPlace)) : undefined,
    };
  }

  listTrips(
    scope: TmsScope,
    f: { status?: TripStatus | 'activos'; vehicleId?: string; q?: string; page?: number; pageSize?: number } = {}
  ): Page<TripView> & { counts: { en_curso: number; planificado: number; atrasados: number; finalizadosHoy: number } } {
    const all = this.state.trips.filter((t) => inScope(scope, t.tenantId));
    const views = all.map((t) => this.tripView(t, 'all' in scope));
    const today = new Date().toISOString().slice(0, 10);
    const counts = {
      en_curso: views.filter((t) => t.status === 'en_curso').length,
      planificado: views.filter((t) => t.status === 'planificado').length,
      atrasados: views.filter((t) => t.late).length,
      finalizadosHoy: views.filter((t) => t.status === 'finalizado' && t.finishedAt?.slice(0, 10) === today).length,
    };
    const needle = foldText(f.q ?? '');
    const rank: Record<TripStatus, number> = { en_curso: 0, planificado: 1, finalizado: 2, cancelado: 3 };
    const items = views
      .filter((t) => (!f.status ? true : f.status === 'activos' ? t.status === 'planificado' || t.status === 'en_curso' : t.status === f.status))
      .filter((t) => !f.vehicleId || t.vehicleId === f.vehicleId)
      .filter((t) => !needle || foldText(`${t.id} ${t.unitCode} ${t.plate} ${t.driverName} ${t.stops.map((s) => s.placeName).join(' ')}`).includes(needle))
      .sort((a, b) => rank[a.status] - rank[b.status] || a.plannedStart.localeCompare(b.plannedStart));
    return { ...paginate(items, f.page, f.pageSize), counts };
  }

  getTrip(scope: TmsScope, id: string): TripView {
    return this.tripView(this.findTrip(scope, id), 'all' in scope);
  }

  private findTrip(scope: TmsScope, id: string): Trip {
    const t = this.state.trips.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!t) throw new TmsError('Viaje no encontrado.', 404);
    return t;
  }

  /** Active trip of each unit (for the unit sheet and the live map). */
  activeTripsByVehicle(scope: TmsScope): Record<string, { tripId: string; status: TripStatus; nextStop?: string }> {
    const out: Record<string, { tripId: string; status: TripStatus; nextStop?: string }> = {};
    const active = this.state.trips
      .filter((t) => inScope(scope, t.tenantId) && (t.status === 'en_curso' || t.status === 'planificado'))
      .sort((a, b) => (a.status === 'en_curso' ? -1 : 1) - (b.status === 'en_curso' ? -1 : 1) || a.plannedStart.localeCompare(b.plannedStart));
    for (const t of active) {
      if (out[t.vehicleId]) continue;
      const cur = currentStop(t);
      out[t.vehicleId] = {
        tripId: t.id,
        status: t.status,
        nextStop: cur ? this.state.places.find((p) => p.id === cur.placeId)?.name : undefined,
      };
    }
    return out;
  }

  /** Assignment check for a unit + driver + orders (used live by the trip form). */
  validate(tenantId: string, input: Pick<TripInput, 'vehicleId' | 'driverId' | 'plannedStart' | 'orderIds'>, tripId?: string): AssignmentCheck {
    const vehicle = this.state.vehicles.find((v) => v.id === input.vehicleId && v.tenantId === tenantId);
    if (!vehicle) throw new TmsError('Unidad no encontrada en la empresa.', 404);
    const driver = this.state.drivers.find((d) => d.id === input.driverId && d.tenantId === tenantId);
    if (!driver) throw new TmsError('Chofer no encontrado en la empresa.', 404);
    const orders = input.orderIds.map((id) => this.findOrder({ tenantId }, id));
    return validateAssignment({
      vehicle,
      driver,
      orders,
      plannedStart: input.plannedStart,
      workOrders: this.state.workOrders.filter((w) => w.tenantId === tenantId),
      checklists: this.state.checklists.filter((c) => c.tenantId === tenantId),
      trips: this.state.trips.filter((t) => t.tenantId === tenantId).map((t) => ({ ...t, orders: this.ordersOf(t) })),
      tripId,
    });
  }

  /** Blocks always stop; warnings need an explicit, reasoned acceptance by an authorized actor. */
  private enforce(check: AssignmentCheck, accept: TripInput['acceptWarnings'], actor: TmsActor) {
    if (check.blocks.length) throw new TmsError(check.blocks[0].message, 409, { check });
    if (check.warnings.length) {
      if (!accept) throw new TmsError('La asignación tiene advertencias: revisalas y aceptalas con un motivo.', 409, { check, needsOverride: true });
      if (!actor.canOverride) throw new TmsError('Tu perfil no puede aceptar advertencias de asignación.', 403, { check });
      if (!accept.reason.trim()) throw new TmsError('Indicá el motivo para aceptar las advertencias.', 400, { check });
    }
  }

  createTrip(tenantId: string, input: TripInput, actor: TmsActor): TripView {
    if (input.orderIds.length === 0) throw new TmsError('Elegí al menos un pedido.');
    const orders = input.orderIds.map((id) => this.findOrder({ tenantId }, id));
    const notReady = orders.find((o) => o.status !== 'confirmado');
    if (notReady) throw new TmsError(`El pedido ${notReady.id} está ${ORDER_STATUS_LABELS[notReady.status].toLowerCase()}: solo se planifican pedidos confirmados.`, 409);
    if (!Number.isFinite(Date.parse(input.plannedStart))) throw new TmsError('Fecha de salida inválida.');
    const check = this.validate(tenantId, input);
    this.enforce(check, input.acceptWarnings, actor);

    const at = nowIso();
    const trip: Trip = {
      id: this.nextFolio('VJ', tenantId, this.state.trips),
      tenantId,
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      plannedStart: new Date(input.plannedStart).toISOString(),
      status: 'planificado',
      stops: buildStops(orders, () => `stp-${uid()}`),
      notes: input.notes?.trim() || undefined,
      overrides: check.warnings.length
        ? { warnings: check.warnings.map((w) => w.message), reason: input.acceptWarnings!.reason.trim(), by: actor.name, at }
        : undefined,
      history: [],
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    for (const o of orders) {
      o.status = 'planificado';
      o.tripId = trip.id;
      o.updatedAt = at;
    }
    const v = this.state.vehicles.find((x) => x.id === trip.vehicleId)!;
    const d = this.state.drivers.find((x) => x.id === trip.driverId)!;
    this.addHistory(trip, actor.name, 'Viaje planificado', `${v.unitCode} · ${d.name} · ${orders.length} pedido(s), ${trip.stops.length} parada(s).`);
    if (trip.overrides) this.addHistory(trip, actor.name, 'Advertencias aceptadas', `${trip.overrides.warnings.join(' ')} Motivo: ${trip.overrides.reason}.`);
    this.state.trips.push(trip);
    this.audit(
      tenantId,
      actor,
      'Viaje planificado',
      trip.id,
      `${v.unitCode} · ${d.name} · ${orders.map((o) => o.id).join(', ')}${trip.overrides ? ` · Aceptó advertencias: ${trip.overrides.reason}` : ''}.`
    );
    this.ctx().persist();
    return this.tripView(trip);
  }

  updateTrip(scope: TmsScope, id: string, patch: TripPatch, actor: TmsActor): TripView {
    const t = this.findTrip(scope, id);
    if (t.status !== 'planificado') throw new TmsError('Solo se edita un viaje planificado.', 409);
    const changes: string[] = [];
    if (patch.vehicleId || patch.driverId || patch.plannedStart) {
      const next = {
        vehicleId: patch.vehicleId ?? t.vehicleId,
        driverId: patch.driverId ?? t.driverId,
        plannedStart: patch.plannedStart ?? t.plannedStart,
        orderIds: this.ordersOf(t).map((o) => o.id),
      };
      const check = this.validate(t.tenantId, next, t.id);
      this.enforce(check, patch.acceptWarnings, actor);
      if (next.vehicleId !== t.vehicleId) changes.push('unidad');
      if (next.driverId !== t.driverId) changes.push('chofer');
      if (next.plannedStart !== t.plannedStart) changes.push('salida');
      t.vehicleId = next.vehicleId;
      t.driverId = next.driverId;
      t.plannedStart = new Date(next.plannedStart).toISOString();
      if (check.warnings.length) {
        t.overrides = { warnings: check.warnings.map((w) => w.message), reason: patch.acceptWarnings!.reason.trim(), by: actor.name, at: nowIso() };
      }
    }
    if (patch.stopOrder) {
      const byId = new Map(t.stops.map((s) => [s.id, s]));
      if (patch.stopOrder.length !== t.stops.length || patch.stopOrder.some((sid) => !byId.has(sid))) {
        throw new TmsError('El orden de paradas debe incluir todas las paradas del viaje.');
      }
      const reordered = patch.stopOrder.map((sid, i) => ({ ...byId.get(sid)!, seq: i + 1 }));
      // Every order must be loaded before it is unloaded.
      for (const o of this.ordersOf(t)) {
        const load = reordered.findIndex((s) => s.kind === 'carga' && s.orderIds.includes(o.id));
        const unload = reordered.findIndex((s) => s.kind === 'descarga' && s.orderIds.includes(o.id));
        if (load > unload) throw new TmsError(`El pedido ${o.id} se descargaría antes de cargarse.`);
      }
      t.stops = reordered;
      changes.push('orden de paradas');
    }
    if (patch.notes !== undefined) {
      t.notes = patch.notes.trim() || undefined;
      changes.push('notas');
    }
    if (changes.length) {
      this.addHistory(t, actor.name, 'Viaje editado', `Cambios: ${changes.join(', ')}.`);
      this.audit(t.tenantId, actor, 'Edición de viaje', t.id, `Cambios: ${changes.join(', ')}.`);
      this.ctx().persist();
    }
    return this.tripView(t);
  }

  private begin(t: Trip, actorName: string, detail: string) {
    t.status = 'en_curso';
    t.startedAt = nowIso();
    t.startOdometerKm = this.state.vehicles.find((v) => v.id === t.vehicleId)?.odometerKm;
    for (const o of this.ordersOf(t)) if (o.status === 'planificado') {
      o.status = 'en_curso';
      o.updatedAt = t.startedAt;
    }
    this.addHistory(t, actorName, 'Viaje iniciado', detail);
  }

  startTrip(scope: TmsScope, id: string, actor: TmsActor): TripView {
    const t = this.findTrip(scope, id);
    if (t.status !== 'planificado') throw new TmsError(`El viaje está ${TRIP_STATUS_LABELS[t.status].toLowerCase()}.`, 409);
    // Re-check the hard rules at departure: something may have changed since planning.
    const check = this.validate(t.tenantId, { vehicleId: t.vehicleId, driverId: t.driverId, plannedStart: t.plannedStart, orderIds: this.ordersOf(t).map((o) => o.id) }, t.id);
    if (check.blocks.length) throw new TmsError(check.blocks[0].message, 409, { check });
    this.begin(t, actor.name, 'Inicio manual.');
    this.audit(t.tenantId, actor, 'Viaje iniciado', t.id, 'Inicio manual.');
    this.ctx().persist();
    return this.tripView(t);
  }

  cancelTrip(scope: TmsScope, id: string, reason: string, actor: TmsActor): TripView {
    const t = this.findTrip(scope, id);
    if (t.status === 'finalizado' || t.status === 'cancelado') throw new TmsError(`El viaje ya está ${TRIP_STATUS_LABELS[t.status].toLowerCase()}.`, 409);
    t.status = 'cancelado';
    t.cancelReason = reason.trim();
    const released: string[] = [];
    for (const o of this.ordersOf(t)) {
      if (o.status === 'entregado') continue;
      o.status = 'confirmado';
      o.tripId = undefined;
      o.updatedAt = nowIso();
      released.push(o.id);
    }
    this.addHistory(t, actor.name, 'Viaje cancelado', `${reason.trim()}${released.length ? ` · Pedidos liberados: ${released.join(', ')}` : ''}.`);
    this.audit(t.tenantId, actor, 'Viaje cancelado', t.id, reason.trim());
    this.ctx().persist();
    return this.tripView(t);
  }

  /** Manual stop update (driver called, GPS off, etc.). */
  setStopStatus(
    scope: TmsScope,
    tripId: string,
    stopId: string,
    input: { status: 'en_lugar' | 'completada' | 'omitida'; note?: string },
    actor: TmsActor,
    source: 'manual' | 'app' = 'manual'
  ): TripView {
    const t = this.findTrip(scope, tripId);
    if (t.status === 'finalizado' || t.status === 'cancelado') throw new TmsError(`El viaje está ${TRIP_STATUS_LABELS[t.status].toLowerCase()}.`, 409);
    const stop = t.stops.find((s) => s.id === stopId);
    if (!stop) throw new TmsError('Parada no encontrada.', 404);
    if (stop.status === 'completada' || stop.status === 'omitida') throw new TmsError('La parada ya está cerrada.', 409);
    if (input.status === 'omitida' && !input.note?.trim()) throw new TmsError('Indicá por qué se omite la parada.');
    if (source === 'app' && stop.kind === 'descarga' && input.status === 'completada') {
      throw new TmsError('Para entregar desde la app hace falta la prueba de entrega (firma, nombre y DNI).');
    }
    const how = source === 'app' ? 'desde la app del chofer' : 'a mano';
    if (t.status === 'planificado') this.begin(t, actor.name, `Inicio al registrar una parada ${how}.`);
    const at = nowIso();
    if (input.status === 'en_lugar' || !stop.arrivedAt) stop.arrivedAt = stop.arrivedAt ?? at;
    stop.detection = source;
    stop.note = input.note?.trim() || stop.note;
    stop.status = input.status;
    if (input.status !== 'en_lugar') stop.departedAt = at;
    const place = this.state.places.find((p) => p.id === stop.placeId);
    this.addHistory(t, actor.name, `Parada ${STOP_STATUS_LABELS[input.status].toLowerCase()} (${source === 'app' ? 'app' : 'manual'})`, `${place?.name ?? stop.placeId}${input.note ? ` · ${input.note.trim()}` : ''}.`);
    this.audit(t.tenantId, actor, source === 'app' ? 'Parada registrada por el chofer' : 'Parada registrada a mano', `${t.id} · ${place?.name ?? ''}`, `${STOP_STATUS_LABELS[input.status]}${input.note ? ` · ${input.note.trim()}` : ''}.`);
    this.afterStopClosed(t, stop, actor.name);
    this.ctx().persist();
    return this.tripView(t);
  }

  /** Effects of closing a stop: delivered orders, released orders, finished trip. */
  private afterStopClosed(t: Trip, stop: TripStop, actorName: string) {
    if (stop.status !== 'completada' && stop.status !== 'omitida') return;
    if (stop.kind === 'descarga') {
      for (const o of this.state.transportOrders.filter((x) => stop.orderIds.includes(x.id))) {
        if (stop.status === 'completada') {
          o.status = 'entregado';
          o.deliveredAt = stop.departedAt ?? nowIso();
          this.ctx().onOrderDelivered?.(o);
        } else {
          // Not delivered: back to the queue to plan again.
          o.status = 'confirmado';
          o.tripId = undefined;
        }
        o.updatedAt = nowIso();
      }
    }
    if (t.stops.every((s) => s.status === 'completada' || s.status === 'omitida')) {
      t.status = 'finalizado';
      t.finishedAt = nowIso();
      t.endOdometerKm = this.state.vehicles.find((v) => v.id === t.vehicleId)?.odometerKm;
      this.addHistory(t, actorName, 'Viaje finalizado', `${t.stops.filter((s) => s.status === 'completada').length} de ${t.stops.length} paradas completadas.`);
    }
  }

  // ---------------------------------------------------------------- T2: public tracking

  /** Link token of an order's public tracking page (created for orders that predate it). */
  trackingToken(scope: TmsScope, orderId: string, actor: TmsActor): string {
    const o = this.findOrder(scope, orderId);
    if (!o.trackingToken) {
      o.trackingToken = newSecret();
      o.updatedAt = nowIso();
      this.audit(o.tenantId, actor, 'Link de seguimiento', o.id, 'Se generó el link público de seguimiento.');
      this.ctx().persist();
    }
    return o.trackingToken;
  }

  /** Read-only tracking data for the receiver. Null when the token doesn't exist or the order was cancelled. */
  publicTracking(token: string, now = new Date()): PublicTracking | null {
    if (!token || token.length < 20) return null;
    const o = this.state.transportOrders.find((x) => x.trackingToken === token);
    if (!o || o.status === 'cancelado') return null;
    const place = (id: string) => this.state.places.find((p) => p.id === id);
    const dest = place(o.destinationPlaceId);
    const trip = o.tripId ? this.state.trips.find((t) => t.id === o.tripId) : undefined;
    const unload = trip?.stops.find((s) => s.kind === 'descarga' && s.orderIds.includes(o.id));
    const load = trip?.stops.find((s) => s.kind === 'carga' && s.orderIds.includes(o.id));
    const events: PublicTracking['events'] = [{ at: o.createdAt, label: 'Pedido registrado' }];
    if (trip?.startedAt) events.push({ at: trip.startedAt, label: 'Viaje iniciado' });
    if (load?.departedAt) events.push({ at: load.departedAt, label: 'Mercadería cargada' });
    if (unload?.arrivedAt) events.push({ at: unload.arrivedAt, label: 'Llegó al destino' });
    if (o.deliveredAt) events.push({ at: o.deliveredAt, label: 'Entregado' });

    let unit: PublicTracking['unit'];
    // The unit's position only while it is on its way to this destination (never before or after).
    if (trip?.status === 'en_curso' && unload && (unload.status === 'pendiente' || unload.status === 'en_lugar') && dest) {
      const current = currentStop(trip);
      const v = this.state.vehicles.find((x) => x.id === trip.vehicleId);
      if (v && current && v.lastReportAt && now.getTime() - Date.parse(v.lastReportAt) < 30 * 60_000) {
        // Remaining path: unit → pending stops up to this destination (straight lines).
        let dist = 0;
        let from = { lat: v.lat, lng: v.lng };
        for (const s of trip.stops.filter((x) => x.seq >= current.seq && x.seq <= unload.seq)) {
          const p = place(s.placeId);
          if (!p) continue;
          dist += distanceMeters(from, p);
          from = p;
        }
        unit = {
          lat: Number(v.lat.toFixed(4)),
          lng: Number(v.lng.toFixed(4)),
          at: v.lastReportAt,
          distanceKm: Math.round(dist / 100) / 10,
          etaMinutes:
            unload.status === 'en_lugar'
              ? 0
              : unload.eta && Date.parse(unload.eta) > now.getTime()
                ? Math.round((Date.parse(unload.eta) - now.getTime()) / 60_000)
                : roughEtaMinutes(dist),
        };
      }
    }
    return {
      orderId: o.id,
      reference: o.reference,
      carrier: this.tenantName(o.tenantId) ?? '',
      status: o.status,
      statusLabel: ORDER_STATUS_LABELS[o.status],
      cargo: o.cargo.description,
      origin: { name: place(o.originPlaceId)?.name ?? '' },
      destination: { name: dest?.name ?? '', address: dest?.address ?? '', lat: dest?.lat ?? 0, lng: dest?.lng ?? 0, radiusM: dest?.radiusM ?? 0 },
      deliveryWindow: o.deliveryWindow,
      unit,
      delivered: o.status === 'entregado' ? { at: o.deliveredAt ?? '', receiverName: unload?.pod?.receiverName ?? '', hasProof: Boolean(unload?.pod) } : undefined,
      events: events.sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  /** Order + its delivery (for the delivery note PDF). */
  deliveryOf(order: TransportOrder): { order: TransportOrder; trip?: Trip; stop?: TripStop } {
    const trip = order.tripId ? this.state.trips.find((t) => t.id === order.tripId) : undefined;
    return { order, trip, stop: trip?.stops.find((s) => s.kind === 'descarga' && s.orderIds.includes(order.id)) };
  }

  /** Everything the delivery note shows (the signature image is loaded by the caller). */
  async deliveryNoteData(order: TransportOrder): Promise<DeliveryNoteInput> {
    const { trip, stop } = this.deliveryOf(order);
    const tenant = this.state.tenants.find((x) => x.id === order.tenantId);
    const v = trip ? this.state.vehicles.find((x) => x.id === trip.vehicleId) : undefined;
    const signature = stop?.pod ? ((await this.ctx().repo.getTmsFile(order.tenantId, stop.pod.signatureFileId))?.data ?? null) : null;
    return {
      carrier: tenant?.name ?? '',
      carrierTaxId: tenant?.taxId,
      order,
      customer: this.state.customers.find((c) => c.id === order.customerId),
      origin: this.state.places.find((p) => p.id === order.originPlaceId),
      destination: this.state.places.find((p) => p.id === order.destinationPlaceId),
      trip,
      stop,
      unit: v ? { unitCode: v.unitCode, plate: v.plate } : undefined,
      driverName: trip ? this.state.drivers.find((d) => d.id === trip.driverId)?.name : undefined,
      signature,
    };
  }

  orderForDocument(scope: TmsScope, id: string): TransportOrder {
    return this.findOrder(scope, id);
  }

  orderByTrackingToken(token: string): TransportOrder | null {
    return this.state.transportOrders.find((x) => x.trackingToken === token && x.status !== 'cancelado') ?? null;
  }

  tripForDocument(scope: TmsScope, id: string): Trip {
    return this.findTrip(scope, id);
  }

  // ---------------------------------------------------------------- T2: driver app

  /** New personal link for the driver's app; the previous one stops working. Returns the raw token (shown once). */
  issueDriverAppLink(scope: TmsScope, driverId: string, actor: TmsActor): { token: string; driver: Driver } {
    const d = this.state.drivers.find((x) => x.id === driverId && inScope(scope, x.tenantId));
    if (!d) throw new TmsError('Chofer no encontrado.', 404);
    const had = Boolean(d.appAccess);
    const token = newSecret();
    d.appAccess = { tokenHash: hashToken(token), createdAt: nowIso(), createdBy: actor.hidden ? 'Superadmin' : actor.name };
    this.audit(d.tenantId, actor, had ? 'Nuevo link de la app del chofer' : 'Link de la app del chofer', d.name, had ? 'El link anterior deja de funcionar.' : 'Se generó el acceso a la app de viajes.');
    this.ctx().persist();
    return { token, driver: d };
  }

  revokeDriverAppLink(scope: TmsScope, driverId: string, actor: TmsActor): Driver {
    const d = this.state.drivers.find((x) => x.id === driverId && inScope(scope, x.tenantId));
    if (!d) throw new TmsError('Chofer no encontrado.', 404);
    if (d.appAccess) {
      delete d.appAccess;
      this.audit(d.tenantId, actor, 'Link de la app revocado', d.name, 'El chofer ya no puede entrar a la app de viajes con su link.');
      this.ctx().persist();
    }
    return d;
  }

  /** Driver behind an app token (null when unknown, revoked or the driver is disabled). */
  driverByAppToken(token: string | undefined): Driver | null {
    if (!token || token.length < 20) return null;
    const hash = hashToken(token);
    const d = this.state.drivers.find((x) => x.appAccess?.tokenHash === hash);
    if (!d || d.enabled === false) return null;
    const now = Date.now();
    // Record activity at most every 5 minutes (it's informative, not worth a write per request).
    if (!d.appAccess!.lastSeenAt || now - Date.parse(d.appAccess!.lastSeenAt) > 5 * 60_000) {
      d.appAccess!.lastSeenAt = new Date(now).toISOString();
      this.ctx().persist();
    }
    return d;
  }

  /** The driver's trips: planned and in progress, plus those finished in the last 24 h. */
  driverTrips(driver: Driver): TripView[] {
    const since = Date.now() - 24 * 3600_000;
    return this.state.trips
      .filter((t) => t.tenantId === driver.tenantId && t.driverId === driver.id)
      .filter((t) => t.status === 'planificado' || t.status === 'en_curso' || (t.status === 'finalizado' && Date.parse(t.finishedAt ?? '') >= since))
      .sort((a, b) => (a.status === 'en_curso' ? -1 : 0) - (b.status === 'en_curso' ? -1 : 0) || a.plannedStart.localeCompare(b.plannedStart))
      .map((t) => this.tripView(t));
  }

  /** A trip of this driver (404 otherwise: a driver never sees someone else's trips). */
  driverTrip(driver: Driver, tripId: string): Trip {
    const t = this.state.trips.find((x) => x.id === tripId && x.tenantId === driver.tenantId && x.driverId === driver.id);
    if (!t) throw new TmsError('Viaje no encontrado.', 404);
    return t;
  }

  driverActor(driver: Driver): TmsActor {
    return { name: driver.name, role: 'Chofer (app)', canOverride: false };
  }

  /** Stores a signature or photo of a delivery. Validates type by content, not only by header. */
  async saveProofFile(tenantId: string, tripId: string, kind: 'signature' | 'photo' | 'receipt', data: Buffer, mime: string, by: string): Promise<string> {
    const check = POD_MIMES[mime];
    if (!check) throw new TmsError('La imagen debe ser JPG o PNG.');
    if (kind === 'signature' && mime !== 'image/png') throw new TmsError('La firma debe ser una imagen PNG.');
    if (!data.length || data.length > POD_FILE_MAX_BYTES) throw new TmsError('La imagen supera los 3 MB.');
    if (!check(data)) throw new TmsError('El archivo no es una imagen válida.');
    const id = `pod-${uid()}${uid()}`;
    await this.ctx().repo.saveTmsFile({ id, tenantId, tripId, kind, mime, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), data, createdBy: by });
    return id;
  }

  /** A proof file, only within the scope and only for trips of that scope. */
  async proofFile(scope: TmsScope, fileId: string): Promise<{ mime: string; data: Buffer } | null> {
    const tenants = 'all' in scope ? this.state.tenants.map((t) => t.id) : [scope.tenantId];
    for (const tenantId of tenants) {
      const f = await this.ctx().repo.getTmsFile(tenantId, fileId);
      if (f) return { mime: f.mime, data: f.data };
    }
    return null;
  }

  /**
   * Unloading completed from the driver's app with proof of delivery: signature, name and DNI of the
   * receiver (mandatory), optional photos and where the phone was.
   */
  completeWithProof(
    driver: Driver,
    tripId: string,
    stopId: string,
    input: { receiverName: string; receiverDni: string; signatureFileId: string; photoFileIds?: string[]; note?: string; lat?: number; lng?: number; accuracyM?: number }
  ): TripView {
    const t = this.driverTrip(driver, tripId);
    if (t.status === 'finalizado' || t.status === 'cancelado') throw new TmsError(`El viaje está ${TRIP_STATUS_LABELS[t.status].toLowerCase()}.`, 409);
    const stop = t.stops.find((s) => s.id === stopId);
    if (!stop) throw new TmsError('Parada no encontrada.', 404);
    if (stop.kind !== 'descarga') throw new TmsError('La prueba de entrega es para paradas de descarga.');
    if (stop.status === 'completada' || stop.status === 'omitida') throw new TmsError('La parada ya está cerrada.', 409);
    const name = input.receiverName.trim();
    const dni = input.receiverDni.replace(/\D/g, '');
    if (name.length < 3) throw new TmsError('Escribí el nombre y apellido de quien recibe.');
    if (!DNI_RE.test(dni)) throw new TmsError('El DNI de quien recibe debe tener 7 u 8 dígitos.');
    if (!input.signatureFileId.startsWith('pod-')) throw new TmsError('Falta la firma de quien recibe.');
    const at = nowIso();
    const pod: ProofOfDelivery = {
      receiverName: name,
      receiverDni: dni,
      signatureFileId: input.signatureFileId,
      photoFileIds: (input.photoFileIds ?? []).filter((id) => id.startsWith('pod-')).slice(0, 5),
      note: input.note?.trim() || undefined,
      lat: typeof input.lat === 'number' && Number.isFinite(input.lat) ? Number(input.lat.toFixed(6)) : undefined,
      lng: typeof input.lng === 'number' && Number.isFinite(input.lng) ? Number(input.lng.toFixed(6)) : undefined,
      accuracyM: typeof input.accuracyM === 'number' && Number.isFinite(input.accuracyM) ? Math.round(input.accuracyM) : undefined,
      at,
      by: driver.name,
    };
    if (t.status === 'planificado') this.begin(t, driver.name, 'Inicio al registrar una entrega desde la app.');
    stop.pod = pod;
    stop.arrivedAt = stop.arrivedAt ?? at;
    stop.departedAt = at;
    stop.status = 'completada';
    stop.detection = 'app';
    const place = this.state.places.find((p) => p.id === stop.placeId);
    const distance = pod.lat !== undefined && pod.lng !== undefined && place ? distanceMeters({ lat: pod.lat, lng: pod.lng }, place) : undefined;
    const far = distance !== undefined && place && distance > place.radiusM + 500;
    this.addHistory(
      t,
      driver.name,
      'Entrega con firma',
      `${place?.name ?? ''}: recibió ${name} (DNI ${dni})${pod.photoFileIds.length ? ` · ${pod.photoFileIds.length} foto(s)` : ''}${
        distance !== undefined ? ` · a ${Math.round(distance)} m del lugar` : ' · sin ubicación del celular'
      }.`
    );
    this.ctx().audit({
      tenantId: t.tenantId,
      actorName: driver.name,
      actorRole: 'Chofer (app)',
      module: 'Operaciones',
      action: 'Entrega con prueba',
      targetLabel: `${t.id} · ${stop.orderIds.join(', ')}`,
      detail: `Recibió ${name} (DNI ${dni}).${far ? ` Atención: firmada a ${Math.round(distance!)} m del lugar.` : ''}`,
    });
    this.afterStopClosed(t, stop, driver.name);
    this.ctx().persist();
    return this.tripView(t);
  }

  /** Something happened on the road: it becomes an incident the dispatch sees in Alerts and Incidents. */
  reportDriverIssue(driver: Driver, tripId: string, input: { type: DriverReportType; note: string; stopId?: string; photoFileId?: string }): { incident: Incident; trip: TripView } {
    const t = this.driverTrip(driver, tripId);
    const meta = DRIVER_REPORT_TYPES[input.type];
    const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
    const stop = input.stopId ? t.stops.find((s) => s.id === input.stopId) : currentStop(t);
    const place = stop ? this.state.places.find((p) => p.id === stop.placeId) : undefined;
    const at = nowIso();
    const incident: Incident = {
      id: `inc-${uid()}`,
      tenantId: t.tenantId,
      alertId: null,
      vehicleId: t.vehicleId,
      unitCode: v?.unitCode ?? '',
      plate: v?.plate ?? '',
      title: `${meta.label} · ${t.id}`,
      category: 'Novedad de viaje (app del chofer)',
      priority: meta.priority,
      status: 'abierto',
      assignee: 'Sin asignar',
      createdAt: at,
      updatedAt: at,
      resolutionNote: `${driver.name}${place ? ` en ${place.name}` : ''}: ${input.note.trim()}${input.photoFileId ? ` (foto adjunta: ${input.photoFileId})` : ''}`,
      clipId: null,
    };
    this.state.incidents.unshift(incident);
    this.addHistory(t, driver.name, `Novedad: ${meta.label}`, `${input.note.trim()}${place ? ` · ${place.name}` : ''}.`);
    this.ctx().audit({ tenantId: t.tenantId, actorName: driver.name, actorRole: 'Chofer (app)', module: 'Operaciones', action: 'Novedad del chofer', targetLabel: t.id, detail: `${meta.label}: ${input.note.trim()}` });
    this.ctx().persist();
    return { incident, trip: this.tripView(t) };
  }

  // ---------------------------------------------------------------- unit capacity

  updateVehicleCapacity(
    scope: TmsScope,
    vehicleId: string,
    patch: { capacityKg?: number | null; capacityM3?: number | null; capacityPallets?: number | null; tankLiters?: number | null; bodyType?: Vehicle['bodyType'] | null; refrigerated?: boolean },
    actor: TmsActor
  ): Vehicle {
    const v = this.state.vehicles.find((x) => x.id === vehicleId && inScope(scope, x.tenantId));
    if (!v) throw new TmsError('Unidad no encontrada.', 404);
    const keys = ['capacityKg', 'capacityM3', 'capacityPallets', 'tankLiters', 'bodyType'] as const;
    for (const k of keys) {
      if (patch[k] === undefined) continue;
      if (patch[k] === null) delete v[k];
      else (v as unknown as Record<string, unknown>)[k] = patch[k];
    }
    if (patch.refrigerated !== undefined) v.refrigerated = patch.refrigerated;
    const desc = [
      v.capacityKg !== undefined ? `${v.capacityKg} kg` : null,
      v.capacityM3 !== undefined ? `${v.capacityM3} m³` : null,
      v.capacityPallets !== undefined ? `${v.capacityPallets} pallets` : null,
      v.tankLiters !== undefined ? `tanque ${v.tankLiters} L` : null,
      v.refrigerated ? 'refrigerada' : null,
    ].filter(Boolean);
    this.audit(v.tenantId, actor, 'Capacidad de unidad', v.unitCode, desc.length ? desc.join(' · ') : 'Sin capacidad cargada.');
    this.ctx().persist();
    return v;
  }

  // ---------------------------------------------------------------- automatic tracking

  /**
   * Moves stops forward with the units' current positions (any source: camera, OBD, phone) and
   * raises one "late delivery" alert per unloading stop whose window closed without arrival.
   * Idempotent; runs every minute and on demand. Returns how many things changed.
   */
  evaluateTrips(now = new Date(), scope: TmsScope = { all: true }): number {
    let changes = 0;
    const system = 'Seguimiento automático';
    for (const t of this.state.trips) {
      if (!inScope(scope, t.tenantId)) continue;
      if (t.status !== 'en_curso' && t.status !== 'planificado') continue;
      const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
      const stop = currentStop(t);
      const place = stop ? this.state.places.find((p) => p.id === stop.placeId) : undefined;

      if (v && stop && place && v.lastReportAt) {
        // A planned trip starts by itself when its time came and the unit reaches the first stop.
        const canTrack = t.status === 'en_curso' || (Date.parse(t.plannedStart) <= now.getTime() && stop.seq === 1);
        const tr = canTrack ? evaluateStop(stop, place, { lat: v.lat, lng: v.lng, at: v.lastReportAt }, now) : null;
        if (tr) {
          if (t.status === 'planificado') this.begin(t, system, `La unidad llegó a ${place.name}.`);
          if (tr.type === 'arrived') {
            stop.status = 'en_lugar';
            stop.arrivedAt = tr.at;
            stop.detection = 'auto';
            this.addHistory(t, system, 'Llegada', `${STOP_KIND_LABELS[stop.kind]} en ${place.name} (a ${Math.round(tr.distanceM)} m del centro).`);
          } else if (tr.type === 'departed') {
            stop.status = 'completada';
            stop.departedAt = tr.at;
            stop.detection = 'auto';
            this.addHistory(t, system, 'Salida', `${STOP_KIND_LABELS[stop.kind]} completada en ${place.name}.`);
            this.afterStopClosed(t, stop, system);
          } else {
            stop.status = 'pendiente';
            stop.arrivedAt = undefined;
            this.addHistory(t, system, 'Paso sin detenerse', `La unidad pasó por ${place.name} sin quedarse: la parada sigue pendiente.`);
          }
          changes += 1;
        }
      }

      for (const s of t.stops) {
        if (!isStopLate(s, now)) continue;
        s.delayAlertedAt = now.toISOString();
        const p = this.state.places.find((x) => x.id === s.placeId);
        if (v) this.raiseDelayAlert(t, s, p?.name ?? 'destino', v, now);
        this.addHistory(t, system, 'Entrega demorada', `${p?.name ?? 'Destino'}: la ventana cerró sin llegada.`);
        changes += 1;
      }
    }
    if (changes) this.ctx().persist();
    return changes;
  }

  private raiseDelayAlert(t: Trip, s: TripStop, placeName: string, v: FleetStoreState['vehicles'][number], now: Date) {
    const driver = this.state.drivers.find((d) => d.id === t.driverId);
    const alert: AlertEvent = {
      id: `alr-${uid()}`,
      tenantId: t.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      plate: v.plate,
      driverName: driver?.name ?? v.driverName,
      ruleId: 'tms-delay',
      ruleName: 'Entrega demorada',
      priority: 'alta',
      status: 'pendiente',
      lat: v.lat,
      lng: v.lng,
      speedKmh: v.speedKmh,
      timestamp: now.toISOString(),
      clipId: null,
      summary: `Viaje ${t.id}: no llegó a ${placeName} antes de las ${new Date(s.window!.to).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.`,
    };
    this.state.alerts.unshift(alert);
  }
}
