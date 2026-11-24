import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import type { AuditLog, FleetStoreState } from '../../src/shared/types.ts';
import { ORDER_STATUS_LABELS, STOP_STATUS_LABELS, TRIP_STATUS_LABELS, type TransportOrder, type Trip } from '../../src/shared/tms.ts';
import { invoiceNumber, type Invoice } from '../../src/shared/billing.ts';
import {
  API_SCOPES,
  WEBHOOK_BACKOFF_MIN,
  WEBHOOK_EVENTS,
  WEBHOOK_PAUSE_AFTER,
  type ApiKey,
  type ApiScope,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from '../../src/shared/integrations.ts';
import { openSecret, sealSecret } from '../billing/arca.ts';
import { TmsError, type TmsActor, type TmsScope } from '../tms/service.ts';

interface Ctx {
  state: FleetStoreState;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
}

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(8).toString('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const KEEP_DELIVERIES_PER_WEBHOOK = 200;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// ---------------------------------------------------------------- outgoing HTTP with SSRF guard

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const x = ip.toLowerCase();
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

const allowPrivate = () => process.env.WEBHOOKS_ALLOW_PRIVATE === 'true';

/** Validates a webhook URL when it is saved (the address is checked again on every delivery). */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new TmsError('La URL no es válida.');
  }
  if (u.username || u.password) throw new TmsError('La URL no puede llevar usuario ni contraseña.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowPrivate())) throw new TmsError('La URL debe empezar con https://.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (net.isIP(host) && isPrivateAddress(host)))) {
    throw new TmsError('La URL apunta a una red interna: usá una dirección pública.');
  }
  return u.toString();
}

