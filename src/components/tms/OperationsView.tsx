import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, CalendarRange, CircleCheck, ClipboardList, FileText, Fuel, GanttChart, MapPin, Receipt, TrendingUp, Truck, X } from 'lucide-react';
import { PlannerPanel } from './PlannerPanel.tsx';
import { DispatchPanel } from './DispatchPanel.tsx';
import { BillingPanel, ExpensesPanel, FuelPanel, ProfitabilityPanel } from './CostsPanels.tsx';
import type { Driver, Tenant, Vehicle } from '../../shared/types.ts';
import type { Customer, Place } from '../../shared/tms.ts';
import { apiRequest } from '../../lib/api.ts';
import { TripsPanel } from './TripsPanel.tsx';
import { OrdersPanel } from './OrdersPanel.tsx';
import { CustomersPanel } from './CustomersPanel.tsx';
import { PlacesPanel } from './PlacesPanel.tsx';
import { errMsg } from './ui.tsx';

type Tab = 'viajes' | 'planificador' | 'despacho' | 'pedidos' | 'clientes' | 'lugares' | 'combustible' | 'gastos' | 'facturacion' | 'rentabilidad';
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'err';
}

/**
 * TMS ("Operaciones"): trips with automatic stop tracking, transport orders, customers and places.
 */
export function OperationsView({
  tenant,
  vehicles,
  drivers,
  canWrite,
  canApprove,
  onDataChanged,
}: {
  tenant: Tenant;
  vehicles: Vehicle[];
  drivers: Driver[];
  canWrite: boolean;
  /** Admin-level: approve expenses, issue pre-invoices, pay settlements, driver costs. */
  canApprove: boolean;
  /** Something that other screens show changed (alerts, orders): refresh the app data. */
  onDataChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('viajes');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [places, setPlaces] = useState<Array<Place & { customerName?: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [engine, setEngine] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<{ engine: string }>('/api/routing/status')
      .then((r) => setEngine(r.engine))
      .catch(() => setEngine(null));
  }, []);

  const allCompanies = tenant.id === 'all';
  const creationBlocked = allCompanies ? 'Elegí una empresa en el selector superior para crear registros.' : undefined;

  const notify = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === 'err' ? 9000 : 5000);
  }, []);

  const loadMasters = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        apiRequest<{ items: Customer[] }>('/api/tms/customers'),
        apiRequest<{ items: Array<Place & { customerName?: string }> }>('/api/tms/places'),
      ]);
      setCustomers(c.items);
      setPlaces(p.items);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err, 'No se pudieron cargar clientes y lugares.'));
    }
  }, []);
  useEffect(() => {
    void loadMasters();
  }, [loadMasters, tenant.id]);

  const changed = () => {
    setRefreshKey((k) => k + 1);
    onDataChanged?.();
  };

  const tabs: Array<[Tab, string, typeof Truck]> = [
    ['viajes', 'Viajes', Truck],
    ['planificador', 'Planificador', CalendarRange],
    ['despacho', 'Despacho', GanttChart],
    ['pedidos', 'Pedidos', ClipboardList],
    ['clientes', `Clientes (${customers.length})`, Building2],
    ['lugares', `Lugares (${places.length})`, MapPin],
    ['combustible', 'Combustible', Fuel],
    ['gastos', 'Gastos', Receipt],
    ['facturacion', 'Facturación', FileText],
    ['rentabilidad', 'Rentabilidad', TrendingUp],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/30">
            <Truck className="w-5 h-5 text-sky-400" aria-hidden />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-slate-100">Operaciones</h1>
            <p className="text-xs text-slate-400">
              Pedidos, viajes y seguimiento de entregas · {tenant.name}
              {engine && (
                <span className={`ml-2 px-1.5 py-0.5 rounded border text-[10px] ${engine === 'estimado' ? 'border-slate-700 text-slate-400' : 'border-emerald-500/40 text-emerald-300'}`} title="Motor de ruteo">
                  {engine === 'osrm+vroom' ? 'Rutas por calle + VROOM' : engine === 'osrm' ? 'Rutas por calle (OSRM)' : engine === 'vroom' ? 'Optimizador VROOM' : 'Distancias estimadas'}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1" role="tablist" aria-label="Secciones de operaciones">
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${tab === id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden /> {label}
            </button>
          ))}
        </div>
      </div>

      {!canWrite && <p className="text-xs text-slate-400">Tu perfil tiene acceso de consulta: podés ver pedidos y viajes, pero no crearlos ni modificarlos.</p>}
      {loadError && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{loadError}</div>}

      {tab === 'viajes' && <TripsPanel vehicles={vehicles} drivers={drivers} canWrite={canWrite} creationBlocked={creationBlocked} notify={notify} refreshKey={refreshKey} onChanged={changed} />}
      {tab === 'pedidos' && (
        <OrdersPanel customers={customers} places={places} canWrite={canWrite} creationBlocked={creationBlocked} notify={notify} refreshKey={refreshKey} onChanged={changed} />
      )}
      {tab === 'clientes' && <CustomersPanel customers={customers} places={places} canWrite={canWrite} creationBlocked={creationBlocked} notify={notify} onChanged={() => void loadMasters()} />}
      {tab === 'planificador' && <PlannerPanel places={places} canApprove={canApprove} creationBlocked={creationBlocked} notify={notify} onCreated={changed} />}
      {tab === 'despacho' && <DispatchPanel vehicles={vehicles} canWrite={canWrite} notify={notify} />}
      {tab === 'combustible' && <FuelPanel vehicles={vehicles} canWrite={canWrite} creationBlocked={creationBlocked} notify={notify} />}
      {tab === 'gastos' && <ExpensesPanel canWrite={canWrite} canApprove={canApprove} creationBlocked={creationBlocked} notify={notify} />}
      {tab === 'facturacion' && <BillingPanel customers={customers} drivers={drivers} canWrite={canWrite} canApprove={canApprove} creationBlocked={creationBlocked} notify={notify} />}
      {tab === 'rentabilidad' && <ProfitabilityPanel drivers={drivers} canApprove={canApprove} notify={notify} />}
      {tab === 'lugares' && <PlacesPanel places={places} customers={customers} canWrite={canWrite} creationBlocked={creationBlocked} notify={notify} onChanged={() => void loadMasters()} />}

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
