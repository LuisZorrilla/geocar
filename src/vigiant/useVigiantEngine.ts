import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  VigiantAccuracyLevel,
  VigiantConfig,
  VigiantLogEntry,
  VigiantTelemetryPayload,
} from '../shared/types.ts';
import {
  appendVigiantLog,
  applyQueryParamsToConfig,
  clearOfflineQueue,
  clearVigiantLogs,
  createDefaultVigiantConfig,
  enqueueOfflinePoint,
  getOfflineQueue,
  getVigiantLogs,
  loadVigiantConfig,
  parseVigiantConfigInput,
  QueuedTelemetryItem,
  removeOfflinePoints,
  saveVigiantConfig,
} from './storage.ts';

export interface LiveGpsFix {
  lat: number;
  lon: number;
  speedKmh: number;
  speedKnots: number;
  bearing: number;
  altitude: number;
  accuracy: number;
  timestamp: number;
  source: 'gps' | 'simulado';
}

interface BatterySnapshot {
  levelPct: number;
  charging: boolean;
  supported: boolean;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function angleDeltaDeg(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

function mapAccuracyToPositionOptions(acc: VigiantAccuracyLevel): PositionOptions {
  switch (acc) {
    case 'highest':
      return { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
    case 'high':
      return { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 };
    case 'medium':
      return { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 };
    case 'low':
      return { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 };
  }
}

function buildOsmAndRequestUrl(baseUrl: string, p: VigiantTelemetryPayload): string {
  const cleanBase = baseUrl.trim() || '/api/osmand';
  const resolved = cleanBase.startsWith('/') && typeof window !== 'undefined'
    ? `${window.location.origin}${cleanBase}`
    : cleanBase;
  const url = new URL(resolved);
  url.searchParams.set('id', p.id);
  url.searchParams.set('lat', p.lat.toFixed(6));
  url.searchParams.set('lon', p.lon.toFixed(6));
  url.searchParams.set('timestamp', String(Math.floor(p.timestamp / 1000)));
  url.searchParams.set('speed', p.speed.toFixed(2));
  url.searchParams.set('bearing', String(Math.round(p.bearing)));
  url.searchParams.set('altitude', String(Math.round(p.altitude)));
  url.searchParams.set('accuracy', String(Math.round(p.accuracy)));
  url.searchParams.set('batt', String(Math.round(p.batt)));
  url.searchParams.set('charge', String(p.charge));
  url.searchParams.set('valid', String(p.valid));
  if (p.alarm) {
    url.searchParams.set('alarm', p.alarm);
  }
  return url.toString();
}

export function useVigiantEngine() {
  const [config, setConfig] = useState<VigiantConfig>(() => loadVigiantConfig());
  const [logs, setLogs] = useState<VigiantLogEntry[]>([]);
  const [offlineQueue, setOfflineQueue] = useState<QueuedTelemetryItem[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [currentFix, setCurrentFix] = useState<LiveGpsFix | null>(null);
  const [battery, setBattery] = useState<BatterySnapshot>({
    levelPct: 92,
    charging: false,
    supported: false,
  });
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [motionState, setMotionState] = useState<'moving' | 'stationary'>('stationary');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [simulateRoute, setSimulateRoute] = useState(false);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [sendingSos, setSendingSos] = useState(false);

  const configRef = useRef(config);
  configRef.current = config;

  const batteryRef = useRef(battery);
  batteryRef.current = battery;

  const currentFixRef = useRef<LiveGpsFix | null>(null);
  currentFixRef.current = currentFix;

  const lastSentFixRef = useRef<LiveGpsFix | null>(null);
  const lastSentTimeRef = useRef<number>(0);
  const wakeLockSentinelRef = useRef<{ release: () => Promise<void> } | null>(null);
  const simStepRef = useRef(0);
  const flushingRef = useRef(false);

  const pushLog = useCallback(
    async (
      level: VigiantLogEntry['level'],
      message: string,
      opts?: { httpStatus?: number; detail?: string }
    ) => {
      const entry: VigiantLogEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        level,
        message,
        httpStatus: opts?.httpStatus,
        detail: opts?.detail,
      };
      setLogs((prev) => [entry, ...prev].slice(0, 200));
      await appendVigiantLog(entry);
    },
    []
  );

  // Initial load of logs, offline queue, and URL QR provisioning params
  useEffect(() => {
    getVigiantLogs().then(setLogs).catch(() => {});
    getOfflineQueue().then(setOfflineQueue).catch(() => {});

    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const { config: updated, changedKeys } = applyQueryParamsToConfig(params, loadVigiantConfig());
      if (changedKeys.length > 0) {
        saveVigiantConfig(updated);
        setConfig(updated);
        pushLog('info', 'Configuración aplicada desde enlace QR', {
          detail: `Parámetros: ${changedKeys.join(', ')} · ID ${updated.deviceId}`,
        });
      }
    }
  }, [pushLog]);

  // Network connectivity listener
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      pushLog('info', 'Conectividad de red restablecida');
    };
    const onOffline = () => {
      setIsOnline(false);
      pushLog('warn', 'Sin conexión a internet · Modo búfer activo');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [pushLog]);

  // Battery Status API listener
  useEffect(() => {
    let batteryManager: {
      level: number;
      charging: boolean;
      addEventListener: (ev: string, fn: () => void) => void;
      removeEventListener: (ev: string, fn: () => void) => void;
    } | null = null;
    const nav = navigator as unknown as {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener: (ev: string, fn: () => void) => void;
        removeEventListener: (ev: string, fn: () => void) => void;
      }>;
    };
    if (!nav.getBattery) return;

    const syncBattery = () => {
      if (!batteryManager) return;
      setBattery({
        levelPct: Math.round(batteryManager.level * 100),
        charging: batteryManager.charging,
        supported: true,
      });
    };

    nav
      .getBattery()
      .then((bm) => {
        batteryManager = bm;
        syncBattery();
        bm.addEventListener('levelchange', syncBattery);
        bm.addEventListener('chargingchange', syncBattery);
      })
      .catch(() => {});

    return () => {
      if (batteryManager) {
        batteryManager.removeEventListener('levelchange', syncBattery);
        batteryManager.removeEventListener('chargingchange', syncBattery);
      }
    };
  }, []);

