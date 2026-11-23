import { useState } from 'react';
import { CheckCircle2, ClipboardCheck, MinusCircle, ShieldCheck, X, XCircle } from 'lucide-react';
import type { ChecklistReviewDecision, PreOpChecklist } from '../shared/types.ts';
import { ASSET_TYPE_LABELS, CHECKLIST_RESULT_META } from '../lib/api.ts';
import { CHECKLIST_DECISION_LABELS, checklistHasFailures, type ReviewChecklistHandler } from '../shared/checklist.ts';

const DECISION_STYLE: Record<ChecklistReviewDecision, string> = {
  apto: 'text-emerald-400',
  apto_con_restriccion: 'text-amber-400',
  no_apto: 'text-rose-400',
};

export const decisionClass = (d: ChecklistReviewDecision) => DECISION_STYLE[d];

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Detail of a pre-op checklist and its supervisor review. The inspection (items, result) is
 * read-only: it's the evidence. The review is added on top and can be corrected (audited).
 */
export function ChecklistDetailDialog({
  checklist,
  canReview,
  onReview,
  onClose,
  onOpenOrder,
  onOpenDossier,
}: {
  checklist: PreOpChecklist;
  canReview: boolean;
  onReview: ReviewChecklistHandler;
  onClose: () => void;
  onOpenOrder: (workOrderId: string) => void;
  onOpenDossier: (vehicleId: string) => void;
}) {
  const hasFailures = checklistHasFailures(checklist);
  const resMeta = CHECKLIST_RESULT_META[checklist.result];
  const [editing, setEditing] = useState(!checklist.review && canReview);
  const [decision, setDecision] = useState<ChecklistReviewDecision>(
    checklist.review?.decision ?? (checklist.result === 'reprobado' ? 'no_apto' : hasFailures ? 'apto_con_restriccion' : 'apto')
  );
  const [note, setNote] = useState(checklist.review?.note ?? '');
  const canCreateOrder = hasFailures && !checklist.linkedWorkOrderId;
  const [createOrder, setCreateOrder] = useState(canCreateOrder && checklist.result === 'reprobado');
  const [saving, setSaving] = useState(false);
  const noteRequired = decision !== 'apto';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (noteRequired && !note.trim()) return;
    setSaving(true);
    const ok = await onReview(checklist.id, { decision, note: note.trim(), createWorkOrder: canCreateOrder && createOrder });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="chk-detail-title">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-700 bg-[#0F172A] text-xs text-slate-300 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <h2 id="chk-detail-title" className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <ClipboardCheck className="h-4 w-4 text-sky-400" /> Checklist pre-operativo <span className="font-mono">{checklist.id}</span>
            </h2>
            <p className="mt-1 text-slate-400">
              <button type="button" className="text-sky-400 hover:underline cursor-pointer" onClick={() => onOpenDossier(checklist.vehicleId)}>
                {checklist.unitCode}
              </button>{' '}
              · {ASSET_TYPE_LABELS[checklist.assetType]} · Turno {checklist.shift} · {fmtDateTime(checklist.submittedAt)}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded p-1 text-slate-400 hover:bg-slate-800 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <div className="text-slate-500">Operador que inspeccionó</div>
              <div className="text-slate-100">{checklist.driverName}</div>
            </div>
            <div>
              <div className="text-slate-500">Resultado</div>
              <div className={`font-semibold ${resMeta.colorClass}`}>{resMeta.label}</div>
            </div>
            <div>
              <div className="text-slate-500">Horómetro</div>
              <div className="font-mono text-slate-100">{checklist.engineHours} h</div>
            </div>
            <div>
              <div className="text-slate-500">Odómetro</div>
              <div className="font-mono text-slate-100">{checklist.odometerKm.toLocaleString('es-AR')} km</div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 font-medium text-slate-200">Puntos de control ({checklist.items.length})</div>
            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
              {checklist.items.map((it) => (
                <li key={it.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div>
                    <div className={it.status === 'falla' ? 'text-rose-200' : 'text-slate-200'}>{it.label}</div>
                    {it.note && <div className="mt-0.5 text-slate-400">{it.note}</div>}
                  </div>
                  {it.status === 'ok' ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> OK</span>
                  ) : it.status === 'falla' ? (
                    <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-rose-400"><XCircle className="h-3.5 w-3.5" /> Falla</span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-slate-500"><MinusCircle className="h-3.5 w-3.5" /> N/A</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-slate-500">Nota de la inspección</div>
            <div className="text-slate-200">{checklist.summaryNote || '—'}</div>
          </div>

          <div>
            <div className="text-slate-500">Orden de trabajo vinculada</div>
            {checklist.linkedWorkOrderId ? (
              <button type="button" className="font-mono text-sky-400 hover:underline cursor-pointer" onClick={() => onOpenOrder(checklist.linkedWorkOrderId!)}>
                {checklist.linkedWorkOrderId}
              </button>
            ) : (
              <div className="text-slate-400">{hasFailures ? 'Ninguna: las fallas no generaron una OT.' : 'No corresponde (sin fallas).'}</div>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-[#11192C] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium text-slate-200">
                <ShieldCheck className="h-4 w-4 text-sky-400" /> Revisión del supervisor
              </div>
              {checklist.review && canReview && !editing && (
                <button type="button" className="text-sky-400 hover:underline cursor-pointer" onClick={() => setEditing(true)}>
                  Corregir revisión
                </button>
              )}
            </div>

            {checklist.review && !editing && (
              <div className="space-y-1">
                <div className={`font-semibold ${decisionClass(checklist.review.decision)}`}>{CHECKLIST_DECISION_LABELS[checklist.review.decision]}</div>
                {checklist.review.note && <div className="text-slate-200">{checklist.review.note}</div>}
                <div className="text-slate-500">
                  {checklist.review.reviewedBy} · {fmtDateTime(checklist.review.reviewedAt)}
                </div>
              </div>
            )}

            {!checklist.review && !editing && (
              <div className="text-slate-400">
                {hasFailures ? 'Sin revisar.' : 'Sin revisar (no es obligatoria: la inspección no tuvo fallas).'} {!canReview && 'Tu perfil no puede revisarla.'}
              </div>
            )}

            {editing && (
              <form onSubmit={submit} className="space-y-3">
                <fieldset>
                  <legend className="mb-1 text-slate-400">Decisión</legend>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(CHECKLIST_DECISION_LABELS) as ChecklistReviewDecision[]).map((d) => (
                      <label
                        key={d}
                        className={`cursor-pointer rounded-lg border px-3 py-1.5 ${
                          decision === d ? 'border-sky-500 bg-sky-500/10 text-slate-100' : 'border-slate-800 text-slate-400'
                        }`}
                      >
                        <input type="radio" name="chk-decision" className="sr-only" checked={decision === d} onChange={() => setDecision(d)} />
                        <span className={decision === d ? decisionClass(d) : ''}>{CHECKLIST_DECISION_LABELS[d]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div>
                  <label htmlFor="chk-review-note" className="mb-1 block text-slate-400">
                    {noteRequired ? 'Restricción o motivo (obligatorio)' : 'Nota (opcional)'}
                  </label>
                  <textarea
                    id="chk-review-note"
                    rows={2}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={decision === 'apto_con_restriccion' ? 'Ej.: solo traslados urbanos hasta reparar luces.' : decision === 'no_apto' ? 'Ej.: fuga de aceite hidráulico, no operar.' : ''}
                    className="w-full rounded-lg border border-slate-800 bg-[#0B1120] px-3 py-2 text-slate-100"
                  />
                  {noteRequired && !note.trim() && <p className="mt-1 text-amber-300">Explicá la restricción o por qué la unidad no está apta.</p>}
                </div>
                {canCreateOrder && (
                  <label className="inline-flex cursor-pointer items-center gap-2 text-slate-300">
                    <input type="checkbox" checked={createOrder} onChange={(e) => setCreateOrder(e.target.checked)} />
                    Generar ahora la orden correctiva por las fallas
                  </label>
                )}
                <div className="flex justify-end gap-2">
                  {checklist.review && (
                    <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 cursor-pointer">
                      Cancelar
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={saving || (noteRequired && !note.trim())}
                    className="rounded-lg bg-sky-600 px-4 py-1.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50 cursor-pointer"
                  >
                    {saving ? 'Guardando…' : checklist.review ? 'Guardar corrección' : 'Guardar revisión'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
