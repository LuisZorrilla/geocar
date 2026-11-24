import express from 'express';
import { z } from 'zod';
import { fleetStore } from '../store.ts';
import { parseBody } from '../validation/http.ts';
import { tmsAccess, type Ctx, type Deps } from '../tms/routes.ts';
import { parseFormat, type MoneyCurrency } from '../export/report.ts';
import { exportFileBase, respondWithReport } from '../export/send.ts';
import { carrierSettlementReport } from './report.ts';

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const r = fn(req, res);
    if (r instanceof Promise) r.catch(next);
  } catch (err) {
    next(err);
  }
};

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida');
const text = (n: number) => z.string().trim().max(n);
const docType = z.enum(['seguro_carga', 'seguro_rc', 'ruta', 'habilitacion', 'vtv', 'otro']);
const carrierFields = {
  name: z.string().trim().min(2).max(160),
  taxId: z.string().trim().min(8).max(20),
  contactName: text(120).optional(),
  phone: text(40).optional(),
  email: z.union([z.literal(''), z.string().trim().email('email inválido').max(160)]).optional(),
  documents: z
    .array(z.object({ id: z.string().max(40).optional(), type: docType, label: text(80).optional(), number: text(60).optional(), expiresAt: z.union([z.literal(''), dateOnly]).optional() }))
    .max(20)
    .optional(),
  vehicles: z
    .array(z.object({ plate: z.string().trim().min(5).max(12), description: text(80).optional(), capacityKg: z.coerce.number().nonnegative().max(100_000).optional(), capacityPallets: z.coerce.number().int().nonnegative().max(100).optional() }))
    .max(30)
    .optional(),
  notes: text(1000).optional(),
  active: z.boolean().optional(),
};
const carrierCreate = z.object(carrierFields);
const carrierUpdate = z.object(carrierFields).partial();
const isoDateTime = z.string().trim().refine((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v)), 'fecha y hora inválidas');
const carrierTrip = z.object({
  carrierId: z.string().min(1).max(80),
  plate: z.string().trim().min(5).max(12),
  driverName: z.string().trim().min(3).max(120),
  driverDni: text(12).optional(),
  driverPhone: text(40).optional(),
  price: z.coerce.number().positive().max(1_000_000_000),
  plannedStart: isoDateTime,
  orderIds: z.array(z.string().min(1).max(40)).min(1).max(50),
  notes: text(1000).optional(),
  acceptWarnings: z.object({ reason: text(300) }).optional(),
});
const carrierTripPatch = z
  .object({ plate: z.string().trim().min(5).max(12), driverName: z.string().trim().min(3).max(120), driverDni: text(12), driverPhone: text(40), price: z.coerce.number().positive().max(1_000_000_000) })
  .partial();
const rating = z.object({ score: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), comment: text(500).optional() });
const settlement = z.object({ carrierId: z.string().min(1).max(80), from: dateOnly, to: dateOnly });
const pay = z.object({ reference: text(120).optional() });
const reason = z.object({ reason: z.string().trim().min(3).max(300) });

