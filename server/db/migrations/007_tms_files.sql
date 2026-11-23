-- Pruebas de entrega del TMS: firmas (PNG) y fotos (JPEG/PNG) cargadas desde la app del chofer.
-- Viven en la misma base para que el respaldo (pg_dump) las incluya.
CREATE TABLE tms_files (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  trip_id    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('signature', 'photo')),
  mime       text NOT NULL,
  size       integer NOT NULL,
  sha256     text NOT NULL,
  data       bytea NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tms_files_tenant_trip_idx ON tms_files (tenant_id, trip_id);
