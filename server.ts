import 'dotenv/config';
import express from 'express';
import path from 'path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { AlertPriority, ModulePermissions, RoleDefinition, Tenant } from './src/shared/types.ts';
import { DomainError, fleetStore, type ActiveSession } from './server/store.ts';
import * as schemas from './server/validation/schemas.ts';
import { parseBody } from './server/validation/http.ts';
import { traccarIngestRouter } from './server/ingest/traccar.ts';
import { tenantNameResolver, workOrdersToCsv } from './server/export/workOrders.ts';
import { parseFormat, type ExportFormat } from './server/export/report.ts';
import { alertsReport, fleetReport, vehicleReport, workOrdersReport, type ExportContext } from './server/export/reports.ts';
import { exportFileBase, respondWithReport, type ExportActor } from './server/export/send.ts';
import { DriverError, registerDriverRoutes } from './server/drivers/routes.ts';
import { CurrencyError } from './server/currency/service.ts';
import { registerTmsRoutes } from './server/tms/routes.ts';
import { registerDriverAppRoutes } from './server/tms/driverAppRoutes.ts';
import { registerCostsRoutes } from './server/tms/costsRoutes.ts';
import { registerRoutingRoutes } from './server/routing/routes.ts';
import { TmsError } from './server/tms/service.ts';
import { registerCurrencyRoutes } from './server/currency/routes.ts';
import * as traccar from './server/traccar/client.ts';
import { findObdCommand } from './src/shared/teltonika.ts';

const PORT = Number(process.env.PORT || 3000);

interface AuthContext {
  session: ActiveSession;
  tenant: Tenant;
  user: {
    id: string;
    name: string;
    username: string;
    tenantId: string;
    roleId: string;
    isCompanyAdmin: boolean;
    isHiddenSuperadmin?: boolean;
  };
  role: RoleDefinition;
}

function extractToken(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  // Tokens in the query string are intentionally not accepted: they leak into logs and browser history.
  return undefined;
}

function requireAuth(req: express.Request, res: express.Response): AuthContext | null {
  const token = extractToken(req);
  const resolved = fleetStore.resolveSession(token);
  if (!resolved) {
    res.status(401).json({ error: 'Sesión no válida o expirada. Inicia sesión nuevamente.' });
    return null;
  }
  // Temporary password: only the bootstrap (to know who is logged in) and the password change are allowed.
  if (resolved.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
    res.status(403).json({
      code: 'PASSWORD_CHANGE_REQUIRED',
      error: 'Debes cambiar tu contraseña temporal antes de continuar.',
    });
    return null;
  }
  return resolved;
}

const PASSWORD_CHANGE_ALLOWED = new Set(['/api/bootstrap', '/api/auth/change-password']);

/** Company management is reserved to the global superadmin. */
function requireSuperadmin(req: express.Request, res: express.Response): AuthContext | null {
  const ctx = requireAuth(req, res);
  if (!ctx) return null;
  if (!ctx.user.isHiddenSuperadmin) {
    res.status(403).json({ error: 'Solo el superadmin de la plataforma puede gestionar empresas.' });
    return null;
  }
  return ctx;
}

function hasWritePermission(role: RoleDefinition, module: keyof ModulePermissions): boolean {
  const lvl = role.permissions[module];
  return lvl === 'full' || lvl === 'write';
}

function getRequestedScope(req: express.Request, ctx: AuthContext): string | undefined {
  if (!ctx.user.isHiddenSuperadmin) return undefined;
  const fromQuery = typeof req.query.scopeTenantId === 'string' ? req.query.scopeTenantId.trim() : '';
  const fromHeader = typeof req.headers['x-tenant-scope'] === 'string' ? req.headers['x-tenant-scope'].trim() : '';
  return fromQuery || fromHeader || 'all';
}

const ALERT_PRIORITIES = new Set<AlertPriority>(['critica', 'alta', 'media', 'informativa']);

function exportActor(ctx: AuthContext): ExportActor {
  return { tenantId: ctx.tenant.id, name: ctx.user.name, role: ctx.role.name, hidden: Boolean(ctx.user.isHiddenSuperadmin) };
}

/** Company label and per-row company names for an export ("Todas las empresas" when the superadmin exports all). */
function exportContext(ctx: AuthContext, data: { tenant: { id: string; name: string }; availableTenants?: { id: string; name: string }[] }): ExportContext {
  const all = data.tenant.id === 'all';
  return {
    company: all ? 'Todas las empresas' : data.tenant.name,
    generatedBy: ctx.user.name,
    multiTenant: all,
    tenantName: tenantNameResolver((data.availableTenants ?? [data.tenant]) as Tenant[], data.tenant.name),
    currencyOf: (tenantId) => fleetStore.currency.find(fleetStore.currency.tenantCurrency(tenantId)) ?? null,
    ...(all
      ? {
          reference: fleetStore.currency.find(fleetStore.currency.platformReferenceCurrency),
          toReference: (tenantId: string, amount: number, dateIso: string) =>
            fleetStore.currency.convertTenantAmount(tenantId, amount, fleetStore.currency.platformReferenceCurrency, dateIso),
        }
      : {}),
  };
}

/**
 * Company that a create operation targets. Regular users always write to their own company.
 * The superadmin must name one (body.tenantId or the active scope); there is no silent default.
 * Returns null after answering 400 when the superadmin didn't pick a valid company.
 */
function targetTenantOrFail(req: express.Request, res: express.Response, ctx: AuthContext): string | null {
  if (!ctx.user.isHiddenSuperadmin) return ctx.tenant.id;
  const bodyTenant = typeof req.body?.tenantId === 'string' ? req.body.tenantId.trim() : '';
  const scope = getRequestedScope(req, ctx);
  if (bodyTenant && bodyTenant !== 'all' && fleetStore.getTenantById(bodyTenant)) return bodyTenant;
  if (scope && scope !== 'all' && fleetStore.getTenantById(scope)) return scope;
  res.status(400).json({ error: 'Selecciona la empresa destino antes de registrar este elemento.' });
  return null;
}

