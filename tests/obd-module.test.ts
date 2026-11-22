import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';
import { FakeTraccar } from './helpers/fakeTraccar.ts';
import { obdHealth, obdLink } from '../src/shared/obdHealth.ts';
import { buildSetupSms } from '../src/shared/teltonika.ts';

const fake = new FakeTraccar();
let env: TestEnv;
let norte: string;
let urbana: string;
let monitoreo: string;
let vehicle: any;
let second: any;
const IMEI = '352093081110001';
const IMEI2 = '352093081110002';
const auth = { Authorization: `Bearer ${INGEST_TOKEN}` };
/** Future base time aligned to 5-minute buckets (+10 s) so ingests are never stale. */
const BASE = Math.floor((Date.now() + 2 * 3_600_000) / 300_000) * 300_000 + 10_000;

const ingest = (offsetMs: number, attributes: Record<string, unknown>, uniqueId = IMEI) => {
  const fix = new Date(BASE + offsetMs).toISOString();
  return env.req('POST', '/ingest/traccar/position', {
    headers: auth,
    body: {
      position: { deviceId: 9, protocol: 'teltonika', serverTime: fix, fixTime: fix, valid: true, latitude: -31.5, longitude: -68.5, speed: 10, attributes: { ignition: true, ...attributes } },
      device: { id: 9, uniqueId, name: 'FMC003' },
    },
  });
};
const event = (type: string, attributes: Record<string, unknown> = {}, uniqueId = IMEI) =>
  env.req('POST', '/ingest/traccar/event', {
    headers: auth,
    body: { event: { type, eventTime: new Date().toISOString(), attributes }, device: { id: 9, uniqueId } },
  });
const obdState = async (id = vehicle.id) => (await env.req('GET', `/api/vehicles/${id}/obd`, { token: norte })).json;

before(
  async () => {
    await fake.start();
    env = new TestEnv({
      TRACCAR_WEB_URL: `http://127.0.0.1:${fake.port}`,
      TRACCAR_ADMIN_EMAIL: 'admin@test',
      TRACCAR_ADMIN_PASSWORD: 'secret',
    });
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const light = boot.vehicles.filter((v: any) => v.assetType === 'vehiculo');
    [vehicle, second] = light;
  },
  { timeout: 120_000 }
);
after(async () => {
  await env.close();
  await fake.close();
});

describe('OBD-II: SMS, salud y conexión (funciones puras)', () => {
  test('el SMS de programación lleva APN, servidor, puerto, TCP y Codec 8 Extended', () => {
    assert.equal(buildSetupSms({ apn: 'datos.personal.com', host: 'flota.ejemplo.com', port: 5027 }), '  setparam 2001:datos.personal.com;2004:flota.ejemplo.com;2005:5027;2006:0;113:1');
    assert.equal(buildSetupSms({ host: 'h', port: 5027 }), '  setparam 2004:h;2005:5027;2006:0;113:1');
  });

  test('salud: umbrales de temperatura, batería y fallas', () => {
    const base = { telemetrySourceEngine: 'obd' as const, coolantTempC: 90, batteryVoltage: 14.1, rpm: 900, ignition: true, faultCodes: [] };
    assert.equal(obdHealth(base).level, 'bien');
    assert.equal(obdHealth({ ...base, telemetrySourceEngine: 'simulada' }).level, 'sin_datos');
    assert.equal(obdHealth({ ...base, coolantTempC: 108 }).level, 'critico');
    assert.equal(obdHealth({ ...base, batteryVoltage: 12.8 }).level, 'atencion', 'en marcha el alternador debe dar más de 13,2 V');
    assert.equal(obdHealth({ ...base, rpm: 0, batteryVoltage: 12.4 }).level, 'bien', 'motor apagado: 12,4 V es normal');
    assert.equal(obdHealth({ ...base, rpm: 0, batteryVoltage: 11.6 }).level, 'atencion');
    const fault = (severity: 'critica' | 'advertencia') => ({ code: 'P0001', system: 'x', description: 'y', severity, source: 'obd' as const });
    assert.equal(obdHealth({ ...base, faultCodes: [fault('advertencia')] }).level, 'atencion');
    assert.equal(obdHealth({ ...base, faultCodes: [fault('critica')] }).level, 'critico');
    assert.equal(obdHealth({ ...base, faultCodes: [{ ...fault('critica'), source: 'simulada' as const }] }).level, 'bien', 'las fallas de demostración no cuentan');
  });

  test('conexión: esperando, conectado, sin señal y errores de alta', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    assert.equal(obdLink(undefined).state, 'sin_equipo');
    assert.equal(obdLink({ provisioning: { status: 'pendiente_sms', at: '' } }, now).state, 'esperando');
    assert.equal(obdLink({ provisioning: { status: 'error', at: '', message: 'x' } }, now).state, 'error');
    assert.equal(obdLink({ lastObdAt: '2026-11-20T11:55:00Z' }, now).state, 'conectado');
    assert.equal(obdLink({ lastObdAt: '2026-11-20T11:30:00Z' }, now).state, 'sin_senal');
  });
});

