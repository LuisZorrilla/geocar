import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';
import { extractObd } from '../server/ingest/obd.ts';
import { describeDtc, parseDtcList } from '../src/shared/dtc.ts';

const env = new TestEnv();
let norte: string;
let urbana: string;
let vehicle: any;
const IMEI = '352093081234567';
const auth = { Authorization: `Bearer ${INGEST_TOKEN}` };
let minute = 0;

/** Teltonika position forwarded by Traccar; each call is one minute later than the previous. */
function obdPosition(uniqueId: string, attributes: Record<string, unknown>) {
  const fix = new Date(Date.now() + ++minute * 60_000).toISOString();
  return {
    position: {
      deviceId: 9,
      protocol: 'teltonika',
      serverTime: fix,
      fixTime: fix,
      valid: true,
      latitude: -31.536,
      longitude: -68.55,
      speed: 20,
      course: 90,
      attributes: { ignition: true, ...attributes },
    },
    device: { id: 9, uniqueId, name: 'FMC003 piloto' },
  };
}

const ingest = (attributes: Record<string, unknown>, uniqueId = IMEI) =>
  env.req('POST', '/ingest/traccar/position', { headers: auth, body: obdPosition(uniqueId, attributes) });
const boot = async (token = norte) => (await env.req('GET', '/api/bootstrap', { token })).json;
const unit = async () => (await boot()).vehicles.find((v: any) => v.id === vehicle.id);

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    vehicle = (await boot()).vehicles.find((v: any) => v.assetType === 'vehiculo');
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('OBD-II: lectura de atributos y códigos', () => {
  test('claves estándar de Traccar y respaldo ioNN de Teltonika', () => {
    const std = extractObd({ rpm: 2100, coolantTemp: 91, fuelLevel: 55, obdOdometer: 48_210_400, hours: 3_600_000 * 1520.5, power: 13.8, vin: '8ajfb8cd1k1234567', dtcs: 'P0420 p0171' });
    assert.deepEqual(std, { rpm: 2100, coolantTempC: 91, fuelPct: 55, odometerKm: 48210.4, engineHours: 1520.5, batteryV: 13.8, vin: '8AJFB8CD1K1234567', dtcs: ['P0420', 'P0171'] });
    const io = extractObd({ io36: 1500, io32: 87, io390: 40, io389: 51000, io66: 12650, io30: 0 });
    assert.deepEqual(io, { rpm: 1500, coolantTempC: 87, fuelPct: 40, odometerKm: 51000, batteryV: 12.65, dtcs: [] });
    assert.equal(extractObd({ ignition: true, sat: 9 }), null, 'una posición sin datos de motor no toca la unidad');
    assert.equal(extractObd({ rpm: 'basura', coolantTemp: 900 }), null, 'valores fuera de rango se ignoran');
  });

  test('códigos: normalización y descripción en español', () => {
    assert.deepEqual(parseDtcList('p0420,P0420; 0301 xyz'), ['P0420', 'P0301']);
    assert.equal(describeDtc('P0420').severity, 'advertencia');
    assert.equal(describeDtc('P0301').severity, 'critica');
    assert.match(describeDtc('P1234').description, /fabricante/);
    assert.equal(describeDtc('U0100').system, 'Red de comunicación');
  });
});

