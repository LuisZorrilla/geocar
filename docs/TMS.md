# Operaciones (TMS) — Fases T1 a T5

Módulo para el ciclo operativo del transporte: **clientes → lugares → pedidos → viajes → entregas**, con seguimiento automático de cada parada a partir de la posición que ya reportan las unidades.

## Conceptos

| Entidad | Qué es | Estados |
|---|---|---|
| **Cliente** | Dador de carga o destinatario. CUIT validado (dígito verificador) o RUT/RIF tal cual se escribe. | Activo / inactivo |
| **Lugar** | Depósito, planta, cliente o puerto con una **geocerca circular** (50 a 2000 m). | Activo / inactivo |
| **Pedido** (`PED-<empresa>-NNNN`) | Qué se lleva, de qué lugar a cuál, ventanas de carga y entrega. | Borrador → Confirmado → Planificado → En curso → Entregado (o Cancelado) |
| **Viaje** (`VJ-<empresa>-NNNN`) | Unidad + chofer + salida + paradas armadas a partir de los pedidos. | Planificado → En curso → Finalizado (o Cancelado) |
| **Parada** | Carga o descarga en un lugar. | Pendiente → En el lugar → Completada (u Omitida) |

## Cómo se arma un viaje

1. Solo entran pedidos **confirmados**.
2. Las paradas se generan solas: una **carga por cada origen** y una **descarga por cada destino**. Los pedidos que comparten un lugar comparten la parada. Las cargas van primero y cada grupo se ordena por su ventana. Mientras el viaje está planificado, el orden se puede cambiar, pero nunca se descarga un pedido antes de cargarlo.
3. **Validación de la asignación** (en vivo en el formulario y otra vez al guardar):

**Bloqueos (no se pueden forzar):**
- Chofer no autorizado, deshabilitado o con documentos pendientes de verificación, según el módulo Choferes.
- Carga peligrosa con un chofer sin la clase E.3 o sin el curso de cargas peligrosas.
- Unidad con una OT **crítica** abierta.
- Último checklist pre-operativo de la unidad revisado como «No apto».
- Unidad o chofer ya asignados a otro viaje en un horario que se superpone. El horario va desde la salida hasta el fin de la última ventana del viaje, o 12 h si no tiene ventanas.

**Advertencias (se aceptan con un motivo):**
- Peso, volumen o pallets por encima de la capacidad de la unidad, o capacidad sin cargar.
- Carga refrigerada en una unidad que no figura como refrigerada.
- Servicio preventivo vencido.
- Checklist con fallas sin revisar.
- Chofer con documentación por vencer.

Aceptar advertencias requiere ser superadmin, admin de la empresa o tener `operaciones: full`. El motivo queda en el viaje y en la auditoría.

Al iniciar el viaje se repiten los bloqueos, porque algo pudo cambiar desde que se planificó.

## Seguimiento automático por geocerca

Cada **60 s** el servidor (o el botón «Actualizar seguimiento») compara la última posición de cada unidad en viaje con su parada actual. Toma la posición venga de donde venga: cámara, OBD-II o celular del chofer.

- **Llegada**: la unidad entra al radio del lugar.
- **Salida**: la unidad sale del radio con 30 m de margen, después de estar **al menos 2 minutos** adentro. Si sale antes, se considera que pasó sin detenerse y la parada sigue pendiente. El margen y el tiempo mínimo evitan los rebotes del GPS.
- Las posiciones con más de 10 minutos de antigüedad se ignoran.
- Un viaje planificado **arranca solo** cuando ya llegó su hora y la unidad entra a la primera parada.
- Al completarse una descarga, sus pedidos quedan **entregados**. Al cerrarse todas las paradas, el viaje queda **finalizado**.
- **Entrega demorada**: si la ventana de una descarga vence sin llegada, se genera **una** alerta «Entrega demorada» (`ruleId: tms-delay`), visible en Alertas.

