import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { etasFrom, evaluateRoute, planRoutes, sequenceRoute, stopOrderFromTasks, type Matrix, type Shipment, type Task, type VehicleSpec } from '../src/shared/routing.ts';

// Nodes on a line, 10 km apart: 0 (depot) — 1 — 2 — 3 — 4. 1 minute per km.
const line = (n: number): Matrix => {
  const km = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * 10));
  return { km, minutes: km.map((r) => r.map((x) => x)) };
};
const T0 = Date.UTC(2026, 10, 24, 8, 0);
const min = (m: number) => T0 + m * 60_000;
const vehicle = (over: Partial<VehicleSpec> = {}): VehicleSpec => ({ id: 'v1', startNode: 0, availableFrom: T0, availableTo: min(12 * 60), ...over });
const task = (id: string, node: number, over: Partial<Task> = {}): Task => ({ id, node, service: 0, deltaKg: 0, deltaPallets: 0, requires: [], ...over });
const shipment = (id: string, from: number, to: number, kg = 1000, over: { deliveryTo?: number } = {}): Shipment => ({
  id,
  weightKg: kg,
  pallets: 0,
  pickup: task(`${id}:c`, from, { deltaKg: kg, service: 10 }),
  delivery: task(`${id}:d`, to, { deltaKg: -kg, service: 10, requires: [`${id}:c`], window: over.deliveryTo !== undefined ? { from: T0, to: min(over.deliveryTo) } : undefined }),
});

describe('T4: optimizador propio', () => {
  test('evaluación: viaje, espera de ventana, servicio, precedencia y capacidad', () => {
    const m = line(5);
    const e = evaluateRoute(vehicle(), [task('a', 2, { service: 15, window: { from: min(60), to: min(90) } }), task('b', 4)], m);
    assert.equal(e.km, 40);
    assert.equal(e.arrivals[0], min(60), 'llega a los 20 min pero espera que abra la ventana');
    assert.equal(e.arrivals[1], min(60 + 15 + 20));
    assert.equal(evaluateRoute(vehicle(), [task('d', 1, { requires: ['c'] }), task('c', 2)], m).problem, 'precedencia');
    assert.equal(evaluateRoute(vehicle({ capacityKg: 500 }), [task('c', 1, { deltaKg: 800 })], m).problem, 'capacidad');
    assert.equal(evaluateRoute(vehicle(), [task('x', 4, { window: { from: T0, to: min(10) } })], m).problem, 'ventana');
  });

  test('secuencia exacta: igual a la fuerza bruta en un caso de 6 tareas', () => {
    // Random-ish 2D points → Euclidean matrix.
    const pts = [[0, 0], [5, 9], [9, 1], [2, 7], [8, 8], [1, 3], [6, 4]];
    const km = pts.map((a) => pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 10) / 10));
    const m: Matrix = { km, minutes: km.map((r) => r.map((x) => x * 2)) };
    const tasks = [task('c1', 1), task('d1', 2, { requires: ['c1'] }), task('c2', 3), task('d2', 4, { requires: ['c2'] }), task('c3', 5), task('d3', 6, { requires: ['c3'] })];
    const got = sequenceRoute(vehicle(), tasks, m);
    assert.equal(got.exact, true);
    // Brute force over all permutations respecting precedence.
    let bestKm = Infinity;
    const perm = (rest: Task[], acc: Task[]) => {
      if (!rest.length) {
        const e = evaluateRoute(vehicle(), acc, m, { allowLate: true });
        if (e.problem !== 'precedencia') bestKm = Math.min(bestKm, e.km);
        return;
      }
      rest.forEach((t, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, t]));
    };
    perm(tasks, []);
    assert.ok(Math.abs(got.eval.km - bestKm) < 0.5, `${got.eval.km} vs óptimo ${bestKm}`);
  });

  test('secuencia: prioriza llegar a tiempo antes que acortar km', () => {
    const m = line(5);
    // Far stop has an early window; going to the near one first would be shorter but late.
    const tasks = [task('near', 1, { service: 30 }), task('far', 4, { window: { from: T0, to: min(45) } })];
    const got = sequenceRoute(vehicle(), tasks, m);
    assert.deepEqual(got.order.map((t) => t.id), ['far', 'near']);
    assert.equal(got.allOnTime, true);
  });

  test('plan: reparte por capacidad, respeta precedencia y explica lo que no entra', () => {
    const m = line(5);
    const vehicles = [vehicle({ id: 'chico', capacityKg: 1500 }), vehicle({ id: 'grande', capacityKg: 10000 })];
    const shipments = [shipment('A', 1, 2, 1000), shipment('B', 1, 3, 8000), shipment('C', 2, 4, 20000), shipment('D', 1, 4, 500, { deliveryTo: 5 })];
    const r = planRoutes(vehicles, shipments, m);
    const of = (id: string) => r.routes.find((x) => x.shipmentIds.includes(id))?.vehicleId;
    assert.equal(of('B'), 'grande');
    assert.ok(of('A'));
    assert.deepEqual(
      r.unassigned.sort((a, b) => a.id.localeCompare(b.id)),
      [{ id: 'C', reason: 'capacidad' }, { id: 'D', reason: 'ventana' }]
    );
    for (const route of r.routes) {
      assert.equal(route.eval.feasible, true);
      for (const id of route.shipmentIds) {
        const ids = route.tasks.map((t) => t.id);
        assert.ok(ids.indexOf(`${id}:c`) < ids.indexOf(`${id}:d`), 'carga antes que descarga');
      }
    }
  });

  test('de tareas a paradas agrupadas sin descargar antes de cargar', () => {
    const tasks = ['A:c', 'A:d', 'B:c', 'B:d'].map((id) => ({ id }));
    // A and B are loaded at the same place (one stop) and unloaded at different places.
    const stops = [
      { id: 's-load', kind: 'carga' as const, orderIds: ['A', 'B'] },
      { id: 's-dA', kind: 'descarga' as const, orderIds: ['A'] },
      { id: 's-dB', kind: 'descarga' as const, orderIds: ['B'] },
    ];
    assert.deepEqual(stopOrderFromTasks(tasks, stops, (o, k) => `${o}:${k === 'carga' ? 'c' : 'd'}`), ['s-load', 's-dA', 's-dB']);
  });

  test('hora estimada: suma tramos, espera de ventana y servicio; marca demora', () => {
    const now = T0;
    const out = etasFrom(now, [30, 20], [{ service: 15, window: { from: min(60), to: min(120) } }, { service: 0, window: { from: T0, to: min(70) } }]);
    assert.equal(out[0].eta, min(30));
    assert.equal(out[0].lateMinutes, 0);
    // Waits until 60, +15 service, +20 travel = 95 > 70.
    assert.equal(out[1].eta, min(95));
    assert.equal(out[1].lateMinutes, 25);
  });
});

