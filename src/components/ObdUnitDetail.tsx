import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertOctagon, AlertTriangle, BarChart3, CheckCircle2, CircleHelp, Pencil, RefreshCw, Send, Table2, X } from 'lucide-react';
import type { Device, ObdFaultEvent, ObdHistoryPoint, ObdHistoryRange, Vehicle } from '../shared/types.ts';
import { apiRequest, formatRelativeTime } from '../lib/api.ts';
import { OBD_THRESHOLDS, obdHealth, obdLink, type ObdHealthLevel } from '../shared/obdHealth.ts';
import { OBD_COMMANDS } from '../shared/teltonika.ts';

interface Props {
  vehicle: Vehicle;
  device?: Device;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRefresh: () => Promise<void>;
  onSync: () => Promise<boolean>;
  onCommand: (commandId: string, option?: string) => Promise<boolean>;
}

// Single-series charts: one hue (reference palette slot 1, dark step), chrome from the dark ink roles.
const SERIES = '#3987e5';
const GRID = '#2c2c2a';
const AXIS = '#898781';
const REF = '#c3c2b7';

const RANGES: { id: ObdHistoryRange; label: string }[] = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
];

interface Metric {
  key: keyof ObdHistoryPoint;
  title: string;
  unit: string;
  digits: number;
  domain?: [number | 'auto', number | 'auto'];
  ref?: { value: number; label: string };
}

const METRICS: Metric[] = [
  { key: 'rpm', title: 'RPM del motor', unit: 'rpm', digits: 0, domain: [0, 'auto'] },
  {
    key: 'coolantC',
    title: 'Temperatura del motor',
    unit: '°C',
    digits: 0,
    domain: [0, 120],
    ref: { value: OBD_THRESHOLDS.coolantCriticalC, label: `Límite ${OBD_THRESHOLDS.coolantCriticalC} °C` },
  },
  { key: 'fuelPct', title: 'Combustible', unit: '%', digits: 0, domain: [0, 100] },
  { key: 'batteryV', title: 'Batería', unit: 'V', digits: 1, domain: [10, 15], ref: { value: OBD_THRESHOLDS.batteryLowOffV, label: 'Mínimo 12 V' } },
];

