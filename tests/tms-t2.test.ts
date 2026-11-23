import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DEMO, INGEST_TOKEN, TestEnv } from './helpers/harness.ts';
import { roughEtaMinutes } from '../src/shared/tms.ts';

const env = new TestEnv();
let norte: string;
let monitoreo: string;
let urbana: string;
const iso = (ms: number) => new Date(ms).toISOString();
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

/** A real, decodable PNG (RGBA) like the signature canvas produces. */
function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.abs(y - height / 2 - 8 * Math.sin(x / 10)) < 2) rows.writeUInt32BE(0x0f172aff, y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function cuitFor(prefix: string, body8: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `${prefix}${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  if (r === 10) return cuitFor(prefix, String(Number(body8) + 1).padStart(8, '0'));
  return `${base}${r === 11 ? 0 : r}`;
}

/** Valid CUIL for a DNI (tries 20, 23, 24, 27 without changing the DNI). */
function cuilFor(dni: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (const p of ['27', '20', '23', '24']) {
    const base = p + dni.padStart(8, '0');
    const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
    if (r !== 10) return base + (r === 11 ? 0 : r);
  }
  throw new Error('sin CUIL');
}

async function authorizedDriver(token: string, dni: string) {
  const created = await env.req('POST', '/api/drivers', {
    token,
    body: {
      firstName: 'Lía', lastName: `App ${dni.slice(-3)}`, dni, cuil: cuilFor(dni), birthDate: '1988-06-01', phone: '+54 264 555 0000',
      branch: 'San Juan Capital', profile: 'profesional', licenseClasses: ['B.1', 'E.1'],
      documents: [
        { type: 'dni', number: dni }, { type: 'licencia', number: dni, expiresAt: plusDays(400) },
        { type: 'linti', number: 'L', expiresAt: plusDays(300) }, { type: 'psicofisico', number: 'P', expiresAt: plusDays(200) },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  let d = created.json.driver;
  for (const doc of d.documents) {
    await fetch(`${env.baseUrl}/api/drivers/${d.id}/documents/${doc.type}/file`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-file-name': 'd.png' }, body: new Uint8Array(PNG) });
    d = (await env.req('POST', `/api/drivers/${d.id}/documents/${doc.type}/verify`, { token, body: { decision: 'verificado' } })).json.driver;
  }
  assert.equal(d.authorization.state, 'habilitado');
  return d;
}

const app = (method: string, path: string, driverToken: string | undefined, body?: unknown) =>
  env.req(method, `/api/driver-app${path}`, { headers: driverToken ? { 'x-driver-token': driverToken } : {}, body });

async function upload(driverToken: string, tripId: string, kind: string, data: Buffer, mime: string) {
  const res = await fetch(`${env.baseUrl}/api/driver-app/trips/${tripId}/files?kind=${kind}`, { method: 'PUT', headers: { 'x-driver-token': driverToken, 'Content-Type': mime }, body: new Uint8Array(data) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('TMS T2: app del chofer, prueba de entrega y seguimiento', () => {
  let driver: any;
  let vehicle: any;
  let terminalId: string;
  let trip: any;
  let order: any;
  let driverToken: string;
  let placeB: any;

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const critical = new Set(boot.workOrders.filter((w: any) => w.priority === 'critica' && !['completada', 'cancelada'].includes(w.status)).map((w: any) => w.vehicleId));
    vehicle = boot.vehicles.find((v: any) => v.assetType === 'vehiculo' && v.deviceId && !critical.has(v.id) && boot.devices.some((d: any) => d.id === v.deviceId && d.terminalId));
    terminalId = boot.devices.find((d: any) => d.id === vehicle.deviceId).terminalId;
    driver = await authorizedDriver(norte, '34555666');
    const customer = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Cliente T2', taxId: cuitFor('30', '71999888') } })).json.customer;
    const placeA = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Origen T2', kind: 'deposito', address: 'X', lat: -31.6, lng: -68.4 } })).json.place;
    placeB = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Destino T2', kind: 'cliente', address: 'Av. Siempre Viva 742', lat: -31.65, lng: -68.45 } })).json.place;
    order = (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'Cajas', weightKg: 500 }, reference: 'OC-T2', confirm: true } })).json.order;
    assert.ok(order.trackingToken, 'los pedidos nuevos traen su token de seguimiento');
    const created = await env.req('POST', '/api/tms/trips', { token: norte, body: { vehicleId: vehicle.id, driverId: driver.id, plannedStart: iso(Date.now() + 3600_000), orderIds: [order.id], acceptWarnings: { reason: 'prueba' } } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    trip = created.json.trip;
  });
  after(() => env.close());

  test('ETA aproximada', () => {
    assert.equal(roughEtaMinutes(40_000), 60); // 40 km × 1,25 = 50 km a 50 km/h
    assert.equal(roughEtaMinutes(10), 1);
  });

  test('link del chofer: solo administradores; el hash nunca sale del servidor', async () => {
    assert.equal((await env.req('POST', `/api/tms/drivers/${driver.id}/app-link`, { token: monitoreo })).status, 403);
    const res = await env.req('POST', `/api/tms/drivers/${driver.id}/app-link`, { token: norte });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.match(res.json.path, /^\/chofer#t=/);
    driverToken = res.json.token;
    const listed = (await env.req('GET', `/api/drivers/${driver.id}`, { token: norte })).json;
    assert.equal(listed.appAccess.tokenHash, '');
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(boot.drivers.find((d: any) => d.id === driver.id).appAccess.tokenHash, '');
    // Another company can't issue a link for this driver.
    assert.equal((await env.req('POST', `/api/tms/drivers/${driver.id}/app-link`, { token: urbana })).status, 404);
  });

  test('app del chofer: sin token o con token inválido → 401; ve solo sus viajes', async () => {
    assert.equal((await app('GET', '/me', undefined)).status, 401);
    assert.equal((await app('GET', '/me', 'x'.repeat(43))).status, 401);
    const me = await app('GET', '/me', driverToken);
    assert.equal(me.status, 200);
    assert.equal(me.json.driver.id, driver.id);
    assert.deepEqual(me.json.trips.map((t: any) => t.id), [trip.id]);
    // A different driver's token can't touch this trip.
    const other = await authorizedDriver(norte, '34555777');
    const otherToken = (await env.req('POST', `/api/tms/drivers/${other.id}/app-link`, { token: norte })).json.token;
    assert.equal((await app('POST', `/trips/${trip.id}/start`, otherToken)).status, 404);
    assert.equal((await app('GET', '/me', otherToken)).json.trips.length, 0);
  });

  test('seguimiento público: sin datos de la unidad hasta que va hacia el destino', async () => {
    const before = await env.req('GET', `/api/public/track/${order.trackingToken}`);
    assert.equal(before.status, 200);
    assert.equal(before.json.tracking.status, 'planificado');
    assert.equal(before.json.tracking.unit, undefined);
    assert.equal(before.json.tracking.destination.name, 'Destino T2');
    assert.equal((await env.req('GET', '/api/public/track/no-existe-este-token-de-prueba')).status, 404);
    assert.equal((await env.req('GET', `/api/public/track/${order.trackingToken}/remito.pdf`)).status, 404, 'el comprobante es solo para entregados');
  });

  test('carga, novedad y entrega con firma desde la app', async () => {
    const [load, unload] = trip.stops;
    assert.equal((await app('POST', `/trips/${trip.id}/start`, driverToken)).json.trip.status, 'en_curso');
    assert.equal((await app('POST', `/trips/${trip.id}/stops/${load.id}/arrive`, driverToken)).json.trip.stops[0].status, 'en_lugar');
    const loaded = await app('POST', `/trips/${trip.id}/stops/${load.id}/complete`, driverToken);
    assert.equal(loaded.json.trip.stops[0].status, 'completada');
    assert.equal(loaded.json.trip.stops[0].detection, 'app');

    // On the way: the public page shows the unit and an ETA.
    const now = Date.now();
    const pos = { position: { deviceId: 7, protocol: 'jt808', serverTime: iso(now), deviceTime: iso(now), fixTime: iso(now), valid: true, latitude: -31.62, longitude: -68.42, altitude: 600, speed: 30, course: 0, attributes: { ignition: true } }, device: { id: 7, uniqueId: terminalId, name: 'c', status: 'online' } };
    assert.equal((await env.req('POST', '/ingest/traccar/position', { headers: { Authorization: `Bearer ${INGEST_TOKEN}` }, body: pos })).status, 200);
    const tracking = (await env.req('GET', `/api/public/track/${order.trackingToken}`)).json.tracking;
    assert.ok(tracking.unit, JSON.stringify(tracking));
    assert.ok(tracking.unit.distanceKm > 0 && tracking.unit.etaMinutes > 0);

    // A report becomes an incident.
    const report = await app('POST', `/trips/${trip.id}/reports`, driverToken, { type: 'demora', note: 'Cola de 40 minutos en portería' });
    assert.equal(report.status, 201, JSON.stringify(report.json));
    const incidents = (await env.req('GET', '/api/bootstrap', { token: norte })).json.incidents;
    assert.ok(incidents.some((i: any) => i.title.includes(trip.id) && i.category.includes('Novedad')));

    // Unloading needs the proof.
    assert.equal((await app('POST', `/trips/${trip.id}/stops/${unload.id}/complete`, driverToken)).status, 400);
    assert.equal((await upload(driverToken, trip.id, 'signature', Buffer.from('no soy una imagen'), 'image/png')).status, 400);
    // A PNG with the right header but broken image data is rejected too (it could hang the PDF).
    assert.equal((await upload(driverToken, trip.id, 'signature', PNG, 'image/png')).status, 400);
    const sig = await upload(driverToken, trip.id, 'signature', makePng(120, 40), 'image/png');
    assert.equal(sig.status, 201, JSON.stringify(sig.json));
    const badDni = await app('POST', `/trips/${trip.id}/stops/${unload.id}/deliver`, driverToken, { receiverName: 'Ana Pérez', receiverDni: '12', signatureFileId: sig.json.fileId });
    assert.equal(badDni.status, 400);
    const delivered = await app('POST', `/trips/${trip.id}/stops/${unload.id}/deliver`, driverToken, {
      receiverName: 'Ana Pérez', receiverDni: '28.111.222', signatureFileId: sig.json.fileId, lat: -31.6501, lng: -68.4502, accuracyM: 12,
    });
    assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
    const done = delivered.json.trip;
    assert.equal(done.status, 'finalizado');
    assert.equal(done.stops[1].pod.receiverDni, '28111222');
    assert.equal(done.orders[0].status, 'entregado');

    // Panel: signature image, delivery note and route sheet; another company can't see the file.
    const file = await fetch(`${env.baseUrl}/api/tms/files/${sig.json.fileId}`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${env.baseUrl}/api/tms/files/${sig.json.fileId}`, { headers: { Authorization: `Bearer ${urbana}` } })).status, 404);
    for (const path of [`/api/tms/orders/${order.id}/remito.pdf`, `/api/tms/trips/${trip.id}/hoja-de-ruta.pdf`]) {
      const pdf = await fetch(env.baseUrl + path, { headers: { Authorization: `Bearer ${norte}` } });
      assert.equal(pdf.status, 200, path);
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    }

    // Public page after delivery: who received, no unit, downloadable proof.
    const pub = (await env.req('GET', `/api/public/track/${order.trackingToken}`)).json.tracking;
    assert.equal(pub.status, 'entregado');
    assert.equal(pub.delivered.receiverName, 'Ana Pérez');
    assert.equal(pub.unit, undefined);
    const pubPdf = await fetch(`${env.baseUrl}/api/public/track/${order.trackingToken}/remito.pdf`);
    assert.equal(pubPdf.status, 200);
  });

  test('un link nuevo invalida el anterior; revocar corta el acceso', async () => {
    const renewed = (await env.req('POST', `/api/tms/drivers/${driver.id}/app-link`, { token: norte })).json.token;
    assert.equal((await app('GET', '/me', driverToken)).status, 401);
    assert.equal((await app('GET', '/me', renewed)).status, 200);
    assert.equal((await env.req('DELETE', `/api/tms/drivers/${driver.id}/app-link`, { token: norte })).status, 200);
    assert.equal((await app('GET', '/me', renewed)).status, 401);
  });
});
