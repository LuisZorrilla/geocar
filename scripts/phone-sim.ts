/**
 * Simulates a driver's phone running Traccar Client.
 *
 *   npm run phone:sim -- --id GC-12345678                 (OsmAnd → Traccar :5055, como la app real)
 *   npm run phone:sim -- --id GC-12345678 --panel         (JSON de reenvío directo al panel, sin Traccar)
 *   opciones: [--host localhost] [--port 5055] [--url http://localhost:3000] [--count 10] [--interval 3] [--no-sos]
 *
 * The trip runs along Av. Libertador (San Juan). The battery drains to 12 % at the end (low battery alert)
 * and the last report carries the SOS alarm (critical alert), unless --no-sos.
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const id = arg('--id');
const toPanel = args.includes('--panel');
const host = arg('--host', 'localhost')!;
const port = Number(arg('--port', process.env.DEVICE_OSMAND_PORT || '5055'));
const panelUrl = arg('--url', `http://localhost:${process.env.PORT || 3000}`)!;
const count = Number(arg('--count', '10'));
const intervalSec = Number(arg('--interval', '3'));
const sos = !args.includes('--no-sos');
const token = process.env.INGEST_TOKEN;

if (!id) {
  console.error('Falta --id <identificador>. Lo ves en Configuración de Cámaras → Conexión Smartphone.');
  process.exit(1);
}
if (toPanel && !token) {
  console.error('INGEST_TOKEN no está definido en .env: la ingesta de Traccar está deshabilitada.');
  process.exit(1);
}

const START = { lat: -31.5352, lng: -68.572 };
const END = { lat: -31.5375, lng: -68.533 };

async function sendOsmand(p: { lat: number; lon: number; speedKnots: number; bearing: number; batt: number; accuracy: number; alarm?: string }) {
  const q = new URLSearchParams({
    id: id!,
    lat: String(p.lat),
    lon: String(p.lon),
    timestamp: String(Math.floor(Date.now() / 1000)),
    speed: String(p.speedKnots),
    bearing: String(p.bearing),
    batt: String(p.batt),
    accuracy: String(p.accuracy),
    charge: 'false',
  });
  if (p.alarm) q.set('alarm', p.alarm);
  const res = await fetch(`http://${host}:${port}/?${q}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Traccar respondió ${res.status}`);
  return 'Traccar OK';
}

async function sendPanel(p: { lat: number; lon: number; speedKnots: number; bearing: number; batt: number; accuracy: number; alarm?: string }) {
  const now = new Date().toISOString();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const device = { id: 1, uniqueId: id, name: `Celular ${id}` };
  const position = {
    deviceId: 1,
    protocol: 'osmand',
    serverTime: now,
    fixTime: now,
    valid: true,
    latitude: p.lat,
    longitude: p.lon,
    speed: p.speedKnots,
    course: p.bearing,
    accuracy: p.accuracy,
    attributes: { batteryLevel: p.batt, charge: false, motion: true, ...(p.alarm ? { alarm: p.alarm } : {}) },
  };
  const res = await fetch(`${panelUrl}/ingest/traccar/position`, { method: 'POST', headers, body: JSON.stringify({ position, device }) });
  const json = (await res.json().catch(() => ({}))) as { matched?: boolean; stale?: boolean };
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  if (p.alarm) {
    await fetch(`${panelUrl}/ingest/traccar/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: { type: 'alarm', eventTime: now, attributes: { alarm: p.alarm } }, position, device }),
    });
  }
  return json.matched ? (json.stale ? 'panel: ignorada (precisión o sin unidad)' : 'panel: aplicada') : 'panel: identificador sin asignar';
}

console.log(`Simulando el celular ${id} → ${toPanel ? panelUrl : `Traccar ${host}:${port} (OsmAnd)`}`);
for (let i = 0; i < count; i++) {
  const t = count === 1 ? 0 : i / (count - 1);
  const last = i === count - 1;
  const p = {
    lat: Number((START.lat + (END.lat - START.lat) * t).toFixed(6)),
    lon: Number((START.lng + (END.lng - START.lng) * t).toFixed(6)),
    speedKnots: 22 + (i % 3) * 3,
    bearing: 92,
    batt: Math.max(12, Math.round(64 - t * 52)),
    accuracy: 8 + (i % 4) * 3,
    alarm: last && sos ? 'sos' : undefined,
  };
  try {
    const r = toPanel ? await sendPanel(p) : await sendOsmand(p);
    console.log(`📱 ${i + 1}/${count} ${p.lat},${p.lon} · ${Math.round(p.speedKnots * 1.852)} km/h · batería ${p.batt} %${p.alarm ? ' · SOS' : ''} → ${r}`);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    break;
  }
  if (!last) await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