Las paradas también se pueden marcar a mano: «Marcar llegada», «Marcar completada» u «Omitir». Para omitir hace falta un motivo, y los pedidos de una descarga omitida vuelven a «Confirmado» para replanificarlos.

## Permisos

Hay un módulo de permisos nuevo, **`operaciones`**. Los roles que ya existían reciben el mismo nivel que tenían en `flotas`, así que nadie gana ni pierde acceso. Con `read` se consulta; con `write` o `full` se crea y se edita.

La **capacidad de carga** de una unidad se edita desde su ficha (Flotas → ficha de la unidad → «Capacidad de carga»). Hace falta escritura en Flotas o en Operaciones.

## API

| Método y ruta | Uso |
|---|---|
| `GET/POST /api/tms/customers`, `PATCH /api/tms/customers/:id` | Clientes |
| `GET/POST /api/tms/places`, `PATCH /api/tms/places/:id` | Lugares |
| `GET/POST /api/tms/orders`, `PATCH /api/tms/orders/:id`, `POST …/:id/confirm`, `POST …/:id/cancel` | Pedidos (filtros `status`, `q`, `customerId`, paginado) |
| `POST /api/tms/trips/validate` | Validación de asignación sin guardar |
| `GET/POST /api/tms/trips`, `GET/PATCH /api/tms/trips/:id` | Viajes (`PATCH` acepta `stopOrder`, unidad, chofer y salida mientras está planificado) |
| `POST /api/tms/trips/:id/start`, `POST …/:id/cancel`, `POST …/:id/stops/:stopId` | Iniciar, cancelar y marcar paradas a mano |
| `POST /api/tms/trips/evaluate` | Recalcular el seguimiento ahora |
| `GET /api/tms/active` | Viaje activo por unidad (ficha y monitoreo) |
| `GET /api/tms/orders/export`, `GET /api/tms/trips/export` | PDF, Excel y CSV (`format=pdf\|xlsx\|csv`) |
| `PATCH /api/tms/vehicles/:id/capacity` | Capacidad de carga de una unidad |

Los errores de asignación responden **409** con `{ error, check: { blocks, warnings }, needsOverride? }`.

## Datos

- **Migración** `006_tms.sql`: tablas `customers`, `places`, `transport_orders` y `trips`, con el mismo formato documento que el resto del estado.
- **Datos demo** (solo con `SEED_DEMO_DATA=true`): por empresa, 3 clientes, 6 lugares y 4 pedidos, y la capacidad de los camiones. Una instalación de producción arranca sin datos del TMS.

## Código

- `src/shared/tms.ts`: tipos y reglas puras (armado de paradas, detección por geocerca, validación de asignación).
- `src/shared/geo.ts`: distancia haversine y círculo de geocerca.
- `server/tms/service.ts` (`TmsService`), `server/tms/routes.ts`, `server/tms/reports.ts` y `server/tms/demo.ts`.
- `src/components/tms/`: `OperationsView`, `TripsPanel`, `OrdersPanel`, `CustomersPanel`, `PlacesPanel`, `TmsMap` y `UnitTmsPanel`.
- Pruebas: `tests/tms.test.ts`.

## Fase T2: entrega con evidencia

### App del chofer (`/chofer`)

**Acceso:**
- Un administrador (superadmin, admin de la empresa u `operaciones: full`) genera un **link personal** desde Choferes, con el ícono QR de cada fila.
- El chofer lo abre una vez (escaneando el QR o desde WhatsApp) y queda vinculado en su celular.
- **No hay usuario ni contraseña.**
- El link se muestra **una sola vez**, porque el servidor guarda solo el hash SHA-256 del token, nunca el token ni el hash viajan al navegador del panel.
- Generar otro link invalida el anterior, y «Revocar acceso» lo corta.
- Un chofer deshabilitado no puede entrar.
- El token va en el *hash* de la URL (`/chofer#t=…`), y la app lo borra de la barra de direcciones al guardarlo.

