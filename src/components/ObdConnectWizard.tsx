import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, MessageSquareText, RefreshCw, Trash2, X, XCircle } from 'lucide-react';
import type { Device, DeviceConnectionSettings, Vehicle } from '../shared/types.ts';
import { DEVICE_CATALOG } from '../shared/deviceCatalog.ts';
import { APN_PRESETS, APN_RE, buildSetupSms } from '../shared/teltonika.ts';
import { obdLink } from '../shared/obdHealth.ts';
import { formatRelativeTime } from '../lib/api.ts';
import { CopyField } from './ConnectionView.tsx';

export interface ObdAssignPayload {
  imei: string;
  catalogModelId?: string;
  vin?: string;
  apn?: string;
}

/** Trackers that read engine data: the OBD-II dongle first (reference device), then CAN-bus units. */
export const OBD_MODELS = DEVICE_CATALOG.filter((m) => m.kind === 'GPS + CAN').sort((a, b) =>
  a.id === 'teltonika-fmc003' ? -1 : b.id === 'teltonika-fmc003' ? 1 : a.model.localeCompare(b.model)
);
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const STEPS = ['Datos del equipo', 'SMS de programación', 'Conexión'] as const;

interface Props {
  vehicle: Vehicle;
  /** Live tracker state (updated by onRefresh). */
  device?: Device;
  deviceConnection: DeviceConnectionSettings;
  onClose: () => void;
  onSave: (p: ObdAssignPayload) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onSync: () => Promise<boolean>;
}