describe('OBD-II: equipo, ingesta, alerta y OT', () => {
  test('asignar: valida IMEI, permisos y empresa; crea un equipo de telemetría', async () => {
    assert.equal((await env.req('PUT', `/api/vehicles/${vehicle.id}/obd`, { token: norte, body: { imei: '123' } })).status, 400);
    assert.equal((await env.req('PUT', `/api/vehicles/${vehicle.id}/obd`, { token: urbana, body: { imei: IMEI } })).status, 404);
    const monitoreo = await env.token(...DEMO.norteMonitoreo);
    assert.equal((await env.req('PUT', `/api/vehicles/${vehicle.id}/obd`, { token: monitoreo, body: { imei: IMEI } })).status, 403);

    const res = await env.req('PUT', `/api/vehicles/${vehicle.id}/obd`, {
      token: norte,
      body: { imei: IMEI, catalogModelId: 'teltonika-fmc003', vin: '' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.device.role, 'telemetria');
    assert.equal(res.json.device.terminalId, IMEI);
    assert.equal(res.json.device.model, 'Teltonika FMC003');
    assert.equal(res.json.vehicles.find((v: any) => v.id === vehicle.id).obdDeviceId, res.json.device.id);

    const other = (await boot()).vehicles.find((v: any) => v.id !== vehicle.id && v.assetType === 'vehiculo');
    const dup = await env.req('PUT', `/api/vehicles/${other.id}/obd`, { token: norte, body: { imei: IMEI } });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /IMEI ya está registrado/);
  });

  test('la ingesta actualiza el motor de la unidad y marca la fuente como OBD-II', async () => {
    const r = await ingest({ rpm: 2200, coolantTemp: 92, fuelLevel: 61, obdOdometer: 48_500_000, odometer: 1_000, power: 13.7, vin: '8AJFB8CD1K1234567' });
    assert.equal(r.status, 200);
    assert.equal(r.json.matched, true);
    const v = await unit();
    assert.equal(v.rpm, 2200);
    assert.equal(v.coolantTempC, 92);
    assert.equal(v.fuelLevelPct, 61);
    assert.equal(v.odometerKm, 48500, 'el odómetro OBD tiene prioridad');
    assert.equal(v.batteryVoltage, 13.7);
    assert.equal(v.vin, '8AJFB8CD1K1234567');
    assert.equal(v.telemetrySourceEngine, 'obd');
  });

  test('un DTC nuevo abre una alerta y una OT; repetido no duplica; al borrarse sale de fallas activas', async () => {
    const before = await boot();
    const alerts0 = before.alerts.length;
    const orders0 = before.workOrders.length;

    await ingest({ rpm: 1900, dtcs: 'P0420' });
    let data = await boot();
    let v = data.vehicles.find((x: any) => x.id === vehicle.id);
    const fault = v.faultCodes.find((f: any) => f.code === 'P0420');
    assert.ok(fault, 'P0420 en fallas activas');
    assert.equal(fault.source, 'obd');
    assert.ok(!v.faultCodes.some((f: any) => f.source !== 'obd' && f.source !== 'can'), 'reemplaza las fallas de demostración');
    assert.equal(data.alerts.length, alerts0 + 1);
    assert.equal(data.alerts[0].ruleName, 'Falla OBD-II P0420');
    assert.equal(data.workOrders.length, orders0 + 1);
    const order = data.workOrders.find((o: any) => o.id === fault.workOrderId);
    assert.ok(order, 'la falla queda ligada a su OT');
    assert.equal(order.type, 'correctivo');
    assert.match(order.title, /P0420/);

    await ingest({ rpm: 1950, dtcs: 'P0420' });
    data = await boot();
    assert.equal(data.alerts.length, alerts0 + 1, 'sin alerta duplicada');
    assert.equal(data.workOrders.length, orders0 + 1, 'sin OT duplicada');

    await ingest({ rpm: 900, dtcs: '' });
    data = await boot();
    v = data.vehicles.find((x: any) => x.id === vehicle.id);
    assert.ok(!v.faultCodes.some((f: any) => f.code === 'P0420'), 'borrada');
    assert.ok(data.workOrders.some((o: any) => o.id === order.id && o.status !== 'completada'), 'la OT sigue abierta para el taller');
    assert.ok(data.auditLogs.some((l: any) => l.action === 'Falla borrada' && l.detail.includes('P0420')));
  });

  test('un código crítico abre la OT con prioridad crítica', async () => {
    await ingest({ dtcs: 'P0301' });
    const data = await boot();
    const v = data.vehicles.find((x: any) => x.id === vehicle.id);
    const f = v.faultCodes.find((x: any) => x.code === 'P0301');
    assert.equal(f.severity, 'critica');
    assert.equal(data.workOrders.find((o: any) => o.id === f.workOrderId).priority, 'critica');
    assert.equal(data.alerts[0].priority, 'critica');
  });

  test('IMEI desconocido queda sin asignar; quitar el equipo vuelve a datos simulados', async () => {
    const unknown = await ingest({ rpm: 1000 }, '352093089999999');
    assert.equal(unknown.json.matched, false);
    const superadmin = await env.token(...DEMO.superadmin);
    assert.ok((await boot(superadmin)).unmatchedDevices.some((u: any) => u.uniqueId === '352093089999999'));

    const del = await env.req('DELETE', `/api/vehicles/${vehicle.id}/obd`, { token: norte });
    assert.equal(del.status, 200);
    const v = del.json.vehicles.find((x: any) => x.id === vehicle.id);
    assert.equal(v.obdDeviceId, undefined);
    assert.equal(v.telemetrySourceEngine, 'simulada');
    assert.ok(!del.json.devices.some((d: any) => d.imei === IMEI));
    assert.equal((await env.req('DELETE', `/api/vehicles/${vehicle.id}/obd`, { token: norte })).status, 404);
  });
});
