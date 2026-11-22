# Vigilant GeoCar: hoja de ruta de prototipo a producción

**Supuestos:**
- Arranque con menos de 200 unidades.
- Dashcams JT808/JT1078.
- Hosting en la nube.

Con ese tamaño **no** hacen falta Kafka ni microservicios. Basta con un servidor de aplicación, un gateway TCP, un servidor de video, PostgreSQL y S3.

## Arquitectura objetivo

```
Dashcams ──TCP 808x (JT808)──► Gateway JT808 (Node) ──► PostgreSQL
        └─TCP/RTP (JT1078)──► Servidor de video ──► HLS/WebRTC al navegador
                                                └─► S3 (clips de evidencia)
Navegador ◄─HTTPS + WebSocket─► API Express ◄─► PostgreSQL / Redis
```

## Fases

| Fase | Contenido | Estimación | Estado |
|---|---|---|---|
| 0 | **Validar hardware.** 1-2 dashcams del modelo final, manual del protocolo del fabricante (extensiones ADAS/DMS 0x64/0x65, adjuntos 0x1210-0x1212), listener TCP que registre 0x0100/0x0102/0x0200/0x0002/0x0704 y prueba de video JT1078. | 1-2 sem | **Listener listo**; falta probar con equipo real |
| 1 | **Backend real.** PostgreSQL, hash de contraseñas, sesiones persistentes con expiración, aislamiento multiempresa, validación de entradas y auditoría. | 3-4 sem | **Casi completa** (ver pendientes) |
| 2 | **Gateway JT808.** Parser de tramas (escape 0x7E/0x7D, checksum, subpaquetes), respuestas 0x8001/0x8100, tabla `positions` particionada por fecha, `last_position`, alarmas hacia `Alert`, WebSocket en lugar del polling `/api/telemetry/tick`, comandos 0x8103/0x8201/0x8300. | 3-5 sem | Pendiente |
| 3 | **Video JT1078.** Servidor de medios (ZLMediaKit o similar), comandos 0x9101/0x9102/0x9205/0x9201, reproductor hls.js/mpegts.js, clips en S3 con ciclo de vida según `retentionDays` y URLs firmadas. | 3-4 sem | Pendiente |
| 4 | **Infraestructura.** Docker Compose en VM, Postgres administrado, S3, TLS, puertos TCP con IP fija, CI/CD, respaldos automáticos, Sentry y tiles de mapa con licencia. | 1-2 sem | Pendiente |
| 5 | **Legal y negocio (MX).** Aviso de privacidad (LFPDPPP), consentimiento de conductores por la grabación de cabina, SLA, facturación por `planTier`, costo de SIMs de datos (preferir clips por evento sobre grabación continua). | continuo | Pendiente |
| 6 | **Piloto.** 10-20 unidades durante 2 semanas: latencia, pérdida de posiciones y costo de datos. Luego escalar a 200. | 2 sem | Pendiente |

## Sprint 1 (Fase 1, primera parte)

### Paso A: Seguridad de autenticación
- [x] Contraseñas con hash scrypt (`server/auth/password.ts`) y política mínima: 10 caracteres, con letras y números.
- [x] Se eliminó `GET /api/auth/demo-accounts`. Las credenciales demo solo se imprimen en la consola del servidor al sembrar.
- [x] El token ya no viaja en la URL: las descargas usan el header `Authorization`.
- [x] Sesiones con expiración por inactividad y absoluta. En la base de datos solo se guarda el hash del token.
- [x] Bloqueo tras 5 intentos fallidos, rate limit en `/api/auth/*` y cabeceras de seguridad con `helmet`.
- [x] Endpoint `POST /api/auth/change-password` y reset de contraseña por un admin.

