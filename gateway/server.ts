/**
 * JT808 test listener (roadmap phase 0).
 *
 * Accepts dashcam/GPS connections, answers registration, authentication,
 * heartbeats and positions so the device keeps talking, prints a readable
 * summary and stores every frame (raw hex + decoded) in a JSONL capture file
 * to compare against the manufacturer's protocol manual.
 *
 * It does NOT write to the database yet; that is phase 2 (production gateway).
 *
 *   npm run gateway            # listens on JT808_PORT (default 7611)
 */
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { decodeFrame, encodeFrame, FrameError, FrameSplitter, type Frame } from './jt808/codec.ts';
import {
  buildGeneralResponse,
  buildRegisterResponse,
  MSG,
  MSG_NAMES,
  parseAuth,
  parseLocation,
  parseLocationBatch,
  parseRegister,
  RESULT,
} from './jt808/messages.ts';

export interface GatewayOptions {
  port: number;
  host?: string;
  captureFile?: string | null;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface GatewayHandle {
  port: number;
  close: () => Promise<void>;
}

const hex = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

export async function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const authCodes = new Map<string, string>();
  let capture: fs.WriteStream | null = null;
  if (opts.captureFile) {
    fs.mkdirSync(path.dirname(opts.captureFile), { recursive: true });
    capture = fs.createWriteStream(opts.captureFile, { flags: 'a' });
  }
  const record = (entry: Record<string, unknown>) => {
    capture?.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    const splitter = new FrameSplitter();
    let platformSerial = 0;
    let phone = '';
    log(`🔌 Conexión ${remote}`);
    socket.setTimeout(opts.idleTimeoutMs ?? 180_000);

    // Replies are queued and sent after the incoming frame is recorded, so the capture reads in order.
    let pendingReplies: Array<{ msgId: number; out: Buffer; phone: string }> = [];
    const reply = (frame: Frame, msgId: number, body: Buffer) => {
      const out = encodeFrame({
        msgId,
        phone: frame.header.phone,
        serial: platformSerial++ & 0xffff,
        body,
        version: frame.header.version,
      });
      pendingReplies.push({ msgId, out, phone: frame.header.phone });
    };
    const flushReplies = () => {
      for (const r of pendingReplies) {
        socket.write(r.out);
        record({ dir: 'out', remote, phone: r.phone, msgId: hex(r.msgId), hex: r.out.toString('hex') });
      }
      pendingReplies = [];
    };
    const ack = (frame: Frame, result: number = RESULT.OK) =>
      reply(frame, MSG.PLATFORM_GENERAL_RESPONSE, buildGeneralResponse(frame.header.serial, frame.header.msgId, result));

    const handle = (frame: Frame) => {
      const { header, body } = frame;
      phone = header.phone;
      const name = MSG_NAMES[header.msgId] ?? 'Desconocido';
      let decoded: unknown = null;

      switch (header.msgId) {
        case MSG.REGISTER: {
          const reg = parseRegister(body, header.version);
          decoded = reg;
          const code = crypto.randomBytes(6).toString('hex').toUpperCase();
          authCodes.set(header.phone, code);
          log(`📝 ${header.phone} registro · fabricante ${reg.manufacturerId} · modelo ${reg.terminalModel} · id ${reg.terminalId} · placa ${reg.plate || '-'}`);
          reply(frame, MSG.REGISTER_RESPONSE, buildRegisterResponse(header.serial, 0, code));
          break;
        }
        case MSG.AUTH: {
          const auth = parseAuth(body, header.version);
          decoded = auth;
          const known = authCodes.get(header.phone);
          // Dev listener: accept unknown codes (devices re-authenticate with a code from an earlier session).
          const note = known ? (known === auth.authCode ? 'código válido' : 'código distinto (aceptado en modo prueba)') : 'código no emitido aquí (aceptado en modo prueba)';
          log(`🔑 ${header.phone} autenticación · ${note}${auth.imei ? ` · IMEI ${auth.imei}` : ''}`);
          ack(frame);
          break;
        }
        case MSG.LOCATION: {
          const loc = parseLocation(body);
          decoded = loc;
          log(
            `📍 ${header.phone} lat ${loc.latitude.toFixed(6)} lon ${loc.longitude.toFixed(6)} ${loc.speedKmh} km/h rumbo ${loc.directionDeg}°` +
              `${loc.positioned ? '' : ' (sin fix)'}${loc.alarms.length ? ` ⚠️ ${loc.alarms.join(', ')}` : ''}`
          );
          ack(frame);
          break;
        }
        case MSG.LOCATION_BATCH: {
          const batch = parseLocationBatch(body);
          decoded = batch;
          log(`📦 ${header.phone} lote de ${batch.reports.length} posiciones (${batch.type})`);
          ack(frame);
          break;
        }
        case MSG.HEARTBEAT:
          log(`💓 ${header.phone} heartbeat`);
          ack(frame);
          break;
        case MSG.UNREGISTER:
          authCodes.delete(header.phone);
          log(`👋 ${header.phone} baja del terminal`);
          ack(frame);
          break;
        case MSG.TERMINAL_GENERAL_RESPONSE:
          // The terminal acknowledging one of our commands; no reply expected.
          log(`↩️  ${header.phone} respuesta general del terminal`);
          break;
        default:
          log(`❔ ${header.phone} ${hex(header.msgId)} ${name} (${body.length} bytes) — guardado en captura`);
          ack(frame);
      }

      record({
        dir: 'in',
        remote,
        phone: header.phone,
        version: header.version,
        msgId: hex(header.msgId),
        name,
        serial: header.serial,
        hex: frame.raw.toString('hex'),
        decoded,
      });
      flushReplies();
    };

    socket.on('data', (chunk) => {
      for (const escaped of splitter.push(chunk)) {
        try {
          handle(decodeFrame(escaped));
        } catch (err) {
          const reason = err instanceof FrameError ? err.message : String(err);
          log(`❌ ${remote} trama inválida: ${reason}`);
          record({ dir: 'in', remote, error: reason, hex: escaped.toString('hex') });
        }
      }
    });
    socket.on('timeout', () => {
      log(`⏱️  ${phone || remote} sin actividad, cerrando conexión`);
      socket.end();
    });
    socket.on('error', (err) => log(`⚠️  ${phone || remote} error de socket: ${err.message}`));
    socket.on('close', () => log(`🔌 ${phone || remote} desconectado`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          capture?.end();
          resolve();
        });
        // Drop open device connections so close() completes.
        for (const s of sockets) s.destroy();
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.JT808_PORT || 7611);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const captureFile = path.join(root, '.data', 'jt808-capture.jsonl');
  startGateway({ port, captureFile })
    .then((g) => {
      console.log(`Listener JT808 escuchando en TCP ${g.port}`);
      console.log(`Captura de tramas: ${captureFile}`);
    })
    .catch((err) => {
      console.error('No se pudo iniciar el listener JT808:', err.message);
      process.exit(1);
    });
}
