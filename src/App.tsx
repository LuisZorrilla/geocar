import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Coins,
  IdCard,
  Cctv,
  Film,
  LogOut,
  Map as MapIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Server,
  Truck,
  X,
} from 'lucide-react';
import type {
  AlertEvent,
  AlertPriority,
  AlertRule,
  AssetType,
  AuditLog,
  AuthSessionResponse,
  ChecklistItem,
  DashcamDriverProfile,
  DashcamVendorFamily,
  Device,
  ObdCommandEntry,
  DeviceDashcamConfig,
  DeviceUplink,
  UnmatchedDevice,
  Incident,
  IncidentStatus,
  MaintenanceDashboardMetrics,
  MaintenanceRecord,
  ModulePermissions,
  PartInventoryItem,
  PreOpChecklist,
  PreventivePlan,
  ProtocolType,
  UnitConnection,
  PublicUser,
  RoleDefinition,
  SizingConfig,
  TenantBootstrapResponse,
  Vehicle,
  VideoClip,
  WorkOrder,
  WorkOrderPartCategory,
  WorkOrderPriority,
  WorkOrderStatus,
} from './shared/types.ts';
import { apiRequest, getAuthToken, getTenantScope, setAuthToken, setTenantScope } from './lib/api.ts';
import { LoginView } from './components/LoginView.tsx';
import { LiveMonitoringView } from './components/LiveMonitoringView.tsx';
import { FleetDevicesView } from './components/FleetDevicesView.tsx';
import { AlertsIncidentsView } from './components/AlertsIncidentsView.tsx';
import { VideoConsoleView } from './components/VideoConsoleView.tsx';
import { ReportsSecurityView } from './components/ReportsSecurityView.tsx';
import { SizingRoadmapView } from './components/SizingRoadmapView.tsx';
import { CameraConfigView } from './components/CameraConfigView.tsx';
import { TenantsView } from './components/TenantsView.tsx';
import { DriversView } from './components/DriversView.tsx';
import { MoneyProvider } from './lib/money.tsx';
import { CurrenciesView } from './components/CurrenciesView.tsx';
import { ForcePasswordChange } from './components/ForcePasswordChange.tsx';
import { UnitDossierModal } from './components/UnitDossierModal.tsx';
import { OperationsView } from './components/tms/OperationsView.tsx';
import type { ReviewChecklistHandler } from './shared/checklist.ts';

type NavSection =
  | 'monitoreo'
  | 'flotas'
  | 'camaras'
  | 'alertas'
  | 'video'
  | 'reportes'
  | 'dimensionamiento'
  | 'empresas'
  | 'monedas'
  | 'choferes'
  | 'operaciones';

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  icon: typeof MapIcon;
  permKey: keyof ModulePermissions;
  /** Visible only to the global superadmin, whatever the role permissions say. */
  superadminOnly?: boolean;
  /** Visible to the superadmin and to each company's admin role. */
  driverAdminOnly?: boolean;
}> = [
  { id: 'monitoreo', label: 'Monitoreo en Vivo', icon: MapIcon, permKey: 'monitoreo' },
  { id: 'flotas', label: 'Flotas y Maquinaria', icon: Truck, permKey: 'flotas' },
  { id: 'operaciones', label: 'Operaciones', icon: Route, permKey: 'operaciones' },
  { id: 'video', label: 'Consola de Video', icon: Film, permKey: 'video' },
  { id: 'alertas', label: 'Alertas e Incidentes', icon: AlertTriangle, permKey: 'alertas' },
  { id: 'empresas', label: 'Empresas', icon: Building2, permKey: 'administracion', superadminOnly: true },
  { id: 'monedas', label: 'Monedas', icon: Coins, permKey: 'administracion', superadminOnly: true },
  { id: 'choferes', label: 'Choferes', icon: IdCard, permKey: 'administracion', driverAdminOnly: true },
  { id: 'reportes', label: 'Perfiles y Reportes', icon: BarChart3, permKey: 'reportes' },
  { id: 'camaras', label: 'Configuración de Cámaras', icon: Cctv, permKey: 'dashcams_config' },
  { id: 'dimensionamiento', label: 'Dimensionamiento', icon: Server, permKey: 'dimensionamiento' },
];

const OPERATOR_AVATAR = '/src/assets/images/operator_avatar_lead_1795020104952.jpg';

