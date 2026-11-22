import { useEffect } from 'react';
import { Ban, FileText, History, Pencil, RotateCcw, ShieldCheck, Smartphone, Truck, X } from 'lucide-react';
import type { DriverListItem } from '../shared/types.ts';
import { formatRelativeTime, openWithAuth } from '../lib/api.ts';
import { phoneLink, PLATFORM_LABELS } from '../shared/phone.ts';
import { formatCuit } from '../shared/cuit.ts';
import { ageOn, daysUntil, DOC_TYPES, DRIVER_PROFILES, formatDateAr, OPTIONAL_DOCS, requiredDocs, verificationStatus } from '../shared/drivers.ts';
import { AuthBadge, ExpiryText } from './DriverBadges.tsx';
import { ClientConfigQrButton } from './ClientConfigQr.tsx';

interface Props {
  driver: DriverListItem;
  /** Server URL for Traccar Client (configuration QR). */
  phoneServerUrl?: string | null;
  onClose: () => void;
  onEdit: () => void;
  onDisable: () => void;
  onEnable: () => void;
  /** Opens the document review (verification) screen. */
  onReview: () => void;
}

/** Side sheet with the driver's authorization, documents and change history. */
export function DriverDetailPanel({ driver: d, phoneServerUrl, onClose, onEdit, onDisable, onEnable, onReview }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const auth = d.authorization;
  const required = new Set(requiredDocs(d.profile ?? 'liviano', Boolean(d.dangerousGoods)));
  const docs = [...(d.documents ?? [])].sort((a, b) => Number(required.has(b.type)) - Number(required.has(a.type)));
  const missingRequired = [...required].filter((t) => !docs.some((x) => x.type === t));
  const disabled = d.enabled === false;
  const pendingReview = docs.filter((x) => required.has(x.type) && verificationStatus(x) === 'pendiente').length;
  const today = new Date();
  const Row = ({ k, v }: { k: string; v?: string | null }) => (
    <div className="flex gap-3 py-1 text-xs">
      <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
      <dd className="text-slate-200 min-w-0 break-words">{v || '—'}</dd>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="dd-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg h-full overflow-y-auto bg-[#0F172A] border-l border-slate-800 flex flex-col"
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="dd-title" className="text-base font-semibold text-slate-100 truncate">
              {d.name}
            </h2>
            <p className="text-xs text-slate-400">
              {DRIVER_PROFILES[d.profile ?? 'liviano'].label}
              {d.tenantName ? ` · ${d.tenantName}` : ''} · {d.branch}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer" aria-label="Cerrar ficha" autoFocus>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 px-5 py-4 space-y-4">
          <section className="p-3.5 rounded-xl border border-slate-800 bg-[#0B1120] space-y-1.5" aria-live="polite">
            <div className="flex items-center gap-2">
              <AuthBadge state={auth.state} />
              {auth.nextExpiry && auth.state !== 'deshabilitado' && (
                <span className="text-xs text-slate-400">
                  Próximo vencimiento: {auth.nextExpiryDoc ? DOC_TYPES[auth.nextExpiryDoc].short : ''} {formatDateAr(auth.nextExpiry)}
                </span>
              )}
            </div>
            {auth.reasons.length > 0 && (
              <ul className="text-xs text-slate-300 list-disc pl-5 space-y-0.5">
                {auth.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {disabled && d.disabledAt && (
              <p className="text-[11px] text-slate-400">
                Deshabilitado el {formatDateAr(d.disabledAt.slice(0, 10))} por {d.disabledBy}
                {d.disabledNote ? ` · «${d.disabledNote}»` : ''}
              </p>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            {pendingReview > 0 && (
              <button type="button" onClick={onReview} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer">
                <ShieldCheck className="w-3.5 h-3.5" /> Revisar documentos ({pendingReview})
              </button>
            )}
            {pendingReview === 0 && docs.length > 0 && (
              <button type="button" onClick={onReview} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-200 border border-slate-700 hover:bg-slate-800 cursor-pointer">
                <ShieldCheck className="w-3.5 h-3.5" /> Ver verificación
              </button>
            )}
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
              <Pencil className="w-3.5 h-3.5" /> Editar
            </button>
            {disabled ? (
              <button type="button" onClick={onEnable} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/10 cursor-pointer">
                <RotateCcw className="w-3.5 h-3.5" /> Habilitar
              </button>
            ) : (
              <button type="button" onClick={onDisable} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-rose-200 border border-rose-500/40 hover:bg-rose-500/10 cursor-pointer">
                <Ban className="w-3.5 h-3.5" /> Deshabilitar
              </button>
            )}
          </div>

          <section>
            <h3 className="text-xs font-semibold text-slate-200 mb-1">Datos personales</h3>
            <dl>
              <Row k="DNI" v={d.dni} />
              <Row k="CUIL" v={d.cuil ? formatCuit(d.cuil) : undefined} />
              <Row k="Nacimiento" v={d.birthDate ? `${formatDateAr(d.birthDate)} (${ageOn(d.birthDate, today)} años)` : undefined} />
              <Row k="Teléfono" v={d.phone} />
              <Row k="Email" v={d.email} />
              <Row k="Domicilio" v={d.address} />
              <Row k="Emergencia" v={d.emergencyContact ? `${d.emergencyContact.name} · ${d.emergencyContact.phone}` : undefined} />
              <Row k="Legajo" v={d.employeeNumber} />
              <Row k="Ingreso" v={d.hireDate ? formatDateAr(d.hireDate) : undefined} />
            </dl>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-slate-200 mb-1">Licencia</h3>
            <dl>
              <Row k="Número" v={d.licenseNumber} />
              <Row k="Clases" v={d.licenseClasses?.join(', ')} />
              <Row k="Emitida por" v={d.licenseJurisdiction} />
            </dl>
          </section>

          <section className="flex items-center gap-2 text-xs text-slate-300">
            <Truck className="w-4 h-4 text-slate-400" aria-hidden />
            {d.assignedVehicle ? (
              <span>
                Conduce <b className="text-slate-100">{d.assignedVehicle.unitCode}</b> ({d.assignedVehicle.plate})
              </span>
            ) : (
              <span className="text-slate-400">Sin unidad asignada</span>
            )}
          </section>

          <section className="flex items-center gap-2 text-xs text-slate-300">
            <Smartphone className="w-4 h-4 text-slate-400" aria-hidden />
            {d.phoneTracker ? (
              <span>
                Celular {PLATFORM_LABELS[d.phoneTracker.platform]} <span className="font-mono">{d.phoneTracker.identifier}</span> ·{' '}
                <b className="text-slate-100">{phoneLink(d.phoneTracker).label}</b>
                {typeof d.phoneTracker.batteryPct === 'number' ? ` · ${d.phoneTracker.batteryPct} %` : ''}
                {d.phoneTracker.lastSeenAt ? ` · ${formatRelativeTime(d.phoneTracker.lastSeenAt)}` : ''}
              </span>
            ) : null}
            {d.phoneTracker && phoneServerUrl ? (
              <ClientConfigQrButton
                identifier={d.phoneTracker.identifier}
                serverUrl={phoneServerUrl}
                platform={d.phoneTracker.platform}
                driverName={d.name}
              />
            ) : null}
            {!d.phoneTracker && (
              <span className="text-slate-400">Sin celular conectado (Configuración de Cámaras → Conexión Smartphone)</span>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold text-slate-200 mb-2">Documentación</h3>
            <ul className="space-y-2">
              {missingRequired.map((t) => (
                <li key={t} className="p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/5 text-xs flex items-center justify-between">
                  <span className="text-slate-200">{DOC_TYPES[t].label}</span>
                  <span className="text-rose-300">Falta (obligatorio)</span>
                </li>
              ))}
              {docs.map((doc) => {
                const meta = DOC_TYPES[doc.type];
                return (
                  <li key={doc.type} className="p-2.5 rounded-lg border border-slate-800 bg-[#0B1120] text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-slate-100">
                          {meta.label}{' '}
                          {OPTIONAL_DOCS.includes(doc.type) && <span className="text-[10px] text-slate-500">opcional</span>}
                        </div>
                        <div className="text-slate-400">
                          {doc.number ? <span className="font-mono">{doc.number}</span> : 'Sin número'}
                          {doc.issuer ? ` · ${doc.issuer}` : ''}
                        </div>
                      </div>
                      {meta.hasExpiry && <ExpiryText date={doc.expiresAt} days={doc.expiresAt ? daysUntil(doc.expiresAt, today) : undefined} />}
                    </div>
                    <div className="mt-1 text-[11px]">
                      {verificationStatus(doc) === 'verificado' ? (
                        <span className="text-emerald-300">
                          Verificado por {doc.verification?.by} el {formatDateAr((doc.verification?.at ?? '').slice(0, 10))}
                        </span>
                      ) : verificationStatus(doc) === 'rechazado' ? (
                        <span className="text-rose-300">Rechazado: {doc.verification?.reason}</span>
                      ) : (
                        <span className="text-sky-300">Pendiente de verificación</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      {doc.file ? (
                        <button
                          type="button"
                          onClick={() => openWithAuth(`/api/drivers/${d.id}/documents/${doc.type}/file`).catch((err) => window.alert(err.message))}
                          className="inline-flex items-center gap-1 text-sky-300 hover:underline cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" aria-hidden /> Ver {doc.file.name}
                        </button>
                      ) : (
                        <span className="text-amber-300">Sin archivo de respaldo</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5" aria-hidden /> Historial
            </h3>
            {d.history?.length ? (
              <ol className="space-y-2 border-l border-slate-800 pl-3">
                {d.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="text-xs">
                    <div className="text-slate-200">{h.action}</div>
                    <div className="text-slate-400">{h.detail}</div>
                    <div className="text-[11px] text-slate-500">
                      {new Date(h.at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })} · {h.actor}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-slate-500">Sin cambios registrados desde que se creó el registro de choferes.</p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