**Qué hace el chofer:**
- Ve sus viajes: planificados, en curso y los finalizados en las últimas 24 h. Nunca ve los viajes de otro chofer, que responden 404.
- Inicia el viaje, marca «Llegué», «Carga lista» y «Cómo llegar» (este último abre Google Maps).
- **Entrega**: pide firma en pantalla, nombre y DNI de quien recibe (obligatorios), hasta 3 fotos opcionales (que la app comprime a JPEG de 1280 px) y observaciones. Si el celular lo permite, se guarda la ubicación. El pedido queda **entregado** con la prueba.
- «No se pudo entregar o cargar»: la parada queda omitida, los pedidos vuelven a «Confirmado» y se crea un **incidente**.
- «Reportar una novedad» (avería, rechazo, faltante, demora, acceso u otra): se crea un **incidente** en Alertas e Incidentes, con prioridad según el tipo.

**Archivos:**
- Las firmas y fotos se guardan en la tabla `tms_files`, dentro de la base, así que el respaldo de la base las incluye (migración `007_tms_files.sql`).
- Se aceptan PNG y JPEG de hasta 3 MB. Un PNG se acepta solo si **realmente se puede decodificar**, porque un PNG falsificado podía colgar la generación del PDF.

### Seguimiento para el cliente (`/seguimiento/<token>`)

**Funcionamiento:**
- Cada pedido tiene un token de seguimiento aleatorio de 32 bytes.
- En Pedidos o en el detalle del viaje, el ícono de link copia la URL para mandarla por mail o WhatsApp.
- La página es **pública y de solo lectura**: no requiere iniciar sesión.

**Qué muestra:** el estado, el destino, la ventana horaria y un historial, y además:
- la posición de la unidad y una **hora estimada de llegada aproximada** (distancia en línea recta × 1,25 a 50 km/h). La ubicación aparece **solo mientras la unidad va hacia ese destino** y si reportó en los últimos 30 minutos;
- cuando el pedido se entregó, quién lo recibió y el comprobante en PDF para descargar.

**Qué nunca muestra:** datos del chofer ni otros pedidos.

**Límites:** las rutas públicas y las de la app tienen un límite de pedidos por IP.

### Documentos

- **Remito de transporte** (`/api/tms/orders/:id/remito.pdf`): cliente, transporte, origen, destino y carga.
  - Una vez entregado, suma la **conformidad**: quién recibió, DNI, fecha y hora, ubicación y la firma.
  - Si la firma no se puede dibujar en 8 s, el remito sale sin ella.
  - Es un documento interno de transporte: **no** reemplaza al remito ni a la factura fiscal (eso es T5).
- **Hoja de ruta** (`/api/tms/trips/:id/hoja-de-ruta.pdf`): el recorrido con sus ventanas y los pedidos del viaje.

### API de T2

| Ruta | Uso |
|---|---|
| `POST/DELETE /api/tms/drivers/:id/app-link` | Generar o revocar el link del chofer |
| `POST /api/tms/orders/:id/tracking-link` | Link público de seguimiento |
| `GET /api/tms/files/:id` | Firma o foto de una entrega (solo dentro de la empresa) |
| `GET /api/driver-app/me` | Chofer y sus viajes (encabezado `x-driver-token`) |
| `POST /api/driver-app/trips/:id/start`, `…/stops/:stopId/arrive`, `…/complete` (carga), `…/fail` | Acciones del chofer |
| `PUT /api/driver-app/trips/:id/files?kind=signature\|photo` | Subir firma o foto (cuerpo binario) |
| `POST /api/driver-app/trips/:id/stops/:stopId/deliver` | Entrega con prueba |
| `POST /api/driver-app/trips/:id/reports` | Novedad, que se registra como incidente |
| `GET /api/public/track/:token`, `GET /api/public/track/:token/remito.pdf` | Seguimiento público |

