import type { DriverPhoneTracker, PhonePlatform } from './types.ts';

/** Minutes without reports after which a phone is shown as "Sin señal". */
export const PHONE_OFFLINE_MINUTES = 10;
/** Fixes less precise than this are discarded (cell-tower positions jump hundreds of meters). */
export const PHONE_MAX_ACCURACY_M = 100;
/** A unit's own tracker (camera / OBD) wins if it reported within this window. */
export const PHONE_DEVICE_PRIORITY_MS = 3 * 60_000;
export const PHONE_LOW_BATTERY_PCT = 15;

export const PLATFORM_LABELS: Record<PhonePlatform, string> = { android: 'Android', ios: 'iPhone' };

export interface PhoneSetting {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Recommended Traccar Client settings (balance between accuracy and the driver's battery). `key` / `param`
 * are Traccar Client's own preference names (lib/preferences.dart), used by the configuration QR.
 */
export const CLIENT_SETTINGS: (PhoneSetting & { key: string; param: string; androidOnly?: boolean })[] = [
  { key: 'accuracy', label: 'Location accuracy', value: 'High', param: 'high', hint: 'GPS; en túneles o galpones usa red celular' },
  { key: 'distance', label: 'Distance', value: '100', param: '100', hint: 'metros entre reportes en movimiento' },
  { key: 'interval', label: 'Interval', value: '60', param: '60', hint: 'segundos (solo Android)', androidOnly: true },
  { key: 'angle', label: 'Angle', value: '30', param: '30', hint: 'grados: reporta en cada giro' },
  { key: 'heartbeat', label: 'Heartbeat', value: '300', param: '300', hint: 'segundos entre reportes detenido' },
  { key: 'buffer', label: 'Offline buffering', value: 'Activado', param: 'true', hint: 'guarda posiciones sin señal y las manda después' },
  { key: 'stop_detection', label: 'Stop detection', value: 'Activado', param: 'true', hint: 'ahorra batería detenido' },
  { key: 'wakelock', label: 'Wake lock', value: 'Activado', param: 'true', hint: 'evita que el celular se duerma en marcha (solo Android)', androidOnly: true },
];

const settingsFor = (platform: PhonePlatform) => CLIENT_SETTINGS.filter((s) => platform === 'android' || !s.androidOnly);

export function recommendedSettings(platform: PhonePlatform): PhoneSetting[] {
  return settingsFor(platform).map(({ label, value, hint }) => ({ label, value, hint }));
}

/** Minimum Traccar Client version that scans configuration QR codes / opens configuration links. */
export const CLIENT_QR_MIN_VERSION = '9.6';

/**
 * Link that configures Traccar Client in one step: scanned from the app (Ajustes → escanear QR) or opened
 * from the phone. Traccar Client takes the Server URL from `url` and applies every other parameter
 * (ConfigurationService.applyUri). Null when the server URL is not configured.
 */
export function buildClientConfigUri(input: { identifier: string; serverUrl: string | null | undefined; platform: PhonePlatform }): string | null {
  if (!input.serverUrl || !input.identifier) return null;
  const params = new URLSearchParams({ url: input.serverUrl, id: input.identifier });
  for (const s of settingsFor(input.platform)) params.set(s.key, s.param);
  return `org.traccar.client://config?${params.toString()}`;
}

/** Phone permissions the driver must grant, per platform. */
export function phonePermissions(platform: PhonePlatform): string[] {
  return platform === 'android'
    ? [
        'Ubicación: «Permitir todo el tiempo» y «Ubicación precisa».',
        'Batería: Traccar Client en «Sin restricciones» (Ajustes → Apps → Traccar Client → Batería).',
        'Samsung: quitarla de «Apps en suspensión». Xiaomi: «Inicio automático» activado y ahorro de batería «Sin restricciones».',
        'No cerrar la app desde «recientes»: debe quedar la notificación de Traccar Client.',
      ]
    : [
        'Ubicación: «Siempre» y «Ubicación exacta» activada (Ajustes → Traccar Client → Ubicación).',
        'Actualización en segundo plano activada.',
        'No cerrar la app deslizándola en el selector de apps: iOS deja de rastrear.',
        'Modo de bajo consumo desactivado durante el turno.',
      ];
}

/** Text the admin sends to the driver (WhatsApp / mail) to configure Traccar Client. */
export function buildShareText(input: {
  driverName: string;
  identifier: string;
  serverUrl: string;
  platform: PhonePlatform;
  companyName?: string;
}): string {
  const store = input.platform === 'android' ? 'Google Play' : 'App Store';
  const lines = [
    `Hola ${input.driverName}: configurá el rastreo del celular${input.companyName ? ` para ${input.companyName}` : ''}.`,
    '',
    `1) Instalá «Traccar Client» desde ${store}.`,
    '2) Abrila y cargá:',
    `   • Device identifier: ${input.identifier}`,
    `   • Server URL: ${input.serverUrl}`,
    ...recommendedSettings(input.platform).map((s) => `   • ${s.label}: ${s.value}`),
    '3) Permisos:',
    ...phonePermissions(input.platform).map((p) => `   • ${p}`),
    '4) Activá «Continuous tracking» (Service status). Solo se usa tu ubicación mientras tenés una unidad asignada.',
  ];
  const link = buildClientConfigUri(input);
  if (link) {
    lines.push('', `Atajo (Traccar Client ${CLIENT_QR_MIN_VERSION} o posterior): tocá este enlace y la app queda configurada sola, sin el paso 2:`, link);
  }
  return lines.join('\n');
}

export type PhoneLinkState = 'sin_celular' | 'manual' | 'error' | 'esperando' | 'conectado' | 'sin_senal';

export interface PhoneLink {
  state: PhoneLinkState;
  label: string;
  detail?: string;
}

export function phoneLink(t: Pick<DriverPhoneTracker, 'lastSeenAt' | 'provisioning'> | undefined, now = Date.now()): PhoneLink {
  if (!t) return { state: 'sin_celular', label: 'Sin celular' };
  if (t.lastSeenAt) {
    const ageMin = (now - Date.parse(t.lastSeenAt)) / 60_000;
    if (Number.isFinite(ageMin) && ageMin > PHONE_OFFLINE_MINUTES) return { state: 'sin_senal', label: 'Sin señal', detail: t.lastSeenAt };
    return { state: 'conectado', label: 'Conectado', detail: t.lastSeenAt };
  }
  const p = t.provisioning;
  if (p?.status === 'error') return { state: 'error', label: 'Error en Traccar', detail: p.message };
  if (p?.status === 'manual') return { state: 'manual', label: 'Alta manual en Traccar', detail: p.message };
  return { state: 'esperando', label: 'Esperando primer reporte' };
}

/** Random identifier: "GC-" + 8 digits. Uniqueness is checked by the server. */
export function newPhoneIdentifier(random: () => number = Math.random): string {
  let digits = '';
  for (let i = 0; i < 8; i++) digits += Math.floor(random() * 10);
  return `GC-${digits}`;
}
