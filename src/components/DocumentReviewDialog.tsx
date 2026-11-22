import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, FileText, Loader2, ShieldCheck, ShieldX, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { DriverListItem } from '../shared/types.ts';
import { apiRequest, fetchBlobWithAuth, openWithAuth, uploadWithAuth } from '../lib/api.ts';
import { formatCuit } from '../shared/cuit.ts';
import {
  DOC_TYPES,
  DRIVER_FILE_MAX_BYTES,
  DRIVER_FILE_TYPES,
  formatDateAr,
  OPTIONAL_DOCS,
  REJECTION_REASONS,
  requiredDocs,
  verificationStatus,
  type DriverDocType,
  type DriverDocument,
} from '../shared/drivers.ts';
import { AuthBadge } from './DriverBadges.tsx';

interface Props {
  driver: DriverListItem;
  /** Document to open first; defaults to the first pending one. */
  initialType?: DriverDocType;
  onClose: () => void;
  /** Called after each server-confirmed change. */
  onChanged: (driver: DriverListItem, message: string) => void;
}

const STATUS_UI = {
  pendiente: { text: 'Pendiente', cls: 'text-sky-300' },
  verificado: { text: 'Verificado', cls: 'text-emerald-300' },
  rechazado: { text: 'Rechazado', cls: 'text-rose-300' },
} as const;

/** Checks the reviewer confirms before a document can be marked as verified. */
function checklistFor(type: DriverDocType, doc: DriverDocument): string[] {
  const meta = DOC_TYPES[type];
  const items = ['El nombre y el DNI del documento son los del chofer'];
  if (doc.number) items.push(`El número coincide: ${doc.number}`);
  if (type === 'licencia') items.push('Las clases de licencia coinciden con las cargadas');
  if (meta.hasExpiry && doc.expiresAt) items.push(`El vencimiento coincide: ${formatDateAr(doc.expiresAt)}`);
  items.push('El documento es legible, original y está vigente');
  return items;
}

