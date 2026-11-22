/**
 * The five exports (fleet, unit dossier, work orders, drivers, alerts) as format-neutral
 * reports. Labels come from src/shared so files say exactly what the panel says.
 */
import type {
  AlertEvent,
  AlertPriority,
  AlertStatus,
  Device,
  DriverListItem,
  Incident,
  IncidentStatus,
  MaintenanceRecord,
  MaintenanceStatus,
  OperationalStatus,
  Vehicle,
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
} from '../../src/shared/types.ts';
import {
  ALERT_STATUS_META,
  ASSET_TYPE_LABELS,
  INCIDENT_STATUS_META,
  LINK_META,
  MAINTENANCE_META,
  PRIORITY_META,
  STATUS_META,
  WORK_ORDER_PRIORITY_META,
  WORK_ORDER_STATUS_META,
} from '../../src/shared/labels.ts';
import {
  AUTH_STATE_LABELS,
  daysUntil,
  DOC_TYPES,
  DRIVER_PROFILES,
  EXPIRY_WARNING_DAYS,
  verificationStatus,
  type DriverAuthState,
  type DriverProfile,
} from '../../src/shared/drivers.ts';
import { formatCuit } from '../../src/shared/cuit.ts';
import { formatMoney } from '../../src/shared/currency.ts';
import { filterList, formatDate, parseDate, section, status, type Column, type Kpi, type MoneyCurrency, type Report, type Row, type Tone } from './report.ts';

/** Who exports and for which company; `tenantName` resolves the company of each row when exporting "all". */
export interface ExportContext {
  company: string;
  generatedBy: string;
  multiTenant: boolean;
  tenantName: (tenantId: string) => string;
  now?: Date;
  /** Currency of a company (null when the superadmin hasn't defined it). */
  currencyOf?: (tenantId: string) => MoneyCurrency | null;
  /**
   * Consolidated export (all companies): currency every amount is converted to, and the
   * conversion with the rate of a date (null when the company has no currency or a rate is missing).
   */
  reference?: MoneyCurrency;
  toReference?: (tenantId: string, amount: number, dateIso: string) => number | null;
}

const OPERATIONAL_TONE: Record<OperationalStatus, Tone> = { en_ruta: 'ok', detenido: 'muted', alerta: 'bad', sin_senal: 'warn' };
const MAINTENANCE_TONE: Record<MaintenanceStatus, Tone> = { al_dia: 'ok', proximo: 'warn', vencido: 'bad' };
const WO_STATUS_TONE: Record<WorkOrderStatus, Tone> = {
  abierta: 'info',
  en_taller: 'warn',
  esperando_refacciones: 'warn',
  completada: 'ok',
  cancelada: 'muted',
};
const WO_PRIORITY_TONE: Record<WorkOrderPriority, Tone> = { critica: 'bad', alta: 'warn', media: 'info', baja: 'muted' };
const ALERT_PRIORITY_TONE: Record<AlertPriority, Tone> = { critica: 'bad', alta: 'warn', media: 'info', informativa: 'muted' };
const ALERT_STATUS_TONE: Record<AlertStatus, Tone> = { pendiente: 'warn', confirmada: 'ok', escalada: 'bad' };
const INCIDENT_TONE: Record<IncidentStatus, Tone> = { abierto: 'warn', en_investigacion: 'info', escalado: 'bad', resuelto: 'ok' };
const AUTH_TONE: Record<DriverAuthState, Tone> = { habilitado: 'ok', por_vencer: 'warn', pendiente: 'info', no_autorizado: 'bad', deshabilitado: 'muted' };
const PART_CATEGORY: Record<string, string> = { refaccion: 'Repuesto', insumo: 'Insumo', mano_obra: 'Mano de obra' };
const ORDER_TYPE: Record<WorkOrder['type'], string> = { preventivo: 'Preventivo', correctivo: 'Correctivo', inspeccion: 'Inspección' };

const companyColumn = (ctx: ExportContext): Column[] => (ctx.multiTenant ? [{ key: 'empresa', label: 'Empresa', kind: 'text', width: 18 }] : []);
const base = (ctx: ExportContext) => ({ company: ctx.company, generatedBy: ctx.generatedBy, generatedAt: ctx.now ?? new Date() });

const formatMoneyCell = (n: number, cur: MoneyCurrency | null) => (cur ? formatMoney(n, cur) : `${formatMoney(n, null)} (sin moneda)`);