**Reglas:**
- Una descarga **no** se puede completar desde la app sin prueba de entrega.
- Desde el panel, o por la geocerca, sí se puede completar sin ella: queda registrado como «sin firma digital».

## Fase T3: costos, tarifas y facturación

Todos los importes están en la moneda de la empresa (ver `docs/MONEDAS.md`).

### Tarifario por cliente (Clientes → ícono de recibo)

**Modalidades:**
- **precio fijo por tramo**: de origen a destino, con la opción ida y vuelta;
- **por kilómetro**: la distancia se estima en línea recta × 1,25;
- **por tonelada**;
- **por pallet**.

km, tonelada y pallet admiten un mínimo por pedido. Para cada pedido se usa **la primera modalidad que aplique**, en el orden que se configure.

**Adicionales:**
- **estadía**: por hora iniciada, sobre la espera real en cada parada (salida − llegada) menos los minutos sin cargo;
- **recargos** por carga peligrosa y por frío, en %;
- **peajes** del viaje trasladados al cliente: los peajes aprobados se reparten entre los pedidos del viaje.

**Funcionamiento:**
- Cada cliente tiene **un tarifario activo**: activar uno desactiva el anterior.
- El **cotizador** aparece en el formulario del pedido y muestra el precio estimado en vivo.
- **Al entregarse un pedido se calcula su precio**: queda guardado con el desglose en `order.charge`.
- El precio se puede **ajustar a mano con un motivo**, que queda auditado, o **recalcular** con el tarifario.
- Un pedido que ya está en una pre-factura no cambia de precio.

### Combustible (Operaciones → Combustible)

**Cómo se registra:**
- **a mano** desde el panel;
- **desde la app del chofer**, con la foto del ticket;
- **importando el resumen** de la tarjeta de flota en CSV o Excel.

**Importación:**
- Las columnas se reconocen por su título: fecha, patente o dominio, litros, importe o precio, kilometraje y estación.
- Primero se ve una **vista previa** con los problemas de cada fila; las cargas repetidas no se duplican.

**Asignación al viaje:** cada carga se asigna sola al viaje de la unidad (hasta 30 min antes de iniciarse o después de terminar).

**Alertas de cada carga:**
- **Más litros que el tanque**: hay que cargar el tanque de la unidad en su ficha.
- **Odómetro incoherente**: es menor que en la carga anterior.
- **Consumo alto**: el rendimiento (L/100 km) es un 30 % peor que el habitual de la unidad, con al menos 3 mediciones previas.
- **El nivel del OBD no subió**: si la unidad tiene OBD y tanque cargado, se compara la suba del nivel en los 90 minutos alrededor de la carga contra los litros cargados.

### Gastos del viaje (Operaciones → Gastos)

**Tipos:** peaje, comida, alojamiento, estacionamiento, lavado u otro.

**Carga y aprobación:**
- El chofer los carga desde la app, con el ticket, y quedan **por aprobar**.
- Un administrador los aprueba o los rechaza con un motivo.
- Los que se cargan desde el panel con permiso de administrador quedan aprobados.

**Quién pagó:** se registra «Pagó el chofer» (se le reintegra) o «Pagó la empresa».

### Costo y rentabilidad (Operaciones → Rentabilidad y detalle del viaje)

**Costo del viaje:**
- **combustible**: las cargas del viaje o, si no hay, km × rendimiento habitual × último precio;
- **gastos aprobados**;
- **mantenimiento por km**: costo de mantenimiento de la unidad en los últimos 12 meses ÷ km de sus viajes en ese tiempo, solo si son al menos 1000 km;
- **horas del chofer**: costo mensual ÷ 176 h × horas del viaje.

**Km del viaje:** se toman del **odómetro al iniciar y al terminar**; sin lecturas, se estiman con las paradas.

