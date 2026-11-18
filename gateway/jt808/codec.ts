/**
 * JT/T 808 frame codec (2013 and 2019 revisions).
 *
 * Frame on the wire:  0x7E | header | body | checksum | 0x7E
 * Inside the delimiters 0x7E is escaped as 0x7D 0x02 and 0x7D as 0x7D 0x01.
 * Checksum = XOR of every byte of header + body (before escaping).
 */

export const FLAG = 0x7e;
const ESC = 0x7d;

export type ProtocolVersion = '2013' | '2019';

export interface FrameHeader {
  msgId: number;
  bodyLength: number;
  encryption: number;
  isSubpackage: boolean;
  version: ProtocolVersion;
  /** 2019 only: protocol version byte (1 = 2019). */
  protocolVersionByte?: number;
  /** Terminal phone number / id as BCD digits (12 digits in 2013, 20 in 2019). */
  phone: string;
  serial: number;
  totalPackages?: number;
  packageIndex?: number;
}

export interface Frame {
  header: FrameHeader;
  body: Buffer;
  /** Unescaped header+body+checksum, for logging. */
  raw: Buffer;
}

export class FrameError extends Error {}

export function escape(data: Buffer): Buffer {
  const out: number[] = [];
  for (const b of data) {
    if (b === FLAG) out.push(ESC, 0x02);
    else if (b === ESC) out.push(ESC, 0x01);
    else out.push(b);
  }
  return Buffer.from(out);
}

export function unescape(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === ESC) {
      const next = data[i + 1];
      if (next === 0x02) out.push(FLAG);
      else if (next === 0x01) out.push(ESC);
      else throw new FrameError(`Secuencia de escape inválida 0x7D 0x${(next ?? 0).toString(16)}`);
      i++;
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}

export function xorChecksum(data: Buffer): number {
  let c = 0;
  for (const b of data) c ^= b;
  return c;
}

export function bcdToString(buf: Buffer): string {
  return [...buf].map((b) => (b >> 4).toString(16) + (b & 0x0f).toString(16)).join('');
}

export function stringToBcd(digits: string, bytes: number): Buffer {
  const padded = digits.padStart(bytes * 2, '0').slice(-bytes * 2);
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = (parseInt(padded[i * 2], 16) << 4) | parseInt(padded[i * 2 + 1], 16);
  }
  return out;
}

/** Decodes one frame: `data` is the content between two 0x7E delimiters (still escaped). */
export function decodeFrame(data: Buffer): Frame {
  const raw = unescape(data);
  if (raw.length < 13) throw new FrameError(`Trama demasiado corta (${raw.length} bytes)`);
  const content = raw.subarray(0, raw.length - 1);
  const checksum = raw[raw.length - 1];
  const expected = xorChecksum(content);
  if (checksum !== expected) {
    throw new FrameError(`Checksum inválido: recibido 0x${checksum.toString(16)}, esperado 0x${expected.toString(16)}`);
  }

  const msgId = content.readUInt16BE(0);
  const props = content.readUInt16BE(2);
  const bodyLength = props & 0x03ff;
  const encryption = (props >> 10) & 0x07;
  const isSubpackage = Boolean(props & 0x2000);
  const is2019 = Boolean(props & 0x4000);

  let offset = 4;
  let protocolVersionByte: number | undefined;
  if (is2019) {
    protocolVersionByte = content[offset];
    offset += 1;
  }
  const phoneLen = is2019 ? 10 : 6;
  const phone = bcdToString(content.subarray(offset, offset + phoneLen));
  offset += phoneLen;
  const serial = content.readUInt16BE(offset);
  offset += 2;

  let totalPackages: number | undefined;
  let packageIndex: number | undefined;
  if (isSubpackage) {
    totalPackages = content.readUInt16BE(offset);
    packageIndex = content.readUInt16BE(offset + 2);
    offset += 4;
  }

  const body = content.subarray(offset);
  if (body.length !== bodyLength) {
    throw new FrameError(`Longitud de cuerpo inconsistente: cabecera ${bodyLength}, real ${body.length}`);
  }

  return {
    header: {
      msgId,
      bodyLength,
      encryption,
      isSubpackage,
      version: is2019 ? '2019' : '2013',
      protocolVersionByte,
      phone,
      serial,
      totalPackages,
      packageIndex,
    },
    body,
    raw,
  };
}

export interface EncodeOptions {
  msgId: number;
  phone: string;
  serial: number;
  body?: Buffer;
  version?: ProtocolVersion;
}

/** Builds a complete frame including the 0x7E delimiters. */
export function encodeFrame({ msgId, phone, serial, body = Buffer.alloc(0), version = '2013' }: EncodeOptions): Buffer {
  if (body.length > 0x03ff) throw new FrameError('Cuerpo mayor a 1023 bytes: requiere subpaquetes');
  const is2019 = version === '2019';
  const props = (body.length & 0x03ff) | (is2019 ? 0x4000 : 0);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(msgId, 0);
  head.writeUInt16BE(props, 2);
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial & 0xffff, 0);
  const parts: Buffer[] = [head];
  if (is2019) parts.push(Buffer.from([0x01]));
  parts.push(stringToBcd(phone, is2019 ? 10 : 6), serialBuf, body);
  const content = Buffer.concat(parts);
  const withChecksum = Buffer.concat([content, Buffer.from([xorChecksum(content)])]);
  return Buffer.concat([Buffer.from([FLAG]), escape(withChecksum), Buffer.from([FLAG])]);
}

/**
 * Splits a TCP stream into frames. TCP may deliver half a frame or several
 * frames at once, so bytes are accumulated until a closing 0x7E arrives.
 */
export class FrameSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private static readonly MAX_BUFFER = 64 * 1024;

  /** Feed bytes; returns the escaped contents of every complete frame found. */
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffer.indexOf(FLAG);
      if (start === -1) {
        // No frame start at all: discard noise.
        this.buffer = Buffer.alloc(0);
        break;
      }
      const end = this.buffer.indexOf(FLAG, start + 1);
      if (end === -1) {
        // Incomplete frame: keep it (from its opening flag) for the next chunk.
        this.buffer = this.buffer.subarray(start);
        break;
      }
      if (end === start + 1) {
        // "7E 7E": a closing flag followed by an opening one (or a lost frame). Restart at the second.
        this.buffer = this.buffer.subarray(end);
        continue;
      }
      frames.push(Buffer.from(this.buffer.subarray(start + 1, end)));
      this.buffer = this.buffer.subarray(end + 1);
    }
    if (this.buffer.length > FrameSplitter.MAX_BUFFER) {
      // Garbage without a closing flag: drop it rather than grow forever.
      this.buffer = Buffer.alloc(0);
    }
    return frames;
  }
}
