import type {
  AlertPriority,
  AlertStatus,
  AssetType,
  DashcamVendorFamily,
  IncidentStatus,
  LicenseValidityStatus,
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

export {
  ASSET_TYPE_LABELS,
  MAINTENANCE_META,
  WORK_ORDER_STATUS_META,
  WORK_ORDER_PRIORITY_META,
  STATUS_META,
  LINK_META,
  PRIORITY_META,
  ALERT_STATUS_META,
  INCIDENT_STATUS_META,
} from '../shared/labels.ts';
import { ASSET_TYPE_LABELS, MAINTENANCE_META, WORK_ORDER_STATUS_META, WORK_ORDER_PRIORITY_META, STATUS_META, LINK_META, PRIORITY_META, ALERT_STATUS_META, INCIDENT_STATUS_META } from '../shared/labels.ts';

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
 * Opens a protected file (PDF or image) in a new tab without putting the session token in the URL.
 * The tab is opened before the download so popup blockers treat it as a user action.
 */
export async function openWithAuth(url: string): Promise<void> {
  const tab = window.open('', '_blank');
  const headers = new Headers();
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const scope = getTenantScope();
  if (scope) headers.set('x-tenant-scope', scope);
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(typeof data.error === 'string' ? data.error : `Error HTTP ${res.status}`);
    }
    const blobUrl = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = blobUrl;
    else window.location.assign(blobUrl);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Fetches a protected file as a Blob (for in-page previews), sending the session in the header. */
export async function fetchBlobWithAuth(url: string): Promise<Blob> {
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
  return res.blob();
}

/** Uploads a file as the raw request body (PUT), reporting progress from 0 to 1. */
export function uploadWithAuth<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const scope = getTenantScope();
    if (scope) xhr.setRequestHeader('x-tenant-scope', scope);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: unknown } = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new Error(typeof data.error === 'string' ? data.error : `Error HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('No se pudo conectar con el servidor.'));
    xhr.send(file);
  });
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
  jimi_concox: 'Jimi / Concox (JC181 / JC261 / JC400)',
  teltonika_fmc: 'Teltonika FMC (CAN + RS232)',
  hikvision_dahua: 'Hikvision Mobile / Dahua MDVR',
  jt808_generico: 'JT/T 808 genérico (Meitrack, MettaX y otros)',
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

export const PERMISSION_LABELS: Record<PermissionLevel, { label: string; colorClass: string }> = {
  full: { label: 'Control total', colorClass: 'text-emerald-400' },
  write: { label: 'Operación', colorClass: 'text-sky-400' },
  read: { label: 'Solo lectura', colorClass: 'text-slate-300' },
  none: { label: 'Sin acceso', colorClass: 'text-slate-500' },
};

/** Validity buckets of a driver license by days to expiry (see licenseValidity in DriverLicenseModal). */
export const LICENSE_STATUS_META: Record<
  LicenseValidityStatus,
  { label: string; shortLabel: string; colorClass: string }
> = {
  vigente: { label: 'Vigente (> 30 d)', shortLabel: 'Vigente', colorClass: 'text-emerald-400' },
  por_vencer_30: { label: 'Por vencer (≤ 30 d)', shortLabel: '≤ 30 días', colorClass: 'text-sky-400' },
  por_vencer_15: { label: 'Por vencer (≤ 15 d)', shortLabel: '≤ 15 días', colorClass: 'text-amber-400' },
  por_vencer_5: { label: 'Inminente (≤ 5 d)', shortLabel: '≤ 5 días', colorClass: 'text-amber-300' },
  vencida: { label: 'Licencia vencida', shortLabel: 'Vencida', colorClass: 'text-rose-400' },
};
