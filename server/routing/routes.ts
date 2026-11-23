import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { str, tmsAccess, type Ctx, type Deps } from '../tms/routes.ts';

/** TMS T4 API: routing engine status, trip optimization and route, day planner, dispatch board. */
export function registerRoutingRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const routing = () => fleetStore.routing;
  const { canRead, canWrite, scopeOf, actorOf, noStore } = tmsAccess(deps);

  const companyOf = (req: express.Request, res: express.Response, ctx: C): string | null => {
    const scope = scopeOf(req, ctx);
    if ('all' in scope) {
      res.status(400).json({ error: 'Elegí una empresa para planificar.' });
      return null;
    }
    return scope.tenantId;
  };

  app.get('/api/routing/status', async (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      noStore(res);
      res.json(await routing().engine.status());
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/routing/trips/:id/optimize', async (req, res, next) => {
    try {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      res.json(await routing().optimizeTrip(scopeOf(req, ctx), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/routing/trips/:id/route', async (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      noStore(res);
      res.json(await routing().tripRoute(scopeOf(req, ctx), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/routing/candidates', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const tenantId = companyOf(req, res, ctx);
    if (!tenantId) return;
    noStore(res);
    const start = str(req.query.start);
    res.json(routing().candidates(tenantId, Number.isFinite(Date.parse(start)) ? start : new Date().toISOString()));
  });

  app.post('/api/routing/plan', async (req, res, next) => {
    try {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(schemas.routingPlan, req, res);
      if (!body) return;
      const tenantId = companyOf(req, res, ctx);
      if (!tenantId) return;
      res.json(await routing().plan(tenantId, body));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/routing/plan/apply', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.routingApply, req, res);
    if (!body) return;
    const tenantId = companyOf(req, res, ctx);
    if (!tenantId) return;
    const result = routing().applyPlan(tenantId, body.proposals, actorOf(ctx));
    res.status(result.created.length ? 201 : 409).json(result);
  });

  app.get('/api/routing/dispatch', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = Number.isFinite(Date.parse(str(req.query.from))) ? str(req.query.from) : today.toISOString();
    const to = Number.isFinite(Date.parse(str(req.query.to))) ? str(req.query.to) : new Date(Date.parse(from) + 86_400_000).toISOString();
    res.json(routing().dispatch(scopeOf(req, ctx), from, to));
  });
}
