# Telemetría OBD-II (Teltonika FMC003)

Un rastreador OBD-II lee la computadora del vehículo: RPM, temperatura del motor, combustible, odómetro, tensión de batería, VIN y **códigos de falla (DTC)**. Sin él, esos datos son simulados en el panel. La cámara JT808 sigue aportando posición y video; el OBD aporta el motor.

```
Conector OBD-II ──► FMC003 ──(SIM 4G)──► Traccar :5027 (teltonika) ──HTTP──► Panel /ingest/traccar/position
```

## 1. ¿Qué vehículos sirven?

| Vehículo | ¿OBD-II? | Equipo |
|---|---|---|
| Liviano a nafta 2009 o posterior (Euro 4: 2009 modelos nuevos, 2011 todos) | Sí | FMC003 |
| Diésel liviano (pick-up, utilitario) reciente | Sí | FMC003 |
| Liviano anterior a 2009 | Puede no responder | Probar; si no, solo GPS |
| Eléctrico o híbrido | Parcial | FMC003 en modo OBD «Non-compliant» |
| Camión, colectivo, maquinaria | **No** (usan CAN J1939/FMS) | FMC650 u otro con lectura CAN |

El conector OBD-II es de 16 pines y está debajo del volante, a la izquierda de las piernas del conductor.

## 2. Instalación

1. Comprar el equipo con una **SIM de datos 4G** (Personal, Claro o Movistar M2M). Anotar el **APN** del operador.
2. Con el motor apagado, enchufar el FMC003 en el conector OBD. Si molesta las piernas, usar un cable extensor OBD y fijar el equipo con precintos.
3. Encender el motor: el LED de GNSS y el de red deben quedar fijos en un par de minutos.

El FMC003 **no usa el WiFi del Starlink**: sale por celular. Sin cobertura guarda los registros y los reenvía cuando vuelve la señal; el panel ignora las posiciones más viejas que la última.

> Teltonika marca el FMC003 como «End of life». Al comprar, confirmar con el distribuidor el modelo que lo reemplaza; la configuración es la misma (protocolo Teltonika, Codec 8 Extended).

## 3. Alta desde el panel (recomendado)

Configuración de Cámaras → **Telemetría OBD-II** → lápiz de la unidad. El asistente tiene 3 pasos:

1. **Datos del equipo:** IMEI (15 dígitos, en la etiqueta), modelo, operador de la SIM (APN) y VIN opcional. Al guardar, el panel **crea el dispositivo en Traccar** con Identificador = IMEI y nombre «<unidad> OBD».
2. **SMS de programación:** el panel arma el SMS con APN, servidor, puerto 5027, TCP y Codec 8 Extended. Se copia y se manda **desde cualquier celular al número de la SIM del equipo**:

   ```
     setparam 2001:<apn>;2004:<host>;2005:5027;2006:0;113:1
   ```

   Empieza con **dos espacios** (usuario y clave vacíos). `2001` APN, `2004` servidor, `2005` puerto, `2006` protocolo (0 = TCP), `113` codec (1 = Codec 8 Extended). Confirmar los números en el wiki de Teltonika para el firmware del equipo.
3. **Conexión:** el asistente muestra «Alta en Traccar» y «Esperando el primer reporte…» hasta que llegan datos del motor (1 a 3 minutos con el motor encendido).

Para que el panel cree el dispositivo en Traccar hacen falta en `.env` `TRACCAR_WEB_URL`, `TRACCAR_ADMIN_EMAIL` y `TRACCAR_ADMIN_PASSWORD`. Sin ellos el estado queda en «Alta manual en Traccar» y hay que crearlo a mano. Si Traccar no responde, «Reintentar alta».

### Servidor personalizado (túnel TCP)

El FMC003 habla **TCP crudo** (protocolo Teltonika), no HTTP. Por eso **un túnel de VS Code (`*.devtunnels.ms`) no sirve** para los OBD-II, aunque sí sirve para los celulares. Caminos válidos:

- IP pública con `5027/TCP` reenviado en el router (predeterminado: `DEVICE_SERVER_HOST` + `5027`).
- Túnel **TCP** (ngrok `tcp`, playit.gg) que apunte al `5027` local de Traccar: da un host y un puerto, por ejemplo `0.tcp.sa.ngrok.io:14523`.

