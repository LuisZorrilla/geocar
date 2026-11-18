import { bcdToString, stringToBcd, type ProtocolVersion } from './codec.ts';

export const MSG = {
  TERMINAL_GENERAL_RESPONSE: 0x0001,
  HEARTBEAT: 0x0002,
  UNREGISTER: 0x0003,
  REGISTER: 0x0100,
  AUTH: 0x0102,
  LOCATION: 0x0200,
  LOCATION_BATCH: 0x0704,
  PLATFORM_GENERAL_RESPONSE: 0x8001,
  REGISTER_RESPONSE: 0x8100,
} as const;

export const MSG_NAMES: Record<number, string> = {
  0x0001: 'Respuesta general del terminal',
  0x0002: 'Heartbeat',
  0x0003: 'Baja del terminal',
  0x0100: 'Registro',
  0x0102: 'Autenticación',
  0x0104: 'Respuesta a consulta de parámetros',
  0x0200: 'Posición',
  0x0704: 'Lote de posiciones',
  0x0800: 'Evento multimedia',
  0x0801: 'Carga multimedia',
  0x1205: 'Lista de recursos de video (JT1078)',
};

// ---- String helpers (terminal strings are GBK, usually plain ASCII in practice) ----

let gbk: TextDecoder | null = null;
try {
  gbk = new TextDecoder('gbk');
} catch {
  gbk = null;
}

function readString(buf: Buffer): string {
  const trimmed = buf.subarray(0, buf.indexOf(0) === -1 ? buf.length : buf.indexOf(0));
  return (gbk ? gbk.decode(trimmed) : trimmed.toString('latin1')).trim();
}

// ---- Terminal → platform ---------------------------------------------------

export interface RegisterBody {
  provinceId: number;
  cityId: number;
  manufacturerId: string;
  terminalModel: string;
  terminalId: string;
  plateColor: number;
  plate: string;
}

export function parseRegister(body: Buffer, version: ProtocolVersion): RegisterBody {
  const [mLen, modelLen, idLen] = version === '2019' ? [11, 30, 30] : [5, 20, 7];
  let o = 0;
  const provinceId = body.readUInt16BE(o);
  const cityId = body.readUInt16BE(o + 2);
  o += 4;
  const manufacturerId = readString(body.subarray(o, o + mLen));
  o += mLen;
  const terminalModel = readString(body.subarray(o, o + modelLen));
  o += modelLen;
  const terminalId = readString(body.subarray(o, o + idLen));
  o += idLen;
  const plateColor = body[o];
  o += 1;
  const plate = readString(body.subarray(o));
  return { provinceId, cityId, manufacturerId, terminalModel, terminalId, plateColor, plate };
}

export interface AuthBody {
  authCode: string;
  imei?: string;
  softwareVersion?: string;
}

export function parseAuth(body: Buffer, version: ProtocolVersion): AuthBody {
  if (version === '2013') return { authCode: readString(body) };
  const len = body[0];
  const authCode = readString(body.subarray(1, 1 + len));
  const imei = readString(body.subarray(1 + len, 1 + len + 15));
  const softwareVersion = readString(body.subarray(1 + len + 15, 1 + len + 15 + 20));
  return { authCode, imei, softwareVersion };
}

/** Alarm flag bits from JT/T 808 table 24 (subset most relevant for fleets). */
const ALARM_BITS: Record<number, string> = {
  0: 'SOS / pánico',
  1: 'Exceso de velocidad',
  2: 'Fatiga de conducción',
  3: 'Advertencia de peligro',
  4: 'Falla del módulo GNSS',
  5: 'Antena GNSS desconectada',
  6: 'Antena GNSS en corto',
  7: 'Bajo voltaje de alimentación',
  8: 'Alimentación principal desconectada',
  11: 'Falla de cámara',
  18: 'Tiempo de manejo excedido',
  19: 'Estacionamiento prolongado',
  20: 'Entrada/salida de zona',
  21: 'Entrada/salida de ruta',
  27: 'Encendido ilegal',
  28: 'Desplazamiento ilegal',
  29: 'Colisión',
  30: 'Volcadura',
};

