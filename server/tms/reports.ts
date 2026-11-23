import { filterList, section, status, type Column, type Report, type Row, type Tone } from '../export/report.ts';
import {
  ORDER_STATUS_LABELS,
  STOP_KIND_LABELS,
  STOP_STATUS_LABELS,
  TRIP_STATUS_LABELS,
  type OrderStatus,
  type TripStatus,
} from '../../src/shared/tms.ts';
import type { OrderView, TripView } from './service.ts';

export interface TmsExportContext {
  company: string;
  generatedBy: string;
  multiTenant: boolean;
  now?: Date;
}

const ORDER_TONE: Record<OrderStatus, Tone> = {
  borrador: 'muted',
  confirmado: 'info',
  planificado: 'info',
  en_curso: 'warn',
  entregado: 'ok',
  cancelado: 'muted',
};
const TRIP_TONE: Record<TripStatus, Tone> = { planificado: 'info', en_curso: 'warn', finalizado: 'ok', cancelado: 'muted' };

const companyColumn = (ctx: TmsExportContext): Column[] => (ctx.multiTenant ? [{ key: 'empresa', label: 'Empresa', kind: 'text', width: 18 }] : []);
const base = (ctx: TmsExportContext) => ({ company: ctx.company, generatedBy: ctx.generatedBy, generatedAt: ctx.now ?? new Date() });

export function ordersReport(orders: OrderView[], filters: { status?: string; q?: string }, ctx: TmsExportContext): Report {
  const rows: Row[] = orders.map((o) => ({
    pedido: o.id,
    empresa: o.tenantName ?? '',
    cliente: o.customerName,
    referencia: o.reference ?? '',
    origen: o.originName,
    destino: o.destinationName,
    carga: o.cargo.description,
    kg: o.cargo.weightKg ?? null,
    pallets: o.cargo.pallets ?? null,
    retiroDesde: o.pickupWindow?.from ?? '',
    entregaHasta: o.deliveryWindow?.to ?? '',
    estado: status(ORDER_STATUS_LABELS[o.status], ORDER_TONE[o.status]),
    viaje: o.tripId ?? '',
    entregado: o.deliveredAt ?? '',
  }));
  const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
  return {
    ...base(ctx),
    title: 'Pedidos de transporte',
    subtitle: 'Origen, destino, carga, ventanas horarias y estado',
    filters: filterList([
      ['Estado', filters.status ? (ORDER_STATUS_LABELS[filters.status as OrderStatus] ?? 'Activos') : undefined],
      ['Búsqueda', filters.q],
    ]),
    orientation: 'landscape',
    kpis: [
      { label: 'Pedidos', value: orders.length },
      { label: 'Confirmados', value: count('confirmado'), tone: 'info' },
      { label: 'En curso', value: count('en_curso') + count('planificado'), tone: 'warn' },
      { label: 'Entregados', value: count('entregado'), tone: 'ok' },
    ],
    sections: [
      section({
        id: 'pedidos',
        title: 'Pedidos',
        columns: [
          { key: 'pedido', label: 'Pedido', kind: 'text', width: 14, total: 'count' },
          ...companyColumn(ctx),
          { key: 'cliente', label: 'Cliente', kind: 'text', width: 18 },
          { key: 'referencia', label: 'Referencia', kind: 'text', width: 10 },
          { key: 'origen', label: 'Origen', kind: 'text', width: 16 },
          { key: 'destino', label: 'Destino', kind: 'text', width: 16 },
          { key: 'carga', label: 'Carga', kind: 'text', width: 16 },
          { key: 'kg', label: 'Kg', kind: 'number', width: 8, total: 'sum' },
          { key: 'pallets', label: 'Pallets', kind: 'number', width: 6, total: 'sum' },
          { key: 'retiroDesde', label: 'Retiro desde', kind: 'datetime', width: 13 },
          { key: 'entregaHasta', label: 'Entrega hasta', kind: 'datetime', width: 13 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 11 },
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 12 },
          { key: 'entregado', label: 'Entregado', kind: 'datetime', width: 13 },
        ],
        rows,
        empty: 'No hay pedidos con estos filtros.',
      }),
    ],
  };
}

