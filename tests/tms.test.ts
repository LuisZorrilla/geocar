import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';
import { circleRing, distanceMeters } from '../src/shared/geo.ts';
import { buildStops, evaluateStop, isStopLate, validateAssignment, MIN_DWELL_MS, type TransportOrder, type TripStop } from '../src/shared/tms.ts';

// ---------------------------------------------------------------- unit

const iso = (ms: number) => new Date(ms).toISOString();
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('TMS: reglas puras', () => {
  test('distancia haversine', () => {
    // 1° de latitud ≈ 111,2 km.
    const d = distanceMeters({ lat: -31, lng: -68 }, { lat: -32, lng: -68 });
    assert.ok(Math.abs(d - 111_195) < 200, String(d));
    assert.equal(distanceMeters({ lat: -31.5, lng: -68.5 }, { lat: -31.5, lng: -68.5 }), 0);
  });

  test('el círculo de la geocerca queda a la distancia del radio en todos sus puntos', () => {
    const c = { lat: -31.5375, lng: -68.5364 };
    const ring = circleRing(c, 300);
    assert.equal(ring.length, 65);
    assert.deepEqual(ring[0], ring[64], 'anillo cerrado');
    for (const [lng, lat] of ring) assert.ok(Math.abs(distanceMeters(c, { lat, lng }) - 300) < 0.5);
  });

  test('armado de paradas: agrupa por lugar, cargas primero y por ventana', () => {
    let n = 0;
    const w = (h: number) => ({ from: iso(Date.UTC(2026, 10, 24, h)), to: iso(Date.UTC(2026, 10, 24, h + 2)) });
    const orders = [
      { id: 'o1', originPlaceId: 'A', destinationPlaceId: 'C', pickupWindow: w(9), deliveryWindow: w(14) },
      { id: 'o2', originPlaceId: 'A', destinationPlaceId: 'D', pickupWindow: w(8), deliveryWindow: w(12) },
      { id: 'o3', originPlaceId: 'B', destinationPlaceId: 'C', pickupWindow: w(7), deliveryWindow: w(15) },
    ];
    const stops = buildStops(orders, () => `s${++n}`);
    assert.deepEqual(
      stops.map((s) => `${s.seq}:${s.kind}:${s.placeId}:${s.orderIds.join('+')}`),
      ['1:carga:B:o3', '2:carga:A:o1+o2', '3:descarga:D:o2', '4:descarga:C:o1+o3']
    );
    // The shared stop's window covers both orders.
    assert.equal(stops[1].window!.from, w(8).from);
    assert.equal(stops[3].window!.to, w(15).to);
  });

  test('detección: llegada, salida con permanencia mínima y paso sin detenerse', () => {
    const place = { lat: -31.5, lng: -68.5, radiusM: 150 };
    const now = Date.now();
    const at = (ms: number) => ({ lat: -31.5, lng: -68.5, at: iso(ms) });
    const far = (ms: number) => ({ lat: -31.51, lng: -68.5, at: iso(ms) }); // ~1,1 km
    assert.equal(evaluateStop({ status: 'pendiente' }, place, far(now), new Date(now)), null);
    assert.equal(evaluateStop({ status: 'pendiente' }, place, at(now), new Date(now))?.type, 'arrived');
    // Left after 3 minutes → departed. After 1 minute → drive-by.
    const arrived = iso(now - 3 * 60_000);
    assert.equal(evaluateStop({ status: 'en_lugar', arrivedAt: arrived }, place, far(now), new Date(now))?.type, 'departed');
    assert.equal(evaluateStop({ status: 'en_lugar', arrivedAt: iso(now - MIN_DWELL_MS / 2) }, place, far(now), new Date(now))?.type, 'drive_by');
    // Just outside the radius but within the margin: still there (GPS jitter).
    const edge = { lat: -31.5 - 160 / 111_195, lng: -68.5, at: iso(now) };
    assert.equal(evaluateStop({ status: 'en_lugar', arrivedAt: arrived }, place, edge, new Date(now)), null);
    // Stale position is ignored.
    assert.equal(evaluateStop({ status: 'pendiente' }, place, at(now - 11 * 60_000), new Date(now)), null);
  });

  test('demora: solo descargas pendientes con ventana vencida y una sola vez', () => {
    const now = new Date();
    const base: TripStop = { id: 's', seq: 1, placeId: 'p', kind: 'descarga', orderIds: [], status: 'pendiente', window: { from: iso(now.getTime() - 3e6), to: iso(now.getTime() - 1000) } };
    assert.equal(isStopLate(base, now), true);
    assert.equal(isStopLate({ ...base, kind: 'carga' }, now), false);
    assert.equal(isStopLate({ ...base, status: 'en_lugar' }, now), false);
    assert.equal(isStopLate({ ...base, delayAlertedAt: iso(now.getTime()) }, now), false);
  });

  test('validación de asignación: bloqueos y advertencias', () => {
    const FILE = { id: 'f', name: 'x', mime: 'image/png', size: 1, sha256: '', uploadedAt: '', uploadedBy: '' };
    const OK = { status: 'verificado' as const };
    const driver: any = {
      id: 'd1', tenantId: 't', name: 'Pérez, Ana', profile: 'profesional', licenseClasses: ['B.1', 'E.1'],
      documents: ['dni', 'licencia', 'linti', 'psicofisico'].map((type) => ({ type, number: '1', expiresAt: plusDays(300), file: FILE, verification: OK })),
    };
    const vehicle: any = { id: 'v1', tenantId: 't', unitCode: 'U-1', maintenanceStatus: 'al_dia', capacityKg: 10000, refrigerated: false };
    const order = (extra: Partial<TransportOrder['cargo']> = {}): TransportOrder => ({
      id: 'o1', tenantId: 't', customerId: 'c', originPlaceId: 'A', destinationPlaceId: 'B', cargo: { description: 'x', weightKg: 5000, ...extra },
      status: 'confirmado', createdBy: '', createdAt: '', updatedAt: '',
    });
    const start = new Date(Date.now() + 3600_000).toISOString();
    const base = { vehicle, driver, plannedStart: start, workOrders: [], checklists: [], trips: [] };

    const ok = validateAssignment({ ...base, orders: [order()] });
    assert.deepEqual(ok, { blocks: [], warnings: [] });

    const heavy = validateAssignment({ ...base, orders: [order({ weightKg: 12000, refrigerated: true })] });
    assert.deepEqual(heavy.warnings.map((w) => w.code).sort(), ['not_refrigerated', 'over_capacity_peso']);
    assert.equal(heavy.blocks.length, 0);

    const dangerous = validateAssignment({ ...base, orders: [order({ dangerous: true })] });
    assert.equal(dangerous.blocks[0].code, 'dangerous_goods');

    const pending = validateAssignment({ ...base, driver: { ...driver, documents: driver.documents.map((d: any) => ({ ...d, verification: undefined })) }, orders: [order()] });
    assert.equal(pending.blocks[0].code, 'driver_pending');

    const wo: any = { id: 'OT-1', vehicleId: 'v1', status: 'en_taller', priority: 'critica' };
    assert.equal(validateAssignment({ ...base, workOrders: [wo], orders: [order()] }).blocks[0].code, 'critical_work_order');

    const chk: any = { id: 'CHK-1', vehicleId: 'v1', submittedAt: new Date().toISOString(), items: [{ status: 'falla' }], review: { decision: 'no_apto' } };
    assert.equal(validateAssignment({ ...base, checklists: [chk], orders: [order()] }).blocks[0].code, 'checklist_not_fit');

    const other: any = { id: 'VJ-1', vehicleId: 'v1', driverId: 'd9', status: 'planificado', plannedStart: start, stops: [], orders: [] };
    assert.equal(validateAssignment({ ...base, trips: [other], orders: [order()] }).blocks[0].code, 'overlap');
    assert.equal(validateAssignment({ ...base, trips: [{ ...other, status: 'finalizado' }], orders: [order()] }).blocks.length, 0);
  });
});

