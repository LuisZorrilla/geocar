import crypto from 'crypto';
import type { AuditLog, FleetStoreState } from '../../src/shared/types.ts';
import { ORDER_STATUS_LABELS, type OrderStatus, type TransportOrder } from '../../src/shared/tms.ts';
import { PORTAL_LOCK_MIN, PORTAL_MAX_FAILED, PORTAL_SESSION_IDLE_H, PORTAL_SESSION_MAX_D, type PortalMe, type PortalSession, type PortalUser } from '../../src/shared/portal.ts';
import { hashPassword, hashToken, validatePasswordPolicy, verifyPassword } from '../auth/password.ts';
import { TmsError, type OrderInput, type TmsActor, type TmsScope, type TmsService } from '../tms/service.ts';

interface Ctx {
  state: FleetStoreState;
  tms: TmsService;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
}

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(8).toString('hex');
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same cost as a real check when the email does not exist (no user enumeration by timing). */
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-0');

/** Readable temporary password: 12 chars without ambiguous letters, with at least one digit. */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    const p = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
    if (/\d/.test(p) && /[A-Za-z]/.test(p)) return p;
  }
}

export type PortalContext = { user: PortalUser; session: PortalSession };

export class PortalService {
  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }
  private audit(tenantId: string, actorName: string, actorRole: string, action: string, target: string, detail: string, hidden?: boolean) {
    this.ctx().audit({ tenantId, actorName, actorRole, actorHidden: hidden, module: 'Portal de clientes', action, targetLabel: target, detail });
  }

  // ---------------------------------------------------------------- admin (company side)

  private visible(u: PortalUser) {
    const { passwordHash: _h, ...rest } = u;
    return rest;
  }

  listUsers(scope: TmsScope, customerId: string) {
    const customer = this.state.customers.find((c) => c.id === customerId && inScope(scope, c.tenantId));
    if (!customer) throw new TmsError('Cliente no encontrado.', 404);
    return this.state.portalUsers.filter((u) => u.customerId === customer.id).map((u) => this.visible(u));
  }

  async createUser(scope: TmsScope, customerId: string, input: { name: string; email: string }, actor: TmsActor) {
    const customer = this.state.customers.find((c) => c.id === customerId && inScope(scope, c.tenantId));
    if (!customer) throw new TmsError('Cliente no encontrado.', 404);
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new TmsError('El email no es válido.');
    if (this.state.portalUsers.some((u) => u.email === email)) throw new TmsError('Ese email ya tiene acceso a un portal.', 409);
    if (this.state.portalUsers.filter((u) => u.customerId === customer.id).length >= 20) throw new TmsError('Máximo 20 usuarios de portal por cliente.');
    const password = tempPassword();
    const at = nowIso();
    const user: PortalUser = {
      id: `pu-${uid()}`,
      tenantId: customer.tenantId,
      customerId: customer.id,
      name: input.name.trim(),
      email,
      passwordHash: await hashPassword(password),
      active: true,
      mustChangePassword: true,
      failedLogins: 0,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    this.state.portalUsers.push(user);
    this.audit(customer.tenantId, actor.name, actor.role, 'Alta de usuario del portal', `${user.name} <${email}>`, `Cliente ${customer.name}.`, actor.hidden);
    this.ctx().persist();
    return { user: this.visible(user), password };
  }

  private findUser(scope: TmsScope, id: string) {
    const u = this.state.portalUsers.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!u) throw new TmsError('Usuario no encontrado.', 404);
    return u;
  }

  private dropSessions(userId: string) {
    this.state.portalSessions = this.state.portalSessions.filter((s) => s.portalUserId !== userId);
  }

  async resetPassword(scope: TmsScope, id: string, actor: TmsActor) {
    const u = this.findUser(scope, id);
    const password = tempPassword();
    u.passwordHash = await hashPassword(password);
    u.mustChangePassword = true;
    u.failedLogins = 0;
    u.lockedUntil = undefined;
    u.updatedAt = nowIso();
    this.dropSessions(u.id);
    this.audit(u.tenantId, actor.name, actor.role, 'Clave del portal restablecida', u.email, 'Se cerraron sus sesiones.', actor.hidden);
    this.ctx().persist();
    return { user: this.visible(u), password };
  }

  updateUser(scope: TmsScope, id: string, patch: { name?: string; active?: boolean }, actor: TmsActor) {
    const u = this.findUser(scope, id);
    if (patch.name !== undefined) u.name = patch.name.trim();
    if (patch.active !== undefined) {
      u.active = patch.active;
      if (!patch.active) this.dropSessions(u.id);
    }
    u.updatedAt = nowIso();
    this.audit(u.tenantId, actor.name, actor.role, patch.active === false ? 'Usuario del portal desactivado' : 'Edición de usuario del portal', u.email, '', actor.hidden);
    this.ctx().persist();
    return this.visible(u);
  }

  // ---------------------------------------------------------------- authentication (portal side)

  async login(emailRaw: string, password: string): Promise<{ token: string; me: PortalMe }> {
    const email = emailRaw.trim().toLowerCase();
    const u = this.state.portalUsers.find((x) => x.email === email);
    const generic = new TmsError('Email o contraseña incorrectos.', 401);
    if (!u) {
      await verifyPassword(password, await DUMMY_HASH_PROMISE);
      throw generic;
    }
    if (u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()) throw new TmsError(`Demasiados intentos fallidos. Probá de nuevo después de las ${new Date(u.lockedUntil).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}.`, 429);
    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok) {
      u.failedLogins += 1;
      if (u.failedLogins >= PORTAL_MAX_FAILED) {
        u.lockedUntil = new Date(Date.now() + PORTAL_LOCK_MIN * 60_000).toISOString();
        u.failedLogins = 0;
        this.audit(u.tenantId, u.name, 'Portal', 'Bloqueo por intentos fallidos', u.email, `${PORTAL_LOCK_MIN} minutos.`);
      }
      this.ctx().persist();
      throw generic;
    }
    const customer = this.state.customers.find((c) => c.id === u.customerId);
    const tenant = this.state.tenants.find((t) => t.id === u.tenantId);
    if (!u.active || !customer?.active || !tenant || tenant.status === 'suspendido') throw new TmsError('Tu acceso al portal está desactivado. Consultá con la empresa de transporte.', 403);
    const token = `gp_${crypto.randomBytes(32).toString('base64url')}`;
    const at = nowIso();
    this.state.portalSessions.push({
      id: hashToken(token),
      tenantId: u.tenantId,
      portalUserId: u.id,
      createdAt: at,
      lastSeenAt: at,
      expiresAt: new Date(Date.now() + PORTAL_SESSION_MAX_D * 86_400_000).toISOString(),
    });
    u.failedLogins = 0;
    u.lockedUntil = undefined;
    u.lastLoginAt = at;
    this.pruneSessions();
    this.audit(u.tenantId, u.name, 'Portal', 'Ingreso al portal', u.email, `Cliente ${customer.name}.`);
    this.ctx().persist();
    return { token, me: this.me(u) };
  }

  private pruneSessions() {
    const now = Date.now();
    const idle = PORTAL_SESSION_IDLE_H * 3600_000;
    this.state.portalSessions = this.state.portalSessions.filter((s) => Date.parse(s.expiresAt) > now && now - Date.parse(s.lastSeenAt) < idle);
  }

  /** Session of a request (x-portal-token), sliding idle timeout. */
  authenticate(token: string | undefined): PortalContext | null {
    if (!token || !token.startsWith('gp_') || token.length > 120) return null;
    const id = hashToken(token);
    const s = this.state.portalSessions.find((x) => x.id === id);
    if (!s) return null;
    const now = Date.now();
    if (Date.parse(s.expiresAt) <= now || now - Date.parse(s.lastSeenAt) >= PORTAL_SESSION_IDLE_H * 3600_000) {
      this.state.portalSessions = this.state.portalSessions.filter((x) => x.id !== id);
      this.ctx().persist();
      return null;
    }
    const u = this.state.portalUsers.find((x) => x.id === s.portalUserId);
    const customer = u && this.state.customers.find((c) => c.id === u.customerId);
    const tenant = u && this.state.tenants.find((t) => t.id === u.tenantId);
    if (!u || !u.active || !customer?.active || !tenant || tenant.status === 'suspendido') return null;
    if (now - Date.parse(s.lastSeenAt) > 60_000) {
      s.lastSeenAt = new Date(now).toISOString();
      this.ctx().persist();
    }
    return { user: u, session: s };
  }

  logout(c: PortalContext) {
    this.state.portalSessions = this.state.portalSessions.filter((s) => s.id !== c.session.id);
    this.ctx().persist();
  }

  me(u: PortalUser): PortalMe {
    const customer = this.state.customers.find((c) => c.id === u.customerId);
    const tenant = this.state.tenants.find((t) => t.id === u.tenantId);
    return { user: { id: u.id, name: u.name, email: u.email, mustChangePassword: u.mustChangePassword }, customer: { id: u.customerId, name: customer?.name ?? '' }, company: { name: tenant?.name ?? '' } };
  }

  async changePassword(c: PortalContext, current: string, next: string) {
    if (!(await verifyPassword(current, c.user.passwordHash))) throw new TmsError('La contraseña actual no es correcta.');
    const policy = validatePasswordPolicy(next);
    if (policy) throw new TmsError(policy);
    if (current === next) throw new TmsError('La contraseña nueva debe ser distinta de la actual.');
    c.user.passwordHash = await hashPassword(next);
    c.user.mustChangePassword = false;
    c.user.updatedAt = nowIso();
    // Other sessions of this user are closed; this one stays.
    this.state.portalSessions = this.state.portalSessions.filter((s) => s.portalUserId !== c.user.id || s.id === c.session.id);
    this.audit(c.user.tenantId, c.user.name, 'Portal', 'Cambio de contraseña del portal', c.user.email, '');
    this.ctx().persist();
  }

  // ---------------------------------------------------------------- customer data

  private requireReady(c: PortalContext) {
    if (c.user.mustChangePassword) throw new TmsError('Cambiá la contraseña temporal para continuar.', 403, { code: 'must_change_password' });
  }

  private placeName(id: string) {
    return this.state.places.find((p) => p.id === id)?.name ?? '—';
  }

  private orderRow(o: TransportOrder) {
    const trip = o.tripId ? this.state.trips.find((t) => t.id === o.tripId) : undefined;
    const delivery = trip?.stops.find((s) => s.kind === 'descarga' && s.orderIds.includes(o.id));
    return {
      id: o.id,
      reference: o.reference ?? null,
      status: o.status,
      statusLabel: ORDER_STATUS_LABELS[o.status],
      origin: this.placeName(o.originPlaceId),
      destination: this.placeName(o.destinationPlaceId),
      cargo: o.cargo,
      pickupWindow: o.pickupWindow ?? null,
      deliveryWindow: o.deliveryWindow ?? null,
      eta: delivery?.status === 'pendiente' ? (delivery.eta ?? null) : null,
      deliveredAt: o.deliveredAt ?? null,
      hasProof: Boolean(delivery?.pod),
      trackingPath: o.trackingToken && o.status !== 'cancelado' ? `/seguimiento/${o.trackingToken}` : null,
      source: o.source?.channel ?? 'panel',
      createdAt: o.createdAt,
    };
  }

  orders(c: PortalContext, f: { status?: OrderStatus | 'activos'; q?: string }) {
    this.requireReady(c);
    const needle = (f.q ?? '').trim().toLowerCase();
    const mine = this.state.transportOrders.filter((o) => o.tenantId === c.user.tenantId && o.customerId === c.user.customerId);
    const counts = { activos: mine.filter((o) => o.status !== 'entregado' && o.status !== 'cancelado').length, entregados: mine.filter((o) => o.status === 'entregado').length };
    const items = mine
      .filter((o) => (!f.status ? true : f.status === 'activos' ? o.status !== 'entregado' && o.status !== 'cancelado' : o.status === f.status))
      .map((o) => this.orderRow(o))
      .filter((o) => !needle || `${o.id} ${o.reference ?? ''} ${o.origin} ${o.destination} ${o.cargo.description}`.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 300);
    return { items, counts };
  }

  /** One order of this customer (404 for anything else, also other customers of the same company). */
  order(c: PortalContext, id: string): TransportOrder {
    this.requireReady(c);
    const o = this.state.transportOrders.find((x) => x.id === id && x.tenantId === c.user.tenantId && x.customerId === c.user.customerId);
    if (!o) throw new TmsError('Pedido no encontrado.', 404);
    return o;
  }

  orderDetail(c: PortalContext, id: string) {
    const o = this.order(c, id);
    const tracking = o.trackingToken ? this.ctx().tms.publicTracking(o.trackingToken) : null;
    return { order: this.orderRow(o), notes: o.notes ?? null, events: tracking?.events ?? [], unit: tracking?.unit ?? null, delivered: tracking?.delivered ?? null };
  }

  /** Places the customer can use in a new order: its own and the company's shared ones. */
  places(c: PortalContext) {
    this.requireReady(c);
    return this.state.places
      .filter((p) => p.tenantId === c.user.tenantId && p.active && (!p.customerId || p.customerId === c.user.customerId))
      .map((p) => ({ id: p.id, name: p.name, address: p.address, kind: p.kind, own: p.customerId === c.user.customerId }))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
  }

  /** New order from the portal: always a draft that the company reviews and confirms. */
  createOrder(c: PortalContext, input: Omit<OrderInput, 'customerId' | 'confirm' | 'source'>) {
    this.requireReady(c);
    const allowed = new Set(this.places(c).map((p) => p.id));
    if (!allowed.has(input.originPlaceId) || !allowed.has(input.destinationPlaceId)) throw new TmsError('Elegí lugares de la lista.');
    const actor: TmsActor = { name: `Portal: ${c.user.name}`, role: 'Portal del cliente', canOverride: false };
    const o = this.ctx().tms.createOrder(c.user.tenantId, { ...input, customerId: c.user.customerId, confirm: false, source: { channel: 'portal', portalUserId: c.user.id } }, actor);
    return this.orderRow(this.order(c, o.id));
  }
}
