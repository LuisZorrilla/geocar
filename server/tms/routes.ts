import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { parseFormat } from '../export/report.ts';
import { exportFileBase, respondWithReport } from '../export/send.ts';
import type { ModulePermissions, PermissionLevel } from '../../src/shared/types.ts';
import { ORDER_STATUS_LABELS, TRIP_STATUS_LABELS, type OrderStatus, type TripStatus } from '../../src/shared/tms.ts';
import type { TmsActor, TmsScope } from './service.ts';
import { ordersReport, tripsReport } from './reports.ts';
import { deliveryNotePdf, routeSheetReport } from './documents.ts';
import { renderPdf } from '../export/pdf.ts';

export interface Ctx {
  user: { id: string; name: string; isHiddenSuperadmin?: boolean };
  tenant: { id: string };
  role: { name: string; isSystemAdminRole?: boolean; permissions: ModulePermissions };
}

export interface Deps<C extends Ctx> {
  requireAuth: (req: express.Request, res: express.Response) => C | null;
  getRequestedScope: (req: express.Request, ctx: C) => string | undefined;
  targetTenantOrFail: (req: express.Request, res: express.Response, ctx: C) => string | null;
}

export const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export const LEVEL_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, full: 3 };

/** Access helpers shared by the TMS route groups ("operaciones" permission). */
export function tmsAccess<C extends Ctx>(deps: Deps<C>) {
  const levelOf = (ctx: C): PermissionLevel =>
    ctx.user.isHiddenSuperadmin ? 'full' : (ctx.role.permissions.operaciones ?? ctx.role.permissions.flotas ?? 'none');

  const requireOps = (need: 'read' | 'write') => (req: express.Request, res: express.Response): C | null => {
    const ctx = deps.requireAuth(req, res);
    if (!ctx) return null;
    if (LEVEL_RANK[levelOf(ctx)] < LEVEL_RANK[need]) {
      res.status(403).json({
        error: need === 'read' ? 'Tu perfil no tiene acceso a Operaciones.' : 'Tu perfil solo puede consultar Operaciones (sin permiso de edición).',
      });
      return null;
    }
    return ctx;
  };

  const scopeOf = (req: express.Request, ctx: C): TmsScope => {
    if (!ctx.user.isHiddenSuperadmin) return { tenantId: ctx.tenant.id };
    const scope = deps.getRequestedScope(req, ctx);
    return scope && scope !== 'all' ? { tenantId: scope } : { all: true };
  };

  const actorOf = (ctx: C): TmsActor => ({
    name: ctx.user.name,
    role: ctx.role.name,
    hidden: Boolean(ctx.user.isHiddenSuperadmin),
    canOverride: Boolean(ctx.user.isHiddenSuperadmin || ctx.role.isSystemAdminRole || levelOf(ctx) === 'full'),
  });

  const companyName = (scope: TmsScope) => ('all' in scope ? 'Todas las empresas' : (fleetStore.getTenantById(scope.tenantId)?.name ?? ''));
  const exportActor = (ctx: C) => ({ tenantId: ctx.tenant.id, name: ctx.user.name, role: ctx.role.name, hidden: Boolean(ctx.user.isHiddenSuperadmin) });
  const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-store');

  return { levelOf, canRead: requireOps('read'), canWrite: requireOps('write'), scopeOf, actorOf, companyName, exportActor, noStore };
}

