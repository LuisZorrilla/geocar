import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Ban, CheckCircle2, FileText, Link2, Route, Circle, CircleDot, Loader2, MapPin, Play, Plus, RefreshCw, Search, ShieldAlert, Truck, XCircle } from 'lucide-react';
import type { Driver, Vehicle } from '../../shared/types.ts';
import { ORDER_STATUS_LABELS, STOP_KIND_LABELS, type AssignmentCheck, type TripStatus, type TripStop, type Trip, type TransportOrder } from '../../shared/tms.ts';
import { distanceMeters, formatDistance } from '../../shared/geo.ts';
import { apiRequest, openWithAuth } from '../../lib/api.ts';
import { useMoney } from '../../lib/money.tsx';
import { Pagination } from '../Pagination.tsx';
import { ExportMenu } from '../ExportMenu.tsx';
import { TmsMap, type MapCircle } from './TmsMap.tsx';
import { ReasonDialog, type OrderRow } from './OrdersPanel.tsx';
import { CarrierTripCard } from './CarriersPanel.tsx';
import { AuthImage, Dialog, Field, TripStatusPill, btnGhost, btnPrimary, copyTrackingLink, errMsg, fmtDateTime, fromLocalInput, inputCls, stopLabel, stopToneClass, toLocalInput } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;

export type TripRow = Omit<Trip, 'stops'> & {
  unitCode: string;
  plate: string;
  driverName: string;
  tenantName?: string;
  stops: Array<TripStop & { placeName: string; address: string; lat: number; lng: number; radiusM: number }>;
  orders: Array<Pick<TransportOrder, 'id' | 'status' | 'reference' | 'cargo'> & { customerName: string }>;
  late: boolean;
  nextStopDistanceM?: number;
};
interface TripPage {
  items: TripRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { en_curso: number; planificado: number; atrasados: number; finalizadosHoy: number };
}

const PAGE = 15;

