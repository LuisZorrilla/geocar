import type { CurrencyChange, CurrencyCode, CurrencyDef, ExchangeRate, MoneySnapshot } from './currency.ts';
import type { DriverAuthState, DriverAuthorization, DriverDocument, DriverProfile } from './drivers.ts';
export type AssetType = 'vehiculo' | 'maquinaria_pesada';

export type MaintenanceStatus = 'al_dia' | 'proximo' | 'vencido';

export type OperationalStatus = 'en_ruta' | 'detenido' | 'alerta' | 'sin_senal';

export type ProtocolType = 'JT808/JT1078' | 'Traccar';
/**
 * How a new unit reports, as chosen in «Registrar vehículo o maquinaria»: dashcam (JT/T 808 + 1078),
 * Traccar-native tracker, OBD-II tracker (Telemetría OBD-II module) or the assigned driver's phone (no hardware).
 */
export type UnitConnection = 'dashcam' | 'traccar' | 'obd' | 'smartphone';

export type LinkStatus = 'conectado' | 'intermitente' | 'desconectado';

export type AlertPriority = 'critica' | 'alta' | 'media' | 'informativa';

export type AlertStatus = 'pendiente' | 'confirmada' | 'escalada';

export type IncidentStatus = 'abierto' | 'en_investigacion' | 'escalado' | 'resuelto';

export type VideoMode = 'clips_eventos' | 'bajo_demanda' | 'grabacion_continua';

export type HostingModel = 'cloud_linux' | 'on_premise' | 'hibrido';

export type StageStatus = 'completada' | 'en_progreso' | 'pendiente';

export type PermissionLevel = 'full' | 'write' | 'read' | 'none';

export type RoleId = string;

export type WorkOrderStatus = 'abierta' | 'en_taller' | 'esperando_refacciones' | 'completada' | 'cancelada';

export type WorkOrderPriority = 'baja' | 'media' | 'alta' | 'critica';

export type WorkOrderPartCategory = 'refaccion' | 'insumo' | 'mano_obra';

export type ChecklistItemStatus = 'ok' | 'falla' | 'na';

export type PreOpChecklistResult = 'aprobado' | 'con_observaciones' | 'reprobado';

export type DashcamVendorFamily = 'howen_streamax' | 'jimi_concox' | 'teltonika_fmc' | 'hikvision_dahua' | 'jt808_generico';

export interface ModulePermissions {
  administracion: PermissionLevel;
  flotas: PermissionLevel;
  dispositivos: PermissionLevel;
  dashcams_config: PermissionLevel;
  monitoreo: PermissionLevel;
  alertas: PermissionLevel;
  incidentes: PermissionLevel;
  video: PermissionLevel;
  reportes: PermissionLevel;
  dimensionamiento: PermissionLevel;
}

export interface Tenant {
  id: string;
  name: string;
  taxId: string;
  city: string;
  branches: string[];
  vehicleQuota: number;
  retentionDays: number;
  planTier: string;
  status: TenantStatus;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  createdAt?: string;
  /** Currency of every amount of the company; null until the superadmin defines it. */
  currency?: CurrencyCode | null;
  /** Currency of the reference equivalent shown next to amounts (default USD). */
  referenceCurrency?: CurrencyCode;
}

export type TenantStatus = 'activo' | 'piloto' | 'suspendido';

/** Row of the superadmin company list. */
export interface TenantSummary extends Tenant {
  vehicleCount: number;
  userCount: number;
  adminUsername: string | null;
  adminName: string | null;
}

export interface UserAccount {
  id: string;
  tenantId: string;
  name: string;
  username: string;
  /** scrypt hash (see server/auth/password.ts). Never sent to the client. */
  passwordHash: string;
  roleId: string;
  isCompanyAdmin: boolean;
  isHiddenSuperadmin?: boolean;
  status: 'activo' | 'inactivo';
  createdAt: string;
  failedAttempts?: number;
  /** ISO timestamp until which login is blocked after repeated failures. */
  lockedUntil?: string | null;
  /** Set for temporary passwords: the user must choose a new one before using the panel. */
  mustChangePassword?: boolean;
}