**Rentabilidad:**
- Se calcula sobre los viajes finalizados del período, agrupada por cliente, viaje, unidad o chofer.
- En la vista por cliente, el costo de un viaje se reparte en proporción a lo que paga cada cliente.
- Se puede exportar.

**Costo mensual de cada chofer:** sueldo más cargas. Se carga desde Rentabilidad y lo pueden editar solo los administradores.

### Facturación (Operaciones → Facturación)

**Pre-factura por cliente y período:**
- Toma los pedidos **entregados, con precio y sin facturar**; los que no tienen precio quedan afuera, con aviso.
- Estados: borrador → emitida, o anulada. Anular libera los pedidos para volver a facturarlos.
- Se descarga en PDF, Excel o CSV.
- **No es un comprobante fiscal**: la factura electrónica de ARCA es T5.

**Liquidación de viáticos por chofer y período:**
- Suma los gastos aprobados que pagó el chofer.
- Estados: a pagar → pagada, o anulada.
- Se descarga en PDF, Excel o CSV.

### Permisos

| Acción | Quién |
|---|---|
| Consultar | `operaciones: read` |
| Cargar combustible y gastos, editar tarifarios y precios, crear pre-facturas y liquidaciones | `operaciones: write` |
| Aprobar gastos, emitir o anular pre-facturas, pagar o anular liquidaciones, editar el costo de los choferes | superadmin, admin de la empresa u `operaciones: full` |

### API de T3

| Ruta | Uso |
|---|---|
| `GET/POST /api/costs/tariffs`, `PUT /api/costs/tariffs/:id`, `POST /api/costs/quote` | Tarifarios y cotizador |
| `POST /api/costs/orders/:id/charge` | Precio manual (`amount` + `reason`) o `recalculate` |
| `GET/POST /api/costs/fuel`, `DELETE /api/costs/fuel/:id`, `POST /api/costs/fuel/import[?dryRun=true]`, `GET /api/costs/fuel/export` | Combustible |
| `GET/POST /api/costs/expenses`, `POST /api/costs/expenses/:id/review` | Gastos |
| `GET /api/costs/trips/:id`, `GET /api/costs/profitability[/export]` | Costo de un viaje y rentabilidad |
| `GET /api/costs/billable`, `GET/POST /api/costs/pre-invoices`, `POST …/:id/issue`, `POST …/:id/void`, `GET …/:id/export` | Pre-facturas |
| `GET/POST /api/costs/settlements`, `POST …/:id/pay`, `POST …/:id/void`, `GET …/:id/export` | Liquidaciones |
| `PUT /api/costs/drivers/:id/monthly-cost` | Costo mensual del chofer |
| `POST /api/driver-app/trips/:id/fuel`, `POST/GET /api/driver-app/trips/:id/expenses` | Desde la app del chofer |

**Datos:**
- Migración `008_costs.sql`: tablas `tariffs`, `fuel_loads`, `trip_expenses`, `pre_invoices` y `driver_settlements`.
- Los tickets van a `tms_files` con el tipo `receipt`.

## Fase T4: ruteo, planificador y despacho

El motor es **híbrido**: usa OSRM y VROOM si están configurados (ver [RUTEO.md](RUTEO.md)) y el motor propio si no. El encabezado de Operaciones indica cuál está activo.

**Optimizador propio** (`src/shared/routing.ts`):
- inserta cada pedido (carga → descarga) donde menos agrega;
- respeta que se cargue antes de descargar, la capacidad (kg y pallets), las ventanas horarias y una jornada de 14 h;
- después mejora reubicando paradas;
- con 8 paradas o menos, en un viaje, prueba todas las combinaciones válidas;
- prioriza **llegar a tiempo** y, en segundo lugar, los km.

**Tiempo de servicio:** cada lugar tiene su tiempo de carga o descarga (20 min si no se carga), que se usa en las rutas y en la hora estimada.

### Optimizar un viaje (detalle del viaje)

