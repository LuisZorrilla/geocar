import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { convert, crossFactor, excelMoneyFormat, formatMoney, rateAt, roundMoney, type ExchangeRate } from '../src/shared/currency.ts';
import { CurrencyService } from '../server/currency/service.ts';
import { fetchSuggestion, findSource } from '../server/currency/sources.ts';

const rate = (currency: string, perUsd: number, effectiveAt: string, id = `fx-${currency}-${effectiveAt}`): ExchangeRate => ({
  id,
  currency,
  perUsd,
  effectiveAt,
  source: 'manual',
  createdBy: 'test',
  createdAt: effectiveAt,
});

describe('tipos de cambio (pivote USD)', () => {
  const rates = [
    rate('ARS', 1000, '2026-01-01T00:00:00Z'),
    rate('ARS', 1500, '2026-06-01T00:00:00Z'),
    rate('CLP', 900, '2026-01-01T00:00:00Z'),
    rate('VES', 200, '2026-01-01T00:00:00Z'),
  ];

  test('rateAt toma la cotización vigente a la fecha; USD vale 1', () => {
    assert.equal(rateAt(rates, 'ARS', '2026-03-01T00:00:00Z')?.perUsd, 1000);
    assert.equal(rateAt(rates, 'ARS', '2026-07-01T00:00:00Z')?.perUsd, 1500);
    assert.equal(rateAt(rates, 'ARS', '2025-12-31T00:00:00Z'), null);
    assert.equal(rateAt(rates, 'USD')?.perUsd, 1);
  });

  test('los cruces son consistentes: ARS→CLP = ARS→USD→CLP', () => {
    const at = '2026-03-01T00:00:00Z';
    const direct = crossFactor(rates, 'ARS', 'CLP', at)!.factor;
    const viaUsd = crossFactor(rates, 'ARS', 'USD', at)!.factor * crossFactor(rates, 'USD', 'CLP', at)!.factor;
    assert.ok(Math.abs(direct - viaUsd) < 1e-12);
    assert.equal(direct, 0.9);
    // Ida y vuelta da 1.
    assert.ok(Math.abs(direct * crossFactor(rates, 'CLP', 'ARS', at)!.factor - 1) < 1e-12);
  });

  test('convert redondea a los decimales del destino (CLP sin decimales)', () => {
    assert.equal(convert(1234.56, 'ARS', 'CLP', rates, '2026-03-01T00:00:00Z'), 1111);
    assert.equal(convert(1000, 'ARS', 'USD', rates, '2026-03-01T00:00:00Z'), 1);
    assert.equal(convert(10, 'USD', 'VES', rates, '2026-03-01T00:00:00Z'), 2000);
    assert.equal(convert(10, 'USD', 'ARS', [], '2026-03-01T00:00:00Z'), null, 'sin cotización no inventa un valor');
    assert.equal(roundMoney(10.555, 'USD'), 10.56);
  });

  test('formato por moneda', () => {
    assert.equal(formatMoney(1234.5, 'ARS'), '$ 1.234,50');
    assert.equal(formatMoney(1234.5, 'USD'), 'US$ 1.234,50');
    assert.equal(formatMoney(15300.4, 'CLP'), 'CLP$ 15.300');
    assert.equal(formatMoney(4210, 'VES', { withCode: true }), 'Bs. 4.210,00 VES');
    assert.equal(formatMoney(12.5, null), '12,50');
    assert.equal(excelMoneyFormat('CLP'), '"CLP$" #,##0');
    assert.equal(excelMoneyFormat('USD'), '"US$" #,##0.00');
  });
});

describe('migración de importes *Mxn', () => {
  test('renombra los campos sin perder valores y es idempotente', () => {
    const state: any = {
      tenants: [{ id: 't1', name: 'T1' }],
      maintenanceRecords: [{ id: 'm1', tenantId: 't1', costMxn: 500 }],
      preventivePlans: [{ id: 'p1', tenantId: 't1', estimatedCostMxn: 900 }],
      partsInventory: [{ id: 'i1', tenantId: 't1', unitCostMxn: 12.5 }],
      workOrders: [
        {
          id: 'o1',
          tenantId: 't1',
          laborCostMxn: 100,
          partsCostMxn: 50,
          totalCostMxn: 150,
          parts: [{ id: 'x', unitCostMxn: 25, subtotalMxn: 50, quantity: 2 }],
        },
      ],
    };
    const svc = new CurrencyService(() => ({ state, repo: null as any, audit: () => {}, persist: () => {} }));
    assert.equal(svc.normalize(), true);
    assert.equal(state.maintenanceRecords[0].cost, 500);
    assert.equal(state.preventivePlans[0].estimatedCost, 900);
    assert.equal(state.partsInventory[0].unitCost, 12.5);
    assert.deepEqual(
      { l: state.workOrders[0].laborCost, p: state.workOrders[0].partsCost, t: state.workOrders[0].totalCost },
      { l: 100, p: 50, t: 150 }
    );
    assert.equal(state.workOrders[0].parts[0].unitCost, 25);
    assert.equal(state.workOrders[0].parts[0].subtotal, 50);
    assert.ok(!('costMxn' in state.maintenanceRecords[0]) && !('unitCostMxn' in state.workOrders[0].parts[0]));
    assert.equal(state.tenants[0].currency, null, 'empresa existente: sin moneda hasta que la defina el superadmin');
    assert.equal(state.tenants[0].referenceCurrency, 'USD');
    assert.deepEqual(state.currencies.map((c: any) => c.code).sort(), ['ARS', 'CLP', 'USD', 'VES']);
    assert.equal(svc.normalize(), false, 'segunda pasada: nada que cambiar');
  });
});

