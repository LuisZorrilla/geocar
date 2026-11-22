import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { DEVICE_CATALOG, GENERIC_JT808_DRIVER_ID } from '../src/shared/deviceCatalog.ts';
import { brandsFor, composeBrandModel, modelsFor } from '../src/shared/vehicleCatalog.ts';

describe('catálogos (unitarias)', () => {
  test('ids del catálogo de equipos únicos', () => {
    const ids = DEVICE_CATALOG.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('modelos de vehículos filtrados por marca, sin distinguir mayúsculas', () => {
    assert.ok(brandsFor('vehiculo').includes('Toyota'));
    assert.ok(modelsFor('vehiculo', 'toyota').includes('Hilux'));
    assert.ok(modelsFor('maquinaria_pesada', 'Caterpillar').includes('320 GC'));
    assert.deepEqual(modelsFor('vehiculo', 'Caterpillar'), []);
    assert.equal(composeBrandModel(' Toyota ', 'Hilux'), 'Toyota Hilux');
  });
});

const env = new TestEnv();
let norte: string;
let drivers: any[];
let seq = 0;

/** Distinct unit code and 15-digit IMEI per call. */
const unit = (extra: Record<string, unknown>) => {
  seq += 1;
  return {
    unitCode: `CAT-${seq}`,
    plate: `AC${seq}00ZZ`,
    imei: `86120000000${String(seq).padStart(4, '0')}`,
    ...extra,
  };
};

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    drivers = (await env.req('GET', '/api/bootstrap', { token: norte })).json.dashcamDrivers;
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('alta de activo con catálogo', () => {
  test('todo driver referenciado por el catálogo existe en el servidor', () => {
    const ids = new Set(drivers.map((d) => d.id));
    for (const m of DEVICE_CATALOG) assert.ok(ids.has(m.driverId), `${m.id} → ${m.driverId}`);
  });

  test('JC181 del catálogo → driver Jimi JC181, puerto 5015, salida celular, marca y modelo separados', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: unit({ brand: 'Toyota', model: 'Hilux', year: 2024, protocol: 'JT808/JT1078', deviceCatalogId: 'jimi-jc181', deviceModel: 'Jimi IoT JC181' }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const { vehicle, device } = res.json;
    assert.equal(vehicle.brand, 'Toyota');
    assert.equal(vehicle.model, 'Hilux');
    assert.equal(vehicle.brandModel, 'Toyota Hilux');
    assert.equal(vehicle.year, 2024);
    assert.equal(device.catalogModelId, 'jimi-jc181');
    assert.equal(device.model, 'Jimi IoT JC181');
    assert.equal(device.uplink, 'celular');
    assert.equal(device.dashcamConfig.driverId, 'drv-jimi-jc181');
    assert.equal(device.dashcamConfig.tcpPort, 5015);
  });

  test('modelo fuera del catálogo con JT808 → perfil genérico, no Howen', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: unit({ brand: 'Marca X', model: 'Z9', protocol: 'JT808/JT1078', deviceModel: 'Fabricante Raro R1' }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.device.dashcamConfig.driverId, GENERIC_JT808_DRIVER_ID);
    assert.equal(res.json.device.catalogModelId, undefined);
  });

  test('texto libre «JC181» sin catálogo también reconoce el driver Jimi', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: unit({ brand: 'Ford', model: 'Ranger', protocol: 'JT808/JT1078', deviceModel: 'JC181' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.device.dashcamConfig.driverId, 'drv-jimi-jc181');
  });

  test('equipo del catálogo con otro protocolo → 400 sin crear nada', async () => {
    const before = (await env.req('GET', '/api/bootstrap', { token: norte })).json.vehicles.length;
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: unit({ brand: 'Ford', model: 'Cargo 1723', protocol: 'JT808/JT1078', deviceCatalogId: 'teltonika-fmc650' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /protocolo/);
    const afterCount = (await env.req('GET', '/api/bootstrap', { token: norte })).json.vehicles.length;
    assert.equal(afterCount, before);
  });

  test('equipo inexistente en el catálogo → 400', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: unit({ brand: 'Ford', model: 'Ranger', protocol: 'JT808/JT1078', deviceCatalogId: 'no-existe' }),
    });
    assert.equal(res.status, 400);
  });

  test('IMEI de 14 dígitos → 400', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: { unitCode: 'CAT-IMEI', plate: 'AA000AA', imei: '86120000000001', brand: 'Ford', model: 'Ranger' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /imei/);
  });
});
