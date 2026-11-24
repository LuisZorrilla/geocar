import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { AlertTriangle, Copy, Link2, Loader2, MessageCircle, Pencil, Plus, Smartphone, Star, Trash2, Truck } from 'lucide-react';
import {
  CARRIER_DOC_LABELS,
  CARRIER_SETTLEMENT_STATUS,
  type Carrier,
  type CarrierDocProblem,
  type CarrierDocType,
  type CarrierSettlement,
  type TripCarrier,
} from '../../shared/carriers.ts';
import { apiRequest, ApiError } from '../../lib/api.ts';
import { useMoney } from '../../lib/money.tsx';
import { ExportMenu } from '../ExportMenu.tsx';
import { ReasonDialog, type OrderRow } from './OrdersPanel.tsx';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, fmtDateTime, fromLocalInput, inputCls, toLocalInput } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
type CarrierRow = Carrier & { trips: number; finished: number; openTrips: number; rating: number | null; ratings: number; lateDeliveries: number; docProblems: CarrierDocProblem[] };
type SettlementRow = CarrierSettlement & { carrierName: string };
const card = 'bg-[#11192C] border border-slate-800/80 rounded-xl';
const todayIso = () => new Date().toISOString().slice(0, 10);

function DocBadges({ problems }: { problems: CarrierDocProblem[] }) {
  if (!problems.length) return <span className="text-emerald-300">Al día</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {problems.map((p, i) => (
        <span key={i} className={`px-1.5 py-0.5 rounded border text-[10px] ${p.problem === 'por_vencer' ? 'border-amber-500/40 text-amber-300' : 'border-rose-500/40 text-rose-300'}`}>
          {p.label}: {p.problem === 'falta' ? 'falta' : p.problem === 'vencido' ? `vencido ${p.expiresAt}` : `vence ${p.expiresAt}`}
        </span>
      ))}
    </div>
  );
}

const Stars = ({ value }: { value: number | null }) =>
  value === null ? <span className="text-slate-500">Sin calificar</span> : (
    <span className="inline-flex items-center gap-0.5 text-amber-300">
      <Star className="w-3 h-3 fill-current" /> {value.toLocaleString('es-AR')}
    </span>
  );

