import crypto from 'crypto';
import type { AlertEvent, AuditLog, Driver, FleetStoreState, Vehicle } from '../../src/shared/types.ts';
import { computeDriverAuthorization } from '../../src/shared/drivers.ts';
import { tripRange, type Place, type Trip, type TripStop, type AssignmentCheck } from '../../src/shared/tms.ts';
import {
  DEFAULT_SERVICE_MINUTES,
  etasFrom,
  evaluateRoute,
  sequenceRoute,
  stopOrderFromTasks,
  UNASSIGNED_LABELS,
  type Shipment,
  type Task,
  type UnassignedReason,
  type VehicleSpec,
} from '../../src/shared/routing.ts';
import { TmsError, type TmsActor, type TmsScope, type TmsService } from '../tms/service.ts';
import type { Pt, RoutingEngine } from './provider.ts';

interface Ctx {
  state: FleetStoreState;
  tms: TmsService;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const OPEN_WO = new Set(['abierta', 'en_taller', 'esperando_refacciones']);
/** How long a planned working day of a unit can be. */
const DAY_SPAN_MS = 14 * 3600_000;
const task = (o: string, k: 'carga' | 'descarga') => `${o}:${k === 'carga' ? 'c' : 'd'}`;

export interface PlanInput {
  startTime: string;
  orderIds: string[];
  vehicleIds: string[];
  depotPlaceId?: string;
}

export interface Proposal {
  vehicleId: string;
  unitCode: string;
  plate: string;
  driverId: string | null;
  driverName: string | null;
  plannedStart: string;
  orderIds: string[];
  taskOrder: string[];
  stops: Array<{ taskId: string; orderId: string; kind: 'carga' | 'descarga'; placeName: string; lat: number; lng: number; arrival: string; lateMinutes: number }>;
  km: number;
  minutes: number;
  endAt: string;
  load: { maxKg: number; capacityKg?: number; maxPallets: number; capacityPallets?: number };
  check: AssignmentCheck | null;
  start: { lat: number; lng: number };
}

/**
 * TMS T4: route optimization of a trip, route + ETAs, day planner (which unit takes which orders,
 * in which order), dispatch board and live ETAs with the "expected delay" alert.
 */
export class RoutingService {
  constructor(
    private readonly ctx: () => Ctx,
    readonly engine: RoutingEngine
  ) {}

  private get state() {
    return this.ctx().state;
  }

  private place(id: string): Place | undefined {
    return this.state.places.find((p) => p.id === id);
  }

  private service(placeId: string) {
    return this.place(placeId)?.serviceMinutes ?? DEFAULT_SERVICE_MINUTES;
  }

  private findTrip(scope: TmsScope, id: string): Trip {
    const t = this.state.trips.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!t) throw new TmsError('Viaje no encontrado.', 404);
    return t;
  }

  private window(w?: { from: string; to: string }) {
    return w ? { from: Date.parse(w.from), to: Date.parse(w.to) } : undefined;
  }

  /** Stop-level tasks of a trip: an unloading stop requires the loading stops of its orders. */
  private stopTasks(t: Trip, stops: TripStop[], firstNode: number): Task[] {
    return stops.map((s, i) => ({
      id: s.id,
      node: firstNode + i,
      service: this.service(s.placeId),
      window: this.window(s.window),
      deltaKg: 0,
      deltaPallets: 0,
      requires: s.kind === 'descarga' ? t.stops.filter((x) => x.kind === 'carga' && x.orderIds.some((o) => s.orderIds.includes(o))).map((x) => x.id) : [],
    }));
  }

  // ---------------------------------------------------------------- one trip

  /** Proposed stop order of a planned trip (nothing is saved). */
  async optimizeTrip(scope: TmsScope, tripId: string) {
    const t = this.findTrip(scope, tripId);
    if (t.status !== 'planificado') throw new TmsError('Solo se reordena un viaje planificado.', 409);
    const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
    if (!v) throw new TmsError('Unidad no encontrada.', 404);
    const places = t.stops.map((s) => this.place(s.placeId)!);
    const { matrix, engine } = await this.engine.matrix([{ lat: v.lat, lng: v.lng }, ...places]);
    const tasks = this.stopTasks(t, t.stops, 1);
    const spec: VehicleSpec = { id: v.id, startNode: 0, availableFrom: Date.parse(t.plannedStart), availableTo: Date.parse(t.plannedStart) + DAY_SPAN_MS };
    const current = evaluateRoute(spec, tasks, matrix, { allowLate: true });
    const best = sequenceRoute(spec, tasks, matrix);
    const summary = (order: Task[], e: typeof current) => ({
      order: order.map((x) => x.id),
      km: e.km,
      minutes: e.minutes,
      lateStops: e.lateness.filter((x) => x > 0).length,
    });
    const proposed = best.eval.km <= current.km || best.eval.lateness.reduce((a, x) => a + x, 0) < current.lateness.reduce((a, x) => a + x, 0) ? best : { order: tasks, eval: current, exact: best.exact };
    return {
      engine,
      exact: best.exact,
      current: summary(tasks, current),
      proposed: summary(proposed.order, proposed.eval),
      changed: proposed.order.some((x, i) => x.id !== tasks[i].id),
    };
  }

