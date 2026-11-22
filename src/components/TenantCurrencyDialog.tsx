import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Coins, X } from 'lucide-react';
import type { TenantSummary } from '../shared/types.ts';
import { apiRequest } from '../lib/api.ts';
import { useMoney } from '../lib/money.tsx';

interface Preview {
  from: string | null;
  to: string;
  mode: 'definir' | 'convertir';
  factor: number | null;
  rateDate: string | null;
  missingRate: boolean;
  documents: { workOrders: number; maintenanceRecords: number; preventivePlans: number; partsInventory: number };
  totals: { before: number; after: number | null };
}

interface Change {
  id: string;
  from: string | null;
  to: string;
  mode: 'definir' | 'convertir' | 'rotulo';
  factor: number | null;
  documents: number;
  actorName: string;
  at: string;
}

const MODE_LABEL: Record<Change['mode'], string> = { definir: 'Definida', convertir: 'Convertida', rotulo: 'Solo rótulo' };

/**
 * Defines or changes a company's currency (superadmin). The first time the amounts are kept
 * (they were loaded in that currency); afterwards the superadmin chooses between converting
 * every amount with the current rate or only relabelling.
 */
export function TenantCurrencyDialog({
  tenant,
  initialTo,
  onClose,
  onDone,
}: {
  tenant: TenantSummary;
  /** Currency preselected (chosen in the edit form). */
  initialTo?: string;
  onClose: () => void;
  onDone: (tenants: TenantSummary[], message: string) => void;
}) {
  const money = useMoney();
  const current = tenant.currency ?? null;
  const [to, setTo] = useState(() => initialTo ?? (current ? money.enabled.find((c) => c.code !== current)?.code : 'ARS') ?? 'ARS');
  const [mode, setMode] = useState<'convertir' | 'rotulo'>('convertir');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    apiRequest<{ preview: Preview; changes: Change[] }>(`/api/tenants/${tenant.id}/currency/preview?to=${encodeURIComponent(to)}`)
      .then((r) => {
        if (!alive) return;
        setPreview(r.preview);
        setChanges(r.changes);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'No se pudo calcular la vista previa.'));
    return () => {
      alive = false;
    };
  }, [tenant.id, to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const docs = preview ? Object.values(preview.documents).reduce((a, b) => a + b, 0) : 0;
  const blocked = Boolean(preview && preview.mode === 'convertir' && mode === 'convertir' && preview.missingRate);
  const same = to === current;

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest<{ tenants: TenantSummary[]; change: Change }>(`/api/tenants/${tenant.id}/currency`, {
        method: 'PUT',
        body: JSON.stringify({ currency: to, mode }),
      });
      const msg =
        res.change.mode === 'definir'
          ? `${tenant.name}: moneda definida en ${to}.`
          : res.change.mode === 'convertir'
            ? `${tenant.name}: ${res.change.documents} documentos convertidos a ${to}.`
            : `${tenant.name}: ahora se muestra en ${to} (importes sin convertir).`;
      onDone(res.tenants, msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la moneda.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tc-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#0F172A] border border-slate-800 rounded-2xl p-5 space-y-4 text-xs text-slate-300"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="tc-title" className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Coins className="w-4 h-4 text-amber-300" aria-hidden /> Moneda de {tenant.name}
            </h3>
            <p className="text-slate-400 mt-0.5">
              Actual: <b className="text-slate-200">{current ? `${money.find(current)?.name ?? current} (${current})` : 'sin moneda definida'}</b>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="p-1 rounded hover:bg-slate-800 text-slate-400 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block">
          <span className="block text-slate-400 mb-1">{current ? 'Nueva moneda' : 'Moneda de la empresa'}</span>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
          >
            {money.enabled.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code}){c.code === current ? ' · actual' : ''}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p role="alert" className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200">
            {error}
          </p>
        )}

        {same ? (
          <p className="text-slate-400">La empresa ya usa {to}.</p>
        ) : !preview ? (
          !error && <p className="text-slate-500">Calculando…</p>
        ) : preview.mode === 'definir' ? (
          <p className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-100">
            Primera definición: los {docs} documentos existentes <b>conservan sus importes</b> y pasan a mostrarse en {to}.
          </p>
        ) : (
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="sr-only">Qué hacer con los importes</legend>
              <label className={`flex gap-2 p-2.5 rounded-lg border cursor-pointer ${mode === 'convertir' ? 'border-sky-500 bg-sky-600/10' : 'border-slate-800'}`}>
                <input type="radio" name="tc-mode" checked={mode === 'convertir'} onChange={() => setMode('convertir')} />
                <span>
                  <b className="text-slate-100">Convertir importes</b> con el tipo de cambio vigente
                  {preview.factor !== null && (
                    <span className="block text-slate-400 font-mono mt-0.5">
                      1 {preview.from} = {Number(preview.factor.toPrecision(6))} {to}
                      {preview.rateDate ? ` · TC del ${new Date(preview.rateDate).toLocaleDateString('es-AR')}` : ''}
                    </span>
                  )}
                </span>
              </label>
              <label className={`flex gap-2 p-2.5 rounded-lg border cursor-pointer ${mode === 'rotulo' ? 'border-amber-500 bg-amber-600/10' : 'border-slate-800'}`}>
                <input type="radio" name="tc-mode" checked={mode === 'rotulo'} onChange={() => setMode('rotulo')} />
                <span>
                  <b className="text-slate-100">Solo cambiar el rótulo</b>
                  <span className="block text-slate-400 mt-0.5">Los números quedan iguales: úsalo solo si se cargaron en {to} por error.</span>
                </span>
              </label>
            </fieldset>

            {mode === 'convertir' &&
              (preview.missingRate ? (
                <p className="flex gap-1.5 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden /> Falta la cotización de {preview.from} o de {to}. Cárgala en «Monedas» antes de convertir.
                </p>
              ) : (
                <div className="p-2.5 rounded-lg bg-[#0B1120] border border-slate-800 space-y-1">
                  <div className="flex items-center gap-2 font-mono text-sm">
                    <span>{money.fmtIn(preview.totals.before, preview.from)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" aria-hidden />
                    <span className="text-emerald-300">{money.fmtIn(preview.totals.after ?? 0, to)}</span>
                  </div>
                  <p className="text-slate-400">
                    {preview.documents.workOrders} órdenes · {preview.documents.maintenanceRecords} mantenimientos · {preview.documents.preventivePlans} planes ·{' '}
                    {preview.documents.partsInventory} artículos de almacén.
                  </p>
                  <p className="text-amber-200">No se deshace sola: para volver, se convierte de nuevo con el tipo de cambio inverso.</p>
                </div>
              ))}
          </div>
        )}

        {changes.length > 0 && (
          <details className="text-slate-400">
            <summary className="cursor-pointer">Historial de cambios de moneda ({changes.length})</summary>
            <ul className="mt-2 space-y-1">
              {changes.map((c) => (
                <li key={c.id} className="font-mono text-[11px]">
                  {new Date(c.at).toLocaleString('es-AR')} · {c.from ?? '—'} → {c.to} · {MODE_LABEL[c.mode]}
                  {c.factor !== null ? ` · ×${Number(c.factor.toPrecision(6))}` : ''} · {c.actorName}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer">
            Cancelar
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={saving || same || !preview || blocked}
            className="px-3.5 py-1.5 rounded-lg font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white cursor-pointer"
          >
            {saving ? 'Aplicando…' : preview?.mode === 'definir' ? 'Definir moneda' : mode === 'convertir' ? 'Convertir y cambiar' : 'Cambiar rótulo'}
          </button>
        </div>
      </div>
    </div>
  );
}
