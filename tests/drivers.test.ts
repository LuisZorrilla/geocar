import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { computeDriverAuthorization, cuilProblem, minimumAge, type DriverDocument } from '../src/shared/drivers.ts';
import { DriverRegistry } from '../server/drivers/registry.ts';

// ---------------------------------------------------------------- unit

const plusDays = (n: number, from = new Date()) => {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const FILE = { id: 'f', name: 'x.pdf', mime: 'application/pdf', size: 1, sha256: '', uploadedAt: '', uploadedBy: '' };
const OK = { status: 'verificado' as const, by: 'Admin', at: '2026-11-01T00:00:00Z' };
const professionalDocs = (licenceDays = 400): DriverDocument[] => [
  { type: 'dni', number: '30123456', file: FILE, verification: OK },
  { type: 'licencia', number: '30123456', expiresAt: plusDays(licenceDays), file: FILE, verification: OK },
  { type: 'linti', number: 'L1', expiresAt: plusDays(300), file: FILE, verification: OK },
  { type: 'psicofisico', number: 'P1', expiresAt: plusDays(200), file: FILE, verification: OK },
];

describe('reglas de habilitación (unitarias)', () => {
  test('completo → habilitado; vence en ≤30 días → por vencer; vencido → no autorizado', () => {
    const base = { profile: 'profesional' as const, licenseClasses: ['B.1', 'E.1'] };
    assert.equal(computeDriverAuthorization({ ...base, documents: professionalDocs() }).state, 'habilitado');
    assert.equal(computeDriverAuthorization({ ...base, documents: professionalDocs(10) }).state, 'por_vencer');
    const expired = computeDriverAuthorization({ ...base, documents: professionalDocs(-1) });
    assert.equal(expired.state, 'no_autorizado');
    assert.match(expired.reasons[0], /Licencia de conducir vencida/);
  });

  test('falta un obligatorio del perfil o la clase no alcanza → no autorizado', () => {
    const docs = professionalDocs().filter((d) => d.type !== 'linti');
    assert.equal(computeDriverAuthorization({ profile: 'profesional', licenseClasses: ['E.1'], documents: docs }).state, 'no_autorizado');
    const wrongClass = computeDriverAuthorization({ profile: 'profesional', licenseClasses: ['B.1'], documents: professionalDocs() });
    assert.equal(wrongClass.state, 'no_autorizado');
    assert.match(wrongClass.reasons.join(' '), /clase/);
  });

  test('deshabilitado manda sobre todo; el archivo faltante solo advierte', () => {
    const d = { profile: 'profesional' as const, licenseClasses: ['E.1'], documents: professionalDocs(), enabled: false, disabledReason: 'Suspensión' };
    assert.equal(computeDriverAuthorization(d).state, 'deshabilitado');
    const noFile = professionalDocs().map(({ file: _f, ...rest }) => rest);
    const auth = computeDriverAuthorization({ profile: 'profesional', licenseClasses: ['E.1'], documents: noFile });
    assert.equal(auth.state, 'habilitado');
    assert.equal(auth.missingFiles.length, 4);
  });

  test('verificación: sin verificar → pendiente; rechazado → no autorizado; vencido le gana a pendiente', () => {
    const base = { profile: 'profesional' as const, licenseClasses: ['E.1'] };
    const unreviewed = professionalDocs().map((d) => (d.type === 'linti' ? { ...d, verification: undefined } : d));
    const pending = computeDriverAuthorization({ ...base, documents: unreviewed });
    assert.equal(pending.state, 'pendiente');
    assert.deepEqual(pending.pendingVerification, ['linti']);
    const rejected = professionalDocs().map((d) => (d.type === 'psicofisico' ? { ...d, verification: { status: 'rechazado' as const, reason: 'Ilegible' } } : d));
    const no = computeDriverAuthorization({ ...base, documents: rejected });
    assert.equal(no.state, 'no_autorizado');
    assert.match(no.reasons.join(' '), /Apto psicofísico: documento rechazado \(Ilegible\)/);
    const expiredAndPending = professionalDocs(-1).map((d) => ({ ...d, verification: undefined }));
    assert.equal(computeDriverAuthorization({ ...base, documents: expiredAndPending }).state, 'no_autorizado');
    const optionalPending = [...professionalDocs(), { type: 'art' as const, number: 'A1', expiresAt: plusDays(100) }];
    assert.equal(computeDriverAuthorization({ ...base, documents: optionalPending }).state, 'habilitado');
  });

  test('CUIL: dígito verificador y coincidencia con el DNI; edad mínima', () => {
    const valid = cuilFor('30123456');
    assert.equal(cuilProblem(valid, '30123456'), null);
    const wrongDigit = valid.slice(0, 10) + String((Number(valid[10]) + 1) % 10);
    assert.match(cuilProblem(wrongDigit, '30123456') ?? '', /CUIL/);
    assert.match(cuilProblem(valid, '30123457') ?? '', /no coincide/);
    assert.match(cuilProblem(cuilFor('30123456').replace(/^2./, '30'), '30123456') ?? '', /./);
    assert.equal(minimumAge(['B.1']), 17);
    assert.equal(minimumAge(['B.1', 'C.1']), 21);
  });

  test('el barrido genera una sola alerta cuando un chofer asignado pasa a no autorizado', () => {
    const state: any = {
      tenants: [{ id: 't1', name: 'T', branches: ['A'] }],
      vehicles: [{ id: 'v1', tenantId: 't1', unitCode: 'U-1', plate: 'AA1', driverId: 'd1', lat: 0, lng: 0, speedKmh: 0 }],
      drivers: [
        { id: 'd1', tenantId: 't1', branch: 'A', name: 'Pérez, Juan', licenseNumber: '1', phone: '1', status: 'activo', profile: 'profesional', licenseClasses: ['E.1'], documents: professionalDocs(5), lastAuthState: 'por_vencer' },
      ],
      alerts: [],
    };
    const reg = new DriverRegistry(() => ({ state, repo: {} as any, audit: () => {}, persist: () => {} }));
    const in10Days = new Date();
    in10Days.setDate(in10Days.getDate() + 10);
    assert.equal(reg.sweep(in10Days), 1);
    assert.equal(state.alerts[0].ruleName, 'Chofer no autorizado');
    assert.equal(state.alerts[0].vehicleId, 'v1');
    assert.equal(reg.sweep(in10Days), 0, 'no repite la alerta');
  });
});

// ---------------------------------------------------------------- API

const env = new TestEnv();
let norte: string;
let monitoreo: string;
let urbana: string;
let superadmin: string;
let norteVehicles: any[];

/** Valid CUIL for a DNI (tries 20, 23, 24). */
function cuilFor(dni: string) {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (const p of ['20', '23', '24']) {
    const base = p + dni.padStart(8, '0');
    const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
    if (r !== 10) return base + (r === 11 ? 0 : r);
  }
  throw new Error('sin CUIL');
}

let dniSeq = 31_000_000;
function newDriver(extra: Record<string, unknown> = {}) {
  const dni = String(dniSeq++);
  return {
    firstName: 'Ana',
    lastName: `Prueba ${dni.slice(-3)}`,
    dni,
    cuil: cuilFor(dni),
    birthDate: '1985-04-12',
    phone: '+54 264 555 1234',
    branch: 'San Juan Capital',
    profile: 'profesional',
    licenseClasses: ['B.1', 'E.1'],
    documents: [
      { type: 'dni', number: dni },
      { type: 'licencia', number: dni, expiresAt: plusDays(400) },
      { type: 'linti', number: 'LNT-1', expiresAt: plusDays(300) },
      { type: 'psicofisico', number: 'PSI-1', expiresAt: plusDays(200) },
    ],
    ...extra,
  };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

async function upload(token: string, id: string, type: string, body: Buffer, mime: string) {
  const res = await fetch(`${env.baseUrl}/api/drivers/${id}/documents/${type}/file`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime, 'x-file-name': encodeURIComponent('licencia frente.png') },
    body: new Uint8Array(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** Uploads a file for each document and verifies it, like an admin reviewing the driver. */
async function verifyAll(token: string, driver: any) {
  let last = driver;
  for (const doc of driver.documents) {
    await upload(token, driver.id, doc.type, PNG, 'image/png');
    const res = await env.req('POST', `/api/drivers/${driver.id}/documents/${doc.type}/verify`, { token, body: { decision: 'verificado' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    last = res.json.driver;
  }
  return last;
}

async function createVerified(token: string, body: Record<string, unknown>) {
  const res = await env.req('POST', '/api/drivers', { token, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return verifyAll(token, res.json.driver);
}

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    superadmin = await env.token(...DEMO.superadmin);
    norteVehicles = (await env.req('GET', '/api/bootstrap', { token: norte })).json.vehicles;
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('registro de choferes (API)', () => {
  test('solo superadmin y admin de empresa: otros perfiles reciben 403', async () => {
    assert.equal((await env.req('GET', '/api/drivers', { token: monitoreo })).status, 403);
    assert.equal((await env.req('POST', '/api/drivers', { token: monitoreo, body: newDriver() })).status, 403);
    assert.equal((await env.req('GET', '/api/drivers', { token: norte })).status, 200);
    assert.equal((await env.req('GET', '/api/drivers', { token: superadmin })).status, 200);
  });

  test('los choferes existentes se completaron y el bootstrap oculta datos personales a quien no es admin', async () => {
    const page = (await env.req('GET', '/api/drivers?pageSize=50', { token: norte })).json;
    assert.ok(page.total > 0);
    assert.ok(page.items.every((d: any) => d.dni && d.cuil && d.profile && d.documents?.length));
    assert.ok(page.items.every((d: any) => cuilProblem(d.cuil, d.dni) === null), 'CUIL de migración válidos');
    assert.ok(page.items.every((d: any) => d.authorization.state !== 'habilitado'), 'los existentes quedan sin verificar');
    assert.ok(page.counts.pendiente > 0);
    assert.ok(page.items.some((d: any) => d.authorization.state === 'pendiente' && d.assignedVehicle), 'conservan su unidad');
    const alerts = (await env.req('GET', '/api/bootstrap', { token: norte })).json.alerts;
    assert.ok(!alerts.some((a: any) => a.ruleName === 'Chofer no autorizado' && a.summary.includes('verificar')), 'sin alertas por pendiente');
    const bootMon = (await env.req('GET', '/api/bootstrap', { token: monitoreo })).json;
    assert.ok(bootMon.drivers.length > 0);
    assert.ok(bootMon.drivers.every((d: any) => d.dni === undefined && d.documents === undefined));
    const bootAdmin = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.ok(bootAdmin.drivers.some((d: any) => d.dni));
  });

  test('paginación desde el servidor: tamaño, límites, búsqueda sin acentos, filtros y contadores', async () => {
    const p1 = (await env.req('GET', '/api/drivers?page=1&pageSize=10', { token: norte })).json;
    assert.equal(p1.items.length, Math.min(10, p1.total));
    assert.equal(p1.pageSize, 10);
    const c = p1.counts;
    assert.equal(c.total, c.habilitado + c.por_vencer + c.pendiente + c.no_autorizado + c.deshabilitado);
    const big = (await env.req('GET', '/api/drivers?page=999&pageSize=25', { token: norte })).json;
    assert.equal(big.page, Math.max(1, Math.ceil(big.total / 25)), 'página fuera de rango → última');
    assert.equal((await env.req('GET', '/api/drivers?pageSize=7', { token: norte })).json.pageSize, 10, 'tamaño no permitido → 10');

    const created = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ firstName: 'Ñandú', lastName: 'Gómez Ávila' }) })).json.driver;
    const found = (await env.req('GET', `/api/drivers?q=${encodeURIComponent('gomez avila')}`, { token: norte })).json;
    assert.ok(found.items.some((d: any) => d.id === created.id));
    const byDni = (await env.req('GET', `/api/drivers?q=${created.dni}`, { token: norte })).json;
    assert.equal(byDni.items[0].id, created.id);
    const onlyOk = (await env.req('GET', '/api/drivers?state=habilitado&pageSize=50', { token: norte })).json;
    assert.ok(onlyOk.items.every((d: any) => d.authorization.state === 'habilitado'));
    assert.equal(onlyOk.total, onlyOk.counts.habilitado);
  });

  test('aislamiento: cada admin ve solo su empresa; el superadmin elige', async () => {
    const created = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver() })).json.driver;
    assert.equal((await env.req('GET', `/api/drivers/${created.id}`, { token: urbana })).status, 404);
    const urbanaList = (await env.req('GET', '/api/drivers?pageSize=50', { token: urbana })).json;
    assert.ok(urbanaList.items.every((d: any) => d.tenantId !== created.tenantId));
    const all = (await env.req('GET', '/api/drivers?pageSize=50', { token: superadmin, headers: { 'x-tenant-scope': 'all' } })).json;
    const scoped = (await env.req('GET', '/api/drivers?pageSize=50', { token: superadmin, headers: { 'x-tenant-scope': created.tenantId } })).json;
    assert.ok(all.total > scoped.total);
    assert.ok(scoped.items.every((d: any) => d.tenantId === created.tenantId));
    // The superadmin must say which company a new driver belongs to.
    assert.equal((await env.req('POST', '/api/drivers', { token: superadmin, headers: { 'x-tenant-scope': 'all' }, body: newDriver() })).status, 400);
  });

  test('alta: DNI o CUIL duplicados, CUIL que no coincide y edad mínima → 400', async () => {
    const d = newDriver();
    assert.equal((await env.req('POST', '/api/drivers', { token: norte, body: d })).status, 201);
    const dup = await env.req('POST', '/api/drivers', { token: norte, body: { ...newDriver(), dni: d.dni, cuil: d.cuil } });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /DNI/);
    const mismatch = newDriver();
    const bad = await env.req('POST', '/api/drivers', { token: norte, body: { ...mismatch, cuil: cuilFor(String(Number(mismatch.dni) + 1)) } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /no coincide/);
    const young = await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ birthDate: plusDays(-365 * 19) }) });
    assert.equal(young.status, 400);
    assert.match(young.json.error, /edad mínima es 21/);
    const avail = (await env.req('GET', `/api/drivers/availability?dni=${d.dni}`, { token: norte })).json;
    assert.equal(avail.dni, 'en_uso');
  });

  test('edición: vencer la licencia lo deja no autorizado; renovarla pide verificar de nuevo', async () => {
    const created = await createVerified(norte, newDriver());
    assert.equal(created.authorization.state, 'habilitado');
    const docs = created.documents.map(({ file: _f, verification: _v, ...d }: any) => (d.type === 'licencia' ? { ...d, expiresAt: plusDays(-2) } : d));
    const expired = (await env.req('PATCH', `/api/drivers/${created.id}`, { token: norte, body: { documents: docs } })).json.driver;
    assert.equal(expired.authorization.state, 'no_autorizado');
    assert.ok(expired.history.some((h: any) => /Habilitado → No autorizado/.test(h.detail)));
    assert.ok(expired.history.some((h: any) => h.action === 'Vuelve a verificación' && /Licencia \(vencimiento\)/.test(h.detail)));
    const renewed = docs.map((d: any) => (d.type === 'licencia' ? { ...d, expiresAt: plusDays(900) } : d));
    const pending = (await env.req('PATCH', `/api/drivers/${created.id}`, { token: norte, body: { documents: renewed } })).json.driver;
    assert.equal(pending.authorization.state, 'pendiente');
    assert.deepEqual(pending.authorization.pendingVerification, ['licencia']);
    const ok = (await env.req('POST', `/api/drivers/${created.id}/documents/licencia/verify`, { token: norte, body: { decision: 'verificado' } })).json.driver;
    assert.equal(ok.authorization.state, 'habilitado');
    // Untouched documents kept their review; changing licence classes sends the licence back to review.
    const reclass = (await env.req('PATCH', `/api/drivers/${created.id}`, { token: norte, body: { licenseClasses: ['B.1', 'E.1', 'C.2'] } })).json.driver;
    assert.deepEqual(reclass.authorization.pendingVerification, ['licencia']);
  });

  test('asignación: no autorizado no puede tener unidad; deshabilitar libera la unidad; habilitar con vencidos sigue no autorizado', async () => {
    const vehicle = norteVehicles[0];
    // A new driver is pending review, so it cannot get a unit at creation time.
    const early = await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ vehicleId: vehicle.id }) });
    assert.equal(early.status, 400);
    assert.match(early.json.error, /verificar/);
    const verified = await createVerified(norte, newDriver());
    const created = (await env.req('PATCH', `/api/drivers/${verified.id}`, { token: norte, body: { vehicleId: vehicle.id } })).json.driver;
    assert.equal(created.assignedVehicle.id, vehicle.id);

    const noDocs = await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ documents: [], vehicleId: norteVehicles[1].id }) });
    assert.equal(noDocs.status, 400);

    const disabled = await env.req('POST', `/api/drivers/${created.id}/disable`, { token: norte, body: { reason: 'Suspensión' } });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.driver.authorization.state, 'deshabilitado');
    assert.equal(disabled.json.driver.assignedVehicle, undefined);
    assert.ok(disabled.json.notes.some((n: string) => n.includes(vehicle.unitCode)));
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(boot.vehicles.find((v: any) => v.id === vehicle.id).driverId, '');

    assert.equal((await env.req('POST', `/api/drivers/${created.id}/disable`, { token: norte, body: { reason: 'Otro' } })).status, 400);
    const docs = created.documents.map(({ file: _f, ...d }: any) => (d.type === 'linti' ? { ...d, expiresAt: plusDays(-1) } : d));
    await env.req('PATCH', `/api/drivers/${created.id}`, { token: norte, body: { documents: docs } });
    const enabled = await env.req('POST', `/api/drivers/${created.id}/enable`, { token: norte });
    assert.equal(enabled.json.driver.authorization.state, 'no_autorizado');
    assert.match(enabled.json.notes.join(' '), /LiNTI/);
  });

  test('archivos: PNG ok, ejecutable renombrado 415, > 5 MB 413, otra empresa 404', async () => {
    const created = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver() })).json.driver;
    const ok = await upload(norte, created.id, 'licencia', PNG, 'image/png');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const doc = ok.json.driver.documents.find((d: any) => d.type === 'licencia');
    assert.equal(doc.file.mime, 'image/png');
    assert.equal(doc.file.name, 'licencia frente.png');

    const exe = await upload(norte, created.id, 'licencia', Buffer.from('MZ\x90\x00 fake exe'), 'application/pdf');
    assert.equal(exe.status, 415);
    const huge = await upload(norte, created.id, 'linti', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 10)]), 'application/pdf');
    assert.equal(huge.status, 413);

    const mine = await fetch(`${env.baseUrl}/api/drivers/${created.id}/documents/licencia/file`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'image/png');
    assert.equal(mine.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await mine.arrayBuffer()).equals(PNG));
    const other = await fetch(`${env.baseUrl}/api/drivers/${created.id}/documents/licencia/file`, { headers: { Authorization: `Bearer ${urbana}` } });
    assert.equal(other.status, 404);

    const removed = await env.req('DELETE', `/api/drivers/${created.id}/documents/licencia/file`, { token: norte });
    assert.equal(removed.json.driver.documents.find((d: any) => d.type === 'licencia').file, undefined);
  });

  test('alta de vehículo con chofer: autorizado ok, no autorizado u otra empresa 400, sin chofer → «Sin chofer asignado»', async () => {
    const ok = await createVerified(norte, newDriver());
    const bad = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ documents: [] }) })).json.driver;
    const pendingDriver = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver() })).json.driver;
    const foreign = (await env.req('GET', '/api/drivers', { token: urbana })).json.items[0];
    const unit = (n: number, extra: Record<string, unknown>) => ({ unitCode: `CHF-${n}`, plate: `AC${n}11ZZ`, imei: `86130000000${String(n).padStart(4, '0')}`, brand: 'Ford', model: 'Cargo 1723', ...extra });

    const withDriver = await env.req('POST', '/api/vehicles', { token: norte, body: unit(1, { driverId: ok.id }) });
    assert.equal(withDriver.status, 201, JSON.stringify(withDriver.json));
    assert.equal(withDriver.json.vehicle.driverName, ok.name);
    assert.equal((await env.req('POST', '/api/vehicles', { token: norte, body: unit(2, { driverId: bad.id }) })).status, 400);
    assert.equal((await env.req('POST', '/api/vehicles', { token: norte, body: unit(6, { driverId: pendingDriver.id }) })).status, 400, 'pendiente de verificación');
    assert.equal((await env.req('POST', '/api/vehicles', { token: norte, body: unit(3, { driverId: foreign.id }) })).status, 400);
    const without = await env.req('POST', '/api/vehicles', { token: norte, body: unit(4, {}) });
    assert.equal(without.json.vehicle.driverName, 'Sin chofer asignado');
    // Reassigning the same driver to another new unit frees the first one.
    await env.req('POST', '/api/vehicles', { token: norte, body: unit(5, { driverId: ok.id }) });
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    assert.equal(boot.vehicles.find((v: any) => v.id === withDriver.json.vehicle.id).driverId, '');
  });

  test('verificación: alta pendiente, sin archivo 400, rechazo con motivo, reemplazo de archivo vuelve a pendiente, permisos', async () => {
    const created = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver() })).json.driver;
    assert.equal(created.authorization.state, 'pendiente');
    assert.ok(created.documents.every((d: any) => d.verification.status === 'pendiente'));

    const noFile = await env.req('POST', `/api/drivers/${created.id}/documents/licencia/verify`, { token: norte, body: { decision: 'verificado' } });
    assert.equal(noFile.status, 400);
    assert.match(noFile.json.error, /Adjunta el archivo/);
    assert.equal((await env.req('POST', `/api/drivers/${created.id}/documents/licencia/verify`, { token: monitoreo, body: { decision: 'verificado' } })).status, 403);

    const ok = await verifyAll(norte, created);
    assert.equal(ok.authorization.state, 'habilitado');
    const lic = ok.documents.find((d: any) => d.type === 'licencia');
    assert.ok(lic.verification.by, 'guarda quién verificó');
    assert.ok(lic.verification.at);
    assert.ok(ok.history.some((h: any) => h.action === 'Documento verificado'));

    assert.equal((await env.req('POST', `/api/drivers/${created.id}/documents/psicofisico/verify`, { token: norte, body: { decision: 'rechazado' } })).status, 400);
    const rejected = (await env.req('POST', `/api/drivers/${created.id}/documents/psicofisico/verify`, { token: norte, body: { decision: 'rechazado', reason: 'Ilegible' } })).json.driver;
    assert.equal(rejected.authorization.state, 'no_autorizado');
    assert.match(rejected.authorization.reasons.join(' '), /Apto psicofísico: documento rechazado \(Ilegible\)/);

    const reupload = await upload(norte, created.id, 'psicofisico', PNG, 'image/png');
    assert.equal(reupload.json.driver.authorization.state, 'pendiente');
    assert.ok(reupload.json.driver.history.some((h: any) => /Vuelve a quedar pendiente de verificación/.test(h.detail)));

    const list = (await env.req('GET', '/api/drivers?state=pendiente&pageSize=50', { token: norte })).json;
    assert.ok(list.items.every((d: any) => d.authorization.state === 'pendiente'));
    assert.equal(list.total, list.counts.pendiente);
  });

  test('persistencia: choferes y archivos sobreviven a un reinicio', async () => {
    const created = (await env.req('POST', '/api/drivers', { token: norte, body: newDriver({ employeeNumber: 'L-PERSIST' }) })).json.driver;
    await upload(norte, created.id, 'dni', PNG, 'image/png');
    await env.restartApp();
    norte = await env.token(...DEMO.norte);
    const again = (await env.req('GET', `/api/drivers/${created.id}`, { token: norte })).json;
    assert.equal(again.employeeNumber, 'L-PERSIST');
    assert.equal(again.history.length >= 2, true);
    const file = await fetch(`${env.baseUrl}/api/drivers/${created.id}/documents/dni/file`, { headers: { Authorization: `Bearer ${norte}` } });
    assert.equal(file.status, 200);
  });
});
