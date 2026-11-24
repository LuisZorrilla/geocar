import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Camera, Fuel, Receipt, CheckCircle2, Circle, CircleDot, Loader2, MapPin, Navigation, PackageCheck, Play, RefreshCw, Truck, X, XCircle } from 'lucide-react';
import { EXPENSE_LABELS, parseAmount, type ExpenseType } from '../shared/costs.ts';
import { DRIVER_REPORT_TYPES, STOP_KIND_LABELS, type DriverReportType, type TripStop, type Trip, type TransportOrder } from '../shared/tms.ts';

/**
 * Driver's trips app (/chofer). Opened from the personal link the company sends (QR or
 * WhatsApp): the token comes in the URL hash once and is kept on the phone.
 */

const TOKEN_KEY = 'geocar_driver_token';

type TripRow = Omit<Trip, 'stops'> & {
  unitCode: string;
  plate: string;
  driverName: string;
  stops: Array<TripStop & { placeName: string; address: string; lat: number; lng: number; radiusM: number }>;
  orders: Array<Pick<TransportOrder, 'id' | 'status' | 'reference' | 'cargo'> & { customerName: string }>;
  late: boolean;
};
type Stop = TripRow['stops'][number];

class DriverApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function readToken(): string | null {
  const m = window.location.hash.match(/(?:^#|&)t=([A-Za-z0-9_-]{20,})/);
  if (m) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    // Don't leave the token in the address bar (screenshots, shared links).
    history.replaceState(null, '', window.location.pathname);
    return m[1];
  }
  return localStorage.getItem(TOKEN_KEY);
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/driver-app${path}`, {
    method,
    headers: { 'x-driver-token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriverApiError(typeof data.error === 'string' ? data.error : `Error ${res.status}`, res.status);
  return data as T;
}

async function uploadImage(token: string, tripId: string, kind: 'signature' | 'photo' | 'receipt', blob: Blob): Promise<string> {
  const res = await fetch(`/api/driver-app/trips/${encodeURIComponent(tripId)}/files?kind=${kind}`, {
    method: 'PUT',
    headers: { 'x-driver-token': token, 'Content-Type': blob.type },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'No se pudo subir la imagen.');
  return data.fileId as string;
}

/** Photo → JPEG of at most 1280 px (a phone photo is several MB). */
async function compressPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo procesar la foto.'))), 'image/jpeg', 0.72));
}

const getPosition = () =>
  new Promise<GeolocationPosition | null>((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 });
  });

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '');
const big = 'w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-base font-semibold cursor-pointer disabled:opacity-50';
const field = 'w-full rounded-xl border border-slate-700 bg-[#0B1120] px-3.5 py-3 text-base text-slate-100 focus:outline-none focus:border-sky-500';

export function DriverApp() {
  const [token] = useState(readToken);
  const [me, setMe] = useState<{ driver: { name: string; company: string }; carrier?: boolean; trips: TripRow[] } | null>(null);
  const [sharing, setSharing] = useState<'off' | 'on' | 'denied'>('off');
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setMe(await call(token, 'GET', '/me'));
      setError(null);
    } catch (err) {
      if (err instanceof DriverApiError && err.status === 401) {
        setDenied(true);
        localStorage.removeItem(TOKEN_KEY);
      } else setError(err instanceof Error ? err.message : 'Sin conexión.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Carriers have no fleet tracker: while their trip is open the phone shares its position.
  const tripOpen = Boolean(me?.carrier && me.trips.some((t) => t.status === 'planificado' || t.status === 'en_curso'));
  useEffect(() => {
    if (!token || !tripOpen || !navigator.geolocation) return;
    let last = 0;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setSharing('on');
        if (Date.now() - last < 20_000) return;
        last = Date.now();
        void call(token, 'POST', '/position', { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }).catch(() => undefined);
      },
      () => setSharing('denied'),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [token, tripOpen]);

  if (!token || denied) {
    return (
      <Shell>
        <div className="mt-16 text-center space-y-3 px-6">
          <Truck className="w-10 h-10 mx-auto text-sky-400" aria-hidden />
          <h1 className="text-lg font-semibold text-slate-100">App de viajes</h1>
          <p className="text-slate-300">{denied ? 'Tu link ya no es válido (lo reemplazaron o lo revocaron).' : 'Para entrar, abrí el link o escaneá el QR que te mandó tu empresa.'}</p>
          <p className="text-slate-500 text-sm">Pedile a tu supervisor un link nuevo desde la sección Choferes.</p>
        </div>
      </Shell>
    );
  }

  const trip = me?.trips.find((t) => t.id === openId) ?? null;
  return (
    <Shell>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-800 bg-[#0F172A]/95 px-4 py-3 backdrop-blur">
        {trip ? (
          <button type="button" onClick={() => setOpenId(null)} className="flex items-center gap-1.5 text-sky-300 cursor-pointer" aria-label="Volver a mis viajes">
            <ArrowLeft className="w-5 h-5" /> Mis viajes
          </button>
        ) : (
          <div>
            <div className="text-xs text-sky-400">{me?.driver.company ?? ' '}</div>
            <div className="font-semibold text-slate-100">{me?.driver.name ?? 'Cargando…'}</div>
          </div>
        )}
        <button type="button" onClick={() => void load()} aria-label="Actualizar" className="p-2 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer">
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>
      {error && <div role="alert" className="m-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">{error}</div>}
      {tripOpen && (
        <div className={`mx-4 mt-3 rounded-xl border p-3 text-sm ${sharing === 'denied' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-100'}`}>
          {sharing === 'denied'
            ? 'Activá la ubicación del celular para este sitio: la empresa necesita seguir el viaje y detectar las llegadas.'
            : 'Mientras el viaje esté abierto compartís tu ubicación con la empresa (solo desde esta página).'}
        </div>
      )}
      {!me ? (
        <div className="mt-16 flex justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : trip ? (
        <TripScreen token={token} trip={trip} carrier={Boolean(me.carrier)} onChanged={load} />
      ) : (
        <TripList trips={me.trips} onOpen={setOpenId} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#0B1120] text-slate-200 max-w-xl mx-auto pb-10">{children}</div>;
}

function TripList({ trips, onOpen }: { trips: TripRow[]; onOpen: (id: string) => void }) {
  if (trips.length === 0) {
    return (
      <div className="mt-16 text-center px-6 space-y-2">
        <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400" aria-hidden />
        <p className="text-slate-200">No tenés viajes asignados por ahora.</p>
        <p className="text-sm text-slate-500">Cuando te asignen uno, aparece acá.</p>
      </div>
    );
  }
  return (
    <ul className="p-4 space-y-3">
      {trips.map((t) => {
        const done = t.stops.filter((s) => s.status === 'completada').length;
        const next = t.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');
        return (
          <li key={t.id}>
            <button type="button" onClick={() => onOpen(t.id)} className="w-full text-left rounded-2xl border border-slate-800 bg-[#11192C] p-4 active:bg-slate-800 cursor-pointer">
              <div className="flex items-center justify-between">
                <span className="font-mono font-semibold text-slate-100">{t.id}</span>
                <span className={`text-sm font-medium ${t.status === 'en_curso' ? 'text-amber-300' : t.status === 'finalizado' ? 'text-emerald-300' : 'text-sky-300'}`}>
                  {t.status === 'en_curso' ? 'En curso' : t.status === 'finalizado' ? 'Finalizado' : `Sale ${fmt(t.plannedStart)}`}
                </span>
              </div>
              <div className="mt-1 text-slate-400">
                {t.unitCode} · {t.plate} · {done}/{t.stops.length} paradas
              </div>
              {next && (
                <div className="mt-2 text-slate-200">
                  Próxima: <strong>{STOP_KIND_LABELS[next.kind]}</strong> en {next.placeName}
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StopIcon({ s }: { s: Stop }) {
  if (s.status === 'completada') return <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" aria-hidden />;
  if (s.status === 'omitida') return <XCircle className="w-6 h-6 text-rose-400 shrink-0" aria-hidden />;
  if (s.status === 'en_lugar') return <CircleDot className="w-6 h-6 text-amber-300 shrink-0" aria-hidden />;
  return <Circle className="w-6 h-6 text-slate-600 shrink-0" aria-hidden />;
}

function TripScreen({ token, trip, carrier, onChanged }: { token: string; trip: TripRow; carrier: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [modal, setModal] = useState<{ kind: 'deliver' | 'fail' | 'report' | 'fuel' | 'expense'; stop?: Stop } | null>(null);
  const current = trip.stops.find((s) => s.status === 'pendiente' || s.status === 'en_lugar');
  const closed = trip.status === 'finalizado' || trip.status === 'cancelado';

  const act = async (path: string, text: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await call(token, 'POST', path);
      setMsg({ text, ok: true });
      await onChanged();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'No se pudo.', ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-lg font-semibold text-slate-100">{trip.id}</h1>
          <span className={`text-sm font-medium ${trip.status === 'en_curso' ? 'text-amber-300' : trip.status === 'finalizado' ? 'text-emerald-300' : 'text-sky-300'}`}>
            {trip.status === 'en_curso' ? 'En curso' : trip.status === 'finalizado' ? 'Finalizado' : trip.status === 'cancelado' ? 'Cancelado' : 'Planificado'}
          </span>
        </div>
        <p className="text-slate-400">
          {trip.unitCode} · {trip.plate} · salida {fmt(trip.plannedStart)}
        </p>
        {trip.notes && <p className="mt-1 text-slate-300">Nota: {trip.notes}</p>}
      </div>

      {msg && <div role="status" className={`rounded-xl border p-3 ${msg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'}`}>{msg.text}</div>}

      {trip.status === 'planificado' && (
        <button type="button" disabled={busy} className={`${big} bg-sky-600 text-white`} onClick={() => void act(`/trips/${trip.id}/start`, 'Viaje iniciado. ¡Buen viaje!')}>
          <Play className="w-5 h-5" /> Iniciar viaje
        </button>
      )}

      <ol className="space-y-3">
        {trip.stops.map((s) => {
          const isCurrent = s.id === current?.id && !closed;
          return (
            <li key={s.id} className={`rounded-2xl border p-4 ${isCurrent ? 'border-amber-500/60 bg-amber-500/5' : 'border-slate-800 bg-[#11192C]'}`}>
              <div className="flex items-start gap-3">
                <StopIcon s={s} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-100">
                    {s.seq}. {STOP_KIND_LABELS[s.kind]} · {s.placeName}
                  </div>
                  <div className="text-slate-400">{s.address}</div>
                  {s.window && <div className="text-sm text-slate-400">Ventana: {fmt(s.window.from)} a {fmt(s.window.to)}</div>}
                  <div className="text-sm text-slate-500">
                    {trip.orders.filter((o) => s.orderIds.includes(o.id)).map((o) => `${o.id} · ${o.customerName} · ${o.cargo.description}`).join(' | ')}
                  </div>
                  {s.status === 'completada' && s.pod && <div className="mt-1 text-sm text-emerald-300">Entregado a {s.pod.receiverName} · {fmt(s.pod.at)}</div>}
                  {s.status === 'omitida' && s.note && <div className="mt-1 text-sm text-rose-300">No realizada: {s.note}</div>}
                </div>
              </div>
              {isCurrent && (
                <div className="mt-3 space-y-2">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`${big} border border-slate-700 text-slate-100`}
                  >
                    <Navigation className="w-5 h-5" /> Cómo llegar
                  </a>
                  {s.status === 'pendiente' && (
                    <button type="button" disabled={busy} className={`${big} bg-slate-700 text-white`} onClick={() => void act(`/trips/${trip.id}/stops/${s.id}/arrive`, `Llegada a ${s.placeName} registrada.`)}>
                      <MapPin className="w-5 h-5" /> Llegué
                    </button>
                  )}
                  {s.kind === 'carga' ? (
                    <button type="button" disabled={busy} className={`${big} bg-emerald-600 text-white`} onClick={() => void act(`/trips/${trip.id}/stops/${s.id}/complete`, 'Carga registrada.')}>
                      <PackageCheck className="w-5 h-5" /> Carga lista
                    </button>
                  ) : (
                    <button type="button" disabled={busy} className={`${big} bg-emerald-600 text-white`} onClick={() => setModal({ kind: 'deliver', stop: s })}>
                      <PackageCheck className="w-5 h-5" /> Entregar (firma)
                    </button>
                  )}
                  <button type="button" disabled={busy} className={`${big} border border-rose-600/50 text-rose-300`} onClick={() => setModal({ kind: 'fail', stop: s })}>
                    <XCircle className="w-5 h-5" /> No se pudo {s.kind === 'carga' ? 'cargar' : 'entregar'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!closed && !carrier && trip.status === 'en_curso' && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={`${big} border border-slate-700 text-slate-100`} onClick={() => setModal({ kind: 'fuel' })}>
            <Fuel className="w-5 h-5" /> Combustible
          </button>
          <button type="button" className={`${big} border border-slate-700 text-slate-100`} onClick={() => setModal({ kind: 'expense' })}>
            <Receipt className="w-5 h-5" /> Gasto
          </button>
        </div>
      )}
      {!closed && (
        <button type="button" className={`${big} border border-amber-500/50 text-amber-200`} onClick={() => setModal({ kind: 'report' })}>
          <AlertTriangle className="w-5 h-5" /> Reportar una novedad
        </button>
      )}
      {(modal?.kind === 'fuel' || modal?.kind === 'expense') && (
        <CostSheet
          token={token}
          trip={trip}
          mode={modal.kind}
          onClose={() => setModal(null)}
          onDone={async (text) => {
            setModal(null);
            setMsg({ text, ok: true });
            await onChanged();
          }}
        />
      )}

      {modal?.kind === 'deliver' && modal.stop && (
        <DeliverSheet
          token={token}
          trip={trip}
          stop={modal.stop}
          onClose={() => setModal(null)}
          onDone={async () => {
            setModal(null);
            setMsg({ text: 'Entrega registrada con firma. ¡Gracias!', ok: true });
            await onChanged();
          }}
        />
      )}
      {(modal?.kind === 'fail' || modal?.kind === 'report') && (
        <ReportSheet
          token={token}
          trip={trip}
          stop={modal.stop}
          mode={modal.kind}
          onClose={() => setModal(null)}
          onDone={async (text) => {
            setModal(null);
            setMsg({ text, ok: true });
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-xl max-h-[95vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-slate-700 bg-[#0F172A] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Signature pad: pointer events (finger, pen or mouse), exported as PNG. */
function SignaturePad({ onChange }: { onChange: (hasInk: boolean) => void; }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0F172A';
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div>
      <canvas
        ref={ref}
        aria-label="Espacio para la firma de quien recibe"
        className="w-full h-44 rounded-xl bg-white touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const ctx = e.currentTarget.getContext('2d')!;
          const p = pos(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d')!;
          const p = pos(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          if (!inked.current) {
            inked.current = true;
            onChange(true);
          }
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      />
      <div className="mt-1 flex justify-between text-sm">
        <span className="text-slate-500">Firma de quien recibe</span>
        <button
          type="button"
          className="text-sky-300 cursor-pointer"
          onClick={() => {
            const c = ref.current!;
            c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
            inked.current = false;
            onChange(false);
          }}
        >
          Borrar
        </button>
      </div>
    </div>
  );
}

function DeliverSheet({ token, trip, stop, onClose, onDone }: { token: string; trip: TripRow; stop: Stop; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [dni, setDni] = useState('');
  const [note, setNote] = useState('');
  const [signed, setSigned] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const padWrap = useRef<HTMLDivElement | null>(null);

  const dniDigits = dni.replace(/\D/g, '');
  const valid = name.trim().length >= 3 && /^\d{7,8}$/.test(dniDigits) && signed;

  const submit = async () => {
    if (!valid) return setError('Completá nombre, DNI (7 u 8 dígitos) y la firma.');
    setError(null);
    try {
      setBusy('Guardando la firma…');
      const canvas = padWrap.current!.querySelector('canvas')!;
      // toDataURL is synchronous (toBlob can take seconds on slow phones).
      const b64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const sigBlob = new Blob([bytes], { type: 'image/png' });
      const signatureFileId = await uploadImage(token, trip.id, 'signature', sigBlob);
      const photoFileIds: string[] = [];
      for (const [i, f] of photos.entries()) {
        setBusy(`Subiendo foto ${i + 1} de ${photos.length}…`);
        photoFileIds.push(await uploadImage(token, trip.id, 'photo', await compressPhoto(f)));
      }
      setBusy('Obteniendo ubicación…');
      const pos = await getPosition();
      setBusy('Registrando la entrega…');
      await call(token, 'POST', `/trips/${trip.id}/stops/${stop.id}/deliver`, {
        receiverName: name.trim(),
        receiverDni: dniDigits,
        signatureFileId,
        photoFileIds,
        note: note.trim() || undefined,
        ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy } : {}),
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar la entrega.');
      setBusy(null);
    }
  };

  return (
    <Sheet title={`Entrega en ${stop.placeName}`} onClose={onClose}>
      <p className="text-sm text-slate-400">{trip.orders.filter((o) => stop.orderIds.includes(o.id)).map((o) => `${o.id} · ${o.cargo.description}`).join(' | ')}</p>
      {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">{error}</div>}
      <label className="block">
        <span className="text-sm text-slate-300">Nombre y apellido de quien recibe</span>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} />
      </label>
      <label className="block">
        <span className="text-sm text-slate-300">DNI de quien recibe</span>
        <input className={`${field} font-mono`} value={dni} onChange={(e) => setDni(e.target.value)} inputMode="numeric" maxLength={12} placeholder="Sin puntos" />
      </label>
      <div ref={padWrap}>
        <SignaturePad onChange={setSigned} />
      </div>
      <label className={`${big} border border-dashed border-slate-600 text-slate-200`}>
        <Camera className="w-5 h-5" /> {photos.length ? `${photos.length} foto(s) — cambiar` : 'Agregar fotos (opcional)'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 3))}
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-300">Observaciones (opcional)</span>
        <textarea className={field} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <button type="button" disabled={!valid || Boolean(busy)} onClick={() => void submit()} className={`${big} bg-emerald-600 text-white`}>
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <PackageCheck className="w-5 h-5" />} {busy ?? 'Confirmar entrega'}
      </button>
      <p className="text-xs text-slate-500 text-center">Se registra la hora y, si lo permitís, la ubicación del celular.</p>
    </Sheet>
  );
}

function ReportSheet({
  token,
  trip,
  stop,
  mode,
  onClose,
  onDone,
}: {
  token: string;
  trip: TripRow;
  stop?: Stop;
  mode: 'fail' | 'report';
  onClose: () => void;
  onDone: (text: string) => Promise<void>;
}) {
  const types = (Object.keys(DRIVER_REPORT_TYPES) as DriverReportType[]).filter((t) => mode === 'report' || ['rechazo', 'faltante', 'acceso', 'otro'].includes(t));
  const [type, setType] = useState<DriverReportType>(mode === 'fail' ? 'rechazo' : 'demora');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!note.trim()) return setError('Contá brevemente qué pasó.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'fail' && stop) {
        await call(token, 'POST', `/trips/${trip.id}/stops/${stop.id}/fail`, { type, reason: note.trim() });
        await onDone('Quedó registrado y tu empresa ya lo ve.');
      } else {
        const photoFileId = photo ? await uploadImage(token, trip.id, 'photo', await compressPhoto(photo)) : undefined;
        await call(token, 'POST', `/trips/${trip.id}/reports`, { type, note: note.trim(), photoFileId });
        await onDone('Novedad enviada a tu empresa.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar.');
      setBusy(false);
    }
  };

  return (
    <Sheet title={mode === 'fail' ? `No se pudo completar: ${stop?.placeName ?? ''}` : 'Reportar una novedad'} onClose={onClose}>
      {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">{error}</div>}
      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-300 mb-1">¿Qué pasó?</legend>
        {types.map((t) => (
          <label key={t} className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 cursor-pointer ${type === t ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700'}`}>
            <input type="radio" name="report-type" checked={type === t} onChange={() => setType(t)} />
            <span className="text-slate-100">{DRIVER_REPORT_TYPES[t].label}</span>
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="text-sm text-slate-300">Detalle</span>
        <textarea className={field} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
      {mode === 'report' && (
        <label className={`${big} border border-dashed border-slate-600 text-slate-200`}>
          <Camera className="w-5 h-5" /> {photo ? 'Foto lista — cambiar' : 'Agregar foto (opcional)'}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <button type="button" disabled={busy} onClick={() => void submit()} className={`${big} ${mode === 'fail' ? 'bg-rose-600' : 'bg-amber-600'} text-white`}>
        {busy && <Loader2 className="w-5 h-5 animate-spin" />} Enviar
      </button>
      {mode === 'fail' && <p className="text-xs text-slate-500 text-center">La parada queda como no realizada y los pedidos vuelven a tu empresa para replanificarlos.</p>}
    </Sheet>
  );
}

/** Fuel load or trip expense with the ticket photo (expenses are approved by the company). */
function CostSheet({ token, trip, mode, onClose, onDone }: { token: string; trip: TripRow; mode: 'fuel' | 'expense'; onClose: () => void; onDone: (text: string) => Promise<void> }) {
  const [liters, setLiters] = useState('');
  const [amount, setAmount] = useState('');
  const [odometer, setOdometer] = useState('');
  const [station, setStation] = useState('');
  const [type, setType] = useState<ExpenseType>('peaje');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const total = parseAmount(amount);
    const l = parseAmount(liters);
    if (!total || (mode === 'fuel' && !l)) return setError(mode === 'fuel' ? 'Indicá los litros y el importe.' : 'Indicá el importe.');
    setBusy(true);
    setError(null);
    try {
      const receiptFileId = photo ? await uploadImage(token, trip.id, 'receipt', await compressPhoto(photo)) : undefined;
      if (mode === 'fuel') {
        const r = await call<{ load: { flags: Array<{ message: string }> } }>(token, 'POST', `/trips/${trip.id}/fuel`, {
          liters: l,
          total,
          odometerKm: parseAmount(odometer) ?? undefined,
          station: station.trim() || undefined,
          receiptFileId,
        });
        await onDone(r.load.flags.length ? `Carga registrada. Atención: ${r.load.flags.map((f) => f.message).join(' ')}` : 'Carga de combustible registrada.');
      } else {
        await call(token, 'POST', `/trips/${trip.id}/expenses`, { type, amount: total, note: note.trim() || undefined, receiptFileId });
        await onDone('Gasto enviado. Tu empresa lo revisa para reintegrártelo.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar.');
      setBusy(false);
    }
  };

  return (
    <Sheet title={mode === 'fuel' ? 'Carga de combustible' : 'Gasto del viaje'} onClose={onClose}>
      {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">{error}</div>}
      {mode === 'fuel' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="text-sm text-slate-300">Litros</span><input className={`${field} font-mono`} inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value)} /></label>
            <label className="block"><span className="text-sm text-slate-300">Importe</span><input className={`${field} font-mono`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          </div>
          <label className="block"><span className="text-sm text-slate-300">Odómetro (km, opcional)</span><input className={`${field} font-mono`} inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} /></label>
          <label className="block"><span className="text-sm text-slate-300">Estación (opcional)</span><input className={field} value={station} maxLength={160} onChange={(e) => setStation(e.target.value)} /></label>
        </>
      ) : (
        <>
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="text-sm text-slate-300 mb-1">Tipo</legend>
            {(Object.keys(EXPENSE_LABELS) as ExpenseType[]).map((t) => (
              <label key={t} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 cursor-pointer ${type === t ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700'}`}>
                <input type="radio" name="exp-type" checked={type === t} onChange={() => setType(t)} /> <span className="text-slate-100">{EXPENSE_LABELS[t]}</span>
              </label>
            ))}
          </fieldset>
          <label className="block"><span className="text-sm text-slate-300">Importe</span><input className={`${field} font-mono`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="block"><span className="text-sm text-slate-300">Detalle (opcional)</span><input className={field} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        </>
      )}
      <label className={`${big} border border-dashed border-slate-600 text-slate-200`}>
        <Camera className="w-5 h-5" /> {photo ? 'Foto del ticket lista — cambiar' : 'Foto del ticket'}
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
      </label>
      <button type="button" disabled={busy} onClick={() => void submit()} className={`${big} bg-sky-600 text-white`}>
        {busy && <Loader2 className="w-5 h-5 animate-spin" />} Enviar
      </button>
    </Sheet>
  );
}
