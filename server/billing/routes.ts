import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { tmsAccess, type Ctx, type Deps } from '../tms/routes.ts';
import { invoiceNumber } from '../../src/shared/billing.ts';
import { invoicePdf } from './pdf.ts';

/** T5 API: ARCA configuration (admins), invoices from pre-invoices, credit notes and PDFs. */
export function registerBillingRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const billing = () => fleetStore.billing;
  const { canRead, canWrite, scopeOf, actorOf, noStore } = tmsAccess(deps);

  /** Admin of one company (ARCA settings are per company; the superadmin picks it in the selector). */
  const admin = (req: express.Request, res: express.Response): { ctx: C; tenantId: string } | null => {
    const ctx = canWrite(req, res);
    if (!ctx) return null;
    if (!actorOf(ctx).canOverride) {
      res.status(403).json({ error: 'Solo un administrador gestiona la facturación electrónica.' });
      return null;
    }
    const scope = scopeOf(req, ctx);
    if ('all' in scope) {
      res.status(400).json({ error: 'Elegí una empresa.' });
      return null;
    }
    return { ctx, tenantId: scope.tenantId };
  };
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response, next: express.NextFunction) => fn(req, res).catch(next);

  app.get('/api/billing/arca-config', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    noStore(res);
    res.json({ config: await billing().config(a.tenantId), secretsKeyConfigured: /^[0-9a-f]{64}$/i.test(process.env.SECRETS_KEY ?? '') });
  }));

  app.put('/api/billing/arca-config', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    const body = parseBody(schemas.arcaConfig, req, res);
    if (!body) return;
    res.json({ config: await billing().saveConfig(a.tenantId, body, actorOf(a.ctx)) });
  }));

  app.post('/api/billing/arca-config/csr', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    const csrPem = await billing().createCsr(a.tenantId, actorOf(a.ctx));
    res.json({ csrPem });
  }));

  app.post('/api/billing/arca-config/certificate', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    const body = parseBody(schemas.arcaCertificate, req, res);
    if (!body) return;
    res.json({ config: await billing().setCertificate(a.tenantId, body.certPem, body.keyPem, actorOf(a.ctx)) });
  }));

  app.delete('/api/billing/arca-config/certificate', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    res.json({ config: await billing().removeCertificate(a.tenantId, actorOf(a.ctx)) });
  }));

  app.post('/api/billing/arca-config/test', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    res.json(await billing().test(a.tenantId));
  }));

  app.post('/api/billing/pre-invoices/:id/invoice', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    res.status(201).json({ invoice: await billing().invoicePreInvoice({ tenantId: a.tenantId }, req.params.id, actorOf(a.ctx)) });
  }));

  app.post('/api/billing/invoices/:id/credit-note', wrap(async (req, res) => {
    const a = admin(req, res);
    if (!a) return;
    const body = parseBody(schemas.cancelWithReason, req, res);
    if (!body) return;
    res.status(201).json({ invoice: await billing().creditNote({ tenantId: a.tenantId }, req.params.id, body.reason, actorOf(a.ctx)) });
  }));

  app.get('/api/billing/invoices', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: billing().list(scopeOf(req, ctx)) });
  });

  app.get('/api/billing/invoices/:id/pdf', wrap(async (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const inv = billing().find(scopeOf(req, ctx), req.params.id);
    const cfg = await billing().config(inv.tenantId);
    const assoc = inv.associatedId ? billing().find({ tenantId: inv.tenantId }, inv.associatedId) : undefined;
    const pdf = await invoicePdf(inv, cfg, assoc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.kind === 'factura' ? 'factura' : 'nota-credito'}-${inv.letter}-${invoiceNumber(inv.pointOfSale, inv.number)}.pdf"`);
    res.send(pdf);
  }));
}
