/**
 * TMS T4: route sequencing and day planning (pure, testable; no I/O).
 *
 * Everything works on a distance/time matrix between "nodes" (places and unit start points),
 * which comes from OSRM when configured or from the built-in estimate (straight line × 1.25 at
 * an average speed). A route is a sequence of tasks (one loading or unloading at a node) that
 * respects precedence (load before unload), capacity and time windows.
 */

export interface Matrix {
  /** km[i][j] and minutes[i][j] between nodes i and j. */
  km: number[][];
  minutes: number[][];
}

export interface Window {
  /** Epoch ms. */
  from: number;
  to: number;
}

export interface Task {
  id: string;
  node: number;
  /** Minutes spent at the place (loading / unloading). */
  service: number;
  window?: Window;
  /** Load change when the task is done (+ loading, − unloading). */
  deltaKg: number;
  deltaPallets: number;
  /** Tasks that must come before this one (loading of the same order). */
  requires: string[];
}

export interface VehicleSpec {
  id: string;
  startNode: number;
  /** Epoch ms when it can leave, and the latest it can still be working. */
  availableFrom: number;
  availableTo: number;
  capacityKg?: number;
  capacityPallets?: number;
}

export interface RouteEval {
  feasible: boolean;
  /** Why it isn't feasible (first problem found). */
  problem?: 'precedencia' | 'capacidad' | 'ventana' | 'horario';
  km: number;
  minutes: number;
  /** Arrival and departure time (epoch ms) of each task, in order. */
  arrivals: number[];
  departures: number[];
  /** Minutes late at each task (0 when on time). */
  lateness: number[];
  endAt: number;
  maxKg: number;
  maxPallets: number;
}

const MIN = 60_000;

/** Walks a route from the vehicle's start: travel, wait for the window to open, service. */
export function evaluateRoute(v: VehicleSpec, tasks: Task[], m: Matrix, opts: { allowLate?: boolean } = {}): RouteEval {
  let at = v.availableFrom;
  let node = v.startNode;
  let km = 0;
  let kg = 0;
  let pallets = 0;
  let maxKg = 0;
  let maxPallets = 0;
  const done = new Set<string>();
  // Requirements outside this route (e.g. stops already done) don't apply.
  const inRoute = new Set(tasks.map((t) => t.id));
  const arrivals: number[] = [];
  const departures: number[] = [];
  const lateness: number[] = [];
  let problem: RouteEval['problem'];
  for (const t of tasks) {
    if (!problem && t.requires.some((r) => inRoute.has(r) && !done.has(r))) problem = 'precedencia';
    km += m.km[node][t.node];
    at += m.minutes[node][t.node] * MIN;
    if (t.window && at < t.window.from) at = t.window.from;
    const late = t.window && at > t.window.to ? Math.round((at - t.window.to) / MIN) : 0;
    if (late && !opts.allowLate && !problem) problem = 'ventana';
    arrivals.push(at);
    lateness.push(late);
    at += t.service * MIN;
    departures.push(at);
    kg += t.deltaKg;
    pallets += t.deltaPallets;
    maxKg = Math.max(maxKg, kg);
    maxPallets = Math.max(maxPallets, pallets);
    if (!problem && ((v.capacityKg !== undefined && kg > v.capacityKg + 1e-6) || (v.capacityPallets !== undefined && pallets > v.capacityPallets))) problem = 'capacidad';
    done.add(t.id);
    node = t.node;
  }
  if (!problem && at > v.availableTo) problem = 'horario';
  return {
    feasible: !problem,
    problem,
    km: Math.round(km * 10) / 10,
    minutes: Math.round((at - v.availableFrom) / MIN),
    arrivals,
    departures,
    lateness,
    endAt: at,
    maxKg,
    maxPallets,
  };
}

/** Cost used to compare routes: km, plus a little for time so equal-km routes prefer shorter days. */
const cost = (e: RouteEval) => e.km + e.minutes / 60;
const lateSum = (e: RouteEval) => e.lateness.reduce((a, x) => a + x, 0);
/** a better than b: less lateness first, then lower cost. */
const better = (a: RouteEval, b: RouteEval) => lateSum(a) < lateSum(b) || (lateSum(a) === lateSum(b) && cost(a) < cost(b) - 1e-6);

// ---------------------------------------------------------------- single route sequencing