- Ver el trazado, los km y el tiempo, y la **hora estimada de cada parada**. En un viaje en curso, se calcula desde la posición de la unidad.
- **«Optimizar orden»** (viajes planificados): compara el orden actual con el propuesto (km, tiempo y paradas fuera de ventana) y lo aplica.

### Planificador del día (Operaciones → Planificador)

1. Elegí la salida, el depósito (o la posición actual de cada unidad), los pedidos confirmados y las unidades. Las no aptas aparecen deshabilitadas con el motivo: OT crítica, checklist «No apto» o ya asignada ese día.
2. **«Proponer viajes»**: una tarjeta por unidad con:
   - la secuencia y la hora de cada parada;
   - km, tiempo y a qué hora vuelve libre;
   - la ocupación de la carga;
   - el chofer sugerido: el de la unidad si está habilitado y libre, o el primero habilitado libre;
   - la validación de la asignación (bloqueos y advertencias).

   Los pedidos que no entran salen con el motivo: capacidad, ventana o sin lugar.
3. **«Crear N viajes»**: crea cada viaje en el orden propuesto. Si uno falla, los demás se crean igual.

### Tablero de despacho (Operaciones → Despacho)

- Línea de tiempo del día por unidad: barras de viaje por estado, demoras en rojo y la línea de «ahora».
- Las paradas aparecen como puntos: llenos si ya se hicieron, huecos si son estimados.
- Al costado, las unidades sin viajes. Al hacer clic en un viaje se abre su detalle.
- Se actualiza cada minuto.

### Hora estimada en vivo y «Demora prevista»

- Cada minuto, y con «Actualizar seguimiento», se recalcula la hora estimada de las paradas pendientes de los viajes en curso: desde la posición de la unidad, como mucho cada 2 minutos por viaje.
- Si una **descarga** va a llegar **después del cierre de su ventana**, se genera **una** alerta «Demora prevista» (`tms-eta-late`) **antes** de que la ventana venza, para avisar al cliente. La de T1, «Entrega demorada», sigue saliendo cuando la ventana ya venció.
- La página pública de seguimiento usa esta hora estimada.

### API de T4

| Ruta | Uso |
|---|---|
| `GET /api/routing/status` | Motor activo (`osrm+vroom`, `osrm`, `vroom` o `estimado`) |
| `POST /api/routing/trips/:id/optimize` | Propuesta de orden (no guarda; se aplica con `PATCH /api/tms/trips/:id { stopOrder }`) |
| `GET /api/routing/trips/:id/route` | Trazado, km, minutos y hora estimada por parada |
| `GET /api/routing/candidates?start=` | Unidades y choferes disponibles, con el motivo cuando no lo están |
| `POST /api/routing/plan` | Propuesta del día: `{ startTime, orderIds, vehicleIds, depotPlaceId? }` |
| `POST /api/routing/plan/apply` | Crea los viajes: `{ proposals: [{ vehicleId, driverId, plannedStart, orderIds, taskOrder, acceptWarnings? }] }` |
| `GET /api/routing/dispatch?from=&to=` | Tablero del período |

## Fase T5: factura electrónica, integraciones, portal del cliente y fleteros

### Factura electrónica ARCA (Operaciones → Facturación)

Una pre-factura **emitida** se convierte en factura electrónica con **«Facturar»**.

**Letra del comprobante:**

- emisor Responsable Inscripto: **A** si el cliente es RI, **B** en los demás casos;
- emisor Monotributo o Exento: **C**.

**Importes:** la pre-factura es el neto. A y B suman IVA (21 % por defecto, configurable); C no lo discrimina. En la nota de crédito, el comprobante asociado se informa a ARCA.

**Documento del receptor:**

| Dato del cliente | Se informa como |
|---|---|
| CUIT | CUIT (80) |
| DNI | DNI (96) |
| Sin documento | Consumidor final (99) |

