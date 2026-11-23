import crypto from 'crypto';
import type { AuditLog, FleetStoreState, Vehicle } from '../../src/shared/types.ts';
import {
  DEFAULT_PRIORITY,
  EXPENSE_LABELS,
  fuelAnomalies,
  fuelEfficiency,
  MONTHLY_HOURS,
  priceOrder,
  roadKm,
  tripCost,
  type ChargeLine,
  type DriverSettlement,
  type ExpenseType,
  type FuelImportRow,
  type FuelLoad,
  type OrderCharge,
  type PreInvoice,
  type Tariff,
  type TariffExtras,
  type TariffRule,
  type TariffRuleKind,
  type TripCost,
  type TripExpense,
} from '../../src/shared/costs.ts';
import type { TransportOrder, Trip } from '../../src/shared/tms.ts';
import type { StateRepository } from '../db/stateRepository.ts';
import { TmsError, type TmsActor, type TmsScope } from './service.ts';

interface Ctx {
  state: FleetStoreState;
  repo: StateRepository;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
  /** Company currency code (null when the superadmin hasn't defined it). */
  currencyOf: (tenantId: string) => string | null;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const nowIso = () => new Date().toISOString();
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const normPlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');
const inPeriod = (iso: string | undefined, from: string, to: string) => Boolean(iso) && iso!.slice(0, 10) >= from && iso!.slice(0, 10) <= to;

export interface TariffInput {
  customerId: string;
  name: string;
  active?: boolean;
  priority?: TariffRuleKind[];
  rules: Array<Omit<TariffRule, 'id'> & { id?: string }>;
  extras?: TariffExtras;
  notes?: string;
}

export interface TripEconomics {
  tripId: string;
  revenue: number;
  /** Delivered orders without a price (need a tariff or a manual price). */
  unpricedOrders: string[];
  cost: TripCost;
  margin: number;
  marginPct: number | null;
  currency: string | null;
}

export interface ProfitRow {
  key: string;
  label: string;
  trips: number;
  km: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
}

/**
 * TMS T3: tariffs and pricing, fuel, trip expenses, trip cost and profitability, pre-invoices and
 * driver expense settlements. Shares the store's state and persistence.
 */
export class CostsService {
  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }

  private audit(tenantId: string, actor: { name: string; role: string; hidden?: boolean }, action: string, target: string, detail: string) {
    this.ctx().audit({ tenantId, actorName: actor.name, actorRole: actor.role, actorHidden: actor.hidden, module: 'Operaciones · Costos', action, targetLabel: target, detail });
  }

  private code(tenantId: string): string {
    const unit = this.state.vehicles.find((v) => v.tenantId === tenantId)?.unitCode?.split('-')[0];
    return unit && /^[A-Z0-9]{2,5}$/.test(unit) ? unit : 'EMP';
  }

