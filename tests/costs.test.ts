import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { fuelAnomalies, fuelEfficiency, parseAmount, parseDateTime, parseFuelRows, priceOrder, tripCost, type Tariff } from '../src/shared/costs.ts';

// ---------------------------------------------------------------- unit

const tariff = (over: Partial<Tariff> = {}): Pick<Tariff, 'rules' | 'extras' | 'priority'> => ({
  priority: ['tramo', 'pallet', 'tonelada', 'km'],
  rules: [
    { id: 't', kind: 'tramo', originPlaceId: 'A', destinationPlaceId: 'B', bothWays: true, price: 100000 },
    { id: 'p', kind: 'pallet', price: 9000, minimum: 50000 },
    { id: 'k', kind: 'km', price: 1500, minimum: 40000 },
  ],
  extras: { waitingPerHour: 10000, waitingFreeMinutes: 60, dangerousPct: 20, refrigeratedPct: 10, tollsPassThrough: true },
  ...over,
});

describe('T3: reglas de precio, combustible y costo', () => {
  test('precio: tramo (ida y vuelta), pallet con mínimo, km, y nada si no aplica', () => {
    assert.equal(priceOrder(tariff(), { originPlaceId: 'A', destinationPlaceId: 'B', distanceKm: 30 })!.amount, 100000);
    assert.equal(priceOrder(tariff(), { originPlaceId: 'B', destinationPlaceId: 'A', distanceKm: 30 })!.rule, 'tramo');
    const pal = priceOrder(tariff(), { originPlaceId: 'A', destinationPlaceId: 'C', pallets: 3, distanceKm: 30 })!;
    assert.equal(pal.rule, 'pallet');
    assert.equal(pal.amount, 50000, 'aplica el mínimo (3 × 9000 = 27000)');
    const km = priceOrder(tariff(), { originPlaceId: 'A', destinationPlaceId: 'C', distanceKm: 40 })!;
    assert.equal(km.rule, 'km');
    assert.equal(km.amount, 60000);
    assert.equal(priceOrder({ ...tariff(), rules: [tariff().rules[0]] }, { originPlaceId: 'A', destinationPlaceId: 'C', distanceKm: 40 }), null);
  });

  test('adicionales: peligrosa, frío, estadía por hora iniciada y peajes', () => {
    const p = priceOrder(tariff(), { originPlaceId: 'A', destinationPlaceId: 'B', distanceKm: 30, dangerous: true, refrigerated: true, waitingMinutes: 150, tolls: 3200 })!;
    assert.deepEqual(
      p.lines.map((l) => l.amount),
      [100000, 20000, 10000, 20000, 3200] // base, +20 %, +10 %, 2 h de estadía (150 − 60 = 90 min → 2 h), peajes
    );
    assert.equal(p.amount, 153200);
  });

  test('combustible: rendimiento, tanque excedido, consumo alto, odómetro y OBD', () => {
    const base = [
      { id: 'a', at: '2026-11-01T10:00:00Z', liters: 100, odometerKm: 10000 },
      { id: 'b', at: '2026-11-03T10:00:00Z', liters: 100, odometerKm: 10350 },
      { id: 'c', at: '2026-11-05T10:00:00Z', liters: 100, odometerKm: 10700 },
      { id: 'd', at: '2026-11-07T10:00:00Z', liters: 100, odometerKm: 11050 },
    ];
    assert.equal(fuelEfficiency(base).get('b'), 28.6);
    const thirsty = { id: 'e', at: '2026-11-09T10:00:00Z', liters: 150, odometerKm: 11300 };
    assert.deepEqual(fuelAnomalies(thirsty, base, { tankLiters: 400 }).map((f) => f.code), ['consumo_alto']);
    // 450 L in 950 km is also above the usual consumption.
    assert.deepEqual(fuelAnomalies({ ...thirsty, liters: 450, odometerKm: 12000 }, base, { tankLiters: 400 }).map((f) => f.code), ['excede_tanque', 'consumo_alto']);
    assert.deepEqual(fuelAnomalies({ ...thirsty, liters: 90, odometerKm: 9000 }, base, {}).map((f) => f.code), ['odometro_incoherente']);
    // 200 L in a 400 L tank should raise ~50 %; it rose 5 % → suspicious.
    assert.deepEqual(fuelAnomalies({ ...thirsty, liters: 200, odometerKm: undefined }, base, { tankLiters: 400 }, { before: 20, after: 25 }).map((f) => f.code), ['obd_no_sube']);
    assert.equal(fuelAnomalies({ ...thirsty, liters: 200, odometerKm: undefined }, base, { tankLiters: 400 }, { before: 20, after: 68 }).length, 0);
  });

  test('importación: números y fechas argentinas, columnas por sinónimos y errores por fila', () => {
    assert.equal(parseAmount('1.234,56'), 1234.56);
    assert.equal(parseAmount('$ 98.500'), 98500);
    assert.equal(parseAmount('1,234.5'), 1234.5);
    assert.equal(parseAmount('120.5'), 120.5);
    assert.equal(parseAmount('45.300'), 45300);
    assert.equal(parseDateTime('23/11/2026 14:05')?.slice(0, 10), new Date(2026, 10, 23, 14, 5).toISOString().slice(0, 10));
    const r = parseFuelRows([
      { Fecha: '23/11/2026 08:10', Dominio: 'ab 123 cd', Litros: '120,5', 'Importe Total': '150.625,00', Kilometraje: '45.300', Establecimiento: 'YPF Ruta 40' },
      { Fecha: 'ayer', Dominio: 'AB123CD', Litros: '10', 'Importe Total': '100' },
    ]);
    assert.deepEqual(r.missingColumns, []);
    assert.equal(r.rows[0].plate, 'AB123CD');
    assert.equal(r.rows[0].liters, 120.5);
    assert.equal(r.rows[0].pricePerLiter, 1250);
    assert.equal(r.rows[0].odometerKm, 45300);
    assert.equal(r.rows[1].error, 'fecha inválida');
    assert.deepEqual(parseFuelRows([{ Dia: '1', Auto: 'x' }]).missingColumns, ['fecha', 'patente', 'litros', 'importe o precio']);
  });

  test('costo del viaje: cargas reales o estimado, gastos, mantenimiento y horas', () => {
    const c = tripCost({ km: 200, kmSource: 'odometro', fuelLoadsTotal: 0, fuelEstimate: { litersPer100: 30, pricePerLiter: 1200 }, expenses: 5000, maintenancePerKm: 50, driverHourlyCost: 8000, hours: 5 });
    assert.equal(c.fuelEstimated, true);
    assert.deepEqual(c.lines.map((l) => l.amount), [72000, 5000, 10000, 40000]);
    assert.equal(c.total, 127000);
  });
});

