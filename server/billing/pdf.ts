import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { pdfSafe } from '../export/pdf.ts';
import { fiscalQrUrl, invoiceNumber, LETTER_LABEL, type ArcaConfig, type Invoice } from '../../src/shared/billing.ts';

const C = { ink: '#0F172A', text: '#1E293B', muted: '#64748B', line: '#94A3B8', soft: '#F1F5F9', warn: '#B91C1C' };
const money = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** PDF of an invoice or credit note with the fiscal QR (RG 4892). Simulated vouchers carry a watermark. */
export async function invoicePdf(inv: Invoice, cfg: ArcaConfig, associated?: Invoice): Promise<Buffer> {
  const qr = await QRCode.toBuffer(fiscalQrUrl(inv, cfg.cuit), { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, lang: 'es-AR', info: { Title: pdfSafe(`${LETTER_LABEL[inv.kind]} ${inv.letter} ${invoiceNumber(inv.pointOfSale, inv.number)}`), Author: 'GeoCar' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const X = 40;
  const W = doc.page.width - 80;
  const t = (s: string, x: number, y: number, o: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfSafe(s), x, y, o);

  if (inv.status === 'simulada') {
    doc.save();
    doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(46).fillColor('#FCA5A5').opacity(0.35);
    t('SIMULADO - SIN VALIDEZ FISCAL', 20, doc.page.height / 2 - 30, { width: doc.page.width - 40, align: 'center' });
    doc.restore();
    doc.opacity(1);
  }

  // Header: issuer | letter box | voucher data.
  const top = 40;
  const boxW = 56;
  doc.rect(X, top, W, 128).lineWidth(1).strokeColor(C.line).stroke();
  doc.moveTo(X + W / 2, top + 60).lineTo(X + W / 2, top + 128).stroke();
  doc.rect(X + W / 2 - boxW / 2, top, boxW, 60).fillAndStroke('#FFFFFF', C.line);
  doc.font('Helvetica-Bold').fontSize(34).fillColor(C.ink);
  t(inv.letter, X + W / 2 - boxW / 2, top + 6, { width: boxW, align: 'center' });
  doc.font('Helvetica').fontSize(7).fillColor(C.muted);
  t(`COD. ${String(inv.cbteTipo).padStart(2, '0')}`, X + W / 2 - boxW / 2, top + 46, { width: boxW, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.ink);
  t(cfg.businessName, X + 10, top + 10, { width: W / 2 - boxW / 2 - 20 });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.text);
  t(`Domicilio comercial: ${cfg.address}`, X + 10, top + 70, { width: W / 2 - 20 });
  t(`Condición frente al IVA: ${cfg.ivaCondition === 'responsable_inscripto' ? 'IVA Responsable Inscripto' : cfg.ivaCondition === 'monotributo' ? 'Responsable Monotributo' : 'IVA Exento'}`, X + 10, doc.y + 2, { width: W / 2 - 20 });

  const rx = X + W / 2 + 10;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.ink);
  t(LETTER_LABEL[inv.kind].toUpperCase(), rx + boxW / 2, top + 10, { width: W / 2 - boxW / 2 - 20 });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.text);
  t(`Punto de venta: ${String(inv.pointOfSale).padStart(5, '0')}   Comp. Nro: ${String(inv.number).padStart(8, '0')}`, rx, top + 70, { width: W / 2 - 20 });
  t(`Fecha de emisión: ${day(inv.date)}`, rx, doc.y + 2);
  t(`CUIT: ${cfg.cuit}   Ingresos Brutos: ${cfg.iibb || '-'}`, rx, doc.y + 2, { width: W / 2 - 20 });
  t(`Inicio de actividades: ${cfg.activityStart ? day(cfg.activityStart) : '-'}`, rx, doc.y + 2);

  // Receiver.
  let y = top + 138;
  doc.rect(X, y, W, 46).strokeColor(C.line).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(C.text);
  const docLabel = inv.receiver.docTipo === 80 ? 'CUIT' : inv.receiver.docTipo === 96 ? 'DNI' : 'Doc.';
  t(`${docLabel}: ${inv.receiver.docTipo === 99 ? '-' : inv.receiver.docNro}`, X + 10, y + 8);
  t(`Apellido y nombre / Razón social: ${inv.receiver.name}`, X + 160, y + 8, { width: W - 170 });
  t(`Condición frente al IVA: ${inv.receiver.ivaConditionLabel}`, X + 10, y + 26);
  t('Condición de venta: Cuenta corriente', X + 300, y + 26);
  y += 56;
  if (associated) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.text);
    t(`Comprobante asociado: Factura ${associated.letter} ${invoiceNumber(associated.pointOfSale, associated.number)} del ${day(associated.date)}${inv.reason ? ` · Motivo: ${inv.reason}` : ''}`, X, y, { width: W });
    y = doc.y + 8;
  }

  // Lines.
  const cols: Array<[string, number, 'left' | 'right']> = [['Pedido', 90, 'left'], ['Detalle', W - 90 - 80 - 100, 'left'], ['Entregado', 80, 'left'], ['Importe neto', 100, 'right']];
  doc.rect(X, y, W, 18).fill(C.soft);
  let cx = X;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.text);
  for (const [label, w, align] of cols) {
    t(label, cx + 5, y + 5, { width: w - 10, align });
    cx += w;
  }
  y += 20;
  doc.font('Helvetica').fontSize(8).fillColor(C.text);
  for (const l of inv.lines) {
    const h = Math.max(14, doc.heightOfString(pdfSafe(l.description), { width: cols[1][1] - 10 }) + 4);
    if (y + h > doc.page.height - 220) {
      doc.addPage();
      y = 40;
    }
    cx = X;
    const cells = [l.orderId, l.description, l.date ? day(l.date) : '', money(l.amount)];
    cells.forEach((c, i) => {
      t(c, cx + 5, y + 2, { width: cols[i][1] - 10, align: cols[i][2] });
      cx += cols[i][1];
    });
    y += h;
    doc.moveTo(X, y).lineTo(X + W, y).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
  }

  // Totals.
  y += 10;
  const tx = X + W - 220;
  doc.font('Helvetica').fontSize(9).fillColor(C.text);
  if (inv.letter !== 'C') {
    t('Importe neto gravado:', tx, y, { width: 120 });
    t(money(inv.net), tx + 120, y, { width: 100, align: 'right' });
    y += 14;
    t(`IVA ${inv.ivaRate} %:`, tx, y, { width: 120 });
    t(money(inv.iva), tx + 120, y, { width: 100, align: 'right' });
    y += 14;
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink);
  t('Importe total:', tx, y, { width: 120 });
  t(money(inv.total), tx + 120, y, { width: 100, align: 'right' });

  // Footer: QR + CAE.
  const fy = doc.page.height - 150;
  doc.image(qr, X, fy, { width: 100 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(inv.status === 'simulada' ? C.warn : C.ink);
  t(inv.status === 'simulada' ? 'COMPROBANTE SIMULADO: NO VÁLIDO COMO FACTURA' : 'Comprobante autorizado', X + 115, fy + 10, { width: W - 115 });
  doc.font('Helvetica').fontSize(9).fillColor(C.text);
  t(`CAE N°: ${inv.cae}`, X + 115, fy + 30);
  t(`Fecha de vencimiento del CAE: ${day(inv.caeDue)}`, X + 115, fy + 45);
  doc.fontSize(7.5).fillColor(C.muted);
  t(
    inv.status === 'simulada'
      ? 'Generado sin certificado de ARCA (modo simulado). Para emitir comprobantes válidos cargá el certificado en Facturación → Configuración de ARCA.'
      : `Emitido por ARCA (${inv.environment === 'homologacion' ? 'HOMOLOGACIÓN: entorno de pruebas, sin validez fiscal' : 'producción'}).`,
    X + 115,
    fy + 65,
    { width: W - 115 }
  );
  doc.end();
  return done;
}
