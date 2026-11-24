import express from 'express';
import rateLimit from 'express-rate-limit';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { tmsAccess, type Ctx, type Deps } from '../tms/routes.ts';
import { TmsError, type TmsActor } from '../tms/service.ts';
import { invoicePdf } from '../billing/pdf.ts';
import { invoiceNumber } from '../../src/shared/billing.ts';
import type { OrderStatus, TripStatus } from '../../src/shared/tms.ts';
import type { ApiKey, ApiScope } from '../../src/shared/integrations.ts';
import { apiInvoice, apiOrder, apiTrip } from './service.ts';

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const r = fn(req, res);
    if (r instanceof Promise) r.catch(next);
  } catch (err) {
    next(err);
  }
};

/** Admin screens of the public API keys and webhooks (company administrators). */
export function registerIntegrationRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const svc = () => fleetStore.integrations;
  const { canWrite, scopeOf, actorOf, noStore } = tmsAccess(deps);

  const admin = (req: express.Request, res: express.Response): { ctx: C; tenantId: string } | null => {
    const ctx = canWrite(req, res);
    if (!ctx) return null;
    if (!actorOf(ctx).canOverride) {
      res.status(403).json({ error: 'Solo un administrador gestiona las integraciones.' });
      return null;
    }
    const scope = scopeOf(req, ctx);
    if ('all' in scope) {
      res.status(400).json({ error: 'Elegí una empresa.' });
      return null;
    }
    return { ctx, tenantId: scope.tenantId };
  };

  app.get(
    '/api/integrations',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      noStore(res);
      const s = { tenantId: a.tenantId };
      res.json({ apiKeys: svc().listKeys(s), webhooks: svc().listWebhooks(s), publicAppUrl: process.env.PUBLIC_APP_URL?.trim() || null });
    })
  );

  app.post(
    '/api/integrations/api-keys',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      const body = parseBody(schemas.createApiKey, req, res);
      if (!body) return;
      noStore(res);
      res.status(201).json(svc().createKey(a.tenantId, body, actorOf(a.ctx)));
    })
  );

  app.delete(
    '/api/integrations/api-keys/:id',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      res.json({ key: svc().revokeKey({ tenantId: a.tenantId }, req.params.id, actorOf(a.ctx)) });
    })
  );

  app.post(
    '/api/integrations/webhooks',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      const body = parseBody(schemas.createWebhook, req, res);
      if (!body) return;
      noStore(res);
      res.status(201).json(svc().createWebhook(a.tenantId, body, actorOf(a.ctx)));
    })
  );

  app.patch(
    '/api/integrations/webhooks/:id',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      const body = parseBody(schemas.updateWebhook, req, res);
      if (!body) return;
      res.json({ webhook: svc().updateWebhook({ tenantId: a.tenantId }, req.params.id, body, actorOf(a.ctx)) });
    })
  );

  app.delete(
    '/api/integrations/webhooks/:id',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      svc().deleteWebhook({ tenantId: a.tenantId }, req.params.id, actorOf(a.ctx));
      res.status(204).end();
    })
  );

  app.post(
    '/api/integrations/webhooks/:id/rotate-secret',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      noStore(res);
      res.json(svc().rotateSecret({ tenantId: a.tenantId }, req.params.id, actorOf(a.ctx)));
    })
  );

  app.post(
    '/api/integrations/webhooks/:id/test',
    wrap(async (req, res) => {
      const a = admin(req, res);
      if (!a) return;
      res.json({ delivery: await svc().test({ tenantId: a.tenantId }, req.params.id) });
    })
  );

  app.get(
    '/api/integrations/webhooks/:id/deliveries',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      noStore(res);
      res.json({ items: svc().deliveries({ tenantId: a.tenantId }, req.params.id) });
    })
  );

  app.post(
    '/api/integrations/deliveries/:id/redeliver',
    wrap((req, res) => {
      const a = admin(req, res);
      if (!a) return;
      res.json({ delivery: svc().redeliver({ tenantId: a.tenantId }, req.params.id) });
    })
  );
}

// ---------------------------------------------------------------- public API v1

const ORDER_STATUSES: OrderStatus[] = ['borrador', 'confirmado', 'planificado', 'en_curso', 'entregado', 'cancelado'];
const TRIP_STATUSES: TripStatus[] = ['planificado', 'en_curso', 'finalizado', 'cancelado'];
type ApiRequest = express.Request & { apiKey?: ApiKey };

