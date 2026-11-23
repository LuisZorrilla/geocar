import { formatDate, section, status, type MoneyCurrency, type Report, type Row } from '../export/report.ts';
import { EXPENSE_LABELS, FUEL_FLAG_LABELS, type DriverSettlement, type FuelLoad, type PreInvoice, type TripExpense } from '../../src/shared/costs.ts';
import type { Customer } from '../../src/shared/tms.ts';
import type { Tenant } from '../../src/shared/types.ts';
import type { ProfitRow } from './costs.ts';

interface Ctx {
  company: string;
  generatedBy: string;
  currency: MoneyCurrency | null;
}

const day = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`));

export function preInvoiceReport(pf: PreInvoice, customer: Customer | undefined, tenant: Tenant | undefined, ctx: Ctx): Report {
  const rows: Row[] = pf.lines.map((l) => ({ pedido: l.orderId, fecha: l.date, referencia: l.reference ?? '', detalle: l.description, importe: l.amount }));
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: `Pre-factura ${pf.id}`,
    subtitle: `${customer?.name ?? ''}${customer?.taxId ? ` · CUIT ${customer.taxId}` : ''} · Período ${day(pf.periodFrom)} al ${day(pf.periodTo)}`,
    filters: [
      { label: 'Estado', value: pf.status === 'borrador' ? 'Borrador' : pf.status === 'emitida' ? `Emitida ${pf.issuedAt ? formatDate(new Date(pf.issuedAt)) : ''}` : `Anulada: ${pf.voidReason ?? ''}` },
      { label: 'Emisor', value: `${tenant?.name ?? ''}${tenant?.taxId ? ` · CUIT ${tenant.taxId}` : ''}` },
    ],
    currency: ctx.currency,
    kpis: [
      { label: 'Pedidos', value: pf.lines.length },
      { label: 'Total', value: pf.total, format: 'money' },
    ],
    sections: [
      section({
        id: 'pedidos',
        title: 'Detalle',
        description: pf.notes ?? 'Documento interno previo a la factura: no es un comprobante fiscal.',
        columns: [
          { key: 'pedido', label: 'Pedido', kind: 'text', width: 13, total: 'count' },
          { key: 'fecha', label: 'Entregado', kind: 'date', width: 10 },
          { key: 'referencia', label: 'Referencia', kind: 'text', width: 11 },
          { key: 'detalle', label: 'Detalle', kind: 'text', width: 40 },
          { key: 'importe', label: 'Importe', kind: 'money', width: 13, total: 'sum' },
        ],
        rows,
        empty: 'Sin pedidos.',
      }),
    ],
  };
}

export function settlementReport(s: DriverSettlement & { driverName: string; expenses: TripExpense[] }, ctx: Ctx): Report {
  const rows: Row[] = s.expenses.map((e) => ({ fecha: e.at, viaje: e.tripId, tipo: EXPENSE_LABELS[e.type], detalle: e.note ?? '', importe: e.amount }));
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: `Liquidación de viáticos ${s.id}`,
    subtitle: `${s.driverName} · Período ${day(s.periodFrom)} al ${day(s.periodTo)}`,
    filters: [{ label: 'Estado', value: s.status === 'pagada' ? `Pagada ${s.paidAt ? formatDate(new Date(s.paidAt)) : ''} por ${s.paidBy ?? ''}` : s.status === 'anulada' ? 'Anulada' : 'Borrador (a pagar)' }],
    currency: ctx.currency,
    kpis: [
      { label: 'Gastos', value: s.expenses.length },
      { label: 'A reintegrar', value: s.total, format: 'money' },
    ],
    sections: [
      section({
        id: 'gastos',
        title: 'Gastos pagados por el chofer',
        columns: [
          { key: 'fecha', label: 'Fecha', kind: 'datetime', width: 13 },
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 12, total: 'count' },
          { key: 'tipo', label: 'Tipo', kind: 'text', width: 12 },
          { key: 'detalle', label: 'Detalle', kind: 'text', width: 30 },
          { key: 'importe', label: 'Importe', kind: 'money', width: 13, total: 'sum' },
        ],
        rows,
        empty: 'Sin gastos.',
      }),
    ],
  };
}

const GROUP_LABEL = { viaje: 'Viaje', cliente: 'Cliente', unidad: 'Unidad', chofer: 'Chofer' } as const;

export function profitabilityReport(data: { rows: ProfitRow[]; totals: ProfitRow }, groupBy: keyof typeof GROUP_LABEL, from: string, to: string, ctx: Ctx): Report {
  const rows: Row[] = data.rows.map((r) => ({
    nombre: r.label,
    viajes: r.trips,
    km: r.km,
    ingresos: r.revenue,
    costo: r.cost,
    margen: r.margin,
    pct: r.marginPct,
    estado: r.marginPct === null ? status('Sin ingresos', 'muted') : r.marginPct < 0 ? status('Pérdida', 'bad') : r.marginPct < 10 ? status('Margen bajo', 'warn') : status('Rentable', 'ok'),
  }));
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: `Rentabilidad por ${GROUP_LABEL[groupBy].toLowerCase()}`,
    subtitle: `Viajes finalizados del ${day(from)} al ${day(to)}`,
    filters: [{ label: 'Agrupado por', value: GROUP_LABEL[groupBy] }],
    currency: ctx.currency,
    orientation: 'landscape',
    kpis: [
      { label: 'Ingresos', value: data.totals.revenue, format: 'money' },
      { label: 'Costo', value: data.totals.cost, format: 'money' },
      { label: 'Margen', value: data.totals.margin, format: 'money', tone: data.totals.margin < 0 ? 'bad' : 'ok' },
      { label: 'Margen %', value: data.totals.marginPct === null ? '—' : `${data.totals.marginPct} %` },
    ],
    sections: [
      section({
        id: 'rentabilidad',
        title: `Por ${GROUP_LABEL[groupBy].toLowerCase()}`,
        description: 'Costo = combustible (cargas del viaje o estimado) + gastos aprobados + mantenimiento por km + horas del chofer.',
        columns: [
          { key: 'nombre', label: GROUP_LABEL[groupBy], kind: 'text', width: 22, total: 'count' },
          { key: 'viajes', label: 'Viajes', kind: 'number', width: 7, decimals: 1, total: 'sum' },
          { key: 'km', label: 'Km', kind: 'number', width: 8, total: 'sum' },
          { key: 'ingresos', label: 'Ingresos', kind: 'money', width: 14, total: 'sum' },
          { key: 'costo', label: 'Costo', kind: 'money', width: 14, total: 'sum' },
          { key: 'margen', label: 'Margen', kind: 'money', width: 14, total: 'sum' },
          { key: 'pct', label: 'Margen %', kind: 'number', width: 9, decimals: 1 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 12 },
        ],
        rows,
        empty: 'No hay viajes finalizados en el período.',
      }),
    ],
  };
}

export function fuelReport(items: Array<FuelLoad & { unitCode: string; plate: string; litersPer100?: number }>, ctx: Ctx & { multiTenant?: boolean }): Report {
  const rows: Row[] = items.map((f) => ({
    fecha: f.at,
    unidad: `${f.unitCode} ${f.plate}`,
    litros: f.liters,
    precio: f.pricePerLiter,
    total: f.total,
    odometro: f.odometerKm ?? null,
    rendimiento: f.litersPer100 ?? null,
    estacion: f.station ?? '',
    viaje: f.tripId ?? '',
    origen: f.source === 'importacion' ? 'Importación' : f.source === 'app' ? 'App del chofer' : 'Manual',
    alertas: f.flags.length ? status(f.flags.map((x) => FUEL_FLAG_LABELS[x.code]).join(', '), 'bad') : status('OK', 'ok'),
  }));
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: 'Cargas de combustible',
    subtitle: 'Litros, importes, rendimiento y alertas de consumo',
    filters: [],
    currency: ctx.currency,
    orientation: 'landscape',
    kpis: [
      { label: 'Cargas', value: items.length },
      { label: 'Litros', value: Math.round(items.reduce((a, f) => a + f.liters, 0)) },
      { label: 'Importe', value: items.reduce((a, f) => a + f.total, 0), format: 'money' },
      { label: 'Con alertas', value: items.filter((f) => f.flags.length).length, tone: 'bad' },
    ],
    sections: [
      section({
        id: 'combustible',
        title: 'Cargas',
        columns: [
          { key: 'fecha', label: 'Fecha', kind: 'datetime', width: 13 },
          { key: 'unidad', label: 'Unidad', kind: 'text', width: 16, total: 'count' },
          { key: 'litros', label: 'Litros', kind: 'number', width: 8, decimals: 2, total: 'sum' },
          { key: 'precio', label: 'Precio/L', kind: 'money', width: 10 },
          { key: 'total', label: 'Importe', kind: 'money', width: 12, total: 'sum' },
          { key: 'odometro', label: 'Odómetro', kind: 'number', width: 9 },
          { key: 'rendimiento', label: 'L/100 km', kind: 'number', width: 8, decimals: 1 },
          { key: 'estacion', label: 'Estación', kind: 'text', width: 16 },
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 12 },
          { key: 'origen', label: 'Origen', kind: 'text', width: 11 },
          { key: 'alertas', label: 'Alertas', kind: 'status', width: 18 },
        ],
        rows,
        empty: 'Sin cargas.',
      }),
    ],
  };
}