/** TMS API: customers, places, transport orders and trips ("operaciones" permission). */
export function registerTmsRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const tms = () => fleetStore.tms;
  const { levelOf, canRead, canWrite, scopeOf, actorOf, companyName, exportActor, noStore } = tmsAccess(deps);

  // ---------------------------------------------------------------- customers

  app.get('/api/tms/customers', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: tms().listCustomers(scopeOf(req, ctx), str(req.query.q).slice(0, 80), req.query.active !== 'true') });
  });

  app.post('/api/tms/customers', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createCustomer, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    const { tenantId: _t, ...input } = body;
    res.status(201).json({ customer: tms().createCustomer(tenantId, input, actorOf(ctx)) });
  });

  app.patch('/api/tms/customers/:id', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updateCustomer, req, res);
    if (!body) return;
    res.json({ customer: tms().updateCustomer(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });

  // ---------------------------------------------------------------- places

  app.get('/api/tms/places', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: tms().listPlaces(scopeOf(req, ctx), str(req.query.q).slice(0, 80), req.query.active !== 'true') });
  });

  app.post('/api/tms/places', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createPlace, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    const { tenantId: _t, ...input } = body;
    res.status(201).json({ place: tms().createPlace(tenantId, input, actorOf(ctx)) });
  });

  app.patch('/api/tms/places/:id', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updatePlace, req, res);
    if (!body) return;
    res.json({ place: tms().updatePlace(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });

  // ---------------------------------------------------------------- orders

  const orderFilters = (req: express.Request) => {
    const s = str(req.query.status);
    return {
      status: s === 'activos' ? ('activos' as const) : s in ORDER_STATUS_LABELS ? (s as OrderStatus) : undefined,
      customerId: str(req.query.customerId) || undefined,
      q: str(req.query.q).slice(0, 80) || undefined,
    };
  };

  app.get('/api/tms/orders', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json(tms().listOrders(scopeOf(req, ctx), { ...orderFilters(req), page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 25 }));
  });

  app.get('/api/tms/orders/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const scope = scopeOf(req, ctx);
    const filters = orderFilters(req);
    const items = tms().listOrders(scope, { ...filters, page: 1, pageSize: 100_000 }).items;
    const report = ordersReport(items, filters, { company: companyName(scope), generatedBy: ctx.user.name, multiTenant: 'all' in scope });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase('pedidos', 'all' in scope ? 'todas' : companyName(scope)), 'Operaciones');
  });

  app.post('/api/tms/orders', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createOrder, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    const { tenantId: _t, ...input } = body;
    res.status(201).json({ order: tms().createOrder(tenantId, input, actorOf(ctx)) });
  });

  app.patch('/api/tms/orders/:id', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updateOrder, req, res);
    if (!body) return;
    res.json({ order: tms().updateOrder(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });

  app.post('/api/tms/orders/:id/confirm', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    res.json({ order: tms().confirmOrder(scopeOf(req, ctx), req.params.id, actorOf(ctx)) });
  });

  app.post('/api/tms/orders/:id/cancel', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.cancelWithReason, req, res);
    if (!body) return;
    res.json({ order: tms().cancelOrder(scopeOf(req, ctx), req.params.id, body.reason, actorOf(ctx)) });
  });

  // ---------------------------------------------------------------- trips

  const tripFilters = (req: express.Request) => {
    const s = str(req.query.status);
    return {
      status: s === 'activos' ? ('activos' as const) : s in TRIP_STATUS_LABELS ? (s as TripStatus) : undefined,
      vehicleId: str(req.query.vehicleId) || undefined,
      q: str(req.query.q).slice(0, 80) || undefined,
    };
  };

  app.get('/api/tms/trips', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json(tms().listTrips(scopeOf(req, ctx), { ...tripFilters(req), page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 25 }));
  });

  app.get('/api/tms/trips/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const scope = scopeOf(req, ctx);
    const filters = tripFilters(req);
    const items = tms().listTrips(scope, { ...filters, page: 1, pageSize: 100_000 }).items;
    const report = tripsReport(items, filters, { company: companyName(scope), generatedBy: ctx.user.name, multiTenant: 'all' in scope });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase('viajes', 'all' in scope ? 'todas' : companyName(scope)), 'Operaciones');
  });

  /** Active trip per unit (unit sheet, live map). */
  app.get('/api/tms/active', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ byVehicle: tms().activeTripsByVehicle(scopeOf(req, ctx)) });
  });

  /** Assignment check without saving (the trip form calls it live). */
  app.post('/api/tms/trips/validate', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.validateTrip, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    res.json({ check: tms().validate(tenantId, body, body.tripId), canOverride: actorOf(ctx).canOverride });
  });

  /** Re-evaluates stops with the current positions now (also runs every minute). */
  app.post('/api/tms/trips/evaluate', async (req, res, next) => {
    try {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const changes = tms().evaluateTrips(new Date(), scopeOf(req, ctx));
      // Live ETAs too (forced: the button means "now").
      for (const t of fleetStore.routing.runningTrips(scopeOf(req, ctx))) delete t.etaComputedAt;
      const etas = await fleetStore.routing.refreshEtas();
      res.json({ changes: changes + etas });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/tms/trips', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createTrip, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    const { tenantId: _t, ...input } = body;
    res.status(201).json({ trip: tms().createTrip(tenantId, input, actorOf(ctx)) });
  });

  app.get('/api/tms/trips/:id', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ trip: tms().getTrip(scopeOf(req, ctx), req.params.id) });
  });

  app.patch('/api/tms/trips/:id', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updateTrip, req, res);
    if (!body) return;
    res.json({ trip: tms().updateTrip(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });

  app.post('/api/tms/trips/:id/start', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    res.json({ trip: tms().startTrip(scopeOf(req, ctx), req.params.id, actorOf(ctx)) });
  });

  app.post('/api/tms/trips/:id/cancel', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.cancelWithReason, req, res);
    if (!body) return;
    res.json({ trip: tms().cancelTrip(scopeOf(req, ctx), req.params.id, body.reason, actorOf(ctx)) });
  });

  app.post('/api/tms/trips/:id/stops/:stopId', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.setStopStatus, req, res);
    if (!body) return;
    res.json({ trip: tms().setStopStatus(scopeOf(req, ctx), req.params.id, req.params.stopId, body, actorOf(ctx)) });
  });

  // ---------------------------------------------------------------- T2: documents, tracking, driver app link

  /** Public tracking link of an order (created for orders that predate it). */
  app.post('/api/tms/orders/:id/tracking-link', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const token = tms().trackingToken(scopeOf(req, ctx), req.params.id, actorOf(ctx));
    res.json({ token, path: `/seguimiento/${token}` });
  });

  app.get('/api/tms/orders/:id/remito.pdf', async (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      const order = tms().orderForDocument(scopeOf(req, ctx), req.params.id);
      const pdf = await deliveryNotePdf(await tms().deliveryNoteData(order));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="remito-${order.id}.pdf"`);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/tms/trips/:id/hoja-de-ruta.pdf', async (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      const scope = scopeOf(req, ctx);
      const trip = tms().getTrip(scope, req.params.id);
      const pdf = await renderPdf(routeSheetReport(trip, { company: fleetStore.getTenantById(trip.tenantId)?.name ?? '', generatedBy: ctx.user.name }));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="hoja-de-ruta-${trip.id}.pdf"`);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  });

  /** Signature or photo of a delivery (proof of delivery), within the user's scope. */
  app.get('/api/tms/files/:id', async (req, res, next) => {
    try {
      const ctx = canRead(req, res);
      if (!ctx) return;
      const f = await tms().proofFile(scopeOf(req, ctx), req.params.id);
      if (!f) {
        res.status(404).json({ error: 'Archivo no encontrado.' });
        return;
      }
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(f.data);
    } catch (err) {
      next(err);
    }
  });

  /** Personal link of the driver's app. Gives access to the driver's trips: admins and "operaciones: full" only. */
  app.post('/api/tms/drivers/:id/app-link', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const actor = actorOf(ctx);
    if (!actor.canOverride) {
      res.status(403).json({ error: 'Solo un administrador puede generar el link de la app del chofer.' });
      return;
    }
    const { token, driver } = tms().issueDriverAppLink(scopeOf(req, ctx), req.params.id, actor);
    res.json({ token, path: `/chofer#t=${token}`, driverName: driver.name, createdAt: driver.appAccess?.createdAt });
  });

  app.delete('/api/tms/drivers/:id/app-link', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const actor = actorOf(ctx);
    if (!actor.canOverride) {
      res.status(403).json({ error: 'Solo un administrador puede revocar el link de la app del chofer.' });
      return;
    }
    tms().revokeDriverAppLink(scopeOf(req, ctx), req.params.id, actor);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- unit capacity

  /** Load capacity of a unit (needs write access to Flotas or Operaciones). */
  app.patch('/api/tms/vehicles/:id/capacity', (req, res) => {
    const ctx = deps.requireAuth(req, res);
    if (!ctx) return;
    const fleet = ctx.user.isHiddenSuperadmin ? 'full' : ctx.role.permissions.flotas;
    if (LEVEL_RANK[fleet] < 2 && LEVEL_RANK[levelOf(ctx)] < 2) {
      res.status(403).json({ error: 'Tu perfil no puede editar la capacidad de las unidades.' });
      return;
    }
    const body = parseBody(schemas.vehicleCapacity, req, res);
    if (!body) return;
    res.json({ vehicle: tms().updateVehicleCapacity(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });
}
