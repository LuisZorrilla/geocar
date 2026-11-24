/**
 * TMS T5: electronic invoices with ARCA (ex AFIP) — WSAA + WSFEv1.
 * Pure types and rules; the SOAP client lives in server/billing/arca.ts.
 */

export type ArcaEnvironment = 'homologacion' | 'produccion';
export type IvaCondition = 'responsable_inscripto' | 'monotributo' | 'exento';
export type InvoiceLetter = 'A' | 'B' | 'C';
export type InvoiceKind = 'factura' | 'nota_credito';

/** Non-secret ARCA settings of a company (the certificate and key are stored apart, never sent to the browser). */
export interface ArcaConfig {
  environment: ArcaEnvironment;
  cuit: string;
  pointOfSale: number;
  ivaCondition: IvaCondition;
  /** VAT rate applied to the freight (21 % by default). */
  ivaRate: 21 | 10.5 | 27;
  businessName: string;
  address: string;
  iibb: string;
  /** YYYY-MM-DD. */
  activityStart: string;
  /** Days to pay (FchVtoPago of services). */
  paymentDays: number;
  hasCertificate: boolean;
  certSubject?: string;
  certNotAfter?: string;
  /** A CSR was generated and its key is waiting for the certificate. */
  csrPending?: boolean;
  /** True when the secrets are stored encrypted (SECRETS_KEY set). */
  encrypted?: boolean;
  updatedAt?: string;
}

export interface InvoiceLine {
  orderId: string;
  date: string;
  description: string;
  amount: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  customerId: string;
  preInvoiceId?: string;
  kind: InvoiceKind;
  letter: InvoiceLetter;
  /** ARCA voucher type (1 FA, 3 NCA, 6 FB, 8 NCB, 11 FC, 13 NCC). */
  cbteTipo: number;
  pointOfSale: number;
  number: number;
  date: string;
  receiver: { name: string; docTipo: number; docNro: string; ivaConditionId: number; ivaConditionLabel: string; address?: string };
  lines: InvoiceLine[];
  net: number;
  iva: number;
  ivaRate: number;
  total: number;
  cae: string;
  caeDue: string;
  /** emitida = approved by ARCA; simulada = no certificate (no fiscal value). */
  status: 'emitida' | 'simulada';
  environment: ArcaEnvironment;
  observations?: string[];
  /** Invoice this credit note cancels / credit note that cancelled this invoice. */
  associatedId?: string;
  creditNoteId?: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
}

export const CBTE_TIPO: Record<InvoiceLetter, Record<InvoiceKind, number>> = {
  A: { factura: 1, nota_credito: 3 },
  B: { factura: 6, nota_credito: 8 },
  C: { factura: 11, nota_credito: 13 },
};

/** CondicionIVAReceptorId (RG 5616). */
export const RECEIVER_IVA: Record<string, { id: number; label: string }> = {
  responsable_inscripto: { id: 1, label: 'IVA Responsable Inscripto' },
  exento: { id: 4, label: 'IVA Sujeto Exento' },
  consumidor_final: { id: 5, label: 'Consumidor Final' },
  monotributo: { id: 6, label: 'Responsable Monotributo' },
  exterior: { id: 9, label: 'Cliente del Exterior' },
};

/** Customer.taxCondition (free text) → receiver condition key. */
export function receiverCondition(taxCondition: string | undefined): keyof typeof RECEIVER_IVA {
  const t = (taxCondition ?? '').toLowerCase();
  if (t.includes('inscripto')) return 'responsable_inscripto';
  if (t.includes('monotrib')) return 'monotributo';
  if (t.includes('exento')) return 'exento';
  if (t.includes('exterior')) return 'exterior';
  return 'consumidor_final';
}

/** Letter: RI issuer → A to RI, B to the rest; monotributo/exento issuer → C. */
export function invoiceLetter(issuer: IvaCondition, receiver: keyof typeof RECEIVER_IVA): InvoiceLetter {
  if (issuer !== 'responsable_inscripto') return 'C';
  return receiver === 'responsable_inscripto' ? 'A' : 'B';
}

/** Receiver document: CUIT (80), DNI (96) or none (99, final consumer). */
export function receiverDoc(taxId: string): { docTipo: number; docNro: string } {
  const d = taxId.replace(/\D/g, '');
  if (d.length === 11) return { docTipo: 80, docNro: d };
  if (d.length === 7 || d.length === 8) return { docTipo: 96, docNro: d };
  return { docTipo: 99, docNro: '0' };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Amounts: the pre-invoice amounts are net; A and B add VAT, C has no VAT breakdown. */
export function invoiceAmounts(net: number, letter: InvoiceLetter, ivaRate: number): { net: number; iva: number; total: number } {
  const n = round2(net);
  if (letter === 'C') return { net: n, iva: 0, total: n };
  const iva = round2((n * ivaRate) / 100);
  return { net: n, iva, total: round2(n + iva) };
}

/** AlicIva Id of ARCA for a rate. */
export const IVA_ID: Record<number, number> = { 10.5: 4, 21: 5, 27: 6 };

/** Fiscal QR (RG 4892): https://www.afip.gob.ar/fe/qr/?p=<base64 json>. */
export function fiscalQrUrl(inv: Pick<Invoice, 'date' | 'pointOfSale' | 'cbteTipo' | 'number' | 'total' | 'receiver' | 'cae'>, issuerCuit: string): string {
  const payload = {
    ver: 1,
    fecha: inv.date.slice(0, 10),
    cuit: Number(issuerCuit.replace(/\D/g, '')),
    ptoVta: inv.pointOfSale,
    tipoCmp: inv.cbteTipo,
    nroCmp: inv.number,
    importe: inv.total,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: inv.receiver.docTipo,
    nroDocRec: Number(inv.receiver.docNro),
    tipoCodAut: 'E',
    codAut: Number(inv.cae),
  };
  const json = JSON.stringify(payload);
  const b64 = typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${b64}`;
}

/** "0001-00000023". */
export const invoiceNumber = (pointOfSale: number, n: number) => `${String(pointOfSale).padStart(5, '0')}-${String(n).padStart(8, '0')}`;

export const LETTER_LABEL: Record<InvoiceKind, string> = { factura: 'Factura', nota_credito: 'Nota de crédito' };
