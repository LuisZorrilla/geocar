import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';
import { FAKE_TRACCAR_ENV, FakeTraccar } from './helpers/fakeTraccar.ts';
import { buildClientConfigUri, buildShareText, newPhoneIdentifier, phoneLink, recommendedSettings } from '../src/shared/phone.ts';

const fake = new FakeTraccar();
let env: TestEnv;
let norte: string;
let urbana: string;
let monitoreo: string;
/** Driver with a unit whose camera is silent (the phone moves the unit). */
let driverA: any;
let unitA: any;
/** Driver with a unit whose camera reports (the camera wins). */
let driverB: any;
let unitB: any;
/** Driver without a unit (off shift). */
let driverC: any;
const auth = { Authorization: `Bearer ${INGEST_TOKEN}` };
let clock = Date.now() + 60_000;
const next = () => new Date((clock += 30_000)).toISOString();

const position = (uniqueId: string, extra: { lat?: number; lng?: number; accuracy?: number; battery?: number; charge?: boolean; protocol?: string } = {}) => {
  const fix = next();
  return env.req('POST', '/ingest/traccar/position', {
    headers: auth,
    body: {
      position: {
        deviceId: 7,
        protocol: extra.protocol ?? 'osmand',
        serverTime: new Date().toISOString(),
        fixTime: fix,
        valid: true,
        latitude: extra.lat ?? -31.54,
        longitude: extra.lng ?? -68.55,
        speed: 20,
        course: 90,
        accuracy: extra.accuracy ?? 10,
        attributes: { batteryLevel: extra.battery ?? 80, charge: extra.charge ?? false },
      },
      device: { id: 7, uniqueId },
    },
  });
};
const phones = async (token = norte) => (await env.req('GET', '/api/phones', { token })).json.phones as any[];
const row = async (driverId: string) => (await phones()).find((p) => p.driverId === driverId);
const boot = async () => (await env.req('GET', '/api/bootstrap', { token: norte })).json;