  /** Route geometry, legs and ETA of each stop (live from the unit when the trip is running). */
  async tripRoute(scope: TmsScope, tripId: string, now = new Date()) {
    const t = this.findTrip(scope, tripId);
    const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
    const running = t.status === 'en_curso';
    const pending = running ? t.stops.filter((s) => s.status === 'pendiente' || s.status === 'en_lugar') : t.stops;
    const fromUnit = v && (running || t.status === 'planificado');
    const points: Pt[] = [...(fromUnit ? [{ lat: v!.lat, lng: v!.lng }] : []), ...pending.map((s) => this.place(s.placeId)!).filter(Boolean)];
    const route = await this.engine.route(points);
    const legs = fromUnit ? route.legs.map((l) => l.minutes) : [0, ...route.legs.map((l) => l.minutes)];
    const startMs = running ? now.getTime() : Date.parse(t.plannedStart);
    const etas =
      t.status === 'finalizado' || t.status === 'cancelado'
        ? []
        : etasFrom(
            startMs,
            legs,
            pending.map((s) => ({ service: s.status === 'en_lugar' ? 0 : this.service(s.placeId), window: this.window(s.window) }))
          ).map((e, i) => ({ stopId: pending[i].id, eta: new Date(e.eta).toISOString(), lateMinutes: e.lateMinutes }));
    if (t.status === 'planificado') {
      t.route = { km: route.km, minutes: route.minutes, engine: route.engine, computedAt: now.toISOString() };
      this.ctx().persist();
    }
    return { tripId: t.id, engine: route.engine, km: route.km, minutes: route.minutes, geometry: route.geometry, etas, fromUnit: Boolean(fromUnit) };
  }

  // ---------------------------------------------------------------- planner

