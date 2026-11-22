# Conexión Smartphone (celular del chofer con Traccar Client)

> Documentos por fuente y guía paso a paso para conectar un teléfono: [docs/smartphone/](smartphone/README.md).

El celular del chofer funciona como **rastreador del chofer**: mientras tiene una unidad asignada, su posición alimenta esa unidad. Sirve como **respaldo** cuando la cámara pierde señal o está apagada, y para **unidades sin equipo** (utilitarios, alquilados, de reemplazo).

```
Celular (Traccar Client) ──(datos móviles)──► Traccar :5055 (osmand) ──HTTP──► Panel /ingest/traccar/position
```

## 1. Qué aporta y qué no

| Aporta | No aporta |
|---|---|
| Posición, velocidad y rumbo (GPS del celular, ±5–20 m) | Datos del motor (RPM, temperatura, fallas): eso es OBD-II |
| Batería del celular y si está cargando | Video ni ADAS/DMS: eso es la cámara |
| Botón SOS (si la versión de la app lo tiene) → alerta crítica | Rastreo garantizado: el celular puede apagarse, quedarse sin batería o cerrar la app |

## 2. Celulares compatibles

- Android 8 o superior, o iPhone con iOS 15 o superior, con GPS y plan de datos.
- App **Traccar Client** (gratuita, oficial de Traccar) desde Google Play o App Store.
- Consumo: unos pocos MB por día y más batería durante el turno: conviene cargador en el vehículo.

## 3. Privacidad y prioridad

- **Unidad asignada:** la última posición del celular queda siempre registrada en el chofer (columna «Última posición»), pero solo **mueve una unidad** si el chofer tiene una asignada (Choferes → asignación).
- **Manda el equipo:** si la cámara u OBD de la unidad reportó en los últimos 3 minutos, la posición de la unidad sale del equipo; el celular queda como dato del chofer. Si el equipo calla, la unidad pasa a moverse con el celular y el panel lo indica («Posición: celular de …»).
- Se descartan las posiciones con precisión peor que ±100 m (ubicación por antenas).

## 4. Alta desde el panel

Configuración de Cámaras → **Conexión Smartphone** → lápiz del chofer. El asistente tiene 3 pasos:

1. **Celular:** Android o iPhone. El panel genera el **identificador** (`GC-` + 8 dígitos) y **da de alta el dispositivo en Traccar** («Celular · Apellido, Nombre»). Requiere `TRACCAR_WEB_URL`, `TRACCAR_ADMIN_EMAIL` y `TRACCAR_ADMIN_PASSWORD`; sin ellos queda «Alta manual en Traccar».
2. **Configurar la app:** **QR de configuración** (ver 5.1) y, en «Configurar a mano», identificador y Server URL para copiar y ajustes recomendados; además, los permisos. **Compartir por WhatsApp** o **Copiar instrucciones** le manda todo al chofer. **Nuevo identificador** sirve si cambió o perdió el celular (el anterior deja de funcionar y se borra de Traccar).
3. **Conexión:** «Alta en Traccar» y «Esperando el primer reporte…» hasta que el celular reporta («Conectado», con la batería).

## 5. Configuración de Traccar Client

| Ajuste | Valor | Nota |
|---|---|---|
| Device identifier | `GC-########` | El que da el panel |
| Server URL | `http://<DEVICE_SERVER_HOST>:5055` | URL completa, con `http://` y puerto |
| Location accuracy | High | GPS; en túneles o galpones usa red celular |
| Distance | 100 | metros entre reportes en movimiento |
| Interval | 60 | segundos (solo Android) |
| Angle | 30 | grados: reporta en cada giro |
| Heartbeat | 300 | segundos entre reportes detenido |
| Offline buffering | Activado | guarda posiciones sin señal |
| Stop detection | Activado | ahorra batería detenido |
| Wake lock | Activado | solo Android |

Después, activar **Service status** (rastreo continuo).

### 5.1 Configuración por QR

El panel genera un **QR con toda la tabla anterior** (identificador, Server URL y ajustes de la plataforma). Aparece en el paso «Configurar la app» del asistente, en el ícono QR de cada fila de la tabla de celulares y en la ficha del chofer (Choferes). Tiene **Descargar PNG**, **Imprimir** y el enlace para copiar.

