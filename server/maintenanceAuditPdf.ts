import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import type { MaintenanceRecord, Tenant, Vehicle, WorkOrder } from '../src/shared/types.ts';

export interface MaintenanceAuditExportInput {
  tenant: Tenant;
  vehicles: Vehicle[];
  closedWorkOrders: WorkOrder[];
  maintenanceRecords: MaintenanceRecord[];
  filters: {
    from?: string;
    to?: string;
    vehicleId?: string;
    vehicleLabel: string;
    type: 'all' | WorkOrder['type'];
  };
  actorName: string;
  actorRole: string;
}

export interface MaintenanceAuditExportResult {
  buffer: Buffer;
  auditFolio: string;
  sha256: string;
  generatedAt: string;
  fileName: string;
  summary: {
    closedOrdersCount: number;
    logbookCount: number;
    unitsCount: number;
    refaccionesMxn: number;
    insumosMxn: number;
    manoObraMxn: number;
    totalWorkOrdersMxn: number;
    totalLogbookMxn: number;
  };
}

const COLORS = {
  ink: '#0F172A',
  slate: '#334155',
  muted: '#64748B',
  border: '#CBD5E1',
  surface: '#F8FAFC',
  surfaceAlt: '#F1F5F9',
  accent: '#0369A1',
  accentDark: '#0C4A6E',
  emerald: '#047857',
  amber: '#B45309',
  rose: '#B91C1C',
  white: '#FFFFFF',
};

const TYPE_LABELS: Record<WorkOrder['type'], string> = {
  preventivo: 'Preventivo',
  correctivo: 'Correctivo',
  inspeccion: 'Inspección técnica',
};

const PRIORITY_LABELS: Record<WorkOrder['priority'], string> = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
};

const ASSET_LABELS: Record<Vehicle['assetType'], string> = {
  vehiculo: 'Vehículo',
  maquinaria_pesada: 'Maquinaria Pesada',
};

function fmtMxn(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-MX')} MXN`;
}

