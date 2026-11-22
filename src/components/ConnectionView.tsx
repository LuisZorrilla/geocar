import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Pencil, RotateCcw, Satellite, Search, Wifi, X } from 'lucide-react';
import type {
  Device,
  DeviceConnectionSettings,
  DeviceUplink,
  RoleDefinition,
  UnmatchedDevice,
} from '../shared/types.ts';
import { apiRequest, formatRelativeTime, LINK_META } from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { UPLINK_LABELS } from '../shared/deviceCatalog.ts';

interface ConnectionViewProps {
  devices: Device[];
  deviceConnection: DeviceConnectionSettings;
  unmatchedDevices?: UnmatchedDevice[];
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  onUpdateConnection: (
    deviceId: string,
    payload: { terminalId: string; uplink: DeviceUplink; wifiSsid?: string }
  ) => Promise<boolean>;
  onNotify?: (kind: 'ok' | 'err', message: string) => void;
  /** New connection settings after the superadmin edits the camera server. */
  onDeviceConnectionChange?: (dc: DeviceConnectionSettings) => void;
}


export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-[#0B1120] border border-slate-800 rounded-lg px-3 py-2 min-w-0">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm text-slate-100 truncate" title={value}>
          {value}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="shrink-0 p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
          aria-label={`Copiar ${label}`}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

export function ConnectionView({
  devices,
  deviceConnection,
  unmatchedDevices,
  activeRole,
  isGlobalSuperadmin,
  onUpdateConnection,
  onNotify,
  onDeviceConnectionChange,
}: ConnectionViewProps) {
  const canEdit =
    Boolean(isGlobalSuperadmin) ||
    activeRole.permissions.dashcams_config === 'full' ||
    activeRole.permissions.dashcams_config === 'write';
  const host = deviceConnection.cameraHost;
  const hostLabel = host ?? '<dominio-del-VPS>';
  const videoHostLabel = deviceConnection.cameraVideoHost ?? hostLabel;
  const port808 = deviceConnection.cameraJt808Port;
  const port1078 = deviceConnection.cameraJt1078Port;

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ id: string; terminalId: string; uplink: DeviceUplink; wifiSsid: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignFor, setAssignFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter(
      (d) =>
        d.unitCode.toLowerCase().includes(q) ||
        d.terminalId.toLowerCase().includes(q) ||
        d.imei.toLowerCase().includes(q) ||
        (d.wifiSsid ?? '').toLowerCase().includes(q)
    );
  }, [devices, search]);
  const pagination = usePagination(filtered, `${search}|${devices.length}`, 8);

  const realCount = devices.filter((d) => d.telemetrySource === 'traccar').length;

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    const ok = await onUpdateConnection(editing.id, {
      terminalId: editing.terminalId.trim(),
      uplink: editing.uplink,
      wifiSsid: editing.wifiSsid.trim() || undefined,
    });
    setSaving(false);
    if (ok) setEditing(null);
  };

  const steps = [
    {
      title: '1. Starlink Mini',
      body: (
        <>
          En la app de Starlink: <b>Configuración → Router</b>. Define un nombre de red WiFi (p. ej. el que figura en la tabla) y una
          clave. La cámara se conecta en <b>2.4 GHz</b>. Alimentación 12 V en el vehículo.
        </>
      ),
    },
    {
      title: '2. Cámara',
      body: (
        <>
          Con la app, software o SMS del fabricante: activar <b>WiFi en modo cliente (STA)</b> con la red y clave del Starlink; servidor 1
          JT/T 808 → <span className="font-mono">{hostLabel}:{port808}</span>; servidor 2 JT/T 1078 (video) →{' '}
          <span className="font-mono">{videoHostLabel}:{port1078}</span>. Ejemplo Jimi:{' '}
          <span className="font-mono text-sky-300">SERVER,1,{hostLabel},{port808},0#</span> (verificar en el manual del
          modelo).
        </>
      ),
    },
    {
      title: '3. Traccar',
      body: (
        <>
          Crear el dispositivo con <b>Identificador = ID de terminal</b> de la tabla. Si llega uno desconocido, aparece abajo en «Equipos
          detectados sin asignar».
        </>
      ),
    },
    {
      title: '4. Verificación',
      body: (
        <>
          El equipo pasa a <b className="text-emerald-300">Conectado</b> con fuente <b>Traccar</b> y la unidad se mueve con su posición real
          en Monitoreo en Vivo.
        </>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {/* Platform endpoints */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-100">Datos para programar las cámaras</div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`px-2 py-0.5 rounded-md border ${
                deviceConnection.ingestEnabled
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              }`}
            >
              Ingesta Traccar {deviceConnection.ingestEnabled ? 'activa' : 'deshabilitada'}
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[#0B1120] border border-slate-800 text-slate-300">
              {realCount} de {devices.length} con datos reales
            </span>
          </div>
        </div>
        {!host && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Falta configurar <span className="font-mono">DEVICE_SERVER_HOST</span> en el servidor (dominio o IP pública del VPS). Hasta
              entonces las cámaras no tienen a dónde conectarse.
            </span>
          </div>
        )}
        <div className={`grid grid-cols-1 gap-2.5 ${isGlobalSuperadmin && onDeviceConnectionChange ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
          {isGlobalSuperadmin && onDeviceConnectionChange ? (
            <CameraServerEditor deviceConnection={deviceConnection} onNotify={onNotify} onChange={onDeviceConnectionChange} />
          ) : (
            <>
              <CopyField label={`Servidor (host)${deviceConnection.cameraServerCustom ? ' · personalizado' : ''}`} value={hostLabel} />
              <CopyField label="Puerto JT/T 808 (posiciones)" value={String(port808)} />
              <CopyField
                label={`JT/T 1078 (video)${videoHostLabel !== hostLabel ? ` · ${videoHostLabel}` : ''}`}
                value={String(port1078)}
              />
            </>
          )}
        </div>
        {deviceConnection.cameraServerCustom && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-sky-300/80">
            <span>
              Datos personalizados. Tienen que llegar a los puertos {deviceConnection.jt808Port} (JT/T 808) y {deviceConnection.jt1078Port} (JT/T
              1078) de Traccar. Las cámaras ya programadas no cambian solas: hay que reprogramarlas.
            </span>
            {isGlobalSuperadmin && onDeviceConnectionChange && (
              <RestoreCameraServer deviceConnection={deviceConnection} onNotify={onNotify} onChange={onDeviceConnectionChange} />
            )}
          </div>
        )}
      </div>

      {/* Guide */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5 text-xs text-slate-300 leading-relaxed">
            <div className="text-sm font-semibold text-slate-100 mb-1.5">{s.title}</div>
            {s.body}
          </div>
        ))}
      </div>

      {/* Unmatched devices (superadmin) */}
      {isGlobalSuperadmin && unmatchedDevices && unmatchedDevices.length > 0 && (
        <div className="bg-[#11192C] border border-amber-500/30 rounded-xl p-4 space-y-2.5">
          <div className="text-sm font-semibold text-amber-200">Equipos detectados sin asignar ({unmatchedDevices.length})</div>
          <p className="text-xs text-slate-400">
            Traccar reporta estos IDs pero ningún equipo del panel los tiene. Asígnalos a una unidad para que sus posiciones aparezcan en el mapa.
          </p>
          <div className="divide-y divide-slate-800">
            {unmatchedDevices.map((u) => (
              <div key={u.uniqueId} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <span className="font-mono text-slate-100">{u.uniqueId}</span>
                  {u.name ? <span className="text-slate-400"> · {u.name}</span> : null}
                  <span className="text-slate-500"> · visto {formatRelativeTime(u.lastSeenAt)}</span>
                </div>
                {assignFor === u.uniqueId ? (
                  <select
                    autoFocus
                    aria-label="Unidad a la que se asigna el equipo"
                    defaultValue=""
                    onChange={async (e) => {
                      const dev = devices.find((d) => d.id === e.target.value);
                      if (!dev) return;
                      const ok = await onUpdateConnection(dev.id, {
                        terminalId: u.uniqueId,
                        uplink: dev.uplink,
                        wifiSsid: dev.wifiSsid,
                      });
                      if (ok) setAssignFor(null);
                    }}
                    className="px-2 py-1 bg-[#0B1120] border border-slate-700 rounded-lg text-slate-100"
                  >
                    <option value="" disabled>
                      Elegir unidad…
                    </option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.unitCode} (actual: {d.terminalId})
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    type="button"
                    disabled={!/^\d{6,20}$/.test(u.uniqueId)}
                    title={!/^\d{6,20}$/.test(u.uniqueId) ? 'El ID debe ser numérico (6 a 20 dígitos)' : undefined}
                    onClick={() => setAssignFor(u.uniqueId)}
                    className="px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 disabled:opacity-40 cursor-pointer"
                  >
                    Asignar a unidad
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices table */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium text-slate-200">Conexión por equipo ({filtered.length})</div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Unidad, ID de terminal, IMEI, red..."
              aria-label="Buscar conexión de equipos"
              className="pl-8 pr-3 py-1.5 w-60 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400 bg-[#0F172A]">
              <tr>
                <th className="text-left font-medium px-4 py-2">Unidad</th>
                <th className="text-left font-medium px-4 py-2">ID de terminal</th>
                <th className="text-left font-medium px-4 py-2">Vía de salida</th>
                <th className="text-left font-medium px-4 py-2">Red WiFi (Starlink)</th>
                <th className="text-left font-medium px-4 py-2">Estado</th>
                <th className="text-left font-medium px-4 py-2">Fuente</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {pagination.pagedItems.map((d) => {
                const isEditing = editing?.id === d.id;
                return (
                  <tr key={d.id} className="text-slate-200">
                    <td className="px-4 py-2 font-medium">{d.unitCode}</td>
                    <td className="px-4 py-2 font-mono">
                      {isEditing ? (
                        <input
                          value={editing.terminalId}
                          onChange={(e) => setEditing({ ...editing, terminalId: e.target.value })}
                          aria-label="ID de terminal"
                          className="w-36 px-2 py-1 bg-[#0B1120] border border-slate-700 rounded text-slate-100"
                        />
                      ) : (
                        d.terminalId
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {isEditing ? (
                        <select
                          value={editing.uplink}
                          onChange={(e) => setEditing({ ...editing, uplink: e.target.value as DeviceUplink })}
                          aria-label="Vía de salida"
                          className="px-2 py-1 bg-[#0B1120] border border-slate-700 rounded text-slate-100"
                        >
                          {Object.entries(UPLINK_LABELS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {d.uplink === 'celular' ? null : <Satellite className="w-3.5 h-3.5 text-sky-400" />}
                          {UPLINK_LABELS[d.uplink]}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {isEditing ? (
                        <input
                          value={editing.wifiSsid}
                          onChange={(e) => setEditing({ ...editing, wifiSsid: e.target.value })}
                          placeholder="Nombre de la red"
                          aria-label="Red WiFi"
                          className="w-40 px-2 py-1 bg-[#0B1120] border border-slate-700 rounded text-slate-100"
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-300">
                          {d.wifiSsid ? <Wifi className="w-3.5 h-3.5 text-slate-500" /> : null}
                          {d.wifiSsid ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={LINK_META[d.linkStatus].colorClass}>{LINK_META[d.linkStatus].label}</span>
                      <span className="text-slate-500"> · {formatRelativeTime(d.lastHeartbeatAt)}</span>
                    </td>
                    <td className="px-4 py-2">
                      {d.telemetrySource === 'traccar' ? (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">Traccar</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">Simulada</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {isEditing ? (
                        <span className="inline-flex gap-1">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={saveEdit}
                            className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 cursor-pointer"
                          >
                            {saving ? 'Guardando…' : 'Guardar'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="p-1 rounded hover:bg-slate-800 text-slate-400 cursor-pointer"
                            aria-label="Cancelar"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canEdit}
                          title={!canEdit ? 'Tu perfil es de solo lectura' : 'Editar conexión'}
                          onClick={() =>
                            setEditing({ id: d.id, terminalId: d.terminalId, uplink: d.uplink, wifiSsid: d.wifiSsid ?? '' })
                          }
                          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                          aria-label={`Editar conexión de ${d.unitCode}`}
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
        <Pagination
          page={pagination.page}
          totalItems={pagination.totalItems}
          pageSize={8}
          onPageChange={pagination.setPage}
        />
      </div>
    </div>
  );
}

/**
 * Superadmin: each camera address is edited on its own (host, JT/T 808 port, video host, JT/T 1078 port).
 * JT/T 808 / 1078 are raw TCP, so HTTP tunnels (VS Code devtunnels) are rejected.
 */
function CameraServerEditor({
  deviceConnection: dc,
  onNotify,
  onChange,
}: {
  deviceConnection: DeviceConnectionSettings;
  onNotify?: (kind: 'ok' | 'err', message: string) => void;
  onChange: (dc: DeviceConnectionSettings) => void;
}) {
  const notify = onNotify ?? (() => undefined);
  const videoDiffers = Boolean(dc.cameraVideoHost && dc.cameraVideoHost !== dc.cameraHost);

  /** Saves the whole address set with one field changed (the server stores them together). */
  const saveField = async (
    patch: Partial<{ host: string; jt808Port: number; videoHost: string; jt1078Port: number }>,
    what: string
  ): Promise<boolean> => {
    const host = patch.host ?? dc.cameraHost;
    if (!host) {
      notify('err', 'Primero cargá el servidor (host) de las cámaras.');
      return false;
    }
    const server = {
      host,
      jt808Port: patch.jt808Port ?? dc.cameraJt808Port,
      videoHost: patch.videoHost !== undefined ? patch.videoHost || undefined : videoDiffers ? (dc.cameraVideoHost ?? undefined) : undefined,
      jt1078Port: patch.jt1078Port ?? dc.cameraJt1078Port,
    };
    try {
      const res = await apiRequest<{ deviceConnection: DeviceConnectionSettings }>('/api/settings/camera-server', {
        method: 'PUT',
        body: JSON.stringify({ server }),
      });
      onChange(res.deviceConnection);
      notify('ok', `${what} actualizado.`);
      return true;
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'No se pudo guardar.');
      return false;
    }
  };

  return (
    <>
      <EditableField
        label={`Servidor JT/T 808 (host)${dc.cameraServerCustom ? ' · personalizado' : ''}`}
        value={dc.cameraHost ?? '<dominio-del-VPS>'}
        editValue={dc.cameraHost ?? ''}
        placeholder="190.176.56.76 o 0.tcp.sa.ngrok.io"
        validate={tcpHostProblem}
        onSave={(v) => saveField({ host: v.toLowerCase() }, 'Servidor JT/T 808')}
      />
      <EditableField
        label="Puerto JT/T 808 (posiciones)"
        value={String(dc.cameraJt808Port)}
        numeric
        validate={tcpPortProblem}
        onSave={(v) => saveField({ jt808Port: Number(v) }, 'Puerto JT/T 808')}
      />
      <EditableField
        label={`Servidor JT/T 1078 (video)${videoDiffers ? '' : ' · igual al 808'}`}
        value={dc.cameraVideoHost ?? dc.cameraHost ?? '<dominio-del-VPS>'}
        editValue={videoDiffers ? (dc.cameraVideoHost ?? '') : ''}
        placeholder="vacío = el mismo servidor JT/T 808"
        emptyAllowed
        validate={tcpHostProblem}
        onSave={(v) => saveField({ videoHost: v.toLowerCase() }, 'Servidor de video')}
      />
      <EditableField
        label="Puerto JT/T 1078 (video)"
        value={String(dc.cameraJt1078Port)}
        numeric
        validate={tcpPortProblem}
        onSave={(v) => saveField({ jt1078Port: Number(v) }, 'Puerto JT/T 1078')}
      />
    </>
  );
}

/** «Restaurar» for the camera addresses (back to DEVICE_SERVER_HOST and the Traccar ports). */
function RestoreCameraServer({
  deviceConnection: dc,
  onNotify,
  onChange,
}: {
  deviceConnection: DeviceConnectionSettings;
  onNotify?: (kind: 'ok' | 'err', message: string) => void;
  onChange: (dc: DeviceConnectionSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`¿Volver a ${dc.host ?? 'DEVICE_SERVER_HOST'}:${dc.jt808Port} / ${dc.jt1078Port}?`)) return;
        setBusy(true);
        try {
          const res = await apiRequest<{ deviceConnection: DeviceConnectionSettings }>('/api/settings/camera-server', {
            method: 'PUT',
            body: JSON.stringify({ server: null }),
          });
          onChange(res.deviceConnection);
          onNotify?.('ok', 'Se restauró el servidor predeterminado de las cámaras.');
        } catch (err) {
          onNotify?.('err', err instanceof Error ? err.message : 'No se pudo restaurar.');
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-slate-300 border border-slate-700 hover:bg-slate-800 cursor-pointer disabled:opacity-50"
    >
      <RotateCcw className="w-3 h-3" aria-hidden /> Restaurar predeterminado
    </button>
  );
}

/** Validation shared by the device address fields (cameras, OBD-II): raw TCP host or a port. */
export function tcpHostProblem(v: string): string | null {
  const h = v.trim().toLowerCase();
  if (!h) return 'Escribí el host o la IP.';
  if (/^[a-z]+:\/\//.test(h)) return 'Solo el host, sin http:// ni https:// (el equipo usa TCP).';
  if (h.endsWith('.devtunnels.ms')) return 'Los túneles de VS Code solo transmiten HTTP/HTTPS: no sirven para equipos TCP.';
  if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('.') || h.endsWith('.')) return 'Host inválido: sin puerto, barras ni espacios.';
  return null;
}

export function tcpPortProblem(v: string): string | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : 'Puerto entre 1 y 65535.';
}

/** One value with copy and its own edit (pencil → input → Guardar / Cancelar). */
export function EditableField({
  label,
  value,
  editValue,
  placeholder,
  numeric,
  emptyAllowed,
  validate,
  onSave,
}: {
  label: string;
  value: string;
  /** Initial text of the input (defaults to value). */
  editValue?: string;
  placeholder?: string;
  numeric?: boolean;
  /** Allow saving an empty value (e.g. «same as the positions host»). */
  emptyAllowed?: boolean;
  validate: (v: string) => string | null;
  onSave: (v: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const problem = emptyAllowed && !draft.trim() ? null : validate(draft);

  const save = async () => {
    if (problem) return;
    setBusy(true);
    const ok = await onSave(draft.trim());
    setBusy(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div className="bg-[#0B1120] border border-sky-600/60 rounded-lg px-3 py-2 min-w-0 space-y-1">
        <label className="block text-[11px] text-slate-400" htmlFor={`edit-${label}`}>
          {label}
        </label>
        <input
          id={`edit-${label}`}
          autoFocus
          value={draft}
          inputMode={numeric ? 'numeric' : undefined}
          placeholder={placeholder}
          aria-invalid={Boolean(problem)}
          onChange={(e) => setDraft(numeric ? e.target.value.replace(/\D/g, '').slice(0, 5) : e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-full px-2 py-1 bg-[#0F172A] border border-slate-700 rounded-md font-mono text-sm text-slate-100 focus:outline-none focus:border-sky-500"
        />
        {problem && draft && <div className="text-[11px] text-rose-300">{problem}</div>}
        <div className="flex justify-end gap-1.5">
          <button type="button" onClick={() => setEditing(false)} className="px-2 py-0.5 rounded text-[11px] text-slate-300 hover:bg-slate-800 cursor-pointer">
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy || Boolean(problem)}
            onClick={() => void save()}
            className="px-2 py-0.5 rounded text-[11px] font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#0B1120] border border-slate-800 rounded-lg px-3 py-2 min-w-0">
      <div className="text-[11px] text-slate-400 truncate">{label}</div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm text-slate-100 truncate" title={value}>
          {value}
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
            aria-label={`Copiar ${label}`}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(editValue ?? value);
              setEditing(true);
            }}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
            aria-label={`Editar ${label}`}
            title={`Editar ${label}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>
    </div>
  );
}
