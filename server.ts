import 'dotenv/config';
import express from 'express';
import path from 'path';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { ModulePermissions, RoleDefinition, Tenant } from './src/shared/types.ts';
import { DomainError, fleetStore, type ActiveSession } from './server/store.ts';
import * as schemas from './server/validation/schemas.ts';
import { parseBody } from './server/validation/http.ts';

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
  return resolved;
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
  app.post('/api/vehicles', (req, res) => {
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
        group: String(body.group || 'Operación General'),
        assetType: body.assetType === 'maquinaria_pesada' ? 'maquinaria_pesada' : 'vehiculo',
        unitCode: String(body.unitCode),
        plate: String(body.plate),
        brandModel: String(body.brandModel || 'Kenworth T680'),
        year: Number(body.year || 2025),
        driverName: String(body.driverName || 'Operador Asignado'),
        imei: String(body.imei),
        protocol: body.protocol === 'Traccar' ? 'Traccar' : 'JT808/JT1078',
        deviceModel: String(body.deviceModel || 'Howen Hero-ME40-04'),
        engineHours: Number(body.engineHours || 120),
        odometerKm: Number(body.odometerKm || 1200),
      },
      ctx.user.name,
      ctx.role.name
    );
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, getRequestedScope(req, ctx));
    res.status(201).json({ ...created, auditLogs: data?.auditLogs ?? [] });
  });

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

  app.get('/api/vehicles/:id/export', (req, res) => {
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
    const format = req.query.format === 'json' ? 'json' : 'csv';
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${dossier.vehicle.unitCode}_ficha_operativa.json"`);
      res.send(JSON.stringify({ empresa: tenantName, exportadoEn: new Date().toISOString(), ...dossier }, null, 2));
      return;
    }
    const v = dossier.vehicle;
    const faultsStr = v.faultCodes.map((f) => `${f.code}: ${f.description}`).join(' | ') || 'Sin fallas';
    const header =
      'Unidad,Tipo_Activo,Placa,Marca_Modelo,Empresa,Sucursal,Conductor,Estado_Operativo,Horometro_h,Proximo_Servicio_h,Proximo_Servicio_Fecha,Odometro_km,Proximo_Servicio_km,Estado_Mantenimiento,Combustible_pct,RPM,Temp_C,Codigos_Falla,Lat,Lng\n';
    const row = [
      v.unitCode,
      v.assetType,
      v.plate,
      `"${v.brandModel}"`,
      `"${tenantName}"`,
      `"${v.branch}"`,
      `"${v.driverName}"`,
      v.operationalStatus,
      v.engineHours,
      v.nextServiceHours,
      v.nextServiceDate,
      v.odometerKm,
      v.nextServiceKm,
      v.maintenanceStatus,
      v.fuelLevelPct,
      v.rpm,
      v.coolantTempC,
      `"${faultsStr}"`,
      v.lat,
      v.lng,
    ].join(',');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${v.unitCode}_ficha_mantenimiento.csv"`);
    res.send(header + row);
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
    const { vehicleId, type, title, workshopOrTech, costMxn, notes, nextServiceDate, clearFaults } = body;
    const isSuper = Boolean(ctx.user.isHiddenSuperadmin);
    const result = fleetStore.addMaintenanceRecord(
      ctx.tenant.id,
      String(vehicleId),
      {
        type: type === 'correctivo' || type === 'inspeccion' ? type : 'preventivo',
        title: String(title),
        workshopOrTech: String(workshopOrTech || 'Taller Interno'),
        costMxn: Number(costMxn || 0),
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
        laborCostMxn: Number(body.laborCostMxn || 0),
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
        estimatedCostMxn: Number(body.estimatedCostMxn || 0),
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
        unitCostMxn: Number(body.unitCostMxn ?? 0),
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

  app.get('/api/reports/export', (req, res) => {
    const ctx = requireAuth(req, res);
    if (!ctx) return;
    const scope = getRequestedScope(req, ctx);
    const data = fleetStore.getTenantBootstrap(ctx.tenant.id, ctx.user.id, scope);
    const vehicles = data?.vehicles ?? [];
    const header =
      'Unidad,Tipo_Activo,Placa,Empresa,Sucursal,Conductor,Estado,Velocidad_kmh,Horometro_h,Proximo_Servicio_h,Proximo_Servicio_Fecha,Estado_Mantto,Fallas_DTC,Lat,Lng,Odometro_km\n';
    const rows = vehicles
      .map((v) => {
        const tName = fleetStore.getTenantById(v.tenantId)?.name ?? ctx.tenant.name;
        return [
          v.unitCode,
          v.assetType,
          v.plate,
          `"${tName}"`,
          `"${v.branch}"`,
          `"${v.driverName}"`,
          v.operationalStatus,
          v.speedKmh,
          v.engineHours,
          v.nextServiceHours,
          v.nextServiceDate,
          v.maintenanceStatus,
          v.faultCodes.length,
          v.lat,
          v.lng,
          v.odometerKm,
        ].join(',');
      })
      .join('\n');

    const exportScopeName = scope ?? ctx.tenant.id;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportScopeName}_flota_mantenimiento.csv"`);
    res.send(header + rows);
  });

  app.use('/api', (err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message });
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
    console.log(`Vigilant FleetOps listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[startup] No se pudo iniciar el servidor:', err instanceof Error ? err.message : err);
  process.exit(1);
});
