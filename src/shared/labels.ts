import type {
  AlertPriority,
  AlertStatus,
  AssetType,
  IncidentStatus,
  LinkStatus,
  MaintenanceStatus,
  OperationalStatus,
  WorkOrderPriority,
  WorkOrderStatus,
} from './types.ts';

/** Spanish labels (and UI colors) for status values, shared by the panel and the server exports. */

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  vehiculo: 'Vehículo',
  maquinaria_pesada: 'Maquinaria pesada',
};

export const MAINTENANCE_META: Record<MaintenanceStatus, { label: string; colorClass: string }> = {
  al_dia: { label: 'Al día', colorClass: 'text-emerald-400' },
  proximo: { label: 'Servicio próximo', colorClass: 'text-amber-400' },
  vencido: { label: 'Servicio vencido', colorClass: 'text-rose-400' },
};

export const WORK_ORDER_STATUS_META: Record<WorkOrderStatus, { label: string; colorClass: string }> = {
  abierta: { label: 'Abierta', colorClass: 'text-sky-400' },
  en_taller: { label: 'En taller', colorClass: 'text-amber-400' },
  esperando_refacciones: { label: 'Esperando refacciones', colorClass: 'text-rose-400' },
  completada: { label: 'Completada', colorClass: 'text-emerald-400' },
  cancelada: { label: 'Cancelada', colorClass: 'text-slate-400' },
};

export const WORK_ORDER_PRIORITY_META: Record<
  WorkOrderPriority,
  { label: string; colorClass: string; rank: number }
> = {
  critica: { label: 'Crítica', colorClass: 'text-rose-400', rank: 0 },
  alta: { label: 'Alta', colorClass: 'text-amber-400', rank: 1 },
  media: { label: 'Media', colorClass: 'text-sky-400', rank: 2 },
  baja: { label: 'Baja', colorClass: 'text-slate-400', rank: 3 },
};

export const STATUS_META: Record<OperationalStatus, { label: string; colorClass: string; dotHex: string }> = {
  en_ruta: { label: 'En ruta / Operando', colorClass: 'text-emerald-400', dotHex: '#22C55E' },
  detenido: { label: 'Detenido', colorClass: 'text-slate-300', dotHex: '#94A3B8' },
  alerta: { label: 'En alerta', colorClass: 'text-rose-400', dotHex: '#EF4444' },
  sin_senal: { label: 'Sin señal', colorClass: 'text-amber-400', dotHex: '#F59E0B' },
};

export const LINK_META: Record<LinkStatus, { label: string; colorClass: string }> = {
  conectado: { label: 'Conectado', colorClass: 'text-emerald-400' },
  intermitente: { label: 'Intermitente', colorClass: 'text-amber-400' },
  desconectado: { label: 'Desconectado', colorClass: 'text-rose-400' },
};

export const PRIORITY_META: Record<AlertPriority, { label: string; colorClass: string }> = {
  critica: { label: 'Crítica', colorClass: 'text-rose-400' },
  alta: { label: 'Alta', colorClass: 'text-amber-400' },
  media: { label: 'Media', colorClass: 'text-sky-400' },
  informativa: { label: 'Informativa', colorClass: 'text-slate-400' },
};

export const ALERT_STATUS_META: Record<AlertStatus, { label: string; colorClass: string }> = {
  pendiente: { label: 'Pendiente', colorClass: 'text-amber-400' },
  confirmada: { label: 'Confirmada', colorClass: 'text-emerald-400' },
  escalada: { label: 'Escalada a incidente', colorClass: 'text-rose-400' },
};

export const INCIDENT_STATUS_META: Record<IncidentStatus, { label: string; colorClass: string }> = {
  abierto: { label: 'Abierto', colorClass: 'text-amber-400' },
  en_investigacion: { label: 'En investigación', colorClass: 'text-sky-400' },
  escalado: { label: 'Escalado', colorClass: 'text-rose-400' },
  resuelto: { label: 'Resuelto', colorClass: 'text-emerald-400' },
};