### Paso B: PostgreSQL (híbrido incremental)
- [x] Migraciones SQL versionadas (`server/db/migrations`).
- [x] Tablas normalizadas: `tenants`, `roles`, `users`, `sessions`.
- [x] Tablas documento (`id`, `tenant_id`, `data jsonb`) para el resto de las colecciones.
- [x] `FleetStore` carga el estado desde Postgres al arrancar y escribe con diff en una transacción. Cada respuesta de escritura espera a que el dato quede guardado.
- [x] IDs generados con `crypto.randomUUID()`.

## Sprint 2 (cierre de Fase 1 + Fase 0)

- [x] Validación con zod en todas las rutas de escritura (`server/validation`). Los campos desconocidos se descartan, así que no hay asignación masiva, y los errores responden 400 en español.
- [x] El superadmin debe elegir la empresa destino; ya no hay respaldo silencioso a `ten-norte` ni a `tenants[0]`.
- [x] El dimensionamiento (configuración global) solo lo modifica el superadmin.
- [x] `npm test`: 33 pruebas automatizadas (autenticación, aislamiento, validación y JT808) con PostgreSQL en memoria (PGlite). No hace falta instalar nada.
- [x] Listener JT808 de prueba (`gateway/`) con simulador. Soporta las versiones 2013 y 2019.

### Pendiente para cerrar la Fase 1
- [ ] **Row-Level Security** por `tenant_id`. Se aplicará al normalizar las tablas en la Fase 2: hoy la app carga tablas completas con un solo usuario de base de datos, así que RLS todavía no aportaría protección real. Mientras tanto, el aislamiento se verifica con `tests/isolation.test.ts`.
- [ ] Normalizar las tablas documento una por una, empezando por `vehicles` y `devices` porque las necesita el gateway.
- [ ] Recuperación de contraseña por correo y 2FA para administradores.
- [ ] Catálogo de drivers de dashcam: hoy es global y lo puede ampliar cualquier admin de empresa. Decidir si pasa a ser solo del superadmin.

## Conexión cámaras → Starlink → panel (inicio de Fase 2)

- [x] Asistente en **Configuración de Cámaras → Conexión**: datos del servidor para programar cada cámara, guía en 4 pasos, ID de terminal, vía de salida y red WiFi por equipo, y estado de conexión.
- [x] Ingesta desde Traccar (`POST /ingest/traccar/position` y `/event`) con token compartido. Las posiciones reales mueven las unidades en el mapa; las alarmas crean alertas; los IDs desconocidos quedan «sin asignar».
- [x] Simulador `npm run traccar:sim` y guía [TRACCAR.md](TRACCAR.md).
- [x] Guía de piloto en PC con Traccar para Windows y túnel o reenvío de puertos ([PILOTO-LOCAL.md](PILOTO-LOCAL.md)), más `npm run traccar:config` y `npm run traccar:check`.
- [ ] Confirmar con Traccar real la forma del JSON de reenvío y el puerto de video.
- [ ] Paquete Docker para el VPS (Traccar + panel + PostgreSQL + HTTPS).
- [ ] WebSocket en lugar del polling del mapa.
- [ ] Video JT/T 1078 dentro del panel (Fase 3).

## Alta y gestión de empresas (superadmin)

- [x] Menú **Empresas**, solo para el superadmin: listado con uso del cupo, editar, suspender o reactivar (bloquea el ingreso y cierra sesiones) y restablecer la contraseña del admin.
- [x] **Asistente en 4 pasos**: empresa (CUIT validado), plan y servicio, usuario administrador y revisión. Crea la empresa, sus 3 perfiles base, el admin con acceso total a los 10 módulos y plantillas opcionales (planes preventivos y reglas de alerta).
- [x] Contraseña temporal que se muestra una sola vez, con **cambio obligatorio en el primer ingreso**.
- [x] Cupo de unidades aplicado al registrar vehículos.
- [x] Con `SEED_DEMO_DATA=false`, una base nueva ya se puede poner en marcha: el superadmin crea las empresas desde el panel.

## Cómo probar con una dashcam real (Fase 0)

