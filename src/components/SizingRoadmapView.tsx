import { useMemo, useState } from 'react';
import { CheckCircle2, Cpu, Database, HardDrive, Layers, Save, Server } from 'lucide-react';
import type { HostingModel, RoleDefinition, SizingConfig, VideoMode } from '../shared/types.ts';
import { Pagination, usePagination } from './Pagination.tsx';

interface SizingRoadmapViewProps {
  sizing: SizingConfig;
  activeRole: RoleDefinition;
  onSaveSizing: (patch: Partial<SizingConfig>) => Promise<void>;
}

const STAGE_STATUS_META = {
  completada: { label: 'Completada', colorClass: 'text-emerald-400' },
  en_progreso: { label: 'En progreso', colorClass: 'text-sky-400' },
  pendiente: { label: 'Planificada', colorClass: 'text-slate-400' },
} as const;

export function SizingRoadmapView({
  sizing,
  activeRole,
  onSaveSizing,
}: SizingRoadmapViewProps) {
  const [draft, setDraft] = useState<SizingConfig>(sizing);
  const [saving, setSaving] = useState(false);

  const canSave = activeRole.permissions.dimensionamiento === 'full';
  const stagesPagination = usePagination(sizing.stages, `${sizing.stages.length}`, 5);

  const metrics = useMemo(() => {
    const gpsMsgsPerMin = Math.round((draft.vehiclesCount * 60) / draft.gpsIntervalSec);
    const gpsStorageGbMonth = Number(((gpsMsgsPerMin * 60 * 24 * 30 * 0.45) / 1024 / 1024).toFixed(1));

    // Video calculation per vehicle/day in GB
    const gbPerVehicleDay =
      draft.videoMode === 'bajo_demanda'
        ? 0.28
        : draft.videoMode === 'clips_eventos'
          ? 0.85
          : 18.5; // 24/7 dual channel compressed

    const videoStorageGb = Math.round(draft.vehiclesCount * gbPerVehicleDay * draft.retentionDays);
    const videoStorageTb = Number((videoStorageGb / 1024).toFixed(2));

    const peakVideoMbps = Number(
      (
        draft.concurrentUsers * 1.8 +
        (draft.videoMode === 'grabacion_continua' ? draft.vehiclesCount * 0.9 : draft.vehiclesCount * 0.08)
      ).toFixed(1)
    );

    const isPilotScale = draft.vehiclesCount <= 150 && draft.videoMode !== 'grabacion_continua';
    const recommendedVcpu = isPilotScale ? 8 : Math.max(16, Math.ceil(draft.vehiclesCount / 40) * 4);
    const recommendedRamGb = isPilotScale ? 16 : Math.max(32, Math.ceil(draft.vehiclesCount / 30) * 4);
    const recommendedTopology = isPilotScale
      ? 'Nodo único Linux + Docker (8 vCPU / 16 GB RAM / 200 GB NVMe + S3 externo)'
      : 'Clúster separado: Nodo BackOffice/PostgreSQL + Nodo Traccar/RabbitMQ + Nodo Video JT1078 dedicado';

    return {
      gpsMsgsPerMin,
      gpsStorageGbMonth,
      videoStorageGb,
      videoStorageTb,
      peakVideoMbps,
      isPilotScale,
      recommendedVcpu,
      recommendedRamGb,
      recommendedTopology,
    };
  }, [draft]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveSizing(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Interactive Sizing Calculator */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-sky-400" />
              Simulador de dimensionamiento de infraestructura y video
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Ajusta las variables operativas pendientes para calcular tráfico, almacenamiento S3/MinIO y topología Linux.
            </p>
          </div>
          <button
            type="button"
            disabled={!canSave || saving}
            onClick={handleSave}
            title={!canSave ? 'Solo Super Admin puede guardar parámetros de dimensionamiento' : undefined}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Guardando...' : 'Guardar escenario'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Controls */}
          <div className="lg:col-span-7 space-y-4 text-xs">
            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span>Cantidad de vehículos activos</span>
                <span className="font-mono tabular-nums text-sky-300 font-semibold">
                  {draft.vehiclesCount} unidades
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={1500}
                step={5}
                value={draft.vehiclesCount}
                onChange={(e) => setDraft((p) => ({ ...p, vehiclesCount: Number(e.target.value) }))}
                className="w-full accent-sky-500 cursor-pointer"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-slate-300 mb-1">Ritmo de reporte GPS (JT808)</label>
                <select
                  value={draft.gpsIntervalSec}
                  onChange={(e) => setDraft((p) => ({ ...p, gpsIntervalSec: Number(e.target.value) }))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value={5}>Cada 5 segundos (alta precisión)</option>
                  <option value={10}>Cada 10 segundos</option>
                  <option value={15}>Cada 15 segundos (piloto recomendado)</option>
                  <option value={30}>Cada 30 segundos</option>
                  <option value={60}>Cada 60 segundos</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Modalidad de video dashcam</label>
                <select
                  value={draft.videoMode}
                  onChange={(e) => setDraft((p) => ({ ...p, videoMode: e.target.value as VideoMode }))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="clips_eventos">Clips por evento + bajo demanda</option>
                  <option value="bajo_demanda">Solo bajo demanda + grabación local SD</option>
                  <option value="grabacion_continua">Transmisión / ingesta continua en nube</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Retención de evidencias (S3/MinIO)</label>
                <select
                  value={draft.retentionDays}
                  onChange={(e) => setDraft((p) => ({ ...p, retentionDays: Number(e.target.value) }))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value={15}>15 días</option>
                  <option value={30}>30 días (estándar piloto)</option>
                  <option value={45}>45 días</option>
                  <option value={90}>90 días (retención legal extendida)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">Modelo de alojamiento</label>
                <select
                  value={draft.hostingModel}
                  onChange={(e) => setDraft((p) => ({ ...p, hostingModel: e.target.value as HostingModel }))}
                  className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="cloud_linux">Cloud Linux (Ubuntu LTS + Docker)</option>
                  <option value="hibrido">Híbrido (Core Cloud + MinIO local)</option>
                  <option value="on_premise">On-Premise centro de datos propio</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span>Usuarios operativos simultáneos en BackOffice</span>
                <span className="font-mono tabular-nums text-sky-300 font-semibold">
                  {draft.concurrentUsers} operadores
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={120}
                step={1}
                value={draft.concurrentUsers}
                onChange={(e) => setDraft((p) => ({ ...p, concurrentUsers: Number(e.target.value) }))}
                className="w-full accent-sky-500 cursor-pointer"
              />
            </div>
          </div>

          {/* Real-time computed architecture capacity */}
          <div className="lg:col-span-5 bg-[#0B1120] border border-slate-800/80 rounded-xl p-4 space-y-3.5">
            <div className="text-xs font-medium text-sky-400">Resultado estimado del dimensionamiento</div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-[#11192C] border border-slate-800/80">
                <div className="text-slate-400">Tráfico telemetría</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {metrics.gpsMsgsPerMin.toLocaleString('es-MX')} msg/min
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#11192C] border border-slate-800/80">
                <div className="text-slate-400">Ancho de banda pico</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-slate-100 mt-0.5">
                  {metrics.peakVideoMbps} Mbps
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#11192C] border border-slate-800/80">
                <div className="text-slate-400">Almacenamiento S3/MinIO</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-amber-300 mt-0.5">
                  {metrics.videoStorageGb >= 1024
                    ? `${metrics.videoStorageTb} TB`
                    : `${metrics.videoStorageGb} GB`}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#11192C] border border-slate-800/80">
                <div className="text-slate-400">Cómputo base</div>
                <div className="font-mono tabular-nums text-sm font-semibold text-emerald-400 mt-0.5">
                  {metrics.recommendedVcpu} vCPU · {metrics.recommendedRamGb} GB
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 text-xs space-y-1.5">
              <div className="text-slate-300 font-medium">Topología sugerida</div>
              <p className="text-slate-400 leading-relaxed">{metrics.recommendedTopology}</p>
              <div className="text-slate-500 font-mono">
                PostGIS estimado: +{metrics.gpsStorageGbMonth} GB/mes · Redis + RabbitMQ incluidos
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Architectural Separation & 5 Implementation Stages */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <div className="xl:col-span-5 bg-[#11192C] border border-slate-800/80 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-sky-400" />
            Separación de responsabilidades en arquitectura
          </h3>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-[#0B1120] border border-slate-800/80 space-y-1">
              <div className="font-semibold text-sky-300 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" /> Núcleo BackOffice + API REST (CodeIgniter 4)
              </div>
              <p className="text-slate-400">
                Centraliza administración multiempresa, vehículos, conductores, dispositivos, reglas de alerta, incidentes, reportes, RBAC y auditoría sobre PostgreSQL + PostGIS.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[#0B1120] border border-slate-800/80 space-y-1">
              <div className="font-semibold text-emerald-400 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> Telemetría y tiempo real (Traccar + Node.js + RabbitMQ)
              </div>
              <p className="text-slate-400">
                Mantiene conexiones TCP persistentes JT808, normaliza paquetes GPS, gestiona caché temporal en Redis y procesa eventos de alto volumen con Outbox, DLQ e idempotencia.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[#0B1120] border border-slate-800/80 space-y-1">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5" /> Servicio independiente de Video (JT1078 + S3/MinIO)
              </div>
              <p className="text-slate-400">
                Aísla el streaming bajo demanda, captura de clips por evento, conversión H.264/MP4 y políticas de retención de evidencias fuera del núcleo administrativo.
              </p>
            </div>
          </div>
        </div>

        <div className="xl:col-span-7 bg-[#11192C] border border-slate-800/80 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">
            Hoja de ruta de implementación modular por etapas
          </h3>

          <div className="space-y-2.5">
            {stagesPagination.pagedItems.map((st) => {
              const meta = STAGE_STATUS_META[st.status];
              return (
                <div
                  key={st.stage}
                  className="p-3.5 rounded-lg bg-[#0B1120] border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-100">{st.title}</span>
                      <span className={`text-xs font-medium ${meta.colorClass}`}>· {meta.label}</span>
                    </div>
                    <p className="text-xs text-slate-400">{st.focus}</p>
                    <div className="text-xs text-slate-500">
                      {st.deliverables.join(' · ')}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {st.status === 'completada' && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination
            page={stagesPagination.page}
            totalItems={stagesPagination.totalItems}
            pageSize={5}
            onPageChange={stagesPagination.setPage}
            className="rounded-lg border border-slate-800/80"
          />
        </div>
      </div>
    </div>
  );
}
