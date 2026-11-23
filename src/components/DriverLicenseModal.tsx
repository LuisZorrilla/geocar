import { useMemo, useState } from 'react';
import { History, IdCard, Loader2, ShieldAlert, Upload, X } from 'lucide-react';
import type { DriverListItem, LicenseValidityStatus } from '../shared/types.ts';
import { apiRequest, LICENSE_STATUS_META, uploadWithAuth } from '../lib/api.ts';
import {
  daysUntil,
  DRIVER_FILE_MAX_BYTES,
  DRIVER_FILE_TYPES,
  formatDateAr,
  LICENSE_CLASSES,
  verificationStatus,
} from '../shared/drivers.ts';

/**
 * Renewal of a driver's license on top of the Choferes module: the license is the driver's
 * "licencia" document (number, issuer, dates) plus its classes and jurisdiction. Saving goes
 * through PATCH /api/drivers/:id, so the registry records the history, the audit log and sends
 * the license back to verification; the new scan (optional) goes to the document's file.
 */
interface DriverLicenseModalProps {
  driver: DriverListItem;
  canWrite: boolean;
  onClose: () => void;
  onDone: (driver: DriverListItem, message: string, tone?: 'ok' | 'warn') => void;
}

function addYearsIso(baseIso: string, years: number): string {
  const parts = baseIso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return baseIso;
  const d = new Date(Date.UTC(parts[0] + years, parts[1] - 1, parts[2]));
  return d.toISOString().slice(0, 10);
}

/** Validity bucket of a license by its expiry date (same thresholds as LICENSE_STATUS_META). */
export function licenseValidity(expiresAt: string | undefined, today = new Date()): { status: LicenseValidityStatus; days: number } | null {
  if (!expiresAt) return null;
  const days = daysUntil(expiresAt, today);
  const status: LicenseValidityStatus =
    days < 0 ? 'vencida' : days <= 5 ? 'por_vencer_5' : days <= 15 ? 'por_vencer_15' : days <= 30 ? 'por_vencer_30' : 'vigente';
  return { status, days };
}

const LICENSE_HISTORY = /licen|documenta|clase|jurisdic|verifica|archivo/i;