/** Three-step onboarding: data → setup SMS → wait for the first report. */
export function ObdConnectWizard({ vehicle, device, deviceConnection, onClose, onSave, onRemove, onRefresh, onSync }: Props) {
  const [step, setStep] = useState(0);
  const [imei, setImei] = useState(device?.imei ?? '');
  const [model, setModel] = useState(device?.catalogModelId ?? (vehicle.assetType === 'maquinaria_pesada' ? 'teltonika-fmc650' : 'teltonika-fmc003'));
  const [vin, setVin] = useState(vehicle.vin ?? '');
  const initialPreset = APN_PRESETS.find((p) => p.apn === device?.apn);
  const [apnChoice, setApnChoice] = useState<string>(initialPreset?.id ?? (device?.apn ? 'otro' : ''));
  const [apnCustom, setApnCustom] = useState(initialPreset ? '' : (device?.apn ?? ''));
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Steps 2-3: poll the tracker so the status changes as soon as it reports.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (step === 0) return;
    const id = window.setInterval(() => void refreshRef.current(), 5000);
    return () => window.clearInterval(id);
  }, [step]);

  const apn = apnChoice === 'otro' ? apnCustom.trim() : (APN_PRESETS.find((p) => p.id === apnChoice)?.apn ?? '');
  const imeiError = !/^\d{15}$/.test(imei.trim()) ? 'El IMEI tiene 15 dígitos (está en la etiqueta del equipo).' : '';
  const vinClean = vin.trim().toUpperCase();
  const vinError = vinClean && !VIN_RE.test(vinClean) ? 'El VIN tiene 17 caracteres, sin I, O ni Q.' : '';
  const apnError = apn && !APN_RE.test(apn) ? 'APN inválido: solo letras, números, puntos y guiones.' : '';
  const selected = OBD_MODELS.find((m) => m.id === model);

  const save = async () => {
    setTouched(true);
    if (imeiError || vinError || apnError) return;
    setBusy(true);
    const ok = await onSave({ imei: imei.trim(), catalogModelId: model, vin: vinClean || undefined, apn });
    setBusy(false);
    if (ok) setStep(1);
  };

  const host = deviceConnection.obdHost ?? '<dominio-del-VPS>';
  const port = deviceConnection.obdPort;
  const sms = buildSetupSms({ apn: device?.apn ?? (apn || undefined), host, port });
  const link = obdLink(device);
  const prov = device?.provisioning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="obd-wiz-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#0F172A] border border-slate-800 rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="obd-wiz-title" className="text-sm font-semibold text-slate-100">
              Equipo OBD-II de {vehicle.unitCode}
            </h3>
            <p className="text-xs text-slate-400">
              {vehicle.brandModel} · {vehicle.plate}
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
                disabled={i > 0 && !device}
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
            {vehicle.assetType === 'maquinaria_pesada' && (
              <p className="text-[11px] p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200">
                La maquinaria y los camiones no tienen OBD-II: usan bus CAN J1939. Elegí un equipo con lectura CAN (por ejemplo FMC650).
              </p>
            )}
            <label className="block text-xs space-y-1">
              <span className="text-slate-300">IMEI del equipo</span>
              <input
                value={imei}
                onChange={(e) => setImei(e.target.value.replace(/\D/g, '').slice(0, 15))}
                onBlur={() => setTouched(true)}
                inputMode="numeric"
                autoFocus
                placeholder="15 dígitos"
                aria-invalid={touched && Boolean(imeiError)}
                aria-describedby="obd-imei-help"
                className="w-full px-3 py-2 bg-[#0B1120] border border-slate-700 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
              <span id="obd-imei-help" className={touched && imeiError ? 'text-rose-300' : 'text-slate-500'}>
                {touched && imeiError ? imeiError : 'Con él el panel da de alta el equipo en Traccar.'}
              </span>
            </label>

            <label className="block text-xs space-y-1">
              <span className="text-slate-300">Modelo</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-[#0B1120] border border-slate-700 rounded-lg text-slate-100"
              >
                {OBD_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.vendor} {m.model} — {m.channels}
                  </option>
                ))}
              </select>
              {selected?.note && <span className="text-slate-500">{selected.note}</span>}
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs space-y-1">
                <span className="text-slate-300">Operador de la SIM (APN)</span>
                <select
                  value={apnChoice}
                  onChange={(e) => setApnChoice(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-700 rounded-lg text-slate-100"
                >
                  <option value="">Sin indicar (ya configurado)</option>
                  {APN_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.apn}
                    </option>
                  ))}
                  <option value="otro">Otro APN (M2M corporativo)…</option>
                </select>
              </label>
              {apnChoice === 'otro' && (
                <label className="block text-xs space-y-1">
                  <span className="text-slate-300">APN</span>
                  <input
                    value={apnCustom}
                    onChange={(e) => setApnCustom(e.target.value.slice(0, 63))}
                    placeholder="m2m.operador.com"
                    aria-invalid={Boolean(apnError)}
                    className="w-full px-3 py-2 bg-[#0B1120] border border-slate-700 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                </label>
              )}
            </div>
            {apnError && <p className="text-xs text-rose-300">{apnError}</p>}

            <label className="block text-xs space-y-1">
              <span className="text-slate-300">
                VIN <span className="text-slate-500">(opcional: el equipo lo lee solo)</span>
              </span>
              <input
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase().slice(0, 17))}
                placeholder="17 caracteres"
                aria-invalid={Boolean(vinError)}
                className="w-full px-3 py-2 bg-[#0B1120] border border-slate-700 rounded-lg font-mono text-slate-100 focus:outline-none focus:border-sky-500"
              />
              {vinError && <span className="text-rose-300">{vinError}</span>}
            </label>

            <div className="flex items-center justify-between gap-2 pt-1">
              {device ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`¿Quitar el equipo OBD-II de ${vehicle.unitCode}? Los datos de motor vuelven a ser simulados y se borra de Traccar.`))
                      return;
                    setBusy(true);
                    const ok = await onRemove();
                    setBusy(false);
                    if (ok) onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-rose-200 border border-rose-500/40 hover:bg-rose-500/10 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Quitar equipo
                </button>
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
                  onClick={save}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  {busy ? 'Guardando…' : 'Guardar y seguir'}
                </button>
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <ProvisioningNote device={device} onSync={onSync} />
            <div className="space-y-2 text-xs text-slate-300">
              <div className="flex items-start gap-2">
                <MessageSquareText className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" aria-hidden />
                <p>
                  Con el equipo enchufado y la SIM puesta, mandá este SMS <b>desde cualquier celular al número de la SIM del equipo</b>. Le indica
                  a qué servidor reportar. Copialo tal cual: empieza con <b>dos espacios</b>.
                </p>
              </div>
              <CopyField label="SMS de programación" value={sms} />
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-slate-200 bg-[#0B1120] border border-slate-800 rounded-lg px-3 py-2">
                {sms}
              </pre>
              <ul className="text-[11px] text-slate-400 list-disc pl-5 space-y-0.5">
                <li>
                  Servidor <span className="font-mono">{host}</span>, puerto <span className="font-mono">{port}</span>, TCP y
                  Codec 8 Extended{device?.apn ? <> · APN <span className="font-mono">{device.apn}</span></> : ''}.
                </li>
                <li>El equipo responde con un SMS de confirmación. Si la SIM tiene PIN, quitáselo antes.</li>
                <li>Los números de parámetro son los de Teltonika FMB/FMC: confirmalos en su wiki para el firmware del equipo.</li>
                <li>Alternativa: Teltonika Configurator por USB con los mismos datos.</li>
              </ul>
              {!deviceConnection.obdHost && (
                <p className="text-[11px] p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200">
                  Falta el servidor de los OBD-II (DEVICE_SERVER_HOST o el que configure el superadmin): el SMS no sirve hasta entonces.
                </p>
              )}
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
                Ya lo mandé
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <ul className="space-y-2 text-xs" aria-live="polite">
              <StatusRow
                state={prov?.status === 'error' ? 'error' : prov?.status === 'manual' ? 'manual' : device?.traccarId || link.state === 'conectado' ? 'ok' : 'wait'}
                title={
                  prov?.status === 'manual'
                    ? 'Alta manual en Traccar'
                    : prov?.status === 'error'
                      ? 'No se pudo dar de alta en Traccar'
                      : 'Alta en Traccar'
                }
                detail={prov?.status === 'manual' || prov?.status === 'error' ? prov.message : device?.traccarId ? `Dispositivo #${device.traccarId}` : undefined}
              />
              <StatusRow
                state={link.state === 'conectado' ? 'ok' : link.state === 'sin_senal' ? 'error' : 'wait'}
                title={
                  link.state === 'conectado'
                    ? 'Conectado: llegan datos del motor'
                    : link.state === 'sin_senal'
                      ? 'Sin señal'
                      : 'Esperando el primer reporte…'
                }
                detail={
                  device?.lastObdAt
                    ? `Último dato ${formatRelativeTime(device.lastObdAt)}${prov?.firstReportAt ? ` · primero ${new Date(prov.firstReportAt).toLocaleString('es-AR')}` : ''}`
                    : 'Suele tardar 1 a 3 minutos desde el SMS con el motor encendido.'
                }
              />
            </ul>
            {link.state !== 'conectado' && (
              <div className="text-[11px] text-slate-400 bg-[#0B1120] border border-slate-800 rounded-lg p-2.5 space-y-1">
                <div className="font-medium text-slate-300">¿No conecta después de 5 minutos?</div>
                <div>· Que el motor esté encendido y los LED del equipo fijos (GPS y red).</div>
                <div>· Que la SIM tenga datos y el APN sea el correcto.</div>
                {deviceConnection.obdServerCustom ? (
                  <div>
                    · Que el túnel TCP {host}:{port} esté activo y apunte al puerto {deviceConnection.teltonikaPort} de Traccar.
                  </div>
                ) : (
                  <div>· Que el puerto {port}/TCP esté abierto en el firewall y reenviado en el router.</div>
                )}
                <div>· Si llega la posición pero no el motor: Codec 8 Extended (comando en el detalle de la unidad).</div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep(1)} className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Ver SMS
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
              >
                {link.state === 'conectado' ? 'Listo' : 'Cerrar y seguir esperando'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProvisioningNote({ device, onSync }: { device?: Device; onSync: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const p = device?.provisioning;
  if (!p || p.status === 'pendiente_sms' || p.status === 'conectado') {
    return device?.traccarId ? (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-300">
        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Dado de alta en Traccar automáticamente (dispositivo #{device.traccarId}).
      </p>
    ) : null;
  }
  return (
    <div
      className={`flex items-start justify-between gap-2 p-2.5 rounded-lg border text-[11px] ${
        p.status === 'error' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
      }`}
    >
      <span>{p.message}</span>
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
