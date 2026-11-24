import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, ClipboardList, Download, ExternalLink, FileText, Loader2, LogOut, MapPin, PackageCheck, Plus, Search, Truck, X } from 'lucide-react';
import type { PortalMe } from '../shared/portal.ts';
import type { Cargo, OrderStatus, TimeWindow } from '../shared/tms.ts';

const TOKEN_KEY = 'geocar.portal.token';
const fmt = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
const money = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
const input = 'w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500';
const primary = 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50 cursor-pointer';
const ghost = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer';
const card = 'rounded-xl border border-slate-800 bg-[#11192C]';

class PortalError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`/api/portal${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { 'x-portal-token': token } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PortalError(typeof json.error === 'string' ? json.error : 'No se pudo completar.', res.status, json.code);
  return json as T;
}

async function openPdf(path: string) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`/api/portal${path}`, { headers: token ? { 'x-portal-token': token } : {} });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(typeof j.error === 'string' ? j.error : 'No se pudo descargar.');
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Sin conexión.');

interface OrderRow {
  id: string;
  reference: string | null;
  status: OrderStatus;
  statusLabel: string;
  origin: string;
  destination: string;
  cargo: Cargo;
  pickupWindow: TimeWindow | null;
  deliveryWindow: TimeWindow | null;
  eta: string | null;
  deliveredAt: string | null;
  hasProof: boolean;
  trackingPath: string | null;
  source: string;
  createdAt: string;
}
interface InvoiceRow {
  id: string;
  kind: 'factura' | 'nota_credito';
  letter: string;
  number: string;
  date: string;
  total: number;
  cae: string;
  status: 'emitida' | 'simulada';
  cancelled: boolean;
  orderIds: string[];
}

const TONE: Record<OrderStatus, string> = {
  borrador: 'border-slate-600 text-slate-300',
  confirmado: 'border-sky-500/50 text-sky-300',
  planificado: 'border-indigo-500/50 text-indigo-300',
  en_curso: 'border-amber-500/50 text-amber-300',
  entregado: 'border-emerald-500/50 text-emerald-300',
  cancelado: 'border-rose-500/40 text-rose-300',
};
const Pill = ({ o }: { o: Pick<OrderRow, 'status' | 'statusLabel'> }) => (
  <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[o.status]}`}>{o.status === 'borrador' ? 'Pendiente de confirmar' : o.statusLabel}</span>
);

/** Customer portal (/portal): orders, live tracking, delivery notes and invoices of one customer. */
export function PortalApp() {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    document.title = 'Portal de clientes';
    if (!localStorage.getItem(TOKEN_KEY)) {
      setChecking(false);
      return;
    }
    call<PortalMe>('/me')
      .then(setMe)
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setChecking(false));
  }, []);

  const logout = async () => {
    await call('/logout', { method: 'POST' }).catch(() => undefined);
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
  };

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100">
      {checking ? (
        <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : !me ? (
        <Login onLogged={setMe} />
      ) : me.user.mustChangePassword ? (
        <ChangePassword me={me} onDone={setMe} onLogout={() => void logout()} />
      ) : (
        <Home me={me} onLogout={() => void logout()} onExpired={() => { localStorage.removeItem(TOKEN_KEY); setMe(null); }} />
      )}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4"><div className={`${card} w-full max-w-sm p-6`}>{children}</div></div>;
}

