import { useMemo, useState } from 'react';
import { MapPin, Pencil, Plus, Search } from 'lucide-react';
import { PLACE_KIND_LABELS, PLACE_RADIUS, type Customer, type Place, type PlaceKind } from '../../shared/tms.ts';
import { apiRequest } from '../../lib/api.ts';
import { foldText } from '../../shared/drivers.ts';
import { Pagination, usePagination } from '../Pagination.tsx';
import { TmsMap } from './TmsMap.tsx';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
type PlaceRow = Place & { customerName?: string };

export function PlacesPanel({
  places,
  customers,
  canWrite,
  creationBlocked,
  notify,
  onChanged,
}: {
  places: PlaceRow[];
  customers: Customer[];
  canWrite: boolean;
  creationBlocked?: string;
  notify: Notify;
  onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<PlaceRow | 'new' | null>(null);
  const filtered = useMemo(() => {
    const n = foldText(q);
    return places.filter((p) => !n || foldText(`${p.name} ${p.address} ${p.customerName ?? ''}`).includes(n));
  }, [places, q]);
  const pag = usePagination(filtered, `${q}|${places.length}`, 10);
  const circles = useMemo(() => filtered.filter((p) => p.active).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, radiusM: p.radiusM, label: p.name })), [filtered]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, dirección o cliente…" aria-label="Buscar lugares" className={`${inputCls} pl-8`} />
        </div>
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setEditing('new')}>
            <Plus className="w-3.5 h-3.5" /> Nuevo lugar
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-3">
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-4 font-medium">Lugar</th>
                <th className="py-2.5 px-4 font-medium">Tipo / Cliente</th>
                <th className="py-2.5 px-4 font-medium">Geocerca</th>
                <th className="py-2.5 px-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {pag.pagedItems.map((p) => (
                <tr key={p.id} className={`hover:bg-slate-800/30 ${p.active ? '' : 'opacity-60'}`}>
                  <td className="py-2.5 px-4">
                    <div className="font-medium text-slate-100">{p.name}</div>
                    <div className="text-slate-500">{p.address || '—'}{p.openingHours ? ` · ${p.openingHours}` : ''}</div>
                  </td>
                  <td className="py-2.5 px-4 text-slate-300">
                    <div>{PLACE_KIND_LABELS[p.kind]}{p.active ? '' : ' · inactivo'}</div>
                    <div className="text-slate-500">{p.customerName ?? 'Propio'}</div>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-300">
                    <div>{p.radiusM} m</div>
                    <div className="text-slate-500">{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</div>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    {canWrite && (
                      <button type="button" onClick={() => setEditing(p)} aria-label={`Editar ${p.name}`} className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="p-8 text-center text-slate-400">{q ? 'Ningún lugar coincide con la búsqueda.' : 'Todavía no hay lugares. Cargá depósitos y puntos de entrega para armar pedidos.'}</div>}
          <Pagination page={pag.page} totalItems={pag.totalItems} pageSize={10} onPageChange={pag.setPage} />
        </div>
        <div className="space-y-1">
          <TmsMap circles={circles} height={420} label="Mapa de lugares y geocercas" />
          <p className="text-[11px] text-slate-500">Cada círculo es la geocerca donde se detecta la llegada y la salida de las unidades.</p>
        </div>
      </div>
      {editing && (
        <PlaceForm
          place={editing === 'new' ? null : editing}
          customers={customers}
          onClose={() => setEditing(null)}
          onSaved={(name, isNew) => {
            setEditing(null);
            notify(isNew ? `Lugar «${name}» creado.` : `Lugar «${name}» actualizado.`);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function PlaceForm({ place, customers, onClose, onSaved }: { place: Place | null; customers: Customer[]; onClose: () => void; onSaved: (name: string, isNew: boolean) => void }) {
  const [name, setName] = useState(place?.name ?? '');
  const [kind, setKind] = useState<PlaceKind>(place?.kind ?? 'cliente');
  const [customerId, setCustomerId] = useState(place?.customerId ?? '');
  const [address, setAddress] = useState(place?.address ?? '');
  const [lat, setLat] = useState(place ? String(place.lat) : '');
  const [lng, setLng] = useState(place ? String(place.lng) : '');
  const [radiusM, setRadiusM] = useState(place?.radiusM ?? PLACE_RADIUS.default);
  const [openingHours, setOpeningHours] = useState(place?.openingHours ?? '');
  const [serviceMinutes, setServiceMinutes] = useState(place?.serviceMinutes?.toString() ?? '');
  const [notes, setNotes] = useState(place?.notes ?? '');
  const [active, setActive] = useState(place?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latN = Number(lat);
  const lngN = Number(lng);
  const located = lat !== '' && lng !== '' && Number.isFinite(latN) && Number.isFinite(lngN) && Math.abs(latN) <= 90 && Math.abs(lngN) <= 180;
  const circles = useMemo(() => (located ? [{ id: 'p', lat: latN, lng: lngN, radiusM, label: name || 'Lugar', tone: 'current' as const }] : []), [located, latN, lngN, radiusM, name]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('El nombre es obligatorio.');
    if (!located) return setError('Marcá la ubicación en el mapa o cargá latitud y longitud.');
    setSaving(true);
    setError(null);
    const body = { name, kind, customerId: customerId || null, address, lat: latN, lng: lngN, radiusM, serviceMinutes: serviceMinutes.trim() ? Number(serviceMinutes) : null, openingHours, notes, active };
    try {
      if (place) await apiRequest(`/api/tms/places/${place.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await apiRequest('/api/tms/places', { method: 'POST', body: JSON.stringify(body) });
      onSaved(name.trim(), !place);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el lugar.'));
      setSaving(false);
    }
  };

  return (
    <Dialog title={place ? `Editar ${place.name}` : 'Nuevo lugar'} subtitle="Depósito, planta o punto de entrega con su geocerca" onClose={onClose} wide>
      <form onSubmit={submit} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
          <Field id="plc-name" label="Nombre">
            <input id="plc-name" className={inputCls} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Depósito Rawson" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="plc-kind" label="Tipo">
              <select id="plc-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)}>
                {(Object.keys(PLACE_KIND_LABELS) as PlaceKind[]).map((k) => (
                  <option key={k} value={k}>{PLACE_KIND_LABELS[k]}</option>
                ))}
              </select>
            </Field>
            <Field id="plc-cust" label="Cliente (opcional)">
              <select id="plc-cust" className={inputCls} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Propio / sin cliente</option>
                {customers.filter((c) => c.active || c.id === customerId).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field id="plc-addr" label="Dirección">
            <input id="plc-addr" className={inputCls} value={address} maxLength={240} onChange={(e) => setAddress(e.target.value)} placeholder="Calle, número, localidad" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="plc-lat" label="Latitud">
              <input id="plc-lat" inputMode="decimal" className={`${inputCls} font-mono`} value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-31.5375" />
            </Field>
            <Field id="plc-lng" label="Longitud">
              <input id="plc-lng" inputMode="decimal" className={`${inputCls} font-mono`} value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-68.5364" />
            </Field>
          </div>
          <Field id="plc-radius" label={`Radio de la geocerca: ${radiusM} m`} hint="Al entrar se registra la llegada; al salir (tras 2 minutos adentro), la salida.">
            <input id="plc-radius" type="range" min={PLACE_RADIUS.min} max={1000} step={10} value={Math.min(radiusM, 1000)} onChange={(e) => setRadiusM(Number(e.target.value))} className="w-full accent-sky-500" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="plc-hours" label="Horario de atención">
              <input id="plc-hours" className={inputCls} value={openingHours} maxLength={120} onChange={(e) => setOpeningHours(e.target.value)} placeholder="Lun a vie 7 a 18 h" />
            </Field>
            <Field id="plc-svc" label="Tiempo de carga o descarga (min)" hint="Para las rutas y la hora estimada. Vacío = 20 min.">
              <input id="plc-svc" inputMode="numeric" className={`${inputCls} font-mono`} value={serviceMinutes} onChange={(e) => setServiceMinutes(e.target.value.replace(/\D/g, ''))} placeholder="20" />
            </Field>
            <Field id="plc-active" label="Estado">
              <label className="inline-flex items-center gap-2 py-2 text-slate-300 cursor-pointer">
                <input id="plc-active" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo
              </label>
            </Field>
          </div>
          <Field id="plc-notes" label="Notas (acceso, contacto en portería…)">
            <textarea id="plc-notes" rows={2} className={inputCls} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <MapPin className="w-3.5 h-3.5 text-sky-400" aria-hidden /> Hacé clic en el mapa para ubicar el lugar.
          </div>
          <TmsMap
            circles={circles}
            height={380}
            label="Elegí la ubicación del lugar"
            onPick={(la, ln) => {
              setLat(String(la));
              setLng(String(ln));
            }}
          />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
            <button type="submit" className={btnPrimary} disabled={saving}>{saving ? 'Guardando…' : 'Guardar lugar'}</button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
