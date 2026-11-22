-- Historial de telemetría OBD-II: una muestra por unidad cada 60 s como máximo (90 días).
CREATE TABLE obd_samples (
  tenant_id   text NOT NULL,
  vehicle_id  text NOT NULL,
  at          timestamptz NOT NULL,
  rpm         real,
  coolant_c   real,
  fuel_pct    real,
  battery_v   real,
  odometer_km real,
  speed_kmh   real
);

CREATE INDEX obd_samples_vehicle_at_idx ON obd_samples (vehicle_id, at);
CREATE INDEX obd_samples_at_idx ON obd_samples (at);

-- Historial de códigos de falla: cuándo apareció y cuándo se borró cada código.
CREATE TABLE obd_fault_events (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  vehicle_id    text NOT NULL,
  code          text NOT NULL,
  description   text NOT NULL,
  severity      text NOT NULL,
  system        text NOT NULL,
  opened_at     timestamptz NOT NULL,
  cleared_at    timestamptz,
  work_order_id text
);

CREATE INDEX obd_fault_events_vehicle_idx ON obd_fault_events (vehicle_id, opened_at DESC);