describe('OBD-II: alta automática en Traccar', () => {
  test('asignar crea el equipo en Traccar y queda esperando el SMS', async () => {
    const res = await env.req('PUT', `/api/vehicles/${vehicle.id}/obd`, { token: norte, body: { imei: IMEI, apn: 'datos.personal.com' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const t = fake.byUniqueId(IMEI);
    assert.ok(t, 'creado en Traccar');
    assert.equal(t.name, `${vehicle.unitCode} OBD`);
    const st = await obdState();
    assert.equal(st.device.traccarId, t.id);
    assert.equal(st.device.provisioning.status, 'pendiente_sms');
    assert.equal(st.device.apn, 'datos.personal.com');
    assert.equal(st.traccarApi, true);
    assert.equal((await env.req('GET', `/api/vehicles/${vehicle.id}/obd`, { token: urbana })).status, 404);
  });

  test('si Traccar falla queda en error y «Reintentar alta» lo resuelve', async () => {
    fake.fail = true;
    const res = await env.req('PUT', `/api/vehicles/${second.id}/obd`, { token: norte, body: { imei: IMEI2 } });
    assert.equal(res.status, 200, 'el equipo se guarda igual en el panel');
    let st = await obdState(second.id);
    assert.equal(st.device.provisioning.status, 'error');
    assert.match(st.device.provisioning.message, /500/);
    fake.fail = false;
    const sync = await env.req('POST', `/api/vehicles/${second.id}/obd/sync`, { token: norte });
    assert.equal(sync.status, 200);
    st = await obdState(second.id);
    assert.equal(st.device.provisioning.status, 'pendiente_sms');
    assert.ok(st.device.traccarId);
    assert.equal((await env.req('POST', `/api/vehicles/${second.id}/obd/sync`, { token: monitoreo })).status, 403);
  });

  test('el primer reporte lo pasa a conectado', async () => {
    const r = await ingest(0, { rpm: 1000, coolantTemp: 85, fuelLevel: 50, power: 14.0 });
    assert.equal(r.json.matched, true);
    const st = await obdState();
    assert.equal(st.device.provisioning.status, 'conectado');
    assert.ok(st.device.provisioning.firstReportAt);
    assert.equal(st.vehicle.telemetrySourceEngine, 'obd');
  });
});

describe('OBD-II: configuración remota', () => {
  test('envía solo comandos de la lista y registra cada envío', async () => {
    const ok = await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: norte, body: { commandId: 'report_profile', option: 'normal' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.entry.status, 'enviado');
    assert.deepEqual(fake.commands.at(-1), { deviceId: fake.byUniqueId(IMEI)!.id, data: 'setparam 10050:30;10000:300' });

    fake.queued = true;
    const q = await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: norte, body: { commandId: 'getver' } });
    assert.equal(q.json.entry.status, 'en_cola');
    fake.queued = false;

    assert.equal((await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: norte, body: { commandId: 'setparam 2004:evil' } })).status, 400);
    assert.equal(
      (await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: norte, body: { commandId: 'report_profile', option: 'turbo' } })).status,
      400
    );
    assert.equal((await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: monitoreo, body: { commandId: 'getver' } })).status, 403);
    assert.equal((await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: urbana, body: { commandId: 'getver' } })).status, 404);

    const st = await obdState();
    assert.equal(st.device.commandLog.length, 2);
    assert.equal(st.device.commandLog[0].commandId, 'getver', 'el más nuevo primero');
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.ok(boot.auditLogs.some((l: any) => l.action === 'Comando OBD-II enviado'));
  });

  test('si Traccar falla el comando queda con error', async () => {
    fake.fail = true;
    const res = await env.req('POST', `/api/vehicles/${vehicle.id}/obd/commands`, { token: norte, body: { commandId: 'getstatus' } });
    fake.fail = false;
    assert.equal(res.status, 502);
    assert.equal((await obdState()).device.commandLog[0].status, 'error');
  });

  test('la respuesta del equipo (commandResult) queda en el comando más viejo pendiente', async () => {
    await event('commandResult', { result: 'Code Ver:03.28.07_04 GPS Ver:AXN_5.10' });
    const log = (await obdState()).device.commandLog;
    const profile = log.find((c: any) => c.commandId === 'report_profile');
    assert.equal(profile.status, 'respondido');
    assert.match(profile.response, /Ver:03\.28/);
    assert.equal(log.find((c: any) => c.commandId === 'getver').status, 'en_cola', 'el siguiente sigue esperando');
  });
});

