import type { PoolClient } from 'pg';
import type { FleetStoreState, ObdFaultEvent, ObdHistoryPoint, RoleDefinition, Tenant, UserAccount } from '../../src/shared/types.ts';
import { getPool } from './pool.ts';

/**
 * Hybrid persistence for FleetStore (Sprint 1).
 *
 * The in-memory FleetStoreState stays the source of truth for business logic.
 * This repository loads it from PostgreSQL at startup and writes back only the
 * rows that changed since the last save, inside a single transaction.
 */

type CollectionKey = Exclude<keyof FleetStoreState, 'schemaVersion' | 'sizing'>;

interface ColumnDef {
  name: string;
  /** Postgres type used in jsonb_to_recordset. */
  type: string;
}

interface TableDef<T = any> {
  key: CollectionKey;
  table: string;
  columns: ColumnDef[];
  toRow: (entity: T) => Record<string, unknown>;
  fromRow: (row: any) => T;
}

const documentTable = (key: CollectionKey, table: string): TableDef => ({
  key,
  table,
  columns: [
    { name: 'id', type: 'text' },
    { name: 'tenant_id', type: 'text' },
    { name: 'data', type: 'jsonb' },
  ],
  toRow: (e: { id: string; tenantId?: string }) => ({ id: e.id, tenant_id: e.tenantId ?? null, data: e }),
  fromRow: (r) => r.data,
});

const toIso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

const tenantsTable: TableDef<Tenant> = {
  key: 'tenants',
  table: 'tenants',
  columns: [
    { name: 'id', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'tax_id', type: 'text' },
    { name: 'city', type: 'text' },
    { name: 'branches', type: 'text[]' },
    { name: 'vehicle_quota', type: 'integer' },
    { name: 'retention_days', type: 'integer' },
    { name: 'plan_tier', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'contact_name', type: 'text' },
    { name: 'contact_email', type: 'text' },
    { name: 'contact_phone', type: 'text' },
    { name: 'created_at', type: 'timestamptz' },
    { name: 'currency', type: 'text' },
    { name: 'reference_currency', type: 'text' },
  ],
  toRow: (t) => ({
    id: t.id,
    name: t.name,
    tax_id: t.taxId,
    city: t.city,
    branches: t.branches,
    vehicle_quota: t.vehicleQuota,
    retention_days: t.retentionDays,
    plan_tier: t.planTier,
    status: t.status,
    contact_name: t.contactName ?? null,
    contact_email: t.contactEmail ?? null,
    contact_phone: t.contactPhone ?? null,
    created_at: t.createdAt ?? null,
    currency: t.currency ?? null,
    reference_currency: t.referenceCurrency ?? 'USD',
  }),
  fromRow: (r) => ({
    id: r.id,
    name: r.name,
    taxId: r.tax_id,
    city: r.city,
    branches: r.branches ?? [],
    vehicleQuota: r.vehicle_quota,
    retentionDays: r.retention_days,
    planTier: r.plan_tier,
    status: r.status,
    ...(r.contact_name ? { contactName: r.contact_name } : {}),
    ...(r.contact_email ? { contactEmail: r.contact_email } : {}),
    ...(r.contact_phone ? { contactPhone: r.contact_phone } : {}),
    ...(r.created_at ? { createdAt: toIso(r.created_at)! } : {}),
    currency: r.currency ?? null,
    referenceCurrency: r.reference_currency ?? 'USD',
  }),
};

const rolesTable: TableDef<RoleDefinition> = {
  key: 'roles',
  table: 'roles',
  columns: [
    { name: 'id', type: 'text' },
    { name: 'tenant_id', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'description', type: 'text' },
    { name: 'is_system_admin_role', type: 'boolean' },
    { name: 'permissions', type: 'jsonb' },
  ],
  toRow: (r) => ({
    id: r.id,
    tenant_id: r.tenantId,
    name: r.name,
    description: r.description ?? '',
    is_system_admin_role: Boolean(r.isSystemAdminRole),
    permissions: r.permissions,
  }),
  fromRow: (r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    isSystemAdminRole: r.is_system_admin_role,
    permissions: r.permissions,
  }),
};

