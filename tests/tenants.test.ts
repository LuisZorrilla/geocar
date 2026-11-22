import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { cuitCheckDigit, cuitProblem, formatCuit, isValidCuit } from '../src/shared/cuit.ts';

/** Builds a valid CUIT from a prefix + 8 digits (picks a body whose check digit isn't 10). */
function makeCuit(prefix: string, seed: number): string {
  for (let n = seed; ; n++) {
    const first10 = prefix + String(n).padStart(8, '0').slice(-8);
    const check = cuitCheckDigit(first10);
    if (check !== null) return `${first10}${check}`;
  }
}

describe('CUIT', () => {
  test('valida dígito verificador, prefijo y longitud', () => {
    // 20-12345678-6 es un CUIT de ejemplo con verificador correcto
    assert.equal(cuitCheckDigit('2012345678'), 6);
    assert.ok(isValidCuit('20-12345678-6'));
    assert.ok(isValidCuit('20123456786'));
    assert.equal(cuitProblem('20-12345678-5'), 'digito_verificador');
    assert.equal(cuitProblem('99-12345678-6'), 'prefijo');
    assert.equal(cuitProblem('20-1234567-6'), 'longitud');
    assert.equal(formatCuit('20123456786'), '20-12345678-6');
    const generated = makeCuit('30', 71234567);
    assert.ok(isValidCuit(generated));
  });
});

const env = new TestEnv();
let superadmin: string;
let norte: string;

const company = (overrides: Record<string, unknown> = {}) => ({
  name: 'Transportes Andinos S.R.L.',
  cuit: makeCuit('30', 71000001),
  city: 'San Juan Capital',
  branches: ['San Juan Capital', 'Caucete'],
  contactName: 'María Gómez',
  contactEmail: 'Maria@Andinos.com.ar',
  contactPhone: '+54 264 400 0000',
  ...overrides,
});
const payload = (o: { company?: Record<string, unknown>; admin?: Record<string, unknown>; templates?: Record<string, boolean>; service?: Record<string, unknown> } = {}) => ({
  company: company(o.company),
  service: { status: 'piloto', planTier: 'Estándar', vehicleQuota: 2, retentionDays: 30, currency: 'ARS', ...o.service },
  admin: { name: 'María Gómez', username: 'admin.andinos', ...o.admin },
  templates: { preventivePlans: true, alertRules: true, ...o.templates },
});

