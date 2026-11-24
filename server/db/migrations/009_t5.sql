-- TMS T5: facturas electrónicas (ARCA), API pública y webhooks, portal del cliente y fleteros.
CREATE TABLE invoices            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE api_keys            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE webhooks            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE webhook_deliveries  (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portal_users        (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portal_sessions     (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE carriers            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE carrier_settlements (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX invoices_tenant_idx            ON invoices (tenant_id);
CREATE INDEX api_keys_tenant_idx            ON api_keys (tenant_id);
CREATE INDEX webhooks_tenant_idx            ON webhooks (tenant_id);
CREATE INDEX webhook_deliveries_tenant_idx  ON webhook_deliveries (tenant_id);
CREATE INDEX portal_users_tenant_idx        ON portal_users (tenant_id);
CREATE INDEX carriers_tenant_idx            ON carriers (tenant_id);
CREATE INDEX carrier_settlements_tenant_idx ON carrier_settlements (tenant_id);