/**
 * /api/v1: REST API for customers' and partners' systems, authenticated with a company API key
 * (Authorization: Bearer gk_… or X-Api-Key). Each key sees only its company and its scopes.
 */
export function registerPublicApiRoutes(app: express.Express) {
  const svc = () => fleetStore.integrations;
  const tms = () => fleetStore.tms;
  const state = () => fleetStore.getState();

  const tokenOf = (req: express.Request) => {
    const auth = req.get('authorization') ?? '';
    return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.get('x-api-key')?.trim();
  };

  app.use(
    '/api/v1',
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => `k:${(tokenOf(req) ?? '').slice(0, 16) || 'anon'}`,
      validate: { keyGeneratorIpFallback: false },
      message: { error: 'Demasiadas solicitudes: máximo 240 por minuto por clave.' },
    })
  );
  app.use('/api/v1', (req: ApiRequest, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const key = svc().authenticate(tokenOf(req));
    if (!key) {
      res.status(401).json({ error: 'Clave de API inválida o revocada.' });
      return;
    }
    req.apiKey = key;
    next();
  });

  const need = (req: ApiRequest, res: express.Response, scope: ApiScope): { tenantId: string; key: ApiKey } | null => {
    const key = req.apiKey!;
    if (!key.scopes.includes(scope)) {
      res.status(403).json({ error: `La clave no tiene el permiso «${scope}».` });
      return null;
    }
    return { tenantId: key.tenantId, key };
  };
  const actor = (key: ApiKey): TmsActor => ({ name: `API: ${key.name}`, role: 'API', canOverride: false });
  const since = (req: express.Request) => {
    const v = typeof req.query.updatedSince === 'string' ? Date.parse(req.query.updatedSince) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const list = <T,>(items: T[], req: express.Request) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };
  const q = (req: express.Request, name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string) : null);

  app.get('/api/v1', (req: ApiRequest, res) => {
    const key = req.apiKey!;
    res.json({ company: fleetStore.getTenantById(key.tenantId)?.name ?? null, key: { name: key.name, prefix: key.prefix, scopes: key.scopes } });
  });

  // ---- catalog
  app.get(
    '/api/v1/customers',
    wrap((req, res) => {
      const a = need(req, res, 'catalog:read');
      if (!a) return;
      const items = tms()
        .listCustomers({ tenantId: a.tenantId }, q(req, 'q') ?? '')
        .map((c) => ({ id: c.id, name: c.name, taxId: c.taxId, taxCondition: c.taxCondition ?? null, active: c.active, contacts: c.contacts ?? [] }));
      res.json(list(items, req));
    })
  );
  app.post(
    '/api/v1/customers',
    wrap((req, res) => {
      const a = need(req, res, 'catalog:write');
      if (!a) return;
      const body = parseBody(schemas.apiCreateCustomer, req, res);
      if (!body) return;
      const c = tms().createCustomer(a.tenantId, body, actor(a.key));
      res.status(201).json({ customer: { id: c.id, name: c.name, taxId: c.taxId, taxCondition: c.taxCondition ?? null, active: c.active } });
    })
  );
  const placeOut = (p: { id: string; name: string; kind: string; address: string; lat: number; lng: number; radiusM: number; customerId?: string | null; active: boolean }) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    radiusM: p.radiusM,
    customerId: p.customerId ?? null,
    active: p.active,
  });
  app.get(
    '/api/v1/places',
    wrap((req, res) => {
      const a = need(req, res, 'catalog:read');
      if (!a) return;
      res.json(list(tms().listPlaces({ tenantId: a.tenantId }, q(req, 'q') ?? '').map(placeOut), req));
    })
  );
  app.post(
    '/api/v1/places',
    wrap((req, res) => {
      const a = need(req, res, 'catalog:write');
      if (!a) return;
      const body = parseBody(schemas.apiCreatePlace, req, res);
      if (!body) return;
      res.status(201).json({ place: placeOut(tms().createPlace(a.tenantId, body, actor(a.key))) });
    })
  );

  // ---- orders
  app.get(
    '/api/v1/orders',
    wrap((req, res) => {
      const a = need(req, res, 'orders:read');
      if (!a) return;
      const s = state();
      const status = ORDER_STATUSES.includes(q(req, 'status') as OrderStatus) ? q(req, 'status') : null;
      const ref = q(req, 'reference');
      const cust = q(req, 'customerId');
      const after = since(req);
      const items = s.transportOrders
        .filter((o) => o.tenantId === a.tenantId && (!status || o.status === status) && (!ref || o.reference === ref) && (!cust || o.customerId === cust) && (after === null || Date.parse(o.updatedAt) > after))
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .map((o) => apiOrder(s, o));
      res.json(list(items, req));
    })
  );
  app.get(
    '/api/v1/orders/:id',
    wrap((req, res) => {
      const a = need(req, res, 'orders:read');
      if (!a) return;
      const o = tms().orderForDocument({ tenantId: a.tenantId }, req.params.id);
      const tracking = o.trackingToken ? tms().publicTracking(o.trackingToken) : null;
      res.json({ order: apiOrder(state(), o), tracking: tracking ? { unit: tracking.unit ?? null, delivered: tracking.delivered ?? null, events: tracking.events } : null });
    })
  );
  app.post(
    '/api/v1/orders',
    wrap((req, res) => {
      const a = need(req, res, 'orders:write');
      if (!a) return;
      const idem = req.get('idempotency-key')?.trim().slice(0, 100) || undefined;
      if (idem) {
        const prev = state().transportOrders.find((o) => o.tenantId === a.tenantId && o.source?.idempotencyKey === idem);
        if (prev) {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(200).json({ order: apiOrder(state(), prev) });
          return;
        }
      }
      const body = parseBody(schemas.apiCreateOrder, req, res);
      if (!body) return;
      const o = tms().createOrder(a.tenantId, { ...body, source: { channel: 'api', apiKeyId: a.key.id, idempotencyKey: idem } }, actor(a.key));
      res.status(201).json({ order: apiOrder(state(), tms().orderForDocument({ tenantId: a.tenantId }, o.id)) });
    })
  );
  app.post(
    '/api/v1/orders/:id/cancel',
    wrap((req, res) => {
      const a = need(req, res, 'orders:write');
      if (!a) return;
      const body = parseBody(schemas.cancelWithReason, req, res);
      if (!body) return;
      tms().cancelOrder({ tenantId: a.tenantId }, req.params.id, body.reason, actor(a.key));
      res.json({ order: apiOrder(state(), tms().orderForDocument({ tenantId: a.tenantId }, req.params.id)) });
    })
  );

  // ---- trips
  app.get(
    '/api/v1/trips',
    wrap((req, res) => {
      const a = need(req, res, 'trips:read');
      if (!a) return;
      const s = state();
      const status = TRIP_STATUSES.includes(q(req, 'status') as TripStatus) ? q(req, 'status') : null;
      const after = since(req);
      const items = s.trips
        .filter((t) => t.tenantId === a.tenantId && (!status || t.status === status) && (after === null || Date.parse(t.updatedAt) > after))
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .map((t) => apiTrip(s, t));
      res.json(list(items, req));
    })
  );
  app.get(
    '/api/v1/trips/:id',
    wrap((req, res) => {
      const a = need(req, res, 'trips:read');
      if (!a) return;
      res.json({ trip: apiTrip(state(), tms().tripForDocument({ tenantId: a.tenantId }, req.params.id)) });
    })
  );

  // ---- invoices
  app.get(
    '/api/v1/invoices',
    wrap((req, res) => {
      const a = need(req, res, 'invoices:read');
      if (!a) return;
      res.json(list(fleetStore.billing.list({ tenantId: a.tenantId }, { customerId: q(req, 'customerId') ?? undefined }).map(apiInvoice), req));
    })
  );
  app.get(
    '/api/v1/invoices/:id/pdf',
    wrap(async (req, res) => {
      const a = need(req, res, 'invoices:read');
      if (!a) return;
      const inv = fleetStore.billing.find({ tenantId: a.tenantId }, req.params.id);
      const cfg = await fleetStore.billing.config(inv.tenantId);
      const assoc = inv.associatedId ? fleetStore.billing.find({ tenantId: inv.tenantId }, inv.associatedId) : undefined;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${inv.letter}-${invoiceNumber(inv.pointOfSale, inv.number)}.pdf"`);
      res.send(await invoicePdf(inv, cfg, assoc));
    })
  );

  app.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'Recurso no encontrado.' });
  });
  // Errors of the public API always answer JSON.
  app.use('/api/v1', (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof TmsError) {
      res.status(err.status).json({ error: err.message, ...((err.details as object | undefined) ?? {}) });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'El cuerpo no es JSON válido.' });
      return;
    }
    console.error('[api v1]', err);
    res.status(500).json({ error: 'Error interno.' });
  });
}
