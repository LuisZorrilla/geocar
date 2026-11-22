import { useMemo, useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, CircleHelp, Gauge, Pencil, RotateCcw, Search } from 'lucide-react';
import type { Device, DeviceConnectionSettings, RoleDefinition, UnmatchedDevice, Vehicle } from '../shared/types.ts';
import { apiRequest, formatRelativeTime } from '../lib/api.ts';
import { buildSetupSms } from '../shared/teltonika.ts';
import { obdHealth, obdLink, type ObdHealthLevel, type ObdLinkState } from '../shared/obdHealth.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { CopyField, EditableField, tcpHostProblem, tcpPortProblem } from './ConnectionView.tsx';
import { ObdConnectWizard, type ObdAssignPayload } from './ObdConnectWizard.tsx';
import { ObdUnitDetail } from './ObdUnitDetail.tsx';

export type { ObdAssignPayload };

interface Props {
  vehicles: Vehicle[];
  devices: Device[];
  deviceConnection: DeviceConnectionSettings;
  unmatchedDevices?: UnmatchedDevice[];
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  onAssign: (vehicleId: string, payload: ObdAssignPayload) => Promise<boolean>;
  onRemove: (vehicleId: string) => Promise<boolean>;
  onRefresh: (vehicleId: string) => Promise<void>;
  onSync: (vehicleId: string) => Promise<boolean>;
  onCommand: (vehicleId: string, commandId: string, option?: string) => Promise<boolean>;
  onNotify: (kind: 'ok' | 'err', message: string) => void;
  /** New connection settings after the superadmin edits the OBD server. */
  onDeviceConnectionChange: (dc: DeviceConnectionSettings) => void;
}

const LINK_CLS: Record<ObdLinkState, string> = {
  sin_equipo: 'text-slate-500',
  manual: 'text-amber-300',
  error: 'text-rose-300',
  esperando: 'text-amber-300',
  conectado: 'text-emerald-300',
  sin_senal: 'text-rose-300',
};

const HEALTH_CHIP: Record<ObdHealthLevel, { cls: string; Icon: typeof CheckCircle2 }> = {
  bien: { cls: 'text-emerald-300', Icon: CheckCircle2 },
  atencion: { cls: 'text-amber-300', Icon: AlertTriangle },
  critico: { cls: 'text-rose-300', Icon: AlertOctagon },
  sin_datos: { cls: 'text-slate-500', Icon: CircleHelp },
};

type QuickFilter = 'todas' | 'con_obd' | 'con_fallas' | 'sin_senal';
const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: 'todas', label: 'Todas' },
  { id: 'con_obd', label: 'Con OBD' },
  { id: 'con_fallas', label: 'Con fallas' },
  { id: 'sin_senal', label: 'Sin señal' },
];