/** Third-party carriers: catalog with documents, trips with a carrier and their settlements. */
export function CarriersPanel({ canWrite, canApprove, creationBlocked, notify, onChanged }: { canWrite: boolean; canApprove: boolean; creationBlocked?: string; notify: Notify; onChanged: () => void }) {
  const money = useMoney();
  const [items, setItems] = useState<CarrierRow[] | null>(null);
  const [settlements, setSettlements] = useState<SettlementRow[] | null>(null);
  const [editing, setEditing] = useState<CarrierRow | 'new' | null>(null);
  const [newTrip, setNewTrip] = useState<CarrierRow | null>(null);
  const [newSettlement, setNewSettlement] = useState(false);
  const [voiding, setVoiding] = useState<SettlementRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([apiRequest<{ items: CarrierRow[] }>('/api/carriers'), apiRequest<{ items: SettlementRow[] }>('/api/carriers/settlements')]);
      setItems(a.items);
      setSettlements(b.items);
    } catch (err) {
      notify(errMsg(err, 'No se pudieron cargar los fleteros.'), 'err');
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);

  const pay = async (s: SettlementRow) => {
    const reference = window.prompt(`Pagar ${s.id} a ${s.carrierName}. Referencia del pago (transferencia, cheque) — opcional:`, '');
    if (reference === null) return;
    try {
      await apiRequest(`/api/carriers/settlements/${s.id}/pay`, { method: 'POST', body: JSON.stringify({ reference }) });
      notify(`${s.id} marcada como pagada.`);
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo marcar como pagada.'), 'err');
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Fleteros</h2>
            <p className="text-xs text-slate-400">Transportistas tercerizados: documentación con vencimientos, viajes con precio pactado y seguimiento por un link en su celular.</p>
          </div>
          {canWrite && (
            <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setEditing('new')}>
              <Plus className="w-3.5 h-3.5" /> Nuevo fletero
            </button>
          )}
        </div>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-3 font-medium">Fletero</th>
                <th className="py-2.5 px-3 font-medium">Documentación</th>
                <th className="py-2.5 px-3 font-medium">Vehículos</th>
                <th className="py-2.5 px-3 font-medium">Viajes</th>
                <th className="py-2.5 px-3 font-medium">Calificación</th>
                <th className="py-2.5 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {items?.map((c) => (
                <tr key={c.id} className={`hover:bg-slate-800/30 ${c.active ? '' : 'opacity-50'}`}>
                  <td className="py-2 px-3">
                    <div className="text-slate-100 font-medium">{c.name}</div>
                    <div className="text-slate-500 font-mono">{c.taxId}{c.phone ? ` · ${c.phone}` : ''}</div>
                  </td>
                  <td className="py-2 px-3"><DocBadges problems={c.docProblems} /></td>
                  <td className="py-2 px-3 font-mono text-slate-300">{c.vehicles.map((v) => v.plate).join(', ') || '—'}</td>
                  <td className="py-2 px-3 text-slate-300">
                    {c.openTrips > 0 && <span className="text-amber-300">{c.openTrips} abiertos · </span>}
                    {c.finished} finalizados
                    {c.lateDeliveries > 0 && <div className="text-rose-300">{c.lateDeliveries} con entrega tarde</div>}
                  </td>
                  <td className="py-2 px-3"><Stars value={c.rating} />{c.ratings > 0 && <span className="text-slate-500"> ({c.ratings})</span>}</td>
                  <td className="py-2 px-3">
                    <div className="flex justify-end gap-1">
                      {canWrite && c.active && (
                        <button type="button" className={btnGhost} onClick={() => setNewTrip(c)}>
                          <Truck className="w-3.5 h-3.5" /> Asignar viaje
                        </button>
                      )}
                      {canWrite && (
                        <button type="button" aria-label={`Editar ${c.name}`} className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer" onClick={() => setEditing(c)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items && items.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay fleteros.</div>}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Liquidaciones a fleteros</h2>
            <p className="text-xs text-slate-400">Viajes finalizados de un período al precio pactado.</p>
          </div>
          {canApprove && (
            <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked) || !items?.length} title={creationBlocked} onClick={() => setNewSettlement(true)}>
              <Plus className="w-3.5 h-3.5" /> Nueva liquidación
            </button>
          )}
        </div>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-3 font-medium">Liquidación</th>
                <th className="py-2.5 px-3 font-medium">Fletero</th>
                <th className="py-2.5 px-3 font-medium">Período</th>
                <th className="py-2.5 px-3 font-medium text-right">Total</th>
                <th className="py-2.5 px-3 font-medium">Estado</th>
                <th className="py-2.5 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {settlements?.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/30">
                  <td className="py-2 px-3 font-mono text-slate-100">{s.id}<div className="text-slate-500 font-sans">{s.lines.length} viaje(s)</div></td>
                  <td className="py-2 px-3 text-slate-200">{s.carrierName}</td>
                  <td className="py-2 px-3 font-mono text-slate-300">{s.periodFrom} a {s.periodTo}</td>
                  <td className="py-2 px-3 text-right font-mono text-slate-100">{money.fmtIn(s.total, s.currency)}</td>
                  <td className={`py-2 px-3 font-medium ${s.status === 'pagada' ? 'text-emerald-300' : s.status === 'anulada' ? 'text-slate-500 line-through' : 'text-amber-300'}`}>
                    {CARRIER_SETTLEMENT_STATUS[s.status]}{s.paidAt ? ` ${fmtDateTime(s.paidAt)}` : ''}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex justify-end items-center gap-1">
                      <ExportMenu url={`/api/carriers/settlements/${s.id}/export`} fileName={s.id} label="Descargar" />
                      {canApprove && s.status === 'borrador' && <button type="button" className={btnGhost} onClick={() => void pay(s)}>Marcar pagada</button>}
                      {canApprove && s.status !== 'anulada' && <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => setVoiding(s)}>Anular</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {settlements && settlements.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay liquidaciones.</div>}
        </div>
      </section>

      {editing && (
        <CarrierDialog
          carrier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            notify(msg);
            void load();
          }}
        />
      )}
      {newTrip && (
        <CarrierTripDialog
          carrier={newTrip}
          canApprove={canApprove}
          onClose={() => setNewTrip(null)}
          onCreated={(id) => {
            setNewTrip(null);
            notify(`Viaje ${id} con ${newTrip.name} planificado. Generá el link para el chofer desde el detalle del viaje.`);
            void load();
            onChanged();
          }}
        />
      )}
      {newSettlement && items && (
        <NewCarrierSettlementDialog
          carriers={items}
          onClose={() => setNewSettlement(false)}
          onDone={(msg) => {
            setNewSettlement(false);
            notify(msg);
            void load();
          }}
        />
      )}
      {voiding && (
        <ReasonDialog
          title={`Anular ${voiding.id}`}
          description="Sus viajes quedan libres para otra liquidación."
          action="Anular liquidación"
          onClose={() => setVoiding(null)}
          onSubmit={async (reason) => {
            await apiRequest(`/api/carriers/settlements/${voiding.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
            setVoiding(null);
            notify('Liquidación anulada.', 'warn');
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- carrier form

type DocDraft = { id?: string; type: CarrierDocType; number: string; expiresAt: string };
type VehicleDraft = { plate: string; description: string; capacityKg: string };

function CarrierDialog({ carrier, onClose, onSaved }: { carrier: CarrierRow | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({
    name: carrier?.name ?? '',
    taxId: carrier?.taxId ?? '',
    contactName: carrier?.contactName ?? '',
    phone: carrier?.phone ?? '',
    email: carrier?.email ?? '',
    notes: carrier?.notes ?? '',
    active: carrier?.active ?? true,
  });
  const [docs, setDocs] = useState<DocDraft[]>(
    carrier?.documents.map((d) => ({ id: d.id, type: d.type, number: d.number ?? '', expiresAt: d.expiresAt ?? '' })) ?? [
      { type: 'seguro_carga', number: '', expiresAt: '' },
      { type: 'ruta', number: '', expiresAt: '' },
    ]
  );
  const [vehicles, setVehicles] = useState<VehicleDraft[]>(carrier?.vehicles.map((v) => ({ plate: v.plate, description: v.description ?? '', capacityKg: v.capacityKg ? String(v.capacityKg) : '' })) ?? [{ plate: '', description: '', capacityKg: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      ...f,
      documents: docs.map((d) => ({ id: d.id, type: d.type, number: d.number || undefined, expiresAt: d.expiresAt || undefined })),
      vehicles: vehicles.filter((v) => v.plate.trim()).map((v) => ({ plate: v.plate, description: v.description || undefined, capacityKg: v.capacityKg ? Number(v.capacityKg) : undefined })),
    };
    try {
      if (carrier) await apiRequest(`/api/carriers/${carrier.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await apiRequest('/api/carriers', { method: 'POST', body: JSON.stringify(body) });
      onSaved(carrier ? 'Fletero actualizado.' : 'Fletero creado.');
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={carrier ? `Editar ${carrier.name}` : 'Nuevo fletero'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="car-name" label="Nombre o razón social"><input id="car-name" className={inputCls} value={f.name} onChange={set('name')} /></Field>
          <Field id="car-cuit" label="CUIT"><input id="car-cuit" className={inputCls} value={f.taxId} onChange={set('taxId')} /></Field>
          <Field id="car-contact" label="Contacto"><input id="car-contact" className={inputCls} value={f.contactName} onChange={set('contactName')} /></Field>
          <Field id="car-phone" label="Teléfono"><input id="car-phone" className={inputCls} value={f.phone} onChange={set('phone')} /></Field>
          <Field id="car-email" label="Email"><input id="car-email" className={inputCls} value={f.email} onChange={set('email')} /></Field>
          <label className="flex items-center gap-2 text-xs text-slate-300 mt-6"><input type="checkbox" checked={f.active} onChange={(e) => setF((x) => ({ ...x, active: e.target.checked }))} /> Activo</label>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Documentación</div>
          <p className="text-xs text-slate-500">Sin seguro de carga ni RUTA vigentes, un viaje solo se asigna con la aprobación de un administrador.</p>
          {docs.map((d, i) => (
            <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2">
              <select aria-label="Tipo" className={inputCls} value={d.type} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, type: e.target.value as CarrierDocType } : x)))}>
                {Object.entries(CARRIER_DOC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input aria-label="Número" placeholder="Número / póliza" className={inputCls} value={d.number} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))} />
              <input aria-label="Vencimiento" type="date" className={inputCls} value={d.expiresAt} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, expiresAt: e.target.value } : x)))} />
              <button type="button" aria-label="Quitar documento" className="p-2 rounded-md text-slate-400 hover:text-rose-300 cursor-pointer" onClick={() => setDocs((all) => all.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button type="button" className="text-xs text-sky-400 hover:underline cursor-pointer" onClick={() => setDocs((all) => [...all, { type: 'otro', number: '', expiresAt: '' }])}>+ Agregar documento</button>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Vehículos</div>
          {vehicles.map((v, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.6fr_1fr_auto] gap-2">
              <input aria-label="Patente" placeholder="Patente" className={`${inputCls} font-mono uppercase`} value={v.plate} onChange={(e) => setVehicles((all) => all.map((x, j) => (j === i ? { ...x, plate: e.target.value } : x)))} />
              <input aria-label="Descripción" placeholder="Tipo (semi, chasis, utilitario)" className={inputCls} value={v.description} onChange={(e) => setVehicles((all) => all.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <input aria-label="Capacidad kg" placeholder="Capacidad (kg)" inputMode="numeric" className={inputCls} value={v.capacityKg} onChange={(e) => setVehicles((all) => all.map((x, j) => (j === i ? { ...x, capacityKg: e.target.value } : x)))} />
              <button type="button" aria-label="Quitar vehículo" className="p-2 rounded-md text-slate-400 hover:text-rose-300 cursor-pointer" onClick={() => setVehicles((all) => all.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button type="button" className="text-xs text-sky-400 hover:underline cursor-pointer" onClick={() => setVehicles((all) => [...all, { plate: '', description: '', capacityKg: '' }])}>+ Agregar vehículo</button>
        </div>
        <Field id="car-notes" label="Notas"><textarea id="car-notes" className={`${inputCls} h-16`} value={f.notes} onChange={set('notes')} /></Field>
        {error && <div role="alert" className="text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Guardar</button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- trip with a carrier

function CarrierTripDialog({ carrier, canApprove, onClose, onCreated }: { carrier: CarrierRow; canApprove: boolean; onClose: () => void; onCreated: (tripId: string) => void }) {
  const money = useMoney();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [f, setF] = useState({ plate: carrier.vehicles[0]?.plate ?? '', driverName: '', driverDni: '', driverPhone: carrier.phone ?? '', price: '', plannedStart: toLocalInput(new Date(Date.now() + 2 * 3600_000).toISOString()), notes: '' });
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = carrier.docProblems.filter((p) => p.problem !== 'por_vencer');
  useEffect(() => {
    apiRequest<{ items: OrderRow[] }>('/api/tms/orders?status=confirmado&pageSize=200')
      .then((r) => setOrders(r.items))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar los pedidos.')));
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const weight = useMemo(() => (orders ?? []).filter((o) => picked.includes(o.id)).reduce((a, o) => a + (o.cargo.weightKg ?? 0), 0), [orders, picked]);
  const capacity = carrier.vehicles.find((v) => v.plate === f.plate.toUpperCase())?.capacityKg;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ trip: { id: string } }>('/api/carriers/trips', {
        method: 'POST',
        body: JSON.stringify({
          carrierId: carrier.id,
          plate: f.plate,
          driverName: f.driverName,
          driverDni: f.driverDni || undefined,
          driverPhone: f.driverPhone || undefined,
          price: Number(f.price.replace(/\./g, '').replace(',', '.')),
          plannedStart: fromLocalInput(f.plannedStart),
          orderIds: picked,
          notes: f.notes || undefined,
          ...(blocking.length ? { acceptWarnings: { reason: override } } : {}),
        }),
      });
      onCreated(r.trip.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errMsg(err, 'No se pudo crear el viaje.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Viaje con ${carrier.name}`} subtitle="El costo del viaje es el precio pactado; la posición llega desde el celular del chofer." onClose={onClose} wide>
      <div className="space-y-4">
        {blocking.length > 0 && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-100 space-y-2">
            <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="w-4 h-4" /> Documentación con problemas</div>
            <DocBadges problems={blocking} />
            {canApprove ? (
              <Field id="ct-override" label="Motivo para asignarlo igual (queda auditado)">
                <input id="ct-override" className={inputCls} value={override} onChange={(e) => setOverride(e.target.value)} />
              </Field>
            ) : (
              <p>Solo un administrador puede asignarle un viaje así.</p>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field id="ct-plate" label="Patente">
            <input id="ct-plate" list="ct-plates" className={`${inputCls} font-mono uppercase`} value={f.plate} onChange={set('plate')} />
            <datalist id="ct-plates">{carrier.vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.description}</option>)}</datalist>
          </Field>
          <Field id="ct-driver" label="Chofer"><input id="ct-driver" className={inputCls} value={f.driverName} onChange={set('driverName')} /></Field>
          <Field id="ct-dni" label="DNI del chofer"><input id="ct-dni" className={inputCls} inputMode="numeric" value={f.driverDni} onChange={set('driverDni')} /></Field>
          <Field id="ct-phone" label="Celular (para el link)"><input id="ct-phone" className={inputCls} value={f.driverPhone} onChange={set('driverPhone')} /></Field>
          <Field id="ct-price" label="Precio pactado"><input id="ct-price" className={inputCls} inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
          <Field id="ct-start" label="Salida"><input id="ct-start" type="datetime-local" className={inputCls} value={f.plannedStart} onChange={set('plannedStart')} /></Field>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-slate-400">Pedidos confirmados</div>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/60">
            {orders?.map((o) => (
              <label key={o.id} className="flex items-center gap-2 p-2 text-xs cursor-pointer hover:bg-slate-800/30">
                <input type="checkbox" checked={picked.includes(o.id)} onChange={(e) => setPicked((all) => (e.target.checked ? [...all, o.id] : all.filter((x) => x !== o.id)))} />
                <span className="font-mono text-slate-100">{o.id}</span>
                <span className="text-slate-300">{o.customerName}</span>
                <span className="text-slate-500 truncate">{o.originName} → {o.destinationName} · {o.cargo.description}{o.cargo.weightKg ? ` · ${o.cargo.weightKg} kg` : ''}</span>
              </label>
            ))}
            {orders && orders.length === 0 && <div className="p-4 text-center text-xs text-slate-400">No hay pedidos confirmados sin viaje.</div>}
          </div>
          {picked.length > 0 && (
            <div className={`text-xs ${capacity && weight > capacity ? 'text-amber-300' : 'text-slate-400'}`}>
              {picked.length} pedido(s) · {weight.toLocaleString('es-AR')} kg{capacity ? ` de ${capacity.toLocaleString('es-AR')} kg del vehículo` : ''}
              {f.price && ` · costo ${money.fmt(Number(f.price.replace(/\./g, '').replace(',', '.')) || 0)}`}
            </div>
          )}
        </div>
        <Field id="ct-notes" label="Notas"><input id="ct-notes" className={inputCls} value={f.notes} onChange={set('notes')} /></Field>
        {error && <div role="alert" className="text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !picked.length || !f.price || f.driverName.trim().length < 3 || f.plate.trim().length < 5 || (blocking.length > 0 && (!canApprove || override.trim().length < 3))}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Planificar viaje
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function NewCarrierSettlementDialog({ carriers, onClose, onDone }: { carriers: CarrierRow[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [carrierId, setCarrierId] = useState(carriers[0]?.id ?? '');
  const [from, setFrom] = useState(`${todayIso().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ settlement: CarrierSettlement }>('/api/carriers/settlements', { method: 'POST', body: JSON.stringify({ carrierId, from, to }) });
      onDone(`Liquidación ${r.settlement.id} creada: ${r.settlement.lines.length} viaje(s).`);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Nueva liquidación a fletero" onClose={onClose}>
      <div className="space-y-3">
        <Field id="cs-carrier" label="Fletero">
          <select id="cs-carrier" className={inputCls} value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="cs-from" label="Desde"><input id="cs-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field id="cs-to" label="Hasta"><input id="cs-to" type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {error && <div role="alert" className="text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || !carrierId} onClick={() => void create()}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Crear</button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- card in the trip detail

/** Carrier block of a trip: who runs it, price, phone link (QR / WhatsApp) and rating. */
export function CarrierTripCard({ tripId, status, carrier, canWrite, notify, onChanged }: { tripId: string; status: string; carrier: TripCarrier; canWrite: boolean; notify: Notify; onChanged: () => void }) {
  const money = useMoney();
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState<number>(carrier.rating?.score ?? 0);
  const [comment, setComment] = useState(carrier.rating?.comment ?? '');
  const open = status === 'planificado' || status === 'en_curso';
  const issue = async () => {
    setBusy(true);
    try {
      const r = await apiRequest<{ path: string }>(`/api/carriers/trips/${tripId}/link`, { method: 'POST' });
      const url = `${window.location.origin}${r.path}`;
      setLink({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) });
      onChanged();
    } catch (err) {
      notify(errMsg(err, 'No se pudo generar el link.'), 'err');
    } finally {
      setBusy(false);
    }
  };
  const editPrice = async () => {
    const v = window.prompt('Nuevo precio pactado:', String(carrier.price));
    if (!v) return;
    try {
      await apiRequest(`/api/carriers/trips/${tripId}`, { method: 'PATCH', body: JSON.stringify({ price: Number(v.replace(/\./g, '').replace(',', '.')) }) });
      notify('Precio actualizado.');
      onChanged();
    } catch (err) {
      notify(errMsg(err, 'No se pudo cambiar el precio.'), 'err');
    }
  };
  const rate = async () => {
    try {
      await apiRequest(`/api/carriers/trips/${tripId}/rating`, { method: 'POST', body: JSON.stringify({ score, comment: comment || undefined }) });
      notify('Calificación guardada.');
      onChanged();
    } catch (err) {
      notify(errMsg(err, 'No se pudo calificar.'), 'err');
    }
  };
  const phone = (carrier.driverPhone ?? '').replace(/\D/g, '');
  const wa = link ? `https://wa.me/${phone}?text=${encodeURIComponent(`Hola ${carrier.driverName}, este es el link del viaje ${tripId}: ${link.url}\nAbrilo en el celular y dejalo abierto durante el viaje (comparte la ubicación).`)}` : '';

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-violet-200">Fletero: {carrier.carrierName}</div>
          <div className="text-slate-300 font-mono">{carrier.plate} · {carrier.driverName}{carrier.driverDni ? ` (DNI ${carrier.driverDni})` : ''}</div>
          <div className="text-slate-300">
            Precio pactado <span className="font-mono text-slate-100">{money.fmt(carrier.price)}</span>
            {carrier.settlementId && <span className="text-slate-500"> · en {carrier.settlementId}</span>}
            {canWrite && !carrier.settlementId && status !== 'cancelado' && <button type="button" className="ml-2 text-sky-400 hover:underline cursor-pointer" onClick={() => void editPrice()}>cambiar</button>}
          </div>
          <div className="text-slate-400">
            {carrier.lastPosition ? `Última ubicación del celular: ${fmtDateTime(carrier.lastPosition.at)}` : 'El celular todavía no compartió ubicación.'}
          </div>
        </div>
        {canWrite && open && (
          <button type="button" className={btnGhost} disabled={busy} onClick={() => void issue()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5" />} {carrier.linkActive ? 'Link nuevo' : 'Link para el chofer'}
          </button>
        )}
      </div>
      {link && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-2">
          <img src={link.qr} alt="QR del link del viaje" className="w-28 h-28 rounded bg-white p-1" />
          <div className="space-y-1.5 min-w-0 flex-1">
            <p className="text-amber-200">Se muestra una sola vez. Quien tenga el link ve solo este viaje y puede marcar llegadas y entregas.</p>
            <code className="block break-all text-[11px] text-slate-300">{link.url}</code>
            <div className="flex gap-1">
              <button type="button" className={btnGhost} onClick={() => void navigator.clipboard?.writeText(link.url).then(() => notify('Link copiado.'))}><Copy className="w-3.5 h-3.5" /> Copiar</button>
              {phone && <a className={btnGhost} href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle className="w-3.5 h-3.5" /> WhatsApp</a>}
            </div>
          </div>
        </div>
      )}
      {!link && carrier.linkActive && open && <div className="flex items-center gap-1 text-emerald-300"><Link2 className="w-3.5 h-3.5" /> El chofer tiene un link activo.</div>}
      {status === 'finalizado' && canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
          <span className="text-slate-400">Calificación:</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-label={`${n} estrellas`} onClick={() => setScore(n)} className="cursor-pointer">
              <Star className={`w-4 h-4 ${n <= score ? 'text-amber-300 fill-current' : 'text-slate-600'}`} />
            </button>
          ))}
          <input className={`${inputCls} flex-1 min-w-[140px]`} placeholder="Comentario (opcional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button type="button" className={btnGhost} disabled={!score} onClick={() => void rate()}>Guardar</button>
        </div>
      )}
    </div>
  );
}
