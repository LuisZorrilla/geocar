import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Download, Loader2, MapPin, PackageCheck, Truck } from 'lucide-react';
import type { PublicTracking } from '../shared/tms.ts';
import { TmsMap } from '../components/tms/TmsMap.tsx';

const fmt = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';

/** Public tracking page of one order (/seguimiento/<token>): no login, read-only. */
export function TrackingPage({ token }: { token: string }) {
  const [data, setData] = useState<PublicTracking | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/track/${encodeURIComponent(token)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'No se pudo cargar el seguimiento.');
      setData(json.tracking);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sin conexión.');
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    document.title = data ? `Seguimiento ${data.orderId}` : 'Seguimiento de envío';
  }, [data?.orderId]);

  const circles = useMemo(
    () => (data ? [{ id: 'dest', lat: data.destination.lat, lng: data.destination.lng, radiusM: data.destination.radiusM || 150, label: data.destination.name, tone: data.delivered ? ('done' as const) : ('current' as const) }] : []),
    [data?.destination.lat, data?.destination.lng, data?.destination.name, Boolean(data?.delivered)]
  );
  const unit = useMemo(() => (data?.unit ? { lat: data.unit.lat, lng: data.unit.lng, label: 'Tu envío' } : null), [data?.unit?.lat, data?.unit?.lng]);

  const steps: Array<[string, boolean]> = data
    ? [
        ['Registrado', true],
        ['En camino', ['en_curso', 'entregado'].includes(data.status)],
        ['Entregado', data.status === 'entregado'],
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-200">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        <header className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/30">
            <Truck className="w-6 h-6 text-sky-400" aria-hidden />
          </div>
          <div>
            <div className="text-xs text-sky-400">{data?.carrier || 'Seguimiento de envío'}</div>
            <h1 className="text-lg font-semibold text-slate-100">{data ? `Envío ${data.orderId}` : 'Seguimiento de envío'}</h1>
          </div>
        </header>

        {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">{error}</div>}
        {!data && !error && (
          <div className="flex justify-center py-16 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}

        {data && (
          <>
            <ol className="grid grid-cols-3 gap-2" aria-label="Estado del envío">
              {steps.map(([label, done]) => (
                <li key={label} className={`rounded-xl border p-3 text-center text-sm ${done ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-slate-800 text-slate-500'}`}>
                  {done ? <CheckCircle2 className="w-5 h-5 mx-auto mb-1" aria-hidden /> : <Clock className="w-5 h-5 mx-auto mb-1" aria-hidden />}
                  {label}
                </li>
              ))}
            </ol>

            {data.delivered ? (
              <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-2">
                <div className="flex items-center gap-2 text-emerald-200 font-semibold">
                  <PackageCheck className="w-5 h-5" aria-hidden /> Entregado el {fmt(data.delivered.at)}
                </div>
                {data.delivered.receiverName && <p className="text-slate-200">Recibió: {data.delivered.receiverName}</p>}
                {data.delivered.hasProof && (
                  <a href={`/api/public/track/${encodeURIComponent(token)}/remito.pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white">
                    <Download className="w-4 h-4" /> Descargar comprobante de entrega
                  </a>
                )}
              </div>
            ) : data.unit ? (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="text-amber-200 font-semibold">
                  {data.unit.etaMinutes === 0 ? 'El vehículo está en el lugar de entrega' : `Llega en aprox. ${data.unit.etaMinutes < 60 ? `${data.unit.etaMinutes} min` : `${Math.floor(data.unit.etaMinutes / 60)} h ${data.unit.etaMinutes % 60} min`}`}
                </div>
                <p className="text-sm text-slate-300">
                  A {data.unit.distanceKm.toLocaleString('es-AR')} km · posición de las {new Date(data.unit.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}. Estimación aproximada.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-800 bg-[#11192C] p-4 text-slate-300">
                {data.status === 'en_curso' ? 'Tu envío está en camino. La ubicación aparece cuando el vehículo se dirige a tu destino.' : 'Tu envío está programado. Vas a ver el vehículo cuando esté en camino.'}
              </div>
            )}

            <div className="rounded-2xl border border-slate-800 bg-[#11192C] p-4 space-y-1">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-0.5 text-sky-400 shrink-0" aria-hidden />
                <div>
                  <div className="text-slate-100 font-medium">{data.destination.name}</div>
                  {data.destination.address && <div className="text-sm text-slate-400">{data.destination.address}</div>}
                </div>
              </div>
              {data.deliveryWindow && <p className="text-sm text-slate-400">Ventana de entrega: {fmt(data.deliveryWindow.from)} a {fmt(data.deliveryWindow.to)}</p>}
              <p className="text-sm text-slate-400">
                Carga: {data.cargo}
                {data.reference ? ` · Ref. ${data.reference}` : ''} · Desde {data.origin.name}
              </p>
            </div>

            {(data.unit || !data.delivered) && <TmsMap circles={circles} unit={unit} height={300} label="Mapa del envío" />}

            <div className="rounded-2xl border border-slate-800 bg-[#11192C] p-4">
              <h2 className="text-sm font-semibold text-slate-200 mb-2">Historial</h2>
              <ul className="space-y-1.5">
                {[...data.events].reverse().map((e) => (
                  <li key={e.at + e.label} className="flex justify-between gap-3 text-sm">
                    <span className="text-slate-200">{e.label}</span>
                    <span className="font-mono text-slate-500">{fmt(e.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-center text-xs text-slate-600">Se actualiza solo cada minuto.</p>
          </>
        )}
      </div>
    </div>
  );
}