/** «Telemetría OBD-II» tab: how to program the trackers and the engine data of each unit. */
export function ObdTelemetryView({
  vehicles,
  devices,
  deviceConnection,
  unmatchedDevices,
  activeRole,
  isGlobalSuperadmin,
  onAssign,
  onRemove,
  onRefresh,
  onSync,
  onCommand,
  onNotify,
  onDeviceConnectionChange,
}: Props) {
  const canEdit =
    Boolean(isGlobalSuperadmin) || activeRole.permissions.dashcams_config === 'full' || activeRole.permissions.dashcams_config === 'write';
  const hostLabel = deviceConnection.obdHost ?? '<dominio-del-VPS>';
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [quick, setQuick] = useState<QuickFilter>('todas');

  const obdById = useMemo(() => new Map(devices.filter((d) => d.role === 'telemetria').map((d) => [d.id, d])), [devices]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...vehicles]
      .sort((a, b) => Number(Boolean(b.obdDeviceId)) - Number(Boolean(a.obdDeviceId)) || a.unitCode.localeCompare(b.unitCode))
      .filter((v) => {
        const dev = v.obdDeviceId ? obdById.get(v.obdDeviceId) : undefined;
        if (quick === 'con_obd') return Boolean(dev);
        if (quick === 'con_fallas') return v.faultCodes.some((f) => f.source === 'obd' || f.source === 'can');
        if (quick === 'sin_senal') return Boolean(dev) && obdLink(dev).state !== 'conectado';
        return true;
      });
    if (!q) return list;
    return list.filter((v) => {
      const dev = v.obdDeviceId ? obdById.get(v.obdDeviceId) : undefined;
      return [v.unitCode, v.plate, v.brandModel, v.vin, dev?.imei, ...v.faultCodes.map((f) => f.code)].some((x) => x?.toLowerCase().includes(q));
    });
  }, [vehicles, obdById, search, quick]);
  const pagination = usePagination(rows, `${search}|${quick}|${vehicles.length}`, 8);

  const installed = vehicles.filter((v) => v.obdDeviceId).length;
  const live = vehicles.filter((v) => v.telemetrySourceEngine === 'obd').length;
  const lightVehicles = vehicles.filter((v) => v.assetType === 'vehiculo');
  const unmatchedImeis = (unmatchedDevices ?? []).filter((u) => /^\d{15}$/.test(u.uniqueId));
  const editingVehicle = vehicles.find((v) => v.id === editingId);
  const detailVehicle = vehicles.find((v) => v.id === detailId);
  const smsTemplate = buildSetupSms({ apn: '<APN>', host: hostLabel, port: deviceConnection.obdPort });

  const steps = [
    {
      title: '1. Compatibilidad',
      body: (
        <>
          Vehículos <b>livianos</b> con conector OBD-II: nafta desde 2009–2011 (Euro 4) y diésel livianos recientes. Camiones y maquinaria{' '}
          <b>no tienen OBD-II</b>: usan bus CAN J1939, con un equipo como el FMC650.
        </>
      ),
    },
    {
      title: '2. Instalación',
      body: (
        <>
          Enchufar el <b>Teltonika FMC003</b> en el conector OBD (16 pines, debajo del volante) y colocar una <b>SIM con datos 4G</b>. No usa el
          WiFi del Starlink: sale por celular y guarda los datos si no hay cobertura.
        </>
      ),
    },
    {
      title: '3. Alta desde el panel',
      body: (
        <>
          Con el lápiz de la unidad cargá el <b>IMEI</b> y el operador de la SIM. El panel lo da de alta en Traccar y arma el <b>SMS de
          programación</b> (servidor, puerto {deviceConnection.obdPort}, TCP, Codec 8 Extended y APN) para mandarlo desde un celular.
        </>
      ),
    },
    {
      title: '4. Seguimiento',
      body: (
        <>
          Al primer reporte la unidad pasa a <b className="text-emerald-300">Conectado</b>. Tocá la fila para ver gráficos, salud, historial de
          fallas y mandar <b>comandos remotos</b>. Un código de falla genera una <b>alerta</b> y una <b>OT correctiva</b>.
        </>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-100">Datos para programar los OBD-II (Teltonika)</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
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
              {installed} de {vehicles.length} con OBD · {live} con datos reales
            </span>
          </div>
        </div>
        {!deviceConnection.obdHost && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Falta configurar <span className="font-mono">DEVICE_SERVER_HOST</span> en el servidor. Hasta entonces los equipos no tienen a dónde
              conectarse.
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {isGlobalSuperadmin ? (
            <ObdServerEditor deviceConnection={deviceConnection} onNotify={onNotify} onChange={onDeviceConnectionChange} />
          ) : (
            <>
              <CopyField label={`Servidor (host)${deviceConnection.obdServerCustom ? ' · personalizado' : ''}`} value={hostLabel} />
              <CopyField label="Puerto (TCP)" value={String(deviceConnection.obdPort)} />
            </>
          )}
          <CopyField label="Protocolo de datos" value="Codec 8 Extended" />
          <CopyField label="SMS de programación (plantilla)" value={smsTemplate} />
        </div>
        {deviceConnection.obdServerCustom && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-sky-300/80">
            <span>
              Datos personalizados. Tienen que llegar al puerto {deviceConnection.teltonikaPort} de Traccar. Los equipos ya programados no cambian
              solos: hay que reenviarles el SMS.
            </span>
            {isGlobalSuperadmin && <RestoreObdServer deviceConnection={deviceConnection} onNotify={onNotify} onChange={onDeviceConnectionChange} />}
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          El asistente de cada unidad completa el APN. El SMS empieza con dos espacios (usuario y clave vacíos). Parámetros Teltonika: 2001 APN,
          2004 servidor, 2005 puerto, 2006 protocolo (0 = TCP), 113 codec (1 = Codec 8 Extended); confirmalos en el wiki para tu firmware. Alternativa:
          Teltonika Configurator por USB con los mismos datos.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5 text-xs text-slate-300 leading-relaxed">
            <div className="text-sm font-semibold text-slate-100 mb-1.5">{s.title}</div>
            {s.body}
          </div>
        ))}
      </div>

      {canEdit && unmatchedImeis.length > 0 && (
        <div className="bg-[#11192C] border border-amber-500/30 rounded-xl p-4 space-y-2.5">
          <div className="text-sm font-semibold text-amber-200">Equipos OBD-II detectados sin asignar ({unmatchedImeis.length})</div>
          <p className="text-xs text-slate-400">Traccar reporta estos IMEI pero ninguna unidad los tiene. Asignalos para recibir sus datos de motor.</p>
          <div className="divide-y divide-slate-800">
            {unmatchedImeis.map((u) => (
              <div key={u.uniqueId} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <span className="font-mono text-slate-100">{u.uniqueId}</span>
                  {u.name ? <span className="text-slate-400"> · {u.name}</span> : null}
                  <span className="text-slate-500"> · visto {formatRelativeTime(u.lastSeenAt)}</span>
                </div>
                {assignFor === u.uniqueId ? (
                  <select
                    autoFocus
                    aria-label="Unidad a la que se asigna el equipo OBD-II"
                    defaultValue=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      if (await onAssign(e.target.value, { imei: u.uniqueId, catalogModelId: 'teltonika-fmc003' })) setAssignFor(null);
                    }}
                    className="px-2 py-1 bg-[#0B1120] border border-slate-700 rounded-lg text-slate-100"
                  >
                    <option value="" disabled>
                      Elegir unidad…
                    </option>
                    {lightVehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.unitCode} · {v.plate}
                        {v.obdDeviceId ? ' (reemplaza el actual)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAssignFor(u.uniqueId)}
                    className="px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 cursor-pointer"
                  >
                    Asignar a unidad
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-medium text-slate-200">Telemetría por unidad ({rows.length})</div>
            <div role="group" aria-label="Filtro rápido" className="inline-flex rounded-lg border border-slate-700 overflow-hidden text-xs">
              {QUICK_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={quick === f.id}
                  onClick={() => setQuick(f.id)}
                  className={`px-2.5 py-1 cursor-pointer ${quick === f.id ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Unidad, patente, IMEI, VIN, código…"
              aria-label="Buscar telemetría por unidad"
              className="pl-8 pr-3 py-1.5 w-64 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400 bg-[#0F172A]">
              <tr>
                <th className="text-left font-medium px-4 py-2">Unidad</th>
                <th className="text-left font-medium px-4 py-2">Equipo OBD-II</th>
                <th className="text-left font-medium px-4 py-2">Conexión</th>
                <th className="text-left font-medium px-4 py-2">Salud</th>
                <th className="text-left font-medium px-4 py-2">VIN</th>
                <th className="text-right font-medium px-3 py-2">RPM</th>
                <th className="text-right font-medium px-3 py-2">Temp.</th>
                <th className="text-right font-medium px-3 py-2">Combust.</th>
                <th className="text-right font-medium px-3 py-2">Batería</th>
                <th className="text-right font-medium px-3 py-2">Odómetro</th>
                <th className="text-left font-medium px-4 py-2">Fallas activas</th>
                <th className="text-left font-medium px-4 py-2">Fuente</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {pagination.pagedItems.map((v) => {
                const dev = v.obdDeviceId ? obdById.get(v.obdDeviceId) : undefined;
                const real = v.telemetrySourceEngine === 'obd';
                const heavy = v.assetType === 'maquinaria_pesada';
                const link = obdLink(dev);
                const health = obdHealth(v);
                const HealthIcon = HEALTH_CHIP[health.level].Icon;
                return (
                  <tr
                    key={v.id}
                    onClick={() => dev && setDetailId(v.id)}
                    className={`text-slate-200 align-top ${dev ? 'cursor-pointer hover:bg-slate-800/40' : ''}`}
                  >
                    <td className="px-4 py-2 whitespace-nowrap">
                      <div className="font-medium">{v.unitCode}</div>
                      <div className="text-slate-500">{v.plate}</div>
                    </td>
                    <td className="px-4 py-2">
                      {dev ? (
                        <>
                          <div className="font-mono">{dev.imei}</div>
                          <div className="text-slate-500">{dev.model}</div>
                        </>
                      ) : heavy ? (
                        <span className="text-slate-500">Usa CAN J1939</span>
                      ) : (
                        <span className="text-slate-500">Sin OBD</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className={LINK_CLS[link.state]}>{link.label}</span>
                      {link.state === 'sin_senal' && dev?.lastObdAt && <div className="text-slate-500">{formatRelativeTime(dev.lastObdAt)}</div>}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 ${HEALTH_CHIP[health.level].cls}`} title={health.reasons.join('\n') || undefined}>
                        <HealthIcon className="w-3.5 h-3.5" aria-hidden /> {health.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-300">{v.vin ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.rpm.toLocaleString('es-AR')}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${v.coolantTempC >= 105 ? 'text-rose-300' : ''}`}>{v.coolantTempC} °C</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${v.fuelLevelPct < 15 ? 'text-amber-300' : ''}`}>{v.fuelLevelPct} %</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${v.batteryVoltage !== undefined && v.batteryVoltage < 11.8 ? 'text-amber-300' : ''}`}>
                      {v.batteryVoltage !== undefined ? `${v.batteryVoltage.toLocaleString('es-AR')} V` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{Math.round(v.odometerKm).toLocaleString('es-AR')} km</td>
                    <td className="px-4 py-2">
                      {v.faultCodes.length ? (
                        <div className="flex flex-wrap gap-1 max-w-[220px]">
                          {v.faultCodes.map((f) => (
                            <span
                              key={f.code}
                              title={`${f.description} · ${f.system}`}
                              className={`px-1.5 py-0.5 rounded font-mono border ${
                                f.severity === 'critica'
                                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                                  : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                              }`}
                            >
                              {f.code}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-500">Sin fallas</span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {real ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                          <Gauge className="w-3 h-3" aria-hidden /> OBD-II en vivo
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">Simulada</span>
                      )}
                      {dev?.lastObdAt && <div className="text-slate-500 mt-0.5">{formatRelativeTime(dev.lastObdAt)}</div>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        disabled={!canEdit}
                        title={!canEdit ? 'Tu perfil es de solo lectura' : dev ? 'Editar equipo OBD-II' : 'Asignar equipo OBD-II'}
                        onClick={() => setEditingId(v.id)}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                        aria-label={`${dev ? 'Editar' : 'Asignar'} equipo OBD-II de ${v.unitCode}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {dev && (
                        <button
                          type="button"
                          onClick={() => setDetailId(v.id)}
                          title="Ver seguimiento"
                          aria-label={`Ver seguimiento OBD-II de ${v.unitCode}`}
                          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination page={pagination.page} totalItems={pagination.totalItems} pageSize={8} onPageChange={pagination.setPage} />
      </div>

      {editingVehicle && (
        <ObdConnectWizard
          vehicle={editingVehicle}
          device={editingVehicle.obdDeviceId ? obdById.get(editingVehicle.obdDeviceId) : undefined}
          deviceConnection={deviceConnection}
          onClose={() => setEditingId(null)}
          onSave={(p) => onAssign(editingVehicle.id, p)}
          onRemove={() => onRemove(editingVehicle.id)}
          onRefresh={() => onRefresh(editingVehicle.id)}
          onSync={() => onSync(editingVehicle.id)}
        />
      )}

      {detailVehicle && !editingVehicle && (
        <ObdUnitDetail
          vehicle={detailVehicle}
          device={detailVehicle.obdDeviceId ? obdById.get(detailVehicle.obdDeviceId) : undefined}
          canEdit={canEdit}
          onClose={() => setDetailId(null)}
          onEdit={() => setEditingId(detailVehicle.id)}
          onRefresh={() => onRefresh(detailVehicle.id)}
          onSync={() => onSync(detailVehicle.id)}
          onCommand={(id, option) => onCommand(detailVehicle.id, id, option)}
        />
      )}
    </div>
  );
}

/**
 * Superadmin: the OBD-II host and port are edited on their own. The Teltonika protocol is raw TCP,
 * so HTTP tunnels (VS Code devtunnels) are rejected.
 */
function ObdServerEditor({
  deviceConnection: dc,
  onNotify,
  onChange,
}: {
  deviceConnection: DeviceConnectionSettings;
  onNotify: (kind: 'ok' | 'err', message: string) => void;
  onChange: (dc: DeviceConnectionSettings) => void;
}) {
  const saveField = async (patch: Partial<{ host: string; port: number }>, what: string): Promise<boolean> => {
    const host = patch.host ?? dc.obdHost;
    if (!host) {
      onNotify('err', 'Primero cargá el servidor (host) de los OBD-II.');
      return false;
    }
    try {
      const res = await apiRequest<{ deviceConnection: DeviceConnectionSettings }>('/api/settings/obd-server', {
        method: 'PUT',
        body: JSON.stringify({ server: { host, port: patch.port ?? dc.obdPort } }),
      });
      onChange(res.deviceConnection);
      onNotify('ok', `${what} actualizado.`);
      return true;
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'No se pudo guardar.');
      return false;
    }
  };

  return (
    <>
      <EditableField
        label={`Servidor (host)${dc.obdServerCustom ? ' · personalizado' : ''}`}
        value={dc.obdHost ?? '<dominio-del-VPS>'}
        editValue={dc.obdHost ?? ''}
        placeholder="190.176.56.76 o 0.tcp.sa.ngrok.io"
        validate={tcpHostProblem}
        onSave={(v) => saveField({ host: v.toLowerCase() }, 'Servidor de los OBD-II')}
      />
      <EditableField
        label="Puerto (TCP)"
        value={String(dc.obdPort)}
        numeric
        validate={tcpPortProblem}
        onSave={(v) => saveField({ port: Number(v) }, 'Puerto de los OBD-II')}
      />
    </>
  );
}

function RestoreObdServer({
  deviceConnection: dc,
  onNotify,
  onChange,
}: {
  deviceConnection: DeviceConnectionSettings;
  onNotify: (kind: 'ok' | 'err', message: string) => void;
  onChange: (dc: DeviceConnectionSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`¿Volver a ${dc.host ?? 'DEVICE_SERVER_HOST'}:${dc.teltonikaPort}?`)) return;
        setBusy(true);
        try {
          const res = await apiRequest<{ deviceConnection: DeviceConnectionSettings }>('/api/settings/obd-server', {
            method: 'PUT',
            body: JSON.stringify({ server: null }),
          });
          onChange(res.deviceConnection);
          onNotify('ok', 'Se restauró el servidor predeterminado de los OBD-II.');
        } catch (err) {
          onNotify('err', err instanceof Error ? err.message : 'No se pudo restaurar.');
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
