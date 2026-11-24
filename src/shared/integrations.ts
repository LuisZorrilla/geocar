/**
 * TMS T5: public API (keys with scopes) and outgoing webhooks.
 * Secrets are never stored in clear: API keys keep only their SHA-256, webhook secrets are sealed.
 */

export type ApiScope = 'orders:read' | 'orders:write' | 'trips:read' | 'catalog:read' | 'catalog:write' | 'invoices:read';

export const API_SCOPES: Record<ApiScope, string> = {
  'orders:read': 'Leer pedidos y su seguimiento',
  'orders:write': 'Crear y cancelar pedidos',
  'trips:read': 'Leer viajes, paradas y entregas',
  'catalog:read': 'Leer clientes y lugares',
  'catalog:write': 'Crear clientes y lugares',
  'invoices:read': 'Leer facturas y descargar su PDF',
};

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  /** First characters of the key, to recognize it ("gk_3f9a1c…"). */
  prefix: string;
  /** SHA-256 hex of the full key. */
  hash: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export type WebhookEvent =
  | 'order.created'
  | 'order.status_changed'
  | 'trip.created'
  | 'trip.status_changed'
  | 'stop.status_changed'
  | 'delivery.proof'
  | 'invoice.issued';

export const WEBHOOK_EVENTS: Record<WebhookEvent, string> = {
  'order.created': 'Pedido creado',
  'order.status_changed': 'Cambio de estado de un pedido',
  'trip.created': 'Viaje creado',
  'trip.status_changed': 'Viaje iniciado, finalizado o cancelado',
  'stop.status_changed': 'Llegada o salida de una parada',
  'delivery.proof': 'Entrega con firma (POD)',
  'invoice.issued': 'Factura o nota de crédito emitida',
};

export interface Webhook {
  id: string;
  tenantId: string;
  url: string;
  events: WebhookEvent[];
  description?: string;
  active: boolean;
  /** Sealed signing secret (server only; shown once at creation / rotation). */
  secret: { enc: boolean; data: string };
  /** Consecutive failed deliveries; the webhook is paused after WEBHOOK_PAUSE_AFTER. */
  failures: number;
  pausedReason?: string;
  lastDeliveryAt?: string;
  lastStatus?: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pendiente' | 'entregado' | 'fallido';

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  webhookId: string;
  event: WebhookEvent | 'ping';
  /** JSON body sent (kept to retry with the same content). */
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt?: string;
  responseStatus?: number | null;
  lastError?: string;
  durationMs?: number;
  createdAt: string;
  deliveredAt?: string;
}

/** Minutes to wait after each failed attempt; after the last one the delivery is "fallido". */
export const WEBHOOK_BACKOFF_MIN = [1, 5, 30, 120, 360];
export const WEBHOOK_PAUSE_AFTER = 20;

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = { pendiente: 'Pendiente', entregado: 'Entregado', fallido: 'Fallido' };
