import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Loader2, RefreshCw, Share2, Smartphone, Trash2, X, XCircle } from 'lucide-react';
import type { DeviceConnectionSettings, PhoneListItem, PhonePlatform } from '../shared/types.ts';
import { buildShareText, phoneLink, phonePermissions, PLATFORM_LABELS, recommendedSettings } from '../shared/phone.ts';
import { formatRelativeTime } from '../lib/api.ts';
import { CopyField } from './ConnectionView.tsx';
import { ClientConfigQr } from './ClientConfigQr.tsx';

const STEPS = ['Celular', 'Configurar la app', 'Conexión'] as const;

interface Props {
  row: PhoneListItem;
  deviceConnection: DeviceConnectionSettings;
  companyName?: string;
  onClose: () => void;
  onSave: (platform: PhonePlatform, regenerate?: boolean) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onSync: () => Promise<boolean>;
  onRefresh: () => Promise<void>;
}

/** Three steps: platform → Traccar Client settings to share with the driver → wait for the first report. */
export function PhoneConnectWizard({ row, deviceConnection, companyName, onClose, onSave, onRemove, onSync, onRefresh }: Props) {
  const t = row.tracker;
  const [step, setStep] = useState(t ? 1 : 0);
  const [platform, setPlatform] = useState<PhonePlatform>(t?.platform ?? 'android');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (step === 0) return;
    const id = window.setInterval(() => void refreshRef.current(), 5000);
    return () => window.clearInterval(id);
  }, [step]);

  const serverUrl = deviceConnection.phoneServerUrl;
  const activePlatform = t?.platform ?? platform;
  const shareText = t
    ? buildShareText({ driverName: row.driverName.split(',').reverse().join(' ').trim(), identifier: t.identifier, serverUrl, platform: activePlatform, companyName })
    : '';
  const link = phoneLink(t);
  const prov = t?.provisioning;

  const save = async (regenerate?: boolean) => {
    setBusy(true);
    const ok = await onSave(platform, regenerate);
    setBusy(false);
    if (ok) setStep(1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-wiz-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#0F172A] border border-slate-800 rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="phone-wiz-title" className="text-sm font-semibold text-slate-100">
              Celular de {row.driverName}
            </h3>
            <p className="text-xs text-slate-400">
              {row.assignedVehicle ? `Unidad asignada: ${row.assignedVehicle.unitCode} · ${row.assignedVehicle.plate}` : 'Sin unidad asignada: no se registra su ubicación'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="p-1 rounded hover:bg-slate-800 text-slate-400 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <ol className="flex items-center gap-2 text-[11px]" aria-label="Pasos">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2 flex-1 min-w-0">
              <button
                type="button"
                disabled={i > 0 && !t}
                onClick={() => setStep(i)}
                aria-current={step === i ? 'step' : undefined}
                className={`flex items-center gap-1.5 min-w-0 cursor-pointer disabled:cursor-not-allowed ${
                  step === i ? 'text-sky-300' : i < step ? 'text-emerald-300' : 'text-slate-500'
                }`}
              >
                <span
                  className={`w-5 h-5 shrink-0 rounded-full grid place-items-center border ${
                    step === i ? 'border-sky-400 bg-sky-500/15' : i < step ? 'border-emerald-400 bg-emerald-500/15' : 'border-slate-700'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="truncate">{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="flex-1 h-px bg-slate-800" />}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <p className="text-xs text-slate-300">
              El chofer usa la app gratuita <b>Traccar Client</b>. El panel le asigna un identificador y lo da de alta en Traccar.
            </p>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="text-xs text-slate-300 mb-1.5">¿Qué celular usa?</legend>
              {(['android', 'ios'] as PhonePlatform[]).map((p) => (
                <label
                  key={p}
                  className={`flex items-center gap-2 p-3 rounded-xl border cursor-pointer text-sm ${
                    platform === p ? 'border-sky-500 bg-sky-500/10 text-slate-100' : 'border-slate-700 text-slate-300 hover:bg-slate-800/50'
                  }`}
                >
                  <input type="radio" name="platform" value={p} checked={platform === p} onChange={() => setPlatform(p)} className="accent-sky-500" />
                  <Smartphone className="w-4 h-4" aria-hidden /> {PLATFORM_LABELS[p]}
                </label>
              ))}
            </fieldset>
            <ul className="text-[11px] text-slate-400 list-disc pl-5 space-y-0.5">
              <li>Celular con GPS, Android 8 o superior / iOS 15 o superior, y plan de datos.</li>
              <li>Solo se guarda su ubicación mientras tiene una unidad asignada.</li>
              <li>Si la unidad tiene cámara u OBD reportando, la posición sale del equipo; el celular queda de respaldo.</li>
            </ul>
            <div className="flex items-center justify-between gap-2 pt-1">
              {t ? (
                <RemoveButton driverName={row.driverName} onRemove={onRemove} onDone={onClose} />
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  {busy ? 'Guardando…' : t ? 'Guardar y seguir' : 'Dar de alta'}
                </button>
              </div>
            </div>
          </>
        )}

        {step === 1 && t && (
          <>
            <ProvisioningNote prov={prov} traccarId={t.traccarId} onSync={onSync} />
            <div className="p-3 rounded-xl bg-[#0B1120] border border-sky-500/30">
              <ClientConfigQr identifier={t.identifier} serverUrl={serverUrl} platform={activePlatform} driverName={row.driverName} compact />
            </div>
            <details className="group">
              <summary className="text-xs text-slate-300 cursor-pointer select-none hover:text-slate-100">
                Configurar a mano (si la app no tiene «Escanear código QR»)
              </summary>
              <div className="mt-2 space-y-3">
            <div className="grid grid-cols-1 gap-2">
              <CopyField label="Device identifier" value={t.identifier} />
              <CopyField label="Server URL" value={serverUrl} />
            </div>
            <div>
              <div className="text-xs text-slate-300 mb-1">Ajustes recomendados en Traccar Client ({PLATFORM_LABELS[activePlatform]})</div>
              <table className="w-full text-[11px] border border-slate-800 rounded-lg overflow-hidden">
                <tbody className="divide-y divide-slate-800">
                  {recommendedSettings(activePlatform).map((s) => (
                    <tr key={s.label}>
                      <td className="px-2.5 py-1 text-slate-400 whitespace-nowrap">{s.label}</td>
                      <td className="px-2.5 py-1 font-mono text-slate-100 whitespace-nowrap">{s.value}</td>
                      <td className="px-2.5 py-1 text-slate-500">{s.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
              </div>
            </details>
            <div>
              <div className="text-xs text-slate-300 mb-1">Permisos del celular</div>
              <ul className="text-[11px] text-slate-400 list-disc pl-5 space-y-0.5">
                {phonePermissions(activePlatform).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 border border-emerald-500/30"
              >
                <Share2 className="w-3.5 h-3.5" aria-hidden /> Compartir por WhatsApp
              </a>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard?.writeText(shareText).catch(() => undefined);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-200 border border-slate-700 hover:bg-slate-800 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" aria-hidden /> {copied ? 'Copiado' : 'Copiar instrucciones'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`¿Generar un identificador nuevo? El actual (${t.identifier}) deja de funcionar: usalo si el chofer cambió o perdió el celular.`))
                    void save(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-amber-200 border border-amber-500/40 hover:bg-amber-500/10 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Nuevo identificador
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep(0)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Atrás
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
              >
                Ya está configurada
              </button>
            </div>
          </>
        )}

        {step === 2 && t && (
          <>
            <ul className="space-y-2 text-xs" aria-live="polite">
              <StatusRow
                state={prov?.status === 'error' ? 'error' : prov?.status === 'manual' ? 'manual' : t.traccarId || link.state === 'conectado' ? 'ok' : 'wait'}
                title={prov?.status === 'manual' ? 'Alta manual en Traccar' : prov?.status === 'error' ? 'No se pudo dar de alta en Traccar' : 'Alta en Traccar'}
                detail={prov?.status === 'manual' || prov?.status === 'error' ? prov.message : t.traccarId ? `Dispositivo #${t.traccarId}` : undefined}
              />
              <StatusRow
                state={link.state === 'conectado' ? 'ok' : link.state === 'sin_senal' ? 'error' : 'wait'}
                title={
                  link.state === 'conectado' ? 'Conectado: el celular reporta' : link.state === 'sin_senal' ? 'Sin señal' : 'Esperando el primer reporte…'
                }
                detail={
                  t.lastSeenAt
                    ? `Último reporte ${formatRelativeTime(t.lastSeenAt)}${typeof t.batteryPct === 'number' ? ` · batería ${t.batteryPct} %${t.charging ? ' (cargando)' : ''}` : ''}`
                    : 'En Traccar Client activá «Service status» (rastreo continuo). Suele tardar menos de un minuto.'
                }
              />
            </ul>
            {link.state !== 'conectado' && (
              <div className="text-[11px] text-slate-400 bg-[#0B1120] border border-slate-800 rounded-lg p-2.5 space-y-1">
                <div className="font-medium text-slate-300">¿No conecta?</div>
                <div>· El identificador y la URL deben ser exactamente los del paso 2 (URL completa, empezando con http:// o https://).</div>
                <div>· Permiso de ubicación «Siempre» y datos móviles activados.</div>
                {deviceConnection.phoneServerUrlCustom ? (
                  <div>· El túnel o proxy de {serverUrl} debe estar activo y apuntar al puerto {deviceConnection.osmandPort} de Traccar.</div>
                ) : (
                  <div>· El puerto {deviceConnection.osmandPort}/TCP debe estar abierto en el firewall del servidor.</div>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep(1)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Ver configuración
              </button>
              <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                {link.state === 'conectado' ? 'Listo' : 'Cerrar y seguir esperando'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RemoveButton({ driverName, onRemove, onDone }: { driverName: string; onRemove: () => Promise<boolean>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`¿Quitar el celular de ${driverName}? Deja de rastrearse y se borra de Traccar.`)) return;
        setBusy(true);
        const ok = await onRemove();
        setBusy(false);
        if (ok) onDone();
      }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-rose-200 border border-rose-500/40 hover:bg-rose-500/10 cursor-pointer"
    >
      <Trash2 className="w-3.5 h-3.5" /> Quitar celular
    </button>
  );
}

function ProvisioningNote({
  prov,
  traccarId,
  onSync,
}: {
  prov?: { status: string; message?: string };
  traccarId?: number;
  onSync: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  if (!prov || prov.status === 'pendiente_app' || prov.status === 'conectado') {
    return traccarId ? (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-300">
        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Dado de alta en Traccar automáticamente (dispositivo #{traccarId}).
      </p>
    ) : null;
  }
  return (
    <div
      className={`flex items-start justify-between gap-2 p-2.5 rounded-lg border text-[11px] ${
        prov.status === 'error' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
      }`}
    >
      <span>{prov.message}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onSync();
          setBusy(false);
        }}
        className="inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-md border border-current/40 hover:bg-white/5 cursor-pointer disabled:opacity-50"
      >
        <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} aria-hidden /> Reintentar alta
      </button>
    </div>
  );
}

function StatusRow({ state, title, detail }: { state: 'ok' | 'wait' | 'error' | 'manual'; title: string; detail?: string }) {
  const icon =
    state === 'ok' ? (
      <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden />
    ) : state === 'wait' ? (
      <Loader2 className="w-4 h-4 text-sky-300 animate-spin" aria-hidden />
    ) : (
      <XCircle className={`w-4 h-4 ${state === 'error' ? 'text-rose-400' : 'text-amber-300'}`} aria-hidden />
    );
  return (
    <li className="flex items-start gap-2 p-2.5 rounded-lg bg-[#0B1120] border border-slate-800">
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="block text-slate-100">{title}</span>
        {detail && <span className="block text-slate-400 break-words">{detail}</span>}
      </span>
    </li>
  );
}

