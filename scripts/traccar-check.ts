/**
 * Read-only diagnosis of the pilot setup: panel ↔ Traccar ↔ internet.
 *
 *   npm run traccar:check
 *
 * Exits with code 1 if any required check fails.
 */
import 'dotenv/config';
import net from 'net';

const panelUrl = `http://localhost:${process.env.PORT || 3000}`;
const traccarWeb = process.env.TRACCAR_WEB_URL || 'http://localhost:8082';
const token = process.env.INGEST_TOKEN;
const publicHost = process.env.DEVICE_SERVER_HOST?.trim();
const publicJt808 = Number(process.env.DEVICE_JT808_PORT || 5015);

let failures = 0;
const ok = (msg: string) => console.log(`✅ ${msg}`);
const fail = (msg: string, fix: string) => {
  failures++;
  console.log(`❌ ${msg}\n   → ${fix}`);
};
const warn = (msg: string, fix: string) => console.log(`⚠️  ${msg}\n   → ${fix}`);

function tcp(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r: boolean) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function http(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
}

console.log('Diagnóstico del piloto: panel ↔ Traccar ↔ internet\n');

// 1. Panel
const panel = await http(panelUrl);
if (panel?.ok) ok(`Panel responde en ${panelUrl}`);
else fail(`El panel no responde en ${panelUrl}`, 'Arráncalo con: npm run dev');

// 2. Ingest
if (!token) {
  fail('INGEST_TOKEN no está definido en .env', 'Genera uno (ver docs/TRACCAR.md) y reinicia el panel.');
} else if (panel?.ok) {
  const h = await http(`${panelUrl}/ingest/traccar/health`, { headers: { Authorization: `Bearer ${token}` } });
  if (h?.ok) ok('Ingesta del panel activa y el token de .env es válido');
  else if (h?.status === 503) fail('La ingesta está deshabilitada en el panel en ejecución', 'Reinicia el panel para que tome INGEST_TOKEN de .env.');
  else if (h?.status === 401) fail('El panel rechaza el token de .env', 'Reinicia el panel: está corriendo con otro INGEST_TOKEN.');
  else fail(`Respuesta inesperada de la ingesta (${h?.status ?? 'sin respuesta'})`, 'Revisa los logs del panel.');
}

// 3-4. Traccar
const web = await http(traccarWeb);
if (web) ok(`Traccar (interfaz web) responde en ${traccarWeb}`);
else fail(`Traccar no responde en ${traccarWeb}`, 'Instálalo (docs/PILOTO-LOCAL.md, paso 2) y verifica que el servicio "Traccar" esté iniciado.');

for (const [port, what] of [
  [5015, 'JT/T 808 (posiciones)'],
  [5263, 'JT/T 1078 (video)'],
  [5027, 'Teltonika (OBD-II FMC003)'],
  [5055, 'OsmAnd (celulares con Traccar Client)'],
] as const) {
  if (await tcp('127.0.0.1', port)) ok(`Traccar escucha en ${port} · ${what}`);
  else
    fail(
      `Nada escucha en el puerto ${port} · ${what}`,
      port === 5015
        ? 'Revisa que el servicio Traccar esté iniciado; jt808 usa 5015 por defecto (o jt808.port en traccar.xml).'
        : port === 5027
          ? 'Revisa que el servicio Traccar esté iniciado; teltonika usa 5027 por defecto (o teltonika.port en traccar.xml).'
          : port === 5055
            ? 'Revisa que el servicio Traccar esté iniciado; osmand usa 5055 por defecto (o osmand.port en traccar.xml).'
          : 'Revisa que el servicio Traccar esté iniciado; jt1078 usa 5263 por defecto (o jt1078.port en traccar.xml).'
    );
}

// 5. Reachability from the internet (best effort)
if (!publicHost) {
  warn(
    'DEVICE_SERVER_HOST está vacío: el panel no sabe a qué dirección deben conectarse las cámaras',
    'Pon en .env el host público del túnel o tu dominio/IP (docs/PILOTO-LOCAL.md, paso 4) y reinicia el panel.'
  );
} else if (await tcp(publicHost, publicJt808, 6000)) {
  ok(`${publicHost}:${publicJt808} acepta conexiones (desde esta PC)`);
  console.log('   La prueba definitiva es desde la cámara: algunos routers no permiten conectarse a su propia IP pública.');
} else {
  fail(
    `No se puede conectar a ${publicHost}:${publicJt808}`,
    'Revisa que el túnel siga activo (el host/puerto cambia al reiniciarlo) o el reenvío de puertos del router y el Firewall de Windows.'
  );
}

console.log(failures ? `\n${failures} problema(s) por resolver.` : '\nTodo listo para conectar la cámara.');
// exitCode instead of process.exit(): exiting while fetch sockets close crashes libuv on Windows.
process.exitCode = failures ? 1 : 0;