export function DriverLicenseModal({ driver, canWrite, onClose, onDone }: DriverLicenseModalProps) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const current = driver.documents?.find((d) => d.type === 'licencia');
  const validity = licenseValidity(current?.expiresAt);
  const meta = validity ? LICENSE_STATUS_META[validity.status] : null;

  const [number, setNumber] = useState(current?.number ?? '');
  const [classes, setClasses] = useState<string[]>(driver.licenseClasses ?? []);
  const [jurisdiction, setJurisdiction] = useState(driver.licenseJurisdiction ?? current?.issuer ?? '');
  const [issuedAt, setIssuedAt] = useState(todayIso);
  const [expiresAt, setExpiresAt] = useState(addYearsIso(todayIso, 5));
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useMemo(
    () => (driver.history ?? []).filter((h) => LICENSE_HISTORY.test(`${h.action} ${h.detail}`)),
    [driver.history]
  );

  const toggleClass = (code: string) =>
    setClasses((all) => (all.includes(code) ? all.filter((c) => c !== code) : [...all, code]));

  const pickFile = (f: File | null) => {
    setError(null);
    if (f && !DRIVER_FILE_TYPES[f.type]) return setError('El archivo debe ser PDF, JPG o PNG.');
    if (f && f.size > DRIVER_FILE_MAX_BYTES) return setError('El archivo supera los 5 MB.');
    setFile(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!number.trim()) return setError('El número de licencia es obligatorio.');
    if (classes.length === 0) return setError('Elegí al menos una clase.');
    if (!issuedAt || !expiresAt) return setError('Las fechas de emisión y vencimiento son obligatorias.');
    if (expiresAt <= issuedAt) return setError('El vencimiento debe ser posterior a la emisión.');
    if (expiresAt <= todayIso) return setError('La licencia nueva ya estaría vencida: revisá la fecha de vencimiento.');

    // The registry replaces the document list: keep every other document as it is.
    const documents = (driver.documents ?? [])
      .filter((d) => d.type !== 'licencia')
      .map(({ file: _f, verification: _v, ...doc }) => doc);
    documents.push({
      type: 'licencia',
      number: number.trim(),
      issuer: jurisdiction.trim() || undefined,
      issuedAt,
      expiresAt,
    });

    setSaving(true);
    try {
      let res = await apiRequest<{ driver: DriverListItem; notes: string[] }>(`/api/drivers/${driver.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ documents, licenseClasses: classes, licenseJurisdiction: jurisdiction.trim() || undefined }),
      });
      let fileNote = '';
      if (file) {
        try {
          const up = await uploadWithAuth<{ driver: DriverListItem }>(`/api/drivers/${driver.id}/documents/licencia/file`, file);
          res = { ...res, driver: up.driver };
        } catch (err) {
          fileNote = ` · No se pudo subir el archivo: ${err instanceof Error ? err.message : 'error'}`;
        }
      }
      const pending = verificationStatus(res.driver.documents?.find((d) => d.type === 'licencia')) !== 'verificado';
      onDone(
        res.driver,
        `Licencia de ${res.driver.name} renovada hasta ${formatDateAr(expiresAt)}${pending ? ' · queda pendiente de verificación' : ''}${fileNote}`,
        pending || fileNote ? 'warn' : 'ok'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la licencia.');
      setSaving(false);
    }
  };

  const input = 'w-full px-3 py-2 bg-[#11192C] border border-slate-800 rounded-lg text-slate-100 disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4" role="dialog" aria-modal="true" aria-labelledby="lic-title">
      <div className="w-full max-w-2xl max-h-[90vh] bg-[#0F172A] border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-sky-400">Renovación de licencia de conducir</div>
            <h3 id="lic-title" className="text-base font-semibold text-slate-100 mt-0.5 truncate flex items-center gap-2">
              <IdCard className="w-4 h-4 text-sky-400 shrink-0" />
              {driver.name} · {driver.branch}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer shrink-0" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          <div className="p-3.5 rounded-xl bg-[#11192C] border border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-slate-400">Licencia registrada</div>
              {current ? (
                <>
                  <div className="font-mono tabular-nums text-slate-100 font-semibold mt-0.5">
                    {current.number || 'Sin número'} · Clases {(driver.licenseClasses ?? []).join(', ') || '—'}
                  </div>
                  <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                    Emisión: {current.issuedAt ? formatDateAr(current.issuedAt) : '—'} · Vence: {current.expiresAt ? formatDateAr(current.expiresAt) : 'sin fecha'}
                  </div>
                </>
              ) : (
                <div className="text-amber-300 mt-0.5">El chofer no tiene la licencia cargada.</div>
              )}
            </div>
            {validity && meta && (
              <div className="text-right">
                <div className={`font-semibold ${meta.colorClass}`}>{meta.label}</div>
                <div className="font-mono tabular-nums text-slate-300 mt-0.5">
                  {validity.days < 0 ? `Vencida hace ${Math.abs(validity.days)} día(s)` : `Restan ${validity.days} día(s)`}
                </div>
              </div>
            )}
          </div>

          {validity?.status === 'vencida' && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/35 text-rose-200 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>La licencia está vencida: el chofer figura «No autorizado» y no puede conducir hasta que se registre la renovación y se verifique.</span>
            </div>
          )}

          {error && <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300" role="alert">{error}</div>}

          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="lic-number" className="block text-slate-300 font-medium mb-1">Número de licencia</label>
                <input id="lic-number" type="text" maxLength={60} value={number} onChange={(e) => setNumber(e.target.value)} disabled={!canWrite} className={`${input} font-mono`} />
              </div>
              <div>
                <label htmlFor="lic-jur" className="block text-slate-300 font-medium mb-1">Jurisdicción / autoridad emisora</label>
                <input
                  id="lic-jur"
                  type="text"
                  maxLength={120}
                  placeholder="Ej. Municipalidad de San Juan"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  disabled={!canWrite}
                  className={input}
                />
              </div>
            </div>

            <fieldset>
              <legend className="block text-slate-300 font-medium mb-1">Clases habilitadas</legend>
              <div className="flex flex-wrap gap-1.5">
                {LICENSE_CLASSES.map((c) => {
                  const on = classes.includes(c.code);
                  return (
                    <label
                      key={c.code}
                      title={c.description}
                      className={`px-2 py-1 rounded-md border font-mono cursor-pointer ${
                        on ? 'border-sky-500 bg-sky-500/15 text-sky-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <input type="checkbox" className="sr-only" checked={on} disabled={!canWrite} onChange={() => toggleClass(c.code)} />
                      {c.code}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="lic-issued" className="block text-slate-300 font-medium mb-1">Fecha de emisión</label>
                <input id="lic-issued" type="date" value={issuedAt} max={todayIso} onChange={(e) => setIssuedAt(e.target.value)} disabled={!canWrite} className={`${input} font-mono`} />
              </div>
              <div>
                <label htmlFor="lic-expires" className="block text-slate-300 font-medium mb-1">Fecha de vencimiento</label>
                <input id="lic-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={!canWrite} className={`${input} font-mono`} />
              </div>
            </div>

            {canWrite && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Vigencia rápida desde la emisión:</span>
                {[1, 3, 5].map((yrs) => (
                  <button
                    key={yrs}
                    type="button"
                    onClick={() => setExpiresAt(addYearsIso(issuedAt || todayIso, yrs))}
                    className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
                  >
                    +{yrs} {yrs === 1 ? 'año' : 'años'}
                  </button>
                ))}
              </div>
            )}

            {canWrite && (
              <div>
                <label htmlFor="lic-file" className="block text-slate-300 font-medium mb-1">Licencia escaneada (opcional, PDF/JPG/PNG hasta 5 MB)</label>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-700 text-slate-300 hover:border-sky-500 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  {file ? file.name : 'Elegir archivo'}
                  <input id="lic-file" type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
                </label>
                <p className="mt-1 text-slate-500">Al guardar, la licencia vuelve a «pendiente de verificación» hasta que un administrador la revise contra el archivo.</p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap">
                Cerrar
              </button>
              {canWrite && (
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white cursor-pointer whitespace-nowrap"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {saving ? 'Guardando…' : 'Registrar renovación'}
                </button>
              )}
            </div>
          </form>

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
              <span className="font-semibold text-slate-100 flex items-center gap-2">
                <History className="w-4 h-4 text-sky-400" />
                Historial de documentación ({history.length})
              </span>
            </div>
            {history.length === 0 ? (
              <div className="p-4 text-slate-400">Sin cambios de documentación registrados.</div>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {history.map((h) => (
                  <div key={`${h.at}-${h.action}`} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-100">{h.action}</div>
                      <div className="text-slate-400">{h.detail}</div>
                    </div>
                    <div className="text-right text-[11px] text-slate-500 shrink-0">
                      <div>{h.actor}</div>
                      <div className="font-mono">{h.at.slice(0, 10)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