function Login({ onLogged }: { onLogged: (me: PortalMe) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; me: PortalMe }>('/login', { method: 'POST', body: { email, password } });
      localStorage.setItem(TOKEN_KEY, r.token);
      onLogged(r.me);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <div className="mb-5 flex items-center gap-2">
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2"><Truck className="h-5 w-5 text-sky-400" /></div>
        <div>
          <h1 className="text-base font-semibold">Portal de clientes</h1>
          <p className="text-xs text-slate-400">Tus pedidos, entregas y facturas</p>
        </div>
      </div>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <label className="block space-y-1 text-xs text-slate-400">
          <span>Email</span>
          <input className={input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block space-y-1 text-xs text-slate-400">
          <span>Contraseña</span>
          <input className={input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
        <button type="submit" className={`${primary} w-full`} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Ingresar</button>
      </form>
      <p className="mt-4 text-[11px] text-slate-500">¿No tenés acceso o olvidaste la contraseña? Pedíselo a tu empresa de transporte.</p>
    </Shell>
  );
}

function ChangePassword({ me, onDone, onLogout }: { me: PortalMe; onDone: (me: PortalMe) => void; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError('Las contraseñas nuevas no coinciden.');
    setBusy(true);
    setError(null);
    try {
      onDone(await call<PortalMe>('/password', { method: 'POST', body: { current, next } }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <h1 className="text-base font-semibold">Hola, {me.user.name}</h1>
      <p className="mb-4 text-xs text-slate-400">Elegí tu contraseña para el portal de {me.company.name}. Mínimo 10 caracteres, con letras y números.</p>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <input className={input} type="password" placeholder="Contraseña temporal" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <input className={input} type="password" placeholder="Contraseña nueva" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <input className={input} type="password" placeholder="Repetí la contraseña nueva" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
        <button type="submit" className={`${primary} w-full`} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Guardar y continuar</button>
      </form>
      <button type="button" className="mt-3 text-xs text-slate-400 hover:underline cursor-pointer" onClick={onLogout}>Salir</button>
    </Shell>
  );
}

type Tab = 'pedidos' | 'nuevo' | 'facturas';

function Home({ me, onLogout, onExpired }: { me: PortalMe; onLogout: () => void; onExpired: () => void }) {
  const [tab, setTab] = useState<Tab>('pedidos');
  const [toast, setToast] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const guard = useCallback(
    (err: unknown) => {
      if (err instanceof PortalError && err.status === 401) onExpired();
      return errText(err);
    },
    [onExpired]
  );
  const tabs: Array<[Tab, string, typeof Truck]> = [
    ['pedidos', 'Mis pedidos', ClipboardList],
    ['nuevo', 'Nuevo pedido', Plus],
    ['facturas', 'Facturas', FileText],
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className={`${card} flex flex-wrap items-center justify-between gap-3 p-4`}>
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2"><Truck className="h-5 w-5 text-sky-400" /></div>
          <div>
            <h1 className="text-sm font-semibold">{me.customer.name}</h1>
            <p className="text-xs text-slate-400">Portal de {me.company.name} · {me.user.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <nav className="flex gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1" aria-label="Secciones">
            {tabs.map(([id, label, Icon]) => (
              <button key={id} type="button" aria-current={tab === id} onClick={() => setTab(id)} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium cursor-pointer ${tab === id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </nav>
          <button type="button" className={ghost} onClick={onLogout}><LogOut className="h-3.5 w-3.5" /> Salir</button>
        </div>
      </header>
      {toast && (
        <div role="status" className="flex items-start justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> {toast}</span>
          <button type="button" aria-label="Cerrar" onClick={() => setToast(null)} className="cursor-pointer"><X className="h-4 w-4" /></button>
        </div>
      )}
      {tab === 'pedidos' && <Orders key={reload} guard={guard} />}
      {tab === 'nuevo' && (
        <NewOrder
          guard={guard}
          onCreated={(o) => {
            setToast(`Pedido ${o.id} enviado. ${me.company.name} lo revisa y lo confirma.`);
            setReload((k) => k + 1);
            setTab('pedidos');
          }}
        />
      )}
      {tab === 'facturas' && <Invoices guard={guard} />}
    </div>
  );
}

function Orders({ guard }: { guard: (e: unknown) => string }) {
  const [filter, setFilter] = useState<'activos' | 'entregado' | ''>('activos');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ items: OrderRow[]; counts: { activos: number; entregados: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (filter) p.set('status', filter);
      if (q.trim()) p.set('q', q.trim());
      setData(await call(`/orders?${p}`));
      setError(null);
    } catch (err) {
      setError(guard(err));
    }
  }, [filter, q, guard]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {([['activos', `En curso (${data?.counts.activos ?? '…'})`], ['entregado', `Entregados (${data?.counts.entregados ?? '…'})`], ['', 'Todos']] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => setFilter(v)} className={`rounded-full border px-3 py-1 text-xs cursor-pointer ${filter === v ? 'border-sky-500 bg-sky-500/15 text-sky-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
            {label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-500" />
          <input className={`${input} w-64 pl-8 text-xs`} placeholder="Buscar pedido, referencia, lugar…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <div className={`${card} divide-y divide-slate-800/70`}>
        {data?.items.map((o) => (
          <button key={o.id} type="button" onClick={() => setOpen(o.id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-slate-800/30 cursor-pointer">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-slate-100">{o.id}</span>
                {o.reference && <span className="text-xs text-slate-400">Ref. {o.reference}</span>}
                <Pill o={o} />
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-slate-300"><MapPin className="h-3 w-3 text-slate-500" /> {o.origin} → {o.destination}</div>
              <div className="text-xs text-slate-500">{o.cargo.description}{o.cargo.weightKg ? ` · ${o.cargo.weightKg.toLocaleString('es-AR')} kg` : ''}</div>
            </div>
            <div className="text-right text-xs text-slate-400">
              {o.status === 'entregado' ? <span className="text-emerald-300">Entregado {fmt(o.deliveredAt)}</span> : o.eta ? <span className="text-amber-200">Llega aprox. {fmt(o.eta)}</span> : o.deliveryWindow ? `Entrega ${fmt(o.deliveryWindow.from)}` : `Pedido ${fmt(o.createdAt)}`}
            </div>
          </button>
        ))}
        {data && data.items.length === 0 && <div className="p-8 text-center text-sm text-slate-400">No hay pedidos para mostrar.</div>}
        {!data && !error && <div className="p-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" /></div>}
      </div>
      {open && <OrderDetail id={open} guard={guard} onClose={() => setOpen(null)} />}
    </section>
  );
}

function OrderDetail({ id, guard, onClose }: { id: string; guard: (e: unknown) => string; onClose: () => void }) {
  const [d, setD] = useState<{ order: OrderRow; notes: string | null; events: Array<{ at: string; label: string }>; unit: { etaMinutes: number; distanceKm: number; at: string } | null; delivered: { at: string; receiverName: string; hasProof: boolean } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<NonNullable<typeof d>>(`/orders/${encodeURIComponent(id)}`)
      .then(setD)
      .catch((e) => setError(guard(e)));
  }, [id, guard]);
  const remito = () => void openPdf(`/orders/${encodeURIComponent(id)}/remito.pdf`).catch((e) => setError(errText(e)));
  const o = d?.order;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label={`Pedido ${id}`} onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-[#0F172A] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-mono text-base">{id}</h2>
            {o && <Pill o={o} />}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1 text-slate-400 hover:bg-slate-800 cursor-pointer"><X className="h-5 w-5" /></button>
        </div>
        {error && <p role="alert" className="mb-3 text-xs text-rose-300">{error}</p>}
        {!d && !error && <Loader2 className="h-5 w-5 animate-spin text-slate-500" />}
        {o && d && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-xs">
              <dt className="text-slate-400">Referencia</dt><dd>{o.reference ?? '—'}</dd>
              <dt className="text-slate-400">Origen</dt><dd>{o.origin}</dd>
              <dt className="text-slate-400">Destino</dt><dd>{o.destination}</dd>
              <dt className="text-slate-400">Carga</dt><dd>{o.cargo.description}{o.cargo.weightKg ? ` · ${o.cargo.weightKg} kg` : ''}{o.cargo.pallets ? ` · ${o.cargo.pallets} pallets` : ''}</dd>
              {o.deliveryWindow && (<><dt className="text-slate-400">Entrega pedida</dt><dd>{fmt(o.deliveryWindow.from)} a {fmt(o.deliveryWindow.to)}</dd></>)}
              {d.notes && (<><dt className="text-slate-400">Notas</dt><dd className="whitespace-pre-wrap">{d.notes}</dd></>)}
            </dl>
            {d.unit && o.status === 'en_curso' && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                <Truck className="mr-1 inline h-4 w-4" /> En camino: a {d.unit.distanceKm.toLocaleString('es-AR')} km, llega en unos {d.unit.etaMinutes} min.
              </div>
            )}
            {d.delivered && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
                <PackageCheck className="mr-1 inline h-4 w-4" /> Entregado el {fmt(d.delivered.at)}{d.delivered.receiverName ? `, recibió ${d.delivered.receiverName}` : ''}{d.delivered.hasProof ? ' (con firma)' : ''}.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {o.trackingPath && (
                <a className={ghost} href={o.trackingPath} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Seguimiento en el mapa</a>
              )}
              {['planificado', 'en_curso', 'entregado'].includes(o.status) && (
                <button type="button" className={ghost} onClick={remito}><Download className="h-3.5 w-3.5" /> Remito {o.hasProof ? 'firmado' : ''}</button>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Historial</h3>
              <ol className="space-y-2 border-l border-slate-700 pl-4">
                {d.events.map((e, i) => (
                  <li key={i} className="relative text-xs">
                    <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-sky-500" />
                    <div className="text-slate-200">{e.label}</div>
                    <div className="text-slate-500">{fmt(e.at)}</div>
                  </li>
                ))}
                {d.events.length === 0 && <li className="text-xs text-slate-500">Todavía sin novedades.</li>}
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NewOrder({ guard, onCreated }: { guard: (e: unknown) => string; onCreated: (o: OrderRow) => void }) {
  const [places, setPlaces] = useState<Array<{ id: string; name: string; address: string; own: boolean }> | null>(null);
  const [f, setF] = useState({ originPlaceId: '', destinationPlaceId: '', description: '', weightKg: '', pallets: '', reference: '', from: '', to: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ items: NonNullable<typeof places> }>('/places')
      .then((r) => setPlaces(r.items))
      .catch((e) => setError(guard(e)));
  }, [guard]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const num = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : undefined);
      const r = await call<{ order: OrderRow }>('/orders', {
        method: 'POST',
        body: {
          originPlaceId: f.originPlaceId,
          destinationPlaceId: f.destinationPlaceId,
          cargo: { description: f.description, weightKg: num(f.weightKg), pallets: num(f.pallets) },
          reference: f.reference || undefined,
          notes: f.notes || undefined,
          deliveryWindow: f.from && f.to ? { from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString() } : undefined,
        },
      });
      onCreated(r.order);
    } catch (err) {
      setError(guard(err));
    } finally {
      setBusy(false);
    }
  };
  const label = 'block space-y-1 text-xs text-slate-400';
  return (
    <form className={`${card} space-y-4 p-4`} onSubmit={(e) => void submit(e)}>
      <p className="text-xs text-slate-400">El pedido llega como pendiente de confirmar: la empresa lo revisa, lo confirma y lo asigna a un viaje. Si necesitás un lugar que no está en la lista, pedíselo a la empresa.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          <span>Origen (carga)</span>
          <select className={input} value={f.originPlaceId} onChange={set('originPlaceId')} required>
            <option value="">Elegí…</option>
            {places?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.address ? ` · ${p.address}` : ''}</option>)}
          </select>
        </label>
        <label className={label}>
          <span>Destino (entrega)</span>
          <select className={input} value={f.destinationPlaceId} onChange={set('destinationPlaceId')} required>
            <option value="">Elegí…</option>
            {places?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.address ? ` · ${p.address}` : ''}</option>)}
          </select>
        </label>
        <label className={`${label} sm:col-span-2`}>
          <span>Qué se transporta</span>
          <input className={input} value={f.description} onChange={set('description')} required maxLength={200} placeholder="Ej.: 12 pallets de bebidas" />
        </label>
        <label className={label}><span>Peso (kg)</span><input className={input} inputMode="decimal" value={f.weightKg} onChange={set('weightKg')} /></label>
        <label className={label}><span>Pallets</span><input className={input} inputMode="numeric" value={f.pallets} onChange={set('pallets')} /></label>
        <label className={label}><span>Entrega desde</span><input className={input} type="datetime-local" value={f.from} onChange={set('from')} /></label>
        <label className={label}><span>Entrega hasta</span><input className={input} type="datetime-local" value={f.to} onChange={set('to')} /></label>
        <label className={label}><span>Tu referencia (orden de compra, remito)</span><input className={input} value={f.reference} onChange={set('reference')} maxLength={60} /></label>
        <label className={`${label} sm:col-span-2`}><span>Notas</span><textarea className={`${input} h-20`} value={f.notes} onChange={set('notes')} maxLength={1000} /></label>
      </div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" className={primary} disabled={busy || !places}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enviar pedido</button>
      </div>
    </form>
  );
}

function Invoices({ guard }: { guard: (e: unknown) => string }) {
  const [items, setItems] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ items: InvoiceRow[] }>('/invoices')
      .then((r) => setItems(r.items))
      .catch((e) => setError(guard(e)));
  }, [guard]);
  return (
    <section className={`${card} overflow-x-auto`}>
      {error && <p role="alert" className="p-3 text-xs text-rose-300">{error}</p>}
      <table className="w-full text-left text-xs">
        <thead><tr className="border-b border-slate-800 bg-[#0F172A] text-slate-400"><th className="px-3 py-2.5 font-medium">Comprobante</th><th className="px-3 py-2.5 font-medium">Fecha</th><th className="px-3 py-2.5 font-medium">Pedidos</th><th className="px-3 py-2.5 text-right font-medium">Total</th><th className="px-3 py-2.5" /></tr></thead>
        <tbody className="divide-y divide-slate-800/60">
          {items?.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2">
                <div className="text-slate-100">{i.kind === 'factura' ? 'Factura' : 'Nota de crédito'} {i.letter} <span className="font-mono">{i.number}</span></div>
                <div className="text-slate-500">{i.status === 'simulada' ? <span className="text-amber-300">Comprobante de prueba</span> : `CAE ${i.cae}`}{i.cancelled && <span className="text-rose-300"> · anulada</span>}</div>
              </td>
              <td className="px-3 py-2 font-mono text-slate-300">{i.date.slice(0, 10)}</td>
              <td className="px-3 py-2 font-mono text-slate-400">{i.orderIds.join(', ')}</td>
              <td className={`px-3 py-2 text-right font-mono ${i.kind === 'nota_credito' ? 'text-rose-300' : 'text-slate-100'}`}>{i.kind === 'nota_credito' ? '-' : ''}{money(i.total)}</td>
              <td className="px-3 py-2 text-right">
                <button type="button" className={ghost} onClick={() => void openPdf(`/invoices/${i.id}/pdf`).catch((e) => setError(errText(e)))}><Download className="h-3.5 w-3.5" /> PDF</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items && items.length === 0 && <div className="p-8 text-center text-sm text-slate-400">Todavía no hay facturas.</div>}
    </section>
  );
}