// ---------------------------------------------------------------- API

const env = new TestEnv();
let norte: string;
let monitoreo: string;
let urbana: string;
const ingestAuth = { Authorization: `Bearer ${INGEST_TOKEN}` };

/** Valid CUIT for a company (prefix 30). */
function cuitFor(body8: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `30${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  if (r === 10) return cuitFor(String(Number(body8) + 1).padStart(8, '0'));
  return `${base}${r === 11 ? 0 : r}`;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

/** A driver of the company with every document uploaded and verified (habilitado). */
async function authorizedDriver(token: string, dni: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `20${dni}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  const created = await env.req('POST', '/api/drivers', {
    token,
    body: {
      firstName: 'Ana', lastName: `Viajes ${dni.slice(-3)}`, dni, cuil: `${base}${r === 11 ? 0 : r === 10 ? 9 : r}`, birthDate: '1985-04-12',
      phone: '+54 264 555 1234', branch: 'San Juan Capital', profile: 'profesional', licenseClasses: ['B.1', 'E.1'],
      documents: [
        { type: 'dni', number: dni },
        { type: 'licencia', number: dni, expiresAt: plusDays(400) },
        { type: 'linti', number: 'LNT-1', expiresAt: plusDays(300) },
        { type: 'psicofisico', number: 'PSI-1', expiresAt: plusDays(200) },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  let d = created.json.driver;
  for (const doc of d.documents) {
    await fetch(`${env.baseUrl}/api/drivers/${d.id}/documents/${doc.type}/file`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-file-name': 'doc.png' },
      body: new Uint8Array(PNG),
    });
    d = (await env.req('POST', `/api/drivers/${d.id}/documents/${doc.type}/verify`, { token, body: { decision: 'verificado' } })).json.driver;
  }
  assert.equal(d.authorization.state, 'habilitado', JSON.stringify(d.authorization));
  return d;
}

function position(uniqueId: string, lat: number, lng: number, fixMs: number) {
  const t = new Date(fixMs).toISOString();
  return {
    position: { deviceId: 7, protocol: 'jt808', serverTime: t, deviceTime: t, fixTime: t, valid: true, latitude: lat, longitude: lng, altitude: 640, speed: 0, course: 0, attributes: { ignition: true } },
    device: { id: 7, uniqueId, name: 'Cámara', status: 'online' },
  };
}

describe('TMS: API', () => {
  let vehicle: any;
  let terminalId: string;
  let driver: any;
  let customer: any;
  let placeA: any;
  let placeB: any;

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const openCritical = new Set(boot.workOrders.filter((w: any) => w.priority === 'critica' && !['completada', 'cancelada'].includes(w.status)).map((w: any) => w.vehicleId));
    vehicle = boot.vehicles.find(
      (v: any) => v.assetType === 'vehiculo' && v.deviceId && !openCritical.has(v.id) && boot.devices.some((d: any) => d.id === v.deviceId && d.terminalId)
    );
    assert.ok(vehicle, 'hay una unidad de prueba');
    terminalId = boot.devices.find((d: any) => d.id === vehicle.deviceId).terminalId;
    driver = await authorizedDriver(norte, '33111222');
  });
  after(() => env.close());

  test('datos demo: clientes, lugares y pedidos; permiso operaciones copiado de flotas', async () => {
    const orders = await env.req('GET', '/api/tms/orders', { token: norte });
    assert.equal(orders.status, 200);
    assert.ok(orders.json.items.length >= 4);
    assert.ok(orders.json.items.every((o: any) => o.tenantId === 'ten-norte'));
    const boot = (await env.req('GET', '/api/bootstrap', { token: monitoreo })).json;
    assert.equal(boot.currentRole.permissions.operaciones, boot.currentRole.permissions.flotas);
    // monitoreo.norte has flotas: read → can read, can't write.
    assert.equal((await env.req('GET', '/api/tms/trips', { token: monitoreo })).status, 200);
    const denied = await env.req('POST', '/api/tms/customers', { token: monitoreo, body: { name: 'X', taxId: '1' } });
    assert.equal(denied.status, 403);
  });

  test('ciclo completo: cliente → lugares → pedido → viaje → paradas automáticas → entregado', async () => {
    const c = await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Bodegas del Sol S.A.', taxId: cuitFor('71555444') } });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    customer = c.json.customer;
    const bad = await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Otro', taxId: '30-71555444-0' === customer.taxId ? '30-71555444-1' : '30-71555444-0' } });
    assert.equal(bad.status, 400, 'CUIT con dígito verificador incorrecto');

    placeA = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Bodega (carga)', kind: 'planta', address: 'Ruta 40', lat: -31.6, lng: -68.4, radiusM: 200, customerId: customer.id } })).json.place;
    placeB = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Centro de entrega', kind: 'cliente', address: 'Av. Central', lat: -31.65, lng: -68.45, radiusM: 200 } })).json.place;
    assert.ok(placeA?.id && placeB?.id);

    const now = Date.now();
    const order = await env.req('POST', '/api/tms/orders', {
      token: norte,
      body: {
        customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id,
        cargo: { description: 'Vino en cajas', weightKg: 2000, pallets: 3 },
        pickupWindow: { from: iso(now - 3600_000), to: iso(now + 3600_000) },
        deliveryWindow: { from: iso(now), to: iso(now + 6 * 3600_000) },
        confirm: true,
      },
    });
    assert.equal(order.status, 201, JSON.stringify(order.json));
    assert.match(order.json.order.id, /^PED-[A-Z0-9]+-\d{4}$/);
    assert.equal(order.json.order.status, 'confirmado');

    const assignment = { vehicleId: vehicle.id, driverId: driver.id, plannedStart: iso(now - 20 * 60_000), orderIds: [order.json.order.id] };
    const check = (await env.req('POST', '/api/tms/trips/validate', { token: norte, body: assignment })).json.check;
    assert.equal(check.blocks.length, 0, JSON.stringify(check));
    const created = await env.req('POST', '/api/tms/trips', {
      token: norte,
      body: { ...assignment, ...(check.warnings.length ? { acceptWarnings: { reason: 'Prueba automatizada' } } : {}) },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const trip = created.json.trip;
    assert.match(trip.id, /^VJ-/);
    assert.deepEqual(trip.stops.map((s: any) => `${s.kind}:${s.placeName}`), ['carga:Bodega (carga)', 'descarga:Centro de entrega']);
    assert.equal(trip.orders[0].status, 'planificado');

    // The same unit can't be assigned to an overlapping trip.
    const order2 = (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'Otra' }, confirm: true } })).json.order;
    const overlap = await env.req('POST', '/api/tms/trips', { token: norte, body: { ...assignment, orderIds: [order2.id], acceptWarnings: { reason: 'x' } } });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.json.check.blocks[0].code, 'overlap');

    // Unit arrives at A, stays 4 min, leaves; arrives at B, stays, leaves.
    const t0 = Date.now() - 9 * 60_000;
    const steps: Array<[number, number, number]> = [
      [-31.6, -68.4, t0], // at A
      [-31.62, -68.42, t0 + 4 * 60_000], // left A
      [-31.65, -68.45, t0 + 5 * 60_000], // at B
      [-31.67, -68.47, t0 + 8 * 60_000], // left B
    ];
    for (const [lat, lng, ms] of steps) {
      const r = await env.req('POST', '/ingest/traccar/position', { headers: ingestAuth, body: position(terminalId, lat, lng, ms) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await env.req('POST', '/api/tms/trips/evaluate', { token: norte })).status, 200);
    }
    const done = (await env.req('GET', `/api/tms/trips/${trip.id}`, { token: norte })).json.trip;
    assert.equal(done.status, 'finalizado', JSON.stringify(done.history));
    assert.ok(done.stops.every((s: any) => s.status === 'completada' && s.detection === 'auto' && s.arrivedAt && s.departedAt));
    assert.equal(done.orders[0].status, 'entregado');
    assert.ok(done.history.some((h: any) => h.action === 'Viaje iniciado'));

    // Exports.
    const csv = await fetch(`${env.baseUrl}/api/tms/trips/export?format=csv`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), new RegExp(trip.id));
  });

  test('demora: una sola alerta cuando vence la ventana de entrega', async () => {
    const now = Date.now();
    const order = (await env.req('POST', '/api/tms/orders', {
      token: norte,
      body: {
        customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'Urgente' },
        deliveryWindow: { from: iso(now - 3 * 3600_000), to: iso(now - 60_000) }, confirm: true,
      },
    })).json.order;
    const start = iso(now + 24 * 3600_000); // far from the previous trip
    const res = await env.req('POST', '/api/tms/trips', { token: norte, body: { vehicleId: vehicle.id, driverId: driver.id, plannedStart: start, orderIds: [order.id], acceptWarnings: { reason: 'Prueba' } } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    await env.req('POST', '/api/tms/trips/evaluate', { token: norte });
    await env.req('POST', '/api/tms/trips/evaluate', { token: norte });
    const alerts = (await env.req('GET', '/api/bootstrap', { token: norte })).json.alerts.filter((a: any) => a.ruleId === 'tms-delay' && a.summary.includes(res.json.trip.id));
    assert.equal(alerts.length, 1);
    // Cancelling the trip frees the order.
    const cancelled = await env.req('POST', `/api/tms/trips/${res.json.trip.id}/cancel`, { token: norte, body: { reason: 'Cliente reprogramó' } });
    assert.equal(cancelled.json.trip.status, 'cancelado');
    const freed = (await env.req('GET', `/api/tms/orders?q=${order.id}`, { token: norte })).json.items[0];
    assert.equal(freed.status, 'confirmado');
    assert.equal(freed.tripId, undefined);
  });

  test('advertencias: sin aceptar → 409, sin motivo → 400; los bloqueos no se fuerzan', async () => {
    const heavy = (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'Muy pesado', weightKg: 999_000 }, confirm: true } })).json.order;
    const body = { vehicleId: vehicle.id, driverId: driver.id, plannedStart: iso(Date.now() + 48 * 3600_000), orderIds: [heavy.id] };
    const noAccept = await env.req('POST', '/api/tms/trips', { token: norte, body });
    assert.equal(noAccept.status, 409);
    assert.equal(noAccept.json.needsOverride, true);
    assert.ok(noAccept.json.check.warnings.some((w: any) => w.code === 'over_capacity_peso'));
    const noReason = await env.req('POST', '/api/tms/trips', { token: norte, body: { ...body, acceptWarnings: { reason: '  ' } } });
    assert.equal(noReason.status, 400);
    // A demo driver pending verification is a block, even with an accepted reason.
    const boot = (await env.req('GET', '/api/drivers?pageSize=50', { token: norte })).json;
    const pending = boot.items.find((d: any) => d.authorization.state === 'pendiente');
    const blocked = await env.req('POST', '/api/tms/trips', { token: norte, body: { ...body, driverId: pending.id, acceptWarnings: { reason: 'forzar' } } });
    assert.equal(blocked.status, 409);
    assert.ok(blocked.json.check.blocks.some((b: any) => b.code === 'driver_pending'));
  });

  test('aislamiento: otra empresa no ve ni toca recursos ajenos', async () => {
    assert.equal((await env.req('PATCH', `/api/tms/customers/${customer.id}`, { token: urbana, body: { name: 'Hack' } })).status, 404);
    assert.equal((await env.req('PATCH', `/api/tms/places/${placeA.id}`, { token: urbana, body: { name: 'Hack' } })).status, 404);
    const list = (await env.req('GET', '/api/tms/customers', { token: urbana })).json.items;
    assert.ok(!list.some((c: any) => c.id === customer.id));
    const trips = (await env.req('GET', '/api/tms/trips', { token: norte })).json.items;
    assert.equal((await env.req('GET', `/api/tms/trips/${trips[0].id}`, { token: urbana })).status, 404);
    // Orders of another company can't go in my trip.
    const bad = await env.req('POST', '/api/tms/orders', { token: urbana, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'x' } } });
    assert.equal(bad.status, 404);
  });
});
