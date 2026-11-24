import crypto from 'crypto';
import forge from 'node-forge';
import type { ArcaEnvironment } from '../../src/shared/billing.ts';

/**
 * ARCA (ex AFIP) web services: WSAA (authentication ticket signed with the company certificate)
 * and WSFEv1 (electronic invoices). SOAP over HTTPS, without external SOAP libraries: requests are
 * small and fixed, and responses are read with a namespace-agnostic tag reader.
 */

export const ARCA_URLS: Record<ArcaEnvironment, { wsaa: string; wsfe: string }> = {
  homologacion: { wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx' },
  produccion: { wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' },
};

export class ArcaError extends Error {
  constructor(
    message: string,
    readonly details: string[] = []
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inner text of the first <prefix:name> / <name> element. */
export function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1].trim() : null;
}
/** Inner text of every <name> element. */
export function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g'))].map((m) => m[1].trim());
}

// ---------------------------------------------------------------- keys, CSR, certificate

/** New RSA 2048 key and the CSR to upload to ARCA ("Administración de certificados digitales"). */
export function generateCsr(input: { cuit: string; businessName: string; alias?: string }): { keyPem: string; csrPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: input.businessName.slice(0, 60) },
    { name: 'commonName', value: (input.alias ?? 'geocar').slice(0, 60) },
    { type: '2.5.4.5', value: `CUIT ${input.cuit.replace(/\D/g, '')}`, valueTagClass: forge.asn1.Type.PRINTABLESTRING } as unknown as forge.pki.CertificateField,
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), csrPem: forge.pki.certificationRequestToPem(csr) };
}

/** Certificate info, and whether it belongs to the private key (same public modulus). */
export function inspectCertificate(certPem: string, keyPem: string): { subject: string; notAfter: string; matchesKey: boolean } {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  return {
    subject: cert.subject.attributes.map((a) => `${a.shortName ?? a.name ?? a.type}=${a.value}`).join(', '),
    notAfter: cert.validity.notAfter.toISOString(),
    matchesKey: pub.n.equals(key.n),
  };
}

// ---------------------------------------------------------------- WSAA

export interface AccessTicket {
  token: string;
  sign: string;
  expiresAt: string;
}

/** TRA (login ticket request) for a service, valid ±10 minutes. */
export function buildTra(service: string, now = new Date()): string {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId><generationTime>${iso(new Date(now.getTime() - 10 * 60_000))}</generationTime><expirationTime>${iso(new Date(now.getTime() + 10 * 60_000))}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
}

/** CMS (PKCS#7 SignedData, content included) of the TRA, base64 — what WSAA's loginCms expects. */
export function signTra(tra: string, certPem: string, keyPem: string): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  const cert = forge.pki.certificateFromPem(certPem);
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

export class ArcaClient {
  constructor(
    private readonly env: ArcaEnvironment,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly timeoutMs = 20_000
  ) {}

  /** Tests point homologación to a local fake ARCA (never production, never outside NODE_ENV=test). */
  private get urls() {
    const base = process.env.NODE_ENV === 'test' ? process.env.ARCA_TEST_BASE : undefined;
    return this.env === 'homologacion' && base ? { wsaa: `${base}/wsaa`, wsfe: `${base}/wsfe` } : ARCA_URLS[this.env];
  }

