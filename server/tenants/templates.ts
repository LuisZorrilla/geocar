import type { AlertRule, PreventivePlan } from '../../src/shared/types.ts';

/**
 * Starter configuration for a company. The preventive plans are the same ones the demo
 * seed uses (the seed calls this function too); alert rules are a generic standard set.
 */
export function buildDefaultPreventivePlans(tenantId: string, updatedAt: (minutesAgo: number) => string): PreventivePlan[] {
  return [
    {
      id: `pln-${tenantId}-veh-250`,
      tenantId,
      name: 'Servicio Preventivo A · Vehículos y Tractos (250 h / 10,000 km)',
      assetType: 'vehiculo',
      intervalHours: 250,
      intervalKm: 10000,
      intervalDays: 45,
      estimatedCost: 6850,
      checklistFocus: 'Aceite motor 15W-40, filtros diésel/aire, ajuste de balatas y calibración ADAS.',
      active: true,
      updatedAt: updatedAt(1440),
    },
    {
      id: `pln-${tenantId}-maq-250`,
      tenantId,
      name: 'Overhaul Preventivo 250 h · Maquinaria Pesada',
      assetType: 'maquinaria_pesada',
      intervalHours: 250,
      intervalKm: 2500,
      intervalDays: 30,
      estimatedCost: 14900,
      checklistFocus: 'Aceite hidráulico ISO 46, mangueras alta presión, engrase de pernos y diagnóstico J1939.',
      active: true,
      updatedAt: updatedAt(2880),
    },
    {
      id: `pln-${tenantId}-cam-90`,
      tenantId,
      name: 'Inspección Trimestral Dashcam, Arnés y Bus CAN',
      assetType: 'ambos',
      intervalHours: 500,
      intervalKm: 20000,
      intervalDays: 90,
      estimatedCost: 1950,
      checklistFocus: 'Limpieza de lentes CH1/CH2, verificación SD industrial, calibración G-Sensor y puerto OBD/J1939.',
      active: true,
      updatedAt: updatedAt(4320),
    },
  ];
}

export function buildDefaultAlertRules(tenantId: string): AlertRule[] {
  const rule = (suffix: string, r: Omit<AlertRule, 'id' | 'tenantId' | 'active'>): AlertRule => ({
    id: `rul-${tenantId}-${suffix}`,
    tenantId,
    active: true,
    ...r,
  });
  return [
    rule('velocidad', {
      name: 'Exceso de velocidad (> 90 km/h)',
      conditionType: 'velocidad',
      thresholdLabel: '> 90 km/h durante 15 s',
      priority: 'alta',
      autoCreateClip: true,
      notifyQueue: 'alerts.high',
    }),
    rule('panico', {
      name: 'Botón de pánico (SOS)',
      conditionType: 'panico',
      thresholdLabel: 'Activación del botón SOS',
      priority: 'critica',
      autoCreateClip: true,
      notifyQueue: 'alerts.critical',
    }),
    rule('colision', {
      name: 'Posible colisión / impacto (G-sensor)',
      conditionType: 'colision_g',
      thresholdLabel: '> 0.65 G',
      priority: 'critica',
      autoCreateClip: true,
      notifyQueue: 'alerts.critical',
    }),
    rule('fatiga', {
      name: 'Fatiga o distracción del conductor (DMS)',
      conditionType: 'fatiga_dms',
      thresholdLabel: 'Evento DMS confirmado',
      priority: 'alta',
      autoCreateClip: true,
      notifyQueue: 'alerts.high',
    }),
  ];
}

/** What the wizard shows next to each template checkbox. */
export const TEMPLATE_DESCRIPTIONS = {
  preventivePlans: buildDefaultPreventivePlans('x', () => '').map((p) => p.name),
  alertRules: buildDefaultAlertRules('x').map((r) => r.name),
};
