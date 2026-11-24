import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, FileUp, Fuel, Loader2, Plus, Trash2, X } from 'lucide-react';
import type { Driver, Vehicle } from '../../shared/types.ts';
import type { Customer } from '../../shared/tms.ts';
import { EXPENSE_LABELS, FUEL_FLAG_LABELS, parseAmount, type DriverSettlement, type ExpenseType, type FuelImportRow, type FuelLoad, type PreInvoice, type TripExpense } from '../../shared/costs.ts';
import { invoiceNumber, type Invoice } from '../../shared/billing.ts';
import { apiRequest, ApiError, getAuthToken, getTenantScope } from '../../lib/api.ts';
import { useMoney } from '../../lib/money.tsx';
import { ExportMenu } from '../ExportMenu.tsx';
import { ReasonDialog } from './OrdersPanel.tsx';
import { InvoicesSection } from './InvoicesPanel.tsx';
import { AuthImage, Dialog, Field, btnGhost, btnPrimary, errMsg, fmtDateTime, fromLocalInput, inputCls, toLocalInput } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
const todayIso = () => new Date().toISOString().slice(0, 10);
const monthStartIso = () => `${todayIso().slice(0, 8)}01`;
const card = 'bg-[#11192C] border border-slate-800/80 rounded-xl';

