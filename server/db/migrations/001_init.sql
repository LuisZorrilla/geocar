-- Sprint 1: esquema híbrido.
-- Tablas normalizadas para identidad y seguridad; tablas documento (jsonb) para el resto,
-- que se normalizarán de forma incremental.

CREATE TABLE tenants (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  tax_id         text NOT NULL,
  city           text NOT NULL,
  branches       text[] NOT NULL DEFAULT '{}',
  vehicle_quota  integer NOT NULL,
  retention_days integer NOT NULL,
  plan_tier      text NOT NULL,
  status         text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id                   text PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  description          text NOT NULL DEFAULT '',
  is_system_admin_role boolean NOT NULL DEFAULT false,
  permissions          jsonb NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roles_tenant_idx ON roles (tenant_id);

CREATE TABLE users (
  id                   text PRIMARY KEY,
  tenant_id            text NOT NULL,
  name                 text NOT NULL,
  username             text NOT NULL,
  password_hash        text NOT NULL,
  role_id              text NOT NULL,
  is_company_admin     boolean NOT NULL DEFAULT false,
  is_hidden_superadmin boolean NOT NULL DEFAULT false,
  status               text NOT NULL,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uidx ON users (lower(username));
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    text NOT NULL,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Tablas documento
CREATE TABLE vehicles            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE devices             (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE drivers             (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE maintenance_records (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE work_orders         (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE preventive_plans    (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE parts_inventory     (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE checklists          (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE dashcam_drivers     (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE alert_rules         (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE alerts              (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE incidents           (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE video_clips         (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_logs          (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX vehicles_tenant_idx            ON vehicles (tenant_id);
CREATE INDEX devices_tenant_idx             ON devices (tenant_id);
CREATE INDEX drivers_tenant_idx             ON drivers (tenant_id);
CREATE INDEX maintenance_records_tenant_idx ON maintenance_records (tenant_id);
CREATE INDEX work_orders_tenant_idx         ON work_orders (tenant_id);
CREATE INDEX preventive_plans_tenant_idx    ON preventive_plans (tenant_id);
CREATE INDEX parts_inventory_tenant_idx     ON parts_inventory (tenant_id);
CREATE INDEX checklists_tenant_idx          ON checklists (tenant_id);
CREATE INDEX alert_rules_tenant_idx         ON alert_rules (tenant_id);
CREATE INDEX alerts_tenant_idx              ON alerts (tenant_id);
CREATE INDEX incidents_tenant_idx           ON incidents (tenant_id);
CREATE INDEX video_clips_tenant_idx         ON video_clips (tenant_id);
CREATE INDEX audit_logs_tenant_idx          ON audit_logs (tenant_id);

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
