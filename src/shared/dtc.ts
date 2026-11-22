/**
 * OBD-II diagnostic trouble codes (SAE J2012 / ISO 15031-6).
 *
 * A code is 1 letter + 4 characters: P0420
 * - letter: P powertrain (engine/transmission), C chassis, B body, U network
 * - 1st digit: 0/2/3 generic (same meaning in every brand), 1 manufacturer-specific
 * Unknown codes still get a readable description from their system and subsystem.
 */

export type DtcSeverity = 'critica' | 'advertencia';

export interface DtcInfo {
  code: string;
  system: string;
  description: string;
  severity: DtcSeverity;
}

const KNOWN: Record<string, [string, DtcSeverity?]> = {
  P0010: ['Circuito del actuador de posición del árbol de levas (banco 1)'],
  P0011: ['Distribución del árbol de levas adelantada (banco 1)'],
  P0016: ['Correlación cigüeñal / árbol de levas (banco 1, sensor A)', 'critica'],
  P0087: ['Presión del riel de combustible demasiado baja', 'critica'],
  P0101: ['Sensor de flujo de aire (MAF): rango o rendimiento'],
  P0102: ['Sensor de flujo de aire (MAF): señal baja'],
  P0106: ['Sensor de presión del múltiple (MAP): rango o rendimiento'],
  P0113: ['Sensor de temperatura del aire de admisión: señal alta'],
  P0115: ['Circuito del sensor de temperatura del refrigerante'],
  P0117: ['Sensor de temperatura del refrigerante: señal baja'],
  P0118: ['Sensor de temperatura del refrigerante: señal alta'],
  P0121: ['Sensor de posición del acelerador: rango o rendimiento'],
  P0128: ['Termostato: el refrigerante no alcanza la temperatura de trabajo'],
  P0130: ['Sensor de oxígeno (banco 1, sensor 1): falla del circuito'],
  P0133: ['Sensor de oxígeno (banco 1, sensor 1): respuesta lenta'],
  P0135: ['Calefactor del sensor de oxígeno (banco 1, sensor 1)'],
  P0141: ['Calefactor del sensor de oxígeno (banco 1, sensor 2)'],
  P0171: ['Mezcla demasiado pobre (banco 1)'],
  P0172: ['Mezcla demasiado rica (banco 1)'],
  P0174: ['Mezcla demasiado pobre (banco 2)'],
  P0175: ['Mezcla demasiado rica (banco 2)'],
  P0217: ['Sobretemperatura del motor', 'critica'],
  P0218: ['Sobretemperatura de la transmisión', 'critica'],
  P0234: ['Sobrealimentación del turbo (sobrepresión)', 'critica'],
  P0299: ['Turbo: presión de sobrealimentación baja'],
  P0300: ['Fallas de encendido aleatorias en varios cilindros', 'critica'],
  P0301: ['Falla de encendido en el cilindro 1', 'critica'],
  P0302: ['Falla de encendido en el cilindro 2', 'critica'],
  P0303: ['Falla de encendido en el cilindro 3', 'critica'],
  P0304: ['Falla de encendido en el cilindro 4', 'critica'],
  P0305: ['Falla de encendido en el cilindro 5', 'critica'],
  P0306: ['Falla de encendido en el cilindro 6', 'critica'],
  P0325: ['Sensor de detonación (banco 1): falla del circuito'],
  P0335: ['Sensor de posición del cigüeñal: falla del circuito', 'critica'],
  P0340: ['Sensor de posición del árbol de levas: falla del circuito'],
  P0380: ['Bujías de precalentamiento (diésel): falla del circuito'],
  P0400: ['Recirculación de gases de escape (EGR): flujo incorrecto'],
  P0401: ['EGR: flujo insuficiente'],
  P0402: ['EGR: flujo excesivo'],
  P0420: ['Eficiencia del catalizador por debajo del umbral (banco 1)'],
  P0430: ['Eficiencia del catalizador por debajo del umbral (banco 2)'],
  P0440: ['Sistema de control de evaporación (EVAP): falla'],
  P0442: ['EVAP: pérdida pequeña detectada'],
  P0455: ['EVAP: pérdida grande detectada (revisar tapa de combustible)'],
  P0456: ['EVAP: pérdida muy pequeña detectada'],
  P0480: ['Electroventilador de refrigeración 1: falla del circuito', 'critica'],
  P0500: ['Sensor de velocidad del vehículo: falla'],
  P0505: ['Control de ralentí: falla'],
  P0506: ['Ralentí más bajo de lo esperado'],
  P0507: ['Ralentí más alto de lo esperado'],
  P0520: ['Sensor o interruptor de presión de aceite: falla', 'critica'],
  P0521: ['Presión de aceite: rango o rendimiento', 'critica'],
  P0524: ['Presión de aceite del motor demasiado baja', 'critica'],
  P0562: ['Tensión del sistema baja (batería o alternador)'],
  P0563: ['Tensión del sistema alta'],
  P0571: ['Interruptor de freno: falla del circuito', 'critica'],
  P0600: ['Falla de comunicación serie de la ECU'],
  P0606: ['Procesador de la ECU: falla', 'critica'],
  P0700: ['Sistema de control de la transmisión: falla (ver códigos de la TCU)'],
  P0715: ['Sensor de velocidad de entrada de la transmisión'],
  P0730: ['Relación de cambio incorrecta', 'critica'],
  P0740: ['Embrague del convertidor de par: falla'],
  P2002: ['Filtro de partículas diésel (DPF): eficiencia baja (banco 1)'],
  P2463: ['Filtro de partículas diésel (DPF): acumulación de hollín', 'critica'],
  P20EE: ['Catalizador SCR (AdBlue): eficiencia baja'],
  C0035: ['Sensor de velocidad de rueda delantera izquierda (ABS)', 'critica'],
  C0040: ['Sensor de velocidad de rueda delantera derecha (ABS)', 'critica'],
  C0045: ['Sensor de velocidad de rueda trasera izquierda (ABS)', 'critica'],
  C0050: ['Sensor de velocidad de rueda trasera derecha (ABS)', 'critica'],
  C0265: ['Relé del motor de la bomba ABS', 'critica'],
  B0001: ['Airbag del conductor: falla del circuito', 'critica'],
  B0100: ['Airbag del acompañante: falla del circuito', 'critica'],
  U0100: ['Sin comunicación con la ECU del motor', 'critica'],
  U0101: ['Sin comunicación con la TCU (transmisión)'],
  U0121: ['Sin comunicación con el módulo ABS', 'critica'],
  U0155: ['Sin comunicación con el tablero de instrumentos'],
};

