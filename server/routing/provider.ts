import { roadKm } from '../../src/shared/costs.ts';
import { evaluateRoute, planRoutes, type Matrix, type PlanResult, type Shipment, type Task, type VehicleSpec } from '../../src/shared/routing.ts';

/**
 * Routing engine: OSRM (road distances/times and geometry) and VROOM (multi-vehicle optimization)
 * when OSRM_URL / VROOM_URL are set, the built-in estimate and optimizer otherwise. Any failure or
 * timeout of the external services falls back to the built-in engine, and responses say which one
 * was used ("osrm" / "vroom" / "estimado").
 */

export type Engine = 'osrm' | 'estimado';
export interface Pt {
  lat: number;
  lng: number;
}
export interface RouteResult {
  km: number;
  minutes: number;
  legs: Array<{ km: number; minutes: number }>;
  /** [lng, lat] pairs. */
  geometry: Array<[number, number]>;
  engine: Engine;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RoutingConfig {
  osrmUrl?: string;
  vroomUrl?: string;
  /** Average speed of the built-in estimate. */
  avgKmh: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const key = (pts: Pt[]) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');

export function routingConfigFromEnv(): RoutingConfig {
  const avg = Number(process.env.ROUTING_AVG_KMH);
  return {
    osrmUrl: process.env.OSRM_URL?.trim().replace(/\/+$/, '') || undefined,
    vroomUrl: process.env.VROOM_URL?.trim().replace(/\/+$/, '') || undefined,
    avgKmh: Number.isFinite(avg) && avg > 5 && avg < 150 ? avg : 45,
  };
}

export class RoutingEngine {
  private matrixCache = new Map<string, { at: number; value: { matrix: Matrix; engine: Engine } }>();
  private statusCache: { at: number; value: { osrmOk: boolean; vroomOk: boolean } } | null = null;

  constructor(readonly config: RoutingConfig) {}

  private get fetch(): FetchLike {
    return this.config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async getJson(url: string, init: Parameters<FetchLike>[1] = {}): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 4000);
    try {
      const res = await this.fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Built-in: straight line × 1.25 at the average speed. */
  builtinMatrix(points: Pt[]): Matrix {
    const km = points.map((a) => points.map((b) => (a === b ? 0 : roadKm(a, b))));
    return { km, minutes: km.map((r) => r.map((x) => round1((x / this.config.avgKmh) * 60))) };
  }

  async matrix(points: Pt[]): Promise<{ matrix: Matrix; engine: Engine }> {
    if (!this.config.osrmUrl || points.length < 2) return { matrix: this.builtinMatrix(points), engine: 'estimado' };
    const k = key(points);
    const hit = this.matrixCache.get(k);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const j = await this.getJson(`${this.config.osrmUrl}/table/v1/driving/${coords}?annotations=distance,duration`);
      if (j?.code !== 'Ok' || !Array.isArray(j.distances) || !Array.isArray(j.durations)) throw new Error('respuesta OSRM inválida');
      // Unreachable pairs come as null: use the estimate for those.
      const est = this.builtinMatrix(points);
      const matrix: Matrix = {
        km: j.distances.map((r: Array<number | null>, i: number) => r.map((d, jj) => (d == null ? est.km[i][jj] : round1(d / 1000)))),
        minutes: j.durations.map((r: Array<number | null>, i: number) => r.map((d, jj) => (d == null ? est.minutes[i][jj] : round1(d / 60)))),
      };
      const value = { matrix, engine: 'osrm' as const };
      this.matrixCache.set(k, { at: Date.now(), value });
      if (this.matrixCache.size > 500) this.matrixCache.delete(this.matrixCache.keys().next().value!);
      return value;
    } catch (err) {
      console.warn('[ruteo] OSRM no respondió, se usa la estimación:', err instanceof Error ? err.message : err);
      return { matrix: this.builtinMatrix(points), engine: 'estimado' };
    }
  }

  /** Path through the points in order (legs + geometry). */
  async route(points: Pt[]): Promise<RouteResult> {
    const straight = (): RouteResult => {
      const m = this.builtinMatrix(points);
      const legs = points.slice(1).map((_, i) => ({ km: m.km[i][i + 1], minutes: m.minutes[i][i + 1] }));
      return { km: round1(legs.reduce((a, l) => a + l.km, 0)), minutes: Math.round(legs.reduce((a, l) => a + l.minutes, 0)), legs, geometry: points.map((p) => [p.lng, p.lat]), engine: 'estimado' };
    };
    if (points.length < 2) return { km: 0, minutes: 0, legs: [], geometry: points.map((p) => [p.lng, p.lat]), engine: this.config.osrmUrl ? 'osrm' : 'estimado' };
    if (!this.config.osrmUrl) return straight();
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const j = await this.getJson(`${this.config.osrmUrl}/route/v1/driving/${coords}?overview=simplified&geometries=geojson&steps=false`);
      const r = j?.routes?.[0];
      if (j?.code !== 'Ok' || !r) throw new Error('respuesta OSRM inválida');
      return {
        km: round1(r.distance / 1000),
        minutes: Math.round(r.duration / 60),
        legs: (r.legs ?? []).map((l: { distance: number; duration: number }) => ({ km: round1(l.distance / 1000), minutes: round1(l.duration / 60) })),
        geometry: (r.geometry?.coordinates ?? []) as Array<[number, number]>,
        engine: 'osrm',
      };
    } catch (err) {
      console.warn('[ruteo] OSRM no respondió, se usa la estimación:', err instanceof Error ? err.message : err);
      return straight();
    }
  }

  /**
   * Multi-vehicle plan: VROOM with our matrix (so VROOM needs no map of its own) when configured,
   * the built-in planner otherwise or on failure. Unassigned reasons always come from the built-in
   * check (VROOM doesn't explain them).
   */
  async plan(vehicles: VehicleSpec[], shipments: Shipment[], m: Matrix): Promise<PlanResult & { optimizer: 'vroom' | 'propio' }> {
    const builtin = planRoutes(vehicles, shipments, m);
    if (!this.config.vroomUrl || !vehicles.length || !shipments.length) return { ...builtin, optimizer: 'propio' };
    try {
      const t0 = Math.min(...vehicles.map((v) => v.availableFrom));
      const sec = (ms: number) => Math.max(0, Math.round((ms - t0) / 1000));
      const tw = (t: Task) => (t.window ? [[sec(t.window.from), Math.max(sec(t.window.from), sec(t.window.to))]] : undefined);
      const body = {
        vehicles: vehicles.map((v, i) => ({
          id: i + 1,
          start_index: v.startNode,
          capacity: [Math.round(v.capacityKg ?? 1e9), Math.round(v.capacityPallets ?? 1e6)],
          time_window: [sec(v.availableFrom), sec(v.availableTo)],
        })),
        shipments: shipments.map((s, i) => ({
          amount: [Math.round(s.weightKg), Math.round(s.pallets)],
          pickup: { id: (i + 1) * 2 - 1, location_index: s.pickup.node, service: s.pickup.service * 60, time_windows: tw(s.pickup) },
          delivery: { id: (i + 1) * 2, location_index: s.delivery.node, service: s.delivery.service * 60, time_windows: tw(s.delivery) },
        })),
        matrices: { car: { durations: m.minutes.map((r) => r.map((x) => Math.round(x * 60))), distances: m.km.map((r) => r.map((x) => Math.round(x * 1000))) } },
      };
      const j = await this.getJson(this.config.vroomUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (j?.code !== 0 || !Array.isArray(j.routes)) throw new Error(`VROOM code ${j?.code}`);
      const taskById = new Map<number, Task>();
      shipments.forEach((s, i) => {
        taskById.set((i + 1) * 2 - 1, s.pickup);
        taskById.set((i + 1) * 2, s.delivery);
      });
      const shipmentOf = (id: number) => shipments[Math.ceil(id / 2) - 1].id;
      const routes = j.routes.map((r: { vehicle: number; steps: Array<{ type: string; id?: number }> }) => {
        const v = vehicles[r.vehicle - 1];
        const steps = r.steps.filter((s) => (s.type === 'pickup' || s.type === 'delivery') && s.id !== undefined);
        const tasks = steps.map((s) => taskById.get(s.id!)!);
        return { vehicleId: v.id, tasks, eval: evaluateWith(v, tasks, m), shipmentIds: [...new Set(steps.map((s) => shipmentOf(s.id!)))] };
      });
      const assigned = new Set(routes.flatMap((r: { shipmentIds: string[] }) => r.shipmentIds));
      const unassigned = shipments
        .filter((s) => !assigned.has(s.id))
        .map((s) => builtin.unassigned.find((u) => u.id === s.id) ?? { id: s.id, reason: 'sin_lugar' as const });
      return { routes, unassigned, optimizer: 'vroom' };
    } catch (err) {
      console.warn('[ruteo] VROOM no respondió, se usa el optimizador propio:', err instanceof Error ? err.message : err);
      return { ...builtin, optimizer: 'propio' };
    }
  }

  /** Whether OSRM and VROOM answer (cached for a minute). */
  async status(): Promise<{ engine: 'osrm+vroom' | 'osrm' | 'vroom' | 'estimado'; osrmConfigured: boolean; vroomConfigured: boolean; osrmOk: boolean; vroomOk: boolean }> {
    const { osrmUrl, vroomUrl } = this.config;
    if (!this.statusCache || Date.now() - this.statusCache.at > 60_000) {
      const osrmOk = osrmUrl ? await this.getJson(`${osrmUrl}/route/v1/driving/-68.5364,-31.5375;-68.5360,-31.5770?overview=false`).then((j) => j?.code === 'Ok').catch(() => false) : false;
      const vroomOk = vroomUrl
        ? await this.getJson(vroomUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vehicles: [{ id: 1, start_index: 0 }], jobs: [{ id: 1, location_index: 1 }], matrices: { car: { durations: [[0, 60], [60, 0]] } } }),
          })
            .then((j) => j?.code === 0)
            .catch(() => false)
        : false;
      this.statusCache = { at: Date.now(), value: { osrmOk, vroomOk } };
    }
    const { osrmOk, vroomOk } = this.statusCache.value;
    return {
      engine: osrmOk && vroomOk ? 'osrm+vroom' : osrmOk ? 'osrm' : vroomOk ? 'vroom' : 'estimado',
      osrmConfigured: Boolean(osrmUrl),
      vroomConfigured: Boolean(vroomUrl),
      osrmOk,
      vroomOk,
    };
  }
}

const evaluateWith = (v: VehicleSpec, tasks: Task[], m: Matrix) => evaluateRoute(v, tasks, m, { allowLate: true });
