-- Alta de empresas desde el panel (asistente del superadmin).
ALTER TABLE tenants
  ADD COLUMN contact_name  text,
  ADD COLUMN contact_email text,
  ADD COLUMN contact_phone text,
  ADD COLUMN created_at    timestamptz;

-- Contraseñas temporales: el usuario debe cambiarla en su primer ingreso.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Un mismo dato fiscal (CUIT) no puede registrarse dos veces, con o sin guiones.
CREATE UNIQUE INDEX tenants_tax_id_uidx ON tenants (upper(replace(tax_id, '-', '')));
