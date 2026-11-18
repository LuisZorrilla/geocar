import { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Cpu,
  Layers,
  Lock,
  Plus,
  Save,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import type {
  DashcamDriverProfile,
  DashcamVendorFamily,
  Device,
  DeviceDashcamConfig,
  ProtocolType,
  RoleDefinition,
  Tenant,
} from '../shared/types.ts';
import { formatRelativeTime, LINK_META, VENDOR_FAMILY_LABELS } from '../lib/api.ts';
import { Pagination, usePagination } from './Pagination.tsx';

export interface DashcamConfigPayload {
  driverId: string;
  tcpPort: number;
  activeChannels: string[];
  resolution: DeviceDashcamConfig['resolution'];
  bitrateKbps: number;
  gpsIntervalSec: number;
  preEventSec: number;
  postEventSec: number;
  gSensorThresholdG: number;
  features: DeviceDashcamConfig['features'];
}

interface DashcamConfigPanelProps {
  tenant: Tenant;
  availableTenants?: Tenant[];
  devices: Device[];
  dashcamDrivers: DashcamDriverProfile[];
  activeRole: RoleDefinition;
  isGlobalSuperadmin?: boolean;
  onValidateDevice: (deviceId: string) => Promise<void>;
  onUpdateDeviceConfig: (deviceId: string, payload: DashcamConfigPayload) => Promise<void>;
  onBatchUpdateDeviceConfig: (deviceIds: string[], payload: DashcamConfigPayload) => Promise<void>;
  onCreateDashcamDriver: (payload: {
    vendorFamily: DashcamVendorFamily;
    vendorName: string;
    modelSeries: string;
    driverCode: string;
    driverVersion: string;
    protocol: ProtocolType;
    defaultPort: number;
    maxChannels: number;
    defaultBitrateKbps: number;
    supportedFeatures: DashcamDriverProfile['supportedFeatures'];
    notes: string;
  }) => Promise<void>;
}

const CHANNEL_POOL = [
  'CH1 Frontal',
  'CH2 Cabina',
  'CH3 Lateral / Carga',
  'CH4 Trasera / Obra',
];

function getDriverChannelOptions(drv: DashcamDriverProfile): string[] {
  if (drv.protocol === 'Traccar') {
    return ['CH1 Frontal (DualCam RS232)', 'Bus CAN J1939'];
  }
  return CHANNEL_POOL.slice(0, Math.max(1, Math.min(4, drv.maxChannels)));
}

function buildConfigForDriver(
  drv: DashcamDriverProfile,
  prev?: DeviceDashcamConfig
): DeviceDashcamConfig {
  const options = getDriverChannelOptions(drv);
  const defaultChannels =
    drv.protocol === 'Traccar'
      ? options
      : options.slice(0, Math.min(2, drv.maxChannels));
  const resolution = drv.supportedResolutions.includes(prev?.resolution ?? '1080p_30fps')
    ? (prev?.resolution ?? drv.supportedResolutions[0] ?? '1080p_30fps')
    : (drv.supportedResolutions[0] ?? '1080p_30fps');

  return {
    driverId: drv.id,
    driverCode: drv.driverCode,
    tcpPort: drv.defaultPort,
    activeChannels: defaultChannels,
    resolution,
    bitrateKbps: drv.defaultBitrateKbps,
    gpsIntervalSec: prev?.gpsIntervalSec ?? 15,
    preEventSec: prev?.preEventSec ?? 10,
    postEventSec: prev?.postEventSec ?? 15,
    gSensorThresholdG: prev?.gSensorThresholdG ?? 0.65,
    features: {
      adasEnabled: drv.supportedFeatures.adas && (prev ? prev.features.adasEnabled : true),
      dmsEnabled: drv.supportedFeatures.dms && (prev ? prev.features.dmsEnabled : true),
      bsdEnabled: drv.supportedFeatures.bsd && Boolean(prev?.features.bsdEnabled),
      intercomEnabled: drv.supportedFeatures.intercomAudio && (prev ? prev.features.intercomEnabled : true),
      loopRecordingSd: prev?.features.loopRecordingSd ?? true,
      canBusEnabled: drv.supportedFeatures.canJ1939 && (prev ? prev.features.canBusEnabled : true),
      rs232Peripheral: drv.supportedFeatures.rs232
        ? (prev?.features.rs232Peripheral ?? 'ninguno')
        : 'ninguno',
    },
    syncStatus: prev?.syncStatus ?? 'sincronizado',
    updatedBy: prev?.updatedBy ?? 'Sistema',
    updatedAt: prev?.updatedAt ?? new Date().toISOString(),
  };
}

export function DashcamConfigPanel({
  tenant,
  availableTenants,
  devices,
  dashcamDrivers,
  activeRole,
  isGlobalSuperadmin,
  onValidateDevice,
  onUpdateDeviceConfig,
  onBatchUpdateDeviceConfig,
  onCreateDashcamDriver,
}: DashcamConfigPanelProps) {
  const [panelTab, setPanelTab] = useState<'matriz' | 'equipos' | 'drivers'>('matriz');
  const [familyFilter, setFamilyFilter] = useState<'all' | DashcamVendorFamily>('all');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(devices[0]?.id ?? '');
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  // Batch & inline matrix state
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [rowDrafts, setRowDrafts] = useState<Record<string, DeviceDashcamConfig>>({});
  const [dirtyRows, setDirtyRows] = useState<Record<string, boolean>>({});
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);

  // New custom driver form
  const [showNewDriver, setShowNewDriver] = useState(false);
  const [savingDriver, setSavingDriver] = useState(false);
  const [driverForm, setDriverForm] = useState({
    vendorFamily: 'howen_streamax' as DashcamVendorFamily,
    vendorName: '',
    modelSeries: '',
    driverCode: '',
    driverVersion: '1.0.0-JT1078',
    protocol: 'JT808/JT1078' as ProtocolType,
    defaultPort: 6812,
    maxChannels: 4,
    defaultBitrateKbps: 2048,
    notes: '',
    supportedFeatures: {
      adas: true,
      dms: true,
      bsd: false,
      canJ1939: true,
      rs232: true,
      intercomAudio: true,
      dualSdSsd: true,
      gSensor: true,
    },
  });

  const canConfigureDashcams =
    Boolean(isGlobalSuperadmin) ||
    activeRole.permissions.dashcams_config === 'full' ||
    activeRole.permissions.dashcams_config === 'write';
  const canValidateDevice =
    activeRole.permissions.dispositivos === 'full' || activeRole.permissions.dispositivos === 'write';

  const tenantNameMap = useMemo(
    () => new Map((availableTenants ?? [tenant]).map((t) => [t.id, t.name])),
    [availableTenants, tenant]
  );

  const driverMap = useMemo(
    () => new Map(dashcamDrivers.map((d) => [d.id, d])),
    [dashcamDrivers]
  );

  const filteredDevices = useMemo(() => {
    if (familyFilter === 'all') return devices;
    return devices.filter((dev) => {
      const drv = driverMap.get(dev.dashcamConfig.driverId);
      return drv?.vendorFamily === familyFilter;
    });
  }, [devices, familyFilter, driverMap]);

  const devicesPagination = usePagination(filteredDevices, `${tenant.id}|devcfg|${familyFilter}`, 5);
  const driversPagination = usePagination(dashcamDrivers, `${tenant.id}|drvcat|${dashcamDrivers.length}`, 5);

  const selectedDevice =
    devices.find((d) => d.id === selectedDeviceId) ??
    filteredDevices[0] ??
    devices[0] ??
    null;

  const [cfgDraft, setCfgDraft] = useState<DeviceDashcamConfig | null>(
    selectedDevice?.dashcamConfig ?? null
  );

  // Batch configuration draft
  const initialBatchDriver = dashcamDrivers[0];
  const [batchDraft, setBatchDraft] = useState<DeviceDashcamConfig | null>(() =>
    initialBatchDriver ? buildConfigForDriver(initialBatchDriver) : null
  );

  useEffect(() => {
    if (!batchDraft && dashcamDrivers[0]) {
      setBatchDraft(buildConfigForDriver(dashcamDrivers[0]));
    }
  }, [dashcamDrivers, batchDraft]);

  useEffect(() => {
    if (selectedDevice) {
      setCfgDraft(selectedDevice.dashcamConfig);
    } else {
      setCfgDraft(null);
    }
  }, [selectedDevice?.id, selectedDevice?.dashcamConfig.updatedAt]);

  // Sync inline row drafts when server devices change
  useEffect(() => {
    setRowDrafts((prev) => {
      const next: Record<string, DeviceDashcamConfig> = {};
      for (const dev of devices) {
        if (dirtyRows[dev.id] && prev[dev.id]) {
          next[dev.id] = prev[dev.id];
        } else {
          next[dev.id] = dev.dashcamConfig;
        }
      }
      return next;
    });
    const deviceIdsSet = new Set(devices.map((d) => d.id));
    setBatchSelectedIds((prev) => prev.filter((id) => deviceIdsSet.has(id)));
  }, [devices]);

  const activeDriver = cfgDraft ? driverMap.get(cfgDraft.driverId) ?? dashcamDrivers[0] : dashcamDrivers[0];
  const batchDriver = batchDraft ? driverMap.get(batchDraft.driverId) ?? dashcamDrivers[0] : dashcamDrivers[0];

  const handleDriverChange = (nextDriverId: string) => {
    const drv = driverMap.get(nextDriverId);
    if (!drv || !cfgDraft) return;
    setCfgDraft(buildConfigForDriver(drv, cfgDraft));
  };

  const handleToggleChannel = (ch: string) => {
    if (!cfgDraft || !activeDriver) return;
    const exists = cfgDraft.activeChannels.includes(ch);
    if (exists) {
      if (cfgDraft.activeChannels.length <= 1) return;
      setCfgDraft({
        ...cfgDraft,
        activeChannels: cfgDraft.activeChannels.filter((c) => c !== ch),
      });
    } else {
      if (cfgDraft.activeChannels.length >= activeDriver.maxChannels) return;
      setCfgDraft({
        ...cfgDraft,
        activeChannels: [...cfgDraft.activeChannels, ch],
      });
    }
  };

  const handleSaveDeviceConfig = async () => {
    if (!selectedDevice || !cfgDraft || !canConfigureDashcams) return;
    setSavingConfig(true);
    try {
      await onUpdateDeviceConfig(selectedDevice.id, {
        driverId: cfgDraft.driverId,
        tcpPort: cfgDraft.tcpPort,
        activeChannels: cfgDraft.activeChannels,
        resolution: cfgDraft.resolution,
        bitrateKbps: cfgDraft.bitrateKbps,
        gpsIntervalSec: cfgDraft.gpsIntervalSec,
        preEventSec: cfgDraft.preEventSec,
        postEventSec: cfgDraft.postEventSec,
        gSensorThresholdG: cfgDraft.gSensorThresholdG,
        features: cfgDraft.features,
      });
    } finally {
      setSavingConfig(false);
    }
  };

  // Matrix inline helpers
  const updateRowDraft = (deviceId: string, updater: (curr: DeviceDashcamConfig) => DeviceDashcamConfig) => {
    const fallback = devices.find((d) => d.id === deviceId)?.dashcamConfig;
    if (!fallback) return;
    setRowDrafts((prev) => ({
      ...prev,
      [deviceId]: updater(prev[deviceId] ?? fallback),
    }));
    setDirtyRows((prev) => ({ ...prev, [deviceId]: true }));
  };

  const handleRowDriverChange = (deviceId: string, nextDriverId: string) => {
    const drv = driverMap.get(nextDriverId);
    if (!drv) return;
    updateRowDraft(deviceId, (curr) => buildConfigForDriver(drv, curr));
  };

  const handleRowToggleChannel = (deviceId: string, ch: string, maxCh: number) => {
    updateRowDraft(deviceId, (curr) => {
      const exists = curr.activeChannels.includes(ch);
      if (exists) {
        if (curr.activeChannels.length <= 1) return curr;
        return { ...curr, activeChannels: curr.activeChannels.filter((c) => c !== ch) };
      }
      if (curr.activeChannels.length >= maxCh) return curr;
      return { ...curr, activeChannels: [...curr.activeChannels, ch] };
    });
  };

  const handleSaveSingleRow = async (deviceId: string) => {
    const draft = rowDrafts[deviceId];
    if (!draft || !canConfigureDashcams) return;
    setSavingRowId(deviceId);
    try {
      await onUpdateDeviceConfig(deviceId, {
        driverId: draft.driverId,
        tcpPort: draft.tcpPort,
        activeChannels: draft.activeChannels,
        resolution: draft.resolution,
        bitrateKbps: draft.bitrateKbps,
        gpsIntervalSec: draft.gpsIntervalSec,
        preEventSec: draft.preEventSec,
        postEventSec: draft.postEventSec,
        gSensorThresholdG: draft.gSensorThresholdG,
        features: draft.features,
      });
      setDirtyRows((prev) => ({ ...prev, [deviceId]: false }));
    } finally {
      setSavingRowId(null);
    }
  };

  // Batch handlers
  const handleBatchDriverChange = (nextDriverId: string) => {
    const drv = driverMap.get(nextDriverId);
    if (!drv || !batchDraft) return;
    setBatchDraft(buildConfigForDriver(drv, batchDraft));
  };

  const handleBatchToggleChannel = (ch: string) => {
    if (!batchDraft || !batchDriver) return;
    const exists = batchDraft.activeChannels.includes(ch);
    if (exists) {
      if (batchDraft.activeChannels.length <= 1) return;
      setBatchDraft({
        ...batchDraft,
        activeChannels: batchDraft.activeChannels.filter((c) => c !== ch),
      });
    } else {
      if (batchDraft.activeChannels.length >= batchDriver.maxChannels) return;
      setBatchDraft({
        ...batchDraft,
        activeChannels: [...batchDraft.activeChannels, ch],
      });
    }
  };

  const handleApplyBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfigureDashcams || !batchDraft || batchSelectedIds.length === 0) return;
    setSavingBatch(true);
    try {
      await onBatchUpdateDeviceConfig(batchSelectedIds, {
        driverId: batchDraft.driverId,
        tcpPort: batchDraft.tcpPort,
        activeChannels: batchDraft.activeChannels,
        resolution: batchDraft.resolution,
        bitrateKbps: batchDraft.bitrateKbps,
        gpsIntervalSec: batchDraft.gpsIntervalSec,
        preEventSec: batchDraft.preEventSec,
        postEventSec: batchDraft.postEventSec,
        gSensorThresholdG: batchDraft.gSensorThresholdG,
        features: batchDraft.features,
      });
      setDirtyRows((prev) => {
        const next = { ...prev };
        for (const id of batchSelectedIds) {
          next[id] = false;
        }
        return next;
      });
    } finally {
      setSavingBatch(false);
    }
  };

  const handleCreateDriverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driverForm.vendorName.trim() || !driverForm.modelSeries.trim() || !driverForm.driverCode.trim()) return;
    setSavingDriver(true);
    try {
      await onCreateDashcamDriver(driverForm);
      setDriverForm((p) => ({
        ...p,
        vendorName: '',
        modelSeries: '',
        driverCode: '',
        notes: '',
      }));
      setShowNewDriver(false);
    } finally {
      setSavingDriver(false);
    }
  };

  const pageDeviceIds = devicesPagination.pagedItems.map((d) => d.id);
  const allPageChecked =
    pageDeviceIds.length > 0 && pageDeviceIds.every((id) => batchSelectedIds.includes(id));

  const toggleSelectPage = () => {
    if (allPageChecked) {
      setBatchSelectedIds((prev) => prev.filter((id) => !pageDeviceIds.includes(id)));
    } else {
      setBatchSelectedIds((prev) => Array.from(new Set([...prev, ...pageDeviceIds])));
    }
  };

  return (
    <div className="space-y-4">
      {/* RBAC Notice Banner + Sub-navigation */}
      <div className="bg-[#11192C] border border-slate-800/80 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          {canConfigureDashcams ? (
            <Sliders className="w-4 h-4 text-sky-400 shrink-0" />
          ) : (
            <Lock className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <div>
            <span className="font-semibold text-slate-100">
              Drivers y prestaciones de dashcams ({tenant.name})
            </span>
            <span className="text-slate-400 ml-2">
              {canConfigureDashcams
                ? 'Habilitado para configurar drivers Howen, Streamax, Jimi, Teltonika CAN/RS232 y Hikvision/Dahua en lote o por unidad.'
                : 'Solo lectura: exclusivo para Superadmin, Admin de Empresa o perfiles habilitados en la matriz.'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-[#0B1120] p-1 rounded-lg border border-slate-800 overflow-x-auto">
          <button
            type="button"
            onClick={() => setPanelTab('matriz')}
            className={`px-3 py-1 rounded text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              panelTab === 'matriz' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Matriz avanzada ({devices.length})
          </button>
          <button
            type="button"
            onClick={() => setPanelTab('equipos')}
            className={`px-3 py-1 rounded text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              panelTab === 'equipos' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Inspector individual
          </button>
          <button
            type="button"
            onClick={() => setPanelTab('drivers')}
            className={`px-3 py-1 rounded text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 ${
              panelTab === 'drivers' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Catálogo de drivers ({dashcamDrivers.length})
          </button>
        </div>
      </div>

      {/* TAB 1: ADVANCED CONFIGURATION MATRIX (BATCH + INDIVIDUAL INLINE) */}
      {panelTab === 'matriz' && (
        <div className="space-y-4">
          {/* Family filter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setFamilyFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                  familyFilter === 'all'
                    ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                    : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                Todos ({devices.length})
              </button>
              {(Object.keys(VENDOR_FAMILY_LABELS) as DashcamVendorFamily[]).map((fam) => (
                <button
                  key={fam}
                  type="button"
                  onClick={() => setFamilyFilter(fam)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                    familyFilter === fam
                      ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                      : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {VENDOR_FAMILY_LABELS[fam]}
                </button>
              ))}
            </div>

            {canConfigureDashcams && (
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setBatchSelectedIds(filteredDevices.map((d) => d.id))}
                  className="px-2.5 py-1.5 rounded-lg bg-[#11192C] border border-slate-800 text-slate-300 hover:text-white cursor-pointer whitespace-nowrap"
                >
                  Sel. filtradas ({filteredDevices.length})
                </button>
                {batchSelectedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setBatchSelectedIds([])}
                    className="px-2.5 py-1.5 rounded-lg bg-[#11192C] border border-slate-800 text-slate-400 hover:text-rose-300 cursor-pointer whitespace-nowrap"
                  >
                    Limpiar ({batchSelectedIds.length})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Interactive Batch Provisioning Form */}
          {canConfigureDashcams && batchDraft && batchDriver && (
            <form
              onSubmit={handleApplyBatch}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                <div className="flex items-center gap-2 font-semibold text-slate-100">
                  <Layers className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>
                    Configuración masiva por lote ·{' '}
                    <span className="text-sky-300 font-mono">
                      {batchSelectedIds.length} unidad(es) seleccionada(s)
                    </span>
                  </span>
                </div>
                <button
                  type="submit"
                  disabled={savingBatch || batchSelectedIds.length === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingBatch
                    ? 'Sincronizando lote...'
                    : `Aplicar driver a ${batchSelectedIds.length} unidad(es)`}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-6 gap-2.5">
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Driver objetivo</label>
                  <select
                    value={batchDraft.driverId}
                    onChange={(e) => handleBatchDriverChange(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                  >
                    {dashcamDrivers.map((drv) => (
                      <option key={drv.id} value={drv.id}>
                        {drv.vendorName} · {drv.modelSeries} ({drv.protocol})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Resolución</label>
                  <select
                    value={batchDraft.resolution}
                    onChange={(e) =>
                      setBatchDraft((p) =>
                        p ? { ...p, resolution: e.target.value as DeviceDashcamConfig['resolution'] } : p
                      )
                    }
                    className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100"
                  >
                    {batchDriver.supportedResolutions.map((res) => (
                      <option key={res} value={res}>
                        {res}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Bitrate (kbps)</label>
                  <input
                    type="number"
                    step={256}
                    min={512}
                    value={batchDraft.bitrateKbps}
                    onChange={(e) =>
                      setBatchDraft((p) => (p ? { ...p, bitrateKbps: Number(e.target.value) } : p))
                    }
                    className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Puerto TCP</label>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={batchDraft.tcpPort}
                    onChange={(e) =>
                      setBatchDraft((p) => (p ? { ...p, tcpPort: Number(e.target.value) } : p))
                    }
                    className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Trigger G-Sensor (G)</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0.2}
                    max={2.5}
                    value={batchDraft.gSensorThresholdG}
                    onChange={(e) =>
                      setBatchDraft((p) => (p ? { ...p, gSensorThresholdG: Number(e.target.value) } : p))
                    }
                    className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-400 mr-1">Canales (máx {batchDriver.maxChannels}):</span>
                  {getDriverChannelOptions(batchDriver).map((ch) => {
                    const active = batchDraft.activeChannels.includes(ch);
                    return (
                      <button
                        key={ch}
                        type="button"
                        onClick={() => handleBatchToggleChannel(ch)}
                        className={`px-2 py-1 rounded border text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                          active
                            ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                            : 'bg-[#0B1120] border-slate-800 text-slate-400'
                        }`}
                      >
                        {ch}
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(
                    [
                      { key: 'adasEnabled', label: 'ADAS', supported: batchDriver.supportedFeatures.adas },
                      { key: 'dmsEnabled', label: 'DMS', supported: batchDriver.supportedFeatures.dms },
                      { key: 'bsdEnabled', label: 'BSD', supported: batchDriver.supportedFeatures.bsd },
                      {
                        key: 'intercomEnabled',
                        label: 'Intercom',
                        supported: batchDriver.supportedFeatures.intercomAudio,
                      },
                      { key: 'loopRecordingSd', label: 'SD Cíclica', supported: true },
                      {
                        key: 'canBusEnabled',
                        label: 'CAN J1939',
                        supported: batchDriver.supportedFeatures.canJ1939,
                      },
                    ] as const
                  ).map((feat) => (
                    <label
                      key={feat.key}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded bg-[#0B1120] border border-slate-800 ${
                        feat.supported ? 'cursor-pointer text-slate-200' : 'opacity-40 text-slate-500'
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={!feat.supported}
                        checked={Boolean(batchDraft.features[feat.key])}
                        onChange={(e) =>
                          setBatchDraft((p) =>
                            p
                              ? {
                                  ...p,
                                  features: { ...p.features, [feat.key]: e.target.checked },
                                }
                              : p
                          )
                        }
                      />
                      <span>{feat.label}</span>
                    </label>
                  ))}

                  <select
                    disabled={!batchDriver.supportedFeatures.rs232}
                    value={batchDraft.features.rs232Peripheral}
                    onChange={(e) =>
                      setBatchDraft((p) =>
                        p
                          ? {
                              ...p,
                              features: {
                                ...p.features,
                                rs232Peripheral: e.target
                                  .value as DeviceDashcamConfig['features']['rs232Peripheral'],
                              },
                            }
                          : p
                      )
                    }
                    className="px-2 py-1 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-40"
                    aria-label="Periférico RS232 en lote"
                  >
                    <option value="ninguno">RS232: Ninguno</option>
                    <option value="rfid_operador">RS232: RFID</option>
                    <option value="sensor_combustible">RS232: Combustible</option>
                    <option value="dualcam_uart">RS232: DualCam UART</option>
                  </select>
                </div>
              </div>
            </form>
          )}

          {/* Editable Matrix Table (5 items per page) */}
          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-2.5 px-3 w-9">
                      <input
                        type="checkbox"
                        aria-label="Seleccionar página actual"
                        disabled={!canConfigureDashcams}
                        checked={allPageChecked}
                        onChange={toggleSelectPage}
                      />
                    </th>
                    <th className="py-2.5 px-3">Unidad / Enlace</th>
                    <th className="py-2.5 px-3">Driver fabricante</th>
                    <th className="py-2.5 px-3">Canales / Resolución</th>
                    <th className="py-2.5 px-3">Bitrate / Puerto / G-Sensor</th>
                    <th className="py-2.5 px-3">Prestaciones / RS232</th>
                    <th className="py-2.5 px-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {devicesPagination.pagedItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 px-4 text-center text-slate-400">
                        No hay dispositivos que coincidan con el filtro seleccionado.
                      </td>
                    </tr>
                  ) : (
                    devicesPagination.pagedItems.map((dev) => {
                      const draft = rowDrafts[dev.id] ?? dev.dashcamConfig;
                      const rowDrv = driverMap.get(draft.driverId) ?? dashcamDrivers[0];
                      const isChecked = batchSelectedIds.includes(dev.id);
                      const isDirty = Boolean(dirtyRows[dev.id]);
                      const link = LINK_META[dev.linkStatus];
                      const channelOpts = rowDrv ? getDriverChannelOptions(rowDrv) : CHANNEL_POOL;

                      return (
                        <tr
                          key={dev.id}
                          className={isChecked ? 'bg-sky-500/10' : 'hover:bg-slate-800/25'}
                        >
                          <td className="py-2.5 px-3 align-top">
                            <input
                              type="checkbox"
                              aria-label={`Seleccionar ${dev.unitCode}`}
                              disabled={!canConfigureDashcams}
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setBatchSelectedIds((prev) => Array.from(new Set([...prev, dev.id])));
                                } else {
                                  setBatchSelectedIds((prev) => prev.filter((id) => id !== dev.id));
                                }
                              }}
                            />
                          </td>

                          <td className="py-2.5 px-3 align-top min-w-[165px]">
                            <div className="font-semibold text-slate-100">
                              {dev.unitCode} · <span className={link.colorClass}>{link.label}</span>
                            </div>
                            <div className="font-mono text-[11px] text-slate-400">
                              {tenant.id === 'all' ? `${tenantNameMap.get(dev.tenantId) ?? dev.tenantId} · ` : ''}
                              {dev.imei}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {dev.protocol} · {formatRelativeTime(dev.lastHeartbeatAt)}
                            </div>
                          </td>

                          <td className="py-2.5 px-3 align-top min-w-[205px]">
                            <select
                              disabled={!canConfigureDashcams}
                              value={draft.driverId}
                              onChange={(e) => handleRowDriverChange(dev.id, e.target.value)}
                              className="w-full px-2 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-60"
                            >
                              {dashcamDrivers.map((drv) => (
                                <option key={drv.id} value={drv.id}>
                                  {drv.vendorName} · {drv.modelSeries}
                                </option>
                              ))}
                            </select>
                            <div className="font-mono text-[11px] text-sky-300 mt-1 truncate max-w-[200px]">
                              {rowDrv?.driverCode ?? draft.driverCode}
                            </div>
                          </td>

                          <td className="py-2.5 px-3 align-top min-w-[180px] space-y-1.5">
                            <div className="flex flex-wrap gap-1">
                              {channelOpts.map((ch, idx) => {
                                const on = draft.activeChannels.includes(ch);
                                const shortLabel =
                                  ch.startsWith('Bus CAN') ? 'CAN' : `CH${idx + 1}`;
                                return (
                                  <button
                                    key={ch}
                                    type="button"
                                    disabled={!canConfigureDashcams}
                                    onClick={() =>
                                      handleRowToggleChannel(dev.id, ch, rowDrv?.maxChannels ?? 4)
                                    }
                                    className={`px-1.5 py-0.5 rounded border font-mono text-[11px] cursor-pointer disabled:opacity-60 ${
                                      on
                                        ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                                        : 'bg-[#0B1120] border-slate-800 text-slate-500'
                                    }`}
                                  >
                                    {shortLabel}
                                  </button>
                                );
                              })}
                            </div>
                            <select
                              disabled={!canConfigureDashcams}
                              value={draft.resolution}
                              onChange={(e) =>
                                updateRowDraft(dev.id, (c) => ({
                                  ...c,
                                  resolution: e.target.value as DeviceDashcamConfig['resolution'],
                                }))
                              }
                              className="w-full px-2 py-1 bg-[#0B1120] border border-slate-800 rounded font-mono text-[11px] text-slate-200 disabled:opacity-60"
                            >
                              {(rowDrv?.supportedResolutions ?? ['1080p_30fps', '720p_30fps']).map((res) => (
                                <option key={res} value={res}>
                                  {res}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="py-2.5 px-3 align-top min-w-[205px]">
                            <div className="grid grid-cols-3 gap-1.5 font-mono">
                              <div>
                                <span className="block text-[10px] text-slate-500">kbps</span>
                                <input
                                  type="number"
                                  step={256}
                                  min={512}
                                  disabled={!canConfigureDashcams}
                                  value={draft.bitrateKbps}
                                  onChange={(e) =>
                                    updateRowDraft(dev.id, (c) => ({
                                      ...c,
                                      bitrateKbps: Number(e.target.value),
                                    }))
                                  }
                                  className="w-full px-1.5 py-1 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-60"
                                />
                              </div>
                              <div>
                                <span className="block text-[10px] text-slate-500">TCP</span>
                                <input
                                  type="number"
                                  min={1024}
                                  max={65535}
                                  disabled={!canConfigureDashcams}
                                  value={draft.tcpPort}
                                  onChange={(e) =>
                                    updateRowDraft(dev.id, (c) => ({
                                      ...c,
                                      tcpPort: Number(e.target.value),
                                    }))
                                  }
                                  className="w-full px-1.5 py-1 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-60"
                                />
                              </div>
                              <div>
                                <span className="block text-[10px] text-slate-500">G-Sens</span>
                                <input
                                  type="number"
                                  step={0.05}
                                  min={0.2}
                                  max={2.5}
                                  disabled={!canConfigureDashcams}
                                  value={draft.gSensorThresholdG}
                                  onChange={(e) =>
                                    updateRowDraft(dev.id, (c) => ({
                                      ...c,
                                      gSensorThresholdG: Number(e.target.value),
                                    }))
                                  }
                                  className="w-full px-1.5 py-1 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-60"
                                />
                              </div>
                            </div>
                          </td>

                          <td className="py-2.5 px-3 align-top min-w-[215px] space-y-1.5">
                            <div className="flex flex-wrap gap-1">
                              {(
                                [
                                  { key: 'adasEnabled', label: 'ADAS', sup: rowDrv?.supportedFeatures.adas },
                                  { key: 'dmsEnabled', label: 'DMS', sup: rowDrv?.supportedFeatures.dms },
                                  { key: 'bsdEnabled', label: 'BSD', sup: rowDrv?.supportedFeatures.bsd },
                                  { key: 'canBusEnabled', label: 'CAN', sup: rowDrv?.supportedFeatures.canJ1939 },
                                  { key: 'loopRecordingSd', label: 'SD', sup: true },
                                ] as const
                              ).map((f) => {
                                const on = Boolean(draft.features[f.key]);
                                return (
                                  <button
                                    key={f.key}
                                    type="button"
                                    disabled={!canConfigureDashcams || !f.sup}
                                    onClick={() =>
                                      updateRowDraft(dev.id, (c) => ({
                                        ...c,
                                        features: { ...c.features, [f.key]: !on },
                                      }))
                                    }
                                    className={`px-1.5 py-0.5 rounded border font-mono text-[10px] cursor-pointer disabled:opacity-35 ${
                                      on
                                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                        : 'bg-[#0B1120] border-slate-800 text-slate-500'
                                    }`}
                                  >
                                    {f.label}
                                  </button>
                                );
                              })}
                            </div>
                            <select
                              disabled={!canConfigureDashcams || !rowDrv?.supportedFeatures.rs232}
                              value={draft.features.rs232Peripheral}
                              onChange={(e) =>
                                updateRowDraft(dev.id, (c) => ({
                                  ...c,
                                  features: {
                                    ...c.features,
                                    rs232Peripheral: e.target
                                      .value as DeviceDashcamConfig['features']['rs232Peripheral'],
                                  },
                                }))
                              }
                              className="w-full px-2 py-1 bg-[#0B1120] border border-slate-800 rounded text-[11px] text-slate-200 disabled:opacity-40"
                            >
                              <option value="ninguno">RS232: Ninguno</option>
                              <option value="rfid_operador">RS232: RFID Operador</option>
                              <option value="sensor_combustible">RS232: Combustible</option>
                              <option value="dualcam_uart">RS232: DualCam UART</option>
                            </select>
                          </td>

                          <td className="py-2.5 px-3 align-top text-right whitespace-nowrap">
                            <div className="inline-flex flex-col items-end gap-1.5">
                              {canConfigureDashcams && (
                                <button
                                  type="button"
                                  disabled={savingRowId === dev.id}
                                  onClick={() => handleSaveSingleRow(dev.id)}
                                  className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                                    isDirty
                                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                      : 'bg-sky-600/20 hover:bg-sky-600/35 text-sky-300 border border-sky-500/40'
                                  }`}
                                >
                                  {savingRowId === dev.id ? 'Guardando...' : isDirty ? 'Guardar fila' : 'Aplicar'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedDeviceId(dev.id);
                                  setPanelTab('equipos');
                                }}
                                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] cursor-pointer whitespace-nowrap"
                              >
                                Inspector
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              page={devicesPagination.page}
              totalItems={devicesPagination.totalItems}
              pageSize={5}
              onPageChange={devicesPagination.setPage}
            />
          </div>
        </div>
      )}

      {/* TAB 2: INDIVIDUAL DEVICE INSPECTOR */}
      {panelTab === 'equipos' && (
        <div className="space-y-3">
          {/* Family filter */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFamilyFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                familyFilter === 'all'
                  ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                  : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              Todos los fabricantes
            </button>
            {(Object.keys(VENDOR_FAMILY_LABELS) as DashcamVendorFamily[]).map((fam) => (
              <button
                key={fam}
                type="button"
                onClick={() => setFamilyFilter(fam)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                  familyFilter === fam
                    ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                    : 'bg-[#11192C] border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {VENDOR_FAMILY_LABELS[fam]}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
            {/* Devices Table (5 items per page) */}
            <div className="xl:col-span-7 bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                      <th className="py-2.5 px-3.5">Unidad / Equipo</th>
                      <th className="py-2.5 px-3.5">Driver / Puerto</th>
                      <th className="py-2.5 px-3.5">Prestaciones activas</th>
                      <th className="py-2.5 px-3.5">Enlace</th>
                      <th className="py-2.5 px-3.5 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {devicesPagination.pagedItems.map((d) => {
                      const link = LINK_META[d.linkStatus];
                      const isSel = selectedDevice?.id === d.id;
                      const feats: string[] = [];
                      if (d.dashcamConfig.features.adasEnabled) feats.push('ADAS');
                      if (d.dashcamConfig.features.dmsEnabled) feats.push('DMS');
                      if (d.dashcamConfig.features.bsdEnabled) feats.push('BSD');
                      if (d.dashcamConfig.features.canBusEnabled) feats.push('CAN');
                      if (d.dashcamConfig.features.rs232Peripheral !== 'ninguno') feats.push('RS232');
                      return (
                        <tr
                          key={d.id}
                          onClick={() => setSelectedDeviceId(d.id)}
                          className={`cursor-pointer transition-colors ${
                            isSel ? 'bg-sky-500/10' : 'hover:bg-slate-800/30'
                          }`}
                        >
                          <td className="py-2.5 px-3.5">
                            <div className="font-semibold text-slate-100">
                              {d.unitCode} · <span className="font-normal text-sky-300">{d.model}</span>
                            </div>
                            <div className="font-mono text-slate-500">
                              {tenant.id === 'all' ? `${tenantNameMap.get(d.tenantId) ?? d.tenantId} · ` : ''}
                              {d.imei}
                            </div>
                          </td>
                          <td className="py-2.5 px-3.5 font-mono">
                            <div className="text-slate-200 truncate max-w-[170px]">{d.dashcamConfig.driverCode}</div>
                            <div className="text-slate-500">
                              {d.protocol} · TCP {d.dashcamConfig.tcpPort}
                            </div>
                          </td>
                          <td className="py-2.5 px-3.5 text-slate-300">
                            <div>
                              {d.dashcamConfig.activeChannels.length}CH · {d.dashcamConfig.resolution}
                            </div>
                            <div className="font-mono text-[11px] text-sky-300">
                              {feats.join(' · ') || 'Estándar'}
                            </div>
                          </td>
                          <td className="py-2.5 px-3.5">
                            <span className={`font-medium ${link.colorClass}`}>{link.label}</span>
                            <div className="text-slate-500">{formatRelativeTime(d.lastHeartbeatAt)}</div>
                          </td>
                          <td className="py-2.5 px-3.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setSelectedDeviceId(d.id)}
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 cursor-pointer"
                              >
                                Configurar
                              </button>
                              {!d.hardwareValidated ? (
                                <button
                                  type="button"
                                  disabled={!canValidateDevice || validatingId === d.id}
                                  onClick={async () => {
                                    setValidatingId(d.id);
                                    try {
                                      await onValidateDevice(d.id);
                                    } finally {
                                      setValidatingId(null);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 disabled:opacity-50 cursor-pointer"
                                >
                                  <ShieldCheck className="w-3 h-3" />
                                  {validatingId === d.id ? '...' : 'Validar'}
                                </button>
                              ) : (
                                <span title="Validado" className="inline-flex items-center">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={devicesPagination.page}
                totalItems={devicesPagination.totalItems}
                pageSize={5}
                onPageChange={devicesPagination.setPage}
              />
            </div>

            {/* Right Inspector: Driver & Capabilities Configurator */}
            <div className="xl:col-span-5 bg-[#11192C] border border-slate-800/80 rounded-xl p-4 space-y-4 text-xs">
              {selectedDevice && cfgDraft && activeDriver ? (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <div className="font-semibold text-sm text-slate-100 flex items-center gap-2">
                        <Camera className="w-4 h-4 text-sky-400" />
                        {selectedDevice.unitCode} · {selectedDevice.model}
                      </div>
                      <div className="font-mono text-slate-400 mt-0.5">
                        IMEI {selectedDevice.imei} · Último ajuste: {cfgDraft.updatedBy}
                      </div>
                    </div>
                    <span className="font-mono text-emerald-400">
                      {cfgDraft.syncStatus === 'sincronizado' ? 'Sincronizado' : 'Pendiente'}
                    </span>
                  </div>

                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Driver de fabricante asignado
                    </label>
                    <select
                      disabled={!canConfigureDashcams}
                      value={cfgDraft.driverId}
                      onChange={(e) => handleDriverChange(e.target.value)}
                      className="w-full px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 disabled:opacity-60"
                    >
                      {dashcamDrivers.map((drv) => (
                        <option key={drv.id} value={drv.id}>
                          {drv.vendorName} · {drv.modelSeries} ({drv.protocol} :{drv.defaultPort})
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1">{activeDriver.notes}</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-slate-400 mb-1">Puerto TCP</label>
                      <input
                        type="number"
                        disabled={!canConfigureDashcams}
                        value={cfgDraft.tcpPort}
                        onChange={(e) =>
                          setCfgDraft((p) => (p ? { ...p, tcpPort: Number(e.target.value) } : p))
                        }
                        className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Resolución</label>
                      <select
                        disabled={!canConfigureDashcams}
                        value={cfgDraft.resolution}
                        onChange={(e) =>
                          setCfgDraft((p) =>
                            p
                              ? { ...p, resolution: e.target.value as DeviceDashcamConfig['resolution'] }
                              : p
                          )
                        }
                        className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-60"
                      >
                        {activeDriver.supportedResolutions.map((res) => (
                          <option key={res} value={res}>
                            {res}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Bitrate (kbps)</label>
                      <input
                        type="number"
                        step={256}
                        disabled={!canConfigureDashcams}
                        value={cfgDraft.bitrateKbps}
                        onChange={(e) =>
                          setCfgDraft((p) => (p ? { ...p, bitrateKbps: Number(e.target.value) } : p))
                        }
                        className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">GPS Intervalo (s)</label>
                      <input
                        type="number"
                        min={5}
                        max={300}
                        disabled={!canConfigureDashcams}
                        value={cfgDraft.gpsIntervalSec}
                        onChange={(e) =>
                          setCfgDraft((p) => (p ? { ...p, gpsIntervalSec: Number(e.target.value) } : p))
                        }
                        className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Buffer Pre/Post (s)</label>
                      <div className="grid grid-cols-2 gap-1">
                        <input
                          type="number"
                          min={5}
                          max={60}
                          disabled={!canConfigureDashcams}
                          value={cfgDraft.preEventSec}
                          onChange={(e) =>
                            setCfgDraft((p) => (p ? { ...p, preEventSec: Number(e.target.value) } : p))
                          }
                          className="w-full px-2 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                        />
                        <input
                          type="number"
                          min={5}
                          max={120}
                          disabled={!canConfigureDashcams}
                          value={cfgDraft.postEventSec}
                          onChange={(e) =>
                            setCfgDraft((p) => (p ? { ...p, postEventSec: Number(e.target.value) } : p))
                          }
                          className="w-full px-2 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Umbral G-Sensor</label>
                      <input
                        type="number"
                        step={0.05}
                        min={0.2}
                        max={2.5}
                        disabled={!canConfigureDashcams}
                        value={cfgDraft.gSensorThresholdG}
                        onChange={(e) =>
                          setCfgDraft((p) => (p ? { ...p, gSensorThresholdG: Number(e.target.value) } : p))
                        }
                        className="w-full px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded font-mono text-slate-100 disabled:opacity-60"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-300 font-medium mb-1.5">
                      Canales habilitados (máx. {activeDriver.maxChannels} para este driver)
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {getDriverChannelOptions(activeDriver).map((ch) => {
                        const on = cfgDraft.activeChannels.includes(ch);
                        return (
                          <button
                            key={ch}
                            type="button"
                            disabled={!canConfigureDashcams}
                            onClick={() => handleToggleChannel(ch)}
                            className={`px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer disabled:opacity-60 ${
                              on
                                ? 'bg-sky-600/20 border-sky-500/50 text-sky-300'
                                : 'bg-[#0B1120] border-slate-800 text-slate-400'
                            }`}
                          >
                            {ch}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <div className="text-slate-300 font-medium">Prestaciones activas en dashcam</div>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          {
                            key: 'adasEnabled',
                            label: 'ADAS (Colisión / Carril)',
                            supported: activeDriver.supportedFeatures.adas,
                          },
                          {
                            key: 'dmsEnabled',
                            label: 'DMS (Fatiga / Distracción)',
                            supported: activeDriver.supportedFeatures.dms,
                          },
                          {
                            key: 'bsdEnabled',
                            label: 'BSD (Punto Ciego)',
                            supported: activeDriver.supportedFeatures.bsd,
                          },
                          {
                            key: 'intercomEnabled',
                            label: 'Intercomunicador Audio',
                            supported: activeDriver.supportedFeatures.intercomAudio,
                          },
                          {
                            key: 'loopRecordingSd',
                            label: 'Grabación Cíclica SD/SSD',
                            supported: true,
                          },
                          {
                            key: 'canBusEnabled',
                            label: 'Telemetría Bus CAN J1939',
                            supported: activeDriver.supportedFeatures.canJ1939,
                          },
                        ] as const
                      ).map((feat) => (
                        <label
                          key={feat.key}
                          className={`p-2 rounded bg-[#0B1120] border border-slate-800 flex items-center justify-between gap-2 ${
                            feat.supported && canConfigureDashcams ? 'cursor-pointer' : 'opacity-50'
                          }`}
                        >
                          <span className="text-slate-300 truncate">{feat.label}</span>
                          <input
                            type="checkbox"
                            disabled={!feat.supported || !canConfigureDashcams}
                            checked={Boolean(cfgDraft.features[feat.key])}
                            onChange={(e) =>
                              setCfgDraft((p) =>
                                p
                                  ? {
                                      ...p,
                                      features: { ...p.features, [feat.key]: e.target.checked },
                                    }
                                  : p
                              )
                            }
                          />
                        </label>
                      ))}
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <label className="text-slate-400">Periférico RS232</label>
                      <select
                        disabled={!activeDriver.supportedFeatures.rs232 || !canConfigureDashcams}
                        value={cfgDraft.features.rs232Peripheral}
                        onChange={(e) =>
                          setCfgDraft((p) =>
                            p
                              ? {
                                  ...p,
                                  features: {
                                    ...p.features,
                                    rs232Peripheral: e.target
                                      .value as DeviceDashcamConfig['features']['rs232Peripheral'],
                                  },
                                }
                              : p
                          )
                        }
                        className="px-2.5 py-1.5 bg-[#0B1120] border border-slate-800 rounded text-slate-100 disabled:opacity-50"
                      >
                        <option value="ninguno">Ninguno</option>
                        <option value="rfid_operador">Lector RFID Operador</option>
                        <option value="sensor_combustible">Sensor de Combustible</option>
                        <option value="dualcam_uart">DualCam UART (Teltonika)</option>
                      </select>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex justify-end">
                    <button
                      type="button"
                      disabled={!canConfigureDashcams || savingConfig}
                      onClick={handleSaveDeviceConfig}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {savingConfig ? 'Aplicando configuración...' : 'Aplicar driver y sincronizar'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-slate-400 py-8 text-center">Selecciona una unidad para configurar su dashcam.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: DRIVERS CATALOG */}
      {panelTab === 'drivers' && (
        <div className="space-y-4">
          {canConfigureDashcams && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowNewDriver((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {showNewDriver ? 'Cancelar' : 'Registrar nuevo driver'}
              </button>
            </div>
          )}

          {showNewDriver && canConfigureDashcams && (
            <form
              onSubmit={handleCreateDriverSubmit}
              className="bg-[#11192C] border border-sky-500/30 rounded-xl p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-slate-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-sky-400" />
                Alta de driver de fabricante o firmware personalizado
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <select
                  value={driverForm.vendorFamily}
                  onChange={(e) =>
                    setDriverForm((p) => ({ ...p, vendorFamily: e.target.value as DashcamVendorFamily }))
                  }
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  {(Object.keys(VENDOR_FAMILY_LABELS) as DashcamVendorFamily[]).map((fam) => (
                    <option key={fam} value={fam}>
                      {VENDOR_FAMILY_LABELS[fam]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Fabricante (ej. Howen / Teltonika)"
                  value={driverForm.vendorName}
                  onChange={(e) => setDriverForm((p) => ({ ...p, vendorName: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <input
                  type="text"
                  placeholder="Serie de equipo (ej. Hero-ME41 4G)"
                  value={driverForm.modelSeries}
                  onChange={(e) => setDriverForm((p) => ({ ...p, modelSeries: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <input
                  type="text"
                  placeholder="Código driver (ej. HOWEN_ME41_V5)"
                  value={driverForm.driverCode}
                  onChange={(e) => setDriverForm((p) => ({ ...p, driverCode: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <select
                  value={driverForm.protocol}
                  onChange={(e) => setDriverForm((p) => ({ ...p, protocol: e.target.value as ProtocolType }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                >
                  <option value="JT808/JT1078">JT808/JT1078</option>
                  <option value="Traccar">Traccar</option>
                </select>
                <input
                  type="text"
                  placeholder="Versión firmware"
                  value={driverForm.driverVersion}
                  onChange={(e) => setDriverForm((p) => ({ ...p, driverVersion: e.target.value }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
                <input
                  type="number"
                  placeholder="Puerto TCP"
                  value={driverForm.defaultPort}
                  onChange={(e) => setDriverForm((p) => ({ ...p, defaultPort: Number(e.target.value) }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
                <input
                  type="number"
                  min={1}
                  max={8}
                  placeholder="Máx. canales"
                  value={driverForm.maxChannels}
                  onChange={(e) => setDriverForm((p) => ({ ...p, maxChannels: Number(e.target.value) }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
                <input
                  type="number"
                  step={256}
                  placeholder="Bitrate kbps"
                  value={driverForm.defaultBitrateKbps}
                  onChange={(e) => setDriverForm((p) => ({ ...p, defaultBitrateKbps: Number(e.target.value) }))}
                  className="px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg font-mono text-slate-100"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { key: 'adas', label: 'ADAS' },
                    { key: 'dms', label: 'DMS' },
                    { key: 'bsd', label: 'BSD' },
                    { key: 'canJ1939', label: 'CAN J1939' },
                    { key: 'rs232', label: 'RS232' },
                    { key: 'intercomAudio', label: 'Intercom' },
                    { key: 'dualSdSsd', label: 'SD/SSD' },
                  ] as const
                ).map((cap) => (
                  <label
                    key={cap.key}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0B1120] border border-slate-800 text-slate-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={driverForm.supportedFeatures[cap.key]}
                      onChange={(e) =>
                        setDriverForm((p) => ({
                          ...p,
                          supportedFeatures: { ...p.supportedFeatures, [cap.key]: e.target.checked },
                        }))
                      }
                    />
                    <span>{cap.label}</span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <input
                  type="text"
                  placeholder="Notas técnicas de prestaciones soportadas..."
                  value={driverForm.notes}
                  onChange={(e) => setDriverForm((p) => ({ ...p, notes: e.target.value }))}
                  className="flex-1 min-w-[240px] px-3 py-2 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100"
                />
                <button
                  type="submit"
                  disabled={savingDriver}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium cursor-pointer"
                >
                  {savingDriver ? 'Registrando...' : 'Guardar driver'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F172A]">
                    <th className="py-2.5 px-4">Fabricante / Serie</th>
                    <th className="py-2.5 px-4">Código Driver / Versión</th>
                    <th className="py-2.5 px-4 font-mono">Protocolo / Puerto / Canales</th>
                    <th className="py-2.5 px-4">Prestaciones Soportadas</th>
                    <th className="py-2.5 px-4">Notas Técnicas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs">
                  {driversPagination.pagedItems.map((drv) => {
                    const caps: string[] = [];
                    if (drv.supportedFeatures.adas) caps.push('ADAS');
                    if (drv.supportedFeatures.dms) caps.push('DMS');
                    if (drv.supportedFeatures.bsd) caps.push('BSD');
                    if (drv.supportedFeatures.canJ1939) caps.push('CAN J1939');
                    if (drv.supportedFeatures.rs232) caps.push('RS232');
                    if (drv.supportedFeatures.intercomAudio) caps.push('Intercom');
                    if (drv.supportedFeatures.dualSdSsd) caps.push('SD/SSD');
                    return (
                      <tr key={drv.id} className="hover:bg-slate-800/30">
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-slate-100">
                            {drv.vendorName} · {drv.modelSeries}
                          </div>
                          <div className="text-slate-400">{VENDOR_FAMILY_LABELS[drv.vendorFamily]}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono">
                          <div className="text-sky-300">{drv.driverCode}</div>
                          <div className="text-slate-400">{drv.driverVersion}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums text-slate-200">
                          {drv.protocol} · :{drv.defaultPort} · {drv.maxChannels}CH · {drv.defaultBitrateKbps} kbps
                        </td>
                        <td className="py-2.5 px-4 font-mono text-emerald-400">{caps.join(' · ')}</td>
                        <td className="py-2.5 px-4 text-slate-400 max-w-xs">{drv.notes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={driversPagination.page}
              totalItems={driversPagination.totalItems}
              pageSize={5}
              onPageChange={driversPagination.setPage}
            />
          </div>
        </div>
      )}
    </div>
  );
}
