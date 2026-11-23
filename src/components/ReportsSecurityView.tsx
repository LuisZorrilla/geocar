import { useState } from 'react';
import { FileSpreadsheet, History, Plus, Shield, UserPlus, Users } from 'lucide-react';
import type {
  AlertEvent,
  AuditLog,
  Incident,
  ModulePermissions,
  PermissionLevel,
  PublicUser,
  RoleDefinition,
  Tenant,
  Vehicle,
  VideoClip,
} from '../shared/types.ts';
import { formatTimeClock, PERMISSION_LABELS } from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { ExportMenu } from './ExportMenu.tsx';

interface ReportsSecurityViewProps {
  tenant: Tenant;
  availableTenants?: Tenant[];
  activeScopeTenantId?: string;
  currentUser: PublicUser;
  vehicles: Vehicle[];
  alerts: AlertEvent[];
  incidents: Incident[];
  videoClips: VideoClip[];
  roles: RoleDefinition[];
  users: PublicUser[];
  auditLogs: AuditLog[];
  activeRole: RoleDefinition;
  onSwitchScope?: (tenantId: string) => void;
  onCreateRole: (payload: { tenantId?: string; name: string; description: string; permissions: ModulePermissions }) => Promise<void>;
  onUpdateRole: (roleId: string, payload: { permissions: ModulePermissions }) => Promise<void>;
  onCreateUser: (payload: { tenantId?: string; name: string; username: string; password: string; roleId: string }) => Promise<void>;
  onUpdateUser: (userId: string, patch: { roleId?: string; status?: 'activo' | 'inactivo' }) => Promise<void>;
}

const MODULE_ROWS: Array<{ key: keyof ModulePermissions; label: string }> = [
  { key: 'administracion', label: 'Administración (Usuarios y perfiles)' },
  { key: 'flotas', label: 'Flotas, maquinaria y mantenimiento' },
  { key: 'operaciones', label: 'Operaciones (clientes, pedidos y viajes)' },
  { key: 'dispositivos', label: 'Dispositivos (GPS, IMEI, JT808/JT1078)' },
  { key: 'dashcams_config', label: 'Configuración de Dashcams y Drivers' },
  { key: 'monitoreo', label: 'Monitoreo en mapa Esri' },
  { key: 'alertas', label: 'Alertas y motor de reglas' },
  { key: 'incidentes', label: 'Incidentes y resolución' },
  { key: 'video', label: 'Consola de video dashcam y retención' },
  { key: 'reportes', label: 'Reportes y exportación CSV' },
  { key: 'dimensionamiento', label: 'Dimensionamiento e infraestructura' },
];

const DEFAULT_PERMISSIONS: ModulePermissions = {
  administracion: 'none',
  flotas: 'read',
  dispositivos: 'read',
  dashcams_config: 'none',
  monitoreo: 'full',
  alertas: 'write',
  incidentes: 'write',
  video: 'read',
  reportes: 'read',
  dimensionamiento: 'none',
  operaciones: 'read',
};

