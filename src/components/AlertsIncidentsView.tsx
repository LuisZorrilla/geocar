import { useEffect, useRef, useState } from 'react';
import {
  AlertOctagon,
  ArrowUpRight,
  Check,
  Film,
  Plus,
  ShieldAlert,
  Sliders,
} from 'lucide-react';
import type {
  AlertEvent,
  AlertPriority,
  AlertRule,
  Incident,
  IncidentStatus,
  RoleDefinition,
  Tenant,
} from '../shared/types.ts';
import {
  ALERT_STATUS_META,
  formatRelativeTime,
  INCIDENT_STATUS_META,
  PRIORITY_META,
} from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';
import { ExportMenu } from './ExportMenu.tsx';

interface AlertsIncidentsViewProps {
  alerts: AlertEvent[];
  incidents: Incident[];
  alertRules: AlertRule[];
  activeRole: RoleDefinition;
  onAcknowledgeAlert: (alertId: string) => Promise<void>;
  onEscalateAlert: (alertId: string) => Promise<void>;
  onUpdateIncident: (
    incidentId: string,
    patch: { status?: IncidentStatus; resolutionNote?: string }
  ) => Promise<void>;
  onToggleRule: (ruleId: string) => Promise<void>;
  onCreateRule: (payload: {
    name: string;
    conditionType: AlertRule['conditionType'];
    thresholdLabel: string;
    priority: AlertPriority;
    autoCreateClip: boolean;
  }) => Promise<void>;
  onOpenClip: (clipId: string) => void;
  /** Alert to show and highlight on arrival (from «En alerta» in Monitoreo en Vivo). */
  focusAlertId?: string | null;
}