function fmtNum(val: number): string {
  return val.toLocaleString('es-MX');
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function fmtDateShort(isoOrDate?: string): string {
  if (!isoOrDate) return '—';
  const raw = isoOrDate.slice(0, 10);
  const parts = raw.split('-');
  if (parts.length !== 3) return raw;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function slugifyFileName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export async function generateMaintenanceAuditPdf(
  input: MaintenanceAuditExportInput
): Promise<MaintenanceAuditExportResult> {
  const generatedAt = new Date().toISOString();
  const dateCompact = generatedAt.slice(0, 10).replace(/-/g, '');
  const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  const auditFolio = `AUD-${dateCompact}-${randomSuffix}`;

  let refaccionesMxn = 0;
  let insumosMxn = 0;
  let manoObraMxn = 0;
  let totalPartsQty = 0;
  let stockDeductedCount = 0;

  for (const wo of input.closedWorkOrders) {
    let woManoObra = Number(wo.laborCost || 0);
    for (const part of wo.parts) {
      totalPartsQty += Number(part.quantity || 0);
      if (part.category === 'refaccion') refaccionesMxn += Number(part.subtotal || 0);
      else if (part.category === 'insumo') insumosMxn += Number(part.subtotal || 0);
      else woManoObra += Number(part.subtotal || 0);
    }
    manoObraMxn += woManoObra;
    if (wo.stockDeducted) stockDeductedCount += 1;
  }

  const totalWorkOrdersMxn = refaccionesMxn + insumosMxn + manoObraMxn;
  const totalLogbookMxn = input.maintenanceRecords.reduce((sum, r) => sum + Number(r.cost || 0), 0);

  const canonicalDigestPayload = {
    auditFolio,
    generatedAt,
    tenantId: input.tenant.id,
    tenantName: input.tenant.name,
    taxId: input.tenant.taxId,
    filters: {
      from: input.filters.from || null,
      to: input.filters.to || null,
      vehicleId: input.filters.vehicleId || 'all',
      type: input.filters.type,
    },
    totals: {
      closedOrdersCount: input.closedWorkOrders.length,
      logbookCount: input.maintenanceRecords.length,
      refaccionesMxn,
      insumosMxn,
      manoObraMxn,
      totalWorkOrdersMxn,
      totalLogbookMxn,
    },
    closedWorkOrders: input.closedWorkOrders.map((wo) => ({
      id: wo.id,
      unitCode: wo.unitCode,
      completedAt: wo.completedAt ?? wo.scheduledDate,
      totalCost: wo.totalCost,
      partsCount: wo.parts.length,
    })),
    maintenanceRecords: input.maintenanceRecords.map((r) => ({
      id: r.id,
      unitCode: r.unitCode,
      performedAt: r.performedAt,
      cost: r.cost,
    })),
  };

  const sha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalDigestPayload))
    .digest('hex');

  const companySlug = slugifyFileName(input.tenant.name);
  const fileName = `Auditoria_Mantto_${companySlug}_${auditFolio}.pdf`;

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 38, bottom: 52, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: `Reporte de Auditoría de Mantenimiento - ${input.tenant.name} (${auditFolio})`,
        Author: `${input.actorName} (${input.actorRole})`,
        Subject: 'Expediente de Órdenes de Trabajo Cerradas e Historial de Mantenimiento',
        Creator: 'Vigilant FleetOps · San Juan, AR',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const marginL = 40;
    const marginR = 40;
    const contentW = pageW - marginL - marginR; // 532 pt
    const bottomLimit = pageH - 56;

    const ensureSpace = (neededHeight: number) => {
      if (doc.y + neededHeight > bottomLimit) {
        doc.addPage();
        drawContinuationHeader();
      }
    };

    const drawContinuationHeader = () => {
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(`${input.tenant.name} · CUIT/RFC ${input.tenant.taxId}`, marginL, 28, {
          width: contentW * 0.65,
        });
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(`Auditoría Externa · Folio ${auditFolio}`, marginL, 28, {
          width: contentW,
          align: 'right',
        });
      doc
        .moveTo(marginL, 41)
        .lineTo(marginL + contentW, 41)
        .lineWidth(0.6)
        .strokeColor(COLORS.border)
        .stroke();
      doc.y = 50;
    };

    const drawSectionHeading = (num: string, title: string, subtitle?: string) => {
      ensureSpace(34);
      const y = doc.y + 4;
      doc
        .rect(marginL, y, contentW, 20)
        .fill(COLORS.ink);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(COLORS.white)
        .text(`${num}. ${title}`, marginL + 8, y + 5, { width: contentW - 16 });
      doc.y = y + 25;
      if (subtitle) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(subtitle, marginL, doc.y, { width: contentW });
        doc.y += 4;
      }
    };

    // ───────────────────────────────────────────────────────────────────────────
    // PAGE 1: MEMBRETE FISCAL & FOLIO DE AUDITORÍA
    // ───────────────────────────────────────────────────────────────────────────
    const headerTop = 36;
    doc
      .roundedRect(marginL, headerTop, contentW, 74, 4)
      .fillAndStroke(COLORS.surface, COLORS.border);

    // Left fiscal letterhead
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLORS.ink)
      .text(input.tenant.name, marginL + 12, headerTop + 10, { width: 315 });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLORS.slate)
      .text(`Identificador Fiscal (CUIT / RFC): ${input.tenant.taxId}`, marginL + 12, headerTop + 28, {
        width: 315,
      });
    doc
      .text(
        `Sede operativa: ${input.tenant.city} · Sucursales: ${input.tenant.branches.join(', ')}`,
        marginL + 12,
        headerTop + 41,
        { width: 315 }
      );
    doc
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `Plan: ${input.tenant.planTier} · Cuota flota: ${input.tenant.vehicleQuota} unidades`,
        marginL + 12,
        headerTop + 54,
        { width: 315 }
      );

    // Right audit stamp box
    const stampX = marginL + 335;
    const stampW = contentW - 347;
    doc
      .roundedRect(stampX, headerTop + 8, stampW, 58, 3)
      .fillAndStroke(COLORS.ink, COLORS.ink);
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#7DD3FC')
      .text('AUDITORÍA EXTERNA DE MANTENIMIENTO', stampX + 8, headerTop + 14, {
        width: stampW - 16,
        align: 'right',
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(COLORS.white)
      .text(auditFolio, stampX + 8, headerTop + 27, {
        width: stampW - 16,
        align: 'right',
      });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#CBD5E1')
      .text(`Emisión: ${fmtDateTime(generatedAt)}`, stampX + 8, headerTop + 42, {
        width: stampW - 16,
        align: 'right',
      });
    doc
      .text(`Por: ${input.actorName}`, stampX + 8, headerTop + 52, {
        width: stampW - 16,
        align: 'right',
      });

    // Scope & Filters Banner
    const filterTop = headerTop + 82;
    doc
      .roundedRect(marginL, filterTop, contentW, 34, 3)
      .fillAndStroke(COLORS.white, COLORS.border);

    const periodLabel =
      input.filters.from || input.filters.to
        ? `${input.filters.from ? fmtDateShort(input.filters.from) : 'Inicio'} a ${input.filters.to ? fmtDateShort(input.filters.to) : 'Hoy'}`
        : 'Histórico completo disponible';
    const typeLabel = input.filters.type === 'all' ? 'Todos (Preventivo, Correctivo, Inspección)' : TYPE_LABELS[input.filters.type];

    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLORS.muted)
      .text('PERIODO AUDITADO', marginL + 10, filterTop + 6, { width: 155 });
    doc
      .text('ALCANCE DE FLOTA', marginL + 175, filterTop + 6, { width: 185 });
    doc
      .text('TIPO DE SERVICIO', marginL + 370, filterTop + 6, { width: 152 });

    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(COLORS.ink)
      .text(periodLabel, marginL + 10, filterTop + 17, { width: 155 });
    doc
      .text(input.filters.vehicleLabel, marginL + 175, filterTop + 17, { width: 185 });
    doc
      .text(typeLabel, marginL + 370, filterTop + 17, { width: 152 });

    doc.y = filterTop + 44;

    // ───────────────────────────────────────────────────────────────────────────
    // SECTION 1: RESUMEN EJECUTIVO DE COSTOS Y CUMPLIMIENTO
    // ───────────────────────────────────────────────────────────────────────────
    drawSectionHeading(
      '1',
      'RESUMEN EJECUTIVO DE COSTOS Y CUMPLIMIENTO',
      `Consolidado financiero de órdenes de trabajo cerradas (estado completada) e historial de bitácora técnica para ${input.tenant.name}.`
    );

    const kpiTop = doc.y + 2;
    const cardGap = 8;
    const cardW = (contentW - cardGap * 3) / 4;
    const kpiCards = [
      {
        label: 'OT CERRADAS',
        value: `${input.closedWorkOrders.length}`,
        sub: `${input.vehicles.length} unidad(es) en alcance`,
        color: COLORS.accent,
      },
      {
        label: 'REFACCIONES',
        value: fmtMxn(refaccionesMxn),
        sub: `${totalPartsQty} pza(s) · ${stockDeductedCount} OT c/ almacén`,
        color: COLORS.ink,
      },
      {
        label: 'INSUMOS / LUBRICANTES',
        value: fmtMxn(insumosMxn),
        sub: 'Consumibles de taller',
        color: COLORS.ink,
      },
      {
        label: 'MANO DE OBRA',
        value: fmtMxn(manoObraMxn),
        sub: 'Técnicos internos y externos',
        color: COLORS.ink,
      },
    ];

    kpiCards.forEach((c, idx) => {
      const cx = marginL + idx * (cardW + cardGap);
      doc
        .roundedRect(cx, kpiTop, cardW, 48, 3)
        .fillAndStroke(COLORS.surface, COLORS.border);
      doc
        .font('Helvetica-Bold')
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(c.label, cx + 8, kpiTop + 7, { width: cardW - 16 });
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(c.color)
        .text(c.value, cx + 8, kpiTop + 19, { width: cardW - 16 });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(c.sub, cx + 8, kpiTop + 34, { width: cardW - 16 });
    });

    const totalStripY = kpiTop + 54;
    doc
      .roundedRect(marginL, totalStripY, contentW, 24, 3)
      .fillAndStroke('#ECFDF5', '#A7F3D0');
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(COLORS.emerald)
      .text(
        `INVERSIÓN TOTAL EN ÓRDENES CERRADAS: ${fmtMxn(totalWorkOrdersMxn)}`,
        marginL + 10,
        totalStripY + 7,
        { width: contentW * 0.62 }
      );
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.slate)
      .text(
        `Bitácora técnica total: ${input.maintenanceRecords.length} reg. (${fmtMxn(totalLogbookMxn)})`,
        marginL + 10,
        totalStripY + 7,
        { width: contentW - 20, align: 'right' }
      );

    doc.y = totalStripY + 34;

    // ───────────────────────────────────────────────────────────────────────────
    // SECTION 2: ÓRDENES DE TRABAJO CERRADAS Y DESGLOSE DE REFACCIONES
    // ───────────────────────────────────────────────────────────────────────────
    drawSectionHeading(
      '2',
      `DETALLE DE ÓRDENES DE TRABAJO CERRADAS (${input.closedWorkOrders.length})`,
      'Listado auditable de órdenes en estado completada con lecturas de cierre, taller responsable y consumo de refacciones/SKUs.'
    );

    if (input.closedWorkOrders.length === 0) {
      ensureSpace(36);
      doc
        .roundedRect(marginL, doc.y, contentW, 28, 3)
        .fillAndStroke(COLORS.surface, COLORS.border);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(
          'No se registran órdenes de trabajo cerradas (completadas) con los filtros de empresa, fecha, unidad y tipo seleccionados.',
          marginL + 10,
          doc.y + 9,
          { width: contentW - 20 }
        );
      doc.y += 38;
    } else {
      for (const wo of input.closedWorkOrders) {
        const partsRowsHeight = wo.parts.length > 0 ? 18 + wo.parts.length * 14 : 16;
        const estimatedBlockH = 66 + partsRowsHeight;
        ensureSpace(Math.min(estimatedBlockH, 160));

        const cardStartY = doc.y;
        // Order Header Bar
        doc
          .rect(marginL, cardStartY, contentW, 20)
          .fillAndStroke(COLORS.surfaceAlt, COLORS.border);
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor(COLORS.accentDark)
          .text(`${wo.id} · ${wo.unitCode} (${wo.plate})`, marginL + 8, cardStartY + 5, {
            width: 240,
          });
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.slate)
          .text(
            `${TYPE_LABELS[wo.type]} · Prioridad ${PRIORITY_LABELS[wo.priority]} · Cierre: ${fmtDateShort(wo.completedAt ?? wo.scheduledDate)}`,
            marginL + 190,
            cardStartY + 5.5,
            { width: 225, align: 'center' }
          );
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor(COLORS.emerald)
          .text(fmtMxn(wo.totalCost), marginL + 410, cardStartY + 5, {
            width: contentW - 418,
            align: 'right',
          });

        let curY = cardStartY + 24;
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor(COLORS.ink)
          .text(wo.title, marginL + 8, curY, { width: contentW - 16 });
        curY = doc.y + 2;

        doc
          .font('Helvetica')
          .fontSize(7.8)
          .fillColor(COLORS.slate)
          .text(
            `Taller/Técnico: ${wo.workshopOrTech}   |   Horómetro cierre: ${fmtNum(wo.engineHoursAtOrder)} h   |   Odómetro: ${fmtNum(wo.odometerAtOrder)} km   |   Almacén: ${wo.stockDeducted ? 'Descontado' : 'Captura directa'}`,
            marginL + 8,
            curY,
            { width: contentW - 16 }
          );
        curY = doc.y + 4;

        // Parts sub-table
        if (wo.parts.length > 0) {
          ensureSpace(28);
          const tblX = marginL + 8;
          const tblW = contentW - 16;
          doc
            .rect(tblX, curY, tblW, 14)
            .fill('#E2E8F0');
          doc
            .font('Helvetica-Bold')
            .fontSize(7)
            .fillColor(COLORS.ink);
          doc.text('SKU', tblX + 4, curY + 3.5, { width: 82 });
          doc.text('DESCRIPCIÓN REFACCIÓN / INSUMO', tblX + 88, curY + 3.5, { width: 195 });
          doc.text('CATEGORÍA', tblX + 286, curY + 3.5, { width: 65 });
          doc.text('CANT.', tblX + 354, curY + 3.5, { width: 35, align: 'right' });
          doc.text('P. UNIT.', tblX + 392, curY + 3.5, { width: 58, align: 'right' });
          doc.text('SUBTOTAL', tblX + 454, curY + 3.5, { width: tblW - 458, align: 'right' });

          curY += 14;
          for (let pi = 0; pi < wo.parts.length; pi++) {
            if (curY + 14 > bottomLimit) {
              doc.addPage();
              drawContinuationHeader();
              curY = doc.y;
            }
            const part = wo.parts[pi];
            if (pi % 2 === 1) {
              doc.rect(tblX, curY, tblW, 13.5).fill(COLORS.surface);
            }
            doc.font('Helvetica').fontSize(7.3).fillColor(COLORS.slate);
            doc.text(part.sku || 'S/SKU', tblX + 4, curY + 3, { width: 82, lineBreak: false });
            doc.text(part.name, tblX + 88, curY + 3, { width: 195, lineBreak: false });
            doc.text(
              part.category === 'refaccion'
                ? 'Refacción'
                : part.category === 'insumo'
                  ? 'Insumo'
                  : 'Mano de obra',
              tblX + 286,
              curY + 3,
              { width: 65, lineBreak: false }
            );
            doc.text(String(part.quantity), tblX + 354, curY + 3, { width: 35, align: 'right', lineBreak: false });
            doc.text(fmtMxn(part.unitCost), tblX + 392, curY + 3, { width: 58, align: 'right', lineBreak: false });
            doc.font('Helvetica-Bold').fillColor(COLORS.ink);
            doc.text(fmtMxn(part.subtotal), tblX + 454, curY + 3, {
              width: tblW - 458,
              align: 'right',
              lineBreak: false,
            });
            curY += 13.5;
          }
        }

        // Cost footer line + notes
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(
            `Desglose OT: Refacciones/Insumos ${fmtMxn(wo.partsCost)} + Mano de obra ${fmtMxn(wo.laborCost)} = ${fmtMxn(wo.totalCost)}`,
            marginL + 8,
            curY + 3,
            { width: contentW - 16 }
          );
        curY = doc.y + 1;

        if (wo.notes?.trim()) {
          doc
            .font('Helvetica-Oblique')
            .fontSize(7.4)
            .fillColor(COLORS.muted)
            .text(`Notas de cierre: ${wo.notes}`, marginL + 8, curY, { width: contentW - 16 });
          curY = doc.y + 2;
        }

        doc
          .moveTo(marginL, curY + 4)
          .lineTo(marginL + contentW, curY + 4)
          .lineWidth(0.6)
          .strokeColor(COLORS.border)
          .stroke();
        doc.y = curY + 10;
      }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // SECTION 3: BITÁCORA E HISTORIAL DE MANTENIMIENTO POR UNIDAD
    // ───────────────────────────────────────────────────────────────────────────
    drawSectionHeading(
      '3',
      `HISTORIAL Y BITÁCORA DE MANTENIMIENTO POR UNIDAD (${input.maintenanceRecords.length} REGISTROS)`,
      'Trazabilidad cronológica por unidad con lectura acumulada de horómetro/odómetro y servicios asentados en bitácora.'
    );

    const recordsByVehicle = new Map<string, MaintenanceRecord[]>();
    for (const r of input.maintenanceRecords) {
      const list = recordsByVehicle.get(r.vehicleId) ?? [];
      list.push(r);
      recordsByVehicle.set(r.vehicleId, list);
    }

    const vehicleMap = new Map(input.vehicles.map((v) => [v.id, v]));
    const unitIdsWithActivity = new Set<string>([
      ...recordsByVehicle.keys(),
      ...input.closedWorkOrders.map((w) => w.vehicleId),
    ]);

    const unitsToRender =
      input.filters.vehicleId && input.filters.vehicleId !== 'all'
        ? input.vehicles
        : input.vehicles.filter((v) => unitIdsWithActivity.has(v.id));

    if (unitsToRender.length === 0) {
      ensureSpace(34);
      doc
        .roundedRect(marginL, doc.y, contentW, 26, 3)
        .fillAndStroke(COLORS.surface, COLORS.border);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text('Sin registros de bitácora histórica en el periodo y filtros seleccionados.', marginL + 10, doc.y + 8, {
          width: contentW - 20,
        });
      doc.y += 34;
    } else {
      for (const veh of unitsToRender) {
        const unitRecs = recordsByVehicle.get(veh.id) ?? [];
        const unitClosedWos = input.closedWorkOrders.filter((w) => w.vehicleId === veh.id);
        const unitTotalMxn =
          unitClosedWos.length > 0
            ? unitClosedWos.reduce((s, w) => s + w.totalCost, 0)
            : unitRecs.reduce((s, r) => s + r.cost, 0);

        ensureSpace(46);
        const uTop = doc.y;
        doc
          .roundedRect(marginL, uTop, contentW, 20, 2)
          .fillAndStroke(COLORS.surfaceAlt, COLORS.border);
        doc
          .font('Helvetica-Bold')
          .fontSize(8.2)
          .fillColor(COLORS.ink)
          .text(
            `${veh.unitCode} · ${veh.brandModel} (${veh.plate}) · ${ASSET_LABELS[veh.assetType]}`,
            marginL + 8,
            uTop + 5.5,
            { width: 320 }
          );
        doc
          .font('Helvetica')
          .fontSize(7.6)
          .fillColor(COLORS.slate)
          .text(
            `${fmtNum(veh.engineHours)} h · ${fmtNum(veh.odometerKm)} km · ${unitClosedWos.length} OT · ${unitRecs.length} bitácora (${fmtMxn(unitTotalMxn)})`,
            marginL + 260,
            uTop + 6,
            { width: contentW - 268, align: 'right' }
          );

        let ry = uTop + 23;
        if (unitRecs.length === 0) {
          doc
            .font('Helvetica-Oblique')
            .fontSize(7.6)
            .fillColor(COLORS.muted)
            .text('Sin asientos adicionales en bitácora técnica para el rango de fechas.', marginL + 8, ry, {
              width: contentW - 16,
            });
          doc.y = ry + 14;
        } else {
          // Table header
          doc.rect(marginL, ry, contentW, 13.5).fill('#E2E8F0');
          doc.font('Helvetica-Bold').fontSize(7).fillColor(COLORS.ink);
          doc.text('FECHA', marginL + 6, ry + 3, { width: 58 });
          doc.text('TIPO', marginL + 66, ry + 3, { width: 65 });
          doc.text('DESCRIPCIÓN DEL SERVICIO / TALLER', marginL + 134, ry + 3, { width: 226 });
          doc.text('LECTURA', marginL + 364, ry + 3, { width: 92, align: 'right' });
          doc.text('COSTO', marginL + 460, ry + 3, { width: contentW - 466, align: 'right' });
          ry += 13.5;

          for (let ri = 0; ri < unitRecs.length; ri++) {
            if (ry + 22 > bottomLimit) {
              doc.addPage();
              drawContinuationHeader();
              ry = doc.y;
            }
            const rec = unitRecs[ri];
            if (ri % 2 === 1) {
              doc.rect(marginL, ry, contentW, 19).fill(COLORS.surface);
            }
            doc.font('Helvetica').fontSize(7.3).fillColor(COLORS.slate);
            doc.text(fmtDateShort(rec.performedAt), marginL + 6, ry + 4, { width: 58, lineBreak: false });
            doc.text(TYPE_LABELS[rec.type], marginL + 66, ry + 4, { width: 65, lineBreak: false });
            doc.font('Helvetica-Bold').fillColor(COLORS.ink);
            doc.text(rec.title, marginL + 134, ry + 2.5, { width: 226, lineBreak: false });
            doc.font('Helvetica').fontSize(6.8).fillColor(COLORS.muted);
            doc.text(`${rec.workshopOrTech}${rec.notes ? ` · ${rec.notes}` : ''}`, marginL + 134, ry + 11, {
              width: 226,
              lineBreak: false,
            });
            doc.font('Helvetica').fontSize(7.2).fillColor(COLORS.slate);
            doc.text(
              `${fmtNum(rec.engineHoursAtService)} h / ${fmtNum(rec.odometerAtService)} km`,
              marginL + 364,
              ry + 5,
              { width: 92, align: 'right', lineBreak: false }
            );
            doc.font('Helvetica-Bold').fillColor(COLORS.ink);
            doc.text(fmtMxn(rec.cost), marginL + 460, ry + 5, {
              width: contentW - 466,
              align: 'right',
              lineBreak: false,
            });
            ry += 19.5;
          }
          doc.y = ry + 6;
        }
      }
    }

    // Handle any orphan vehicle in records not in vehicleMap cleanly (no-op safeguard)
    void vehicleMap;

    // ───────────────────────────────────────────────────────────────────────────
    // SECTION 4: SELLO CRIPTOGRÁFICO DE INTEGRIDAD & BLOQUE DE FIRMAS
    // ───────────────────────────────────────────────────────────────────────────
    ensureSpace(148);
    drawSectionHeading(
      '4',
      'VERIFICACIÓN DE INTEGRIDAD Y BLOQUE DE FIRMAS PARA AUDITORÍA EXTERNA'
    );

    const verifyY = doc.y + 2;
    doc
      .roundedRect(marginL, verifyY, contentW, 44, 3)
      .fillAndStroke(COLORS.surface, COLORS.border);
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLORS.accentDark)
      .text(`FOLIO DE AUDITORÍA: ${auditFolio}   ·   EMISIÓN: ${fmtDateTime(generatedAt)}`, marginL + 10, verifyY + 7, {
        width: contentW - 20,
      });
    doc
      .font('Courier')
      .fontSize(7.5)
      .fillColor(COLORS.ink)
      .text(`SHA-256 INTEGRIDAD: ${sha256}`, marginL + 10, verifyY + 19, {
        width: contentW - 20,
      });
    doc
      .font('Helvetica')
      .fontSize(7.2)
      .fillColor(COLORS.muted)
      .text(
        `Documento emitido automáticamente por Vigilant FleetOps bajo aislamiento multi-empresa para ${input.tenant.name} (${input.tenant.taxId}).`,
        marginL + 10,
        verifyY + 31,
        { width: contentW - 20 }
      );

    const sigTop = verifyY + 56;
    const sigGap = 14;
    const sigW = (contentW - sigGap * 2) / 3;
    const signers = [
      {
        title: 'RESPONSABLE DE FLOTA',
        subtitle: input.tenant.name,
        caption: 'Nombre, firma y fecha',
      },
      {
        title: 'JEFE DE TALLER / MANTENIMIENTO',
        subtitle: 'Validación técnica y refacciones',
        caption: 'Nombre, firma y sello',
      },
      {
        title: 'AUDITOR EXTERNO REVISOR',
        subtitle: `Folio ${auditFolio}`,
        caption: 'Nombre, matrícula y fecha',
      },
    ];

    signers.forEach((s, idx) => {
      const sx = marginL + idx * (sigW + sigGap);
      doc
        .roundedRect(sx, sigTop, sigW, 66, 3)
        .fillAndStroke(COLORS.white, COLORS.border);
      doc
        .moveTo(sx + 12, sigTop + 38)
        .lineTo(sx + sigW - 12, sigTop + 38)
        .lineWidth(0.7)
        .strokeColor(COLORS.slate)
        .stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(7.2)
        .fillColor(COLORS.ink)
        .text(s.title, sx + 8, sigTop + 42, { width: sigW - 16, align: 'center' });
      doc
        .font('Helvetica')
        .fontSize(6.8)
        .fillColor(COLORS.muted)
        .text(s.subtitle, sx + 8, sigTop + 51, { width: sigW - 16, align: 'center', lineBreak: false });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // ALL-PAGE FOOTER STAMPING (Página X de Y + SHA-256)
    // ───────────────────────────────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footerY = pageH - 36;
      doc
        .moveTo(marginL, footerY - 6)
        .lineTo(marginL + contentW, footerY - 6)
        .lineWidth(0.5)
        .strokeColor(COLORS.border)
        .stroke();

      doc
        .font('Helvetica')
        .fontSize(7.2)
        .fillColor(COLORS.muted)
        .text(`${input.tenant.name} · ${input.tenant.taxId} · ${auditFolio}`, marginL, footerY, {
          width: 240,
          lineBreak: false,
        });
      doc
        .font('Courier')
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(`SHA-256: ${sha256.slice(0, 18)}...`, marginL + 210, footerY, {
          width: 160,
          align: 'center',
          lineBreak: false,
        });
      doc
        .font('Helvetica-Bold')
        .fontSize(7.2)
        .fillColor(COLORS.slate)
        .text(`Página ${i + 1} de ${range.count}`, marginL + 380, footerY, {
          width: contentW - 380,
          align: 'right',
          lineBreak: false,
        });
    }

    doc.end();
  });

  return {
    buffer,
    auditFolio,
    sha256,
    generatedAt,
    fileName,
    summary: {
      closedOrdersCount: input.closedWorkOrders.length,
      logbookCount: input.maintenanceRecords.length,
      unitsCount: unitsToCount(input.vehicles, input.closedWorkOrders, input.maintenanceRecords, input.filters.vehicleId),
      refaccionesMxn,
      insumosMxn,
      manoObraMxn,
      totalWorkOrdersMxn,
      totalLogbookMxn,
    },
  };
}

function unitsToCount(
  vehicles: Vehicle[],
  closedWos: WorkOrder[],
  records: MaintenanceRecord[],
  vehicleId?: string
): number {
  if (vehicleId && vehicleId !== 'all') return vehicles.length;
  const ids = new Set<string>([...closedWos.map((w) => w.vehicleId), ...records.map((r) => r.vehicleId)]);
  return ids.size > 0 ? ids.size : vehicles.length;
}