/**
 * Best order for the tasks of one route.
 * - Up to 8 tasks: exhaustive search over the orders that respect precedence (exact).
 * - More: cheapest insertion in the given order + relocation improvement.
 * When no order meets every window, the one with the least total lateness wins (flagged).
 */
export function sequenceRoute(v: VehicleSpec, tasks: Task[], m: Matrix): { order: Task[]; eval: RouteEval; exact: boolean; allOnTime: boolean } {
  if (tasks.length <= 8) {
    let best: { order: Task[]; e: RouteEval; late: number } | null = null;
    const chosen: Task[] = [];
    const used = new Set<string>();
    const dfs = () => {
      if (chosen.length === tasks.length) {
        const e = evaluateRoute(v, chosen, m, { allowLate: true });
        if (e.problem === 'precedencia' || e.problem === 'capacidad') return;
        const late = e.lateness.reduce((a, x) => a + x, 0);
        if (!best || late < best.late || (late === best.late && cost(e) < cost(best.e))) best = { order: [...chosen], e, late };
        return;
      }
      for (const t of tasks) {
        if (used.has(t.id) || t.requires.some((r) => !used.has(r) && tasks.some((x) => x.id === r))) continue;
        used.add(t.id);
        chosen.push(t);
        dfs();
        chosen.pop();
        used.delete(t.id);
      }
    };
    dfs();
    if (best) {
      const b = best as { order: Task[]; e: RouteEval; late: number };
      return { order: b.order, eval: b.e, exact: true, allOnTime: b.late === 0 };
    }
  }
  // Heuristic: insert tasks one by one where they add the least, then try relocating each.
  let order: Task[] = [];
  for (const t of tasks) order = bestInsertion(v, order, [t], m, true)?.route ?? [...order, t];
  order = relocate(v, order, m, true);
  const e = evaluateRoute(v, order, m, { allowLate: true });
  return { order, eval: e, exact: false, allOnTime: e.lateness.every((x) => x === 0) };
}

/** Cheapest feasible way to insert a group of tasks (1 or a load→unload pair) into a route. */
function bestInsertion(v: VehicleSpec, route: Task[], group: Task[], m: Matrix, allowLate: boolean): { route: Task[]; eval: RouteEval } | null {
  let best: { route: Task[]; eval: RouteEval } | null = null;
  const consider = (candidate: Task[]) => {
    const e = evaluateRoute(v, candidate, m, { allowLate });
    if (!e.feasible && !(allowLate && (e.problem === 'ventana' || e.problem === 'horario'))) return;
    if (!best || better(e, best.eval)) best = { route: candidate, eval: e };
  };
  if (group.length === 1) {
    for (let i = 0; i <= route.length; i++) consider([...route.slice(0, i), group[0], ...route.slice(i)]);
  } else {
    const [a, b] = group;
    for (let i = 0; i <= route.length; i++) {
      for (let j = i; j <= route.length; j++) {
        const withA = [...route.slice(0, i), a, ...route.slice(i)];
        consider([...withA.slice(0, j + 1), b, ...withA.slice(j + 1)]);
      }
    }
  }
  return best;
}

