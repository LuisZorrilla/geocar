import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { tmsAccess, type Ctx, type Deps } from '../tms/routes.ts';
import { deliveryNotePdf } from '../tms/documents.ts';
import { invoicePdf } from '../billing/pdf.ts';
import { invoiceNumber } from '../../src/shared/billing.ts';
import type { OrderStatus } from '../../src/shared/tms.ts';
import type { PortalContext } from './service.ts';

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const r = fn(req, res);
    if (r instanceof Promise) r.catch(next);
  } catch (err) {
    next(err);
  }
};

const portalUser = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email('email inválido').max(160) });
const portalUserPatch = z.object({ name: z.string().trim().min(2).max(120), active: z.boolean() }).partial();
const portalLogin = z.object({ email: z.string().trim().max(160), password: z.string().max(200) });
const portalPassword = z.object({ current: z.string().max(200), next: z.string().min(1).max(200) });

/** Company side: who of each customer can enter the portal. */
export function registerPortalAdminRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const portal = () => fleetStore.portal;
  const { canRead, canWrite, scopeOf, actorOf, noStore } = tmsAccess(deps);

  app.get(
    '/api/tms/customers/:id/portal-users',
    wrap((req, res) => {
      const ctx = canRead(req, res);
      if (!ctx) return;
      noStore(res);
      res.json({ items: portal().listUsers(scopeOf(req, ctx), req.params.id) });
    })
  );
  app.post(
    '/api/tms/customers/:id/portal-users',
    wrap(async (req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(portalUser, req, res);
      if (!body) return;
      noStore(res);
      res.status(201).json(await portal().createUser(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)));
    })
  );
  app.post(
    '/api/tms/portal-users/:id/reset-password',
    wrap(async (req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      noStore(res);
      res.json(await portal().resetPassword(scopeOf(req, ctx), req.params.id, actorOf(ctx)));
    })
  );
  app.patch(
    '/api/tms/portal-users/:id',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(portalUserPatch, req, res);
      if (!body) return;
      res.json({ user: portal().updateUser(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
    })
  );
}

/** Customer side (/portal): own login and session (x-portal-token), only the customer's own data. */
export function registerPortalRoutes(app: express.Express) {
  const portal = () => fleetStore.portal;
  const limiter = (limit: number) => rateLimit({ windowMs: 15 * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Demasiadas solicitudes. Esperá unos minutos.' } });
  app.use('/api/portal/login', limiter(30));
  app.use('/api/portal', limiter(1500));
  app.use('/api/portal', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const session = (req: express.Request, res: express.Response): PortalContext | null => {
    const c = portal().authenticate(req.get('x-portal-token') ?? undefined);
    if (!c) {
      res.status(401).json({ error: 'Tu sesión venció. Ingresá de nuevo.' });
      return null;
    }
    return c;
  };

  app.post(
    '/api/portal/login',
    wrap(async (req, res) => {
      const body = parseBody(portalLogin, req, res);
      if (!body) return;
      res.json(await portal().login(body.email, body.password));
    })
  );
  app.post('/api/portal/logout', (req, res) => {
    const c = session(req, res);
    if (!c) return;
    portal().logout(c);
    res.status(204).end();
  });
  app.get('/api/portal/me', (req, res) => {
    const c = session(req, res);
    if (!c) return;
    res.json(portal().me(c.user));
  });
  app.post(
    '/api/portal/password',
    wrap(async (req, res) => {
      const c = session(req, res);
      if (!c) return;
      const body = parseBody(portalPassword, req, res);
      if (!body) return;
      await portal().changePassword(c, body.current, body.next);
      res.json(portal().me(c.user));
    })
  );

  app.get(
    '/api/portal/orders',
    wrap((req, res) => {
      const c = session(req, res);
      if (!c) return;
      const status = typeof req.query.status === 'string' ? (req.query.status as OrderStatus | 'activos') : undefined;
      res.json(portal().orders(c, { status, q: typeof req.query.q === 'string' ? req.query.q : undefined }));
    })
  );
  app.get(
    '/api/portal/orders/:id',
    wrap((req, res) => {
      const c = session(req, res);
      if (!c) return;
      res.json(portal().orderDetail(c, req.params.id));
    })
  );
  app.get(
    '/api/portal/orders/:id/remito.pdf',
    wrap(async (req, res) => {
      const c = session(req, res);
      if (!c) return;
      const order = portal().order(c, req.params.id);
      if (!order.tripId) {
        res.status(409).json({ error: 'El remito está disponible cuando el pedido tiene viaje asignado.' });
        return;
      }
      const pdf = await deliveryNotePdf(await fleetStore.tms.deliveryNoteData(order));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="remito-${order.id}.pdf"`);
      res.send(pdf);
    })
  );
  app.get(
    '/api/portal/places',
    wrap((req, res) => {
      const c = session(req, res);
      if (!c) return;
      res.json({ items: portal().places(c) });
    })
  );
  app.post(
    '/api/portal/orders',
    wrap((req, res) => {
      const c = session(req, res);
      if (!c) return;
      const body = parseBody(schemas.portalCreateOrder, req, res);
      if (!body) return;
      res.status(201).json({ order: portal().createOrder(c, body) });
    })
  );

  app.get(
    '/api/portal/invoices',
    wrap((req, res) => {
      const c = session(req, res);
      if (!c) return;
      portal().orders(c, {}); // password check
      const items = fleetStore.billing.list({ tenantId: c.user.tenantId }, { customerId: c.user.customerId }).map((i) => ({
        id: i.id,
        kind: i.kind,
        letter: i.letter,
        number: invoiceNumber(i.pointOfSale, i.number),
        date: i.date,
        total: i.total,
        cae: i.cae,
        caeDue: i.caeDue,
        status: i.status,
        cancelled: Boolean(i.creditNoteId),
        orderIds: i.lines.map((l) => l.orderId),
      }));
      res.json({ items });
    })
  );
  app.get(
    '/api/portal/invoices/:id/pdf',
    wrap(async (req, res) => {
      const c = session(req, res);
      if (!c) return;
      portal().orders(c, {});
      const inv = fleetStore.billing.find({ tenantId: c.user.tenantId }, req.params.id);
      if (inv.customerId !== c.user.customerId) {
        res.status(404).json({ error: 'Comprobante no encontrado.' });
        return;
      }
      const cfg = await fleetStore.billing.config(inv.tenantId);
      const assoc = inv.associatedId ? fleetStore.billing.find({ tenantId: inv.tenantId }, inv.associatedId) : undefined;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${inv.letter}-${invoiceNumber(inv.pointOfSale, inv.number)}.pdf"`);
      res.send(await invoicePdf(inv, cfg, assoc));
    })
  );
}
