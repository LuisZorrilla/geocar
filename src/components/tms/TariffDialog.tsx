import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { DEFAULT_PRIORITY, parseAmount, TARIFF_RULE_LABELS, type Tariff, type TariffRule, type TariffRuleKind } from '../../shared/costs.ts';
import type { Customer, Place } from '../../shared/tms.ts';
import { apiRequest } from '../../lib/api.ts';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, inputCls } from './ui.tsx';

type RuleDraft = Omit<TariffRule, 'id' | 'price' | 'minimum'> & { id?: string; price: string; minimum: string };

const num = (v: string) => (v.trim() === '' ? undefined : (parseAmount(v) ?? NaN));
const show = (n?: number) => (n === undefined ? '' : String(n));

/**
 * Price list of a customer: rules (fixed per route, per km, per tonne, per pallet) tried in the
 * priority order, plus extras (waiting, dangerous/refrigerated surcharges, tolls).
 */
export function TariffDialog({ customer, places, onClose, onSaved }: { customer: Customer; places: Place[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<Tariff | null>(null);
  const [name, setName] = useState(`Tarifario · ${customer.name}`);
  const [priority, setPriority] = useState<TariffRuleKind[]>([...DEFAULT_PRIORITY]);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [waitingPerHour, setWaitingPerHour] = useState('');
  const [waitingFree, setWaitingFree] = useState('60');
  const [dangerousPct, setDangerousPct] = useState('');
  const [refrigeratedPct, setRefrigeratedPct] = useState('');
  const [tolls, setTolls] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ items: Tariff[] }>(`/api/costs/tariffs?customerId=${encodeURIComponent(customer.id)}`)
      .then((r) => {
        const t = r.items.find((x) => x.active) ?? r.items[0];
        if (t) {
          setExisting(t);
          setName(t.name);
          setPriority(t.priority.length ? t.priority : [...DEFAULT_PRIORITY]);
          setRules(t.rules.map((x) => ({ ...x, price: show(x.price), minimum: show(x.minimum) })));
          setWaitingPerHour(show(t.extras.waitingPerHour));
          setWaitingFree(show(t.extras.waitingFreeMinutes ?? 60));
          setDangerousPct(show(t.extras.dangerousPct));
          setRefrigeratedPct(show(t.extras.refrigeratedPct));
          setTolls(Boolean(t.extras.tollsPassThrough));
        }
      })
      .catch((err) => setError(errMsg(err, 'No se pudo cargar el tarifario.')))
      .finally(() => setLoading(false));
  }, [customer.id]);

  const placeName = (id?: string) => places.find((p) => p.id === id)?.name ?? '—';
  const update = (i: number, patch: Partial<RuleDraft>) => setRules((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (kind: TariffRuleKind) => setRules((all) => [...all, { kind, price: '', minimum: '', originPlaceId: kind === 'tramo' ? places[0]?.id : undefined, destinationPlaceId: kind === 'tramo' ? places[1]?.id : undefined, bothWays: true }]);
  const move = (i: number, dir: -1 | 1) =>
    setPriority((p) => {
      const n = [...p];
      [n[i], n[i + dir]] = [n[i + dir], n[i]];
      return n;
    });

  const save = async () => {
    setError(null);
    const body = {
      customerId: customer.id,
      name,
      active: true,
      priority,
      rules: rules.map((r) => ({
        id: r.id,
        kind: r.kind,
        originPlaceId: r.kind === 'tramo' ? r.originPlaceId : undefined,
        destinationPlaceId: r.kind === 'tramo' ? r.destinationPlaceId : undefined,
        bothWays: r.kind === 'tramo' ? Boolean(r.bothWays) : undefined,
        price: num(r.price) ?? 0,
        minimum: r.kind === 'tramo' ? undefined : num(r.minimum),
      })),
      extras: {
        waitingPerHour: num(waitingPerHour),
        waitingFreeMinutes: num(waitingFree),
        dangerousPct: num(dangerousPct),
        refrigeratedPct: num(refrigeratedPct),
        tollsPassThrough: tolls,
      },
    };
    if (body.rules.some((r) => !(r.price > 0))) return setError('Cada regla necesita un precio mayor que 0.');
    setSaving(true);
    try {
      if (existing) await apiRequest(`/api/costs/tariffs/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiRequest('/api/costs/tariffs', { method: 'POST', body: JSON.stringify(body) });
      onSaved(`Tarifario de ${customer.name} guardado. Los pedidos que se entreguen desde ahora se cotizan con él.`);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar.'));
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Tarifario · ${customer.name}`} subtitle="Cómo se calcula el flete de sus pedidos (se aplica al entregarlos)" onClose={onClose} wide>
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando…</div>
      ) : (
        <div className="space-y-4">
          {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
          <Field id="tar-name" label="Nombre del tarifario">
            <input id="tar-name" className={inputCls} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reglas de precio</h3>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(TARIFF_RULE_LABELS) as TariffRuleKind[]).map((k) => (
                  <button key={k} type="button" className={btnGhost} onClick={() => add(k)}>
                    <Plus className="w-3 h-3" /> {TARIFF_RULE_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
            {rules.length === 0 && <p className="text-slate-500">Sin reglas: agregá al menos una.</p>}
            <ul className="space-y-2">
              {rules.map((r, i) => (
                <li key={r.id ?? `new-${i}`} className="rounded-lg border border-slate-800 bg-[#11192C] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-slate-200">{TARIFF_RULE_LABELS[r.kind]}</span>
                    <button type="button" aria-label="Quitar regla" onClick={() => setRules((all) => all.filter((_, j) => j !== i))} className="p-1 rounded text-slate-400 hover:text-rose-300 cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
                    {r.kind === 'tramo' ? (
                      <>
                        <Field label="Origen">
                          <select aria-label="Origen del tramo" className={inputCls} value={r.originPlaceId} onChange={(e) => update(i, { originPlaceId: e.target.value })}>
                            {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </Field>
                        <Field label="Destino">
                          <select aria-label="Destino del tramo" className={inputCls} value={r.destinationPlaceId} onChange={(e) => update(i, { destinationPlaceId: e.target.value })}>
                            {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </Field>
                        <Field label="Precio por pedido">
                          <input aria-label="Precio del tramo" inputMode="decimal" className={`${inputCls} font-mono`} value={r.price} onChange={(e) => update(i, { price: e.target.value })} />
                        </Field>
                        <label className="inline-flex items-center gap-2 pb-2 text-slate-300 cursor-pointer">
                          <input type="checkbox" checked={Boolean(r.bothWays)} onChange={(e) => update(i, { bothWays: e.target.checked })} /> Ida y vuelta
                        </label>
                      </>
                    ) : (
                      <>
                        <Field label={r.kind === 'km' ? 'Precio por km' : r.kind === 'tonelada' ? 'Precio por tonelada' : 'Precio por pallet'}>
                          <input aria-label={`Precio ${TARIFF_RULE_LABELS[r.kind]}`} inputMode="decimal" className={`${inputCls} font-mono`} value={r.price} onChange={(e) => update(i, { price: e.target.value })} />
                        </Field>
                        <Field label="Mínimo por pedido (opcional)">
                          <input aria-label={`Mínimo ${TARIFF_RULE_LABELS[r.kind]}`} inputMode="decimal" className={`${inputCls} font-mono`} value={r.minimum} onChange={(e) => update(i, { minimum: e.target.value })} />
                        </Field>
                      </>
                    )}
                  </div>
                  {r.kind === 'tramo' && r.originPlaceId === r.destinationPlaceId && <p className="mt-1 text-amber-300">Origen y destino deben ser distintos ({placeName(r.originPlaceId)}).</p>}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Orden de aplicación</h3>
            <p className="text-slate-500 mb-2">Para cada pedido se usa la primera modalidad que aplique (por ejemplo, el precio del tramo si existe; si no, por pallet…).</p>
            <ol className="flex flex-wrap gap-2">
              {priority.map((k, i) => (
                <li key={k} className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0B1120] px-2 py-1">
                  <span className="text-slate-500">{i + 1}.</span> <span className="text-slate-200">{TARIFF_RULE_LABELS[k]}</span>
                  <button type="button" disabled={i === 0} aria-label={`Subir ${TARIFF_RULE_LABELS[k]}`} onClick={() => move(i, -1)} className="p-0.5 text-slate-400 disabled:opacity-30 cursor-pointer"><ArrowUp className="w-3 h-3" /></button>
                  <button type="button" disabled={i === priority.length - 1} aria-label={`Bajar ${TARIFF_RULE_LABELS[k]}`} onClick={() => move(i, 1)} className="p-0.5 text-slate-400 disabled:opacity-30 cursor-pointer"><ArrowDown className="w-3 h-3" /></button>
                </li>
              ))}
            </ol>
          </section>

          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <h3 className="col-span-2 md:col-span-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Adicionales</h3>
            <Field id="tar-wait" label="Estadía por hora">
              <input id="tar-wait" inputMode="decimal" className={`${inputCls} font-mono`} value={waitingPerHour} onChange={(e) => setWaitingPerHour(e.target.value)} />
            </Field>
            <Field id="tar-free" label="Minutos sin cargo por parada">
              <input id="tar-free" inputMode="numeric" className={`${inputCls} font-mono`} value={waitingFree} onChange={(e) => setWaitingFree(e.target.value)} />
            </Field>
            <Field id="tar-dg" label="Recargo carga peligrosa (%)">
              <input id="tar-dg" inputMode="decimal" className={`${inputCls} font-mono`} value={dangerousPct} onChange={(e) => setDangerousPct(e.target.value)} />
            </Field>
            <Field id="tar-cold" label="Recargo frío (%)">
              <input id="tar-cold" inputMode="decimal" className={`${inputCls} font-mono`} value={refrigeratedPct} onChange={(e) => setRefrigeratedPct(e.target.value)} />
            </Field>
            <label className="col-span-2 md:col-span-4 inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input type="checkbox" checked={tolls} onChange={(e) => setTolls(e.target.checked)} /> Trasladar los peajes del viaje al cliente (se reparten entre los pedidos del viaje)
            </label>
          </section>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
            <button type="button" className={btnPrimary} disabled={saving || rules.length === 0} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar tarifario'}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