export function tripsReport(trips: TripView[], filters: { status?: string; q?: string }, ctx: TmsExportContext): Report {
  const rows: Row[] = trips.map((t) => ({
    viaje: t.id,
    empresa: t.tenantName ?? '',
    unidad: `${t.unitCode}${t.plate ? ` (${t.plate})` : ''}`,
    chofer: t.driverName,
    salida: t.plannedStart,
    estado: status(TRIP_STATUS_LABELS[t.status], t.late ? 'bad' : TRIP_TONE[t.status]),
    paradas: `${t.stops.filter((s) => s.status === 'completada').length}/${t.stops.length}`,
    pedidos: t.orders.map((o) => o.id).join(', '),
    inicio: t.startedAt ?? '',
    fin: t.finishedAt ?? '',
    demora: t.late ? 'Sí' : '',
  }));
  const stops: Row[] = trips.flatMap((t) =>
    t.stops.map((s) => ({
      viaje: t.id,
      n: s.seq,
      lugar: s.placeName,
      tipo: STOP_KIND_LABELS[s.kind],
      ventanaHasta: s.window?.to ?? '',
      estado: status(STOP_STATUS_LABELS[s.status], s.status === 'completada' ? 'ok' : s.status === 'omitida' ? 'bad' : s.status === 'en_lugar' ? 'warn' : 'muted'),
      llegada: s.arrivedAt ?? '',
      salida: s.departedAt ?? '',
      deteccion: s.detection === 'auto' ? 'Automática' : s.detection === 'manual' ? 'Manual' : '',
      nota: s.note ?? '',
    }))
  );
  return {
    ...base(ctx),
    title: 'Viajes',
    subtitle: 'Unidad, chofer, paradas y cumplimiento',
    filters: filterList([
      ['Estado', filters.status ? (TRIP_STATUS_LABELS[filters.status as TripStatus] ?? 'Activos') : undefined],
      ['Búsqueda', filters.q],
    ]),
    orientation: 'landscape',
    kpis: [
      { label: 'Viajes', value: trips.length },
      { label: 'En curso', value: trips.filter((t) => t.status === 'en_curso').length, tone: 'warn' },
      { label: 'Finalizados', value: trips.filter((t) => t.status === 'finalizado').length, tone: 'ok' },
      { label: 'Con demora', value: trips.filter((t) => t.late).length, tone: 'bad' },
    ],
    sections: [
      section({
        id: 'viajes',
        title: 'Viajes',
        columns: [
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 13, total: 'count' },
          ...companyColumn(ctx),
          { key: 'unidad', label: 'Unidad', kind: 'text', width: 16 },
          { key: 'chofer', label: 'Chofer', kind: 'text', width: 18 },
          { key: 'salida', label: 'Salida planificada', kind: 'datetime', width: 13 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 11 },
          { key: 'paradas', label: 'Paradas', kind: 'text', width: 7 },
          { key: 'pedidos', label: 'Pedidos', kind: 'text', width: 24 },
          { key: 'inicio', label: 'Inicio', kind: 'datetime', width: 13 },
          { key: 'fin', label: 'Fin', kind: 'datetime', width: 13 },
          { key: 'demora', label: 'Demora', kind: 'text', width: 6 },
        ],
        rows,
        empty: 'No hay viajes con estos filtros.',
      }),
      section({
        id: 'paradas',
        title: 'Paradas',
        description: 'Una fila por parada, con llegada y salida',
        columns: [
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 13, total: 'count' },
          { key: 'n', label: 'N.º', kind: 'number', width: 4 },
          { key: 'lugar', label: 'Lugar', kind: 'text', width: 20 },
          { key: 'tipo', label: 'Tipo', kind: 'text', width: 8 },
          { key: 'ventanaHasta', label: 'Ventana hasta', kind: 'datetime', width: 13 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 11 },
          { key: 'llegada', label: 'Llegada', kind: 'datetime', width: 13 },
          { key: 'salida', label: 'Salida', kind: 'datetime', width: 13 },
          { key: 'deteccion', label: 'Detección', kind: 'text', width: 9 },
          { key: 'nota', label: 'Nota', kind: 'text', width: 18 },
        ],
        rows: stops,
        empty: 'Sin paradas.',
      }),
    ],
  };
}
