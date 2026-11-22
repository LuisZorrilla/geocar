# Piloto en tu PC (Windows): cámara → Starlink → Traccar → panel

Para probar con una o dos cámaras **antes de contratar el VPS**. Tu PC hace de servidor: corre Traccar y el panel, y la cámara se conecta a ella por internet.

```
Cámara ──WiFi──► Starlink Mini ──internet──► [router o túnel] ──► Tu PC
                                                                  ├─ Traccar :5015 (posiciones) :5263 (video)
                                                                  └─ Panel   :3000  ◄── Traccar reenvía
```

**Lo difícil no es Traccar, es que la cámara pueda llegar a tu PC desde internet** (paso 4).

**Lugar definitivo:** en producción, Traccar va en el VPS junto al panel (ver «Pasar al VPS» al final). La PC sirve solo para el piloto.

---

## Paso 0 (recomendado): ¿la cámara sale por el Starlink sin SIM?

Es la duda más grande del piloto (ver el PDF de fabricantes). Se puede probar **sin Traccar**, con el listener que trae el proyecto:

1. `npm run gateway`: escucha en el puerto 7611 y muestra en pantalla cada mensaje de la cámara.
2. Expón el 7611 a internet como en el paso 4, pero solo para este puerto.
3. Programa la cámara con ese host y puerto, unida al WiFi del Starlink y **sin SIM**.
4. Si ves 📝 registro → 🔑 autenticación → 📍 posiciones, la cámara sirve para la arquitectura. Cada trama queda en `.data/jt808-capture.jsonl`.

Si en el paso 0 no llega nada, no tiene sentido seguir con Traccar con ese modelo: revisa el modo WiFi cliente con el proveedor.

---

## Paso 1: Panel corriendo

```
npm run dev
```

El panel queda en http://localhost:3000, con tu PostgreSQL local.

## Paso 2: Instalar Traccar en Windows

> **Estado en esta PC (19-nov-2026):** Traccar **6.17.0 instalado** como servicio (inicio automático). El bloque de reenvío ya está en `traccar.xml`; queda un respaldo del original en `traccar.xml.original`. El usuario administrador está en `.env` (`TRACCAR_ADMIN_EMAIL` / `TRACCAR_ADMIN_PASSWORD`). Ya se probó el circuito completo con el simulador: `npm run gateway:sim -- --port 5015 --phone 201051000173`.

1. Descarga **Traccar para Windows (64 bits)** desde https://www.traccar.org/download/. Es un `.zip` con un instalador.
2. Ejecuta el instalador **como administrador**. Queda instalado como servicio de Windows llamado «Traccar», que arranca solo con la PC. Trae su propio Java; no hay que instalar nada más.
3. Abre http://localhost:8082 y crea el usuario administrador de Traccar.

Traccar usa su propia base interna; no toca tu PostgreSQL ni la base `geocar`.

## Paso 3: Conectar Traccar con el panel

1. En la carpeta del proyecto:
   ```
   npm run traccar:config
   ```
   Imprime un bloque XML con el token de ingesta de tu `.env` ya puesto. **No lo compartas.**
2. Abre como administrador `C:\Program Files\Traccar\conf\traccar.xml` (Bloc de notas → «Ejecutar como administrador» → Abrir).
3. Pega el bloque **antes** de la línea `</properties>` y guarda.
4. Reinicia el servicio en PowerShell como administrador:
   ```
   Restart-Service traccar
   ```
   O desde `services.msc` → Traccar → Reiniciar.

> **Puertos verificados en Traccar 6.17:** el protocolo `jt808` escucha en **5015** (posiciones) y `jt1078` en **5263** (video) sin configurar nada. En versiones anteriores de Traccar el JT808 se llamaba `huabao`. Si cambias un puerto, usa `jt808.port` o `jt1078.port`.

## Paso 4: Abrir tu PC a internet (elige una opción)

La cámara está en internet (vía Starlink) y tu PC está detrás del router de tu casa u oficina. Hay que abrir un camino para los puertos **5015** y **5263**.

### Opción A: reenvío de puertos en tu router
Sirve solo si tu conexión tiene **IP pública propia**. Para saberlo, compara la IP «WAN» que muestra tu router con la de https://ifconfig.me: si son distintas, estás detrás de CGNAT y esta opción no funciona.

