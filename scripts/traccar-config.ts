/**
 * Prints the traccar.xml block that connects Traccar to this panel, with the real
 * INGEST_TOKEN from .env, so the secret is never copied by hand.
 *
 *   npm run traccar:config                     # panel on the same machine (pilot on a PC)
 *   npm run traccar:config -- --panel-url http://api:3000   # Docker network on the VPS
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const i = args.indexOf('--panel-url');
const panelUrl = (i >= 0 ? args[i + 1] : `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const token = process.env.INGEST_TOKEN;

if (!token) {
  console.error('INGEST_TOKEN no está definido en .env, así que la ingesta del panel está deshabilitada.');
  console.error('Genera uno y agrégalo a .env:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}

const xml = `
    <!-- ===== GeoCar: reenvío de Traccar al panel ===== -->
    <entry key='forward.url'>${panelUrl}/ingest/traccar/position</entry>
    <entry key='forward.type'>json</entry>
    <entry key='forward.header'>Authorization: Bearer ${token}</entry>
    <entry key='forward.retry.enable'>true</entry>

    <entry key='event.forward.url'>${panelUrl}/ingest/traccar/event</entry>
    <entry key='event.forward.header'>Authorization: Bearer ${token}</entry>

    <!-- Puertos de las cámaras: no hace falta definirlos. Verificado en Traccar 6.17:
         jt808 escucha en 5015 (posiciones) y jt1078 en 5263 (video) por defecto.
         Solo si necesitas cambiarlos: <entry key='jt808.port'>5015</entry> y <entry key='jt1078.port'>5263</entry>
         (en versiones anteriores de Traccar el protocolo JT808 se llamaba 'huabao').
         OBD-II Teltonika (FMC003): el protocolo teltonika escucha en 5027 por defecto;
         solo si necesitas cambiarlo: <entry key='teltonika.port'>5027</entry> -->
    <!-- ===== fin GeoCar ===== -->
`;

console.log('Pega este bloque dentro de <properties> ... </properties> en traccar.xml');
console.log('(Windows: C:\\Program Files\\Traccar\\conf\\traccar.xml) y reinicia el servicio "Traccar".');
console.log(xml);
console.log('Contiene el token de ingesta: no lo compartas ni lo subas a git.');
