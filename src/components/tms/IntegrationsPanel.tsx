import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Pause, Play, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { API_SCOPES, DELIVERY_STATUS_LABELS, WEBHOOK_EVENTS, type ApiKey, type ApiScope, type Webhook, type WebhookDelivery, type WebhookEvent } from '../../shared/integrations.ts';
import { apiRequest } from '../../lib/api.ts';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, fmtDateTime, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
type KeyRow = Omit<ApiKey, 'hash'>;
type HookRow = Omit<Webhook, 'secret'> & { pending: number; failed: number };
const card = 'bg-[#11192C] border border-slate-800/80 rounded-xl';

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="flex gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg border border-amber-500/40 bg-[#0B1120] px-3 py-2 font-mono text-xs text-amber-100 select-all">{value}</code>
        <button
          type="button"
          className={btnGhost}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="text-xs text-amber-300">Guardalo ahora: por seguridad no se vuelve a mostrar.</p>
    </div>
  );
}

/** Public API keys and webhooks of the company (administrators). */
export function IntegrationsPanel({ notify }: { notify: Notify }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState(false);
  const [newHook, setNewHook] = useState(false);
  const [shown, setShown] = useState<{ title: string; label: string; value: string } | null>(null);
  const [detail, setDetail] = useState<HookRow | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiRequest<{ apiKeys: KeyRow[]; webhooks: HookRow[]; publicAppUrl: string | null }>('/api/integrations');
      setKeys(r.apiKeys);
      setHooks(r.webhooks);
      setPublicUrl(r.publicAppUrl);
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'No se pudieron cargar las integraciones.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (k: KeyRow) => {
    if (!window.confirm(`¿Revocar la clave «${k.name}»? Los sistemas que la usan dejan de funcionar al instante.`)) return;
    try {
      await apiRequest(`/api/integrations/api-keys/${k.id}`, { method: 'DELETE' });
      notify('Clave revocada.', 'warn');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo revocar.'), 'err');
    }
  };
  const toggle = async (h: HookRow) => {
    try {
      await apiRequest(`/api/integrations/webhooks/${h.id}`, { method: 'PATCH', body: JSON.stringify({ active: !h.active }) });
      notify(h.active ? 'Webhook pausado.' : 'Webhook reactivado: se envía lo pendiente.');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo cambiar.'), 'err');
    }
  };
  const remove = async (h: HookRow) => {
    if (!window.confirm(`¿Eliminar el webhook a ${h.url}? Se borra también su historial de envíos.`)) return;
    try {
      await apiRequest(`/api/integrations/webhooks/${h.id}`, { method: 'DELETE' });
      notify('Webhook eliminado.', 'warn');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo eliminar.'), 'err');
    }
  };
  const rotate = async (h: HookRow) => {
    if (!window.confirm('¿Generar un secreto nuevo? El anterior deja de valer en el próximo envío.')) return;
    try {
      const r = await apiRequest<{ secret: string }>(`/api/integrations/webhooks/${h.id}/rotate-secret`, { method: 'POST' });
      setShown({ title: 'Secreto nuevo del webhook', label: 'Secreto de firma', value: r.secret });
    } catch (err) {
      notify(errMsg(err, 'No se pudo renovar.'), 'err');
    }
  };

  if (error) return <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">{error}</div>;

  return (
    <div className="space-y-5">
      <div className={`${card} p-4 text-xs text-slate-300 space-y-1`}>
        <p>
          Conectá el ERP, la web o el sistema de tus clientes. La <b>API</b> permite crear y consultar pedidos, viajes y facturas con una clave; los <b>webhooks</b> avisan
          al instante cuando algo cambia, firmados con HMAC-SHA256.
        </p>
        <p className="text-slate-400">
          Base: <code className="font-mono text-slate-200">{(publicUrl ?? window.location.origin).replace(/\/+$/, '')}/api/v1</code> · Autenticación:{' '}
          <code className="font-mono text-slate-200">Authorization: Bearer gk_…</code> · Documentación: docs/API.md
        </p>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Claves de API</h2>
            <p className="text-xs text-slate-400">Cada clave tiene permisos propios y se puede revocar sin afectar a las demás.</p>
          </div>
          <button type="button" className={btnPrimary} onClick={() => setNewKey(true)}>
            <Plus className="w-3.5 h-3.5" /> Nueva clave
          </button>
        </div>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
                <th className="py-2.5 px-3 font-medium">Nombre</th>
                <th className="py-2.5 px-3 font-medium">Clave</th>
                <th className="py-2.5 px-3 font-medium">Permisos</th>
                <th className="py-2.5 px-3 font-medium">Último uso</th>
                <th className="py-2.5 px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {keys?.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'opacity-50' : 'hover:bg-slate-800/30'}>
                  <td className="py-2 px-3 text-slate-100">
                    {k.name}
                    <div className="text-slate-500">por {k.createdBy} · {fmtDateTime(k.createdAt)}</div>
                  </td>
                  <td className="py-2 px-3 font-mono text-slate-300">{k.prefix}…</td>
                  <td className="py-2 px-3 text-slate-300">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <span key={s} className="px-1.5 py-0.5 rounded border border-slate-700 font-mono text-[10px]" title={API_SCOPES[s]}>{s}</span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-slate-300">{k.revokedAt ? <span className="text-rose-300">Revocada {fmtDateTime(k.revokedAt)}</span> : k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : 'Nunca'}</td>
                  <td className="py-2 px-3 text-right">
                    {!k.revokedAt && (
                      <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => void revoke(k)}>
                        Revocar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {keys && keys.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay claves.</div>}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Webhooks</h2>
            <p className="text-xs text-slate-400">Si el destino falla se reintenta a los 1, 5, 30, 120 y 360 minutos; tras 20 fallas seguidas el webhook se pausa.</p>
          </div>
          <button type="button" className={btnPrimary} onClick={() => setNewHook(true)}>
            <Plus className="w-3.5 h-3.5" /> Nuevo webhook
          </button>
        </div>
        <div className={`${card} divide-y divide-slate-800/60`}>
          {hooks?.map((h) => (
            <div key={h.id} className="p-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <WebhookIcon className={`w-4 h-4 ${h.active ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className="font-mono text-xs text-slate-100 break-all">{h.url}</span>
                </div>
                {h.description && <div className="text-xs text-slate-400 mt-0.5">{h.description}</div>}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {h.events.map((e) => (
                    <span key={e} className="px-1.5 py-0.5 rounded border border-slate-700 text-[10px] text-slate-300" title={WEBHOOK_EVENTS[e]}>{e}</span>
                  ))}
                </div>
                <div className="text-xs mt-1.5 text-slate-400">
                  {h.active ? <span className="text-emerald-300">Activo</span> : <span className="text-amber-300">{h.pausedReason ?? 'Pausado'}</span>}
                  {h.lastDeliveryAt && ` · último envío ${fmtDateTime(h.lastDeliveryAt)} (${h.lastStatus ?? 'sin respuesta'})`}
                  {h.pending > 0 && <span className="text-amber-300"> · {h.pending} en cola</span>}
                  {h.failed > 0 && <span className="text-rose-300"> · {h.failed} fallidos</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <button type="button" className={btnGhost} onClick={() => setDetail(h)}>Envíos</button>
                <button type="button" className={btnGhost} onClick={() => void toggle(h)}>
                  {h.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />} {h.active ? 'Pausar' : 'Reactivar'}
                </button>
                <button type="button" className={btnGhost} onClick={() => void rotate(h)}>
                  <KeyRound className="w-3.5 h-3.5" /> Secreto
                </button>
                <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => void remove(h)} aria-label="Eliminar webhook">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {hooks && hooks.length === 0 && <div className="p-6 text-center text-xs text-slate-400">Todavía no hay webhooks.</div>}
        </div>
      </section>

      {newKey && (
        <NewKeyDialog
          onClose={() => setNewKey(false)}
          onDone={(token) => {
            setNewKey(false);
            setShown({ title: 'Clave de API creada', label: 'Clave', value: token });
            void load();
          }}
        />
      )}
      {newHook && (
        <NewHookDialog
          onClose={() => setNewHook(false)}
          onDone={(secret) => {
            setNewHook(false);
            setShown({ title: 'Webhook creado', label: 'Secreto de firma (para verificar X-GeoCar-Signature)', value: secret });
            void load();
          }}
        />
      )}
      {shown && (
        <Dialog title={shown.title} onClose={() => setShown(null)}>
          <CopyField label={shown.label} value={shown.value} />
          <div className="flex justify-end mt-4">
            <button type="button" className={btnPrimary} onClick={() => setShown(null)}>Ya lo guardé</button>
          </div>
        </Dialog>
      )}
      {detail && <DeliveriesDialog hook={detail} notify={notify} onClose={() => { setDetail(null); void load(); }} />}
    </div>
  );
}

function NewKeyDialog({ onClose, onDone }: { onClose: () => void; onDone: (token: string) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['orders:read', 'trips:read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ token: string }>('/api/integrations/api-keys', { method: 'POST', body: JSON.stringify({ name, scopes }) });
      onDone(r.token);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear la clave.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Nueva clave de API" onClose={onClose}>
      <div className="space-y-3">
        <Field id="key-name" label="Nombre" hint="Para reconocerla: el sistema o cliente que la usa.">
          <input id="key-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ERP de Cliente SA" />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-slate-400 mb-1">Permisos</legend>
          {(Object.keys(API_SCOPES) as ApiScope[]).map((s) => (
            <label key={s} className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((all) => (e.target.checked ? [...all, s] : all.filter((x) => x !== s)))} />
              <span className="font-mono text-[11px] text-slate-400 w-28">{s}</span> {API_SCOPES[s]}
            </label>
          ))}
        </fieldset>
        {error && <div className="text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || !name.trim() || !scopes.length} onClick={() => void submit()}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Crear clave
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function NewHookDialog({ onClose, onDone }: { onClose: () => void; onDone: (secret: string) => void }) {
  const [url, setUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['order.status_changed', 'delivery.proof']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ secret: string }>('/api/integrations/webhooks', { method: 'POST', body: JSON.stringify({ url, events, description }) });
      onDone(r.secret);
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear el webhook.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Nuevo webhook" onClose={onClose}>
      <div className="space-y-3">
        <Field id="hook-url" label="URL de destino" hint="https público. Recibe un POST JSON por evento.">
          <input id="hook-url" className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field id="hook-desc" label="Descripción (opcional)">
          <input id="hook-desc" className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-slate-400 mb-1">Eventos</legend>
          {(Object.keys(WEBHOOK_EVENTS) as WebhookEvent[]).map((e) => (
            <label key={e} className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" checked={events.includes(e)} onChange={(ev) => setEvents((all) => (ev.target.checked ? [...all, e] : all.filter((x) => x !== e)))} />
              <span className="font-mono text-[11px] text-slate-400 w-40">{e}</span> {WEBHOOK_EVENTS[e]}
            </label>
          ))}
        </fieldset>
        {error && <div className="text-xs text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || url.length < 10 || !events.length} onClick={() => void submit()}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Crear webhook
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function DeliveriesDialog({ hook, notify, onClose }: { hook: HookRow; notify: Notify; onClose: () => void }) {
  const [items, setItems] = useState<WebhookDelivery[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems((await apiRequest<{ items: WebhookDelivery[] }>(`/api/integrations/webhooks/${hook.id}/deliveries`)).items);
    } catch (err) {
      notify(errMsg(err, 'No se pudieron cargar los envíos.'), 'err');
    }
  }, [hook.id, notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const ping = async () => {
    setBusy(true);
    try {
      const r = await apiRequest<{ delivery: WebhookDelivery }>(`/api/integrations/webhooks/${hook.id}/test`, { method: 'POST' });
      notify(r.delivery.status === 'entregado' ? `Prueba entregada (${r.delivery.responseStatus}).` : `La prueba falló: ${r.delivery.lastError ?? ''}`, r.delivery.status === 'entregado' ? 'ok' : 'err');
      void load();
    } catch (err) {
      notify(errMsg(err, 'No se pudo enviar la prueba.'), 'err');
    } finally {
      setBusy(false);
    }
  };
  const redeliver = async (d: WebhookDelivery) => {
    try {
      await apiRequest(`/api/integrations/deliveries/${d.id}/redeliver`, { method: 'POST' });
      notify('Reenvío en cola.');
      setTimeout(() => void load(), 800);
    } catch (err) {
      notify(errMsg(err, 'No se pudo reenviar.'), 'err');
    }
  };
  const tone = (s: WebhookDelivery['status']) => (s === 'entregado' ? 'text-emerald-300' : s === 'fallido' ? 'text-rose-300' : 'text-amber-300');
  return (
    <Dialog title="Envíos del webhook" subtitle={hook.url} onClose={onClose} wide>
      <div className="flex justify-end gap-2 mb-3">
        <button type="button" className={btnGhost} onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Actualizar
        </button>
        <button type="button" className={btnPrimary} onClick={() => void ping()} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Enviar prueba
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-800/60 border border-slate-800 rounded-lg">
        {items?.map((d) => (
          <div key={d.id} className="p-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="text-left cursor-pointer" onClick={() => setOpen(open === d.id ? null : d.id)}>
                <span className="font-mono text-slate-100">{d.event}</span>
                <span className={`ml-2 font-medium ${tone(d.status)}`}>{DELIVERY_STATUS_LABELS[d.status]}</span>
                <span className="ml-2 text-slate-400">
                  {fmtDateTime(d.createdAt)} · {d.attempts} intento(s){d.responseStatus != null ? ` · HTTP ${d.responseStatus}` : ''}
                  {d.durationMs != null ? ` · ${d.durationMs} ms` : ''}
                </span>
              </button>
              {d.status !== 'pendiente' && (
                <button type="button" className={btnGhost} onClick={() => void redeliver(d)}>Reenviar</button>
              )}
            </div>
            {d.lastError && <div className="text-rose-300 mt-1">{d.lastError}{d.nextAttemptAt && d.status === 'pendiente' ? ` · próximo intento ${fmtDateTime(d.nextAttemptAt)}` : ''}</div>}
            {open === d.id && <pre className="mt-2 p-2 rounded bg-[#0B1120] text-[11px] text-slate-300 overflow-x-auto">{JSON.stringify(JSON.parse(d.payload), null, 2)}</pre>}
          </div>
        ))}
        {items && items.length === 0 && <div className="p-6 text-center text-xs text-slate-400">Sin envíos todavía.</div>}
      </div>
    </Dialog>
  );
}
