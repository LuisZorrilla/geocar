import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Coins, DownloadCloud, Pencil, RefreshCw, X } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import {
  crossFactor,
  formatMoney,
  PIVOT_CURRENCY,
  rateAgeDays,
  rateAt,
  staleAfterDays,
  type CurrencyDef,
  type ExchangeRate,
} from '../shared/currency.ts';
import { Pagination, usePagination } from './Pagination.tsx';

interface Snapshot {
  currencies: CurrencyDef[];
  exchangeRates: ExchangeRate[];
  platformReferenceCurrency: string;
  usage: Record<string, number>;
  sources?: Array<{ id: string; currency: string; label: string; url: string }>;
}

interface Suggestion {
  sourceId: string;
  label: string;
  currency: string;
  perUsd: number | null;
  at: string | null;
  error?: string;
}

const input = 'w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 text-xs focus:outline-none focus:border-sky-500';

/** "2026-11-22T14:05" in local time for <input type="datetime-local">. */
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const fmtRate = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: n >= 100 ? 2 : 6 });
const fmtDate = (iso: string) => new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

/** Superadmin: currencies, exchange rates (pivot USD) and the currency of the consolidated view. */
export function CurrenciesView({ showToast, onChanged }: { showToast: (type: 'ok' | 'err', text: string) => void; onChanged: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<CurrencyDef>>({});
  const [rateForm, setRateForm] = useState({ currency: 'ARS', perUsd: '', effectiveAt: localNow(), source: 'manual', note: '' });
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [savingRate, setSavingRate] = useState(false);
  const [historyCode, setHistoryCode] = useState('ARS');

  const load = useCallback(async () => {
    try {
      setSnap(await apiRequest<Snapshot>('/api/currencies'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las monedas.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const applySnapshot = (s: Partial<Snapshot>) => {
    setSnap((prev) => (prev ? { ...prev, ...s } : prev));
    onChanged();
  };

  const currencies = snap?.currencies ?? [];
  const rates = snap?.exchangeRates ?? [];
  const enabled = currencies.filter((c) => c.enabled);
  const nonPivot = currencies.filter((c) => c.code !== PIVOT_CURRENCY);
  const history = useMemo(() => rates.filter((r) => r.currency === historyCode), [rates, historyCode]);
  const historyPage = usePagination(history, `${historyCode}|${history.length}`, 8);

  const saveCurrency = async (code: string) => {
    try {
      const res = await apiRequest<Snapshot>(`/api/currencies/${code}`, { method: 'PATCH', body: JSON.stringify(draft) });
      applySnapshot(res);
      setEditing(null);
      showToast('ok', `Moneda ${code} actualizada.`);
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'No se pudo guardar.');
    }
  };

  const toggleEnabled = async (c: CurrencyDef) => {
    try {
      const res = await apiRequest<Snapshot>(`/api/currencies/${c.code}`, { method: 'PATCH', body: JSON.stringify({ enabled: !c.enabled }) });
      applySnapshot(res);
      showToast('ok', `${c.code} ${c.enabled ? 'deshabilitada' : 'habilitada'}.`);
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'No se pudo cambiar.');
    }
  };

  const fetchSuggestions = async () => {
    setLoadingSuggest(true);
    setSuggestions(null);
    try {
      const res = await apiRequest<{ suggestions: Suggestion[] }>(`/api/currencies/rates/suggest?code=${encodeURIComponent(rateForm.currency)}`);
      setSuggestions(res.suggestions);
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'No se pudo consultar las fuentes.');
    } finally {
      setLoadingSuggest(false);
    }
  };

  const pickSuggestion = (s: Suggestion) => {
    if (s.perUsd === null) return;
    const at = s.at ? new Date(s.at) : new Date();
    // A source date in the future (time zones) falls back to now.
    const when = at.getTime() > Date.now() ? new Date() : at;
    when.setMinutes(when.getMinutes() - when.getTimezoneOffset());
    setRateForm((f) => ({ ...f, perUsd: String(s.perUsd), source: s.sourceId, effectiveAt: when.toISOString().slice(0, 16) }));
  };

  const saveRate = async () => {
    const perUsd = Number(rateForm.perUsd.replace(',', '.'));
    if (!(perUsd > 0)) {
      showToast('err', 'La cotización debe ser un número mayor que cero.');
      return;
    }
    setSavingRate(true);
    try {
      const res = await apiRequest<Snapshot & { rate: ExchangeRate }>(`/api/currencies/${rateForm.currency}/rates`, {
        method: 'POST',
        body: JSON.stringify({
          perUsd,
          effectiveAt: new Date(rateForm.effectiveAt).toISOString(),
          source: rateForm.source,
          note: rateForm.note || undefined,
        }),
      });
      applySnapshot(res);
      setHistoryCode(rateForm.currency);
      setRateForm((f) => ({ ...f, perUsd: '', note: '', source: 'manual', effectiveAt: localNow() }));
      setSuggestions(null);
      showToast('ok', `Cotización cargada: 1 USD = ${fmtRate(perUsd)} ${res.rate.currency}.`);
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'No se pudo cargar la cotización.');
    } finally {
      setSavingRate(false);
    }
  };

  const setPlatformCurrency = async (code: string) => {
    try {
      applySnapshot(await apiRequest<Snapshot>('/api/settings/platform-currency', { method: 'PUT', body: JSON.stringify({ currency: code }) }));
      showToast('ok', `El consolidado de todas las empresas se muestra en ${code}.`);
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'No se pudo cambiar.');
    }
  };

  if (error) return <div className="p-6 text-sm text-rose-300">{error}</div>;
  if (!snap) return <div className="p-6 text-sm text-slate-400">Cargando monedas…</div>;

  const sourcesOf = (code: string) => (snap.sources ?? []).filter((s) => s.currency === code);
  const sourceLabel = (id: string) => snap.sources?.find((s) => s.id === id)?.label ?? id;
  const selectedRate = rateForm.currency ? rateAt(rates, rateForm.currency) : null;
  const typedRate = Number(rateForm.perUsd.replace(',', '.'));
  const variation = selectedRate?.rate && typedRate > 0 ? (typedRate / selectedRate.perUsd - 1) * 100 : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#11192C] border border-slate-800/80 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <span className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <Coins className="w-5 h-5 text-amber-300" aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Monedas y tipos de cambio</h2>
            <p className="text-xs text-slate-400">
              Cada cotización es «unidades por 1 USD»; los cruces entre monedas se calculan desde ahí, así siempre son consistentes.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          Consolidado de todas las empresas en
          <select
            value={snap.platformReferenceCurrency}
            onChange={(e) => void setPlatformCurrency(e.target.value)}
            className="px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
          >
            {enabled.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Currencies */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 text-sm font-semibold text-slate-100">Monedas</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400 bg-[#0F172A]">
              <tr>
                <th className="text-left font-medium px-4 py-2">Moneda</th>
                <th className="text-left font-medium px-4 py-2">Símbolo</th>
                <th className="text-left font-medium px-4 py-2">Decimales</th>
                <th className="text-left font-medium px-4 py-2">Ejemplo</th>
                <th className="text-left font-medium px-4 py-2">Cotización vigente</th>
                <th className="text-left font-medium px-4 py-2">Fuente sugerida</th>
                <th className="text-left font-medium px-4 py-2">Empresas</th>
                <th className="text-left font-medium px-4 py-2">Estado</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-200">
              {currencies.map((c) => {
                const cur = rateAt(rates, c.code);
                const isEditing = editing === c.code;
                const age = cur?.rate ? rateAgeDays(cur.rate) : null;
                const stale = age !== null && age > staleAfterDays(c.code);
                return (
                  <tr key={c.code} className={c.enabled ? '' : 'opacity-60'}>
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <input aria-label={`Nombre de ${c.code}`} className={input} value={draft.name ?? c.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                      ) : (
                        <>
                          <div className="font-medium text-slate-100">{c.name}</div>
                          <div className="font-mono text-[11px] text-slate-500">{c.code}</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono">
                      {isEditing ? (
                        <input aria-label={`Símbolo de ${c.code}`} className={`${input} w-20`} value={draft.symbol ?? c.symbol} onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value }))} />
                      ) : (
                        c.symbol
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <select aria-label={`Decimales de ${c.code}`} className={`${input} w-16`} value={draft.decimals ?? c.decimals} onChange={(e) => setDraft((d) => ({ ...d, decimals: Number(e.target.value) }))}>
                          {[0, 1, 2, 3, 4].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      ) : (
                        c.decimals
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono whitespace-nowrap text-slate-400">
                      {formatMoney(12345.678, { ...c, symbol: draft.symbol && isEditing ? draft.symbol : c.symbol, decimals: isEditing && draft.decimals !== undefined ? draft.decimals : c.decimals })}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {c.code === PIVOT_CURRENCY ? (
                        <span className="text-slate-400">1 (base)</span>
                      ) : cur?.rate ? (
                        <>
                          <div className="font-mono">1 USD = {fmtRate(cur.perUsd)} {c.code}</div>
                          <div className={`text-[11px] ${stale ? 'text-amber-300' : 'text-slate-500'}`}>
                            {stale && <AlertTriangle className="inline w-3 h-3 mr-0.5 -mt-0.5" aria-hidden />}
                            {fmtDate(cur.rate.effectiveAt)} · {age === 0 ? 'hoy' : `hace ${age} d`}
                            {stale ? ' · desactualizada' : ''}
                          </div>
                        </>
                      ) : (
                        <span className="text-rose-300">Sin cotización</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {isEditing && sourcesOf(c.code).length > 0 ? (
                        <select aria-label={`Fuente de ${c.code}`} className={input} value={draft.suggestSource ?? c.suggestSource ?? ''} onChange={(e) => setDraft((d) => ({ ...d, suggestSource: e.target.value }))}>
                          <option value="">Ninguna</option>
                          {sourcesOf(c.code).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-400">{c.suggestSource ? sourceLabel(c.suggestSource) : '—'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{snap.usage[c.code] ?? 0}</td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => void toggleEnabled(c)}
                        disabled={c.code === PIVOT_CURRENCY}
                        title={c.code === PIVOT_CURRENCY ? 'El dólar es la base de los tipos de cambio' : c.enabled ? 'Deshabilitar' : 'Habilitar'}
                        className={`px-2 py-0.5 rounded-md border cursor-pointer disabled:cursor-default ${c.enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 text-slate-400'}`}
                      >
                        {c.enabled ? 'Habilitada' : 'Deshabilitada'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button type="button" onClick={() => void saveCurrency(c.code)} aria-label="Guardar" className="p-1.5 rounded-md hover:bg-slate-800 text-emerald-400 cursor-pointer">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => setEditing(null)} aria-label="Cancelar" className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 cursor-pointer">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(c.code);
                            setDraft({});
                          }}
                          aria-label={`Editar ${c.code}`}
                          className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Load a rate */}
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3 text-xs">
          <div className="text-sm font-semibold text-slate-100">Cargar cotización</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-slate-400 mb-1">Moneda</span>
              <select
                className={input}
                value={rateForm.currency}
                onChange={(e) => {
                  setRateForm((f) => ({ ...f, currency: e.target.value, source: 'manual' }));
                  setSuggestions(null);
                }}
              >
                {nonPivot.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-slate-400 mb-1">1 USD equivale a</span>
              <div className="flex items-center gap-1.5">
                <input
                  inputMode="decimal"
                  className={`${input} font-mono`}
                  value={rateForm.perUsd}
                  onChange={(e) => setRateForm((f) => ({ ...f, perUsd: e.target.value, source: f.source === 'manual' ? 'manual' : f.source }))}
                  placeholder={selectedRate?.rate ? fmtRate(selectedRate.perUsd) : '0'}
                />
                <span className="font-mono text-slate-400">{rateForm.currency}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-slate-400 mb-1">Vigente desde</span>
              <input type="datetime-local" className={`${input} font-mono`} value={rateForm.effectiveAt} onChange={(e) => setRateForm((f) => ({ ...f, effectiveAt: e.target.value }))} />
            </label>
            <label className="block">
              <span className="block text-slate-400 mb-1">Nota (opcional)</span>
              <input className={input} value={rateForm.note} onChange={(e) => setRateForm((f) => ({ ...f, note: e.target.value }))} placeholder="Ej.: cierre BNA" />
            </label>
          </div>
          {variation !== null && Math.abs(variation) >= 10 && (
            <p className="flex gap-1.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              Cambia {variation.toFixed(1).replace('.', ',')} % respecto de la vigente ({fmtRate(selectedRate!.perUsd)}). Revisa el valor antes de guardar.
            </p>
          )}
          <p className="text-slate-500">Fuente: {rateForm.source === 'manual' ? 'carga manual' : sourceLabel(rateForm.source)}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void fetchSuggestions()}
              disabled={loadingSuggest || sourcesOf(rateForm.currency).length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
            >
              {loadingSuggest ? <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <DownloadCloud className="w-3.5 h-3.5" aria-hidden />}
              Traer cotización sugerida
            </button>
            <button
              type="button"
              onClick={() => void saveRate()}
              disabled={savingRate || !rateForm.perUsd}
              className="px-3.5 py-1.5 rounded-lg font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white cursor-pointer"
            >
              {savingRate ? 'Guardando…' : 'Guardar cotización'}
            </button>
          </div>
          {suggestions && (
            <div className="space-y-1.5" aria-live="polite">
              <p className="text-slate-400">La sugerencia no se guarda sola: elige una y confirma con «Guardar cotización».</p>
              {suggestions.map((s) => (
                <div key={s.sourceId} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#0B1120] border border-slate-800">
                  <div className="min-w-0">
                    <div className="text-slate-200 truncate">{s.label}</div>
                    <div className="text-[11px] text-slate-500">
                      {s.perUsd !== null ? `1 USD = ${fmtRate(s.perUsd)} ${s.currency}${s.at ? ` · ${fmtDate(s.at)}` : ''}` : s.error}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => pickSuggestion(s)}
                    disabled={s.perUsd === null}
                    className="px-2.5 py-1 rounded-md border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 disabled:opacity-40 cursor-pointer shrink-0"
                  >
                    Usar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cross rates */}
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3 text-xs">
          <div>
            <div className="text-sm font-semibold text-slate-100">Tipos de cambio cruzados (vigentes)</div>
            <p className="text-slate-400">Cuánto vale 1 unidad de la fila en la moneda de la columna.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full font-mono tabular-nums">
              <thead>
                <tr className="text-slate-400">
                  <th className="text-left font-medium p-1.5">1 ↓ =</th>
                  {enabled.map((c) => (
                    <th key={c.code} className="text-right font-medium p-1.5">
                      {c.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {enabled.map((row) => (
                  <tr key={row.code}>
                    <th className="text-left font-medium p-1.5 text-slate-300">{row.code}</th>
                    {enabled.map((col) => {
                      const f = crossFactor(rates, row.code, col.code);
                      return (
                        <td key={col.code} className={`text-right p-1.5 ${row.code === col.code ? 'text-slate-600' : f ? 'text-slate-200' : 'text-rose-300'}`}>
                          {row.code === col.code ? '1' : f ? Number(f.factor.toPrecision(6)).toLocaleString('es-AR', { maximumFractionDigits: 6 }) : 'sin TC'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* History */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold text-slate-100">Historial de cotizaciones</div>
          <div role="tablist" className="flex gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800">
            {nonPivot.map((c) => (
              <button
                key={c.code}
                type="button"
                role="tab"
                aria-selected={historyCode === c.code}
                onClick={() => setHistoryCode(c.code)}
                className={`px-3 py-1 rounded-md font-medium cursor-pointer ${historyCode === c.code ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {c.code}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full">
          <thead className="text-slate-400 bg-[#0F172A]">
            <tr>
              <th className="text-left font-medium px-4 py-2">Vigente desde</th>
              <th className="text-right font-medium px-4 py-2">1 USD =</th>
              <th className="text-left font-medium px-4 py-2">Fuente</th>
              <th className="text-left font-medium px-4 py-2">Cargó</th>
              <th className="text-left font-medium px-4 py-2">Nota</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 text-slate-200">
            {historyPage.pagedItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Sin cotizaciones de {historyCode} en el último año.
                </td>
              </tr>
            ) : (
              historyPage.pagedItems.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-mono whitespace-nowrap">{fmtDate(r.effectiveAt)}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {fmtRate(r.perUsd)} {r.currency}
                  </td>
                  <td className="px-4 py-2 text-slate-400">{r.source === 'manual' ? 'Manual' : sourceLabel(r.source)}</td>
                  <td className="px-4 py-2 text-slate-400">{r.createdBy}</td>
                  <td className="px-4 py-2 text-slate-400">{r.note ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={historyPage.page} totalItems={historyPage.totalItems} pageSize={8} onPageChange={historyPage.setPage} />
      </div>
    </div>
  );
}
