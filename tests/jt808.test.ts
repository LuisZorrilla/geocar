import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, encodeFrame, escape, FrameError, FrameSplitter, unescape, xorChecksum } from '../gateway/jt808/codec.ts';
import { buildLocationBody, buildRegisterBody, MSG, parseLocation, parseRegister } from '../gateway/jt808/messages.ts';
import { startGateway } from '../gateway/server.ts';
import { simulate } from '../gateway/simulator.ts';

const inner = (frame: Buffer) => frame.subarray(1, frame.length - 1);

describe('JT808 codec', () => {
  test('escape / unescape de 0x7E y 0x7D', () => {
    const data = Buffer.from([0x30, 0x7e, 0x08, 0x7d, 0x55]);
    const escaped = escape(data);
    assert.deepEqual([...escaped], [0x30, 0x7d, 0x02, 0x08, 0x7d, 0x01, 0x55]);
    assert.deepEqual(unescape(escaped), data);
  });

  test('checksum XOR', () => {
    assert.equal(xorChecksum(Buffer.from([0x01, 0x02, 0x04])), 0x07);
  });

  test('trama de referencia del estándar (heartbeat 2013)', () => {
    // 7E | 0002 0000 013800138000 0001 | checksum | 7E
    // checksum = XOR(00 02 00 00 01 38 00 13 80 00 00 01) = 0xA9 (verificado a mano)
    const frame = encodeFrame({ msgId: 0x0002, phone: '013800138000', serial: 1 });
    assert.equal(frame.toString('hex'), '7e000200000138001380000001' + 'a9' + '7e');
    const decoded = decodeFrame(inner(frame));
    assert.equal(decoded.header.msgId, 0x0002);
    assert.equal(decoded.header.phone, '013800138000');
    assert.equal(decoded.header.serial, 1);
    assert.equal(decoded.header.version, '2013');
  });

  test('ida y vuelta 2019 con cuerpo que contiene bytes a escapar', () => {
    const body = Buffer.from([0x7e, 0x7d, 0x00, 0x7e]);
    const frame = encodeFrame({ msgId: 0x0200, phone: '00000000013800138000', serial: 65535, body, version: '2019' });
    const decoded = decodeFrame(inner(frame));
    assert.equal(decoded.header.version, '2019');
    assert.equal(decoded.header.protocolVersionByte, 1);
    assert.equal(decoded.header.phone, '00000000013800138000');
    assert.equal(decoded.header.serial, 65535);
    assert.deepEqual(decoded.body, body);
  });

  test('checksum incorrecto se rechaza', () => {
    const frame = Buffer.from(inner(encodeFrame({ msgId: 0x0002, phone: '1', serial: 1 })));
    frame[frame.length - 1] ^= 0xff;
    assert.throws(() => decodeFrame(frame), FrameError);
  });

  test('el splitter maneja tramas partidas, pegadas y ruido', () => {
    const a = encodeFrame({ msgId: 0x0002, phone: '1', serial: 1 });
    const b = encodeFrame({ msgId: 0x0002, phone: '1', serial: 2 });
    const stream = Buffer.concat([Buffer.from([0x00, 0x11]), a, b]);
    const splitter = new FrameSplitter();
    const out = [...splitter.push(stream.subarray(0, 9)), ...splitter.push(stream.subarray(9))];
    assert.equal(out.length, 2);
    assert.equal(decodeFrame(out[0]).header.serial, 1);
    assert.equal(decodeFrame(out[1]).header.serial, 2);
  });
});

describe('JT808 mensajes', () => {
  test('posición 0x0200 con hemisferios oeste/norte, alarma y extras', () => {
    const time = new Date('2026-11-18T18:30:15Z');
    const body = buildLocationBody({
      latitude: 25.686614,
      longitude: -100.316116,
      speedKmh: 62.5,
      directionDeg: 270,
      altitudeM: 540,
      alarmFlags: (1 << 1) | (1 << 29),
      time,
      additional: [
        { id: 0x01, value: Buffer.from([0x00, 0x00, 0x30, 0x39]) },
        { id: 0x64, value: Buffer.from([0xaa, 0xbb]) },
      ],
    });
    const loc = parseLocation(body);
    assert.equal(loc.latitude, 25.686614);
    assert.equal(loc.longitude, -100.316116);
    assert.equal(loc.speedKmh, 62.5);
    assert.equal(loc.directionDeg, 270);
    assert.equal(loc.altitudeM, 540);
    assert.ok(loc.positioned && loc.accOn);
    assert.deepEqual(loc.alarms, ['Exceso de velocidad', 'Colisión']);
    assert.equal(loc.timeRaw, '261119023015'); // GMT+8
    assert.equal(loc.timeIsoAssumingGmt8, time.toISOString());
    assert.equal(loc.additional[0].value, 1234.5);
    assert.equal(loc.additional[1].hex, 'aabb');
  });

  test('registro 0x0100 en 2013 y 2019', () => {
    for (const version of ['2013', '2019'] as const) {
      const reg = { provinceId: 19, cityId: 39, manufacturerId: 'HOWEN', terminalModel: 'HERO-ME40', terminalId: 'T001', plateColor: 1, plate: 'NL-123' };
      assert.deepEqual(parseRegister(buildRegisterBody(reg, version), version), reg);
    }
  });
});

describe('JT808 listener + simulador', () => {
  for (const version of ['2013', '2019'] as const) {
    test(`flujo completo ${version}: registro, autenticación, heartbeat y posiciones`, async () => {
      const lines: string[] = [];
      const gw = await startGateway({ port: 0, host: '127.0.0.1', captureFile: null, log: (l) => lines.push(l) });
      try {
        const result = await simulate({ host: '127.0.0.1', port: gw.port, version, positions: 5, log: () => undefined });
        assert.ok(result.ok, JSON.stringify(result.steps, null, 2));
        assert.equal(result.steps.length, 8);
        assert.ok(lines.some((l) => l.includes('registro') && l.includes('HOWEN')));
        assert.equal(lines.filter((l) => l.startsWith('📍')).length, 5);
        assert.ok(lines.some((l) => l.includes('Exceso de velocidad')));
        assert.ok(!lines.some((l) => l.startsWith('❌')), lines.join('\n'));
      } finally {
        await gw.close();
      }
    });
  }

  test('una trama corrupta se registra y no tumba la conexión', async () => {
    const lines: string[] = [];
    const gw = await startGateway({ port: 0, host: '127.0.0.1', captureFile: null, log: (l) => lines.push(l) });
    try {
      const net = await import('net');
      const sock = net.connect(gw.port, '127.0.0.1');
      await new Promise((r) => sock.once('connect', r));
      const bad = Buffer.from(encodeFrame({ msgId: MSG.HEARTBEAT, phone: '1', serial: 1 }));
      bad[bad.length - 2] ^= 0xff; // break checksum
      sock.write(bad);
      sock.write(encodeFrame({ msgId: MSG.HEARTBEAT, phone: '1', serial: 2 }));
      const reply = await new Promise<Buffer>((r) => sock.once('data', r));
      const ack = decodeFrame(inner(reply));
      assert.equal(ack.header.msgId, MSG.PLATFORM_GENERAL_RESPONSE);
      assert.equal(ack.body.readUInt16BE(0), 2);
      assert.ok(lines.some((l) => l.includes('trama inválida')));
      sock.destroy();
    } finally {
      await gw.close();
    }
  });
});