export interface PublicUser {
  id: string;
  tenantId: string;
  name: string;
  username: string;
  roleId: string;
  roleName: string;
  isCompanyAdmin: boolean;
  isGlobalSuperadmin?: boolean;
  status: 'activo' | 'inactivo';
  createdAt: string;
  mustChangePassword?: boolean;
}

export interface Driver {
  id: string;
  tenantId: string;
  branch: string;
  /** Display name, "Apellido, Nombre" for drivers created with the registry. */
  name: string;
  licenseNumber: string;
  phone: string;
  status: 'activo' | 'descanso' | 'suspendido';
  firstName?: string;
  lastName?: string;
  dni?: string;
  cuil?: string;
  birthDate?: string;
  email?: string;
  address?: string;
  emergencyContact?: { name: string; phone: string };
  employeeNumber?: string;
  hireDate?: string;
  profile?: DriverProfile;
  dangerousGoods?: boolean;
  licenseClasses?: string[];
  licenseJurisdiction?: string;
  documents?: DriverDocument[];
  /** false = manually disabled (independent of documents). Missing = enabled. */
  enabled?: boolean;
  disabledReason?: string;
  disabledNote?: string;
  disabledAt?: string;
  disabledBy?: string;
  /** Last authorization state seen by the expiry sweep, to alert once per transition. */
  lastAuthState?: DriverAuthState;
  /** Most recent changes first (capped), shown in the driver sheet. */
  history?: DriverHistoryEntry[];
  /** Driver's smartphone running Traccar Client (tracks the driver while assigned to a unit). */
  phoneTracker?: DriverPhoneTracker;
  createdAt?: string;
  updatedAt?: string;
}

export type PhonePlatform = 'android' | 'ios';

/**
 * manual = Traccar API not configured (create it by hand); error = Traccar API failed;
 * pendiente_app = created in Traccar, the app is not configured yet; conectado = it already reported.
 */
export type PhoneProvisioningStatus = 'manual' | 'error' | 'pendiente_app' | 'conectado';

export interface DriverPhoneTracker {
  /** Traccar uniqueId, generated by the panel (GC-########). Typed into Traccar Client as "Device identifier". */
  identifier: string;
  platform: PhonePlatform;
  traccarId?: number;
  provisioning?: { status: PhoneProvisioningStatus; message?: string; at: string; firstReportAt?: string };
  /** Last report of any kind (also outside a shift). */
  lastSeenAt?: string;
  /** Last accepted position; only stored while the driver has a unit assigned. */
  lastFix?: { lat: number; lng: number; at: string; speedKmh: number; accuracyM?: number; vehicleId?: string };
  batteryPct?: number;
  charging?: boolean;
  /** Alerts already raised for the current assignment (avoid repeating them). */
  lowBatteryAlertFor?: string;
  /** lastSeenAt of the outage already alerted as «sin señal». */
  offlineAlertFor?: string;
  createdAt: string;
}

/** Row of the «Conexión Smartphone» tab. */
export interface PhoneListItem {
  driverId: string;
  tenantId: string;
  tenantName?: string;
  driverName: string;
  driverPhone: string;
  enabled: boolean;
  assignedVehicle?: { id: string; unitCode: string; plate: string; positionSource?: Vehicle['positionSource'] };
  tracker?: DriverPhoneTracker;
}

export interface DriverHistoryEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

/** Driver row of the paginated registry, with derived data. */
export interface DriverListItem extends Driver {
  authorization: DriverAuthorization;
  assignedVehicle?: { id: string; unitCode: string; plate: string };
  tenantName?: string;
}

export interface DriverCounts {
  total: number;
  habilitado: number;
  por_vencer: number;
  pendiente: number;
  no_autorizado: number;
  deshabilitado: number;
  sinRespaldo: number;
}

