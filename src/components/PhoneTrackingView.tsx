import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import { AlertTriangle, BatteryCharging, BatteryLow, BatteryMedium, Pencil, Search, Smartphone } from 'lucide-react';
import type { DeviceConnectionSettings, PhoneListItem, PhonePlatform, RoleDefinition } from '../shared/types.ts';
import { apiRequest, formatRelativeTime } from '../lib/api.ts';
import { phoneLink, PHONE_LOW_BATTERY_PCT, PLATFORM_LABELS, type PhoneLinkState } from '../shared/phone.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { CopyField } from './ConnectionView.tsx';
import { PhoneConnectWizard } from './PhoneConnectWizard.tsx';
import { ClientConfigQrButton } from './ClientConfigQr.tsx';

interface Props {
  deviceConnection: DeviceConnectionSettings;
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  /** Changes when the company scope changes (reloads the list). */
  scopeKey: string;
  companyName?: string;
  onNotify: (kind: 'ok' | 'err', message: string) => void;
  /** New connection settings after the superadmin edits the Server URL. */
  onDeviceConnectionChange: (dc: DeviceConnectionSettings) => void;
}

const LINK_CLS: Record<PhoneLinkState, string> = {
  sin_celular: 'text-slate-500',
  manual: 'text-amber-300',
  error: 'text-rose-300',
  esperando: 'text-amber-300',
  conectado: 'text-emerald-300',
  sin_senal: 'text-rose-300',
};

type QuickFilter = 'todos' | 'con_celular' | 'sin_senal' | 'bateria_baja';
const QUICK: { id: QuickFilter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'con_celular', label: 'Con celular' },
  { id: 'sin_senal', label: 'Sin señal' },
  { id: 'bateria_baja', label: 'Batería baja' },
];