  private async soap(url: string, action: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      const fault = tag(text, 'faultstring');
      if (fault) throw new ArcaError(`ARCA: ${decode(fault)}`);
      if (!res.ok) throw new ArcaError(`ARCA respondió ${res.status}.`);
      return text;
    } catch (err) {
      if (err instanceof ArcaError) throw err;
      throw new ArcaError((err as { name?: string })?.name === 'AbortError' ? 'ARCA no respondió a tiempo.' : 'No se pudo conectar con ARCA.');
    } finally {
      clearTimeout(timer);
    }
  }

  /** WSAA login: access ticket (token + sign) for the service, valid ~12 h. */
  async login(service: string, certPem: string, keyPem: string): Promise<AccessTicket> {
    const cms = signTra(buildTra(service), certPem, keyPem);
    const xml = await this.soap(
      this.urls.wsaa,
      '',
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`
    );
    const ret = tag(xml, 'loginCmsReturn');
    if (!ret) throw new ArcaError('Respuesta de WSAA sin ticket.');
    const ta = decode(ret);
    const token = tag(ta, 'token');
    const sign = tag(ta, 'sign');
    const expiresAt = tag(ta, 'expirationTime');
    if (!token || !sign || !expiresAt) throw new ArcaError('Ticket de acceso incompleto.');
    return { token, sign, expiresAt: new Date(expiresAt).toISOString() };
  }

  private auth(ta: AccessTicket, cuit: string) {
    return `<ar:Auth><ar:Token>${esc(ta.token)}</ar:Token><ar:Sign>${esc(ta.sign)}</ar:Sign><ar:Cuit>${cuit.replace(/\D/g, '')}</ar:Cuit></ar:Auth>`;
  }
  private envelope(inner: string) {
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Header/><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
  }
  private errors(xml: string): string[] {
    const errs = tag(xml, 'Errors');
    return errs ? tags(errs, 'Err').map((e) => `${tag(e, 'Code')}: ${decode(tag(e, 'Msg') ?? '')}`) : [];
  }

  /** Health of the WSFE servers (no authentication). */
  async dummy(): Promise<{ app: string; db: string; auth: string }> {
    const xml = await this.soap(this.urls.wsfe, 'http://ar.gov.afip.dif.FEV1/FEDummy', this.envelope('<ar:FEDummy/>'));
    return { app: tag(xml, 'AppServer') ?? '?', db: tag(xml, 'DbServer') ?? '?', auth: tag(xml, 'AuthServer') ?? '?' };
  }

  async lastNumber(ta: AccessTicket, cuit: string, pointOfSale: number, cbteTipo: number): Promise<number> {
    const xml = await this.soap(
      this.urls.wsfe,
      'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado',
      this.envelope(`<ar:FECompUltimoAutorizado>${this.auth(ta, cuit)}<ar:PtoVta>${pointOfSale}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FECompUltimoAutorizado>`)
    );
    const errs = this.errors(xml);
    if (errs.length) throw new ArcaError('ARCA rechazó la consulta del último comprobante.', errs);
    return Number(tag(xml, 'CbteNro') ?? 0);
  }

  /** Requests the CAE of one voucher. Throws with ARCA's messages when rejected. */
  async requestCae(
    ta: AccessTicket,
    cuit: string,
    v: {
      pointOfSale: number;
      cbteTipo: number;
      number: number;
      date: string; // YYYYMMDD
      docTipo: number;
      docNro: string;
      receiverIvaId: number;
      net: number;
      iva: number;
      total: number;
      ivaId?: number;
      serviceFrom: string;
      serviceTo: string;
      dueDate: string;
      associated?: { cbteTipo: number; pointOfSale: number; number: number; cuit: string; date: string };
    }
  ): Promise<{ cae: string; caeDue: string; observations: string[] }> {
    const money = (n: number) => n.toFixed(2);
    const ivaBlock = v.ivaId ? `<ar:Iva><ar:AlicIva><ar:Id>${v.ivaId}</ar:Id><ar:BaseImp>${money(v.net)}</ar:BaseImp><ar:Importe>${money(v.iva)}</ar:Importe></ar:AlicIva></ar:Iva>` : '';
    const assoc = v.associated
      ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${v.associated.cbteTipo}</ar:Tipo><ar:PtoVta>${v.associated.pointOfSale}</ar:PtoVta><ar:Nro>${v.associated.number}</ar:Nro><ar:Cuit>${v.associated.cuit.replace(/\D/g, '')}</ar:Cuit><ar:CbteFch>${v.associated.date}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>`
      : '';
    const det = `<ar:FECAEDetRequest><ar:Concepto>2</ar:Concepto><ar:DocTipo>${v.docTipo}</ar:DocTipo><ar:DocNro>${v.docNro}</ar:DocNro><ar:CbteDesde>${v.number}</ar:CbteDesde><ar:CbteHasta>${v.number}</ar:CbteHasta><ar:CbteFch>${v.date}</ar:CbteFch><ar:ImpTotal>${money(v.total)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${money(v.net)}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${money(v.iva)}</ar:ImpIVA><ar:FchServDesde>${v.serviceFrom}</ar:FchServDesde><ar:FchServHasta>${v.serviceTo}</ar:FchServHasta><ar:FchVtoPago>${v.dueDate}</ar:FchVtoPago><ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${v.receiverIvaId}</ar:CondicionIVAReceptorId>${assoc}${ivaBlock}</ar:FECAEDetRequest>`;
    const xml = await this.soap(
      this.urls.wsfe,
      'http://ar.gov.afip.dif.FEV1/FECAESolicitar',
      this.envelope(
        `<ar:FECAESolicitar>${this.auth(ta, cuit)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${v.pointOfSale}</ar:PtoVta><ar:CbteTipo>${v.cbteTipo}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq>${det}</ar:FeDetReq></ar:FeCAEReq></ar:FECAESolicitar>`
      )
    );
    const detResp = tag(xml, 'FECAEDetResponse') ?? '';
    const obsBlock = tag(detResp, 'Observaciones');
    const observations = obsBlock ? tags(obsBlock, 'Obs').map((o) => `${tag(o, 'Code')}: ${decode(tag(o, 'Msg') ?? '')}`) : [];
    const result = tag(detResp, 'Resultado');
    const errs = this.errors(xml);
    if (result !== 'A') throw new ArcaError('ARCA rechazó el comprobante.', [...errs, ...observations]);
    const cae = tag(detResp, 'CAE');
    const due = tag(detResp, 'CAEFchVto');
    if (!cae || !due) throw new ArcaError('ARCA aprobó sin informar el CAE.', errs);
    return { cae, caeDue: `${due.slice(0, 4)}-${due.slice(4, 6)}-${due.slice(6, 8)}`, observations };
  }
}

// ---------------------------------------------------------------- secrets at rest

/** AES-256-GCM with SECRETS_KEY (64 hex chars); without it secrets are stored as is. */
export function sealSecret(plain: string): { v: 1; enc: boolean; data: string } {
  const keyHex = process.env.SECRETS_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return { v: 1, enc: false, data: plain };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const out = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { v: 1, enc: true, data: Buffer.concat([iv, cipher.getAuthTag(), out]).toString('base64') };
}

export function openSecret(sealed: { enc: boolean; data: string }): string {
  if (!sealed.enc) return sealed.data;
  const keyHex = process.env.SECRETS_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new ArcaError('Los datos de ARCA están cifrados y falta SECRETS_KEY en el servidor.');
  const raw = Buffer.from(sealed.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