1. Arrancar el listener con `npm run gateway`. Escucha en TCP `JT808_PORT`, por defecto 7611.
2. Exponer el puerto:
   - **En la nube:** abrir el puerto TCP en el firewall o security group de la VM.
   - **Desde tu PC:** usar un túnel TCP (por ejemplo `ngrok tcp 7611`) y usar el host y puerto que te asigne.
3. Configurar la dashcam (por su app, web o SMS según el fabricante): servidor = IP o host del paso 2, puerto, protocolo JT808 y, si lo pide, número de terminal o teléfono.
4. Encender el equipo y revisar la consola. Debe aparecer 📝 registro → 🔑 autenticación → 💓 heartbeats → 📍 posiciones.
5. Cada trama queda en `.data/jt808-capture.jsonl`, con el hex crudo y la versión decodificada. Las que no se reconocen se marcan con ❔: compararlas con el manual del fabricante (ADAS/DMS 0x64/0x65, adjuntos 0x1210-0x1212, video 0x1205).
6. Sin equipo, puedes probar con `npm run gateway:sim` (añade `-- --v2019` para el formato 2019).

**La hora del equipo:** el estándar la define en GMT+8. Muchos equipos permiten configurar la zona horaria, así que compara `timeRaw` en la captura con la hora real antes de interpretarla.

## Desarrollo local

1. Instalar PostgreSQL 17: `winget install PostgreSQL.PostgreSQL.17` o el instalador oficial.
2. Crear la base: `createdb -U postgres geocar`.
3. Copiar `.env.example` a `.env` y ajustar `DATABASE_URL`.
4. Ejecutar `npm install` y luego `npm run dev`. Con `SEED_DEMO_DATA=true` la primera ejecución siembra los datos demo e imprime las credenciales en la consola.
5. `npm run db:reset` borra todas las tablas y vuelve a sembrar. **Es solo para desarrollo.**

## Registro de choferes (superadmin y admin de empresa)

Menú **Choferes**, después de «Empresas».

- **Alta en 5 pasos:**
  1. Datos personales, con DNI y CUIL validados (el CUIL debe coincidir con el DNI).
  2. Perfil y clases de licencia.
  3. Documentación: datos, vencimiento y archivo de cada documento.
  4. Asignación: sucursal, legajo y unidad.
  5. Revisión, que anticipa si el chofer quedará autorizado.
- **Documentos obligatorios según el perfil:**
  - liviano: DNI y licencia;
  - profesional: además LiNTI y psicofísico;
  - maquinaria: además el certificado de operador;
  - si transporta cargas peligrosas, también el curso.
- **Estado calculado:** Habilitado, Por vencer (30 días o menos), No autorizado (falta un documento, uno vencido o una clase insuficiente) o Deshabilitado (a mano, con motivo).
  - Un chofer no autorizado no puede asignarse a una unidad.
  - Un barrido cada hora genera una alerta en la unidad del chofer que pasa a no autorizado.
- **Archivos** (PDF, JPG o PNG, máximo 5 MB, validados por su contenido) en la tabla `driver_files` de PostgreSQL (migración 003), incluidos en el `pg_dump`.
- **Listado** con paginación desde el servidor (10, 25 o 50 por página), buscador sin acentos, filtros y contadores que filtran. Los cambios se reflejan al instante y el listado se refresca cada 30 s.
- **Alta de activos:** «Chofer asignado» elige entre los choferes autorizados. Ya no se crean choferes a partir de texto libre.
- **Datos personales:** los perfiles que no son administradores reciben el padrón sin DNI, CUIL ni documentos.
- **Verificación por un administrador:** cada documento obligatorio queda «Pendiente de verificación» hasta que un admin compara el archivo con los datos y lo marca «Verificado», o «Rechazado» con motivo.
  - El archivo es obligatorio para verificar.
  - Si cambian los datos, el archivo, las clases de licencia o el DNI, el documento vuelve a quedar pendiente.
  - Un chofer pendiente no puede tener unidad nueva; los que ya existían conservan las suyas, sin alertas.
  - Pantalla de revisión con vista previa y lista de control.