const HEALTH_META: Record<ObdHealthLevel, { cls: string; Icon: typeof CheckCircle2 }> = {
  bien: { cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300', Icon: CheckCircle2 },
  atencion: { cls: 'bg-amber-500/10 border-amber-500/30 text-amber-300', Icon: AlertTriangle },
  critico: { cls: 'bg-rose-500/10 border-rose-500/30 text-rose-300', Icon: AlertOctagon },
  sin_datos: { cls: 'bg-slate-800 border-slate-700 text-slate-400', Icon: CircleHelp },
};

const fmtNum = (n: number | null | undefined, digits: number) =>
  n == null ? '—' : n.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function tickLabel(iso: string, range: ObdHistoryRange) {
  const d = new Date(iso);
  return range === '24h'
    ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function duration(fromIso: string, toIso: string | null) {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} días`;
}

function MetricChart({ metric, points, range }: { metric: Metric; points: ObdHistoryPoint[]; range: ObdHistoryRange }) {
  const values = points.map((p) => p[metric.key] as number | null).filter((x): x is number => x != null);
  const last = values.length ? values[values.length - 1] : null;
  return (
    <figure className="bg-[#0B1120] border border-slate-800 rounded-xl p-3">
      <figcaption className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-slate-300">{metric.title}</span>
        <span className="text-sm font-semibold text-slate-100 tabular-nums">
          {fmtNum(last, metric.digits)} <span className="text-[11px] font-normal text-slate-400">{metric.unit}</span>
        </span>
      </figcaption>
      {values.length === 0 ? (
        <div className="h-36 grid place-items-center text-[11px] text-slate-500">Sin datos en este período</div>
      ) : (
        <div className="h-36" role="img" aria-label={`${metric.title}: último ${fmtNum(last, metric.digits)} ${metric.unit}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="at"
                tickFormatter={(v: string) => tickLabel(v, range)}
                tick={{ fill: AXIS, fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: '#383835' }}
                minTickGap={28}
              />
              <YAxis domain={metric.domain ?? ['auto', 'auto']} tick={{ fill: AXIS, fontSize: 10 }} tickLine={false} axisLine={false} width={44} />
              {metric.ref && (
                <ReferenceLine
                  y={metric.ref.value}
                  stroke={REF}
                  strokeDasharray="4 3"
                  label={{ value: metric.ref.label, position: 'insideTopRight', fill: REF, fontSize: 10 }}
                />
              )}
              <Tooltip
                cursor={{ stroke: AXIS, strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const p = active && payload?.[0] ? (payload[0].payload as ObdHistoryPoint) : null;
                  if (!p) return null;
                  const v = p[metric.key] as number | null;
                  return (
                    <div className="px-2.5 py-1.5 rounded-lg bg-[#0F172A] border border-slate-700 text-[11px] text-slate-300 shadow-lg">
                      <div className="text-slate-400">{new Date(p.at).toLocaleString('es-AR')}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block w-3 h-0.5 rounded" style={{ background: SERIES }} />
                        <b className="text-slate-100 tabular-nums">
                          {fmtNum(v, metric.digits)} {metric.unit}
                        </b>
                        <span>{metric.title.toLowerCase()}</span>
                      </div>
                      {metric.key === 'coolantC' && p.coolantMaxC != null && range !== '24h' && <div>Máx. {fmtNum(p.coolantMaxC, 0)} °C</div>}
                      {metric.key === 'batteryV' && p.batteryMinV != null && range !== '24h' && <div>Mín. {fmtNum(p.batteryMinV, 1)} V</div>}
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey={metric.key}
                stroke={SERIES}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: '#0B1120', strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  );
}

/** «Seguimiento» of one unit: health, engine history, fault history and remote configuration. */
export function ObdUnitDetail({ vehicle, device, canEdit, onClose, onEdit, onRefresh, onSync, onCommand }: Props) {
  const [range, setRange] = useState<ObdHistoryRange>('24h');
  const [points, setPoints] = useState<ObdHistoryPoint[] | null>(null);
  const [faults, setFaults] = useState<ObdFaultEvent[] | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [profile, setProfile] = useState('normal');

  const health = obdHealth(vehicle);
  const link = obdLink(device);
  const HealthIcon = HEALTH_META[health.level].Icon;

  const loadHistory = useCallback(async () => {
    try {
      const [h, f] = await Promise.all([
        apiRequest<{ points: ObdHistoryPoint[] }>(`/api/vehicles/${vehicle.id}/obd/history?range=${range}`),
        apiRequest<{ faults: ObdFaultEvent[] }>(`/api/vehicles/${vehicle.id}/obd/faults`),
      ]);
      setPoints(h.points);
      setFaults(f.faults);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el historial.');
    }
  }, [vehicle.id, range]);

  useEffect(() => {
    setPoints(null);
    void loadHistory();
    const id = window.setInterval(() => void loadHistory(), 60_000);
    return () => window.clearInterval(id);
  }, [loadHistory]);

  // Command replies and connection state.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    const id = window.setInterval(() => void refreshRef.current(), 10_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (commandId: string, option?: string) => {
    const def = OBD_COMMANDS.find((c) => c.id === commandId);
    if (def?.confirm && !window.confirm(def.confirm)) return;
    setSending(commandId);
    await onCommand(commandId, option);
    setSending(null);
  };

  const tableRows = useMemo(() => (points ?? []).filter((p) => p.rpm != null || p.coolantC != null).slice().reverse(), [points]);
  const remoteReady = Boolean(device?.traccarId);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="obd-detail-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl my-4 bg-[#0F172A] border border-slate-800 rounded-2xl p-5 space-y-5"
      >
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="obd-detail-title" className="text-base font-semibold text-slate-100">
              Seguimiento OBD-II · {vehicle.unitCode}
            </h3>
            <p className="text-xs text-slate-400">
              {vehicle.brandModel} · {vehicle.plate}
              {device ? (
                <>
                  {' '}
                  · {device.model} · IMEI <span className="font-mono">{device.imei}</span>
                </>
              ) : null}
              {vehicle.vin ? (
                <>
                  {' '}
                  · VIN <span className="font-mono">{vehicle.vin}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700 hover:bg-slate-800 cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" aria-hidden /> Equipo y conexión
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Cerrar" className="p-1.5 rounded hover:bg-slate-800 text-slate-400 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-[#0B1120] border border-slate-800 rounded-xl p-3 text-xs">
            <div className="text-slate-400 mb-1">Conexión</div>
            <div
              className={`text-sm font-semibold ${
                link.state === 'conectado' ? 'text-emerald-300' : link.state === 'sin_senal' || link.state === 'error' ? 'text-rose-300' : 'text-amber-300'
              }`}
            >
              {link.label}
            </div>
            <div className="text-slate-500 mt-0.5 break-words">
              {device?.lastObdAt ? `Último dato ${formatRelativeTime(device.lastObdAt)}` : (link.detail ?? 'Todavía no reportó.')}
            </div>
          </div>
          <div className={`md:col-span-2 border rounded-xl p-3 text-xs ${HEALTH_META[health.level].cls}`}>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <HealthIcon className="w-4 h-4" aria-hidden /> Salud del vehículo: {health.label}
            </div>
            {health.reasons.length ? (
              <ul className="mt-1 space-y-0.5 text-slate-200">
                {health.reasons.slice(0, 4).map((r) => (
                  <li key={r}>· {r}</li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-slate-300">
                {health.level === 'sin_datos' ? 'Aparece cuando el equipo envía datos del motor.' : 'Sin fallas activas, temperatura y batería normales.'}
              </div>
            )}
          </div>
        </div>

        {/* History */}
        <section className="space-y-3" aria-labelledby="obd-hist-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id="obd-hist-title" className="text-sm font-semibold text-slate-100">
              Historial del motor
            </h4>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Período" className="inline-flex rounded-lg border border-slate-700 overflow-hidden text-xs">
                {RANGES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={range === r.id}
                    onClick={() => setRange(r.id)}
                    className={`px-2.5 py-1 cursor-pointer ${range === r.id ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowTable((x) => !x)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-300 border border-slate-700 hover:bg-slate-800 cursor-pointer"
              >
                {showTable ? <BarChart3 className="w-3.5 h-3.5" aria-hidden /> : <Table2 className="w-3.5 h-3.5" aria-hidden />}
                {showTable ? 'Ver gráficos' : 'Ver tabla'}
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-rose-300">{error}</p>}
          {points === null ? (
            <div className="h-40 grid place-items-center text-xs text-slate-500">Cargando historial…</div>
          ) : showTable ? (
            <div className="max-h-80 overflow-auto border border-slate-800 rounded-xl">
              <table className="w-full text-xs">
                <thead className="text-slate-400 bg-[#0B1120] sticky top-0">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Fecha</th>
                    <th className="text-right font-medium px-3 py-2">RPM</th>
                    <th className="text-right font-medium px-3 py-2">Temp. (°C)</th>
                    <th className="text-right font-medium px-3 py-2">Combust. (%)</th>
                    <th className="text-right font-medium px-3 py-2">Batería (V)</th>
                    <th className="text-right font-medium px-3 py-2">Velocidad (km/h)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200 tabular-nums">
                  {tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                        Sin datos en este período
                      </td>
                    </tr>
                  ) : (
                    tableRows.map((p) => (
                      <tr key={p.at}>
                        <td className="px-3 py-1.5">{new Date(p.at).toLocaleString('es-AR')}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(p.rpm, 0)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(p.coolantC, 0)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(p.fuelPct, 0)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(p.batteryV, 1)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(p.speedKmh, 0)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {METRICS.map((m) => (
                <MetricChart key={m.key} metric={m} points={points} range={range} />
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            Promedios cada {range === '24h' ? '5 minutos' : range === '7d' ? 'hora' : '6 horas'}. Se guarda un dato por minuto durante 90 días.
          </p>
        </section>

        {/* Fault history */}
        <section className="space-y-2" aria-labelledby="obd-faults-title">
          <h4 id="obd-faults-title" className="text-sm font-semibold text-slate-100">
            Historial de fallas
          </h4>
          <div className="border border-slate-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400 bg-[#0B1120]">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Código</th>
                  <th className="text-left font-medium px-3 py-2">Descripción</th>
                  <th className="text-left font-medium px-3 py-2">Gravedad</th>
                  <th className="text-left font-medium px-3 py-2">Apareció</th>
                  <th className="text-left font-medium px-3 py-2">Estado</th>
                  <th className="text-left font-medium px-3 py-2">Duración</th>
                  <th className="text-left font-medium px-3 py-2">OT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-200">
                {!faults || faults.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-5 text-center text-slate-500">
                      {faults ? 'El equipo no reportó códigos de falla.' : 'Cargando…'}
                    </td>
                  </tr>
                ) : (
                  faults.map((f) => (
                    <tr key={f.id}>
                      <td className="px-3 py-1.5 font-mono">{f.code}</td>
                      <td className="px-3 py-1.5">
                        {f.description}
                        <div className="text-slate-500">{f.system}</div>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex items-center gap-1 ${f.severity === 'critica' ? 'text-rose-300' : 'text-amber-300'}`}>
                          {f.severity === 'critica' ? <AlertOctagon className="w-3 h-3" aria-hidden /> : <AlertTriangle className="w-3 h-3" aria-hidden />}
                          {f.severity === 'critica' ? 'Crítica' : 'Advertencia'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{new Date(f.openedAt).toLocaleString('es-AR')}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {f.clearedAt ? (
                          <span className="text-slate-400">Borrada {new Date(f.clearedAt).toLocaleString('es-AR')}</span>
                        ) : (
                          <span className="text-rose-300 font-medium">Activa</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{duration(f.openedAt, f.clearedAt)}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-400">{f.workOrderId ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Remote configuration */}
        <section className="space-y-3" aria-labelledby="obd-remote-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id="obd-remote-title" className="text-sm font-semibold text-slate-100">
              Configuración remota
            </h4>
            <span className="text-[11px] text-slate-500">Por GPRS a través de Traccar. Si el equipo está desconectado, el comando queda en cola.</span>
          </div>
          {!device ? (
            <p className="text-xs text-slate-500">La unidad no tiene equipo OBD-II.</p>
          ) : !remoteReady ? (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              <span>
                {device.provisioning?.message ??
                  'El equipo no está dado de alta en Traccar desde el panel, así que no se le pueden mandar comandos.'}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void onSync()}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-400/40 hover:bg-white/5 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden /> Reintentar alta
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {OBD_COMMANDS.map((c) => (
                <div key={c.id} className="bg-[#0B1120] border border-slate-800 rounded-xl p-3 flex flex-col gap-2 text-xs">
                  <div>
                    <div className="font-medium text-slate-100">{c.label}</div>
                    <div className="text-slate-400">{c.description}</div>
                  </div>
                  {c.options && (
                    <select
                      value={profile}
                      onChange={(e) => setProfile(e.target.value)}
                      aria-label={c.label}
                      className="px-2 py-1 bg-[#0F172A] border border-slate-700 rounded-lg text-slate-100"
                    >
                      {c.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={!canEdit || sending !== null}
                    title={!canEdit ? 'Tu perfil es de solo lectura' : undefined}
                    onClick={() => void send(c.id, c.options ? profile : undefined)}
                    className="mt-auto inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-200 border border-sky-500/30 disabled:opacity-40 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" aria-hidden /> {sending === c.id ? 'Enviando…' : 'Enviar'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {device?.commandLog && device.commandLog.length > 0 && (
            <div className="border border-slate-800 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400 bg-[#0B1120]">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Fecha</th>
                    <th className="text-left font-medium px-3 py-2">Comando</th>
                    <th className="text-left font-medium px-3 py-2">Usuario</th>
                    <th className="text-left font-medium px-3 py-2">Estado</th>
                    <th className="text-left font-medium px-3 py-2">Respuesta del equipo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200 align-top">
                  {device.commandLog.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-1.5 whitespace-nowrap">{new Date(c.at).toLocaleString('es-AR')}</td>
                      <td className="px-3 py-1.5">
                        {c.label}
                        <div className="font-mono text-slate-500">{c.text.trim()}</div>
                      </td>
                      <td className="px-3 py-1.5">{c.actorName}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span
                          className={
                            c.status === 'respondido'
                              ? 'text-emerald-300'
                              : c.status === 'error'
                                ? 'text-rose-300'
                                : c.status === 'en_cola'
                                  ? 'text-amber-300'
                                  : 'text-sky-300'
                          }
                        >
                          {{ enviado: 'Enviado', en_cola: 'En cola', error: 'Error', respondido: 'Respondido' }[c.status]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-slate-300 break-all max-w-[340px]">
                        {c.response ?? <span className="text-slate-500 font-sans">Esperando respuesta…</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