/** «Conexión Smartphone» tab: drivers' phones running Traccar Client. */
export function PhoneTrackingView({ deviceConnection, activeRole, isGlobalSuperadmin, scopeKey, companyName, onNotify, onDeviceConnectionChange }: Props) {
  const canEdit =
    Boolean(isGlobalSuperadmin) || activeRole.permissions.dashcams_config === 'full' || activeRole.permissions.dashcams_config === 'write';
  const [phones, setPhones] = useState<PhoneListItem[] | null>(null);
  const [traccarApi, setTraccarApi] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState<QuickFilter>('todos');
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ phones: PhoneListItem[]; traccarApi: boolean }>('/api/phones');
      setPhones(res.phones);
      setTraccarApi(res.traccarApi);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la lista de celulares.');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(id);
  }, [load, scopeKey]);

  const act = async (fn: () => Promise<{ phones: PhoneListItem[] }>, ok: string, fail: string) => {
    try {
      const res = await fn();
      setPhones(res.phones);
      onNotify('ok', ok);
      return true;
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : fail);
      return false;
    }
  };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (phones ?? []).filter((p) => {
      const link = phoneLink(p.tracker);
      if (quick === 'con_celular' && !p.tracker) return false;
      if (quick === 'sin_senal' && !(p.tracker && link.state !== 'conectado')) return false;
      if (quick === 'bateria_baja' && !(typeof p.tracker?.batteryPct === 'number' && p.tracker.batteryPct < PHONE_LOW_BATTERY_PCT)) return false;
      if (!q) return true;
      return [p.driverName, p.driverPhone, p.tracker?.identifier, p.assignedVehicle?.unitCode, p.assignedVehicle?.plate, p.tenantName].some((x) =>
        x?.toLowerCase().includes(q)
      );
    });
  }, [phones, search, quick]);
  const pagination = usePagination(rows, `${search}|${quick}|${phones?.length ?? 0}`, 10);

  const withPhone = (phones ?? []).filter((p) => p.tracker).length;
  const online = (phones ?? []).filter((p) => phoneLink(p.tracker).state === 'conectado').length;
  const moving = (phones ?? []).filter((p) => p.assignedVehicle?.positionSource === 'smartphone').length;
  const serverUrl = deviceConnection.phoneServerUrl;
  const editing = phones?.find((p) => p.driverId === editingId);

  const steps = [
    {
      title: '1. Instalar Traccar Client',
      body: (
        <>
          App gratuita y oficial de Traccar, en <b>Google Play</b> y <b>App Store</b>. Celular con GPS, Android 8+ o iOS 15+, y plan de datos.
        </>
      ),
    },
    {
      title: '2. Dar de alta el celular',
      body: (
        <>
          Con el lápiz del chofer: el panel genera su <b>identificador</b> (GC-…) y lo da de alta en Traccar. Las instrucciones se comparten por{' '}
          <b>WhatsApp</b>.
        </>
      ),
    },
    {
      title: '3. Configurar la app',
      body: (
        <>
          Escanear el <b>QR</b> del chofer desde Traccar Client (Ajustes → Escanear código QR): carga identificador, Server URL y ajustes. A mano:
          Server URL <span className="font-mono">{serverUrl}</span>, precisión <b>High</b>. Activar «Service status».
        </>
      ),
    },
    {
      title: '4. Permisos y turno',
      body: (
        <>
          Ubicación <b>«Siempre»</b> y batería <b>sin restricciones</b>. Solo se usa la ubicación mientras el chofer tiene una <b>unidad asignada</b>;
          si la unidad tiene cámara u OBD reportando, manda el equipo.
        </>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-100">Datos para Traccar Client (celulares de choferes)</div>
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
              {withPhone} con celular · {online} conectados · {moving} unidades por celular
            </span>
          </div>
        </div>
        {(!deviceConnection.host || !traccarApi) && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {!deviceConnection.host && (
                <>
                  Falta <span className="font-mono">DEVICE_SERVER_HOST</span> en el servidor: los celulares no tienen a dónde conectarse.{' '}
                </>
              )}
              {!traccarApi && (
                <>
                  La API de Traccar no está configurada (<span className="font-mono">TRACCAR_WEB_URL</span>,{' '}
                  <span className="font-mono">TRACCAR_ADMIN_EMAIL</span>, <span className="font-mono">TRACCAR_ADMIN_PASSWORD</span>): habrá que crear
                  cada celular a mano en Traccar.
                </>
              )}
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {isGlobalSuperadmin ? (
            <ServerUrlEditor deviceConnection={deviceConnection} onNotify={onNotify} onChange={onDeviceConnectionChange} />
          ) : (
            <CopyField label={`Server URL (Traccar Client)${deviceConnection.phoneServerUrlCustom ? ' · personalizada' : ''}`} value={serverUrl} />
          )}
          <CopyField label="Puerto OsmAnd en Traccar (local)" value={String(deviceConnection.osmandPort)} />
          <CopyField label="Protocolo" value="OsmAnd (HTTP/HTTPS)" />
        </div>
        {deviceConnection.phoneServerUrlCustom && (
          <p className="text-[11px] text-slate-500">
            URL personalizada (túnel o proxy HTTPS). Debe reenviar al puerto {deviceConnection.osmandPort} de Traccar. Los celulares ya
            configurados no se actualizan solos: si cambia, hay que volver a escanear el QR (o cargar la nueva URL) en cada Traccar Client.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {steps.map((s) => (
          <div key={s.title} className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5 text-xs text-slate-300 leading-relaxed">
            <div className="text-sm font-semibold text-slate-100 mb-1.5">{s.title}</div>
            {s.body}
          </div>
        ))}
      </div>

      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-medium text-slate-200">Celulares de choferes ({rows.length})</div>
            <div role="group" aria-label="Filtro rápido" className="inline-flex rounded-lg border border-slate-700 overflow-hidden text-xs">
              {QUICK.map((f) => (
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
              placeholder="Chofer, unidad, identificador…"
              aria-label="Buscar celulares de choferes"
              className="pl-8 pr-3 py-1.5 w-64 bg-[#0B1120] border border-slate-800 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
        {error && <p className="px-4 py-2 text-xs text-rose-300">{error}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400 bg-[#0F172A]">
              <tr>
                <th className="text-left font-medium px-4 py-2">Chofer</th>
                <th className="text-left font-medium px-4 py-2">Unidad asignada</th>
                <th className="text-left font-medium px-4 py-2">Celular</th>
                <th className="text-left font-medium px-4 py-2">Conexión</th>
                <th className="text-left font-medium px-4 py-2">Batería</th>
                <th className="text-left font-medium px-4 py-2">Última posición</th>
                <th className="text-left font-medium px-4 py-2">Posición de la unidad</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {phones === null ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    Cargando…
                  </td>
                </tr>
              ) : pagination.pagedItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    No hay choferes con ese filtro.
                  </td>
                </tr>
              ) : (
                pagination.pagedItems.map((p) => {
                  const t = p.tracker;
                  const link = phoneLink(t);
                  const battery = t?.batteryPct;
                  const BatteryIcon = t?.charging ? BatteryCharging : typeof battery === 'number' && battery < PHONE_LOW_BATTERY_PCT ? BatteryLow : BatteryMedium;
                  return (
                    <tr key={p.driverId} className={`align-top ${p.enabled ? 'text-slate-200' : 'text-slate-500'}`}>
                      <td className="px-4 py-2">
                        <div className="font-medium">{p.driverName}</div>
                        <div className="text-slate-500">
                          {p.driverPhone}
                          {isGlobalSuperadmin && p.tenantName ? ` · ${p.tenantName}` : ''}
                          {!p.enabled ? ' · deshabilitado' : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {p.assignedVehicle ? (
                          <>
                            <div className="font-medium">{p.assignedVehicle.unitCode}</div>
                            <div className="text-slate-500">{p.assignedVehicle.plate}</div>
                          </>
                        ) : (
                          <span className="text-slate-500">Sin unidad asignada</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {t ? (
                          <>
                            <div className="font-mono">{t.identifier}</div>
                            <div className="text-slate-500 inline-flex items-center gap-1">
                              <Smartphone className="w-3 h-3" aria-hidden /> {PLATFORM_LABELS[t.platform]}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-500">Sin celular</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className={LINK_CLS[link.state]}>{link.label}</span>
                        {t?.lastSeenAt && <div className="text-slate-500">{formatRelativeTime(t.lastSeenAt)}</div>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {typeof battery === 'number' ? (
                          <span
                            className={`inline-flex items-center gap-1 ${battery < PHONE_LOW_BATTERY_PCT && !t?.charging ? 'text-amber-300' : ''}`}
                          >
                            <BatteryIcon className="w-3.5 h-3.5" aria-hidden /> {battery} %{t?.charging ? ' · cargando' : ''}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {t?.lastFix ? (
                          <>
                            <div className="font-mono text-slate-300">
                              {t.lastFix.lat.toFixed(5)}, {t.lastFix.lng.toFixed(5)}
                            </div>
                            <div className="text-slate-500">
                              {formatRelativeTime(t.lastFix.at)} · {Math.round(t.lastFix.speedKmh)} km/h
                              {typeof t.lastFix.accuracyM === 'number' ? ` · ±${t.lastFix.accuracyM} m` : ''}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-500">{t ? 'Sin datos todavía' : '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {!t ? (
                          <span className="text-slate-500">—</span>
                        ) : !p.assignedVehicle ? (
                          <span
                            title="El celular reporta, pero el chofer no tiene unidad asignada: la posición queda en el chofer y no mueve ninguna unidad. Asígnale una unidad en Choferes."
                            className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300"
                          >
                            Solo el chofer (sin unidad)
                          </span>
                        ) : p.assignedVehicle.positionSource === 'smartphone' ? (
                          <span className="px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300">Desde el celular</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">Desde el equipo</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {t && canEdit && (
                          <ClientConfigQrButton identifier={t.identifier} serverUrl={serverUrl} platform={t.platform} driverName={p.driverName} />
                        )}
                        <button
                          type="button"
                          disabled={!canEdit || (!p.enabled && !t)}
                          title={!canEdit ? 'Tu perfil es de solo lectura' : !p.enabled && !t ? 'Chofer deshabilitado' : t ? 'Configurar celular' : 'Conectar celular'}
                          onClick={() => setEditingId(p.driverId)}
                          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                          aria-label={`${t ? 'Configurar' : 'Conectar'} celular de ${p.driverName}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={pagination.page} totalItems={pagination.totalItems} pageSize={10} onPageChange={pagination.setPage} />
      </div>

      {editing && (
        <PhoneConnectWizard
          row={editing}
          deviceConnection={deviceConnection}
          companyName={companyName}
          onClose={() => setEditingId(null)}
          onSave={(platform: PhonePlatform, regenerate?: boolean) =>
            act(
              () =>
                apiRequest(`/api/drivers/${editing.driverId}/phone`, {
                  method: 'PUT',
                  body: JSON.stringify({ platform, regenerate }),
                }),
              regenerate ? 'Nuevo identificador generado.' : 'Celular guardado.',
              'No se pudo guardar el celular.'
            )
          }
          onRemove={() =>
            act(() => apiRequest(`/api/drivers/${editing.driverId}/phone`, { method: 'DELETE' }), 'Celular retirado.', 'No se pudo quitar el celular.')
          }
          onSync={() =>
            act(() => apiRequest(`/api/drivers/${editing.driverId}/phone/sync`, { method: 'POST' }), 'Alta en Traccar reintentada.', 'No se pudo dar de alta.')
          }
          onRefresh={load}
        />
      )}
    </div>
  );
}

/** Superadmin: edit the Server URL drivers type into Traccar Client (tunnel, HTTPS proxy). Empty = default. */
function ServerUrlEditor({
  deviceConnection,
  onNotify,
  onChange,
}: {
  deviceConnection: DeviceConnectionSettings;
  onNotify: (kind: 'ok' | 'err', message: string) => void;
  onChange: (dc: DeviceConnectionSettings) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(deviceConnection.phoneServerUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const save = async (url: string | null) => {
    setBusy(true);
    try {
      const res = await apiRequest<{ deviceConnection: DeviceConnectionSettings }>('/api/settings/phone-server-url', {
        method: 'PUT',
        body: JSON.stringify({ url }),
      });
      onChange(res.deviceConnection);
      setValue(res.deviceConnection.phoneServerUrl);
      setEditing(false);
      onNotify('ok', url === null ? 'Se restauró la URL predeterminada.' : 'URL de los celulares actualizada.');
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'No se pudo guardar la URL.');
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="bg-[#0B1120] border border-slate-800 rounded-lg px-3 py-2 min-w-0">
        <div className="text-[11px] text-slate-400">
          Server URL (Traccar Client){deviceConnection.phoneServerUrlCustom ? <span className="text-sky-300"> · personalizada</span> : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm text-slate-100 truncate" title={deviceConnection.phoneServerUrl}>
            {deviceConnection.phoneServerUrl}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard?.writeText(deviceConnection.phoneServerUrl).catch(() => undefined);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
              aria-label="Copiar Server URL"
              title={copied ? 'Copiado' : 'Copiar'}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => {
                setValue(deviceConnection.phoneServerUrl);
                setEditing(true);
              }}
              aria-label="Editar Server URL"
              title="Editar (túnel o proxy HTTPS)"
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" aria-hidden />
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#0B1120] border border-sky-600/60 rounded-lg px-3 py-2 min-w-0 space-y-1.5 sm:col-span-3">
      <label className="block text-[11px] text-slate-400" htmlFor="phone-server-url">
        Server URL para Traccar Client (por ejemplo, un túnel: https://xxxx-5055.brs.devtunnels.ms)
      </label>
      <input
        id="phone-server-url"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save(value.trim());
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder="https://..."
        className="w-full px-2.5 py-1.5 bg-[#0F172A] border border-slate-700 rounded-md font-mono text-sm text-slate-100 focus:outline-none focus:border-sky-500"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">
          Afecta a todas las empresas. Vacío o «Restaurar» vuelve a http://{deviceConnection.host ?? 'DEVICE_SERVER_HOST'}:{deviceConnection.osmandPort}.
        </span>
        <span className="flex gap-2">
          {deviceConnection.phoneServerUrlCustom && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-300 border border-slate-700 hover:bg-slate-800 cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3 h-3" aria-hidden /> Restaurar
            </button>
          )}
          <button type="button" onClick={() => setEditing(false)} className="px-2.5 py-1 rounded-md text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(value.trim() ? value.trim() : null)}
            className="px-2.5 py-1 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </span>
      </div>
    </div>
  );
}