describe('OBD-II: historial y fallas', () => {
  test('una muestra por minuto como máximo; el historial agrega por intervalos', async () => {
    // Same 5-minute bucket: the reading 30 s later must be discarded (otherwise the average would be 2000).
    await ingest(60_000, { rpm: 1000, coolantTemp: 90, power: 13.9 });
    await ingest(90_000, { rpm: 3000, coolantTemp: 90, power: 13.9 });
    const res = await env.req('GET', `/api/vehicles/${vehicle.id}/obd/history?range=24h`, { token: norte });
    assert.equal(res.status, 200);
    const bucket = res.json.points.find((p: any) => Date.parse(p.at) === BASE - 10_000);
    assert.ok(bucket, JSON.stringify(res.json.points));
    // Bucket = first report (t+0: 1000 rpm, 85 °C) + t+60 s (1000 rpm, 90 °C); t+90 s is dropped.
    assert.equal(bucket.rpm, 1000);
    assert.equal(bucket.coolantC, 87.5);
    assert.equal(bucket.coolantMaxC, 90);
    const week = await env.req('GET', `/api/vehicles/${vehicle.id}/obd/history?range=7d`, { token: norte });
    assert.ok(week.json.points.length >= 1);
    assert.ok('coolantMaxC' in week.json.points[0]);
    assert.equal((await env.req('GET', `/api/vehicles/${vehicle.id}/obd/history`, { token: urbana })).status, 404);
  });

  test('un código abre un evento y al borrarse se cierra', async () => {
    await ingest(5 * 60_000, { rpm: 1500, dtcs: 'P0420' });
    let faults = (await env.req('GET', `/api/vehicles/${vehicle.id}/obd/faults`, { token: norte })).json.faults;
    const open = faults.find((f: any) => f.code === 'P0420');
    assert.ok(open);
    assert.equal(open.clearedAt, null);
    assert.ok(open.workOrderId, 'ligado a la OT correctiva');
    await ingest(7 * 60_000, { rpm: 1500, dtcs: '' });
    faults = (await env.req('GET', `/api/vehicles/${vehicle.id}/obd/faults`, { token: norte })).json.faults;
    assert.ok(faults.find((f: any) => f.code === 'P0420').clearedAt);
    assert.equal((await env.req('GET', `/api/vehicles/${vehicle.id}/obd/faults`, { token: urbana })).status, 404);
  });

  test('quitar el equipo lo borra de Traccar', async () => {
    const id = fake.byUniqueId(IMEI)!.id;
    assert.equal((await env.req('DELETE', `/api/vehicles/${vehicle.id}/obd`, { token: norte })).status, 200);
    assert.equal(fake.devices.has(id), false);
  });
});