Se informa también la condición frente al IVA del receptor (RG 5616).

**Comprobante:** el PDF incluye recuadro de letra, datos del emisor y receptor, detalle por pedido, CAE con vencimiento y **QR fiscal (RG 4892)**.

**Corrección:** una factura se corrige con **nota de crédito** por el total. La pre-factura queda libre para volver a facturarla o anularla. Mientras tenga una factura vigente, la pre-factura no se puede anular.

**Requisito:** la empresa debe operar en **pesos (ARS)**.

**Configuración** («Configurar ARCA», solo administradores):

1. Completar los datos del emisor: razón social, CUIT, domicilio, condición de IVA, punto de venta *Web Services*, Ingresos Brutos e inicio de actividades.
2. Generar el **pedido de certificado (CSR)**. La clave privada se crea en el servidor y **nunca se descarga**.
3. Subir el CSR a ARCA:
   - homologación: WSASS;
   - producción: «Administración de certificados digitales».
4. Asociar el certificado al servicio `wsfe`.
5. Pegar el certificado y usar **«Probar conexión»**, que hace el login WSAA y consulta los últimos números.

**Modos:**

| Modo | Cuándo | Comprobante |
|---|---|---|
| Simulado | Sin certificado | Mismo flujo, CAE ficticio, marca «SIN VALIDEZ FISCAL»; no se llama a ARCA |
| Homologación | Certificado cargado, entorno de pruebas (por defecto) | CAE real de prueba, sin validez fiscal |
| Producción | Se elige en la configuración | Comprobante válido |

**Seguridad:**

- El certificado y la clave se guardan cifrados con AES-256-GCM cuando el servidor tiene `SECRETS_KEY`: 64 caracteres hexadecimales, generados con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- El ticket de acceso de WSAA se reutiliza mientras está vigente.
- Si ARCA rechaza un comprobante, se muestra su mensaje (código y texto) y no se guarda nada.

### API pública y webhooks (Operaciones → Integraciones)

Solo administradores. Claves con permisos, `/api/v1` (pedidos con idempotencia, viajes, catálogo, facturas) y webhooks firmados con HMAC-SHA256 y reintentos.

Los eventos se detectan comparando el estado en cada guardado, así salen igual desde el panel, la app del chofer, el ruteo, la API o el portal.

Guía para integradores: [docs/API.md](API.md).

### Portal del cliente (`/portal`)

**Alta de accesos:** en **Clientes → ícono de personas**, la empresa da acceso por email. Se genera una **contraseña temporal** (se ve una vez, con texto listo para enviar) que el usuario cambia al entrar.

**Qué ve el cliente**, siempre solo lo suyo:

- sus pedidos: en curso, entregados, búsqueda;
- el historial de cada pedido y la hora estimada;
- el link al mapa de seguimiento;
- el **remito** (firmado, si ya se entregó);
- sus **facturas** con PDF.

**Pedidos nuevos:** el cliente puede cargar pedidos, que llegan como **borrador** para que la empresa los confirme. Solo elige entre los lugares propios y los compartidos de la empresa.

**Seguridad:**

- login y sesiones separados del panel, de 12 h de inactividad y 7 días máximo;
- bloqueo de 15 minutos tras 5 intentos fallidos;
- desactivar el acceso o restablecer la contraseña cierra las sesiones.

### Fleteros tercerizados (Operaciones → Fleteros)

**Ficha:** CUIT validado, contacto, vehículos (patente y capacidad) y documentación con vencimiento:

- seguro de carga;
- RUTA;
- RC;
- VTV;
- habilitación.

Sin seguro de carga o RUTA vigentes, un viaje solo se asigna si un administrador lo aprueba con motivo, y la aprobación queda auditada.

**Viaje con fletero:** «Asignar viaje» con patente, chofer, **precio pactado** y pedidos confirmados. Es un viaje normal: paradas, seguimiento, entrega con firma, remito, facturación y webhooks.

