import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Ban,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Eye,
  FileWarning,
  IdCard,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Users,
  X,
} from 'lucide-react';
import type { Driver, DriverListItem, DriverPage, Tenant, Vehicle } from '../shared/types.ts';
import { apiRequest } from '../lib/api.ts';
import {
  AUTH_STATE_LABELS,
  computeDriverAuthorization,
  DISABLE_REASONS,
  DOC_TYPES,
  DRIVER_PAGE_SIZES,
  DRIVER_PROFILES,
  type DriverAuthState,
  type DriverProfile,
} from '../shared/drivers.ts';
import { AuthBadge, ExpiryText } from './DriverBadges.tsx';
import { DriverWizard } from './DriverWizard.tsx';
import { DriverDetailPanel } from './DriverDetailPanel.tsx';
import { DriverLicenseModal } from './DriverLicenseModal.tsx';
import { DocumentReviewDialog } from './DocumentReviewDialog.tsx';
import { ExportMenu } from './ExportMenu.tsx';

interface DriversViewProps {
  tenant: Tenant;
  availableTenants?: Tenant[];
  vehicles: Vehicle[];
  drivers: Driver[];
  /** Server URL for Traccar Client: builds the phone configuration QR. */
  phoneServerUrl?: string | null;
  /** Reloads the app data so units and the fleet roster reflect assignment changes. */
  onDataChanged: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

const REFRESH_MS = 30_000;

/** Driver registry: KPI filters, server-side pagination, wizard, sheet and enable/disable. */
export function DriversView({ tenant, availableTenants, vehicles, drivers, phoneServerUrl, onDataChanged }: DriversViewProps) {
  const [data, setData] = useState<DriverPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<DriverAuthState | ''>('');
  const [branch, setBranch] = useState('');
  const [profile, setProfile] = useState<DriverProfile | ''>('');
  const [sort, setSort] = useState<'name' | 'expiry'>('name');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [wizard, setWizard] = useState<{ mode: 'create' } | { mode: 'edit'; driver: DriverListItem } | null>(null);
  const [detail, setDetail] = useState<DriverListItem | null>(null);
  const [disabling, setDisabling] = useState<DriverListItem | null>(null);
  const [enabling, setEnabling] = useState<DriverListItem | null>(null);
  const [reviewing, setReviewing] = useState<DriverListItem | null>(null);
  const [renewing, setRenewing] = useState<DriverListItem | null>(null);
  const requestSeq = useRef(0);

  const showAll = tenant.id === 'all';
  const branches = useMemo(() => {
    const list = showAll ? (availableTenants ?? []).flatMap((t) => t.branches) : tenant.branches;
    return [...new Set(list)].sort((a, b) => a.localeCompare(b, 'es'));
  }, [showAll, availableTenants, tenant.branches]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // Debounced search: the request goes out 300 ms after the last keystroke.
  useEffect(() => {
    const h = setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => clearTimeout(h);
  }, [searchDraft]);

  // Any filter change goes back to page 1.
  useEffect(() => {
    setPage(1);
  }, [search, state, branch, profile, sort, pageSize, tenant.id]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const seq = ++requestSeq.current;
      if (!opts.silent) setLoading(true);
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort });
      if (search) params.set('q', search);
      if (state) params.set('state', state);
      if (branch) params.set('branch', branch);
      if (profile) params.set('profile', profile);
      try {
        const res = await apiRequest<DriverPage>(`/api/drivers?${params}`);
        if (seq !== requestSeq.current) return null; // a newer request already answered
        setData(res);
        setLoadError(null);
        if (res.page !== page) setPage(res.page);
        return res;
      } catch (err) {
        if (seq === requestSeq.current && !opts.silent) setLoadError(err instanceof Error ? err.message : 'No se pudo cargar el listado.');
        return null;
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [page, pageSize, sort, search, state, branch, profile]
  );

  useEffect(() => {
    void load();
  }, [load, tenant.id]);

  // Keep the list fresh for changes made by other users.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible' && !wizard) void load({ silent: true });
    };
    const h = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [load, wizard]);

  /** Applies a server-confirmed change: row replaced at once, then counters and filters refreshed. */
  const applyChange = useCallback(
    async (driver: DriverListItem, message: string, tone: Toast['tone'] = 'ok') => {
      setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === driver.id ? driver : x)) } : d));
      setDetail((cur) => (cur?.id === driver.id ? driver : cur));
      setHighlight(driver.id);
      setTimeout(() => setHighlight((h) => (h === driver.id ? null : h)), 2500);
      const fresh = await load({ silent: true });
      const visible = fresh?.items.some((x) => x.id === driver.id);
      toast(
        visible || !fresh ? message : `${message}. No aparece en esta vista por los filtros activos.`,
        tone
      );
      onDataChanged();
    },
    [load, toast, onDataChanged]
  );

  const clearFilters = () => {
    setSearchDraft('');
    setSearch('');
    setState('');
    setBranch('');
    setProfile('');
  };
  const hasFilters = Boolean(search || state || branch || profile);

  const counts = data?.counts;
  const kpis: Array<{ key: DriverAuthState | ''; label: string; value?: number; Icon: typeof Users; tone: string }> = [
    { key: '', label: 'Total', value: counts?.total, Icon: Users, tone: 'text-slate-200' },
    { key: 'habilitado', label: 'Habilitados', value: counts?.habilitado, Icon: CircleCheck, tone: 'text-emerald-300' },
    { key: 'pendiente', label: 'Por verificar', value: counts?.pendiente, Icon: ShieldQuestion, tone: 'text-sky-300' },
    { key: 'por_vencer', label: 'Por vencer', value: counts?.por_vencer, Icon: Clock, tone: 'text-amber-300' },
    { key: 'no_autorizado', label: 'No autorizados', value: counts?.no_autorizado, Icon: ShieldAlert, tone: 'text-rose-300' },
    { key: 'deshabilitado', label: 'Deshabilitados', value: counts?.deshabilitado, Icon: Ban, tone: 'text-slate-300' },
  ];

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const pageNumbers = useMemo(() => {
    const set = new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages));
    const sorted = [...set].sort((a, b) => a - b);
    const out: Array<number | '…'> = [];
    sorted.forEach((n, i) => {
      if (i && n - sorted[i - 1] > 1) out.push('…');
      out.push(n);
    });
    return out;
  }, [page, totalPages]);

  const selectCls = 'px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-sky-500';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-sky-600/15 border border-sky-500/30 flex items-center justify-center shrink-0">
            <IdCard className="w-5 h-5 text-sky-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100">Choferes</h2>
            <p className="text-xs text-slate-400 truncate">
              Documentación y habilitación para conducir · {showAll ? 'todas las empresas' : tenant.name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu
            url="/api/drivers/export"
            label="Exportar"
            params={{ q: search || undefined, state: state || undefined, branch: branch || undefined, profile: profile || undefined, sort }}
            count={data?.total}
            filtered={Boolean(search || state || branch || profile)}
            fileName="choferes"
          />
          <button
            type="button"
            onClick={() => setWizard({ mode: 'create' })}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Registrar chofer
          </button>
        </div>
      </div>

      {/* KPI filters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" role="group" aria-label="Filtrar por estado">
        {kpis.map((k) => {
          const active = state === k.key;
          return (
            <button
              key={k.label}
              type="button"
              aria-pressed={active}
              onClick={() => setState(active && k.key ? '' : k.key)}
              className={`text-left p-3 rounded-xl border cursor-pointer transition-colors ${
                active ? 'border-sky-500 bg-sky-500/10' : 'border-slate-800/80 bg-[#11192C] hover:border-slate-600'
              }`}
            >
              <div className={`flex items-center gap-1.5 text-[11px] ${k.tone}`}>
                <k.Icon className="w-3.5 h-3.5" aria-hidden />
                {k.label}
              </div>
              <div className="mt-1 text-xl font-semibold text-slate-100 tabular-nums">{k.value ?? '—'}</div>
            </button>
          );
        })}
      </div>
      {counts && counts.sinRespaldo > 0 && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
          <FileWarning className="w-4 h-4 shrink-0" aria-hidden />
          {counts.sinRespaldo} {counts.sinRespaldo === 1 ? 'chofer tiene' : 'choferes tienen'} documentos obligatorios sin archivo de respaldo.
        </div>
      )}

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Buscar por nombre, DNI, licencia o legajo…"
            aria-label="Buscar choferes"
            className="w-full pl-8 pr-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>
        <select aria-label="Sucursal" value={branch} onChange={(e) => setBranch(e.target.value)} className={selectCls}>
          <option value="">Todas las sucursales</option>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select aria-label="Perfil" value={profile} onChange={(e) => setProfile(e.target.value as DriverProfile | '')} className={selectCls}>
          <option value="">Todos los perfiles</option>
          {(Object.keys(DRIVER_PROFILES) as DriverProfile[]).map((p) => (
            <option key={p} value={p}>
              {DRIVER_PROFILES[p].label}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
            <X className="w-3.5 h-3.5" /> Limpiar filtros
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        {loadError ? (
          <div className="p-8 text-center space-y-2" role="alert">
            <AlertTriangle className="w-6 h-6 text-rose-300 mx-auto" aria-hidden />
            <p className="text-sm text-slate-200">{loadError}</p>
            <button type="button" onClick={() => load()} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer">
              Reintentar
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" aria-busy={loading}>
              <thead className="bg-[#0B1120] text-slate-400">
                <tr>
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    <button type="button" onClick={() => setSort('name')} className="inline-flex items-center gap-1 hover:text-slate-200 cursor-pointer" aria-sort={sort === 'name' ? 'ascending' : undefined}>
                      Chofer {sort === 'name' && <ArrowDownUp className="w-3 h-3" aria-hidden />}
                    </button>
                  </th>
                  {showAll && (
                    <th scope="col" className="text-left font-medium px-3 py-2.5">
                      Empresa
                    </th>
                  )}
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    Perfil
                  </th>
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    Licencia
                  </th>
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    <button type="button" onClick={() => setSort('expiry')} className="inline-flex items-center gap-1 hover:text-slate-200 cursor-pointer" aria-sort={sort === 'expiry' ? 'ascending' : undefined}>
                      Próximo vencimiento {sort === 'expiry' && <ArrowDownUp className="w-3 h-3" aria-hidden />}
                    </button>
                  </th>
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    Estado
                  </th>
                  <th scope="col" className="text-left font-medium px-3 py-2.5">
                    Unidad
                  </th>
                  <th scope="col" className="text-right font-medium px-3 py-2.5">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && !data
                  ? Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                      <tr key={i} className="border-t border-slate-800/80">
                        <td colSpan={showAll ? 8 : 7} className="px-3 py-3">
                          <div className="h-4 rounded bg-slate-800/70 animate-pulse" />
                        </td>
                      </tr>
                    ))
                  : data?.items.map((d) => {
                      const auth = d.authorization;
                      const disabled = d.enabled === false;
                      return (
                        <tr
                          key={d.id}
                          className={`border-t border-slate-800/80 transition-colors duration-700 ${highlight === d.id ? 'bg-sky-500/15' : 'hover:bg-slate-800/30'} ${loading ? 'opacity-60' : ''}`}
                        >
                          <td className="px-3 py-2.5">
                            <button type="button" onClick={() => setDetail(d)} className="text-left cursor-pointer group">
                              <div className="text-slate-100 font-medium group-hover:underline">{d.name}</div>
                              <div className="text-[11px] text-slate-500">
                                DNI {d.dni ?? '—'}
                                {d.employeeNumber ? ` · ${d.employeeNumber}` : ''}
                              </div>
                            </button>
                          </td>
                          {showAll && <td className="px-3 py-2.5 text-slate-300">{d.tenantName}</td>}
                          <td className="px-3 py-2.5 text-slate-300">
                            {DRIVER_PROFILES[d.profile ?? 'liviano'].label}
                            {d.dangerousGoods && <div className="text-[11px] text-amber-300">Cargas peligrosas</div>}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {(d.licenseClasses ?? []).map((c) => (
                                <span key={c} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-slate-200">
                                  {c}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <ExpiryText date={auth.nextExpiry} days={auth.daysToExpiry} />
                            {auth.nextExpiryDoc && <span className="block text-[10px] text-slate-500">{DOC_TYPES[auth.nextExpiryDoc].short}</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            <span tabIndex={auth.reasons.length ? 0 : -1} title={auth.reasons.join(' ')} aria-label={`${AUTH_STATE_LABELS[auth.state]}. ${auth.reasons.join(' ')}`}>
                              <AuthBadge state={auth.state} />
                            </span>
                            {auth.reasons[0] && auth.state !== 'habilitado' && (
                              <div className="mt-0.5 text-[10px] text-slate-500 max-w-[14rem] truncate" aria-hidden>
                                {auth.reasons[0]}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-slate-300">{d.assignedVehicle ? d.assignedVehicle.unitCode : <span className="text-slate-500">—</span>}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => setDetail(d)} className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer" aria-label={`Ver ficha de ${d.name}`} title="Ver ficha">
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              {auth.state === 'pendiente' && (
                                <button
                                  type="button"
                                  onClick={() => setReviewing(d)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                                >
                                  <ShieldCheck className="w-3.5 h-3.5" /> Verificar
                                </button>
                              )}
                              <button type="button" onClick={() => setRenewing(d)} className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer" aria-label={`Renovar licencia de ${d.name}`} title="Renovar licencia">
                                <IdCard className="w-3.5 h-3.5" />
                              </button>
                              <button type="button" onClick={() => setWizard({ mode: 'edit', driver: d })} className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer" aria-label={`Editar a ${d.name}`} title="Editar">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {disabled ? (
                                <button
                                  type="button"
                                  onClick={() => setEnabling(d)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" /> Habilitar
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setDisabling(d)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-rose-300 hover:bg-rose-500/10 cursor-pointer"
                                >
                                  <Ban className="w-3.5 h-3.5" /> Deshabilitar
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>

            {data && data.items.length === 0 && (
              <div className="p-10 text-center space-y-2">
                <IdCard className="w-7 h-7 text-slate-500 mx-auto" aria-hidden />
                {hasFilters ? (
                  <>
                    <p className="text-sm text-slate-200">No hay choferes que coincidan con la búsqueda o los filtros.</p>
                    <button type="button" onClick={clearFilters} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer">
                      Limpiar filtros
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-200">Todavía no hay choferes registrados.</p>
                    <p className="text-xs text-slate-400">Registra a cada chofer con su licencia y documentación para saber si está autorizado para conducir.</p>
                    <button type="button" onClick={() => setWizard({ mode: 'create' })} className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                      <Plus className="w-3.5 h-3.5" /> Registrar chofer
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Pagination */}
        {data && total > 0 && (
          <nav className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border-t border-slate-800/80 text-xs text-slate-400" aria-label="Paginación de choferes">
            <div className="flex items-center gap-2">
              <span>
                Mostrando <b className="text-slate-200">{from}–{to}</b> de <b className="text-slate-200">{total}</b>
              </span>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="Cargando" />}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5">
                Por página
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className={selectCls}>
                  {DRIVER_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => setPage(page - 1)} disabled={page <= 1} className="p-1.5 rounded-md hover:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-default" aria-label="Página anterior">
                <ChevronLeft className="w-4 h-4" />
              </button>
              {pageNumbers.map((n, i) =>
                n === '…' ? (
                  <span key={`gap-${i}`} className="px-1">
                    …
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    aria-current={n === page ? 'page' : undefined}
                    className={`min-w-7 h-7 px-1.5 rounded-md cursor-pointer ${n === page ? 'bg-sky-600 text-white' : 'hover:bg-slate-800 text-slate-300'}`}
                  >
                    {n}
                  </button>
                )
              )}
              <button type="button" onClick={() => setPage(page + 1)} disabled={page >= totalPages} className="p-1.5 rounded-md hover:bg-slate-800 disabled:opacity-40 cursor-pointer disabled:cursor-default" aria-label="Página siguiente">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </nav>
        )}
      </div>

      {wizard && (
        <DriverWizard
          mode={wizard.mode}
          driver={wizard.mode === 'edit' ? wizard.driver : undefined}
          tenant={tenant}
          availableTenants={availableTenants}
          vehicles={vehicles}
          drivers={drivers}
          onClose={() => setWizard(null)}
          onSaved={(d, msg) => void applyChange(d, msg)}
          onViewDriver={(id) => {
            setWizard(null);
            apiRequest<DriverListItem>(`/api/drivers/${id}`).then(setDetail, (err) => toast(err.message, 'error'));
          }}
          onVerifyNow={(id) => {
            setWizard(null);
            apiRequest<DriverListItem>(`/api/drivers/${id}`).then(setReviewing, (err) => toast(err.message, 'error'));
          }}
        />
      )}

      {reviewing && (
        <DocumentReviewDialog
          driver={reviewing}
          onClose={() => setReviewing(null)}
          onChanged={(d, msg) => void applyChange(d, msg)}
        />
      )}

      {detail && !wizard && !reviewing && (
        <DriverDetailPanel
          driver={detail}
          phoneServerUrl={phoneServerUrl}
          onClose={() => setDetail(null)}
          onEdit={() => setWizard({ mode: 'edit', driver: detail })}
          onDisable={() => setDisabling(detail)}
          onEnable={() => setEnabling(detail)}
          onReview={() => setReviewing(detail)}
        />
      )}

      {renewing && (
        <DriverLicenseModal
          driver={renewing}
          canWrite
          onClose={() => setRenewing(null)}
          onDone={(d, msg, tone) => {
            setRenewing(null);
            void applyChange(d, msg, tone);
          }}
        />
      )}

      {disabling && (
        <DisableDialog
          driver={disabling}
          onCancel={() => setDisabling(null)}
          onDone={(d, notes) => {
            setDisabling(null);
            void applyChange(d, `${d.name} deshabilitado${notes.length ? ` · ${notes.join('; ')}` : ''}`);
          }}
        />
      )}

      {enabling && (
        <EnableDialog
          driver={enabling}
          onCancel={() => setEnabling(null)}
          onDone={(d) => {
            setEnabling(null);
            const st = d.authorization.state;
            void applyChange(
              d,
              st === 'no_autorizado'
                ? `${d.name} habilitado, pero sigue «No autorizado» por su documentación`
                : st === 'pendiente'
                  ? `${d.name} habilitado; falta verificar documentos para que pueda conducir`
                  : `${d.name} habilitado`,
              st === 'no_autorizado' || st === 'pendiente' ? 'warn' : 'ok'
            );
          }}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-[70] space-y-2 w-[min(92vw,26rem)]" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-2 p-3 rounded-lg border shadow-xl text-xs ${
              t.tone === 'ok' ? 'bg-[#0F2A22] border-emerald-500/40 text-emerald-100' : t.tone === 'warn' ? 'bg-[#2A2210] border-amber-500/40 text-amber-100' : 'bg-[#2A1215] border-rose-500/40 text-rose-100'
            }`}
          >
            {t.tone === 'ok' ? <CircleCheck className="w-4 h-4 shrink-0" aria-hidden /> : <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />}
            <span className="flex-1">{t.text}</span>
            <button type="button" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} className="opacity-70 hover:opacity-100 cursor-pointer" aria-label="Cerrar aviso">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function DialogShell({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="drv-dialog-title">
      <div className="w-full max-w-md bg-[#11192C] border border-slate-700 rounded-xl p-5 space-y-3">
        <h3 id="drv-dialog-title" className="text-sm font-semibold text-slate-100">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

function DisableDialog({ driver, onCancel, onDone }: { driver: DriverListItem; onCancel: () => void; onDone: (d: DriverListItem, notes: string[]) => void }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = reason === 'Otro';
  const valid = reason && (!needsNote || note.trim());

  const submit = async () => {
    if (!valid) {
      setError(!reason ? 'Elige el motivo.' : 'Describe el motivo.');
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest<{ driver: DriverListItem; notes: string[] }>(`/api/drivers/${driver.id}/disable`, {
        method: 'POST',
        body: JSON.stringify({ reason, note: note.trim() || undefined }),
      });
      onDone(res.driver, res.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo deshabilitar.');
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`Deshabilitar a ${driver.name}`} onCancel={onCancel}>
      <p className="text-xs text-slate-300">
        No podrá conducir ni asignarse a unidades hasta que lo habilites de nuevo.
        {driver.assignedVehicle && (
          <>
            {' '}
            <b className="text-amber-200">{driver.assignedVehicle.unitCode} quedará sin chofer.</b>
          </>
        )}{' '}
        Sus datos y documentos se conservan.
      </p>
      <div>
        <label htmlFor="drv-disable-reason" className="block text-xs text-slate-300 mb-1">
          Motivo *
        </label>
        <select
          id="drv-disable-reason"
          autoFocus
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-sky-500"
        >
          <option value="">Elige el motivo…</option>
          {DISABLE_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="drv-disable-note" className="block text-xs text-slate-300 mb-1">
          Detalle {needsNote ? '*' : '(opcional)'}
        </label>
        <textarea
          id="drv-disable-note"
          rows={2}
          maxLength={400}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setError(null);
          }}
          className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-sky-500"
        />
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
          Cancelar
        </button>
        <button type="button" onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white cursor-pointer disabled:opacity-50">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Deshabilitar
        </button>
      </div>
    </DialogShell>
  );
}

function EnableDialog({ driver, onCancel, onDone }: { driver: DriverListItem; onCancel: () => void; onDone: (d: DriverListItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const after = computeDriverAuthorization({ ...driver, enabled: true });

  const submit = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ driver: DriverListItem }>(`/api/drivers/${driver.id}/enable`, { method: 'POST' });
      onDone(res.driver);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo habilitar.');
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`Habilitar a ${driver.name}`} onCancel={onCancel}>
      {after.state === 'no_autorizado' || after.state === 'pendiente' ? (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100 space-y-1">
          <p>
            Quedará habilitado, pero seguirá «{after.state === 'pendiente' ? 'Pendiente de verificación' : 'No autorizado'}» y no podrá conducir hasta
            resolver:
          </p>
          <ul className="list-disc pl-5">
            {after.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-slate-300 flex items-center gap-2">
          Quedará <AuthBadge state={after.state} /> y se le podrán asignar unidades.
        </p>
      )}
      {driver.disabledReason && <p className="text-[11px] text-slate-400">Motivo de la deshabilitación: {driver.disabledReason}.</p>}
      {error && (
        <p role="alert" className="text-[11px] text-rose-300">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
          Cancelar
        </button>
        <button type="button" autoFocus onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Habilitar
        </button>
      </div>
    </DialogShell>
  );
}