function Kpi({ label, value, tone = 'text-slate-100' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={`${card} p-3.5`}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-lg font-semibold font-mono tabular-nums mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

// ================================================================ fuel

type FuelRow = FuelLoad & { unitCode: string; plate: string; litersPer100?: number };

export function FuelPanel({ vehicles, canWrite, creationBlocked, notify }: { vehicles: Vehicle[]; canWrite: boolean; creationBlocked?: string; notify: Notify }) {
  const money = useMoney();
  const [vehicleId, setVehicleId] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState<{ items: FuelRow[]; totals: { liters: number; amount: number; flagged: number } } | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const params = useMemo(() => ({ vehicleId: vehicleId || undefined, flagged: flagged ? 'true' : undefined, from, to }), [vehicleId, flagged, from, to]);
  const load = useCallback(async () => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as Array<[string, string]>);
    try {
      setData(await apiRequest(`/api/costs/fuel?${q}`));
    } catch (err) {
      notify(errMsg(err, 'No se pudieron cargar las cargas.'), 'err');
    }
  }, [params, notify]);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (f: FuelRow) => {
    if (!window.confirm(`¿Eliminar la carga de ${f.liters} L de ${f.unitCode} del ${fmtDateTime(f.at)}?`)) return;
    try {
      await apiRequest(`/api/costs/fuel/${f.id}`, { method: 'DELETE' });
      notify('Carga eliminada.', 'warn');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo eliminar.'), 'err');
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Litros" value={data ? data.totals.liters.toLocaleString('es-AR') : '—'} />
        <Kpi label="Importe" value={data ? money.fmt(data.totals.amount) : '—'} tone="text-emerald-300" />
        <Kpi label="Cargas con alertas" value={data?.totals.flagged ?? '—'} tone={data?.totals.flagged ? 'text-rose-300' : 'text-slate-100'} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field id="fuel-veh" label="Unidad">
          <select id="fuel-veh" className={`${inputCls} w-48`} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">Todas</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.unitCode} · {v.plate}</option>)}
          </select>
        </Field>
        <Field id="fuel-from" label="Desde">
          <input id="fuel-from" type="date" className={`${inputCls} font-mono`} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field id="fuel-to" label="Hasta">
          <input id="fuel-to" type="date" className={`${inputCls} font-mono`} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <label className="inline-flex items-center gap-2 pb-2 text-xs text-slate-300 cursor-pointer">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Solo con alertas
        </label>
        <div className="flex-1" />
        <ExportMenu url="/api/costs/fuel/export" params={params} count={data?.items.length} filtered fileName="combustible" />
        {canWrite && (
          <>
            <button type="button" className={btnGhost} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setImporting(true)}>
              <FileUp className="w-3.5 h-3.5" /> Importar resumen
            </button>
            <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setAdding(true)}>
              <Plus className="w-3.5 h-3.5" /> Cargar ticket
            </button>
          </>
        )}
      </div>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
              <th className="py-2.5 px-3 font-medium">Fecha</th>
              <th className="py-2.5 px-3 font-medium">Unidad</th>
              <th className="py-2.5 px-3 font-medium text-right">Litros</th>
              <th className="py-2.5 px-3 font-medium text-right">Importe</th>
              <th className="py-2.5 px-3 font-medium text-right">L/100 km</th>
              <th className="py-2.5 px-3 font-medium">Estación / viaje</th>
              <th className="py-2.5 px-3 font-medium">Alertas</th>
              <th className="py-2.5 px-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {data?.items.map((f) => (
              <tr key={f.id} className="hover:bg-slate-800/30 align-top">
                <td className="py-2 px-3 font-mono text-slate-300 whitespace-nowrap">{fmtDateTime(f.at)}</td>
                <td className="py-2 px-3 text-slate-200">{f.unitCode} <span className="text-slate-500">{f.plate}</span></td>
                <td className="py-2 px-3 text-right font-mono text-slate-200">{f.liters.toLocaleString('es-AR')}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
                  {money.fmt(f.total, f.tenantId)}
                  <div className="text-slate-500">{money.fmt(f.pricePerLiter, f.tenantId)}/L</div>
                </td>
                <td className="py-2 px-3 text-right font-mono text-slate-300">{f.litersPer100 ?? '—'}</td>
                <td className="py-2 px-3 text-slate-400">
                  {f.station || '—'}
                  {f.tripId && <div className="font-mono text-slate-500">{f.tripId}</div>}
                  <div className="text-slate-500">{f.source === 'importacion' ? 'Importación' : f.source === 'app' ? 'App del chofer' : 'Manual'}{f.odometerKm ? ` · ${f.odometerKm.toLocaleString('es-AR')} km` : ''}</div>
                </td>
                <td className="py-2 px-3">
                  {f.flags.length ? (
                    <ul className="space-y-0.5">
                      {f.flags.map((x) => (
                        <li key={x.code} className="text-rose-300" title={x.message}>
                          <AlertTriangle className="inline w-3 h-3 mr-1" aria-hidden />
                          {FUEL_FLAG_LABELS[x.code]}
                          <span className="block text-slate-500">{x.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-emerald-300">OK</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right">
                  <div className="flex justify-end gap-1">
                    {f.receiptFileId && <AuthImage src={`/api/tms/files/${f.receiptFileId}`} alt="Ticket" className="h-9 w-9 rounded object-cover" />}
                    {canWrite && (
                      <button type="button" aria-label="Eliminar carga" onClick={() => void remove(f)} className="p-1.5 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && <div className="p-8 text-center text-slate-400">Sin cargas en el período. Cargá tickets o importá el resumen de la tarjeta de flota.</div>}
      </div>
      {adding && <FuelForm vehicles={vehicles} onClose={() => setAdding(false)} onSaved={(l) => { setAdding(false); notify(l.flags.length ? `Carga registrada con alertas: ${l.flags.map((x) => x.message).join(' ')}` : 'Carga registrada.', l.flags.length ? 'warn' : 'ok'); void load(); }} />}
      {importing && <FuelImportDialog onClose={() => setImporting(false)} onDone={(msg, tone) => { setImporting(false); notify(msg, tone); void load(); }} />}
    </div>
  );
}

function FuelForm({ vehicles, onClose, onSaved }: { vehicles: Vehicle[]; onClose: () => void; onSaved: (l: FuelLoad) => void }) {
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '');
  const [at, setAt] = useState(toLocalInput(new Date().toISOString()));
  const [liters, setLiters] = useState('');
  const [total, setTotal] = useState('');
  const [odometer, setOdometer] = useState('');
  const [station, setStation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const l = parseAmount(liters);
    const t = parseAmount(total);
    if (!vehicleId || !l || !t) return setError('Unidad, litros e importe son obligatorios.');
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{ load: FuelLoad }>('/api/costs/fuel', {
        method: 'POST',
        body: JSON.stringify({ vehicleId, at: fromLocalInput(at), liters: l, total: t, odometerKm: parseAmount(odometer) ?? undefined, station: station || undefined }),
      });
      onSaved(res.load);
    } catch (err) {
      setError(errMsg(err, 'No se pudo registrar.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Cargar ticket de combustible" subtitle="Se asigna solo al viaje en curso de la unidad" onClose={onClose}>
      <div className="space-y-3">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="fl-veh" label="Unidad">
            <select id="fl-veh" className={inputCls} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.unitCode} · {v.plate}</option>)}
            </select>
          </Field>
          <Field id="fl-at" label="Fecha y hora">
            <input id="fl-at" type="datetime-local" className={`${inputCls} font-mono`} value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
          <Field id="fl-l" label="Litros">
            <input id="fl-l" inputMode="decimal" className={`${inputCls} font-mono`} value={liters} onChange={(e) => setLiters(e.target.value)} />
          </Field>
          <Field id="fl-t" label="Importe total">
            <input id="fl-t" inputMode="decimal" className={`${inputCls} font-mono`} value={total} onChange={(e) => setTotal(e.target.value)} />
          </Field>
          <Field id="fl-o" label="Odómetro (km, opcional)" hint="Con el odómetro se calcula el rendimiento.">
            <input id="fl-o" inputMode="numeric" className={`${inputCls} font-mono`} value={odometer} onChange={(e) => setOdometer(e.target.value)} />
          </Field>
          <Field id="fl-s" label="Estación (opcional)">
            <input id="fl-s" className={inputCls} value={station} maxLength={160} onChange={(e) => setStation(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}><Fuel className="w-3.5 h-3.5" /> Registrar carga</button>
        </div>
      </div>
    </Dialog>
  );
}

async function postFile<T>(url: string, file: File): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) });
  const token = getAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const scope = getTenantScope();
  if (scope) headers.set('x-tenant-scope', scope);
  const res = await fetch(url, { method: 'POST', headers, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `Error HTTP ${res.status}`, res.status, data);
  return data as T;
}

function FuelImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string, tone: 'ok' | 'warn') => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ rows: FuelImportRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setError(null);
    if (!f) return;
    setBusy(true);
    try {
      setPreview(await postFile('/api/costs/fuel/import?dryRun=true', f));
    } catch (err) {
      setError(errMsg(err, 'No se pudo leer el archivo.'));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await postFile<{ imported: number; flagged: number; skipped: Array<{ line: number; reason: string }> }>('/api/costs/fuel/import', file);
      onDone(`Importadas ${r.imported} carga(s)${r.flagged ? `, ${r.flagged} con alertas` : ''}${r.skipped.length ? `; ${r.skipped.length} fila(s) omitida(s)` : ''}.`, r.flagged || r.skipped.length ? 'warn' : 'ok');
    } catch (err) {
      setError(errMsg(err, 'No se pudo importar.'));
      setBusy(false);
    }
  };
  const ok = preview?.rows.filter((r) => !r.error).length ?? 0;
  return (
    <Dialog title="Importar resumen de combustible" subtitle="CSV o Excel de la tarjeta de flota (YPF Ruta, Shell, Axion…)" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-slate-400">Se reconocen las columnas por su título: fecha, patente/dominio, litros, importe o precio, y opcionalmente kilometraje y estación. Las cargas repetidas no se duplican.</p>
        <label className={`${btnGhost} w-fit`}>
          <FileUp className="w-3.5 h-3.5" /> {file ? file.name : 'Elegir archivo (.csv o .xlsx)'}
          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </label>
        {busy && <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Procesando…</div>}
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        {preview && (
          <>
            <p className="text-slate-300">
              {preview.total} fila(s): <span className="text-emerald-300">{ok} para importar</span>, <span className="text-amber-300">{preview.rows.length - ok} con problemas</span>
              {preview.total > preview.rows.length ? ` (vista previa de las primeras ${preview.rows.length})` : ''}.
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-800">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0F172A] text-slate-400">
                  <tr><th className="px-2 py-1.5 text-left">Fila</th><th className="px-2 py-1.5 text-left">Fecha</th><th className="px-2 py-1.5 text-left">Patente</th><th className="px-2 py-1.5 text-right">Litros</th><th className="px-2 py-1.5 text-right">Importe</th><th className="px-2 py-1.5 text-left">Estado</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {preview.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-2 py-1 font-mono text-slate-500">{r.line}</td>
                      <td className="px-2 py-1 font-mono text-slate-300">{r.at ? fmtDateTime(r.at) : '—'}</td>
                      <td className="px-2 py-1 font-mono text-slate-300">{r.plate}</td>
                      <td className="px-2 py-1 text-right font-mono text-slate-300">{r.liters ?? '—'}</td>
                      <td className="px-2 py-1 text-right font-mono text-slate-300">{r.total?.toLocaleString('es-AR') ?? '—'}</td>
                      <td className="px-2 py-1">{r.error ? <span className="text-amber-300">{r.error}</span> : <span className="text-emerald-300">OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={!preview || ok === 0 || busy} onClick={() => void confirm()}>Importar {ok} carga(s)</button>
        </div>
      </div>
    </Dialog>
  );
}

// ================================================================ expenses

type ExpenseRow = TripExpense & { driverName: string };

export function ExpensesPanel({ canWrite, canApprove, creationBlocked, notify }: { canWrite: boolean; canApprove: boolean; creationBlocked?: string; notify: Notify }) {
  const money = useMoney();
  const [status, setStatus] = useState<TripExpense['status'] | ''>('pendiente');
  const [items, setItems] = useState<ExpenseRow[] | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseRow | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems((await apiRequest<{ items: ExpenseRow[] }>(`/api/costs/expenses${status ? `?status=${status}` : ''}`)).items);
    } catch (err) {
      notify(errMsg(err, 'No se pudieron cargar los gastos.'), 'err');
    }
  }, [status, notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const approve = async (e: ExpenseRow) => {
    try {
      await apiRequest(`/api/costs/expenses/${e.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'aprobado' }) });
      notify(`Gasto de ${e.driverName} aprobado.`);
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo aprobar.'), 'err');
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1" role="tablist" aria-label="Estado de los gastos">
          {([['pendiente', 'Por aprobar'], ['aprobado', 'Aprobados'], ['rechazado', 'Rechazados'], ['', 'Todos']] as const).map(([k, label]) => (
            <button key={label} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)} className={`px-2.5 py-1 rounded-md text-xs cursor-pointer ${status === k ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setAdding(true)}>
            <Plus className="w-3.5 h-3.5" /> Agregar gasto
          </button>
        )}
      </div>
      {!canApprove && <p className="text-xs text-slate-400">Los gastos los aprueba un administrador.</p>}
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
              <th className="py-2.5 px-3 font-medium">Fecha / viaje</th>
              <th className="py-2.5 px-3 font-medium">Chofer</th>
              <th className="py-2.5 px-3 font-medium">Gasto</th>
              <th className="py-2.5 px-3 font-medium text-right">Importe</th>
              <th className="py-2.5 px-3 font-medium">Ticket</th>
              <th className="py-2.5 px-3 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {items?.map((e) => (
              <tr key={e.id} className="align-top hover:bg-slate-800/30">
                <td className="py-2 px-3"><div className="font-mono text-slate-300">{fmtDateTime(e.at)}</div><div className="font-mono text-slate-500">{e.tripId}</div></td>
                <td className="py-2 px-3 text-slate-200">{e.driverName}<div className="text-slate-500">{e.paidBy === 'chofer' ? 'Pagó el chofer (se reintegra)' : 'Pagó la empresa'}</div></td>
                <td className="py-2 px-3 text-slate-200">{EXPENSE_LABELS[e.type]}{e.note && <div className="text-slate-500">{e.note}</div>}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-100">{money.fmt(e.amount, e.tenantId)}</td>
                <td className="py-2 px-3">{e.receiptFileId ? <AuthImage src={`/api/tms/files/${e.receiptFileId}`} alt="Ticket del gasto" className="h-12 w-12 rounded object-cover" /> : <span className="text-slate-600">—</span>}</td>
                <td className="py-2 px-3">
                  {e.status === 'pendiente' && canApprove ? (
                    <div className="flex gap-1">
                      <button type="button" onClick={() => void approve(e)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"><Check className="w-3.5 h-3.5" /> Aprobar</button>
                      <button type="button" onClick={() => setRejecting(e)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-rose-300 hover:bg-rose-500/10 cursor-pointer"><X className="w-3.5 h-3.5" /> Rechazar</button>
                    </div>
                  ) : (
                    <span className={e.status === 'aprobado' ? 'text-emerald-300' : e.status === 'rechazado' ? 'text-rose-300' : 'text-amber-300'}>
                      {e.status === 'aprobado' ? 'Aprobado' : e.status === 'rechazado' ? `Rechazado: ${e.rejectReason ?? ''}` : 'Por aprobar'}
                      {e.settlementId && <span className="block font-mono text-slate-500">{e.settlementId}</span>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && items.length === 0 && <div className="p-8 text-center text-slate-400">No hay gastos en esta vista. Los choferes los cargan desde su app con la foto del ticket.</div>}
      </div>
      {rejecting && (
        <ReasonDialog
          title={`Rechazar gasto de ${rejecting.driverName}`}
          description={`${EXPENSE_LABELS[rejecting.type]} · ${money.fmt(rejecting.amount, rejecting.tenantId)} · ${rejecting.tripId}`}
          action="Rechazar"
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            await apiRequest(`/api/costs/expenses/${rejecting.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'rechazado', reason }) });
            setRejecting(null);
            notify('Gasto rechazado.', 'warn');
            void load();
          }}
        />
      )}
      {adding && <ExpenseForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); notify('Gasto registrado.'); void load(); }} />}
    </div>
  );
}

function ExpenseForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [trips, setTrips] = useState<Array<{ id: string; unitCode: string; driverName: string }>>([]);
  const [tripId, setTripId] = useState('');
  const [type, setType] = useState<ExpenseType>('peaje');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState<'chofer' | 'empresa'>('empresa');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<{ items: Array<{ id: string; unitCode: string; driverName: string }> }>('/api/tms/trips?pageSize=100')
      .then((r) => {
        setTrips(r.items);
        setTripId(r.items[0]?.id ?? '');
      })
      .catch(() => undefined);
  }, []);
  const submit = async () => {
    const a = parseAmount(amount);
    if (!tripId || !a) return setError('Elegí el viaje e indicá el importe.');
    setBusy(true);
    try {
      await apiRequest('/api/costs/expenses', { method: 'POST', body: JSON.stringify({ tripId, type, amount: a, paidBy, note: note || undefined }) });
      onSaved();
    } catch (err) {
      setError(errMsg(err, 'No se pudo registrar.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Agregar gasto de viaje" onClose={onClose}>
      <div className="space-y-3">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="ex-trip" label="Viaje">
            <select id="ex-trip" className={inputCls} value={tripId} onChange={(e) => setTripId(e.target.value)}>
              {trips.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.unitCode} · {t.driverName}</option>)}
            </select>
          </Field>
          <Field id="ex-type" label="Tipo">
            <select id="ex-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value as ExpenseType)}>
              {(Object.keys(EXPENSE_LABELS) as ExpenseType[]).map((k) => <option key={k} value={k}>{EXPENSE_LABELS[k]}</option>)}
            </select>
          </Field>
          <Field id="ex-amt" label="Importe">
            <input id="ex-amt" inputMode="decimal" className={`${inputCls} font-mono`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field id="ex-paid" label="Lo pagó">
            <select id="ex-paid" className={inputCls} value={paidBy} onChange={(e) => setPaidBy(e.target.value as 'chofer' | 'empresa')}>
              <option value="empresa">La empresa</option>
              <option value="chofer">El chofer (se le reintegra)</option>
            </select>
          </Field>
        </div>
        <Field id="ex-note" label="Detalle (opcional)">
          <input id="ex-note" className={inputCls} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void submit()}>Registrar gasto</button>
        </div>
      </div>
    </Dialog>
  );
}

// ================================================================ billing

type PreInvoiceRow = PreInvoice & { customerName: string };
type SettlementRow = DriverSettlement & { driverName: string };

export function BillingPanel({ customers, drivers, canWrite, canApprove, creationBlocked, notify }: { customers: Customer[]; drivers: Driver[]; canWrite: boolean; canApprove: boolean; creationBlocked?: string; notify: Notify }) {
  const money = useMoney();
  const [pfs, setPfs] = useState<PreInvoiceRow[] | null>(null);
  const [lqs, setLqs] = useState<SettlementRow[] | null>(null);
  const [newPf, setNewPf] = useState(false);
  const [newLq, setNewLq] = useState(false);
  const [voiding, setVoiding] = useState<PreInvoiceRow | null>(null);
  const [invoicing, setInvoicing] = useState<string | null>(null);
  const [invoicesKey, setInvoicesKey] = useState(0);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([apiRequest<{ items: PreInvoiceRow[] }>('/api/costs/pre-invoices'), apiRequest<{ items: SettlementRow[] }>('/api/costs/settlements')]);
      setPfs(a.items);
      setLqs(b.items);
    } catch (err) {
      notify(errMsg(err, 'No se pudo cargar la facturación.'), 'err');
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (url: string, msg: string) => {
    try {
      await apiRequest(url, { method: 'POST' });
      notify(msg);
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo completar.'), 'err');
    }
  };
  const invoice = async (p: PreInvoiceRow) => {
    setInvoicing(p.id);
    try {
      const r = await apiRequest<{ invoice: Invoice }>(`/api/billing/pre-invoices/${encodeURIComponent(p.id)}/invoice`, { method: 'POST' });
      const n = `${r.invoice.letter} ${invoiceNumber(r.invoice.pointOfSale, r.invoice.number)}`;
      notify(r.invoice.status === 'simulada' ? `Factura ${n} generada en modo simulado (sin validez fiscal).` : `Factura ${n} autorizada por ARCA. CAE ${r.invoice.cae}.`, r.invoice.status === 'simulada' ? 'warn' : 'ok');
      void load();
      setInvoicesKey((k) => k + 1);
    } catch (err) {
      notify(errMsg(err, 'No se pudo facturar.'), 'err');
    } finally {
      setInvoicing(null);
    }
  };
  const pill = (s: string) => (s === 'emitida' || s === 'pagada' ? 'text-emerald-300' : s === 'anulada' ? 'text-slate-500 line-through' : 'text-amber-300');

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Pre-facturas a clientes</h2>
            <p className="text-xs text-slate-400">Pedidos entregados y con precio de un período. Documento interno; una vez emitida se factura electrónicamente con «Facturar».</p>
          </div>
          {canWrite && <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setNewPf(true)}><Plus className="w-3.5 h-3.5" /> Nueva pre-factura</button>}
        </div>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-left text-xs">
            <thead><tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]"><th className="py-2.5 px-3 font-medium">Pre-factura</th><th className="py-2.5 px-3 font-medium">Cliente</th><th className="py-2.5 px-3 font-medium">Período</th><th className="py-2.5 px-3 font-medium text-right">Total</th><th className="py-2.5 px-3 font-medium">Estado</th><th className="py-2.5 px-3" /></tr></thead>
            <tbody className="divide-y divide-slate-800/60">
              {pfs?.map((p) => (
                <tr key={p.id} className="hover:bg-slate-800/30">
                  <td className="py-2 px-3 font-mono text-slate-100">{p.id}<div className="text-slate-500">{p.lines.length} pedido(s)</div></td>
                  <td className="py-2 px-3 text-slate-200">{p.customerName}</td>
                  <td className="py-2 px-3 font-mono text-slate-300">{p.periodFrom} a {p.periodTo}</td>
                  <td className="py-2 px-3 text-right font-mono text-slate-100">{money.fmtIn(p.total, p.currency)}</td>
                  <td className={`py-2 px-3 font-medium ${pill(p.status)}`}>{p.status === 'borrador' ? 'Borrador' : p.status === 'emitida' ? (p.invoiceId ? 'Facturada' : 'Emitida') : 'Anulada'}</td>
                  <td className="py-2 px-3">
                    <div className="flex justify-end items-center gap-1">
                      <ExportMenu url={`/api/costs/pre-invoices/${p.id}/export`} fileName={p.id} label="Descargar" />
                      {canApprove && p.status === 'borrador' && <button type="button" className={btnGhost} onClick={() => void act(`/api/costs/pre-invoices/${p.id}/issue`, `${p.id} emitida.`)}>Emitir</button>}
                      {canApprove && p.status === 'emitida' && !p.invoiceId && (
                        <button type="button" className={btnGhost} disabled={invoicing !== null} onClick={() => void invoice(p)}>
                          {invoicing === p.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Facturar
                        </button>
                      )}
                      {canApprove && p.status !== 'anulada' && !p.invoiceId && <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => setVoiding(p)}>Anular</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pfs && pfs.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay pre-facturas.</div>}
        </div>
      </section>

      <InvoicesSection canApprove={canApprove} notify={notify} reloadKey={invoicesKey} onChanged={() => void load()} />

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Liquidaciones de viáticos</h2>
            <p className="text-xs text-slate-400">Reintegro a cada chofer de los gastos aprobados que pagó él.</p>
          </div>
          {canWrite && <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setNewLq(true)}><Plus className="w-3.5 h-3.5" /> Nueva liquidación</button>}
        </div>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-left text-xs">
            <thead><tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]"><th className="py-2.5 px-3 font-medium">Liquidación</th><th className="py-2.5 px-3 font-medium">Chofer</th><th className="py-2.5 px-3 font-medium">Período</th><th className="py-2.5 px-3 font-medium text-right">Total</th><th className="py-2.5 px-3 font-medium">Estado</th><th className="py-2.5 px-3" /></tr></thead>
            <tbody className="divide-y divide-slate-800/60">
              {lqs?.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/30">
                  <td className="py-2 px-3 font-mono text-slate-100">{s.id}<div className="text-slate-500">{s.expenseIds.length} gasto(s)</div></td>
                  <td className="py-2 px-3 text-slate-200">{s.driverName}</td>
                  <td className="py-2 px-3 font-mono text-slate-300">{s.periodFrom} a {s.periodTo}</td>
                  <td className="py-2 px-3 text-right font-mono text-slate-100">{money.fmtIn(s.total, s.currency)}</td>
                  <td className={`py-2 px-3 font-medium ${pill(s.status)}`}>{s.status === 'borrador' ? 'A pagar' : s.status === 'pagada' ? `Pagada ${s.paidAt ? fmtDateTime(s.paidAt) : ''}` : 'Anulada'}</td>
                  <td className="py-2 px-3">
                    <div className="flex justify-end items-center gap-1">
                      <ExportMenu url={`/api/costs/settlements/${s.id}/export`} fileName={s.id} label="Descargar" />
                      {canApprove && s.status === 'borrador' && <button type="button" className={btnGhost} onClick={() => void act(`/api/costs/settlements/${s.id}/pay`, `${s.id} marcada como pagada.`)}>Marcar pagada</button>}
                      {canApprove && s.status === 'borrador' && <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => void act(`/api/costs/settlements/${s.id}/void`, `${s.id} anulada.`)}>Anular</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lqs && lqs.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay liquidaciones.</div>}
        </div>
      </section>

      {newPf && <NewPreInvoiceDialog customers={customers} onClose={() => setNewPf(false)} onDone={(msg) => { setNewPf(false); notify(msg); void load(); }} />}
      {newLq && <NewSettlementDialog drivers={drivers} onClose={() => setNewLq(false)} onDone={(msg) => { setNewLq(false); notify(msg); void load(); }} />}
      {voiding && (
        <ReasonDialog
          title={`Anular ${voiding.id}`}
          description="Sus pedidos quedan libres para volver a pre-facturarlos."
          action="Anular pre-factura"
          onClose={() => setVoiding(null)}
          onSubmit={async (reason) => {
            await apiRequest(`/api/costs/pre-invoices/${voiding.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
            setVoiding(null);
            notify('Pre-factura anulada.', 'warn');
            void load();
          }}
        />
      )}
    </div>
  );
}

function NewPreInvoiceDialog({ customers, onClose, onDone }: { customers: Customer[]; onClose: () => void; onDone: (msg: string) => void }) {
  const money = useMoney();
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [preview, setPreview] = useState<{ priced: Array<{ id: string; deliveredAt?: string; reference?: string; cargo: string; charge: { amount: number; currency: string | null } }>; unpriced: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!customerId) return;
    apiRequest<NonNullable<typeof preview>>(`/api/costs/billable?customerId=${encodeURIComponent(customerId)}&from=${from}&to=${to}`)
      .then(setPreview)
      .catch((err) => setError(errMsg(err, 'No se pudo consultar.')));
  }, [customerId, from, to]);
  const total = preview?.priced.reduce((a, o) => a + o.charge.amount, 0) ?? 0;
  const currency = preview?.priced[0]?.charge.currency ?? null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ preInvoice: PreInvoice }>('/api/costs/pre-invoices', { method: 'POST', body: JSON.stringify({ customerId, from, to }) });
      onDone(`Pre-factura ${r.preInvoice.id} creada en borrador.`);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Nueva pre-factura" subtitle="Toma los pedidos entregados y con precio del período que todavía no se facturaron" onClose={onClose}>
      <div className="space-y-3">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field id="pf-c" label="Cliente">
            <select id="pf-c" className={inputCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field id="pf-f" label="Desde"><input id="pf-f" type="date" className={`${inputCls} font-mono`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field id="pf-t" label="Hasta"><input id="pf-t" type="date" className={`${inputCls} font-mono`} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {preview && (
          <>
            <ul className="max-h-60 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800">
              {preview.priced.map((o) => (
                <li key={o.id} className="flex justify-between gap-2 px-3 py-1.5">
                  <span><span className="font-mono text-slate-100">{o.id}</span> <span className="text-slate-400">{o.cargo}{o.reference ? ` · ${o.reference}` : ''}</span></span>
                  <span className="font-mono text-slate-200">{money.fmtIn(o.charge.amount, o.charge.currency)}</span>
                </li>
              ))}
              {preview.priced.length === 0 && <li className="px-3 py-3 text-slate-400">No hay pedidos para facturar en el período.</li>}
            </ul>
            {preview.unpriced.length > 0 && <p className="text-amber-300">{preview.unpriced.length} pedido(s) entregado(s) sin precio quedan afuera: {preview.unpriced.join(', ')}. Ponéles precio en Pedidos.</p>}
            <p className="text-right text-slate-200">Total: <span className="font-mono font-semibold">{money.fmtIn(total, currency)}</span></p>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || !preview?.priced.length} onClick={() => void create()}>Crear pre-factura</button>
        </div>
      </div>
    </Dialog>
  );
}

function NewSettlementDialog({ drivers, onClose, onDone }: { drivers: Driver[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [driverId, setDriverId] = useState(drivers[0]?.id ?? '');
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ settlement: DriverSettlement }>('/api/costs/settlements', { method: 'POST', body: JSON.stringify({ driverId, from, to }) });
      onDone(`Liquidación ${r.settlement.id} creada.`);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear.'));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Nueva liquidación de viáticos" subtitle="Suma los gastos aprobados que pagó el chofer en el período" onClose={onClose}>
      <div className="space-y-3">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field id="lq-d" label="Chofer">
            <select id="lq-d" className={inputCls} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              {[...drivers].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field id="lq-f" label="Desde"><input id="lq-f" type="date" className={`${inputCls} font-mono`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field id="lq-t" label="Hasta"><input id="lq-t" type="date" className={`${inputCls} font-mono`} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || !driverId} onClick={() => void create()}>Crear liquidación</button>
        </div>
      </div>
    </Dialog>
  );
}

// ================================================================ profitability

interface ProfitRow {
  key: string;
  label: string;
  trips: number;
  km: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number | null;
}

export function ProfitabilityPanel({ drivers, canApprove, notify }: { drivers: Driver[]; canApprove: boolean; notify: Notify }) {
  const money = useMoney();
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [groupBy, setGroupBy] = useState<'viaje' | 'cliente' | 'unidad' | 'chofer'>('cliente');
  const [data, setData] = useState<{ rows: ProfitRow[]; totals: ProfitRow; currency: string | null } | null>(null);
  const [showCosts, setShowCosts] = useState(false);
  useEffect(() => {
    apiRequest<typeof data>(`/api/costs/profitability?from=${from}&to=${to}&groupBy=${groupBy}`)
      .then(setData)
      .catch((err) => notify(errMsg(err, 'No se pudo calcular la rentabilidad.'), 'err'));
  }, [from, to, groupBy, notify]);
  const f = (n: number) => money.fmtIn(n, data?.currency ?? null);
  const max = Math.max(1, ...(data?.rows.map((r) => Math.max(r.revenue, r.cost)) ?? [1]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field id="pr-f" label="Desde"><input id="pr-f" type="date" className={`${inputCls} font-mono`} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field id="pr-t" label="Hasta"><input id="pr-t" type="date" className={`${inputCls} font-mono`} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1 mb-0.5" role="tablist" aria-label="Agrupar por">
          {(['cliente', 'viaje', 'unidad', 'chofer'] as const).map((g) => (
            <button key={g} type="button" role="tab" aria-selected={groupBy === g} onClick={() => setGroupBy(g)} className={`px-2.5 py-1 rounded-md text-xs capitalize cursor-pointer ${groupBy === g ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {g}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <ExportMenu url="/api/costs/profitability/export" params={{ from, to, groupBy }} count={data?.rows.length} fileName={`rentabilidad-${groupBy}`} />
      </div>
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Ingresos" value={f(data.totals.revenue)} tone="text-sky-300" />
          <Kpi label="Costo" value={f(data.totals.cost)} />
          <Kpi label="Margen" value={f(data.totals.margin)} tone={data.totals.margin < 0 ? 'text-rose-300' : 'text-emerald-300'} />
          <Kpi label="Margen %" value={data.totals.marginPct === null ? '—' : `${data.totals.marginPct} %`} tone={data.totals.marginPct !== null && data.totals.marginPct < 0 ? 'text-rose-300' : 'text-emerald-300'} />
        </div>
      )}
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
              <th className="py-2.5 px-3 font-medium capitalize">{groupBy}</th>
              <th className="py-2.5 px-3 font-medium text-right">Viajes</th>
              <th className="py-2.5 px-3 font-medium text-right">Km</th>
              <th className="py-2.5 px-3 font-medium text-right">Ingresos</th>
              <th className="py-2.5 px-3 font-medium text-right">Costo</th>
              <th className="py-2.5 px-3 font-medium text-right">Margen</th>
              <th className="py-2.5 px-3 font-medium w-40" aria-label="Ingresos contra costo" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {data?.rows.map((r) => (
              <tr key={r.key} className="hover:bg-slate-800/30">
                <td className="py-2 px-3 text-slate-100">{r.label}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-300">{r.trips}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-300">{r.km.toLocaleString('es-AR')}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-200">{f(r.revenue)}</td>
                <td className="py-2 px-3 text-right font-mono text-slate-300">{f(r.cost)}</td>
                <td className={`py-2 px-3 text-right font-mono font-medium ${r.margin < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                  {f(r.margin)}
                  <div className="text-slate-500 font-normal">{r.marginPct === null ? 'sin ingresos' : `${r.marginPct} %`}</div>
                </td>
                <td className="py-2 px-3">
                  <div className="space-y-1" aria-hidden>
                    <div className="h-1.5 rounded-full bg-sky-500" style={{ width: `${(r.revenue / max) * 100}%` }} />
                    <div className="h-1.5 rounded-full bg-slate-500" style={{ width: `${(r.cost / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <div className="p-8 text-center text-slate-400">No hay viajes finalizados en el período.</div>}
      </div>
      <p className="text-xs text-slate-500">
        Barra azul: ingresos · gris: costo. Costo = combustible (cargas del viaje o estimado por rendimiento) + gastos aprobados + mantenimiento por km + horas del chofer (costo mensual ÷ 176 h).
      </p>
      {canApprove && (
        <div className={card}>
          <button type="button" className="w-full text-left px-4 py-3 text-sm font-medium text-slate-200 cursor-pointer" onClick={() => setShowCosts((v) => !v)} aria-expanded={showCosts}>
            {showCosts ? '▾' : '▸'} Costo mensual de cada chofer (sueldo + cargas)
          </button>
          {showCosts && <DriverCosts drivers={drivers} notify={notify} />}
        </div>
      )}
    </div>
  );
}

function DriverCosts({ drivers, notify }: { drivers: Driver[]; notify: Notify }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(drivers.map((d) => [d.id, d.monthlyCost?.toString() ?? ''])));
  const save = async (d: Driver) => {
    const raw = values[d.id] ?? '';
    try {
      await apiRequest(`/api/costs/drivers/${d.id}/monthly-cost`, { method: 'PUT', body: JSON.stringify({ monthlyCost: raw.trim() ? parseAmount(raw) : null }) });
      notify(`Costo mensual de ${d.name} guardado.`);
    } catch (err) {
      notify(errMsg(err, 'No se pudo guardar.'), 'err');
    }
  };
  return (
    <ul className="divide-y divide-slate-800 border-t border-slate-800 max-h-80 overflow-y-auto">
      {[...drivers].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((d) => (
        <li key={d.id} className="flex items-center gap-2 px-4 py-1.5 text-xs">
          <span className="flex-1 text-slate-200">{d.name}</span>
          <input aria-label={`Costo mensual de ${d.name}`} inputMode="decimal" className={`${inputCls} w-40 font-mono`} value={values[d.id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [d.id]: e.target.value }))} />
          <button type="button" className={btnGhost} onClick={() => void save(d)}>Guardar</button>
        </li>
      ))}
    </ul>
  );
}
