import PDFDocument from 'pdfkit';
import { pdfSafe } from '../export/pdf.ts';
import { formatDate, section, status, type Report, type Row } from '../export/report.ts';
import { STOP_KIND_LABELS, STOP_STATUS_LABELS, type Customer, type Place, type TransportOrder, type Trip, type TripStop } from '../../src/shared/tms.ts';
import type { TripView } from './service.ts';

const C = { ink: '#0F172A', text: '#1E293B', muted: '#64748B', line: '#CBD5E1', card: '#F1F5F9', brand: '#0369A1', ok: '#047857' };

export interface DeliveryNoteInput {
  carrier: string;
  carrierTaxId?: string;
  order: TransportOrder;
  customer?: Customer;
  origin?: Place;
  destination?: Place;
  trip?: Trip;
  stop?: TripStop;
  unit?: { unitCode: string; plate: string };
  driverName?: string;
  /** PNG of the receiver's signature, when delivered from the app. */
  signature?: Buffer | null;
}

/**
 * Delivery note (remito) of one order. Before delivery it is the document that travels with the
 * load; after delivery it also carries the proof (receiver, DNI, time, place and signature).
 * It is an internal transport document, not the fiscal remito (that one comes with ARCA in T5).
 */
export async function deliveryNotePdf(input: DeliveryNoteInput): Promise<Buffer> {
  if (!input.signature) return renderDeliveryNote(input);
  // Safety net: if the signature image can't be drawn in time, the note goes out without it.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 8000);
  });
  const withSignature = await Promise.race([renderDeliveryNote(input), timeout]);
  clearTimeout(timer);
  return withSignature ?? renderDeliveryNote({ ...input, signature: null });
}

