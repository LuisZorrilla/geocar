import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { carrierDocProblems, tripUnit } from '../src/shared/carriers.ts';

function companyCuit(body8: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `30${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  return r === 10 ? companyCuit(String(Number(body8) + 1)) : `${base}${r === 11 ? 0 : r}`;
}
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

describe('T5: fleteros — reglas', () => {
  test('documentación: faltantes obligatorios, vencidos y por vencer', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const p = carrierDocProblems(
      { documents: [{ id: '1', type: 'seguro_carga', expiresAt: '2026-12-10' }, { id: '2', type: 'vtv', expiresAt: '2026-11-01' }] },
      now
    );
    assert.deepEqual(
      p.map((x) => `${x.type}:${x.problem}`),
      ['ruta:falta', 'seguro_carga:por_vencer', 'vtv:vencido']
    );
  });

  test('unidad del viaje: vehículo propio o datos del fletero con la posición del celular', () => {
    const vehicles = [{ id: 'v1', unitCode: 'U-1', lat: 1, lng: 2, lastReportAt: 'x' }];
    assert.equal(tripUnit({ vehicleId: 'v1' }, vehicles)?.unitCode, 'U-1');
    const c = { carrierId: 'c', carrierName: 'Fletes SA', plate: 'AB123CD', driverName: 'Juan', price: 1 };
    const noPos = tripUnit({ vehicleId: 'carrier:c', carrier: c }, vehicles) as any;
    assert.equal(noPos.unitCode, 'Fletes SA');
    assert.ok(Number.isNaN(noPos.lat));
    assert.equal(noPos.lastReportAt, undefined);
    const withPos = tripUnit({ vehicleId: 'carrier:c', carrier: { ...c, lastPosition: { lat: -31, lng: -68, at: '2026-11-23T10:00:00Z' } } }, vehicles) as any;
    assert.deepEqual([withPos.lat, withPos.lng, withPos.lastReportAt], [-31, -68, '2026-11-23T10:00:00Z']);
  });
});

const env = new TestEnv();

describe('T5: API de fleteros', () => {
  let norte = '';
  let monitoreo = '';
  let urbana = '';
  let carrier: any;
  let customer: any;
  let places: any[] = [];
  let trip: any;
  let token = '';
  const order = async () =>
    (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: places[0].id, destinationPlaceId: places[1].id, cargo: { description: 'Cemento', weightKg: 9000 }, confirm: true } })).json.order;
  const app = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${env.baseUrl}/api/driver-app${path}`, { method: init.method ?? 'GET', headers: { 'x-driver-token': token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined }).then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    customer = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Cementera', taxId: companyCuit('71999111') } })).json.customer;
    places = await Promise.all(
      ['Planta', 'Obra'].map(async (n, i) => (await env.req('POST', '/api/tms/places', { token: norte, body: { name: `${n} F`, kind: 'cliente', address: n, lat: -31.53 - i * 0.2, lng: -68.52, radiusM: 300 } })).json.place)
    );
  });
  after(() => env.close());

  test('alta: CUIT válido, permisos y aislamiento entre empresas', async () => {
    const body = {
      name: 'Fletes del Oeste',
      taxId: companyCuit('70111222'),
      phone: '+54 9 264 555 1234',
      documents: [
        { type: 'seguro_carga', number: 'POL-1', expiresAt: plusDays(200) },
        { type: 'ruta', number: 'R-9', expiresAt: plusDays(-3) },
      ],
      vehicles: [{ plate: 'ab 123 cd', description: 'Semi', capacityKg: 28000 }],
    };
    assert.equal((await env.req('POST', '/api/carriers', { token: monitoreo, body })).status, 403);
    assert.equal((await env.req('POST', '/api/carriers', { token: norte, body: { ...body, taxId: '30-12345678-0' } })).status, 400);
    const r = await env.req('POST', '/api/carriers', { token: norte, body });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    carrier = r.json.carrier;
    assert.equal(carrier.vehicles[0].plate, 'AB123CD');
    assert.equal((await env.req('POST', '/api/carriers', { token: norte, body })).status, 409, 'CUIT repetido');
    const list = (await env.req('GET', '/api/carriers', { token: monitoreo })).json.items;
    const row = list.find((c: any) => c.id === carrier.id);
    assert.equal(row.active, true);
    assert.deepEqual(row.docProblems.map((p: any) => p.problem), ['vencido']);
    assert.equal((await env.req('GET', '/api/carriers', { token: urbana })).json.items.some((c: any) => c.id === carrier.id), false);
    assert.equal((await env.req('PATCH', `/api/carriers/${carrier.id}`, { token: urbana, body: { notes: 'x' } })).status, 404);
  });

  test('viaje con fletero: documentación vencida bloquea salvo aprobación con motivo', async () => {
    const o = await order();
    const base = { carrierId: carrier.id, plate: 'AB123CD', driverName: 'Pedro Gómez', driverDni: '30111222', price: 450000, plannedStart: new Date(Date.now() + 3600_000).toISOString(), orderIds: [o.id] };
    const blocked = await env.req('POST', '/api/carriers/trips', { token: norte, body: base });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.needsOverride, true);
    assert.match(blocked.json.error, /Inscripción RUTA/);
    const r = await env.req('POST', '/api/carriers/trips', { token: norte, body: { ...base, acceptWarnings: { reason: 'RUTA en trámite, comprobante a la vista' } } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    trip = r.json.trip;
    assert.equal(trip.vehicleId, `carrier:${carrier.id}`);
    assert.equal(trip.unitCode, 'Fletes del Oeste');
    assert.equal(trip.driverName, 'Pedro Gómez');
    assert.equal(trip.carrier.price, 450000);
    assert.equal(trip.carrier.linkTokenHash, undefined);
    assert.ok(trip.overrides.reason.includes('RUTA'));

    // With the documents in order no approval is needed.
    await env.req('PATCH', `/api/carriers/${carrier.id}`, {
      token: norte,
      body: { documents: [{ type: 'seguro_carga', expiresAt: plusDays(200) }, { type: 'ruta', expiresAt: plusDays(300) }] },
    });
    const o2 = await order();
    const ok = await env.req('POST', '/api/carriers/trips', { token: norte, body: { ...base, orderIds: [o2.id] } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.trip.overrides, undefined);
    assert.equal((await env.req('PATCH', `/api/tms/trips/${trip.id}`, { token: norte, body: { vehicleId: 'x' } })).status, 409);
  });

  test('link del viaje: el chofer ve solo ese viaje, comparte la posición y no carga combustible', async () => {
    const link = await env.req('POST', `/api/carriers/trips/${trip.id}/link`, { token: norte });
    assert.equal(link.status, 200);
    token = link.json.path.split('t=')[1];
    const me = await app('/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.carrier, true);
    assert.deepEqual(me.json.trips.map((t: any) => t.id), [trip.id]);
    assert.equal((await app(`/trips/${trip.id}/fuel`, { method: 'POST', body: { liters: 10, total: 1000 } })).status, 403);
    assert.equal((await app(`/trips/${trip.id}/expenses`, { method: 'POST', body: { type: 'peaje', amount: 10 } })).status, 403);

    assert.equal((await app(`/trips/${trip.id}/start`, { method: 'POST' })).status, 200);
    const pos = await app('/position', { method: 'POST', body: { lat: places[0].lat, lng: places[0].lng, accuracyM: 12 } });
    assert.equal(pos.status, 200, JSON.stringify(pos.json));
    const t = (await env.req('GET', `/api/tms/trips/${trip.id}`, { token: norte })).json.trip;
    assert.equal(t.carrier.lastPosition.lat, places[0].lat);
    assert.equal(t.carrier.linkActive, true);
    assert.equal(t.stops[0].status, 'en_lugar', 'la posición del celular detecta la llegada');
    assert.equal(t.stops[0].detection, 'auto');
  });

  test('cierre: costo = precio pactado; calificación; tablero de despacho', async () => {
    let t = (await env.req('GET', `/api/tms/trips/${trip.id}`, { token: norte })).json.trip;
    for (const s of t.stops) await env.req('POST', `/api/tms/trips/${trip.id}/stops/${s.id}`, { token: norte, body: { status: 'completada' } });
    t = (await env.req('GET', `/api/tms/trips/${trip.id}`, { token: norte })).json.trip;
    assert.equal(t.status, 'finalizado');
    const eco = (await env.req('GET', `/api/costs/trips/${trip.id}`, { token: norte })).json.economics;
    assert.equal(eco.cost.total, 450000);
    assert.match(eco.cost.lines[0].label, /Fletero Fletes del Oeste/);
    assert.equal((await app('/me')).json.trips.length, 1, 'el link sigue 24 h para ver el viaje cerrado');

    assert.equal((await env.req('POST', `/api/carriers/trips/${trip.id}/rating`, { token: norte, body: { score: 6 } })).status, 400);
    assert.equal((await env.req('POST', `/api/carriers/trips/${trip.id}/rating`, { token: norte, body: { score: 4, comment: 'Puntual' } })).status, 200);
    const row = (await env.req('GET', '/api/carriers', { token: norte })).json.items.find((c: any) => c.id === carrier.id);
    assert.equal(row.rating, 4);
    assert.equal(row.finished, 1);

    const board = (await env.req('GET', `/api/routing/dispatch?date=${today()}`, { token: norte })).json;
    const carrierRow = board.rows.find((r: any) => r.vehicleId === `carrier:${carrier.id}`);
    assert.ok(carrierRow, 'el fletero tiene su fila en el tablero');
    assert.equal(carrierRow.carrier, true);
  });

  test('liquidación: solo administradores, sin doble pago, anular libera los viajes', async () => {
    const body = { carrierId: carrier.id, from: today(), to: today() };
    assert.equal((await env.req('POST', '/api/carriers/settlements', { token: monitoreo, body })).status, 403);
    const s = await env.req('POST', '/api/carriers/settlements', { token: norte, body });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal(s.json.settlement.total, 450000);
    assert.match(s.json.settlement.id, /^LF-\d{4}-\d{4}$/);
    assert.equal((await env.req('POST', '/api/carriers/settlements', { token: norte, body })).status, 409, 'no liquida dos veces');
    assert.equal((await env.req('PATCH', `/api/carriers/trips/${trip.id}`, { token: norte, body: { price: 1 } })).status, 409, 'precio congelado');
    const pdf = await fetch(`${env.baseUrl}/api/carriers/settlements/${s.json.settlement.id}/export?format=pdf`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await env.req('POST', `/api/carriers/settlements/${s.json.settlement.id}/void`, { token: norte, body: { reason: 'Error de precio' } })).json.settlement.status, 'anulada');
    assert.equal((await env.req('PATCH', `/api/carriers/trips/${trip.id}`, { token: norte, body: { price: 430000 } })).status, 200);
    const again = await env.req('POST', '/api/carriers/settlements', { token: norte, body });
    assert.equal(again.json.settlement.total, 430000);
    const paid = await env.req('POST', `/api/carriers/settlements/${again.json.settlement.id}/pay`, { token: norte, body: { reference: 'Transf. 7781' } });
    assert.equal(paid.json.settlement.status, 'pagada');
    assert.equal((await env.req('POST', `/api/carriers/settlements/${again.json.settlement.id}/pay`, { token: norte, body: {} })).status, 409);
  });

  test('revocar el link corta el acceso del celular', async () => {
    assert.equal((await env.req('DELETE', `/api/carriers/trips/${trip.id}/link`, { token: norte })).status, 200);
    assert.equal((await app('/me')).status, 401);
  });
});