/** Single-company exports: the company's currency for every money column. */
const singleCurrency = (ctx: ExportContext, tenantId: string | undefined): MoneyCurrency | null =>
  tenantId && ctx.currencyOf ? ctx.currencyOf(tenantId) : null;
const countWhere = <T>(items: T[], pred: (x: T) => boolean) => items.filter(pred).length;

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------
export function fleetReport(vehicles: Vehicle[], ctx: ExportContext): Report {
  const rows: Row[] = vehicles.map((v) => ({
    unidad: v.unitCode,
    empresa: ctx.tenantName(v.tenantId),
    tipo: ASSET_TYPE_LABELS[v.assetType] ?? v.assetType,
    patente: v.plate,
    modelo: v.brandModel,
    anio: v.year ? String(v.year) : '',
    sucursal: v.branch,
    chofer: v.driverName,
    estado: status(STATUS_META[v.operationalStatus]?.label ?? v.operationalStatus, OPERATIONAL_TONE[v.operationalStatus] ?? 'muted'),
    horometro: v.engineHours,
    proxH: v.nextServiceHours,
    odometro: Math.round(v.odometerKm),
    proxKm: Math.round(v.nextServiceKm),
    proxFecha: v.nextServiceDate,
    mantenimiento: status(MAINTENANCE_META[v.maintenanceStatus]?.label ?? v.maintenanceStatus, MAINTENANCE_TONE[v.maintenanceStatus] ?? 'muted'),
    fallas: v.faultCodes.length,
    detalleFallas: v.faultCodes.map((f) => `${f.code}: ${f.description}`).join(' | '),
  }));
  const columns: Column[] = [
    { key: 'unidad', label: 'Unidad', kind: 'text', width: 11, total: 'count' },
    ...companyColumn(ctx),
    { key: 'tipo', label: 'Tipo', kind: 'text', width: 13 },
    { key: 'patente', label: 'Patente', kind: 'text', width: 10 },
    { key: 'modelo', label: 'Marca y modelo', kind: 'text', width: 20 },
    { key: 'anio', label: 'Año', kind: 'text', width: 6 },
    { key: 'sucursal', label: 'Sucursal', kind: 'text', width: 14 },
    { key: 'chofer', label: 'Chofer', kind: 'text', width: 18 },
    { key: 'estado', label: 'Estado', kind: 'status', width: 17 },
    { key: 'horometro', label: 'Horómetro (h)', kind: 'number', decimals: 1, width: 11 },
    { key: 'proxH', label: 'Próximo servicio (h)', kind: 'number', decimals: 1, width: 11 },
    { key: 'odometro', label: 'Odómetro (km)', kind: 'number', width: 11 },
    { key: 'proxKm', label: 'Próximo servicio (km)', kind: 'number', width: 11 },
    { key: 'proxFecha', label: 'Fecha próximo servicio', kind: 'date', width: 11 },
    { key: 'mantenimiento', label: 'Mantenimiento', kind: 'status', width: 15 },
    { key: 'fallas', label: 'Fallas activas', kind: 'number', width: 8, total: 'sum' },
    { key: 'detalleFallas', label: 'Detalle de fallas', kind: 'text', width: 30 },
  ];
  const kpis: Kpi[] = [
    { label: 'Unidades', value: vehicles.length, formula: { section: 'unidades', column: 'unidad', op: 'count' } },
    {
      label: 'En ruta / operando',
      value: countWhere(vehicles, (v) => v.operationalStatus === 'en_ruta'),
      tone: 'ok',
      formula: { section: 'unidades', column: 'estado', op: 'count', equals: STATUS_META.en_ruta.label },
    },
    {
      label: 'Servicio vencido',
      value: countWhere(vehicles, (v) => v.maintenanceStatus === 'vencido'),
      tone: 'bad',
      formula: { section: 'unidades', column: 'mantenimiento', op: 'count', equals: MAINTENANCE_META.vencido.label },
    },
    {
      label: 'Servicio próximo',
      value: countWhere(vehicles, (v) => v.maintenanceStatus === 'proximo'),
      tone: 'warn',
      formula: { section: 'unidades', column: 'mantenimiento', op: 'count', equals: MAINTENANCE_META.proximo.label },
    },
    { label: 'Unidades con fallas', value: countWhere(vehicles, (v) => v.faultCodes.length > 0), tone: 'bad' },
  ];
  return {
    ...base(ctx),
    title: 'Reporte de flota y mantenimiento',
    subtitle: 'Estado operativo, próximos servicios y fallas de cada unidad',
    filters: [],
    kpis,
    orientation: 'landscape',
    sections: [section({ id: 'unidades', title: 'Unidades', columns, rows, empty: 'No hay unidades registradas.' })],
  };
}

