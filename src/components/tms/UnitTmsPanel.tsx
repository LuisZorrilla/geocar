import { useEffect, useState } from 'react';
import { Package, Pencil, Route } from 'lucide-react';
import type { Vehicle, VehicleBodyType } from '../../shared/types.ts';
import { STOP_KIND_LABELS } from '../../shared/tms.ts';
import { parseAmount } from '../../shared/costs.ts';
import { formatDistance } from '../../shared/geo.ts';
import { apiRequest } from '../../lib/api.ts';
import type { TripRow } from './TripsPanel.tsx';
import { TripStatusPill, btnGhost, btnPrimary, errMsg, inputCls } from './ui.tsx';

const BODY_LABELS: Record<VehicleBodyType, string> = {
  caja_seca: 'Caja seca',
  refrigerado: 'Refrigerado',
  playo: 'Playo',
  tanque: 'Tanque',
  volcador: 'Volcador',
  otro: 'Otro',
};

/**
 * In the unit sheet: the unit's active trip (if any) and its load capacity, which the trip
 * assignment checks use.
 */
export function UnitTmsPanel({ vehicle, canEdit, onVehicleUpdated }: { vehicle: Vehicle; canEdit: boolean; onVehicleUpdated: (v: Vehicle) => void }) {
  const [trip, setTrip] = useState<TripRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ kg: '', m3: '', pallets: '', tank: '', body: '' as VehicleBodyType | '', cold: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Users without access to Operaciones get a 403: the trip line is simply not shown.
    apiRequest<{ items: TripRow[] }>(`/api/tms/trips?vehicleId=${encodeURIComponent(vehicle.id)}&status=activos&pageSize=1`)
      .then((r) => !cancelled && setTrip(r.items[0] ?? null))
      .catch(() => !cancelled && setTrip(null));
    return () => {
      cancelled = true;
    };
  }, [vehicle.id]);

  const startEdit = () => {
    setForm({
      kg: vehicle.capacityKg?.toString() ?? '',
      m3: vehicle.capacityM3?.toString() ?? '',
      pallets: vehicle.capacityPallets?.toString() ?? '',
      tank: vehicle.tankLiters?.toString() ?? '',
      body: vehicle.bodyType ?? '',
      cold: Boolean(vehicle.refrigerated),
    });
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const num = (v: string) => (v.trim() === '' ? null : (parseAmount(v) ?? null));
    setSaving(true);
    try {
      const res = await apiRequest<{ vehicle: Vehicle }>(`/api/tms/vehicles/${vehicle.id}/capacity`, {
        method: 'PATCH',
        body: JSON.stringify({ capacityKg: num(form.kg), capacityM3: num(form.m3), capacityPallets: num(form.pallets), tankLiters: num(form.tank), bodyType: form.body || null, refrigerated: form.cold }),
      });
      onVehicleUpdated(res.vehicle);
      setEditing(false);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar la capacidad.'));
    } finally {
      setSaving(false);
    }
  };

  const next = trip?.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');
  const cap = [
    vehicle.capacityKg !== undefined ? `${vehicle.capacityKg.toLocaleString('es-AR')} kg` : null,
    vehicle.capacityM3 !== undefined ? `${vehicle.capacityM3} m³` : null,
    vehicle.capacityPallets !== undefined ? `${vehicle.capacityPallets} pallets` : null,
    vehicle.tankLiters !== undefined ? `tanque ${vehicle.tankLiters} L` : null,
    vehicle.bodyType ? BODY_LABELS[vehicle.bodyType] : null,
    vehicle.refrigerated ? 'refrigerada' : null,
  ].filter(Boolean);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="p-3 rounded-xl bg-[#0B1120] border border-slate-800/80">
        <div className="text-slate-400 inline-flex items-center gap-2">
          <Route className="w-4 h-4 text-sky-400" aria-hidden /> Viaje actual
        </div>
        {trip ? (
          <div className="mt-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-slate-100">{trip.id}</span>
              <TripStatusPill status={trip.status} late={trip.late} />
            </div>
            <div className="text-slate-300">
              {next ? `Próxima: ${STOP_KIND_LABELS[next.kind]} en ${next.placeName}` : 'Sin paradas pendientes'}
              {next && trip.nextStopDistanceM !== undefined && next.status === 'pendiente' ? ` · a ${formatDistance(trip.nextStopDistanceM)}` : ''}
              {next?.status === 'en_lugar' ? ' · en el lugar' : ''}
            </div>
            <div className="text-slate-500">
              {trip.stops.filter((s) => s.status === 'completada').length}/{trip.stops.length} paradas · {trip.driverName}
            </div>
          </div>
        ) : (
          <div className="mt-1 text-slate-500">Sin viaje asignado.</div>
        )}
      </div>
      <div className="p-3 rounded-xl bg-[#0B1120] border border-slate-800/80">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-400 inline-flex items-center gap-2">
            <Package className="w-4 h-4 text-sky-400" aria-hidden /> Capacidad de carga
          </span>
          {canEdit && !editing && vehicle.assetType === 'vehiculo' && (
            <button type="button" onClick={startEdit} aria-label="Editar capacidad de carga" className="p-1 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {!editing ? (
          <div className="mt-1 text-slate-300">{cap.length ? cap.join(' · ') : <span className="text-slate-500">Sin cargar: los viajes avisan que no se puede verificar el peso.</span>}</div>
        ) : (
          <div className="mt-2 space-y-2">
            {error && <p className="text-rose-300">{error}</p>}
            <div className="grid grid-cols-3 gap-2">
              <input aria-label="Capacidad en kg" placeholder="kg" inputMode="decimal" className={`${inputCls} font-mono`} value={form.kg} onChange={(e) => setForm((f) => ({ ...f, kg: e.target.value }))} />
              <input aria-label="Capacidad en m³" placeholder="m³" inputMode="decimal" className={`${inputCls} font-mono`} value={form.m3} onChange={(e) => setForm((f) => ({ ...f, m3: e.target.value }))} />
              <input aria-label="Capacidad en pallets" placeholder="pallets" inputMode="numeric" className={`${inputCls} font-mono`} value={form.pallets} onChange={(e) => setForm((f) => ({ ...f, pallets: e.target.value }))} />
            </div>
            <input aria-label="Tanque de combustible en litros" placeholder="Tanque de combustible (L)" inputMode="numeric" className={`${inputCls} font-mono`} value={form.tank} onChange={(e) => setForm((f) => ({ ...f, tank: e.target.value }))} />
            <div className="flex flex-wrap items-center gap-3">
              <select aria-label="Tipo de caja" className={`${inputCls} w-auto`} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value as VehicleBodyType | '' }))}>
                <option value="">Tipo de caja…</option>
                {(Object.keys(BODY_LABELS) as VehicleBodyType[]).map((b) => (
                  <option key={b} value={b}>{BODY_LABELS[b]}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.cold} onChange={(e) => setForm((f) => ({ ...f, cold: e.target.checked }))} /> Refrigerada
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhost} onClick={() => setEditing(false)}>Cancelar</button>
              <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
