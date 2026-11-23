import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Loader2, Sparkles, Truck } from 'lucide-react';
import type { Vehicle } from '../../shared/types.ts';
import type { AssignmentCheck, Place } from '../../shared/tms.ts';
import { apiRequest } from '../../lib/api.ts';
import { TmsMap } from './TmsMap.tsx';
import type { OrderRow } from './OrdersPanel.tsx';
import { Field, btnGhost, btnPrimary, errMsg, fmtDateTime, fromLocalInput, inputCls, toLocalInput } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;

interface Candidate {
  id: string;
  unitCode?: string;
  plate?: string;
  name?: string;
  capacityKg?: number;
  capacityPallets?: number;
  available: boolean;
  reason: string | null;
}

interface Proposal {
  vehicleId: string;
  unitCode: string;
  plate: string;
  driverId: string | null;
  driverName: string | null;
  plannedStart: string;
  orderIds: string[];
  taskOrder: string[];
  stops: Array<{ taskId: string; orderId: string; kind: 'carga' | 'descarga'; placeName: string; lat: number; lng: number; arrival: string; lateMinutes: number }>;
  km: number;
  minutes: number;
  endAt: string;
  load: { maxKg: number; capacityKg?: number; maxPallets: number; capacityPallets?: number };
  check: AssignmentCheck | null;
  start: { lat: number; lng: number };
}

interface PlanResponse {
  engine: 'osrm' | 'estimado';
  optimizer: 'vroom' | 'propio';
  proposals: Proposal[];
  unassigned: Array<{ orderId: string; reason: string; message: string }>;
  excluded: Array<{ vehicleId: string; unitCode: string; reason: string }>;
}

function tomorrowAt7() {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(7, 0, 0, 0);
  return toLocalInput(d.toISOString());
}
const hm = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;

/**
 * Day planner: choose confirmed orders and available units; the optimizer proposes which unit takes
 * which orders and in which order (capacity, windows, authorized driver). Review and create the trips.
 */