function renderDeliveryNote(input: DeliveryNoteInput): Promise<Buffer> {
  const { order, stop } = input;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 42, right: 42 }, lang: 'es-AR', info: { Title: pdfSafe(`Remito ${order.id}`), Author: 'GeoCar' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const X = 42;
  const W = doc.page.width - 84;
  const t = (s: string, x: number, y: number, o: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfSafe(s), x, y, o);
  const when = (iso?: string) => (iso ? formatDate(new Date(iso), true) : '—');

  // Header.
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.brand);
  t('GEOCAR · DOCUMENTO DE TRANSPORTE', X, 48, { characterSpacing: 1.2 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink);
  t(`Remito de transporte ${order.id}`, X, 64, { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor(C.text);
  t(`Transportista: ${input.carrier}${input.carrierTaxId ? ` · CUIT ${input.carrierTaxId}` : ''}`, X, doc.y + 4, { width: W });
  doc.fillColor(C.muted).fontSize(8.5);
  t(`Emitido el ${formatDate(new Date(), true)}${order.reference ? ` · Referencia del cliente: ${order.reference}` : ''}`, X, doc.y + 2, { width: W });
  let y = doc.y + 12;

  // Parties.
  const box = (title: string, lines: string[], x: number, w: number, top: number) => {
    doc.font('Helvetica').fontSize(9);
    const h = 22 + lines.reduce((a, l) => a + doc.heightOfString(pdfSafe(l), { width: w - 16 }) + 2, 0);
    doc.roundedRect(x, top, w, h, 4).fill(C.card);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted);
    t(title.toUpperCase(), x + 8, top + 7, { characterSpacing: 0.8 });
    doc.font('Helvetica').fontSize(9).fillColor(C.text);
    let ly = top + 19;
    for (const l of lines) {
      t(l, x + 8, ly, { width: w - 16 });
      ly = doc.y + 2;
    }
    return h;
  };
  const half = (W - 10) / 2;
  const h1 = box('Cliente', [input.customer?.name ?? '—', input.customer?.taxId ? `CUIT/ID: ${input.customer.taxId}` : ''].filter(Boolean), X, half, y);
  const h2 = box(
    'Transporte',
    [input.unit ? `Unidad ${input.unit.unitCode} · Patente ${input.unit.plate}` : 'Sin unidad asignada', input.driverName ? `Chofer: ${input.driverName}` : '', input.trip ? `Viaje ${input.trip.id}` : ''].filter(Boolean),
    X + half + 10,
    half,
    y
  );
  y += Math.max(h1, h2) + 8;
  const h3 = box('Origen (carga)', [input.origin?.name ?? '—', input.origin?.address ?? ''].filter(Boolean), X, half, y);
  const h4 = box('Destino (descarga)', [input.destination?.name ?? '—', input.destination?.address ?? ''].filter(Boolean), X + half + 10, half, y);
  y += Math.max(h3, h4) + 12;

  // Cargo table.
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink);
  t('Carga', X, y);
  y = doc.y + 4;
  const cols: Array<[string, number]> = [['Descripción', W - 230], ['Peso (kg)', 70], ['Volumen (m³)', 80], ['Pallets', 80]];
  doc.rect(X, y, W, 18).fill(C.ink);
  let cx = X;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  for (const [label, w] of cols) {
    t(label, cx + 6, y + 5, { width: w - 12 });
    cx += w;
  }
  y += 18;
  const cg = order.cargo;
  const cells = [
    `${cg.description}${cg.dangerous ? ' · CARGA PELIGROSA' : ''}${cg.refrigerated ? ' · requiere frío' : ''}`,
    cg.weightKg !== undefined ? cg.weightKg.toLocaleString('es-AR') : '—',
    cg.volumeM3 !== undefined ? cg.volumeM3.toLocaleString('es-AR') : '—',
    cg.pallets !== undefined ? String(cg.pallets) : '—',
  ];
  doc.font('Helvetica').fontSize(9).fillColor(C.text);
  const rowH = Math.max(20, doc.heightOfString(pdfSafe(cells[0]), { width: cols[0][1] - 12 }) + 10);
  doc.rect(X, y, W, rowH).strokeColor(C.line).lineWidth(0.7).stroke();
  cx = X;
  cells.forEach((c, i) => {
    t(c, cx + 6, y + 5, { width: cols[i][1] - 12 });
    cx += cols[i][1];
  });
  y += rowH + 10;
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted);
  t(
    `Ventana de entrega: ${order.deliveryWindow ? `${when(order.deliveryWindow.from)} a ${when(order.deliveryWindow.to)}` : 'sin ventana'}${order.notes ? ` · Notas: ${order.notes}` : ''}`,
    X,
    y,
    { width: W }
  );
  y = doc.y + 16;

  // Proof of delivery.
  const pod = stop?.pod;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink);
  t('Conformidad de entrega', X, y);
  y = doc.y + 6;
  if (pod) {
    doc.roundedRect(X, y, W, 128, 4).strokeColor(C.ok).lineWidth(1).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ok);
    t('ENTREGADO', X + 10, y + 10, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.text);
    t(`Recibió: ${pod.receiverName}`, X + 10, y + 28, { width: W / 2 - 20 });
    t(`DNI: ${pod.receiverDni}`, X + 10, doc.y + 3);
    t(`Fecha y hora: ${when(pod.at)}`, X + 10, doc.y + 3);
    t(pod.lat !== undefined && pod.lng !== undefined ? `Ubicación: ${pod.lat}, ${pod.lng}${pod.accuracyM ? ` (±${pod.accuracyM} m)` : ''}` : 'Ubicación: no informada por el celular', X + 10, doc.y + 3, { width: W / 2 - 20 });
    if (pod.note) t(`Observaciones: ${pod.note}`, X + 10, doc.y + 3, { width: W / 2 - 20 });
    t(`Registrado por ${pod.by} desde la app del chofer${pod.photoFileIds.length ? ` · ${pod.photoFileIds.length} foto(s) en el sistema` : ''}.`, X + 10, doc.y + 3, { width: W / 2 - 20 });
    const sx = X + W / 2 + 10;
    if (input.signature) {
      try {
        doc.image(input.signature, sx, y + 12, { fit: [W / 2 - 30, 90], align: 'center', valign: 'center' });
      } catch {
        // A damaged image must not break the document.
      }
    }
    doc.moveTo(sx, y + 106).lineTo(X + W - 10, y + 106).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(C.muted);
    t('Firma de quien recibe', sx, y + 110, { width: W / 2 - 20, align: 'center' });
  } else {
    doc.roundedRect(X, y, W, 120, 4).strokeColor(C.line).lineWidth(0.8).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(C.text);
    t(stop?.status === 'completada' ? 'Entregado sin firma digital (registrado por geocerca o desde el panel).' : 'Pendiente de entrega. Completar al recibir:', X + 10, y + 10, { width: W - 20 });
    const lines = ['Nombre y apellido', 'DNI', 'Fecha y hora', 'Firma'];
    lines.forEach((l, i) => {
      const ly = y + 34 + i * 21;
      doc.fontSize(8.5).fillColor(C.muted);
      t(l, X + 10, ly);
      doc.moveTo(X + 110, ly + 9).lineTo(X + W - 10, ly + 9).strokeColor(C.line).stroke();
    });
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(C.muted);
  t('Documento interno de transporte generado por GeoCar. No reemplaza al remito o la factura electrónica fiscal.', X, doc.page.height - 60, { width: W, align: 'center' });
  doc.end();
  return done;
}