before(
  async () => {
    await env.start();
    superadmin = await env.token(...DEMO.superadmin);
    norte = await env.token(...DEMO.norte);
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('alta y gestión de empresas (superadmin)', () => {
  let created: any;

  test('solo el superadmin accede a /api/tenants', async () => {
    assert.equal((await env.req('GET', '/api/tenants', { token: norte })).status, 403);
    assert.equal((await env.req('POST', '/api/tenants', { token: norte, body: payload() })).status, 403);
    assert.equal((await env.req('GET', '/api/tenants/availability?cuit=1', { token: norte })).status, 403);
    const list = await env.req('GET', '/api/tenants', { token: superadmin });
    assert.equal(list.status, 200);
    assert.equal(list.json.tenants.length, 3);
    assert.ok(list.json.tenants.every((t: any) => typeof t.vehicleCount === 'number' && t.adminUsername));
  });

  test('disponibilidad en vivo: CUIT inválido, usuario en uso', async () => {
    const r = await env.req('GET', `/api/tenants/availability?cuit=20-12345678-5&username=admin.norte&name=Otra`, { token: superadmin });
    assert.deepEqual(
      { cuit: r.json.cuit, username: r.json.username, name: r.json.name },
      { cuit: 'invalido', username: 'en_uso', name: 'ok' }
    );
    assert.match(r.json.cuitMessage, /verificador/);
  });

  test('el asistente crea empresa, perfiles, admin y plantillas; la contraseña no se cachea', async () => {
    const res = await env.req('POST', '/api/tenants', { token: superadmin, body: payload() });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    created = res.json;
    assert.match(created.tenant.id, /^ten-transportes-andinos/);
    assert.match(created.tenant.taxId, /^\d{2}-\d{8}-\d$/);
    assert.equal(created.tenant.contactEmail, 'maria@andinos.com.ar');
    assert.equal(created.admin.username, 'admin.andinos');
    assert.equal(created.admin.mustChangePassword, true);
    assert.match(created.temporaryPassword, /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{14}$/);
    assert.equal(created.tenants.length, 4);
  });

  test('datos repetidos o inválidos → 400 sin crear nada', async () => {
    const dupCuit = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: payload({ company: { name: 'Otra Empresa', cuit: created.tenant.taxId }, admin: { username: 'admin.otra' } }),
    });
    assert.equal(dupCuit.status, 400);
    assert.match(dupCuit.json.error, /CUIT/);
    const dupUser = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: payload({ company: { name: 'Otra Empresa', cuit: makeCuit('30', 72000001) }, admin: { username: 'admin.norte' } }),
    });
    assert.equal(dupUser.status, 400);
    const badCuit = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: payload({ company: { name: 'Otra Empresa', cuit: '20-12345678-5' }, admin: { username: 'admin.otra' } }),
    });
    assert.equal(badCuit.status, 400);
    const badEmail = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: payload({ company: { name: 'Otra Empresa', cuit: makeCuit('30', 73000001), contactEmail: 'no-es-email' }, admin: { username: 'admin.otra' } }),
    });
    assert.equal(badEmail.status, 400);
    assert.equal((await env.req('GET', '/api/tenants', { token: superadmin })).json.tenants.length, 4);
  });

  test('el admin nuevo debe cambiar la contraseña; después tiene los 10 módulos y una empresa vacía', async () => {
    const login = await env.login('admin.andinos', created.temporaryPassword);
    assert.equal(login.status, 200);
    assert.equal(login.json.user.mustChangePassword, true);
    const token = login.json.token;

    const blocked = await env.req('GET', '/api/reports/export', { token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await env.req('GET', '/api/bootstrap', { token })).status, 200);

    const same = await env.req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: created.temporaryPassword, newPassword: created.temporaryPassword },
    });
    assert.equal(same.status, 400, 'la nueva debe ser distinta');
    const changed = await env.req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: created.temporaryPassword, newPassword: 'Andinos2026Seguro' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));

    const boot = await env.req('GET', '/api/bootstrap', { token });
    assert.equal(boot.status, 200);
    assert.ok(!boot.json.currentUser.mustChangePassword);
    assert.ok(Object.values(boot.json.currentRole.permissions).every((p) => p === 'full'));
    assert.equal(Object.keys(boot.json.currentRole.permissions).length, 10);
    assert.equal(boot.json.vehicles.length, 0);
    assert.equal(boot.json.roles.length, 3);
    assert.equal(boot.json.preventivePlans.length, 3);
    assert.equal(boot.json.alertRules.length, 4);
    assert.ok(!JSON.stringify(boot.json).includes('ten-norte'));
    assert.equal((await env.req('GET', '/api/reports/export', { token })).status, 200);
  });

  test('sin plantillas la empresa arranca sin planes ni reglas', async () => {
    const res = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: payload({
        company: { name: 'Minera del Valle', cuit: makeCuit('33', 70000001) },
        admin: { username: 'admin.minera' },
        templates: { preventivePlans: false, alertRules: false },
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const login = await env.login('admin.minera', res.json.temporaryPassword);
    await env.req('POST', '/api/auth/change-password', {
      token: login.json.token,
      body: { currentPassword: res.json.temporaryPassword, newPassword: 'Minera2026Valle' },
    });
    const boot = (await env.req('GET', '/api/bootstrap', { token: login.json.token })).json;
    assert.equal(boot.preventivePlans.length, 0);
    assert.equal(boot.alertRules.length, 0);
  });

  test('cupo de unidades: no se puede superar ni bajar por debajo de lo registrado', async () => {
    const token = await env.token('admin.andinos', 'Andinos2026Seguro');
    const vehicle = (n: number) => ({ unitCode: `AND-0${n}`, plate: `AA${n}00BB`, imei: `86000000000000${n}` });
    assert.equal((await env.req('POST', '/api/vehicles', { token, body: vehicle(1) })).status, 201);
    assert.equal((await env.req('POST', '/api/vehicles', { token, body: vehicle(2) })).status, 201);
    const over = await env.req('POST', '/api/vehicles', { token, body: vehicle(3) });
    assert.equal(over.status, 400);
    assert.match(over.json.error, /cupo de 2 unidades/);

    const lower = await env.req('PATCH', `/api/tenants/${created.tenant.id}`, { token: superadmin, body: { vehicleQuota: 1 } });
    assert.equal(lower.status, 400);
    const raise = await env.req('PATCH', `/api/tenants/${created.tenant.id}`, { token: superadmin, body: { vehicleQuota: 10, status: 'activo' } });
    assert.equal(raise.status, 200);
    assert.equal(raise.json.tenant.vehicleQuota, 10);
    assert.equal(raise.json.tenant.vehicleCount, 2);
  });

  test('suspender bloquea el ingreso y cierra sesiones; reactivar lo restablece', async () => {
    const token = await env.token('admin.andinos', 'Andinos2026Seguro');
    const sus = await env.req('PATCH', `/api/tenants/${created.tenant.id}`, { token: superadmin, body: { status: 'suspendido' } });
    assert.equal(sus.status, 200);
    assert.equal((await env.req('GET', '/api/bootstrap', { token })).status, 401, 'la sesión abierta se cierra');
    const login = await env.login('admin.andinos', 'Andinos2026Seguro');
    assert.equal(login.status, 423);
    assert.match(login.json.error, /suspendida/);

    await env.req('PATCH', `/api/tenants/${created.tenant.id}`, { token: superadmin, body: { status: 'activo' } });
    assert.equal((await env.login('admin.andinos', 'Andinos2026Seguro')).status, 200);
  });

  test('restablecer la contraseña del admin invalida la anterior y exige cambio', async () => {
    const res = await env.req('POST', `/api/tenants/${created.tenant.id}/reset-admin-password`, { token: superadmin });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.json.username, 'admin.andinos');
    assert.equal((await env.login('admin.andinos', 'Andinos2026Seguro')).status, 401);
    const login = await env.login('admin.andinos', res.json.temporaryPassword);
    assert.equal(login.status, 200);
    assert.equal(login.json.user.mustChangePassword, true);
  });

  test('editar datos valida el CUIT solo si cambia (las empresas demo conservan su RFC)', async () => {
    const demo = await env.req('PATCH', '/api/tenants/ten-norte', { token: superadmin, body: { contactName: 'Luis Mendoza' } });
    assert.equal(demo.status, 200);
    assert.equal(demo.json.tenant.taxId, 'TLN-980412-K81');
    const bad = await env.req('PATCH', '/api/tenants/ten-norte', { token: superadmin, body: { cuit: '20-12345678-5' } });
    assert.equal(bad.status, 400);
  });

  test('la empresa, sus contactos y la contraseña temporal pendiente sobreviven a un reinicio', async () => {
    await env.restartApp();
    const sa = await env.token(...DEMO.superadmin);
    const t = (await env.req('GET', '/api/tenants', { token: sa })).json.tenants.find((x: any) => x.id === created.tenant.id);
    assert.equal(t.contactEmail, 'maria@andinos.com.ar');
    assert.equal(t.status, 'activo');
    assert.equal(t.vehicleQuota, 10);
    const reset = await env.req('POST', `/api/tenants/${created.tenant.id}/reset-admin-password`, { token: sa });
    await new Promise((r) => setTimeout(r, 300));
    await env.restartApp();
    const login = await env.login('admin.andinos', reset.json.temporaryPassword);
    assert.equal(login.json.user.mustChangePassword, true);
  });
});