export default function App() {
  const [data, setData] = useState<TenantBootstrapResponse | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  const [activeNav, setActiveNav] = useState<NavSection>('monitoreo');
  /** Alert to highlight when opening «Alertas e Incidentes» from «En alerta». */
  const [focusAlertId, setFocusAlertId] = useState<string | null>(null);
  useEffect(() => {
    if (activeNav !== 'alertas') setFocusAlertId(null);
  }, [activeNav]);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [dossierVehicleId, setDossierVehicleId] = useState<string | null>(null);
  const [livePolling, setLivePolling] = useState(true);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  const showToast = useCallback((type: 'ok' | 'err', text: string) => {
    setToast({ type, text });
    window.setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 3600);
  }, []);

  const loadTenantWorkspace = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      setData(null);
      setCheckingSession(false);
      return;
    }
    setCheckingSession(true);
    try {
      const scope = getTenantScope();
      const url = scope ? `/api/bootstrap?scopeTenantId=${encodeURIComponent(scope)}` : '/api/bootstrap';
      const res = await apiRequest<TenantBootstrapResponse>(url);
      setData(res);
      if (res.videoClips[0]) {
        setSelectedClipId((prev) => prev ?? res.videoClips[0].id);
      }
    } catch {
      setAuthToken(null);
      setData(null);
    } finally {
      setCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    loadTenantWorkspace();
  }, [loadTenantWorkspace]);

  /** Reloads the data in place (no loading screen), so the open view keeps its state. */
  const refreshWorkspaceSilently = useCallback(async () => {
    try {
      const scope = getTenantScope();
      const url = scope ? `/api/bootstrap?scopeTenantId=${encodeURIComponent(scope)}` : '/api/bootstrap';
      setData(await apiRequest<TenantBootstrapResponse>(url));
    } catch {
      /* the next regular refresh will retry */
    }
  }, []);

  const handleLoginSuccess = async (session: AuthSessionResponse) => {
    setAuthToken(session.token);
    setTenantScope(session.user.isGlobalSuperadmin ? 'all' : null);
    setActiveNav('monitoreo');
    setSelectedClipId(null);
    setDossierVehicleId(null);
    await loadTenantWorkspace();
    showToast('ok', `Sesión iniciada en ${session.tenant.name}.`);
  };

  const handleSwitchScope = async (scopeTenantId: string) => {
    setTenantScope(scopeTenantId);
    await loadTenantWorkspace();
    const label =
      scopeTenantId === 'all'
        ? 'Todas las empresas'
        : data?.availableTenants?.find((t) => t.id === scopeTenantId)?.name ?? 'Empresa';
    showToast('ok', `Ámbito operativo: ${label}.`);
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network failure on logout
    }
    setAuthToken(null);
    setData(null);
    setDossierVehicleId(null);
  };

  /** Alert ids seen in the previous live tick (null until the first one). */
  const knownAlertIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    // Another company (or «Todas»): its alerts are not "new".
    knownAlertIds.current = null;
  }, [data?.tenant.id]);

  const handleTelemetryTick = useCallback(async () => {
    if (!data) return;
    try {
      const res = await apiRequest<{
        vehicles: Vehicle[];
        workOrders?: WorkOrder[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        alerts?: AlertEvent[];
        incidents?: Incident[];
      }>('/api/telemetry/tick', { method: 'POST' });
      // New critical alerts (e.g. a driver's SOS) since the previous tick get an on-screen notice.
      let newCritical: AlertEvent | undefined;
      if (res.alerts) {
        const known = knownAlertIds.current;
        if (known) newCritical = res.alerts.find((a) => !known.has(a.id) && a.priority === 'critica' && a.status === 'pendiente');
        knownAlertIds.current = new Set(res.alerts.map((a) => a.id));
      }
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          vehicles: res.vehicles,
          workOrders: res.workOrders ?? prev.workOrders,
          maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
          alerts: res.alerts ?? prev.alerts,
          incidents: res.incidents ?? prev.incidents,
        };
      });
      if (newCritical) {
        const a = newCritical;
        showToast('err', `${a.ruleName} · ${a.unitCode}${a.driverName ? ` · ${a.driverName}` : ''}`);
      }
    } catch {
      // Silent tick error
    }
  }, [data !== null]);

  useEffect(() => {
    if (!livePolling || !data || data.currentUser.mustChangePassword) return;
    const id = window.setInterval(() => {
      handleTelemetryTick();
    }, 4500);
    return () => window.clearInterval(id);
  }, [livePolling, data !== null, data?.currentUser.mustChangePassword, handleTelemetryTick]);

  // Mutation handlers
  const handleCreateVehicle = async (payload: {
    tenantId?: string;
    branch: string;
    group: string;
    assetType: AssetType;
    unitCode: string;
    plate: string;
    brandModel: string;
    brand?: string;
    model?: string;
    year: number;
    driverName: string;
    imei?: string;
    protocol: ProtocolType;
    connection: UnitConnection;
    deviceModel: string;
    deviceCatalogId?: string;
    driverId?: string;
    engineHours: number;
  }) => {
    try {
      const res = await apiRequest<{
        vehicle: Vehicle;
        device: Device | null;
        auditLogs: AuditLog[];
      }>('/api/vehicles', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              vehicles: [res.vehicle, ...prev.vehicles],
              devices: res.device ? [res.device, ...prev.devices] : prev.devices,
              auditLogs: res.auditLogs,
              sizing: { ...prev.sizing, vehiclesCount: prev.vehicles.length + 1 },
            }
          : prev
      );
      showToast(
        'ok',
        `Activo ${res.vehicle.unitCode} registrado ${
          payload.connection === 'smartphone' ? 'con el celular del chofer' : payload.connection === 'obd' ? 'con Telemetría OBD-II' : `con ${res.device?.protocol ?? payload.protocol}`
        }.`
      );
      // Assigning a driver can free the unit they drove before: reload so every view agrees.
      if (payload.driverId) void refreshWorkspaceSilently();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al registrar activo.';
      showToast('err', msg);
      throw err;
    }
  };

  const handleValidateDevice = async (deviceId: string) => {
    try {
      const res = await apiRequest<{ device: Device; auditLogs: AuditLog[] }>(
        `/api/devices/${deviceId}/validate`,
        { method: 'POST' }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              devices: prev.devices.map((d) => (d.id === deviceId ? res.device : d)),
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Equipo ${res.device.imei} validado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al validar equipo.');
    }
  };

  const handleUpdateDeviceDashcamConfig = async (
    deviceId: string,
    payload: {
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
  ) => {
    try {
      const res = await apiRequest<{ device: Device; devices: Device[]; auditLogs: AuditLog[] }>(
        `/api/devices/${deviceId}/dashcam-config`,
        { method: 'PUT', body: JSON.stringify(payload) }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              devices: res.devices,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Driver y prestaciones aplicadas a ${res.device.unitCode}.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al configurar dashcam.');
    }
  };

  type ObdResponse = { vehicles: Vehicle[]; devices: Device[]; unmatchedDevices?: UnmatchedDevice[]; auditLogs: AuditLog[] };
  const applyObdResponse = (res: ObdResponse) =>
    setData((prev) =>
      prev
        ? {
            ...prev,
            vehicles: res.vehicles,
            devices: res.devices,
            unmatchedDevices: res.unmatchedDevices ?? prev.unmatchedDevices,
            auditLogs: res.auditLogs,
          }
        : prev
    );

  /** Merges the latest state of one unit and its OBD-II tracker (polled while the wizard or detail is open). */
  const handleRefreshObd = useCallback(async (vehicleId: string): Promise<void> => {
    try {
      const res = await apiRequest<{ vehicle: Vehicle; device: Device | null }>(`/api/vehicles/${vehicleId}/obd`);
      setData((prev) => {
        if (!prev) return prev;
        const devices = res.device
          ? prev.devices.some((d) => d.id === res.device!.id)
            ? prev.devices.map((d) => (d.id === res.device!.id ? res.device! : d))
            : [...prev.devices, res.device]
          : prev.devices;
        return { ...prev, vehicles: prev.vehicles.map((v) => (v.id === vehicleId ? res.vehicle : v)), devices };
      });
    } catch {
      // Silent: the next poll retries.
    }
  }, []);

  const handleSyncObd = async (vehicleId: string): Promise<boolean> => {
    try {
      const res = await apiRequest<ObdResponse & { device: Device }>(`/api/vehicles/${vehicleId}/obd/sync`, { method: 'POST' });
      applyObdResponse(res);
      const p = res.device.provisioning;
      if (p?.status === 'error') showToast('err', p.message ?? 'Traccar no respondió.');
      else showToast('ok', 'Equipo dado de alta en Traccar.');
      return p?.status !== 'error';
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo dar de alta en Traccar.');
      return false;
    }
  };

  const handleObdCommand = async (vehicleId: string, commandId: string, option?: string): Promise<boolean> => {
    try {
      const res = await apiRequest<ObdResponse & { entry: ObdCommandEntry }>(`/api/vehicles/${vehicleId}/obd/commands`, {
        method: 'POST',
        body: JSON.stringify({ commandId, option }),
      });
      applyObdResponse(res);
      showToast('ok', res.entry.status === 'en_cola' ? 'Comando en cola: se enviará cuando el equipo se conecte.' : 'Comando enviado al equipo.');
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo enviar el comando.');
      // A failed send is still logged: refresh to show it.
      void handleRefreshObd(vehicleId);
      return false;
    }
  };

  const handleAssignObd = async (vehicleId: string, payload: { imei: string; catalogModelId?: string; vin?: string; apn?: string }): Promise<boolean> => {
    try {
      const res = await apiRequest<ObdResponse & { device: Device }>(`/api/vehicles/${vehicleId}/obd`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      applyObdResponse(res);
      showToast('ok', `Equipo OBD-II ${res.device.imei} asignado a ${res.device.unitCode}.`);
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo guardar el equipo OBD-II.');
      return false;
    }
  };

  const handleRemoveObd = async (vehicleId: string): Promise<boolean> => {
    try {
      applyObdResponse(await apiRequest<ObdResponse>(`/api/vehicles/${vehicleId}/obd`, { method: 'DELETE' }));
      showToast('ok', 'Equipo OBD-II retirado.');
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo quitar el equipo OBD-II.');
      return false;
    }
  };

  const handleUpdateDeviceConnection = async (
    deviceId: string,
    payload: { terminalId: string; uplink: DeviceUplink; wifiSsid?: string }
  ): Promise<boolean> => {
    try {
      const res = await apiRequest<{
        device: Device;
        devices: Device[];
        unmatchedDevices?: UnmatchedDevice[];
        auditLogs: AuditLog[];
      }>(`/api/devices/${deviceId}/connection`, { method: 'PUT', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              devices: res.devices,
              unmatchedDevices: res.unmatchedDevices ?? prev.unmatchedDevices,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Conexión de ${res.device.unitCode} actualizada.`);
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al guardar la conexión.');
      return false;
    }
  };

  const handleBatchUpdateDeviceDashcamConfig = async (
    deviceIds: string[],
    payload: {
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
  ) => {
    try {
      const res = await apiRequest<{
        updatedCount: number;
        updatedDevices: Device[];
        devices: Device[];
        auditLogs: AuditLog[];
      }>('/api/devices/dashcam-config/batch', {
        method: 'PUT',
        body: JSON.stringify({ deviceIds, ...payload }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              devices: res.devices,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Configuración sincronizada en lote para ${res.updatedCount} unidad(es).`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al aplicar configuración en lote.');
    }
  };

  const handleCreateDashcamDriver = async (payload: {
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
  }) => {
    try {
      const res = await apiRequest<{
        driver: DashcamDriverProfile;
        dashcamDrivers: DashcamDriverProfile[];
        auditLogs: AuditLog[];
      }>('/api/dashcam-drivers', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              dashcamDrivers: res.dashcamDrivers,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Driver ${res.driver.driverCode} registrado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al registrar driver.');
    }
  };

  const handleCreateWorkOrder = async (payload: {
    vehicleId: string;
    planId?: string;
    type: WorkOrder['type'];
    priority: WorkOrder['priority'];
    title: string;
    workshopOrTech: string;
    scheduledDate: string;
    parts: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCost: number; currency?: string }>;
    laborCost: number;
    laborCurrency?: string;
    notes: string;
    clearFaultsOnClose?: boolean;
  }) => {
    try {
      const res = await apiRequest<{
        workOrder: WorkOrder;
        workOrders: WorkOrder[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>('/api/work-orders', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              workOrders: res.workOrders,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Orden de trabajo ${res.workOrder.id} abierta.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al abrir orden de trabajo.');
    }
  };

  const handleUpdateWorkOrder = async (
    workOrderId: string,
    patch: {
      status?: WorkOrderStatus;
      priority?: WorkOrderPriority;
      workshopOrTech?: string;
      scheduledDate?: string;
      notes?: string;
      laborCost?: number;
      laborCurrency?: string;
      parts?: Array<{ sku: string; name: string; category: WorkOrderPartCategory; quantity: number; unitCost: number; currency?: string }>;
      clearFaultsOnClose?: boolean;
      nextServiceDate?: string;
    }
  ) => {
    try {
      const res = await apiRequest<{
        workOrder: WorkOrder;
        lowStockAlerts?: string[];
        workOrders: WorkOrder[];
        vehicles: Vehicle[];
        maintenanceRecords: MaintenanceRecord[];
        partsInventory?: PartInventoryItem[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>(`/api/work-orders/${workOrderId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              workOrders: res.workOrders,
              vehicles: res.vehicles,
              maintenanceRecords: res.maintenanceRecords,
              partsInventory: res.partsInventory ?? prev.partsInventory,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      if (res.lowStockAlerts && res.lowStockAlerts.length > 0) {
        showToast(
          'ok',
          `Orden ${res.workOrder.id} cerrada · Stock bajo mínimo: ${res.lowStockAlerts.join(', ')}.`
        );
      } else {
        showToast('ok', `Orden ${res.workOrder.id} actualizada a ${res.workOrder.status}.`);
      }
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al actualizar orden.');
    }
  };

  const handleCreatePreventivePlan = async (payload: {
    name: string;
    assetType: AssetType | 'ambos';
    intervalHours: number;
    intervalKm: number;
    intervalDays: number;
    estimatedCost: number;
    checklistFocus: string;
  }) => {
    try {
      const res = await apiRequest<{
        plan: PreventivePlan;
        preventivePlans: PreventivePlan[];
        auditLogs: AuditLog[];
      }>('/api/preventive-plans', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev ? { ...prev, preventivePlans: res.preventivePlans, auditLogs: res.auditLogs } : prev
      );
      showToast('ok', `Plan "${res.plan.name}" creado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al crear plan preventivo.');
    }
  };

  const handleUpdatePreventivePlan = async (
    planId: string,
    patch: {
      name?: string;
      assetType?: AssetType | 'ambos';
      intervalHours?: number;
      intervalKm?: number;
      intervalDays?: number;
      estimatedCost?: number;
      checklistFocus?: string;
    }
  ) => {
    try {
      const res = await apiRequest<{
        plan: PreventivePlan;
        preventivePlans: PreventivePlan[];
        auditLogs: AuditLog[];
      }>(`/api/preventive-plans/${planId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setData((prev) =>
        prev ? { ...prev, preventivePlans: res.preventivePlans, auditLogs: res.auditLogs } : prev
      );
      showToast('ok', `Plan "${res.plan.name}" actualizado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al actualizar plan.');
    }
  };

  const handleAssignPreventivePlan = async (planId: string, vehicleIds: string[]) => {
    try {
      const res = await apiRequest<{
        plan: PreventivePlan;
        createdOrders: WorkOrder[];
        vehicles: Vehicle[];
        workOrders: WorkOrder[];
        preventivePlans: PreventivePlan[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>(`/api/preventive-plans/${planId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ vehicleIds }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              vehicles: res.vehicles,
              workOrders: res.workOrders,
              preventivePlans: res.preventivePlans,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast(
        'ok',
        res.createdOrders.length > 0
          ? `Plan asignado · ${res.createdOrders.length} OT preventiva(s) disparada(s).`
          : `Plan "${res.plan.name}" asignado a ${vehicleIds.length} unidad(es).`
      );
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al asignar plan.');
    }
  };

  const handleEvaluateMaintenancePlans = async () => {
    try {
      const res = await apiRequest<{
        evaluatedCount: number;
        createdOrders: WorkOrder[];
        escalatedCount: number;
        vehicles: Vehicle[];
        workOrders: WorkOrder[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>('/api/maintenance/evaluate-plans', { method: 'POST' });
      setData((prev) =>
        prev
          ? {
              ...prev,
              vehicles: res.vehicles,
              workOrders: res.workOrders,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast(
        'ok',
        `Evaluación (${res.evaluatedCount} un.): ${res.createdOrders.length} OT(s) nuevas · ${res.escalatedCount} escalada(s).`
      );
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al evaluar umbrales preventivos.');
    }
  };

  const handleTogglePreventivePlan = async (planId: string) => {
    try {
      const res = await apiRequest<{
        plan: PreventivePlan;
        preventivePlans: PreventivePlan[];
        auditLogs: AuditLog[];
      }>(`/api/preventive-plans/${planId}/toggle`, { method: 'PATCH' });
      setData((prev) =>
        prev ? { ...prev, preventivePlans: res.preventivePlans, auditLogs: res.auditLogs } : prev
      );
      showToast('ok', `Plan "${res.plan.name}" ${res.plan.active ? 'activado' : 'pausado'}.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al modificar plan.');
    }
  };

  const handleUpsertPartInventory = async (payload: {
    sku: string;
    name: string;
    category: PartInventoryItem['category'];
    unit: string;
    stockQty: number;
    minStock: number;
    unitCost: number;
    unitCostCurrency?: string;
    warehouseLocation: string;
  }) => {
    try {
      const res = await apiRequest<{
        item: PartInventoryItem;
        partsInventory: PartInventoryItem[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>('/api/parts-inventory', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              partsInventory: res.partsInventory,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `SKU ${res.item.sku} guardado en almacén.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al guardar SKU en almacén.');
    }
  };

  const handleAdjustPartStock = async (itemId: string, deltaQty: number, reason: string) => {
    try {
      const res = await apiRequest<{
        item: PartInventoryItem;
        partsInventory: PartInventoryItem[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>(`/api/parts-inventory/${itemId}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ deltaQty, reason }),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              partsInventory: res.partsInventory,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `${res.item.sku}: existencia actual ${res.item.stockQty} ${res.item.unit}.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al ajustar existencias.');
    }
  };

  const handleCreateChecklist = async (payload: {
    vehicleId: string;
    driverName: string;
    shift: PreOpChecklist['shift'];
    items: ChecklistItem[];
    summaryNote: string;
    createWorkOrderIfFailed: boolean;
  }) => {
    try {
      const res = await apiRequest<{
        checklist: PreOpChecklist;
        workOrder?: WorkOrder;
        checklists: PreOpChecklist[];
        workOrders: WorkOrder[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>('/api/checklists', { method: 'POST', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              checklists: res.checklists,
              workOrders: res.workOrders,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast(
        'ok',
        res.workOrder
          ? `Checklist ${res.checklist.id} guardado · Generó ${res.workOrder.id}.`
          : `Checklist ${res.checklist.id} registrado.`
      );
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al registrar checklist.');
    }
  };

  /** Returns true when the review was saved (the dialog closes only then). */
  const handleReviewChecklist: ReviewChecklistHandler = async (checklistId, payload) => {
    try {
      const res = await apiRequest<{
        checklist: PreOpChecklist;
        workOrder?: WorkOrder;
        checklists: PreOpChecklist[];
        workOrders: WorkOrder[];
        maintenanceDashboard?: MaintenanceDashboardMetrics;
        auditLogs: AuditLog[];
      }>(`/api/checklists/${encodeURIComponent(checklistId)}/review`, { method: 'PATCH', body: JSON.stringify(payload) });
      setData((prev) =>
        prev
          ? {
              ...prev,
              checklists: res.checklists,
              workOrders: res.workOrders,
              maintenanceDashboard: res.maintenanceDashboard ?? prev.maintenanceDashboard,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast(
        'ok',
        res.workOrder ? `Checklist ${res.checklist.id} revisado · Generó ${res.workOrder.id}.` : `Checklist ${res.checklist.id} revisado.`
      );
      return true;
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al revisar el checklist.');
      return false;
    }
  };

  const handleAcknowledgeAlert = async (alertId: string) => {
    try {
      const res = await apiRequest<{ alert: AlertEvent; vehicles: Vehicle[]; auditLogs: AuditLog[] }>(
        `/api/alerts/${alertId}/acknowledge`,
        { method: 'POST' }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              alerts: prev.alerts.map((a) => (a.id === alertId ? res.alert : a)),
              vehicles: res.vehicles,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Alerta ${alertId} confirmada.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al confirmar alerta.');
    }
  };

  const handleEscalateAlert = async (alertId: string) => {
    try {
      const res = await apiRequest<{
        alert: AlertEvent;
        incident: Incident;
        incidents: Incident[];
        auditLogs: AuditLog[];
      }>(`/api/alerts/${alertId}/escalate`, { method: 'POST' });
      setData((prev) =>
        prev
          ? {
              ...prev,
              alerts: prev.alerts.map((a) => (a.id === alertId ? res.alert : a)),
              incidents: res.incidents,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Incidente ${res.incident.id} creado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al escalar alerta.');
    }
  };

  const handleUpdateIncident = async (
    incidentId: string,
    patch: { status?: IncidentStatus; resolutionNote?: string }
  ) => {
    try {
      const res = await apiRequest<{ incident: Incident; vehicles: Vehicle[]; auditLogs: AuditLog[] }>(
        `/api/incidents/${incidentId}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              incidents: prev.incidents.map((i) => (i.id === incidentId ? res.incident : i)),
              vehicles: res.vehicles,
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Incidente ${incidentId} actualizado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al actualizar incidente.');
    }
  };

  const handleToggleRule = async (ruleId: string) => {
    try {
      const res = await apiRequest<{ rule: AlertRule; auditLogs: AuditLog[] }>(
        `/api/alert-rules/${ruleId}/toggle`,
        { method: 'PATCH' }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              alertRules: prev.alertRules.map((r) => (r.id === ruleId ? res.rule : r)),
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Regla "${res.rule.name}" ${res.rule.active ? 'activada' : 'pausada'}.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al modificar regla.');
    }
  };

  const handleCreateRule = async (payload: {
    name: string;
    conditionType: AlertRule['conditionType'];
    thresholdLabel: string;
    priority: AlertPriority;
    autoCreateClip: boolean;
  }) => {
    try {
      const res = await apiRequest<{ rule: AlertRule; auditLogs: AuditLog[] }>('/api/alert-rules', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setData((prev) =>
        prev
          ? {
              ...prev,
              alertRules: [res.rule, ...prev.alertRules],
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', `Regla "${res.rule.name}" creada.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al crear regla.');
    }
  };

  const handleRequestVideoStream = async (vehicleId: string, channel: VideoClip['channel'] = 'dual') => {
    try {
      const res = await apiRequest<{ clip: VideoClip; auditLogs: AuditLog[] }>(
        '/api/video-clips/request-stream',
        { method: 'POST', body: JSON.stringify({ vehicleId, channel }) }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              videoClips: [res.clip, ...prev.videoClips],
              auditLogs: res.auditLogs,
            }
          : prev
      );
      setSelectedClipId(res.clip.id);
      setActiveNav('video');
      showToast('ok', `Clip JT1078 ${res.clip.id} capturado en MinIO.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al solicitar video JT1078.');
    }
  };

  const handleToggleClipRetention = async (clipId: string) => {
    try {
      const res = await apiRequest<{ clip: VideoClip; auditLogs: AuditLog[] }>(
        `/api/video-clips/${clipId}/retention`,
        { method: 'PATCH' }
      );
      setData((prev) =>
        prev
          ? {
              ...prev,
              videoClips: prev.videoClips.map((c) => (c.id === clipId ? res.clip : c)),
              auditLogs: res.auditLogs,
            }
          : prev
      );
      showToast('ok', res.clip.retentionLocked ? 'Retención legal bloqueada (90d).' : 'Retención estándar restaurada.');
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al cambiar retención.');
    }
  };

  const handleSaveSizing = async (patch: Partial<SizingConfig>) => {
    try {
      const res = await apiRequest<{ sizing: SizingConfig; auditLogs: AuditLog[] }>('/api/sizing', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      setData((prev) => (prev ? { ...prev, sizing: res.sizing, auditLogs: res.auditLogs } : prev));
      showToast('ok', 'Escenario de dimensionamiento guardado.');
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al guardar escenario.');
    }
  };

  const handleCreateRole = async (payload: {
    tenantId?: string;
    name: string;
    description: string;
    permissions: ModulePermissions;
  }) => {
    const res = await apiRequest<{ role: RoleDefinition; roles: RoleDefinition[]; auditLogs: AuditLog[] }>(
      '/api/roles',
      { method: 'POST', body: JSON.stringify(payload) }
    );
    setData((prev) => (prev ? { ...prev, roles: res.roles, auditLogs: res.auditLogs } : prev));
    showToast('ok', `Perfil "${res.role.name}" creado.`);
  };

  const handleUpdateRole = async (roleId: string, payload: { permissions: ModulePermissions }) => {
    try {
      const res = await apiRequest<{ role: RoleDefinition; roles: RoleDefinition[]; auditLogs: AuditLog[] }>(
        `/api/roles/${roleId}`,
        { method: 'PATCH', body: JSON.stringify(payload) }
      );
      setData((prev) => (prev ? { ...prev, roles: res.roles, auditLogs: res.auditLogs } : prev));
      showToast('ok', `Permisos de "${res.role.name}" actualizados.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al actualizar perfil.');
    }
  };

  const handleCreateUser = async (payload: {
    tenantId?: string;
    name: string;
    username: string;
    password: string;
    roleId: string;
  }) => {
    const res = await apiRequest<{ user: PublicUser; users: PublicUser[]; auditLogs: AuditLog[] }>(
      '/api/users',
      { method: 'POST', body: JSON.stringify(payload) }
    );
    setData((prev) => (prev ? { ...prev, users: res.users, auditLogs: res.auditLogs } : prev));
    showToast('ok', `Usuario ${res.user.name} creado.`);
  };

  const handleUpdateUser = async (userId: string, patch: { roleId?: string; status?: 'activo' | 'inactivo' }) => {
    try {
      const res = await apiRequest<{ user: PublicUser; users: PublicUser[]; auditLogs: AuditLog[] }>(
        `/api/users/${userId}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
      setData((prev) => (prev ? { ...prev, users: res.users, auditLogs: res.auditLogs } : prev));
      showToast('ok', `Usuario ${res.user.name} actualizado.`);
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al actualizar usuario.');
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-[#0B1120] text-slate-200 flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-[#11192C] border border-slate-800 rounded-xl p-6 space-y-3 text-center">
          <div className="text-sm font-semibold text-slate-100">Vigilant GeoCar</div>
          <div className="text-xs text-slate-400">Verificando sesión de empresa...</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  if (data.currentUser.mustChangePassword) {
    return (
      <ForcePasswordChange
        userName={data.currentUser.name}
        username={data.currentUser.username}
        tenantName={data.tenant.name}
        onChanged={async () => {
          await loadTenantWorkspace();
          showToast('ok', 'Contraseña actualizada. ¡Bienvenido!');
        }}
        onLogout={handleLogout}
      />
    );
  }

  const isSuperadmin = Boolean(data.currentUser.isGlobalSuperadmin);
  const isDriverAdmin = isSuperadmin || Boolean(data.currentRole.isSystemAdminRole);
  const visibleNavItems = NAV_ITEMS.filter((item) =>
    item.superadminOnly
      ? isSuperadmin
      : item.driverAdminOnly
        ? isDriverAdmin
        : data.currentRole.permissions[item.permKey] !== 'none'
  );
  const pendingAlertsCount = data.alerts.filter((a) => a.status === 'pendiente').length;
  const openIncidentsCount = data.incidents.filter((i) => i.status !== 'resuelto').length;
  const currentNavLabel = NAV_ITEMS.find((n) => n.id === activeNav)?.label ?? 'Monitoreo en Vivo';

  return (
    <MoneyProvider data={data}>
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex">
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Collapsible Left Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 bg-[#0F172A] border-r border-slate-800/90 flex flex-col justify-between transition-[width,transform] duration-200 shrink-0 ${
          leftCollapsed ? 'lg:w-[68px]' : 'lg:w-[252px]'
        } w-[252px] ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div>
          <div className="h-14 px-4 flex items-center justify-between border-b border-slate-800/80">
            {!leftCollapsed && (
              <span className="font-display font-bold text-base tracking-tight text-slate-100 whitespace-nowrap truncate">
                Vigilant GeoCar
              </span>
            )}
            <button
              type="button"
              onClick={() => setLeftCollapsed((c) => !c)}
              className="hidden lg:inline-flex p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 cursor-pointer mx-auto"
              title={leftCollapsed ? 'Expandir menú izquierdo' : 'Minimizar menú izquierdo'}
              aria-label={leftCollapsed ? 'Expandir menú izquierdo' : 'Minimizar menú izquierdo'}
            >
              {leftCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 text-slate-400 hover:text-slate-100"
              aria-label="Cerrar menú"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="p-2.5 space-y-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={leftCollapsed ? item.label : undefined}
                  onClick={() => {
                    setActiveNav(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center ${
                    leftCollapsed ? 'justify-center px-2' : 'justify-between px-3'
                  } gap-2 py-2.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-sky-600/15 text-sky-300 border border-sky-500/30'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2.5 whitespace-nowrap">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-sky-400' : 'text-slate-400'}`} />
                    {!leftCollapsed && <span>{item.label}</span>}
                  </span>
                  {!leftCollapsed && item.id === 'alertas' && (pendingAlertsCount > 0 || openIncidentsCount > 0) && (
                    <span className="font-mono tabular-nums text-[11px] text-rose-400">
                      {pendingAlertsCount + openIncidentsCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-3 border-t border-slate-800/80 text-xs">
          {!leftCollapsed ? (
            <div className="space-y-1">
              <div className="text-slate-300 font-medium truncate">{data.tenant.name}</div>
              <div className="font-mono tabular-nums text-slate-400">
                {data.vehicles.length} activos · {data.tenant.city}
              </div>
              <div className="text-slate-500">
                {data.currentUser.isGlobalSuperadmin ? 'Acceso global multiempresa' : 'Aislamiento exclusivo'}
              </div>
            </div>
          ) : (
            <div className="text-center font-mono text-[11px] text-slate-400" title={data.tenant.name}>
              {data.vehicles.length}
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean 3-zone Top Bar */}
        <header className="h-14 px-4 lg:px-6 bg-[#0F172A] border-b border-slate-800/90 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-lg text-slate-300 hover:bg-slate-800"
              aria-label="Abrir navegación"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm truncate">
              {data.currentUser.isGlobalSuperadmin && data.availableTenants ? (
                <select
                  aria-label="Cambiar ámbito de empresa"
                  value={data.activeScopeTenantId ?? 'all'}
                  onChange={(e) => handleSwitchScope(e.target.value)}
                  className="px-2.5 py-1 bg-[#0B1120] border border-sky-500/40 rounded-lg text-xs text-sky-300 font-medium focus:outline-none focus:border-sky-400 cursor-pointer"
                >
                  <option value="all">Todas las empresas ({data.availableTenants.length})</option>
                  {data.availableTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sky-400 font-medium truncate max-w-[180px] hidden sm:inline">
                  {data.tenant.name}
                </span>
              )}
              <span className="text-slate-600 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-100 truncate">{currentNavLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden md:flex items-center gap-2 text-xs">
              <span className="text-slate-200 font-medium">{data.currentUser.name}</span>
              <span className="text-slate-600">·</span>
              <span className="text-sky-300">{data.currentRole.name}</span>
            </div>

            {!avatarBroken ? (
              <img
                src={OPERATOR_AVATAR}
                alt={data.currentUser.name}
                referrerPolicy="no-referrer"
                onError={() => setAvatarBroken(true)}
                className="w-8 h-8 rounded-full object-cover border border-slate-700 hidden sm:block"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 hidden sm:flex items-center justify-center text-xs font-semibold text-slate-200">
                {data.currentUser.name.slice(0, 2).toUpperCase()}
              </div>
            )}

            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5 text-slate-400" />
              Salir
            </button>
          </div>
        </header>

        {/* Notification Toast */}
        {toast && (
          <div className="fixed bottom-5 right-5 z-50 max-w-sm px-4 py-2.5 rounded-lg border text-xs font-medium shadow-lg bg-[#0F172A] border-slate-700 text-slate-100 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                toast.type === 'ok' ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
            <span>{toast.text}</span>
          </div>
        )}

        {/* Viewport Content */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">
          {activeNav === 'monitoreo' && (
            <LiveMonitoringView
              vehicles={data.vehicles}
              devices={data.devices}
              alerts={data.alerts}
              tenant={data.tenant}
              activeRole={data.currentRole}
              livePolling={livePolling}
              onToggleLivePolling={() => setLivePolling((p) => !p)}
              onTickNow={handleTelemetryTick}
              onRequestVideo={(vid) => handleRequestVideoStream(vid, 'dual')}
              onOpenDossier={(vid) => setDossierVehicleId(vid)}
              onGoToAlerts={(alertId) => {
                setFocusAlertId(alertId ?? null);
                setActiveNav('alertas');
              }}
            />
          )}

          {activeNav === 'flotas' && (
            <FleetDevicesView
              vehicles={data.vehicles}
              devices={data.devices}
              maintenanceRecords={data.maintenanceRecords}
              maintenanceDashboard={data.maintenanceDashboard}
              workOrders={data.workOrders}
              preventivePlans={data.preventivePlans}
              partsInventory={data.partsInventory}
              checklists={data.checklists}
              tenant={data.tenant}
              availableTenants={data.availableTenants}
              drivers={data.drivers}
              activeRole={data.currentRole}
              isGlobalSuperadmin={data.currentUser.isGlobalSuperadmin}
              onCreateVehicle={handleCreateVehicle}
              onCreateWorkOrder={handleCreateWorkOrder}
              onUpdateWorkOrder={handleUpdateWorkOrder}
              onCreatePreventivePlan={handleCreatePreventivePlan}
              onUpdatePreventivePlan={handleUpdatePreventivePlan}
              onAssignPreventivePlan={handleAssignPreventivePlan}
              onEvaluateMaintenancePlans={handleEvaluateMaintenancePlans}
              onTogglePreventivePlan={handleTogglePreventivePlan}
              onUpsertPartInventory={handleUpsertPartInventory}
              onAdjustPartStock={handleAdjustPartStock}
              onCreateChecklist={handleCreateChecklist}
              onReviewChecklist={handleReviewChecklist}
              onOpenDossier={(vid) => setDossierVehicleId(vid)}
            />
          )}

          {activeNav === 'camaras' && (
            <CameraConfigView
              tenant={data.tenant}
              availableTenants={data.availableTenants}
              devices={data.devices}
              dashcamDrivers={data.dashcamDrivers}
              activeRole={data.currentRole}
              isGlobalSuperadmin={data.currentUser.isGlobalSuperadmin}
              onValidateDevice={handleValidateDevice}
              onUpdateDeviceConfig={handleUpdateDeviceDashcamConfig}
              onBatchUpdateDeviceConfig={handleBatchUpdateDeviceDashcamConfig}
              onCreateDashcamDriver={handleCreateDashcamDriver}
              deviceConnection={data.deviceConnection}
              unmatchedDevices={data.unmatchedDevices}
              onUpdateConnection={handleUpdateDeviceConnection}
              vehicles={data.vehicles}
              onAssignObd={handleAssignObd}
              onRemoveObd={handleRemoveObd}
              onRefreshObd={handleRefreshObd}
              onSyncObd={handleSyncObd}
              onObdCommand={handleObdCommand}
              onNotify={showToast}
              onDeviceConnectionChange={(dc) => setData((prev) => (prev ? { ...prev, deviceConnection: dc } : prev))}
            />
          )}

          {activeNav === 'alertas' && (
            <AlertsIncidentsView
              alerts={data.alerts}
              incidents={data.incidents}
              alertRules={data.alertRules}
              activeRole={data.currentRole}
              onAcknowledgeAlert={handleAcknowledgeAlert}
              onEscalateAlert={handleEscalateAlert}
              onUpdateIncident={handleUpdateIncident}
              onToggleRule={handleToggleRule}
              onCreateRule={handleCreateRule}
              onOpenClip={(clipId) => {
                setSelectedClipId(clipId);
                setActiveNav('video');
              }}
              focusAlertId={focusAlertId}
            />
          )}

          {activeNav === 'video' && (
            <VideoConsoleView
              clips={data.videoClips}
              vehicles={data.vehicles}
              activeRole={data.currentRole}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onRequestStream={handleRequestVideoStream}
              onToggleRetention={handleToggleClipRetention}
            />
          )}

          {activeNav === 'reportes' && (
            <ReportsSecurityView
              tenant={data.tenant}
              availableTenants={data.availableTenants}
              activeScopeTenantId={data.activeScopeTenantId}
              currentUser={data.currentUser}
              vehicles={data.vehicles}
              alerts={data.alerts}
              incidents={data.incidents}
              videoClips={data.videoClips}
              roles={data.roles}
              users={data.users}
              auditLogs={data.auditLogs}
              activeRole={data.currentRole}
              onSwitchScope={handleSwitchScope}
              onCreateRole={handleCreateRole}
              onUpdateRole={handleUpdateRole}
              onCreateUser={handleCreateUser}
              onUpdateUser={handleUpdateUser}
            />
          )}

          {activeNav === 'empresas' && isSuperadmin && (
            <TenantsView
              showToast={showToast}
              onTenantsChanged={loadTenantWorkspace}
              onViewTenant={async (tenantId) => {
                await handleSwitchScope(tenantId);
                setActiveNav('monitoreo');
              }}
            />
          )}

          {activeNav === 'monedas' && isSuperadmin && (
            <CurrenciesView showToast={showToast} onChanged={() => void refreshWorkspaceSilently()} />
          )}

          {activeNav === 'operaciones' && (
            <OperationsView
              tenant={data.tenant}
              vehicles={data.vehicles}
              drivers={data.drivers}
              canWrite={isSuperadmin || data.currentRole.permissions.operaciones === 'full' || data.currentRole.permissions.operaciones === 'write'}
              canApprove={isSuperadmin || Boolean(data.currentRole.isSystemAdminRole) || data.currentRole.permissions.operaciones === 'full'}
              onDataChanged={() => void refreshWorkspaceSilently()}
            />
          )}

          {activeNav === 'choferes' && isDriverAdmin && (
            <DriversView
              tenant={data.tenant}
              availableTenants={data.availableTenants}
              vehicles={data.vehicles}
              drivers={data.drivers}
              phoneServerUrl={data.deviceConnection?.phoneServerUrl}
              onDataChanged={() => void refreshWorkspaceSilently()}
            />
          )}

          {activeNav === 'dimensionamiento' && (
            <SizingRoadmapView
              sizing={data.sizing}
              activeRole={data.currentRole}
              isGlobalSuperadmin={Boolean(data.currentUser.isGlobalSuperadmin)}
              onSaveSizing={handleSaveSizing}
            />
          )}
        </main>
      </div>

      {/* Vehicle / Heavy Machinery Dossier & Maintenance Modal */}
      <UnitDossierModal
        vehicleId={dossierVehicleId}
        liveVehicle={dossierVehicleId ? data.vehicles.find((v) => v.id === dossierVehicleId) ?? null : null}
        preventivePlans={data.preventivePlans}
        checklists={data.checklists}
        activeRole={data.currentRole}
        onClose={() => setDossierVehicleId(null)}
        onMaintenanceAdded={async ({ vehicle, maintenanceRecords }) => {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  vehicles: prev.vehicles.map((v) => (v.id === vehicle.id ? vehicle : v)),
                  maintenanceRecords,
                }
              : prev
          );
          showToast('ok', `Mantenimiento registrado para ${vehicle.unitCode}.`);
          try {
            const scope = getTenantScope();
            const url = scope
              ? `/api/maintenance/dashboard?scopeTenantId=${encodeURIComponent(scope)}`
              : '/api/maintenance/dashboard';
            const freshMetrics = await apiRequest<MaintenanceDashboardMetrics>(url);
            setData((prev) => (prev ? { ...prev, maintenanceDashboard: freshMetrics } : prev));
          } catch {
            // Ignore background refresh error
          }
        }}
      />
    </div>
    </MoneyProvider>
  );
}