export function PlannerPanel({ places, canApprove, creationBlocked, notify, onCreated }: { places: Place[]; canApprove: boolean; creationBlocked?: string; notify: Notify; onCreated: () => void }) {
  const [start, setStart] = useState(tomorrowAt7());
  const [depotId, setDepotId] = useState('');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [cand, setCand] = useState<{ vehicles: Candidate[]; drivers: Candidate[] } | null>(null);
  const [selOrders, setSelOrders] = useState<string[]>([]);
  const [selUnits, setSelUnits] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startIso = fromLocalInput(start);

  useEffect(() => {
    apiRequest<{ items: OrderRow[] }>('/api/tms/orders?status=confirmado&pageSize=100')
      .then((r) => {
        setOrders(r.items);
        setSelOrders(r.items.map((o) => o.id));
      })
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar los pedidos.')));
  }, []);
  useEffect(() => {
    if (!startIso || creationBlocked) return;
    apiRequest<{ vehicles: Candidate[]; drivers: Candidate[] }>(`/api/routing/candidates?start=${encodeURIComponent(startIso)}`)
      .then((c) => {
        setCand(c);
        setSelUnits((sel) => (sel.length ? sel.filter((id) => c.vehicles.some((v) => v.id === id && v.available)) : c.vehicles.filter((v) => v.available).slice(0, 4).map((v) => v.id)));
      })
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar las unidades.')));
    setPlan(null);
  }, [startIso, creationBlocked]);

  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<PlanResponse>('/api/routing/plan', { method: 'POST', body: JSON.stringify({ startTime: startIso, orderIds: selOrders, vehicleIds: selUnits, depotPlaceId: depotId || undefined }) });
      setPlan(r);
      setInclude(Object.fromEntries(r.proposals.map((p) => [p.vehicleId, Boolean(p.driverId) && !p.check?.blocks.length])));
      setActive(r.proposals[0]?.vehicleId ?? null);
    } catch (err) {
      setError(errMsg(err, 'No se pudo armar la propuesta.'));
    } finally {
      setBusy(false);
    }
  };

  const changeDriver = async (p: Proposal, driverId: string) => {
    const name = cand?.drivers.find((d) => d.id === driverId)?.name ?? null;
    try {
      const r = await apiRequest<{ check: AssignmentCheck }>('/api/tms/trips/validate', { method: 'POST', body: JSON.stringify({ vehicleId: p.vehicleId, driverId, plannedStart: p.plannedStart, orderIds: p.orderIds }) });
      setPlan((pl) => (pl ? { ...pl, proposals: pl.proposals.map((x) => (x.vehicleId === p.vehicleId ? { ...x, driverId, driverName: name, check: r.check } : x)) } : pl));
      setInclude((inc) => ({ ...inc, [p.vehicleId]: !r.check.blocks.length }));
    } catch (err) {
      notify(errMsg(err, 'No se pudo validar el chofer.'), 'err');
    }
  };

  const chosen = plan?.proposals.filter((p) => include[p.vehicleId]) ?? [];
  const missingReason = chosen.some((p) => p.check?.warnings.length && !reasons[p.vehicleId]?.trim());
  const apply = async () => {
    setBusy(true);
    try {
      const r = await apiRequest<{ created: Array<{ tripId: string }>; failed: Array<{ vehicleId: string; error: string }> }>('/api/routing/plan/apply', {
        method: 'POST',
        body: JSON.stringify({
          proposals: chosen.map((p) => ({
            vehicleId: p.vehicleId,
            driverId: p.driverId,
            plannedStart: p.plannedStart,
            orderIds: p.orderIds,
            taskOrder: p.taskOrder,
            acceptWarnings: p.check?.warnings.length ? { reason: reasons[p.vehicleId] } : undefined,
          })),
        }),
      });
      notify(`${r.created.length} viaje(s) creado(s): ${r.created.map((c) => c.tripId).join(', ')}${r.failed.length ? `. Con error: ${r.failed.map((f) => f.error).join(' ')}` : ''}`, r.failed.length ? 'warn' : 'ok');
      setPlan(null);
      onCreated();
      const left = await apiRequest<{ items: OrderRow[] }>('/api/tms/orders?status=confirmado&pageSize=100');
      setOrders(left.items);
      setSelOrders(left.items.map((o) => o.id));
    } catch (err) {
      const data = (err as { data?: { failed?: Array<{ error: string }> } }).data;
      notify(data?.failed?.length ? `No se creó ningún viaje: ${data.failed.map((f) => f.error).join(' ')}` : errMsg(err, 'No se pudieron crear los viajes.'), 'err');
    } finally {
      setBusy(false);
    }
  };

  const activeP = plan?.proposals.find((p) => p.vehicleId === active);
  const mapCircles = useMemo(
    () => activeP?.stops.map((s, i) => ({ id: s.taskId, lat: s.lat, lng: s.lng, radiusM: 150, label: `${i + 1}`, tone: s.lateMinutes ? ('current' as const) : ('default' as const) })) ?? [],
    [activeP]
  );
  const mapPath = useMemo(() => (activeP ? ([[activeP.start.lng, activeP.start.lat], ...activeP.stops.map((s) => [s.lng, s.lat])] as Array<[number, number]>) : null), [activeP]);
  const freeDrivers = cand?.drivers.filter((d) => d.available) ?? [];

  if (creationBlocked) return <p className="text-xs text-slate-400">{creationBlocked}</p>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <Field id="pl-start" label="Salida">
          <input id="pl-start" type="datetime-local" className={`${inputCls} font-mono`} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="pl-depot" label="Las unidades salen de" hint="Si no elegís depósito, cada unidad sale de donde está ahora.">
          <select id="pl-depot" className={inputCls} value={depotId} onChange={(e) => setDepotId(e.target.value)}>
            <option value="">Su posición actual</option>
            {places.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <button type="button" className={`${btnPrimary} mb-5`} disabled={busy || !selOrders.length || !selUnits.length} onClick={() => void propose()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Proponer viajes
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 text-xs">
        <section className="bg-[#11192C] border border-slate-800/80 rounded-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
            <span className="font-medium text-slate-200">Pedidos confirmados ({selOrders.length}/{orders.length})</span>
            <button type="button" className="text-sky-400 cursor-pointer" onClick={() => setSelOrders(selOrders.length === orders.length ? [] : orders.map((o) => o.id))}>{selOrders.length === orders.length ? 'Ninguno' : 'Todos'}</button>
          </div>
          <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800">
            {orders.map((o) => (
              <li key={o.id}>
                <label className="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-slate-800/40">
                  <input type="checkbox" className="mt-0.5" checked={selOrders.includes(o.id)} onChange={(e) => setSelOrders((s) => (e.target.checked ? [...s, o.id] : s.filter((x) => x !== o.id)))} />
                  <span className="flex-1">
                    <span className="font-mono text-slate-100">{o.id}</span> · {o.customerName}
                    <span className="block text-slate-400">{o.originName} → {o.destinationName}{o.cargo.weightKg ? ` · ${o.cargo.weightKg.toLocaleString('es-AR')} kg` : ''}{o.deliveryWindow ? ` · entrega ≤ ${fmtDateTime(o.deliveryWindow.to)}` : ''}</span>
                  </span>
                </label>
              </li>
            ))}
            {orders.length === 0 && <li className="px-3 py-4 text-slate-400">No hay pedidos confirmados.</li>}
          </ul>
        </section>
        <section className="bg-[#11192C] border border-slate-800/80 rounded-xl">
          <div className="px-3 py-2 border-b border-slate-800 font-medium text-slate-200">Unidades ({selUnits.length})</div>
          <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800">
            {cand?.vehicles.map((v) => (
              <li key={v.id}>
                <label className={`flex items-start gap-2 px-3 py-1.5 ${v.available ? 'cursor-pointer hover:bg-slate-800/40' : 'opacity-50'}`}>
                  <input type="checkbox" className="mt-0.5" disabled={!v.available} checked={selUnits.includes(v.id)} onChange={(e) => setSelUnits((s) => (e.target.checked ? [...s, v.id] : s.filter((x) => x !== v.id)))} />
                  <span className="flex-1">
                    <span className="text-slate-100">{v.unitCode}</span> <span className="text-slate-500">{v.plate}</span>
                    <span className="block text-slate-400">{v.available ? (v.capacityKg ? `${v.capacityKg.toLocaleString('es-AR')} kg${v.capacityPallets ? ` · ${v.capacityPallets} pallets` : ''}` : 'Sin capacidad cargada') : v.reason}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {plan && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            {plan.proposals.length} viaje(s) propuesto(s) · {plan.engine === 'osrm' ? 'tiempos por calle (OSRM)' : 'distancias estimadas'} · optimizador {plan.optimizer === 'vroom' ? 'VROOM' : 'propio'}.
            {freeDrivers.length < plan.proposals.length ? ' No hay choferes habilitados libres para todas las unidades.' : ''}
          </p>
          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-3">
            <div className="space-y-3">
              {plan.proposals.map((p) => {
                const pct = p.load.capacityKg ? Math.min(100, Math.round((p.load.maxKg / p.load.capacityKg) * 100)) : null;
                return (
                  <article key={p.vehicleId} className={`rounded-xl border p-3 text-xs cursor-pointer ${active === p.vehicleId ? 'border-sky-500/60 bg-sky-500/5' : 'border-slate-800 bg-[#11192C]'}`} onClick={() => setActive(p.vehicleId)}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <label className="inline-flex items-center gap-2 font-medium text-slate-100" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={Boolean(include[p.vehicleId])} disabled={!p.driverId || Boolean(p.check?.blocks.length)} onChange={(e) => setInclude((inc) => ({ ...inc, [p.vehicleId]: e.target.checked }))} />
                        <Truck className="w-4 h-4 text-sky-400" aria-hidden /> {p.unitCode} <span className="text-slate-500 font-normal">{p.plate}</span>
                      </label>
                      <span className="font-mono text-slate-300">{p.km.toLocaleString('es-AR')} km · {hm(p.minutes)} · vuelve libre {fmtDateTime(p.endAt)}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
                      <Field label="Chofer">
                        <select aria-label={`Chofer de ${p.unitCode}`} className={inputCls} value={p.driverId ?? ''} onChange={(e) => void changeDriver(p, e.target.value)}>
                          {!p.driverId && <option value="">Sin chofer libre</option>}
                          {freeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </Field>
                      <div>
                        <div className="text-[11px] font-medium text-slate-300 mb-1">Carga máxima</div>
                        {pct !== null ? (
                          <>
                            <div className="h-2 rounded-full bg-slate-800 overflow-hidden" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Ocupación de la carga">
                              <div className={`h-full ${pct > 95 ? 'bg-amber-400' : 'bg-sky-500'}`} style={{ width: `${pct}%` }} />
                            </div>
                            <div className="text-slate-400 mt-0.5">{p.load.maxKg.toLocaleString('es-AR')} de {p.load.capacityKg!.toLocaleString('es-AR')} kg ({pct} %)</div>
                          </>
                        ) : (
                          <div className="text-slate-400">{p.load.maxKg.toLocaleString('es-AR')} kg (unidad sin capacidad cargada)</div>
                        )}
                      </div>
                    </div>
                    <ol className="mt-2 space-y-0.5">
                      {p.stops.map((s, i) => (
                        <li key={s.taskId} className="flex justify-between gap-2">
                          <span className="text-slate-300">{i + 1}. {s.kind === 'carga' ? 'Carga' : 'Descarga'} · {s.placeName} <span className="text-slate-500 font-mono">{s.orderId}</span></span>
                          <span className={`font-mono ${s.lateMinutes ? 'text-rose-300' : 'text-slate-400'}`}>{fmtDateTime(s.arrival)}{s.lateMinutes ? ` (+${s.lateMinutes} min)` : ''}</span>
                        </li>
                      ))}
                    </ol>
                    {p.check && (p.check.blocks.length > 0 || p.check.warnings.length > 0) && (
                      <ul className="mt-2 space-y-1">
                        {p.check.blocks.map((b) => <li key={b.code + b.message} className="text-rose-300"><Ban className="inline w-3 h-3 mr-1" aria-hidden />{b.message}</li>)}
                        {p.check.warnings.map((w) => <li key={w.code + w.message} className="text-amber-300"><AlertTriangle className="inline w-3 h-3 mr-1" aria-hidden />{w.message}</li>)}
                      </ul>
                    )}
                    {p.check?.warnings.length && !p.check.blocks.length && include[p.vehicleId] ? (
                      canApprove ? (
                        <input
                          aria-label={`Motivo para aceptar las advertencias de ${p.unitCode}`}
                          placeholder="Motivo para aceptar las advertencias"
                          className={`${inputCls} mt-2`}
                          value={reasons[p.vehicleId] ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setReasons((r) => ({ ...r, [p.vehicleId]: e.target.value }))}
                        />
                      ) : (
                        <p className="mt-2 text-amber-300">Un administrador tiene que aceptar las advertencias.</p>
                      )
                    ) : null}
                  </article>
                );
              })}
            </div>
            <div className="space-y-3">
              {activeP && <TmsMap circles={mapCircles} path={mapPath} height={320} label={`Recorrido propuesto para ${activeP.unitCode}`} />}
              {(plan.unassigned.length > 0 || plan.excluded.length > 0) && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-1">
                  {plan.unassigned.map((u) => (
                    <p key={u.orderId} className="text-amber-200"><span className="font-mono">{u.orderId}</span> sin asignar: {u.message}</p>
                  ))}
                  {plan.excluded.map((x) => (
                    <p key={x.vehicleId} className="text-slate-400">{x.unitCode} no se usó: {x.reason}</p>
                  ))}
                </div>
              )}
              {plan.proposals.length === 0 && <p className="text-xs text-slate-400">No se pudo armar ningún viaje con esa selección.</p>}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setPlan(null)}>Descartar</button>
            <button type="button" className={btnPrimary} disabled={busy || !chosen.length || (missingReason && canApprove) || (!canApprove && chosen.some((p) => p.check?.warnings.length))} onClick={() => void apply()}>
              <CheckCircle2 className="w-3.5 h-3.5" /> Crear {chosen.length} viaje(s)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
