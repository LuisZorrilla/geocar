import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { checkWebhookUrl, isPrivateAddress, signPayload } from '../server/integrations/service.ts';

describe('T5: webhooks — reglas', () => {
  test('direcciones internas bloqueadas (IPv4, IPv6 y mapeadas)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '200.45.10.1', '172.32.0.1', '2800:810::1']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('URL: https público, sin credenciales ni redes internas', () => {
    const prev = process.env.WEBHOOKS_ALLOW_PRIVATE;
    delete process.env.WEBHOOKS_ALLOW_PRIVATE;
    try {
      assert.equal(checkWebhookUrl('https://erp.cliente.com/hooks/geocar'), 'https://erp.cliente.com/hooks/geocar');
      assert.throws(() => checkWebhookUrl('http://erp.cliente.com/x'), /https/);
      assert.throws(() => checkWebhookUrl('https://localhost/x'), /red interna/);
      assert.throws(() => checkWebhookUrl('https://169.254.169.254/latest'), /red interna/);
      assert.throws(() => checkWebhookUrl('https://[::1]/x'), /red interna/);
      assert.throws(() => checkWebhookUrl('https://user:pw@erp.cliente.com/x'), /usuario/);
      assert.throws(() => checkWebhookUrl('no es url'), /no es válida/);
    } finally {
      if (prev !== undefined) process.env.WEBHOOKS_ALLOW_PRIVATE = prev;
    }
  });

  test('firma: HMAC-SHA256 de "<t>.<cuerpo>" verificable por el receptor', () => {
    const body = '{"id":"evt-1"}';
    const sig = signPayload('whsec_x', body, 1700000000);
    const [t, v1] = sig.split(',').map((p) => p.split('=')[1]);
    assert.equal(t, '1700000000');
    assert.equal(v1, crypto.createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex'));
  });
});

// ---------------------------------------------------------------- API

type Hit = { headers: http.IncomingHttpHeaders; body: string; json: any };