// ---------------------------------------------------------------- API

const env = new TestEnv();
let norte: string;
let monitoreo: string;
let urbana: string;
const iso = (ms: number) => new Date(ms).toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

function makePng(w: number, h: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4)))), chunk('IEND', Buffer.alloc(0))]);
}

/** Valid company CUIT (prefix 30). */
function companyCuit(body8: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `30${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  return r === 10 ? companyCuit(String(Number(body8) + 1)) : `${base}${r === 11 ? 0 : r}`;
}

function cuilFor(dni: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (const p of ['20', '23', '24', '27']) {
    const base = p + dni.padStart(8, '0');
    const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
    if (r !== 10) return base + (r === 11 ? 0 : r);
  }
  throw new Error('sin CUIL');
}

async function authorizedDriver(token: string, dni: string) {
  let d = (await env.req('POST', '/api/drivers', {
    token,
    body: {
      firstName: 'Tomás', lastName: `Costos ${dni.slice(-3)}`, dni, cuil: cuilFor(dni), birthDate: '1985-01-01', phone: '+54 264 555 0000',
      branch: 'San Juan Capital', profile: 'profesional', licenseClasses: ['B.1', 'E.1'],
      documents: [
        { type: 'dni', number: dni }, { type: 'licencia', number: dni, expiresAt: plusDays(400) },
        { type: 'linti', number: 'L', expiresAt: plusDays(300) }, { type: 'psicofisico', number: 'P', expiresAt: plusDays(200) },
      ],
    },
  })).json.driver;
  for (const doc of d.documents) {
    await fetch(`${env.baseUrl}/api/drivers/${d.id}/documents/${doc.type}/file`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-file-name': 'd.png' }, body: new Uint8Array(PNG) });
    d = (await env.req('POST', `/api/drivers/${d.id}/documents/${doc.type}/verify`, { token, body: { decision: 'verificado' } })).json.driver;
  }
  assert.equal(d.authorization.state, 'habilitado');
  return d;
}

describe('T3: API de costos y facturación', () => {
  let vehicle: any;
  let driver: any;
  let customer: any;
  let placeA: any;
  let placeB: any;
  let order: any;
  let trip: any;
  let driverToken: string;

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const critical = new Set(boot.workOrders.filter((w: any) => w.priority === 'critica' && !['completada', 'cancelada'].includes(w.status)).map((w: any) => w.vehicleId));
    vehicle = boot.vehicles.find((v: any) => v.assetType === 'vehiculo' && !critical.has(v.id));
    driver = await authorizedDriver(norte, '35666777');
    const created = await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Cliente Costos', taxId: companyCuit('71444333') } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    customer = created.json.customer;
    placeA = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Origen C', kind: 'deposito', address: 'X', lat: -31.6, lng: -68.4 } })).json.place;
    placeB = (await env.req('POST', '/api/tms/places', { token: norte, body: { name: 'Destino C', kind: 'cliente', address: 'Y', lat: -31.7, lng: -68.5 } })).json.place;
    driverToken = (await env.req('POST', `/api/tms/drivers/${driver.id}/app-link`, { token: norte })).json.token;
  });
  after(() => env.close());

  test('tarifario y cotizador; un perfil de solo lectura no edita', async () => {
    const body = {
      customerId: customer.id,
      name: 'Tarifario de prueba',
      rules: [
        { kind: 'tramo', originPlaceId: placeA.id, destinationPlaceId: placeB.id, price: 120000 },
        { kind: 'km', price: 2000, minimum: 30000 },
      ],
      extras: { tollsPassThrough: true, dangerousPct: 25 },
    };
    assert.equal((await env.req('POST', '/api/costs/tariffs', { token: monitoreo, body })).status, 403);
    const t = await env.req('POST', '/api/costs/tariffs', { token: norte, body });
    assert.equal(t.status, 201, JSON.stringify(t.json));
    const q = await env.req('POST', '/api/costs/quote', { token: norte, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, dangerous: true } });
    assert.equal(q.status, 200);
    assert.equal(q.json.price.amount, 150000);
    assert.ok(q.json.distanceKm > 10);
    // Reverse route isn't "bothWays": falls back to per km.
    const back = (await env.req('POST', '/api/costs/quote', { token: norte, body: { customerId: customer.id, originPlaceId: placeB.id, destinationPlaceId: placeA.id } })).json;
    assert.equal(back.price.rule, 'km');
  });

  test('viaje entregado: precio automático con peajes; combustible y gastos desde la app; costo y margen', async () => {
    order = (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: placeA.id, destinationPlaceId: placeB.id, cargo: { description: 'Cajas', weightKg: 800 }, confirm: true } })).json.order;
    trip = (await env.req('POST', '/api/tms/trips', { token: norte, body: { vehicleId: vehicle.id, driverId: driver.id, plannedStart: iso(Date.now() + 3600_000), orderIds: [order.id], acceptWarnings: { reason: 'prueba' } } })).json.trip;
    const h = { 'x-driver-token': driverToken };
    await env.req('POST', `/api/driver-app/trips/${trip.id}/start`, { headers: h });

    // Driver loads fuel and a toll (with the ticket photo) from the app.
    const up = await fetch(`${env.baseUrl}/api/driver-app/trips/${trip.id}/files?kind=receipt`, { method: 'PUT', headers: { ...h, 'Content-Type': 'image/png' }, body: new Uint8Array(makePng(40, 20)) });
    assert.equal(up.status, 201);
    const receipt = (await up.json()).fileId;
    const fuel = await env.req('POST', `/api/driver-app/trips/${trip.id}/fuel`, { headers: h, body: { liters: 80, total: 96000, receiptFileId: receipt } });
    assert.equal(fuel.status, 201, JSON.stringify(fuel.json));
    const toll = await env.req('POST', `/api/driver-app/trips/${trip.id}/expenses`, { headers: h, body: { type: 'peaje', amount: 4500, receiptFileId: receipt } });
    assert.equal(toll.status, 201);
    assert.equal(toll.json.expense.status, 'pendiente');
    const meal = (await env.req('POST', `/api/driver-app/trips/${trip.id}/expenses`, { headers: h, body: { type: 'comida', amount: 12000 } })).json.expense;

    // Monitoring can't approve; the admin approves the toll and rejects nothing else yet.
    assert.equal((await env.req('POST', `/api/costs/expenses/${toll.json.expense.id}/review`, { token: monitoreo, body: { decision: 'aprobado' } })).status, 403);
    assert.equal((await env.req('POST', `/api/costs/expenses/${toll.json.expense.id}/review`, { token: norte, body: { decision: 'aprobado' } })).status, 200);
    assert.equal((await env.req('POST', `/api/costs/expenses/${meal.id}/review`, { token: norte, body: { decision: 'aprobado' } })).status, 200);

    // Finish: both stops by hand → delivered → priced with the tariff + toll.
    let t = (await env.req('GET', `/api/tms/trips/${trip.id}`, { token: norte })).json.trip;
    for (const s of t.stops) await env.req('POST', `/api/tms/trips/${trip.id}/stops/${s.id}`, { token: norte, body: { status: 'completada' } });
    const ord = (await env.req('GET', `/api/tms/orders?q=${order.id}`, { token: norte })).json.items[0];
    assert.equal(ord.status, 'entregado');
    assert.equal(ord.charge.amount, 124500, JSON.stringify(ord.charge));
    assert.deepEqual(ord.charge.lines.map((l: any) => l.label), ['Flete por tramo', 'Peajes']);

    const eco = (await env.req('GET', `/api/costs/trips/${trip.id}`, { token: norte })).json.economics;
    assert.equal(eco.revenue, 124500);
    assert.ok(eco.cost.lines.some((l: any) => l.label.startsWith('Combustible (cargas') && l.amount === 96000));
    assert.ok(eco.cost.lines.some((l: any) => l.label === 'Gastos del viaje' && l.amount === 16500));
    assert.equal(eco.margin, Math.round((eco.revenue - eco.cost.total) * 100) / 100);

    // Manual adjustment needs a reason and is kept.
    assert.equal((await env.req('POST', `/api/costs/orders/${order.id}/charge`, { token: norte, body: { amount: 130000 } })).status, 400);
    const adj = await env.req('POST', `/api/costs/orders/${order.id}/charge`, { token: norte, body: { amount: 130000, reason: 'Acordado con el cliente' } });
    assert.equal(adj.json.charge.amount, 130000);
    assert.equal(adj.json.charge.rule, 'manual');
  });

  test('pre-factura: toma lo entregado, bloquea el doble cobro, se emite y se anula', async () => {
    const pf = await env.req('POST', '/api/costs/pre-invoices', { token: norte, body: { customerId: customer.id, from: today(), to: today() } });
    assert.equal(pf.status, 201, JSON.stringify(pf.json));
    assert.equal(pf.json.preInvoice.total, 130000);
    assert.match(pf.json.preInvoice.id, /^PF-/);
    assert.equal((await env.req('POST', '/api/costs/pre-invoices', { token: norte, body: { customerId: customer.id, from: today(), to: today() } })).status, 409, 'no factura dos veces');
    assert.equal((await env.req('POST', `/api/costs/orders/${order.id}/charge`, { token: norte, body: { amount: 1, reason: 'x' } })).status, 409, 'no se cambia el precio de algo pre-facturado');
    const pdf = await fetch(`${env.baseUrl}/api/costs/pre-invoices/${pf.json.preInvoice.id}/export?format=pdf`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await env.req('POST', `/api/costs/pre-invoices/${pf.json.preInvoice.id}/issue`, { token: monitoreo })).status, 403);
    assert.equal((await env.req('POST', `/api/costs/pre-invoices/${pf.json.preInvoice.id}/issue`, { token: norte })).json.preInvoice.status, 'emitida');
    const voided = await env.req('POST', `/api/costs/pre-invoices/${pf.json.preInvoice.id}/void`, { token: norte, body: { reason: 'Error de período' } });
    assert.equal(voided.json.preInvoice.status, 'anulada');
    assert.equal((await env.req('POST', '/api/costs/pre-invoices', { token: norte, body: { customerId: customer.id, from: today(), to: today() } })).status, 201, 'anulada, se puede volver a facturar');
  });

  test('liquidación de viáticos: solo gastos aprobados que pagó el chofer', async () => {
    const s = await env.req('POST', '/api/costs/settlements', { token: norte, body: { driverId: driver.id, from: today(), to: today() } });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal(s.json.settlement.total, 16500);
    assert.equal((await env.req('POST', '/api/costs/settlements', { token: norte, body: { driverId: driver.id, from: today(), to: today() } })).status, 409);
    assert.equal((await env.req('POST', `/api/costs/settlements/${s.json.settlement.id}/pay`, { token: norte })).json.settlement.status, 'pagada');
  });

  test('combustible: importación con vista previa, duplicados, patentes ajenas y alertas', async () => {
    const plate = vehicle.plate;
    const csv = [
      'Fecha;Dominio;Litros;Importe;Kilometraje;Establecimiento',
      `20/11/2026 08:00;${plate};100,00;120.000,00;50000;YPF Centro`,
      `21/11/2026 08:00;${plate};110,00;132.000,00;50350;YPF Centro`,
      `22/11/2026 08:00;ZZ999ZZ;50,00;60.000,00;;Shell`,
      `23/11/2026 08:00;${plate};900,00;1.080.000,00;50700;YPF Centro`,
    ].join('\n');
    const send = (dry: boolean) =>
      fetch(`${env.baseUrl}/api/costs/fuel/import${dry ? '?dryRun=true' : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${norte}`, 'Content-Type': 'text/csv', 'x-file-name': 'resumen.csv' }, body: csv }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const preview = await send(true);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.total, 4);
    assert.match(preview.json.rows[2].error, /no es de la empresa/);
    const imp = await send(false);
    assert.equal(imp.json.imported, 3, JSON.stringify(imp.json));
    assert.equal(imp.json.skipped.length, 1);
    assert.ok(imp.json.flagged >= 1, 'los 900 L superan el tanque');
    const again = await send(false);
    assert.equal(again.json.imported, 0);
    assert.ok(again.json.skipped.some((s: any) => s.reason === 'ya estaba cargada'));
    const list = (await env.req('GET', `/api/costs/fuel?vehicleId=${vehicle.id}&flagged=true`, { token: norte })).json;
    assert.ok(list.items.some((f: any) => f.flags.some((x: any) => x.code === 'excede_tanque')));
    // Another company's file for these plates: the plates aren't theirs.
    const other = await fetch(`${env.baseUrl}/api/costs/fuel/import`, { method: 'POST', headers: { Authorization: `Bearer ${urbana}`, 'Content-Type': 'text/csv', 'x-file-name': 'r.csv' }, body: csv }).then((r) => r.json());
    assert.equal(other.imported, 0);
  });

  test('rentabilidad por cliente y aislamiento', async () => {
    const r = (await env.req('GET', `/api/costs/profitability?groupBy=cliente&from=${today()}&to=${today()}`, { token: norte })).json;
    const row = r.rows.find((x: any) => x.key === customer.id);
    assert.ok(row, JSON.stringify(r));
    assert.equal(row.revenue, 130000);
    const xlsx = await fetch(`${env.baseUrl}/api/costs/profitability/export?groupBy=chofer&format=xlsx&from=${today()}&to=${today()}`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(xlsx.status, 200);
    assert.equal((await env.req('GET', `/api/costs/trips/${trip.id}`, { token: urbana })).status, 404);
    assert.equal((await env.req('GET', '/api/costs/tariffs', { token: urbana })).json.items.some((t: any) => t.customerId === customer.id), false);
  });
});