- **Costo:** es el precio pactado, más los gastos del viaje que pague la empresa.
- **Link por viaje:** desde el detalle del viaje se genera un link con QR o WhatsApp. Abre la app del chofer con **solo ese viaje**:
  - sin combustible ni gastos;
  - el celular **comparte su ubicación** mientras el viaje está abierto;
  - esa ubicación alimenta las llegadas automáticas, la hora estimada y el seguimiento del cliente.

  El link vence 24 h después de terminado el viaje o al revocarlo.
- **Calificación:** de 1 a 5 al cerrar el viaje. La ficha muestra el promedio y las entregas tarde.
- **Liquidaciones:** reúnen los viajes finalizados del período al precio pactado; se exportan en PDF, Excel o CSV. Al marcarla pagada se registra la referencia del pago. Anularla libera los viajes.
- **Tablero de despacho:** cada fletero tiene su fila.

### API de T5

| Método y ruta | Uso |
|---|---|
| `GET`/`PUT /api/billing/arca-config` | Configuración de ARCA (administradores) |
| `POST /api/billing/arca-config/csr` | Genera la clave y devuelve el CSR |
| `POST`/`DELETE /api/billing/arca-config/certificate` | Carga o quita el certificado (`{ certPem, keyPem? }`) |
| `POST /api/billing/arca-config/test` | Prueba de conexión |
| `POST /api/billing/pre-invoices/:id/invoice` | Factura una pre-factura emitida |
| `GET /api/billing/invoices` · `GET /api/billing/invoices/:id/pdf` | Comprobantes |
| `POST /api/billing/invoices/:id/credit-note` | Nota de crédito `{ reason }` |
| `GET /api/integrations` · `POST /api/integrations/api-keys` · `DELETE /api/integrations/api-keys/:id` | Claves |
| `POST`/`PATCH`/`DELETE /api/integrations/webhooks[/:id]` · `POST /…/:id/test` · `POST /…/:id/rotate-secret` · `GET /…/:id/deliveries` | Webhooks |
| `POST /api/integrations/deliveries/:id/redeliver` | Reenvío |
| `GET`/`POST /api/tms/customers/:id/portal-users` · `POST /api/tms/portal-users/:id/reset-password` · `PATCH /api/tms/portal-users/:id` | Accesos al portal |
| `/api/portal/*` | Portal (encabezado `x-portal-token`) |
| `GET`/`POST /api/carriers` · `PATCH /api/carriers/:id` | Fleteros |
| `POST /api/carriers/trips` · `PATCH /api/carriers/trips/:id` | Viaje con fletero; patente, chofer o precio |
| `POST`/`DELETE /api/carriers/trips/:id/link` · `POST /api/carriers/trips/:id/rating` | Link del viaje y calificación |
| `GET`/`POST /api/carriers/settlements` · `POST /…/:id/pay` · `POST /…/:id/void` · `GET /…/:id/export?format=` | Liquidaciones a fleteros |
| `POST /api/driver-app/position` | Posición del celular del fletero `{ lat, lng, accuracyM? }` |

**Datos:** migración `009_t5.sql` con las tablas `invoices`, `api_keys`, `webhooks`, `webhook_deliveries`, `portal_users`, `portal_sessions`, `carriers` y `carrier_settlements`. La configuración y los secretos de ARCA están en `app_settings`.

**Variables nuevas:**

| Variable | Uso |
|---|---|
| `SECRETS_KEY` | Cifrado del certificado de ARCA |
| `PUBLIC_APP_URL` | Dirección pública del panel, para los links de seguimiento en la API y los webhooks |

## Pendientes

- **COT** (ARBA y otras provincias) y **Carta de Porte electrónica** (granos): no incluidos en T5.
- Probar la factura con el certificado real de homologación y luego en producción.
- Probar el portal y el link del fletero con clientes y celulares reales.
