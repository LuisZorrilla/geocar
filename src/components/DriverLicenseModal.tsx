import { useEffect, useState } from 'react';
import { History, IdCard, ShieldAlert, X } from 'lucide-react';
import type { Driver, LicenseCategory, Tenant } from '../shared/types.ts';
import { formatServiceDate, LICENSE_CATEGORIES, LICENSE_STATUS_META } from '../lib/api.ts';

interface DriverLicenseModalProps {
  isOpen: boolean;
  mode: 'renew' | 'create';
  driver: Driver | null;
  tenant: Tenant;
  availableTenants?: Tenant[];
  canWriteFleet: boolean;
  onClose: () => void;
  onRenewLicense: (
    driverId: string,
    payload: {
      licenseNumber: string;
      licenseCategory: LicenseCategory;
      licenseIssuedAt: string;
      licenseExpiresAt: string;
      issuingAuthority: string;
      notes: string;
      status: Driver['status'];
    }
  ) => Promise<void>;
  onCreateDriver: (payload: {
    tenantId?: string;
    branch: string;
    name: string;
    licenseNumber: string;
    licenseCategory: LicenseCategory;
    licenseIssuedAt: string;
    licenseExpiresAt: string;
    issuingAuthority: string;
    phone: string;
    status: Driver['status'];
  }) => Promise<void>;
}

function addYearsIso(baseIso: string, years: number): string {
  const parts = baseIso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return baseIso;
  const d = new Date(Date.UTC(parts[0] + years, parts[1] - 1, parts[2]));
  return d.toISOString().slice(0, 10);
}

