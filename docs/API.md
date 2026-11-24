# API pública y webhooks

Para conectar el ERP, la tienda online o el sistema de un cliente con GeoCar: crear y consultar pedidos, seguir viajes y entregas, descargar facturas, y recibir avisos al instante cuando algo cambia.

## Autenticación

Cada empresa crea sus claves en **Operaciones → Integraciones** (solo administradores). La clave se muestra **una sola vez**; GeoCar guarda únicamente su huella SHA-256.

```http
Authorization: Bearer gk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

También se acepta el encabezado `X-Api-Key: gk_…`. Cada clave:

- ve solo los datos de **su empresa**;
- tiene **permisos** propios:

| Permiso | Qué permite |
|---|---|
| `orders:read` | Leer pedidos y su seguimiento |
| `orders:write` | Crear y cancelar pedidos |
| `trips:read` | Leer viajes, paradas y entregas |
| `catalog:read` | Leer clientes y lugares |
| `catalog:write` | Crear clientes y lugares |
| `invoices:read` | Leer facturas y descargar su PDF |

- se revoca sin afectar a las demás.

**Límites:** 240 solicitudes por minuto por clave. Si se superan, la API responde `429`.

**Errores:** JSON `{ "error": "mensaje" }` con el código HTTP correspondiente:

| Código | Significado |
|---|---|
| `400` | Datos inválidos |
| `401` | Clave inválida o revocada |
| `403` | La clave no tiene el permiso |
| `404` | El recurso no existe o es de otra empresa |
| `409` | El estado no lo permite |

## Recursos

Base: `https://<tu-dominio>/api/v1`. Las listas devuelven `{ items, total, limit, offset }`; aceptan `limit` (máximo 200, por defecto 50) y `offset`.

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /` | cualquiera | Empresa, nombre y permisos de la clave |
| `GET /customers?q=` | `catalog:read` | Clientes |
| `POST /customers` | `catalog:write` | Alta: `{ name, taxId, taxCondition?, contacts?, notes? }` |
| `GET /places?q=` | `catalog:read` | Lugares (depósitos, plantas, clientes) con coordenadas y radio |
| `POST /places` | `catalog:write` | Alta: `{ name, kind, address, lat, lng, radiusM?, customerId? }` |
| `GET /orders?status=&reference=&customerId=&updatedSince=` | `orders:read` | Pedidos, los más recientes primero |
| `GET /orders/:id` | `orders:read` | Pedido, más su seguimiento (`events`, posición mientras va a destino, entrega) |
| `POST /orders` | `orders:write` | Alta de pedido (ver abajo) |
| `POST /orders/:id/cancel` | `orders:write` | `{ reason }` |
| `GET /trips?status=&updatedSince=` | `trips:read` | Viajes con paradas, horas estimadas y prueba de entrega |
| `GET /trips/:id` | `trips:read` | Un viaje |
| `GET /invoices?customerId=` | `invoices:read` | Facturas y notas de crédito con CAE |
| `GET /invoices/:id/pdf` | `invoices:read` | PDF con QR fiscal |

`kind` de un lugar: `deposito`, `planta`, `cliente`, `puerto` u `otro`.

`updatedSince` (ISO 8601) sirve para sincronizar incrementalmente: pedir solo lo que cambió desde la última consulta.

### Crear un pedido

```http
POST /api/v1/orders
Authorization: Bearer gk_…
Idempotency-Key: OC-7781
Content-Type: application/json

{
  "customerId": "cus-…",
  "originPlaceId": "plc-…",
  "destinationPlaceId": "plc-…",
  "cargo": { "description": "Bobinas", "weightKg": 1200, "pallets": 4, "dangerous": false, "refrigerated": false },
  "deliveryWindow": { "from": "2026-11-24T08:00:00-03:00", "to": "2026-11-24T12:00:00-03:00" },
  "reference": "OC-7781",
  "confirm": true
}
```

**Confirmación:**

- `confirm: true` crea el pedido confirmado, listo para planificar;
- sin `confirm`, el pedido queda en borrador para que la empresa lo revise.

**Idempotencia:** con `Idempotency-Key`, repetir la misma solicitud (por ejemplo, tras un corte de red) no duplica el pedido. Se recibe el mismo pedido con `200` y el encabezado `Idempotent-Replayed: true`.

**Seguimiento:** la respuesta incluye `trackingPath`, la página pública de seguimiento para el destinatario. `trackingUrl` trae la dirección completa cuando el servidor tiene `PUBLIC_APP_URL` configurado.

**Estados de un pedido:** `borrador` → `confirmado` → `planificado` → `en_curso` → `entregado`. También puede pasar a `cancelado`.

## Webhooks

En **Operaciones → Integraciones → Nuevo webhook** se indica una URL `https://` pública y los eventos a recibir. GeoCar envía un `POST` JSON por evento:

```json
{
  "id": "evt-3f9a1c0b2d4e5f60",
  "event": "order.status_changed",
  "createdAt": "2026-11-23T14:05:12.345Z",
  "data": { "id": "PED-2026-0042", "status": "entregado", "previousStatus": "en_curso", "...": "..." }
}
```

| Evento | Cuándo | `data` |
|---|---|---|
| `order.created` | Alta de un pedido (panel, API o portal) | Pedido |
| `order.status_changed` | Cambio de estado | Pedido + `previousStatus` |
| `trip.created` | Viaje planificado (unidad propia o fletero) | Viaje |
| `trip.status_changed` | Iniciado, finalizado o cancelado | Viaje + `previousStatus` |
| `stop.status_changed` | Llegada, salida u omisión de una parada | `{ tripId, stop, previousStatus }` |
| `delivery.proof` | Entrega firmada desde la app | `{ tripId, stopId, orderIds, receiverName, receiverDni, at, lat, lng, photos }` |
| `invoice.issued` | Factura o nota de crédito emitida | Comprobante |

Encabezados de cada envío:

| Encabezado | Contenido |
|---|---|
| `X-GeoCar-Event` | El evento (`ping` en la prueba) |
| `X-GeoCar-Delivery` | Id único del envío; sirve para descartar repetidos |
| `X-GeoCar-Signature` | `t=<unix>,v1=<hex>`, donde `v1 = HMAC-SHA256(secreto, "<t>.<cuerpo>")` |

### Verificar la firma (Node.js)

```js
import crypto from 'node:crypto';

function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}
```

Usá el cuerpo **tal como llegó** (sin volver a serializarlo). El secreto (`whsec_…`) se ve una sola vez al crear o renovar el webhook.

### Entrega y reintentos

**Respuesta esperada:** el receptor responde `2xx` en menos de 10 segundos. Conviene encolar el trabajo y responder enseguida.

**Reintentos:** cualquier otra respuesta, o un error de conexión, se reintenta a los 1, 5, 30, 120 y 360 minutos. Después queda como **fallido** y se puede reenviar a mano.

**Orden:** los envíos a un mismo webhook salen en orden; si uno falla, los siguientes esperan.

**Pausa automática:** tras 20 fallas seguidas, el webhook se pausa. Al reactivarlo se envía lo pendiente.

**Direcciones bloqueadas:** por seguridad, no se envía a direcciones internas: localhost, redes privadas, link-local ni metadatos de nube. La URL se valida al guardarla y la IP resuelta, en cada envío.

Para desarrollo local, `WEBHOOKS_ALLOW_PRIVATE=true` permite `http://` y redes internas. **Nunca en producción.**
