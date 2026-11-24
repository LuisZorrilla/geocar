import crypto from 'crypto';
import type { AuditLog, FleetStoreState } from '../../src/shared/types.ts';
import {
  CBTE_TIPO,
  invoiceAmounts,
  invoiceLetter,
  IVA_ID,
  receiverCondition,
  receiverDoc,
  RECEIVER_IVA,
  type ArcaConfig,
  type ArcaEnvironment,
  type Invoice,
  type InvoiceKind,
} from '../../src/shared/billing.ts';
import type { StateRepository } from '../db/stateRepository.ts';
import { TmsError, type TmsActor, type TmsScope } from '../tms/service.ts';
import { ArcaClient, ArcaError, generateCsr, inspectCertificate, openSecret, sealSecret, type AccessTicket } from './arca.ts';

interface Ctx {
  state: FleetStoreState;
  repo: StateRepository;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
  currencyOf: (tenantId: string) => string | null;
}

type Sealed = { v: 1; enc: boolean; data: string };
interface Secrets {
  key?: Sealed;
  cert?: Sealed;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const TZ = 'America/Argentina/Buenos_Aires';
/** YYYY-MM-DD in Argentina. */
const arDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const compact = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

export const DEFAULT_ARCA_CONFIG: ArcaConfig = {
  environment: 'homologacion',
  cuit: '',
  pointOfSale: 1,
  ivaCondition: 'responsable_inscripto',
  ivaRate: 21,
  businessName: '',
  address: '',
  iibb: '',
  activityStart: '',
  paymentDays: 30,
  hasCertificate: false,
};

/**
 * Electronic invoices from pre-invoices. Without a certificate the company works in "simulated"
 * mode: same flow and PDF, with a fake CAE and the voucher marked as having no fiscal value.
 */
export class BillingService {
  private tickets = new Map<string, AccessTicket>();

  constructor(
    private readonly ctx: () => Ctx,
    private readonly clientFor: (env: ArcaEnvironment) => ArcaClient = (env) => new ArcaClient(env)
  ) {}

  private get state() {
    return this.ctx().state;
  }
  private get repo() {
    return this.ctx().repo;
  }

  private audit(tenantId: string, actor: TmsActor, action: string, target: string, detail: string) {
    this.ctx().audit({ tenantId, actorName: actor.name, actorRole: actor.role, actorHidden: actor.hidden, module: 'Facturación electrónica', action, targetLabel: target, detail });
  }

  // ---------------------------------------------------------------- configuration

  async config(tenantId: string): Promise<ArcaConfig> {
    const c = await this.repo.getAppSetting<ArcaConfig>(`arca:${tenantId}`);
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    return { ...DEFAULT_ARCA_CONFIG, cuit: tenant?.taxId?.replace(/\D/g, '') ?? '', businessName: tenant?.name ?? '', ...(c ?? {}) };
  }

  async saveConfig(tenantId: string, patch: Partial<ArcaConfig>, actor: TmsActor): Promise<ArcaConfig> {
    const current = await this.config(tenantId);
    const next: ArcaConfig = {
      ...current,
      ...patch,
      cuit: (patch.cuit ?? current.cuit).replace(/\D/g, ''),
      // Certificate state is managed by the certificate endpoints only.
      hasCertificate: current.hasCertificate,
      certSubject: current.certSubject,
      certNotAfter: current.certNotAfter,
      csrPending: current.csrPending,
      encrypted: current.encrypted,
      updatedAt: new Date().toISOString(),
    };
    if (next.cuit && next.cuit.length !== 11) throw new TmsError('El CUIT del emisor debe tener 11 dígitos.');
    if (patch.environment && patch.environment !== current.environment) this.tickets.delete(`${tenantId}:${current.environment}`);
    await this.repo.setAppSetting(`arca:${tenantId}`, next);
    this.audit(tenantId, actor, 'Configuración de ARCA', next.businessName || tenantId, `Entorno ${next.environment} · punto de venta ${next.pointOfSale}.`);
    return next;
  }

