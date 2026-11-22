import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Building2,
  CheckCircle2,
  Copy,
  Eye,
  KeyRound,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { TenantStatus, TenantSummary } from '../shared/types.ts';
import { apiRequest } from '../lib/api.ts';
import { cuitProblem, CUIT_MESSAGES, formatCuit, normalizeCuit, taxIdKey } from '../shared/cuit.ts';
import { PLAN_TIERS, RETENTION_DAYS } from '../shared/tenantOptions.ts';
import { TenantWizard, type TenantCreatedResult } from './TenantWizard.tsx';
import { TenantCurrencyDialog } from './TenantCurrencyDialog.tsx';
import { useMoney } from '../lib/money.tsx';

interface TenantsViewProps {
  /** Reload the workspace so new/changed companies show up in the header selector. */
  onTenantsChanged: () => Promise<void> | void;
  onViewTenant: (tenantId: string) => void;
  showToast: (type: 'ok' | 'err', text: string) => void;
}

const STATUS_META: Record<TenantStatus, { label: string; cls: string; icon: ReactNode }> = {
  activo: { label: 'Activa', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', icon: <CheckCircle2 className="w-3 h-3" /> },
  piloto: { label: 'Piloto', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30', icon: <PlayCircle className="w-3 h-3" /> },
  suspendido: { label: 'Suspendida', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30', icon: <PauseCircle className="w-3 h-3" /> },
};

function QuotaMeter({ used, quota }: { used: number; quota: number }) {
  const ratio = quota > 0 ? used / quota : 0;
  const color = ratio >= 1 ? 'bg-rose-500' : ratio >= 0.9 ? 'bg-amber-400' : 'bg-sky-500';
  return (
    <div className="min-w-[7rem]">
      <div className="text-xs text-slate-200 tabular-nums">
        {used} / {quota} <span className="text-slate-500">unidades</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-800 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used} aria-label="Uso del cupo">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg bg-[#0F172A] border border-slate-800 rounded-2xl flex flex-col max-h-[92vh]">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="px-5 py-3 border-t border-slate-800 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

const input = 'w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-sky-500';

// ---------------------------------------------------------------- edit

/** Defined at module level: a component declared inside render remounts on every keystroke and steals focus. */
function L({ id, label, children, err }: { id: string; label: string; children: ReactNode; err?: string | null }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs text-slate-300">
        {label}
      </label>
      {children}
      {err && (
        <p className="text-xs text-rose-300" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function EditTenantModal({
  tenant,
  onClose,
  onSaved,
  onCurrencyChange,
}: {
  tenant: TenantSummary;
  onClose: () => void;
  onSaved: (t: TenantSummary, note?: string) => void;
  /** The company already had a currency and another one was chosen: open the conversion dialog. */
  onCurrencyChange: (t: TenantSummary, to: string) => void;
}) {
  const [f, setF] = useState({
    name: tenant.name,
    cuit: tenant.taxId,
    city: tenant.city,
    branches: tenant.branches.join(', '),
    contactName: tenant.contactName ?? '',
    contactEmail: tenant.contactEmail ?? '',
    contactPhone: tenant.contactPhone ?? '',
    planTier: (PLAN_TIERS as readonly string[]).includes(tenant.planTier) ? tenant.planTier : 'Estándar',
    vehicleQuota: tenant.vehicleQuota,
    retentionDays: (RETENTION_DAYS as readonly number[]).includes(tenant.retentionDays) ? tenant.retentionDays : 30,
    referenceCurrency: tenant.referenceCurrency ?? 'USD',
    currency: tenant.currency ?? '',
  });
  const money = useMoney();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cuitChanged = taxIdKey(f.cuit) !== taxIdKey(tenant.taxId);
  const cuitError = cuitChanged ? (() => { const p = cuitProblem(f.cuit); return p ? CUIT_MESSAGES[p] : null; })() : null;
  const quotaError = f.vehicleQuota < tenant.vehicleCount ? `No puede ser menor que las ${tenant.vehicleCount} unidades registradas.` : null;

  const save = async () => {
    if (cuitError || quotaError) return;
    setSaving(true);
    setError(null);
    const branches = f.branches.split(',').map((b) => b.trim()).filter(Boolean);
    const patch: Record<string, unknown> = {
      name: f.name,
      city: f.city,
      branches,
      planTier: f.planTier,
      vehicleQuota: Number(f.vehicleQuota),
      retentionDays: Number(f.retentionDays),
      referenceCurrency: f.referenceCurrency,
    };
    if (cuitChanged) patch.cuit = f.cuit;
    if (f.contactName.trim()) patch.contactName = f.contactName;
    if (f.contactEmail.trim()) patch.contactEmail = f.contactEmail;
    if (f.contactPhone.trim()) patch.contactPhone = f.contactPhone;
    try {
      const res = await apiRequest<{ tenant: TenantSummary }>(`/api/tenants/${tenant.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (f.currency && f.currency !== (tenant.currency ?? '')) {
        if (!tenant.currency) {
          // First definition: the existing amounts are kept as they are.
          await apiRequest(`/api/tenants/${tenant.id}/currency`, { method: 'PUT', body: JSON.stringify({ currency: f.currency, mode: 'convertir' }) });
          onSaved({ ...res.tenant, currency: f.currency }, `moneda definida en ${f.currency}`);
        } else {
          onCurrencyChange({ ...res.tenant, currency: tenant.currency }, f.currency);
        }
        return;
      }
      onSaved(res.tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron guardar los cambios.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Editar ${tenant.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
            Cancelar
          </button>
          <button type="button" onClick={save} disabled={saving || Boolean(cuitError || quotaError)} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white cursor-pointer">
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {error && <div role="alert" className="sm:col-span-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">{error}</div>}
        <div className="sm:col-span-2">
          <L id="et-name" label="Razón social">
            <input id="et-name" className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </L>
        </div>
        <L id="et-cuit" label="CUIT" err={cuitError}>
          <input id="et-cuit" className={`${input} font-mono`} value={f.cuit} onChange={(e) => setF({ ...f, cuit: normalizeCuit(e.target.value).length === 11 ? formatCuit(e.target.value) : e.target.value })} />
        </L>
        <L id="et-city" label="Ciudad / provincia">
          <input id="et-city" className={input} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </L>
        <div className="sm:col-span-2">
          <L id="et-branches" label="Sucursales (separadas por coma)">
            <input id="et-branches" className={input} value={f.branches} onChange={(e) => setF({ ...f, branches: e.target.value })} />
          </L>
        </div>
        <L id="et-cn" label="Contacto">
          <input id="et-cn" className={input} value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        </L>
        <L id="et-ce" label="Email de contacto">
          <input id="et-ce" type="email" className={input} value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
        </L>
        <L id="et-cp" label="Teléfono de contacto">
          <input id="et-cp" type="tel" className={input} value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
        </L>
        <L id="et-plan" label="Plan">
          <select id="et-plan" className={input} value={f.planTier} onChange={(e) => setF({ ...f, planTier: e.target.value })}>
            {PLAN_TIERS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </L>
        <L id="et-quota" label={`Cupo de unidades (usa ${tenant.vehicleCount})`} err={quotaError}>
          <input id="et-quota" type="number" min={1} max={5000} className={input} value={f.vehicleQuota} onChange={(e) => setF({ ...f, vehicleQuota: Number(e.target.value) })} />
        </L>
        <L id="et-ret" label="Retención de video">
          <select id="et-ret" className={input} value={f.retentionDays} onChange={(e) => setF({ ...f, retentionDays: Number(e.target.value) })}>
            {RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} días
              </option>
            ))}
          </select>
        </L>
        <L id="et-cur" label="Moneda de la empresa (sus importes)">
          <select id="et-cur" className={input} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {!tenant.currency && <option value="">Sin moneda definida</option>}
            {money.enabled.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
          {!tenant.currency && f.currency && (
            <span className="block mt-1 text-[11px] text-sky-300">Primera definición: los importes existentes se conservan.</span>
          )}
          {tenant.currency && f.currency !== tenant.currency && (
            <span className="block mt-1 text-[11px] text-amber-300">Al guardar se abre la conversión de importes de {tenant.currency} a {f.currency}.</span>
          )}
        </L>
        <L id="et-ref" label="Moneda de referencia (equivalente)">
          <select id="et-ref" className={input} value={f.referenceCurrency} onChange={(e) => setF({ ...f, referenceCurrency: e.target.value })}>
            {money.enabled.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </L>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- list

export function TenantsView({ onTenantsChanged, onViewTenant, showToast }: TenantsViewProps) {
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todas' | TenantStatus>('todas');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<TenantSummary | null>(null);
  const [currencyTarget, setCurrencyTarget] = useState<TenantSummary | null>(null);
  const [statusTarget, setStatusTarget] = useState<TenantSummary | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [resetTarget, setResetTarget] = useState<TenantSummary | null>(null);
  const [resetResult, setResetResult] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ tenants: TenantSummary[] }>('/api/tenants');
      setTenants(res.tenants);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'No se pudo cargar el listado.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const list = tenants ?? [];
    return {
      total: list.length,
      activo: list.filter((t) => t.status === 'activo').length,
      piloto: list.filter((t) => t.status === 'piloto').length,
      suspendido: list.filter((t) => t.status === 'suspendido').length,
    };
  }, [tenants]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return (tenants ?? [])
      .filter((t) => statusFilter === 'todas' || t.status === statusFilter)
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.city.toLowerCase().includes(q) ||
          t.taxId.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && t.taxId.replace(/\D/g, '').includes(qDigits))
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [tenants, search, statusFilter]);

  const afterChange = async () => {
    await load();
    await onTenantsChanged();
  };

  const changeStatus = async (t: TenantSummary, status: TenantStatus) => {
    setBusy(true);
    try {
      await apiRequest(`/api/tenants/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      showToast('ok', status === 'suspendido' ? `${t.name} quedó suspendida.` : `${t.name} quedó reactivada.`);
      setStatusTarget(null);
      setConfirmText('');
      await afterChange();
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (t: TenantSummary) => {
    setBusy(true);
    try {
      const res = await apiRequest<{ username: string; temporaryPassword: string }>(`/api/tenants/${t.id}/reset-admin-password`, { method: 'POST' });
      setResetResult(res);
      showToast('ok', `Contraseña temporal generada para ${res.username}.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo restablecer la contraseña.');
    } finally {
      setBusy(false);
    }
  };

  const onCreated = async (r: TenantCreatedResult) => {
    showToast('ok', `${r.tenant.name} quedó registrada.`);
    await afterChange();
  };

  const kpi = (label: string, value: number, cls = 'text-slate-100') => (
    <div className="px-3 py-2 rounded-lg bg-[#0B1120] border border-slate-800 min-w-[6.5rem]">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-sky-600/15 border border-sky-500/30 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Empresas</h2>
            <p className="text-xs text-slate-400">Alta y gestión de las empresas cliente de la plataforma</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kpi('Total', counts.total)}
          {kpi('Activas', counts.activo, 'text-emerald-300')}
          {kpi('En piloto', counts.piloto, 'text-sky-300')}
          {kpi('Suspendidas', counts.suspendido, counts.suspendido ? 'text-rose-300' : 'text-slate-100')}
        </div>
        <button type="button" onClick={() => setWizardOpen(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
          <Plus className="w-4 h-4" /> Registrar empresa
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800" role="tablist" aria-label="Filtrar por estado">
          {(
            [
              ['todas', 'Todas'],
              ['activo', 'Activas'],
              ['piloto', 'Piloto'],
              ['suspendido', 'Suspendidas'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={statusFilter === id} onClick={() => setStatusFilter(id)} className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${statusFilter === id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre, CUIT o ciudad…" aria-label="Buscar empresas" className="pl-8 pr-3 py-1.5 w-72 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500" />
        </div>
      </div>

      {tenants && tenants.some((t) => !t.currency) && (
        <div role="status" className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
          {tenants.filter((t) => !t.currency).length} empresa(s) sin moneda definida: sus importes se muestran sin símbolo y no entran en el
          consolidado. Defínela con el botón «Sin moneda · definir» o en Editar → «Moneda de la empresa» (los importes existentes se
          conservan). La «moneda de referencia» es otra cosa: solo define el equivalente que se muestra al lado de los totales.
        </div>
      )}

      {/* Table */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        {loadError ? (
          <div className="p-6 text-sm text-rose-300">{loadError}</div>
        ) : tenants === null ? (
          <div className="p-6 flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Cargando empresas…
          </div>
        ) : tenants.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <Building2 className="w-8 h-8 text-slate-600 mx-auto" />
            <p className="text-sm text-slate-200">Todavía no hay empresas registradas.</p>
            <p className="text-xs text-slate-400">El asistente registra la empresa, sus perfiles y su usuario administrador en 4 pasos.</p>
            <button type="button" onClick={() => setWizardOpen(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
              <Plus className="w-4 h-4" /> Registrar la primera empresa
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">Ninguna empresa coincide con la búsqueda.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400 bg-[#0F172A]">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Empresa</th>
                  <th className="text-left font-medium px-4 py-2">CUIT</th>
                  <th className="text-left font-medium px-4 py-2">Estado</th>
                  <th className="text-left font-medium px-4 py-2">Moneda</th>
                  <th className="text-left font-medium px-4 py-2">Uso del cupo</th>
                  <th className="text-left font-medium px-4 py-2">Usuarios</th>
                  <th className="text-left font-medium px-4 py-2">Administrador</th>
                  <th className="text-left font-medium px-4 py-2">Alta</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {filtered.map((t) => {
                  const st = STATUS_META[t.status] ?? STATUS_META.activo;
                  return (
                    <tr key={t.id} className={t.status === 'suspendido' ? 'opacity-70' : ''}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-100">{t.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {t.city}
                          {t.contactName ? ` · ${t.contactName}` : ''}
                          {t.contactEmail ? ` · ${t.contactEmail}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{t.taxId}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${st.cls}`}>
                          {st.icon}
                          {st.label}
                        </span>
                        <div className="text-[11px] text-slate-500 mt-0.5">Plan {t.planTier}</div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {t.currency ? (
                          <button
                            type="button"
                            onClick={() => setCurrencyTarget(t)}
                            title="Cambiar la moneda de la empresa"
                            className="px-2 py-0.5 rounded-md border border-slate-700 bg-slate-800/60 font-mono text-slate-200 hover:border-sky-500 cursor-pointer"
                          >
                            {t.currency}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setCurrencyTarget(t)}
                            className="px-2 py-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                          >
                            Sin moneda · definir
                          </button>
                        )}
                        <div className="text-[11px] text-slate-500 mt-0.5" title="Moneda de referencia: solo para el equivalente">equivalente en {t.referenceCurrency ?? 'USD'}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <QuotaMeter used={t.vehicleCount} quota={t.vehicleQuota} />
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{t.userCount}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-mono">{t.adminUsername ?? '—'}</div>
                        <div className="text-[11px] text-slate-500">{t.adminName ?? ''}</div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{t.createdAt ? new Date(t.createdAt).toLocaleDateString('es-AR') : 'Inicial'}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => onViewTenant(t.id)} disabled={t.status === 'suspendido'} title="Ver en el panel" aria-label={`Ver ${t.name} en el panel`} className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 cursor-pointer">
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => setEditing(t)} title="Editar" aria-label={`Editar ${t.name}`} className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => { setResetResult(null); setResetTarget(t); }} disabled={!t.adminUsername} title="Restablecer contraseña del admin" aria-label={`Restablecer contraseña del admin de ${t.name}`} className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 cursor-pointer">
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => { setConfirmText(''); setStatusTarget(t); }} title={t.status === 'suspendido' ? 'Reactivar' : 'Suspender'} aria-label={`${t.status === 'suspendido' ? 'Reactivar' : 'Suspender'} ${t.name}`} className={`p-1.5 rounded-md hover:bg-slate-800 cursor-pointer ${t.status === 'suspendido' ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {t.status === 'suspendido' ? <PlayCircle className="w-3.5 h-3.5" /> : <PauseCircle className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {wizardOpen && (
        <TenantWizard
          onClose={() => setWizardOpen(false)}
          onCreated={onCreated}
          onViewTenant={(id) => {
            setWizardOpen(false);
            onViewTenant(id);
          }}
        />
      )}

      {currencyTarget && (
        <TenantCurrencyDialog
          tenant={currencyTarget}
          initialTo={(currencyTarget as TenantSummary & { pendingCurrency?: string }).pendingCurrency}
          onClose={() => setCurrencyTarget(null)}
          onDone={(list, msg) => {
            setTenants(list);
            setCurrencyTarget(null);
            showToast('ok', msg);
            onTenantsChanged();
          }}
        />
      )}

      {editing && (
        <EditTenantModal
          tenant={editing}
          onClose={() => setEditing(null)}
          onSaved={async (t, note) => {
            setEditing(null);
            showToast('ok', `Cambios guardados en ${t.name}${note ? ` · ${note}` : ''}.`);
            await afterChange();
          }}
          onCurrencyChange={(t, to) => {
            setEditing(null);
            setCurrencyTarget({ ...t, pendingCurrency: to } as TenantSummary & { pendingCurrency: string });
            // Only the list: a full workspace reload remounts this view and would close the dialog.
            void load();
          }}
        />
      )}

      {statusTarget && (
        <Modal
          title={statusTarget.status === 'suspendido' ? `Reactivar ${statusTarget.name}` : `Suspender ${statusTarget.name}`}
          onClose={() => setStatusTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => setStatusTarget(null)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Cancelar
              </button>
              {statusTarget.status === 'suspendido' ? (
                <button type="button" disabled={busy} onClick={() => changeStatus(statusTarget, 'activo')} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white cursor-pointer">
                  Reactivar empresa
                </button>
              ) : (
                <button type="button" disabled={busy || confirmText.trim() !== statusTarget.name} onClick={() => changeStatus(statusTarget, 'suspendido')} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white cursor-pointer">
                  Suspender empresa
                </button>
              )}
            </>
          }
        >
          {statusTarget.status === 'suspendido' ? (
            <p className="text-sm text-slate-300">Sus {statusTarget.userCount} usuarios podrán volver a ingresar al panel. La empresa queda como «Activa».</p>
          ) : (
            <div className="space-y-3 text-sm text-slate-300">
              <p>
                Sus <b>{statusTarget.userCount} usuarios no podrán ingresar</b> y se cerrarán sus sesiones abiertas. Los datos (unidades, órdenes,
                alertas) se conservan y la suspensión se puede revertir.
              </p>
              <label htmlFor="tv-confirm" className="block text-xs text-slate-400">
                Para confirmar, escribe el nombre de la empresa: <b className="text-slate-200">{statusTarget.name}</b>
              </label>
              <input id="tv-confirm" autoFocus className={input} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </div>
          )}
        </Modal>
      )}

      {resetTarget && (
        <Modal
          title={`Restablecer contraseña · ${resetTarget.name}`}
          onClose={() => {
            setResetTarget(null);
            setResetResult(null);
          }}
          footer={
            resetResult ? (
              <button type="button" onClick={() => { setResetTarget(null); setResetResult(null); }} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                Listo, ya la copié
              </button>
            ) : (
              <>
                <button type="button" onClick={() => setResetTarget(null)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                  Cancelar
                </button>
                <button type="button" disabled={busy} onClick={() => resetPassword(resetTarget)} className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white cursor-pointer">
                  {busy ? 'Generando…' : 'Generar contraseña temporal'}
                </button>
              </>
            )
          }
        >
          {resetResult ? (
            <div className="space-y-3 text-sm">
              <p className="text-slate-300">Contraseña temporal para <b className="font-mono">{resetResult.username}</b>:</p>
              <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[#0B1120] border border-slate-800">
                <span className="font-mono text-base text-slate-100 break-all">{resetResult.temporaryPassword}</span>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(`Usuario: ${resetResult.username}\nContraseña temporal: ${resetResult.temporaryPassword}`)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
                  <Copy className="w-3.5 h-3.5" /> Copiar
                </button>
              </div>
              <p className="text-xs text-amber-200">No se volverá a mostrar. El administrador deberá cambiarla en su próximo ingreso.</p>
            </div>
          ) : (
            <p className="text-sm text-slate-300">
              Se generará una contraseña temporal nueva para <b className="font-mono">{resetTarget.adminUsername}</b>. La actual dejará de funcionar, se
              cerrarán sus sesiones y deberá elegir una contraseña propia al ingresar.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