- **Pendiente:**
  - adjuntar y verificar los archivos de los choferes que vienen de la base anterior (aparecen como «Sin respaldo»);
  - avisos por email de vencimientos.

## Exportaciones (PDF, Excel y CSV)

Cada pantalla con datos tiene un botón **«Exportar ▾»** con tres formatos. Se exporta lo que el usuario puede ver en su empresa y con los filtros de la pantalla.

| Exportación | Dónde | Endpoint |
|---|---|---|
| Flota y mantenimiento | Flotas y Maquinaria, Perfiles y Reportes | `GET /api/reports/export` |
| Ficha de una unidad | Ficha técnica, Monitoreo en Vivo | `GET /api/vehicles/:id/export` |
| Órdenes de trabajo y repuestos | Mantenimiento | `GET /api/work-orders/export` |
| Choferes y documentación (con filtros) | Choferes | `GET /api/drivers/export` |
| Alertas e incidentes (con prioridad) | Alertas e Incidentes | `GET /api/alerts/export` |

- **Formato:** `?format=pdf|xlsx|csv`. Si no se indica, es CSV. El JSON de la ficha se eliminó.
- **PDF** (para leer, imprimir o enviar):
  - portada con filtros, indicadores e índice con enlaces;
  - marcadores por sección;
  - tablas con el encabezado repetido en cada página, estados como etiqueta con texto y fila de totales;
  - pie «Generado por… · Página N de M».
- **Excel** (para filtrar y calcular):
  - hoja «Resumen» con indicadores que son fórmulas sobre los datos y enlaces a cada hoja;
  - una Tabla de Excel por sección, con filtros, encabezado fijo y totales con `SUBTOTAL` que respetan el filtro;
  - fechas y montos con tipo real;
  - lista para imprimir.
- **CSV:** formato de Excel en español (separador `;`, coma decimal y BOM) y protegido contra fórmulas. El de órdenes de trabajo conserva sus columnas originales.
- **Auditoría:** cada exportación queda registrada («Exportó … (PDF)»).
- **Código:**
  - `server/export/`: `report.ts` (modelo), `reports.ts` (los 5 reportes), `pdf.ts` (pdfkit), `xlsx.ts` (exceljs), `csv.ts` y `send.ts`;
  - `src/components/ExportMenu.tsx`.

## Telemetría OBD-II (Teltonika FMC003)

Datos reales de motor por el conector OBD-II de los vehículos livianos. Guía completa: `docs/OBD-II.md` y `docs/configuracion-obd2.pdf`.

- **Pantalla:** Configuración de Cámaras → pestaña **Telemetría OBD-II** (después de «Conexión»). Datos para programar el equipo (host, puerto `5027`, Codec 8 Extended, SMS), los pasos, y la tabla por unidad con RPM, temperatura, combustible, batería, odómetro, VIN, fallas activas y fuente (OBD-II en vivo o simulada).
- **Equipo:** `Device.role = 'telemetria'`, ligado a la unidad (`Vehicle.obdDeviceId`). Identificador en Traccar = IMEI. API `PUT|DELETE /api/vehicles/:id/obd`.
- **Ingesta:** Traccar (protocolo `teltonika`, `5027/TCP`) → `/ingest/traccar/position`. Claves estándar (`rpm`, `coolantTemp`, `fuelLevel`, `obdOdometer`, `hours`, `power`, `vin`, `dtcs`) y respaldo `ioNN` de Teltonika (`TELTONIKA_IO`, a confirmar con un equipo real).
- **Códigos de falla:** cada DTC nuevo → falla activa con descripción en español (`src/shared/dtc.ts`), alerta y OT correctiva (una por unidad y código). Al borrarse sale de fallas activas; la OT la cierra el taller.
- **Camiones y maquinaria:** no tienen OBD-II; usan CAN J1939 con un equipo como el FMC650.
- **Alta desde el panel:** asistente de 3 pasos (datos + APN → SMS de programación → espera del primer reporte). El panel crea el dispositivo en Traccar por su API (`server/traccar/client.ts`, `TRACCAR_WEB_URL` + `TRACCAR_ADMIN_EMAIL/PASSWORD`); si falla, «Reintentar alta» (`POST /api/vehicles/:id/obd/sync`). Quitar el equipo lo borra de Traccar.
- **Configuración remota:** comandos Teltonika predefinidos (sin texto libre) por GPRS vía `POST /api/commands/send` de Traccar: versión, estado, datos OBD, códigos de falla, frecuencia de reporte, Codec 8 Extended y reinicio. `POST /api/vehicles/:id/obd/commands`; historial de los últimos 20 con la respuesta del equipo (evento `commandResult`).
- **Seguimiento:** detalle por unidad con conexión, salud (`src/shared/obdHealth.ts`), gráficos de RPM, temperatura, combustible y batería (24 h / 7 d / 30 d, con vista de tabla), historial de fallas y comandos. Historial en PostgreSQL (`004_obd_history.sql`: `obd_samples`, una muestra por minuto, 90 días; `obd_fault_events`).
- **Pendiente:** validar con un FMC003 real qué claves envía Traccar (`INGEST_LOG=true`), los números de parámetro del SMS y de `setparam`, y las respuestas de los comandos; abrir `5027/TCP` en el firewall del VPS.

