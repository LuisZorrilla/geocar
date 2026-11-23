import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
let norte: string;
let monitoreo: string;
let urbana: string;
const iso = (ms: number) => new Date(ms).toISOString();
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

function cuilFor(dni: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (const p of ['20', '23', '24', '27']) {
    const base = p + dni.padStart(8, '0');
    const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
    if (r !== 10) return base + (r === 11 ? 0 : r);
  }
  throw new Error('sin CUIL');
}

async function authorizedDriver(dni: string) {
  let d = (await env.req('POST', '/api/drivers', {
    token: norte,
    body: {
      firstName: 'Rita', lastName: `Ruta ${dni.slice(-3)}`, dni, cuil: cuilFor(dni), birthDate: '1987-02-02', phone: '+54 264 555 0000',
      branch: 'San Juan Capital', profile: 'profesional', licenseClasses: ['B.1', 'E.1'],
      documents: [
        { type: 'dni', number: dni }, { type: 'licencia', number: dni, expiresAt: plusDays(400) },
        { type: 'linti', number: 'L', expiresAt: plusDays(300) }, { type: 'psicofisico', number: 'P', expiresAt: plusDays(200) },
      ],
    },
  })).json.driver;
  for (const doc of d.documents) {
    await fetch(`${env.baseUrl}/api/drivers/${d.id}/documents/${doc.type}/file`, { method: 'PUT', headers: { Authorization: `Bearer ${norte}`, 'Content-Type': 'image/png', 'x-file-name': 'd.png' }, body: new Uint8Array(PNG) });
    d = (await env.req('POST', `/api/drivers/${d.id}/documents/${doc.type}/verify`, { token: norte, body: { decision: 'verificado' } })).json.driver;
  }
  assert.equal(d.authorization.state, 'habilitado');
  return d;
}