/** POST without redirects; DNS answers that point to internal networks are refused at connect time. */
function postJson(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const lookup: net.LookupFunction = (hostname, options, cb) => {
      dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
        if (err) return cb(err, address, family);
        if (!allowPrivate() && isPrivateAddress(String(address))) return cb(Object.assign(new Error('dirección interna bloqueada'), { code: 'EPRIVATE' }), address, family);
        cb(null, address, family);
      });
    };
    const req = lib.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'GeoCar-Webhooks/1' }, lookup, timeout: DELIVERY_TIMEOUT_MS },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 500) }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('tiempo agotado'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/** Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

// ---------------------------------------------------------------- public representations

/** What the API and the webhooks expose of an order (no internal tokens or audit data). */
export function apiOrder(state: FleetStoreState, o: TransportOrder) {
  const place = (id: string) => {
    const p = state.places.find((x) => x.id === id);
    return p ? { id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng } : { id };
  };
  const customer = state.customers.find((c) => c.id === o.customerId);
  const base = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  return {
    id: o.id,
    reference: o.reference ?? null,
    status: o.status,
    statusLabel: ORDER_STATUS_LABELS[o.status],
    customer: { id: o.customerId, name: customer?.name ?? null },
    origin: place(o.originPlaceId),
    destination: place(o.destinationPlaceId),
    cargo: o.cargo,
    pickupWindow: o.pickupWindow ?? null,
    deliveryWindow: o.deliveryWindow ?? null,
    notes: o.notes ?? null,
    tripId: o.tripId ?? null,
    deliveredAt: o.deliveredAt ?? null,
    cancelReason: o.cancelReason ?? null,
    trackingPath: o.trackingToken ? `/seguimiento/${o.trackingToken}` : null,
    trackingUrl: o.trackingToken && base ? `${base}/seguimiento/${o.trackingToken}` : null,
    source: o.source?.channel ?? 'panel',
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export function apiTrip(state: FleetStoreState, t: Trip) {
  const v = state.vehicles.find((x) => x.id === t.vehicleId);
  const d = state.drivers.find((x) => x.id === t.driverId);
  return {
    id: t.id,
    status: t.status,
    statusLabel: TRIP_STATUS_LABELS[t.status],
    vehicle: t.carrier ? null : { id: t.vehicleId, unitCode: v?.unitCode ?? null, plate: v?.plate ?? null },
    driver: t.carrier ? null : { id: t.driverId, name: d?.name ?? null },
    carrier: t.carrier ? { id: t.carrier.carrierId, name: t.carrier.carrierName, plate: t.carrier.plate, driverName: t.carrier.driverName } : null,
    plannedStart: t.plannedStart,
    startedAt: t.startedAt ?? null,
    finishedAt: t.finishedAt ?? null,
    route: t.route ? { km: t.route.km, minutes: t.route.minutes, engine: t.route.engine } : null,
    stops: t.stops.map((s) => {
      const p = state.places.find((x) => x.id === s.placeId);
      return {
        id: s.id,
        seq: s.seq,
        kind: s.kind,
        status: s.status,
        statusLabel: STOP_STATUS_LABELS[s.status],
        place: { id: s.placeId, name: p?.name ?? null, address: p?.address ?? null, lat: p?.lat ?? null, lng: p?.lng ?? null },
        orderIds: s.orderIds,
        window: s.window ?? null,
        eta: s.eta ?? null,
        arrivedAt: s.arrivedAt ?? null,
        departedAt: s.departedAt ?? null,
        proofOfDelivery: s.pod ? { receiverName: s.pod.receiverName, receiverDni: s.pod.receiverDni, at: s.pod.at, photos: s.pod.photoFileIds.length } : null,
      };
    }),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function apiInvoice(inv: Invoice) {
  return {
    id: inv.id,
    kind: inv.kind,
    letter: inv.letter,
    number: invoiceNumber(inv.pointOfSale, inv.number),
    cbteTipo: inv.cbteTipo,
    date: inv.date,
    customerId: inv.customerId,
    receiver: { name: inv.receiver.name, docTipo: inv.receiver.docTipo, docNro: inv.receiver.docNro },
    net: inv.net,
    iva: inv.iva,
    total: inv.total,
    cae: inv.cae,
    caeDue: inv.caeDue,
    status: inv.status,
    environment: inv.environment,
    associatedId: inv.associatedId ?? null,
    creditNoteId: inv.creditNoteId ?? null,
    orderIds: inv.lines.map((l) => l.orderId),
  };
}

// ---------------------------------------------------------------- service

/**
 * API keys, webhooks and their deliveries. Events are detected by comparing a snapshot of orders,
 * trips, stops and invoices on every state save, so every path (panel, driver app, routing, API,
 * portal) produces them without each operation having to remember it.
 */
export class IntegrationsService {
  private snapshot: Map<string, string> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastUse = new Map<string, number>();

  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }
  private audit(tenantId: string, actor: TmsActor, action: string, target: string, detail: string) {
    this.ctx().audit({ tenantId, actorName: actor.name, actorRole: actor.role, actorHidden: actor.hidden, module: 'Integraciones', action, targetLabel: target, detail });
  }

  // ---------------------------------------------------------------- API keys

  listKeys(scope: TmsScope) {
    return this.state.apiKeys
      .filter((k) => inScope(scope, k.tenantId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ hash: _hash, ...k }) => k);
  }

  createKey(tenantId: string, input: { name: string; scopes: ApiScope[] }, actor: TmsActor): { key: Omit<ApiKey, 'hash'>; token: string } {
    const scopes = [...new Set(input.scopes)].filter((s) => s in API_SCOPES);
    if (!scopes.length) throw new TmsError('Elegí al menos un permiso.');
    if (this.state.apiKeys.filter((k) => k.tenantId === tenantId && !k.revokedAt).length >= 20) throw new TmsError('Máximo 20 claves activas por empresa: revocá las que no uses.');
    const token = `gk_${crypto.randomBytes(24).toString('base64url')}`;
    const key: ApiKey = {
      id: `key-${uid()}`,
      tenantId,
      name: input.name.trim(),
      prefix: token.slice(0, 10),
      hash: sha256(token),
      scopes,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: nowIso(),
    };
    this.state.apiKeys.push(key);
    this.audit(tenantId, actor, 'Alta de clave de API', key.name, `${key.prefix}… · permisos: ${scopes.join(', ')}.`);
    this.ctx().persist();
    const { hash: _hash, ...visible } = key;
    return { key: visible, token };
  }

  revokeKey(scope: TmsScope, id: string, actor: TmsActor) {
    const k = this.state.apiKeys.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!k) throw new TmsError('Clave no encontrada.', 404);
    if (k.revokedAt) throw new TmsError('La clave ya está revocada.', 409);
    k.revokedAt = nowIso();
    k.revokedBy = actor.hidden ? 'Superadmin' : actor.name;
    this.audit(k.tenantId, actor, 'Clave de API revocada', k.name, `${k.prefix}…`);
    this.ctx().persist();
    const { hash: _hash, ...visible } = k;
    return visible;
  }

  /** Key of a request (Authorization: Bearer gk_… or X-Api-Key), or null. Only active keys of active companies. */
  authenticate(token: string | undefined): ApiKey | null {
    if (!token || !token.startsWith('gk_') || token.length > 100) return null;
    const h = sha256(token);
    const k = this.state.apiKeys.find((x) => !x.revokedAt && crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(h, 'hex')));
    if (!k) return null;
    const tenant = this.state.tenants.find((t) => t.id === k.tenantId);
    if (!tenant || tenant.status === 'suspendido') return null;
    // lastUsedAt is saved at most once per minute per key.
    const last = this.lastUse.get(k.id) ?? 0;
    if (Date.now() - last > 60_000) {
      this.lastUse.set(k.id, Date.now());
      k.lastUsedAt = nowIso();
      this.ctx().persist();
    }
    return k;
  }

  // ---------------------------------------------------------------- webhooks

  private visibleWebhook(w: Webhook) {
    const { secret: _secret, ...rest } = w;
    const deliveries = this.state.webhookDeliveries.filter((d) => d.webhookId === w.id);
    return { ...rest, pending: deliveries.filter((d) => d.status === 'pendiente').length, failed: deliveries.filter((d) => d.status === 'fallido').length };
  }

  listWebhooks(scope: TmsScope) {
    return this.state.webhooks
      .filter((w) => inScope(scope, w.tenantId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((w) => this.visibleWebhook(w));
  }

  private findWebhook(scope: TmsScope, id: string): Webhook {
    const w = this.state.webhooks.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!w) throw new TmsError('Webhook no encontrado.', 404);
    return w;
  }

  private cleanEvents(events: string[]): WebhookEvent[] {
    const e = [...new Set(events)].filter((x): x is WebhookEvent => x in WEBHOOK_EVENTS);
    if (!e.length) throw new TmsError('Elegí al menos un evento.');
    return e;
  }

  createWebhook(tenantId: string, input: { url: string; events: string[]; description?: string }, actor: TmsActor) {
    if (this.state.webhooks.filter((w) => w.tenantId === tenantId).length >= 10) throw new TmsError('Máximo 10 webhooks por empresa.');
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const at = nowIso();
    const w: Webhook = {
      id: `wh-${uid()}`,
      tenantId,
      url: checkWebhookUrl(input.url),
      events: this.cleanEvents(input.events),
      description: input.description?.trim() || undefined,
      active: true,
      secret: sealSecret(secret),
      failures: 0,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    this.state.webhooks.push(w);
    this.audit(tenantId, actor, 'Alta de webhook', w.url, `Eventos: ${w.events.join(', ')}.`);
    this.ctx().persist();
    return { webhook: this.visibleWebhook(w), secret };
  }

  updateWebhook(scope: TmsScope, id: string, patch: { url?: string; events?: string[]; description?: string; active?: boolean }, actor: TmsActor) {
    const w = this.findWebhook(scope, id);
    if (patch.url !== undefined) w.url = checkWebhookUrl(patch.url);
    if (patch.events !== undefined) w.events = this.cleanEvents(patch.events);
    if (patch.description !== undefined) w.description = patch.description.trim() || undefined;
    if (patch.active !== undefined) {
      w.active = patch.active;
      if (patch.active) {
        w.failures = 0;
        w.pausedReason = undefined;
      }
    }
    w.updatedAt = nowIso();
    this.audit(w.tenantId, actor, 'Edición de webhook', w.url, `Campos: ${Object.keys(patch).join(', ')}.`);
    this.ctx().persist();
    if (w.active) this.kick();
    return this.visibleWebhook(w);
  }

  deleteWebhook(scope: TmsScope, id: string, actor: TmsActor) {
    const w = this.findWebhook(scope, id);
    this.state.webhooks = this.state.webhooks.filter((x) => x.id !== w.id);
    this.state.webhookDeliveries = this.state.webhookDeliveries.filter((d) => d.webhookId !== w.id);
    this.audit(w.tenantId, actor, 'Baja de webhook', w.url, '');
    this.ctx().persist();
  }

  rotateSecret(scope: TmsScope, id: string, actor: TmsActor) {
    const w = this.findWebhook(scope, id);
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    w.secret = sealSecret(secret);
    w.updatedAt = nowIso();
    this.audit(w.tenantId, actor, 'Secreto de webhook renovado', w.url, '');
    this.ctx().persist();
    return { webhook: this.visibleWebhook(w), secret };
  }

  deliveries(scope: TmsScope, webhookId: string) {
    const w = this.findWebhook(scope, webhookId);
    return this.state.webhookDeliveries
      .filter((d) => d.webhookId === w.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  /** Sends a "ping" now and returns the delivery. */
  async test(scope: TmsScope, id: string): Promise<WebhookDelivery> {
    const w = this.findWebhook(scope, id);
    const d = this.enqueue(w, 'ping', { message: 'Prueba de webhook desde GeoCar.' });
    this.ctx().persist();
    await this.attempt(d, w);
    this.ctx().persist();
    return d;
  }

  redeliver(scope: TmsScope, deliveryId: string) {
    const d = this.state.webhookDeliveries.find((x) => x.id === deliveryId && inScope(scope, x.tenantId));
    if (!d) throw new TmsError('Envío no encontrado.', 404);
    if (d.status === 'pendiente') throw new TmsError('El envío ya está en cola.', 409);
    d.status = 'pendiente';
    d.attempts = 0;
    d.nextAttemptAt = nowIso();
    this.ctx().persist();
    this.kick();
    return d;
  }

  // ---------------------------------------------------------------- events

  private enqueue(w: Webhook, event: WebhookEvent | 'ping', data: unknown): WebhookDelivery {
    const id = `evt-${uid()}`;
    const createdAt = nowIso();
    const d: WebhookDelivery = {
      id,
      tenantId: w.tenantId,
      webhookId: w.id,
      event,
      payload: JSON.stringify({ id, event, createdAt, data }),
      status: 'pendiente',
      attempts: 0,
      nextAttemptAt: createdAt,
      createdAt,
    };
    this.state.webhookDeliveries.push(d);
    return d;
  }

  emit(tenantId: string, event: WebhookEvent, data: unknown): number {
    const hooks = this.state.webhooks.filter((w) => w.tenantId === tenantId && w.active && w.events.includes(event));
    for (const w of hooks) this.enqueue(w, event, data);
    return hooks.length;
  }

  private take(): Map<string, string> {
    const m = new Map<string, string>();
    for (const o of this.state.transportOrders) m.set(`o:${o.id}`, o.status);
    for (const t of this.state.trips) {
      m.set(`t:${t.id}`, t.status);
      for (const s of t.stops) {
        m.set(`s:${t.id}:${s.id}`, s.status);
        if (s.pod) m.set(`p:${t.id}:${s.id}`, '1');
      }
    }
    for (const i of this.state.invoices) m.set(`i:${i.id}`, '1');
    return m;
  }

  /** Called on every state save: queues the events of what changed since the previous save. */
  detectChanges(): void {
    const next = this.take();
    const prev = this.snapshot;
    this.snapshot = next;
    if (!prev || !this.state.webhooks.some((w) => w.active)) return;
    let queued = 0;
    for (const [k, v] of next) {
      const before = prev.get(k);
      if (before === v) continue;
      const [kind, a, b] = k.split(':');
      if (kind === 'o') {
        const o = this.state.transportOrders.find((x) => x.id === a)!;
        queued += this.emit(o.tenantId, before === undefined ? 'order.created' : 'order.status_changed', { ...apiOrder(this.state, o), previousStatus: before ?? null });
      } else if (kind === 't') {
        const t = this.state.trips.find((x) => x.id === a)!;
        queued += this.emit(t.tenantId, before === undefined ? 'trip.created' : 'trip.status_changed', { ...apiTrip(this.state, t), previousStatus: before ?? null });
      } else if (kind === 's' && before !== undefined) {
        const t = this.state.trips.find((x) => x.id === a)!;
        const trip = apiTrip(this.state, t);
        queued += this.emit(t.tenantId, 'stop.status_changed', { tripId: t.id, stop: trip.stops.find((s) => s.id === b), previousStatus: before });
      } else if (kind === 'p') {
        const t = this.state.trips.find((x) => x.id === a)!;
        const stop = t.stops.find((s) => s.id === b)!;
        queued += this.emit(t.tenantId, 'delivery.proof', {
          tripId: t.id,
          stopId: stop.id,
          orderIds: stop.orderIds,
          receiverName: stop.pod!.receiverName,
          receiverDni: stop.pod!.receiverDni,
          at: stop.pod!.at,
          lat: stop.pod!.lat ?? null,
          lng: stop.pod!.lng ?? null,
          photos: stop.pod!.photoFileIds.length,
        });
      } else if (kind === 'i') {
        const inv = this.state.invoices.find((x) => x.id === a)!;
        queued += this.emit(inv.tenantId, 'invoice.issued', apiInvoice(inv));
      }
    }
    if (queued) this.kick();
  }

  /** Re-reads the baseline (after loading the state from the database). */
  resetSnapshot() {
    this.snapshot = this.take();
  }

  // ---------------------------------------------------------------- delivery worker

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.process(), 15_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private kick() {
    setImmediate(() => void this.process());
  }

  private async attempt(d: WebhookDelivery, w: Webhook) {
    const started = Date.now();
    d.attempts += 1;
    try {
      const secret = openSecret(w.secret);
      const r = await postJson(w.url, d.payload, {
        'X-GeoCar-Event': d.event,
        'X-GeoCar-Delivery': d.id,
        'X-GeoCar-Signature': signPayload(secret, d.payload),
      });
      d.responseStatus = r.status;
      if (r.status >= 200 && r.status < 300) {
        d.status = 'entregado';
        d.deliveredAt = nowIso();
        d.lastError = undefined;
        d.nextAttemptAt = undefined;
        w.failures = 0;
      } else {
        throw Object.assign(new Error(`respondió ${r.status}${r.body ? `: ${r.body.slice(0, 120)}` : ''}`), { status: r.status });
      }
    } catch (err) {
      const e = err as { message?: string; code?: string; status?: number };
      d.lastError = e.code === 'EPRIVATE' ? 'La dirección resuelve a una red interna (bloqueada).' : e.code === 'ETIMEDOUT' ? 'Tiempo agotado (10 s).' : (e.message ?? 'Error de conexión').slice(0, 200);
      if (e.status === undefined) d.responseStatus = null;
      w.failures += 1;
      const wait = WEBHOOK_BACKOFF_MIN[d.attempts - 1];
      if (d.event === 'ping' || wait === undefined) {
        d.status = 'fallido';
        d.nextAttemptAt = undefined;
      } else {
        d.nextAttemptAt = new Date(Date.now() + wait * 60_000).toISOString();
      }
      if (w.active && w.failures >= WEBHOOK_PAUSE_AFTER) {
        w.active = false;
        w.pausedReason = `Pausado automáticamente tras ${w.failures} envíos fallidos seguidos.`;
        this.ctx().audit({ tenantId: w.tenantId, actorName: 'Sistema', actorRole: 'Sistema', module: 'Integraciones', action: 'Webhook pausado', targetLabel: w.url, detail: w.pausedReason });
      }
    }
    d.durationMs = Date.now() - started;
    w.lastDeliveryAt = nowIso();
    w.lastStatus = d.responseStatus ?? null;
  }

  /** Sends what is due (oldest first, one at a time per webhook to keep the order). */
  async process(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const now = Date.now();
      const due = this.state.webhookDeliveries
        .filter((d) => d.status === 'pendiente' && Date.parse(d.nextAttemptAt ?? d.createdAt) <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const blocked = new Set<string>();
      for (const d of due) {
        const w = this.state.webhooks.find((x) => x.id === d.webhookId);
        if (!w) continue;
        if (!w.active || blocked.has(w.id)) continue;
        await this.attempt(d, w);
        sent += 1;
        if (d.status !== 'entregado') blocked.add(w.id);
      }
      if (sent) {
        this.prune();
        this.ctx().persist();
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  private prune() {
    const byHook = new Map<string, WebhookDelivery[]>();
    for (const d of this.state.webhookDeliveries) {
      if (d.status === 'pendiente') continue;
      const list = byHook.get(d.webhookId) ?? [];
      list.push(d);
      byHook.set(d.webhookId, list);
    }
    const drop = new Set<string>();
    for (const list of byHook.values()) {
      if (list.length <= KEEP_DELIVERIES_PER_WEBHOOK) continue;
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const d of list.slice(KEEP_DELIVERIES_PER_WEBHOOK)) drop.add(d.id);
    }
    if (drop.size) this.state.webhookDeliveries = this.state.webhookDeliveries.filter((d) => !drop.has(d.id));
  }
}
