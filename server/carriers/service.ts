import crypto from 'crypto';
import type { AuditLog, FleetStoreState } from '../../src/shared/types.ts';
import {
  blockingDocProblems,
  CARRIER_DOC_LABELS,
  carrierDocProblems,
  type Carrier,
  type CarrierDocType,
  type CarrierDocument,
  type CarrierSettlement,
  type CarrierVehicle,
} from '../../src/shared/carriers.ts';
import { CUIT_MESSAGES, cuitProblem, taxIdKey } from '../../src/shared/cuit.ts';
import { foldText } from '../../src/shared/drivers.ts';
import { hashToken } from '../auth/password.ts';
import { TmsError, type TmsActor, type TmsScope, type TmsService } from '../tms/service.ts';

interface Ctx {
  state: FleetStoreState;
  tms: TmsService;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
  currencyOf: (tenantId: string) => string | null;
}

export interface CarrierInput {
  name: string;
  taxId: string;
  contactName?: string;
  phone?: string;
  email?: string;
  documents?: Array<Omit<CarrierDocument, 'id'> & { id?: string }>;
  vehicles?: CarrierVehicle[];
  notes?: string;
  active?: boolean;
}

export interface CarrierTripInput {
  carrierId: string;
  plate: string;
  driverName: string;
  driverDni?: string;
  driverPhone?: string;
  price: number;
  plannedStart: string;
  orderIds: string[];
  notes?: string;
  acceptWarnings?: { reason: string };
}

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(6).toString('hex');
const inScope = (scope: TmsScope, tenantId: string) => 'all' in scope || scope.tenantId === tenantId;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export class CarriersService {
  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }
  private audit(tenantId: string, actor: TmsActor, action: string, target: string, detail: string) {
    this.ctx().audit({ tenantId, actorName: actor.name, actorRole: actor.role, actorHidden: actor.hidden, module: 'Fleteros', action, targetLabel: target, detail });
  }

  // ---------------------------------------------------------------- carriers

  private stats(c: Carrier) {
    const trips = this.state.trips.filter((t) => t.carrier?.carrierId === c.id && t.status !== 'cancelado');
    const rated = trips.filter((t) => t.carrier?.rating);
    const lateDeliveries = trips.filter((t) => t.status === 'finalizado' && t.stops.some((s) => s.kind === 'descarga' && s.window && s.arrivedAt && Date.parse(s.arrivedAt) > Date.parse(s.window.to))).length;
    return {
      trips: trips.length,
      finished: trips.filter((t) => t.status === 'finalizado').length,
      openTrips: trips.filter((t) => t.status === 'planificado' || t.status === 'en_curso').length,
      rating: rated.length ? Math.round((rated.reduce((a, t) => a + t.carrier!.rating!.score, 0) / rated.length) * 10) / 10 : null,
      ratings: rated.length,
      lateDeliveries,
      docProblems: carrierDocProblems(c),
    };
  }

  list(scope: TmsScope, q = '') {
    const needle = foldText(q);
    return this.state.carriers
      .filter((c) => inScope(scope, c.tenantId) && (!needle || foldText(`${c.name} ${c.taxId} ${c.vehicles.map((v) => v.plate).join(' ')}`).includes(needle)))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
      .map((c) => ({ ...c, ...this.stats(c) }));
  }

  find(scope: TmsScope, id: string): Carrier {
    const c = this.state.carriers.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!c) throw new TmsError('Fletero no encontrado.', 404);
    return c;
  }

  private normalize(tenantId: string, input: CarrierInput, selfId?: string) {
    const name = input.name.trim();
    if (name.length < 2) throw new TmsError('Indicá el nombre o razón social del fletero.');
    const problem = cuitProblem(input.taxId);
    if (problem) throw new TmsError(`CUIT del fletero: ${CUIT_MESSAGES[problem]}`);
    const key = taxIdKey(input.taxId);
    if (this.state.carriers.some((c) => c.tenantId === tenantId && c.id !== selfId && taxIdKey(c.taxId) === key)) throw new TmsError('Ya hay un fletero con ese CUIT.', 409);
    const docs = (input.documents ?? []).map((d) => ({
      id: d.id ?? `cd-${uid()}`,
      type: d.type,
      label: d.label?.trim() || undefined,
      number: d.number?.trim() || undefined,
      expiresAt: d.expiresAt || undefined,
    }));
    const plates = new Set<string>();
    const vehicles = (input.vehicles ?? []).map((v) => {
      const plate = v.plate.replace(/\s+/g, '').toUpperCase();
      if (plate.length < 5) throw new TmsError(`Patente inválida: ${v.plate}.`);
      if (plates.has(plate)) throw new TmsError(`La patente ${plate} está repetida.`);
      plates.add(plate);
      return { plate, description: v.description?.trim() || undefined, capacityKg: v.capacityKg, capacityPallets: v.capacityPallets };
    });
    return { name, taxId: input.taxId.trim(), documents: docs, vehicles };
  }

  create(tenantId: string, input: CarrierInput, actor: TmsActor): Carrier {
    const n = this.normalize(tenantId, input);
    const at = nowIso();
    const c: Carrier = {
      id: `car-${uid()}`,
      tenantId,
      ...n,
      contactName: input.contactName?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      email: input.email?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      active: input.active ?? true,
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    this.state.carriers.push(c);
    this.audit(tenantId, actor, 'Alta de fletero', c.name, `CUIT ${c.taxId} · ${c.vehicles.length} vehículo(s) · ${c.documents.length} documento(s).`);
    this.ctx().persist();
    return c;
  }

  update(scope: TmsScope, id: string, patch: Partial<CarrierInput>, actor: TmsActor): Carrier {
    const c = this.find(scope, id);
    const merged: CarrierInput = { ...c, ...patch, documents: patch.documents ?? c.documents, vehicles: patch.vehicles ?? c.vehicles };
    const n = this.normalize(c.tenantId, merged, c.id);
    Object.assign(c, n, {
      contactName: merged.contactName?.trim() || undefined,
      phone: merged.phone?.trim() || undefined,
      email: merged.email?.trim() || undefined,
      notes: merged.notes?.trim() || undefined,
      active: merged.active ?? c.active,
      updatedAt: nowIso(),
    });
    // The name shown on its trips follows the carrier (open trips only).
    for (const t of this.state.trips) if (t.carrier?.carrierId === c.id && (t.status === 'planificado' || t.status === 'en_curso')) t.carrier.carrierName = c.name;
    this.audit(c.tenantId, actor, 'Edición de fletero', c.name, `Campos: ${Object.keys(patch).join(', ')}.`);
    this.ctx().persist();
    return c;
  }

  // ---------------------------------------------------------------- trips

  /** Trip with a carrier: blocked when a required document is missing or expired (an admin may accept it with a reason). */
  createTrip(tenantId: string, input: CarrierTripInput, actor: TmsActor) {
    const c = this.find({ tenantId }, input.carrierId);
    if (!c.active) throw new TmsError(`El fletero «${c.name}» está inactivo.`, 409);
    if (!(input.price > 0)) throw new TmsError('Indicá el precio pactado con el fletero.');
    if (input.driverName.trim().length < 3) throw new TmsError('Indicá el nombre del chofer del fletero.');
    if (input.driverDni && !/^\d{7,8}$/.test(input.driverDni.replace(/\D/g, ''))) throw new TmsError('El DNI del chofer debe tener 7 u 8 dígitos.');
    const problems = blockingDocProblems(carrierDocProblems(c));
    let override: { warnings: string[]; reason: string } | undefined;
    if (problems.length) {
      const warnings = problems.map((p) => `${p.label}: ${p.problem === 'falta' ? 'falta cargarlo' : `vencido el ${p.expiresAt}`}.`);
      if (!input.acceptWarnings) throw new TmsError(`Documentación del fletero: ${warnings.join(' ')}`, 409, { problems, needsOverride: true });
      if (!actor.canOverride) throw new TmsError('Tu perfil no puede asignar un fletero con documentación vencida o faltante.', 403, { problems });
      if (!input.acceptWarnings.reason.trim()) throw new TmsError('Indicá el motivo para asignarlo igual.', 400, { problems });
      override = { warnings, reason: input.acceptWarnings.reason };
    }
    return this.ctx().tms.createCarrierTrip(
      tenantId,
      { carrier: c, plate: input.plate, driverName: input.driverName, driverDni: input.driverDni, driverPhone: input.driverPhone, price: input.price, plannedStart: input.plannedStart, orderIds: input.orderIds, notes: input.notes },
      override,
      actor
    );
  }

  private carrierTrip(scope: TmsScope, tripId: string) {
    const t = this.state.trips.find((x) => x.id === tripId && inScope(scope, x.tenantId));
    if (!t) throw new TmsError('Viaje no encontrado.', 404);
    if (!t.carrier) throw new TmsError('El viaje no es de un fletero.', 409);
    return t;
  }

  /** Plate, driver or price of a carrier trip (price only while it is not in a settlement). */
  updateTrip(scope: TmsScope, tripId: string, patch: { plate?: string; driverName?: string; driverDni?: string; driverPhone?: string; price?: number }, actor: TmsActor) {
    const t = this.carrierTrip(scope, tripId);
    if (t.status === 'cancelado') throw new TmsError('El viaje está cancelado.', 409);
    const c = t.carrier!;
    const changes: string[] = [];
    if (patch.price !== undefined) {
      if (c.settlementId) throw new TmsError('El viaje ya está en una liquidación: anulala para cambiar el precio.', 409);
      if (!(patch.price > 0)) throw new TmsError('El precio debe ser mayor a cero.');
      changes.push(`precio ${c.price} → ${round2(patch.price)}`);
      c.price = round2(patch.price);
    }
    if (patch.plate !== undefined || patch.driverName !== undefined || patch.driverDni !== undefined || patch.driverPhone !== undefined) {
      if (t.status === 'finalizado') throw new TmsError('El viaje ya terminó.', 409);
      if (patch.plate !== undefined) c.plate = patch.plate.trim().toUpperCase();
      if (patch.driverName !== undefined) c.driverName = patch.driverName.trim();
      if (patch.driverDni !== undefined) c.driverDni = patch.driverDni.replace(/\D/g, '') || undefined;
      if (patch.driverPhone !== undefined) c.driverPhone = patch.driverPhone.trim() || undefined;
      changes.push('patente/chofer');
    }
    if (!changes.length) return this.ctx().tms.getTrip(scope, t.id);
    t.updatedAt = nowIso();
    t.history.push({ at: t.updatedAt, actor: actor.name, action: 'Datos del fletero', detail: `${changes.join(', ')}.` });
    this.audit(t.tenantId, actor, 'Viaje de fletero editado', t.id, changes.join(', '));
    this.ctx().persist();
    return this.ctx().tms.getTrip(scope, t.id);
  }

  /** Per-trip link for the carrier's phone (driver app limited to this trip, shares its position). */
  issueLink(scope: TmsScope, tripId: string, actor: TmsActor): { token: string; path: string } {
    const t = this.carrierTrip(scope, tripId);
    if (t.status !== 'planificado' && t.status !== 'en_curso') throw new TmsError('El link se genera para viajes planificados o en curso.', 409);
    const token = crypto.randomBytes(24).toString('base64url');
    t.carrier!.linkTokenHash = hashToken(token);
    t.carrier!.linkCreatedAt = nowIso();
    t.history.push({ at: t.carrier!.linkCreatedAt, actor: actor.name, action: 'Link del fletero', detail: 'Se generó un link nuevo (el anterior dejó de funcionar).' });
    this.audit(t.tenantId, actor, 'Link de viaje para fletero', t.id, t.carrier!.carrierName);
    this.ctx().persist();
    return { token, path: `/chofer#t=${token}` };
  }

  revokeLink(scope: TmsScope, tripId: string, actor: TmsActor) {
    const t = this.carrierTrip(scope, tripId);
    t.carrier!.linkTokenHash = undefined;
    this.audit(t.tenantId, actor, 'Link de fletero revocado', t.id, t.carrier!.carrierName);
    this.ctx().persist();
    return this.ctx().tms.getTrip(scope, t.id);
  }

  rate(scope: TmsScope, tripId: string, input: { score: 1 | 2 | 3 | 4 | 5; comment?: string }, actor: TmsActor) {
    const t = this.carrierTrip(scope, tripId);
    if (t.status !== 'finalizado') throw new TmsError('Se califica un viaje finalizado.', 409);
    t.carrier!.rating = { score: input.score, comment: input.comment?.trim() || undefined, by: actor.hidden ? 'Superadmin' : actor.name, at: nowIso() };
    this.audit(t.tenantId, actor, 'Calificación de fletero', t.id, `${t.carrier!.carrierName}: ${input.score}/5${input.comment ? ` · ${input.comment.trim()}` : ''}`);
    this.ctx().persist();
    return this.ctx().tms.getTrip(scope, t.id);
  }

  // ---------------------------------------------------------------- settlements

  private nextSettlementId(tenantId: string) {
    const year = new Date().getFullYear();
    const n = this.state.carrierSettlements.filter((s) => s.tenantId === tenantId && s.id.startsWith(`LF-${year}-`)).length + 1;
    return `LF-${year}-${String(n).padStart(4, '0')}`;
  }

  /** Finished trips of a carrier in a period that are not in another settlement. */
  pendingTrips(scope: TmsScope, carrierId: string, from: string, to: string) {
    const c = this.find(scope, carrierId);
    return this.state.trips.filter(
      (t) => t.carrier?.carrierId === c.id && t.status === 'finalizado' && !t.carrier.settlementId && (t.finishedAt ?? '').slice(0, 10) >= from && (t.finishedAt ?? '').slice(0, 10) <= to
    );
  }

  createSettlement(scope: TmsScope, input: { carrierId: string; from: string; to: string }, actor: TmsActor): CarrierSettlement {
    if (input.from > input.to) throw new TmsError('El período es inválido.');
    const c = this.find(scope, input.carrierId);
    const trips = this.pendingTrips(scope, c.id, input.from, input.to);
    if (!trips.length) throw new TmsError('No hay viajes finalizados sin liquidar de este fletero en el período.', 409);
    const at = nowIso();
    const lines = trips
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
      .map((t) => ({ tripId: t.id, date: (t.finishedAt ?? t.plannedStart).slice(0, 10), description: `${t.carrier!.plate} · ${t.carrier!.driverName} · ${t.stops.length} parada(s)`, amount: t.carrier!.price }));
    const s: CarrierSettlement = {
      id: this.nextSettlementId(c.tenantId),
      tenantId: c.tenantId,
      carrierId: c.id,
      periodFrom: input.from,
      periodTo: input.to,
      lines,
      total: round2(lines.reduce((a, l) => a + l.amount, 0)),
      currency: this.ctx().currencyOf(c.tenantId) ?? 'ARS',
      status: 'borrador',
      createdBy: actor.hidden ? 'Superadmin' : actor.name,
      createdAt: at,
      updatedAt: at,
    };
    for (const t of trips) t.carrier!.settlementId = s.id;
    this.state.carrierSettlements.push(s);
    this.audit(c.tenantId, actor, 'Liquidación de fletero', s.id, `${c.name} · ${lines.length} viaje(s) · total ${s.total}.`);
    this.ctx().persist();
    return s;
  }

  listSettlements(scope: TmsScope, carrierId?: string) {
    const names = new Map(this.state.carriers.map((c) => [c.id, c.name]));
    return this.state.carrierSettlements
      .filter((s) => inScope(scope, s.tenantId) && (!carrierId || s.carrierId === carrierId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ ...s, carrierName: names.get(s.carrierId) ?? '—' }));
  }

  findSettlement(scope: TmsScope, id: string) {
    const s = this.state.carrierSettlements.find((x) => x.id === id && inScope(scope, x.tenantId));
    if (!s) throw new TmsError('Liquidación no encontrada.', 404);
    return s;
  }

  paySettlement(scope: TmsScope, id: string, reference: string | undefined, actor: TmsActor) {
    const s = this.findSettlement(scope, id);
    if (s.status !== 'borrador') throw new TmsError('La liquidación no está pendiente de pago.', 409);
    s.status = 'pagada';
    s.paidAt = nowIso();
    s.paymentReference = reference?.trim() || undefined;
    s.updatedAt = s.paidAt;
    this.audit(s.tenantId, actor, 'Liquidación de fletero pagada', s.id, `${s.total}${s.paymentReference ? ` · ${s.paymentReference}` : ''}.`);
    this.ctx().persist();
    return s;
  }

  voidSettlement(scope: TmsScope, id: string, reason: string, actor: TmsActor) {
    const s = this.findSettlement(scope, id);
    if (s.status === 'anulada') throw new TmsError('Ya está anulada.', 409);
    s.status = 'anulada';
    s.voidReason = reason.trim();
    s.updatedAt = nowIso();
    for (const t of this.state.trips) if (t.carrier?.settlementId === s.id) t.carrier.settlementId = undefined;
    this.audit(s.tenantId, actor, 'Liquidación de fletero anulada', s.id, reason.trim());
    this.ctx().persist();
    return s;
  }

  docLabel(type: CarrierDocType) {
    return CARRIER_DOC_LABELS[type];
  }
}
