/**
 * TMS T5: third-party carriers ("fleteros"). A carrier trip is a normal Trip with `carrier` set:
 * same stops, tracking, proof of delivery and billing; the cost is the agreed price and the
 * position comes from the carrier's phone (per-trip link) instead of a fleet tracker.
 */

export type CarrierDocType = 'seguro_carga' | 'seguro_rc' | 'ruta' | 'habilitacion' | 'vtv' | 'otro';

export const CARRIER_DOC_LABELS: Record<CarrierDocType, string> = {
  seguro_carga: 'Seguro de carga',
  seguro_rc: 'Seguro de responsabilidad civil',
  ruta: 'Inscripción RUTA',
  habilitacion: 'Habilitación / licencia',
  vtv: 'VTV / RTO',
  otro: 'Otro',
};

/** Documents without which a carrier trip is blocked (overridable by an admin with a reason). */
export const CARRIER_REQUIRED_DOCS: CarrierDocType[] = ['seguro_carga', 'ruta'];

export interface CarrierDocument {
  id: string;
  type: CarrierDocType;
  label?: string;
  number?: string;
  /** YYYY-MM-DD. */
  expiresAt?: string;
}

export interface CarrierVehicle {
  plate: string;
  description?: string;
  capacityKg?: number;
  capacityPallets?: number;
}

export interface Carrier {
  id: string;
  tenantId: string;
  name: string;
  taxId: string;
  contactName?: string;
  phone?: string;
  email?: string;
  documents: CarrierDocument[];
  vehicles: CarrierVehicle[];
  notes?: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Carrier part of a trip. */
export interface TripCarrier {
  carrierId: string;
  carrierName: string;
  plate: string;
  driverName: string;
  driverDni?: string;
  driverPhone?: string;
  /** Agreed price of the trip (company currency). */
  price: number;
  /** SHA-256 of the per-trip link token (never sent to the browser). */
  linkTokenHash?: string;
  linkCreatedAt?: string;
  /** View only: a link was issued (the hash itself is never sent). */
  linkActive?: boolean;
  lastSeenAt?: string;
  /** Phone position shared from the trip link. */
  lastPosition?: { lat: number; lng: number; accuracyM?: number; at: string };
  rating?: { score: 1 | 2 | 3 | 4 | 5; comment?: string; by: string; at: string };
  settlementId?: string;
}

export interface CarrierSettlementLine {
  tripId: string;
  date: string;
  description: string;
  amount: number;
}

export interface CarrierSettlement {
  id: string;
  tenantId: string;
  carrierId: string;
  periodFrom: string;
  periodTo: string;
  lines: CarrierSettlementLine[];
  total: number;
  currency: string;
  status: 'borrador' | 'pagada' | 'anulada';
  paidAt?: string;
  paymentReference?: string;
  voidReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CarrierDocProblem {
  type: CarrierDocType;
  label: string;
  problem: 'falta' | 'vencido' | 'por_vencer';
  expiresAt?: string;
}

/** Missing/expired required documents and documents expiring within 30 days. */
export function carrierDocProblems(c: Pick<Carrier, 'documents'>, now = new Date()): CarrierDocProblem[] {
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const out: CarrierDocProblem[] = [];
  for (const type of CARRIER_REQUIRED_DOCS) {
    if (!c.documents.some((d) => d.type === type)) out.push({ type, label: CARRIER_DOC_LABELS[type], problem: 'falta' });
  }
  for (const d of c.documents) {
    if (!d.expiresAt) continue;
    const label = d.label || CARRIER_DOC_LABELS[d.type];
    if (d.expiresAt < today) out.push({ type: d.type, label, problem: 'vencido', expiresAt: d.expiresAt });
    else if (d.expiresAt <= soon) out.push({ type: d.type, label, problem: 'por_vencer', expiresAt: d.expiresAt });
  }
  return out;
}

/** Problems that block a trip: a required document missing or any document expired. */
export const blockingDocProblems = (p: CarrierDocProblem[]) => p.filter((x) => x.problem === 'vencido' || x.problem === 'falta');

export const carrierVehicleId = (carrierId: string) => `carrier:${carrierId}`;
export const carrierDriverId = (tripId: string) => `carrier-trip:${tripId}`;
export const isCarrierId = (vehicleId: string) => vehicleId.startsWith('carrier:');

/** Position of whoever runs a trip: the fleet unit's tracker or the carrier's phone. */
export function tripPosition(
  t: { vehicleId: string; carrier?: Pick<TripCarrier, 'lastPosition'> },
  vehicles: Array<{ id: string; lat: number; lng: number; lastReportAt?: string }>
): { lat: number; lng: number; at: string } | null {
  if (t.carrier) return t.carrier.lastPosition ? { lat: t.carrier.lastPosition.lat, lng: t.carrier.lastPosition.lng, at: t.carrier.lastPosition.at } : null;
  const v = vehicles.find((x) => x.id === t.vehicleId);
  return v?.lastReportAt ? { lat: v.lat, lng: v.lng, at: v.lastReportAt } : null;
}

/**
 * The "unit" of a trip for position, names and alerts: the fleet vehicle, or a stand-in built from
 * the carrier data (lat/lng are NaN and lastReportAt undefined until the phone shares a position).
 */
export function tripUnit<V extends { id: string }>(t: { vehicleId: string; carrier?: TripCarrier }, vehicles: V[]): V | undefined {
  if (!t.carrier) return vehicles.find((v) => v.id === t.vehicleId);
  const p = t.carrier.lastPosition;
  return {
    id: t.vehicleId,
    unitCode: t.carrier.carrierName,
    plate: t.carrier.plate,
    driverName: t.carrier.driverName,
    lat: p?.lat ?? Number.NaN,
    lng: p?.lng ?? Number.NaN,
    lastReportAt: p?.at,
    speedKmh: 0,
  } as unknown as V;
}

export const CARRIER_SETTLEMENT_STATUS: Record<CarrierSettlement['status'], string> = { borrador: 'A pagar', pagada: 'Pagada', anulada: 'Anulada' };