describe('OBD-II: servidor editable (túnel TCP)', () => {
  test('el superadmin cambia host y puerto; se rechazan túneles HTTP y URLs; se puede restaurar', async () => {
    const superadmin = await env.token(...DEMO.superadmin);
    const put = (token: string, server: unknown) => env.req('PUT', '/api/settings/obd-server', { token, body: { server } });

    assert.equal((await put(norte, { host: '0.tcp.sa.ngrok.io', port: 14523 })).status, 403);
    const tunnel = await put(superadmin, { host: 'cxsxdnnc-5055.brs.devtunnels.ms', port: 443 });
    assert.equal(tunnel.status, 400);
    assert.match(tunnel.json.error, /solo transmiten HTTP/);
    assert.equal((await put(superadmin, { host: 'https://0.tcp.sa.ngrok.io', port: 14523 })).status, 400, 'sin protocolo');
    assert.equal((await put(superadmin, { host: '0.tcp.sa.ngrok.io:14523', port: 14523 })).status, 400, 'el puerto va aparte');
    assert.equal((await put(superadmin, { host: '0.tcp.sa.ngrok.io', port: 70000 })).status, 400);

    const ok = await put(superadmin, { host: '0.TCP.sa.ngrok.io', port: 14523 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.deviceConnection.obdHost, '0.tcp.sa.ngrok.io');
    assert.equal(ok.json.deviceConnection.obdPort, 14523);
    assert.equal(ok.json.deviceConnection.obdServerCustom, true);
    assert.equal(ok.json.deviceConnection.teltonikaPort, 5027, 'el puerto local de Traccar no cambia');
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(boot.deviceConnection.obdHost, '0.tcp.sa.ngrok.io', 'todas las empresas lo ven');

    const reset = await put(superadmin, null);
    assert.equal(reset.json.deviceConnection.obdHost, 'flota.test.local');
    assert.equal(reset.json.deviceConnection.obdPort, 5027);
    assert.equal(reset.json.deviceConnection.obdServerCustom, false);
  });
});


describe('Alta de unidades con Telemetría OBD-II o Conexión Smartphone', () => {
  const body = (n: number, extra: Record<string, unknown>) => ({ unitCode: `CNX-${n}`, plate: `CX${n}22ZZ`, brand: 'Fiat', model: 'Cronos', ...extra });

  test('OBD-II: el equipo queda en el módulo OBD y se crea en Traccar', async () => {
    const imei = '352093081110077';
    const r = await env.req('POST', '/api/vehicles', { token: norte, body: body(1, { connection: 'obd', imei, deviceCatalogId: 'teltonika-fmc003' }) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.device.role, 'telemetria');
    assert.equal(r.json.device.imei, imei);
    assert.equal(r.json.vehicle.deviceId, r.json.device.id);
    assert.ok(fake.byUniqueId(imei), 'alta automática en Traccar');
    const obd = await obdState(r.json.vehicle.id);
    assert.equal(obd.device.id, r.json.device.id);
  });

  test('OBD-II: IMEI repetido o equipo que no es OBD se rechazan', async () => {
    const dup = await env.req('POST', '/api/vehicles', { token: norte, body: body(2, { connection: 'obd', imei: '352093081110077' }) });
    assert.equal(dup.status, 400);
    const cam = await env.req('POST', '/api/vehicles', { token: norte, body: body(3, { connection: 'obd', imei: '352093081110078', deviceCatalogId: 'jimi-jc181' }) });
    assert.equal(cam.status, 400);
  });

  test('Smartphone: sin equipo ni IMEI; la posición la da el celular del chofer', async () => {
    const r = await env.req('POST', '/api/vehicles', { token: norte, body: body(4, { connection: 'smartphone' }) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.device, null);
    assert.equal(r.json.vehicle.deviceId, '');
    assert.equal(r.json.vehicle.positionSource, 'smartphone');
    const noImei = await env.req('POST', '/api/vehicles', { token: norte, body: body(5, { connection: 'dashcam' }) });
    assert.equal(noImei.status, 400, 'una dashcam sigue pidiendo IMEI');
  });
});