export function TripsPanel({
  vehicles,
  drivers,
  canWrite,
  creationBlocked,
  notify,
  refreshKey,
  onChanged,
}: {
  vehicles: Vehicle[];
  drivers: Driver[];
  canWrite: boolean;
  creationBlocked?: string;
  notify: Notify;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<TripStatus | 'activos' | ''>('activos');
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TripPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(qDraft.trim()), 300);
    return () => clearTimeout(t);
  }, [qDraft]);
  useEffect(() => setPage(1), [status, q]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    try {
      setData(await apiRequest<TripPage>(`/api/tms/trips?${params}`));
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'No se pudieron cargar los viajes.'));
    }
  }, [page, status, q]);
  useEffect(() => {
    void load();
    // The server advances stops every minute: refresh the board at the same pace.
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const evaluateNow = async () => {
    setEvaluating(true);
    try {
      const res = await apiRequest<{ changes: number }>('/api/tms/trips/evaluate', { method: 'POST' });
      notify(res.changes ? `Seguimiento actualizado: ${res.changes} cambio(s).` : 'Seguimiento al día: sin cambios.');
      await load();
      if (res.changes) onChanged();
    } catch (err) {
      notify(errMsg(err, 'No se pudo actualizar el seguimiento.'), 'err');
    } finally {
      setEvaluating(false);
    }
  };

  const kpis: Array<[string, number | undefined, string, TripStatus | 'activos' | '']> = [
    ['En curso', data?.counts.en_curso, 'text-amber-300', 'en_curso'],
    ['Planificados', data?.counts.planificado, 'text-indigo-300', 'planificado'],
    ['Demorados', data?.counts.atrasados, 'text-rose-300', 'activos'],
    ['Finalizados hoy', data?.counts.finalizadosHoy, 'text-emerald-300', 'finalizado'],
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map(([label, n, color, target]) => (
          <button key={label} type="button" onClick={() => setStatus(target)} className="text-left bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5 hover:border-slate-600 cursor-pointer">
            <div className="text-xs text-slate-400">{label}</div>
            <div className={`text-xl font-semibold font-mono tabular-nums mt-1 ${color}`}>{n ?? '—'}</div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1" role="tablist" aria-label="Estado de los viajes">
          {(
            [
              ['activos', 'Activos'],
              ['en_curso', 'En curso'],
              ['planificado', 'Planificados'],
              ['finalizado', 'Finalizados'],
              ['cancelado', 'Cancelados'],
              ['', 'Todos'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={status === key}
              onClick={() => setStatus(key)}
              className={`px-2.5 py-1 rounded-md text-xs cursor-pointer whitespace-nowrap ${status === key ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Buscar viaje, unidad, chofer o lugar…" aria-label="Buscar viajes" className={`${inputCls} pl-8`} />
        </div>
        {canWrite && (
          <button type="button" className={btnGhost} onClick={() => void evaluateNow()} disabled={evaluating} title="Recalcula llegadas y salidas con la última posición de cada unidad (también se hace solo cada minuto)">
            <RefreshCw className={`w-3.5 h-3.5 ${evaluating ? 'animate-spin' : ''}`} /> Actualizar seguimiento
          </button>
        )}
        <ExportMenu url="/api/tms/trips/export" params={{ status: status || undefined, q: q || undefined }} count={data?.total} filtered={Boolean(status || q)} fileName="viajes" />
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setCreating(true)}>
            <Plus className="w-3.5 h-3.5" /> Nuevo viaje
          </button>
        )}
      </div>
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-4 font-medium">Viaje</th>
                <th className="py-2.5 px-4 font-medium">Unidad / Chofer</th>
                <th className="py-2.5 px-4 font-medium">Paradas</th>
                <th className="py-2.5 px-4 font-medium">Próxima parada</th>
                <th className="py-2.5 px-4 font-medium">Salida</th>
                <th className="py-2.5 px-4 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data?.items.map((t) => {
                const next = t.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');
                return (
                  <tr key={t.id} className="hover:bg-slate-800/30 cursor-pointer" onClick={() => setOpenId(t.id)} title="Ver detalle">
                    <td className="py-2.5 px-4">
                      <div className="font-mono font-semibold text-sky-300">{t.id}</div>
                      <div className="text-slate-500">{t.orders.length} pedido(s){t.tenantName ? ` · ${t.tenantName}` : ''}</div>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="text-slate-100">{t.unitCode} <span className="text-slate-500">{t.plate}</span></div>
                      <div className="text-slate-400">{t.driverName}</div>
                    </td>
                    <td className="py-2.5 px-4">
                      <StopDots stops={t.stops} />
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">
                      {next ? (
                        <>
                          <div>
                            {STOP_KIND_LABELS[next.kind]} · {next.placeName}
                          </div>
                          <div className="text-slate-500">
                            {next.status === 'en_lugar' ? 'En el lugar' : t.nextStopDistanceM !== undefined ? `a ${formatDistance(t.nextStopDistanceM)}` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-300 whitespace-nowrap">{fmtDateTime(t.startedAt ?? t.plannedStart)}</td>
                    <td className="py-2.5 px-4">
                      <TripStatusPill status={t.status} late={t.late} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && data.items.length === 0 && <div className="p-8 text-center text-slate-400">No hay viajes con estos filtros. Armá uno con «Nuevo viaje» a partir de pedidos confirmados.</div>}
        {data && <Pagination page={data.page} totalItems={data.total} pageSize={PAGE} onPageChange={setPage} />}
      </div>
      {creating && (
        <TripWizard
          vehicles={vehicles}
          drivers={drivers}
          onClose={() => setCreating(false)}
          onCreated={(trip) => {
            setCreating(false);
            notify(`Viaje ${trip.id} planificado con ${trip.stops.length} parada(s).`);
            void load();
            onChanged();
            setOpenId(trip.id);
          }}
        />
      )}
      {openId && (
        <TripDetail
          tripId={openId}
          vehicles={vehicles}
          canWrite={canWrite}
          notify={notify}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function StopDots({ stops }: { stops: TripRow['stops'] }) {
  const done = stops.filter((s) => s.status === 'completada').length;
  return (
    <div className="flex items-center gap-1" aria-label={`${done} de ${stops.length} paradas completadas`}>
      {stops.map((s) =>
        s.status === 'completada' ? (
          <CheckCircle2 key={s.id} className="w-3.5 h-3.5 text-emerald-400" aria-hidden />
        ) : s.status === 'en_lugar' ? (
          <CircleDot key={s.id} className="w-3.5 h-3.5 text-amber-300" aria-hidden />
        ) : s.status === 'omitida' ? (
          <XCircle key={s.id} className="w-3.5 h-3.5 text-rose-400" aria-hidden />
        ) : (
          <Circle key={s.id} className="w-3.5 h-3.5 text-slate-600" aria-hidden />
        )
      )}
      <span className="ml-1 font-mono text-slate-400">
        {done}/{stops.length}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- wizard

function defaultStart() {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return toLocalInput(d.toISOString());
}

function CheckList({ check }: { check: AssignmentCheck }) {
  if (!check.blocks.length && !check.warnings.length) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">
        <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden /> Unidad y chofer habilitados para estos pedidos.
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {check.blocks.map((b) => (
        <li key={b.code + b.message} className="flex items-start gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/35 text-rose-200">
          <Ban className="w-4 h-4 shrink-0 mt-px" aria-hidden />
          <span>
            <strong className="font-semibold">Bloqueo:</strong> {b.message}
          </span>
        </li>
      ))}
      {check.warnings.map((w) => (
        <li key={w.code + w.message} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
          <span>
            <strong className="font-semibold">Advertencia:</strong> {w.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TripWizard({ vehicles, drivers, onClose, onCreated }: { vehicles: Vehicle[]; drivers: Driver[]; onClose: () => void; onCreated: (trip: TripRow) => void }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [start, setStart] = useState(defaultStart());
  const [notes, setNotes] = useState('');
  const [check, setCheck] = useState<AssignmentCheck | null>(null);
  const [canOverride, setCanOverride] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ items: OrderRow[] }>('/api/tms/orders?status=confirmado&pageSize=100')
      .then((r) => setOrders(r.items))
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar los pedidos.')));
  }, []);

  const trucks = useMemo(() => [...vehicles].sort((a, b) => Number(b.assetType === 'vehiculo') - Number(a.assetType === 'vehiculo') || a.unitCode.localeCompare(b.unitCode)), [vehicles]);
  const chosen = orders?.filter((o) => selected.includes(o.id)) ?? [];
  const totals = chosen.reduce((a, o) => ({ kg: a.kg + (o.cargo.weightKg ?? 0), pallets: a.pallets + (o.cargo.pallets ?? 0) }), { kg: 0, pallets: 0 });
  const vehicle = vehicles.find((v) => v.id === vehicleId);
  const startIso = fromLocalInput(start);

  // Live assignment check.
  useEffect(() => {
    if (!vehicleId || !driverId || !startIso || selected.length === 0) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(() => {
      apiRequest<{ check: AssignmentCheck; canOverride: boolean }>('/api/tms/trips/validate', {
        method: 'POST',
        body: JSON.stringify({ vehicleId, driverId, plannedStart: startIso, orderIds: selected }),
      })
        .then((r) => {
          if (cancelled) return;
          setCheck(r.check);
          setCanOverride(r.canOverride);
        })
        .catch((err) => !cancelled && setError(errMsg(err, 'No se pudo validar la asignación.')))
        .finally(() => !cancelled && setChecking(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [vehicleId, driverId, startIso, selected.join(',')]);

  const blocked = Boolean(check?.blocks.length);
  const needsReason = Boolean(check?.warnings.length);
  const ready = selected.length > 0 && vehicleId && driverId && startIso && check && !checking && !blocked && (!needsReason || (canOverride && reason.trim()));

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest<{ trip: TripRow }>('/api/tms/trips', {
        method: 'POST',
        body: JSON.stringify({ vehicleId, driverId, plannedStart: startIso, orderIds: selected, notes, ...(needsReason ? { acceptWarnings: { reason } } : {}) }),
      });
      onCreated(res.trip);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear el viaje.'));
      setSaving(false);
    }
  };

  return (
    <Dialog title="Nuevo viaje" subtitle="Elegí los pedidos, la unidad, el chofer y la salida" onClose={onClose} wide>
      <div className="space-y-4">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">1 · Pedidos confirmados</h3>
          {!orders ? (
            <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando…</div>
          ) : orders.length === 0 ? (
            <div className="p-3 rounded-lg border border-slate-800 text-slate-400">No hay pedidos confirmados para planificar. Creá o confirmá pedidos en la pestaña «Pedidos».</div>
          ) : (
            <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800">
              {orders.map((o) => (
                <li key={o.id}>
                  <label className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-slate-800/40">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.includes(o.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, o.id] : s.filter((x) => x !== o.id)))}
                    />
                    <span className="flex-1">
                      <span className="font-mono text-slate-100">{o.id}</span> · {o.customerName}
                      <span className="block text-slate-400">
                        {o.originName} → {o.destinationName} · {o.cargo.description}
                        {o.cargo.weightKg ? ` · ${o.cargo.weightKg.toLocaleString('es-AR')} kg` : ''}
                      </span>
                    </span>
                    <span className="font-mono text-slate-500 whitespace-nowrap">{o.deliveryWindow ? `entrega ≤ ${fmtDateTime(o.deliveryWindow.to)}` : ''}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {selected.length > 0 && (
            <p className="mt-1.5 text-slate-400">
              {selected.length} pedido(s) · {totals.kg.toLocaleString('es-AR')} kg · {totals.pallets} pallets
            </p>
          )}
        </section>
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <h3 className="md:col-span-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">2 · Asignación</h3>
          <Field id="trp-veh" label="Unidad" hint={vehicle ? (vehicle.capacityKg !== undefined ? `Capacidad: ${vehicle.capacityKg.toLocaleString('es-AR')} kg${vehicle.capacityPallets ? ` · ${vehicle.capacityPallets} pallets` : ''}` : 'Sin capacidad cargada') : undefined}>
            <select id="trp-veh" className={inputCls} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Elegí la unidad…</option>
              {trucks.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.unitCode} · {v.plate} · {v.brandModel}
                </option>
              ))}
            </select>
          </Field>
          <Field id="trp-drv" label="Chofer">
            <select id="trp-drv" className={inputCls} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Elegí el chofer…</option>
              {[...drivers].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="trp-start" label="Salida planificada">
            <input id="trp-start" type="datetime-local" className={`${inputCls} font-mono`} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
        </section>
        <section aria-live="polite">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">3 · Validación</h3>
          {checking ? (
            <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Verificando chofer, unidad y horarios…</div>
          ) : check ? (
            <CheckList check={check} />
          ) : (
            <p className="text-slate-500">Elegí pedidos, unidad, chofer y salida para validar la asignación.</p>
          )}
          {check && !blocked && needsReason && (
            canOverride ? (
              <div className="mt-3">
                <Field id="trp-reason" label="Motivo para aceptar las advertencias (queda en la auditoría)">
                  <input id="trp-reason" className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: carga parcial, el cliente aceptó la demora" />
                </Field>
              </div>
            ) : (
              <p className="mt-2 text-amber-300">Tu perfil no puede aceptar advertencias: pedíselo a un administrador o cambiá la asignación.</p>
            )
          )}
        </section>
        <Field id="trp-notes" label="Notas del viaje (opcional)">
          <textarea id="trp-notes" rows={2} className={inputCls} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={!ready || saving} onClick={() => void submit()}>
            <Truck className="w-3.5 h-3.5" /> {saving ? 'Planificando…' : 'Planificar viaje'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- detail

export function TripDetail({
  tripId,
  vehicles,
  canWrite,
  notify,
  onClose,
  onChanged,
}: {
  tripId: string;
  vehicles: Vehicle[];
  canWrite: boolean;
  notify: Notify;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [trip, setTrip] = useState<TripRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [skipping, setSkipping] = useState<TripRow['stops'][number] | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [optimizing, setOptimizing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrip((await apiRequest<{ trip: TripRow }>(`/api/tms/trips/${encodeURIComponent(tripId)}`)).trip);
    } catch (err) {
      setError(errMsg(err, 'No se pudo cargar el viaje.'));
    }
  }, [tripId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<{ trip: TripRow }>, msg: string, tone: 'ok' | 'warn' = 'ok') => {
    setBusy(true);
    try {
      setTrip((await fn()).trip);
      notify(msg, tone);
      onChanged();
    } catch (err) {
      notify(errMsg(err, 'No se pudo completar la acción.'), 'err');
    } finally {
      setBusy(false);
    }
  };

  const vehicle = trip ? vehicles.find((v) => v.id === trip.vehicleId) : undefined;
  const current = trip?.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');
  const circles = useMemo<MapCircle[]>(
    () =>
      trip?.stops.map((s) => ({
        id: s.id,
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        label: `${s.seq}. ${s.placeName}`,
        tone: s.status === 'completada' ? 'done' : s.id === current?.id ? 'current' : 'default',
      })) ?? [],
    [trip, current?.id]
  );
  const carrierPos = trip?.carrier?.lastPosition;
  const unit = useMemo(
    () => (carrierPos ? { lat: carrierPos.lat, lng: carrierPos.lng, label: trip?.carrier?.plate ?? 'Fletero' } : vehicle ? { lat: vehicle.lat, lng: vehicle.lng, label: vehicle.unitCode } : null),
    [carrierPos?.lat, carrierPos?.lng, trip?.carrier?.plate, vehicle?.lat, vehicle?.lng, vehicle?.unitCode]
  );
  const editable = canWrite && trip && (trip.status === 'planificado' || trip.status === 'en_curso');
  const routeKey = trip ? `${trip.id}|${trip.status}|${trip.stops.map((s) => `${s.id}:${s.status}`).join(',')}` : '';
  useEffect(() => {
    if (!trip) return;
    apiRequest<RouteInfo>(`/api/routing/trips/${encodeURIComponent(trip.id)}/route`)
      .then(setRoute)
      .catch(() => setRoute(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
  const etaOf = (stopId: string) => route?.etas.find((e) => e.stopId === stopId);

  const move = (idx: number, dir: -1 | 1) => {
    if (!trip) return;
    const ids = trip.stops.map((s) => s.id);
    [ids[idx], ids[idx + dir]] = [ids[idx + dir], ids[idx]];
    void act(() => apiRequest(`/api/tms/trips/${trip.id}`, { method: 'PATCH', body: JSON.stringify({ stopOrder: ids }) }), 'Orden de paradas actualizado.');
  };

  return (
    <Dialog
      title={trip ? `Viaje ${trip.id}` : 'Viaje'}
      subtitle={trip ? `${trip.unitCode} ${trip.plate} · ${trip.driverName} · salida ${fmtDateTime(trip.plannedStart)}` : undefined}
      onClose={onClose}
      wide
    >
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
      {!trip ? (
        !error && <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando…</div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TripStatusPill status={trip.status} late={trip.late} />
              {trip.startedAt && <span className="text-slate-400">Inició {fmtDateTime(trip.startedAt)}</span>}
              {trip.finishedAt && <span className="text-slate-400">· Finalizó {fmtDateTime(trip.finishedAt)}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnGhost} onClick={() => void openWithAuth(`/api/tms/trips/${encodeURIComponent(trip.id)}/hoja-de-ruta.pdf`).catch((err) => notify(errMsg(err, 'No se pudo abrir la hoja de ruta.'), 'err'))}>
                <FileText className="w-3.5 h-3.5" /> Hoja de ruta
              </button>
              {canWrite && trip.status === 'planificado' && trip.stops.length > 2 && (
                <button type="button" className={btnGhost} onClick={() => setOptimizing(true)}>
                  <Route className="w-3.5 h-3.5" /> Optimizar orden
                </button>
              )}
            {editable && (
              <>
                {trip.status === 'planificado' && (
                  <button type="button" className={btnPrimary} disabled={busy} onClick={() => void act(() => apiRequest(`/api/tms/trips/${trip.id}/start`, { method: 'POST' }), `Viaje ${trip.id} iniciado.`)}>
                    <Play className="w-3.5 h-3.5" /> Iniciar ahora
                  </button>
                )}
                <button type="button" className={`${btnGhost} text-rose-300`} disabled={busy} onClick={() => setCancelling(true)}>
                  <XCircle className="w-3.5 h-3.5" /> Cancelar viaje
                </button>
              </>
            )}
            </div>
          </div>
          {trip.overrides && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-px" aria-hidden />
              <span>
                Planificado aceptando advertencias ({trip.overrides.warnings.join(' ')}) — por {trip.overrides.by}: «{trip.overrides.reason}».
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-4">
            <ol className="space-y-2" aria-label="Paradas">
              {trip.stops.map((s, i) => (
                <li key={s.id} className={`rounded-lg border p-3 ${s.id === current?.id ? 'border-amber-500/50 bg-amber-500/5' : 'border-slate-800 bg-[#11192C]'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-100">
                        {s.seq}. {STOP_KIND_LABELS[s.kind]} · {s.placeName}
                      </div>
                      <div className="text-slate-500">{s.address}</div>
                      <div className="text-slate-400 font-mono">
                        {s.window ? `Ventana ${fmtDateTime(s.window.from)} – ${fmtDateTime(s.window.to)}` : 'Sin ventana'} · {s.orderIds.join(', ')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`font-medium ${stopToneClass(s.status)}`}>{stopLabel(s.status)}</div>
                      {s.arrivedAt && <div className="font-mono text-slate-400">Llegó {fmtDateTime(s.arrivedAt)}</div>}
                      {s.departedAt && <div className="font-mono text-slate-400">Salió {fmtDateTime(s.departedAt)}</div>}
                      {(s.status === 'pendiente' || s.status === 'en_lugar') && etaOf(s.id) && (
                        <div className={`font-mono ${etaOf(s.id)!.lateMinutes ? 'text-rose-300' : 'text-sky-300'}`}>
                          ETA {fmtDateTime(etaOf(s.id)!.eta)}
                          {etaOf(s.id)!.lateMinutes ? ` · ${etaOf(s.id)!.lateMinutes} min tarde` : ''}
                        </div>
                      )}
                      {s.detection && <div className="text-slate-500">{s.detection === 'auto' ? 'Por geocerca' : s.detection === 'app' ? 'Desde la app del chofer' : 'Registrada a mano'}</div>}
                    </div>
                  </div>
                  {s.note && <div className="mt-1 text-slate-400">Nota: {s.note}</div>}
                  {s.pod && (
                    <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-emerald-300">Prueba de entrega</div>
                          <div className="text-slate-200">Recibió {s.pod.receiverName} · DNI {s.pod.receiverDni}</div>
                          <div className="text-slate-400">
                            {fmtDateTime(s.pod.at)} · por {s.pod.by}
                            {s.pod.lat !== undefined && s.pod.lng !== undefined ? ` · a ${formatDistance(distanceMeters({ lat: s.pod.lat, lng: s.pod.lng }, s))} del lugar` : ' · sin ubicación'}
                          </div>
                          {s.pod.note && <div className="text-slate-400">Obs.: {s.pod.note}</div>}
                        </div>
                        <AuthImage src={`/api/tms/files/${s.pod.signatureFileId}`} alt={`Firma de ${s.pod.receiverName}`} className="h-16 w-40 rounded bg-white object-contain" />
                      </div>
                      {s.pod.photoFileIds.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {s.pod.photoFileIds.map((id, i) => (
                            <AuthImage key={id} src={`/api/tms/files/${id}`} alt={`Foto ${i + 1} de la entrega`} className="h-20 w-28 rounded object-cover" />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {editable && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {trip.status === 'planificado' && (
                        <>
                          <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Subir parada ${s.seq}`} className="p-1 rounded border border-slate-700 text-slate-300 disabled:opacity-30 cursor-pointer">
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button type="button" disabled={busy || i === trip.stops.length - 1} onClick={() => move(i, 1)} aria-label={`Bajar parada ${s.seq}`} className="p-1 rounded border border-slate-700 text-slate-300 disabled:opacity-30 cursor-pointer">
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      {s.id === current?.id && (
                        <>
                          {s.status === 'pendiente' && (
                            <button
                              type="button"
                              disabled={busy}
                              className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
                              onClick={() => void act(() => apiRequest(`/api/tms/trips/${trip.id}/stops/${s.id}`, { method: 'POST', body: JSON.stringify({ status: 'en_lugar' }) }), `Llegada a ${s.placeName} registrada.`)}
                            >
                              <MapPin className="inline w-3 h-3 mr-1" />
                              Marcar llegada
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className="px-2 py-1 rounded border border-emerald-600/50 text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                            onClick={() => void act(() => apiRequest(`/api/tms/trips/${trip.id}/stops/${s.id}`, { method: 'POST', body: JSON.stringify({ status: 'completada' }) }), `${STOP_KIND_LABELS[s.kind]} en ${s.placeName} completada.`)}
                          >
                            Marcar completada
                          </button>
                          <button type="button" disabled={busy} className="px-2 py-1 rounded border border-rose-600/40 text-rose-300 hover:bg-rose-500/10 cursor-pointer" onClick={() => setSkipping(s)}>
                            Omitir
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <div className="space-y-3">
              <TmsMap circles={circles} unit={unit} path={route?.geometry} height={300} label={`Mapa del viaje ${trip.id}`} />
              {route && (
                <p className="text-slate-400">
                  {route.fromUnit && trip.status === 'en_curso' ? 'Lo que falta: ' : 'Recorrido: '}
                  <span className="font-mono text-slate-200">{route.km.toLocaleString('es-AR')} km · {Math.floor(route.minutes / 60)} h {route.minutes % 60} min</span>{' '}
                  <span className="text-slate-500">({route.engine === 'osrm' ? 'rutas por calle' : 'distancias estimadas'})</span>
                </p>
              )}
              {trip.carrier && <CarrierTripCard tripId={trip.id} status={trip.status} carrier={trip.carrier} canWrite={canWrite} notify={notify} onChanged={() => void load()} />}
              {trip.status !== 'planificado' && trip.status !== 'cancelado' && <TripEconomicsCard tripId={trip.id} version={trip.updatedAt} />}
              <div className="rounded-lg border border-slate-800 bg-[#11192C]">
                <div className="px-3 py-2 border-b border-slate-800 font-medium text-slate-200">Pedidos</div>
                <ul className="divide-y divide-slate-800">
                  {trip.orders.map((o) => (
                    <li key={o.id} className="px-3 py-2 flex items-center justify-between gap-2">
                      <span>
                        <span className="font-mono text-slate-100">{o.id}</span> · {o.customerName}
                        <span className="block text-slate-500">{o.cargo.description}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-slate-400">{ORDER_STATUS_LABELS[o.status]}</span>
                        <button
                          type="button"
                          title="Remito (PDF)"
                          aria-label={`Remito de ${o.id}`}
                          className="p-1 rounded text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                          onClick={() => void openWithAuth(`/api/tms/orders/${encodeURIComponent(o.id)}/remito.pdf`).catch((err) => notify(errMsg(err, 'No se pudo abrir el remito.'), 'err'))}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                        {canWrite && (
                          <button
                            type="button"
                            title="Copiar link de seguimiento para el cliente"
                            aria-label={`Copiar link de seguimiento de ${o.id}`}
                            className="p-1 rounded text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                            onClick={() =>
                              void copyTrackingLink(o.id)
                                .then(() => notify(`Link de seguimiento de ${o.id} copiado: pegalo en el mail o WhatsApp al cliente.`))
                                .catch((err) => notify(errMsg(err, 'No se pudo generar el link.'), 'err'))
                            }
                          >
                            <Link2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#11192C]">
                <div className="px-3 py-2 border-b border-slate-800 font-medium text-slate-200">Historial</div>
                <ul className="max-h-48 overflow-y-auto divide-y divide-slate-800">
                  {trip.history.map((h, i) => (
                    <li key={i} className="px-3 py-2">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium text-slate-200">{h.action}</span>
                        <span className="font-mono text-slate-500">{fmtDateTime(h.at)}</span>
                      </div>
                      <div className="text-slate-400">{h.detail}</div>
                      <div className="text-slate-500">{h.actor}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
      {optimizing && trip && (
        <OptimizeDialog
          trip={trip}
          onClose={() => setOptimizing(false)}
          onApplied={(t) => {
            setOptimizing(false);
            setTrip(t);
            notify(`Orden de paradas de ${t.id} optimizado.`);
            onChanged();
          }}
        />
      )}
      {cancelling && trip && (
        <ReasonDialog
          title={`Cancelar ${trip.id}`}
          description="Los pedidos no entregados vuelven a «Confirmado» para planificarlos de nuevo."
          action="Cancelar viaje"
          onClose={() => setCancelling(false)}
          onSubmit={async (reason) => {
            const res = await apiRequest<{ trip: TripRow }>(`/api/tms/trips/${trip.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
            setTrip(res.trip);
            setCancelling(false);
            notify(`Viaje ${trip.id} cancelado.`, 'warn');
            onChanged();
          }}
        />
      )}
      {skipping && trip && (
        <ReasonDialog
          title={`Omitir parada ${skipping.seq} · ${skipping.placeName}`}
          description={skipping.kind === 'descarga' ? 'Sus pedidos no se marcan como entregados y vuelven a «Confirmado».' : undefined}
          action="Omitir parada"
          onClose={() => setSkipping(null)}
          onSubmit={async (note) => {
            const res = await apiRequest<{ trip: TripRow }>(`/api/tms/trips/${trip.id}/stops/${skipping.id}`, { method: 'POST', body: JSON.stringify({ status: 'omitida', note }) });
            setTrip(res.trip);
            setSkipping(null);
            notify(`Parada ${skipping.placeName} omitida.`, 'warn');
            onChanged();
          }}
        />
      )}
    </Dialog>
  );
}

interface Economics {
  revenue: number;
  unpricedOrders: string[];
  cost: { lines: Array<{ label: string; amount: number }>; total: number; km: number; kmSource: 'odometro' | 'estimado'; fuelEstimated: boolean };
  margin: number;
  marginPct: number | null;
  currency: string | null;
}

/** Revenue, cost breakdown and margin of a trip (T3). */
function TripEconomicsCard({ tripId, version }: { tripId: string; version: string }) {
  const money = useMoney();
  const [e, setE] = useState<Economics | null>(null);
  useEffect(() => {
    apiRequest<{ economics: Economics }>(`/api/costs/trips/${encodeURIComponent(tripId)}`)
      .then((r) => setE(r.economics))
      .catch(() => setE(null));
  }, [tripId, version]);
  if (!e) return null;
  const f = (n: number) => money.fmtIn(n, e.currency);
  return (
    <div className="rounded-lg border border-slate-800 bg-[#11192C]">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <span className="font-medium text-slate-200">Costo y margen</span>
        <span className="text-slate-500">{e.cost.km} km {e.cost.kmSource === 'odometro' ? '(odómetro)' : '(estimado)'}</span>
      </div>
      <dl className="px-3 py-2 space-y-1">
        <div className="flex justify-between"><dt className="text-slate-300">Ingresos (pedidos entregados)</dt><dd className="font-mono text-slate-100">{f(e.revenue)}</dd></div>
        {e.cost.lines.map((l) => (
          <div key={l.label} className="flex justify-between"><dt className="text-slate-400">− {l.label}</dt><dd className="font-mono text-slate-300">{f(l.amount)}</dd></div>
        ))}
        <div className="flex justify-between border-t border-slate-800 pt-1">
          <dt className="font-medium text-slate-200">Margen</dt>
          <dd className={`font-mono font-semibold ${e.margin < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
            {f(e.margin)}{e.marginPct !== null ? ` (${e.marginPct} %)` : ''}
          </dd>
        </div>
      </dl>
      {(e.unpricedOrders.length > 0 || e.cost.fuelEstimated) && (
        <p className="px-3 pb-2 text-amber-300">
          {e.unpricedOrders.length > 0 ? `${e.unpricedOrders.join(', ')} sin precio (cargalo en Pedidos). ` : ''}
          {e.cost.fuelEstimated ? 'Combustible estimado: no hay cargas registradas en el viaje.' : ''}
        </p>
      )}
    </div>
  );
}

interface RouteInfo {
  engine: 'osrm' | 'estimado';
  km: number;
  minutes: number;
  geometry: Array<[number, number]>;
  etas: Array<{ stopId: string; eta: string; lateMinutes: number }>;
  fromUnit: boolean;
}

interface OptimizeResult {
  engine: 'osrm' | 'estimado';
  exact: boolean;
  changed: boolean;
  current: { order: string[]; km: number; minutes: number; lateStops: number };
  proposed: { order: string[]; km: number; minutes: number; lateStops: number };
}

/** Before / after of the stop order proposed by the optimizer; applying saves the new order. */
function OptimizeDialog({ trip, onClose, onApplied }: { trip: TripRow; onClose: () => void; onApplied: (t: TripRow) => void }) {
  const [res, setRes] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiRequest<OptimizeResult>(`/api/routing/trips/${encodeURIComponent(trip.id)}/optimize`, { method: 'POST' })
      .then(setRes)
      .catch((err) => setError(errMsg(err, 'No se pudo optimizar.')));
  }, [trip.id]);
  const name = (id: string) => {
    const s = trip.stops.find((x) => x.id === id);
    return s ? `${STOP_KIND_LABELS[s.kind]} · ${s.placeName}` : id;
  };
  const hm = (m: number) => `${Math.floor(m / 60)} h ${m % 60} min`;
  const apply = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const r = await apiRequest<{ trip: TripRow }>(`/api/tms/trips/${encodeURIComponent(trip.id)}`, { method: 'PATCH', body: JSON.stringify({ stopOrder: res.proposed.order }) });
      onApplied(r.trip);
    } catch (err) {
      setError(errMsg(err, 'No se pudo aplicar.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Optimizar ${trip.id}`} subtitle="Orden de paradas más corto que respeta las ventanas y carga antes de descargar" onClose={onClose}>
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
      {!res && !error && <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Calculando…</div>}
      {res && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {([['Actual', res.current], ['Propuesto', res.proposed]] as const).map(([label, r]) => (
              <div key={label} className={`rounded-lg border p-3 ${label === 'Propuesto' ? 'border-sky-500/40 bg-sky-500/5' : 'border-slate-800'}`}>
                <div className="font-medium text-slate-200">{label}</div>
                <div className="font-mono text-slate-100">{r.km.toLocaleString('es-AR')} km · {hm(r.minutes)}</div>
                <div className={r.lateStops ? 'text-rose-300' : 'text-emerald-300'}>{r.lateStops ? `${r.lateStops} parada(s) fuera de ventana` : 'Todas en ventana'}</div>
                <ol className="mt-2 space-y-0.5 text-slate-300 list-decimal list-inside">
                  {r.order.map((id) => <li key={id}>{name(id)}</li>)}
                </ol>
              </div>
            ))}
          </div>
          <p className="text-slate-500">
            {res.engine === 'osrm' ? 'Distancias y tiempos por calle (OSRM).' : 'Distancias estimadas (línea recta × 1,25): instalá OSRM para rutas por calle.'}
            {res.exact ? ' Se probaron todas las combinaciones posibles.' : ''}
          </p>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" className={btnGhost} onClick={onClose}>Cerrar</button>
            <button type="button" className={btnPrimary} disabled={!res.changed || busy} onClick={() => void apply()}>
              {res.changed ? `Aplicar (ahorra ${Math.max(0, Math.round((res.current.km - res.proposed.km) * 10) / 10)} km)` : 'El orden actual ya es el mejor'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