/** Moves each task to its best position while that improves the route (precedence kept). */
function relocate(v: VehicleSpec, route: Task[], m: Matrix, allowLate: boolean): Task[] {
  let current = route;
  let currentEval = evaluateRoute(v, current, m, { allowLate });
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const t of [...current]) {
      const without = current.filter((x) => x.id !== t.id);
      const ins = bestInsertion(v, without, [t], m, allowLate);
      if (ins && better(ins.eval, currentEval)) {
        current = ins.route;
        currentEval = ins.eval;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return current;
}

// ---------------------------------------------------------------- day planning (several units)

export interface Shipment {
  /** Order id. */
  id: string;
  pickup: Task;
  delivery: Task;
  weightKg: number;
  pallets: number;
}

export type UnassignedReason = 'capacidad' | 'ventana' | 'sin_lugar';

export const UNASSIGNED_LABELS: Record<UnassignedReason, string> = {
  capacidad: 'La carga supera la capacidad de todas las unidades elegidas.',
  ventana: 'Ninguna unidad llega a tiempo a su ventana horaria.',
  sin_lugar: 'Las unidades elegidas ya no tienen capacidad o tiempo para sumarlo.',
};

export interface PlanResult {
  routes: Array<{ vehicleId: string; tasks: Task[]; eval: RouteEval; shipmentIds: string[] }>;
  unassigned: Array<{ id: string; reason: UnassignedReason }>;
}

/**
 * Assigns shipments to vehicles and orders their stops: the most urgent shipments first, each
 * into the vehicle and positions that add the least (cheapest feasible insertion), then a
 * relocation pass per route. Vehicles without shipments are left out of the result.
 */
export function planRoutes(vehicles: VehicleSpec[], shipments: Shipment[], m: Matrix): PlanResult {
  const routes = new Map<string, Task[]>(vehicles.map((v) => [v.id, []]));
  const owner = new Map<string, string>();
  const unassigned: PlanResult['unassigned'] = [];
  const urgency = (s: Shipment) => s.delivery.window?.to ?? s.pickup.window?.to ?? Number.MAX_SAFE_INTEGER;
  for (const s of [...shipments].sort((a, b) => urgency(a) - urgency(b))) {
    let best: { vehicleId: string; route: Task[]; delta: number } | null = null;
    for (const v of vehicles) {
      const route = routes.get(v.id)!;
      const before = cost(evaluateRoute(v, route, m));
      const ins = bestInsertion(v, route, [s.pickup, s.delivery], m, false);
      if (!ins) continue;
      const delta = cost(ins.eval) - before;
      if (!best || delta < best.delta) best = { vehicleId: v.id, route: ins.route, delta };
    }
    if (best) {
      routes.set(best.vehicleId, best.route);
      owner.set(s.id, best.vehicleId);
      continue;
    }
    // Why not: alone in an empty unit?
    const fitsSomewhere = vehicles.some(
      (v) => (v.capacityKg === undefined || s.weightKg <= v.capacityKg) && (v.capacityPallets === undefined || s.pallets <= v.capacityPallets)
    );
    if (!fitsSomewhere) unassigned.push({ id: s.id, reason: 'capacidad' });
    else if (!vehicles.some((v) => evaluateRoute(v, [s.pickup, s.delivery], m).feasible)) unassigned.push({ id: s.id, reason: 'ventana' });
    else unassigned.push({ id: s.id, reason: 'sin_lugar' });
  }
  const result: PlanResult = { routes: [], unassigned };
  for (const v of vehicles) {
    const route = relocate(v, routes.get(v.id)!, m, false);
    if (!route.length) continue;
    result.routes.push({ vehicleId: v.id, tasks: route, eval: evaluateRoute(v, route, m), shipmentIds: [...owner.entries()].filter(([, vid]) => vid === v.id).map(([id]) => id) });
  }
  return result;
}

/**
 * A route of per-order tasks → the trip's grouped stops order. Loading stops go where their first
 * loading appears, unloading stops where their last unloading appears, so grouping never puts an
 * unloading before its loading.
 */
export function stopOrderFromTasks(
  tasks: Array<{ id: string }>,
  stops: Array<{ id: string; kind: 'carga' | 'descarga' | 'paso'; orderIds: string[] }>,
  taskOf: (orderId: string, kind: 'carga' | 'descarga') => string
): string[] {
  const pos = new Map(tasks.map((t, i) => [t.id, i]));
  const rank = (s: (typeof stops)[number]) => {
    const kind = s.kind === 'descarga' ? 'descarga' : 'carga';
    const positions = s.orderIds.map((o) => pos.get(taskOf(o, kind)) ?? Number.MAX_SAFE_INTEGER);
    return kind === 'carga' ? Math.min(...positions) : Math.max(...positions);
  };
  return [...stops].sort((a, b) => rank(a) - rank(b) || (a.kind === 'carga' ? -1 : 1)).map((s) => s.id);
}

// ---------------------------------------------------------------- ETA

/**
 * ETA of the remaining stops from the unit's position: legs in minutes between consecutive points
 * (position → stop 1 → stop 2…), waiting for windows to open, plus the service time at each stop.
 */
export function etasFrom(nowMs: number, legMinutes: number[], stops: Array<{ service: number; window?: Window }>): Array<{ eta: number; lateMinutes: number }> {
  let at = nowMs;
  return stops.map((s, i) => {
    at += (legMinutes[i] ?? 0) * MIN;
    const eta = at;
    if (s.window && at < s.window.from) at = s.window.from;
    const lateMinutes = s.window && eta > s.window.to ? Math.round((eta - s.window.to) / MIN) : 0;
    at += s.service * MIN;
    return { eta, lateMinutes };
  });
}

export const DEFAULT_SERVICE_MINUTES = 20;