/** Route sheet of a trip: stops in order with windows, plus its orders (rendered with the standard report PDF). */
export function routeSheetReport(trip: TripView, ctx: { company: string; generatedBy: string }): Report {
  const stops: Row[] = trip.stops.map((s) => ({
    n: s.seq,
    tipo: STOP_KIND_LABELS[s.kind],
    lugar: s.placeName,
    direccion: s.address,
    desde: s.window?.from ?? '',
    hasta: s.window?.to ?? '',
    pedidos: s.orderIds.join(', '),
    estado: status(STOP_STATUS_LABELS[s.status], s.status === 'completada' ? 'ok' : s.status === 'omitida' ? 'bad' : s.status === 'en_lugar' ? 'warn' : 'muted'),
  }));
  const orders: Row[] = trip.orders.map((o) => ({
    pedido: o.id,
    cliente: o.customerName,
    referencia: o.reference ?? '',
    carga: o.cargo.description + (o.cargo.dangerous ? ' (peligrosa)' : '') + (o.cargo.refrigerated ? ' (frío)' : ''),
    kg: o.cargo.weightKg ?? null,
    pallets: o.cargo.pallets ?? null,
  }));
  return {
    company: ctx.company,
    generatedBy: ctx.generatedBy,
    generatedAt: new Date(),
    title: `Hoja de ruta ${trip.id}`,
    subtitle: `${trip.unitCode} ${trip.plate} · Chofer ${trip.driverName} · Salida ${formatDate(new Date(trip.plannedStart), true)}`,
    filters: [],
    showFilters: false,
    orientation: 'landscape',
    kpis: [
      { label: 'Paradas', value: trip.stops.length },
      { label: 'Pedidos', value: trip.orders.length },
      { label: 'Kg', value: trip.orders.reduce((a, o) => a + (o.cargo.weightKg ?? 0), 0) },
    ],
    sections: [
      section({
        id: 'paradas',
        title: 'Recorrido',
        columns: [
          { key: 'n', label: 'N.º', kind: 'number', width: 4 },
          { key: 'tipo', label: 'Tipo', kind: 'text', width: 8 },
          { key: 'lugar', label: 'Lugar', kind: 'text', width: 20 },
          { key: 'direccion', label: 'Dirección', kind: 'text', width: 24 },
          { key: 'desde', label: 'Ventana desde', kind: 'datetime', width: 13 },
          { key: 'hasta', label: 'Ventana hasta', kind: 'datetime', width: 13 },
          { key: 'pedidos', label: 'Pedidos', kind: 'text', width: 18 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 11 },
        ],
        rows: stops,
        empty: 'Sin paradas.',
      }),
      section({
        id: 'pedidos',
        title: 'Pedidos',
        columns: [
          { key: 'pedido', label: 'Pedido', kind: 'text', width: 14, total: 'count' },
          { key: 'cliente', label: 'Cliente', kind: 'text', width: 20 },
          { key: 'referencia', label: 'Referencia', kind: 'text', width: 12 },
          { key: 'carga', label: 'Carga', kind: 'text', width: 26 },
          { key: 'kg', label: 'Kg', kind: 'number', width: 8, total: 'sum' },
          { key: 'pallets', label: 'Pallets', kind: 'number', width: 7, total: 'sum' },
        ],
        rows: orders,
        empty: 'Sin pedidos.',
      }),
    ],
  };
}
