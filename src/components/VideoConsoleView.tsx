import { useEffect, useState } from 'react';
import {
  Camera,
  HardDrive,
  Lock,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Unlock,
  Video,
} from 'lucide-react';
import type { RoleDefinition, Vehicle, VideoClip } from '../shared/types.ts';
import { formatRelativeTime, formatTimeClock } from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';

interface VideoConsoleViewProps {
  clips: VideoClip[];
  vehicles: Vehicle[];
  activeRole: RoleDefinition;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  onRequestStream: (vehicleId: string, channel: VideoClip['channel']) => Promise<void>;
  onToggleRetention: (clipId: string) => Promise<void>;
}

const TRIGGER_LABELS: Record<VideoClip['triggerType'], string> = {
  evento_g: 'Impacto / Frenado G',
  dms_fatiga: 'Fatiga / Distracción DMS',
  adas_colision: 'Alerta ADAS Colisión',
  exceso_velocidad: 'Exceso de velocidad',
  bajo_demanda: 'Bajo demanda JT1078',
};

export function VideoConsoleView({
  clips,
  vehicles,
  activeRole,
  selectedClipId,
  onSelectClip,
  onRequestStream,
  onToggleRetention,
}: VideoConsoleViewProps) {
  const activeClip = clips.find((c) => c.id === selectedClipId) ?? clips[0] ?? null;

  const [viewLayout, setViewLayout] = useState<'dual' | 'ch1' | 'ch2'>('dual');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [requestVehicleId, setRequestVehicleId] = useState(vehicles[0]?.id ?? '');
  const [requestChannel, setRequestChannel] = useState<VideoClip['channel']>('dual');
  const [requesting, setRequesting] = useState(false);
  const [imgFallback, setImgFallback] = useState<Record<string, boolean>>({});

  const canOperateVideo = activeRole.permissions.video === 'full' || activeRole.permissions.video === 'write';
  const clipsPagination = usePagination(clips, `${clips[0]?.tenantId ?? ''}|${clips.length}`, 5);

  useEffect(() => {
    setPlayheadSec(0);
    setIsPlaying(false);
  }, [activeClip?.id]);

  useEffect(() => {
    if (!isPlaying || !activeClip) return;
    const timer = window.setInterval(() => {
      setPlayheadSec((prev) => {
        if (prev + 1 >= activeClip.durationSec) {
          setIsPlaying(false);
          return activeClip.durationSec;
        }
        return prev + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPlaying, activeClip]);

  const handleRequestVod = async () => {
    if (!requestVehicleId) return;
    setRequesting(true);
    try {
      await onRequestStream(requestVehicleId, requestChannel);
    } finally {
      setRequesting(false);
    }
  };

  const progressRatio = activeClip ? playheadSec / Math.max(1, activeClip.durationSec) : 0;
  const simulatedSpeed = activeClip
    ? Math.max(0, Math.round(activeClip.speedAtEventKmh - Math.sin(progressRatio * Math.PI) * 14))
    : 0;
  const simulatedG = activeClip
    ? Number((0.12 + Math.exp(-Math.pow((progressRatio - 0.52) * 5, 2)) * (activeClip.gForcePeak - 0.12)).toFixed(2))
    : 0;

  return (
    <div className="space-y-5">
      {/* Top On-Demand Request Bar */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Radio className="w-4 h-4 text-sky-400" />
            Solicitud de transmisión y clip bajo demanda (JT1078)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Conecta con el servicio independiente de video para extraer evidencia de cámara y almacenarla en S3/MinIO.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <select
            value={requestVehicleId}
            onChange={(e) => setRequestVehicleId(e.target.value)}
            className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
          >
            {vehicles.slice(0, 30).map((v) => (
              <option key={v.id} value={v.id}>
                {v.unitCode} · {v.plate} ({v.driverName})
              </option>
            ))}
          </select>

          <select
            value={requestChannel}
            onChange={(e) => setRequestChannel(e.target.value as VideoClip['channel'])}
            className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
          >
            <option value="dual">Dual (CH1 + CH2)</option>
            <option value="ch1_frontal">CH1 Frontal Carretera</option>
            <option value="ch2_cabina">CH2 Cabina Conductor</option>
          </select>

          <button
            type="button"
            disabled={!canOperateVideo || requesting}
            onClick={handleRequestVod}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            <Video className="w-3.5 h-3.5" />
            {requesting ? 'Solicitando JT1078...' : 'Solicitar clip ahora'}
          </button>
        </div>
      </div>

      {/* Main Split: Dual Player (8 cols) + Evidence Library (4 cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* Player Viewport */}
        <div className="xl:col-span-8 bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden flex flex-col">
          {activeClip ? (
            <>
              <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-sky-400 font-medium">
                    {TRIGGER_LABELS[activeClip.triggerType]} · {activeClip.id}
                  </div>
                  <div className="text-sm font-semibold text-slate-100 mt-0.5">
                    {activeClip.unitCode} ({activeClip.plate}) · {activeClip.driverName}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 text-xs">
                    {(
                      [
                        { id: 'dual', label: 'Dual' },
                        { id: 'ch1', label: 'CH1 Frontal' },
                        { id: 'ch2', label: 'CH2 Cabina' },
                      ] as const
                    ).map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setViewLayout(l.id)}
                        className={`px-2.5 py-1 rounded-md font-medium cursor-pointer transition-colors ${
                          viewLayout === l.id ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    disabled={!canOperateVideo}
                    onClick={() => onToggleRetention(activeClip.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer disabled:opacity-40 ${
                      activeClip.retentionLocked
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-slate-100'
                    }`}
                  >
                    {activeClip.retentionLocked ? (
                      <>
                        <Lock className="w-3.5 h-3.5" /> Retención legal ({activeClip.retentionDays}d)
                      </>
                    ) : (
                      <>
                        <Unlock className="w-3.5 h-3.5" /> Bloquear evidencia
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Camera Feeds */}
              <div
                className={`p-4 grid gap-3 bg-[#070D19] ${
                  viewLayout === 'dual' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
                }`}
              >
                {(viewLayout === 'dual' || viewLayout === 'ch1') && (
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-800 bg-slate-900">
                    {!imgFallback[`${activeClip.id}-road`] ? (
                      <img
                        src={activeClip.roadImageUrl}
                        alt={`Cámara frontal carretera ${activeClip.unitCode}`}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setImgFallback((prev) => ({ ...prev, [`${activeClip.id}-road`]: true }))
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 text-xs gap-2">
                        <Camera className="w-7 h-7 text-slate-600" />
                        <span>CH1 Frontal · {activeClip.unitCode}</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 flex items-end justify-between text-xs">
                      <div>
                        <div className="font-mono text-slate-200 font-medium">
                          CH1 · FRONTAL CARRETERA
                        </div>
                        <div className="font-mono tabular-nums text-slate-300">
                          {formatTimeClock(activeClip.recordedAt)} · +{String(playheadSec).padStart(2, '0')}s
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div className="text-sky-300 font-semibold">{simulatedSpeed} km/h</div>
                        <div className="text-slate-300">{simulatedG} G</div>
                      </div>
                    </div>
                  </div>
                )}

                {(viewLayout === 'dual' || viewLayout === 'ch2') && (
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-slate-800 bg-slate-900">
                    {!imgFallback[`${activeClip.id}-cabin`] ? (
                      <img
                        src={activeClip.cabinImageUrl}
                        alt={`Cámara cabina conductor ${activeClip.unitCode}`}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setImgFallback((prev) => ({ ...prev, [`${activeClip.id}-cabin`]: true }))
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 text-xs gap-2">
                        <Camera className="w-7 h-7 text-slate-600" />
                        <span>CH2 Cabina · {activeClip.driverName}</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 flex items-end justify-between text-xs">
                      <div>
                        <div className="font-mono text-slate-200 font-medium">
                          CH2 · CABINA / DMS INFRARROJO
                        </div>
                        <div className="font-mono tabular-nums text-slate-300">
                          {activeClip.driverName}
                        </div>
                      </div>
                      <div className="font-mono tabular-nums text-emerald-300">
                        H.264 · 720p
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Playback Timeline & S3 Info */}
              <div className="p-4 border-t border-slate-800/80 space-y-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (playheadSec >= activeClip.durationSec) setPlayheadSec(0);
                      setIsPlaying((p) => !p);
                    }}
                    className="p-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
                    aria-label={isPlaying ? 'Pausar reproducción' : 'Reproducir clip'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsPlaying(false);
                      setPlayheadSec(0);
                    }}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                    aria-label="Reiniciar clip"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>

                  <input
                    type="range"
                    min={0}
                    max={activeClip.durationSec}
                    value={playheadSec}
                    onChange={(e) => setPlayheadSec(Number(e.target.value))}
                    className="flex-1 accent-sky-500 cursor-pointer"
                  />

                  <span className="font-mono tabular-nums text-xs text-slate-300 w-20 text-right">
                    00:{String(playheadSec).padStart(2, '0')} / 00:{String(activeClip.durationSec).padStart(2, '0')}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 pt-1">
                  <span className="inline-flex items-center gap-1.5 font-mono truncate max-w-full">
                    <HardDrive className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    {activeClip.s3Path}
                  </span>
                  <span className="font-mono tabular-nums text-slate-300">
                    {activeClip.sizeMb} MB · Pico {activeClip.gForcePeak} G
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="p-10 text-center text-xs text-slate-400">
              No hay clips de evidencia disponibles para la empresa seleccionada.
            </div>
          )}
        </div>

        {/* Evidence Clip Queue */}
        <div className="xl:col-span-4 bg-[#11192C] border border-slate-800/80 rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">Evidencia almacenada (S3/MinIO)</span>
            <span className="text-xs font-mono tabular-nums text-slate-400">{clips.length} clips</span>
          </div>

          <div className="divide-y divide-slate-800/60 flex-1">
            {clipsPagination.pagedItems.map((clip) => {
              const selected = clip.id === activeClip?.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  onClick={() => onSelectClip(clip.id)}
                  className={`w-full text-left p-3.5 transition-colors cursor-pointer space-y-1.5 ${
                    selected ? 'bg-sky-500/10' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-100">
                      {clip.unitCode} · {TRIGGER_LABELS[clip.triggerType]}
                    </span>
                    {clip.retentionLocked && (
                      <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    )}
                  </div>
                  <div className="text-xs text-slate-400">
                    {clip.driverName} · {clip.plate}
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-500">
                    <span>
                      {clip.durationSec}s · {clip.sizeMb} MB
                    </span>
                    <span>{formatRelativeTime(clip.recordedAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <Pagination
            page={clipsPagination.page}
            totalItems={clipsPagination.totalItems}
            pageSize={5}
            onPageChange={clipsPagination.setPage}
            compact
          />
        </div>
      </div>
    </div>
  );
}