// ---------------------------------------------------------------- OSRM / VROOM adapters

import { RoutingEngine } from '../server/routing/provider.ts';

const fakeFetch = (handler: (url: string, body?: any) => any) => async (url: string, init?: { body?: string }) => {
  const out = handler(url, init?.body ? JSON.parse(init.body) : undefined);
  if (out instanceof Error) throw out;
  return { ok: true, status: 200, json: async () => out };
};

describe('T4: adaptadores OSRM y VROOM con respaldo', () => {
  const pts = [{ lat: -31.5, lng: -68.5 }, { lat: -31.6, lng: -68.4 }, { lat: -31.7, lng: -68.6 }];

  test('OSRM: matriz y ruta en km/min; si falla, estimación', async () => {
    const osrm = new RoutingEngine({
      osrmUrl: 'http://osrm',
      avgKmh: 45,
      fetchImpl: fakeFetch((url) =>
        url.includes('/table/')
          ? { code: 'Ok', distances: [[0, 15000, 30000], [15000, 0, 20000], [30000, 20000, 0]], durations: [[0, 900, 1800], [900, 0, 1200], [1800, 1200, 0]] }
          : { code: 'Ok', routes: [{ distance: 35000, duration: 2100, legs: [{ distance: 15000, duration: 900 }, { distance: 20000, duration: 1200 }], geometry: { coordinates: [[-68.5, -31.5], [-68.45, -31.55], [-68.6, -31.7]] } }] }
      ),
    });
    const mx = await osrm.matrix(pts);
    assert.equal(mx.engine, 'osrm');
    assert.equal(mx.matrix.km[0][2], 30);
    assert.equal(mx.matrix.minutes[1][2], 20);
    const r = await osrm.route(pts);
    assert.equal(r.engine, 'osrm');
    assert.deepEqual([r.km, r.minutes, r.legs.length, r.geometry.length], [35, 35, 2, 3]);

    const down = new RoutingEngine({ osrmUrl: 'http://osrm', avgKmh: 45, fetchImpl: fakeFetch(() => new Error('ECONNREFUSED')) });
    assert.equal((await down.matrix(pts)).engine, 'estimado');
    const r2 = await down.route(pts);
    assert.equal(r2.engine, 'estimado');
    assert.equal(r2.geometry.length, 3, 'línea recta entre paradas');
  });

  test('VROOM: mapea rutas a tareas; si falla, optimizador propio', async () => {
    const m = line(5);
    const vehicles = [vehicle({ id: 'a' }), vehicle({ id: 'b' })];
    const shipments = [shipment('X', 1, 2), shipment('Y', 3, 4)];
    let sent: any;
    const vroom = new RoutingEngine({
      vroomUrl: 'http://vroom',
      avgKmh: 45,
      fetchImpl: fakeFetch((_url, body) => {
        sent = body;
        return { code: 0, routes: [{ vehicle: 2, steps: [{ type: 'start' }, { type: 'pickup', id: 3 }, { type: 'pickup', id: 1 }, { type: 'delivery', id: 2 }, { type: 'delivery', id: 4 }, { type: 'end' }] }], unassigned: [] };
      }),
    });
    const r = await vroom.plan(vehicles, shipments, m);
    assert.equal(r.optimizer, 'vroom');
    assert.equal(sent.shipments.length, 2);
    assert.deepEqual(sent.shipments[0].amount, [1000, 0]);
    assert.ok(sent.matrices.car.durations[0][1] === 600, 'minutos → segundos');
    assert.equal(r.routes[0].vehicleId, 'b');
    assert.deepEqual(r.routes[0].tasks.map((t) => t.id), ['Y:c', 'X:c', 'X:d', 'Y:d']);
    assert.deepEqual(r.routes[0].shipmentIds.sort(), ['X', 'Y']);

    const down = new RoutingEngine({ vroomUrl: 'http://vroom', avgKmh: 45, fetchImpl: fakeFetch(() => ({ code: 3, error: 'bad' })) });
    const r2 = await down.plan(vehicles, shipments, m);
    assert.equal(r2.optimizer, 'propio');
    assert.equal(r2.unassigned.length, 0);
  });
});
