/**
 * Teltonika FMx003 (FMC003/FMB003) setup and remote commands.
 *
 * The same text works by SMS (with two leading spaces: empty user and password) and as a
 * GPRS command (Codec 12) sent through Traccar once the tracker is online.
 *
 * Parameter ids are from the Teltonika FMB/FMC parameter list. Confirm them for the firmware
 * of the tracker (Teltonika wiki → FMC003 Parameter list) before a large rollout.
 */

export const TELTONIKA_PARAM = {
  apn: 2001,
  apnUser: 2002,
  apnPassword: 2003,
  serverDomain: 2004,
  serverPort: 2005,
  /** 0 = TCP, 1 = UDP. */
  serverProtocol: 2006,
  /** 0 = Codec 8, 1 = Codec 8 Extended (needed for VIN and OEM data). */
  dataProtocol: 113,
  /** Data acquisition, home network: minimum period while stopped / moving (seconds). */
  homeStopPeriod: 10000,
  homeMovingPeriod: 10050,
} as const;

export interface ApnPreset {
  id: string;
  label: string;
  apn: string;
}

/** Common M2M/data APNs in Argentina. Corporate M2M lines may use their own APN: ask the carrier. */
export const APN_PRESETS: ApnPreset[] = [
  { id: 'personal', label: 'Personal', apn: 'datos.personal.com' },
  { id: 'claro', label: 'Claro', apn: 'igprs.claro.com.ar' },
  { id: 'movistar', label: 'Movistar', apn: 'internet.gprs.unifon.com.ar' },
];

export const APN_RE = /^[A-Za-z0-9._-]{1,63}$/;

/** SMS that points a brand-new tracker at the server (APN, host, port, TCP, Codec 8 Extended). */
export function buildSetupSms(input: { apn?: string; host: string; port: number }): string {
  const p = TELTONIKA_PARAM;
  const parts: string[] = [];
  if (input.apn) parts.push(`${p.apn}:${input.apn}`);
  parts.push(`${p.serverDomain}:${input.host}`, `${p.serverPort}:${input.port}`, `${p.serverProtocol}:0`, `${p.dataProtocol}:1`);
  return `  setparam ${parts.join(';')}`;
}

export interface ReportProfile {
  id: string;
  label: string;
  movingS: number;
  stopS: number;
  hint: string;
}

export const REPORT_PROFILES: ReportProfile[] = [
  { id: 'normal', label: 'Normal', movingS: 30, stopS: 300, hint: 'Uso diario: un dato cada 30 s en marcha y cada 5 min detenido.' },
  { id: 'ahorro', label: 'Ahorro', movingS: 60, stopS: 3600, hint: 'Menos datos móviles y menos consumo de batería con el vehículo parado.' },
  { id: 'intensivo', label: 'Intensivo', movingS: 10, stopS: 60, hint: 'Para diagnosticar una falla o seguir un viaje de cerca. Usa más datos.' },
];

export interface ObdCommandDef {
  id: string;
  label: string;
  description: string;
  /** Options shown as a select (only report profiles today). */
  options?: { id: string; label: string }[];
  /** Asks for confirmation before sending. */
  confirm?: string;
  build: (option?: string) => string | null;
}

export const OBD_COMMANDS: ObdCommandDef[] = [
  {
    id: 'getver',
    label: 'Ver versión',
    description: 'Firmware, modelo e IMEI del equipo.',
    build: () => 'getver',
  },
  {
    id: 'getstatus',
    label: 'Ver estado',
    description: 'Conexión al servidor, señal celular y GPS.',
    build: () => 'getstatus',
  },
  {
    id: 'obdinfo',
    label: 'Pedir datos OBD',
    description: 'Protocolo OBD detectado, VIN y estado de la lectura del vehículo.',
    build: () => 'obdinfo',
  },
  {
    id: 'faultcodes',
    label: 'Pedir códigos de falla',
    description: 'Lee en el momento los códigos de falla activos del vehículo.',
    build: () => 'faultcodes',
  },
  {
    id: 'report_profile',
    label: 'Cambiar frecuencia de reporte',
    description: 'Cada cuánto manda datos en marcha y detenido.',
    options: REPORT_PROFILES.map((r) => ({ id: r.id, label: `${r.label} (${r.movingS} s / ${r.stopS >= 3600 ? `${r.stopS / 3600} h` : `${r.stopS / 60} min`})` })),
    build: (option) => {
      const profile = REPORT_PROFILES.find((r) => r.id === option);
      if (!profile) return null;
      return `setparam ${TELTONIKA_PARAM.homeMovingPeriod}:${profile.movingS};${TELTONIKA_PARAM.homeStopPeriod}:${profile.stopS}`;
    },
  },
  {
    id: 'codec8e',
    label: 'Activar Codec 8 Extended',
    description: 'Necesario para recibir el VIN y los datos OEM. Úsalo si llega la posición pero no el motor.',
    build: () => `setparam ${TELTONIKA_PARAM.dataProtocol}:1`,
  },
  {
    id: 'cpureset',
    label: 'Reiniciar equipo',
    description: 'Reinicia el rastreador. Vuelve a conectarse en uno o dos minutos.',
    confirm: '¿Reiniciar el equipo OBD-II? Dejará de reportar uno o dos minutos.',
    build: () => 'cpureset',
  },
];

export function findObdCommand(id: string): ObdCommandDef | undefined {
  return OBD_COMMANDS.find((c) => c.id === id);
}

/** Minutes without OBD data after which a tracker is shown as "Sin señal". */
export const OBD_OFFLINE_MINUTES = 15;
