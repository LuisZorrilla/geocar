import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();

function companyCuit(body8: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `30${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  return r === 10 ? companyCuit(String(Number(body8) + 1)) : `${base}${r === 11 ? 0 : r}`;
}

describe('T5: portal de clientes', () => {
  let norte = '';
  let monitoreo = '';
  let urbana = '';
  let mine: any;
  let other: any;
  let shared: any;
  let ownPlace: any;
  let otherPlace: any;
  let myOrder: any;
  let otherOrder: any;
  let userId = '';
  let temp = '';
  let token = '';
  const portal = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    fetch(`${env.baseUrl}/api/portal${path}`, {
      method: init.method ?? 'GET',
      headers: { ...((init.token ?? token) ? { 'x-portal-token': init.token ?? token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }).then(async (r) => ({ status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null }));

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    mine = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Bodega Portal', taxId: companyCuit('71777666') } })).json.customer;
    other = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Otro Cliente', taxId: companyCuit('71888777') } })).json.customer;
    const place = async (name: string, customerId?: string) =>
      (await env.req('POST', '/api/tms/places', { token: norte, body: { name, kind: customerId ? 'cliente' : 'deposito', address: name, lat: -31.5, lng: -68.5 + Math.random() / 10, customerId } })).json.place;
    shared = await place('Depósito central portal');
    ownPlace = await place('Planta Bodega', mine.id);
    otherPlace = await place('Planta Otro', other.id);
    const order = async (customerId: string, dest: string) =>
      (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId, originPlaceId: shared.id, destinationPlaceId: dest, cargo: { description: 'Vino' }, confirm: true } })).json.order;
    myOrder = await order(mine.id, ownPlace.id);
    otherOrder = await order(other.id, otherPlace.id);
  });
  after(() => env.close());

  test('alta de acceso: la empresa da la clave temporal; otra empresa no ve a este cliente', async () => {
    assert.equal((await env.req('POST', `/api/tms/customers/${mine.id}/portal-users`, { token: monitoreo, body: { name: 'Ana', email: 'ana@bodega.test' } })).status, 403);
    assert.equal((await env.req('POST', `/api/tms/customers/${mine.id}/portal-users`, { token: norte, body: { name: 'Ana', email: 'no-es-email' } })).status, 400);
    const r = await env.req('POST', `/api/tms/customers/${mine.id}/portal-users`, { token: norte, body: { name: 'Ana Logística', email: 'Ana@Bodega.test' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    userId = r.json.user.id;
    temp = r.json.password;
    assert.equal(r.json.user.email, 'ana@bodega.test');
    assert.equal(r.json.user.passwordHash, undefined);
    assert.equal(r.json.user.mustChangePassword, true);
    assert.equal((await env.req('POST', `/api/tms/customers/${other.id}/portal-users`, { token: norte, body: { name: 'Dup', email: 'ana@bodega.test' } })).status, 409, 'email único');
    assert.equal((await env.req('GET', `/api/tms/customers/${mine.id}/portal-users`, { token: urbana })).status, 404);
    const list = await env.req('GET', `/api/tms/customers/${mine.id}/portal-users`, { token: monitoreo });
    assert.equal(list.json.items.length, 1);
  });

  test('ingreso: error genérico, cambio obligatorio de la clave temporal y política de contraseñas', async () => {
    assert.equal((await portal('/login', { method: 'POST', body: { email: 'ana@bodega.test', password: 'mala' }, token: '' })).status, 401);
    assert.equal((await portal('/login', { method: 'POST', body: { email: 'nadie@x.test', password: 'mala' }, token: '' })).json.error, 'Email o contraseña incorrectos.');
    const ok = await portal('/login', { method: 'POST', body: { email: 'ANA@bodega.test', password: temp }, token: '' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    token = ok.json.token;
    assert.match(token, /^gp_/);
    assert.equal(ok.json.me.customer.name, 'Bodega Portal');
    const blocked = await portal('/orders');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'must_change_password');
    assert.equal((await portal('/password', { method: 'POST', body: { current: temp, next: 'corta1' } })).status, 400);
    assert.equal((await portal('/password', { method: 'POST', body: { current: 'otra', next: 'NuevaClave2026' } })).status, 400);
    const changed = await portal('/password', { method: 'POST', body: { current: temp, next: 'NuevaClave2026' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.user.mustChangePassword, false);
    // The panel session token is not a portal session.
    assert.equal((await portal('/me', { token: norte })).status, 401);
  });

  test('pedidos: solo los del cliente; el detalle de otro cliente es 404', async () => {
    const list = await portal('/orders?status=');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map((o: any) => o.id), [myOrder.id]);
    assert.equal(list.json.items[0].trackingPath.startsWith('/seguimiento/'), true);
    const d = await portal(`/orders/${myOrder.id}`);
    assert.equal(d.status, 200);
    assert.ok(Array.isArray(d.json.events));
    assert.equal((await portal(`/orders/${otherOrder.id}`)).status, 404);
    assert.equal((await portal(`/orders/${otherOrder.id}/remito.pdf`)).status, 404);
    assert.equal((await portal(`/orders/${myOrder.id}/remito.pdf`)).status, 409, 'sin viaje todavía');
    assert.deepEqual((await portal('/invoices')).json.items, []);
  });

  test('nuevo pedido: borrador con origen portal; solo lugares propios o compartidos', async () => {
    const places = (await portal('/places')).json.items.map((p: any) => p.id);
    assert.ok(places.includes(ownPlace.id) && places.includes(shared.id));
    assert.ok(!places.includes(otherPlace.id), 'no ve lugares de otro cliente');
    assert.equal((await portal('/orders', { method: 'POST', body: { originPlaceId: shared.id, destinationPlaceId: otherPlace.id, cargo: { description: 'X' } } })).status, 400);
    const r = await portal('/orders', { method: 'POST', body: { originPlaceId: ownPlace.id, destinationPlaceId: shared.id, cargo: { description: 'Barricas', pallets: 6 }, reference: 'OC-55', customerId: other.id } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.order.status, 'borrador');
    assert.equal(r.json.order.source, 'portal');
    const panel = (await env.req('GET', `/api/tms/orders?q=${r.json.order.id}`, { token: norte })).json.items[0];
    assert.equal(panel.customerId, mine.id, 'el cliente es siempre el del usuario');
    assert.equal(panel.status, 'borrador');
    assert.match(panel.createdBy, /^Portal: /);
  });

  test('seguridad: bloqueo por intentos, desactivar corta la sesión y la clave nueva cierra sesiones', async () => {
    for (let i = 0; i < 5; i++) await portal('/login', { method: 'POST', body: { email: 'ana@bodega.test', password: `mal-${i}` }, token: '' });
    const locked = await portal('/login', { method: 'POST', body: { email: 'ana@bodega.test', password: 'NuevaClave2026' }, token: '' });
    assert.equal(locked.status, 429, 'bloqueado aun con la clave correcta');
    assert.equal((await portal('/me')).status, 200, 'la sesión abierta sigue');

    const reset = await env.req('POST', `/api/tms/portal-users/${userId}/reset-password`, { token: norte });
    assert.equal(reset.status, 200);
    assert.equal((await portal('/me')).status, 401, 'restablecer cierra las sesiones');
    const again = await portal('/login', { method: 'POST', body: { email: 'ana@bodega.test', password: reset.json.password }, token: '' });
    assert.equal(again.status, 200, 'el restablecimiento quita el bloqueo');
    token = again.json.token;

    assert.equal((await env.req('PATCH', `/api/tms/portal-users/${userId}`, { token: norte, body: { active: false } })).json.user.active, false);
    assert.equal((await portal('/me')).status, 401);
    assert.equal((await portal('/login', { method: 'POST', body: { email: 'ana@bodega.test', password: reset.json.password }, token: '' })).status, 403);
  });
});