export interface DriverPage {
  items: DriverListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: DriverCounts;
}

export interface FaultCode {
  code: string;
  system: string;
  description: string;
  severity: 'critica' | 'advertencia';
  /** Where the code came from: the OBD-II port, a CAN bus or the demo data. */
  source?: 'obd' | 'can' | 'simulada';
  firstSeenAt?: string;
  /** Corrective work order opened for this code. */
  workOrderId?: string;
}

export interface MaintenanceRecord {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  type: 'preventivo' | 'correctivo' | 'inspeccion';
  title: string;
  performedAt: string;
  engineHoursAtService: number;
  odometerAtService: number;
  nextServiceDate?: string;
  workshopOrTech: string;
  cost: number;
  notes: string;
  status: 'completado' | 'programado';
}

export interface WorkOrderPart {
  id: string;
  sku: string;
  name: string;
  category: WorkOrderPartCategory;
  quantity: number;
  unitCost: number;
  subtotal: number;
  /** Unit cost as loaded, when it was in another currency. */
  original?: MoneySnapshot;
}

export interface PartInventoryItem {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: 'refaccion' | 'insumo';
  unit: string;
  stockQty: number;
  minStock: number;
  unitCost: number;
  /** Unit cost as loaded, when it was in another currency. */
  unitCostOriginal?: MoneySnapshot;
  warehouseLocation: string;
  updatedAt: string;
}

export interface WorkOrder {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  plate: string;
  assetType: AssetType;
  planId?: string;
  type: 'preventivo' | 'correctivo' | 'inspeccion';
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  title: string;
  workshopOrTech: string;
  scheduledDate: string;
  completedAt?: string;
  engineHoursAtOrder: number;
  odometerAtOrder: number;
  parts: WorkOrderPart[];
  laborCost: number;
  /** Labor as loaded, when it was in another currency. */
  laborOriginal?: MoneySnapshot;
  partsCost: number;
  totalCost: number;
  notes: string;
  clearFaultsOnClose?: boolean;
  autoGenerated?: boolean;
  stockDeducted?: boolean;
  createdAt: string;
}

export interface PreventivePlan {
  id: string;
  tenantId: string;
  name: string;
  assetType: AssetType | 'ambos';
  intervalHours: number;
  intervalKm: number;
  intervalDays: number;
  estimatedCost: number;
  checklistFocus: string;
  active: boolean;
  updatedAt: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistItemStatus;
  note?: string;
}

export interface PreOpChecklist {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  assetType: AssetType;
  driverName: string;
  shift: 'Matutino' | 'Vespertino' | 'Nocturno';
  engineHours: number;
  odometerKm: number;
  result: PreOpChecklistResult;
  items: ChecklistItem[];
  summaryNote: string;
  linkedWorkOrderId?: string;
  submittedAt: string;
  /** Supervisor review. The inspection itself (items, result) is never modified: it is the evidence. */
  review?: ChecklistReview;
}

export type ChecklistReviewDecision = 'apto' | 'apto_con_restriccion' | 'no_apto';

