-- Archivos de la documentación de choferes (licencia, LiNTI, psicofísico, etc.).
-- Viven en la misma base para que el respaldo (pg_dump) los incluya.
-- Un archivo por chofer y tipo de documento: reemplazar borra el anterior.
CREATE TABLE driver_files (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  driver_id   text NOT NULL,
  doc_type    text NOT NULL,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  sha256      text NOT NULL,
  data        bytea NOT NULL,
  uploaded_by text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, doc_type)
);

CREATE INDEX driver_files_tenant_driver_idx ON driver_files (tenant_id, driver_id);