export function ReportsSecurityView({
  tenant,
  availableTenants,
  activeScopeTenantId,
  currentUser,
  vehicles,
  alerts,
  incidents,
  videoClips,
  roles,
  users,
  auditLogs,
  activeRole,
  onSwitchScope,
  onCreateRole,
  onUpdateRole,
  onCreateUser,
  onUpdateUser,
}: ReportsSecurityViewProps) {
  const defaultTargetTenantId = tenant.id === 'all' ? (availableTenants?.[0]?.id ?? 'ten-norte') : tenant.id;
  const [targetTenantId, setTargetTenantId] = useState(defaultTargetTenantId);

  const [showNewRole, setShowNewRole] = useState(false);
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [rolePerms, setRolePerms] = useState<ModulePermissions>(DEFAULT_PERMISSIONS);
  const [savingRole, setSavingRole] = useState(false);

  const [showNewUser, setShowNewUser] = useState(false);
  const [userForm, setUserForm] = useState({
    name: '',
    username: '',
    password: '',
    roleId: roles.find((r) => !r.isSystemAdminRole)?.id ?? roles[0]?.id ?? '',
  });
  const [savingUser, setSavingUser] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);

  const isCompanyAdmin = currentUser.isCompanyAdmin || activeRole.permissions.administracion === 'full';
  const tenantNameMap = new Map((availableTenants ?? [tenant]).map((t) => [t.id, t.name]));
  const effectiveTenantForForms = tenant.id === 'all' ? targetTenantId : tenant.id;
  const rolesForSelectedFormTenant = roles.filter((r) => r.tenantId === effectiveTenantForForms);

  const modulesPagination = usePagination(MODULE_ROWS, tenant.id, 5);
  const usersPagination = usePagination(users, `${tenant.id}|${users.length}`, 5);
  const auditPagination = usePagination(auditLogs, `${tenant.id}|${auditLogs.length}`, 5);

  const totalStorageMb = videoClips.reduce((sum, c) => sum + c.sizeMb, 0);
  const resolvedCount = incidents.filter((i) => i.status === 'resuelto').length;
  const availabilityPct =
    vehicles.length > 0
      ? Math.round(
          (vehicles.filter((v) => v.operationalStatus !== 'sin_senal').length / vehicles.length) * 100
        )
      : 100;
  const maintAlertCount = vehicles.filter((v) => v.maintenanceStatus !== 'al_dia').length;

  const handleCreateRoleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecError(null);
    if (!roleName.trim()) {
      setSecError('Indica el nombre del nuevo perfil.');
      return;
    }
    setSavingRole(true);
    try {
      await onCreateRole({
        tenantId: effectiveTenantForForms,
        name: roleName,
        description: roleDesc,
        permissions: rolePerms,
      });
      setRoleName('');
      setRoleDesc('');
      setRolePerms(DEFAULT_PERMISSIONS);
      setShowNewRole(false);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : 'Error al crear perfil.');
    } finally {
      setSavingRole(false);
    }
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecError(null);
    if (!userForm.name.trim() || !userForm.username.trim()) {
      setSecError('Nombre y usuario de acceso son obligatorios.');
      return;
    }
    const chosenRoleId =
      rolesForSelectedFormTenant.find((r) => r.id === userForm.roleId)?.id ??
      rolesForSelectedFormTenant[0]?.id ??
      userForm.roleId;
    setSavingUser(true);
    try {
      await onCreateUser({ ...userForm, tenantId: effectiveTenantForForms, roleId: chosenRoleId });
      setUserForm((p) => ({ ...p, name: '', username: '', password: '' }));
      setShowNewUser(false);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : 'Error al crear usuario.');
    } finally {
      setSavingUser(false);
    }
  };

  const handleCyclePermission = async (role: RoleDefinition, key: keyof ModulePermissions) => {
    if (!isCompanyAdmin || role.isSystemAdminRole) return;
    const order: PermissionLevel[] = ['none', 'read', 'write', 'full'];
    const next = order[(order.indexOf(role.permissions[key]) + 1) % order.length];
    await onUpdateRole(role.id, {
      permissions: { ...role.permissions, [key]: next },
    });
  };

  return (
    <div className="space-y-6">
      {/* Company Executive Operational Indicators + CSV Export */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-sky-400" />
              Indicadores operativos de {tenant.name}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Información exclusiva de tu empresa · {tenant.city} · Retención de video: {tenant.retentionDays} días
            </p>
          </div>
          <ExportMenu url="/api/reports/export" label="Exportar reporte de flota" count={vehicles.length} fileName="flota" />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
          <div className="p-3.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
            <div className="text-xs text-slate-400">Disponibilidad GPS/Dashcam</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-emerald-400 mt-1">
              {availabilityPct}%
            </div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
            <div className="text-xs text-slate-400">Mantenimiento por atender</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-amber-400 mt-1">
              {maintAlertCount} / {vehicles.length}
            </div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
            <div className="text-xs text-slate-400">Incidentes resueltos</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-sky-400 mt-1">
              {resolvedCount} / {incidents.length}
            </div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#0B1120] border border-slate-800/80">
            <div className="text-xs text-slate-400">Evidencia S3/MinIO ({alerts.length} alertas)</div>
            <div className="text-xl font-semibold font-mono tabular-nums text-slate-100 mt-1">
              {totalStorageMb.toFixed(1)} MB
            </div>
          </div>
        </div>
      </div>

      {secError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {secError}
        </div>
      )}

      {/* Company Admin: Custom Profiles & Permissions Matrix */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Shield className="w-4 h-4 text-sky-400" />
              Perfiles y permisos de {tenant.name}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {isCompanyAdmin
                ? 'Como Admin de Empresa puedes crear nuevos perfiles y hacer clic en cualquier celda de permiso para ajustarlo.'
                : `Tu perfil actual (${activeRole.name}) es de consulta en administración de permisos.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {availableTenants && onSwitchScope && (
              <select
                value={activeScopeTenantId ?? 'all'}
                onChange={(e) => onSwitchScope(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg text-xs bg-[#0B1120] border border-slate-700 text-slate-200 cursor-pointer"
              >
                <option value="all">Todas las empresas</option>
                {availableTenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            {isCompanyAdmin && (
              <button
                type="button"
                onClick={() => setShowNewRole((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {showNewRole ? 'Cancelar perfil' : 'Crear nuevo perfil'}
              </button>
            )}
          </div>
        </div>

        {showNewRole && isCompanyAdmin && (
          <form onSubmit={handleCreateRoleSubmit} className="p-5 bg-[#0B1120] border-b border-slate-800 space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {availableTenants && tenant.id === 'all' && (
                <div>
                  <label className="block text-slate-300 mb-1">Empresa destino</label>
                  <select
                    value={targetTenantId}
                    onChange={(e) => setTargetTenantId(e.target.value)}
                    className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                  >
                    {availableTenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-slate-300 mb-1">Nombre del perfil</label>
                <input
                  type="text"
                  placeholder="Ej. Supervisor Nocturno o Jefe de Taller"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-300 mb-1">Descripción operativa</label>
                <input
                  type="text"
                  placeholder="Alcance del perfil dentro de la empresa"
                  value={roleDesc}
                  onChange={(e) => setRoleDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {MODULE_ROWS.map((m) => (
                <div key={m.key} className="p-2.5 rounded-lg bg-[#11192C] border border-slate-800/80 flex items-center justify-between gap-2">
                  <span className="text-slate-300 truncate">{m.label.split(' (')[0]}</span>
                  <select
                    value={rolePerms[m.key]}
                    onChange={(e) =>
                      setRolePerms((prev) => ({ ...prev, [m.key]: e.target.value as PermissionLevel }))
                    }
                    className="px-2 py-1 bg-[#0B1120] border border-slate-700 rounded text-slate-100"
                  >
                    <option value="none">Sin acceso</option>
                    <option value="read">Solo lectura</option>
                    <option value="write">Operación</option>
                    <option value="full">Control total</option>
                  </select>
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingRole}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
              >
                {savingRole ? 'Guardando perfil...' : 'Guardar perfil personalizado'}
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                <th className="py-3 px-4">Módulo operativo</th>
                {roles.map((r) => (
                  <th
                    key={r.id}
                    className={`py-3 px-4 ${r.id === activeRole.id ? 'text-sky-300 bg-sky-500/5' : ''}`}
                  >
                    <div>{r.name}{r.id === activeRole.id ? ' (Tu perfil)' : ''}</div>
                    {tenant.id === 'all' && (
                      <div className="text-[11px] font-normal text-slate-500">
                        {tenantNameMap.get(r.tenantId) ?? r.tenantId}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {modulesPagination.pagedItems.map((row) => (
                <tr key={row.key} className="hover:bg-slate-800/20">
                  <td className="py-2.5 px-4 text-slate-200">{row.label}</td>
                  {roles.map((r) => {
                    const lvl = r.permissions[row.key];
                    const meta = PERMISSION_LABELS[lvl];
                    const editable = isCompanyAdmin && !r.isSystemAdminRole;
                    return (
                      <td
                        key={`${row.key}-${r.id}`}
                        className={`py-2.5 px-4 ${r.id === activeRole.id ? 'bg-sky-500/5' : ''}`}
                      >
                        {editable ? (
                          <button
                            type="button"
                            onClick={() => handleCyclePermission(r, row.key)}
                            title="Clic para alternar permiso"
                            className={`font-medium underline-offset-4 hover:underline cursor-pointer ${meta.colorClass}`}
                          >
                            {meta.label}
                          </button>
                        ) : (
                          <span className={`font-medium ${meta.colorClass}`}>{meta.label}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          page={modulesPagination.page}
          totalItems={modulesPagination.totalItems}
          pageSize={5}
          onPageChange={modulesPagination.setPage}
        />
      </div>

      {/* Company Users Directory (Superadmin NEVER listed) */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Users className="w-4 h-4 text-sky-400" />
              Usuarios de {tenant.name} ({users.length})
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Solo se muestran usuarios pertenecientes a esta empresa.
            </p>
          </div>
          {isCompanyAdmin && (
            <button
              type="button"
              onClick={() => setShowNewUser((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {showNewUser ? 'Cancelar' : 'Nuevo usuario'}
            </button>
          )}
        </div>

        {showNewUser && isCompanyAdmin && (
          <form onSubmit={handleCreateUserSubmit} className="p-4 bg-[#0B1120] border-b border-slate-800 grid grid-cols-1 sm:grid-cols-6 gap-3 text-xs">
            {availableTenants && tenant.id === 'all' && (
              <select
                value={targetTenantId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setTargetTenantId(nextId);
                  const firstRole = roles.find((r) => r.tenantId === nextId);
                  if (firstRole) setUserForm((p) => ({ ...p, roleId: firstRole.id }));
                }}
                className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
              >
                {availableTenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <input
              type="text"
              placeholder="Nombre completo"
              value={userForm.name}
              onChange={(e) => setUserForm((p) => ({ ...p, name: e.target.value }))}
              className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
            />
            <input
              type="text"
              placeholder="Usuario (ej. operador.norte)"
              value={userForm.username}
              onChange={(e) => setUserForm((p) => ({ ...p, username: e.target.value }))}
              className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
            />
            <input
              type="password"
              placeholder="Contraseña inicial (mín. 10, letras y números)"
              autoComplete="new-password"
              value={userForm.password}
              onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))}
              className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
            />
            <select
              value={userForm.roleId}
              onChange={(e) => setUserForm((p) => ({ ...p, roleId: e.target.value }))}
              className="px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
            >
              {rolesForSelectedFormTenant.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={savingUser}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
            >
              {savingUser ? 'Creando...' : 'Crear usuario'}
            </button>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-4">Nombre</th>
                <th className="py-2.5 px-4">Usuario de acceso</th>
                <th className="py-2.5 px-4">Perfil asignado</th>
                <th className="py-2.5 px-4">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {usersPagination.pagedItems.map((u) => {
                const userTenantRoles = roles.filter((r) => r.tenantId === u.tenantId);
                return (
                <tr key={u.id} className="hover:bg-slate-800/20">
                  <td className="py-2.5 px-4 font-medium text-slate-100">
                    <div>{u.name} {u.id === currentUser.id ? <span className="text-sky-400">(Tú)</span> : null}</div>
                    {tenant.id === 'all' && (
                      <div className="text-[11px] font-normal text-slate-500">
                        {tenantNameMap.get(u.tenantId) ?? u.tenantId}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-300">{u.username}</td>
                  <td className="py-2.5 px-4">
                    {isCompanyAdmin && u.id !== currentUser.id ? (
                      <select
                        value={u.roleId}
                        onChange={(e) => onUpdateUser(u.id, { roleId: e.target.value })}
                        className="px-2 py-1 bg-[#0B1120] border border-slate-800 rounded text-slate-200"
                      >
                        {userTenantRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-sky-300">{u.roleName}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4">
                    {isCompanyAdmin && u.id !== currentUser.id ? (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateUser(u.id, { status: u.status === 'activo' ? 'inactivo' : 'activo' })
                        }
                        className={`font-medium cursor-pointer ${
                          u.status === 'activo' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {u.status === 'activo' ? 'Activo' : 'Inactivo'}
                      </button>
                    ) : (
                      <span className="text-emerald-400 font-medium">Activo</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination
          page={usersPagination.page}
          totalItems={usersPagination.totalItems}
          pageSize={5}
          onPageChange={usersPagination.setPage}
        />
      </div>

      {/* Immutable Audit Trail */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800/80 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <History className="w-4 h-4 text-sky-400" />
            Bitácora de auditoría de {tenant.name}
          </h3>
          <span className="text-xs font-mono tabular-nums text-slate-400">{auditLogs.length} registros</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-4">Hora</th>
                <th className="py-2.5 px-4">Usuario / Perfil</th>
                <th className="py-2.5 px-4">Módulo y Acción</th>
                <th className="py-2.5 px-4">Objetivo</th>
                <th className="py-2.5 px-4">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {auditPagination.pagedItems.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/20">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                    {formatTimeClock(log.timestamp)}
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="text-slate-200 font-medium">{log.actorName}</div>
                    <div className="text-slate-500">{log.actorRole}</div>
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="text-sky-300">{log.module}</div>
                    <div className="text-slate-300">{log.action}</div>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-300">{log.targetLabel}</td>
                  <td className="py-2.5 px-4 text-slate-400">{log.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          page={auditPagination.page}
          totalItems={auditPagination.totalItems}
          pageSize={5}
          onPageChange={auditPagination.setPage}
        />
      </div>
    </div>
  );
}
