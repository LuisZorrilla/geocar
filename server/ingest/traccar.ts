import crypto from 'crypto';
import express from 'express';
import { fleetStore } from '../store.ts';
import * as schemas from '../validation/schemas.ts';
import { extractObd } from './obd.ts';

/**
 * Traccar → platform ingest (diagram step 5: "Traccar reenvía a la API por HTTP JSON").
 *
 * Configure Traccar (traccar.xml) to forward here; see docs/TRACCAR.md:
 *   POST /ingest/traccar/position   { position, device }
 *   POST /ingest/traccar/event      { event, position?, device }
 *
 * Auth: shared secret INGEST_TOKEN sent as "Authorization: Bearer <token>"
 * (Traccar: forward.header / event.forward.header). Without INGEST_TOKEN the
 * endpoints are disabled (503).
 */
export const traccarIngestRouter = express.Router();

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

traccarIngestRouter.use((req, res, next) => {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Ingesta de Traccar deshabilitada: define INGEST_TOKEN en el servidor.' });
    return;
  }
  const auth = req.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!provided || !tokenMatches(provided, expected)) {
    res.status(401).json({ error: 'Token de ingesta inválido.' });
    return;
  }
  next();
});

/** Token check without side effects (used by `npm run traccar:check`). */
traccarIngestRouter.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/** Phone battery in % (Traccar Client sends batteryLevel; some versions batteryLevelPct). */
function batteryPercent(attrs: Record<string, unknown>): number | undefined {
  for (const key of ['batteryLevel', 'batteryLevelPct']) {
    const n = Number(attrs[key]);
    if (attrs[key] !== undefined && attrs[key] !== null && Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return undefined;
}

const issue = (err: { issues: Array<{ path: PropertyKey[]; message: string }> }) => {
  const first = err.issues[0];
  return `${first.path.map(String).join('.') || 'cuerpo'}: ${first.message}`;
};

traccarIngestRouter.post('/position', (req, res) => {
  const parsed = schemas.traccarPositionForward.safeParse(req.body ?? {});
  if (!parsed.success) {
    console.warn('[ingest] posición rechazada:', issue(parsed.error));
    res.status(400).json({ error: `Posición inválida. ${issue(parsed.error)}` });
    return;
  }
  const { position, device } = parsed.data;
  const attrs = (position.attributes ?? {}) as Record<string, unknown>;
  const result = fleetStore.ingestTraccarPosition({
    uniqueId: device.uniqueId,
    deviceName: device.name,
    positionId: position.id,
    latitude: position.latitude,
    longitude: position.longitude,
    speedKnots: position.speed,
    course: position.course,
    fixTime: position.fixTime,
    serverTime: position.serverTime,
    odometerMeters: position.attributes?.odometer ?? position.attributes?.totalDistance,
    ignition: position.attributes?.ignition,
    obd: extractObd(position.attributes as Record<string, unknown> | undefined),
    accuracyM: position.accuracy,
    batteryPct: batteryPercent(attrs),
    charging: typeof attrs.charge === 'boolean' ? attrs.charge : attrs.charge === 'true' ? true : attrs.charge === 'false' ? false : undefined,
  });
  if (process.env.INGEST_LOG === 'true') {
    console.log(
      `[ingest] posición ${device.uniqueId} id=${position.id ?? '-'} fix=${position.fixTime} ` +
        `${position.latitude},${position.longitude} → ${result.matched ? (result.stale ? 'ignorada (más vieja)' : 'aplicada') : 'sin asignar'}`
    );
    // Shows every attribute so the OBD keys a real device sends can be checked against TELTONIKA_IO.
    if (position.attributes) console.log(`[ingest] atributos ${device.uniqueId}: ${JSON.stringify(position.attributes)}`);
  }
  // 200 even when unmatched: Traccar would otherwise retry forever. The device shows up as "sin asignar".
  res.json({ ok: true, ...result });
});

traccarIngestRouter.post('/event', (req, res) => {
  const parsed = schemas.traccarEventForward.safeParse(req.body ?? {});
  if (!parsed.success) {
    console.warn('[ingest] evento rechazado:', issue(parsed.error));
    res.status(400).json({ error: `Evento inválido. ${issue(parsed.error)}` });
    return;
  }
  const { event, position, device } = parsed.data;
  const result = fleetStore.ingestTraccarEvent({
    uniqueId: device.uniqueId,
    deviceName: device.name,
    type: event.type,
    alarm: event.attributes?.alarm ?? position?.attributes?.alarm,
    eventTime: event.eventTime ?? position?.fixTime ?? new Date().toISOString(),
    latitude: position?.latitude,
    longitude: position?.longitude,
    speedKnots: position?.speed,
    result: event.attributes?.result,
  });
  res.json({ ok: true, ...result });
});
