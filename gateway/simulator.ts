/**
 * JT808 device simulator: register → authenticate → heartbeat → N positions,
 * checking every platform response. Used to test the listener without hardware.
 *
 *   npm run gateway:sim                       # 2013, localhost:7611
 *   npm run gateway:sim -- --v2019 --host 1.2.3.4 --port 7611
 */
import net from 'net';
import path from 'path';
import { pathToFileURL } from 'url';
import { decodeFrame, encodeFrame, FrameSplitter, type Frame, type ProtocolVersion } from './jt808/codec.ts';
import { buildAuthBody, buildLocationBody, buildRegisterBody, MSG } from './jt808/messages.ts';

export interface SimulationOptions {
  host: string;
  port: number;
  version: ProtocolVersion;
  phone?: string;
  positions?: number;
  log?: (line: string) => void;
}

export interface SimulationResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

/** Route along Av. Constitución, Monterrey (west → east). */
const ROUTE = [
  [25.6714, -100.3332],
  [25.6702, -100.3268],
  [25.6690, -100.3196],
  [25.6687, -100.3121],
  [25.6693, -100.3049],
  [25.6705, -100.2978],
];

export async function simulate(opts: SimulationOptions): Promise<SimulationResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const phone = opts.phone ?? (opts.version === '2019' ? '00000000013800138000' : '013800138000');
  const steps: SimulationResult['steps'] = [];
  const socket = net.connect(opts.port, opts.host);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });

  const splitter = new FrameSplitter();
  const inbox: Frame[] = [];
  let waiter: (() => void) | null = null;
  socket.on('data', (chunk) => {
    for (const f of splitter.push(chunk)) inbox.push(decodeFrame(f));
    waiter?.();
  });
  const nextFrame = (timeoutMs = 3000) =>
    new Promise<Frame>((resolve, reject) => {
      const take = () => {
        const f = inbox.shift();
        if (f) {
          clearTimeout(timer);
          waiter = null;
          resolve(f);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error('Sin respuesta de la plataforma'));
      }, timeoutMs);
      if (!take()) waiter = () => void take();
    });

  let serial = 1;
  const send = (msgId: number, body: Buffer) => {
    const s = serial++;
    socket.write(encodeFrame({ msgId, phone, serial: s, body, version: opts.version }));
    return s;
  };
  const expectAck = async (step: string, sentSerial: number, sentId: number) => {
    try {
      const f = await nextFrame();
      const ok =
        f.header.msgId === MSG.PLATFORM_GENERAL_RESPONSE &&
        f.body.readUInt16BE(0) === sentSerial &&
        f.body.readUInt16BE(2) === sentId &&
        f.body[4] === 0;
      steps.push({ step, ok, detail: ok ? '0x8001 OK' : `respuesta inesperada ${f.header.msgId.toString(16)} ${f.body.toString('hex')}` });
    } catch (err) {
      steps.push({ step, ok: false, detail: (err as Error).message });
    }
    log(`${steps.at(-1)!.ok ? '✅' : '❌'} ${step}: ${steps.at(-1)!.detail}`);
  };

  // 1. Register
  const regSerial = send(
    MSG.REGISTER,
    buildRegisterBody(
      { provinceId: 19, cityId: 39, manufacturerId: 'HOWEN', terminalModel: 'HERO-ME40-04', terminalId: 'SIM0001', plateColor: 1, plate: 'NL-123-SIM' },
      opts.version
    )
  );
  let authCode = '';
  try {
    const f = await nextFrame();
    const ok = f.header.msgId === MSG.REGISTER_RESPONSE && f.body.readUInt16BE(0) === regSerial && f.body[2] === 0;
    authCode = f.body.subarray(3).toString('ascii');
    steps.push({ step: 'Registro', ok, detail: ok ? `0x8100 código ${authCode}` : `respuesta inesperada ${f.body.toString('hex')}` });
  } catch (err) {
    steps.push({ step: 'Registro', ok: false, detail: (err as Error).message });
  }
  log(`${steps.at(-1)!.ok ? '✅' : '❌'} Registro: ${steps.at(-1)!.detail}`);

  // 2. Authenticate
  const authSerial = send(
    MSG.AUTH,
    buildAuthBody({ authCode, imei: '860000000000001', softwareVersion: 'SIM-1.0' }, opts.version)
  );
  await expectAck('Autenticación', authSerial, MSG.AUTH);

  // 3. Heartbeat
  await expectAck('Heartbeat', send(MSG.HEARTBEAT, Buffer.alloc(0)), MSG.HEARTBEAT);

  // 4. Positions
  const total = opts.positions ?? 5;
  for (let i = 0; i < total; i++) {
    const [lat, lng] = ROUTE[i % ROUTE.length];
    const body = buildLocationBody({
      latitude: lat,
      longitude: lng,
      speedKmh: 40 + i * 5.5,
      directionDeg: 90,
      altitudeM: 540,
      // Last position carries an overspeed alarm (bit 1) to exercise alarm decoding.
      alarmFlags: i === total - 1 ? 1 << 1 : 0,
      additional: [
        { id: 0x01, value: Buffer.from([0x00, 0x01, 0xe2, 0x40 + i]) }, // odometer
        { id: 0x31, value: Buffer.from([12]) }, // satellites
      ],
    });
    await expectAck(`Posición ${i + 1}/${total}`, send(MSG.LOCATION, body), MSG.LOCATION);
  }

  await new Promise<void>((resolve) => socket.end(() => resolve()));
  return { ok: steps.every((s) => s.ok), steps };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  simulate({
    host: arg('--host') ?? '127.0.0.1',
    port: Number(arg('--port') ?? process.env.JT808_PORT ?? 7611),
    version: args.includes('--v2019') ? '2019' : '2013',
    positions: Number(arg('--positions') ?? 5),
  })
    .then((r) => {
      console.log(r.ok ? '\nSimulación completa: todas las respuestas OK.' : '\nSimulación con errores.');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`No se pudo conectar al listener: ${err.message}`);
      process.exit(1);
    });
}