  private async secrets(tenantId: string): Promise<Secrets> {
    return (await this.repo.getAppSetting<Secrets>(`arca-secret:${tenantId}`)) ?? {};
  }

  /** New key + CSR to upload to ARCA. The key never leaves the server. */
  async createCsr(tenantId: string, actor: TmsActor): Promise<string> {
    const cfg = await this.config(tenantId);
    if (cfg.cuit.length !== 11 || !cfg.businessName.trim()) throw new TmsError('Completá el CUIT y la razón social del emisor antes de generar el pedido de certificado.');
    const { keyPem, csrPem } = generateCsr({ cuit: cfg.cuit, businessName: cfg.businessName, alias: 'geocar' });
    const key = sealSecret(keyPem);
    await this.repo.setAppSetting(`arca-secret:${tenantId}`, { key });
    await this.repo.setAppSetting(`arca:${tenantId}`, { ...cfg, hasCertificate: false, certSubject: undefined, certNotAfter: undefined, csrPending: true, encrypted: key.enc });
    this.tickets.delete(`${tenantId}:${cfg.environment}`);
    this.audit(tenantId, actor, 'Pedido de certificado ARCA', cfg.businessName, 'Se generó una clave nueva y su CSR.');
    return csrPem;
  }

  /** Certificate issued by ARCA (for the CSR's key), or certificate + key of an existing pair. */
  async setCertificate(tenantId: string, certPem: string, keyPem: string | undefined, actor: TmsActor): Promise<ArcaConfig> {
    const cfg = await this.config(tenantId);
    const stored = await this.secrets(tenantId);
    const key = keyPem ?? (stored.key ? openSecret(stored.key) : undefined);
    if (!key) throw new TmsError('Falta la clave privada: generá el pedido de certificado (CSR) o subí la clave junto al certificado.');
    let info: ReturnType<typeof inspectCertificate>;
    try {
      info = inspectCertificate(certPem, key);
    } catch {
      throw new TmsError('El certificado o la clave no tienen formato PEM válido.');
    }
    if (!info.matchesKey) throw new TmsError('El certificado no corresponde a la clave guardada. ¿Es el que ARCA generó para este pedido?');
    if (Date.parse(info.notAfter) < Date.now()) throw new TmsError(`El certificado venció el ${info.notAfter.slice(0, 10)}.`);
    const sealedKey = sealSecret(key);
    await this.repo.setAppSetting(`arca-secret:${tenantId}`, { key: sealedKey, cert: sealSecret(certPem) });
    const next = { ...cfg, hasCertificate: true, csrPending: false, certSubject: info.subject, certNotAfter: info.notAfter, encrypted: sealedKey.enc };
    await this.repo.setAppSetting(`arca:${tenantId}`, next);
    this.tickets.delete(`${tenantId}:${cfg.environment}`);
    this.audit(tenantId, actor, 'Certificado ARCA cargado', cfg.businessName, `${info.subject} · vence ${info.notAfter.slice(0, 10)}.`);
    return next;
  }

  async removeCertificate(tenantId: string, actor: TmsActor): Promise<ArcaConfig> {
    const cfg = await this.config(tenantId);
    await this.repo.setAppSetting(`arca-secret:${tenantId}`, null);
    await this.repo.setAppSetting(`arca-ta:${tenantId}:${cfg.environment}`, null);
    const next = { ...cfg, hasCertificate: false, csrPending: false, certSubject: undefined, certNotAfter: undefined };
    await this.repo.setAppSetting(`arca:${tenantId}`, next);
    this.tickets.delete(`${tenantId}:${cfg.environment}`);
    this.audit(tenantId, actor, 'Certificado ARCA quitado', cfg.businessName, 'Vuelve al modo simulado.');
    return next;
  }

