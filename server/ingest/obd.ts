import { parseDtcList } from '../../src/shared/dtc.ts';

/** Engine data read from a Traccar position (only the values present in that report). */
export interface ObdReading {
  rpm?: number;
  coolantTempC?: number;
  fuelPct?: number;
  odometerKm?: number;
  engineHours?: number;
  batteryV?: number;
  vin?: string;
  /** Active codes. Undefined = the report says nothing about faults; [] = no active faults. */
  dtcs?: string[];
}

/**
 * Teltonika AVL ids that Traccar may forward raw as "ioNN" (FMC003 / FMB003 OBD elements).
 * Traccar already translates several of them to standard keys (rpm, coolantTemp, power…);
 * this table only fills the gaps. Confirm in the pilot with INGEST_LOG=true and adjust.
 */
export const TELTONIKA_IO = {
  dtcCount: 'io30',
  coolantTemp: 'io32', // °C
  rpm: 'io36',
  fuelLevel: 'io48', // %
  externalVoltage: 'io66', // mV
  vin: 'io256',
  dtcList: 'io281',
  oemOdometer: 'io389', // km
  oemFuelLevel: 'io390', // %
} as const;

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const first = (attrs: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== '') return attrs[k];
  return undefined;
};
const inRange = (n: number | undefined, min: number, max: number) => (n !== undefined && n >= min && n <= max ? n : undefined);

/** Reads OBD-II values from Traccar position attributes (standard keys first, then Teltonika ioNN). */
export function extractObd(attributes: Record<string, unknown> | undefined): ObdReading | null {
  if (!attributes) return null;
  const a = attributes;
  const io = TELTONIKA_IO;
  const reading: ObdReading = {};

  reading.rpm = inRange(num(first(a, 'rpm', io.rpm)), 0, 12000);
  reading.coolantTempC = inRange(num(first(a, 'coolantTemp', 'engineTemp', io.coolantTemp)), -40, 215);
  reading.fuelPct = inRange(num(first(a, 'fuelLevel', 'fuel', io.oemFuelLevel, io.fuelLevel)), 0, 100);

  const obdOdo = num(a.obdOdometer); // meters (Traccar)
  const oemOdo = num(a[io.oemOdometer]); // km (Teltonika OEM total mileage)
  const odoKm = obdOdo !== undefined ? obdOdo / 1000 : oemOdo;
  if (odoKm !== undefined && odoKm > 0) reading.odometerKm = Number(odoKm.toFixed(1));

  const hoursMs = num(a.hours); // Traccar keeps engine hours in milliseconds
  if (hoursMs !== undefined && hoursMs > 0) reading.engineHours = Number((hoursMs / 3_600_000).toFixed(1));

  const power = num(first(a, 'power'));
  const mv = num(a[io.externalVoltage]);
  const volts = power ?? (mv !== undefined ? mv / 1000 : undefined);
  reading.batteryV = inRange(volts !== undefined ? Number(volts.toFixed(2)) : undefined, 0, 60);

  const vin = first(a, 'vin', io.vin);
  if (typeof vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) reading.vin = vin.trim().toUpperCase();

  const list = first(a, 'dtcs', io.dtcList);
  const count = num(a[io.dtcCount]);
  if (list !== undefined) reading.dtcs = parseDtcList(list);
  else if (a.dtcs === '' || count === 0) reading.dtcs = [];

  const hasData = Object.values(reading).some((v) => v !== undefined);
  return hasData ? reading : null;
}
