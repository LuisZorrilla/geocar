import { formatDate, section, type MoneyCurrency, type Report, type Row } from '../export/report.ts';
import { CARRIER_SETTLEMENT_STATUS, type Carrier, type CarrierSettlement } from '../../src/shared/carriers.ts';

const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Settlement to pay a carrier: its finished trips of the period at the agreed price. */
export function carrierSettlementReport(s: CarrierSettlement, carrier: Carrier, ctx: { company: string; generatedBy: string; currency: MoneyCurrency | null }): Report {
  const rows: Row[] = s.lines.map((l) => ({ fecha: l.date, viaje: l.tripId, detalle: l.description, importe: l.amount }));
  const state =
    s.status === 'pagada'
      ? `Pagada ${s.paidAt ? formatDate(new Date(s.paidAt)) : ''}${s.paymentReference ? ` · ${s.paymentReference}` : ''}`
      : s.status === 'anulada'
        ? `Anulada: ${s.voidReason ?? ''}`
        : CARRIER_SETTLEMENT_STATUS[s.status];
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: `Liquidación de fletero ${s.id}`,
    subtitle: `${carrier.name} (CUIT ${carrier.taxId}) · Período ${day(s.periodFrom)} al ${day(s.periodTo)}`,
    filters: [{ label: 'Estado', value: state }],
    currency: ctx.currency,
    kpis: [
      { label: 'Viajes', value: s.lines.length },
      { label: 'A pagar', value: s.total, format: 'money' },
    ],
    sections: [
      section({
        id: 'viajes',
        title: 'Viajes finalizados',
        columns: [
          { key: 'fecha', label: 'Fecha', kind: 'date', width: 11 },
          { key: 'viaje', label: 'Viaje', kind: 'text', width: 14, total: 'count' },
          { key: 'detalle', label: 'Detalle', kind: 'text', width: 40 },
          { key: 'importe', label: 'Precio pactado', kind: 'money', width: 15, total: 'sum' },
        ],
        rows,
        empty: 'Sin viajes.',
      }),
    ],
  };
}