before(
  async () => {
    await fake.start();
    env = new TestEnv(FAKE_TRACCAR_ENV(fake.port));
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    const data = await boot();
    const assigned = data.vehicles.filter((v: any) => v.driverId && data.drivers.some((d: any) => d.id === v.driverId && d.enabled !== false));
    [unitA, unitB] = assigned;
    driverA = data.drivers.find((d: any) => d.id === unitA.driverId);
    driverB = data.drivers.find((d: any) => d.id === unitB.driverId);
    driverC = data.drivers.find((d: any) => d.enabled !== false && !data.vehicles.some((v: any) => v.driverId === d.id));
    if (!driverC) {
      // Free one driver from its unit.
      const v = assigned[2];
      driverC = data.drivers.find((d: any) => d.id === v.driverId);
      const r = await env.req('PATCH', `/api/drivers/${driverC.id}`, { token: norte, body: { vehicleId: null } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
  },
  { timeout: 120_000 }
);
after(async () => {
  await env.close();
  await fake.close();
});

describe('Smartphone: funciones puras', () => {
  test('identificador, ajustes por plataforma, mensaje y estado de conexión', () => {
    assert.match(newPhoneIdentifier(), /^GC-\d{8}$/);
    assert.ok(recommendedSettings('android').some((s) => s.label === 'Wake lock'));
    assert.ok(!recommendedSettings('ios').some((s) => s.label === 'Wake lock' || s.label === 'Interval'), 'iOS no tiene wake lock ni intervalo');
    const text = buildShareText({ driverName: 'Juan Pérez', identifier: 'GC-12345678', serverUrl: 'http://flota:5055', platform: 'ios' });
    assert.match(text, /GC-12345678/);
    assert.match(text, /http:\/\/flota:5055/);
    assert.match(text, /App Store/);
    const now = Date.parse('2026-11-20T12:00:00Z');
    assert.equal(phoneLink(undefined).state, 'sin_celular');
    assert.equal(phoneLink({ provisioning: { status: 'pendiente_app', at: '' } }, now).state, 'esperando');
    assert.equal(phoneLink({ lastSeenAt: '2026-11-20T11:55:00Z' }, now).state, 'conectado');
    assert.equal(phoneLink({ lastSeenAt: '2026-11-20T11:40:00Z' }, now).state, 'sin_senal');
  });
});

describe('Smartphone: alta en el panel y en Traccar', () => {
  test('alta: genera el identificador y crea el dispositivo en Traccar', async () => {
    const res = await env.req('PUT', `/api/drivers/${driverA.id}/phone`, { token: norte, body: { platform: 'android' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const t = res.json.tracker;
    assert.match(t.identifier, /^GC-\d{8}$/);
    const inTraccar = fake.byUniqueId(t.identifier);
    assert.ok(inTraccar);
    assert.equal(inTraccar.name, `Celular · ${driverA.name}`);
    const r = await row(driverA.id);
    assert.equal(r.tracker.provisioning.status, 'pendiente_app');
    assert.equal(r.tracker.traccarId, inTraccar.id);
    assert.equal(r.assignedVehicle.id, unitA.id);
  });

  test('permisos y aislamiento por empresa', async () => {
    assert.equal((await env.req('PUT', `/api/drivers/${driverB.id}/phone`, { token: monitoreo, body: { platform: 'ios' } })).status, 403);
    assert.equal((await env.req('PUT', `/api/drivers/${driverB.id}/phone`, { token: urbana, body: { platform: 'ios' } })).status, 404);
    assert.equal((await env.req('PUT', `/api/drivers/${driverB.id}/phone`, { token: norte, body: { platform: 'nokia' } })).status, 400);
    assert.ok(!(await phones(urbana)).some((p) => p.driverId === driverA.id), 'otra empresa no ve los celulares');
    assert.equal((await env.req('GET', '/api/phones', { token: monitoreo })).status, 403, 'monitoreo no tiene acceso a Configuración de Cámaras');
  });

  test('nuevo identificador: el anterior se borra de Traccar', async () => {
    await env.req('PUT', `/api/drivers/${driverB.id}/phone`, { token: norte, body: { platform: 'ios' } });
    const before = (await row(driverB.id)).tracker;
    const res = await env.req('PUT', `/api/drivers/${driverB.id}/phone`, { token: norte, body: { platform: 'ios', regenerate: true } });
    assert.equal(res.status, 200);
    assert.notEqual(res.json.tracker.identifier, before.identifier);
    assert.equal(fake.byUniqueId(before.identifier), undefined);
    assert.ok(fake.byUniqueId(res.json.tracker.identifier));
  });
});

describe('Smartphone: ingesta', () => {
  test('sin unidad asignada: registra batería, conexión y la última posición del celular', async () => {
    await env.req('PUT', `/api/drivers/${driverC.id}/phone`, { token: norte, body: { platform: 'android' } });
    const id = (await row(driverC.id)).tracker.identifier;
    const r = await position(id, { battery: 55 });
    assert.equal(r.json.matched, true);
    assert.equal(r.json.phone, true);
    const t = (await row(driverC.id)).tracker;
    assert.equal(t.batteryPct, 55);
    assert.equal(t.provisioning.status, 'conectado');
    assert.ok(t.lastSeenAt);
    assert.ok(t.lastFix, 'la última posición del celular queda registrada');
    assert.equal(t.lastFix.vehicleId, undefined, 'sin unidad: no mueve ninguna');
    assert.equal(r.json.vehicleId, undefined);
  });

  test('con unidad y sin equipo reportando: el celular mueve la unidad', async () => {
    const id = (await row(driverA.id)).tracker.identifier;
    const r = await position(id, { lat: -31.6001, lng: -68.6001 });
    assert.equal(r.json.vehicleId, unitA.id);
    const v = (await boot()).vehicles.find((x: any) => x.id === unitA.id);
    assert.equal(v.lat, -31.6001);
    assert.equal(v.positionSource, 'smartphone');
    assert.equal(v.positionSourceLabel, `Celular de ${driverA.name}`);
    const t = (await row(driverA.id)).tracker;
    assert.equal(t.lastFix.vehicleId, unitA.id);
    assert.equal((await row(driverA.id)).assignedVehicle.positionSource, 'smartphone');
  });

  test('un fix impreciso (±250 m) se descarta', async () => {
    const id = (await row(driverA.id)).tracker.identifier;
    const r = await position(id, { lat: -31.7, lng: -68.7, accuracy: 250 });
    assert.equal(r.json.stale, true);
    const v = (await boot()).vehicles.find((x: any) => x.id === unitA.id);
    assert.equal(v.lat, -31.6001, 'la unidad no salta');
  });

  test('si la cámara de la unidad reporta, la posición sale de la cámara', async () => {
    const camera = (await boot()).devices.find((d: any) => d.vehicleId === unitB.id && d.role !== 'telemetria');
    assert.ok(camera, 'la unidad B tiene cámara');
    await position(camera.terminalId, { lat: -31.5, lng: -68.5, protocol: 'jt808' });
    const id = (await row(driverB.id)).tracker.identifier;
    await position(id, { lat: -31.9, lng: -68.9 });
    const v = (await boot()).vehicles.find((x: any) => x.id === unitB.id);
    assert.equal(v.lat, -31.5);
    assert.equal(v.positionSource, 'equipo');
    assert.equal((await row(driverB.id)).tracker.lastFix.lat, -31.9, 'el celular queda como dato del chofer');
  });
});

describe('Smartphone: alertas y baja', () => {
  test('batería baja: una alerta por turno, sin duplicados', async () => {
    const id = (await row(driverA.id)).tracker.identifier;
    const before = (await boot()).alerts.length;
    await position(id, { battery: 10 });
    await position(id, { battery: 9 });
    const data = await boot();
    assert.equal(data.alerts.length, before + 1);
    assert.equal(data.alerts[0].ruleName, 'Batería baja del celular del chofer');
    assert.equal(data.alerts[0].vehicleId, unitA.id);
  });

  test('SOS desde el celular: alerta crítica con chofer y unidad', async () => {
    const id = (await row(driverA.id)).tracker.identifier;
    const r = await env.req('POST', '/ingest/traccar/event', {
      headers: auth,
      body: { event: { type: 'alarm', eventTime: new Date().toISOString(), attributes: { alarm: 'sos' } }, device: { id: 7, uniqueId: id } },
    });
    assert.ok(r.json.alertId);
    const alert = (await boot()).alerts.find((a: any) => a.id === r.json.alertId);
    assert.equal(alert.priority, 'critica');
    assert.equal(alert.driverName, driverA.name);
    assert.equal(alert.unitCode, unitA.unitCode);
    assert.match(alert.summary, /celular/);
  });

  test('quitar el celular lo borra de Traccar y el identificador queda sin asignar', async () => {
    const t = (await row(driverA.id)).tracker;
    const del = await env.req('DELETE', `/api/drivers/${driverA.id}/phone`, { token: norte });
    assert.equal(del.status, 200);
    assert.equal(fake.byUniqueId(t.identifier), undefined);
    assert.equal((await row(driverA.id)).tracker, undefined);
    assert.equal((await env.req('DELETE', `/api/drivers/${driverA.id}/phone`, { token: norte })).status, 404);
    // After removal the identifier is unknown: it goes to «sin asignar».
    const r = await position(t.identifier);
    assert.equal(r.json.matched, false);
  });
});

describe('Smartphone: SOS fuera de turno y actualización en vivo', () => {
  test('el SOS de un chofer sin unidad lleva la ubicación que manda el celular y aparece en el tick', async () => {
    const id = (await row(driverC.id)).tracker.identifier;
    const r = await env.req('POST', '/ingest/traccar/event', {
      headers: auth,
      body: {
        event: { type: 'alarm', eventTime: new Date().toISOString(), attributes: { alarm: 'sos' } },
        position: { latitude: -31.5432, longitude: -68.5321, fixTime: new Date().toISOString() },
        device: { id: 7, uniqueId: id },
      },
    });
    assert.ok(r.json.alertId);
    const tick = await env.req('POST', '/api/telemetry/tick', { token: norte });
    const alert = tick.json.alerts.find((a: any) => a.id === r.json.alertId);
    assert.ok(alert, 'la alerta nueva llega con la actualización en vivo');
    assert.equal(alert.unitCode, 'Sin unidad');
    assert.equal(alert.lat, -31.5432, 'una emergencia lleva la ubicación aunque esté fuera de turno');
    assert.equal(alert.lng, -68.5321);
    assert.match(alert.summary, /Ubicación del celular/);
  });

  test('sin posición en el evento usa la última que mandó el celular (solo en memoria)', async () => {
    const id = (await row(driverC.id)).tracker.identifier;
    await position(id, { lat: -31.6111, lng: -68.6111 });
    const r = await env.req('POST', '/ingest/traccar/event', {
      headers: auth,
      body: { event: { type: 'alarm', eventTime: new Date().toISOString(), attributes: { alarm: 'sos' } }, device: { id: 7, uniqueId: id } },
    });
    const alert = (await boot()).alerts.find((a: any) => a.id === r.json.alertId);
    assert.equal(alert.lat, -31.6111);
  });
});

describe('Smartphone: URL para Traccar Client', () => {
  test('el superadmin la cambia (túnel), persiste al reiniciar y se puede restaurar', async () => {
    const superadmin = await env.token(...DEMO.superadmin);
    const put = (token: string, url: unknown) => env.req('PUT', '/api/settings/phone-server-url', { token, body: { url } });

    assert.equal((await put(norte, 'https://abc-5055.brs.devtunnels.ms')).status, 403, 'una empresa no puede cambiarla');
    assert.equal((await put(superadmin, 'abc-5055.brs.devtunnels.ms')).status, 400, 'falta el protocolo');
    assert.equal((await put(superadmin, 'ftp://abc.example.com')).status, 400);
    assert.equal((await put(superadmin, 'https://abc.example.com/?id=1')).status, 400, 'sin parámetros');
    const tunnelPort = await put(superadmin, 'https://abc-5055.brs.devtunnels.ms:5055');
    assert.equal(tunnelPort.status, 400, 'un túnel de VS Code no lleva puerto');
    assert.match(tunnelPort.json.error, /no llevan puerto/);

    const ok = await put(superadmin, 'https://abc-5055.brs.devtunnels.ms/');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.deviceConnection.phoneServerUrl, 'https://abc-5055.brs.devtunnels.ms', 'sin la barra final');
    assert.equal(ok.json.deviceConnection.phoneServerUrlCustom, true);
    assert.equal((await boot()).deviceConnection.phoneServerUrl, 'https://abc-5055.brs.devtunnels.ms', 'todas las empresas la ven');

    await env.restartApp();
    norte = await env.token(...DEMO.norte);
    assert.equal((await boot()).deviceConnection.phoneServerUrl, 'https://abc-5055.brs.devtunnels.ms', 'persiste en la base');

    const superadmin2 = await env.token(...DEMO.superadmin);
    const reset = await put(superadmin2, null);
    assert.equal(reset.status, 200);
    assert.equal(reset.json.deviceConnection.phoneServerUrl, 'http://flota.test.local:5055');
    assert.equal(reset.json.deviceConnection.phoneServerUrlCustom, false);
  });
});


describe('Smartphone: QR de configuración de Traccar Client', () => {
  const serverUrl = 'https://cxsxdnnc-5055.brs.devtunnels.ms';
  const parse = (uri: string) => new URL(uri);

  test('Android: enlace org.traccar.client://config con URL, identificador y todos los ajustes', () => {
    const uri = buildClientConfigUri({ identifier: 'GC-93210024', serverUrl, platform: 'android' })!;
    assert.match(uri, /^org\.traccar\.client:\/\/config\?/);
    assert.ok(uri.includes('url=https%3A%2F%2Fcxsxdnnc-5055.brs.devtunnels.ms'), 'la URL viaja codificada');
    const q = parse(uri).searchParams;
    assert.equal(q.get('url'), serverUrl);
    assert.equal(q.get('id'), 'GC-93210024');
    assert.equal(q.get('accuracy'), 'high');
    assert.equal(q.get('distance'), '100');
    assert.equal(q.get('interval'), '60');
    assert.equal(q.get('wakelock'), 'true');
    assert.equal(q.get('stop_detection'), 'true');
    assert.equal(q.get('buffer'), 'true');
  });

  test('iPhone: sin interval ni wakelock (solo existen en Android)', () => {
    const q = parse(buildClientConfigUri({ identifier: 'GC-1', serverUrl, platform: 'ios' })!).searchParams;
    assert.equal(q.get('interval'), null);
    assert.equal(q.get('wakelock'), null);
    assert.equal(q.get('angle'), '30');
  });

  test('sin Server URL no hay QR', () => {
    assert.equal(buildClientConfigUri({ identifier: 'GC-1', serverUrl: null, platform: 'android' }), null);
    assert.equal(buildClientConfigUri({ identifier: 'GC-1', serverUrl: '', platform: 'android' }), null);
  });

  test('las instrucciones de WhatsApp incluyen el enlace y la tabla manual sigue igual', () => {
    const text = buildShareText({ driverName: 'Ana', identifier: 'GC-2', serverUrl, platform: 'android' });
    assert.ok(text.includes(buildClientConfigUri({ identifier: 'GC-2', serverUrl, platform: 'android' })!));
    assert.deepEqual(
      recommendedSettings('android').map((s) => s.label),
      ['Location accuracy', 'Distance', 'Interval', 'Angle', 'Heartbeat', 'Offline buffering', 'Stop detection', 'Wake lock']
    );
  });
});
