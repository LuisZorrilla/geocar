import type {
  AlertPriority,
  AlertStatus,
  AssetType,
  DashcamVendorFamily,
  IncidentStatus,
  LinkStatus,
  MaintenanceStatus,
  OperationalStatus,
  PermissionLevel,
  PreOpChecklistResult,
  Vehicle,
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
} from '../shared/types.ts';

const TOKEN_STORAGE_KEY = 'fleetops_auth_token';
const TENANT_SCOPE_KEY = 'fleetops_tenant_scope';

export function getAuthToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      window.localStorage.removeItem(TENANT_SCOPE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getTenantScope(): string | null {
  try {
    return window.localStorage.getItem(TENANT_SCOPE_KEY);
  } catch {
    return null;
  }
}

export function setTenantScope(scope: string | null): void {
  try {
    if (scope) {
      window.localStorage.setItem(TENANT_SCOPE_KEY, scope);
    } else {
      window.localStorage.removeItem(TENANT_SCOPE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export async function apiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getAuthToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const scope = getTenantScope();
  if (scope && !headers.has('x-tenant-scope')) {
    headers.set('x-tenant-scope', scope);
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Error HTTP ${res.status}`);
  }
  return data as T;
}

/**
 * Downloads a protected file using the Authorization header, so the session
 * token never appears in the URL (browser history, proxy and server logs).
 */
export async function downloadWithAuth(url: string, fallbackFilename: string): Promise<void> {
  const headers = new Headers();
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const scope = getTenantScope();
  if (scope) headers.set('x-tenant-scope', scope);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.error === 'string' ? data.error : `Error HTTP ${res.status}`);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : fallbackFilename;

  const blobUrl = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `hace ${diffSec} s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

export function formatTimeClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatServiceDate(isoDate?: string): string {
  if (!isoDate) return 'Por programar';
  const parsed = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function getServiceDateDeltaDays(isoDate?: string): number {
  if (!isoDate) return 0;
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const parts = isoDate.split('-').map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;
  const targetUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  return Math.round((targetUtc - todayUtc) / 86_400_000);
}

export function suggestNextServiceDate(engineHours: number, targetServiceHours: number, avgDailyHours = 8): string {
  const remainingHours = targetServiceHours - engineHours;
  const deltaDays = Math.round(remainingHours / avgDailyHours);
  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + deltaDays));
  return target.toISOString().slice(0, 10);
}

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

export function sortWorkOrdersByPriority(orders: WorkOrder[], vehicles: Vehicle[]): WorkOrder[] {
  const vehMap = new Map(vehicles.map((v) => [v.id, v]));
  const isClosed = (s: WorkOrderStatus) => s === 'completada' || s === 'cancelada';
  const mRank = (m?: MaintenanceStatus) => (m === 'vencido' ? 0 : m === 'proximo' ? 1 : 2);
  return [...orders].sort((a, b) => {
    const aClosed = isClosed(a.status) ? 1 : 0;
    const bClosed = isClosed(b.status) ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;

    const pDiff = WORK_ORDER_PRIORITY_META[a.priority].rank - WORK_ORDER_PRIORITY_META[b.priority].rank;
    if (pDiff !== 0) return pDiff;

    const vA = vehMap.get(a.vehicleId);
    const vB = vehMap.get(b.vehicleId);
    const mDiff = mRank(vA?.maintenanceStatus) - mRank(vB?.maintenanceStatus);
    if (mDiff !== 0) return mDiff;

    return a.scheduledDate.localeCompare(b.scheduledDate);
  });
}

export const CHECKLIST_RESULT_META: Record<PreOpChecklistResult, { label: string; colorClass: string }> = {
  aprobado: { label: 'Aprobado', colorClass: 'text-emerald-400' },
  con_observaciones: { label: 'Con observaciones', colorClass: 'text-amber-400' },
  reprobado: { label: 'Reprobado', colorClass: 'text-rose-400' },
};

export const VENDOR_FAMILY_LABELS: Record<DashcamVendorFamily, string> = {
  howen_streamax: 'Howen / Streamax (JT808/JT1078)',
  jimi_concox: 'Jimi / Concox (JC400 / JC450)',
  teltonika_fmc: 'Teltonika FMC (CAN + RS232)',
  hikvision_dahua: 'Hikvision Mobile / Dahua MDVR',
};

export const DEFAULT_VEHICLE_CHECKLIST_LABELS = [
  'Presión y desgaste de neumáticos / birlos',
  'Sistema de frenos de servicio y estacionamiento',
  'Luces frontales, direccionales y torreta',
  'Niveles de aceite motor, refrigerante y dirección',
  'Cámara dashcam CH1/CH2 y sensor DMS operativos',
];

export const DEFAULT_MACHINERY_CHECKLIST_LABELS = [
  'Líneas, mangueras y cilindros hidráulicos sin fugas',
  'Estado de orugas / neumáticos de tracción y pernos',
  'Freno de trabajo, alarma de reversa y paro de emergencia',
  'Niveles de aceite hidráulico, motor diésel y refrigerante',
  'Cámaras MDVR 360° / cabina y telemetría CAN J1939',
];

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

export const PERMISSION_LABELS: Record<PermissionLevel, { label: string; colorClass: string }> = {
  full: { label: 'Control total', colorClass: 'text-emerald-400' },
  write: { label: 'Operación', colorClass: 'text-sky-400' },
  read: { label: 'Solo lectura', colorClass: 'text-slate-300' },
  none: { label: 'Sin acceso', colorClass: 'text-slate-500' },
};