  // Screen Wake Lock manager
  useEffect(() => {
    let cancelled = false;
    const releaseLock = async () => {
      if (wakeLockSentinelRef.current) {
        try {
          await wakeLockSentinelRef.current.release();
        } catch {
          // Ignore
        }
        wakeLockSentinelRef.current = null;
      }
      if (!cancelled) setWakeLockActive(false);
    };

    const acquireLock = async () => {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (!wl || !config.serviceEnabled || !config.wakeLock) {
        await releaseLock();
        return;
      }
      try {
        const sentinel = await wl.request('screen');
        if (cancelled) {
          await sentinel.release();
          return;
        }
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
      } catch {
        setWakeLockActive(false);
      }
    };

    acquireLock();

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && config.serviceEnabled && config.wakeLock) {
        acquireLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      releaseLock();
    };
  }, [config.serviceEnabled, config.wakeLock]);

  const sendPayloadToServer = useCallback(
    async (payload: VigiantTelemetryPayload, isBufferedRetry = false): Promise<boolean> => {
      const cfg = configRef.current;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!isBufferedRetry && cfg.offlineBuffer) {
          const updatedQueue = await enqueueOfflinePoint(payload);
          setOfflineQueue(updatedQueue);
          await pushLog(payload.alarm === 'sos' ? 'sos' : 'warn', 'Sin red · Trama guardada en búfer offline', {
            detail: `Cola: ${updatedQueue.length} pendiente(s) · (${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)})`,
          });
        }
        return false;
      }

      try {
        const reqUrl = buildOsmAndRequestUrl(cfg.serverUrl, payload);
        const resp = await fetch(reqUrl, { method: 'GET' });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        setLastSyncAt(new Date().toISOString());
        if (!isBufferedRetry) {
          const speedKmh = Math.round(payload.speed * 1.852);
          await pushLog(
            payload.alarm === 'sos' ? 'sos' : 'ok',
            payload.alarm === 'sos'
              ? 'Alarma SOS transmitida (OsmAnd)'
              : 'Ubicación enviada al servidor',
            {
              httpStatus: resp.status,
              detail: `${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)} · ${speedKmh} km/h · Bat ${payload.batt}%`,
            }
          );
        }
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error de red';
        if (!isBufferedRetry && cfg.offlineBuffer) {
          const updatedQueue = await enqueueOfflinePoint(payload);
          setOfflineQueue(updatedQueue);
          await pushLog('warn', `Fallo envío (${msg}) · Guardado en búfer`, {
            detail: `En cola: ${updatedQueue.length} punto(s)`,
          });
        } else if (!isBufferedRetry) {
          await pushLog('error', `Error al enviar trama (${msg})`, {
            detail: 'Búfer offline desactivado · Trama descartada',
          });
        }
        return false;
      }
    },
    [pushLog]
  );

  const flushOfflineQueue = useCallback(async (): Promise<number> => {
    if (flushingRef.current) return 0;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;

    flushingRef.current = true;
    setSyncingQueue(true);
    let sentCount = 0;
    try {
      const items = await getOfflineQueue();
      if (items.length === 0) return 0;

      const sentIds: number[] = [];
      for (const item of items) {
        const ok = await sendPayloadToServer(item.payload, true);
        if (!ok) break;
        sentCount += 1;
        if (item.queueId !== undefined) {
          sentIds.push(item.queueId);
        }
      }
      if (sentIds.length > 0) {
        const remaining = await removeOfflinePoints(sentIds);
        setOfflineQueue(remaining);
        await pushLog('ok', `Búfer offline sincronizado (${sentCount} punto${sentCount === 1 ? '' : 's'})`, {
          httpStatus: 200,
          detail: remaining.length > 0 ? `Restan ${remaining.length} en cola` : 'Cola vacía al día',
        });
      }
    } finally {
      flushingRef.current = false;
      setSyncingQueue(false);
    }
    return sentCount;
  }, [pushLog, sendPayloadToServer]);

  // Auto-flush queue when network returns
  useEffect(() => {
    if (isOnline && offlineQueue.length > 0) {
      flushOfflineQueue();
    }
  }, [isOnline, offlineQueue.length, flushOfflineQueue]);

  const buildPayloadFromFix = useCallback((fix: LiveGpsFix, alarm?: string): VigiantTelemetryPayload => {
    const cfg = configRef.current;
    const batt = batteryRef.current;
    return {
      id: cfg.deviceId,
      lat: fix.lat,
      lon: fix.lon,
      timestamp: fix.timestamp,
      speed: fix.speedKnots,
      bearing: fix.bearing,
      altitude: fix.altitude,
      accuracy: fix.accuracy,
      batt: batt.levelPct,
      charge: batt.charging,
      valid: true,
      alarm,
    };
  }, []);

  const evaluateAndTransmitFix = useCallback(
    async (fix: LiveGpsFix, force = false) => {
      setCurrentFix(fix);
      setGpsError(null);
      const cfg = configRef.current;
      const now = Date.now();
      const lastSent = lastSentFixRef.current;
      const elapsedSec = (now - lastSentTimeRef.current) / 1000;

      const distMeters = lastSent
        ? haversineMeters(lastSent.lat, lastSent.lon, fix.lat, fix.lon)
        : Infinity;

      const isMoving = !cfg.stopDetection || fix.speedKmh >= 2 || distMeters >= 15;
      setMotionState(isMoving ? 'moving' : 'stationary');

      if (!force) {
        if (!cfg.serviceEnabled) return;
        if (elapsedSec < cfg.fastestIntervalSec) return;

        const targetInterval = isMoving ? cfg.intervalSec : cfg.stationaryHeartbeatSec;
        const intervalDue = elapsedSec >= targetInterval;
        const distanceDue = cfg.distanceMeters > 0 && isMoving && distMeters >= cfg.distanceMeters;
        const angleDue =
          cfg.accuracy === 'highest' &&
          cfg.angleDegrees > 0 &&
          Boolean(lastSent) &&
          angleDeltaDeg(lastSent!.bearing, fix.bearing) >= cfg.angleDegrees;

        if (!intervalDue && !distanceDue && !angleDue) {
          return;
        }
      }

      lastSentFixRef.current = fix;
      lastSentTimeRef.current = now;
      const payload = buildPayloadFromFix(fix);
      await sendPayloadToServer(payload);
    },
    [buildPayloadFromFix, sendPayloadToServer]
  );

  // Active GPS watcher or simulated field route when serviceEnabled is ON
  useEffect(() => {
    if (!config.serviceEnabled) return;

    if (simulateRoute) {
      const emitSimFix = () => {
        simStepRef.current += 1;
        const step = simStepRef.current;
        // Circular route around San Juan, Argentina (-31.5375, -68.5364)
        const angleRad = (step * 18 * Math.PI) / 180;
        const isPause = configRef.current.stopDetection && step % 8 >= 6;
        const radius = 0.0045;
        const lat = -31.5375 + Math.sin(angleRad) * radius;
        const lon = -68.5364 + Math.cos(angleRad) * radius;
        const speedKmh = isPause ? 0 : 42 + (step % 15);
        const bearing = ((Math.round((angleRad * 180) / Math.PI) + 90) % 360 + 360) % 360;
        evaluateAndTransmitFix({
          lat,
          lon,
          speedKmh,
          speedKnots: Number((speedKmh / 1.852).toFixed(2)),
          bearing,
          altitude: 642,
          accuracy: 8,
          timestamp: Date.now(),
          source: 'simulado',
        });
      };

      emitSimFix();
      const timer = window.setInterval(emitSimFix, Math.max(2000, config.fastestIntervalSec * 1000));
      return () => window.clearInterval(timer);
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('Este navegador no soporta Geolocation API.');
      pushLog('error', 'GPS no disponible en este navegador');
      return;
    }

    const posOptions = mapAccuracyToPositionOptions(config.accuracy);
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const speedMs = pos.coords.speed ?? 0;
        const speedKmh = Math.max(0, Math.round(speedMs * 3.6));
        const fix: LiveGpsFix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speedKmh,
          speedKnots: Number((speedKmh / 1.852).toFixed(2)),
          bearing: Number.isFinite(pos.coords.heading) ? Number(pos.coords.heading) : 0,
          altitude: Number.isFinite(pos.coords.altitude) ? Number(pos.coords.altitude) : 640,
          accuracy: Math.round(pos.coords.accuracy || 15),
          timestamp: pos.timestamp || Date.now(),
          source: 'gps',
        };
        evaluateAndTransmitFix(fix);
      },
      (err) => {
        const msg =
          err.code === 1
            ? 'Permiso de ubicación denegado por el usuario.'
            : err.code === 2
              ? 'Señal GPS no disponible temporalmente.'
              : 'Tiempo de espera agotado al obtener ubicación.';
        setGpsError(msg);
        pushLog('error', 'Error de proveedor GPS', { detail: msg });
      },
      posOptions
    );

    // Heartbeat timer ensures stationary / interval transmissions even if watchPosition stays idle
    const hbTimer = window.setInterval(() => {
      if (currentFixRef.current) {
        evaluateAndTransmitFix({
          ...currentFixRef.current,
          timestamp: Date.now(),
        });
      }
    }, Math.max(5000, Math.min(config.intervalSec, config.stationaryHeartbeatSec) * 1000));

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(hbTimer);
    };
  }, [
    config.serviceEnabled,
    config.accuracy,
    config.intervalSec,
    config.stationaryHeartbeatSec,
    config.fastestIntervalSec,
    simulateRoute,
    evaluateAndTransmitFix,
    pushLog,
  ]);

  const updateConfig = useCallback(
    (patch: Partial<VigiantConfig>) => {
      setConfig((prev) => {
        const next: VigiantConfig = { ...prev, ...patch };
        saveVigiantConfig(next);
        if (patch.serviceEnabled !== undefined && patch.serviceEnabled !== prev.serviceEnabled) {
          pushLog(
            patch.serviceEnabled ? 'ok' : 'info',
            patch.serviceEnabled ? 'Servicio de rastreo iniciado' : 'Servicio de rastreo detenido',
            { detail: `ID ${next.deviceId} · Precisión ${next.accuracy}` }
          );
          if (patch.serviceEnabled) {
            lastSentTimeRef.current = 0;
          }
        }
        return next;
      });
    },
    [pushLog]
  );

  const applyQrText = useCallback(
    async (rawText: string): Promise<{ ok: boolean; error?: string; changedKeys: string[] }> => {
      const res = parseVigiantConfigInput(rawText, configRef.current);
      if (res.error || res.changedKeys.length === 0) {
        await pushLog('error', 'Error al leer configuración QR', { detail: res.error });
        return { ok: false, error: res.error, changedKeys: [] };
      }
      saveVigiantConfig(res.config);
      setConfig(res.config);
      await pushLog('ok', 'Configuración actualizada vía QR', {
        detail: `ID ${res.config.deviceId} · Campos: ${res.changedKeys.join(', ')}`,
      });
      return { ok: true, changedKeys: res.changedKeys };
    },
    [pushLog]
  );

  const resetConfig = useCallback(async () => {
    const fresh = createDefaultVigiantConfig();
    saveVigiantConfig(fresh);
    setConfig(fresh);
    await pushLog('info', 'Ajustes restablecidos a valores predeterminados', {
      detail: `Nuevo ID: ${fresh.deviceId}`,
    });
  }, [pushLog]);

  const sendPositionNow = useCallback(async () => {
    if (currentFixRef.current) {
      await evaluateAndTransmitFix({ ...currentFixRef.current, timestamp: Date.now() }, true);
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const speedKmh = Math.max(0, Math.round((pos.coords.speed ?? 0) * 3.6));
          evaluateAndTransmitFix(
            {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              speedKmh,
              speedKnots: Number((speedKmh / 1.852).toFixed(2)),
              bearing: Number.isFinite(pos.coords.heading) ? Number(pos.coords.heading) : 0,
              altitude: Number.isFinite(pos.coords.altitude) ? Number(pos.coords.altitude) : 640,
              accuracy: Math.round(pos.coords.accuracy || 15),
              timestamp: pos.timestamp || Date.now(),
              source: 'gps',
            },
            true
          );
        },
        () => {
          // Fallback to San Juan base fix so manual test still verifies endpoint
          evaluateAndTransmitFix(
            {
              lat: -31.5375,
              lon: -68.5364,
              speedKmh: 0,
              speedKnots: 0,
              bearing: 0,
              altitude: 640,
              accuracy: 25,
              timestamp: Date.now(),
              source: 'simulado',
            },
            true
          );
        },
        mapAccuracyToPositionOptions(configRef.current.accuracy)
      );
    }
  }, [evaluateAndTransmitFix]);

  const sendSos = useCallback(async () => {
    setSendingSos(true);
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([200, 100, 200, 100, 350]);
      }

      let fix: LiveGpsFix | null = currentFixRef.current;
      if (!fix && typeof navigator !== 'undefined' && navigator.geolocation) {
        fix = await new Promise<LiveGpsFix | null>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const speedKmh = Math.max(0, Math.round((pos.coords.speed ?? 0) * 3.6));
              resolve({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                speedKmh,
                speedKnots: Number((speedKmh / 1.852).toFixed(2)),
                bearing: Number.isFinite(pos.coords.heading) ? Number(pos.coords.heading) : 0,
                altitude: Number.isFinite(pos.coords.altitude) ? Number(pos.coords.altitude) : 640,
                accuracy: Math.round(pos.coords.accuracy || 15),
                timestamp: pos.timestamp || Date.now(),
                source: 'gps',
              });
            },
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 4500, maximumAge: 15000 }
          );
        });
      }

      const resolvedFix: LiveGpsFix = fix ?? {
        lat: -31.5375,
        lon: -68.5364,
        speedKmh: 0,
        speedKnots: 0,
        bearing: 0,
        altitude: 640,
        accuracy: 35,
        timestamp: Date.now(),
        source: 'simulado',
      };
      setCurrentFix(resolvedFix);

      const payload = buildPayloadFromFix(resolvedFix, 'sos');
      await sendPayloadToServer(payload);
    } finally {
      setSendingSos(false);
    }
  }, [buildPayloadFromFix, sendPayloadToServer]);

  const clearLogs = useCallback(async () => {
    setLogs([]);
    await clearVigiantLogs();
  }, []);

  const clearQueue = useCallback(async () => {
    setOfflineQueue([]);
    await clearOfflineQueue();
    await pushLog('info', 'Búfer offline vaciado manualmente');
  }, [pushLog]);

  return {
    config,
    logs,
    offlineQueue,
    isOnline,
    currentFix,
    battery,
    wakeLockActive,
    motionState,
    lastSyncAt,
    gpsError,
    simulateRoute,
    syncingQueue,
    sendingSos,
    setSimulateRoute,
    updateConfig,
    applyQrText,
    resetConfig,
    sendPositionNow,
    sendSos,
    flushOfflineQueue,
    clearLogs,
    clearQueue,
  };
}