describe('T4: API de ruteo, planificador y despacho', () => {
  let units: any[];
  let devices: any[];
  let orders: any[];
  const start = (() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(7, 0, 0, 0);
    return d.toISOString();
  })();

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    devices = boot.devices;
    await authorizedDriver('36111222');
    await authorizedDriver('36111333');
    await authorizedDriver('36111444');
    orders = (await env.req('GET', '/api/tms/orders?status=confirmado', { token: norte })).json.items;
    assert.ok(orders.length >= 3);
    const cand = (await env.req('GET', `/api/routing/candidates?start=${encodeURIComponent(start)}`, { token: norte })).json;
    units = cand.vehicles.filter((v: any) => v.available);
    assert.ok(units.length >= 3, JSON.stringify(cand.vehicles.slice(0, 3)));
    assert.ok(cand.drivers.filter((d: any) => d.available).length >= 3);
  });
  after(() => env.close());

  test('estado del motor: sin OSRM ni VROOM configurados → estimado', async () => {
    const s = (await env.req('GET', '/api/routing/status', { token: norte })).json;
    assert.equal(s.engine, 'estimado');
    assert.equal(s.osrmConfigured, false);
  });

  test('planificador: propone viajes por unidad, con chofer y validación; aplicar los crea en ese orden', async () => {
    assert.equal((await env.req('POST', '/api/routing/plan', { token: monitoreo, body: { startTime: start, orderIds: [orders[0].id], vehicleIds: [units[0].id] } })).status, 403);
    const plan = await env.req('POST', '/api/routing/plan', {
      token: norte,
      body: { startTime: start, orderIds: orders.slice(0, 3).map((o: any) => o.id), vehicleIds: units.slice(0, 2).map((u: any) => u.id) },
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    const { proposals, unassigned } = plan.json;
    assert.equal(plan.json.engine, 'estimado');
    const assignedIds = proposals.flatMap((p: any) => p.orderIds);
    assert.equal(assignedIds.length + unassigned.length, 3);
    for (const p of proposals) {
      assert.ok(p.driverId, 'sugiere un chofer habilitado');
      assert.deepEqual(p.check.blocks, [], JSON.stringify(p.check));
      assert.ok(p.km > 0 && p.minutes > 0);
      for (const id of p.orderIds) assert.ok(p.taskOrder.indexOf(`${id}:c`) < p.taskOrder.indexOf(`${id}:d`));
    }
    const apply = await env.req('POST', '/api/routing/plan/apply', {
      token: norte,
      body: { proposals: proposals.map((p: any) => ({ vehicleId: p.vehicleId, driverId: p.driverId, plannedStart: p.plannedStart, orderIds: p.orderIds, taskOrder: p.taskOrder, acceptWarnings: p.check.warnings.length ? { reason: 'Plan del día' } : undefined })) },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.json));
    assert.equal(apply.json.created.length, proposals.length);
    assert.equal(apply.json.failed.length, 0);
    const trip = (await env.req('GET', `/api/tms/trips/${apply.json.created[0].tripId}`, { token: norte })).json.trip;
    const firstOrder = proposals[0].taskOrder[0].split(':')[0];
    assert.equal(trip.stops[0].kind, 'carga');
    assert.ok(trip.stops[0].orderIds.includes(firstOrder));
    // The same units are now busy for that day.
    const cand = (await env.req('GET', `/api/routing/candidates?start=${encodeURIComponent(start)}`, { token: norte })).json;
    assert.equal(cand.vehicles.find((v: any) => v.id === proposals[0].vehicleId).available, false);
  });

  test('optimizar un viaje planificado no empeora los km; ruta con ETA por parada', async () => {
    const trips = (await env.req('GET', '/api/tms/trips?status=planificado', { token: norte })).json.items;
    const t = trips[0];
    const opt = await env.req('POST', `/api/routing/trips/${t.id}/optimize`, { token: norte });
    assert.equal(opt.status, 200, JSON.stringify(opt.json));
    assert.ok(opt.json.proposed.km <= opt.json.current.km);
    assert.equal(opt.json.proposed.order.length, t.stops.length);
    if (opt.json.changed) {
      const applied = await env.req('PATCH', `/api/tms/trips/${t.id}`, { token: norte, body: { stopOrder: opt.json.proposed.order } });
      assert.equal(applied.status, 200, JSON.stringify(applied.json));
    }
    const route = (await env.req('GET', `/api/routing/trips/${t.id}/route`, { token: norte })).json;
    assert.equal(route.etas.length, t.stops.length);
    assert.ok(route.geometry.length >= 2);
    assert.equal((await env.req('POST', `/api/routing/trips/${t.id}/optimize`, { token: urbana })).status, 404);
  });

  test('despacho del día: unidades con viajes y unidades libres', async () => {
    const from = new Date(start);
    from.setHours(0, 0, 0, 0);
    const d = (await env.req('GET', `/api/routing/dispatch?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(new Date(from.getTime() + 86_400_000).toISOString())}`, { token: norte })).json;
    assert.ok(d.rows.length >= 1);
    assert.ok(d.rows.every((r: any) => r.trips.every((t: any) => t.stops.length > 0 && t.startAt < t.endAt)));
    assert.ok(d.idle.length > 0);
  });

  test('demora prevista: alerta una sola vez antes de que venza la ventana', async () => {
    // A unit far away (≈ 300 km) with a delivery due in 40 minutes.
    const unit = units.find((u: any) => devices.some((dv: any) => dv.vehicleId === u.id && dv.terminalId) && !(u.reason));
    const dev = devices.find((dv: any) => dv.vehicleId === unit.id && dv.terminalId);
    const now = Date.now();
    const pos = { position: { deviceId: 9, protocol: 'jt808', serverTime: iso(now), deviceTime: iso(now), fixTime: iso(now), valid: true, latitude: -34.2, longitude: -68.5, altitude: 600, speed: 40, course: 0, attributes: { ignition: true } }, device: { id: 9, uniqueId: dev.terminalId, name: 'c', status: 'online' } };
    assert.equal((await env.req('POST', '/ingest/traccar/position', { headers: { Authorization: `Bearer ${INGEST_TOKEN}` }, body: pos })).status, 200);
    const o = orders[3] ?? (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: orders[0].customerId, originPlaceId: orders[0].originPlaceId, destinationPlaceId: orders[0].destinationPlaceId, cargo: { description: 'Urgente' }, confirm: true } })).json.order;
    await env.req('PATCH', `/api/tms/orders/${o.id}`, { token: norte, body: { pickupWindow: undefined, deliveryWindow: { from: iso(now - 3600_000), to: iso(now + 40 * 60_000) } } });
    const drivers = (await env.req('GET', `/api/routing/candidates?start=${encodeURIComponent(iso(now))}`, { token: norte })).json.drivers.filter((d: any) => d.available);
    const t = (await env.req('POST', '/api/tms/trips', { token: norte, body: { vehicleId: unit.id, driverId: drivers[0].id, plannedStart: iso(now - 5 * 60_000), orderIds: [o.id], acceptWarnings: { reason: 'prueba' } } })).json.trip;
    assert.ok(t, 'viaje creado');
    await env.req('POST', `/api/tms/trips/${t.id}/start`, { token: norte });
    await env.req('POST', '/api/tms/trips/evaluate', { token: norte });
    await env.req('POST', '/api/tms/trips/evaluate', { token: norte });
    const alerts = (await env.req('GET', '/api/bootstrap', { token: norte })).json.alerts.filter((a: any) => a.ruleId === 'tms-eta-late' && a.summary.includes(t.id));
    assert.equal(alerts.length, 1, 'una sola alerta');
    const after = (await env.req('GET', `/api/tms/trips/${t.id}`, { token: norte })).json.trip;
    assert.ok(after.stops.every((s: any) => s.eta), 'cada parada pendiente tiene ETA');
    // Public page uses the live ETA.
    const pub = (await env.req('GET', `/api/public/track/${o.trackingToken ?? (await env.req('POST', `/api/tms/orders/${o.id}/tracking-link`, { token: norte })).json.token}`)).json.tracking;
    assert.ok(pub.unit.etaMinutes > 40, JSON.stringify(pub.unit));
  });
});
