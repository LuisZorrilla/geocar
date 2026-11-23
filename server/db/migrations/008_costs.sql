-- TMS T3: tarifario por cliente, combustible, gastos de viaje, pre-facturas y liquidaciones de viáticos.
CREATE TABLE tariffs            (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE fuel_loads         (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE trip_expenses      (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pre_invoices       (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE driver_settlements (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX tariffs_tenant_idx            ON tariffs (tenant_id);
CREATE INDEX fuel_loads_tenant_idx         ON fuel_loads (tenant_id, (data->>'vehicleId'), (data->>'at'));
CREATE INDEX trip_expenses_tenant_idx      ON trip_expenses (tenant_id, (data->>'tripId'));
CREATE INDEX pre_invoices_tenant_idx       ON pre_invoices (tenant_id);
CREATE INDEX driver_settlements_tenant_idx ON driver_settlements (tenant_id);

-- Los tickets (foto) de combustible y gastos van a tms_files: se amplían los tipos permitidos.
ALTER TABLE tms_files DROP CONSTRAINT tms_files_kind_check;
ALTER TABLE tms_files ADD CONSTRAINT tms_files_kind_check CHECK (kind IN ('signature', 'photo', 'receipt'));
