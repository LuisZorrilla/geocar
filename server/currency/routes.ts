import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { RATE_SOURCES, fetchSuggestion, findSource, sourcesFor, type RateSuggestion } from './sources.ts';
import type { CurrencyActor } from './service.ts';

interface Ctx {
  user: { name: string; isHiddenSuperadmin?: boolean };
  role: { name: string };
}

interface Deps<C extends Ctx> {
  requireAuth: (req: express.Request, res: express.Response) => C | null;
  /** Fetch used by the suggestion (tests replace it; they never go to the network). */
  fetchImpl?: Parameters<typeof fetchSuggestion>[1];
}

const SUPER_ONLY = 'Solo el superadmin de la plataforma puede gestionar monedas y tipos de cambio.';

/**
 * Currencies and exchange rates. Reading is open to every signed-in user (the panel needs the
 * rates to show equivalents); every change is reserved to the platform superadmin.
 */
export function registerCurrencyRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const svc = () => fleetStore.currency;

  const requireSuper = (req: express.Request, res: express.Response): C | null => {
    const ctx = deps.requireAuth(req, res);
    if (!ctx) return null;
    if (!ctx.user.isHiddenSuperadmin) {
      res.status(403).json({ error: SUPER_ONLY });
      return null;
    }
    return ctx;
  };
  const actor = (ctx: C): CurrencyActor => ({ name: ctx.user.name, role: ctx.role.name, hidden: true });
  const snapshot = () => ({
    currencies: svc().list(),
    exchangeRates: svc().ratesForClient(),
    platformReferenceCurrency: svc().platformReferenceCurrency,
    usage: svc().usage(),
  });

  app.get('/api/currencies', (req, res) => {
    const ctx = deps.requireAuth(req, res);
    if (!ctx) return;
    if (ctx.user.isHiddenSuperadmin) {
      res.json({ ...snapshot(), sources: RATE_SOURCES.map(({ id, currency, label, url }) => ({ id, currency, label, url })) });
      return;
    }
    res.json({ currencies: svc().list().filter((c) => c.enabled), exchangeRates: svc().ratesForClient() });
  });

  app.patch('/api/currencies/:code', (req, res) => {
    const ctx = requireSuper(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updateCurrency, req, res);
    if (!body) return;
    if (body.suggestSource !== undefined && body.suggestSource !== '' && findSource(body.suggestSource)?.currency !== req.params.code) {
      res.status(400).json({ error: 'Esa fuente no corresponde a la moneda.' });
      return;
    }
    const currency = svc().updateCurrency(req.params.code, body, actor(ctx));
    res.json({ currency, ...snapshot() });
  });

  app.post('/api/currencies/:code/rates', (req, res) => {
    const ctx = requireSuper(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.addExchangeRate, req, res);
    if (!body) return;
    const rate = svc().addRate(req.params.code, body, actor(ctx));
    res.status(201).json({ rate, ...snapshot() });
  });

  app.get('/api/currencies/rates/history', (req, res) => {
    if (!requireSuper(req, res)) return;
    const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]).slice(0, 40) : undefined);
    res.json({ rates: svc().history(q('code'), q('from'), q('to')) });
  });

  /** Suggested rate from public sources; it is NOT saved (the superadmin confirms it). */
  app.get('/api/currencies/rates/suggest', async (req, res, next) => {
    try {
      if (!requireSuper(req, res)) return;
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const sourceId = typeof req.query.source === 'string' ? req.query.source : undefined;
      const wanted = sourceId
        ? [findSource(sourceId)].filter((s) => s !== undefined)
        : code
          ? sourcesFor(code)
          : svc()
              .list()
              .filter((c) => c.enabled && c.suggestSource)
              .map((c) => findSource(c.suggestSource))
              .filter((s) => s !== undefined);
      const suggestions: RateSuggestion[] = await Promise.all(wanted.map((s) => fetchSuggestion(s, deps.fetchImpl)));
      res.json({ suggestions });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/settings/platform-currency', async (req, res, next) => {
    try {
      const ctx = requireSuper(req, res);
      if (!ctx) return;
      const body = parseBody(schemas.platformReferenceCurrency, req, res);
      if (!body) return;
      await svc().setPlatformReference(body.currency, actor(ctx));
      res.json(snapshot());
    } catch (err) {
      next(err);
    }
  });

  // ---- Company currency ----

  app.get('/api/tenants/:id/currency/preview', (req, res) => {
    if (!requireSuper(req, res)) return;
    const to = typeof req.query.to === 'string' ? req.query.to : '';
    res.json({ preview: svc().previewTenantCurrency(req.params.id, to), changes: svc().changesOf(req.params.id) });
  });

  app.put('/api/tenants/:id/currency', (req, res) => {
    const ctx = requireSuper(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.setTenantCurrency, req, res);
    if (!body) return;
    const result = svc().setTenantCurrency(req.params.id, body.currency, body.mode, actor(ctx));
    res.json({ ...result, tenants: fleetStore.listTenantSummaries(), ...snapshot() });
  });
}
