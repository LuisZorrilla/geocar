import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { parseFormat, type MoneyCurrency } from '../export/report.ts';
import { exportFileBase, respondWithReport } from '../export/send.ts';
import { parseFuelRows } from '../../src/shared/costs.ts';
import { str, tmsAccess, type Ctx, type Deps } from './routes.ts';
import type { TmsScope } from './service.ts';
import { TmsError } from './service.ts';
import { readSpreadsheet } from './spreadsheet.ts';
import { fuelReport, preInvoiceReport, profitabilityReport, settlementReport } from './costReports.ts';

const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const dateParam = (v: unknown, fallback: string) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : fallback);

/** TMS T3 API: tariffs and quotes, order prices, fuel, trip expenses, profitability, pre-invoices and settlements. */
export function registerCostsRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const costs = () => fleetStore.costs;
  const { canRead, canWrite, scopeOf, actorOf, companyName, exportActor, noStore } = tmsAccess(deps);

  const moneyOf = (scope: TmsScope): MoneyCurrency | null => {
    if ('all' in scope) return null;
    const code = fleetStore.currency.tenantCurrency(scope.tenantId);
    const def = fleetStore.currency.find(code);
    return def ? { code: def.code, symbol: def.symbol, decimals: def.decimals, locale: def.locale } : null;
  };
  /** Admin-level actions (approve expenses, issue/void pre-invoices, pay settlements). */
  const requireOverride = (req: express.Request, res: express.Response): C | null => {
    const ctx = canWrite(req, res);
    if (!ctx) return null;
    if (!actorOf(ctx).canOverride) {
      res.status(403).json({ error: 'Solo un administrador puede hacer esta operación.' });
      return null;
    }
    return ctx;
  };
  const companyOnly = (req: express.Request, res: express.Response, ctx: C): string | null => {
    const scope = scopeOf(req, ctx);
    if ('all' in scope) {
      res.status(400).json({ error: 'Elegí una empresa para esta operación.' });
      return null;
    }
    return scope.tenantId;
  };

  // ---------------------------------------------------------------- tariffs & quotes

  app.get('/api/costs/tariffs', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: costs().listTariffs(scopeOf(req, ctx), str(req.query.customerId) || undefined) });
  });

  const saveTariff = (id: string | null) => (req: express.Request, res: express.Response) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.saveTariff, req, res);
    if (!body) return;
    const tenantId = id ? '' : deps.targetTenantOrFail(req, res, ctx);
    if (!id && !tenantId) return;
    const { tenantId: _t, ...input } = body;
    res.status(id ? 200 : 201).json({ tariff: costs().saveTariff(scopeOf(req, ctx), tenantId ?? '', id, input, actorOf(ctx)) });
  };
  app.post('/api/costs/tariffs', saveTariff(null));
  app.put('/api/costs/tariffs/:id', (req, res) => saveTariff(req.params.id)(req, res));

  app.post('/api/costs/quote', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.quote, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    res.json(costs().quote(tenantId, body));
  });

  app.post('/api/costs/orders/:id/charge', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.setCharge, req, res);
    if (!body) return;
    const order = costs().setOrderCharge(scopeOf(req, ctx), req.params.id, { amount: body.amount, reason: body.reason ?? '', recalculate: body.recalculate }, actorOf(ctx));
    res.json({ charge: order.charge });
  });

  // ---------------------------------------------------------------- fuel

  const fuelFilters = (req: express.Request) => ({
    vehicleId: str(req.query.vehicleId) || undefined,
    from: dateParam(req.query.from, ''),
    to: dateParam(req.query.to, ''),
    flagged: req.query.flagged === 'true',
  });

  app.get('/api/costs/fuel', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    const f = fuelFilters(req);
    res.json(costs().listFuel(scopeOf(req, ctx), { ...f, from: f.from || undefined, to: f.to || undefined }));
  });

  app.get('/api/costs/fuel/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const scope = scopeOf(req, ctx);
    const f = fuelFilters(req);
    const { items } = costs().listFuel(scope, { ...f, from: f.from || undefined, to: f.to || undefined });
    const report = fuelReport(items, { company: companyName(scope), generatedBy: ctx.user.name, currency: moneyOf(scope) });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase('combustible', companyName(scope)), 'Operaciones · Costos');
  });

  app.post('/api/costs/fuel', async (req, res, next) => {
    try {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const body = parseBody(schemas.fuelLoad, req, res);
      if (!body) return;
      const tenantId = deps.targetTenantOrFail(req, res, ctx);
      if (!tenantId) return;
      const { tenantId: _t, ...input } = body;
      res.status(201).json({ load: await costs().addFuelLoad(tenantId, input, actorOf(ctx), 'manual') });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/costs/fuel/:id', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    costs().deleteFuelLoad(scopeOf(req, ctx), req.params.id, actorOf(ctx));
    res.json({ ok: true });
  });

  /** Fleet card statement (CSV or XLSX, raw body). ?dryRun=true only parses and reports what would happen. */
  app.post('/api/costs/fuel/import', express.raw({ type: () => true, limit: IMPORT_MAX_BYTES }), async (req, res, next) => {
    try {
      const ctx = canWrite(req, res);
      if (!ctx) return;
      const tenantId = companyOnly(req, res, ctx);
      if (!tenantId) return;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!data.length) throw new TmsError('El archivo está vacío.');
      const fileName = decodeURIComponent(String(req.get('x-file-name') ?? 'archivo.csv'));
      const parsed = parseFuelRows(await readSpreadsheet(data, fileName));
      if (parsed.missingColumns.length) {
        res.status(400).json({ error: `No encuentro las columnas: ${parsed.missingColumns.join(', ')}. Revisá que la primera fila tenga los títulos.`, missingColumns: parsed.missingColumns });
        return;
      }
      if (req.query.dryRun === 'true') {
        const plates = new Set(costs().plates(tenantId));
        res.json({
          rows: parsed.rows.slice(0, 200).map((r) => ({ ...r, error: r.error ?? (plates.has(r.plate.replace(/[^A-Z0-9]/g, '')) ? undefined : `patente ${r.plate} no es de la empresa`) })),
          total: parsed.rows.length,
        });
        return;
      }
      res.json(await costs().importFuel(tenantId, parsed.rows, actorOf(ctx)));
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- expenses

  app.get('/api/costs/expenses', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    const s = str(req.query.status);
    res.json({
      items: costs().listExpenses(scopeOf(req, ctx), {
        status: s === 'pendiente' || s === 'aprobado' || s === 'rechazado' ? s : undefined,
        tripId: str(req.query.tripId) || undefined,
        driverId: str(req.query.driverId) || undefined,
      }),
    });
  });

  app.post('/api/costs/expenses', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.tripExpense, req, res);
    if (!body) return;
    const tenantId = companyOnly(req, res, ctx);
    if (!tenantId) return;
    // Loaded from the panel by someone who can approve: approved directly.
    res.status(201).json({ expense: costs().addExpense(tenantId, body, actorOf(ctx), 'panel', actorOf(ctx).canOverride) });
  });

  app.post('/api/costs/expenses/:id/review', (req, res) => {
    const ctx = requireOverride(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.reviewExpense, req, res);
    if (!body) return;
    res.json({ expense: costs().reviewExpense(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)) });
  });

  // ---------------------------------------------------------------- trip cost & profitability

  app.get('/api/costs/trips/:id', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ economics: costs().tripEconomics(scopeOf(req, ctx), req.params.id) });
  });

  const profitParams = (req: express.Request) => {
    const g = str(req.query.groupBy);
    return {
      from: dateParam(req.query.from, monthStart()),
      to: dateParam(req.query.to, today()),
      groupBy: (g === 'cliente' || g === 'unidad' || g === 'chofer' ? g : 'viaje') as 'viaje' | 'cliente' | 'unidad' | 'chofer',
    };
  };

  app.get('/api/costs/profitability', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    const p = profitParams(req);
    res.json({ ...costs().profitability(scopeOf(req, ctx), p.from, p.to, p.groupBy), ...p });
  });

  app.get('/api/costs/profitability/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const scope = scopeOf(req, ctx);
    const p = profitParams(req);
    const data = costs().profitability(scope, p.from, p.to, p.groupBy);
    const report = profitabilityReport(data, p.groupBy, p.from, p.to, { company: companyName(scope), generatedBy: ctx.user.name, currency: moneyOf(scope) });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase(`rentabilidad-${p.groupBy}`, companyName(scope)), 'Operaciones · Costos');
  });

  // ---------------------------------------------------------------- pre-invoices

  app.get('/api/costs/billable', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    const b = costs().billable(scopeOf(req, ctx), str(req.query.customerId), dateParam(req.query.from, monthStart()), dateParam(req.query.to, today()));
    res.json({ priced: b.priced.map((o) => ({ id: o.id, deliveredAt: o.deliveredAt, reference: o.reference, cargo: o.cargo.description, charge: o.charge })), unpriced: b.unpriced });
  });

  app.get('/api/costs/pre-invoices', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: costs().listPreInvoices(scopeOf(req, ctx)) });
  });

  app.post('/api/costs/pre-invoices', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createPreInvoice, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    res.status(201).json({ preInvoice: costs().createPreInvoice({ tenantId }, tenantId, body, actorOf(ctx)) });
  });

  app.post('/api/costs/pre-invoices/:id/issue', (req, res) => {
    const ctx = requireOverride(req, res);
    if (!ctx) return;
    res.json({ preInvoice: costs().issuePreInvoice(scopeOf(req, ctx), req.params.id, actorOf(ctx)) });
  });

  app.post('/api/costs/pre-invoices/:id/void', (req, res) => {
    const ctx = requireOverride(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.cancelWithReason, req, res);
    if (!body) return;
    res.json({ preInvoice: costs().voidPreInvoice(scopeOf(req, ctx), req.params.id, body.reason, actorOf(ctx)) });
  });

  /** PDF / Excel / CSV of a pre-invoice. */
  app.get('/api/costs/pre-invoices/:id/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const pf = costs().preInvoice(scopeOf(req, ctx), req.params.id);
    const scope = { tenantId: pf.tenantId };
    const report = preInvoiceReport(pf, pf.customer, pf.tenant, { company: pf.tenant?.name ?? '', generatedBy: ctx.user.name, currency: moneyOf(scope) });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase(`prefactura-${pf.id}`, pf.customer?.name ?? ''), 'Operaciones · Costos');
  });

  // ---------------------------------------------------------------- driver settlements

  app.get('/api/costs/settlements', (req, res) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    noStore(res);
    res.json({ items: costs().listSettlements(scopeOf(req, ctx)) });
  });

  app.post('/api/costs/settlements', (req, res) => {
    const ctx = canWrite(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createSettlement, req, res);
    if (!body) return;
    res.status(201).json({ settlement: costs().createSettlement(scopeOf(req, ctx), body, actorOf(ctx)) });
  });

  app.post('/api/costs/settlements/:id/:action(pay|void)', (req, res) => {
    const ctx = requireOverride(req, res);
    if (!ctx) return;
    res.json({ settlement: costs().setSettlementStatus(scopeOf(req, ctx), req.params.id, req.params.action === 'pay' ? 'pagada' : 'anulada', actorOf(ctx)) });
  });

  app.get('/api/costs/settlements/:id/export', (req, res, next) => {
    const ctx = canRead(req, res);
    if (!ctx) return;
    const s = costs().settlement(scopeOf(req, ctx), req.params.id);
    const report = settlementReport(s, { company: s.tenant?.name ?? '', generatedBy: ctx.user.name, currency: moneyOf({ tenantId: s.tenantId }) });
    void respondWithReport(res, next, exportActor(ctx), report, parseFormat(req.query.format), exportFileBase(`liquidacion-${s.id}`, s.driverName), 'Operaciones · Costos');
  });

  app.put('/api/costs/drivers/:id/monthly-cost', (req, res) => {
    const ctx = requireOverride(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.driverMonthlyCost, req, res);
    if (!body) return;
    const d = costs().setDriverMonthlyCost(scopeOf(req, ctx), req.params.id, body.monthlyCost, actorOf(ctx));
    res.json({ monthlyCost: d.monthlyCost ?? null });
  });
}
