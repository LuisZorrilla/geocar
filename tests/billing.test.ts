import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { DEMO, TestEnv } from './helpers/harness.ts';
import { fiscalQrUrl, invoiceAmounts, invoiceLetter, invoiceNumber, receiverCondition, receiverDoc } from '../src/shared/billing.ts';
import { ArcaClient, ArcaError, buildTra, generateCsr, inspectCertificate, openSecret, sealSecret, signTra, tag } from '../server/billing/arca.ts';

// ---------------------------------------------------------------- helpers

/** Certificate for the CSR's public key, signed by a throwaway CA (plays the role of ARCA). */
function certifyCsr(csrPem: string, days = 365): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  const ca = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey!;
  cert.serialNumber = '0a';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer([{ name: 'commonName', value: 'Computadores Test' }]);
  cert.sign(ca.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const soap = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const ticketXml = (exp = new Date(Date.now() + 12 * 3600_000)) =>
  `<?xml version="1.0"?><loginTicketResponse><header><expirationTime>${exp.toISOString()}</expirationTime></header><credentials><token>TOKEN-1</token><sign>SIGN-1</sign></credentials></loginTicketResponse>`;
const caeOk = (cae: string, obs = '') =>
  soap(`<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>A</Resultado>${obs}<CAE>${cae}</CAE><CAEFchVto>20261203</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`);
const lastOk = (n: number) => soap(`<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult><PtoVta>3</PtoVta><CbteTipo>1</CbteTipo><CbteNro>${n}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`);

type Call = { url: string; action: string; body: string };
function fakeFetch(handler: (c: Call) => { status?: number; body: string } | Promise<never>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const c = { url, action: init.headers.SOAPAction, body: init.body };
    calls.push(c);
    const r = await handler(c);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.body };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------- unit

describe('T5: reglas de facturación electrónica', () => {
  test('letra según emisor y receptor; documento del receptor', () => {
    assert.equal(receiverCondition('IVA Responsable Inscripto'), 'responsable_inscripto');
    assert.equal(receiverCondition('Monotributista'), 'monotributo');
    assert.equal(receiverCondition(undefined), 'consumidor_final');
    assert.equal(invoiceLetter('responsable_inscripto', 'responsable_inscripto'), 'A');
    assert.equal(invoiceLetter('responsable_inscripto', 'monotributo'), 'B');
    assert.equal(invoiceLetter('responsable_inscripto', 'consumidor_final'), 'B');
    assert.equal(invoiceLetter('monotributo', 'responsable_inscripto'), 'C');
    assert.deepEqual(receiverDoc('30-71444333-5'), { docTipo: 80, docNro: '30714443335' });
    assert.deepEqual(receiverDoc('35.666.777'), { docTipo: 96, docNro: '35666777' });
    assert.deepEqual(receiverDoc(''), { docTipo: 99, docNro: '0' });
  });

  test('importes: A y B suman IVA sobre el neto, C no discrimina', () => {
    assert.deepEqual(invoiceAmounts(130000, 'A', 21), { net: 130000, iva: 27300, total: 157300 });
    assert.deepEqual(invoiceAmounts(1000.555, 'B', 10.5), { net: 1000.56, iva: 105.06, total: 1105.62 });
    assert.deepEqual(invoiceAmounts(5000, 'C', 21), { net: 5000, iva: 0, total: 5000 });
    assert.equal(invoiceNumber(3, 42), '00003-00000042');
  });

  test('QR fiscal: URL de ARCA con los datos del comprobante en base64', () => {
    const url = fiscalQrUrl({ date: '2026-11-23', pointOfSale: 3, cbteTipo: 1, number: 42, total: 157300, receiver: { name: 'X', docTipo: 80, docNro: '30714443335', ivaConditionId: 1, ivaConditionLabel: '' }, cae: '75123456789012' }, '30-71234567-1');
    assert.match(url, /^https:\/\/www\.afip\.gob\.ar\/fe\/qr\/\?p=/);
    const data = JSON.parse(Buffer.from(url.split('p=')[1], 'base64').toString());
    assert.deepEqual(data, { ver: 1, fecha: '2026-11-23', cuit: 30712345671, ptoVta: 3, tipoCmp: 1, nroCmp: 42, importe: 157300, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 30714443335, tipoCodAut: 'E', codAut: 75123456789012 });
  });

  test('certificado: CSR con el CUIT, certificado que corresponde a la clave y firma del TRA', () => {
    const { keyPem, csrPem } = generateCsr({ cuit: '30712345671', businessName: 'Transportes Test SA', alias: 'geocar' });
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    assert.ok(csr.verify());
    assert.equal(csr.subject.getField({ name: 'serialNumber' })?.value ?? csr.subject.attributes.find((a) => a.type === '2.5.4.5')?.value, 'CUIT 30712345671');
    const certPem = certifyCsr(csrPem);
    const info = inspectCertificate(certPem, keyPem);
    assert.equal(info.matchesKey, true);
    assert.equal(inspectCertificate(certPem, generateCsr({ cuit: '30712345671', businessName: 'Otra' }).keyPem).matchesKey, false);

    const tra = buildTra('wsfe');
    assert.equal(tag(tra, 'service'), 'wsfe');
    const cms = signTra(tra, certPem, keyPem);
    const der = forge.util.decode64(cms);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as forge.pkcs7.PkcsSignedData;
    assert.equal(p7.certificates.length, 1, 'incluye el certificado');
    assert.ok(der.includes('<service>wsfe</service>'), 'el TRA va embebido en el CMS');
  });

  test('secretos: cifrados con SECRETS_KEY y legibles solo con la misma clave', () => {
    const prev = process.env.SECRETS_KEY;
    try {
      delete process.env.SECRETS_KEY;
      assert.deepEqual(sealSecret('abc'), { v: 1, enc: false, data: 'abc' });
      process.env.SECRETS_KEY = 'a'.repeat(64);
      const s = sealSecret('-----BEGIN PRIVATE KEY-----');
      assert.equal(s.enc, true);
      assert.ok(!s.data.includes('PRIVATE'));
      assert.equal(openSecret(s), '-----BEGIN PRIVATE KEY-----');
      process.env.SECRETS_KEY = 'b'.repeat(64);
      assert.throws(() => openSecret(s));
    } finally {
      if (prev === undefined) delete process.env.SECRETS_KEY;
      else process.env.SECRETS_KEY = prev;
    }
  });
});

describe('T5: cliente SOAP de ARCA (con respuestas simuladas)', () => {
  const ta = { token: 'T', sign: 'S', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const cae = {
    pointOfSale: 3, cbteTipo: 1, number: 42, date: '20261123', docTipo: 80, docNro: '30714443335', receiverIvaId: 1,
    net: 130000, iva: 27300, total: 157300, ivaId: 5, serviceFrom: '20261101', serviceTo: '20261123', dueDate: '20261223',
  };

  test('login: firma el TRA y lee el ticket escapado', async () => {
    const { keyPem, csrPem } = generateCsr({ cuit: '30712345671', businessName: 'Test' });
    const f = fakeFetch(() => ({ body: soap(`<loginCmsResponse><loginCmsReturn>${xmlEsc(ticketXml())}</loginCmsReturn></loginCmsResponse>`) }));
    const t = await new ArcaClient('homologacion', f.fn).login('wsfe', certifyCsr(csrPem), keyPem);
    assert.equal(t.token, 'TOKEN-1');
    assert.equal(t.sign, 'SIGN-1');
    assert.match(f.calls[0].url, /wsaahomo\.afip\.gov\.ar/);
    assert.match(f.calls[0].body, /<wsaa:in0>[A-Za-z0-9+/=]{200,}<\/wsaa:in0>/);
  });

  test('último número y CAE: arma el pedido con IVA, condición del receptor y lee la respuesta', async () => {
    const f = fakeFetch((c) => ({ body: c.action.endsWith('FECompUltimoAutorizado') ? lastOk(41) : caeOk('75123456789012', '<Observaciones><Obs><Code>10217</Code><Msg>Aviso &amp; nota</Msg></Obs></Observaciones>') }));
    const client = new ArcaClient('homologacion', f.fn);
    assert.equal(await client.lastNumber(ta, '30-71234567-1', 3, 1), 41);
    const r = await client.requestCae(ta, '30712345671', cae);
    assert.deepEqual(r, { cae: '75123456789012', caeDue: '2026-12-03', observations: ['10217: Aviso & nota'] });
    const body = f.calls[1].body;
    for (const frag of ['<ar:Cuit>30712345671</ar:Cuit>', '<ar:CbteTipo>1</ar:CbteTipo>', '<ar:Concepto>2</ar:Concepto>', '<ar:ImpTotal>157300.00</ar:ImpTotal>', '<ar:ImpIVA>27300.00</ar:ImpIVA>', '<ar:CondicionIVAReceptorId>1</ar:CondicionIVAReceptorId>', '<ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>130000.00</ar:BaseImp>'])
      assert.ok(body.includes(frag), frag);
    assert.match(f.calls[1].url, /wswhomo\.afip\.gov\.ar\/wsfev1/);
  });

  test('nota de crédito: informa el comprobante asociado; factura C sin bloque de IVA', async () => {
    const f = fakeFetch(() => ({ body: caeOk('1') }));
    const client = new ArcaClient('produccion', f.fn);
    await client.requestCae(ta, '30712345671', { ...cae, cbteTipo: 3, associated: { cbteTipo: 1, pointOfSale: 3, number: 42, cuit: '30712345671', date: '20261123' } });
    assert.match(f.calls[0].body, /<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>1<\/ar:Tipo><ar:PtoVta>3<\/ar:PtoVta><ar:Nro>42<\/ar:Nro>/);
    assert.match(f.calls[0].url, /servicios1\.afip\.gov\.ar/);
    await client.requestCae(ta, '30712345671', { ...cae, cbteTipo: 11, iva: 0, total: 130000, ivaId: undefined });
    assert.ok(!f.calls[1].body.includes('<ar:Iva>'));
  });

  test('rechazos: errores de ARCA, SOAP fault, HTTP y tiempo agotado', async () => {
    const rejected = soap('<FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><Observaciones><Obs><Code>10242</Code><Msg>Falta CondicionIVAReceptorId</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp><Errors><Err><Code>600</Code><Msg>ValidacionDeToken</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse>');
    await assert.rejects(new ArcaClient('homologacion', fakeFetch(() => ({ body: rejected })).fn).requestCae(ta, '30712345671', cae), (e: unknown) => {
      assert.ok(e instanceof ArcaError);
      assert.deepEqual(e.details, ['600: ValidacionDeToken', '10242: Falta CondicionIVAReceptorId']);
      return true;
    });
    await assert.rejects(new ArcaClient('homologacion', fakeFetch(() => ({ status: 500, body: soap('<soap:Fault><faultstring>El CEE ya posee un TA valido</faultstring></soap:Fault>') })).fn).dummy(), /El CEE ya posee un TA valido/);
    await assert.rejects(new ArcaClient('homologacion', fakeFetch(() => ({ status: 503, body: 'down' })).fn).dummy(), /respondió 503/);
    const hang = (_u: string, init: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await assert.rejects(new ArcaClient('homologacion', hang as never, 50).dummy(), /no respondió a tiempo/);
  });
});

// ---------------------------------------------------------------- API

/** Fake ARCA homologación: WSAA + WSFE over plain HTTP, recording what it receives. */
function startFakeArca() {
  const received: Call[] = [];
  let last = 41;
  let rejectNext = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const action = String(req.headers.soapaction ?? '');
      received.push({ url: req.url ?? '', action, body });
      res.setHeader('Content-Type', 'text/xml');
      if (req.url === '/wsaa') return res.end(soap(`<loginCmsResponse><loginCmsReturn>${xmlEsc(ticketXml())}</loginCmsReturn></loginCmsResponse>`));
      if (action.endsWith('FEDummy')) return res.end(soap('<FEDummyResponse><FEDummyResult><AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer></FEDummyResult></FEDummyResponse>'));
      if (action.endsWith('FECompUltimoAutorizado')) return res.end(lastOk(last));
      if (action.endsWith('FECAESolicitar')) {
        if (rejectNext) {
          rejectNext = false;
          return res.end(soap('<FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>El numero no es el proximo</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>'));
        }
        last += 1;
        return res.end(caeOk(`7512345678${String(last).padStart(4, '0')}`));
      }
      res.statusCode = 404;
      res.end('');
    });
  });
  return {
    received,
    rejectOnce: () => (rejectNext = true),
    listen: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const arca = startFakeArca();
let env: TestEnv;
let norte = '';
let monitoreo = '';
let urbana = '';
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f0b50000000049454e44ae426082', 'hex');

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


function companyCuit(body8: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const base = `30${body8}`;
  const r = 11 - (w.reduce((a, x, i) => a + x * Number(base[i]), 0) % 11);
  return r === 10 ? companyCuit(String(Number(body8) + 1)) : `${base}${r === 11 ? 0 : r}`;
}

describe('T5: API de facturación electrónica', () => {
  let customer: any;
  let preInvoiceId = '';
  let simulated: any;

  before(async () => {
    const base = await arca.listen();
    env = new TestEnv({ ARCA_TEST_BASE: base });
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    customer = (await env.req('POST', '/api/tms/customers', { token: norte, body: { name: 'Cliente Factura SA', taxId: companyCuit('71555444'), taxCondition: 'IVA Responsable Inscripto' } })).json.customer;
    const places = await Promise.all(
      ['A', 'B'].map(async (n, i) => (await env.req('POST', '/api/tms/places', { token: norte, body: { name: `Lugar F${n}`, kind: 'deposito', address: n, lat: -31.6 - i / 10, lng: -68.4 } })).json.place)
    );
    // A delivered order with a price: completed through the order lifecycle shortcut used by T3.
    const order = (await env.req('POST', '/api/tms/orders', { token: norte, body: { customerId: customer.id, originPlaceId: places[0].id, destinationPlaceId: places[1].id, cargo: { description: 'Cajas', weightKg: 100 }, confirm: true } })).json.order;
    const boot = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
    const critical = new Set(boot.workOrders.filter((w: any) => w.priority === 'critica' && !['completada', 'cancelada'].includes(w.status)).map((w: any) => w.vehicleId));
    const vehicle = boot.vehicles.find((v: any) => v.assetType === 'vehiculo' && !critical.has(v.id));
    const driver = await authorizedDriver(norte, '36777888');
    const trip = await env.req('POST', '/api/tms/trips', { token: norte, body: { vehicleId: vehicle.id, driverId: driver.id, plannedStart: new Date(Date.now() + 3600_000).toISOString(), orderIds: [order.id], acceptWarnings: { reason: 'prueba de facturación' } } });
    assert.equal(trip.status, 201, JSON.stringify(trip.json));
    await env.req('POST', `/api/tms/trips/${trip.json.trip.id}/start`, { token: norte, body: { reason: 'prueba' } });
    for (const s of trip.json.trip.stops) {
      const r = await env.req('POST', `/api/tms/trips/${trip.json.trip.id}/stops/${s.id}`, { token: norte, body: { status: 'completada' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const charge = await env.req('POST', `/api/costs/orders/${order.id}/charge`, { token: norte, body: { amount: 100000, reason: 'Precio acordado' } });
    assert.equal(charge.status, 200, JSON.stringify(charge.json));
    const pf = await env.req('POST', '/api/costs/pre-invoices', { token: norte, body: { customerId: customer.id, from: today(), to: today() } });
    assert.equal(pf.status, 201, JSON.stringify(pf.json));
    preInvoiceId = pf.json.preInvoice.id;
  });
  after(async () => {
    await env.close();
    await arca.close();
  });

  test('configuración: solo administradores; sin datos completos no se factura', async () => {
    assert.equal((await env.req('GET', '/api/billing/arca-config', { token: monitoreo })).status, 403);
    const cfg = await env.req('GET', '/api/billing/arca-config', { token: norte });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.config.hasCertificate, false);
    assert.equal(cfg.json.config.environment, 'homologacion');
    assert.ok(!JSON.stringify(cfg.json).includes('PRIVATE'));

    assert.equal((await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte })).status, 409, 'borrador: primero se emite');
    assert.equal((await env.req('POST', `/api/costs/pre-invoices/${preInvoiceId}/issue`, { token: norte })).status, 200);
    const missing = await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte });
    assert.equal(missing.status, 409);
    assert.match(missing.json.error, /domicilio comercial/);

    assert.equal((await env.req('PUT', '/api/billing/arca-config', { token: norte, body: { cuit: '123' } })).status, 400);
    const saved = await env.req('PUT', '/api/billing/arca-config', {
      token: norte,
      body: { cuit: '30-71234567-1', businessName: 'Transportes del Norte SA', address: 'Ruta 40 km 3, San Juan', activityStart: '2015-03-01', pointOfSale: 3, ivaCondition: 'responsable_inscripto', ivaRate: 21, paymentDays: 30 },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.config.cuit, '30712345671');
    assert.equal((await env.req('POST', '/api/billing/arca-config/test', { token: norte })).json.mode, 'simulado');
  });

  test('modo simulado: factura A con IVA, sin doble factura, PDF con QR, nota de crédito y aislamiento', async () => {
    const r = await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    simulated = r.json.invoice;
    assert.equal(simulated.status, 'simulada');
    assert.equal(simulated.letter, 'A');
    assert.equal(simulated.cbteTipo, 1);
    assert.equal(simulated.number, 1);
    assert.deepEqual([simulated.net, simulated.iva, simulated.total], [100000, 21000, 121000]);
    assert.match(simulated.cae, /^7\d{13}$/);
    assert.equal(simulated.receiver.docTipo, 80);
    assert.equal(arca.received.length, 0, 'el modo simulado no llama a ARCA');

    assert.equal((await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte })).status, 409, 'no factura dos veces');
    assert.equal((await env.req('POST', `/api/costs/pre-invoices/${preInvoiceId}/void`, { token: norte, body: { reason: 'x' } })).status, 409, 'no se anula una pre-factura facturada');

    const pdf = await fetch(`${env.baseUrl}/api/billing/invoices/${simulated.id}/pdf`, { headers: { Authorization: `Bearer ${monitoreo}` } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(`${env.baseUrl}/api/billing/invoices/${simulated.id}/pdf`, { headers: { Authorization: `Bearer ${urbana}` } })).status, 404);
    assert.equal((await env.req('GET', '/api/billing/invoices', { token: urbana })).json.items.length, 0);
    assert.equal((await env.req('GET', '/api/billing/invoices', { token: norte })).json.items[0].customerName, 'Cliente Factura SA');

    assert.equal((await env.req('POST', `/api/billing/invoices/${simulated.id}/credit-note`, { token: monitoreo, body: { reason: 'x' } })).status, 403);
    const nc = await env.req('POST', `/api/billing/invoices/${simulated.id}/credit-note`, { token: norte, body: { reason: 'Error en el importe' } });
    assert.equal(nc.status, 201, JSON.stringify(nc.json));
    assert.equal(nc.json.invoice.kind, 'nota_credito');
    assert.equal(nc.json.invoice.cbteTipo, 3);
    assert.equal(nc.json.invoice.associatedId, simulated.id);
    assert.equal((await env.req('POST', `/api/billing/invoices/${simulated.id}/credit-note`, { token: norte, body: { reason: 'otra' } })).status, 409);
    const pfs = (await env.req('GET', '/api/costs/pre-invoices', { token: norte })).json.items;
    assert.equal(pfs.find((p: any) => p.id === preInvoiceId).invoiceId, undefined, 'la pre-factura queda libre');
  });

  test('homologación: CSR, certificado, prueba de conexión y CAE real del servidor de ARCA', async () => {
    const csr = await env.req('POST', '/api/billing/arca-config/csr', { token: norte });
    assert.equal(csr.status, 200);
    assert.match(csr.json.csrPem, /BEGIN CERTIFICATE REQUEST/);
    assert.ok(!JSON.stringify(csr.json).includes('PRIVATE KEY'));
    assert.equal((await env.req('GET', '/api/billing/arca-config', { token: norte })).json.config.csrPending, true);

    const other = certifyCsr(generateCsr({ cuit: '30712345671', businessName: 'Otra' }).csrPem);
    const wrong = await env.req('POST', '/api/billing/arca-config/certificate', { token: norte, body: { certPem: other } });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /no corresponde a la clave/);
    const ok = await env.req('POST', '/api/billing/arca-config/certificate', { token: norte, body: { certPem: certifyCsr(csr.json.csrPem) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.config.hasCertificate, true);
    assert.match(ok.json.config.certSubject, /CUIT 30712345671/);

    const t = await env.req('POST', '/api/billing/arca-config/test', { token: norte });
    assert.equal(t.json.ok, true, JSON.stringify(t.json));
    assert.deepEqual(t.json.last, { 'Factura A': 41, 'Factura B': 41 });
    assert.equal(arca.received.filter((c) => c.url === '/wsaa').length, 1);

    // A simulated invoice can't be cancelled against the real ARCA.
    assert.equal((await env.req('POST', `/api/billing/invoices/${simulated.id}/credit-note`, { token: norte, body: { reason: 'x' } })).status, 409);

    // ARCA rejects → 502 with its message; nothing is stored.
    arca.rejectOnce();
    const rej = await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte });
    assert.equal(rej.status, 502);
    assert.match(rej.json.error, /10016/);

    const r = await env.req('POST', `/api/billing/pre-invoices/${preInvoiceId}/invoice`, { token: norte });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.invoice.status, 'emitida');
    assert.equal(r.json.invoice.environment, 'homologacion');
    assert.equal(r.json.invoice.number, 42, 'último autorizado + 1');
    assert.equal(r.json.invoice.cae, '75123456780042');
    assert.equal(r.json.invoice.caeDue, '2026-12-03');
    const req = arca.received.filter((c) => c.action.endsWith('FECAESolicitar')).at(-1)!.body;
    assert.ok(req.includes('<ar:Token>TOKEN-1</ar:Token>'), 'reusa el ticket de WSAA');
    assert.ok(req.includes('<ar:CbteDesde>42</ar:CbteDesde>'));
    assert.ok(req.includes('<ar:ImpTotal>121000.00</ar:ImpTotal>'));
    assert.equal(arca.received.filter((c) => c.url === '/wsaa').length, 1, 'un solo login');

    const nc = await env.req('POST', `/api/billing/invoices/${r.json.invoice.id}/credit-note`, { token: norte, body: { reason: 'Devolución' } });
    assert.equal(nc.status, 201, JSON.stringify(nc.json));
    assert.equal(nc.json.invoice.status, 'emitida');
    assert.match(arca.received.at(-1)!.body, /<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>1<\/ar:Tipo><ar:PtoVta>3<\/ar:PtoVta><ar:Nro>42<\/ar:Nro>/);

    const removed = await env.req('DELETE', '/api/billing/arca-config/certificate', { token: norte });
    assert.equal(removed.json.config.hasCertificate, false);
  });
});
