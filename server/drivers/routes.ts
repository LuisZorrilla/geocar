import express from 'express';
import { DRIVER_FILE_MAX_BYTES, type DriverAuthState, type DriverDocType, type DriverProfile } from '../../src/shared/drivers.ts';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { parseBody } from '../validation/http.ts';
import { DriverError, type DriverActor, type DriverScope } from './registry.ts';
import { parseFormat } from '../export/report.ts';
import { driversReport } from '../export/reports.ts';
import { exportFileBase, respondWithReport } from '../export/send.ts';

/** The parts of the server's auth context this module needs. */
interface Ctx {
  user: { name: string; isHiddenSuperadmin?: boolean };
  tenant: { id: string };
  role: { name: string; isSystemAdminRole?: boolean };
}

interface Deps<C extends Ctx> {
  requireAuth: (req: express.Request, res: express.Response) => C | null;
  getRequestedScope: (req: express.Request, ctx: C) => string | undefined;
  targetTenantOrFail: (req: express.Request, res: express.Response, ctx: C) => string | null;
}

const DOC_TYPES = new Set<DriverDocType>([
  'dni',
  'licencia',
  'linti',
  'psicofisico',
  'cargas_peligrosas',
  'operador_maquinaria',
  'antecedentes',
  'libre_deuda',
  'art',
]);
const STATES = new Set<DriverAuthState>(['habilitado', 'por_vencer', 'pendiente', 'no_autorizado', 'deshabilitado']);
const PROFILES = new Set<DriverProfile>(['liviano', 'profesional', 'maquinaria']);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Driver registry API: only the platform superadmin and each company's admin role. */
export function registerDriverRoutes<C extends Ctx>(app: express.Express, deps: Deps<C>) {
  const requireDriverAdmin = (req: express.Request, res: express.Response): C | null => {
    const ctx = deps.requireAuth(req, res);
    if (!ctx) return null;
    if (!ctx.user.isHiddenSuperadmin && !ctx.role.isSystemAdminRole) {
      res.status(403).json({ error: 'Solo el superadmin y el administrador de la empresa pueden gestionar choferes.' });
      return null;
    }
    return ctx;
  };

  const scopeOf = (req: express.Request, ctx: C): DriverScope => {
    if (!ctx.user.isHiddenSuperadmin) return { tenantId: ctx.tenant.id };
    const scope = deps.getRequestedScope(req, ctx);
    return scope && scope !== 'all' ? { tenantId: scope } : { all: true };
  };

  const actorOf = (ctx: Ctx): DriverActor => ({
    name: ctx.user.name,
    role: ctx.role.name,
    hidden: Boolean(ctx.user.isHiddenSuperadmin),
  });

  const docTypeOf = (req: express.Request, res: express.Response): DriverDocType | null => {
    const t = req.params.type as DriverDocType;
    if (!DOC_TYPES.has(t)) {
      res.status(400).json({ error: 'Tipo de documento desconocido.' });
      return null;
    }
    return t;
  };

  const registry = () => fleetStore.driverRegistry;

  app.get('/api/drivers', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const state = str(req.query.state) as DriverAuthState;
    const profile = str(req.query.profile) as DriverProfile;
    const page = registry().list(scopeOf(req, ctx), {
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 10,
      q: str(req.query.q).slice(0, 80),
      state: STATES.has(state) ? state : undefined,
      branch: str(req.query.branch) || undefined,
      profile: PROFILES.has(profile) ? profile : undefined,
      sort: req.query.sort === 'expiry' ? 'expiry' : 'name',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(page);
  });

  // Same filters as the list, without paging, as PDF, Excel or CSV.
  app.get('/api/drivers/export', (req, res, next) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const state = str(req.query.state) as DriverAuthState;
    const profile = str(req.query.profile) as DriverProfile;
    const filters = {
      q: str(req.query.q).slice(0, 80) || undefined,
      state: STATES.has(state) ? state : undefined,
      branch: str(req.query.branch) || undefined,
      profile: PROFILES.has(profile) ? profile : undefined,
      sort: req.query.sort === 'expiry' ? ('expiry' as const) : ('name' as const),
    };
    const scope = scopeOf(req, ctx);
    const items = registry().listAll(scope, filters);
    const all = 'all' in scope;
    const company = all ? 'Todas las empresas' : (fleetStore.getTenantById(scope.tenantId)?.name ?? '');
    const report = driversReport(items, filters, {
      company,
      generatedBy: ctx.user.name,
      multiTenant: all,
      tenantName: (id) => fleetStore.getTenantById(id)?.name ?? '',
    });
    void respondWithReport(
      res,
      next,
      { tenantId: ctx.tenant.id, name: ctx.user.name, role: ctx.role.name, hidden: Boolean(ctx.user.isHiddenSuperadmin) },
      report,
      parseFormat(req.query.format),
      exportFileBase('choferes', all ? 'todas' : company),
      'Choferes'
    );
  });

  app.get('/api/drivers/availability', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const scope = scopeOf(req, ctx);
    const tenantId = ctx.user.isHiddenSuperadmin ? str(req.query.tenantId) || ('tenantId' in scope ? scope.tenantId : '') : ctx.tenant.id;
    if (!tenantId) {
      res.status(400).json({ error: 'Selecciona la empresa.' });
      return;
    }
    res.json(registry().availability(tenantId, { dni: str(req.query.dni), cuil: str(req.query.cuil), except: str(req.query.except) || undefined }));
  });

  app.get('/api/drivers/:id', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(registry().get(scopeOf(req, ctx), req.params.id));
  });

  app.post('/api/drivers', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.createDriver, req, res);
    if (!body) return;
    const tenantId = deps.targetTenantOrFail(req, res, ctx);
    if (!tenantId) return;
    const { tenantId: _ignored, ...input } = body;
    const driver = registry().create(tenantId, input, actorOf(ctx));
    res.status(201).json({ driver });
  });

  app.patch('/api/drivers/:id', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.updateDriver, req, res);
    if (!body) return;
    res.json(registry().update(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)));
  });

  app.post('/api/drivers/:id/disable', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.disableDriver, req, res);
    if (!body) return;
    res.json(registry().disable(scopeOf(req, ctx), req.params.id, body, actorOf(ctx)));
  });

  app.post('/api/drivers/:id/documents/:type/verify', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    const type = docTypeOf(req, res);
    if (!type) return;
    const body = parseBody(schemas.verifyDriverDocument, req, res);
    if (!body) return;
    res.json({ driver: registry().verifyDocument(scopeOf(req, ctx), req.params.id, type, body, actorOf(ctx)) });
  });

  app.post('/api/drivers/:id/enable', (req, res) => {
    const ctx = requireDriverAdmin(req, res);
    if (!ctx) return;
    res.json(registry().enable(scopeOf(req, ctx), req.params.id, actorOf(ctx)));
  });

  // Files travel as the raw request body; the type is checked against the bytes, not the header.
  app.put(
    '/api/drivers/:id/documents/:type/file',
    express.raw({ type: () => true, limit: DRIVER_FILE_MAX_BYTES }),
    async (req, res, next) => {
      try {
        const ctx = requireDriverAdmin(req, res);
        if (!ctx) return;
        const type = docTypeOf(req, res);
        if (!type) return;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let name = str(req.headers['x-file-name']);
        try {
          name = decodeURIComponent(name);
        } catch {
          /* keep the raw header */
        }
        const driver = await registry().setFile(scopeOf(req, ctx), req.params.id, type, body, name, actorOf(ctx));
        res.json({ driver });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/drivers/:id/documents/:type/file', async (req, res, next) => {
    try {
      const ctx = requireDriverAdmin(req, res);
      if (!ctx) return;
      const type = docTypeOf(req, res);
      if (!type) return;
      const file = await registry().getFile(scopeOf(req, ctx), req.params.id, type);
      res.setHeader('Content-Type', file.mime);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.end(file.data);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/drivers/:id/documents/:type/file', async (req, res, next) => {
    try {
      const ctx = requireDriverAdmin(req, res);
      if (!ctx) return;
      const type = docTypeOf(req, res);
      if (!type) return;
      const driver = await registry().deleteFile(scopeOf(req, ctx), req.params.id, type, actorOf(ctx));
      res.json({ driver });
    } catch (err) {
      next(err);
    }
  });
}

export { DriverError };