  /** Units and drivers available to plan from a start time (with the reason when they aren't). */
  candidates(tenantId: string, startIso: string) {
    const from = Date.parse(startIso);
    const to = from + DAY_SPAN_MS;
    const busy = (t: Trip) => {
      if (t.status !== 'planificado' && t.status !== 'en_curso') return false;
      const r = tripRange(t.plannedStart, this.ordersOf(t));
      return r.from < to && from < r.to;
    };
    const trips = this.state.trips.filter((t) => t.tenantId === tenantId);
    const vehicles = this.state.vehicles
      .filter((v) => v.tenantId === tenantId && v.assetType === 'vehiculo')
      .map((v) => {
        const wo = this.state.workOrders.find((w) => w.vehicleId === v.id && OPEN_WO.has(w.status) && w.priority === 'critica');
        const last = this.state.checklists.filter((c) => c.vehicleId === v.id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
        const trip = trips.find((t) => t.vehicleId === v.id && busy(t));
        const reason = wo ? `OT crítica ${wo.id} abierta` : last?.review?.decision === 'no_apto' ? `Checklist ${last.id} «No apto»` : trip ? `Asignada al viaje ${trip.id}` : null;
        return { id: v.id, unitCode: v.unitCode, plate: v.plate, capacityKg: v.capacityKg, capacityPallets: v.capacityPallets, driverId: v.driverId, available: !reason, reason };
      });
    const drivers = this.state.drivers
      .filter((d) => d.tenantId === tenantId)
      .map((d) => {
        const auth = computeDriverAuthorization(d);
        const trip = trips.find((t) => t.driverId === d.id && busy(t));
        const ok = auth.state === 'habilitado' || auth.state === 'por_vencer';
        return { id: d.id, name: d.name, available: ok && !trip, reason: !ok ? auth.reasons[0] ?? 'No habilitado' : trip ? `Asignado al viaje ${trip.id}` : null };
      });
    return { vehicles, drivers };
  }

  private ordersOf(t: Trip) {
    const ids = new Set(t.stops.flatMap((s) => s.orderIds));
    return this.state.transportOrders.filter((o) => ids.has(o.id));
  }

  /** Proposed trips for the selected orders and units (nothing is saved). */
  async plan(tenantId: string, input: PlanInput) {
    const start = Date.parse(input.startTime);
    if (!Number.isFinite(start)) throw new TmsError('Hora de salida inválida.');
    const orders = input.orderIds.map((id) => {
      const o = this.state.transportOrders.find((x) => x.id === id && x.tenantId === tenantId);
      if (!o) throw new TmsError(`Pedido ${id} no encontrado.`, 404);
      if (o.status !== 'confirmado') throw new TmsError(`El pedido ${o.id} no está confirmado.`, 409);
      return o;
    });
    const cand = this.candidates(tenantId, input.startTime);
    const excluded = input.vehicleIds
      .map((id) => cand.vehicles.find((v) => v.id === id))
      .filter((v): v is NonNullable<typeof v> => Boolean(v) && !v!.available)
      .map((v) => ({ vehicleId: v.id, unitCode: v.unitCode, reason: v.reason! }));
    const vehicles: Vehicle[] = input.vehicleIds
      .map((id) => this.state.vehicles.find((v) => v.id === id && v.tenantId === tenantId))
      .filter((v): v is Vehicle => Boolean(v) && cand.vehicles.some((c) => c.id === v!.id && c.available));
    if (orders.length === 0) throw new TmsError('Elegí al menos un pedido confirmado.');
    if (vehicles.length === 0) throw new TmsError('Elegí al menos una unidad disponible.', 409);
    const depot = input.depotPlaceId ? this.state.places.find((p) => p.id === input.depotPlaceId && p.tenantId === tenantId) : undefined;
    if (input.depotPlaceId && !depot) throw new TmsError('Depósito no encontrado.', 404);

    // Nodes: one start per unit, then every place used by the orders.
    const placeIds = [...new Set(orders.flatMap((o) => [o.originPlaceId, o.destinationPlaceId]))];
    const starts: Pt[] = vehicles.map((v) => (depot ? { lat: depot.lat, lng: depot.lng } : { lat: v.lat, lng: v.lng }));
    const points = [...starts, ...placeIds.map((id) => this.place(id)!)];
    const nodeOf = (placeId: string) => vehicles.length + placeIds.indexOf(placeId);
    const { matrix, engine } = await this.engine.matrix(points);
    const specs: VehicleSpec[] = vehicles.map((v, i) => ({ id: v.id, startNode: i, availableFrom: start, availableTo: start + DAY_SPAN_MS, capacityKg: v.capacityKg, capacityPallets: v.capacityPallets }));
    const shipments: Shipment[] = orders.map((o) => ({
      id: o.id,
      weightKg: o.cargo.weightKg ?? 0,
      pallets: o.cargo.pallets ?? 0,
      pickup: { id: task(o.id, 'carga'), node: nodeOf(o.originPlaceId), service: this.service(o.originPlaceId), window: this.window(o.pickupWindow), deltaKg: o.cargo.weightKg ?? 0, deltaPallets: o.cargo.pallets ?? 0, requires: [] },
      delivery: {
        id: task(o.id, 'descarga'),
        node: nodeOf(o.destinationPlaceId),
        service: this.service(o.destinationPlaceId),
        window: this.window(o.deliveryWindow),
        deltaKg: -(o.cargo.weightKg ?? 0),
        deltaPallets: -(o.cargo.pallets ?? 0),
        requires: [task(o.id, 'carga')],
      },
    }));
    const result = await this.engine.plan(specs, shipments, matrix);

    // Drivers: the unit's own when available, otherwise the first free authorized one.
    const used = new Set<string>();
    const freeDrivers = cand.drivers.filter((d) => d.available);
    const proposals: Proposal[] = result.routes.map((r) => {
      const v = vehicles.find((x) => x.id === r.vehicleId)!;
      const own = freeDrivers.find((d) => d.id === v.driverId && !used.has(d.id));
      const driver = own ?? freeDrivers.find((d) => !used.has(d.id));
      if (driver) used.add(driver.id);
      const orderIds = r.shipmentIds;
      const check = driver ? this.ctx().tms.validate(tenantId, { vehicleId: v.id, driverId: driver.id, plannedStart: new Date(start).toISOString(), orderIds }) : null;
      return {
        vehicleId: v.id,
        unitCode: v.unitCode,
        plate: v.plate,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        plannedStart: new Date(start).toISOString(),
        orderIds,
        taskOrder: r.tasks.map((t) => t.id),
        stops: r.tasks.map((t, i) => {
          const [orderId, k] = t.id.split(':');
          const o = orders.find((x) => x.id === orderId)!;
          const p = this.place(k === 'c' ? o.originPlaceId : o.destinationPlaceId)!;
          return { taskId: t.id, orderId, kind: k === 'c' ? 'carga' : 'descarga', placeName: p.name, lat: p.lat, lng: p.lng, arrival: new Date(r.eval.arrivals[i]).toISOString(), lateMinutes: r.eval.lateness[i] };
        }),
        km: r.eval.km,
        minutes: r.eval.minutes,
        endAt: new Date(r.eval.endAt).toISOString(),
        load: { maxKg: r.eval.maxKg, capacityKg: v.capacityKg, maxPallets: r.eval.maxPallets, capacityPallets: v.capacityPallets },
        check,
        start: starts[vehicles.indexOf(v)],
      };
    });
    return {
      engine,
      optimizer: result.optimizer,
      proposals,
      unassigned: result.unassigned.map((u) => ({ orderId: u.id, reason: u.reason as UnassignedReason, message: UNASSIGNED_LABELS[u.reason as UnassignedReason] })),
      excluded,
      noDriver: proposals.some((p) => !p.driverId),
    };
  }

  /** Creates the trips of the accepted proposals; one failing doesn't stop the others. */
  applyPlan(
    tenantId: string,
    proposals: Array<{ vehicleId: string; driverId: string; plannedStart: string; orderIds: string[]; taskOrder: string[]; acceptWarnings?: { reason: string } }>,
    actor: TmsActor
  ) {
    const tms = this.ctx().tms;
    const created: Array<{ tripId: string; vehicleId: string }> = [];
    const failed: Array<{ vehicleId: string; error: string }> = [];
    for (const p of proposals) {
      try {
        const trip = tms.createTrip(tenantId, { vehicleId: p.vehicleId, driverId: p.driverId, plannedStart: p.plannedStart, orderIds: p.orderIds, acceptWarnings: p.acceptWarnings }, actor);
        const order = stopOrderFromTasks(p.taskOrder.map((id) => ({ id })), trip.stops, task);
        if (order.some((id, i) => id !== trip.stops[i].id)) tms.updateTrip({ tenantId }, trip.id, { stopOrder: order }, actor);
        created.push({ tripId: trip.id, vehicleId: p.vehicleId });
      } catch (err) {
        failed.push({ vehicleId: p.vehicleId, error: err instanceof Error ? err.message : 'error' });
      }
    }
    if (created.length) {
      this.ctx().audit({
        tenantId,
        actorName: actor.name,
        actorRole: actor.role,
        actorHidden: actor.hidden,
        module: 'Operaciones · Ruteo',
        action: 'Plan del día aplicado',
        targetLabel: created.map((c) => c.tripId).join(', '),
        detail: `${created.length} viaje(s) creado(s)${failed.length ? `, ${failed.length} con error` : ''}.`,
      });
    }
    return { created, failed };
  }

  // ---------------------------------------------------------------- dispatch board

  dispatch(scope: TmsScope, fromIso: string, toIso: string, now = new Date()) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!(from < to)) throw new TmsError('Rango inválido.');
    const vehicles = this.state.vehicles.filter((v) => inScope(scope, v.tenantId) && v.assetType === 'vehiculo');
    const drivers = new Map(this.state.drivers.map((d: Driver) => [d.id, d.name]));
    const rows = vehicles.map((v) => {
      const trips = this.state.trips
        .filter((t) => t.vehicleId === v.id && t.status !== 'cancelado')
        .map((t) => {
          const startAt = Date.parse(t.startedAt ?? t.plannedStart);
          const lastEta = [...t.stops].reverse().find((s) => s.eta)?.eta;
          const estEnd = t.finishedAt
            ? Date.parse(t.finishedAt)
            : lastEta
              ? Date.parse(lastEta) + this.service(t.stops[t.stops.length - 1].placeId) * 60_000
              : t.route
                ? Date.parse(t.plannedStart) + t.route.minutes * 60_000 + t.stops.reduce((a, s) => a + this.service(s.placeId), 0) * 60_000
                : tripRange(t.plannedStart, this.ordersOf(t)).to;
          return { t, startAt, endAt: Math.max(estEnd, startAt + 15 * 60_000) };
        })
        .filter((x) => x.startAt < to && from < x.endAt)
        .map(({ t, startAt, endAt }) => ({
          id: t.id,
          status: t.status,
          driverName: drivers.get(t.driverId) ?? '—',
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          estimatedEnd: !t.finishedAt,
          late: t.stops.some((s) => (s.status === 'pendiente' || s.status === 'en_lugar') && s.window && (Date.parse(s.eta ?? '') > Date.parse(s.window.to) || (s.kind === 'descarga' && Date.parse(s.window.to) < now.getTime()))),
          stops: t.stops.map((s) => {
            const real = s.departedAt ?? s.arrivedAt;
            const at = real ?? s.eta ?? null;
            return {
              seq: s.seq,
              kind: s.kind,
              placeName: this.place(s.placeId)?.name ?? '—',
              status: s.status,
              at,
              estimated: !real,
              late: Boolean(s.window && at && Date.parse(at) > Date.parse(s.window.to)),
            };
          }),
        }));
      return { vehicleId: v.id, unitCode: v.unitCode, plate: v.plate, trips };
    });
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      now: now.toISOString(),
      rows: rows.filter((r) => r.trips.length).sort((a, b) => a.unitCode.localeCompare(b.unitCode)),
      idle: rows.filter((r) => !r.trips.length).map((r) => ({ vehicleId: r.vehicleId, unitCode: r.unitCode, plate: r.plate })),
    };
  }

  // ---------------------------------------------------------------- live ETAs

  runningTrips(scope: TmsScope): Trip[] {
    return this.state.trips.filter((t) => t.status === 'en_curso' && inScope(scope, t.tenantId));
  }

  /**
   * ETAs of the pending stops of running trips (every 2 minutes per trip at most) and the
   * "expected delay" alert when an unloading is predicted to arrive after its window closes
   * (raised once per stop, before the window expires).
   */
  async refreshEtas(now = new Date()): Promise<number> {
    let changed = 0;
    for (const t of this.state.trips.filter((x) => x.status === 'en_curso')) {
      if (t.etaComputedAt && now.getTime() - Date.parse(t.etaComputedAt) < 2 * 60_000) continue;
      const v = this.state.vehicles.find((x) => x.id === t.vehicleId);
      if (!v?.lastReportAt || now.getTime() - Date.parse(v.lastReportAt) > 30 * 60_000) continue;
      const pending = t.stops.filter((s) => s.status === 'pendiente' || s.status === 'en_lugar');
      if (!pending.length) continue;
      const route = await this.engine.route([{ lat: v.lat, lng: v.lng }, ...pending.map((s) => this.place(s.placeId)!).filter(Boolean)]);
      const etas = etasFrom(
        now.getTime(),
        route.legs.map((l) => l.minutes),
        pending.map((s) => ({ service: s.status === 'en_lugar' ? 0 : this.service(s.placeId), window: this.window(s.window) }))
      );
      t.etaComputedAt = now.toISOString();
      pending.forEach((s, i) => {
        s.eta = new Date(etas[i].eta).toISOString();
        const windowOpen = s.window && Date.parse(s.window.to) > now.getTime();
        if (s.kind === 'descarga' && s.status === 'pendiente' && windowOpen && etas[i].lateMinutes > 0 && !s.etaLateAlertedAt && !s.delayAlertedAt) {
          s.etaLateAlertedAt = now.toISOString();
          this.raiseExpectedDelay(t, s, v, etas[i].lateMinutes, now);
          t.history = [
            { at: now.toISOString(), actor: 'Seguimiento automático', action: 'Demora prevista', detail: `${this.place(s.placeId)?.name ?? ''}: llegaría ${etas[i].lateMinutes} min después de la ventana.` },
            ...(t.history ?? []),
          ].slice(0, 100);
        }
      });
      changed += 1;
    }
    if (changed) this.ctx().persist();
    return changed;
  }

  private raiseExpectedDelay(t: Trip, s: TripStop, v: Vehicle, lateMinutes: number, now: Date) {
    const driver = this.state.drivers.find((d) => d.id === t.driverId);
    const alert: AlertEvent = {
      id: `alr-${uid()}`,
      tenantId: t.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      plate: v.plate,
      driverName: driver?.name ?? v.driverName,
      ruleId: 'tms-eta-late',
      ruleName: 'Demora prevista',
      priority: 'media',
      status: 'pendiente',
      lat: v.lat,
      lng: v.lng,
      speedKmh: v.speedKmh,
      timestamp: now.toISOString(),
      clipId: null,
      summary: `Viaje ${t.id}: llegaría a ${this.place(s.placeId)?.name ?? 'destino'} unos ${lateMinutes} min tarde (ventana hasta las ${new Date(s.window!.to).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}). Avisá al cliente.`,
    };
    this.state.alerts.unshift(alert);
  }
}