function receiver() {
  const hits: Hit[] = [];
  let failWith = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failWith) {
        res.statusCode = failWith;
        return res.end('caído');
      }
      hits.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.end('ok');
    });
  });
  return {
    hits,
    fail: (status: number) => (failWith = status),
    listen: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitForAsync<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout esperando el webhook');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const env = new TestEnv({ WEBHOOKS_ALLOW_PRIVATE: 'true', PUBLIC_APP_URL: 'https://flota.example.com' });
const rx = receiver();
let hookUrl = '';

describe('T5: API pública y webhooks', () => {
  let norte = '';
  let monitoreo = '';
  let urbana = '';
  let token = '';
  let keyId = '';
  let webhook: any;
  let secret = '';
  let customer: any;
  let places: any[] = [];
  let orderId = '';
  const v1 = (path: string, init: { method?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${env.baseUrl}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.key !== '' ? { Authorization: `Bearer ${init.key ?? token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }).then(async (r) => ({ status: r.status, headers: r.headers, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null }));

  before(async () => {
    hookUrl = await rx.listen();
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    customer = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Cliente API', taxId: '30-71666555-0', taxCondition: 'Responsable Inscripto' } })).json.customer;
    if (!customer) customer = (await env.req('GET', '/api/tms/customers', { token: norte })).json.items[0];
    places = await Promise.all(['A', 'B'].map(async (n, i) => (await env.req('POST', '/api/tms/places', { token: norte, body: { name: `API ${n}`, kind: 'deposito', address: n, lat: -31.5 - i / 10, lng: -68.5 } })).json.place));
  });
  after(async () => {
    await env.close();
    await rx.close();
  });

  test('claves: solo administradores; el token se muestra una vez y no se guarda en claro', async () => {
    assert.equal((await env.req('POST', '/api/integrations/api-keys', { token: monitoreo, body: { name: 'x', scopes: ['orders:read'] } })).status, 403);
    assert.equal((await env.req('POST', '/api/integrations/api-keys', { token: norte, body: { name: 'ERP', scopes: [] } })).status, 400);
    const r = await env.req('POST', '/api/integrations/api-keys', { token: norte, body: { name: 'ERP del cliente', scopes: ['orders:read', 'orders:write', 'catalog:read', 'trips:read'] } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    token = r.json.token;
    keyId = r.json.key.id;
    assert.match(token, /^gk_[A-Za-z0-9_-]{32}$/);
    assert.equal(r.json.key.hash, undefined);
    const list = await env.req('GET', '/api/integrations', { token: norte });
    assert.equal(list.json.apiKeys.length, 1);
    assert.ok(!JSON.stringify(list.json).includes(token.slice(10)), 'la lista no expone la clave');
    assert.equal(list.json.apiKeys[0].prefix, token.slice(0, 10));
  });

  test('autenticación y permisos de la clave', async () => {
    assert.equal((await v1('', { key: '' })).status, 401);
    assert.equal((await v1('', { key: 'gk_inventada' })).status, 401);
    const me = await v1('');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.key.scopes, ['orders:read', 'orders:write', 'catalog:read', 'trips:read']);
    assert.equal((await v1('/customers', { method: 'POST', body: { name: 'X', taxId: '1' } })).status, 403, 'sin catalog:write');
    assert.equal((await v1('/invoices')).status, 403, 'sin invoices:read');
    const places = await v1('/places?q=API');
    assert.equal(places.status, 200);
    assert.ok(places.json.items.length >= 2);
    assert.equal((await v1('/no-existe')).status, 404);
    const viaHeader = await fetch(`${env.baseUrl}/api/v1/customers`, { headers: { 'X-Api-Key': token } });
    assert.equal(viaHeader.status, 200);
  });

  test('webhook: alta con secreto único; pedido por API (idempotente) dispara order.created firmado', async () => {
    const wh = await env.req('POST', '/api/integrations/webhooks', { token: norte, body: { url: hookUrl, events: ['order.created', 'order.status_changed', 'trip.created'] } });
    assert.equal(wh.status, 201, JSON.stringify(wh.json));
    webhook = wh.json.webhook;
    secret = wh.json.secret;
    assert.match(secret, /^whsec_/);
    assert.equal(webhook.secret, undefined);

    const body = { customerId: customer.id, originPlaceId: places[0].id, destinationPlaceId: places[1].id, cargo: { description: 'Bobinas', weightKg: 1200 }, reference: 'OC-7781', confirm: true };
    const created = await v1('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': 'oc-7781' } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    orderId = created.json.order.id;
    assert.equal(created.json.order.status, 'confirmado');
    assert.equal(created.json.order.source, 'api');
    assert.match(created.json.order.trackingUrl, /^https:\/\/flota\.example\.com\/seguimiento\//);
    const again = await v1('/orders', { method: 'POST', body, headers: { 'Idempotency-Key': 'oc-7781' } });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.json.order.id, orderId);

    const hit = await waitFor(() => rx.hits.find((h) => h.json.event === 'order.created' && h.json.data.id === orderId));
    assert.equal(hit.headers['x-geocar-event'], 'order.created');
    const [t, sig] = String(hit.headers['x-geocar-signature']).split(',').map((p) => p.split('=')[1]);
    assert.equal(sig, crypto.createHmac('sha256', secret).update(`${t}.${hit.body}`).digest('hex'), 'firma válida');
    assert.equal(hit.json.data.reference, 'OC-7781');
    assert.equal(hit.json.data.trackingPath.startsWith('/seguimiento/'), true);
    assert.equal(rx.hits.filter((h) => h.json.event === 'order.created' && h.json.data.id === orderId).length, 1, 'la repetición idempotente no genera otro evento');

    const got = await v1(`/orders/${orderId}`);
    assert.equal(got.json.order.reference, 'OC-7781');
    assert.ok(Array.isArray(got.json.tracking.events));
    const filtered = await v1('/orders?reference=OC-7781&status=confirmado');
    assert.equal(filtered.json.total, 1);
  });

  test('cambio de estado: cancelar por API dispara order.status_changed con el estado anterior', async () => {
    assert.equal((await v1(`/orders/${orderId}/cancel`, { method: 'POST', body: {} })).status, 400);
    const c = await v1(`/orders/${orderId}/cancel`, { method: 'POST', body: { reason: 'Lo canceló el cliente' } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.order.status, 'cancelado');
    const hit = await waitFor(() => rx.hits.find((h) => h.json.event === 'order.status_changed' && h.json.data.id === orderId));
    assert.equal(hit.json.data.previousStatus, 'confirmado');
    assert.equal(hit.json.data.status, 'cancelado');
  });

  test('aislamiento: la clave solo ve su empresa; otra empresa no gestiona este webhook', async () => {
    assert.equal((await env.req('POST', '/api/integrations/api-keys', { token: urbana, body: { name: 'U', scopes: ['orders:read'] } })).status, 201);
    const urbanaKey = (await env.req('POST', '/api/integrations/api-keys', { token: urbana, body: { name: 'U2', scopes: ['orders:read'] } })).json.token;
    assert.equal((await v1(`/orders/${orderId}`, { key: urbanaKey })).status, 404);
    assert.equal((await v1('/orders?reference=OC-7781', { key: urbanaKey })).json.total, 0);
    assert.equal((await env.req('GET', `/api/integrations/webhooks/${webhook.id}/deliveries`, { token: urbana })).status, 404);
  });

  test('fallas: reintento con espera, prueba (ping) fallida y reenvío manual', async () => {
    rx.fail(503);
    const ping = await env.req('POST', `/api/integrations/webhooks/${webhook.id}/test`, { token: norte });
    assert.equal(ping.json.delivery.status, 'fallido');
    assert.equal(ping.json.delivery.responseStatus, 503);

    const o = await v1('/orders', { method: 'POST', body: { customerId: customer.id, originPlaceId: places[0].id, destinationPlaceId: places[1].id, cargo: { description: 'Reintento' } } });
    assert.equal(o.status, 201);
    const failed = await waitForAsync(async () => {
      const items = (await env.req('GET', `/api/integrations/webhooks/${webhook.id}/deliveries`, { token: norte })).json.items;
      return items.find((x: any) => x.event === 'order.created' && JSON.parse(x.payload).data.id === o.json.order.id && x.attempts >= 1);
    });
    assert.equal(failed.status, 'pendiente', 'queda en cola para reintentar');
    assert.equal(failed.responseStatus, 503);
    assert.match(failed.lastError, /503/);
    assert.ok(Date.parse(failed.nextAttemptAt) - Date.now() > 30_000, 'espera antes del próximo intento');
    assert.equal((await env.req('POST', `/api/integrations/deliveries/${failed.id}/redeliver`, { token: norte })).status, 409, 'ya está en cola');

    // The receiver comes back; a manual redelivery of the failed ping, and the queued one on its turn.
    rx.fail(0);
    const re = await env.req('POST', `/api/integrations/deliveries/${ping.json.delivery.id}/redeliver`, { token: norte });
    assert.equal(re.status, 200);
    await waitFor(() => rx.hits.find((h) => h.json.event === 'ping'));
    const hooks = (await env.req('GET', '/api/integrations', { token: norte })).json.webhooks;
    assert.equal(hooks[0].pending, 1);

    // Pausing stops deliveries; a revoked key stops working.
    const paused = await env.req('PATCH', `/api/integrations/webhooks/${webhook.id}`, { token: norte, body: { active: false } });
    assert.equal(paused.json.webhook.active, false);
    assert.equal((await env.req('DELETE', `/api/integrations/api-keys/${keyId}`, { token: norte })).status, 200);
    assert.equal((await v1('')).status, 401);
  });
});