## Conexión Smartphone (celular del chofer)

El celular del chofer, con la app oficial **Traccar Client**, rastrea al chofer mientras tiene una unidad asignada. Guía: `docs/SMARTPHONE.md` y `docs/conexion-smartphone.pdf`.

- **Pantalla:** Configuración de Cámaras → pestaña **Conexión Smartphone** (después de «Telemetría OBD-II»): datos para Traccar Client (Server URL `http://<host>:5055`, OsmAnd), pasos, tabla de choferes con celular, conexión, batería, última posición y origen de la posición de la unidad. Asistente de 3 pasos con identificador `GC-########`, ajustes por plataforma y «Compartir por WhatsApp».
- **Datos:** `Driver.phoneTracker` (sin entidad nueva); `Vehicle.positionSource` (`equipo` / `smartphone`). Alta y baja automáticas en Traccar por su API.
- **Reglas:** la última posición del celular se registra siempre en el chofer, pero solo mueve una unidad si tiene una asignada; la cámara/OBD con reporte en los últimos 3 min manda sobre el celular; se descartan fixes de más de ±100 m.
- **Alertas:** SOS (crítica), batería baja < 15 % (una por asignación), «Celular del chofer sin señal» (> 10 min en ruta, barrido cada minuto).
- **API:** `GET /api/phones`, `PUT|DELETE /api/drivers/:id/phone`, `POST /api/drivers/:id/phone/sync`. Simulador `npm run phone:sim`.
- **Pendiente:** abrir `5055/TCP` en el firewall del VPS; probar con celulares reales (Android de varias marcas e iPhone) el rastreo en segundo plano y si la versión de Traccar Client envía SOS.


## Monedas y tipos de cambio (superadmin)

Detalle en [docs/MONEDAS.md](MONEDAS.md).

- [x] Monedas ARS, VES, USD y CLP, administradas por el superadmin (nombre, símbolo, decimales, habilitar).
- [x] Tipos de cambio con fecha y pivote USD, para que los cruces sean siempre consistentes, y cotización sugerida desde fuentes públicas que el superadmin confirma.
- [x] Moneda de cada empresa, decidida por el superadmin. Al cambiarla, se elige entre convertir los importes o cambiar solo el rótulo, y queda el historial.
- [x] Equivalente en la moneda de referencia, carga de importes en otra moneda (repuestos, mano de obra, almacén), consolidado de todas las empresas y exportaciones con la moneda.
- [ ] Definir la moneda de las empresas existentes desde Empresas: quedan «Sin moneda» hasta que el superadmin la elige.
- [ ] Carga automática programada de cotizaciones (hoy es manual, con la sugerencia como ayuda).
