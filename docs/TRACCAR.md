# Conexión cámaras → Starlink → Traccar → panel

Guía para dejar funcionando el camino completo del diagrama:

```
Dashcam ──WiFi/Ethernet──► Starlink Mini ──internet──► VPS
                                                        ├─ Traccar  :5015 (JT/T 808)  :5263 (JT/T 1078 video)
                                                        └─ Panel    /ingest/traccar/*  ◄── Traccar reenvía posiciones y eventos
```

> **¿Piloto en tu PC antes del VPS?** Sigue [PILOTO-LOCAL.md](PILOTO-LOCAL.md). Herramientas:
> `npm run traccar:config` imprime el bloque de `traccar.xml` con tu token; `npm run traccar:check` diagnostica panel, Traccar, puertos y acceso desde internet.

La configuración se hace en **4 lugares**. El panel muestra los datos exactos de cada paso en
**Configuración de Cámaras → Conexión (Starlink → servidor)**.

## 1. Servidor (una sola vez)

Variables en el `.env` del panel:

| Variable | Valor | Para qué |
|---|---|---|
| `DEVICE_SERVER_HOST` | `flota.midominio.com` | Dominio o IP pública del VPS. Es lo que se programa en cada cámara. |
| `DEVICE_JT808_PORT` | `5015` | Puerto de posiciones de Traccar. |
| `DEVICE_JT1078_PORT` | `5263` | Puerto de video de Traccar (confirmar en el piloto). |
| `DEVICE_TELTONIKA_PORT` | `5027` | Puerto Teltonika de Traccar para los OBD-II (FMC003). |
| `DEVICE_OSMAND_PORT` | `5055` | Puerto OsmAnd de Traccar para los celulares de los choferes (Traccar Client). |
| `INGEST_TOKEN` | secreto aleatorio | Traccar lo envía para poder escribir en el panel. Vacío = ingesta deshabilitada. |
| `SIMULATED_TELEMETRY` | `false` en producción | Apaga el movimiento simulado de las unidades demo. |

Para generar el token:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

**Direcciones editables desde el panel (superadmin):** si los equipos entran por otro camino (por ejemplo túneles TCP de ngrok o playit.gg), el superadmin cambia lo que se programa en cada equipo sin tocar `.env`. Se guarda en la base (`app_settings`) y «Restaurar» vuelve a estos valores:

| Equipo | Dónde | Clave | API |
|---|---|---|---|
| Cámaras (JT/T 808 y 1078; el video puede tener otro host) | Configuración de Cámaras → Conexión | `camera_server` | `PUT /api/settings/camera-server` |
| OBD-II (Teltonika) | Telemetría OBD-II | `obd_server` | `PUT /api/settings/obd-server` |
| Celulares (Traccar Client) | Conexión Smartphone | `phone_server_url` | `PUT /api/settings/phone-server-url` |

Cámaras y OBD-II usan **TCP**: un túnel de VS Code (`*.devtunnels.ms`, solo HTTP/HTTPS) no les sirve y el panel lo rechaza. Para los celulares sí sirve.

**Firewall del VPS:** abrir `5015/TCP`, `5263/TCP`, `5027/TCP` (OBD-II Teltonika, ver `docs/OBD-II.md`), `5055/TCP` (celulares con Traccar Client, ver `docs/SMARTPHONE.md`) y `443/TCP`. El puerto `3000` del panel y el `8082` de Traccar **no** se exponen a internet.

## 2. Traccar: reenvío al panel (`traccar.xml`)

```xml
<!-- Posiciones → panel -->
<entry key='forward.url'>http://api:3000/ingest/traccar/position</entry>
<entry key='forward.type'>json</entry>
<entry key='forward.header'>Authorization: Bearer TU_INGEST_TOKEN</entry>
<entry key='forward.retry.enable'>true</entry>

<!-- Eventos (alarmas, online/offline) → panel -->
<entry key='event.forward.url'>http://api:3000/ingest/traccar/event</entry>
<entry key='event.forward.header'>Authorization: Bearer TU_INGEST_TOKEN</entry>
```