// ---------------------------------------------------------------------------
// Unit dossier
// ---------------------------------------------------------------------------
export interface Dossier {
  vehicle: Vehicle;
  device: Device | null;
  maintenance: MaintenanceRecord[];
  alerts: AlertEvent[];
  incidents: Incident[];
}

const KV: Column[] = [
  { key: 'dato', label: 'Dato', kind: 'text', width: 16 },
  { key: 'valor', label: 'Valor', kind: 'auto', width: 34 },
];

export function vehicleReport(d: Dossier, ctx: ExportContext): Report {
  const v = d.vehicle;
  const remainingH = Number((v.nextServiceHours - v.engineHours).toFixed(1));
  const remainingKm = Math.round(v.nextServiceKm - v.odometerKm);
  const nextDate = parseDate(v.nextServiceDate);
  const unit: Row[] = [
    ['Unidad', v.unitCode],
    ['Tipo', ASSET_TYPE_LABELS[v.assetType] ?? v.assetType],
    ['Patente', v.plate],
    ['Marca y modelo', v.brandModel],
    ['Año', v.year ? String(v.year) : ''],
    ['Empresa', ctx.tenantName(v.tenantId)],
    ['Sucursal', v.branch],
    ['Grupo', v.group],
    ['Chofer', v.driverName],
    ['Estado operativo', status(STATUS_META[v.operationalStatus]?.label ?? v.operationalStatus, OPERATIONAL_TONE[v.operationalStatus] ?? 'muted')],
    ['Mantenimiento', status(MAINTENANCE_META[v.maintenanceStatus]?.label ?? v.maintenanceStatus, MAINTENANCE_TONE[v.maintenanceStatus] ?? 'muted')],
    ['Horómetro (h)', v.engineHours],
    ['Próximo servicio (h)', v.nextServiceHours],
    ['Odómetro (km)', Math.round(v.odometerKm)],
    ['Próximo servicio (km)', Math.round(v.nextServiceKm)],
    ['Fecha próximo servicio', nextDate ? formatDate(nextDate) : v.nextServiceDate],
    ['Combustible (%)', v.fuelLevelPct],
    ['RPM', v.rpm],
    ['Temperatura motor (°C)', v.coolantTempC],
    ['Ubicación', `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`],
    ['Códigos de falla', v.faultCodes.map((f) => `${f.code}: ${f.description}`).join(' | ') || 'Sin fallas'],
  ].map(([dato, valor]) => ({ dato, valor }) as Row);

  const dev = d.device;
  const device: Row[] = dev
    ? [
        ['Modelo', dev.model],
        ['IMEI', dev.imei],
        ['ID de terminal', dev.terminalId],
        ['ICCID', dev.iccid],
        ['Operador SIM', dev.simCarrier],
        ['Protocolo', dev.protocol],
        ['Firmware', dev.firmware],
        ['Canales de video', dev.channels.join(', ') || '—'],
        ['Enlace', status(LINK_META[dev.linkStatus]?.label ?? dev.linkStatus, dev.linkStatus === 'conectado' ? 'ok' : dev.linkStatus === 'intermitente' ? 'warn' : 'bad')],
        ['Hardware validado', dev.hardwareValidated ? 'Sí' : 'No'],
        ['Último reporte', dev.lastHeartbeatAt ? formatDate(new Date(dev.lastHeartbeatAt), true) : '—'],
      ].map(([dato, valor]) => ({ dato, valor }) as Row)
    : [];

  const maintenance: Row[] = d.maintenance.map((m) => ({
    fecha: m.performedAt,
    tipo: ORDER_TYPE[m.type] ?? m.type,
    titulo: m.title,
    taller: m.workshopOrTech,
    horas: m.engineHoursAtService,
    km: Math.round(m.odometerAtService),
    costo: m.cost,
    estado: status(m.status === 'completado' ? 'Completado' : 'Programado', m.status === 'completado' ? 'ok' : 'info'),
    notas: m.notes,
  }));
  const alerts: Row[] = d.alerts.map((a) => alertRow(a, ctx));
  const incidents: Row[] = d.incidents.map((i) => incidentRow(i, ctx));
  const totalCost = d.maintenance.reduce((s, m) => s + (m.cost || 0), 0);

  return {
    ...base(ctx),
    title: `Ficha de la unidad ${v.unitCode}`,
    subtitle: `${v.brandModel} · ${v.plate}`,
    currency: singleCurrency(ctx, v.tenantId),
    filters: [],
    showFilters: false,
    orientation: 'portrait',
    kpis: [
      { label: 'Horas al próximo servicio', value: remainingH, tone: remainingH <= 0 ? 'bad' : remainingH <= 24 ? 'warn' : 'ok' },
      { label: 'Km al próximo servicio', value: remainingKm, tone: remainingKm <= 0 ? 'bad' : remainingKm <= 500 ? 'warn' : 'ok' },
      { label: 'Combustible (%)', value: v.fuelLevelPct, tone: v.fuelLevelPct < 15 ? 'warn' : 'muted' },
      { label: 'Fallas activas', value: v.faultCodes.length, tone: v.faultCodes.length ? 'bad' : 'ok' },
      { label: 'Costo de mantenimientos', value: totalCost, format: 'money', formula: { section: 'mantenimientos', column: 'costo', op: 'sum' } },
    ],
    sections: [
      section({ id: 'unidad', title: 'Datos de la unidad', columns: KV, rows: unit, empty: '' }),
      section({ id: 'equipo', title: 'Equipo instalado', columns: KV, rows: device, empty: 'La unidad no tiene un equipo asociado.' }),
      section({
        id: 'mantenimientos',
        title: 'Historial de mantenimiento',
        columns: [
          { key: 'fecha', label: 'Fecha', kind: 'date', width: 10 },
          { key: 'tipo', label: 'Tipo', kind: 'text', width: 10 },
          { key: 'titulo', label: 'Servicio', kind: 'text', width: 22, total: 'count' },
          { key: 'taller', label: 'Taller o técnico', kind: 'text', width: 16 },
          { key: 'horas', label: 'Horómetro (h)', kind: 'number', decimals: 1, width: 10 },
          { key: 'km', label: 'Odómetro (km)', kind: 'number', width: 10 },
          { key: 'costo', label: 'Costo', kind: 'money', width: 12, total: 'sum' },
          { key: 'estado', label: 'Estado', kind: 'status', width: 12 },
          { key: 'notas', label: 'Notas', kind: 'text', width: 30 },
        ],
        rows: maintenance,
        empty: 'Sin mantenimientos registrados.',
      }),
      section({ id: 'alertas', title: 'Alertas', columns: alertColumns({ ...ctx, multiTenant: false }), rows: alerts, empty: 'Sin alertas para esta unidad.' }),
      section({ id: 'incidentes', title: 'Incidentes', columns: incidentColumns({ ...ctx, multiTenant: false }), rows: incidents, empty: 'Sin incidentes para esta unidad.' }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------
export function workOrdersReport(orders: WorkOrder[], ctx: ExportContext): Report {
  // Consolidated (all companies): amounts converted to the reference currency with the rate of
  // each order's date; the original currency and total stay in their own columns.
  const consolidated = ctx.multiTenant && Boolean(ctx.reference && ctx.toReference);
  const orderDate = (o: WorkOrder) => o.completedAt || o.createdAt || `${o.scheduledDate}T23:59:59Z`;
  const amount = (o: WorkOrder, n: number) => (consolidated ? ctx.toReference!(o.tenantId, n, orderDate(o)) : n);
  let notConverted = 0;
  const rows: Row[] = orders.map((o) => {
    const total = amount(o, o.totalCost);
    if (consolidated && total === null) notConverted++;
    const own = ctx.currencyOf?.(o.tenantId) ?? null;
    return {
    id: o.id,
    empresa: ctx.tenantName(o.tenantId),
    unidad: o.unitCode,
    patente: o.plate,
    activo: ASSET_TYPE_LABELS[o.assetType] ?? o.assetType,
    tipo: ORDER_TYPE[o.type] ?? o.type,
    prioridad: status(WORK_ORDER_PRIORITY_META[o.priority]?.label ?? o.priority, WO_PRIORITY_TONE[o.priority] ?? 'muted'),
    estado: status(WORK_ORDER_STATUS_META[o.status]?.label ?? o.status, WO_STATUS_TONE[o.status] ?? 'muted'),
    titulo: o.title,
    taller: o.workshopOrTech,
    programada: o.scheduledDate,
    completada: o.completedAt ?? '',
    origen: o.autoGenerated ? 'Automática' : 'Manual',
    manoObra: amount(o, o.laborCost),
    piezas: amount(o, o.partsCost),
    total,
    moneda: own?.code ?? 'Sin moneda',
    totalOriginal: own ? o.totalCost : null,
    totalOriginalTexto: formatMoneyCell(o.totalCost, own),
    };
  });
  const parts: Row[] = orders.flatMap((o) =>
    o.parts.map((p) => ({
      ot: o.id,
      unidad: o.unitCode,
      sku: p.sku,
      nombre: p.name,
      categoria: PART_CATEGORY[p.category] ?? p.category,
      cantidad: p.quantity,
      unitario: amount(o, p.unitCost),
      subtotal: amount(o, p.subtotal),
      monedaOriginal: p.original ? `${p.original.currency} ${p.original.amount}` : '',
      descontado: o.stockDeducted ? 'Sí' : 'No',
    }))
  );
  const is = (s: WorkOrderStatus) => (o: WorkOrder) => o.status === s;
  const statusKpi = (label: string, s: WorkOrderStatus, tone: Tone): Kpi => ({
    label,
    value: countWhere(orders, is(s)),
    tone,
    formula: { section: 'ordenes', column: 'estado', op: 'count', equals: WORK_ORDER_STATUS_META[s].label },
  });
  return {
    ...base(ctx),
    title: 'Órdenes de trabajo',
    subtitle: consolidated
      ? `Todas las empresas · importes convertidos a ${ctx.reference!.code} con el tipo de cambio de la fecha de cada orden${notConverted ? ` · ${notConverted} orden(es) sin tipo de cambio quedan fuera de los totales` : ''}`
      : 'Todas las órdenes de la empresa, abiertas y cerradas, con costos y repuestos',
    filters: [],
    orientation: 'landscape',
    kpis: [
      { label: 'Órdenes', value: orders.length, formula: { section: 'ordenes', column: 'id', op: 'count' } },
      statusKpi('Abiertas', 'abierta', 'info'),
      statusKpi('En taller', 'en_taller', 'warn'),
      statusKpi('Esperando refacciones', 'esperando_refacciones', 'warn'),
      statusKpi('Completadas', 'completada', 'ok'),
      {
        label: consolidated ? `Costo total (${ctx.reference!.code})` : 'Costo total',
        value: rows.reduce((s, r) => s + (typeof r.total === 'number' ? r.total : 0), 0),
        format: 'money',
        formula: { section: 'ordenes', column: 'total', op: 'sum' },
      },
    ],
    currency: consolidated ? ctx.reference! : ctx.multiTenant ? null : singleCurrency(ctx, orders[0]?.tenantId),
    sections: [
      section({
        id: 'ordenes',
        title: 'Órdenes de trabajo',
        columns: [
          { key: 'id', label: 'N.º de OT', kind: 'text', width: 13, total: 'count' },
          ...companyColumn(ctx),
          { key: 'unidad', label: 'Unidad', kind: 'text', width: 10 },
          { key: 'patente', label: 'Patente', kind: 'text', width: 10 },
          { key: 'tipo', label: 'Tipo', kind: 'text', width: 10 },
          { key: 'prioridad', label: 'Prioridad', kind: 'status', width: 10 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 15 },
          { key: 'titulo', label: 'Trabajo', kind: 'text', width: 24 },
          { key: 'taller', label: 'Taller o técnico', kind: 'text', width: 16 },
          { key: 'programada', label: 'Programada', kind: 'date', width: 10 },
          { key: 'completada', label: 'Completada', kind: 'date', width: 10 },
          { key: 'origen', label: 'Origen', kind: 'text', width: 9 },
          { key: 'manoObra', label: 'Mano de obra', kind: 'money', width: 12, total: 'sum' },
          { key: 'piezas', label: 'Repuestos', kind: 'money', width: 12, total: 'sum' },
          { key: 'total', label: consolidated ? `Total (${ctx.reference!.code})` : 'Total', kind: 'money', width: 12, total: 'sum' },
          ...(ctx.multiTenant
            ? ([
                { key: 'moneda', label: 'Moneda de la empresa', kind: 'text', width: 8 },
                { key: 'totalOriginalTexto', label: 'Total en su moneda', kind: 'text', width: 14 },
              ] satisfies Column[])
            : []),
        ],
        rows,
        empty: 'No hay órdenes de trabajo.',
      }),
      section({
        id: 'repuestos',
        title: 'Repuestos consumidos',
        description: 'Una fila por repuesto o insumo usado en cada orden',
        columns: [
          { key: 'ot', label: 'N.º de OT', kind: 'text', width: 13, total: 'count' },
          { key: 'unidad', label: 'Unidad', kind: 'text', width: 10 },
          { key: 'sku', label: 'SKU', kind: 'text', width: 12 },
          { key: 'nombre', label: 'Repuesto', kind: 'text', width: 26 },
          { key: 'categoria', label: 'Categoría', kind: 'text', width: 12 },
          { key: 'cantidad', label: 'Cantidad', kind: 'number', decimals: 2, width: 9, total: 'sum' },
          { key: 'unitario', label: 'Costo unitario', kind: 'money', width: 12 },
          { key: 'subtotal', label: 'Subtotal', kind: 'money', width: 12, total: 'sum' },
          { key: 'monedaOriginal', label: 'Cargado en otra moneda', kind: 'text', width: 12 },
          { key: 'descontado', label: 'Descontado del stock', kind: 'text', width: 10 },
        ],
        rows: parts,
        empty: 'Ninguna orden consumió repuestos.',
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
export interface DriverExportFilters {
  q?: string;
  state?: DriverAuthState;
  branch?: string;
  profile?: DriverProfile;
  sort?: 'name' | 'expiry';
}

export function driversReport(drivers: DriverListItem[], filters: DriverExportFilters, ctx: ExportContext): Report {
  const today = ctx.now ?? new Date();
  const rows: Row[] = drivers.map((d) => {
    const a = d.authorization;
    return {
      nombre: d.name,
      empresa: d.tenantName ?? ctx.tenantName(d.tenantId),
      dni: d.dni ?? '',
      cuil: d.cuil ? formatCuit(d.cuil) : '',
      perfil: DRIVER_PROFILES[d.profile ?? 'liviano']?.label,
      sucursal: d.branch,
      estado: status(AUTH_STATE_LABELS[a.state], AUTH_TONE[a.state]),
      motivos: a.reasons.join(' '),
      unidad: d.assignedVehicle ? `${d.assignedVehicle.unitCode} (${d.assignedVehicle.plate})` : '',
      licencia: d.licenseNumber ?? '',
      clases: d.licenseClasses?.join(', ') ?? '',
      vence: a.state === 'deshabilitado' ? '' : (a.nextExpiry ?? ''),
      venceDoc: a.nextExpiryDoc && a.state !== 'deshabilitado' ? DOC_TYPES[a.nextExpiryDoc].short : '',
      dias: a.state === 'deshabilitado' ? null : (a.daysToExpiry ?? null),
    };
  });
  const docs: Row[] = drivers.flatMap((d) =>
    (d.documents ?? []).map((doc) => {
      const meta = DOC_TYPES[doc.type];
      const days = doc.expiresAt ? daysUntil(doc.expiresAt, today) : null;
      const vigencia = !meta.hasExpiry
        ? status('Sin vencimiento', 'muted')
        : days === null
          ? status('Sin fecha', 'bad')
          : days < 0
            ? status('Vencido', 'bad')
            : days <= EXPIRY_WARNING_DAYS
              ? status('Por vencer', 'warn')
              : status('Vigente', 'ok');
      const review = verificationStatus(doc);
      return {
        chofer: d.name,
        dni: d.dni ?? '',
        documento: meta.label,
        numero: doc.type === 'dni' ? (d.dni ?? doc.number ?? '') : (doc.number ?? ''),
        emisor: doc.issuer ?? '',
        vence: doc.expiresAt ?? '',
        dias: days,
        vigencia,
        archivo: doc.file ? 'Sí' : 'No',
        verificacion: status(
          review === 'verificado' ? 'Verificado' : review === 'rechazado' ? 'Rechazado' : 'Pendiente',
          review === 'verificado' ? 'ok' : review === 'rechazado' ? 'bad' : 'info'
        ),
        por: doc.verification?.by ?? '',
        fechaVerif: doc.verification?.at ?? '',
        motivo: doc.verification?.reason ?? '',
      };
    })
  );
  const stateKpi = (s: DriverAuthState): Kpi => ({
    label: AUTH_STATE_LABELS[s],
    value: countWhere(drivers, (d) => d.authorization.state === s),
    tone: AUTH_TONE[s],
    formula: { section: 'choferes', column: 'estado', op: 'count', equals: AUTH_STATE_LABELS[s] },
  });
  return {
    ...base(ctx),
    title: 'Registro de choferes',
    subtitle: 'Autorización para conducir, documentación y vencimientos',
    filters: filterList([
      ['Búsqueda', filters.q],
      ['Estado', filters.state ? AUTH_STATE_LABELS[filters.state] : undefined],
      ['Sucursal', filters.branch],
      ['Perfil', filters.profile ? DRIVER_PROFILES[filters.profile]?.label : undefined],
      ['Orden', filters.sort === 'expiry' ? 'Próximo vencimiento primero' : undefined],
    ]),
    orientation: 'landscape',
    kpis: [
      { label: 'Choferes', value: drivers.length, formula: { section: 'choferes', column: 'nombre', op: 'count' } },
      stateKpi('habilitado'),
      stateKpi('por_vencer'),
      stateKpi('pendiente'),
      stateKpi('no_autorizado'),
      stateKpi('deshabilitado'),
    ],
    sections: [
      section({
        id: 'choferes',
        title: 'Choferes',
        columns: [
          { key: 'nombre', label: 'Chofer', kind: 'text', width: 18, total: 'count' },
          ...companyColumn(ctx),
          { key: 'dni', label: 'DNI', kind: 'text', width: 9 },
          { key: 'cuil', label: 'CUIL', kind: 'text', width: 12 },
          { key: 'perfil', label: 'Perfil', kind: 'text', width: 14 },
          { key: 'sucursal', label: 'Sucursal', kind: 'text', width: 12 },
          { key: 'estado', label: 'Estado', kind: 'status', width: 17 },
          { key: 'motivos', label: 'Motivos', kind: 'text', width: 32 },
          { key: 'unidad', label: 'Unidad asignada', kind: 'text', width: 14 },
          { key: 'licencia', label: 'N.º de licencia', kind: 'text', width: 11 },
          { key: 'clases', label: 'Clases', kind: 'text', width: 9 },
          { key: 'vence', label: 'Próximo vencimiento', kind: 'date', width: 11 },
          { key: 'venceDoc', label: 'Documento que vence', kind: 'text', width: 10 },
          { key: 'dias', label: 'Días restantes', kind: 'number', width: 8 },
        ],
        rows,
        empty: 'No hay choferes con estos filtros.',
      }),
      section({
        id: 'documentos',
        title: 'Documentación',
        description: 'Una fila por documento cargado, con su vigencia y verificación',
        columns: [
          { key: 'chofer', label: 'Chofer', kind: 'text', width: 18, total: 'count' },
          { key: 'dni', label: 'DNI', kind: 'text', width: 9 },
          { key: 'documento', label: 'Documento', kind: 'text', width: 18 },
          { key: 'numero', label: 'Número', kind: 'text', width: 12 },
          { key: 'emisor', label: 'Emitido por', kind: 'text', width: 14 },
          { key: 'vence', label: 'Vence', kind: 'date', width: 10 },
          { key: 'dias', label: 'Días restantes', kind: 'number', width: 8 },
          { key: 'vigencia', label: 'Vigencia', kind: 'status', width: 12 },
          { key: 'archivo', label: 'Archivo', kind: 'text', width: 7 },
          { key: 'verificacion', label: 'Verificación', kind: 'status', width: 12 },
          { key: 'por', label: 'Verificado por', kind: 'text', width: 14 },
          { key: 'fechaVerif', label: 'Fecha de verificación', kind: 'date', width: 11 },
          { key: 'motivo', label: 'Motivo de rechazo', kind: 'text', width: 16 },
        ],
        rows: docs,
        empty: 'Ningún chofer tiene documentos cargados.',
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Alerts and incidents
// ---------------------------------------------------------------------------
function alertColumns(ctx: ExportContext): Column[] {
  return [
    { key: 'fecha', label: 'Fecha y hora', kind: 'datetime', width: 14, total: 'count' },
    ...companyColumn(ctx),
    { key: 'unidad', label: 'Unidad', kind: 'text', width: 10 },
    { key: 'patente', label: 'Patente', kind: 'text', width: 10 },
    { key: 'chofer', label: 'Chofer', kind: 'text', width: 16 },
    { key: 'regla', label: 'Regla', kind: 'text', width: 18 },
    { key: 'prioridad', label: 'Prioridad', kind: 'status', width: 11 },
    { key: 'estado', label: 'Estado', kind: 'status', width: 15 },
    { key: 'velocidad', label: 'Velocidad (km/h)', kind: 'number', width: 9 },
    { key: 'detalle', label: 'Detalle', kind: 'text', width: 30 },
    { key: 'video', label: 'Video', kind: 'text', width: 6 },
  ];
}

function alertRow(a: AlertEvent, ctx: ExportContext): Row {
  return {
    fecha: a.timestamp,
    empresa: ctx.tenantName(a.tenantId),
    unidad: a.unitCode,
    patente: a.plate,
    chofer: a.driverName,
    regla: a.ruleName,
    prioridad: status(PRIORITY_META[a.priority]?.label ?? a.priority, ALERT_PRIORITY_TONE[a.priority] ?? 'muted'),
    estado: status(ALERT_STATUS_META[a.status]?.label ?? a.status, ALERT_STATUS_TONE[a.status] ?? 'muted'),
    velocidad: a.speedKmh,
    detalle: a.summary,
    video: a.clipId ? 'Sí' : 'No',
  };
}

function incidentColumns(ctx: ExportContext): Column[] {
  return [
    { key: 'fecha', label: 'Abierto el', kind: 'datetime', width: 14, total: 'count' },
    ...companyColumn(ctx),
    { key: 'unidad', label: 'Unidad', kind: 'text', width: 10 },
    { key: 'patente', label: 'Patente', kind: 'text', width: 10 },
    { key: 'titulo', label: 'Incidente', kind: 'text', width: 22 },
    { key: 'categoria', label: 'Categoría', kind: 'text', width: 13 },
    { key: 'prioridad', label: 'Prioridad', kind: 'status', width: 11 },
    { key: 'estado', label: 'Estado', kind: 'status', width: 14 },
    { key: 'responsable', label: 'Responsable', kind: 'text', width: 15 },
    { key: 'actualizado', label: 'Actualizado', kind: 'datetime', width: 14 },
    { key: 'resolucion', label: 'Resolución', kind: 'text', width: 28 },
  ];
}

function incidentRow(i: Incident, ctx: ExportContext): Row {
  return {
    fecha: i.createdAt,
    empresa: ctx.tenantName(i.tenantId),
    unidad: i.unitCode,
    patente: i.plate,
    titulo: i.title,
    categoria: i.category,
    prioridad: status(PRIORITY_META[i.priority]?.label ?? i.priority, ALERT_PRIORITY_TONE[i.priority] ?? 'muted'),
    estado: status(INCIDENT_STATUS_META[i.status]?.label ?? i.status, INCIDENT_TONE[i.status] ?? 'muted'),
    responsable: i.assignee,
    actualizado: i.updatedAt,
    resolucion: i.resolutionNote,
  };
}

export function alertsReport(
  alerts: AlertEvent[],
  incidents: Incident[] | null,
  filters: { priority?: AlertPriority },
  ctx: ExportContext
): Report {
  const byPriority = <T extends { priority: AlertPriority }>(xs: T[]) => (filters.priority ? xs.filter((x) => x.priority === filters.priority) : xs);
  const al = byPriority(alerts).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const inc = incidents ? byPriority(incidents).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : null;
  const kpis: Kpi[] = [
    { label: 'Alertas', value: al.length, formula: { section: 'alertas', column: 'fecha', op: 'count' } },
    {
      label: 'Críticas',
      value: countWhere(al, (a) => a.priority === 'critica'),
      tone: 'bad',
      formula: { section: 'alertas', column: 'prioridad', op: 'count', equals: PRIORITY_META.critica.label },
    },
    {
      label: 'Pendientes de revisar',
      value: countWhere(al, (a) => a.status === 'pendiente'),
      tone: 'warn',
      formula: { section: 'alertas', column: 'estado', op: 'count', equals: ALERT_STATUS_META.pendiente.label },
    },
  ];
  if (inc) kpis.push({ label: 'Incidentes sin resolver', value: countWhere(inc, (i) => i.status !== 'resuelto'), tone: 'info' });
  return {
    ...base(ctx),
    title: 'Alertas e incidentes',
    subtitle: 'Eventos detectados por las reglas y su seguimiento',
    filters: filterList([['Prioridad', filters.priority ? PRIORITY_META[filters.priority].label : undefined]]),
    orientation: 'landscape',
    kpis,
    sections: [
      section({ id: 'alertas', title: 'Alertas', columns: alertColumns(ctx), rows: al.map((a) => alertRow(a, ctx)), empty: 'No hay alertas con estos filtros.' }),
      ...(inc
        ? [section({ id: 'incidentes', title: 'Incidentes', columns: incidentColumns(ctx), rows: inc.map((i) => incidentRow(i, ctx)), empty: 'No hay incidentes con estos filtros.' })]
        : []),
    ],
  };
}