const SYSTEMS: Record<string, string> = { P: 'Motor y transmisión', C: 'Chasis', B: 'Carrocería', U: 'Red de comunicación' };

/** P0 subsystems by the 2nd digit (P0x..). */
const POWERTRAIN_AREA: Record<string, string> = {
  '0': 'control de combustible, aire o emisiones',
  '1': 'medición de combustible y aire',
  '2': 'medición de combustible y aire (inyectores)',
  '3': 'encendido o fallas de encendido',
  '4': 'control auxiliar de emisiones',
  '5': 'velocidad, ralentí o entradas auxiliares',
  '6': 'computadora o salidas auxiliares',
  '7': 'transmisión',
  '8': 'transmisión',
  '9': 'transmisión',
  A: 'propulsión híbrida',
  B: 'propulsión híbrida',
  C: 'propulsión híbrida',
};

/** Normalizes "p0420", "P0420-00" or "0420" (assumed P) to "P0420"; null when it is not a DTC. */
export function normalizeDtc(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  const m = /^([PCBU])?([0-3][0-9A-F]{3})/.exec(t);
  if (!m) return null;
  return `${m[1] ?? 'P'}${m[2]}`;
}

/** Splits Traccar's `dtcs` attribute ("P0420 P0171", "P0420,P0171") into unique codes. */
export function parseDtcList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((v) => normalizeDtc(String(v))).filter((c): c is string => Boolean(c)))];
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[\s,;|]+/).map(normalizeDtc).filter((c): c is string => Boolean(c)))];
}

export function describeDtc(code: string): DtcInfo {
  const system = SYSTEMS[code[0]] ?? 'Sistema desconocido';
  const known = KNOWN[code];
  if (known) return { code, system, description: known[0], severity: known[1] ?? 'advertencia' };
  const manufacturer = code[1] === '1' || (code[0] !== 'P' && code[1] === '2');
  const area = code[0] === 'P' ? POWERTRAIN_AREA[code[2]] : undefined;
  const description = [
    manufacturer ? 'Código propio del fabricante' : 'Código genérico',
    area ? `de ${area}` : `de ${system.toLowerCase()}`,
    '— consultar con el escáner del taller',
  ].join(' ');
  // Ignition (P03xx) and network-loss codes are treated as critical even when not listed.
  const severity: DtcSeverity = code[0] === 'P' && code[2] === '3' ? 'critica' : 'advertencia';
  return { code, system, description, severity };
}