- `api:3000` es el nombre del contenedor del panel en la red interna de Docker. Si Traccar y el panel corren en el mismo host sin Docker, usar `http://localhost:3000`.
- En versiones viejas de Traccar, en lugar de `forward.type=json` se usa `<entry key='forward.json'>true</entry>`.
- **Alta de cada equipo en Traccar:** Dispositivos → Agregar. El campo **Identificador** debe ser igual al **ID de terminal** que muestra el panel.

> **Verificado con Traccar 6.17 (Windows):**
> - El reenvío llega con la forma `{ position, device }`, y el panel la acepta.
> - Los puertos por defecto son `jt808` = 5015 y `jt1078` = 5263; en versiones anteriores el JT808 se llamaba `huabao`.
> - Traccar reenvía **antes de guardar** (`position.id` llega en 0) y **en paralelo**, así que las posiciones pueden llegar desordenadas. El panel las ordena por la hora GPS (`fixTime`) y descarta las más viejas.
>
> Para ver cada posición recibida, arranca el panel con `INGEST_LOG=true`; las rechazadas siempre se registran como `[ingest] posición rechazada: …`.

## 3. Starlink Mini (en cada vehículo)

App de Starlink → Configuración → Router:
- Nombre de red (SSID) y clave. Conviene un nombre por vehículo, por ejemplo `Starlink-TLN-001`, y anotarlo en el panel (columna «Red WiFi»).
- La cámara usa **2.4 GHz**.

Para el piloto, Starlink entrega IP compartida (CGNAT): está bien, porque la cámara es la que inicia la conexión hacia el VPS.

## 4. Cámara (en cada equipo)

Con la app, el software de PC o los SMS del fabricante:

1. **WiFi en modo cliente (STA):** red y clave del Starlink de ese vehículo. Si el equipo tiene puerto Ethernet de salida, se puede usar cable en su lugar.
2. **Servidor 1 (JT/T 808):** `DEVICE_SERVER_HOST`, puerto `5015`, protocolo JT808-2013 o 2019.
3. **Servidor 2 (JT/T 1078, video):** el mismo host, puerto `5263`.
4. Anotar el **ID de terminal** que reporta el equipo y cargarlo en el panel y en Traccar.

Ejemplo Jimi, reportado en el foro de Traccar (verificar en el manual del modelo):

```
SERVER,1,flota.midominio.com,5015,0#
```

## Verificación

1. En el panel, la fila del equipo pasa a **Conectado** con fuente **Traccar**, y la unidad se mueve en **Monitoreo en Vivo**.
2. Si en «Equipos detectados sin asignar» (solo superadmin) aparece un ID, Traccar lo está recibiendo pero ningún equipo del panel lo tiene: asignarlo a la unidad correcta.
3. Sin cámara ni Traccar se puede probar el tramo Traccar → panel con el simulador:

```
npm run traccar:sim -- --terminal <ID de terminal>
```

Envía posiciones por la Av. Libertador (San Juan) y al final una alarma SOS, que aparece en **Alertas e Incidentes**.

## Qué hace el panel con cada dato

| Llega de Traccar | Efecto en el panel |
|---|---|
| Posición | Mueve la unidad (lat/lng, velocidad en km/h, rumbo, odómetro); el equipo queda «Conectado», fuente «Traccar». La simulación deja de mover esa unidad. |
| Evento `alarm` | Crea una alerta pendiente. `sos`, `accident` y `tampering` → crítica (la unidad pasa a «En alerta»); `overspeed`, `fatigueDriving` y `driverDistraction` → alta; el resto → media. |
| `deviceOnline` / `deviceOffline` | Cambia el estado del enlace. |
| ID desconocido | Se lista en «Equipos detectados sin asignar» (no se pierde, pero no se muestra en el mapa). |

Las posiciones se guardan en PostgreSQL agrupadas cada 2 segundos. Al apagar el servidor (SIGTERM) se guarda lo pendiente.
