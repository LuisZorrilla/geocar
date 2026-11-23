import { useEffect, useState, type ReactNode } from 'react';
import { apiRequest, getAuthToken, getTenantScope } from '../../lib/api.ts';
import { X } from 'lucide-react';
import type { OrderStatus, StopStatus, TripStatus } from '../../shared/tms.ts';
import { ORDER_STATUS_LABELS, STOP_STATUS_LABELS, TRIP_STATUS_LABELS } from '../../shared/tms.ts';

export const inputCls =
  'w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 text-xs focus:outline-none focus:border-sky-500 disabled:opacity-60';
export const btnPrimary =
  'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white cursor-pointer whitespace-nowrap';
export const btnGhost =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap disabled:opacity-50';

export function Field({ id, label, hint, error, children }: { id?: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-medium text-slate-300 mb-1">
        {label}
      </label>
      {children}
      {error ? <p className="mt-1 text-[11px] text-rose-300">{error}</p> : hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** Modal with Escape to close. */
export function Dialog({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} max-h-[92vh] flex flex-col rounded-2xl border border-slate-800 bg-[#0F172A] text-xs text-slate-300 shadow-2xl`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100 truncate">{title}</h2>
            {subtitle && <p className="mt-0.5 text-slate-400">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded p-1 text-slate-400 hover:bg-slate-800 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

const ORDER_TONE: Record<OrderStatus, string> = {
  borrador: 'bg-slate-700/40 text-slate-300 border-slate-600',
  confirmado: 'bg-sky-500/10 text-sky-300 border-sky-500/40',
  planificado: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/40',
  en_curso: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  entregado: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  cancelado: 'bg-slate-800 text-slate-500 border-slate-700',
};
const TRIP_TONE: Record<TripStatus, string> = {
  planificado: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/40',
  en_curso: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  finalizado: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  cancelado: 'bg-slate-800 text-slate-500 border-slate-700',
};
const STOP_TONE: Record<StopStatus, string> = {
  pendiente: 'text-slate-400',
  en_lugar: 'text-amber-300',
  completada: 'text-emerald-300',
  omitida: 'text-rose-300',
};

const pill = 'inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap';
export const OrderStatusPill = ({ status }: { status: OrderStatus }) => <span className={`${pill} ${ORDER_TONE[status]}`}>{ORDER_STATUS_LABELS[status]}</span>;
export const TripStatusPill = ({ status, late }: { status: TripStatus; late?: boolean }) => (
  <span className={`${pill} ${late ? 'bg-rose-500/10 text-rose-300 border-rose-500/40' : TRIP_TONE[status]}`}>
    {TRIP_STATUS_LABELS[status]}
    {late ? ' · demorado' : ''}
  </span>
);
export const stopToneClass = (s: StopStatus) => STOP_TONE[s];
export const stopLabel = (s: StopStatus) => STOP_STATUS_LABELS[s];

/** "24/11 08:30" in local time. */
export const fmtDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';

/** ISO → value for <input type="datetime-local"> (local time). */
export function toLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** <input type="datetime-local"> value → ISO (undefined when empty). */
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

export const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Image behind the session (proof-of-delivery signature/photos): fetched with the auth header. */
export function AuthImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    const headers = new Headers();
    const token = getAuthToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const scope = getTenantScope();
    if (scope) headers.set('x-tenant-scope', scope);
    fetch(src, { headers })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  if (failed) return <div className={`${className ?? ''} flex items-center justify-center text-[11px] text-slate-500 border border-slate-800`}>No disponible</div>;
  return url ? <img src={url} alt={alt} className={className} /> : <div className={`${className ?? ''} animate-pulse bg-slate-800/60`} aria-label="Cargando imagen" />;
}

/** Copies the public tracking link of an order (creating it for older orders). */
export async function copyTrackingLink(orderId: string): Promise<string> {
  const res = await apiRequest<{ path: string }>(`/api/tms/orders/${encodeURIComponent(orderId)}/tracking-link`, { method: 'POST' });
  const url = `${window.location.origin}${res.path}`;
  await navigator.clipboard.writeText(url).catch(() => undefined);
  return url;
}
