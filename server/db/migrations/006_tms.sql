-- TMS: clientes, lugares (con geocerca circular), pedidos de transporte y viajes.
-- Mismo formato documento que el resto del estado (data jsonb por entidad).

CREATE TABLE customers        (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE places           (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE transport_orders (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE trips            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX customers_tenant_idx        ON customers (tenant_id);
CREATE INDEX places_tenant_idx           ON places (tenant_id);
CREATE INDEX transport_orders_tenant_idx ON transport_orders (tenant_id, (data->>'status'));
CREATE INDEX trips_tenant_idx            ON trips (tenant_id, (data->>'status'));