export function AlertsIncidentsView({
  alerts,
  incidents,
  alertRules,
  activeRole,
  onAcknowledgeAlert,
  onEscalateAlert,
  onUpdateIncident,
  onToggleRule,
  onCreateRule,
  onOpenClip,
  focusAlertId,
}: AlertsIncidentsViewProps) {
  const [tab, setTab] = useState<'alertas' | 'incidentes' | 'reglas'>('alertas');
  const [priorityFilter, setPriorityFilter] = useState<'all' | AlertPriority>('all');
  const [editingIncidentId, setEditingIncidentId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [statusDraft, setStatusDraft] = useState<IncidentStatus>('en_investigacion');
  const [newRuleOpen, setNewRuleOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    name: '',
    conditionType: 'velocidad' as AlertRule['conditionType'],
    thresholdLabel: '> 90 km/h durante 20 s',
    priority: 'alta' as AlertPriority,
    autoCreateClip: true,
  });

  const canOperateAlerts = activeRole.permissions.alertas === 'full' || activeRole.permissions.alertas === 'write';
  const canOperateIncidents =
    activeRole.permissions.incidentes === 'full' || activeRole.permissions.incidentes === 'write';

  const filteredAlerts = alerts.filter(
    (a) => priorityFilter === 'all' || a.priority === priorityFilter
  );

  const alertsPagination = usePagination(filteredAlerts, `${priorityFilter}|${alerts.length}`, 5);
  const incidentsPagination = usePagination(incidents, `${incidents.length}`, 5);
  const rulesPagination = usePagination(alertRules, `${alertRules.length}`, 5);

  // Coming from «En alerta»: open the queue on the page holding that alert, scroll to it and highlight it.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focusedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focusAlertId) return;
    const idx = alerts.findIndex((a) => a.id === focusAlertId);
    if (idx < 0) return;
    setTab('alertas');
    setPriorityFilter('all');
    alertsPagination.setPage(Math.floor(idx / 5) + 1);
    setHighlightId(focusAlertId);
    const t = window.setTimeout(() => setHighlightId(null), 6000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAlertId]);
  useEffect(() => {
    if (highlightId) focusedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, alertsPagination.page]);

  const handleSaveIncident = async (incidentId: string) => {
    await onUpdateIncident(incidentId, { status: statusDraft, resolutionNote: noteDraft });
    setEditingIncidentId(null);
  };

  const handleCreateRuleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleForm.name.trim()) return;
    await onCreateRule(ruleForm);
    setNewRuleOpen(false);
    setRuleForm((prev) => ({ ...prev, name: '' }));
  };

  return (
    <div className="space-y-5">
      {/* Segmented header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-[#11192C] border border-slate-800/80 rounded-xl p-3.5">
        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800">
          {(
            [
              { id: 'alertas', label: `Bandeja de Alertas (${alerts.length})` },
              { id: 'incidentes', label: `Incidentes (${incidents.length})` },
              { id: 'reglas', label: `Motor de Reglas (${alertRules.length})` },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                tab === t.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'alertas' && (
          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'critica', 'alta', 'media', 'informativa'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriorityFilter(p)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  priorityFilter === p
                    ? 'bg-slate-800 text-slate-100 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {p === 'all' ? 'Todas' : PRIORITY_META[p].label}
              </button>
            ))}
          </div>
        )}

        {tab !== 'reglas' && (
          <ExportMenu
            url="/api/alerts/export"
            label="Exportar alertas e incidentes"
            params={{ priority: priorityFilter === 'all' ? undefined : priorityFilter }}
            count={filteredAlerts.length}
            filtered={priorityFilter !== 'all'}
            fileName="alertas"
          />
        )}

        {tab === 'reglas' && (
          <button
            type="button"
            disabled={!canOperateAlerts}
            onClick={() => setNewRuleOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Nueva regla RabbitMQ
          </button>
        )}
      </div>

      {/* Tab 1: Alerts Queue */}
      {tab === 'alertas' && (
        <div className="space-y-3">
          {filteredAlerts.length === 0 ? (
            <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-8 text-center text-xs text-slate-400">
              No hay alertas registradas para este filtro.
            </div>
          ) : (
            <>
              {alertsPagination.pagedItems.map((alert) => {
                const prio = PRIORITY_META[alert.priority];
                const st = ALERT_STATUS_META[alert.status];
                return (
                  <div
                    key={alert.id}
                    ref={alert.id === highlightId ? focusedRef : undefined}
                    className={`bg-[#11192C] border rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition-colors ${
                      alert.id === highlightId ? 'border-rose-500/70 ring-2 ring-rose-500/30' : 'border-slate-800/80'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`font-semibold ${prio.colorClass}`}>Prioridad {prio.label}</span>
                        <span className="text-slate-600">·</span>
                        <span className="font-mono text-slate-300">{alert.unitCode}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-400">{alert.driverName}</span>
                        <span className="text-slate-600">·</span>
                        <span className="font-mono tabular-nums text-slate-400">
                          {formatRelativeTime(alert.timestamp)}
                        </span>
                      </div>
                      <h4 className="text-sm font-semibold text-slate-100">{alert.ruleName}</h4>
                      <p className="text-xs text-slate-400">{alert.summary}</p>
                      <div className="text-xs font-mono tabular-nums text-slate-500 pt-0.5">
                        Estado: <span className={st.colorClass}>{st.label}</span> · {alert.speedKmh} km/h ·{' '}
                        {alert.lat.toFixed(4)}, {alert.lng.toFixed(4)}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {alert.clipId && (
                        <button
                          type="button"
                          onClick={() => onOpenClip(alert.clipId!)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
                        >
                          <Film className="w-3.5 h-3.5 text-sky-400" />
                          Ver clip {alert.clipId}
                        </button>
                      )}

                      {alert.status === 'pendiente' && (
                        <button
                          type="button"
                          disabled={!canOperateAlerts}
                          onClick={() => onAcknowledgeAlert(alert.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 disabled:opacity-40 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Confirmar
                        </button>
                      )}

                      {alert.status !== 'escalada' && (
                        <button
                          type="button"
                          disabled={!canOperateIncidents}
                          onClick={() => onEscalateAlert(alert.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 disabled:opacity-40 cursor-pointer"
                        >
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          Escalar a incidente
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
                <Pagination
                  page={alertsPagination.page}
                  totalItems={alertsPagination.totalItems}
                  pageSize={5}
                  onPageChange={alertsPagination.setPage}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Tab 2: Incidents */}
      {tab === 'incidentes' && (
        <div className="space-y-3">
          {incidentsPagination.pagedItems.map((inc) => {
            const st = INCIDENT_STATUS_META[inc.status];
            const prio = PRIORITY_META[inc.priority];
            const isEditing = editingIncidentId === inc.id;
            return (
              <div key={inc.id} className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-3">
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-slate-300">{inc.id}</span>
                      <span className="text-slate-600">·</span>
                      <span className={`font-medium ${prio.colorClass}`}>{prio.label}</span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-400">
                        {inc.unitCode} ({inc.plate})
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-400">Responsable: {inc.assignee}</span>
                    </div>
                    <h4 className="text-sm font-semibold text-slate-100">{inc.title}</h4>
                    <p className="text-xs text-slate-300">{inc.resolutionNote}</p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs font-medium ${st.colorClass}`}>{st.label}</span>
                    {inc.clipId && (
                      <button
                        type="button"
                        onClick={() => onOpenClip(inc.clipId!)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
                      >
                        <Film className="w-3.5 h-3.5 text-sky-400" />
                        Evidencia
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!canOperateIncidents}
                      onClick={() => {
                        setEditingIncidentId(isEditing ? null : inc.id);
                        setNoteDraft(inc.resolutionNote);
                        setStatusDraft(inc.status);
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer"
                    >
                      {isEditing ? 'Cerrar' : 'Gestionar caso'}
                    </button>
                  </div>
                </div>

                {isEditing && (
                  <div className="pt-3 border-t border-slate-800 space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                      <div>
                        <label className="block text-slate-400 mb-1">Nuevo estado</label>
                        <select
                          value={statusDraft}
                          onChange={(e) => setStatusDraft(e.target.value as IncidentStatus)}
                          className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                        >
                          <option value="abierto">Abierto</option>
                          <option value="en_investigacion">En investigación</option>
                          <option value="escalado">Escalado</option>
                          <option value="resuelto">Resuelto</option>
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-slate-400 mb-1">Bitácora de seguimiento y resolución</label>
                        <input
                          type="text"
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleSaveIncident(inc.id)}
                        className="px-4 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
                      >
                        Guardar actualización auditada
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <Pagination
              page={incidentsPagination.page}
              totalItems={incidentsPagination.totalItems}
              pageSize={5}
              onPageChange={incidentsPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* Tab 3: Alert Rules Engine */}
      {tab === 'reglas' && (
        <div className="space-y-4">
          {newRuleOpen && (
            <form
              onSubmit={handleCreateRuleSubmit}
              className="bg-[#11192C] border border-sky-500/40 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <Sliders className="w-4 h-4 text-sky-400" />
                Configurar nueva regla en motor de eventos
              </div>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <input
                  type="text"
                  placeholder="Nombre de la regla (ej. Velocidad urbana > 60 km/h)"
                  value={ruleForm.name}
                  onChange={(e) => setRuleForm((p) => ({ ...p, name: e.target.value }))}
                  className="md:col-span-2 px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <select
                  value={ruleForm.conditionType}
                  onChange={(e) =>
                    setRuleForm((p) => ({
                      ...p,
                      conditionType: e.target.value as AlertRule['conditionType'],
                    }))
                  }
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="velocidad">Exceso de velocidad</option>
                  <option value="colision_g">Frenado / G-Sensor</option>
                  <option value="fatiga_dms">Fatiga DMS</option>
                  <option value="geocerca">Geocerca operativa</option>
                  <option value="desconexion_cam">Desconexión cámara</option>
                  <option value="panico">Botón pánico</option>
                  <option value="licencia_vencimiento">Vigencia de licencia</option>
                </select>
                <input
                  type="text"
                  placeholder="Umbral (ej. > 60 km/h / 10 s)"
                  value={ruleForm.thresholdLabel}
                  onChange={(e) => setRuleForm((p) => ({ ...p, thresholdLabel: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <select
                  value={ruleForm.priority}
                  onChange={(e) => setRuleForm((p) => ({ ...p, priority: e.target.value as AlertPriority }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="critica">Crítica</option>
                  <option value="alta">Alta</option>
                  <option value="media">Media</option>
                  <option value="informativa">Informativa</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ruleForm.autoCreateClip}
                    onChange={(e) => setRuleForm((p) => ({ ...p, autoCreateClip: e.target.checked }))}
                    className="rounded border-slate-700 bg-[#0B1120]"
                  />
                  Solicitar clip automático JT1078 al disparar evento
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setNewRuleOpen(false)}
                    className="px-3 py-1.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium cursor-pointer"
                  >
                    Guardar regla
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                  <th className="py-3 px-4">Regla operativa</th>
                  <th className="py-3 px-4">Umbral de disparo</th>
                  <th className="py-3 px-4">Cola RabbitMQ</th>
                  <th className="py-3 px-4">Clip JT1078</th>
                  <th className="py-3 px-4">Prioridad</th>
                  <th className="py-3 px-4 text-right">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {rulesPagination.pagedItems.map((rule) => {
                  const prio = PRIORITY_META[rule.priority];
                  return (
                    <tr key={rule.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 font-medium text-slate-100">{rule.name}</td>
                      <td className="py-3 px-4 font-mono text-slate-300">{rule.thresholdLabel}</td>
                      <td className="py-3 px-4 font-mono text-slate-400">{rule.notifyQueue}</td>
                      <td className="py-3 px-4 text-slate-300">
                        {rule.autoCreateClip ? 'Automático 30s' : 'Solo telemetría'}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-medium ${prio.colorClass}`}>{prio.label}</span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          disabled={!canOperateAlerts}
                          onClick={() => onToggleRule(rule.id)}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium border cursor-pointer disabled:opacity-40 ${
                            rule.active
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                              : 'bg-slate-800 border-slate-700 text-slate-400'
                          }`}
                        >
                          {rule.active ? 'Activa' : 'Pausada'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination
              page={rulesPagination.page}
              totalItems={rulesPagination.totalItems}
              pageSize={5}
              onPageChange={rulesPagination.setPage}
            />
          </div>

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-sky-400" />
              Procesamiento asíncrono desacoplado: Outbox transaccional + cola de reintentos DLQ + clave de idempotencia por evento.
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-300 font-mono">
              <AlertOctagon className="w-3.5 h-3.5 text-amber-400" />
              DLQ: 0 mensajes retenidos
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