const usersTable: TableDef<UserAccount> = {
  key: 'users',
  table: 'users',
  columns: [
    { name: 'id', type: 'text' },
    { name: 'tenant_id', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'username', type: 'text' },
    { name: 'password_hash', type: 'text' },
    { name: 'role_id', type: 'text' },
    { name: 'is_company_admin', type: 'boolean' },
    { name: 'is_hidden_superadmin', type: 'boolean' },
    { name: 'status', type: 'text' },
    { name: 'failed_attempts', type: 'integer' },
    { name: 'locked_until', type: 'timestamptz' },
    { name: 'created_at', type: 'timestamptz' },
    { name: 'must_change_password', type: 'boolean' },
  ],
  toRow: (u) => ({
    id: u.id,
    tenant_id: u.tenantId,
    name: u.name,
    username: u.username,
    password_hash: u.passwordHash,
    role_id: u.roleId,
    is_company_admin: u.isCompanyAdmin,
    is_hidden_superadmin: Boolean(u.isHiddenSuperadmin),
    status: u.status,
    failed_attempts: u.failedAttempts ?? 0,
    locked_until: u.lockedUntil ?? null,
    created_at: u.createdAt,
    must_change_password: Boolean(u.mustChangePassword),
  }),
  fromRow: (r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    username: r.username,
    passwordHash: r.password_hash,
    roleId: r.role_id,
    isCompanyAdmin: r.is_company_admin,
    isHiddenSuperadmin: r.is_hidden_superadmin,
    status: r.status,
    failedAttempts: r.failed_attempts,
    lockedUntil: toIso(r.locked_until),
    createdAt: toIso(r.created_at) ?? new Date().toISOString(),
    mustChangePassword: Boolean(r.must_change_password),
  }),
};

/** Order matters: parents before children on upsert, reverse on delete. */
const TABLES: TableDef[] = [
  documentTable('currencies', 'currencies'),
  documentTable('exchangeRates', 'exchange_rates'),
  tenantsTable,
  rolesTable,
  usersTable,
  documentTable('drivers', 'drivers'),
  documentTable('vehicles', 'vehicles'),
  documentTable('devices', 'devices'),
  documentTable('maintenanceRecords', 'maintenance_records'),
  documentTable('workOrders', 'work_orders'),
  documentTable('preventivePlans', 'preventive_plans'),
  documentTable('partsInventory', 'parts_inventory'),
  documentTable('checklists', 'checklists'),
  documentTable('dashcamDrivers', 'dashcam_drivers'),
  documentTable('alertRules', 'alert_rules'),
  documentTable('alerts', 'alerts'),
  documentTable('incidents', 'incidents'),
  documentTable('videoClips', 'video_clips'),
  documentTable('auditLogs', 'audit_logs'),
  documentTable('currencyChanges', 'currency_changes'),
  documentTable('customers', 'customers'),
  documentTable('places', 'places'),
  documentTable('transportOrders', 'transport_orders'),
  documentTable('trips', 'trips'),
  documentTable('tariffs', 'tariffs'),
  documentTable('fuelLoads', 'fuel_loads'),
  documentTable('tripExpenses', 'trip_expenses'),
  documentTable('preInvoices', 'pre_invoices'),
  documentTable('driverSettlements', 'driver_settlements'),
  documentTable('invoices', 'invoices'),
  documentTable('apiKeys', 'api_keys'),
  documentTable('webhooks', 'webhooks'),
  documentTable('webhookDeliveries', 'webhook_deliveries'),
  documentTable('portalUsers', 'portal_users'),
  documentTable('portalSessions', 'portal_sessions'),
  documentTable('carriers', 'carriers'),
  documentTable('carrierSettlements', 'carrier_settlements'),
];