  private nextFolio(prefix: string, tenantId: string, existing: Array<{ id: string; tenantId: string }>) {
    const head = `${prefix}-${this.code(tenantId)}-`;
    let max = 0;
    for (const e of existing) if (e.tenantId === tenantId && e.id.startsWith(head)) max = Math.max(max, Number(e.id.slice(head.length)) || 0);
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  // ---------------------------------------------------------------- tariffs

  listTariffs(scope: TmsScope, customerId?: string): Tariff[] {
    return this.state.tariffs
      .filter((t) => inScope(scope, t.tenantId) && (!customerId || t.customerId === customerId))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
  }

  private checkTariff(tenantId: string, input: TariffInput) {
    if (!this.state.customers.some((c) => c.id === input.customerId && c.tenantId === tenantId)) throw new TmsError('Cliente no encontrado.', 404);
    if (input.rules.length === 0) throw new TmsError('Agregá al menos una regla de precio.');
    for (const r of input.rules) {
      if (!(r.price > 0)) throw new TmsError('Cada regla necesita un precio mayor que 0.');
      if (r.kind === 'tramo') {
        if (!r.originPlaceId || !r.destinationPlaceId || r.originPlaceId === r.destinationPlaceId) throw new TmsError('Un precio por tramo necesita origen y destino distintos.');
        for (const id of [r.originPlaceId, r.destinationPlaceId]) {
          if (!this.state.places.some((p) => p.id === id && p.tenantId === tenantId)) throw new TmsError('Lugar del tramo no encontrado.', 404);
        }
      }
    }
  }

  /** Active tariff of a customer (the most recently updated active one). */
  activeTariff(tenantId: string, customerId: string): Tariff | undefined {
    return this.state.tariffs.filter((t) => t.tenantId === tenantId && t.customerId === customerId && t.active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  saveTariff(scope: TmsScope, tenantId: string, id: string | null, input: TariffInput, actor: TmsActor): Tariff {
    const existing = id ? this.state.tariffs.find((t) => t.id === id && inScope(scope, t.tenantId)) : undefined;
    if (id && !existing) throw new TmsError('Tarifario no encontrado.', 404);
    const tid = existing?.tenantId ?? tenantId;
    this.checkTariff(tid, input);
    const at = nowIso();
    const t: Tariff = {
      id: existing?.id ?? `tar-${uid()}`,
      tenantId: tid,
      customerId: input.customerId,
      name: input.name.trim(),
      active: input.active ?? true,
      priority: input.priority?.length ? [...new Set(input.priority)] : [...DEFAULT_PRIORITY],
      rules: input.rules.map((r) => ({ ...r, id: r.id ?? `r-${uid()}` })),
      extras: input.extras ?? {},
      notes: input.notes?.trim() || undefined,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    // One active tariff per customer: activating this one deactivates the others.
    if (t.active) for (const o of this.state.tariffs) if (o.id !== t.id && o.tenantId === tid && o.customerId === t.customerId) o.active = false;
    if (existing) Object.assign(existing, t);
    else this.state.tariffs.push(t);
    this.audit(tid, actor, existing ? 'Tarifario editado' : 'Tarifario creado', t.name, `${t.rules.length} regla(s)${t.active ? ', activo' : ''}.`);
    this.ctx().persist();
    return existing ?? t;
  }

  /** Price of a hypothetical order (quote). */
  quote(
    tenantId: string,
    input: { customerId: string; originPlaceId: string; destinationPlaceId: string; weightKg?: number; pallets?: number; dangerous?: boolean; refrigerated?: boolean }
  ): { tariff?: { id: string; name: string }; distanceKm: number; price: { amount: number; lines: ChargeLine[]; rule: TariffRuleKind } | null; currency: string | null } {
    const o = this.state.places.find((p) => p.id === input.originPlaceId && p.tenantId === tenantId);
    const d = this.state.places.find((p) => p.id === input.destinationPlaceId && p.tenantId === tenantId);
    if (!o || !d) throw new TmsError('Lugar no encontrado.', 404);
    const distanceKm = roadKm(o, d);
    const tariff = this.activeTariff(tenantId, input.customerId);
    const price = tariff ? priceOrder(tariff, { ...input, distanceKm }) : null;
    return { tariff: tariff ? { id: tariff.id, name: tariff.name } : undefined, distanceKm, price, currency: this.ctx().currencyOf(tenantId) };
  }

  /** Minutes the unit spent at this order's stops (arrival → departure). */
  private waitingMinutes(order: TransportOrder, trip?: Trip): number {
    if (!trip) return 0;
    let ms = 0;
    for (const s of trip.stops) if (s.orderIds.includes(order.id) && s.arrivedAt && s.departedAt) ms += Math.max(0, Date.parse(s.departedAt) - Date.parse(s.arrivedAt));
    return Math.round(ms / 60_000);
  }

  /** Tolls of the trip (approved expenses) split equally among its orders. */
  private tollShare(trip?: Trip): number {
    if (!trip) return 0;
    const tolls = this.state.tripExpenses.filter((e) => e.tripId === trip.id && e.type === 'peaje' && e.status === 'aprobado').reduce((a, e) => a + e.amount, 0);
    const orders = new Set(trip.stops.flatMap((s) => s.orderIds)).size || 1;
    return round2(tolls / orders);
  }

  /**
   * Prices an order with its customer's active tariff. Manual prices and orders already in a
   * pre-invoice are left alone. Returns the charge (or undefined when no rule applies).
   */
  priceOrder(order: TransportOrder, force = false): OrderCharge | undefined {
    if (order.charge?.preInvoiceId) return order.charge;
    if (order.charge?.adjustedBy && !force) return order.charge;
    const trip = order.tripId ? this.state.trips.find((t) => t.id === order.tripId) : undefined;
    const o = this.state.places.find((p) => p.id === order.originPlaceId);
    const d = this.state.places.find((p) => p.id === order.destinationPlaceId);
    const tariff = this.activeTariff(order.tenantId, order.customerId);
    if (!o || !d || !tariff) return order.charge;
    const distanceKm = roadKm(o, d);
    const priced = priceOrder(tariff, {
      originPlaceId: order.originPlaceId,
      destinationPlaceId: order.destinationPlaceId,
      weightKg: order.cargo.weightKg,
      pallets: order.cargo.pallets,
      dangerous: order.cargo.dangerous,
      refrigerated: order.cargo.refrigerated,
      distanceKm,
      waitingMinutes: this.waitingMinutes(order, trip),
      tolls: this.tollShare(trip),
    });
    if (!priced) return order.charge;
    order.charge = { amount: priced.amount, currency: this.ctx().currencyOf(order.tenantId), lines: priced.lines, tariffId: tariff.id, rule: priced.rule, distanceKm, computedAt: nowIso() };
    return order.charge;
  }

  /** Hook: an order was delivered → price it (no persist: the caller persists). */
  onOrderDelivered(order: TransportOrder) {
    this.priceOrder(order);
  }

  setOrderCharge(scope: TmsScope, orderId: string, input: { amount?: number; reason: string; recalculate?: boolean }, actor: TmsActor): TransportOrder {
    const order = this.state.transportOrders.find((o) => o.id === orderId && inScope(scope, o.tenantId));
    if (!order) throw new TmsError('Pedido no encontrado.', 404);
    if (order.charge?.preInvoiceId) throw new TmsError(`El pedido ya está en la pre-factura ${order.charge.preInvoiceId}: anulala para cambiar el precio.`, 409);
    if (input.recalculate) {
      delete order.charge;
      if (!this.priceOrder(order, true)) throw new TmsError('El cliente no tiene un tarifario activo que aplique a este pedido: cargá el precio a mano.', 409);
      this.audit(order.tenantId, actor, 'Precio recalculado', order.id, `${order.charge!.amount} según el tarifario.`);
    } else {
      if (!(typeof input.amount === 'number' && input.amount >= 0)) throw new TmsError('Indicá el importe.');
      if (!input.reason.trim()) throw new TmsError('Indicá el motivo del ajuste.');
      const prev = order.charge?.amount;
      order.charge = {
        amount: round2(input.amount),
        currency: this.ctx().currencyOf(order.tenantId),
        lines: [{ label: 'Precio ajustado a mano', amount: round2(input.amount) }],
        rule: 'manual',
        computedAt: nowIso(),
        adjustedBy: actor.name,
        adjustReason: input.reason.trim(),
      };
      this.audit(order.tenantId, actor, 'Precio ajustado', order.id, `${prev ?? 'sin precio'} → ${order.charge.amount}: ${input.reason.trim()}`);
    }
    order.updatedAt = nowIso();
    this.ctx().persist();
    return order;
  }

  // ---------------------------------------------------------------- fuel

  private tripAt(vehicleId: string, atIso: string): Trip | undefined {
    const at = Date.parse(atIso);
    return this.state.trips.find(
      (t) =>
        t.vehicleId === vehicleId &&
        t.startedAt &&
        Date.parse(t.startedAt) - 30 * 60_000 <= at &&
        (t.finishedAt ? at <= Date.parse(t.finishedAt) + 30 * 60_000 : t.status === 'en_curso')
    );
  }

  async addFuelLoad(
    tenantId: string,
    input: { vehicleId: string; at?: string; liters: number; total?: number; pricePerLiter?: number; odometerKm?: number; station?: string; fullTank?: boolean; receiptFileId?: string; tripId?: string; driverId?: string },
    actor: { name: string; role: string; hidden?: boolean },
    source: FuelLoad['source'],
    importBatch?: string
  ): Promise<FuelLoad> {
    const v = this.state.vehicles.find((x) => x.id === input.vehicleId && x.tenantId === tenantId);
    if (!v) throw new TmsError('Unidad no encontrada.', 404);
    if (!(input.liters > 0 && input.liters < 5000)) throw new TmsError('Los litros deben ser mayores que 0.');
    const total = input.total ?? (input.pricePerLiter ? input.liters * input.pricePerLiter : undefined);
    if (!(total && total > 0)) throw new TmsError('Indicá el importe o el precio por litro.');
    const at = input.at ?? nowIso();
    if (Date.parse(at) > Date.now() + 10 * 60_000) throw new TmsError('La fecha de la carga no puede ser futura.');
    const trip = input.tripId ? this.state.trips.find((t) => t.id === input.tripId && t.tenantId === tenantId) : this.tripAt(v.id, at);
    const load: FuelLoad = {
      id: `fuel-${uid()}`,
      tenantId,
      vehicleId: v.id,
      driverId: input.driverId ?? trip?.driverId,
      tripId: trip?.id,
      at,
      liters: round2(input.liters),
      pricePerLiter: round2(input.pricePerLiter ?? total / input.liters),
      total: round2(total),
      odometerKm: typeof input.odometerKm === 'number' ? Math.round(input.odometerKm) : undefined,
      station: input.station?.trim() || undefined,
      fullTank: input.fullTank,
      source,
      receiptFileId: input.receiptFileId,
      importBatch,
      flags: [],
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: nowIso(),
    };
    const history = this.state.fuelLoads.filter((f) => f.vehicleId === v.id);
    const obd = await this.ctx().repo.obdFuelAround(tenantId, v.id, at).catch(() => null);
    load.flags = fuelAnomalies(load, history, v, obd);
    this.state.fuelLoads.push(load);
    if (!importBatch) {
      this.audit(tenantId, actor, 'Carga de combustible', v.unitCode, `${load.liters} L · ${load.total}${load.flags.length ? ` · Atención: ${load.flags.map((f) => f.message).join(' ')}` : ''}`);
      this.ctx().persist();
    }
    return load;
  }

  /** Imports a fleet card statement (already parsed). Rows that can't be matched are reported, not imported. */
  async importFuel(tenantId: string, rows: FuelImportRow[], actor: TmsActor): Promise<{ imported: number; flagged: number; skipped: Array<{ line: number; reason: string }> }> {
    const batch = `imp-${uid()}`;
    const plates = new Map(this.state.vehicles.filter((v) => v.tenantId === tenantId).map((v) => [normPlate(v.plate), v]));
    const skipped: Array<{ line: number; reason: string }> = [];
    let imported = 0;
    let flagged = 0;
    for (const r of rows) {
      if (r.error) {
        skipped.push({ line: r.line, reason: r.error });
        continue;
      }
      const v = plates.get(normPlate(r.plate));
      if (!v) {
        skipped.push({ line: r.line, reason: `patente ${r.plate} no es de la empresa` });
        continue;
      }
      const dup = this.state.fuelLoads.find((f) => f.vehicleId === v.id && Math.abs(Date.parse(f.at) - Date.parse(r.at!)) < 2 * 60_000 && Math.abs(f.liters - r.liters!) < 0.05);
      if (dup) {
        skipped.push({ line: r.line, reason: 'ya estaba cargada' });
        continue;
      }
      try {
        const load = await this.addFuelLoad(
          tenantId,
          { vehicleId: v.id, at: r.at!, liters: r.liters!, total: r.total!, pricePerLiter: r.pricePerLiter ?? undefined, odometerKm: r.odometerKm ?? undefined, station: r.station },
          actor,
          'importacion',
          batch
        );
        imported += 1;
        if (load.flags.length) flagged += 1;
      } catch (err) {
        skipped.push({ line: r.line, reason: err instanceof Error ? err.message : 'error' });
      }
    }
    this.audit(tenantId, actor, 'Importación de combustible', batch, `${imported} carga(s) importada(s), ${skipped.length} omitida(s), ${flagged} con alertas.`);
    this.ctx().persist();
    return { imported, flagged, skipped };
  }

  listFuel(scope: TmsScope, f: { vehicleId?: string; from?: string; to?: string; flagged?: boolean } = {}) {
    const items = this.state.fuelLoads
      .filter((x) => inScope(scope, x.tenantId))
      .filter((x) => !f.vehicleId || x.vehicleId === f.vehicleId)
      .filter((x) => (!f.from || x.at.slice(0, 10) >= f.from) && (!f.to || x.at.slice(0, 10) <= f.to))
      .filter((x) => !f.flagged || x.flags.length > 0)
      .sort((a, b) => b.at.localeCompare(a.at));
    const vehicles = new Map(this.state.vehicles.map((v) => [v.id, v]));
    const eff = new Map<string, number>();
    const byVehicle = new Map<string, FuelLoad[]>();
    for (const l of this.state.fuelLoads.filter((x) => inScope(scope, x.tenantId))) byVehicle.set(l.vehicleId, [...(byVehicle.get(l.vehicleId) ?? []), l]);
    for (const loads of byVehicle.values()) for (const [id, v] of fuelEfficiency(loads)) eff.set(id, v);
    return {
      items: items.map((x) => ({ ...x, unitCode: vehicles.get(x.vehicleId)?.unitCode ?? '—', plate: vehicles.get(x.vehicleId)?.plate ?? '', litersPer100: eff.get(x.id) })),
      totals: { liters: round2(items.reduce((a, x) => a + x.liters, 0)), amount: round2(items.reduce((a, x) => a + x.total, 0)), flagged: items.filter((x) => x.flags.length).length },
    };
  }

  deleteFuelLoad(scope: TmsScope, id: string, actor: TmsActor) {
    const idx = this.state.fuelLoads.findIndex((f) => f.id === id && inScope(scope, f.tenantId));
    if (idx < 0) throw new TmsError('Carga no encontrada.', 404);
    const [f] = this.state.fuelLoads.splice(idx, 1);
    this.audit(f.tenantId, actor, 'Carga de combustible eliminada', f.id, `${f.liters} L · ${f.total} del ${f.at.slice(0, 10)}.`);
    this.ctx().persist();
  }

  /** Usual consumption of a unit (median L/100 km) and its last price per liter. */
  private fuelProfile(vehicleId: string): { litersPer100: number; pricePerLiter: number } | null {
    const loads = this.state.fuelLoads.filter((f) => f.vehicleId === vehicleId);
    const eff = [...fuelEfficiency(loads).values()].sort((a, b) => a - b);
    const last = [...loads].sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!eff.length || !last) return null;
    return { litersPer100: eff[Math.floor(eff.length / 2)], pricePerLiter: last.pricePerLiter };
  }

  // ---------------------------------------------------------------- expenses

  addExpense(
    tenantId: string,
    input: { tripId: string; type: ExpenseType; amount: number; at?: string; note?: string; paidBy?: 'chofer' | 'empresa'; receiptFileId?: string },
    actor: { name: string; role: string; hidden?: boolean },
    source: TripExpense['source'],
    approve: boolean
  ): TripExpense {
    const trip = this.state.trips.find((t) => t.id === input.tripId && t.tenantId === tenantId);
    if (!trip) throw new TmsError('Viaje no encontrado.', 404);
    if (!(input.amount > 0)) throw new TmsError('El importe debe ser mayor que 0.');
    const at = nowIso();
    const e: TripExpense = {
      id: `gas-${uid()}`,
      tenantId,
      tripId: trip.id,
      driverId: trip.driverId,
      type: input.type,
      amount: round2(input.amount),
      at: input.at ?? at,
      note: input.note?.trim() || undefined,
      paidBy: input.paidBy ?? (source === 'app' ? 'chofer' : 'empresa'),
      receiptFileId: input.receiptFileId,
      source,
      status: approve ? 'aprobado' : 'pendiente',
      reviewedBy: approve ? actor.name : undefined,
      reviewedAt: approve ? at : undefined,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
    };
    this.state.tripExpenses.push(e);
    this.audit(tenantId, actor, 'Gasto de viaje', `${trip.id} · ${EXPENSE_LABELS[e.type]}`, `${e.amount} (${e.paidBy === 'chofer' ? 'pagó el chofer' : 'pagó la empresa'}${approve ? '' : ', pendiente de aprobación'}).`);
    this.ctx().persist();
    return e;
  }

  reviewExpense(scope: TmsScope, id: string, input: { decision: 'aprobado' | 'rechazado'; reason?: string }, actor: TmsActor): TripExpense {
    const e = this.state.tripExpenses.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!e) throw new TmsError('Gasto no encontrado.', 404);
    if (e.settlementId) throw new TmsError(`El gasto ya está en la liquidación ${e.settlementId}.`, 409);
    if (input.decision === 'rechazado' && !input.reason?.trim()) throw new TmsError('Indicá por qué se rechaza.');
    e.status = input.decision;
    e.reviewedBy = actor.name;
    e.reviewedAt = nowIso();
    e.rejectReason = input.decision === 'rechazado' ? input.reason!.trim() : undefined;
    this.audit(e.tenantId, actor, input.decision === 'aprobado' ? 'Gasto aprobado' : 'Gasto rechazado', `${e.tripId} · ${EXPENSE_LABELS[e.type]}`, `${e.amount}${e.rejectReason ? ` · ${e.rejectReason}` : ''}`);
    this.ctx().persist();
    return e;
  }

  listExpenses(scope: TmsScope, f: { status?: TripExpense['status']; tripId?: string; driverId?: string } = {}) {
    const drivers = new Map(this.state.drivers.map((d) => [d.id, d.name]));
    return this.state.tripExpenses
      .filter((e) => inScope(scope, e.tenantId))
      .filter((e) => (!f.status || e.status === f.status) && (!f.tripId || e.tripId === f.tripId) && (!f.driverId || e.driverId === f.driverId))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((e) => ({ ...e, driverName: drivers.get(e.driverId) ?? '—' }));
  }

  // ---------------------------------------------------------------- trip cost & profitability

  /** km of a trip: odometer difference, or the stops' road estimate when there are no readings. */
  private tripKm(t: Trip): { km: number; source: 'odometro' | 'estimado' } {
    if (typeof t.startOdometerKm === 'number' && typeof t.endOdometerKm === 'number' && t.endOdometerKm > t.startOdometerKm) {
      return { km: Math.round(t.endOdometerKm - t.startOdometerKm), source: 'odometro' };
    }
    if (t.route && t.route.km > 0) return { km: t.route.km, source: 'estimado' };
    let km = 0;
    const places = t.stops.map((s) => this.state.places.find((p) => p.id === s.placeId)).filter(Boolean) as Array<{ lat: number; lng: number }>;
    for (let i = 1; i < places.length; i++) km += roadKm(places[i - 1], places[i]);
    return { km: Math.round(km * 10) / 10, source: 'estimado' };
  }

  /** Maintenance cost per km of a unit: last 12 months of maintenance over the km of its trips in that time. */
  private maintenancePerKm(v: Vehicle): number {
    const since = Date.now() - 365 * 86_400_000;
    const cost = this.state.maintenanceRecords.filter((m) => m.vehicleId === v.id && Date.parse(m.performedAt) >= since).reduce((a, m) => a + (m.cost ?? 0), 0);
    const km = this.state.trips.filter((t) => t.vehicleId === v.id && t.status === 'finalizado' && Date.parse(t.finishedAt ?? '') >= since).reduce((a, t) => a + this.tripKm(t).km, 0);
    // Below 1000 km the ratio is meaningless (a single repair would explode it).
    return km >= 1000 ? cost / km : 0;
  }

  economics(t: Trip): TripEconomics {
    const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
    const d = this.state.drivers.find((x) => x.id === t.driverId);
    const { km, source } = this.tripKm(t);
    const fuel = this.state.fuelLoads.filter((f) => f.tripId === t.id).reduce((a, f) => a + f.total, 0);
    const expenses = this.state.tripExpenses.filter((e) => e.tripId === t.id && e.status === 'aprobado').reduce((a, e) => a + e.amount, 0);
    const hours = t.startedAt ? Math.max(0, (Date.parse(t.finishedAt ?? nowIso()) - Date.parse(t.startedAt)) / 3_600_000) : 0;
    const cost = tripCost({
      km,
      kmSource: source,
      fuelLoadsTotal: fuel,
      fuelEstimate: v ? this.fuelProfile(v.id) : null,
      expenses,
      maintenancePerKm: v ? this.maintenancePerKm(v) : 0,
      driverHourlyCost: d?.monthlyCost ? d.monthlyCost / MONTHLY_HOURS : 0,
      hours,
    });
    const orderIds = new Set(t.stops.flatMap((s) => s.orderIds));
    const orders = this.state.transportOrders.filter((o) => orderIds.has(o.id));
    const delivered = orders.filter((o) => o.status === 'entregado');
    const revenue = round2(delivered.reduce((a, o) => a + (o.charge?.amount ?? 0), 0));
    const margin = round2(revenue - cost.total);
    return {
      tripId: t.id,
      revenue,
      unpricedOrders: delivered.filter((o) => !o.charge).map((o) => o.id),
      cost,
      margin,
      marginPct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null,
      currency: this.ctx().currencyOf(t.tenantId),
    };
  }

  tripEconomics(scope: TmsScope, tripId: string): TripEconomics {
    const t = this.state.trips.find((x) => x.id === tripId && inScope(scope, x.tenantId));
    if (!t) throw new TmsError('Viaje no encontrado.', 404);
    return this.economics(t);
  }

  /** Profitability of finished trips in a period, grouped by trip, customer, unit or driver. */
  profitability(scope: TmsScope, from: string, to: string, groupBy: 'viaje' | 'cliente' | 'unidad' | 'chofer'): { rows: ProfitRow[]; totals: ProfitRow; currency: string | null } {
    const trips = this.state.trips.filter((t) => inScope(scope, t.tenantId) && t.status === 'finalizado' && inPeriod(t.finishedAt, from, to));
    const groups = new Map<string, ProfitRow>();
    const add = (key: string, label: string, part: { trips: number; km: number; revenue: number; cost: number }) => {
      const g = groups.get(key) ?? { key, label, trips: 0, km: 0, revenue: 0, cost: 0, margin: 0, marginPct: null };
      g.trips += part.trips;
      g.km += part.km;
      g.revenue += part.revenue;
      g.cost += part.cost;
      groups.set(key, g);
    };
    for (const t of trips) {
      const e = this.economics(t);
      if (groupBy === 'cliente') {
        // The trip cost is shared among its customers in proportion to what each one pays.
        const orderIds = new Set(t.stops.flatMap((s) => s.orderIds));
        const orders = this.state.transportOrders.filter((o) => orderIds.has(o.id) && o.status === 'entregado');
        const total = orders.reduce((a, o) => a + (o.charge?.amount ?? 0), 0);
        for (const o of orders) {
          const share = total > 0 ? (o.charge?.amount ?? 0) / total : 1 / orders.length;
          const c = this.state.customers.find((x) => x.id === o.customerId);
          add(o.customerId, c?.name ?? '—', { trips: share, km: e.cost.km * share, revenue: o.charge?.amount ?? 0, cost: e.cost.total * share });
        }
        continue;
      }
      const key = groupBy === 'viaje' ? t.id : groupBy === 'unidad' ? t.vehicleId : t.driverId;
      const label =
        groupBy === 'viaje'
          ? t.id
          : groupBy === 'unidad'
            ? (this.state.vehicles.find((v) => v.id === t.vehicleId)?.unitCode ?? '—')
            : (this.state.drivers.find((d) => d.id === t.driverId)?.name ?? '—');
      add(key, label, { trips: 1, km: e.cost.km, revenue: e.revenue, cost: e.cost.total });
    }
    const finish = (g: ProfitRow): ProfitRow => {
      const revenue = round2(g.revenue);
      const cost = round2(g.cost);
      const margin = round2(revenue - cost);
      return { ...g, trips: Math.round(g.trips * 10) / 10, km: Math.round(g.km), revenue, cost, margin, marginPct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null };
    };
    const rows = [...groups.values()].map(finish).sort((a, b) => b.revenue - a.revenue);
    const totals = finish(rows.reduce((a, r) => ({ ...a, trips: a.trips + r.trips, km: a.km + r.km, revenue: a.revenue + r.revenue, cost: a.cost + r.cost }), { key: 'total', label: 'Total', trips: 0, km: 0, revenue: 0, cost: 0, margin: 0, marginPct: null } as ProfitRow));
    const currency = 'tenantId' in scope ? this.ctx().currencyOf(scope.tenantId) : null;
    return { rows, totals, currency };
  }

  // ---------------------------------------------------------------- pre-invoices

  /** Delivered orders of a customer in a period, priced and not billed yet (plus those without price). */
  billable(scope: TmsScope, customerId: string, from: string, to: string) {
    const orders = this.state.transportOrders.filter(
      (o) => inScope(scope, o.tenantId) && o.customerId === customerId && o.status === 'entregado' && inPeriod(o.deliveredAt, from, to) && !o.charge?.preInvoiceId
    );
    return { priced: orders.filter((o) => o.charge), unpriced: orders.filter((o) => !o.charge).map((o) => o.id) };
  }

  createPreInvoice(scope: TmsScope, tenantId: string, input: { customerId: string; from: string; to: string; notes?: string }, actor: TmsActor): PreInvoice {
    const customer = this.state.customers.find((c) => c.id === input.customerId && inScope(scope, c.tenantId));
    if (!customer) throw new TmsError('Cliente no encontrado.', 404);
    if (input.from > input.to) throw new TmsError('El período está invertido.');
    const { priced, unpriced } = this.billable({ tenantId: customer.tenantId }, customer.id, input.from, input.to);
    if (priced.length === 0) {
      throw new TmsError(unpriced.length ? `Hay ${unpriced.length} pedido(s) entregado(s) sin precio: asignales precio antes de pre-facturar.` : 'No hay pedidos entregados para facturar en ese período.', 409);
    }
    const id = this.nextFolio('PF', customer.tenantId, this.state.preInvoices);
    const lines = priced
      .sort((a, b) => (a.deliveredAt ?? '').localeCompare(b.deliveredAt ?? ''))
      .map((o) => {
        const orig = this.state.places.find((p) => p.id === o.originPlaceId)?.name ?? '';
        const dest = this.state.places.find((p) => p.id === o.destinationPlaceId)?.name ?? '';
        o.charge!.preInvoiceId = id;
        return { orderId: o.id, date: o.deliveredAt ?? '', description: `${o.cargo.description} · ${orig} → ${dest}`, reference: o.reference, amount: o.charge!.amount };
      });
    const pf: PreInvoice = {
      id,
      tenantId: customer.tenantId,
      customerId: customer.id,
      periodFrom: input.from,
      periodTo: input.to,
      lines,
      total: round2(lines.reduce((a, l) => a + l.amount, 0)),
      currency: this.ctx().currencyOf(customer.tenantId),
      status: 'borrador',
      notes: input.notes?.trim() || undefined,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: nowIso(),
    };
    this.state.preInvoices.push(pf);
    this.audit(pf.tenantId, actor, 'Pre-factura creada', id, `${customer.name} · ${lines.length} pedido(s) · ${pf.total}${unpriced.length ? ` · ${unpriced.length} sin precio quedaron afuera` : ''}.`);
    this.ctx().persist();
    return pf;
  }

  private findPreInvoice(scope: TmsScope, id: string) {
    const pf = this.state.preInvoices.find((p) => p.id === id && inScope(scope, p.tenantId));
    if (!pf) throw new TmsError('Pre-factura no encontrada.', 404);
    return pf;
  }

  issuePreInvoice(scope: TmsScope, id: string, actor: TmsActor): PreInvoice {
    const pf = this.findPreInvoice(scope, id);
    if (pf.status !== 'borrador') throw new TmsError('Solo se emite una pre-factura en borrador.', 409);
    pf.status = 'emitida';
    pf.issuedAt = nowIso();
    this.audit(pf.tenantId, actor, 'Pre-factura emitida', pf.id, `Total ${pf.total}.`);
    this.ctx().persist();
    return pf;
  }

  voidPreInvoice(scope: TmsScope, id: string, reason: string, actor: TmsActor): PreInvoice {
    const pf = this.findPreInvoice(scope, id);
    if (pf.status === 'anulada') throw new TmsError('La pre-factura ya está anulada.', 409);
    pf.status = 'anulada';
    pf.voidReason = reason.trim();
    // Its orders can be billed again.
    for (const l of pf.lines) {
      const o = this.state.transportOrders.find((x) => x.id === l.orderId);
      if (o?.charge?.preInvoiceId === pf.id) delete o.charge.preInvoiceId;
    }
    this.audit(pf.tenantId, actor, 'Pre-factura anulada', pf.id, reason.trim());
    this.ctx().persist();
    return pf;
  }

  listPreInvoices(scope: TmsScope) {
    const customers = new Map(this.state.customers.map((c) => [c.id, c.name]));
    return this.state.preInvoices.filter((p) => inScope(scope, p.tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => ({ ...p, customerName: customers.get(p.customerId) ?? '—' }));
  }

  preInvoice(scope: TmsScope, id: string) {
    const pf = this.findPreInvoice(scope, id);
    return { ...pf, customer: this.state.customers.find((c) => c.id === pf.customerId), tenant: this.state.tenants.find((t) => t.id === pf.tenantId) };
  }

  // ---------------------------------------------------------------- driver settlements

  createSettlement(scope: TmsScope, input: { driverId: string; from: string; to: string }, actor: TmsActor): DriverSettlement {
    const d = this.state.drivers.find((x) => x.id === input.driverId && inScope(scope, x.tenantId));
    if (!d) throw new TmsError('Chofer no encontrado.', 404);
    if (input.from > input.to) throw new TmsError('El período está invertido.');
    const expenses = this.state.tripExpenses.filter(
      (e) => e.tenantId === d.tenantId && e.driverId === d.id && e.paidBy === 'chofer' && e.status === 'aprobado' && !e.settlementId && inPeriod(e.at, input.from, input.to)
    );
    if (expenses.length === 0) {
      const pending = this.state.tripExpenses.filter((e) => e.driverId === d.id && e.status === 'pendiente' && inPeriod(e.at, input.from, input.to)).length;
      throw new TmsError(pending ? `${d.name} tiene ${pending} gasto(s) pendiente(s) de aprobar en ese período.` : `${d.name} no tiene gastos aprobados para reintegrar en ese período.`, 409);
    }
    const id = this.nextFolio('LQ', d.tenantId, this.state.driverSettlements);
    for (const e of expenses) e.settlementId = id;
    const s: DriverSettlement = {
      id,
      tenantId: d.tenantId,
      driverId: d.id,
      periodFrom: input.from,
      periodTo: input.to,
      expenseIds: expenses.map((e) => e.id),
      total: round2(expenses.reduce((a, e) => a + e.amount, 0)),
      currency: this.ctx().currencyOf(d.tenantId),
      status: 'borrador',
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: nowIso(),
    };
    this.state.driverSettlements.push(s);
    this.audit(s.tenantId, actor, 'Liquidación de viáticos', id, `${d.name} · ${expenses.length} gasto(s) · ${s.total}.`);
    this.ctx().persist();
    return s;
  }

  setSettlementStatus(scope: TmsScope, id: string, status: 'pagada' | 'anulada', actor: TmsActor): DriverSettlement {
    const s = this.state.driverSettlements.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!s) throw new TmsError('Liquidación no encontrada.', 404);
    if (s.status !== 'borrador') throw new TmsError(`La liquidación ya está ${s.status}.`, 409);
    s.status = status;
    if (status === 'pagada') {
      s.paidAt = nowIso();
      s.paidBy = actor.name;
    } else {
      for (const e of this.state.tripExpenses) if (e.settlementId === s.id) delete e.settlementId;
    }
    this.audit(s.tenantId, actor, status === 'pagada' ? 'Liquidación pagada' : 'Liquidación anulada', s.id, `Total ${s.total}.`);
    this.ctx().persist();
    return s;
  }

  listSettlements(scope: TmsScope) {
    const drivers = new Map(this.state.drivers.map((d) => [d.id, d.name]));
    return this.state.driverSettlements.filter((s) => inScope(scope, s.tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => ({ ...s, driverName: drivers.get(s.driverId) ?? '—' }));
  }

  settlement(scope: TmsScope, id: string) {
    const s = this.state.driverSettlements.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!s) throw new TmsError('Liquidación no encontrada.', 404);
    return { ...s, driverName: this.state.drivers.find((d) => d.id === s.driverId)?.name ?? '—', expenses: this.state.tripExpenses.filter((e) => s.expenseIds.includes(e.id)), tenant: this.state.tenants.find((t) => t.id === s.tenantId) };
  }

  /** Normalized plates of the company's units (import preview). */
  plates(tenantId: string): string[] {
    return this.state.vehicles.filter((v) => v.tenantId === tenantId).map((v) => normPlate(v.plate));
  }

  // ---------------------------------------------------------------- driver monthly cost / tank

  setDriverMonthlyCost(scope: TmsScope, driverId: string, monthlyCost: number | null, actor: TmsActor) {
    const d = this.state.drivers.find((x) => x.id === driverId && inScope(scope, x.tenantId));
    if (!d) throw new TmsError('Chofer no encontrado.', 404);
    if (monthlyCost === null) delete d.monthlyCost;
    else d.monthlyCost = round2(monthlyCost);
    this.audit(d.tenantId, actor, 'Costo mensual del chofer', d.name, monthlyCost === null ? 'Sin costo cargado.' : `${d.monthlyCost} por mes.`);
    this.ctx().persist();
    return d;
  }
}