- **En el celular:** Traccar Client **9.6 o posterior** → Ajustes → **Escanear código QR**. La app guarda los valores y queda lista; solo falta dar los permisos y activar Service status.
- **Formato:** `org.traccar.client://config?url=<Server URL codificada>&id=GC-########&accuracy=high&distance=100&interval=60&angle=30&heartbeat=300&buffer=true&stop_detection=true&wakelock=true`. En iPhone no van `interval` ni `wakelock` (solo existen en Android). La app toma la Server URL de `url` y aplica el resto de los parámetros (`ConfigurationService.applyUri` en el código de Traccar Client).
- **Por WhatsApp:** las instrucciones compartidas incluyen el mismo enlace; tocarlo en el celular abre Traccar Client y la configura.
- **Si cambia la Server URL:** el QR nuevo sale con la URL vigente; los celulares ya configurados hay que volver a escanearlos.
- **Seguridad:** el QR no lleva contraseñas, solo la URL del receptor y el identificador. Quien lo tenga podría reportar con ese identificador: compartirlo solo con el chofer. Si se filtra, «Nuevo identificador».
- **Sin lector de QR** (versiones viejas de la app): cargar los datos a mano con la tabla de arriba.

### Server URL personalizada (túnel o proxy HTTPS)

Por defecto la Server URL es `http://<DEVICE_SERVER_HOST>:5055`. Si los celulares entran por otro camino (por ejemplo un túnel de VS Code `https://xxxx-5055.brs.devtunnels.ms`, o un proxy HTTPS en el VPS), el **superadmin** la cambia en la pestaña Conexión Smartphone (lápiz del campo «Server URL»). Es global para todas las empresas, se guarda en la base (`app_settings`, clave `phone_server_url`) y «Restaurar» vuelve a la predeterminada. API: `PUT /api/settings/phone-server-url` con `{ "url": "https://…" }` o `{ "url": null }`. Los celulares ya configurados no se actualizan solos.

## 6. Permisos por marca

| Celular | Qué configurar |
|---|---|
| Todos los Android | Ubicación «Permitir todo el tiempo» y «Ubicación precisa»; batería de Traccar Client «Sin restricciones» |
| Samsung | Sacar Traccar Client de «Apps en suspensión» y «Apps en suspensión profunda» |
| Xiaomi / Redmi | «Inicio automático» activado; ahorro de batería «Sin restricciones»; bloquear la app en recientes |
| Motorola | Batería → «Sin restricciones» |
| iPhone | Ubicación «Siempre» y «Ubicación exacta»; actualización en segundo plano; no cerrar la app deslizándola; sin modo de bajo consumo en el turno |

Guía por marca: [dontkillmyapp.com](https://dontkillmyapp.com).

## 7. Alertas

| Alerta | Cuándo | Prioridad |
|---|---|---|
| Botón de pánico (SOS) | La app envía `alarm=sos` | Crítica |
| Batería baja del celular del chofer | < 15 % sin cargar, en turno (una por asignación) | Media |
| Celular del chofer sin señal | La unidad se rastrea con el celular, está en ruta y no reporta hace más de 10 min | Alta |

## 8. Servidor

- Traccar escucha el protocolo **osmand** en **5055** por defecto. Abrir **`5055/TCP`** en el firewall del VPS.
- `npm run traccar:check` comprueba el puerto 5055.
- Variable `DEVICE_OSMAND_PORT` (por defecto 5055) si Traccar usa otro puerto.

## 9. Probar sin celular

```
npm run phone:sim -- --id GC-12345678            # OsmAnd directo a Traccar :5055, como la app real
npm run phone:sim -- --id GC-12345678 --panel    # reenvío directo al panel, sin Traccar
```

Recorre Av. Libertador (San Juan); la batería baja hasta 12 % (alerta) y el último reporte trae SOS (salvo `--no-sos`).

## 10. Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Queda «Esperando primer reporte» | Identificador o URL mal escritos; falta `http://` o el puerto | Copiar de nuevo desde el asistente |
| Conecta pero la unidad no se mueve | El chofer no tiene unidad asignada, o la cámara de la unidad está reportando | Revisar la asignación; con cámara activa es lo esperado |
| Se corta al bloquear la pantalla | Ahorro de batería del celular | Permisos de la sección 6 |
| Saltos de posición | Precisión baja (antenas) | Precisión «High»; el panel descarta > ±100 m |
| «Error en Traccar» al dar de alta | URL o credenciales de Traccar en `.env` | Corregir y «Reintentar alta» |

## 11. Referencia técnica

- Datos: `Driver.phoneTracker` (`src/shared/types.ts`), `Vehicle.positionSource` / `positionSourceLabel`.
- Lógica: `FleetStore.ingestPhonePosition`, `ingestPhoneEvent`, `sweepPhones`, `assignDriverPhone`, `removeDriverPhone`, `listPhones` (`server/store.ts`); ajustes y textos en `src/shared/phone.ts`.
- API: `GET /api/phones`, `PUT|DELETE /api/drivers/:id/phone`, `POST /api/drivers/:id/phone/sync`.
- Pantalla: `src/components/PhoneTrackingView.tsx`, `PhoneConnectWizard.tsx`.
- Fuentes: [Traccar Client – configuración](https://www.traccar.org/client-configuration/), [foro Traccar – puerto 5055 del Client](https://www.traccar.org/forums/topic/cannot-connect-server-in-android-devices-in-port-5055/).
