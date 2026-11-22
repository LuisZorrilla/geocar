-- Monedas y tipos de cambio (los administra el superadmin).
-- Las cotizaciones se guardan como "unidades de la moneda por 1 USD"; los cruces se calculan.

CREATE TABLE currencies       (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE exchange_rates   (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE currency_changes (id text PRIMARY KEY, tenant_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX exchange_rates_currency_idx ON exchange_rates ((data->>'currency'), (data->>'effectiveAt') DESC);
CREATE INDEX currency_changes_tenant_idx ON currency_changes (tenant_id);

-- Monedas iniciales (el superadmin puede cambiar nombre, símbolo, decimales y habilitarlas).
INSERT INTO currencies (id, data) VALUES
  ('ARS', '{"id":"ARS","code":"ARS","name":"Peso argentino","symbol":"$","decimals":2,"locale":"es-AR","enabled":true,"sortOrder":1,"suggestSource":"dolarapi_ar_oficial","updatedAt":"2026-11-22T00:00:00.000Z"}'),
  ('VES', '{"id":"VES","code":"VES","name":"Bolívar venezolano","symbol":"Bs.","decimals":2,"locale":"es-VE","enabled":true,"sortOrder":2,"suggestSource":"dolarapi_ve_oficial","updatedAt":"2026-11-22T00:00:00.000Z"}'),
  ('USD', '{"id":"USD","code":"USD","name":"Dólar estadounidense","symbol":"US$","decimals":2,"locale":"es-AR","enabled":true,"sortOrder":3,"updatedAt":"2026-11-22T00:00:00.000Z"}'),
  ('CLP', '{"id":"CLP","code":"CLP","name":"Peso chileno","symbol":"CLP$","decimals":0,"locale":"es-CL","enabled":true,"sortOrder":4,"suggestSource":"mindicador_cl_dolar","updatedAt":"2026-11-22T00:00:00.000Z"}');

-- Moneda de cada empresa: NULL hasta que el superadmin la define (los importes existentes se conservan).
ALTER TABLE tenants
  ADD COLUMN currency           text REFERENCES currencies (id),
  ADD COLUMN reference_currency text NOT NULL DEFAULT 'USD' REFERENCES currencies (id);