  /** WSAA ticket, reused while valid (WSAA refuses a new one while the previous is alive). */
  private async ticket(tenantId: string, cfg: ArcaConfig): Promise<AccessTicket> {
    const k = `${tenantId}:${cfg.environment}`;
    const valid = (t?: AccessTicket | null) => t && Date.parse(t.expiresAt) - 5 * 60_000 > Date.now();
    let t = this.tickets.get(k);
    if (valid(t)) return t!;
    const stored = await this.repo.getAppSetting<{ t: Sealed }>(`arca-ta:${k}`);
    if (stored) {
      t = JSON.parse(openSecret(stored.t)) as AccessTicket;
      if (valid(t)) {
        this.tickets.set(k, t);
        return t;
      }
    }
    const s = await this.secrets(tenantId);
    if (!s.key || !s.cert) throw new TmsError('Falta el certificado de ARCA.');
    t = await this.clientFor(cfg.environment).login('wsfe', openSecret(s.cert), openSecret(s.key));
    this.tickets.set(k, t);
    await this.repo.setAppSetting(`arca-ta:${k}`, { t: sealSecret(JSON.stringify(t)) });
    return t;
  }

  /** Connection test: servers, authentication and last numbers of the point of sale. */
  async test(tenantId: string) {
    const cfg = await this.config(tenantId);
    if (!cfg.hasCertificate) return { mode: 'simulado' as const, ok: true, message: 'Sin certificado: los comprobantes se emiten en modo simulado (sin validez fiscal).' };
    const client = this.clientFor(cfg.environment);
    try {
      const servers = await client.dummy();
      const t = await this.ticket(tenantId, cfg);
      const letters = cfg.ivaCondition === 'responsable_inscripto' ? (['A', 'B'] as const) : (['C'] as const);
      const last: Record<string, number> = {};
      for (const l of letters) last[`Factura ${l}`] = await client.lastNumber(t, cfg.cuit, cfg.pointOfSale, CBTE_TIPO[l].factura);
      return { mode: cfg.environment, ok: true, servers, last, message: `Conexión correcta con ARCA (${cfg.environment}).` };
    } catch (err) {
      const e = err instanceof ArcaError ? err : new ArcaError(err instanceof Error ? err.message : 'Error');
      return { mode: cfg.environment, ok: false, message: e.message, details: e.details };
    }
  }

  // ---------------------------------------------------------------- invoices

  private missingIssuerData(cfg: ArcaConfig): string[] {
    const m: string[] = [];
    if (cfg.cuit.length !== 11) m.push('CUIT');
    if (!cfg.businessName.trim()) m.push('razón social');
    if (!cfg.address.trim()) m.push('domicilio comercial');
    if (!cfg.activityStart) m.push('inicio de actividades');
    if (!(cfg.pointOfSale > 0)) m.push('punto de venta');
    return m;
  }

  private nextSimulatedNumber(tenantId: string, pointOfSale: number, cbteTipo: number) {
    return (
      this.state.invoices.filter((i) => i.tenantId === tenantId && i.status === 'simulada' && i.pointOfSale === pointOfSale && i.cbteTipo === cbteTipo).reduce((a, i) => Math.max(a, i.number), 0) + 1
    );
  }

