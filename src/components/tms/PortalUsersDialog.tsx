import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, UserPlus } from 'lucide-react';
import type { Customer } from '../../shared/tms.ts';
import type { PortalUser } from '../../shared/portal.ts';
import { apiRequest } from '../../lib/api.ts';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, fmtDateTime, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
type Row = Omit<PortalUser, 'passwordHash'>;

/** Who of a customer can enter the customer portal (/portal). */
export function PortalUsersDialog({ customer, notify, onClose }: { customer: Customer; notify: Notify; onClose: () => void }) {
  const [items, setItems] = useState<Row[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
  const portalUrl = `${window.location.origin}/portal`;

  const load = useCallback(async () => {
    try {
      setItems((await apiRequest<{ items: Row[] }>(`/api/tms/customers/${customer.id}/portal-users`)).items);
    } catch (err) {
      setError(errMsg(err, 'No se pudieron cargar los accesos.'));
    }
  }, [customer.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ user: Row; password: string }>(`/api/tms/customers/${customer.id}/portal-users`, { method: 'POST', body: JSON.stringify({ name, email }) });
      setCredential({ email: r.user.email, password: r.password });
      setName('');
      setEmail('');
      void load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear el acceso.'));
    } finally {
      setBusy(false);
    }
  };
  const reset = async (u: Row) => {
    if (!window.confirm(`¿Generar una contraseña temporal nueva para ${u.email}? Se cierran sus sesiones abiertas.`)) return;
    try {
      const r = await apiRequest<{ password: string }>(`/api/tms/portal-users/${u.id}/reset-password`, { method: 'POST' });
      setCredential({ email: u.email, password: r.password });
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo restablecer.'), 'err');
    }
  };
  const toggle = async (u: Row) => {
    try {
      await apiRequest(`/api/tms/portal-users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ active: !u.active }) });
      notify(u.active ? `${u.email} ya no puede entrar al portal.` : `${u.email} puede volver a entrar.`, u.active ? 'warn' : 'ok');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo cambiar.'), 'err');
    }
  };
  const message = credential ? `Portal de clientes: ${portalUrl}\nUsuario: ${credential.email}\nContraseña temporal: ${credential.password}\n(Al entrar te pide cambiarla.)` : '';

  return (
    <Dialog title={`Portal de clientes · ${customer.name}`} subtitle="Ven sus pedidos, el seguimiento, los remitos y las facturas; pueden cargar pedidos para que los confirmes." onClose={onClose} wide>
      <div className="space-y-4">
        {credential && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100 space-y-2">
            <div className="font-medium">Contraseña temporal de {credential.email}: no se vuelve a mostrar.</div>
            <pre className="whitespace-pre-wrap rounded bg-[#0B1120] p-2 font-mono text-[11px] text-slate-200 select-all">{message}</pre>
            <button
              type="button"
              className={btnGhost}
              onClick={() => void navigator.clipboard?.writeText(message).then(() => notify('Datos de acceso copiados.'))}
            >
              <Copy className="w-3.5 h-3.5" /> Copiar para enviar
            </button>
          </div>
        )}
        <div className="rounded-lg border border-slate-800 divide-y divide-slate-800/60">
          {items?.map((u) => (
            <div key={u.id} className={`flex flex-wrap items-center justify-between gap-2 p-2.5 text-xs ${u.active ? '' : 'opacity-60'}`}>
              <div>
                <div className="text-slate-100">{u.name} <span className="text-slate-400">&lt;{u.email}&gt;</span></div>
                <div className="text-slate-500">
                  {u.active ? (u.mustChangePassword ? 'Todavía no entró (contraseña temporal)' : u.lastLoginAt ? `Último ingreso ${fmtDateTime(u.lastLoginAt)}` : 'Activo') : 'Desactivado'}
                  {u.lockedUntil && Date.parse(u.lockedUntil) > Date.now() && <span className="text-rose-300"> · bloqueado por intentos fallidos</span>}
                </div>
              </div>
              <div className="flex gap-1">
                <button type="button" className={btnGhost} onClick={() => void reset(u)}>
                  <KeyRound className="w-3.5 h-3.5" /> Nueva contraseña
                </button>
                <button type="button" className={`${btnGhost} ${u.active ? 'text-rose-300' : ''}`} onClick={() => void toggle(u)}>
                  {u.active ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            </div>
          ))}
          {items && items.length === 0 && <div className="p-4 text-center text-xs text-slate-400">Este cliente todavía no tiene accesos al portal.</div>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <Field id="pu-name" label="Nombre">
            <input id="pu-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="pu-email" label="Email (usuario)">
            <input id="pu-email" type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <button type="button" className={btnPrimary} disabled={busy || name.trim().length < 2 || !email.includes('@')} onClick={() => void add()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Dar acceso
          </button>
        </div>
        {error && <div className="text-xs text-rose-300">{error}</div>}
      </div>
    </Dialog>
  );
}
