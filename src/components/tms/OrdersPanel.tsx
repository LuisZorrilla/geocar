import { useCallback, useEffect, useState } from 'react';
import { useMoney } from '../../lib/money.tsx';
import { parseAmount, TARIFF_RULE_LABELS, type ChargeLine, type TariffRuleKind } from '../../shared/costs.ts';
import { CheckCircle2, FileText, Link2, Pencil, Plus, Search, XCircle } from 'lucide-react';
import type { Customer, OrderStatus, Place, TransportOrder } from '../../shared/tms.ts';
import { apiRequest, openWithAuth } from '../../lib/api.ts';
import { Pagination } from '../Pagination.tsx';
import { ExportMenu } from '../ExportMenu.tsx';
import { Dialog, Field, OrderStatusPill, copyTrackingLink, btnGhost, btnPrimary, errMsg, fmtDateTime, fromLocalInput, inputCls, toLocalInput } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
export type OrderRow = TransportOrder & { customerName: string; originName: string; destinationName: string; tenantName?: string };
interface OrderPage {
  items: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<OrderStatus, number>;
}

const PAGE = 15;

export function OrdersPanel({
  customers,
  places,
  canWrite,
  creationBlocked,
  notify,
  refreshKey,
  onChanged,
}: {
  customers: Customer[];
  places: Place[];
  canWrite: boolean;
  creationBlocked?: string;
  notify: Notify;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<OrderStatus | 'activos' | ''>('activos');
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrderPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrderRow | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  const [pricing, setPricing] = useState<OrderRow | null>(null);
  const money = useMoney();

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
      setData(await apiRequest<OrderPage>(`/api/tms/orders?${params}`));
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'No se pudieron cargar los pedidos.'));
    }
  }, [page, status, q]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const changed = (msg: string, tone?: 'ok' | 'warn') => {
    notify(msg, tone);
    void load();
    onChanged();
  };

  const confirm = async (o: OrderRow) => {
    try {
      await apiRequest(`/api/tms/orders/${o.id}/confirm`, { method: 'POST' });
      changed(`Pedido ${o.id} confirmado: ya se puede planificar.`);
    } catch (err) {
      notify(errMsg(err, 'No se pudo confirmar.'), 'err');
    }
  };

  const tabs: Array<[OrderStatus | 'activos' | '', string, number | undefined]> = [
    ['activos', 'Activos', data ? Object.entries(data.counts).filter(([k]) => k !== 'entregado' && k !== 'cancelado').reduce((a, [, n]) => a + n, 0) : undefined],
    ['borrador', 'Borradores', data?.counts.borrador],
    ['confirmado', 'Por planificar', data?.counts.confirmado],
    ['en_curso', 'En curso', data?.counts.en_curso],
    ['entregado', 'Entregados', data?.counts.entregado],
    ['', 'Todos', undefined],
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1" role="tablist" aria-label="Estado de los pedidos">
          {tabs.map(([key, label, n]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={status === key}
              onClick={() => setStatus(key)}
              className={`px-2.5 py-1 rounded-md text-xs cursor-pointer whitespace-nowrap ${status === key ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {label}
              {n !== undefined ? ` (${n})` : ''}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Buscar pedido, cliente, lugar o referencia…" aria-label="Buscar pedidos" className={`${inputCls} pl-8`} />
        </div>
        <ExportMenu url="/api/tms/orders/export" params={{ status: status || undefined, q: q || undefined }} count={data?.total} filtered={Boolean(status || q)} fileName="pedidos" />
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setEditing('new')}>
            <Plus className="w-3.5 h-3.5" /> Nuevo pedido
          </button>
        )}
      </div>
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-4 font-medium">Pedido / Cliente</th>
                <th className="py-2.5 px-4 font-medium">Origen → Destino</th>
                <th className="py-2.5 px-4 font-medium">Carga</th>
                <th className="py-2.5 px-4 font-medium">Entrega</th>
                <th className="py-2.5 px-4 font-medium text-right">Precio</th>
                <th className="py-2.5 px-4 font-medium">Estado</th>
                <th className="py-2.5 px-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data?.items.map((o) => (
                <tr key={o.id} className="hover:bg-slate-800/30 align-top">
                  <td className="py-2.5 px-4">
                    <div className="font-mono font-semibold text-slate-100">{o.id}</div>
                    <div className="text-slate-300">{o.customerName}</div>
                    {o.reference && <div className="text-slate-500">Ref. {o.reference}</div>}
                    {o.tenantName && <div className="text-slate-500">{o.tenantName}</div>}
                  </td>
                  <td className="py-2.5 px-4 text-slate-300">
                    <div>{o.originName}</div>
                    <div className="text-slate-500">→ {o.destinationName}</div>
                  </td>
                  <td className="py-2.5 px-4 text-slate-300">
                    <div>{o.cargo.description}</div>
                    <div className="text-slate-500 font-mono">
                      {[o.cargo.weightKg ? `${o.cargo.weightKg.toLocaleString('es-AR')} kg` : null, o.cargo.pallets ? `${o.cargo.pallets} pallets` : null, o.cargo.dangerous ? 'peligrosa' : null, o.cargo.refrigerated ? 'frío' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-300 whitespace-nowrap">
                    {o.deliveryWindow ? (
                      <>
                        <div>{fmtDateTime(o.deliveryWindow.from)}</div>
                        <div className="text-slate-500">hasta {fmtDateTime(o.deliveryWindow.to)}</div>
                      </>
                    ) : (
                      <span className="text-slate-500">Sin ventana</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-right whitespace-nowrap">
                    {o.charge ? (
                      <>
                        <div className="font-mono text-slate-100">{money.fmtIn(o.charge.amount, o.charge.currency)}</div>
                        <div className="text-slate-500">
                          {o.charge.rule === 'manual' ? 'ajustado' : o.charge.rule ? TARIFF_RULE_LABELS[o.charge.rule].toLowerCase() : ''}
                          {o.charge.preInvoiceId ? ` · ${o.charge.preInvoiceId}` : ''}
                        </div>
                      </>
                    ) : o.status === 'entregado' ? (
                      <span className="text-amber-300">Sin precio</span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                    {canWrite && o.status === 'entregado' && !o.charge?.preInvoiceId && (
                      <button type="button" className="block ml-auto mt-0.5 text-sky-400 hover:underline cursor-pointer" onClick={() => setPricing(o)}>
                        {o.charge ? 'Ajustar' : 'Poner precio'}
                      </button>
                    )}
                  </td>
                  <td className="py-2.5 px-4">
                    <OrderStatusPill status={o.status} />
                    {o.tripId && <div className="mt-1 font-mono text-slate-500">{o.tripId}</div>}
                    {o.cancelReason && <div className="mt-1 text-slate-500">{o.cancelReason}</div>}
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex justify-end gap-1">
                      {o.status !== 'cancelado' && (
                        <button
                          type="button"
                          title="Remito (PDF)"
                          aria-label={`Remito de ${o.id}`}
                          className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                          onClick={() => void openWithAuth(`/api/tms/orders/${encodeURIComponent(o.id)}/remito.pdf`).catch((err) => notify(errMsg(err, 'No se pudo abrir el remito.'), 'err'))}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canWrite && o.status !== 'cancelado' && (
                        <button
                          type="button"
                          title="Copiar link de seguimiento para el cliente"
                          aria-label={`Copiar link de seguimiento de ${o.id}`}
                          className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                          onClick={() =>
                            void copyTrackingLink(o.id)
                              .then(() => notify(`Link de seguimiento de ${o.id} copiado.`))
                              .catch((err) => notify(errMsg(err, 'No se pudo generar el link.'), 'err'))
                          }
                        >
                          <Link2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {canWrite && (
                      <div className="flex justify-end gap-1">
                        {o.status === 'borrador' && (
                          <button type="button" onClick={() => void confirm(o)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-emerald-300 hover:bg-emerald-500/10 cursor-pointer">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Confirmar
                          </button>
                        )}
                        {(o.status === 'borrador' || o.status === 'confirmado') && (
                          <button type="button" onClick={() => setEditing(o)} aria-label={`Editar ${o.id}`} title="Editar" className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {(o.status === 'borrador' || o.status === 'confirmado' || o.status === 'planificado') && (
                          <button type="button" onClick={() => setCancelling(o)} aria-label={`Cancelar ${o.id}`} title="Cancelar pedido" className="p-1.5 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer">
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.items.length === 0 && (
          <div className="p-8 text-center text-slate-400">
            {customers.length === 0 || places.length < 2 ? 'Para crear pedidos, primero cargá al menos un cliente y dos lugares.' : 'No hay pedidos con estos filtros.'}
          </div>
        )}
        {data && <Pagination page={data.page} totalItems={data.total} pageSize={PAGE} onPageChange={setPage} />}
      </div>
      {editing && (
        <OrderForm
          order={editing === 'new' ? null : editing}
          customers={customers}
          places={places}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            changed(msg);
          }}
        />
      )}
      {pricing && (
        <ChargeDialog
          order={pricing}
          onClose={() => setPricing(null)}
          onDone={(msg) => {
            setPricing(null);
            changed(msg);
          }}
        />
      )}
      {cancelling && (
        <ReasonDialog
          title={`Cancelar ${cancelling.id}`}
          description={cancelling.status === 'planificado' ? `El pedido sale del viaje ${cancelling.tripId}. Si el viaje queda sin pedidos, se cancela.` : 'El pedido no se podrá planificar.'}
          action="Cancelar pedido"
          onClose={() => setCancelling(null)}
          onSubmit={async (reason) => {
            await apiRequest(`/api/tms/orders/${cancelling.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
            setCancelling(null);
            changed(`Pedido ${cancelling.id} cancelado.`, 'warn');
          }}
        />
      )}
    </div>
  );
}