/** Side-by-side review: the attached file on the left, the loaded data and the decision on the right. */
export function DocumentReviewDialog({ driver: initialDriver, initialType, onClose, onChanged }: Props) {
  const [driver, setDriver] = useState(initialDriver);
  const required = useMemo(() => requiredDocs(driver.profile ?? 'liviano', Boolean(driver.dangerousGoods)), [driver.profile, driver.dangerousGoods]);
  const docs = useMemo(() => {
    const list = driver.documents ?? [];
    const order = [...required, ...OPTIONAL_DOCS];
    return [...list].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  }, [driver.documents, required]);
  const firstPending = docs.find((d) => verificationStatus(d) === 'pendiente' && required.includes(d.type))?.type;
  const [type, setType] = useState<DriverDocType | undefined>(initialType ?? firstPending ?? docs[0]?.type);
  const doc = docs.find((d) => d.type === type);
  const meta = type ? DOC_TYPES[type] : undefined;

  const [preview, setPreview] = useState<{ url: string; mime: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [checks, setChecks] = useState<boolean[]>([]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const items = doc && type ? checklistFor(type, doc) : [];
  const allChecked = items.length > 0 && checks.length === items.length && checks.every(Boolean);
  const pendingCount = docs.filter((d) => required.includes(d.type) && verificationStatus(d) === 'pendiente').length;

  // Reset the form when switching documents.
  useEffect(() => {
    setChecks(items.map(() => false));
    setRejecting(false);
    setReason('');
    setNote('');
    setError(null);
    setZoom(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, doc?.file?.id]);

  // Load the attached file into a local object URL (the session never goes into a URL).
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!doc?.file || !type) return;
    let url = '';
    let cancelled = false;
    setLoadingPreview(true);
    fetchBlobWithAuth(`/api/drivers/${driver.id}/documents/${type}/file`)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview({ url, mime: blob.type || doc.file!.mime });
      })
      .catch((err) => !cancelled && setPreviewError(err instanceof Error ? err.message : 'No se pudo cargar el archivo.'))
      .finally(() => !cancelled && setLoadingPreview(false));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [driver.id, type, doc?.file?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const goNextPending = (d: DriverListItem, current?: DriverDocType) => {
    const list = d.documents ?? [];
    const next = [...required, ...OPTIONAL_DOCS].find(
      (t) => t !== current && required.includes(t) && list.some((x) => x.type === t && verificationStatus(x) === 'pendiente')
    );
    if (next) setType(next);
  };

  const decide = async (decision: 'verificado' | 'rechazado') => {
    if (!type || !meta) return;
    if (decision === 'rechazado' && (!reason || (reason === 'Otro' && !note.trim()))) {
      setError(!reason ? 'Elige el motivo del rechazo.' : 'Describe el motivo.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fullReason = reason === 'Otro' ? note.trim() : [reason, note.trim()].filter(Boolean).join(' · ');
      const res = await apiRequest<{ driver: DriverListItem }>(`/api/drivers/${driver.id}/documents/${type}/verify`, {
        method: 'POST',
        body: JSON.stringify({ decision, ...(decision === 'rechazado' ? { reason: fullReason } : {}) }),
      });
      setDriver(res.driver);
      onChanged(res.driver, `${meta.label} de ${res.driver.name} ${decision === 'verificado' ? 'verificado' : 'rechazado'}`);
      goNextPending(res.driver, type);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la revisión.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    if (!type) return;
    if (!DRIVER_FILE_TYPES[file.type]) return setError('Formato no admitido: elige un PDF, JPG o PNG.');
    if (file.size > DRIVER_FILE_MAX_BYTES) return setError('El archivo supera los 5 MB.');
    setBusy(true);
    setError(null);
    try {
      const res = await uploadWithAuth<{ driver: DriverListItem }>(`/api/drivers/${driver.id}/documents/${type}/file`, file);
      setDriver(res.driver);
      onChanged(res.driver, `Archivo adjuntado a ${DOC_TYPES[type].label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
    } finally {
      setBusy(false);
    }
  };

  const status = doc ? verificationStatus(doc) : 'pendiente';

  return (
    <div className="fixed inset-0 z-[55] bg-black/70 flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="rv-title">
      <div className="w-full sm:max-w-6xl bg-[#0F172A] border border-slate-800 sm:rounded-2xl flex flex-col max-h-screen sm:max-h-[94vh]">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rv-title" className="text-base font-semibold text-slate-100 truncate">
              Verificar documentos de {driver.name}
            </h2>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>
                DNI {driver.dni} · CUIL {driver.cuil ? formatCuit(driver.cuil) : '—'}
              </span>
              <AuthBadge state={driver.authorization.state} />
              {pendingCount > 0 && <span>{pendingCount} por verificar</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Document tabs */}
        <div className="px-5 py-2 border-b border-slate-800 flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Documentos">
          {docs.map((d) => {
            const st = verificationStatus(d);
            const sel = d.type === type;
            return (
              <button
                key={d.type}
                type="button"
                role="tab"
                aria-selected={sel}
                onClick={() => setType(d.type)}
                className={`shrink-0 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer ${sel ? 'border-sky-500 bg-sky-500/10 text-slate-100' : 'border-slate-800 text-slate-300 hover:border-slate-600'}`}
              >
                {DOC_TYPES[d.type].short}
                {!required.includes(d.type) && <span className="text-slate-500"> (opc.)</span>}
                <span className={`block text-[10px] ${STATUS_UI[st].cls}`}>{STATUS_UI[st].text}</span>
              </button>
            );
          })}
        </div>

        {!doc || !type || !meta ? (
          <div className="p-10 text-center text-sm text-slate-400">Este chofer no tiene documentos cargados. Complétalos con «Editar».</div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_22rem]">
            {/* Preview */}
            <div className="min-h-[18rem] bg-[#0B1120] border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col">
              <div className="px-3 py-2 flex items-center justify-between gap-2 text-xs text-slate-400 border-b border-slate-800">
                <span className="truncate">{doc.file ? doc.file.name : 'Sin archivo adjunto'}</span>
                {doc.file && (
                  <div className="flex items-center gap-1">
                    {preview?.mime.startsWith('image/') && (
                      <>
                        <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="p-1 rounded hover:bg-slate-800 cursor-pointer" aria-label="Alejar">
                          <ZoomOut className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="p-1 rounded hover:bg-slate-800 cursor-pointer" aria-label="Acercar">
                          <ZoomIn className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => openWithAuth(`/api/drivers/${driver.id}/documents/${type}/file`).catch((err) => setError(err.message))}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800 text-sky-300 cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Abrir en pestaña
                    </button>
                  </div>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-3">
                {!doc.file ? (
                  <div className="m-auto text-center space-y-2 max-w-xs">
                    <FileText className="w-8 h-8 text-slate-600 mx-auto" aria-hidden />
                    <p className="text-sm text-slate-300">Adjunta el archivo para poder verificar este documento.</p>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(f);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Adjuntar archivo
                    </button>
                  </div>
                ) : loadingPreview ? (
                  <Loader2 className="m-auto w-6 h-6 animate-spin text-slate-500" aria-label="Cargando archivo" />
                ) : previewError ? (
                  <p className="m-auto text-sm text-rose-300">{previewError}</p>
                ) : preview?.mime === 'application/pdf' ? (
                  <iframe src={preview.url} title={`Archivo de ${meta.label}`} className="w-full h-full min-h-[28rem] rounded bg-white" />
                ) : preview ? (
                  <img
                    src={preview.url}
                    alt={`${meta.label} de ${driver.name}`}
                    style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? '100%' : 'none' }}
                    className="rounded shadow-lg"
                  />
                ) : null}
              </div>
            </div>

            {/* Data + decision */}
            <div className="overflow-y-auto p-4 space-y-4 text-xs">
              <section>
                <h3 className="text-sm font-semibold text-slate-100">{meta.label}</h3>
                <p className={`mt-0.5 ${STATUS_UI[status].cls}`}>
                  {STATUS_UI[status].text}
                  {doc.verification?.by && status !== 'pendiente' && ` por ${doc.verification.by} el ${formatDateAr(doc.verification.at!.slice(0, 10))}`}
                  {status === 'rechazado' && doc.verification?.reason && ` · ${doc.verification.reason}`}
                </p>
                <dl className="mt-2 space-y-1">
                  {[
                    ['Chofer', driver.name],
                    ['Número', doc.number],
                    [meta.issuerLabel ?? 'Emisor', doc.issuer],
                    ['Emitido', doc.issuedAt ? formatDateAr(doc.issuedAt) : undefined],
                    ['Vencimiento', doc.expiresAt ? formatDateAr(doc.expiresAt) : undefined],
                    ...(type === 'licencia' ? [['Clases', driver.licenseClasses?.join(', ')]] : []),
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-3">
                        <dt className="w-24 shrink-0 text-slate-500">{k}</dt>
                        <dd className="text-slate-100 font-medium">{v}</dd>
                      </div>
                    ))}
                </dl>
              </section>

              {!rejecting ? (
                <section className="space-y-2">
                  <h4 className="text-slate-300 font-medium">Compara con el archivo y confirma</h4>
                  {items.map((it, i) => (
                    <label key={it} className="flex items-start gap-2 text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-emerald-500"
                        disabled={!doc.file}
                        checked={checks[i] ?? false}
                        onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? e.target.checked : x)))}
                      />
                      <span>{it}</span>
                    </label>
                  ))}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => decide('verificado')}
                      disabled={!doc.file || !allChecked || busy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Verificar
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejecting(true)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-rose-200 border border-rose-500/40 hover:bg-rose-500/10 cursor-pointer disabled:opacity-40"
                    >
                      <ShieldX className="w-3.5 h-3.5" /> Rechazar
                    </button>
                  </div>
                  {doc.file && !allChecked && <p className="text-[11px] text-slate-500">Tilda todos los puntos para habilitar «Verificar».</p>}
                </section>
              ) : (
                <section className="space-y-2">
                  <h4 className="text-slate-300 font-medium">Motivo del rechazo</h4>
                  <select
                    autoFocus
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setError(null);
                    }}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                    aria-label="Motivo del rechazo"
                  >
                    <option value="">Elige el motivo…</option>
                    {REJECTION_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <textarea
                    rows={2}
                    maxLength={160}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={reason === 'Otro' ? 'Describe el motivo (obligatorio)' : 'Detalle para el chofer (opcional)'}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                    aria-label="Detalle del rechazo"
                  />
                  <p className="text-[11px] text-slate-400">El chofer quedará «No autorizado» hasta que se cargue un documento correcto y se verifique.</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setRejecting(false)} className="px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer">
                      Volver
                    </button>
                    <button
                      type="button"
                      onClick={() => decide('rechazado')}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg font-medium bg-rose-600 hover:bg-rose-500 text-white cursor-pointer disabled:opacity-50"
                    >
                      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Confirmar rechazo
                    </button>
                  </div>
                </section>
              )}

              {error && (
                <p role="alert" className="text-[11px] text-rose-300">
                  {error}
                </p>
              )}

              <section className="pt-3 border-t border-slate-800 space-y-2" aria-live="polite">
                <div className="flex items-center gap-2 text-slate-300">
                  Estado del chofer: <AuthBadge state={driver.authorization.state} />
                </div>
                {driver.authorization.reasons[0] && <p className="text-slate-400">{driver.authorization.reasons.join(' ')}</p>}
                {pendingCount === 0 && driver.authorization.state !== 'pendiente' && (
                  <p className="flex items-center gap-1.5 text-emerald-300">
                    <Check className="w-3.5 h-3.5" aria-hidden /> No quedan documentos obligatorios por verificar.
                  </p>
                )}
                <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer">
                  Listo
                </button>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
