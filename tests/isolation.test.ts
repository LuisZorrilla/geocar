import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
let norte: string;
let urbana: string;
let superadmin: string;
let norteData: any;

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    superadmin = await env.token(...DEMO.superadmin);
    norteData = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
  },
  { timeout: 120_000 }
);
after(() => env.close());

const first = (list: any[], what: string, pred: (x: any) => boolean = () => true) => {
  const item = list?.find(pred);
  assert.ok(item, `el seed debe tener al menos un ${what} de ten-norte`);
  return item;
};

describe('aislamiento multiempresa', () => {
  test('el bootstrap de una empresa no contiene datos de otra', async () => {
    const res = await env.req('GET', '/api/bootstrap', { token: urbana });
    assert.equal(res.status, 200);
    const { sizing: _sizing, dashcamDrivers: _drivers, ...tenantScoped } = res.json;
    assert.ok(!JSON.stringify(tenantScoped).includes('"ten-norte"'), 'no debe aparecer ten-norte');
  });

  test('otra empresa no puede leer ni exportar una unidad ajena', async () => {
    const v = first(norteData.vehicles, 'vehículo');
    assert.equal((await env.req('GET', `/api/vehicles/${v.id}/dossier`, { token: urbana })).status, 404);
    assert.equal((await env.req('GET', `/api/vehicles/${v.id}/export`, { token: urbana })).status, 404);
  });

  test('otra empresa no puede modificar recursos ajenos', async () => {
    const wo = first(norteData.workOrders, 'orden de trabajo');
    const alert = first(norteData.alerts, 'alerta pendiente', (a) => a.status === 'pendiente');
    const device = first(norteData.devices, 'dispositivo');
    const plan = first(norteData.preventivePlans, 'plan preventivo');
    const part = first(norteData.partsInventory, 'refacción');
    const user = first(norteData.users, 'usuario', (u) => !u.isCompanyAdmin);
    const role = first(norteData.roles, 'perfil', (r) => !r.isSystemAdminRole);
    const driverId = norteData.dashcamDrivers[0].id;

    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', `/api/work-orders/${wo.id}`, { notes: 'intrusión' }],
      ['POST', `/api/alerts/${alert.id}/acknowledge`, {}],
      ['POST', `/api/alerts/${alert.id}/escalate`, {}],
      ['PUT', `/api/devices/${device.id}/dashcam-config`, { driverId }],
      ['POST', `/api/devices/${device.id}/validate`, {}],
      ['PATCH', `/api/preventive-plans/${plan.id}`, { name: 'intrusión' }],
      ['PATCH', `/api/preventive-plans/${plan.id}/toggle`, {}],
      ['PATCH', `/api/parts-inventory/${part.id}/stock`, { deltaQty: -5 }],
      ['PATCH', `/api/users/${user.id}`, { status: 'inactivo' }],
      ['PATCH', `/api/roles/${role.id}`, { name: 'intrusión' }],
    ];
    if (norteData.videoClips?.length) {
      attempts.push(['PATCH', `/api/video-clips/${norteData.videoClips[0].id}/retention`, {}]);
    }
    if (norteData.incidents?.length) {
      attempts.push(['PATCH', `/api/incidents/${norteData.incidents[0].id}`, { status: 'resuelto' }]);
    }
    for (const [method, path, body] of attempts) {
      const res = await env.req(method, path, { token: urbana, body });
      assert.ok([403, 404].includes(res.status), `${method} ${path} devolvió ${res.status}`);
    }

    // Nothing changed for ten-norte
    const after = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(after.alerts.find((a: any) => a.id === alert.id).status, 'pendiente');
    assert.notEqual(after.workOrders.find((w: any) => w.id === wo.id).notes, 'intrusión');
    assert.equal(after.users.find((u: any) => u.id === user.id).status, user.status);
  });

  test('tenantId en el body se ignora para usuarios de empresa', async () => {
    const res = await env.req('POST', '/api/alert-rules', {
      token: norte,
      body: { tenantId: 'ten-frio', name: 'Exceso 90', thresholdLabel: '> 90 km/h' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.rule.tenantId, 'ten-norte');
  });

  test('superadmin debe elegir empresa destino al crear', async () => {
    const missing = await env.req('POST', '/api/alert-rules', {
      token: superadmin,
      body: { name: 'Regla global', thresholdLabel: '> 80 km/h' },
    });
    assert.equal(missing.status, 400);

    const ok = await env.req('POST', '/api/alert-rules', {
      token: superadmin,
      body: { tenantId: 'ten-frio', name: 'Regla frío', thresholdLabel: '> 80 km/h' },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.rule.tenantId, 'ten-frio');

    const viaScope = await env.req('POST', '/api/alert-rules', {
      token: superadmin,
      headers: { 'x-tenant-scope': 'ten-urbana' },
      body: { name: 'Regla urbana', thresholdLabel: '> 70 km/h' },
    });
    assert.equal(viaScope.status, 201);
    assert.equal(viaScope.json.rule.tenantId, 'ten-urbana');
  });

  test('el dimensionamiento global solo lo modifica el superadmin', async () => {
    const tenantTry = await env.req('PUT', '/api/sizing', { token: norte, body: { vehiclesCount: 5 } });
    assert.equal(tenantTry.status, 403);

    const ok = await env.req('PUT', '/api/sizing', { token: superadmin, body: { vehiclesCount: 150 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.sizing.vehiclesCount, 150);
  });
});