export const ALL_TABLES = [...TABLES.map((t) => t.table), 'app_settings', 'sessions', 'driver_files', 'tms_files', 'obd_samples', 'obd_fault_events'];

export interface StoredSession {
  tokenHash: string;
  userId: string;
  tenantId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export class StateRepository {
  /** Last persisted JSON per collection/id, used to compute diffs. */
  private snapshot = new Map<string, Map<string, string>>();
  private sizingSnapshot = '';
  /** Last persisted id order per collection (array order is meaningful to the UI). */
  private orderSnapshot = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  async loadState(schemaVersion: number): Promise<FleetStoreState | null> {
    const pool = getPool();
    // A production install may start with only the superadmin and no tenants yet.
    const { rows: userCheck } = await pool.query('SELECT 1 FROM users LIMIT 1');
    if (userCheck.length === 0) return null;

    const { rows: orderRows } = await pool.query(`SELECT key, data FROM app_settings WHERE key LIKE 'order:%'`);
    const orders = new Map<string, string[]>(orderRows.map((r) => [r.key.slice('order:'.length), r.data]));

    const state: Partial<FleetStoreState> = { schemaVersion };
    for (const def of TABLES) {
      const { rows } = await pool.query(`SELECT * FROM ${def.table} ORDER BY id`);
      const order = orders.get(def.key) ?? [];
      const rank = new Map(order.map((id, i) => [id, i]));
      const entities = rows
        .map(def.fromRow)
        .sort(
          (a: { id: string }, b: { id: string }) =>
            (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        );
      this.orderSnapshot.set(def.key, JSON.stringify(entities.map((e: { id: string }) => e.id)));
      (state as any)[def.key] = entities;
      this.snapshot.set(def.key, new Map(entities.map((e: { id: string }) => [e.id, JSON.stringify(e)])));
    }
    const { rows: settings } = await pool.query(`SELECT data FROM app_settings WHERE key = 'sizing'`);
    state.sizing = settings[0]?.data;
    this.sizingSnapshot = JSON.stringify(state.sizing ?? null);
    return state as FleetStoreState;
  }

  /**
   * Enqueue a diff-based save. Saves run one at a time; the returned promise
   * resolves when this save (and every earlier one) is committed.
   */
  saveState(state: FleetStoreState): Promise<void> {
    // Serialize now so later in-memory mutations don't leak into this save.
    const pending = this.computeDiff(state);
    const run = this.queue.then(() => this.applyDiff(pending));
    // Keep the queue alive even if one save fails.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private computeDiff(state: FleetStoreState) {
    const upserts: Array<{ def: TableDef; rows: Record<string, unknown>[] }> = [];
    const deletes: Array<{ def: TableDef; ids: string[] }> = [];
    const nextSnapshot = new Map<string, Map<string, string>>();
    const orderChanges: Array<{ key: string; json: string }> = [];

    for (const def of TABLES) {
      const prev = this.snapshot.get(def.key) ?? new Map<string, string>();
      const next = new Map<string, string>();
      const changed: Record<string, unknown>[] = [];
      for (const entity of (state[def.key] as Array<{ id: string }>) ?? []) {
        const json = JSON.stringify(entity);
        next.set(entity.id, json);
        if (prev.get(entity.id) !== json) changed.push(def.toRow(JSON.parse(json)));
      }
      const removed = [...prev.keys()].filter((id) => !next.has(id));
      if (changed.length) upserts.push({ def, rows: changed });
      if (removed.length) deletes.push({ def, ids: removed });
      nextSnapshot.set(def.key, next);
      const orderJson = JSON.stringify([...next.keys()]);
      if (this.orderSnapshot.get(def.key) !== orderJson) {
        orderChanges.push({ key: def.key, json: orderJson });
        this.orderSnapshot.set(def.key, orderJson);
      }
    }

    const sizingJson = JSON.stringify(state.sizing ?? null);
    const sizing = sizingJson !== this.sizingSnapshot ? sizingJson : null;

    // Optimistically advance the snapshot; on failure it is reset (see applyDiff).
    this.snapshot = nextSnapshot;
    this.sizingSnapshot = sizingJson;
    return { upserts, deletes, sizing, orderChanges };
  }

  private async applyDiff(diff: ReturnType<StateRepository['computeDiff']>): Promise<void> {
    if (!diff.upserts.length && !diff.deletes.length && diff.sizing === null && !diff.orderChanges.length) return;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const { def, rows } of diff.upserts) await this.upsert(client, def, rows);
      for (const { def, ids } of [...diff.deletes].reverse()) {
        await client.query(`DELETE FROM ${def.table} WHERE id = ANY($1::text[])`, [ids]);
      }
      if (diff.sizing !== null) {
        await client.query(
          `INSERT INTO app_settings (key, data) VALUES ('sizing', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [diff.sizing]
        );
      }
      for (const { key, json } of diff.orderChanges) {
        await client.query(
          `INSERT INTO app_settings (key, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [`order:${key}`, json]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Force the next save to rewrite everything that may not have landed.
      this.snapshot = new Map();
      this.sizingSnapshot = '';
      this.orderSnapshot = new Map();
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsert(client: PoolClient, def: TableDef, rows: Record<string, unknown>[]): Promise<void> {
    const cols = def.columns.map((c) => c.name);
    const recordDef = def.columns.map((c) => `${c.name} ${c.type}`).join(', ');
    const updates = cols
      .filter((c) => c !== 'id')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .concat('updated_at = now()')
      .join(', ');
    const sql = `
      INSERT INTO ${def.table} (${cols.join(', ')})
      SELECT ${cols.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${recordDef})
      ON CONFLICT (id) DO UPDATE SET ${updates}`;
    for (let i = 0; i < rows.length; i += 500) {
      await client.query(sql, [JSON.stringify(rows.slice(i, i + 500))]);
    }
  }

  // ---- Sessions -----------------------------------------------------------

  async loadActiveSessions(): Promise<StoredSession[]> {
    const { rows } = await getPool().query(
      `SELECT token_hash, user_id, tenant_id, created_at, last_seen_at, expires_at
       FROM sessions WHERE expires_at > now()`
    );
    await getPool().query('DELETE FROM sessions WHERE expires_at <= now()');
    return rows.map((r) => ({
      tokenHash: r.token_hash,
      userId: r.user_id,
      tenantId: r.tenant_id,
      createdAt: new Date(r.created_at).getTime(),
      lastSeenAt: new Date(r.last_seen_at).getTime(),
      expiresAt: new Date(r.expires_at).getTime(),
    }));
  }

  async saveSession(s: StoredSession, meta: { ip?: string; userAgent?: string } = {}): Promise<void> {
    await getPool().query(
      `INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7, $8)`,
      [s.tokenHash, s.userId, s.tenantId, s.createdAt, s.lastSeenAt, s.expiresAt, meta.ip ?? null, meta.userAgent ?? null]
    );
  }

  async touchSession(tokenHash: string, lastSeenAt: number): Promise<void> {
    await getPool().query('UPDATE sessions SET last_seen_at = to_timestamp($2 / 1000.0) WHERE token_hash = $1', [
      tokenHash,
      lastSeenAt,
    ]);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    await getPool().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  // ---- Driver document files (kept out of the in-memory state) -------------

  /** Stores the file for a driver document, replacing any previous one. */
  async saveDriverFile(f: {
    id: string;
    tenantId: string;
    driverId: string;
    docType: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    data: Buffer;
    uploadedBy: string;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO driver_files (id, tenant_id, driver_id, doc_type, name, mime, size, sha256, data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (driver_id, doc_type) DO UPDATE SET
         id = EXCLUDED.id, tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, mime = EXCLUDED.mime,
         size = EXCLUDED.size, sha256 = EXCLUDED.sha256, data = EXCLUDED.data,
         uploaded_by = EXCLUDED.uploaded_by, created_at = now()`,
      [f.id, f.tenantId, f.driverId, f.docType, f.name, f.mime, f.size, f.sha256, f.data, f.uploadedBy]
    );
  }

  async getDriverFile(
    tenantId: string,
    driverId: string,
    docType: string
  ): Promise<{ name: string; mime: string; data: Buffer } | null> {
    const { rows } = await getPool().query(
      'SELECT name, mime, data FROM driver_files WHERE tenant_id = $1 AND driver_id = $2 AND doc_type = $3',
      [tenantId, driverId, docType]
    );
    return rows[0] ? { name: rows[0].name, mime: rows[0].mime, data: rows[0].data } : null;
  }

  async deleteDriverFile(tenantId: string, driverId: string, docType: string): Promise<void> {
    await getPool().query('DELETE FROM driver_files WHERE tenant_id = $1 AND driver_id = $2 AND doc_type = $3', [
      tenantId,
      driverId,
      docType,
    ]);
  }

  // ---- TMS proof-of-delivery files (signatures and photos) ------------------

  async saveTmsFile(f: { id: string; tenantId: string; tripId: string; kind: 'signature' | 'photo' | 'receipt'; mime: string; size: number; sha256: string; data: Buffer; createdBy: string }): Promise<void> {
    await getPool().query(
      `INSERT INTO tms_files (id, tenant_id, trip_id, kind, mime, size, sha256, data, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [f.id, f.tenantId, f.tripId, f.kind, f.mime, f.size, f.sha256, f.data, f.createdBy]
    );
  }

  async getTmsFile(tenantId: string, id: string): Promise<{ tripId: string; kind: string; mime: string; data: Buffer } | null> {
    const { rows } = await getPool().query('SELECT trip_id, kind, mime, data FROM tms_files WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    return rows[0] ? { tripId: rows[0].trip_id, kind: rows[0].kind, mime: rows[0].mime, data: rows[0].data } : null;
  }

  // ---- Global settings (single keys in app_settings) -------------------------

  async getAppSetting<T>(key: string): Promise<T | null> {
    const { rows } = await getPool().query('SELECT data FROM app_settings WHERE key = $1', [key]);
    return (rows[0]?.data as T) ?? null;
  }

  /** Stores a setting; null deletes it. */
  async setAppSetting(key: string, data: unknown | null): Promise<void> {
    if (data === null) {
      await getPool().query('DELETE FROM app_settings WHERE key = $1', [key]);
      return;
    }
    await getPool().query(
      `INSERT INTO app_settings (key, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [key, JSON.stringify(data)]
    );
  }

  // ---- OBD-II history (time series, kept out of the in-memory state) -------

  async insertObdSample(x: {
    tenantId: string;
    vehicleId: string;
    at: string;
    rpm?: number;
    coolantC?: number;
    fuelPct?: number;
    batteryV?: number;
    odometerKm?: number;
    speedKmh?: number;
  }): Promise<void> {
    await getPool().query(
      `INSERT INTO obd_samples (tenant_id, vehicle_id, at, rpm, coolant_c, fuel_pct, battery_v, odometer_km, speed_kmh)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [x.tenantId, x.vehicleId, x.at, x.rpm ?? null, x.coolantC ?? null, x.fuelPct ?? null, x.batteryV ?? null, x.odometerKm ?? null, x.speedKmh ?? null]
    );
  }

  /**
   * OBD fuel level around a fuel load: lowest level in the 90 min before and highest in the 90 min
   * after. Null when the unit has no OBD readings in either window.
   */
  async obdFuelAround(tenantId: string, vehicleId: string, atIso: string): Promise<{ before: number; after: number } | null> {
    const { rows } = await getPool().query(
      `SELECT
         (SELECT min(fuel_pct) FROM obd_samples WHERE tenant_id = $1 AND vehicle_id = $2 AND fuel_pct IS NOT NULL
             AND at BETWEEN $3::timestamptz - interval '90 minutes' AND $3::timestamptz) AS before,
         (SELECT max(fuel_pct) FROM obd_samples WHERE tenant_id = $1 AND vehicle_id = $2 AND fuel_pct IS NOT NULL
             AND at BETWEEN $3::timestamptz AND $3::timestamptz + interval '90 minutes') AS after`,
      [tenantId, vehicleId, atIso]
    );
    const r = rows[0];
    return r && r.before != null && r.after != null ? { before: Number(r.before), after: Number(r.after) } : null;
  }

  /** Averages per bucket (plus max temperature / min battery) between from and now. */
  async obdHistory(tenantId: string, vehicleId: string, fromIso: string, bucketSeconds: number): Promise<ObdHistoryPoint[]> {
    const { rows } = await getPool().query(
      `SELECT date_bin(make_interval(secs => $4), at, TIMESTAMPTZ '2000-01-01') AS bucket,
              avg(rpm) AS rpm, avg(coolant_c) AS coolant, avg(fuel_pct) AS fuel, avg(battery_v) AS battery,
              avg(speed_kmh) AS speed, max(coolant_c) AS coolant_max, min(battery_v) AS battery_min
         FROM obd_samples
        WHERE tenant_id = $1 AND vehicle_id = $2 AND at >= $3
        GROUP BY bucket
        ORDER BY bucket`,
      [tenantId, vehicleId, fromIso, bucketSeconds]
    );
    const num = (x: unknown, digits = 1) => (x == null ? null : Number(Number(x).toFixed(digits)));
    return rows.map((r: any) => ({
      at: new Date(r.bucket).toISOString(),
      rpm: num(r.rpm, 0),
      coolantC: num(r.coolant),
      fuelPct: num(r.fuel),
      batteryV: num(r.battery, 2),
      speedKmh: num(r.speed),
      coolantMaxC: num(r.coolant_max),
      batteryMinV: num(r.battery_min, 2),
    }));
  }

  async purgeObdSamples(olderThanIso: string): Promise<number> {
    const res = await getPool().query('DELETE FROM obd_samples WHERE at < $1', [olderThanIso]);
    return res.rowCount ?? 0;
  }

  async openObdFault(e: Omit<ObdFaultEvent, 'clearedAt'> & { tenantId: string }): Promise<void> {
    await getPool().query(
      `INSERT INTO obd_fault_events (id, tenant_id, vehicle_id, code, description, severity, system, opened_at, work_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.id, e.tenantId, e.vehicleId, e.code, e.description, e.severity, e.system, e.openedAt, e.workOrderId]
    );
  }

  /** Closes the open event of that unit and code. */
  async clearObdFault(vehicleId: string, code: string, clearedAt: string): Promise<void> {
    await getPool().query(
      'UPDATE obd_fault_events SET cleared_at = $3 WHERE vehicle_id = $1 AND code = $2 AND cleared_at IS NULL',
      [vehicleId, code, clearedAt]
    );
  }

  async listObdFaults(tenantId: string, vehicleId: string, limit = 100): Promise<ObdFaultEvent[]> {
    const { rows } = await getPool().query(
      `SELECT id, vehicle_id, code, description, severity, system, opened_at, cleared_at, work_order_id
         FROM obd_fault_events WHERE tenant_id = $1 AND vehicle_id = $2
        ORDER BY opened_at DESC LIMIT $3`,
      [tenantId, vehicleId, limit]
    );
    return rows.map((r: any) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      code: r.code,
      description: r.description,
      severity: r.severity,
      system: r.system,
      openedAt: new Date(r.opened_at).toISOString(),
      clearedAt: r.cleared_at ? new Date(r.cleared_at).toISOString() : null,
      workOrderId: r.work_order_id,
    }));
  }
}