describe('definir la moneda de una empresa sin moneda', () => {
  test('la primera vez conserva los importes y queda el rastro', () => {
    const audits: any[] = [];
    const state: any = {
      tenants: [{ id: 't1', name: 'Vieja S.A.', currency: null, referenceCurrency: 'USD' }],
      maintenanceRecords: [{ id: 'm1', tenantId: 't1', cost: 500 }],
      preventivePlans: [],
      partsInventory: [],
      workOrders: [{ id: 'o1', tenantId: 't1', laborCost: 100, partsCost: 0, totalCost: 100, parts: [] }],
      exchangeRates: [],
      currencyChanges: [],
    };
    const svc = new CurrencyService(() => ({ state, repo: null as any, audit: (e) => audits.push(e), persist: () => {} }));
    svc.normalize();
    const r = svc.setTenantCurrency('t1', 'CLP', 'convertir', { name: 'Super', role: 'Superadmin' });
    assert.equal(r.change.mode, 'definir', 'sin moneda previa: se define, no se convierte (aunque no haya cotización)');
    assert.equal(state.tenants[0].currency, 'CLP');
    assert.equal(state.workOrders[0].totalCost, 100);
    assert.equal(state.maintenanceRecords[0].cost, 500);
    assert.equal(state.currencyChanges.length, 1);
    assert.match(audits[0].detail, /se conservan/);
    // Cambiarla después sin cotización: error claro, nada se toca.
    assert.throws(() => svc.setTenantCurrency('t1', 'ARS', 'convertir', { name: 'Super', role: 'Superadmin' }), /Falta el tipo de cambio/);
    assert.equal(state.tenants[0].currency, 'CLP');
  });
});

describe('cotización sugerida (adaptadores, sin red)', () => {
  const fakeFetch = (body: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 503, json: async () => body });

  test('dolarapi AR toma el precio de venta', async () => {
    const s = await fetchSuggestion(findSource('dolarapi_ar_oficial')!, fakeFetch({ compra: 1550, venta: 1600, fechaActualizacion: '2026-11-20T18:55:00.000Z' }));
    assert.equal(s.perUsd, 1600);
    assert.equal(s.at, '2026-11-20T18:55:00.000Z');
  });

  test('dolarapi VE usa el promedio; mindicador CL el primer valor de la serie', async () => {
    assert.equal((await fetchSuggestion(findSource('dolarapi_ve_oficial')!, fakeFetch({ promedio: 918.7662, compra: null, venta: null }))).perUsd, 918.7662);
    assert.equal(
      (await fetchSuggestion(findSource('mindicador_cl_dolar')!, fakeFetch({ serie: [{ fecha: '2026-11-20T03:00:00.000Z', valor: 1008.79 }, { valor: 1 }] }))).perUsd,
      1008.79
    );
  });

  test('errores de la fuente vuelven como mensaje, sin lanzar', async () => {
    const down = await fetchSuggestion(findSource('dolarapi_cl')!, fakeFetch({}, false));
    assert.equal(down.perUsd, null);
    assert.match(down.error!, /503/);
    const broken = await fetchSuggestion(findSource('dolarapi_cl')!, fakeFetch({ venta: 'x' }));
    assert.match(broken.error!, /no trajo/);
    const offline = await fetchSuggestion(findSource('dolarapi_cl')!, async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.match(offline.error!, /No se pudo/);
  });
});

const env = new TestEnv();
let superadmin: string;
let norte: string;
let urbana: string;
let frio: string;