El **superadmin** cambia host y puerto en la pestaña Telemetría OBD-II (lápiz de «Servidor (host)»). Es global, queda en la base (`app_settings`, clave `obd_server`), se usa en el SMS de programación y «Restaurar» vuelve al predeterminado. API: `PUT /api/settings/obd-server` con `{ "server": { "host": "…", "port": 14523 } }` o `{ "server": null }`. Los equipos ya programados no cambian solos: hay que reenviarles el SMS.

## 3 bis. Teltonika Configurator (alternativa por USB)

Descargar **Teltonika Configurator** del wiki de Teltonika y conectar el equipo por USB o Bluetooth.

| Sección | Parámetro | Valor |
|---|---|---|
| GPRS | APN | El del operador de la SIM |
| GPRS → Server | Domain | `DEVICE_SERVER_HOST` (se ve en el panel) |
| GPRS → Server | Port | `5027` |
| GPRS → Server | Protocol | TCP |
| System / Data protocol | Codec | **Codec 8 Extended** |
| OBD II | Mode | Auto (Non-compliant en eléctricos) |
| OBD II | VIN | Auto (o escribirlo a mano) |
| OBD II → elementos | Enviar | RPM, Coolant Temperature, Fuel Level, OEM Total Mileage, DTC (Fault Codes), VIN |
| Data Acquisition | En movimiento | Cada 30 s (o 200 m, o 15° de giro) |
| Data Acquisition | Detenido | Cada 300 s |


## 4. Traccar y el panel

1. **Traccar:** el protocolo `teltonika` escucha en **5027** sin configurar nada. El panel crea el dispositivo (Identificador = IMEI); a mano solo si la API no está configurada.
2. **Firewall del VPS:** abrir `5027/TCP`.
3. **Panel:** asistente de la sección 3.
4. **Verificación:** al llegar el primer reporte la fuente pasa a **OBD-II en vivo** y la ficha de la unidad muestra RPM, temperatura, combustible, batería y VIN reales.

Si el IMEI llega antes de asignarlo, aparece en «Equipos OBD-II detectados sin asignar» (solo superadmin) y se asigna desde ahí.

## 5. Códigos de falla (DTC)

Cuando el vehículo enciende el testigo «check engine», el FMC003 envía el código (por ejemplo `P0420`). El panel:

1. Lo agrega a **Fallas activas** con su descripción en español y gravedad.
2. Crea una **alerta** «Falla OBD-II P0420» (crítica o alta).
3. Abre una **OT correctiva** en Mantenimiento, salvo que ya haya una abierta para ese código en esa unidad.
4. Cuando el código deja de estar activo (reparado o borrado con escáner) sale de Fallas activas y queda en la auditoría. **La OT no se cierra sola**: la cierra el taller.

| Letra | Sistema | Ejemplos frecuentes |
|---|---|---|
| P | Motor y transmisión | P0300–P0306 fallas de encendido (crítico), P0420 catalizador, P0171 mezcla pobre, P0217 sobretemperatura (crítico), P0520 presión de aceite (crítico) |
| C | Chasis | C0035 sensor ABS rueda delantera izquierda (crítico) |
| B | Carrocería | B0001 airbag del conductor (crítico) |
| U | Red de comunicación | U0100 sin comunicación con la ECU del motor (crítico) |

Segundo carácter `0` = código genérico (igual en todas las marcas); `1` = propio del fabricante (consultar con el escáner del taller).

## 6. Seguimiento y configuración remota

Tocando la fila de una unidad con equipo se abre el **Seguimiento OBD-II**:

- **Conexión:** Conectado, Sin señal (más de 15 min sin datos), Esperando primer reporte o error de alta.
- **Salud del vehículo:**

  | Estado | Cuándo |
  |---|---|
  | Bien | Sin fallas, temperatura y batería normales |
  | Atención | Falla de advertencia; batería < 12,0 V con el motor apagado o < 13,2 V en marcha |
  | Crítico | Falla crítica o temperatura > 105 °C |

