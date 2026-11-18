import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
before(() => env.start(), { timeout: 120_000 });
after(() => env.close());

describe('autenticación', () => {
  test('el seed imprime credenciales solo en consola y demo-accounts ya no existe', async () => {
    assert.match(env.seedLog, /admin\.norte\s+Norte2026!/);
    const res = await env.req('GET', '/api/auth/demo-accounts');
    assert.ok(!(res.json && typeof res.json === 'object' && 'accounts' in res.json));
  });

  test('login correcto no devuelve contraseña ni hash', async () => {
    const res = await env.login(...DEMO.norte);
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.ok(!JSON.stringify(res.json).includes('scrypt$'));
    assert.ok(!('password' in res.json.user) && !('passwordHash' in res.json.user));
  });

  test('bootstrap no filtra hashes de otros usuarios', async () => {
    const token = await env.token(...DEMO.norte);
    const res = await env.req('GET', '/api/bootstrap', { token });
    assert.equal(res.status, 200);
    assert.ok(res.json.vehicles.length > 0);
    assert.ok(!JSON.stringify(res.json).includes('scrypt$'));
  });

  test('el token en query string se rechaza', async () => {
    const token = await env.token(...DEMO.norte);
    const res = await env.req('GET', `/api/bootstrap?token=${token}`);
    assert.equal(res.status, 401);
  });

  test('export CSV funciona con header Authorization', async () => {
    const token = await env.token(...DEMO.norte);
    const res = await env.req('GET', '/api/reports/export', { token });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/csv/);
  });

  test('5 intentos fallidos bloquean la cuenta', async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await env.login(DEMO.norteTaller[0], 'incorrecta123');
      assert.equal(bad.status, 401);
    }
    const locked = await env.login(...DEMO.norteTaller);
    assert.equal(locked.status, 423);
  });

  test('crear usuario: contraseña débil se rechaza, válida permite entrar', async () => {
    const token = await env.token(...DEMO.norte);
    const boot = await env.req('GET', '/api/bootstrap', { token });
    const roleId = boot.json.roles.find((r: any) => r.tenantId === 'ten-norte' && !r.isSystemAdminRole).id;

    const weak = await env.req('POST', '/api/users', {
      token,
      body: { name: 'Débil', username: 'debil.norte', password: 'abc', roleId },
    });
    assert.equal(weak.status, 400);

    const ok = await env.req('POST', '/api/users', {
      token,
      body: { name: 'Nuevo Operador', username: 'nuevo.norte', password: 'ClaveSegura123', roleId },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal((await env.login('nuevo.norte', 'ClaveSegura123')).status, 200);
  });

  test('cambio de contraseña propio y persistencia tras reinicio', async () => {
    const token = await env.token('nuevo.norte', 'ClaveSegura123');
    const cp = await env.req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'ClaveSegura123', newPassword: 'OtraClave4567' },
    });
    assert.equal(cp.status, 200, JSON.stringify(cp.json));

    const adminToken = await env.token(...DEMO.norte);
    const boot = await env.req('GET', '/api/bootstrap', { token: adminToken });
    const alert = boot.json.alerts.find((a: any) => a.status === 'pendiente');
    assert.ok(alert, 'se necesita una alerta pendiente en el seed');
    const ack = await env.req('POST', `/api/alerts/${alert.id}/acknowledge`, { token: adminToken, body: {} });
    assert.equal(ack.status, 200, JSON.stringify(ack.json));

    await env.restartApp();
    assert.doesNotMatch(env.seedLog, /\[seed\]/, 'no debe volver a sembrar');

    const again = await env.req('GET', '/api/bootstrap', { token: adminToken });
    assert.equal(again.status, 200, 'la sesión sobrevive al reinicio');
    assert.equal(again.json.vehicles.length, boot.json.vehicles.length);
    assert.equal(again.json.alerts.find((a: any) => a.id === alert.id).status, 'confirmada');
    assert.equal((await env.login('nuevo.norte', 'OtraClave4567')).status, 200);
    assert.equal((await env.login('nuevo.norte', 'ClaveSegura123')).status, 401);
  });

  test('logout invalida la sesión', async () => {
    const token = await env.token(...DEMO.urbana);
    assert.equal((await env.req('POST', '/api/auth/logout', { token })).status, 200);
    assert.equal((await env.req('GET', '/api/bootstrap', { token })).status, 401);
  });
});
