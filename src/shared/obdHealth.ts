import type { Device, Vehicle } from './types.ts';
import { OBD_OFFLINE_MINUTES } from './teltonika.ts';

export type ObdHealthLevel = 'bien' | 'atencion' | 'critico' | 'sin_datos';

export interface ObdHealth {
  level: ObdHealthLevel;
  label: string;
  /** Reasons, in Spanish, most serious first. */
  reasons: string[];
}

export const OBD_THRESHOLDS = {
  coolantCriticalC: 105,
  /** Battery with the engine off / running (alternator charging). */
  batteryLowOffV: 12.0,
  batteryLowRunningV: 13.2,
} as const;

const LABELS: Record<ObdHealthLevel, string> = {
  bien: 'Bien',
  atencion: 'Atención',
  critico: 'Crítico',
  sin_datos: 'Sin datos',
};

/** Health of a unit from its latest OBD data. Only meaningful when the source is OBD-II. */
export function obdHealth(v: Pick<Vehicle, 'telemetrySourceEngine' | 'coolantTempC' | 'batteryVoltage' | 'rpm' | 'ignition' | 'faultCodes'>): ObdHealth {
  if (v.telemetrySourceEngine !== 'obd') return { level: 'sin_datos', label: LABELS.sin_datos, reasons: [] };
  const critical: string[] = [];
  const warning: string[] = [];
  const faults = (v.faultCodes ?? []).filter((f) => f.source === 'obd' || f.source === 'can');
  for (const f of faults) (f.severity === 'critica' ? critical : warning).push(`${f.code}: ${f.description}`);
  if (typeof v.coolantTempC === 'number' && v.coolantTempC > OBD_THRESHOLDS.coolantCriticalC) {
    critical.unshift(`Temperatura del motor ${v.coolantTempC} °C (máx. ${OBD_THRESHOLDS.coolantCriticalC} °C)`);
  }
  const volts = (n: number) => n.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (typeof v.batteryVoltage === 'number') {
    const running = (v.rpm ?? 0) > 400;
    const min = running ? OBD_THRESHOLDS.batteryLowRunningV : OBD_THRESHOLDS.batteryLowOffV;
    if (v.batteryVoltage < min) {
      warning.unshift(
        running
          ? `Batería ${volts(v.batteryVoltage)} V en marcha: el alternador no carga bien (mín. ${volts(min)} V)`
          : `Batería ${volts(v.batteryVoltage)} V con el motor apagado (mín. ${volts(min)} V)`
      );
    }
  }
  if (critical.length) return { level: 'critico', label: LABELS.critico, reasons: [...critical, ...warning] };
  if (warning.length) return { level: 'atencion', label: LABELS.atencion, reasons: warning };
  return { level: 'bien', label: LABELS.bien, reasons: [] };
}

export type ObdLinkState = 'sin_equipo' | 'manual' | 'error' | 'esperando' | 'conectado' | 'sin_senal';

export interface ObdLink {
  state: ObdLinkState;
  label: string;
  detail?: string;
}

/** Connection state of the OBD-II tracker of a unit. */
export function obdLink(device: Pick<Device, 'lastObdAt' | 'provisioning'> | undefined, now = Date.now()): ObdLink {
  if (!device) return { state: 'sin_equipo', label: 'Sin equipo' };
  if (device.lastObdAt) {
    const ageMin = (now - Date.parse(device.lastObdAt)) / 60_000;
    if (Number.isFinite(ageMin) && ageMin > OBD_OFFLINE_MINUTES) return { state: 'sin_senal', label: 'Sin señal', detail: device.lastObdAt };
    return { state: 'conectado', label: 'Conectado', detail: device.lastObdAt };
  }
  const p = device.provisioning;
  if (p?.status === 'error') return { state: 'error', label: 'Error en Traccar', detail: p.message };
  if (p?.status === 'manual') return { state: 'manual', label: 'Alta manual en Traccar', detail: p.message };
  return { state: 'esperando', label: 'Esperando primer reporte' };
}