- **Historial del motor:** gráficos de RPM, temperatura (línea en 105 °C), combustible y batería (línea en 12 V) para 24 h, 7 días o 30 días, y la misma información en tabla. Se guarda un dato por minuto durante 90 días.
- **Historial de fallas:** cada código con cuándo apareció, cuándo se borró, duración y la OT abierta.
- **Configuración remota:** botones que mandan comandos al equipo por internet (GPRS) a través de Traccar. Si el equipo está desconectado, el comando queda **en cola** y se envía cuando se conecta. No hay comando libre: solo estos.

  | Botón | Comando | Para qué |
  |---|---|---|
  | Ver versión | `getver` | Firmware, modelo e IMEI |
  | Ver estado | `getstatus` | Conexión, señal y GPS |
  | Pedir datos OBD | `obdinfo` | Protocolo OBD, VIN y estado de lectura |
  | Pedir códigos de falla | `faultcodes` | Lee los DTC activos en el momento |
  | Cambiar frecuencia de reporte | `setparam 10050:<s>;10000:<s>` | Normal 30 s / 5 min, Ahorro 60 s / 1 h, Intensivo 10 s / 1 min |
  | Activar Codec 8 Extended | `setparam 113:1` | Si llega la posición pero no el motor |
  | Reiniciar equipo | `cpureset` | Pide confirmación |

  Cada envío queda en el historial de comandos (y en la auditoría) con su estado: Enviado, En cola, Error o Respondido, con el texto que contestó el equipo.

## 7. Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Llega posición pero no RPM ni temperatura | Codec 8 (no Extended) o modo OBD apagado | Codec 8 Extended y OBD «Auto» |
| No llega el VIN | El vehículo no lo informa por OBD | Escribirlo a mano en el panel |
| La unidad sigue «Simulada» | IMEI no asignado o distinto en Traccar | Revisar «Equipos detectados sin asignar» |
| «Error en Traccar» al asignar | Credenciales o URL de Traccar en `.env` | Corregir y «Reintentar alta» |
| Comandos siempre «En cola» | El equipo no está conectado a Traccar | Revisar SMS, SIM y puerto 5027 |
| Valores raros en una marca | Traccar envía claves `ioNN` sin traducir | Panel con `INGEST_LOG=true` y ajustar `TELTONIKA_IO` en `server/ingest/obd.ts` |
| Batería descargada con el auto parado | Intervalo detenido muy corto | 300 s o más; activar modo de bajo consumo |

## 8. Probar sin equipo

```
npm run traccar:sim -- --terminal <IMEI asignado> --obd
```

Envía posiciones con RPM, temperatura, combustible, odómetro, batería y VIN; a un tercio del recorrido aparece `P0420` (alerta + OT) y en el último reporte se borra, con el motor apagado y la batería en 11,6 V (salud «Atención»).

## 9. Referencia técnica

- Claves de Traccar usadas: `rpm`, `coolantTemp`, `fuelLevel`/`fuel`, `obdOdometer` (m), `hours` (ms), `power` (V), `vin`, `dtcs`. Respaldo Teltonika: `io36`, `io32`, `io390`/`io48`, `io389`, `io66` (mV), `io256`, `io281`, `io30`.
- Código: `server/ingest/obd.ts` (lectura), `src/shared/dtc.ts` (códigos), `src/shared/teltonika.ts` (SMS y comandos), `src/shared/obdHealth.ts` (salud y conexión), `server/traccar/client.ts` (API de Traccar), `FleetStore.applyObdReading` / `assignObdDevice` (`server/store.ts`), `src/components/ObdTelemetryView.tsx`, `ObdConnectWizard.tsx`, `ObdUnitDetail.tsx`.
- API: `GET|PUT|DELETE /api/vehicles/:id/obd`, `POST /api/vehicles/:id/obd/sync`, `POST /api/vehicles/:id/obd/commands`, `GET /api/vehicles/:id/obd/history?range=24h|7d|30d`, `GET /api/vehicles/:id/obd/faults`.
- Historial: tablas `obd_samples` y `obd_fault_events` (`server/db/migrations/004_obd_history.sql`); purga diaria de muestras de más de 90 días.
