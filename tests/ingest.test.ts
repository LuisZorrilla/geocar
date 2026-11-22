import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
let norte: string;
let urbana: string;
let superadmin: string;
let device: any;
let vehicle: any;

const auth = { Authorization: `Bearer ${INGEST_TOKEN}` };

function position(uniqueId: string, lat: number, lng: number, speedKnots = 27) {
  const now = new Date().toISOString();
  return {
    position: {
      deviceId: 7,
      protocol: 'jt808',
      serverTime: now,
      deviceTime: now,
      fixTime: now,
      valid: true,
      latitude: lat,
      longitude: lng,
      altitude: 640,
      speed: speedKnots,
      course: 91.5,
      attributes: { ignition: true, odometer: 123456, sat: 11 },
    },
    device: { id: 7, uniqueId, name: 'Cámara piloto', status: 'online' },
  };
}

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    superadmin = await env.token(...DEMO.superadmin);
    const data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    // An en_ruta unit, so we can also check that the simulation stops moving it.
    vehicle = data.vehicles.find((v: any) => v.operationalStatus === 'en_ruta');
    device = data.devices.find((d: any) => d.vehicleId === vehicle.id);
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('ingesta Traccar', () => {
  test('sin token o con token incorrecto → 401', async () => {
    const body = position(device.terminalId, -31.53, -68.53);
    assert.equal((await env.req('POST', '/ingest/traccar/position', { body })).status, 401);
    const wrong = await env.req('POST', '/ingest/traccar/position', { body, headers: { Authorization: 'Bearer otro' } });
    assert.equal(wrong.status, 401);
  });

  test('payload inválido → 400', async () => {
    const res = await env.req('POST', '/ingest/traccar/position', {
      headers: auth,
      body: { position: { latitude: 'norte' }, device: { uniqueId: device.terminalId } },
    });
    assert.equal(res.status, 400);
  });

  test('una posición real mueve la unidad y marca el equipo como conectado vía Traccar', async () => {
    const res = await env.req('POST', '/ingest/traccar/position', {
      headers: auth,
      body: position(device.terminalId, -31.5368, -68.5432),
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.matched, true);

    const data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const v = data.vehicles.find((x: any) => x.id === vehicle.id);
    const d = data.devices.find((x: any) => x.id === device.id);
    assert.equal(v.lat, -31.5368);
    assert.equal(v.lng, -68.5432);
    assert.equal(v.speedKmh, 50); // 27 knots × 1.852
    assert.equal(v.heading, 92);
    assert.equal(v.odometerKm, 123.5);
    assert.equal(v.operationalStatus, 'en_ruta');
    assert.equal(d.linkStatus, 'conectado');
    assert.equal(d.telemetrySource, 'traccar');
  });

  test('la simulación ya no mueve una unidad con datos reales', async () => {
    const tick = await env.req('POST', '/api/telemetry/tick', { token: norte });
    assert.equal(tick.status, 200);
    const v = tick.json.vehicles.find((x: any) => x.id === vehicle.id);
    assert.equal(v.lat, -31.5368);
    assert.equal(v.lng, -68.5432);
  });

  test('posiciones fuera de orden no hacen retroceder la unidad', async () => {
    const t2 = new Date(Date.now() + 60_000).toISOString();
    const t1 = new Date(Date.now() + 30_000).toISOString();
    const send = async (lat: number, fixTime: string, id: number) => {
      const body = position(device.terminalId, lat, -68.54);
      Object.assign(body.position, { fixTime, id });
      const r = await env.req('POST', '/ingest/traccar/position', { headers: auth, body });
      assert.equal(r.status, 200);
      return r.json;
    };
    const current = async () =>
      (await env.req('GET', '/api/bootstrap', { token: norte })).json.vehicles.find((v: any) => v.id === vehicle.id).lat;

    assert.equal((await send(-31.52, t2, 10)).stale, undefined); // newest so far → applied
    assert.equal((await send(-31.51, t1, 11)).stale, true); // older timestamp → ignored
    assert.equal((await send(-31.50, t2, 9)).stale, true); // same timestamp, lower Traccar id → ignored
    assert.equal(await current(), -31.52);
    assert.equal((await send(-31.49, t2, 12)).stale, undefined); // same timestamp, higher id → applied
    assert.equal(await current(), -31.49);
  });

  test('un ID desconocido aparece solo al superadmin como «sin asignar»', async () => {
    const res = await env.req('POST', '/ingest/traccar/position', {
      headers: auth,
      body: position('555000111222', -31.5, -68.5),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.matched, false);

    const sa = (await env.req('GET', '/api/bootstrap', { token: superadmin })).json;
    assert.ok(sa.unmatchedDevices.some((u: any) => u.uniqueId === '555000111222'));
    const tenant = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(tenant.unmatchedDevices, undefined);
  });

  test('una alarma SOS crea una alerta crítica solo para la empresa dueña', async () => {
    const now = new Date().toISOString();
    const res = await env.req('POST', '/ingest/traccar/event', {
      headers: auth,
      body: {
        event: { id: 1, type: 'alarm', eventTime: now, deviceId: 7, attributes: { alarm: 'sos' } },
        position: { latitude: -31.5371, longitude: -68.5401, fixTime: now, speed: 0, attributes: { alarm: 'sos' } },
        device: { id: 7, uniqueId: device.terminalId },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.alertId);

    const data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const alert = data.alerts.find((a: any) => a.id === res.json.alertId);
    assert.equal(alert.priority, 'critica');
    assert.equal(alert.status, 'pendiente');
    assert.equal(alert.vehicleId, vehicle.id);
    assert.equal(data.vehicles.find((v: any) => v.id === vehicle.id).operationalStatus, 'alerta');

    const other = (await env.req('GET', '/api/bootstrap', { token: urbana })).json;
    assert.ok(!other.alerts.some((a: any) => a.id === res.json.alertId));
  });

  test('evento deviceOffline marca el equipo como desconectado', async () => {
    const res = await env.req('POST', '/ingest/traccar/event', {
      headers: auth,
      body: { event: { type: 'deviceOffline', eventTime: new Date().toISOString() }, device: { uniqueId: device.terminalId } },
    });
    assert.equal(res.status, 200);
    const data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(data.devices.find((d: any) => d.id === device.id).linkStatus, 'desconectado');
  });

  test('los datos de Traccar se guardan en PostgreSQL (sobreviven a un reinicio)', async () => {
    const before = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const latBefore = before.vehicles.find((v: any) => v.id === vehicle.id).lat;
    await new Promise((r) => setTimeout(r, 2500)); // persistSoon debounce
    await env.restartApp();
    const data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const d = data.devices.find((x: any) => x.id === device.id);
    assert.equal(d.telemetrySource, 'traccar');
    assert.equal(data.vehicles.find((v: any) => v.id === vehicle.id).lat, latBefore);
  });
});

describe('ingesta Traccar deshabilitada', () => {
  const off = new TestEnv({ INGEST_TOKEN: '' });
  before(() => off.start(), { timeout: 120_000 });
  after(() => off.close());

  test('sin INGEST_TOKEN → 503', async () => {
    const res = await off.req('POST', '/ingest/traccar/position', {
      headers: auth,
      body: position('1', -31.5, -68.5),
    });
    assert.equal(res.status, 503);
    const t = await off.token(...DEMO.norte);
    const data = (await off.req('GET', '/api/bootstrap', { token: t })).json;
    assert.equal(data.deviceConnection.ingestEnabled, false);
  });
});
