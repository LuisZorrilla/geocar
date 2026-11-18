import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
let norte: string;
let superadmin: string;
let data: any;

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    superadmin = await env.token(...DEMO.superadmin);
    data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('validación de entradas', () => {
  test('JSON malformado → 400', async () => {
    const res = await fetch(`${env.baseUrl}/api/alert-rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${norte}`, 'Content-Type': 'application/json' },
      body: '{"name": ',
    });
    assert.equal(res.status, 400);
  });

  test('enum inválido → 400 con mensaje en español', async () => {
    const v = data.vehicles[0];
    const res = await env.req('POST', '/api/work-orders', {
      token: norte,
      body: { vehicleId: v.id, title: 'Cambio de aceite', priority: 'urgentisima' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /priority/);
  });

  test('IMEI inválido → 400', async () => {
    const res = await env.req('POST', '/api/vehicles', {
      token: norte,
      body: { unitCode: 'TLN-999', plate: 'ABC-123', imei: 'no-es-imei' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /imei/);
  });

  test('permisos de rol: nivel o módulo desconocido → 400', async () => {
    const role = data.roles.find((r: any) => !r.isSystemAdminRole);
    const badLevel = await env.req('PATCH', `/api/roles/${role.id}`, {
      token: norte,
      body: { permissions: { flotas: 'god' } },
    });
    assert.equal(badLevel.status, 400);
    const badModule = await env.req('PATCH', `/api/roles/${role.id}`, {
      token: norte,
      body: { permissions: { superpoderes: 'full' } },
    });
    assert.equal(badModule.status, 400);

    const ok = await env.req('PATCH', `/api/roles/${role.id}`, {
      token: norte,
      body: { permissions: { reportes: 'read' } },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.role.permissions.reportes, 'read');
    assert.equal(Object.keys(ok.json.role.permissions).length, 10);
  });

  test('campos no permitidos se descartan (no hay asignación masiva)', async () => {
    const wo = data.workOrders.find((w: any) => w.tenantId === 'ten-norte');
    const res = await env.req('PATCH', `/api/work-orders/${wo.id}`, {
      token: norte,
      body: { notes: 'Revisión ok', tenantId: 'ten-urbana', id: 'hackeado', vehicleId: 'otro' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.workOrder.id, wo.id);
    assert.equal(res.json.workOrder.tenantId, 'ten-norte');
    assert.equal(res.json.workOrder.vehicleId, wo.vehicleId);
    assert.equal(res.json.workOrder.notes, 'Revisión ok');
  });

  test('sizing: tipos inválidos → 400 y campos extra no se guardan', async () => {
    const bad = await env.req('PUT', '/api/sizing', { token: superadmin, body: { vehiclesCount: 'muchos' } });
    assert.equal(bad.status, 400);

    const ok = await env.req('PUT', '/api/sizing', {
      token: superadmin,
      body: { gpsIntervalSec: 30, inyectado: true },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sizing.gpsIntervalSec, 30);
    assert.ok(!('inyectado' in ok.json.sizing));
  });

  test('payload real del frontend para checklist se acepta', async () => {
    const v = data.vehicles[0];
    const res = await env.req('POST', '/api/checklists', {
      token: norte,
      body: {
        vehicleId: v.id,
        driverName: 'Operador',
        shift: 'Matutino',
        items: [
          { id: 'it-0', label: 'Frenos', status: 'ok' },
          { id: 'it-1', label: 'Luces', status: 'falla', note: 'Faro izquierdo' },
        ],
        summaryNote: '',
        createWorkOrderIfFailed: true,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  });
});