function OrderForm({ order, customers, places, onClose, onSaved }: { order: OrderRow | null; customers: Customer[]; places: Place[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [customerId, setCustomerId] = useState(order?.customerId ?? '');
  const [originPlaceId, setOrigin] = useState(order?.originPlaceId ?? '');
  const [destinationPlaceId, setDestination] = useState(order?.destinationPlaceId ?? '');
  const [description, setDescription] = useState(order?.cargo.description ?? '');
  const [weightKg, setWeight] = useState(order?.cargo.weightKg?.toString() ?? '');
  const [volumeM3, setVolume] = useState(order?.cargo.volumeM3?.toString() ?? '');
  const [pallets, setPallets] = useState(order?.cargo.pallets?.toString() ?? '');
  const [dangerous, setDangerous] = useState(Boolean(order?.cargo.dangerous));
  const [refrigerated, setRefrigerated] = useState(Boolean(order?.cargo.refrigerated));
  const [pFrom, setPFrom] = useState(toLocalInput(order?.pickupWindow?.from));
  const [pTo, setPTo] = useState(toLocalInput(order?.pickupWindow?.to));
  const [dFrom, setDFrom] = useState(toLocalInput(order?.deliveryWindow?.from));
  const [dTo, setDTo] = useState(toLocalInput(order?.deliveryWindow?.to));
  const [reference, setReference] = useState(order?.reference ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [confirmNow, setConfirmNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePlaces = places.filter((p) => p.active || p.id === originPlaceId || p.id === destinationPlaceId);
  // Places of the chosen customer first.
  const sorted = [...activePlaces].sort((a, b) => Number(b.customerId === customerId) - Number(a.customerId === customerId) || a.name.localeCompare(b.name, 'es'));
  const num = (v: string) => (v.trim() === '' ? undefined : (parseAmount(v) ?? undefined));
  const win = (from: string, to: string) => (from && to ? { from: fromLocalInput(from)!, to: fromLocalInput(to)! } : undefined);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!customerId || !originPlaceId || !destinationPlaceId || !description.trim()) return setError('Cliente, origen, destino y descripción de la carga son obligatorios.');
    if (originPlaceId === destinationPlaceId) return setError('El origen y el destino deben ser distintos.');
    if ((pFrom && !pTo) || (!pFrom && pTo) || (dFrom && !dTo) || (!dFrom && dTo)) return setError('Completá el inicio y el fin de cada ventana horaria (o dejalas vacías).');
    const body = {
      customerId,
      originPlaceId,
      destinationPlaceId,
      cargo: { description, weightKg: num(weightKg), volumeM3: num(volumeM3), pallets: num(pallets), dangerous, refrigerated },
      pickupWindow: win(pFrom, pTo),
      deliveryWindow: win(dFrom, dTo),
      reference,
      notes,
      ...(order ? {} : { confirm: confirmNow }),
    };
    setSaving(true);
    try {
      if (order) {
        await apiRequest(`/api/tms/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        onSaved(`Pedido ${order.id} actualizado.`);
      } else {
        const res = await apiRequest<{ order: TransportOrder }>('/api/tms/orders', { method: 'POST', body: JSON.stringify(body) });
        onSaved(`Pedido ${res.order.id} creado${confirmNow ? ' y confirmado' : ' como borrador'}.`);
      }
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el pedido.'));
      setSaving(false);
    }
  };

  const placeOptions = sorted.map((p) => (
    <option key={p.id} value={p.id}>
      {p.name}
      {p.customerId && p.customerId === customerId ? ' ★' : ''}
    </option>
  ));

  return (
    <Dialog title={order ? `Editar ${order.id}` : 'Nuevo pedido de transporte'} subtitle="Qué se lleva, de dónde, a dónde y cuándo" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="ord-cust" label="Cliente">
            <select id="ord-cust" className={inputCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Elegí el cliente…</option>
              {customers.filter((c) => c.active || c.id === customerId).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field id="ord-ref" label="Referencia del cliente" hint="Orden de compra, remito, n.º de envío…">
            <input id="ord-ref" className={inputCls} value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field id="ord-orig" label="Origen (carga)" hint={customerId ? '★ = lugar del cliente elegido' : undefined}>
            <select id="ord-orig" className={inputCls} value={originPlaceId} onChange={(e) => setOrigin(e.target.value)}>
              <option value="">Elegí el lugar…</option>
              {placeOptions}
            </select>
          </Field>
          <Field id="ord-dest" label="Destino (descarga)">
            <select id="ord-dest" className={inputCls} value={destinationPlaceId} onChange={(e) => setDestination(e.target.value)}>
              <option value="">Elegí el lugar…</option>
              {placeOptions}
            </select>
          </Field>
        </div>
        <fieldset className="rounded-lg border border-slate-800 p-3 space-y-3">
          <legend className="px-1 text-[11px] font-medium text-slate-300">Carga</legend>
          <Field id="ord-desc" label="Descripción">
            <input id="ord-desc" className={inputCls} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Ej.: Bebidas en pallets" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field id="ord-kg" label="Peso (kg)">
              <input id="ord-kg" inputMode="decimal" className={`${inputCls} font-mono`} value={weightKg} onChange={(e) => setWeight(e.target.value)} />
            </Field>
            <Field id="ord-m3" label="Volumen (m³)">
              <input id="ord-m3" inputMode="decimal" className={`${inputCls} font-mono`} value={volumeM3} onChange={(e) => setVolume(e.target.value)} />
            </Field>
            <Field id="ord-pal" label="Pallets">
              <input id="ord-pal" inputMode="numeric" className={`${inputCls} font-mono`} value={pallets} onChange={(e) => setPallets(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 text-slate-300">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dangerous} onChange={(e) => setDangerous(e.target.checked)} /> Carga peligrosa (exige chofer con clase E.3)
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={refrigerated} onChange={(e) => setRefrigerated(e.target.checked)} /> Requiere frío
            </label>
          </div>
        </fieldset>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <fieldset className="rounded-lg border border-slate-800 p-3 space-y-2">
            <legend className="px-1 text-[11px] font-medium text-slate-300">Ventana de carga (opcional)</legend>
            <input type="datetime-local" aria-label="Carga desde" className={`${inputCls} font-mono`} value={pFrom} onChange={(e) => setPFrom(e.target.value)} />
            <input type="datetime-local" aria-label="Carga hasta" className={`${inputCls} font-mono`} value={pTo} onChange={(e) => setPTo(e.target.value)} />
          </fieldset>
          <fieldset className="rounded-lg border border-slate-800 p-3 space-y-2">
            <legend className="px-1 text-[11px] font-medium text-slate-300">Ventana de entrega (opcional)</legend>
            <input type="datetime-local" aria-label="Entrega desde" className={`${inputCls} font-mono`} value={dFrom} onChange={(e) => setDFrom(e.target.value)} />
            <input type="datetime-local" aria-label="Entrega hasta" className={`${inputCls} font-mono`} value={dTo} onChange={(e) => setDTo(e.target.value)} />
            <p className="text-[11px] text-slate-500">Si la unidad no llega antes del fin, se genera la alerta «Entrega demorada».</p>
          </fieldset>
        </div>
        <QuoteHint
          customerId={customerId}
          originPlaceId={originPlaceId}
          destinationPlaceId={destinationPlaceId}
          weightKg={num(weightKg)}
          pallets={num(pallets)}
          dangerous={dangerous}
          refrigerated={refrigerated}
        />
        <Field id="ord-notes" label="Notas">
          <textarea id="ord-notes" rows={2} className={inputCls} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
          {!order ? (
            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input type="checkbox" checked={confirmNow} onChange={(e) => setConfirmNow(e.target.checked)} /> Confirmar ya (listo para planificar)
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
            <button type="submit" className={btnPrimary} disabled={saving}>{saving ? 'Guardando…' : 'Guardar pedido'}</button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** Asks for a mandatory reason (cancel order / trip, skip stop). */
export function ReasonDialog({
  title,
  description,
  action,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  action: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} subtitle={description} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reason.trim()) return setError('Indicá el motivo.');
          setBusy(true);
          try {
            await onSubmit(reason.trim());
          } catch (err) {
            setError(errMsg(err, 'No se pudo completar la acción.'));
            setBusy(false);
          }
        }}
      >
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <Field id="reason" label="Motivo">
          <textarea id="reason" rows={2} autoFocus className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Volver</button>
          <button type="submit" className={`${btnPrimary} bg-rose-600 hover:bg-rose-500`} disabled={busy}>{busy ? 'Procesando…' : action}</button>
        </div>
      </form>
    </Dialog>
  );
}


/** Live quote of the order being typed, with the customer's active tariff. */
function QuoteHint(p: { customerId: string; originPlaceId: string; destinationPlaceId: string; weightKg?: number; pallets?: number; dangerous: boolean; refrigerated: boolean }) {
  const money = useMoney();
  const [q, setQ] = useState<{ tariff?: { name: string }; distanceKm: number; price: { amount: number; lines: ChargeLine[]; rule: TariffRuleKind } | null; currency: string | null } | null>(null);
  const ready = p.customerId && p.originPlaceId && p.destinationPlaceId && p.originPlaceId !== p.destinationPlaceId;
  useEffect(() => {
    if (!ready) {
      setQ(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      apiRequest<NonNullable<typeof q>>('/api/costs/quote', { method: 'POST', body: JSON.stringify(p) })
        .then((r) => !cancelled && setQ(r))
        .catch(() => !cancelled && setQ(null));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [p.customerId, p.originPlaceId, p.destinationPlaceId, p.weightKg, p.pallets, p.dangerous, p.refrigerated]);
  if (!ready || !q) return null;
  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" aria-live="polite">
      {q.price ? (
        <>
          <div className="text-emerald-300 font-medium">
            Precio estimado: <span className="font-mono">{money.fmtIn(q.price.amount, q.currency)}</span> · {TARIFF_RULE_LABELS[q.price.rule].toLowerCase()} · {q.distanceKm} km aprox.
          </div>
          <div className="text-slate-400">{q.price.lines.map((l) => `${l.label}: ${money.fmtIn(l.amount, q.currency)}`).join(' · ')}</div>
          <div className="text-slate-500">Se confirma al entregar (suma estadía y peajes reales).</div>
        </>
      ) : (
        <div className="text-amber-300">{q.tariff ? `El tarifario «${q.tariff.name}» no tiene una regla para este pedido.` : 'El cliente no tiene tarifario: el precio se carga a mano al entregar.'}</div>
      )}
    </div>
  );
}

/** Manual price of a delivered order (with reason) or recalculation with the tariff. */
function ChargeDialog({ order, onClose, onDone }: { order: OrderRow; onClose: () => void; onDone: (msg: string) => void }) {
  const money = useMoney();
  const [amount, setAmount] = useState(order.charge ? String(order.charge.amount) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: object, msg: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/costs/orders/${encodeURIComponent(order.id)}/charge`, { method: 'POST', body: JSON.stringify(body) });
      onDone(msg);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el precio.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Precio de ${order.id}`} subtitle={`${order.customerName} · ${order.originName} → ${order.destinationName}`} onClose={onClose}>
      <div className="space-y-3">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        {order.charge && (
          <ul className="rounded-lg border border-slate-800 divide-y divide-slate-800">
            {order.charge.lines.map((l, i) => (
              <li key={i} className="flex justify-between px-3 py-1.5">
                <span className="text-slate-300">{l.label}</span>
                <span className="font-mono text-slate-100">{money.fmtIn(l.amount, order.charge!.currency)}</span>
              </li>
            ))}
            {order.charge.adjustReason && <li className="px-3 py-1.5 text-slate-500">Ajuste de {order.charge.adjustedBy}: {order.charge.adjustReason}</li>}
          </ul>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="chg-amount" label="Importe">
            <input id="chg-amount" inputMode="decimal" className={`${inputCls} font-mono`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field id="chg-reason" label="Motivo del ajuste">
            <input id="chg-reason" className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: precio acordado por mail" />
          </Field>
        </div>
        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} disabled={busy} onClick={() => void send({ recalculate: true }, `Precio de ${order.id} recalculado con el tarifario.`)}>
            Recalcular con el tarifario
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !reason.trim() || parseAmount(amount) === null}
            onClick={() => void send({ amount: parseAmount(amount), reason }, `Precio de ${order.id} ajustado.`)}
          >
            Guardar precio
          </button>
        </div>
      </div>
    </Dialog>
  );
}