async function startServer() {
  await fleetStore.init();
  // Documents expire with the calendar: re-evaluate drivers at startup and every hour.
  fleetStore.driverRegistry.sweep();
  setInterval(() => fleetStore.driverRegistry.sweep(), 60 * 60 * 1000).unref();
  // OBD-II history keeps 90 days.
  const purgeObd = () =>
    fleetStore
      .purgeObdHistory()
      .then((n) => n && console.log(`[obd] historial: ${n} muestras de más de 90 días borradas`))
      .catch((err) => console.error('[obd] purga del historial:', err));
  void purgeObd();
  setInterval(purgeObd, 24 * 60 * 60 * 1000).unref();
  // Driver phones: «sin señal» alerts when a unit depends on a silent phone.
  setInterval(() => fleetStore.sweepPhones(), 60 * 1000).unref();
  // TMS: stops advance with the units' positions; late deliveries raise one alert.
  setInterval(() => {
    try {
      fleetStore.tms.evaluateTrips();
    } catch (err) {
      console.error('[tms] Error al evaluar viajes:', err);
    }
    // Live ETAs (and the "expected delay" alert); async because it may call OSRM.
    fleetStore.routing.refreshEtas().catch((err) => console.error('[ruteo] Error al calcular ETAs:', err));
  }, 60 * 1000).unref();

  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(
    helmet({
      // The Vite dev server injects inline scripts; the map SDKs load remote tiles and workers.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // Every successful write response means the change is committed to PostgreSQL.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let flushed = false;
    const afterFlush = (send: () => void) => {
      if (flushed) return send();
      fleetStore.flush().then(
        () => {
          flushed = true;
          send();
        },
        (err) => {
          console.error(`[db] ${req.method} ${req.originalUrl}: no se pudo guardar`, err);
          flushed = true;
          res.status(500);
          originalJson({ error: 'No se pudo guardar el cambio. Intenta de nuevo.' });
        }
      );
      return res;
    };
    res.json = ((body: unknown) => afterFlush(() => originalJson(body))) as typeof res.json;
    res.send = ((body: unknown) => afterFlush(() => originalSend(body))) as typeof res.send;
    next();
  });

  // Traccar → platform (internal network; shared-secret auth, no user session)
  app.use('/ingest/traccar', traccarIngestRouter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' },
  });
  app.use('/api/auth', authLimiter);

  app.post('/api/auth/login', async (req, res) => {
    const parsed = schemas.login.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Ingresa usuario y contraseña de la empresa.' });
      return;
    }
    const { username, password } = parsed.data;
    try {
      const result = await fleetStore.authenticate(username, password, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const { ok: _ok, ...auth } = result;
      res.json(auth);
    } catch (err) {
      console.error('[auth] login:', err);
      res.status(500).json({ error: 'No fue posible iniciar sesión. Intenta de nuevo.' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = extractToken(req);
    if (token) await fleetStore.revokeSession(token);
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const body = parseBody(schemas.changePassword, req, res);
    if (!body) return;
    const { currentPassword, newPassword } = body;
    const result = await fleetStore.changeOwnPassword(
      ctx.user.id,
      ctx.session.tokenHash,
      currentPassword,
      newPassword
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  // Protected tenant-isolated bootstrap (or global scope for superadmin)
  app.get('/api/bootstrap', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const scope = getRequestedScope(req, ctx);
    const payload = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, scope);
    if (!payload) {
      res.status(404).json({ error: 'Empresa o usuario no disponible.' });
      return;
    }
    res.json(payload);
  });

  app.post('/api/telemetry/tick', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const scope = getRequestedScope(req, ctx);
    const vehicles = fleetStore.tickTelemetry(ctx.tenant.id, scope);
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, scope);
    res.json({
      vehicles,
      workOrders: data?.workOrders ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      // Alerts arrive from Traccar at any time (SOS, alarms): refresh them with the live tick.
      alerts: data?.alerts,
      incidents: data?.incidents,
      updatedAt: new Date().toISOString(),
    });
  });

  app.get('/api/maintenance/dashboard', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const scope = getRequestedScope(req, ctx);
    const metrics = fleetStore.getMaintenanceDashboardMetrics(ctx.tenant.id, scope);
    res.json(metrics);
  });

  // Company Admin: Custom Profiles & Permissions
  app.post('/api/roles', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isCompanyAdmin && ctx.role.permissions.administracion !== 'full') {
      res.status(403).json({ error: 'Solo el Admin de la empresa puede crear perfiles.' });
      return;
    }
    const body = parseBody(schemas.createRole, req, res);
    if (!body) return;
    const { name, description, permissions } = body;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const role = fleetStore.createRole(
      targetTenantId,
      { name, description, permissions },
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({ role, roles: data?.roles ?? [], auditLogs: data?.auditLogs ?? [] });
  });

  app.patch('/api/roles/:id', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isCompanyAdmin && ctx.role.permissions.administracion !== 'full') {
      res.status(403).json({ error: 'Solo el Admin de la empresa puede editar perfiles.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const body = parseBody(schemas.updateRole, req, res);
    if (!body) return;
    const role = fleetStore.updateRole(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!role) {
      res.status(404).json({ error: 'Perfil no encontrado o protegido.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ role, roles: data?.roles ?? [], auditLogs: data?.auditLogs ?? [] });
  });

  // Company Admin: Users (strictly excludes superadmin)
  app.post('/api/users', async (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isCompanyAdmin && ctx.role.permissions.administracion !== 'full') {
      res.status(403).json({ error: 'Solo el Admin de la empresa puede crear usuarios.' });
      return;
    }
    const body = parseBody(schemas.createUser, req, res);
    if (!body) return;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const { name, username, password, roleId } = body;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = await fleetStore.createUser(
      targetTenantId,
      { name, username, password, roleId },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (result.error || !result.user) {
      res.status(400).json({ error: result.error || 'No se pudo crear el usuario.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({ user: result.user, users: data?.users ?? [], auditLogs: data?.auditLogs ?? [] });
  });

  app.patch('/api/users/:id', async (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isCompanyAdmin && ctx.role.permissions.administracion !== 'full') {
      res.status(403).json({ error: 'Solo el Admin de la empresa puede actualizar usuarios.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const body = parseBody(schemas.updateUser, req, res);
    if (!body) return;
    const updated = await fleetStore.updateUser(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!updated) {
      res.status(404).json({ error: 'Usuario no encontrado en esta empresa.' });
      return;
    }
    if ('error' in updated) {
      res.status(400).json({ error: updated.error });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ user: updated, users: data?.users ?? [], auditLogs: data?.auditLogs ?? [] });
  });

  // Vehicles & Heavy Machinery
  app.post('/api/vehicles', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!hasWritePermission(ctx.role, 'flotas')) {
        res.status(403).json({ error: 'Tu perfil no tiene permisos para registrar unidades.' });
        return;
      }
      const body = parseBody(schemas.createVehicle, req, res);
      if (!body) return;
      const targetTenantId = targetTenantOrFail(req, res, ctx);
      if (!targetTenantId) return;
      const targetTenant = fleetStore.getTenantById(targetTenantId) ?? ctx.tenant;
      const created = fleetStore.createVehicle(
        targetTenantId,
        {
          branch: String(body.branch || targetTenant.branches[0]),
          group: String(body.group || ''),
          assetType: body.assetType === 'maquinaria_pesada' ? 'maquinaria_pesada' : 'vehiculo',
          unitCode: String(body.unitCode),
          plate: String(body.plate),
          brandModel: String(body.brandModel || 'Sin especificar'),
          brand: body.brand,
          model: body.model,
          year: Number(body.year || new Date().getFullYear()),
          driverName: String(body.driverName || 'Operador Asignado'),
          imei: body.imei ?? '',
          protocol: body.protocol === 'Traccar' || body.connection === 'obd' || body.connection === 'smartphone' ? 'Traccar' : 'JT808/JT1078',
          connection: body.connection,
          deviceModel: String(body.deviceModel || ''),
          deviceCatalogId: body.deviceCatalogId,
          driverId: body.driverId,
          engineHours: Number(body.engineHours || 120),
          odometerKm: Number(body.odometerKm || 1200),
        },
        ctx.user.name,
        ctx.role.name
      );
      // OBD-II tracker: create it in Traccar right away, as the OBD wizard does.
      if (body.connection === 'obd' && created.device) {
        await provisionInTraccar(created.device.id, created.device.imei, created.device.unitCode);
      }
      const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
      const device = created.device ? (data?.devices.find((d) => d.id === created.device!.id) ?? created.device) : null;
      res.status(201).json({ ...created, device, auditLogs: data?.auditLogs ?? [] });
    } catch (err) {
      next(err);
    }
  });

  registerDriverRoutes(app, { requireAuth, getRequestedScope, targetTenantOrFail });
  registerCurrencyRoutes(app, { requireAuth });
  registerTmsRoutes(app, { requireAuth, getRequestedScope, targetTenantOrFail });
  registerDriverAppRoutes(app);
  registerCostsRoutes(app, { requireAuth, getRequestedScope, targetTenantOrFail });
  registerRoutingRoutes(app, { requireAuth, getRequestedScope, targetTenantOrFail });

  app.get('/api/vehicles/:id/dossier', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const dossier = fleetStore.getVehicleDossier(
      ctx.tenant.id,
      req.params.id,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    if (!dossier) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
      return;
    }
    res.json(dossier);
  });

  // Unit dossier as PDF, Excel or CSV (?format=pdf|xlsx|csv, CSV by default).
  app.get('/api/vehicles/:id/export', (req, res, next) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const dossier = fleetStore.getVehicleDossier(
      ctx.tenant.id,
      req.params.id,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    if (!dossier) {
      res.status(404).json({ error: 'Unidad no encontrada.' });
      return;
    }
    const tenantName = fleetStore.getTenantById(dossier.vehicle.tenantId)?.name ?? ctx.tenant.name;
    const report = vehicleReport(dossier, {
      company: tenantName,
      generatedBy: ctx.user.name,
      multiTenant: false,
      tenantName: () => tenantName,
    });
    const format = parseFormat(req.query.format);
    void respondWithReport(res, next, exportActor(ctx), report, format, exportFileBase(`ficha-${dossier.vehicle.unitCode}`, tenantName), 'Flotas y Maquinaria');
  });

  app.post('/api/maintenance', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para registrar mantenimientos.' });
      return;
    }
    const body = parseBody(schemas.addMaintenance, req, res);
    if (!body) return;
    const { vehicleId, type, title, workshopOrTech, cost, notes, nextServiceDate, clearFaults } = body;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.addMaintenanceRecord(
      ctx.tenant.id,
      String(vehicleId),
      {
        type: type === 'correctivo' || type === 'inspeccion' ? type : 'preventivo',
        title: String(title),
        workshopOrTech: String(workshopOrTech || 'Taller Interno'),
        cost: Number(cost || 0),
        notes: String(notes || ''),
        nextServiceDate: typeof nextServiceDate === 'string' ? nextServiceDate : undefined,
        clearFaults: Boolean(clearFaults),
      },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      ...result,
      maintenanceRecords: data?.maintenanceRecords ?? [],
      partsInventory: data?.partsInventory ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/devices/:id/validate', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'dispositivos')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para validar dispositivos.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const dev = fleetStore.validateDevice(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!dev) {
      res.status(404).json({ error: 'Dispositivo no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ device: dev, auditLogs: data?.auditLogs ?? [] });
  });

  // Full Fleet Maintenance: Work Orders, Preventive Plans & Pre-Op Checklists
  app.post('/api/work-orders', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para abrir órdenes de trabajo.' });
      return;
    }
    const body = parseBody(schemas.createWorkOrder, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const workOrder = fleetStore.createWorkOrder(
      ctx.tenant.id,
      {
        vehicleId: String(body.vehicleId),
        planId: typeof body.planId === 'string' && body.planId ? body.planId : undefined,
        type: body.type === 'correctivo' || body.type === 'inspeccion' ? body.type : 'preventivo',
        priority:
          body.priority === 'baja' || body.priority === 'alta' || body.priority === 'critica'
            ? body.priority
            : 'media',
        title: String(body.title),
        workshopOrTech: String(body.workshopOrTech || 'Taller Central Certificado'),
        scheduledDate: String(body.scheduledDate || new Date().toISOString().slice(0, 10)),
        parts: body.parts ?? [],
        laborCost: Number(body.laborCost || 0),
        laborCurrency: body.laborCurrency,
        notes: String(body.notes || ''),
        clearFaultsOnClose: Boolean(body.clearFaultsOnClose ?? true),
      },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!workOrder) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      workOrder,
      workOrders: data?.workOrders ?? [],
      partsInventory: data?.partsInventory ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  // All work orders (any status) for the company in scope, as PDF, Excel or CSV.
  // The CSV keeps its original columns (WORK_ORDER_CSV_HEADER) for whoever already imports it.
  app.get('/api/work-orders/export', (req, res, next) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (ctx.role.permissions.flotas === 'none') {
      res.status(403).json({ error: 'Tu perfil no tiene acceso a las órdenes de trabajo.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    if (!data) {
      res.status(404).json({ error: 'Empresa o usuario no disponible.' });
      return;
    }
    const ectx = exportContext(ctx, data);
    const format = parseFormat(req.query.format);
    const fileBase = exportFileBase('ordenes-trabajo', ectx.multiTenant ? 'todas' : data.tenant.name);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(workOrdersToCsv(data.workOrders, ectx.tenantName, (id) => fleetStore.currency.tenantCurrency(id)));
      return;
    }
    void respondWithReport(res, next, exportActor(ctx), workOrdersReport(data.workOrders, ectx), format, fileBase, 'Mantenimiento');
  });

  app.patch('/api/work-orders/:id', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para actualizar órdenes de trabajo.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const body = parseBody(schemas.updateWorkOrder, req, res);
    if (!body) return;
    const result = fleetStore.updateWorkOrder(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Orden de trabajo no encontrada en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      ...result,
      workOrders: data?.workOrders ?? [],
      vehicles: data?.vehicles ?? [],
      maintenanceRecords: data?.maintenanceRecords ?? [],
      partsInventory: data?.partsInventory ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/preventive-plans', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para crear planes preventivos.' });
      return;
    }
    const body = parseBody(schemas.createPreventivePlan, req, res);
    if (!body) return;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const plan = fleetStore.createPreventivePlan(
      targetTenantId,
      {
        name: String(body.name),
        assetType:
          body.assetType === 'vehiculo' || body.assetType === 'maquinaria_pesada' ? body.assetType : 'ambos',
        intervalHours: Number(body.intervalHours || 250),
        intervalKm: Number(body.intervalKm || 10000),
        intervalDays: Number(body.intervalDays || 45),
        estimatedCost: Number(body.estimatedCost || 0),
        checklistFocus: String(body.checklistFocus || 'Inspección general preventiva.'),
      },
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      plan,
      preventivePlans: data?.preventivePlans ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.patch('/api/preventive-plans/:id/toggle', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para modificar planes preventivos.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const plan = fleetStore.togglePreventivePlan(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!plan) {
      res.status(404).json({ error: 'Plan preventivo no encontrado.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      plan,
      preventivePlans: data?.preventivePlans ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.patch('/api/preventive-plans/:id', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para editar planes preventivos.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const body = parseBody(schemas.updatePreventivePlan, req, res);
    if (!body) return;
    const plan = fleetStore.updatePreventivePlan(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!plan) {
      res.status(404).json({ error: 'Plan preventivo no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      plan,
      preventivePlans: data?.preventivePlans ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/preventive-plans/:id/assign', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para asignar planes preventivos.' });
      return;
    }
    const body = parseBody(schemas.assignPreventivePlan, req, res);
    if (!body) return;
    const vehicleIds = body.vehicleIds;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.assignPreventivePlanToVehicles(
      ctx.tenant.id,
      req.params.id,
      vehicleIds,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Plan preventivo no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      ...result,
      vehicles: data?.vehicles ?? [],
      workOrders: data?.workOrders ?? [],
      preventivePlans: data?.preventivePlans ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/maintenance/evaluate-plans', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para ejecutar evaluación de planes preventivos.' });
      return;
    }
    const scope = getRequestedScope(req, ctx);
    const summary = fleetStore.runPreventiveAutoDispatch(
      ctx.tenant.id,
      scope,
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, scope);
    res.json({
      ...summary,
      vehicles: data?.vehicles ?? [],
      workOrders: data?.workOrders ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/parts-inventory', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para administrar el almacén de refacciones.' });
      return;
    }
    const body = parseBody(schemas.upsertPart, req, res);
    if (!body) return;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const item = fleetStore.upsertPartInventoryItem(
      targetTenantId,
      {
        sku: String(body.sku),
        name: String(body.name),
        category: body.category === 'insumo' ? 'insumo' : 'refaccion',
        unit: String(body.unit || 'pza'),
        stockQty: Number(body.stockQty ?? 0),
        minStock: Number(body.minStock ?? 2),
        unitCost: Number(body.unitCost ?? 0),
        unitCostCurrency: body.unitCostCurrency,
        warehouseLocation: String(body.warehouseLocation || 'Almacén Central'),
      },
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      item,
      partsInventory: data?.partsInventory ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.patch('/api/parts-inventory/:id/stock', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para ajustar existencias de almacén.' });
      return;
    }
    const body = parseBody(schemas.adjustStock, req, res);
    if (!body) return;
    const deltaQty = body.deltaQty;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const item = fleetStore.adjustPartInventoryStock(
      ctx.tenant.id,
      req.params.id,
      deltaQty,
      String(body.reason || 'Reabasto en taller'),
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!item) {
      res.status(404).json({ error: 'SKU no encontrado en el almacén de tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      item,
      partsInventory: data?.partsInventory ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/checklists', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'flotas') && ctx.role.permissions.monitoreo !== 'full') {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para registrar checklists pre-operativos.' });
      return;
    }
    const body = parseBody(schemas.createChecklist, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.createPreOpChecklist(
      ctx.tenant.id,
      {
        vehicleId: String(body.vehicleId),
        driverName: String(body.driverName || ''),
        shift: body.shift === 'Vespertino' || body.shift === 'Nocturno' ? body.shift : 'Matutino',
        items: body.items,
        summaryNote: String(body.summaryNote || ''),
        createWorkOrderIfFailed: Boolean(body.createWorkOrderIfFailed),
      },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      ...result,
      checklists: data?.checklists ?? [],
      workOrders: data?.workOrders ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  // Supervisor review of a pre-op checklist (the inspection itself stays unchanged).
  app.patch('/api/checklists/:id/review', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && !hasWritePermission(ctx.role, 'flotas')) {
      res.status(403).json({ error: 'Tu perfil no tiene permisos para revisar checklists pre-operativos.' });
      return;
    }
    const body = parseBody(schemas.reviewChecklist, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.reviewPreOpChecklist(
      ctx.tenant.id,
      String(req.params.id),
      { decision: body.decision, note: body.note ?? '', createWorkOrder: Boolean(body.createWorkOrder) },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Checklist no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      ...result,
      checklists: data?.checklists ?? [],
      workOrders: data?.workOrders ?? [],
      maintenanceDashboard: data?.maintenanceDashboard,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  // Dashcam Drivers & Capabilities Configuration (Exclusive Superadmin & Company Admin / Authorized Roles)
  app.post('/api/dashcam-drivers', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && !hasWritePermission(ctx.role, 'dashcams_config')) {
      res.status(403).json({ error: 'Solo Superadmin y Admin de Empresa (o perfil autorizado) pueden registrar drivers de dashcams.' });
      return;
    }
    const body = parseBody(schemas.createDashcamDriver, req, res);
    if (!body) return;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const driver = fleetStore.createDashcamDriver(
      targetTenantId,
      {
        vendorFamily:
          body.vendorFamily === 'jimi_concox' ||
          body.vendorFamily === 'teltonika_fmc' ||
          body.vendorFamily === 'hikvision_dahua'
            ? body.vendorFamily
            : 'howen_streamax',
        vendorName: String(body.vendorName),
        modelSeries: String(body.modelSeries),
        driverCode: String(body.driverCode),
        driverVersion: String(body.driverVersion || '1.0.0-CUSTOM'),
        protocol: body.protocol === 'Traccar' ? 'Traccar' : 'JT808/JT1078',
        defaultPort: Number(body.defaultPort || 6808),
        maxChannels: Number(body.maxChannels || 4),
        defaultBitrateKbps: Number(body.defaultBitrateKbps || 2048),
        supportedFeatures: {
          adas: Boolean(body.supportedFeatures?.adas),
          dms: Boolean(body.supportedFeatures?.dms),
          bsd: Boolean(body.supportedFeatures?.bsd),
          canJ1939: Boolean(body.supportedFeatures?.canJ1939),
          rs232: Boolean(body.supportedFeatures?.rs232),
          intercomAudio: Boolean(body.supportedFeatures?.intercomAudio),
          dualSdSsd: Boolean(body.supportedFeatures?.dualSdSsd),
          gSensor: Boolean(body.supportedFeatures?.gSensor ?? true),
        },
        notes: String(body.notes || ''),
      },
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({
      driver,
      dashcamDrivers: data?.dashcamDrivers ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.put('/api/devices/dashcam-config/batch', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && !hasWritePermission(ctx.role, 'dashcams_config')) {
      res.status(403).json({
        error:
          'Acceso restringido: solo Superadmin, Admin de Empresa o perfiles autorizados pueden configurar drivers y prestaciones de dashcams en lote.',
      });
      return;
    }
    const body = parseBody(schemas.batchDashcamConfig, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const updated = fleetStore.batchUpdateDeviceDashcamConfig(
      ctx.tenant.id,
      body.deviceIds,
      {
        driverId: String(body.driverId),
        tcpPort: Number(body.tcpPort || 6808),
        activeChannels: Array.isArray(body.activeChannels) ? body.activeChannels.map(String) : ['CH1 Frontal'],
        resolution:
          body.resolution === '720p_30fps' || body.resolution === '720p_15fps' ? body.resolution : '1080p_30fps',
        bitrateKbps: Number(body.bitrateKbps || 2048),
        gpsIntervalSec: Number(body.gpsIntervalSec || 15),
        preEventSec: Number(body.preEventSec || 10),
        postEventSec: Number(body.postEventSec || 15),
        gSensorThresholdG: Number(body.gSensorThresholdG || 0.65),
        features: {
          adasEnabled: Boolean(body.features?.adasEnabled),
          dmsEnabled: Boolean(body.features?.dmsEnabled),
          bsdEnabled: Boolean(body.features?.bsdEnabled),
          intercomEnabled: Boolean(body.features?.intercomEnabled),
          loopRecordingSd: Boolean(body.features?.loopRecordingSd ?? true),
          canBusEnabled: Boolean(body.features?.canBusEnabled),
          rs232Peripheral:
            body.features?.rs232Peripheral === 'rfid_operador' ||
            body.features?.rs232Peripheral === 'sensor_combustible' ||
            body.features?.rs232Peripheral === 'dualcam_uart'
              ? body.features.rs232Peripheral
              : 'ninguno',
        },
      },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!updated) {
      res.status(404).json({ error: 'Ninguno de los dispositivos o driver pertenecen a tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      updatedCount: updated.length,
      updatedDevices: updated,
      devices: data?.devices ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.put('/api/devices/:id/dashcam-config', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && !hasWritePermission(ctx.role, 'dashcams_config')) {
      res.status(403).json({ error: 'Acceso restringido: solo Superadmin, Admin de Empresa o perfiles autorizados pueden configurar drivers y prestaciones de dashcams.' });
      return;
    }
    const body = parseBody(schemas.updateDashcamConfig, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const device = fleetStore.updateDeviceDashcamConfig(
      ctx.tenant.id,
      req.params.id,
      {
        driverId: String(body.driverId),
        tcpPort: Number(body.tcpPort || 6808),
        activeChannels: Array.isArray(body.activeChannels) ? body.activeChannels.map(String) : ['CH1 Frontal'],
        resolution:
          body.resolution === '720p_30fps' || body.resolution === '720p_15fps' ? body.resolution : '1080p_30fps',
        bitrateKbps: Number(body.bitrateKbps || 2048),
        gpsIntervalSec: Number(body.gpsIntervalSec || 15),
        preEventSec: Number(body.preEventSec || 10),
        postEventSec: Number(body.postEventSec || 15),
        gSensorThresholdG: Number(body.gSensorThresholdG || 0.65),
        features: {
          adasEnabled: Boolean(body.features?.adasEnabled),
          dmsEnabled: Boolean(body.features?.dmsEnabled),
          bsdEnabled: Boolean(body.features?.bsdEnabled),
          intercomEnabled: Boolean(body.features?.intercomEnabled),
          loopRecordingSd: Boolean(body.features?.loopRecordingSd ?? true),
          canBusEnabled: Boolean(body.features?.canBusEnabled),
          rs232Peripheral:
            body.features?.rs232Peripheral === 'rfid_operador' ||
            body.features?.rs232Peripheral === 'sensor_combustible' ||
            body.features?.rs232Peripheral === 'dualcam_uart'
              ? body.features.rs232Peripheral
              : 'ninguno',
        },
      },
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!device) {
      res.status(404).json({ error: 'Dispositivo o driver no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      device,
      devices: data?.devices ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.put('/api/devices/:id/connection', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && !hasWritePermission(ctx.role, 'dashcams_config')) {
      res.status(403).json({ error: 'Tu perfil no puede modificar la conexión de los equipos.' });
      return;
    }
    const body = parseBody(schemas.updateDeviceConnection, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const device = fleetStore.updateDeviceConnection(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!device) {
      res.status(404).json({ error: 'Equipo no encontrado en tu empresa.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      device,
      devices: data?.devices ?? [],
      unmatchedDevices: data?.unmatchedDevices,
      auditLogs: data?.auditLogs ?? [],
    });
  });

  // ---- OBD-II telemetry device of a unit (same permission as the camera connection) -----------
  const obdResponse = (req: express.Request, ctx: AuthContext) => {
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    return {
      vehicles: data?.vehicles ?? [],
      devices: data?.devices ?? [],
      unmatchedDevices: data?.unmatchedDevices,
      auditLogs: data?.auditLogs ?? [],
    };
  };

  const canConfigObd = (ctx: AuthContext, res: express.Response) => {
    if (ctx.user.isHiddenSuperadmin || hasWritePermission(ctx.role, 'dashcams_config')) return true;
    res.status(403).json({ error: 'Tu perfil no puede configurar equipos OBD-II.' });
    return false;
  };

  /** Creates (or renames) the tracker in Traccar and records the outcome on the device. Never throws. */
  const provisionInTraccar = async (deviceId: string, imei: string, unitCode: string) => {
    if (!traccar.isTraccarConfigured()) {
      fleetStore.setObdProvisioning(deviceId, {
        status: 'manual',
        message: 'La API de Traccar no está configurada: crea el dispositivo en Traccar con Identificador = IMEI.',
      });
      return;
    }
    try {
      const t = await traccar.ensureDevice({ uniqueId: imei, name: `${unitCode} OBD` });
      fleetStore.setObdProvisioning(deviceId, { traccarId: t.id, status: 'pendiente_sms' });
    } catch (err) {
      fleetStore.setObdProvisioning(deviceId, { status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const removeFromTraccar = async (traccarId?: number) => {
    if (!traccarId || !traccar.isTraccarConfigured()) return;
    await traccar.deleteDevice(traccarId).catch((err) => console.warn('[obd] no se pudo borrar el equipo en Traccar:', err.message));
  };

  app.put('/api/vehicles/:id/obd', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const body = parseBody(schemas.assignObdDevice, req, res);
      if (!body) return;
      const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
      const prev = fleetStore.getObdDevice(ctx.tenant.id, req.params.id, isSuper)?.device;
      const prevImei = prev?.imei;
      const prevTraccarId = prev?.traccarId;
      const device = fleetStore.assignObdDevice(ctx.tenant.id, req.params.id, body, ctx.user.name, ctx.role.name, isSuper, isSuper);
      if (!device) {
        res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
        return;
      }
      if (prevImei && prevImei !== device.imei) await removeFromTraccar(prevTraccarId);
      await provisionInTraccar(device.id, device.imei, device.unitCode);
      res.json({ device, ...obdResponse(req, ctx) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Driver smartphones (Traccar Client) -------------------------------------------
  /** Creates the phone in Traccar and records the outcome. Never throws. */
  const provisionPhone = async (driverId: string, identifier: string, driverName: string) => {
    if (!traccar.isTraccarConfigured()) {
      fleetStore.setPhoneProvisioning(driverId, {
        status: 'manual',
        message: 'La API de Traccar no está configurada: crea el dispositivo en Traccar con Identificador = ' + identifier + '.',
      });
      return;
    }
    try {
      const t = await traccar.ensureDevice({ uniqueId: identifier, name: `Celular · ${driverName}` });
      fleetStore.setPhoneProvisioning(driverId, { traccarId: t.id, status: 'pendiente_app' });
    } catch (err) {
      fleetStore.setPhoneProvisioning(driverId, { status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const phoneScope = (req: express.Request, ctx: AuthContext) =>
    ctx.user.isHiddenSuperadmin ? (getRequestedScope(req, ctx) ?? 'all') : ctx.tenant.id;

  /** Addresses programmed into the cameras (global: superadmin only). Body { server: { host, jt808Port, videoHost?, jt1078Port } | null }. */
  app.put('/api/settings/camera-server', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!ctx.user.isHiddenSuperadmin) {
        res.status(403).json({ error: 'Solo el superadmin de la plataforma puede cambiar el servidor de las cámaras: es el mismo para todas las empresas.' });
        return;
      }
      const body = parseBody(schemas.cameraServer, req, res);
      if (!body) return;
      res.json({ deviceConnection: await fleetStore.setCameraServer(body.server, ctx.user.name, ctx.role.name) });
    } catch (err) {
      next(err);
    }
  });

  /** Host/port programmed into OBD-II trackers (global: superadmin only). Body { server: { host, port } | null }. */
  app.put('/api/settings/obd-server', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!ctx.user.isHiddenSuperadmin) {
        res.status(403).json({ error: 'Solo el superadmin de la plataforma puede cambiar el servidor de los OBD-II: es el mismo para todas las empresas.' });
        return;
      }
      const body = parseBody(schemas.obdServer, req, res);
      if (!body) return;
      res.json({ deviceConnection: await fleetStore.setObdServer(body.server, ctx.user.name, ctx.role.name) });
    } catch (err) {
      next(err);
    }
  });

  /** Server URL for Traccar Client (global: superadmin only). Body { url: string | null }. */
  app.put('/api/settings/phone-server-url', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      if (!ctx.user.isHiddenSuperadmin) {
        res.status(403).json({ error: 'Solo el superadmin de la plataforma puede cambiar la URL de los celulares: es la misma para todas las empresas.' });
        return;
      }
      const body = parseBody(schemas.phoneServerUrl, req, res);
      if (!body) return;
      res.json({ deviceConnection: await fleetStore.setPhoneServerUrl(body.url, ctx.user.name, ctx.role.name) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/phones', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin && (ctx.role.permissions.dashcams_config ?? 'none') === 'none') {
      res.status(403).json({ error: 'Tu perfil no puede ver los celulares de los choferes.' });
      return;
    }
    res.json({ phones: fleetStore.listPhones(phoneScope(req, ctx)), traccarApi: traccar.isTraccarConfigured() });
  });

  app.put('/api/drivers/:id/phone', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const body = parseBody(schemas.assignDriverPhone, req, res);
      if (!body) return;
      const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
      const { driver, oldTraccarId } = fleetStore.assignDriverPhone(ctx.tenant.id, req.params.id, body, ctx.user.name, ctx.role.name, isSuper, isSuper);
      await removeFromTraccar(oldTraccarId);
      await provisionPhone(driver.id, driver.phoneTracker!.identifier, driver.name);
      res.json({ phones: fleetStore.listPhones(phoneScope(req, ctx)), tracker: driver.phoneTracker });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/drivers/:id/phone/sync', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const driver = fleetStore.getDriverPhone(ctx.tenant.id, req.params.id, Boolean(ctx.user.isHiddenSuperadmin));
      if (!driver.phoneTracker) {
        res.status(404).json({ error: 'El chofer no tiene celular conectado.' });
        return;
      }
      await provisionPhone(driver.id, driver.phoneTracker.identifier, driver.name);
      res.json({ phones: fleetStore.listPhones(phoneScope(req, ctx)), tracker: driver.phoneTracker });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/drivers/:id/phone', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
      const removed = fleetStore.removeDriverPhone(ctx.tenant.id, req.params.id, ctx.user.name, ctx.role.name, isSuper, isSuper);
      await removeFromTraccar(removed.traccarId);
      res.json({ phones: fleetStore.listPhones(phoneScope(req, ctx)) });
    } catch (err) {
      next(err);
    }
  });

  /** Current state of the unit's tracker (polled by the connection wizard and the unit detail). */
  app.get('/api/vehicles/:id/obd', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const found = fleetStore.getObdDevice(ctx.tenant.id, req.params.id, Boolean(ctx.user.isHiddenSuperadmin));
    if (!found) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
      return;
    }
    res.json({ vehicle: found.vehicle, device: found.device ?? null, traccarApi: traccar.isTraccarConfigured() });
  });

  /** Retries the Traccar registration (after fixing credentials or connectivity). */
  app.post('/api/vehicles/:id/obd/sync', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const found = fleetStore.getObdDevice(ctx.tenant.id, req.params.id, Boolean(ctx.user.isHiddenSuperadmin));
      if (!found?.device) {
        res.status(404).json({ error: 'La unidad no tiene un equipo OBD-II en tu empresa.' });
        return;
      }
      await provisionInTraccar(found.device.id, found.device.imei, found.device.unitCode);
      res.json({ device: found.device, ...obdResponse(req, ctx) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/vehicles/:id/obd', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
      const removed = fleetStore.removeObdDevice(ctx.tenant.id, req.params.id, ctx.user.name, ctx.role.name, isSuper, isSuper);
      if (!removed) {
        res.status(404).json({ error: 'La unidad no tiene un equipo OBD-II en tu empresa.' });
        return;
      }
      await removeFromTraccar(removed.traccarId);
      res.json(obdResponse(req, ctx));
    } catch (err) {
      next(err);
    }
  });

  /** Remote configuration: only the predefined Teltonika commands (no free text). */
  app.post('/api/vehicles/:id/obd/commands', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx || !canConfigObd(ctx, res)) return;
      const body = parseBody(schemas.obdCommand, req, res);
      if (!body) return;
      const def = findObdCommand(body.commandId);
      const text = def?.build(body.option);
      if (!def || !text) {
        res.status(400).json({ error: 'Comando u opción no válidos.' });
        return;
      }
      const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
      const found = fleetStore.getObdDevice(ctx.tenant.id, req.params.id, isSuper);
      if (!found?.device) {
        res.status(404).json({ error: 'La unidad no tiene un equipo OBD-II en tu empresa.' });
        return;
      }
      const dev = found.device;
      if (!dev.traccarId || !traccar.isTraccarConfigured()) {
        res.status(409).json({ error: 'El equipo no está dado de alta en Traccar desde el panel. Usa «Reintentar alta» primero.' });
        return;
      }
      const label = def.options ? `${def.label}: ${def.options.find((o) => o.id === body.option)?.label ?? ''}` : def.label;
      let status: 'enviado' | 'en_cola' | 'error';
      let response: string | undefined;
      try {
        status = await traccar.sendCustomCommand(dev.traccarId, text);
      } catch (err) {
        status = 'error';
        response = err instanceof Error ? err.message : String(err);
      }
      const entry = fleetStore.recordObdCommand(
        dev.id,
        { actorName: ctx.user.name, commandId: def.id, label, text, status, response },
        ctx.role.name,
        isSuper
      );
      res.status(status === 'error' ? 502 : 200).json({
        entry,
        error: status === 'error' ? `No se pudo enviar el comando. ${response}` : undefined,
        ...obdResponse(req, ctx),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/vehicles/:id/obd/history', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const range = req.query.range === '7d' || req.query.range === '30d' ? req.query.range : '24h';
      const points = await fleetStore.getObdHistory(ctx.tenant.id, req.params.id, range, Boolean(ctx.user.isHiddenSuperadmin));
      if (!points) {
        res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
        return;
      }
      res.json({ range, points });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/vehicles/:id/obd/faults', async (req, res, next) => {
    try {
      const ctx = requireAuth(req, res);
      if (!ctx) return;
      const faults = await fleetStore.getObdFaultHistory(ctx.tenant.id, req.params.id, Boolean(ctx.user.isHiddenSuperadmin));
      if (!faults) {
        res.status(404).json({ error: 'Unidad no encontrada en tu empresa.' });
        return;
      }
      res.json({ faults });
    } catch (err) {
      next(err);
    }
  });

  // ---- Companies (superadmin only) ------------------------------------------------
  app.get('/api/tenants', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    res.json({ tenants: fleetStore.listTenantSummaries() });
  });

  app.get('/api/tenants/availability', (req, res) => {
    if (!requireSuperadmin(req, res)) return;
    const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]).slice(0, 160) : undefined);
    res.json(fleetStore.checkTenantAvailability({ cuit: q('cuit'), username: q('username'), name: q('name'), exceptTenantId: q('except') }));
  });

  app.post('/api/tenants', async (req, res, next) => {
    try {
      const ctx = requireSuperadmin(req, res);
      if (!ctx) return;
      const body = parseBody(schemas.createTenant, req, res);
      if (!body) return;
      const result = await fleetStore.createTenantWithAdmin(body, ctx.user.name);
      res.setHeader('Cache-Control', 'no-store'); // contains the temporary password
      res.status(201).json({ ...result, tenants: fleetStore.listTenantSummaries() });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/tenants/:id', async (req, res, next) => {
    try {
      const ctx = requireSuperadmin(req, res);
      if (!ctx) return;
      const body = parseBody(schemas.updateTenant, req, res);
      if (!body) return;
      const tenant = await fleetStore.updateTenant(req.params.id, body, ctx.user.name);
      res.json({ tenant, tenants: fleetStore.listTenantSummaries() });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/tenants/:id/reset-admin-password', async (req, res, next) => {
    try {
      const ctx = requireSuperadmin(req, res);
      if (!ctx) return;
      const result = await fleetStore.resetTenantAdminPassword(req.params.id, ctx.user.name);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/alerts/:id/acknowledge', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'alertas')) {
      res.status(403).json({ error: 'Tu perfil no puede confirmar alertas.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const alert = fleetStore.acknowledgeAlert(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!alert) {
      res.status(404).json({ error: 'Alerta no encontrada.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      alert,
      vehicles: data?.vehicles ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/alerts/:id/escalate', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'incidentes')) {
      res.status(403).json({ error: 'Tu perfil no puede escalar incidentes.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.escalateAlert(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!result) {
      res.status(404).json({ error: 'Alerta no encontrada.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      ...result,
      incidents: data?.incidents ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.patch('/api/incidents/:id', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'incidentes')) {
      res.status(403).json({ error: 'Tu perfil es de solo lectura en incidentes.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const body = parseBody(schemas.updateIncident, req, res);
    if (!body) return;
    const incident = fleetStore.updateIncident(
      ctx.tenant.id,
      req.params.id,
      body,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!incident) {
      res.status(404).json({ error: 'Incidente no encontrado.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({
      incident,
      vehicles: data?.vehicles ?? [],
      auditLogs: data?.auditLogs ?? [],
    });
  });

  app.post('/api/alert-rules', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'alertas')) {
      res.status(403).json({ error: 'Tu perfil no puede crear reglas.' });
      return;
    }
    const body = parseBody(schemas.createAlertRule, req, res);
    if (!body) return;
    const targetTenantId = targetTenantOrFail(req, res, ctx);
    if (!targetTenantId) return;
    const rule = fleetStore.createRule(
      targetTenantId,
      {
        name: String(body.name),
        conditionType: body.conditionType ?? 'velocidad',
        thresholdLabel: String(body.thresholdLabel),
        priority: body.priority ?? 'alta',
        autoCreateClip: Boolean(body.autoCreateClip ?? true),
        active: true,
        notifyQueue: String(body.notifyQueue || 'rabbitmq.alerts.high'),
      },
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({ rule, auditLogs: data?.auditLogs ?? [] });
  });

  app.patch('/api/alert-rules/:id/toggle', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'alertas')) {
      res.status(403).json({ error: 'Tu perfil no puede modificar reglas.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const rule = fleetStore.toggleRule(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!rule) {
      res.status(404).json({ error: 'Regla no encontrada.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ rule, auditLogs: data?.auditLogs ?? [] });
  });

  app.post('/api/video-clips/request-stream', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'video')) {
      res.status(403).json({ error: 'Tu perfil no puede solicitar transmisiones bajo demanda.' });
      return;
    }
    const body = parseBody(schemas.requestStream, req, res);
    if (!body) return;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const clip = fleetStore.requestOnDemandClip(
      ctx.tenant.id,
      body.vehicleId,
      body.channel ?? 'dual',
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!clip) {
      res.status(404).json({ error: 'Unidad no encontrada en tu empresa para transmisión JT1078.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({ clip, auditLogs: data?.auditLogs ?? [] });
  });

  app.patch('/api/video-clips/:id/retention', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!hasWritePermission(ctx.role, 'video')) {
      res.status(403).json({ error: 'Tu perfil no puede cambiar la retención legal.' });
      return;
    }
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const clip = fleetStore.toggleClipRetention(
      ctx.tenant.id,
      req.params.id,
      ctx.user.name,
      ctx.role.name,
      isSuper,
      isSuper
    );
    if (!clip) {
      res.status(404).json({ error: 'Clip no encontrado.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ clip, auditLogs: data?.auditLogs ?? [] });
  });

  app.put('/api/sizing', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (!ctx.user.isHiddenSuperadmin) {
      res.status(403).json({
        error: 'El dimensionamiento de la plataforma es global; solo el Superadmin puede modificarlo.',
      });
      return;
    }
    const body = parseBody(schemas.updateSizing, req, res);
    if (!body) return;
    const sizing = fleetStore.updateSizing(
      'global',
      body,
      ctx.user.name,
      ctx.role.name,
      Boolean(ctx.user.isHiddenSuperadmin)
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.json({ sizing, auditLogs: data?.auditLogs ?? [] });
  });

  // Fleet report (every unit in scope) as PDF, Excel or CSV.
  app.get('/api/reports/export', (req, res, next) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    if (!data) {
      res.status(404).json({ error: 'Empresa o usuario no disponible.' });
      return;
    }
    const ectx = exportContext(ctx, data);
    const format = parseFormat(req.query.format);
    const fileBase = exportFileBase('flota', ectx.multiTenant ? 'todas' : data.tenant.name);
    void respondWithReport(res, next, exportActor(ctx), fleetReport(data.vehicles, ectx), format, fileBase, 'Perfiles y Reportes');
  });

  // Alerts (and incidents, when the profile can see them) as PDF, Excel or CSV. ?priority= filters both.
  app.get('/api/alerts/export', (req, res, next) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    if (ctx.role.permissions.alertas === 'none') {
      res.status(403).json({ error: 'Tu perfil no tiene acceso a las alertas.' });
      return;
    }
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    if (!data) {
      res.status(404).json({ error: 'Empresa o usuario no disponible.' });
      return;
    }
    const priority = ALERT_PRIORITIES.has(req.query.priority as AlertPriority) ? (req.query.priority as AlertPriority) : undefined;
    const incidents = ctx.role.permissions.incidentes === 'none' ? null : data.incidents;
    const ectx = exportContext(ctx, data);
    const report = alertsReport(data.alerts, incidents, { priority }, ectx);
    const format = parseFormat(req.query.format);
    void respondWithReport(res, next, exportActor(ctx), report, format, exportFileBase('alertas', ectx.multiTenant ? 'todas' : data.tenant.name), 'Alertas e Incidentes');
  });

  app.use('/api', (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof TmsError) {
      res.status(err.status).json({ error: err.message, ...(err.details && typeof err.details === 'object' ? err.details : {}) });
      return;
    }
    if (err instanceof DomainError || err instanceof DriverError || err instanceof CurrencyError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if ((err as { type?: string } | null)?.type === 'entity.too.large') {
      res.status(413).json({ error: 'El archivo supera el tamaño máximo permitido (5 MB).' });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido.' });
      return;
    }
    console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  if (isProd) {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vigilant GeoCar listening on http://localhost:${PORT}`);
  });

  // Save buffered GPS positions before exiting (docker stop / systemd send SIGTERM).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      fleetStore
        .shutdown()
        .catch((err) => console.error('[shutdown] No se pudo guardar el estado pendiente:', err))
        .finally(() => process.exit(0));
    });
  }
}

startServer().catch((err) => {
  console.error('[startup] No se pudo iniciar el servidor:', err instanceof Error ? err.message : err);
  process.exit(1);
});