  private async emit(
    tenantId: string,
    cfg: ArcaConfig,
    kind: InvoiceKind,
    base: Omit<Invoice, 'id' | 'cbteTipo' | 'number' | 'cae' | 'caeDue' | 'status' | 'environment' | 'kind' | 'pointOfSale' | 'date' | 'observations' | 'createdAt'>,
    service: { from: string; to: string },
    associated?: Invoice
  ): Promise<Invoice> {
    const cbteTipo = CBTE_TIPO[base.letter][kind];
    const date = arDate();
    const due = arDate(new Date(Date.now() + cfg.paymentDays * 86_400_000));
    let number: number;
    let cae: string;
    let caeDue: string;
    let observations: string[] = [];
    let status: Invoice['status'];
    if (!cfg.hasCertificate) {
      status = 'simulada';
      number = this.nextSimulatedNumber(tenantId, cfg.pointOfSale, cbteTipo);
      cae = `7${String(crypto.randomInt(0, 1e13)).padStart(13, '0')}`;
      caeDue = arDate(new Date(Date.now() + 10 * 86_400_000));
    } else {
      status = 'emitida';
      const client = this.clientFor(cfg.environment);
      const t = await this.ticket(tenantId, cfg);
      number = (await client.lastNumber(t, cfg.cuit, cfg.pointOfSale, cbteTipo)) + 1;
      const r = await client.requestCae(t, cfg.cuit, {
        pointOfSale: cfg.pointOfSale,
        cbteTipo,
        number,
        date: compact(date),
        docTipo: base.receiver.docTipo,
        docNro: base.receiver.docNro,
        receiverIvaId: base.receiver.ivaConditionId,
        net: base.net,
        iva: base.iva,
        total: base.total,
        ivaId: base.letter === 'C' ? undefined : IVA_ID[base.ivaRate],
        serviceFrom: compact(service.from),
        serviceTo: compact(service.to),
        dueDate: compact(due),
        associated: associated ? { cbteTipo: associated.cbteTipo, pointOfSale: associated.pointOfSale, number: associated.number, cuit: cfg.cuit, date: compact(associated.date) } : undefined,
      });
      cae = r.cae;
      caeDue = r.caeDue;
      observations = r.observations;
    }
    return {
      ...base,
      id: `inv-${uid()}`,
      kind,
      cbteTipo,
      pointOfSale: cfg.pointOfSale,
      number,
      date,
      cae,
      caeDue,
      status,
      environment: cfg.environment,
      observations: observations.length ? observations : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  /** Invoice of an issued pre-invoice. */
  async invoicePreInvoice(scope: TmsScope, preInvoiceId: string, actor: TmsActor): Promise<Invoice> {
    const pf = this.state.preInvoices.find((p) => p.id === preInvoiceId && inScope(scope, p.tenantId));
    if (!pf) throw new TmsError('Pre-factura no encontrada.', 404);
    if (pf.status !== 'emitida') throw new TmsError('Solo se factura una pre-factura emitida.', 409);
    if (pf.invoiceId) {
      const prev = this.state.invoices.find((i) => i.id === pf.invoiceId);
      if (prev && !prev.creditNoteId) throw new TmsError('La pre-factura ya tiene una factura vigente.', 409);
    }
    const currency = this.ctx().currencyOf(pf.tenantId);
    if (currency !== 'ARS') throw new TmsError('La factura electrónica de ARCA es para empresas que operan en pesos argentinos (ARS).', 409);
    const cfg = await this.config(pf.tenantId);
    const missing = this.missingIssuerData(cfg);
    if (missing.length) throw new TmsError(`Completá en la configuración de ARCA: ${missing.join(', ')}.`, 409);
    const customer = this.state.customers.find((c) => c.id === pf.customerId);
    if (!customer) throw new TmsError('Cliente no encontrado.', 404);
    const condKey = receiverCondition(customer.taxCondition);
    const letter = invoiceLetter(cfg.ivaCondition, condKey);
    const doc = receiverDoc(customer.taxId);
    if (letter === 'A' && doc.docTipo !== 80) throw new TmsError('Para Factura A el cliente necesita un CUIT válido.', 409);
    const amounts = invoiceAmounts(pf.total, letter, cfg.ivaRate);
    let inv: Invoice;
    try {
      inv = await this.emit(
        pf.tenantId,
        cfg,
        'factura',
        {
          tenantId: pf.tenantId,
          customerId: customer.id,
          preInvoiceId: pf.id,
          letter,
          receiver: { name: customer.name, docTipo: doc.docTipo, docNro: doc.docNro, ivaConditionId: RECEIVER_IVA[condKey].id, ivaConditionLabel: RECEIVER_IVA[condKey].label },
          lines: pf.lines.map((l) => ({ orderId: l.orderId, date: l.date, description: l.description, amount: l.amount })),
          ...amounts,
          ivaRate: letter === 'C' ? 0 : cfg.ivaRate,
          createdBy: actor.hidden ? 'Superadmin' : actor.name,
        },
        { from: pf.periodFrom, to: pf.periodTo }
      );
    } catch (err) {
      if (err instanceof ArcaError) throw new TmsError([err.message, ...err.details].join(' '), 502);
      throw err;
    }
    this.state.invoices.push(inv);
    pf.invoiceId = inv.id;
    this.audit(pf.tenantId, actor, inv.status === 'simulada' ? 'Factura simulada' : 'Factura emitida', `${inv.letter} ${inv.pointOfSale}-${inv.number}`, `${customer.name} · total ${inv.total} · CAE ${inv.cae}${inv.status === 'simulada' ? ' (sin validez fiscal)' : ''}.`);
    this.ctx().persist();
    return inv;
  }

  /** Credit note that cancels an invoice in full. */
  async creditNote(scope: TmsScope, invoiceId: string, reason: string, actor: TmsActor): Promise<Invoice> {
    const inv = this.state.invoices.find((i) => i.id === invoiceId && inScope(scope, i.tenantId));
    if (!inv) throw new TmsError('Factura no encontrada.', 404);
    if (inv.kind !== 'factura') throw new TmsError('Solo se anula una factura.', 409);
    if (inv.creditNoteId) throw new TmsError('La factura ya tiene nota de crédito.', 409);
    const cfg = await this.config(inv.tenantId);
    if ((inv.status === 'simulada') !== !cfg.hasCertificate) throw new TmsError(inv.status === 'simulada' ? 'Es una factura simulada: no se puede anular con ARCA real.' : 'Falta el certificado de ARCA para anularla.', 409);
    if (inv.status === 'emitida' && inv.environment !== cfg.environment) throw new TmsError(`La factura se emitió en ${inv.environment}; cambiá el entorno de ARCA a ese para anularla.`, 409);
    let nc: Invoice;
    try {
      nc = await this.emit(
        inv.tenantId,
        cfg,
        'nota_credito',
        {
          tenantId: inv.tenantId,
          customerId: inv.customerId,
          preInvoiceId: inv.preInvoiceId,
          letter: inv.letter,
          receiver: inv.receiver,
          lines: inv.lines,
          net: inv.net,
          iva: inv.iva,
          total: inv.total,
          ivaRate: inv.ivaRate,
          associatedId: inv.id,
          reason: reason.trim(),
          createdBy: actor.hidden ? 'Superadmin' : actor.name,
        },
        { from: inv.date, to: inv.date },
        inv
      );
    } catch (err) {
      if (err instanceof ArcaError) throw new TmsError([err.message, ...err.details].join(' '), 502);
      throw err;
    }
    this.state.invoices.push(nc);
    inv.creditNoteId = nc.id;
    // The pre-invoice is free again: it can be invoiced anew or voided.
    const pf = inv.preInvoiceId ? this.state.preInvoices.find((p) => p.id === inv.preInvoiceId) : undefined;
    if (pf?.invoiceId === inv.id) pf.invoiceId = undefined;
    this.audit(inv.tenantId, actor, 'Nota de crédito', `${nc.letter} ${nc.pointOfSale}-${nc.number}`, `Anula ${inv.letter} ${inv.pointOfSale}-${inv.number}: ${reason.trim()}.`);
    this.ctx().persist();
    return nc;
  }

  list(scope: TmsScope, f: { customerId?: string } = {}) {
    const customers = new Map(this.state.customers.map((c) => [c.id, c.name]));
    return this.state.invoices
      .filter((i) => inScope(scope, i.tenantId) && (!f.customerId || i.customerId === f.customerId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((i) => ({ ...i, customerName: customers.get(i.customerId) ?? i.receiver.name }));
  }

  find(scope: TmsScope, id: string): Invoice {
    const inv = this.state.invoices.find((i) => i.id === id && inScope(scope, i.tenantId));
    if (!inv) throw new TmsError('Comprobante no encontrado.', 404);
    return inv;
  }
}
