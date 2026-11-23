import type {
  VigiantAccuracyLevel,
  VigiantConfig,
  VigiantLogEntry,
  VigiantTelemetryPayload,
} from '../shared/types.ts';

const CONFIG_KEY = 'vigiant.config.v1';
const LOGS_FALLBACK_KEY = 'vigiant.logs.v1';
const QUEUE_FALLBACK_KEY = 'vigiant.queue.v1';
const DB_NAME = 'vigiant-client-db';
const DB_VERSION = 1;
const STORE_QUEUE = 'offline_queue';
const STORE_LOGS = 'logs';

export interface QueuedTelemetryItem {
  queueId?: number;
  queuedAt: string;
  attempts: number;
  payload: VigiantTelemetryPayload;
}

export function generateRandomDeviceId(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function getDefaultServerUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api/osmand`;
  }
  return '/api/osmand';
}

export function createDefaultVigiantConfig(): VigiantConfig {
  return {
    deviceId: generateRandomDeviceId(),
    serverUrl: getDefaultServerUrl(),
    accuracy: 'high',
    intervalSec: 30,
    distanceMeters: 0,
    angleDegrees: 0,
    stationaryHeartbeatSec: 300,
    fastestIntervalSec: 5,
    offlineBuffer: true,
    wakeLock: false,
    stopDetection: true,
    serviceEnabled: false,
  };
}

export function loadVigiantConfig(): VigiantConfig {
  const defaults = createDefaultVigiantConfig();
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) {
      saveVigiantConfig(defaults);
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<VigiantConfig>;
    return {
      ...defaults,
      ...parsed,
      deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId.trim() ? parsed.deviceId.trim() : defaults.deviceId,
      serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl.trim() ? parsed.serverUrl.trim() : defaults.serverUrl,
      intervalSec: Math.max(1, Number(parsed.intervalSec ?? defaults.intervalSec)),
      distanceMeters: Math.max(0, Number(parsed.distanceMeters ?? defaults.distanceMeters)),
      angleDegrees: Math.max(0, Math.min(180, Number(parsed.angleDegrees ?? defaults.angleDegrees))),
      stationaryHeartbeatSec: Math.max(5, Number(parsed.stationaryHeartbeatSec ?? defaults.stationaryHeartbeatSec)),
      fastestIntervalSec: Math.max(1, Number(parsed.fastestIntervalSec ?? defaults.fastestIntervalSec)),
    };
  } catch {
    return defaults;
  }
}

export function saveVigiantConfig(cfg: VigiantConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // Ignore storage quota errors
  }
}

function openVigiantDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'queueId', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function enqueueOfflinePoint(payload: VigiantTelemetryPayload): Promise<QueuedTelemetryItem[]> {
  const item: QueuedTelemetryItem = {
    queuedAt: new Date().toISOString(),
    attempts: 0,
    payload,
  };
  try {
    const db = await openVigiantDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      tx.objectStore(STORE_QUEUE).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return await getOfflineQueue();
  } catch {
    try {
      const curr = JSON.parse(localStorage.getItem(QUEUE_FALLBACK_KEY) || '[]') as QueuedTelemetryItem[];
      const next = [...curr, { ...item, queueId: Date.now() + Math.floor(Math.random() * 1000) }];
      localStorage.setItem(QUEUE_FALLBACK_KEY, JSON.stringify(next));
      return next;
    } catch {
      return [item];
    }
  }
}

export async function getOfflineQueue(): Promise<QueuedTelemetryItem[]> {
  try {
    const db = await openVigiantDb();
    const rows = await new Promise<QueuedTelemetryItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readonly');
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve((req.result as QueuedTelemetryItem[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a, b) => (a.queueId ?? 0) - (b.queueId ?? 0));
  } catch {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_FALLBACK_KEY) || '[]') as QueuedTelemetryItem[];
    } catch {
      return [];
    }
  }
}

export async function removeOfflinePoints(queueIds: number[]): Promise<QueuedTelemetryItem[]> {
  if (queueIds.length === 0) return getOfflineQueue();
  try {
    const db = await openVigiantDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_QUEUE);
      for (const id of queueIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return await getOfflineQueue();
  } catch {
    try {
      const curr = JSON.parse(localStorage.getItem(QUEUE_FALLBACK_KEY) || '[]') as QueuedTelemetryItem[];
      const idSet = new Set(queueIds);
      const next = curr.filter((item) => item.queueId === undefined || !idSet.has(item.queueId));
      localStorage.setItem(QUEUE_FALLBACK_KEY, JSON.stringify(next));
      return next;
    } catch {
      return [];
    }
  }
}

export async function clearOfflineQueue(): Promise<void> {
  try {
    const db = await openVigiantDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      tx.objectStore(STORE_QUEUE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    localStorage.removeItem(QUEUE_FALLBACK_KEY);
  }
}

export async function appendVigiantLog(entry: VigiantLogEntry): Promise<void> {
  try {
    const db = await openVigiantDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      tx.objectStore(STORE_LOGS).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    try {
      const curr = JSON.parse(localStorage.getItem(LOGS_FALLBACK_KEY) || '[]') as VigiantLogEntry[];
      const next = [entry, ...curr].slice(0, 150);
      localStorage.setItem(LOGS_FALLBACK_KEY, JSON.stringify(next));
    } catch {
      // Ignore
    }
  }
}

export async function getVigiantLogs(): Promise<VigiantLogEntry[]> {
  try {
    const db = await openVigiantDb();
    const rows = await new Promise<Array<VigiantLogEntry & { seq?: number }>>((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readonly');
      const req = tx.objectStore(STORE_LOGS).getAll();
      req.onsuccess = () => resolve((req.result as Array<VigiantLogEntry & { seq?: number }>) ?? []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, 200);
  } catch {
    try {
      return JSON.parse(localStorage.getItem(LOGS_FALLBACK_KEY) || '[]') as VigiantLogEntry[];
    } catch {
      return [];
    }
  }
}

export async function clearVigiantLogs(): Promise<void> {
  try {
    const db = await openVigiantDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      tx.objectStore(STORE_LOGS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    localStorage.removeItem(LOGS_FALLBACK_KEY);
  }
}

function normalizeAccuracy(val: string | null | undefined): VigiantAccuracyLevel | undefined {
  if (!val) return undefined;
  const low = val.trim().toLowerCase();
  if (low === 'highest' || low === 'high' || low === 'medium' || low === 'low') {
    return low;
  }
  return undefined;
}

function parseBoolParam(val: string | null | undefined): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  const low = val.trim().toLowerCase();
  if (low === 'true' || low === '1' || low === 'yes') return true;
  if (low === 'false' || low === '0' || low === 'no') return false;
  return undefined;
}

export function applyQueryParamsToConfig(
  params: URLSearchParams,
  base: VigiantConfig
): { config: VigiantConfig; changedKeys: string[] } {
  const next: VigiantConfig = { ...base };
  const changedKeys: string[] = [];

  const id = params.get('id') || params.get('deviceId') || params.get('deviceid');
  if (id && id.trim()) {
    next.deviceId = id.trim();
    changedKeys.push('deviceId');
  }

  const url = params.get('url') || params.get('serverUrl');
  if (url && url.trim()) {
    next.serverUrl = url.trim();
    changedKeys.push('serverUrl');
  }

  const acc = normalizeAccuracy(params.get('accuracy'));
  if (acc) {
    next.accuracy = acc;
    changedKeys.push('accuracy');
  }

  const interval = Number(params.get('interval') ?? params.get('intervalSec'));
  if (Number.isFinite(interval) && interval >= 1) {
    next.intervalSec = Math.round(interval);
    changedKeys.push('intervalSec');
  }

  const distance = Number(params.get('distance') ?? params.get('distanceMeters'));
  if (Number.isFinite(distance) && distance >= 0) {
    next.distanceMeters = Math.round(distance);
    changedKeys.push('distanceMeters');
  }

  const angle = Number(params.get('angle') ?? params.get('angleDegrees'));
  if (Number.isFinite(angle) && angle >= 0) {
    next.angleDegrees = Math.min(180, Math.round(angle));
    changedKeys.push('angleDegrees');
  }

  const heartbeat = Number(
    params.get('heartbeat') ?? params.get('stationary_heartbeat') ?? params.get('stationaryHeartbeatSec')
  );
  if (Number.isFinite(heartbeat) && heartbeat >= 5) {
    next.stationaryHeartbeatSec = Math.round(heartbeat);
    changedKeys.push('stationaryHeartbeatSec');
  }

  const fastest = Number(params.get('fastest_interval') ?? params.get('fastestIntervalSec'));
  if (Number.isFinite(fastest) && fastest >= 1) {
    next.fastestIntervalSec = Math.round(fastest);
    changedKeys.push('fastestIntervalSec');
  }

  const buffer = parseBoolParam(params.get('buffer') ?? params.get('offlineBuffer'));
  if (buffer !== undefined) {
    next.offlineBuffer = buffer;
    changedKeys.push('offlineBuffer');
  }

  const wake = parseBoolParam(params.get('wakelock') ?? params.get('wakeLock'));
  if (wake !== undefined) {
    next.wakeLock = wake;
    changedKeys.push('wakeLock');
  }

  const stopDet = parseBoolParam(params.get('stop_detection') ?? params.get('stopDetection'));
  if (stopDet !== undefined) {
    next.stopDetection = stopDet;
    changedKeys.push('stopDetection');
  }

  return { config: next, changedKeys };
}

export function parseVigiantConfigInput(
  rawText: string,
  base: VigiantConfig
): { config: VigiantConfig; changedKeys: string[]; error?: string } {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { config: base, changedKeys: [], error: 'El código QR o texto está vacío.' };
  }

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const res = applyQueryParamsToConfig(params, base);
      if (res.changedKeys.length === 0) {
        return { config: base, changedKeys: [], error: 'El JSON no contiene parámetros válidos de Vigiant.' };
      }
      return res;
    } catch {
      return { config: base, changedKeys: [], error: 'Formato JSON inválido.' };
    }
  }

  if (trimmed.includes('?') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('traccar://') || trimmed.startsWith('vigiant://')) {
    try {
      const normalized = trimmed.replace(/^(traccar|vigiant):\/\//i, 'https://vigiant.local/');
      const parsedUrl = new URL(normalized);
      const res = applyQueryParamsToConfig(parsedUrl.searchParams, base);
      if (res.changedKeys.length === 0 && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
        // Plain OsmAnd server URL scanned
        return {
          config: { ...base, serverUrl: trimmed },
          changedKeys: ['serverUrl'],
        };
      }
      if (res.changedKeys.length === 0) {
        return { config: base, changedKeys: [], error: 'No se detectaron parámetros id/url en el enlace QR.' };
      }
      return res;
    } catch {
      // Fall through to query parser
    }
  }

  if (trimmed.includes('=')) {
    const params = new URLSearchParams(trimmed.replace(/^\?/, ''));
    const res = applyQueryParamsToConfig(params, base);
    if (res.changedKeys.length > 0) return res;
  }

  // Plain device ID fallback (e.g. IMEI barcode)
  if (/^[a-zA-Z0-9._-]{3,40}$/.test(trimmed)) {
    return {
      config: { ...base, deviceId: trimmed },
      changedKeys: ['deviceId'],
    };
  }

  return { config: base, changedKeys: [], error: 'No se reconoció el formato del QR escaneado.' };
}

export function buildVigiantShareUrl(cfg: VigiantConfig, origin?: string): string {
  const resolvedOrigin =
    origin || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  const params = new URLSearchParams({
    id: cfg.deviceId,
    url: cfg.serverUrl,
    accuracy: cfg.accuracy,
    interval: String(cfg.intervalSec),
    distance: String(cfg.distanceMeters),
    angle: String(cfg.angleDegrees),
    heartbeat: String(cfg.stationaryHeartbeatSec),
    fastest_interval: String(cfg.fastestIntervalSec),
    buffer: String(cfg.offlineBuffer),
    wakelock: String(cfg.wakeLock),
    stop_detection: String(cfg.stopDetection),
  });
  return `${resolvedOrigin}/vigiant?${params.toString()}`;
}
