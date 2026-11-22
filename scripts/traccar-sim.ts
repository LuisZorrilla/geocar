/**
 * Simulates Traccar forwarding positions and an alarm to the panel, so the whole
 * camera → Traccar → panel path can be seen on the map without hardware.
 *
 *   npm run traccar:sim -- --terminal <ID de terminal> [--url http://localhost:3000] [--count 12] [--interval 3]
 *   npm run traccar:sim -- --terminal <IMEI del OBD-II> --obd     (Teltonika FMC003: datos de motor y un DTC)
 *
 * With --obd the positions carry OBD-II attributes (rpm, coolantTemp, fuelLevel, obdOdometer, power, vin)
 * and the trouble code P0420 appears in the middle of the trip and is cleared in the last report,
 * where the battery drops to 11.6 V (health «Atención»).
 * Uses INGEST_TOKEN from .env. Payloads follow Traccar's JSON forwarding format
 * ({ position, device } / { event, position, device }); speed is in knots, as Traccar sends it.
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const terminal = arg('--terminal');
const baseUrl = arg('--url', `http://localhost:${process.env.PORT || 3000}`)!;
const count = Number(arg('--count', '12'));
const intervalSec = Number(arg('--interval', '3'));
const token = process.env.INGEST_TOKEN;
const obd = args.includes('--obd');

if (!terminal) {
  console.error('Falta --terminal <ID>. Lo ves en Configuración de Cámaras → Conexión.');
  process.exit(1);
}
if (!token) {
  console.error('INGEST_TOKEN no está definido en .env: la ingesta de Traccar está deshabilitada.');
  process.exit(1);
}

/** Av. Libertador General San Martín, San Juan (west → east). */
const START = { lat: -31.5352, lng: -68.5720 };
const END = { lat: -31.5375, lng: -68.5330 };

async function post(path: string, body: unknown) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json as { matched?: boolean; alertId?: string };
}

const device = { id: 1, uniqueId: terminal, name: `Simulador ${terminal}` };

for (let i = 0; i < count; i++) {
  const t = count === 1 ? 0 : i / (count - 1);
  const now = new Date().toISOString();
  const position = {
    deviceId: 1,
    protocol: obd ? 'teltonika' : 'jt808',
    serverTime: now,
    deviceTime: now,
    fixTime: now,
    valid: true,
    latitude: START.lat + (END.lat - START.lat) * t,
    longitude: START.lng + (END.lng - START.lng) * t,
    altitude: 640,
    speed: 25 + (i % 4) * 3, // knots (≈46–63 km/h)
    course: 92,
    attributes: {
      ignition: true,
      sat: 12,
      ...(obd
        ? {
            rpm: i === count - 1 ? 0 : 1800 + (i % 5) * 120,
            coolantTemp: 88 + (i % 3),
            fuelLevel: Math.max(5, 64 - i),
            obdOdometer: (48210 + i * 0.4) * 1000, // meters
            // Engine off at the end with a weak battery: the panel shows «Atención».
            power: i === count - 1 ? 11.6 : 13.9,
            vin: '8AJFB8CD1K1234567',
            // P0420 from a third of the trip on; the last report has no active codes.
            dtcs: i === count - 1 ? '' : i >= Math.floor(count / 3) ? 'P0420' : '',
          }
        : {}),
    },
  };
  const r = await post('/ingest/traccar/position', { position, device });
  if (obd) console.log(`   🔧 RPM ${position.attributes.rpm} · ${position.attributes.coolantTemp} °C · ${position.attributes.power} V · DTC ${position.attributes.dtcs || 'ninguno'}`);
  console.log(
    `📍 ${i + 1}/${count} lat ${position.latitude.toFixed(5)} lon ${position.longitude.toFixed(5)} ` +
      `${Math.round(position.speed * 1.852)} km/h → ${r.matched ? 'asignado a una unidad' : 'SIN ASIGNAR (ver Conexión)'}`
  );
  if (i < count - 1) await new Promise((res) => setTimeout(res, intervalSec * 1000));
}

const now = new Date().toISOString();
const r = await post('/ingest/traccar/event', {
  event: { type: 'alarm', eventTime: now, attributes: { alarm: 'sos' } },
  position: { latitude: END.lat, longitude: END.lng, fixTime: now, speed: 0, attributes: { alarm: 'sos' } },
  device,
});
console.log(r.alertId ? `🚨 Alarma SOS enviada → alerta ${r.alertId}` : '🚨 Alarma SOS enviada (equipo sin asignar: no se creó alerta)');