before(
  async () => {
    await env.start();
    superadmin = await env.token(...DEMO.superadmin);
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    frio = await env.token(...DEMO.frio);
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('API de monedas', () => {
  test('cualquiera lee monedas y cotizaciones; solo el superadmin las cambia', async () => {
    const read = await env.req('GET', '/api/currencies', { token: norte });
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.currencies.map((c: any) => c.code), ['ARS', 'VES', 'USD', 'CLP']);
    assert.ok(read.json.exchangeRates.length >= 3);
    assert.equal(read.json.sources, undefined, 'las fuentes son solo para el superadmin');

    assert.equal((await env.req('POST', '/api/currencies/ARS/rates', { token: norte, body: { perUsd: 1 } })).status, 403);
    assert.equal((await env.req('PATCH', '/api/currencies/ARS', { token: norte, body: { name: 'x' } })).status, 403);
    assert.equal((await env.req('PUT', '/api/tenants/ten-norte/currency', { token: norte, body: { currency: 'USD' } })).status, 403);
    assert.equal((await env.req('GET', '/api/currencies/rates/suggest', { token: norte })).status, 403);
    assert.equal((await env.req('PUT', '/api/settings/platform-currency', { token: norte, body: { currency: 'ARS' } })).status, 403);

    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(boot.tenant.currency, 'ARS');
    assert.ok(boot.currencies.length === 4 && boot.exchangeRates.length >= 3);
  });

  test('cargar cotización: valida, queda en el historial y en la auditoría', async () => {
    assert.equal((await env.req('POST', '/api/currencies/ARS/rates', { token: superadmin, body: { perUsd: 0 } })).status, 400);
    assert.equal((await env.req('POST', '/api/currencies/USD/rates', { token: superadmin, body: { perUsd: 2 } })).status, 400);
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    assert.equal((await env.req('POST', '/api/currencies/ARS/rates', { token: superadmin, body: { perUsd: 1500, effectiveAt: future } })).status, 400);

    const ok = await env.req('POST', '/api/currencies/ARS/rates', { token: superadmin, body: { perUsd: 1600, source: 'dolarapi_ar_oficial' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.rate.perUsd, 1600);
    const hist = await env.req('GET', '/api/currencies/rates/history?code=ARS', { token: superadmin });
    assert.equal(hist.json.rates[0].perUsd, 1600);
    const audit = (await env.req('GET', '/api/bootstrap', { token: superadmin })).json.auditLogs;
    assert.ok(audit.some((a: any) => a.module === 'Monedas' && /1 USD = 1600 ARS/.test(a.detail)));
  });

  test('editar moneda; no se deshabilita USD ni una moneda en uso', async () => {
    const r = await env.req('PATCH', '/api/currencies/CLP', { token: superadmin, body: { symbol: '$CL', decimals: 0 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.currency.symbol, '$CL');
    assert.equal((await env.req('PATCH', '/api/currencies/USD', { token: superadmin, body: { enabled: false } })).status, 400);
    assert.equal((await env.req('PATCH', '/api/currencies/ARS', { token: superadmin, body: { enabled: false } })).status, 400);
    assert.equal((await env.req('PATCH', '/api/currencies/VES', { token: superadmin, body: { enabled: false } })).status, 200);
    assert.equal((await env.req('PATCH', '/api/currencies/VES', { token: superadmin, body: { enabled: true } })).status, 200);
  });

  test('repuesto cargado en USD en una empresa en ARS: se convierte y guarda el original', async () => {
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const v = boot.vehicles[0];
    const created = await env.req('POST', '/api/work-orders', {
      token: norte,
      body: {
        vehicleId: v.id,
        title: 'Turbo importado',
        parts: [{ sku: 'TRB-1', name: 'Turbo', category: 'refaccion', quantity: 2, unitCost: 100, currency: 'USD' }],
        laborCost: 50,
        laborCurrency: 'USD',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const wo = created.json.workOrder;
    assert.equal(wo.parts[0].unitCost, 160_000); // 100 USD × 1600
    assert.equal(wo.parts[0].subtotal, 320_000);
    assert.deepEqual({ c: wo.parts[0].original.currency, a: wo.parts[0].original.amount }, { c: 'USD', a: 100 });
    assert.equal(wo.laborCost, 80_000);
    assert.equal(wo.laborOriginal.amount, 50);
    assert.equal(wo.totalCost, 400_000);

    // Moneda inexistente: se rechaza sin guardar nada.
    const noRate = await env.req('POST', '/api/parts-inventory', {
      token: norte,
      body: { sku: 'X-1', name: 'X', unitCost: 10, unitCostCurrency: 'XYZ' },
    });
    assert.equal(noRate.status, 400);
  });

  test('vista previa de la conversión: factor calculado por el pivote USD', async () => {
    const p = await env.req('GET', '/api/tenants/ten-frio/currency/preview?to=CLP', { token: superadmin });
    assert.equal(p.status, 200);
    assert.equal(p.json.preview.mode, 'convertir');
    assert.equal(p.json.preview.from, 'ARS');
    assert.ok(Math.abs(p.json.preview.factor - 950 / 1600) < 1e-12);
  });

  test('cambiar con conversión: convierte todos los importes y deja el rastro', async () => {
    const before = (await env.req('GET', '/api/bootstrap', { token: frio })).json;
    const order = before.workOrders.find((o: any) => o.totalCost > 0);
    assert.ok(order);
    const r = await env.req('PUT', '/api/tenants/ten-frio/currency', { token: superadmin, body: { currency: 'CLP', mode: 'convertir' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.change.mode, 'convertir');
    assert.ok(r.json.change.documents > 0);

    const after = (await env.req('GET', '/api/bootstrap', { token: frio })).json;
    assert.equal(after.tenant.currency, 'CLP');
    const same = after.workOrders.find((o: any) => o.id === order.id);
    assert.equal(same.totalCost, Math.round(same.partsCost + same.laborCost));
    assert.ok(Math.abs(same.totalCost - order.totalCost * (950 / 1600)) <= order.parts.length + 2, 'convertido con 1 ARS = 950/1600 CLP');
    assert.ok(same.parts.every((p: any) => Number.isInteger(p.unitCost)), 'CLP sin decimales');

    // Ya usa CLP: repetir es un error.
    assert.equal((await env.req('PUT', '/api/tenants/ten-frio/currency', { token: superadmin, body: { currency: 'CLP' } })).status, 400);

    const changes = await env.req('GET', '/api/tenants/ten-frio/currency/preview?to=ARS', { token: superadmin });
    assert.equal(changes.json.changes[0].to, 'CLP');
  });

  test('solo rótulo: los números no cambian', async () => {
    const before = (await env.req('GET', '/api/bootstrap', { token: urbana })).json;
    const r = await env.req('PUT', '/api/tenants/ten-urbana/currency', { token: superadmin, body: { currency: 'VES', mode: 'rotulo' } });
    assert.equal(r.status, 200);
    const after = (await env.req('GET', '/api/bootstrap', { token: urbana })).json;
    assert.equal(after.tenant.currency, 'VES');
    assert.deepEqual(
      after.workOrders.map((o: any) => o.totalCost),
      before.workOrders.map((o: any) => o.totalCost)
    );
  });

  test('consolidado: el tablero de todas las empresas suma en la moneda de referencia', async () => {
    const all = (await env.req('GET', '/api/bootstrap', { token: superadmin, headers: { 'x-tenant-scope': 'all' } })).json;
    assert.equal(all.maintenanceDashboard.currency, 'USD');
    assert.equal(all.maintenanceDashboard.consolidated, true);
    assert.equal(all.tenant.currency, 'USD');

    const one = (await env.req('GET', '/api/bootstrap', { token: superadmin, headers: { 'x-tenant-scope': 'ten-norte' } })).json;
    assert.equal(one.maintenanceDashboard.currency, 'ARS');
    assert.equal(one.maintenanceDashboard.consolidated, false);

    const r = await env.req('PUT', '/api/settings/platform-currency', { token: superadmin, body: { currency: 'ARS' } });
    assert.equal(r.status, 200);
    const allArs = (await env.req('GET', '/api/bootstrap', { token: superadmin, headers: { 'x-tenant-scope': 'all' } })).json;
    assert.equal(allArs.maintenanceDashboard.currency, 'ARS');
    await env.req('PUT', '/api/settings/platform-currency', { token: superadmin, body: { currency: 'USD' } });
  });

  test('exportación consolidada: columnas de moneda y total en la referencia', async () => {
    const res = await fetch(`${env.baseUrl}/api/work-orders/export?format=csv`, {
      headers: { Authorization: `Bearer ${superadmin}`, 'x-tenant-scope': 'all' },
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /Moneda/);
    assert.match(text, /CLP/);
  });

  test('alta de empresa con moneda inexistente → 400', async () => {
    const r = await env.req('POST', '/api/tenants', {
      token: superadmin,
      body: {
        company: { name: 'Moneda Rara S.A.', cuit: '20-12345678-6', city: 'San Juan', branches: ['San Juan'], contactName: 'Ana', contactEmail: 'ana@x.com', contactPhone: '+54 264 400 0000' },
        service: { status: 'piloto', planTier: 'Estándar', vehicleQuota: 2, retentionDays: 30, currency: 'EUR' },
        admin: { name: 'Ana', username: 'admin.rara' },
        templates: { preventivePlans: false, alertRules: false },
      },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /EUR/);
  });
});