export function DriverLicenseModal({
  isOpen,
  mode,
  driver,
  tenant,
  availableTenants,
  canWriteFleet,
  onClose,
  onRenewLicense,
  onCreateDriver,
}: DriverLicenseModalProps) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const initialTenantId = tenant.id === 'all' ? (availableTenants?.[0]?.id ?? 'ten-norte') : tenant.id;
  const initialBranches =
    (availableTenants?.find((t) => t.id === initialTenantId) ?? tenant).branches;

  const [targetTenantId, setTargetTenantId] = useState(initialTenantId);
  const [branch, setBranch] = useState(initialBranches[0] ?? 'San Juan Capital');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('+54 264 4');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseCategory, setLicenseCategory] = useState<LicenseCategory>('Federal Tipo B');
  const [licenseIssuedAt, setLicenseIssuedAt] = useState(todayIso);
  const [licenseExpiresAt, setLicenseExpiresAt] = useState(addYearsIso(todayIso, 2));
  const [issuingAuthority, setIssuingAuthority] = useState('Licencia Nacional de Conducir · San Juan');
  const [status, setStatus] = useState<Driver['status']>('activo');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    const nowStr = new Date().toISOString().slice(0, 10);
    if (mode === 'renew' && driver) {
      setTargetTenantId(driver.tenantId);
      setBranch(driver.branch);
      setName(driver.name);
      setPhone(driver.phone);
      setLicenseNumber(driver.licenseNumber);
      setLicenseCategory(driver.licenseCategory);
      setLicenseIssuedAt(nowStr);
      setLicenseExpiresAt(addYearsIso(nowStr, 2));
      setIssuingAuthority(driver.issuingAuthority);
      setStatus(driver.status);
      setNotes('');
    } else {
      const defTid = tenant.id === 'all' ? (availableTenants?.[0]?.id ?? 'ten-norte') : tenant.id;
      const defBranches = (availableTenants?.find((t) => t.id === defTid) ?? tenant).branches;
      setTargetTenantId(defTid);
      setBranch(defBranches[0] ?? 'San Juan Capital');
      setName('');
      setPhone('+54 264 4');
      setLicenseNumber('');
      setLicenseCategory('Federal Tipo B');
      setLicenseIssuedAt(nowStr);
      setLicenseExpiresAt(addYearsIso(nowStr, 2));
      setIssuingAuthority('Licencia Nacional de Conducir · San Juan');
      setStatus('activo');
      setNotes('');
    }
  }, [isOpen, mode, driver, tenant, availableTenants]);

  if (!isOpen) return null;
  if (mode === 'renew' && !driver) return null;

  const currentCompany = availableTenants?.find((t) => t.id === targetTenantId) ?? tenant;
  const companyBranches = currentCompany.branches.length > 0 ? currentCompany.branches : ['San Juan Capital'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!licenseNumber.trim() || !licenseIssuedAt || !licenseExpiresAt) {
      setError('Folio de licencia, fecha de emisión y vencimiento son obligatorios.');
      return;
    }
    if (licenseExpiresAt <= licenseIssuedAt) {
      setError('La fecha de vencimiento debe ser posterior a la fecha de emisión.');
      return;
    }
    if (mode === 'create' && !name.trim()) {
      setError('El nombre del operador es obligatorio.');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'renew' && driver) {
        await onRenewLicense(driver.id, {
          licenseNumber,
          licenseCategory,
          licenseIssuedAt,
          licenseExpiresAt,
          issuingAuthority,
          notes: notes.trim() || 'Renovación de vigencia documental registrada.',
          status,
        });
      } else {
        await onCreateDriver({
          tenantId: targetTenantId,
          branch,
          name,
          licenseNumber,
          licenseCategory,
          licenseIssuedAt,
          licenseExpiresAt,
          issuingAuthority,
          phone,
          status,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la licencia.');
    } finally {
      setSaving(false);
    }
  };

  const licMeta = driver ? LICENSE_STATUS_META[driver.licenseStatus] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl max-h-[90vh] bg-[#0F172A] border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-sky-400">
              {mode === 'renew' ? 'Gestión y renovación de licencia de conducir' : 'Alta de operador y vigencia documental'}
            </div>
            <h3 className="text-base font-semibold text-slate-100 mt-0.5 truncate flex items-center gap-2">
              <IdCard className="w-4 h-4 text-sky-400 shrink-0" />
              {mode === 'renew' && driver ? `${driver.name} · ${driver.branch}` : 'Nuevo operador en padrón'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer shrink-0"
            aria-label="Cerrar modal de licencia"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {mode === 'renew' && driver && licMeta && (
            <div className="p-3.5 rounded-xl bg-[#11192C] border border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-slate-400">Vigencia actual registrada</div>
                <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                  {driver.licenseNumber} · {driver.licenseCategory}
                </div>
                <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                  Emisión: {formatServiceDate(driver.licenseIssuedAt)} · Vence: {formatServiceDate(driver.licenseExpiresAt)}
                </div>
              </div>
              <div className="text-right">
                <div className={`font-semibold ${licMeta.colorClass}`}>{licMeta.label}</div>
                <div className="font-mono tabular-nums text-slate-300 mt-0.5">
                  {driver.daysToExpire <= 0
                    ? `Vencida hace ${Math.abs(driver.daysToExpire)} día(s)`
                    : `Restan ${driver.daysToExpire} día(s)`}
                </div>
              </div>
            </div>
          )}

          {driver && driver.licenseStatus === 'vencida' && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/35 text-rose-200 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>
                Esta licencia está vencida y mantiene una alerta crítica activa. Al registrar la renovación con vigencia superior a 30 días, las alertas pendientes del operador se confirmarán automáticamente.
              </span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'create' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {tenant.id === 'all' && availableTenants && (
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">Empresa</label>
                    <select
                      value={targetTenantId}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        setTargetTenantId(nextId);
                        const comp = availableTenants.find((t) => t.id === nextId);
                        if (comp?.branches[0]) setBranch(comp.branches[0]);
                      }}
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
                  <label className="block text-slate-300 font-medium mb-1">Nombre completo</label>
                  <input
                    type="text"
                    placeholder="Ej. Martín Quiroga"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Sucursal / Base operativa</label>
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                  >
                    {companyBranches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Teléfono de contacto</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg font-mono text-slate-100"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Categoría / Tipo de licencia</label>
                <select
                  value={licenseCategory}
                  onChange={(e) => setLicenseCategory(e.target.value as LicenseCategory)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                >
                  {LICENSE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-slate-300 font-medium mb-1">Número / Folio de licencia</label>
                <input
                  type="text"
                  placeholder="LIC-2026-8810"
                  value={licenseNumber}
                  onChange={(e) => setLicenseNumber(e.target.value)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-medium mb-1">Estado del operador</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Driver['status'])}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="activo">Activo</option>
                  <option value="descanso">En descanso</option>
                  <option value="suspendido">Suspendido</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Fecha de emisión</label>
                <input
                  type="date"
                  value={licenseIssuedAt}
                  onChange={(e) => setLicenseIssuedAt(e.target.value)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-medium mb-1">Fecha de vencimiento</label>
                <input
                  type="date"
                  value={licenseExpiresAt}
                  onChange={(e) => setLicenseExpiresAt(e.target.value)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-medium mb-1">Autoridad emisora</label>
                <input
                  type="text"
                  value={issuingAuthority}
                  onChange={(e) => setIssuingAuthority(e.target.value)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                />
              </div>
            </div>

            {canWriteFleet && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Extender vigencia rápida:</span>
                {[1, 2, 3].map((yrs) => (
                  <button
                    key={yrs}
                    type="button"
                    onClick={() => setLicenseExpiresAt(addYearsIso(licenseIssuedAt || todayIso, yrs))}
                    className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
                  >
                    +{yrs} {yrs === 1 ? 'año' : 'años'}
                  </button>
                ))}
              </div>
            )}

            {mode === 'renew' && (
              <div>
                <label className="block text-slate-300 font-medium mb-1">Notas de renovación</label>
                <input
                  type="text"
                  placeholder="Ej. Examen psicofísico aprobado · Renovación presencial"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={!canWriteFleet}
                  className="w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100"
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
              >
                Cerrar
              </button>
              {canWriteFleet && (
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white cursor-pointer whitespace-nowrap"
                >
                  {saving
                    ? 'Guardando...'
                    : mode === 'renew'
                      ? 'Registrar renovación'
                      : 'Guardar operador'}
                </button>
              )}
            </div>
          </form>

          {/* Chronological License Renewal Logbook */}
          {mode === 'renew' && driver && (
            <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
                <span className="font-semibold text-slate-100 flex items-center gap-2">
                  <History className="w-4 h-4 text-sky-400" />
                  Bitácora de renovaciones ({driver.licenseHistory?.length ?? 0})
                </span>
                <span className="text-[11px] font-mono text-slate-400">Trazabilidad documental</span>
              </div>
              {!driver.licenseHistory || driver.licenseHistory.length === 0 ? (
                <div className="p-4 text-slate-400">
                  Sin renovaciones previas registradas para este operador.
                </div>
              ) : (
                <div className="divide-y divide-slate-800/70">
                  {driver.licenseHistory.map((item) => (
                    <div key={item.id} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-100">
                          <span className="font-mono text-sky-300">{item.newLicenseNumber}</span> · {item.category}
                        </div>
                        <div className="text-slate-400">
                          {item.issuingAuthority} · {item.notes}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Anterior: <span className="font-mono">{item.previousLicenseNumber}</span> (vto. {formatServiceDate(item.previousExpiresAt)}) · Por {item.actorName}
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums text-slate-300 shrink-0">
                        <div className="text-emerald-400">Vence {formatServiceDate(item.newExpiresAt)}</div>
                        <div className="text-[11px] text-slate-500">{item.renewedAt.slice(0, 10)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
