import { useMemo, useState } from 'react';
import { Pencil, Plus, ReceiptText, Search, Trash2, UsersRound } from 'lucide-react';
import type { Customer, CustomerContact, Place } from '../../shared/tms.ts';
import { TariffDialog } from './TariffDialog.tsx';
import { PortalUsersDialog } from './PortalUsersDialog.tsx';
import { apiRequest } from '../../lib/api.ts';
import { foldText } from '../../shared/drivers.ts';
import { Pagination, usePagination } from '../Pagination.tsx';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;

export function CustomersPanel({
  customers,
  places,
  canWrite,
  creationBlocked,
  notify,
  onChanged,
}: {
  customers: Customer[];
  places: Place[];
  canWrite: boolean;
  /** Superadmin viewing "all companies": creating needs a company. */
  creationBlocked?: string;
  notify: Notify;
  onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [tariffOf, setTariffOf] = useState<Customer | null>(null);
  const [portalOf, setPortalOf] = useState<Customer | null>(null);
  const filtered = useMemo(() => {
    const n = foldText(q);
    return customers.filter((c) => !n || foldText(`${c.name} ${c.taxId}`).includes(n));
  }, [customers, q]);
  const pag = usePagination(filtered, `${q}|${customers.length}`, 10);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre o CUIT…" aria-label="Buscar clientes" className={`${inputCls} pl-8`} />
        </div>
        {canWrite && (
          <button type="button" className={btnPrimary} disabled={Boolean(creationBlocked)} title={creationBlocked} onClick={() => setEditing('new')}>
            <Plus className="w-3.5 h-3.5" /> Nuevo cliente
          </button>
        )}
      </div>
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
              <th className="py-2.5 px-4 font-medium">Cliente</th>
              <th className="py-2.5 px-4 font-medium">CUIT / ID fiscal</th>
              <th className="py-2.5 px-4 font-medium">Contacto</th>
              <th className="py-2.5 px-4 font-medium">Estado</th>
              <th className="py-2.5 px-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {pag.pagedItems.map((c) => (
              <tr key={c.id} className="hover:bg-slate-800/30">
                <td className="py-2.5 px-4">
                  <div className="font-medium text-slate-100">{c.name}</div>
                  {c.taxCondition && <div className="text-slate-500">{c.taxCondition}</div>}
                </td>
                <td className="py-2.5 px-4 font-mono text-slate-300">{c.taxId}</td>
                <td className="py-2.5 px-4 text-slate-300">
                  {c.contacts[0] ? (
                    <>
                      <div>{c.contacts[0].name}</div>
                      <div className="text-slate-500">{[c.contacts[0].phone, c.contacts[0].email].filter(Boolean).join(' · ')}</div>
                    </>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="py-2.5 px-4">{c.active ? <span className="text-emerald-300">Activo</span> : <span className="text-slate-500">Inactivo</span>}</td>
                <td className="py-2.5 px-4 text-right">
                  {canWrite && (
                    <button type="button" onClick={() => setTariffOf(c)} aria-label={`Tarifario de ${c.name}`} title="Tarifario" className="p-1.5 rounded-md text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer">
                      <ReceiptText className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {canWrite && (
                    <button type="button" onClick={() => setPortalOf(c)} aria-label={`Portal de ${c.name}`} title="Accesos al portal de clientes" className="p-1.5 rounded-md text-slate-400 hover:text-violet-300 hover:bg-violet-500/10 cursor-pointer">
                      <UsersRound className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {canWrite && (
                    <button type="button" onClick={() => setEditing(c)} aria-label={`Editar ${c.name}`} className="p-1.5 rounded-md text-slate-400 hover:text-sky-300 hover:bg-sky-500/10 cursor-pointer">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="p-8 text-center text-slate-400">{q ? 'Ningún cliente coincide con la búsqueda.' : 'Todavía no hay clientes. Cargá el primero para crear pedidos.'}</div>}
        <Pagination page={pag.page} totalItems={pag.totalItems} pageSize={10} onPageChange={pag.setPage} />
      </div>
      {portalOf && <PortalUsersDialog customer={portalOf} notify={notify} onClose={() => setPortalOf(null)} />}
      {tariffOf && (
        <TariffDialog
          customer={tariffOf}
          places={places.filter((p) => p.active)}
          onClose={() => setTariffOf(null)}
          onSaved={(msg) => {
            setTariffOf(null);
            notify(msg);
          }}
        />
      )}
      {editing && (
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name, isNew) => {
            setEditing(null);
            notify(isNew ? `Cliente «${name}» creado.` : `Cliente «${name}» actualizado.`);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: (name: string, isNew: boolean) => void }) {
  const [name, setName] = useState(customer?.name ?? '');
  const [taxId, setTaxId] = useState(customer?.taxId ?? '');
  const [taxCondition, setTaxCondition] = useState(customer?.taxCondition ?? 'Responsable inscripto');
  const [contacts, setContacts] = useState<CustomerContact[]>(customer?.contacts.length ? customer.contacts : [{ name: '', phone: '', email: '' }]);
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [active, setActive] = useState(customer?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !taxId.trim()) return setError('Nombre e identificación fiscal son obligatorios.');
    setSaving(true);
    setError(null);
    const body = { name, taxId, taxCondition, contacts: contacts.filter((c) => c.name.trim()), notes, active };
    try {
      if (customer) await apiRequest(`/api/tms/customers/${customer.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await apiRequest('/api/tms/customers', { method: 'POST', body: JSON.stringify(body) });
      onSaved(name.trim(), !customer);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el cliente.'));
      setSaving(false);
    }
  };

  return (
    <Dialog title={customer ? `Editar ${customer.name}` : 'Nuevo cliente'} subtitle="Dador de carga o destinatario de los pedidos" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field id="cli-name" label="Razón social">
            <input id="cli-name" className={inputCls} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="cli-tax" label="CUIT / RUT / RIF" hint="Un CUIT se valida con su dígito verificador.">
            <input id="cli-tax" className={`${inputCls} font-mono`} value={taxId} maxLength={30} onChange={(e) => setTaxId(e.target.value)} placeholder="30-71234567-1" />
          </Field>
          <Field id="cli-cond" label="Condición fiscal">
            <select id="cli-cond" className={inputCls} value={taxCondition} onChange={(e) => setTaxCondition(e.target.value)}>
              {['Responsable inscripto', 'Monotributo', 'Exento', 'Consumidor final', 'Exterior'].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field id="cli-active" label="Estado">
            <label className="inline-flex items-center gap-2 py-2 text-slate-300 cursor-pointer">
              <input id="cli-active" type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo (se puede usar en pedidos nuevos)
            </label>
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-medium text-slate-300 mb-1">Contactos</legend>
          {contacts.map((c, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2">
              <input aria-label={`Nombre del contacto ${i + 1}`} placeholder="Nombre" className={inputCls} value={c.name} onChange={(e) => setContacts((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input aria-label={`Teléfono del contacto ${i + 1}`} placeholder="Teléfono" className={inputCls} value={c.phone ?? ''} onChange={(e) => setContacts((all) => all.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
              <input aria-label={`Email del contacto ${i + 1}`} placeholder="Email" type="email" className={inputCls} value={c.email ?? ''} onChange={(e) => setContacts((all) => all.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
              <button type="button" aria-label={`Quitar contacto ${i + 1}`} onClick={() => setContacts((all) => all.filter((_, j) => j !== i))} className="p-2 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {contacts.length < 10 && (
            <button type="button" className="text-sky-400 hover:underline cursor-pointer" onClick={() => setContacts((all) => [...all, { name: '', phone: '', email: '' }])}>
              + Agregar contacto
            </button>
          )}
        </fieldset>
        <Field id="cli-notes" label="Notas">
          <textarea id="cli-notes" rows={2} className={inputCls} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="submit" className={btnPrimary} disabled={saving}>{saving ? 'Guardando…' : 'Guardar cliente'}</button>
        </div>
      </form>
    </Dialog>
  );
}