export interface ChecklistReview {
  decision: ChecklistReviewDecision;
  note: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface DashcamDriverProfile {
  id: string;
  vendorFamily: DashcamVendorFamily;
  vendorName: string;
  modelSeries: string;
  driverCode: string;
  driverVersion: string;
  protocol: ProtocolType;
  defaultPort: number;
  maxChannels: number;
  supportedResolutions: Array<'1080p_30fps' | '720p_30fps' | '720p_15fps'>;
  defaultBitrateKbps: number;
  supportedFeatures: {
    adas: boolean;
    dms: boolean;
    bsd: boolean;
    canJ1939: boolean;
    rs232: boolean;
    intercomAudio: boolean;
    dualSdSsd: boolean;
    gSensor: boolean;
  };
  notes: string;
  isCustom?: boolean;
}

export interface DeviceDashcamConfig {
  driverId: string;
  driverCode: string;
  tcpPort: number;
  activeChannels: string[];
  resolution: '1080p_30fps' | '720p_30fps' | '720p_15fps';
  bitrateKbps: number;
  gpsIntervalSec: number;
  preEventSec: number;
  postEventSec: number;
  gSensorThresholdG: number;
  features: {
    adasEnabled: boolean;
    dmsEnabled: boolean;
    bsdEnabled: boolean;
    intercomEnabled: boolean;
    loopRecordingSd: boolean;
    canBusEnabled: boolean;
    rs232Peripheral: 'ninguno' | 'rfid_operador' | 'sensor_combustible' | 'dualcam_uart';
  };
  syncStatus: 'sincronizado' | 'pendiente_push';
  updatedBy: string;
  updatedAt: string;
}

export interface Vehicle {
  id: string;
  tenantId: string;
  branch: string;
  group: string;
  assetType: AssetType;
  unitCode: string;
  plate: string;
  /** Display text, "<brand> <model>" for units created with the catalog form. */
  brandModel: string;
  brand?: string;
  model?: string;
  year: number;
  driverId: string;
  driverName: string;
  deviceId: string;
  operationalStatus: OperationalStatus;
  ignition: boolean;
  speedKmh: number;
  heading: number;
  lat: number;
  lng: number;
  odometerKm: number;
  engineHours: number;
  nextServiceHours: number;
  nextServiceKm: number;
  nextServiceDate: string;
  serviceDatePinned?: boolean;
  assignedPlanId?: string;
  maintenanceStatus: MaintenanceStatus;
  fuelLevelPct: number;
  rpm: number;
  coolantTempC: number;
  faultCodes: FaultCode[];
  lastReportAt: string;
  /** OBD-II telemetry device (Device.role = 'telemetria') installed in the unit. */
  obdDeviceId?: string;
  /** Vehicle identification number, read by the OBD device or typed in. */
  vin?: string;
  /** Battery / supply voltage reported by the OBD device. */
  batteryVoltage?: number;
  /** Whether engine data (RPM, temperature, fuel, faults) is real (OBD-II) or demo data. */
  telemetrySourceEngine?: 'simulada' | 'obd';
  /** What moved the unit last: its own tracker (camera / OBD) or the driver's smartphone. */
  positionSource?: 'equipo' | 'smartphone';
  /** E.g. "Celular de Pérez, Juan" when the position comes from the driver's phone. */
  positionSourceLabel?: string;
  geofenceName: string;
}

export interface Device {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  imei: string;
  iccid: string;
  simCarrier: string;
  model: string;
  /** DEVICE_CATALOG id when the equipment was chosen from the catalog. */
  catalogModelId?: string;
  protocol: ProtocolType;
  firmware: string;
  channels: string[];
  linkStatus: LinkStatus;
  hardwareValidated: boolean;
  lastHeartbeatAt: string;
  dashcamConfig: DeviceDashcamConfig;
  /** JT/T 808 terminal ID; Traccar identifies the device by it (uniqueId). Globally unique. */
  terminalId: string;
  /** How the camera reaches the internet. */
  uplink: DeviceUplink;
  /** WiFi network (SSID) of the vehicle's Starlink. The password is never stored. */
  wifiSsid?: string;
  /** Where the latest position came from. */
  telemetrySource: TelemetrySource;
  /** Traccar position id of the last applied position (orders positions with equal timestamps). */
  lastTraccarPositionId?: number;
  /** camara (default) = dashcam/MDVR; telemetria = OBD-II tracker such as Teltonika FMC003. */
  role?: DeviceRole;
  /** VIN read through OBD-II (telemetry devices). */
  vin?: string;
  /** Last time OBD engine data arrived. */
  lastObdAt?: string;
  /** Id of the device in Traccar (created by the panel through the Traccar API). */
  traccarId?: number;
  /** APN of the tracker's SIM (used to build the setup SMS). */
  apn?: string;
  /** Onboarding state of an OBD-II tracker. */
  provisioning?: ObdProvisioning;
  /** Latest remote commands sent to the tracker (newest first, max 20). */
  commandLog?: ObdCommandEntry[];
}

export type DeviceRole = 'camara' | 'telemetria';

/**
 * manual = Traccar API not configured (create the device by hand in Traccar);
 * error = the Traccar API call failed; pendiente_sms = created in Traccar, the SMS still has to be sent;
 * conectado = the tracker already reported.
 */
export type ObdProvisioningStatus = 'manual' | 'error' | 'pendiente_sms' | 'conectado';

export interface ObdProvisioning {
  status: ObdProvisioningStatus;
  message?: string;
  at: string;
  /** First report received from the tracker. */
  firstReportAt?: string;
}

export type ObdCommandStatus = 'enviado' | 'en_cola' | 'error' | 'respondido';

export interface ObdCommandEntry {
  id: string;
  at: string;
  actorName: string;
  commandId: string;
  label: string;
  /** Exact text sent to the tracker. */
  text: string;
  status: ObdCommandStatus;
  /** Tracker reply (Traccar commandResult event) or error message. */
  response?: string;
  respondedAt?: string;
}

/** One aggregated point of the engine history (averages per bucket). */
export interface ObdHistoryPoint {
  at: string;
  rpm: number | null;
  coolantC: number | null;
  fuelPct: number | null;
  batteryV: number | null;
  speedKmh: number | null;
  /** Bucket extremes, useful on long ranges. */
  coolantMaxC: number | null;
  batteryMinV: number | null;
}

export type ObdHistoryRange = '24h' | '7d' | '30d';

export interface ObdFaultEvent {
  id: string;
  vehicleId: string;
  code: string;
  description: string;
  severity: FaultCode['severity'];
  system: string;
  openedAt: string;
  clearedAt: string | null;
  workOrderId: string | null;
}

export type DeviceUplink = 'wifi_starlink' | 'ethernet_starlink' | 'celular';

export type TelemetrySource = 'simulada' | 'traccar';

/** Platform endpoints that every camera must be programmed with (from server env). */
export interface DeviceConnectionSettings {
  host: string | null;
  jt808Port: number;
  jt1078Port: number;
  /** Traccar port for the Teltonika protocol (OBD-II trackers such as the FMC003). */
  teltonikaPort: number;
  /** Traccar port for the OsmAnd protocol (Traccar Client app on smartphones). */
  osmandPort: number;
  /** Server URL typed into Traccar Client: http://host:osmandPort, or the one set by the superadmin (tunnel, HTTPS proxy). */
  phoneServerUrl: string;
  /** True when phoneServerUrl was set by hand instead of derived from DEVICE_SERVER_HOST. */
  phoneServerUrlCustom: boolean;
  /**
   * Host and port programmed into OBD-II trackers (raw TCP, Teltonika protocol): DEVICE_SERVER_HOST and
   * teltonikaPort, or the ones set by the superadmin (e.g. a TCP tunnel). teltonikaPort stays the local Traccar port.
   */
  obdHost: string | null;
  obdPort: number;
  obdServerCustom: boolean;
  /**
   * Addresses programmed into the cameras (raw TCP): JT/T 808 (positions) and JT/T 1078 (video). Default:
   * DEVICE_SERVER_HOST with jt808Port / jt1078Port; the superadmin can set others (e.g. two TCP tunnels).
   * jt808Port / jt1078Port stay the local Traccar ports.
   */
  cameraHost: string | null;
  cameraJt808Port: number;
  cameraVideoHost: string | null;
  cameraJt1078Port: number;
  cameraServerCustom: boolean;
  /** True when the Traccar ingest endpoint is enabled (INGEST_TOKEN set). */
  ingestEnabled: boolean;
}

/** Device seen by Traccar whose uniqueId matches no registered device (superadmin only). */
export interface UnmatchedDevice {
  uniqueId: string;
  name?: string;
  lastSeenAt: string;
  lat?: number;
  lng?: number;
}

export interface AlertRule {
  id: string;
  tenantId: string;
  name: string;
  /** licencia_vencimiento: names and prioritizes the alert raised when an assigned driver's license expires. */
  conditionType: 'velocidad' | 'geocerca' | 'fatiga_dms' | 'colision_g' | 'desconexion_cam' | 'panico' | 'licencia_vencimiento';
  thresholdLabel: string;
  priority: AlertPriority;
  autoCreateClip: boolean;
  active: boolean;
  notifyQueue: string;
}

export interface AlertEvent {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  plate: string;
  driverName: string;
  ruleId: string;
  ruleName: string;
  priority: AlertPriority;
  status: AlertStatus;
  lat: number;
  lng: number;
  speedKmh: number;
  timestamp: string;
  clipId: string | null;
  summary: string;
}

export interface Incident {
  id: string;
  tenantId: string;
  alertId: string | null;
  vehicleId: string;
  unitCode: string;
  plate: string;
  title: string;
  category: string;
  priority: AlertPriority;
  status: IncidentStatus;
  assignee: string;
  createdAt: string;
  updatedAt: string;
  resolutionNote: string;
  clipId: string | null;
}

export interface VideoClip {
  id: string;
  tenantId: string;
  vehicleId: string;
  unitCode: string;
  plate: string;
  driverName: string;
  triggerType: 'evento_g' | 'dms_fatiga' | 'adas_colision' | 'exceso_velocidad' | 'bajo_demanda';
  channel: 'dual' | 'ch1_frontal' | 'ch2_cabina';
  durationSec: number;
  sizeMb: number;
  roadImageUrl: string;
  cabinImageUrl: string;
  s3Path: string;
  recordedAt: string;
  retentionLocked: boolean;
  retentionDays: number;
  speedAtEventKmh: number;
  gForcePeak: number;
}

export interface RoleDefinition {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  isSystemAdminRole?: boolean;
  permissions: ModulePermissions;
}

export interface AuditLog {
  id: string;
  tenantId: string;
  actorName: string;
  actorRole: string;
  actorHidden?: boolean;
  module: string;
  action: string;
  targetLabel: string;
  detail: string;
  timestamp: string;
}

export interface RoadmapStage {
  stage: number;
  title: string;
  focus: string;
  deliverables: string[];
  status: StageStatus;
}

export interface SizingConfig {
  vehiclesCount: number;
  gpsIntervalSec: number;
  videoMode: VideoMode;
  retentionDays: number;
  hostingModel: HostingModel;
  concurrentUsers: number;
  stages: RoadmapStage[];
}

export interface FleetStoreState {
  schemaVersion: number;
  tenants: Tenant[];
  users: UserAccount[];
  drivers: Driver[];
  vehicles: Vehicle[];
  devices: Device[];
  maintenanceRecords: MaintenanceRecord[];
  workOrders: WorkOrder[];
  preventivePlans: PreventivePlan[];
  partsInventory: PartInventoryItem[];
  checklists: PreOpChecklist[];
  dashcamDrivers: DashcamDriverProfile[];
  alertRules: AlertRule[];
  alerts: AlertEvent[];
  incidents: Incident[];
  videoClips: VideoClip[];
  roles: RoleDefinition[];
  auditLogs: AuditLog[];
  currencies: CurrencyDef[];
  exchangeRates: ExchangeRate[];
  currencyChanges: CurrencyChange[];
  sizing: SizingConfig;
}

export interface AuthSessionResponse {
  token: string;
  tenant: Tenant;
  user: PublicUser;
  role: RoleDefinition;
}

export interface MonthlyCostBucket {
  monthKey: string;
  monthLabel: string;
  refacciones: number;
  insumos: number;
  manoObra: number;
  total: number;
  ordersCount: number;
}

export interface PostGisCorridorMetric {
  geofenceName: string;
  branch: string;
  unitsCount: number;
  insideCorridorCount: number;
  outsideCorridorCount: number;
  avgDistanceToHubKm: number;
  avgEngineHours: number;
  totalOdometerKm: number;
  overdueCount: number;
  faultUnitsCount: number;
}

export interface MaintenanceDashboardMetrics {
  generatedAt: string;
  engine: string;
  upcomingOrdersCount: number;
  overdueUnitsCount: number;
  criticalFaultUnitsCount: number;
  lowStockPartsCount?: number;
  autoGeneratedOrdersCount?: number;
  currentMonthTotal: number;
  /** Currency of every amount in these metrics (the reference one in the consolidated view). */
  currency?: CurrencyCode | null;
  /** Consolidated view: amounts converted from each company's currency with the rate of each order's date. */
  consolidated?: boolean;
  /** Consolidated view: orders left out because their company has no currency or a rate is missing. */
  excludedOrders?: number;
  totalFleetOdometerKm: number;
  totalFleetEngineHours: number;
  unitsInsideCorridor: number;
  unitsOutsideCorridor: number;
  avgDistanceToHubKm: number;
  monthlyCosts: MonthlyCostBucket[];
  corridorMetrics: PostGisCorridorMetric[];
}

export interface TenantBootstrapResponse {
  tenant: Tenant;
  availableTenants?: Tenant[];
  activeScopeTenantId?: string;
  currentUser: PublicUser;
  currentRole: RoleDefinition;
  users: PublicUser[];
  roles: RoleDefinition[];
  drivers: Driver[];
  vehicles: Vehicle[];
  devices: Device[];
  maintenanceRecords: MaintenanceRecord[];
  workOrders: WorkOrder[];
  preventivePlans: PreventivePlan[];
  partsInventory: PartInventoryItem[];
  checklists: PreOpChecklist[];
  dashcamDrivers: DashcamDriverProfile[];
  maintenanceDashboard?: MaintenanceDashboardMetrics;
  alertRules: AlertRule[];
  alerts: AlertEvent[];
  incidents: Incident[];
  videoClips: VideoClip[];
  auditLogs: AuditLog[];
  sizing: SizingConfig;
  deviceConnection: DeviceConnectionSettings;
  currencies: CurrencyDef[];
  /** Rates needed to show equivalents (the latest per currency plus about a year of history). */
  exchangeRates: ExchangeRate[];
  /** Only for the global superadmin: currency of the consolidated view. */
  platformReferenceCurrency?: CurrencyCode;
  /** Only for the global superadmin. */
  unmatchedDevices?: UnmatchedDevice[];
}

// ── Vigiant (PWA tracker that reports over the OsmAnd protocol) ──────────────

export type VigiantAccuracyLevel = 'highest' | 'high' | 'medium' | 'low';

export interface VigiantConfig {
  deviceId: string;
  /** OsmAnd endpoint, e.g. https://host/api/osmand */
  serverUrl: string;
  accuracy: VigiantAccuracyLevel;
  intervalSec: number;
  distanceMeters: number;
  angleDegrees: number;
  stationaryHeartbeatSec: number;
  fastestIntervalSec: number;
  offlineBuffer: boolean;
  wakeLock: boolean;
  stopDetection: boolean;
  serviceEnabled: boolean;
}

export interface VigiantLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'ok' | 'warn' | 'error' | 'sos';
  message: string;
  httpStatus?: number;
  detail?: string;
}

/** One OsmAnd fix (speed in knots, timestamp in ms). */
export interface VigiantTelemetryPayload {
  id: string;
  lat: number;
  lon: number;
  timestamp: number;
  speed: number;
  bearing: number;
  altitude: number;
  accuracy: number;
  batt: number;
  charge: boolean;
  valid: boolean;
  alarm?: string;
}

// ── Driver license validity (DriverLicenseModal / LICENSE_STATUS_META) ───────

export type LicenseValidityStatus = 'vigente' | 'por_vencer_30' | 'por_vencer_15' | 'por_vencer_5' | 'vencida';