1. Fija la IP local de tu PC (por ejemplo `192.168.1.50`) o reserva una en el DHCP del router.
2. En el router, reenvía **5015/TCP y 5263/TCP** a esa IP.
3. Abre esos puertos en el Firewall de Windows (PowerShell como administrador):
   ```
   New-NetFirewallRule -DisplayName "Traccar JT808" -Direction Inbound -Protocol TCP -LocalPort 5015 -Action Allow
   New-NetFirewallRule -DisplayName "Traccar JT1078" -Direction Inbound -Protocol TCP -LocalPort 5263 -Action Allow
   ```
4. Si tu IP pública cambia, usa un DNS dinámico gratuito (por ejemplo DuckDNS) y programa la cámara con ese nombre.
5. En `.env`: `DEVICE_SERVER_HOST=tu-ip-o-dominio`, `DEVICE_JT808_PORT=5015`, `DEVICE_JT1078_PORT=5263`.

### Opción B: túnel TCP (sin tocar el router)
Servicios como **ngrok**, **playit.gg** o **localtonet** te dan una dirección pública que llega a tu PC.

1. Crea **dos túneles TCP**: uno hacia `localhost:5015` y otro hacia `localhost:5263`.
2. Cada túnel te da un host y un **puerto público distinto**, por ejemplo `0.tcp.sa.ngrok.io:14523`.
3. En `.env` pon **los valores públicos del túnel**, no los locales:
   ```
   DEVICE_SERVER_HOST="0.tcp.sa.ngrok.io"
   DEVICE_JT808_PORT=14523
   DEVICE_JT1078_PORT=<puerto público del segundo túnel>
   ```
4. Reinicia el panel (`npm run dev`).

Cuidados:
- En los planes gratuitos el host o el puerto **cambian cada vez que reinicias el túnel**, y hay que reprogramar la cámara.
- ngrok pide verificar la cuenta para usar túneles TCP. Revisa los límites de túneles simultáneos de tu plan.

En ambas opciones, **Configuración de Cámaras → Conexión** en el panel te muestra el host y los puertos exactos que hay que cargar en la cámara.

## Paso 5: Programar la cámara y darla de alta

1. **Starlink:** red WiFi en 2.4 GHz (nombre y clave).
2. **Cámara:** WiFi en modo cliente con esa red; servidor 1 (JT808) y servidor 2 (JT1078) con los valores de la pestaña Conexión.
3. **Traccar** (http://localhost:8082): Dispositivos → Agregar. **Identificador = ID de terminal** de la cámara.
4. **Panel:** en Conexión, carga ese mismo ID de terminal en la unidad que corresponda (o asígnalo desde «Equipos detectados sin asignar»).

## Paso 6: Verificar

```
npm run traccar:check
```

Revisa el panel, el token, Traccar, sus puertos y si la dirección pública responde. Cada ❌ trae el arreglo sugerido.

Con todo en ✅:
- En Traccar, la cámara aparece «en línea».
- En el panel, la unidad aparece **Conectado · Traccar** y se mueve en **Monitoreo en Vivo**.
- Un evento (por ejemplo el botón SOS) aparece en **Alertas e Incidentes**.

Para probar Traccar → panel sin cámara: `npm run traccar:sim -- --terminal <ID>`.

## Límites de la PC para el piloto

- La PC debe quedar **encendida y sin suspensión** mientras la cámara reporte. Si no, la cámara guarda las posiciones y las reenvía después.
- Con túnel gratuito, la dirección puede cambiar.
- Sin respaldos ni alta disponibilidad: **no es para producción**.

---

## Pasar al VPS (producción)

Cuando el piloto funcione, la misma configuración va a un VPS:

| | Recomendado |
|---|---|
| Sistema | Ubuntu 24.04 LTS |
| Tamaño | 2 vCPU · 4 GB RAM · 80 GB SSD (suficiente para menos de 200 unidades sin grabar video en el servidor) |
| Región | **São Paulo o Santiago**: la latencia hacia Argentina importa sobre todo para el video en vivo |
| Red | IP pública fija y un dominio, por ejemplo `flota.tuempresa.com.ar` |
| Puertos abiertos | 5015/TCP, 5263/TCP, 443/TCP (panel con HTTPS) y 22/TCP solo desde tus IPs |

Cambios respecto a la PC:
- `DEVICE_SERVER_HOST` = el dominio; puertos 5015/5263 directos, sin túnel.
- `forward.url` de Traccar apunta al panel por la red interna: `npm run traccar:config -- --panel-url http://api:3000`.
- `SIMULATED_TELEMETRY=false`.

Las cámaras ya programadas solo necesitan que les cambies el host. El paquete Docker del VPS (Traccar + panel + PostgreSQL + HTTPS) es el siguiente paso del ROADMAP.