export interface AdditionalItem {
  id: number;
  length: number;
  hex: string;
  /** Decoded value for well-known items. */
  value?: number | string;
  label?: string;
}

export interface LocationReport {
  alarmFlags: number;
  alarms: string[];
  statusFlags: number;
  accOn: boolean;
  positioned: boolean;
  latitude: number;
  longitude: number;
  altitudeM: number;
  speedKmh: number;
  directionDeg: number;
  /** Raw BCD time YYMMDDhhmmss as reported by the device. */
  timeRaw: string;
  /** ISO time interpreting the device clock as GMT+8 (the standard's default; many units are configurable). */
  timeIsoAssumingGmt8: string;
  additional: AdditionalItem[];
}

function decodeAdditional(id: number, value: Buffer): Pick<AdditionalItem, 'value' | 'label'> {
  switch (id) {
    case 0x01:
      return { label: 'Odómetro (km)', value: value.readUInt32BE(0) / 10 };
    case 0x02:
      return { label: 'Combustible (L)', value: value.readUInt16BE(0) / 10 };
    case 0x03:
      return { label: 'Velocidad tacógrafo (km/h)', value: value.readUInt16BE(0) / 10 };
    case 0x30:
      return { label: 'Señal celular (CSQ)', value: value[0] };
    case 0x31:
      return { label: 'Satélites GNSS', value: value[0] };
    case 0x64:
      return { label: 'Alarma ADAS (extensión JT/T 1078)' };
    case 0x65:
      return { label: 'Alarma DMS (extensión JT/T 1078)' };
    case 0x66:
      return { label: 'Alarma de presión de llantas' };
    case 0x67:
      return { label: 'Alarma de punto ciego (BSD)' };
    default:
      return {};
  }
}

export function parseLocation(body: Buffer): LocationReport {
  if (body.length < 28) throw new Error(`Cuerpo 0x0200 demasiado corto (${body.length} bytes)`);
  const alarmFlags = body.readUInt32BE(0);
  const statusFlags = body.readUInt32BE(4);
  const south = Boolean(statusFlags & (1 << 2));
  const west = Boolean(statusFlags & (1 << 3));
  const latitude = (body.readUInt32BE(8) / 1e6) * (south ? -1 : 1);
  const longitude = (body.readUInt32BE(12) / 1e6) * (west ? -1 : 1);
  const altitudeM = body.readUInt16BE(16);
  const speedKmh = body.readUInt16BE(18) / 10;
  const directionDeg = body.readUInt16BE(20);
  const timeRaw = bcdToString(body.subarray(22, 28));

  const [yy, mm, dd, hh, mi, ss] = timeRaw.match(/../g)!.map(Number);
  const timeIsoAssumingGmt8 = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh - 8, mi, ss)).toISOString();

  const additional: AdditionalItem[] = [];
  let o = 28;
  while (o + 2 <= body.length) {
    const id = body[o];
    const length = body[o + 1];
    const value = body.subarray(o + 2, o + 2 + length);
    if (value.length < length) break;
    let decoded: Pick<AdditionalItem, 'value' | 'label'> = {};
    try {
      decoded = decodeAdditional(id, value);
    } catch {
      decoded = {};
    }
    additional.push({ id, length, hex: value.toString('hex'), ...decoded });
    o += 2 + length;
  }

  const alarms = Object.entries(ALARM_BITS)
    .filter(([bit]) => alarmFlags & (1 << Number(bit)))
    .map(([, name]) => name);

  return {
    alarmFlags,
    alarms,
    statusFlags,
    accOn: Boolean(statusFlags & 1),
    positioned: Boolean(statusFlags & 2),
    latitude,
    longitude,
    altitudeM,
    speedKmh,
    directionDeg,
    timeRaw,
    timeIsoAssumingGmt8,
    additional,
  };
}

export interface LocationBatch {
  type: 'normal' | 'zona_ciega';
  reports: LocationReport[];
}

