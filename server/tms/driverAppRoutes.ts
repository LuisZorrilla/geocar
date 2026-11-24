import express from 'express';
import rateLimit from 'express-rate-limit';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import type { Driver } from '../../src/shared/types.ts';
import { POD_FILE_MAX_BYTES } from './service.ts';
import { deliveryNotePdf } from './documents.ts';

const limiter = (limit: number) =>
  rateLimit({ windowMs: 15 * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Demasiadas solicitudes. Esperá unos minutos.' } });

/**
 * Driver app (/chofer) and public tracking page (/seguimiento/<token>).
 * - Driver app: authenticated by the personal link token (header x-driver-token), only its own trips.
 * - Public tracking: read-only, by the order's tracking token, minimal data.
 */
export function registerDriverAppRoutes(app: express.Express) {
  const tms = () => fleetStore.tms;

  app.use('/api/driver-app', limiter(900));
  app.use('/api/public', limiter(300));

  const driverOf = (req: express.Request, res: express.Response): Driver | null => {
    const d = tms().driverByAppToken(req.get('x-driver-token') ?? undefined);
    if (!d) {
      res.status(401).json({ error: 'Tu link de acceso no es válido o fue reemplazado. Pedí uno nuevo a tu empresa.' });
      return null;
    }
    return d;
  };
  const scopeOf = (d: Driver) => ({ tenantId: d.tenantId });
  const isCarrier = (d: Driver) => d.id.startsWith('carrier-trip:');
  const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-store');

  app.get('/api/driver-app/me', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    noStore(res);
    const tenant = fleetStore.getTenantById(d.tenantId);
    res.json({ driver: { id: d.id, name: d.name, company: tenant?.name ?? '' }, carrier: isCarrier(d), trips: tms().driverTrips(d) });
  });

  /** Phone position of a carrier while its trip is open (fleet drivers are tracked by their unit). */
  app.post('/api/driver-app/position', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    const body = parseBody(schemas.driverPosition, req, res);
    if (!body) return;
    if (!isCarrier(d)) {
      res.status(204).end();
      return;
    }
    res.json({ stored: tms().carrierPosition(d, body) });
  });

  app.post('/api/driver-app/trips/:id/start', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    tms().driverTrip(d, req.params.id);
    res.json({ trip: tms().startTrip(scopeOf(d), req.params.id, tms().driverActor(d)) });
  });

  app.post('/api/driver-app/trips/:id/stops/:stopId/arrive', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    tms().driverTrip(d, req.params.id);
    res.json({ trip: tms().setStopStatus(scopeOf(d), req.params.id, req.params.stopId, { status: 'en_lugar' }, tms().driverActor(d), 'app') });
  });

  /** Loading done (unloading needs /deliver with the proof). */
  app.post('/api/driver-app/trips/:id/stops/:stopId/complete', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    tms().driverTrip(d, req.params.id);
    res.json({ trip: tms().setStopStatus(scopeOf(d), req.params.id, req.params.stopId, { status: 'completada' }, tms().driverActor(d), 'app') });
  });

  /** Couldn't deliver / load: the stop is skipped and the dispatch gets an incident. */
  app.post('/api/driver-app/trips/:id/stops/:stopId/fail', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    const body = parseBody(schemas.failStop, req, res);
    if (!body) return;
    tms().driverTrip(d, req.params.id);
    tms().setStopStatus(scopeOf(d), req.params.id, req.params.stopId, { status: 'omitida', note: body.reason }, tms().driverActor(d), 'app');
    const { trip } = tms().reportDriverIssue(d, req.params.id, { type: body.type ?? 'rechazo', note: `No se pudo completar la parada: ${body.reason}`, stopId: req.params.stopId });
    res.json({ trip });
  });

  /** Signature (PNG) or photo (JPEG/PNG) of a delivery: raw body, one per request. */
  app.put(
    '/api/driver-app/trips/:id/files',
    express.raw({ type: () => true, limit: POD_FILE_MAX_BYTES }),
    async (req, res, next) => {
      try {
        const d = driverOf(req, res);
        if (!d) return;
        const trip = tms().driverTrip(d, req.params.id);
        const kind = req.query.kind === 'signature' ? 'signature' : req.query.kind === 'receipt' ? 'receipt' : 'photo';
        const mime = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const fileId = await tms().saveProofFile(trip.tenantId, trip.id, kind, data, mime, d.name);
        res.status(201).json({ fileId });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/driver-app/trips/:id/stops/:stopId/deliver', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    const body = parseBody(schemas.deliverStop, req, res);
    if (!body) return;
    res.json({ trip: tms().completeWithProof(d, req.params.id, req.params.stopId, body) });
  });

  /** Fuel loaded during the trip (with the ticket photo, uploaded first with kind=receipt). */
  app.post('/api/driver-app/trips/:id/fuel', async (req, res, next) => {
    try {
      const d = driverOf(req, res);
      if (!d) return;
      if (isCarrier(d)) {
        res.status(403).json({ error: 'El combustible del fletero corre por su cuenta.' });
        return;
      }
      const body = parseBody(schemas.driverFuel, req, res);
      if (!body) return;
      const trip = tms().driverTrip(d, req.params.id);
      const v = fleetStore.costs;
      const load = await v.addFuelLoad(trip.tenantId, { ...body, vehicleId: trip.vehicleId, tripId: trip.id, driverId: d.id }, tms().driverActor(d), 'app');
      res.status(201).json({ load: { id: load.id, liters: load.liters, total: load.total, flags: load.flags } });
    } catch (err) {
      next(err);
    }
  });

  /** Trip expense paid by the driver (toll, meal…): pending until an admin approves it. */
  app.post('/api/driver-app/trips/:id/expenses', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    if (isCarrier(d)) {
      res.status(403).json({ error: 'Los gastos del fletero se acuerdan en el precio del viaje.' });
      return;
    }
    const body = parseBody(schemas.driverExpense, req, res);
    if (!body) return;
    const trip = tms().driverTrip(d, req.params.id);
    const e = fleetStore.costs.addExpense(trip.tenantId, { ...body, tripId: trip.id, paidBy: 'chofer' }, tms().driverActor(d), 'app', false);
    res.status(201).json({ expense: { id: e.id, type: e.type, amount: e.amount, status: e.status } });
  });

  /** The driver's own expenses of a trip (to see what was approved). */
  app.get('/api/driver-app/trips/:id/expenses', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    const trip = tms().driverTrip(d, req.params.id);
    res.json({
      items: fleetStore.costs.listExpenses({ tenantId: trip.tenantId }, { tripId: trip.id }).map((e) => ({ id: e.id, type: e.type, amount: e.amount, status: e.status, at: e.at, rejectReason: e.rejectReason })),
    });
  });

  app.post('/api/driver-app/trips/:id/reports', (req, res) => {
    const d = driverOf(req, res);
    if (!d) return;
    const body = parseBody(schemas.driverReport, req, res);
    if (!body) return;
    const { trip } = tms().reportDriverIssue(d, req.params.id, body);
    res.status(201).json({ trip });
  });

  // ---------------------------------------------------------------- public tracking

  app.get('/api/public/track/:token', (req, res) => {
    const data = tms().publicTracking(req.params.token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!data) {
      res.status(404).json({ error: 'El link de seguimiento no existe o el pedido fue cancelado.' });
      return;
    }
    res.json({ tracking: data });
  });

  /** Delivery note with the proof, only once delivered. */
  app.get('/api/public/track/:token/remito.pdf', async (req, res, next) => {
    try {
      const order = tms().orderByTrackingToken(req.params.token);
      if (!order || order.status !== 'entregado') {
        res.status(404).json({ error: 'El comprobante está disponible cuando el pedido fue entregado.' });
        return;
      }
      const pdf = await deliveryNotePdf(await tms().deliveryNoteData(order));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="remito-${order.id}.pdf"`);
      res.setHeader('X-Robots-Tag', 'noindex');
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  });
}