/** Third-party carriers: catalog with documents, carrier trips with a per-trip link, ratings and settlements. */
export function registerCarrierRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const svc = () => fleetStore.carriers;
  const { canRead, canWrite, scopeOf, actorOf, noStore, exportActor } = tmsAccess(deps);
  const tenantFor = (req: express.Request, res: express.Response, ctx: C): string | null => {
    const scope = scopeOf(req, ctx);
    if ('all' in scope) {
      res.status(400).json({ error: 'Elegí una empresa.' });
      return null;
    }
    return scope.tenantId;
  };
  const approver = (req: express.Request, res: express.Response): C | null => {
    const ctx = canWrite(req, res);
    if (!ctx) return null;
    if (!actorOf(ctx).canOverride) {
      res.status(403).json({ error: 'Solo un administrador liquida y paga a fleteros.' });
      return null;
    }
    return ctx;
  };

  app.get(
    '/api/carriers',
    wrap((req, res) => {
      const ctx = canRead(req, res);
      if (!ctx) return;
      noStore(res);
      res.json({ items: svc().list(scopeOf(req, ctx), typeof req.query.q === 'string' ? req.query.q : '') });
    })
  );
  app.post(
    '/api/carriers',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const tenantId = tenantFor(req, res, ctx);
      if (!tenantId) return;
      const body = parseBody(carrierCreate, req, res);
      if (!body) return;
      res.status(201).json({ carrier: svc().create(tenantId, body, actorOf(ctx)) });
    })
  );
  app.patch(
    '/api/carriers/:id',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(carrierUpdate, req, res);
      if (!body) return;
      res.json({ carrier: svc().update(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
    })
  );

  app.post(
    '/api/carriers/trips',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const tenantId = tenantFor(req, res, ctx);
      if (!tenantId) return;
      const body = parseBody(carrierTrip, req, res);
      if (!body) return;
      res.status(201).json({ trip: svc().createTrip(tenantId, body, actorOf(ctx)) });
    })
  );
  app.patch(
    '/api/carriers/trips/:id',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(carrierTripPatch, req, res);
      if (!body) return;
      res.json({ trip: svc().updateTrip(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
    })
  );
  app.post(
    '/api/carriers/trips/:id/link',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      noStore(res);
      res.json(svc().issueLink(scopeOf(req, ctx), req.params.id, actorOf(ctx)));
    })
  );
  app.delete(
    '/api/carriers/trips/:id/link',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      res.json({ trip: svc().revokeLink(scopeOf(req, ctx), req.params.id, actorOf(ctx)) });
    })
  );
  app.post(
    '/api/carriers/trips/:id/rating',
    wrap((req, res) => {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(rating, req, res);
      if (!body) return;
      res.json({ trip: svc().rate(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
    })
  );

  app.get(
    '/api/carriers/settlements',
    wrap((req, res) => {
      const ctx = canRead(req, res);
      if (!ctx) return;
      noStore(res);
      res.json({ items: svc().listSettlements(scopeOf(req, ctx), typeof req.query.carrierId === 'string' ? req.query.carrierId : undefined) });
    })
  );
  app.post(
    '/api/carriers/settlements',
    wrap((req, res) => {
      const ctx = approver(req, res);
      if (!ctx) return;
      const body = parseBody(settlement, req, res);
      if (!body) return;
      res.status(201).json({ settlement: svc().createSettlement(scopeOf(req, ctx), body, actorOf(ctx)) });
    })
  );
  app.post(
    '/api/carriers/settlements/:id/pay',
    wrap((req, res) => {
      const ctx = approver(req, res);
      if (!ctx) return;
      const body = parseBody(pay, req, res);
      if (!body) return;
      res.json({ settlement: svc().paySettlement(scopeOf(req, ctx), req.params.id, body.reference, actorOf(ctx)) });
    })
  );
  app.post(
    '/api/carriers/settlements/:id/void',
    wrap((req, res) => {
      const ctx = approver(req, res);
      if (!ctx) return;
      const body = parseBody(reason, req, res);
      if (!body) return;
      res.json({ settlement: svc().voidSettlement(scopeOf(req, ctx), req.params.id, body.reason, actorOf(ctx)) });
    })
  );
  app.get('/api/carriers/settlements/:id/export', (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      const s = svc().findSettlement(scopeOf(req, ctx), req.params.id);
      const carrier = svc().find({ tenantId: s.tenantId }, s.carrierId);
      const def = fleetStore.currency.find(s.currency);
      const currency: MoneyCurrency | null = def ? { code: def.code, symbol: def.symbol, decimals: def.decimals, locale: def.locale } : null;
      const report = carrierSettlementReport(s, carrier, { company: fleetStore.getTenantById(s.tenantId)?.name ?? '', generatedBy: ctx.user.name, currency });
      void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase(`liquidacion-${s.id}`, carrier.name), 'Operaciones · Fleteros');
    } catch (err) {
      next(err);
    }
  });
}