export function parseLocationBatch(body: Buffer): LocationBatch {
  const count = body.readUInt16BE(0);
  const type = body[2] === 1 ? 'zona_ciega' : 'normal';
  const reports: LocationReport[] = [];
  let o = 3;
  for (let i = 0; i < count && o + 2 <= body.length; i++) {
    const len = body.readUInt16BE(o);
    reports.push(parseLocation(body.subarray(o + 2, o + 2 + len)));
    o += 2 + len;
  }
  return { type, reports };
}

// ---- Platform → terminal ---------------------------------------------------

export const RESULT = { OK: 0, FAIL: 1, MESSAGE_ERROR: 2, UNSUPPORTED: 3, ALARM_ACK: 4 } as const;

export function buildGeneralResponse(replySerial: number, replyMsgId: number, result: number = RESULT.OK): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt16BE(replySerial, 0);
  b.writeUInt16BE(replyMsgId, 2);
  b[4] = result;
  return b;
}

/** result: 0 ok, 1 vehicle already registered, 2 vehicle not in DB, 3 terminal already registered, 4 terminal not in DB. */
export function buildRegisterResponse(replySerial: number, result: number, authCode: string): Buffer {
  const head = Buffer.alloc(3);
  head.writeUInt16BE(replySerial, 0);
  head[2] = result;
  return result === 0 ? Buffer.concat([head, Buffer.from(authCode, 'ascii')]) : head;
}

// ---- Builders for the simulator and tests ------------------------------------

function fixed(text: string, len: number): Buffer {
  const b = Buffer.alloc(len);
  b.write(text.slice(0, len), 'ascii');
  return b;
}

export function buildRegisterBody(r: RegisterBody, version: ProtocolVersion): Buffer {
  const [mLen, modelLen, idLen] = version === '2019' ? [11, 30, 30] : [5, 20, 7];
  const head = Buffer.alloc(4);
  head.writeUInt16BE(r.provinceId, 0);
  head.writeUInt16BE(r.cityId, 2);
  return Buffer.concat([
    head,
    fixed(r.manufacturerId, mLen),
    fixed(r.terminalModel, modelLen),
    fixed(r.terminalId, idLen),
    Buffer.from([r.plateColor]),
    Buffer.from(r.plate, 'ascii'),
  ]);
}

export function buildAuthBody(a: AuthBody, version: ProtocolVersion): Buffer {
  const code = Buffer.from(a.authCode, 'ascii');
  if (version === '2013') return code;
  return Buffer.concat([Buffer.from([code.length]), code, fixed(a.imei ?? '', 15), fixed(a.softwareVersion ?? '', 20)]);
}

export interface LocationInput {
  alarmFlags?: number;
  accOn?: boolean;
  latitude: number;
  longitude: number;
  altitudeM?: number;
  speedKmh: number;
  directionDeg?: number;
  /** Date to encode; written as GMT+8 per the standard. */
  time?: Date;
  additional?: Array<{ id: number; value: Buffer }>;
}

export function buildLocationBody(l: LocationInput): Buffer {
  const b = Buffer.alloc(28);
  let status = 0;
  if (l.accOn ?? true) status |= 1;
  status |= 2; // positioned
  if (l.latitude < 0) status |= 1 << 2;
  if (l.longitude < 0) status |= 1 << 3;
  b.writeUInt32BE(l.alarmFlags ?? 0, 0);
  b.writeUInt32BE(status >>> 0, 4);
  b.writeUInt32BE(Math.round(Math.abs(l.latitude) * 1e6), 8);
  b.writeUInt32BE(Math.round(Math.abs(l.longitude) * 1e6), 12);
  b.writeUInt16BE(l.altitudeM ?? 0, 16);
  b.writeUInt16BE(Math.round(l.speedKmh * 10), 18);
  b.writeUInt16BE(l.directionDeg ?? 0, 20);
  const t = new Date((l.time ?? new Date()).getTime() + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const bcd = `${p(t.getUTCFullYear() % 100)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
  stringToBcd(bcd, 6).copy(b, 22);
  const extras = (l.additional ?? []).map(({ id, value }) => Buffer.concat([Buffer.from([id, value.length]), value]));
  return Buffer.concat([b, ...extras]);
}
