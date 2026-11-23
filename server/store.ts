import crypto from 'crypto';
import { hashPassword, hashPasswordSync, hashToken, validatePasswordPolicy, verifyPassword } from './auth/password.ts';
import { runMigrations } from './db/migrate.ts';
import { StateRepository } from './db/stateRepository.ts';
import { MAP_REGION } from '../src/shared/region.ts';
import { buildDefaultAlertRules, buildDefaultPreventivePlans } from './tenants/templates.ts';
import { CUIT_MESSAGES, cuitProblem, formatCuit, taxIdKey } from '../src/shared/cuit.ts';
import { fileSlug } from './export/csv.ts';
import type { ObdReading } from './ingest/obd.ts';
import { describeDtc } from '../src/shared/dtc.ts';
import { catalogModelLabel, findCatalogModel, GENERIC_JT808_DRIVER_ID } from '../src/shared/deviceCatalog.ts';
import { composeBrandModel } from '../src/shared/vehicleCatalog.ts';
import { DriverRegistry } from './drivers/registry.ts';
import { CurrencyService } from './currency/service.ts';
import { BASE_CURRENCIES, formatMoney } from '../src/shared/currency.ts';
import { CHECKLIST_DECISION_LABELS } from '../src/shared/checklist.ts';
import {
  newPhoneIdentifier,
  PHONE_DEVICE_PRIORITY_MS,
  PHONE_LOW_BATTERY_PCT,
  PHONE_MAX_ACCURACY_M,
  PHONE_OFFLINE_MINUTES,
} from '../src/shared/phone.ts';
import { computeDriverAuthorization, AUTH_STATE_LABELS } from '../src/shared/drivers.ts';
import type {
  AlertEvent,
  AlertRule,
  AssetType,
  AuditLog,
  ChecklistItem,
  ChecklistReviewDecision,
  DashcamDriverProfile,
  Device,
  DeviceConnectionSettings,
  DeviceDashcamConfig,
  DeviceUplink,
  Driver,
  FaultCode,
  DriverPhoneTracker,
  PhoneListItem,
  PhonePlatform,
  PhoneProvisioningStatus,
  ObdCommandEntry,
  ObdFaultEvent,
  ObdHistoryPoint,
  ObdHistoryRange,
  ObdProvisioningStatus,
  FleetStoreState,
  Incident,
  MaintenanceDashboardMetrics,
  MaintenanceRecord,
  MaintenanceStatus,
  ModulePermissions,
  MonthlyCostBucket,
  OperationalStatus,
  PartInventoryItem,
  PostGisCorridorMetric,
  PreOpChecklist,
  PreOpChecklistResult,
  PreventivePlan,
  ProtocolType,
  UnitConnection,
  PublicUser,
  RoleDefinition,
  Tenant,
  TenantBootstrapResponse,
  TenantStatus,
  TenantSummary,
  UnmatchedDevice,
  UserAccount,
  Vehicle,
  VideoClip,
  WorkOrder,
  WorkOrderPart,
  WorkOrderPriority,
  WorkOrderStatus,
} from '../src/shared/types.ts';

const SCHEMA_VERSION = 8;

const PRIORITY_RANK: Record<WorkOrderPriority, number> = {
  critica: 0,
  alta: 1,
  media: 2,
  baja: 3,
};

function evaluateVehicleMaintenanceStatus(v: Vehicle, todayStr: string): MaintenanceStatus {
  const remainingHours = v.nextServiceHours - v.engineHours;
  const remainingKm = v.nextServiceKm - v.odometerKm;
  if (remainingHours <= 0 || remainingKm <= 0 || v.nextServiceDate < todayStr) {
    return 'vencido';
  }
  if (remainingHours <= 24 || remainingKm <= 500) {
    return 'proximo';
  }
  return 'al_dia';
}

function sortWorkOrdersList(orders: WorkOrder[], vehicles: Vehicle[]): WorkOrder[] {
  const vehMap = new Map(vehicles.map((v) => [v.id, v]));
  const isClosed = (s: WorkOrderStatus) => s === 'completada' || s === 'cancelada';
  return [...orders].sort((a, b) => {
    const aClosed = isClosed(a.status) ? 1 : 0;
    const bClosed = isClosed(b.status) ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;

    const pDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pDiff !== 0) return pDiff;

    const vA = vehMap.get(a.vehicleId);
    const vB = vehMap.get(b.vehicleId);
    const mRank = (m?: MaintenanceStatus) => (m === 'vencido' ? 0 : m === 'proximo' ? 1 : 2);
    const mDiff = mRank(vA?.maintenanceStatus) - mRank(vB?.maintenanceStatus);
    if (mDiff !== 0) return mDiff;

    return a.scheduledDate.localeCompare(b.scheduledDate);
  });
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeServiceDateFromHours(
  engineHours: number,
  nextServiceHours: number,
  maintenanceStatus?: MaintenanceStatus
): string {
  const avgDailyHours = 8;
  let deltaDays = Math.round((nextServiceHours - engineHours) / avgDailyHours);
  if (maintenanceStatus === 'vencido' && deltaDays >= 0) {
    deltaDays = -3;
  } else if (maintenanceStatus === 'vencido' && deltaDays > -2) {
    deltaDays = -2;
  }
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + deltaDays));
  return target.toISOString().slice(0, 10);
}

export const SUPERADMIN_ROLE: RoleDefinition = {
  id: 'super_admin_internal',
  tenantId: 'global',
  name: 'Super Admin Global',
  description: 'Acceso maestro multiempresa y control total de todos los módulos del sistema.',
  isSystemAdminRole: true,
  permissions: {
    administracion: 'full',
    flotas: 'full',
    dispositivos: 'full',
    dashcams_config: 'full',
    monitoreo: 'full',
    alertas: 'full',
    incidentes: 'full',
    video: 'full',
    reportes: 'full',
    dimensionamiento: 'full',
  },
};

const ROAD_HIGHWAY_IMG = '/src/assets/images/dashcam_road_highway_1795020102566.jpg';
const ROAD_URBAN_IMG = '/src/assets/images/dashcam_road_urban_1795020103292.jpg';
const CABIN_DRIVER_IMG = '/src/assets/images/dashcam_cabin_driver_1795020104262.jpg';

// Hubs come from the shared region config (src/shared/region.ts). Index order matters:
// tenants use corridorIndices [0,1], [2,3] and [4,5].
const CORRIDORS = MAP_REGION.hubs;
const UNIT_SPREAD = MAP_REGION.unitSpreadDeg;

const FIRST_NAMES = ['Carlos', 'Miguel', 'Lucía', 'Javier', 'Sofía', 'Fernando', 'Andrés', 'Valeria', 'Ricardo', 'Elena', 'Raúl', 'Patricia'];
const LAST_NAMES = ['Mendoza', 'Herrera', 'Salazar', 'Castillo', 'Ríos', 'Vega', 'Navarro', 'Delgado', 'Cortés', 'Ortega', 'Aguilar', 'Paredes'];
const VEHICLE_BRANDS = ['Kenworth T680', 'Freightliner M2', 'Mercedes Sprinter 416', 'Isuzu ELF 500', 'Hino Serie 500', 'Ford Transit Van'];
const MACHINERY_BRANDS = ['Excavadora CAT 320 GC', 'Cargador Frontal Volvo L90H', 'Grúa Hidráulica Grove GMK', 'Retroexcavadora JCB 3CX'];
const DASHCAM_MODELS = [
  'Howen Hero-ME40-04',
  'Streamax X3-N',
  'Jimi JC400D Dual',
  'Teltonika FMC130 + CAN/J1939',
  'Hikvision DS-MP5604 MDVR',
];

const INITIAL_DASHCAM_DRIVERS: DashcamDriverProfile[] = [
  {
    id: 'drv-howen-me40',
    vendorFamily: 'howen_streamax',
    vendorName: 'Howen',
    modelSeries: 'Hero-ME40-04 (MDVR 4G)',
    driverCode: 'JT808_JT1078_HOWEN_V4',
    driverVersion: '4.2.18-JT1078',
    protocol: 'JT808/JT1078',
    defaultPort: 6808,
    maxChannels: 4,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 2048,
    supportedFeatures: {
      adas: true,
      dms: true,
      bsd: true,
      canJ1939: true,
      rs232: true,
      intercomAudio: true,
      dualSdSsd: true,
      gSensor: true,
    },
    notes: 'Driver multicanal JT808/JT1078 con soporte nativo para streaming H.264/H.265, ADAS frontal, DMS infrarrojo e intercomunicador bidireccional.',
  },
  {
    id: 'drv-streamax-x3',
    vendorFamily: 'howen_streamax',
    vendorName: 'Streamax',
    modelSeries: 'X3-N / C6D AI Dashcam',
    driverCode: 'JT808_JT1078_STREAMAX_X3',
    driverVersion: '5.1.04-SMX',
    protocol: 'JT808/JT1078',
    defaultPort: 6809,
    maxChannels: 4,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 2560,
    supportedFeatures: {
      adas: true,
      dms: true,
      bsd: true,
      canJ1939: true,
      rs232: true,
      intercomAudio: true,
      dualSdSsd: true,
      gSensor: true,
    },
    notes: 'Protocolo Streamax CEIBA / JT1078 extendido con detección de fatiga DMS, alerta de colisión frontal ADAS y lectura de bus CAN.',
  },
  {
    id: 'drv-jimi-jc400',
    vendorFamily: 'jimi_concox',
    vendorName: 'Jimi IoT / Concox',
    modelSeries: 'JC400D / JC450 Pro',
    driverCode: 'JIMI_JC400_JC450_LTE',
    driverVersion: '3.8.12-JC',
    protocol: 'JT808/JT1078',
    defaultPort: 21100,
    maxChannels: 4,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 1536,
    supportedFeatures: {
      adas: true,
      dms: true,
      bsd: false,
      canJ1939: false,
      rs232: true,
      intercomAudio: true,
      dualSdSsd: false,
      gSensor: true,
    },
    notes: 'Driver optimizado para dashcams LTE JC400 dual y JC450 4CH; soporta comandos SMS/TCP de snapshot, clips por G-Sensor e intercomunicador.',
  },
  {
    id: 'drv-teltonika-fmc',
    vendorFamily: 'teltonika_fmc',
    vendorName: 'Teltonika Telematics',
    modelSeries: 'FMC130 / FMC650 + DualCam',
    driverCode: 'TRACCAR_TELTONIKA_CODEC8E',
    driverVersion: '03.29.00.Rev.14',
    protocol: 'Traccar',
    defaultPort: 5027,
    maxChannels: 2,
    supportedResolutions: ['720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 1024,
    supportedFeatures: {
      adas: false,
      dms: false,
      bsd: false,
      canJ1939: true,
      rs232: true,
      intercomAudio: false,
      dualSdSsd: false,
      gSensor: true,
    },
    notes: 'Codec 8 Extended con lectura FMS/J1939 de horómetro, RPM, temperatura y códigos DTC más periféricos RS232 (RFID, sensor combustible, DualCam UART).',
  },
  {
    id: 'drv-hik-dahua-mdvr',
    vendorFamily: 'hikvision_dahua',
    vendorName: 'Hikvision Mobile / Dahua',
    modelSeries: 'DS-MP5604 / Dahua MXVR',
    driverCode: 'HIK_DAHUA_ISUP_JT1078',
    driverVersion: '6.0.22-MDVR',
    protocol: 'JT808/JT1078',
    defaultPort: 7660,
    maxChannels: 4,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 3072,
    supportedFeatures: {
      adas: true,
      dms: true,
      bsd: true,
      canJ1939: true,
      rs232: true,
      intercomAudio: true,
      dualSdSsd: true,
      gSensor: true,
    },
    notes: 'Integración MDVR vehicular robusta para maquinaria pesada y tractocamiones: 4 canales AHD 1080p, SSD antivibración y cámara BSD punto ciego.',
  },
  {
    id: 'drv-jimi-jc181',
    vendorFamily: 'jimi_concox',
    vendorName: 'Jimi IoT / Concox',
    modelSeries: 'JC181 / JC261 / JC261P',
    driverCode: 'JT808_2013_JT1078_JIMI',
    driverVersion: 'JT808-2013 / JT1078-2016',
    protocol: 'JT808/JT1078',
    defaultPort: 5015,
    maxChannels: 2,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 1536,
    supportedFeatures: {
      adas: false,
      dms: false,
      bsd: false,
      canJ1939: false,
      rs232: false,
      intercomAudio: true,
      dualSdSsd: false,
      gSensor: true,
    },
    notes: 'Probado con Traccar: servidor 1 JT/T 808 en 5015 y servidor 2 JT/T 1078 (video) en 5263. Frontal 1080p + cabina; la JC261 suma ADAS.',
  },
  {
    id: GENERIC_JT808_DRIVER_ID,
    vendorFamily: 'jt808_generico',
    vendorName: 'JT/T 808 genérico',
    modelSeries: 'Meitrack, MettaX y otros JT808/JT1078',
    driverCode: 'JT808_JT1078_GENERIC',
    driverVersion: 'JT808-2013/2019 / JT1078-2016',
    protocol: 'JT808/JT1078',
    defaultPort: 5015,
    maxChannels: 4,
    supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
    defaultBitrateKbps: 1536,
    supportedFeatures: {
      adas: false,
      dms: false,
      bsd: false,
      canJ1939: false,
      rs232: false,
      intercomAudio: false,
      dualSdSsd: false,
      gSensor: true,
    },
    notes: 'Perfil base para equipos que hablan JT/T 808 + JT/T 1078 estándar sin driver propio. Activar ADAS/DMS solo si el equipo los tiene.',
  },
];

function matchDriverForModel(
  model: string,
  protocol: ProtocolType,
  driverPool: DashcamDriverProfile[]
): DashcamDriverProfile {
  const lower = model.toLowerCase();
  const byId = (id: string) => driverPool.find((d) => d.id === id);
  if (lower.includes('jc181') || lower.includes('jc261')) {
    return byId('drv-jimi-jc181') ?? byId('drv-jimi-jc400') ?? driverPool[0];
  }
  if (lower.includes('streamax')) {
    return driverPool.find((d) => d.id === 'drv-streamax-x3') ?? driverPool[0];
  }
  if (lower.includes('jimi') || lower.includes('jc400') || lower.includes('jc450') || lower.includes('concox')) {
    return driverPool.find((d) => d.id === 'drv-jimi-jc400') ?? driverPool[0];
  }
  if (lower.includes('teltonika') || lower.includes('fmc') || protocol === 'Traccar') {
    return driverPool.find((d) => d.id === 'drv-teltonika-fmc') ?? driverPool[0];
  }
  if (lower.includes('hikvision') || lower.includes('dahua') || lower.includes('mdvr') || lower.includes('ds-mp')) {
    return driverPool.find((d) => d.id === 'drv-hik-dahua-mdvr') ?? driverPool[0];
  }
  if (lower.includes('howen') || lower.includes('hero-')) {
    return byId('drv-howen-me40') ?? driverPool[0];
  }
  // Unknown model: a standard JT808 profile is safer than assuming a Howen MDVR.
  return byId(GENERIC_JT808_DRIVER_ID) ?? byId('drv-howen-me40') ?? driverPool[0];
}

function buildDefaultDashcamConfig(
  model: string,
  protocol: ProtocolType,
  driverPool: DashcamDriverProfile[],
  updatedBy = 'Sistema',
  resolvedDriver?: DashcamDriverProfile
): DeviceDashcamConfig {
  const drv = resolvedDriver ?? matchDriverForModel(model, protocol, driverPool);
  const channels =
    drv.protocol === 'Traccar'
      ? ['CH1 Frontal (DualCam RS232)', 'Bus CAN J1939']
      : drv.id === 'drv-hik-dahua-mdvr'
        ? ['CH1 Frontal', 'CH2 Cabina', 'CH3 Lateral Izq.', 'CH4 Trasera']
        : ['CH1 Frontal', 'CH2 Cabina'];
  return {
    driverId: drv.id,
    driverCode: drv.driverCode,
    tcpPort: drv.defaultPort,
    activeChannels: channels,
    resolution: drv.supportedResolutions[0] ?? '1080p_30fps',
    bitrateKbps: drv.defaultBitrateKbps,
    gpsIntervalSec: 15,
    preEventSec: 10,
    postEventSec: 15,
    gSensorThresholdG: 0.65,
    features: {
      adasEnabled: drv.supportedFeatures.adas,
      dmsEnabled: drv.supportedFeatures.dms,
      bsdEnabled: drv.supportedFeatures.bsd && drv.id === 'drv-hik-dahua-mdvr',
      intercomEnabled: drv.supportedFeatures.intercomAudio,
      loopRecordingSd: true,
      canBusEnabled: drv.supportedFeatures.canJ1939,
      rs232Peripheral: drv.id === 'drv-teltonika-fmc' ? 'dualcam_uart' : 'ninguno',
    },
    syncStatus: 'sincronizado',
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
}

const FAULT_CATALOG: FaultCode[] = [
  {
    code: 'SPN 110 / FMI 0',
    system: 'Motor · Refrigeración J1939',
    description: 'Temperatura de refrigerante por encima del umbral normal (> 102 °C)',
    severity: 'critica',
  },
  {
    code: 'SPN 157 / FMI 18',
    system: 'Inyección Diésel J1939',
    description: 'Presión de riel de combustible moderadamente baja bajo carga',
    severity: 'advertencia',
  },
  {
    code: 'P0420',
    system: 'Emisiones OBD-II',
    description: 'Eficiencia del sistema catalítico por debajo del umbral óptimo',
    severity: 'advertencia',
  },
  {
    code: 'SPN 524 / FMI 2',
    system: 'Transmisión / Hidráulico',
    description: 'Variación en sensor de presión de línea hidráulica auxiliar',
    severity: 'critica',
  },
];

function seededOffset(idx: number, scale: number): number {
  const s = Math.sin(idx * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * scale;
}

function buildTenantBaseRoles(tenantId: string): RoleDefinition[] {
  return [
    {
      id: `rol-${tenantId}-admin`,
      tenantId,
      name: 'Admin de Empresa',
      description: 'Administrador principal de la empresa. Crea perfiles, gestiona usuarios, flota, mantenimiento, dashcams y video.',
      isSystemAdminRole: true,
      permissions: {
        administracion: 'full',
        flotas: 'full',
        dispositivos: 'full',
        dashcams_config: 'full',
        monitoreo: 'full',
        alertas: 'full',
        incidentes: 'full',
        video: 'full',
        reportes: 'full',
        dimensionamiento: 'full',
      },
    },
    {
      id: `rol-${tenantId}-operador`,
      tenantId,
      name: 'Operador de Monitoreo',
      description: 'Monitoreo en vivo en mapa Esri, atención de alertas, incidentes y solicitud de video JT1078.',
      permissions: {
        administracion: 'none',
        flotas: 'read',
        dispositivos: 'read',
        dashcams_config: 'none',
        monitoreo: 'full',
        alertas: 'write',
        incidentes: 'write',
        video: 'write',
        reportes: 'read',
        dimensionamiento: 'none',
      },
    },
    {
      id: `rol-${tenantId}-mantenimiento`,
      tenantId,
      name: 'Jefe de Mantenimiento',
      description: 'Control de horómetros, órdenes de trabajo, planes preventivos, refacciones, checklists y equipos JT808.',
      permissions: {
        administracion: 'none',
        flotas: 'full',
        dispositivos: 'write',
        dashcams_config: 'none',
        monitoreo: 'read',
        alertas: 'read',
        incidentes: 'write',
        video: 'read',
        reportes: 'full',
        dimensionamiento: 'read',
      },
    },
  ];
}

type SeedUser = Omit<UserAccount, 'passwordHash'> & { password: string };

export interface DemoCredential {
  username: string;
  password: string;
  tenantId: string;
}

function buildInitialState(demoCredentials: DemoCredential[] = []): FleetStoreState {
  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  const tenants: Tenant[] = [
    {
      id: 'ten-norte',
      name: 'TransLogística Norte S.A.',
      taxId: 'TLN-980412-K81',
      city: 'San Juan Capital, San Juan',
      branches: [CORRIDORS[0].branch, CORRIDORS[1].branch],
      vehicleQuota: 50,
      retentionDays: 30,
      planTier: 'Piloto Empresarial',
      status: 'piloto',
      currency: 'ARS',
      referenceCurrency: 'USD',
    },
    {
      id: 'ten-urbana',
      name: 'Mensajería Urbana Express',
      taxId: 'MUE-140922-M12',
      city: 'Rivadavia, San Juan',
      branches: [CORRIDORS[2].branch, CORRIDORS[3].branch],
      vehicleQuota: 40,
      retentionDays: 15,
      planTier: 'Piloto Última Milla',
      status: 'piloto',
      currency: 'ARS',
      referenceCurrency: 'USD',
    },
    {
      id: 'ten-frio',
      name: 'FríoCadena Refrigerados',
      taxId: 'FCR-190305-Q44',
      city: 'Pocito, San Juan',
      branches: [CORRIDORS[4].branch, CORRIDORS[5].branch],
      vehicleQuota: 25,
      retentionDays: 45,
      planTier: 'Piloto Cadena Fría',
      status: 'piloto',
      currency: 'ARS',
      referenceCurrency: 'USD',
    },
  ];

  const roles: RoleDefinition[] = tenants.flatMap((t) => buildTenantBaseRoles(t.id));

  const seedUsers: SeedUser[] = [
    // Hidden superadmin account: NEVER exposed in any user list or selector
    {
      id: 'usr-super-internal',
      tenantId: 'global',
      name: 'Super Admin Global',
      username: 'superadmin',
      password: 'SuperAdmin2026!',
      roleId: 'super_admin_internal',
      isCompanyAdmin: true,
      isHiddenSuperadmin: true,
      status: 'activo',
      createdAt: iso(10000),
    },
    // TransLogística Norte
    {
      id: 'usr-norte-admin',
      tenantId: 'ten-norte',
      name: 'Luis Mendoza',
      username: 'admin.norte',
      password: 'Norte2026!',
      roleId: 'rol-ten-norte-admin',
      isCompanyAdmin: true,
      status: 'activo',
      createdAt: iso(4000),
    },
    {
      id: 'usr-norte-op',
      tenantId: 'ten-norte',
      name: 'Sofía Ramírez',
      username: 'monitoreo.norte',
      password: 'Norte2026!',
      roleId: 'rol-ten-norte-operador',
      isCompanyAdmin: false,
      status: 'activo',
      createdAt: iso(3500),
    },
    {
      id: 'usr-norte-mant',
      tenantId: 'ten-norte',
      name: 'Roberto Garza',
      username: 'taller.norte',
      password: 'Norte2026!',
      roleId: 'rol-ten-norte-mantenimiento',
      isCompanyAdmin: false,
      status: 'activo',
      createdAt: iso(3000),
    },
    // Mensajería Urbana Express
    {
      id: 'usr-urbana-admin',
      tenantId: 'ten-urbana',
      name: 'Carlos Ortega',
      username: 'admin.urbana',
      password: 'Urbana2026!',
      roleId: 'rol-ten-urbana-admin',
      isCompanyAdmin: true,
      status: 'activo',
      createdAt: iso(4000),
    },
    {
      id: 'usr-urbana-op',
      tenantId: 'ten-urbana',
      name: 'Valeria Cruz',
      username: 'monitoreo.urbana',
      password: 'Urbana2026!',
      roleId: 'rol-ten-urbana-operador',
      isCompanyAdmin: false,
      status: 'activo',
      createdAt: iso(3200),
    },
    // FríoCadena Refrigerados
    {
      id: 'usr-frio-admin',
      tenantId: 'ten-frio',
      name: 'Elena Paredes',
      username: 'admin.frio',
      password: 'Frio2026!',
      roleId: 'rol-ten-frio-admin',
      isCompanyAdmin: true,
      status: 'activo',
      createdAt: iso(4000),
    },
    {
      id: 'usr-frio-mant',
      tenantId: 'ten-frio',
      name: 'Miguel Navarro',
      username: 'taller.frio',
      password: 'Frio2026!',
      roleId: 'rol-ten-frio-mantenimiento',
      isCompanyAdmin: false,
      status: 'activo',
      createdAt: iso(2900),
    },
  ];
  demoCredentials.push(...seedUsers.map((u) => ({ username: u.username, password: u.password, tenantId: u.tenantId })));
  const users: UserAccount[] = seedUsers.map(({ password, ...u }) => ({
    ...u,
    passwordHash: hashPasswordSync(password),
    failedAttempts: 0,
    lockedUntil: null,
  }));

  const tenantCounts = [
    { tenantId: 'ten-norte', count: 42, prefix: 'TLN', corridorIndices: [0, 1], groupPrefix: 'Tractocamión / Obra' },
    { tenantId: 'ten-urbana', count: 34, prefix: 'MUE', corridorIndices: [2, 3], groupPrefix: 'Reparto / Maquinaria' },
    { tenantId: 'ten-frio', count: 20, prefix: 'FCR', corridorIndices: [4, 5], groupPrefix: 'Cadena Fría / Patio' },
  ];

  const dashcamDrivers: DashcamDriverProfile[] = INITIAL_DASHCAM_DRIVERS.map((d) => ({ ...d }));

  const drivers: Driver[] = [];
  const vehicles: Vehicle[] = [];
  const devices: Device[] = [];
  const maintenanceRecords: MaintenanceRecord[] = [];
  const preventivePlans: PreventivePlan[] = [];
  const partsInventory: PartInventoryItem[] = [];
  const workOrders: WorkOrder[] = [];
  const checklists: PreOpChecklist[] = [];

  let globalIndex = 1;

  for (const tc of tenantCounts) {
    preventivePlans.push(...buildDefaultPreventivePlans(tc.tenantId, iso));

    partsInventory.push(
      {
        id: `inv-${tc.tenantId}-01`,
        tenantId: tc.tenantId,
        sku: 'LUB-15W40-19L',
        name: 'Aceite Diésel Sintético 15W-40 CK-4 (19L)',
        category: 'insumo',
        unit: 'cubeta',
        stockQty: 14,
        minStock: 5,
        unitCost: 2650,
        warehouseLocation: 'Almacén A · Rack 01',
        updatedAt: iso(240),
      },
      {
        id: `inv-${tc.tenantId}-02`,
        tenantId: tc.tenantId,
        sku: 'HID-ISO46-200',
        name: 'Cubeta Aceite Hidráulico ISO 46 (19L)',
        category: 'insumo',
        unit: 'cubeta',
        stockQty: 9,
        minStock: 4,
        unitCost: 2450,
        warehouseLocation: 'Almacén A · Rack 02',
        updatedAt: iso(360),
      },
      {
        id: `inv-${tc.tenantId}-03`,
        tenantId: tc.tenantId,
        sku: 'FRN-BAL-HD04',
        name: 'Juego de Balatas Delanteras Heavy Duty',
        category: 'refaccion',
        unit: 'juego',
        stockQty: 8,
        minStock: 4,
        unitCost: 2890,
        warehouseLocation: 'Almacén B · Pasillo 03',
        updatedAt: iso(480),
      },
      {
        id: `inv-${tc.tenantId}-04`,
        tenantId: tc.tenantId,
        sku: 'CAT-FLT-320H',
        name: 'Kit Filtros Hidráulico y Retorno CAT 320',
        category: 'refaccion',
        unit: 'kit',
        stockQty: 6,
        minStock: 3,
        unitCost: 4200,
        warehouseLocation: 'Almacén B · Pasillo 01',
        updatedAt: iso(510),
      },
      {
        id: `inv-${tc.tenantId}-05`,
        tenantId: tc.tenantId,
        sku: 'CAT-BOM-320',
        name: 'Kit Bombas / Mangueras Alta Presión',
        category: 'refaccion',
        unit: 'kit',
        stockQty: 2,
        minStock: 3,
        unitCost: 5600,
        warehouseLocation: 'Almacén B · Pasillo 02',
        updatedAt: iso(720),
      },
      {
        id: `inv-${tc.tenantId}-06`,
        tenantId: tc.tenantId,
        sku: 'TRN-KIT-HD',
        name: 'Juego Balatas, Filtros y Tensores',
        category: 'refaccion',
        unit: 'kit',
        stockQty: 11,
        minStock: 4,
        unitCost: 2950,
        warehouseLocation: 'Almacén B · Pasillo 04',
        updatedAt: iso(840),
      },
      {
        id: `inv-${tc.tenantId}-07`,
        tenantId: tc.tenantId,
        sku: 'SEN-NOX-400',
        name: 'Sensor NOx Escape J1939 Post-Tratamiento',
        category: 'refaccion',
        unit: 'pza',
        stockQty: 1,
        minStock: 3,
        unitCost: 4850,
        warehouseLocation: 'Almacén Electrónica · Gaveta 02',
        updatedAt: iso(960),
      },
      {
        id: `inv-${tc.tenantId}-08`,
        tenantId: tc.tenantId,
        sku: 'ADBLUE-20L',
        name: 'Urea Automotriz AdBlue ISO 22241 (20L)',
        category: 'insumo',
        unit: 'garrafa',
        stockQty: 22,
        minStock: 8,
        unitCost: 680,
        warehouseLocation: 'Almacén A · Zona Fluidos',
        updatedAt: iso(180),
      }
    );

    for (let i = 1; i <= tc.count; i++) {
      const idx = globalIndex++;
      const corridor = CORRIDORS[tc.corridorIndices[i % tc.corridorIndices.length]];
      const driverName = `${FIRST_NAMES[idx % FIRST_NAMES.length]} ${LAST_NAMES[(idx * 3) % LAST_NAMES.length]}`;
      const driverId = `drv-${String(idx).padStart(3, '0')}`;
      const vehicleId = `veh-${String(idx).padStart(3, '0')}`;
      const deviceId = `dev-${String(idx).padStart(3, '0')}`;

      const isHeavyMachinery = i % 4 === 0;
      const assetType: AssetType = isHeavyMachinery ? 'maquinaria_pesada' : 'vehiculo';
      const unitCode = isHeavyMachinery
        ? `${tc.prefix}-MQ-${String(i).padStart(2, '0')}`
        : `${tc.prefix}-${String(100 + i)}`;
      const plate = isHeavyMachinery
        ? `MQ-${100 + idx}`
        : `${tc.prefix.slice(0, 2)}-${10 + (idx % 89)}-${100 + ((idx * 7) % 899)}`;

      let opStatus: OperationalStatus = 'en_ruta';
      if (idx === 3 || idx === 19 || idx === 47 || idx === 81) opStatus = 'alerta';
      else if (idx % 7 === 0) opStatus = 'detenido';
      else if (idx % 16 === 0) opStatus = 'sin_senal';

      const ignition = opStatus === 'en_ruta' || opStatus === 'alerta';
      const speedKmh = isHeavyMachinery
        ? ignition
          ? 12
          : 0
        : opStatus === 'en_ruta'
          ? Math.round(48 + Math.abs(seededOffset(idx, 42)))
          : opStatus === 'alerta'
            ? 104
            : 0;

      const devModel = DASHCAM_MODELS[idx % DASHCAM_MODELS.length];
      const protocol: ProtocolType = devModel.includes('Teltonika') ? 'Traccar' : 'JT808/JT1078';
      const dashcamConfig = buildDefaultDashcamConfig(devModel, protocol, dashcamDrivers, 'Inicialización de Flota');

      const engineHours = Number((1240 + idx * 38.5).toFixed(1));
      const odometerKm = isHeavyMachinery ? 4800 + idx * 95 : 42100 + idx * 815;

      let maintenanceStatus: MaintenanceStatus = 'al_dia';
      let nextServiceHours = Math.ceil(engineHours / 250) * 250;
      if (nextServiceHours - engineHours < 18) nextServiceHours += 250;

      if (idx % 8 === 0) {
        maintenanceStatus = 'vencido';
        nextServiceHours = Number((engineHours - 14.5).toFixed(1));
      } else if (idx % 5 === 0) {
        maintenanceStatus = 'proximo';
        nextServiceHours = Number((engineHours + 19.0).toFixed(1));
      }

      const nextServiceKm =
        maintenanceStatus === 'vencido'
          ? odometerKm - 420
          : maintenanceStatus === 'proximo'
            ? odometerKm + 650
            : odometerKm + 4800;

      const nextServiceDate = computeServiceDateFromHours(engineHours, nextServiceHours, maintenanceStatus);

      const faultCodes: FaultCode[] =
        idx % 6 === 0
          ? [FAULT_CATALOG[idx % FAULT_CATALOG.length]]
          : opStatus === 'alerta'
            ? [FAULT_CATALOG[0]]
            : [];

      drivers.push({
        id: driverId,
        tenantId: tc.tenantId,
        branch: corridor.branch,
        name: driverName,
        licenseNumber: isHeavyMachinery ? `OP-MAQ-${4400 + idx}` : `LIC-${2020 + (idx % 5)}-${String(4400 + idx)}`,
        phone: `+52 55 ${String(3100 + idx).padStart(4, '0')} ${String(1200 + (idx * 13) % 8000).padStart(4, '0')}`,
        status: opStatus === 'sin_senal' ? 'descanso' : 'activo',
      });

      vehicles.push({
        id: vehicleId,
        tenantId: tc.tenantId,
        branch: corridor.branch,
        group: isHeavyMachinery ? 'Maquinaria Pesada · Obra' : `${tc.groupPrefix} · Sector ${((i - 1) % 3) + 1}`,
        assetType,
        unitCode,
        plate,
        brandModel: isHeavyMachinery
          ? MACHINERY_BRANDS[idx % MACHINERY_BRANDS.length]
          : VEHICLE_BRANDS[idx % VEHICLE_BRANDS.length],
        year: 2022 + (idx % 4),
        driverId,
        driverName,
        deviceId,
        operationalStatus: opStatus,
        ignition,
        speedKmh,
        heading: Math.round(Math.abs(seededOffset(idx + 5, 360))),
        lat: Number((corridor.lat + seededOffset(idx, UNIT_SPREAD)).toFixed(5)),
        lng: Number((corridor.lng + seededOffset(idx + 31, UNIT_SPREAD)).toFixed(5)),
        odometerKm,
        engineHours,
        nextServiceHours,
        nextServiceKm,
        nextServiceDate,
        serviceDatePinned: false,
        assignedPlanId: isHeavyMachinery ? `pln-${tc.tenantId}-maq-250` : `pln-${tc.tenantId}-veh-250`,
        maintenanceStatus,
        fuelLevelPct: 28 + ((idx * 17) % 68),
        rpm: ignition ? (isHeavyMachinery ? 1680 : 1420) : 0,
        coolantTempC: ignition ? (faultCodes.some((f) => f.code.includes('110')) ? 104 : 86) : 32,
        faultCodes,
        lastReportAt: iso(opStatus === 'sin_senal' ? 28 : idx % 4),
        geofenceName: corridor.geofence,
      });

      const seedImei = `86420105${String(1000000 + idx * 173).slice(0, 7)}`;
      devices.push({
        id: deviceId,
        tenantId: tc.tenantId,
        vehicleId,
        unitCode,
        terminalId: seedImei.slice(-12),
        uplink: 'wifi_starlink',
        wifiSsid: `Starlink-${unitCode}`,
        telemetrySource: 'simulada',
        imei: seedImei,
        iccid: `8952010099${String(10000000 + idx * 91).slice(0, 8)}`,
        simCarrier: idx % 2 === 0 ? 'Telcel M2M IoT' : 'AT&T Multi-Carrier',
        model: devModel,
        protocol,
        firmware: matchDriverForModel(devModel, protocol, dashcamDrivers).driverVersion,
        channels: dashcamConfig.activeChannels,
        linkStatus:
          opStatus === 'sin_senal'
            ? 'desconectado'
            : idx % 11 === 0
              ? 'intermitente'
              : 'conectado',
        hardwareValidated: idx % 13 !== 0,
        lastHeartbeatAt: iso(opStatus === 'sin_senal' ? 28 : idx % 3),
        dashcamConfig,
      });

      if (i <= 6) {
        maintenanceRecords.push({
          id: `mnt-${String(idx).padStart(3, '0')}`,
          tenantId: tc.tenantId,
          vehicleId,
          unitCode,
          type: isHeavyMachinery ? 'preventivo' : i % 2 === 0 ? 'preventivo' : 'inspeccion',
          title: isHeavyMachinery
            ? 'Servicio 250h · Cambio de aceite hidráulico y filtros'
            : 'Mantenimiento preventivo 15,000 km · Frenos y lubricación',
          performedAt: iso(60 * 24 * (i + 3)),
          engineHoursAtService: Number((engineHours - 180).toFixed(1)),
          odometerAtService: Math.max(0, odometerKm - 4500),
          nextServiceDate,
          workshopOrTech: 'Taller Central Certificado',
          cost: isHeavyMachinery ? 14800 : 6400,
          notes: 'Sin fugas hidráulicas ni desgaste prematuro en balatas.',
          status: 'completado',
        });
      }

      if (i <= 6) {
        const statuses: WorkOrderStatus[] = [
          'en_taller',
          'esperando_refacciones',
          'abierta',
          'en_taller',
          'completada',
          'abierta',
        ];
        const status = statuses[i - 1];
        const parts: WorkOrderPart[] = isHeavyMachinery
          ? [
              {
                id: `prt-${idx}-1`,
                sku: 'HID-ISO46-200',
                name: 'Cubeta Aceite Hidráulico ISO 46 (19L)',
                category: 'insumo',
                quantity: 2,
                unitCost: 2450,
                subtotal: 4900,
              },
              {
                id: `prt-${idx}-2`,
                sku: 'CAT-FLT-320H',
                name: 'Kit Filtros Hidráulico y Retorno CAT 320',
                category: 'refaccion',
                quantity: 1,
                unitCost: 4200,
                subtotal: 4200,
              },
            ]
          : [
              {
                id: `prt-${idx}-1`,
                sku: 'LUB-15W40-19L',
                name: 'Aceite Diésel Sintético 15W-40 CK-4 (19L)',
                category: 'insumo',
                quantity: 1,
                unitCost: 2650,
                subtotal: 2650,
              },
              {
                id: `prt-${idx}-2`,
                sku: 'FRN-BAL-HD04',
                name: 'Juego de Balatas Delanteras Heavy Duty',
                category: 'refaccion',
                quantity: 1,
                unitCost: 2890,
                subtotal: 2890,
              },
            ];
        const partsCost = parts.reduce((acc, p) => acc + p.subtotal, 0);
        const laborCost = isHeavyMachinery ? 3600 : 1950;
        const scheduledDate = computeServiceDateFromHours(engineHours, engineHours + (i - 2) * 8);
        workOrders.push({
          id: `OT-${tc.prefix}-${100 + i}`,
          tenantId: tc.tenantId,
          vehicleId,
          unitCode,
          plate,
          assetType,
          planId: isHeavyMachinery ? `pln-${tc.tenantId}-maq-250` : `pln-${tc.tenantId}-veh-250`,
          type: faultCodes.length > 0 ? 'correctivo' : 'preventivo',
          priority: faultCodes.length > 0 || status === 'esperando_refacciones' ? 'alta' : 'media',
          status,
          title:
            faultCodes.length > 0
              ? `Atención falla ${faultCodes[0].code} y servicio ${isHeavyMachinery ? '250 h' : '10,000 km'}`
              : isHeavyMachinery
                ? 'Mantenimiento preventivo 250 h · Sistema hidráulico'
                : 'Servicio preventivo · Cambio de aceite, filtros y frenos',
          workshopOrTech: i % 2 === 0 ? 'Taller Central Certificado' : 'Bahía Móvil de Obra #2',
          scheduledDate,
          completedAt: status === 'completada' ? iso(180) : undefined,
          engineHoursAtOrder: engineHours,
          odometerAtOrder: odometerKm,
          parts,
          laborCost,
          partsCost,
          totalCost: partsCost + laborCost,
          notes:
            status === 'esperando_refacciones'
              ? 'En espera de sello hidráulico y válvula de alivio de almacén regional.'
              : 'Inspección programada con validación de telemetría J1939 y dashcam.',
          clearFaultsOnClose: true,
          createdAt: iso(720 * i),
        });
      }

      // Historical 5-month completed orders for monthly parts/supplies/labor cost analytics
      if (i >= 7 && i <= 16) {
        const monthsBack = ((i - 7) % 5) + 1;
        const baseNow = new Date();
        const histDate = new Date(
          Date.UTC(baseNow.getUTCFullYear(), baseNow.getUTCMonth() - monthsBack, 8 + (i % 18), 14, 0, 0)
        );
        const histIso = histDate.toISOString();
        const histParts: WorkOrderPart[] = isHeavyMachinery
          ? [
              {
                id: `prt-h-${idx}-1`,
                sku: 'HID-ISO46-200',
                name: 'Aceite Hidráulico ISO 46 + Sellos',
                category: 'insumo',
                quantity: 1 + (monthsBack % 2),
                unitCost: 2350,
                subtotal: (1 + (monthsBack % 2)) * 2350,
              },
              {
                id: `prt-h-${idx}-2`,
                sku: 'CAT-BOM-320',
                name: 'Kit Bombas / Mangueras Alta Presión',
                category: 'refaccion',
                quantity: 1,
                unitCost: 5200 + monthsBack * 350,
                subtotal: 5200 + monthsBack * 350,
              },
            ]
          : [
              {
                id: `prt-h-${idx}-1`,
                sku: 'LUB-15W40-19L',
                name: 'Lubricante Sintético + Anticongelante',
                category: 'insumo',
                quantity: 1,
                unitCost: 2250 + (i % 3) * 200,
                subtotal: 2250 + (i % 3) * 200,
              },
              {
                id: `prt-h-${idx}-2`,
                sku: 'TRN-KIT-HD',
                name: 'Juego Balatas, Filtros y Tensores',
                category: 'refaccion',
                quantity: 1 + (i % 2),
                unitCost: 2650 + monthsBack * 180,
                subtotal: (1 + (i % 2)) * (2650 + monthsBack * 180),
              },
            ];
        const partsCost = histParts.reduce((s, p) => s + p.subtotal, 0);
        const laborCost = isHeavyMachinery ? 3400 + monthsBack * 150 : 1850 + monthsBack * 120;
        workOrders.push({
          id: `OT-${tc.prefix}-H${monthsBack}${String(i).padStart(2, '0')}`,
          tenantId: tc.tenantId,
          vehicleId,
          unitCode,
          plate,
          assetType,
          planId: isHeavyMachinery ? `pln-${tc.tenantId}-maq-250` : `pln-${tc.tenantId}-veh-250`,
          type: i % 3 === 0 ? 'correctivo' : 'preventivo',
          priority: i % 3 === 0 ? 'alta' : 'media',
          status: 'completada',
          title: isHeavyMachinery
            ? `Servicio histórico 250 h (${histIso.slice(0, 7)})`
            : `Mantenimiento preventivo (${histIso.slice(0, 7)})`,
          workshopOrTech: i % 2 === 0 ? 'Taller Central Certificado' : 'Bahía Móvil de Obra #2',
          scheduledDate: histIso.slice(0, 10),
          completedAt: histIso,
          engineHoursAtOrder: Math.max(120, Number((engineHours - monthsBack * 190).toFixed(1))),
          odometerAtOrder: Math.max(800, odometerKm - monthsBack * 3200),
          parts: histParts,
          laborCost,
          partsCost,
          totalCost: partsCost + laborCost,
          notes: 'Servicio cerrado en historial mensual de taller.',
          clearFaultsOnClose: true,
          createdAt: histIso,
        });
      }

      if (i <= 3) {
        const hasIssue = i === 2;
        const items: ChecklistItem[] = isHeavyMachinery
          ? [
              { id: 'chk-1', label: 'Líneas, mangueras y cilindros hidráulicos sin fugas', status: hasIssue ? 'falla' : 'ok', note: hasIssue ? 'Resudado menor en brazo auxiliar' : undefined },
              { id: 'chk-2', label: 'Estado de orugas / neumáticos de tracción y pernos', status: 'ok' },
              { id: 'chk-3', label: 'Freno de trabajo, alarma de reversa y paro de emergencia', status: 'ok' },
              { id: 'chk-4', label: 'Niveles de aceite hidráulico, motor diésel y refrigerante', status: 'ok' },
              { id: 'chk-5', label: 'Cámaras MDVR 360° / cabina y telemetría CAN J1939', status: 'ok' },
            ]
          : [
              { id: 'chk-1', label: 'Presión y desgaste de neumáticos / birlos', status: 'ok' },
              { id: 'chk-2', label: 'Sistema de frenos de servicio y estacionamiento', status: hasIssue ? 'falla' : 'ok', note: hasIssue ? 'Recorrido largo en pedal' : undefined },
              { id: 'chk-3', label: 'Luces frontales, direccionales y torreta', status: 'ok' },
              { id: 'chk-4', label: 'Niveles de aceite motor, refrigerante y dirección', status: 'ok' },
              { id: 'chk-5', label: 'Cámara dashcam CH1/CH2 y sensor DMS operativos', status: 'ok' },
            ];
        const result: PreOpChecklistResult = hasIssue ? 'con_observaciones' : 'aprobado';
        checklists.push({
          id: `CHK-${tc.prefix}-${200 + i}`,
          tenantId: tc.tenantId,
          vehicleId,
          unitCode,
          assetType,
          driverName,
          shift: i === 1 ? 'Matutino' : i === 2 ? 'Vespertino' : 'Nocturno',
          engineHours,
          odometerKm,
          result,
          items,
          summaryNote: hasIssue
            ? 'Se reportó observación preventiva al turno de taller sin detener operación inmediata.'
            : 'Inspección pre-operativa completa sin hallazgos.',
          submittedAt: iso(95 * i),
        });
      }
    }
  }

  const alertRules: AlertRule[] = [
    {
      id: 'rul-01',
      tenantId: 'ten-norte',
      name: 'Exceso de velocidad autopista (> 95 km/h)',
      conditionType: 'velocidad',
      thresholdLabel: '> 95 km/h durante 15 s',
      priority: 'alta',
      autoCreateClip: true,
      active: true,
      notifyQueue: 'rabbitmq.alerts.high',
    },
    {
      id: 'rul-02',
      tenantId: 'ten-norte',
      name: 'Frenado brusco / Impacto G-Sensor (> 0.65 G)',
      conditionType: 'colision_g',
      thresholdLabel: 'Acelerómetro >= 0.65 G',
      priority: 'critica',
      autoCreateClip: true,
      active: true,
      notifyQueue: 'rabbitmq.alerts.critical',
    },
    {
      id: 'rul-03',
      tenantId: 'ten-urbana',
      name: 'Detección de fatiga / distracción DMS',
      conditionType: 'fatiga_dms',
      thresholdLabel: 'Cierre ocular > 2.0 s',
      priority: 'critica',
      autoCreateClip: true,
      active: true,
      notifyQueue: 'rabbitmq.alerts.critical',
    },
    {
      id: 'rul-04',
      tenantId: 'ten-urbana',
      name: 'Salida de geocerca operativa',
      conditionType: 'geocerca',
      thresholdLabel: 'Desvío > 350 m fuera de polígono',
      priority: 'media',
      autoCreateClip: false,
      active: true,
      notifyQueue: 'rabbitmq.alerts.standard',
    },
    {
      id: 'rul-05',
      tenantId: 'ten-frio',
      name: 'Pérdida de enlace cámara JT1078',
      conditionType: 'desconexion_cam',
      thresholdLabel: 'Sin heartbeat > 15 min con ignición ON',
      priority: 'alta',
      autoCreateClip: false,
      active: true,
      notifyQueue: 'rabbitmq.alerts.high',
    },
    {
      id: 'rul-06',
      tenantId: 'ten-frio',
      name: 'Botón de pánico en cabina',
      conditionType: 'panico',
      thresholdLabel: 'Activación física SOS',
      priority: 'critica',
      autoCreateClip: true,
      active: true,
      notifyQueue: 'rabbitmq.alerts.critical',
    },
  ];

  const videoClips: VideoClip[] = [
    {
      id: 'clp-901',
      tenantId: 'ten-norte',
      vehicleId: vehicles[2].id,
      unitCode: vehicles[2].unitCode,
      plate: vehicles[2].plate,
      driverName: vehicles[2].driverName,
      triggerType: 'evento_g',
      channel: 'dual',
      durationSec: 30,
      sizeMb: 28.4,
      roadImageUrl: ROAD_HIGHWAY_IMG,
      cabinImageUrl: CABIN_DRIVER_IMG,
      s3Path: 's3://fleetops-evidencia/ten-norte/2026-11/clp-901-dual.mp4',
      recordedAt: iso(11),
      retentionLocked: true,
      retentionDays: 90,
      speedAtEventKmh: 104,
      gForcePeak: 0.78,
    },
    {
      id: 'clp-902',
      tenantId: 'ten-urbana',
      vehicleId: vehicles[46].id,
      unitCode: vehicles[46].unitCode,
      plate: vehicles[46].plate,
      driverName: vehicles[46].driverName,
      triggerType: 'dms_fatiga',
      channel: 'dual',
      durationSec: 20,
      sizeMb: 19.2,
      roadImageUrl: ROAD_URBAN_IMG,
      cabinImageUrl: CABIN_DRIVER_IMG,
      s3Path: 's3://fleetops-evidencia/ten-urbana/2026-11/clp-902-dms.mp4',
      recordedAt: iso(24),
      retentionLocked: false,
      retentionDays: 15,
      speedAtEventKmh: 58,
      gForcePeak: 0.24,
    },
    {
      id: 'clp-903',
      tenantId: 'ten-norte',
      vehicleId: vehicles[18].id,
      unitCode: vehicles[18].unitCode,
      plate: vehicles[18].plate,
      driverName: vehicles[18].driverName,
      triggerType: 'exceso_velocidad',
      channel: 'ch1_frontal',
      durationSec: 15,
      sizeMb: 14.6,
      roadImageUrl: ROAD_HIGHWAY_IMG,
      cabinImageUrl: CABIN_DRIVER_IMG,
      s3Path: 's3://fleetops-evidencia/ten-norte/2026-11/clp-903-vel.mp4',
      recordedAt: iso(47),
      retentionLocked: false,
      retentionDays: 30,
      speedAtEventKmh: 108,
      gForcePeak: 0.31,
    },
    {
      id: 'clp-904',
      tenantId: 'ten-frio',
      vehicleId: vehicles[80].id,
      unitCode: vehicles[80].unitCode,
      plate: vehicles[80].plate,
      driverName: vehicles[80].driverName,
      triggerType: 'bajo_demanda',
      channel: 'dual',
      durationSec: 45,
      sizeMb: 41.0,
      roadImageUrl: ROAD_HIGHWAY_IMG,
      cabinImageUrl: CABIN_DRIVER_IMG,
      s3Path: 's3://fleetops-evidencia/ten-frio/2026-11/clp-904-vod.mp4',
      recordedAt: iso(72),
      retentionLocked: true,
      retentionDays: 45,
      speedAtEventKmh: 84,
      gForcePeak: 0.18,
    },
  ];

  const alerts: AlertEvent[] = [
    {
      id: 'alt-501',
      tenantId: 'ten-norte',
      vehicleId: vehicles[2].id,
      unitCode: vehicles[2].unitCode,
      plate: vehicles[2].plate,
      driverName: vehicles[2].driverName,
      ruleId: 'rul-02',
      ruleName: 'Frenado brusco / Impacto G-Sensor (> 0.65 G)',
      priority: 'critica',
      status: 'escalada',
      lat: vehicles[2].lat,
      lng: vehicles[2].lng,
      speedKmh: 104,
      timestamp: iso(11),
      clipId: 'clp-901',
      summary: 'Pico de desaceleración de 0.78 G en autopista; clip dual JT1078 cargado en MinIO.',
    },
    {
      id: 'alt-502',
      tenantId: 'ten-urbana',
      vehicleId: vehicles[46].id,
      unitCode: vehicles[46].unitCode,
      plate: vehicles[46].plate,
      driverName: vehicles[46].driverName,
      ruleId: 'rul-03',
      ruleName: 'Detección de fatiga / distracción DMS',
      priority: 'critica',
      status: 'pendiente',
      lat: vehicles[46].lat,
      lng: vehicles[46].lng,
      speedKmh: 58,
      timestamp: iso(24),
      clipId: 'clp-902',
      summary: 'Sensor DMS reportó micro-sueño de 2.4 s en avenida urbana.',
    },
    {
      id: 'alt-503',
      tenantId: 'ten-norte',
      vehicleId: vehicles[18].id,
      unitCode: vehicles[18].unitCode,
      plate: vehicles[18].plate,
      driverName: vehicles[18].driverName,
      ruleId: 'rul-01',
      ruleName: 'Exceso de velocidad autopista (> 95 km/h)',
      priority: 'alta',
      status: 'pendiente',
      lat: vehicles[18].lat,
      lng: vehicles[18].lng,
      speedKmh: 108,
      timestamp: iso(47),
      clipId: 'clp-903',
      summary: 'Velocidad sostenida de 108 km/h durante 22 segundos.',
    },
    {
      id: 'alt-504',
      tenantId: 'ten-frio',
      vehicleId: vehicles[80].id,
      unitCode: vehicles[80].unitCode,
      plate: vehicles[80].plate,
      driverName: vehicles[80].driverName,
      ruleId: 'rul-06',
      ruleName: 'Botón de pánico en cabina',
      priority: 'critica',
      status: 'confirmada',
      lat: vehicles[80].lat,
      lng: vehicles[80].lng,
      speedKmh: 84,
      timestamp: iso(72),
      clipId: 'clp-904',
      summary: 'Activación manual verificada por llamada con operador; falsa alarma en retén.',
    },
    {
      id: 'alt-505',
      tenantId: 'ten-urbana',
      vehicleId: vehicles[51].id,
      unitCode: vehicles[51].unitCode,
      plate: vehicles[51].plate,
      driverName: vehicles[51].driverName,
      ruleId: 'rul-04',
      ruleName: 'Salida de geocerca operativa',
      priority: 'media',
      status: 'pendiente',
      lat: vehicles[51].lat,
      lng: vehicles[51].lng,
      speedKmh: 46,
      timestamp: iso(95),
      clipId: null,
      summary: 'Desvío de ruta de reparto 410 m al norte del polígono Acceso Norte Chimbas.',
    },
  ];

  const incidents: Incident[] = [
    {
      id: 'inc-301',
      tenantId: 'ten-norte',
      alertId: 'alt-501',
      vehicleId: vehicles[2].id,
      unitCode: vehicles[2].unitCode,
      plate: vehicles[2].plate,
      title: 'Frenado de emergencia con desaceleración 0.78 G',
      category: 'Seguridad Vial · ADAS',
      priority: 'critica',
      status: 'en_investigacion',
      assignee: 'Sofía Ramírez',
      createdAt: iso(10),
      updatedAt: iso(4),
      resolutionNote: 'Video dual asegurado en S3. Se contactó al operador para confirmar integridad de carga.',
      clipId: 'clp-901',
    },
    {
      id: 'inc-302',
      tenantId: 'ten-frio',
      alertId: 'alt-504',
      vehicleId: vehicles[80].id,
      unitCode: vehicles[80].unitCode,
      plate: vehicles[80].plate,
      title: 'Activación botón SOS en corredor Querétaro–León',
      category: 'Protocolo de Emergencia',
      priority: 'critica',
      status: 'resuelto',
      assignee: 'Elena Paredes',
      createdAt: iso(70),
      updatedAt: iso(54),
      resolutionNote: 'Verificación audiovisual JT1078 bajo demanda sin anomalías; operador confirmó activación accidental.',
      clipId: 'clp-904',
    },
    {
      id: 'inc-303',
      tenantId: 'ten-urbana',
      alertId: null,
      vehicleId: vehicles[47].id,
      unitCode: vehicles[47].unitCode,
      plate: vehicles[47].plate,
      title: 'Pérdida intermitente de canal CH2 en dashcam',
      category: 'Soporte Hardware JT1078',
      priority: 'media',
      status: 'abierto',
      assignee: 'Carlos Ortega',
      createdAt: iso(180),
      updatedAt: iso(140),
      resolutionNote: 'Programada revisión de arnés y actualización de firmware FW 4.2.18-JT1078 en patio Chimbas.',
      clipId: null,
    },
  ];

  const auditLogs: AuditLog[] = [
    {
      id: 'aud-01',
      tenantId: 'ten-norte',
      actorName: 'Sofía Ramírez',
      actorRole: 'Operador de Monitoreo',
      module: 'Alertas e Incidentes',
      action: 'Escalamiento a incidente',
      targetLabel: 'alt-501 · TLN-103',
      detail: 'Alerta crítica G-Sensor escalada a inc-301 con evidencia clp-901 bloqueada en MinIO.',
      timestamp: iso(10),
    },
    {
      id: 'aud-02',
      tenantId: 'ten-frio',
      actorName: 'Elena Paredes',
      actorRole: 'Admin de Empresa',
      module: 'Consola de Video',
      action: 'Solicitud JT1078 bajo demanda',
      targetLabel: 'FCR-105 · clp-904',
      detail: 'Transmisión dual CH1/CH2 solicitada y archivada con retención extendida de 45 días.',
      timestamp: iso(68),
    },
    {
      id: 'aud-03',
      tenantId: 'ten-urbana',
      actorName: 'Carlos Ortega',
      actorRole: 'Admin de Empresa',
      module: 'Dispositivos',
      action: 'Validación JT808/JT1078',
      targetLabel: 'IMEI 864201051008131',
      detail: 'Verificación de firmware FW 4.2.18-JT1078 y canales duales completada.',
      timestamp: iso(130),
    },
  ];

  // Auto-generate initial preventive work orders for seeded overdue/upcoming units without active OT
  const todaySeed = new Date().toISOString().slice(0, 10);
  for (const v of vehicles) {
    if (v.maintenanceStatus === 'al_dia') continue;
    const hasActivePrev = workOrders.some(
      (w) =>
        w.vehicleId === v.id &&
        w.type === 'preventivo' &&
        (w.status === 'abierta' || w.status === 'en_taller' || w.status === 'esperando_refacciones')
    );
    if (hasActivePrev) continue;
    const plan = preventivePlans.find((p) => p.id === v.assignedPlanId);
    const isMach = v.assetType === 'maquinaria_pesada';
    const defaultParts: WorkOrderPart[] = isMach
      ? [
          {
            id: `prt-auto-${v.id}-1`,
            sku: 'HID-ISO46-200',
            name: 'Cubeta Aceite Hidráulico ISO 46 (19L)',
            category: 'insumo',
            quantity: 1,
            unitCost: 2450,
            subtotal: 2450,
          },
          {
            id: `prt-auto-${v.id}-2`,
            sku: 'CAT-FLT-320H',
            name: 'Kit Filtros Hidráulico y Retorno CAT 320',
            category: 'refaccion',
            quantity: 1,
            unitCost: 4200,
            subtotal: 4200,
          },
        ]
      : [
          {
            id: `prt-auto-${v.id}-1`,
            sku: 'LUB-15W40-19L',
            name: 'Aceite Diésel Sintético 15W-40 CK-4 (19L)',
            category: 'insumo',
            quantity: 1,
            unitCost: 2650,
            subtotal: 2650,
          },
          {
            id: `prt-auto-${v.id}-2`,
            sku: 'FRN-BAL-HD04',
            name: 'Juego de Balatas Delanteras Heavy Duty',
            category: 'refaccion',
            quantity: 1,
            unitCost: 2890,
            subtotal: 2890,
          },
        ];
    const partsCost = defaultParts.reduce((s, p) => s + p.subtotal, 0);
    const laborCost = isMach ? 3600 : 1950;
    workOrders.push({
      id: `OT-${v.unitCode.split('-')[0]}-A${v.id.slice(-3)}`,
      tenantId: v.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      plate: v.plate,
      assetType: v.assetType,
      planId: plan?.id,
      type: 'preventivo',
      priority: v.maintenanceStatus === 'vencido' || v.faultCodes.some((f) => f.severity === 'critica') ? 'critica' : 'alta',
      status: 'abierta',
      title: `Disparo automático · ${plan?.name ?? 'Servicio preventivo'}`,
      workshopOrTech: 'Taller Central Certificado',
      scheduledDate: v.maintenanceStatus === 'vencido' ? todaySeed : v.nextServiceDate,
      engineHoursAtOrder: v.engineHours,
      odometerAtOrder: v.odometerKm,
      parts: defaultParts,
      laborCost,
      partsCost,
      totalCost: partsCost + laborCost,
      notes: `Generada automáticamente por umbral ${v.maintenanceStatus} (${v.engineHours} h / ${v.odometerKm} km).`,
      clearFaultsOnClose: true,
      autoGenerated: true,
      createdAt: iso(15),
    });
  }

  const sortedWorkOrders = sortWorkOrdersList(workOrders, vehicles);

  return {
    schemaVersion: SCHEMA_VERSION,
    tenants,
    users,
    drivers,
    vehicles,
    devices,
    maintenanceRecords,
    workOrders: sortedWorkOrders,
    preventivePlans,
    partsInventory,
    checklists,
    dashcamDrivers,
    alertRules,
    alerts,
    incidents,
    videoClips,
    roles,
    auditLogs,
    currencies: BASE_CURRENCIES.map((c) => ({ ...c, updatedAt: iso(0) })),
    // Demo rates only (seeded data): the real ones are loaded by the superadmin.
    exchangeRates: [
      { id: 'fx-demo-ars', currency: 'ARS', perUsd: 1450, effectiveAt: '2026-01-01T00:00:00.000Z', source: 'demo', createdBy: 'Datos demo', createdAt: '2026-01-01T00:00:00.000Z', tenantId: null },
      { id: 'fx-demo-ves', currency: 'VES', perUsd: 240, effectiveAt: '2026-01-01T00:00:00.000Z', source: 'demo', createdBy: 'Datos demo', createdAt: '2026-01-01T00:00:00.000Z', tenantId: null },
      { id: 'fx-demo-clp', currency: 'CLP', perUsd: 950, effectiveAt: '2026-01-01T00:00:00.000Z', source: 'demo', createdBy: 'Datos demo', createdAt: '2026-01-01T00:00:00.000Z', tenantId: null },
    ],
    currencyChanges: [],
    sizing: {
      vehiclesCount: 96,
      gpsIntervalSec: 15,
      videoMode: 'clips_eventos',
      retentionDays: 30,
      hostingModel: 'cloud_linux',
      concurrentUsers: 18,
      stages: [
        {
          stage: 1,
          title: 'Etapa 1 · Núcleo de gestión',
          focus: 'BackOffice REST, autenticación por empresa, vehículos, maquinaria, usuarios y perfiles RBAC.',
          deliverables: ['Aislamiento multiempresa', 'CRUD flotas y maquinaria', 'Perfiles dinámicos y auditoría'],
          status: 'completada',
        },
        {
          stage: 2,
          title: 'Etapa 2 · Integración de telemetría',
          focus: 'Traccar + JT808 + bus CAN/J1939, normalización PostGIS y cartografía Esri con ArcGIS Maps SDK.',
          deliverables: ['Ingesta GPS y horómetro', 'ArcGIS Dark Gray & Imagery', 'Códigos de falla DTC'],
          status: 'completada',
        },
        {
          stage: 3,
          title: 'Etapa 3 · Alertas e incidentes',
          focus: 'RabbitMQ + Outbox/DLQ, motor de reglas, notificaciones, confirmación y trazabilidad de incidentes.',
          deliverables: ['Motor de reglas por prioridad', 'Bandeja de confirmación', 'Flujo de incidentes'],
          status: 'en_progreso',
        },
        {
          stage: 4,
          title: 'Etapa 4 · Video dashcam',
          focus: 'Servicio independiente JT1078, streaming bajo demanda, clips por evento y almacenamiento S3/MinIO.',
          deliverables: ['Visor dual CH1/CH2', 'Clips automáticos por evento', 'Políticas de retención'],
          status: 'en_progreso',
        },
        {
          stage: 5,
          title: 'Etapa 5 · Analítica y mantenimiento',
          focus: 'Indicadores ejecutivos, mantenimiento predictivo por horómetro, analítica y dimensionamiento.',
          deliverables: ['Reportes exportables', 'Mantenimiento preventivo', 'Dimensionamiento escalable'],
          status: 'pendiente',
        },
      ],
    },
  };
}

/** Traccar alarm codes → alert label, priority and matching rule condition. */
const TRACCAR_ALARMS: Record<
  string,
  { label: string; priority: AlertEvent['priority']; condition: AlertRule['conditionType'] | null }
> = {
  sos: { label: 'Botón de pánico (SOS)', priority: 'critica', condition: 'panico' },
  accident: { label: 'Posible colisión', priority: 'critica', condition: 'colision_g' },
  tampering: { label: 'Manipulación del equipo', priority: 'critica', condition: 'desconexion_cam' },
  overspeed: { label: 'Exceso de velocidad', priority: 'alta', condition: 'velocidad' },
  fatigueDriving: { label: 'Fatiga de conducción', priority: 'alta', condition: 'fatiga_dms' },
  driverDistraction: { label: 'Distracción del conductor', priority: 'alta', condition: 'fatiga_dms' },
  geofenceEnter: { label: 'Entrada a geocerca', priority: 'media', condition: 'geocerca' },
  geofenceExit: { label: 'Salida de geocerca', priority: 'media', condition: 'geocerca' },
  powerCut: { label: 'Corte de alimentación', priority: 'alta', condition: null },
  lowBattery: { label: 'Batería baja', priority: 'media', condition: null },
};

export interface ActiveSession {
  /** sha256 of the bearer token; the raw token is never stored. */
  tokenHash: string;
  userId: string;
  tenantId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_HOURS || 12) * 3_600_000;
const SESSION_MAX_MS = Number(process.env.SESSION_MAX_DAYS || 7) * 86_400_000;
const SESSION_TOUCH_PERSIST_MS = 5 * 60_000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;
// Keeps login timing similar whether or not the username exists.
const DUMMY_PASSWORD_HASH = hashPasswordSync(crypto.randomBytes(12).toString('hex'));

/** Business-rule violation that should reach the client as HTTP 400. */
/** Camera addresses set by the superadmin (videoHost only when the video tunnel has another host). */
export interface CameraServerOverride {
  host: string;
  jt808Port: number;
  videoHost?: string;
  jt1078Port: number;
}

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** Audit entries about global settings (visible only to the superadmin). */
export const GLOBAL_AUDIT_TENANT = 'global';

/** Random id fragment. Replaces timestamp-based ids, which could collide and overwrite rows on upsert. */
function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

class FleetStore {
  private state!: FleetStoreState;
  private sessions: Map<string, ActiveSession> = new Map();
  private sessionTouchPersistedAt: Map<string, number> = new Map();
  private repo = new StateRepository();
  private pendingWrite: Promise<void> = Promise.resolve();
  private initialized = false;
  private persistTimer: NodeJS.Timeout | null = null;
  /** Devices reported by Traccar that match no registered device (onboarding aid, in memory). */
  private unmatchedDevices = new Map<string, UnmatchedDevice>();
  /** Driver registry (documents, authorization, assignment). Shares this store's state and persistence. */
  readonly driverRegistry = new DriverRegistry(() => ({
    state: this.state,
    repo: this.repo,
    audit: (entry) => {
      this.addAuditLog(entry);
    },
    persist: () => this.persist(this.state),
  }));
  /** Currencies, exchange rates and company currency (superadmin). */
  readonly currency = new CurrencyService(() => ({
    state: this.state,
    repo: this.repo,
    audit: (entry) => {
      this.addAuditLog(entry);
    },
    persist: () => this.persist(this.state),
  }));

  async init(): Promise<void> {
    if (this.initialized) return;
    await runMigrations();
    const loaded = await this.repo.loadState(SCHEMA_VERSION);
    if (loaded) {
      this.state = loaded;
    } else {
      this.state = this.buildFreshState();
      this.persist(this.state);
      await this.flush();
    }
    const devicesChanged = this.normalizeDevices();
    const driversChanged = this.normalizeDrivers();
    const legacyDriversChanged = this.driverRegistry.normalizeLegacy();
    const verificationChanged = this.driverRegistry.normalizeVerification();
    const currencyChanged = this.currency.normalize();
    if (devicesChanged || driversChanged || legacyDriversChanged || verificationChanged || currencyChanged) {
      this.persist(this.state);
      await this.flush();
    }
    for (const s of await this.repo.loadActiveSessions()) {
      this.sessions.set(s.tokenHash, s);
    }
    this.phoneServerUrlOverride = (await this.repo.getAppSetting<{ url: string }>('phone_server_url'))?.url ?? null;
    this.obdServerOverride = await this.repo.getAppSetting<{ host: string; port: number }>('obd_server');
    this.cameraServerOverride = await this.repo.getAppSetting<CameraServerOverride>('camera_server');
    await this.currency.load();
    this.initialized = true;
  }

  private buildFreshState(): FleetStoreState {
    const demoCredentials: DemoCredential[] = [];
    const seeded = buildInitialState(demoCredentials);
    if (process.env.SEED_DEMO_DATA === 'true') {
      console.log('\n[seed] Base de datos vacía: se sembraron los datos DEMO. Credenciales (solo desarrollo):');
      for (const c of demoCredentials) console.log(`  - ${c.username.padEnd(18)} ${c.password}   (${c.tenantId})`);
      console.log('');
      return seeded;
    }

    const username = process.env.SUPERADMIN_USERNAME?.trim();
    const password = process.env.SUPERADMIN_PASSWORD;
    const policyError = validatePasswordPolicy(password);
    if (!username || policyError) {
      throw new Error(
        'Base de datos vacía. Define SEED_DEMO_DATA=true (desarrollo) o SUPERADMIN_USERNAME y SUPERADMIN_PASSWORD ' +
          `(producción) en .env. ${policyError ?? ''}`
      );
    }
    console.log(`[seed] Base de datos vacía: se creó únicamente el superadmin "${username}".`);
    return {
      ...seeded,
      tenants: [],
      roles: [],
      users: [
        {
          id: 'usr-super-internal',
          tenantId: 'global',
          name: 'Super Admin Global',
          username: username.toLowerCase(),
          passwordHash: hashPasswordSync(password!),
          roleId: SUPERADMIN_ROLE.id,
          isCompanyAdmin: true,
          isHiddenSuperadmin: true,
          status: 'activo',
          createdAt: new Date().toISOString(),
          failedAttempts: 0,
          lockedUntil: null,
        },
      ],
      drivers: [],
      vehicles: [],
      devices: [],
      maintenanceRecords: [],
      workOrders: [],
      preventivePlans: [],
      partsInventory: [],
      checklists: [],
      alertRules: [],
      alerts: [],
      incidents: [],
      videoClips: [],
      auditLogs: [],
      exchangeRates: [],
      currencyChanges: [],
    };
  }

  /** Queue a diff-based write of the whole state to PostgreSQL. */
  private persist(nextState: FleetStoreState): void {
    const write = this.repo.saveState(nextState);
    write.catch((err) => console.error('[db] Error al guardar el estado:', err));
    this.pendingWrite = write;
  }

  /** Resolves once every queued write is committed; rejects if the latest write failed. */
  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  /** Writes anything still waiting in the persistSoon() debounce. Call before the process exits. */
  async shutdown(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persist(this.state);
    }
    await this.flush();
  }

  /** Coalesces frequent writes (e.g. one per incoming GPS position) into one save every 2 s. */
  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist(this.state);
    }, 2000);
    this.persistTimer.unref?.();
  }

  /** Fills connection fields on devices saved before they existed. Returns true if anything changed. */
  /** Adds built-in driver profiles introduced after the database was created (by id; existing ones are left as edited). */
  private normalizeDrivers(): boolean {
    const known = new Set(this.state.dashcamDrivers.map((d) => d.id));
    const missing = INITIAL_DASHCAM_DRIVERS.filter((d) => !known.has(d.id));
    for (const d of missing) this.state.dashcamDrivers.push(structuredClone(d));
    return missing.length > 0;
  }

  private normalizeDevices(): boolean {
    let changed = false;
    const used = new Set<string>();
    for (const d of this.state.devices) {
      if (!d.terminalId) {
        let candidate = d.imei.slice(-12);
        if (used.has(candidate)) candidate = d.imei;
        d.terminalId = candidate;
        changed = true;
      }
      used.add(d.terminalId);
      if (!d.uplink) {
        d.uplink = 'wifi_starlink';
        changed = true;
      }
      if (!d.telemetrySource) {
        d.telemetrySource = 'simulada';
        changed = true;
      }
    }
    return changed;
  }

  /** Server URL for Traccar Client set by the superadmin (e.g. a tunnel); null = derived from DEVICE_SERVER_HOST. */
  private phoneServerUrlOverride: string | null = null;
  /** Host/port for OBD-II trackers set by the superadmin (TCP tunnel); null = DEVICE_SERVER_HOST + teltonikaPort. */
  private obdServerOverride: { host: string; port: number } | null = null;
  /** Addresses programmed into the cameras set by the superadmin; null = DEVICE_SERVER_HOST + JT808/JT1078 ports. */
  private cameraServerOverride: CameraServerOverride | null = null;

  getDeviceConnectionSettings(): DeviceConnectionSettings {
    const host = process.env.DEVICE_SERVER_HOST?.trim() || null;
    const osmandPort = Number(process.env.DEVICE_OSMAND_PORT || 5055);
    const teltonikaPort = Number(process.env.DEVICE_TELTONIKA_PORT || 5027);
    const jt808Port = Number(process.env.DEVICE_JT808_PORT || 5015);
    const jt1078Port = Number(process.env.DEVICE_JT1078_PORT || 5263);
    const cam = this.cameraServerOverride;
    return {
      host,
      jt808Port,
      jt1078Port,
      teltonikaPort,
      cameraHost: cam?.host ?? host,
      cameraJt808Port: cam?.jt808Port ?? jt808Port,
      cameraVideoHost: cam?.videoHost ?? cam?.host ?? host,
      cameraJt1078Port: cam?.jt1078Port ?? jt1078Port,
      cameraServerCustom: cam !== null,
      osmandPort,
      obdHost: this.obdServerOverride?.host ?? host,
      obdPort: this.obdServerOverride?.port ?? teltonikaPort,
      obdServerCustom: this.obdServerOverride !== null,
      phoneServerUrl: this.phoneServerUrlOverride ?? `http://${host ?? '<dominio-del-VPS>'}:${osmandPort}`,
      phoneServerUrlCustom: this.phoneServerUrlOverride !== null,
      ingestEnabled: Boolean(process.env.INGEST_TOKEN),
    };
  }

  /** Sets (or with null restores) the addresses programmed into the cameras. Global, like the OBD server. */
  async setCameraServer(value: CameraServerOverride | null, actorName: string, actorRole: string): Promise<DeviceConnectionSettings> {
    const fmt = (dc: DeviceConnectionSettings) =>
      `JT808 ${dc.cameraHost ?? '(sin host)'}:${dc.cameraJt808Port} · JT1078 ${dc.cameraVideoHost ?? '(sin host)'}:${dc.cameraJt1078Port}`;
    const before = fmt(this.getDeviceConnectionSettings());
    const clean = value ? { ...value, videoHost: value.videoHost && value.videoHost !== value.host ? value.videoHost : undefined } : null;
    await this.repo.setAppSetting('camera_server', clean);
    this.cameraServerOverride = clean;
    const after = fmt(this.getDeviceConnectionSettings());
    this.addAuditLog({
      tenantId: GLOBAL_AUDIT_TENANT,
      actorName,
      actorRole,
      actorHidden: true,
      module: 'Configuración de Cámaras',
      action: value === null ? 'Servidor de cámaras restaurado' : 'Servidor de cámaras modificado',
      targetLabel: 'Cámaras JT/T 808 / 1078',
      detail: `Antes: ${before}. Ahora: ${after}. Las cámaras ya programadas siguen usando el servidor que tienen: hay que reprogramarlas.`,
    });
    this.persist(this.state);
    return this.getDeviceConnectionSettings();
  }

  /** Sets (or with null restores) the host/port programmed into OBD-II trackers. Global, like the phone URL. */
  async setObdServer(value: { host: string; port: number } | null, actorName: string, actorRole: string): Promise<DeviceConnectionSettings> {
    const fmt = (dc: DeviceConnectionSettings) => `${dc.obdHost ?? '(sin host)'}:${dc.obdPort}`;
    const before = fmt(this.getDeviceConnectionSettings());
    await this.repo.setAppSetting('obd_server', value);
    this.obdServerOverride = value;
    const after = fmt(this.getDeviceConnectionSettings());
    this.addAuditLog({
      tenantId: GLOBAL_AUDIT_TENANT,
      actorName,
      actorRole,
      actorHidden: true,
      module: 'Telemetría OBD-II',
      action: value === null ? 'Servidor OBD-II restaurado' : 'Servidor OBD-II modificado',
      targetLabel: 'Equipos Teltonika',
      detail: `Antes: ${before}. Ahora: ${after}. Los equipos ya programados siguen usando el servidor que tienen: hay que reenviarles el SMS.`,
    });
    this.persist(this.state);
    return this.getDeviceConnectionSettings();
  }

  /** Sets (or with null restores) the Server URL shown to drivers for Traccar Client. Global: one Traccar for every company. */
  async setPhoneServerUrl(url: string | null, actorName: string, actorRole: string): Promise<DeviceConnectionSettings> {
    const before = this.getDeviceConnectionSettings().phoneServerUrl;
    await this.repo.setAppSetting('phone_server_url', url === null ? null : { url });
    this.phoneServerUrlOverride = url;
    const after = this.getDeviceConnectionSettings().phoneServerUrl;
    this.addAuditLog({
      tenantId: GLOBAL_AUDIT_TENANT,
      actorName,
      actorRole,
      actorHidden: true,
      module: 'Conexión Smartphone',
      action: url === null ? 'URL de celulares restaurada' : 'URL de celulares modificada',
      targetLabel: 'Traccar Client',
      detail: `Antes: ${before}. Ahora: ${after}. Los celulares ya configurados siguen usando la URL que tienen cargada.`,
    });
    this.persist(this.state);
    return this.getDeviceConnectionSettings();
  }

  updateDeviceConnection(
    tenantId: string,
    deviceId: string,
    patch: { terminalId: string; uplink: DeviceUplink; wifiSsid?: string },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device | null {
    const dev = this.state.devices.find((d) => d.id === deviceId && (allowAllTenants || d.tenantId === tenantId));
    if (!dev) return null;
    const clash = this.state.devices.find((d) => d.id !== dev.id && d.terminalId === patch.terminalId);
    if (clash) {
      // Traccar identifies devices by this ID, so it must be unique across all companies.
      throw new DomainError('Ese ID de terminal ya está asignado a otro equipo.');
    }
    const before = `${dev.terminalId} · ${dev.uplink} · ${dev.wifiSsid ?? '-'}`;
    dev.terminalId = patch.terminalId;
    dev.uplink = patch.uplink;
    dev.wifiSsid = patch.wifiSsid || undefined;
    this.unmatchedDevices.delete(patch.terminalId);
    this.addAuditLog({
      tenantId: dev.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Configuración de Cámaras',
      action: 'Conexión del equipo',
      targetLabel: dev.unitCode,
      detail: `Antes: ${before}. Ahora: ${dev.terminalId} · ${dev.uplink} · ${dev.wifiSsid ?? '-'}.`,
    });
    this.persist(this.state);
    return dev;
  }

  // ---- Traccar ingest --------------------------------------------------------

  private findDeviceByUniqueId(uniqueId: string): Device | undefined {
    return (
      this.state.devices.find((d) => d.terminalId === uniqueId) ?? this.state.devices.find((d) => d.imei === uniqueId)
    );
  }

  private rememberUnmatched(uniqueId: string, name: string | undefined, at: string, lat?: number, lng?: number) {
    this.unmatchedDevices.set(uniqueId, { uniqueId, name, lastSeenAt: at, lat, lng });
    if (this.unmatchedDevices.size > 50) {
      const oldest = [...this.unmatchedDevices.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];
      this.unmatchedDevices.delete(oldest.uniqueId);
    }
  }

  /** Applies a position forwarded by Traccar. Returns whether it matched a registered device. */
  ingestTraccarPosition(input: {
    uniqueId: string;
    deviceName?: string;
    positionId?: number;
    latitude: number;
    longitude: number;
    speedKnots?: number;
    course?: number;
    fixTime: string;
    serverTime?: string;
    odometerMeters?: number;
    ignition?: boolean;
    /** Engine data (OBD-II trackers); applied only for devices with role 'telemetria'. */
    obd?: ObdReading | null;
    /** Smartphone extras (Traccar Client): fix accuracy, battery and charging state. */
    accuracyM?: number;
    batteryPct?: number;
    charging?: boolean;
  }): { matched: boolean; vehicleId?: string; stale?: boolean; phone?: boolean } {
    const seenAt = input.serverTime ?? new Date().toISOString();
    const dev = this.findDeviceByUniqueId(input.uniqueId);
    if (!dev) {
      const driver = this.findPhoneDriver(input.uniqueId);
      if (driver) return this.ingestPhonePosition(driver, input, seenAt);
      this.rememberUnmatched(input.uniqueId, input.deviceName, seenAt, input.latitude, input.longitude);
      return { matched: false };
    }
    const v = this.state.vehicles.find((x) => x.id === dev.vehicleId);

    // Traccar forwards concurrently and cameras replay buffered positions (0x0704) when coverage
    // returns, so positions can arrive out of order. Never move a unit back to an older position.
    let stale = false;
    if (v && dev.telemetrySource === 'traccar') {
      const fix = Date.parse(input.fixTime);
      const last = Date.parse(v.lastReportAt);
      if (Number.isFinite(fix) && Number.isFinite(last)) {
        stale =
          fix < last ||
          (fix === last &&
            input.positionId != null &&
            input.positionId > 0 &&
            dev.lastTraccarPositionId != null &&
            input.positionId <= dev.lastTraccarPositionId);
      }
    }

    dev.linkStatus = 'conectado';
    dev.lastHeartbeatAt = seenAt;
    dev.telemetrySource = 'traccar';
    if (stale) {
      this.persistSoon();
      return { matched: true, vehicleId: v?.id, stale: true };
    }
    // Traccar 6.17 forwards before saving, so the id is usually 0; only real ids help ordering.
    if (input.positionId != null && input.positionId > 0) dev.lastTraccarPositionId = input.positionId;
    if (v) {
      const speedKmh = Math.round((input.speedKnots ?? 0) * 1.852 * 10) / 10;
      v.lat = Number(input.latitude.toFixed(6));
      v.lng = Number(input.longitude.toFixed(6));
      v.speedKmh = speedKmh;
      if (typeof input.course === 'number') v.heading = Math.round(input.course) % 360;
      if (typeof input.ignition === 'boolean') v.ignition = input.ignition;
      if (typeof input.odometerMeters === 'number' && input.odometerMeters > 0) {
        v.odometerKm = Number((input.odometerMeters / 1000).toFixed(1));
      }
      if (v.operationalStatus !== 'alerta') {
        v.operationalStatus = speedKmh > 3 ? 'en_ruta' : 'detenido';
      }
      v.lastReportAt = input.fixTime;
      v.positionSource = 'equipo';
      v.positionSourceLabel = undefined;
      if (dev.role === 'telemetria' && input.obd) this.applyObdReading(v, dev, input.obd, input.fixTime);
    }
    this.persistSoon();
    return { matched: true, vehicleId: v?.id };
  }

  // ---- Driver smartphones (Traccar Client, OsmAnd protocol) -----------------

  private static readonly PHONE_ACTOR = { name: 'Celular del chofer', role: 'Sistema' };

  /**
   * Last raw position of each phone (even an imprecise one), in memory only. Used to place an SOS
   * when the phone has no accepted fix yet.
   */
  private lastPhoneRaw = new Map<string, { lat: number; lng: number; at: number; speedKmh: number }>();

  private findPhoneDriver(uniqueId: string): Driver | undefined {
    return this.state.drivers.find((d) => d.phoneTracker?.identifier === uniqueId);
  }

  private assignedVehicleOf(d: Driver): Vehicle | undefined {
    return this.state.vehicles.find((v) => v.driverId === d.id && v.tenantId === d.tenantId);
  }

  /** True when the unit's own camera / OBD tracker reported through Traccar recently: it wins over the phone. */
  private unitHasLiveDevice(v: Vehicle, now: number): boolean {
    return this.state.devices.some(
      (d) =>
        d.vehicleId === v.id &&
        d.telemetrySource === 'traccar' &&
        now - Date.parse(d.lastHeartbeatAt) < PHONE_DEVICE_PRIORITY_MS
    );
  }

  private phoneAlert(
    d: Driver,
    v: Vehicle | undefined,
    ruleName: string,
    priority: AlertEvent['priority'],
    summary: string,
    at: string,
    ruleId = 'smartphone',
    where?: { lat: number; lng: number; speedKmh?: number }
  ) {
    const fix = where ?? d.phoneTracker?.lastFix;
    const alert: AlertEvent = {
      id: `alr-${uid()}`,
      tenantId: d.tenantId,
      vehicleId: v?.id ?? '',
      unitCode: v?.unitCode ?? 'Sin unidad',
      plate: v?.plate ?? '',
      driverName: d.name,
      ruleId,
      ruleName,
      priority,
      status: 'pendiente',
      lat: v?.lat ?? fix?.lat ?? 0,
      lng: v?.lng ?? fix?.lng ?? 0,
      speedKmh: v?.speedKmh ?? fix?.speedKmh ?? 0,
      timestamp: at,
      clipId: null,
      summary,
    };
    this.state.alerts.unshift(alert);
    return alert;
  }

  /**
   * Position from a driver's phone. Coordinates are kept only while the driver has a unit assigned
   * (privacy); the unit moves only if its own tracker is silent.
   */
  private ingestPhonePosition(
    d: Driver,
    input: {
      latitude: number;
      longitude: number;
      speedKnots?: number;
      course?: number;
      fixTime: string;
      accuracyM?: number;
      batteryPct?: number;
      charging?: boolean;
    },
    seenAt: string
  ): { matched: boolean; vehicleId?: string; stale?: boolean; phone: true } {
    const t = d.phoneTracker!;
    t.lastSeenAt = seenAt;
    this.lastPhoneRaw.set(d.id, {
      lat: Number(input.latitude.toFixed(6)),
      lng: Number(input.longitude.toFixed(6)),
      at: Date.now(),
      speedKmh: Math.round((input.speedKnots ?? 0) * 1.852 * 10) / 10,
    });
    if (typeof input.batteryPct === 'number') t.batteryPct = Math.round(input.batteryPct);
    if (typeof input.charging === 'boolean') t.charging = input.charging;
    if (t.provisioning?.status !== 'conectado') {
      t.provisioning = { status: 'conectado', at: seenAt, firstReportAt: seenAt };
      this.addAuditLog({
        tenantId: d.tenantId,
        actorName: FleetStore.PHONE_ACTOR.name,
        actorRole: FleetStore.PHONE_ACTOR.role,
        module: 'Conexión Smartphone',
        action: 'Celular conectado',
        targetLabel: d.name,
        detail: `Primer reporte del celular ${t.identifier} (Traccar Client).`,
      });
    }
    const v = this.assignedVehicleOf(d);
    const fixMs = Date.parse(input.fixTime);
    const tooVague = typeof input.accuracyM === 'number' && input.accuracyM > PHONE_MAX_ACCURACY_M;
    const older = t.lastFix && Number.isFinite(fixMs) && fixMs <= Date.parse(t.lastFix.at);
    const speedKmh = Math.round((input.speedKnots ?? 0) * 1.852 * 10) / 10;
    const accepted = !tooVague && !older && Number.isFinite(fixMs);
    if (accepted) {
      // The phone's last position is always kept on the driver; a unit moves only if one is assigned.
      t.lastFix = {
        lat: Number(input.latitude.toFixed(6)),
        lng: Number(input.longitude.toFixed(6)),
        at: input.fixTime,
        speedKmh,
        accuracyM: typeof input.accuracyM === 'number' ? Math.round(input.accuracyM) : undefined,
        vehicleId: v?.id,
      };
      t.offlineAlertFor = undefined;
    }
    if (!v) {
      this.persistSoon();
      return { matched: true, stale: !accepted || undefined, phone: true };
    }

    // Low battery: one alert per assignment while it stays low.
    if (typeof t.batteryPct === 'number' && t.batteryPct < PHONE_LOW_BATTERY_PCT && !t.charging) {
      if (t.lowBatteryAlertFor !== v.id) {
        t.lowBatteryAlertFor = v.id;
        this.phoneAlert(
          d,
          v,
          'Batería baja del celular del chofer',
          'media',
          `El celular de ${d.name} tiene ${t.batteryPct} % de batería: puede dejar de reportar la posición de ${v.unitCode}.`,
          seenAt
        );
      }
    } else if (typeof t.batteryPct === 'number' && (t.batteryPct >= PHONE_LOW_BATTERY_PCT + 5 || t.charging)) {
      t.lowBatteryAlertFor = undefined;
    }

    if (!accepted || !t.lastFix) {
      this.persistSoon();
      return { matched: true, vehicleId: v.id, stale: true, phone: true };
    }

    const lastUnit = Date.parse(v.lastReportAt);
    if (!this.unitHasLiveDevice(v, Date.now()) && !(Number.isFinite(lastUnit) && v.positionSource !== 'smartphone' && fixMs < lastUnit)) {
      v.lat = t.lastFix.lat;
      v.lng = t.lastFix.lng;
      v.speedKmh = speedKmh;
      if (typeof input.course === 'number' && input.course >= 0) v.heading = Math.round(input.course) % 360;
      if (v.operationalStatus !== 'alerta') v.operationalStatus = speedKmh > 3 ? 'en_ruta' : 'detenido';
      v.lastReportAt = input.fixTime;
      v.positionSource = 'smartphone';
      v.positionSourceLabel = `Celular de ${d.name}`;
    }
    this.persistSoon();
    return { matched: true, vehicleId: v.id, phone: true };
  }

  /** Alarms from the phone (e.g. SOS) become alerts on the driver's unit. */
  private ingestPhoneEvent(
    d: Driver,
    input: { type: string; alarm?: string; eventTime: string; latitude?: number; longitude?: number }
  ): { matched: boolean; alertId?: string } {
    const t = d.phoneTracker!;
    if (input.type === 'deviceOnline') t.lastSeenAt = input.eventTime;
    if (input.type !== 'alarm') {
      this.persistSoon();
      return { matched: true };
    }
    const v = this.assignedVehicleOf(d);
    const alarm = input.alarm ?? 'general';
    const meta = TRACCAR_ALARMS[alarm] ?? { label: `Alarma del celular (${alarm})`, priority: 'media' as const, condition: null };
    const rule = meta.condition
      ? this.state.alertRules.find((r) => r.tenantId === d.tenantId && r.conditionType === meta.condition && r.active)
      : undefined;
    const hasEventFix = typeof input.latitude === 'number' && typeof input.longitude === 'number' && !(input.latitude === 0 && input.longitude === 0);
    if (v && hasEventFix && !this.unitHasLiveDevice(v, Date.now())) {
      v.lat = Number(input.latitude!.toFixed(6));
      v.lng = Number(input.longitude!.toFixed(6));
    }
    // An alarm is an emergency: it carries where the phone is, even off shift.
    const raw = this.lastPhoneRaw.get(d.id);
    const where = hasEventFix
      ? { lat: Number(input.latitude!.toFixed(6)), lng: Number(input.longitude!.toFixed(6)) }
      : raw && Date.now() - raw.at < 5 * 60_000
        ? raw
        : undefined;
    const place = where ? ` Ubicación del celular: ${where.lat}, ${where.lng}.` : ' El celular no envió su ubicación.';
    const alert = this.phoneAlert(
      d,
      v,
      rule?.name ?? meta.label,
      meta.priority,
      `${meta.label} enviada desde el celular de ${d.name}${v ? ` (${v.unitCode})` : ' (sin unidad asignada)'}.${place}`,
      input.eventTime,
      rule?.id ?? 'smartphone',
      v && !where ? undefined : where
    );
    if (v && meta.priority === 'critica') v.operationalStatus = 'alerta';
    this.persistSoon();
    return { matched: true, alertId: alert.id };
  }

  /** «Celular del chofer sin señal»: the unit depends on the phone and it stopped reporting. Runs every minute. */
  sweepPhones(now = Date.now()): number {
    let raised = 0;
    for (const d of this.state.drivers) {
      const t = d.phoneTracker;
      if (!t?.lastSeenAt) continue;
      const v = this.assignedVehicleOf(d);
      if (!v || v.positionSource !== 'smartphone' || v.operationalStatus !== 'en_ruta') continue;
      if (now - Date.parse(t.lastSeenAt) < PHONE_OFFLINE_MINUTES * 60_000) continue;
      if (t.offlineAlertFor === t.lastSeenAt || this.unitHasLiveDevice(v, now)) continue;
      t.offlineAlertFor = t.lastSeenAt;
      this.phoneAlert(
        d,
        v,
        'Celular del chofer sin señal',
        'alta',
        `${v.unitCode} se rastrea con el celular de ${d.name} y no reporta desde hace más de ${PHONE_OFFLINE_MINUTES} minutos.`,
        new Date(now).toISOString()
      );
      raised++;
    }
    if (raised) this.persistSoon();
    return raised;
  }

  private phoneDriver(tenantId: string, driverId: string, allowAllTenants: boolean): Driver {
    const d = this.state.drivers.find((x) => x.id === driverId && (allowAllTenants || x.tenantId === tenantId));
    if (!d) throw new DomainError('Chofer no encontrado en tu empresa.', 404);
    return d;
  }

  private identifierTaken(id: string, exceptDriverId?: string): boolean {
    return (
      this.state.devices.some((x) => x.terminalId === id || x.imei === id) ||
      this.state.drivers.some((x) => x.id !== exceptDriverId && x.phoneTracker?.identifier === id)
    );
  }

  /**
   * Registers (or updates) the driver's phone. Keeps the identifier unless regenerate is set (new or lost phone).
   * Returns the previous Traccar id when it must be deleted.
   */
  assignDriverPhone(
    tenantId: string,
    driverId: string,
    input: { platform: PhonePlatform; regenerate?: boolean },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { driver: Driver; oldTraccarId?: number } {
    const d = this.phoneDriver(tenantId, driverId, allowAllTenants);
    if (d.enabled === false) throw new DomainError('El chofer está deshabilitado: habilitalo antes de conectar su celular.');
    const current = d.phoneTracker;
    let oldTraccarId: number | undefined;
    let tracker: DriverPhoneTracker;
    if (!current || input.regenerate) {
      let identifier = newPhoneIdentifier();
      for (let i = 0; i < 20 && this.identifierTaken(identifier, d.id); i++) identifier = newPhoneIdentifier();
      if (this.identifierTaken(identifier, d.id)) throw new DomainError('No se pudo generar un identificador libre. Probá de nuevo.');
      oldTraccarId = current?.traccarId;
      tracker = { identifier, platform: input.platform, createdAt: new Date().toISOString() };
    } else {
      tracker = { ...current, platform: input.platform };
    }
    d.phoneTracker = tracker;
    this.addAuditLog({
      tenantId: d.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Conexión Smartphone',
      action: !current ? 'Celular dado de alta' : input.regenerate ? 'Nuevo identificador de celular' : 'Celular modificado',
      targetLabel: d.name,
      detail: `${tracker.identifier} · ${input.platform === 'ios' ? 'iPhone' : 'Android'}${
        input.regenerate && current ? `. El identificador anterior ${current.identifier} deja de funcionar.` : ''
      }`,
    });
    this.persist(this.state);
    return { driver: d, oldTraccarId };
  }

  setPhoneProvisioning(driverId: string, result: { traccarId?: number; status: PhoneProvisioningStatus; message?: string }) {
    const t = this.state.drivers.find((d) => d.id === driverId)?.phoneTracker;
    if (!t) return;
    if (result.traccarId !== undefined) t.traccarId = result.traccarId;
    if (t.provisioning?.status === 'conectado') t.provisioning = { ...t.provisioning, message: result.message };
    else t.provisioning = { status: result.status, message: result.message, at: new Date().toISOString() };
    this.persistSoon();
  }

  getDriverPhone(tenantId: string, driverId: string, allowAllTenants = false): Driver {
    return this.phoneDriver(tenantId, driverId, allowAllTenants);
  }

  removeDriverPhone(
    tenantId: string,
    driverId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): DriverPhoneTracker {
    const d = this.phoneDriver(tenantId, driverId, allowAllTenants);
    const t = d.phoneTracker;
    if (!t) throw new DomainError('El chofer no tiene celular conectado.', 404);
    d.phoneTracker = undefined;
    const v = this.assignedVehicleOf(d);
    if (v?.positionSource === 'smartphone') v.positionSourceLabel = `Celular de ${d.name} (retirado)`;
    this.addAuditLog({
      tenantId: d.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Conexión Smartphone',
      action: 'Celular retirado',
      targetLabel: d.name,
      detail: `Se quitó el celular ${t.identifier}.`,
    });
    this.persist(this.state);
    return t;
  }

  /** Rows of the «Conexión Smartphone» tab (scope 'all' = every company, superadmin). */
  listPhones(scopeTenantId: string): PhoneListItem[] {
    return this.state.drivers
      .filter((d) => scopeTenantId === 'all' || d.tenantId === scopeTenantId)
      .map((d) => {
        const v = this.assignedVehicleOf(d);
        return {
          driverId: d.id,
          tenantId: d.tenantId,
          tenantName: this.state.tenants.find((t) => t.id === d.tenantId)?.name,
          driverName: d.name,
          driverPhone: d.phone,
          enabled: d.enabled !== false,
          assignedVehicle: v ? { id: v.id, unitCode: v.unitCode, plate: v.plate, positionSource: v.positionSource } : undefined,
          tracker: d.phoneTracker,
        };
      })
      .sort((a, b) => Number(Boolean(b.tracker)) - Number(Boolean(a.tracker)) || a.driverName.localeCompare(b.driverName));
  }

  // ---- OBD-II telemetry ------------------------------------------------------

  private static readonly OBD_ACTOR = { name: 'Telemetría OBD-II', role: 'Sistema' };

  /** Copies engine data to the unit and turns new trouble codes into an alert plus a corrective work order. */
  private applyObdReading(v: Vehicle, dev: Device, obd: ObdReading, at: string) {
    if (obd.rpm !== undefined) v.rpm = Math.round(obd.rpm);
    if (obd.coolantTempC !== undefined) v.coolantTempC = Math.round(obd.coolantTempC);
    if (obd.fuelPct !== undefined) v.fuelLevelPct = Math.round(obd.fuelPct);
    if (obd.odometerKm !== undefined) v.odometerKm = obd.odometerKm;
    if (obd.engineHours !== undefined) v.engineHours = obd.engineHours;
    if (obd.batteryV !== undefined) v.batteryVoltage = obd.batteryV;
    if (obd.vin) {
      dev.vin = obd.vin;
      if (!v.vin) v.vin = obd.vin;
    }
    v.telemetrySourceEngine = 'obd';
    dev.lastObdAt = at;
    if (dev.provisioning?.status !== 'conectado') {
      dev.provisioning = { status: 'conectado', at, firstReportAt: at };
      this.addAuditLog({
        tenantId: v.tenantId,
        actorName: FleetStore.OBD_ACTOR.name,
        actorRole: FleetStore.OBD_ACTOR.role,
        module: 'Telemetría OBD-II',
        action: 'Equipo OBD-II conectado',
        targetLabel: v.unitCode,
        detail: `Primer reporte del equipo ${dev.imei} con datos del motor.`,
      });
    }
    if (obd.dtcs) this.syncObdFaults(v, obd.dtcs, at);
    this.recordObdSample(v, obd, at);
  }

  /** Last stored history sample per unit (ms); limits the history to one sample per minute. */
  private lastObdSample = new Map<string, number>();
  /** Pending history writes; queries wait for them so a reading is visible right after ingest. */
  private obdWrites: Promise<unknown> = Promise.resolve();
  static readonly OBD_SAMPLE_EVERY_MS = 60_000;
  static readonly OBD_RETENTION_DAYS = 90;

  private queueObdWrite(label: string, fn: () => Promise<unknown>) {
    this.obdWrites = this.obdWrites.then(fn).catch((err) => console.error(`[db] ${label}:`, err));
  }

  private recordObdSample(v: Vehicle, obd: ObdReading, at: string) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const last = this.lastObdSample.get(v.id);
    if (last !== undefined && Math.abs(t - last) < FleetStore.OBD_SAMPLE_EVERY_MS) return;
    this.lastObdSample.set(v.id, t);
    const sample = {
      tenantId: v.tenantId,
      vehicleId: v.id,
      at,
      rpm: obd.rpm,
      coolantC: obd.coolantTempC,
      fuelPct: obd.fuelPct,
      batteryV: obd.batteryV,
      odometerKm: obd.odometerKm,
      speedKmh: v.speedKmh,
    };
    this.queueObdWrite('insertObdSample', () => this.repo.insertObdSample(sample));
  }

  /** Deletes history older than the retention window. Runs at startup and every 24 h. */
  async purgeObdHistory(): Promise<number> {
    const cutoff = new Date(Date.now() - FleetStore.OBD_RETENTION_DAYS * 86_400_000).toISOString();
    return this.repo.purgeObdSamples(cutoff);
  }

  private obdVehicle(tenantId: string, vehicleId: string, allowAllTenants: boolean): Vehicle | undefined {
    return this.state.vehicles.find((x) => x.id === vehicleId && (allowAllTenants || x.tenantId === tenantId));
  }

  /** Engine history of a unit, aggregated so each range returns at most ~300 points. */
  async getObdHistory(
    tenantId: string,
    vehicleId: string,
    range: ObdHistoryRange,
    allowAllTenants = false
  ): Promise<ObdHistoryPoint[] | null> {
    const v = this.obdVehicle(tenantId, vehicleId, allowAllTenants);
    if (!v) return null;
    const spec = { '24h': { hours: 24, bucket: 300 }, '7d': { hours: 168, bucket: 3600 }, '30d': { hours: 720, bucket: 6 * 3600 } }[range];
    await this.obdWrites;
    const from = new Date(Date.now() - spec.hours * 3_600_000).toISOString();
    return this.repo.obdHistory(v.tenantId, v.id, from, spec.bucket);
  }

  async getObdFaultHistory(tenantId: string, vehicleId: string, allowAllTenants = false): Promise<ObdFaultEvent[] | null> {
    const v = this.obdVehicle(tenantId, vehicleId, allowAllTenants);
    if (!v) return null;
    await this.obdWrites;
    return this.repo.listObdFaults(v.tenantId, v.id);
  }

  /** The OBD-II tracker of a unit (tenant-scoped). */
  getObdDevice(tenantId: string, vehicleId: string, allowAllTenants = false): { vehicle: Vehicle; device?: Device } | null {
    const v = this.obdVehicle(tenantId, vehicleId, allowAllTenants);
    if (!v) return null;
    return { vehicle: v, device: v.obdDeviceId ? this.state.devices.find((d) => d.id === v.obdDeviceId) : undefined };
  }

  /** Result of creating the tracker in Traccar. */
  setObdProvisioning(deviceId: string, result: { traccarId?: number; status: ObdProvisioningStatus; message?: string }) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return;
    if (result.traccarId !== undefined) dev.traccarId = result.traccarId;
    if (dev.provisioning?.status === 'conectado') {
      // Already reporting: keep it connected, only remember a Traccar problem in the message.
      dev.provisioning = { ...dev.provisioning, message: result.message };
    } else {
      dev.provisioning = { status: result.status, message: result.message, at: new Date().toISOString() };
    }
    this.persistSoon();
  }

  /** Stores a remote command in the tracker log (newest first, max 20) and audits it. */
  recordObdCommand(
    deviceId: string,
    entry: Omit<ObdCommandEntry, 'id' | 'at'>,
    actorRole: string,
    actorHidden = false
  ): ObdCommandEntry | null {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return null;
    const full: ObdCommandEntry = { id: `cmd-${uid()}`, at: new Date().toISOString(), ...entry };
    dev.commandLog = [full, ...(dev.commandLog ?? [])].slice(0, 20);
    const outcome =
      entry.status === 'en_cola'
        ? 'en cola hasta que el equipo se conecte'
        : entry.status === 'error'
          ? `error: ${entry.response ?? ''}`
          : 'enviado';
    this.addAuditLog({
      tenantId: dev.tenantId,
      actorName: entry.actorName,
      actorRole,
      actorHidden,
      module: 'Telemetría OBD-II',
      action: 'Comando OBD-II enviado',
      targetLabel: dev.unitCode,
      detail: `${entry.label} (${entry.text.trim()}) → ${outcome}.`,
    });
    this.persist(this.state);
    return full;
  }

  private syncObdFaults(v: Vehicle, codes: string[], at: string) {
    // Once the OBD reports, its list replaces demo codes; CAN codes from other sources stay.
    const kept = v.faultCodes.filter((f) => f.source === 'can');
    const previous = new Map(v.faultCodes.filter((f) => f.source === 'obd').map((f) => [f.code, f]));
    const cleared = [...previous.keys()].filter((c) => !codes.includes(c));
    const next = codes.map((code) => {
      const existing = previous.get(code);
      if (existing) return existing;
      const info = describeDtc(code);
      const fault: FaultCode = { ...info, source: 'obd', firstSeenAt: at };
      this.raiseObdFault(v, fault, at);
      return fault;
    });
    v.faultCodes = [...kept, ...next];
    for (const code of cleared) {
      this.queueObdWrite('clearObdFault', () => this.repo.clearObdFault(v.id, code, at));
      this.addAuditLog({
        tenantId: v.tenantId,
        actorName: FleetStore.OBD_ACTOR.name,
        actorRole: FleetStore.OBD_ACTOR.role,
        module: 'Telemetría OBD-II',
        action: 'Falla borrada',
        targetLabel: v.unitCode,
        detail: `El código ${code} ya no está activo en la computadora del vehículo. La orden de trabajo, si existe, sigue abierta para que el taller la cierre.`,
      });
    }
  }

  /** Alert + corrective work order (one per unit and code while an order is open). */
  private raiseObdFault(v: Vehicle, fault: FaultCode, at: string) {
    const priority = fault.severity === 'critica' ? 'critica' : 'alta';
    this.state.alerts.unshift({
      id: `alr-${uid()}`,
      tenantId: v.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      plate: v.plate,
      driverName: v.driverName,
      ruleId: 'obd',
      ruleName: `Falla OBD-II ${fault.code}`,
      priority,
      status: 'pendiente',
      lat: v.lat,
      lng: v.lng,
      speedKmh: v.speedKmh,
      timestamp: at,
      clipId: null,
      summary: `${fault.code}: ${fault.description} (${fault.system}). Reportado por el equipo OBD-II.`,
    });
    const open = this.state.workOrders.find(
      (o) => o.vehicleId === v.id && o.status !== 'completada' && o.status !== 'cancelada' && o.title.includes(fault.code)
    );
    if (open) {
      fault.workOrderId = open.id;
    } else {
      const order = this.createWorkOrder(
      v.tenantId,
      {
        vehicleId: v.id,
        type: 'correctivo',
        priority: fault.severity === 'critica' ? 'critica' : 'alta',
        title: `Falla OBD-II ${fault.code}: ${fault.description}`.slice(0, 160),
        workshopOrTech: 'Taller a definir',
        scheduledDate: at.slice(0, 10),
        parts: [],
        laborCost: 0,
        notes: `Abierta automáticamente por la telemetría OBD-II. Sistema: ${fault.system}. Verificar con escáner antes de reparar.`,
        clearFaultsOnClose: true,
      },
      FleetStore.OBD_ACTOR.name,
      FleetStore.OBD_ACTOR.role,
      true,
      false
    );
      if (order) fault.workOrderId = order.id;
    }
    const event = {
      id: `obdf-${uid()}`,
      tenantId: v.tenantId,
      vehicleId: v.id,
      code: fault.code,
      description: fault.description,
      severity: fault.severity,
      system: fault.system,
      openedAt: at,
      workOrderId: fault.workOrderId ?? null,
    };
    this.queueObdWrite('openObdFault', () => this.repo.openObdFault(event));
  }

  /** Installs (or replaces) the OBD-II tracker of a unit. Its Traccar identifier is the IMEI. */
  assignObdDevice(
    tenantId: string,
    vehicleId: string,
    input: { imei: string; catalogModelId?: string; vin?: string; apn?: string },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device | null {
    const v = this.state.vehicles.find((x) => x.id === vehicleId && (allowAllTenants || x.tenantId === tenantId));
    if (!v) return null;
    const current = v.obdDeviceId ? this.state.devices.find((d) => d.id === v.obdDeviceId) : undefined;
    const clash = this.state.devices.find((d) => d.id !== current?.id && (d.imei === input.imei || d.terminalId === input.imei));
    if (clash) throw new DomainError(`Ese IMEI ya está registrado en el equipo de la unidad ${clash.unitCode}.`);
    const model = findCatalogModel(input.catalogModelId) ?? findCatalogModel('teltonika-fmc003');
    const label = model ? `${model.vendor} ${model.model}` : 'Rastreador OBD-II';
    const nowIso = new Date().toISOString();
    const dev: Device = current ?? {
      id: `dev-obd-${uid()}`,
      tenantId: v.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      imei: input.imei,
      iccid: '',
      simCarrier: '',
      model: label,
      protocol: 'Traccar',
      firmware: '',
      channels: [],
      linkStatus: 'desconectado',
      hardwareValidated: false,
      lastHeartbeatAt: nowIso,
      dashcamConfig: buildDefaultDashcamConfig(label, 'Traccar', this.state.dashcamDrivers, actorName),
      terminalId: input.imei,
      uplink: 'celular',
      telemetrySource: 'simulada',
      role: 'telemetria',
    };
    const before = current ? `${current.imei} · ${current.model}` : 'sin equipo';
    if (current && current.imei !== input.imei) {
      // Another tracker: it must report again; the route recreates it in Traccar.
      dev.lastObdAt = undefined;
      dev.provisioning = undefined;
      dev.traccarId = undefined;
      dev.commandLog = [];
    }
    if (input.apn !== undefined) dev.apn = input.apn || undefined;
    dev.imei = input.imei;
    dev.terminalId = input.imei;
    dev.model = label;
    if (model) dev.catalogModelId = model.id;
    if (!current) this.state.devices.push(dev);
    v.obdDeviceId = dev.id;
    if (input.vin) v.vin = input.vin.toUpperCase();
    this.unmatchedDevices.delete(input.imei);
    this.addAuditLog({
      tenantId: v.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Telemetría OBD-II',
      action: current ? 'Equipo OBD-II modificado' : 'Equipo OBD-II instalado',
      targetLabel: v.unitCode,
      detail: `Antes: ${before}. Ahora: ${dev.imei} · ${dev.model}${v.vin ? ` · VIN ${v.vin}` : ''}.`,
    });
    this.persist(this.state);
    return dev;
  }

  /** Removes the OBD-II tracker; engine data goes back to demo values. Active faults stay until repaired. */
  removeObdDevice(
    tenantId: string,
    vehicleId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device | null {
    const v = this.state.vehicles.find((x) => x.id === vehicleId && (allowAllTenants || x.tenantId === tenantId));
    if (!v || !v.obdDeviceId) return null;
    const dev = this.state.devices.find((d) => d.id === v.obdDeviceId);
    this.state.devices = this.state.devices.filter((d) => d.id !== v.obdDeviceId);
    v.obdDeviceId = undefined;
    v.telemetrySourceEngine = 'simulada';
    this.addAuditLog({
      tenantId: v.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Telemetría OBD-II',
      action: 'Equipo OBD-II retirado',
      targetLabel: v.unitCode,
      detail: `Se quitó el equipo ${dev?.imei ?? ''} (${dev?.model ?? ''}).`,
    });
    this.lastObdSample.delete(v.id);
    this.persist(this.state);
    return dev ?? null;
  }

  /** Applies an event forwarded by Traccar (alarms, online/offline). */
  ingestTraccarEvent(input: {
    uniqueId: string;
    deviceName?: string;
    type: string;
    alarm?: string;
    eventTime: string;
    latitude?: number;
    longitude?: number;
    speedKnots?: number;
    /** Reply text of a commandResult event. */
    result?: string;
  }): { matched: boolean; alertId?: string } {
    const dev = this.findDeviceByUniqueId(input.uniqueId);
    if (!dev) {
      const driver = this.findPhoneDriver(input.uniqueId);
      if (driver) return this.ingestPhoneEvent(driver, input);
      this.rememberUnmatched(input.uniqueId, input.deviceName, input.eventTime, input.latitude, input.longitude);
      return { matched: false };
    }
    if (input.type === 'deviceOnline') {
      dev.linkStatus = 'conectado';
      dev.lastHeartbeatAt = input.eventTime;
      this.persistSoon();
      return { matched: true };
    }
    if (input.type === 'deviceOffline' || input.type === 'deviceUnknown') {
      dev.linkStatus = 'desconectado';
      this.persistSoon();
      return { matched: true };
    }
    if (input.type === 'commandResult') {
      // Replies are matched to the oldest command still waiting for one.
      const waiting = (dev.commandLog ?? []).filter((c) => c.status === 'enviado' || c.status === 'en_cola');
      const target = waiting[waiting.length - 1];
      if (target) {
        target.status = 'respondido';
        target.response = (input.result ?? '').slice(0, 1000);
        target.respondedAt = input.eventTime;
        this.persistSoon();
      }
      return { matched: true };
    }
    if (input.type !== 'alarm') return { matched: true };

    const v = this.state.vehicles.find((x) => x.id === dev.vehicleId);
    if (!v) return { matched: true };
    const alarm = input.alarm ?? 'general';
    const meta = TRACCAR_ALARMS[alarm] ?? { label: `Alarma del equipo (${alarm})`, priority: 'media' as const, condition: null };
    const rule = meta.condition
      ? this.state.alertRules.find((r) => r.tenantId === v.tenantId && r.conditionType === meta.condition && r.active)
      : undefined;
    const alert: AlertEvent = {
      id: `alr-${uid()}`,
      tenantId: v.tenantId,
      vehicleId: v.id,
      unitCode: v.unitCode,
      plate: v.plate,
      driverName: v.driverName,
      ruleId: rule?.id ?? 'traccar',
      ruleName: rule?.name ?? meta.label,
      priority: meta.priority,
      status: 'pendiente',
      lat: input.latitude ?? v.lat,
      lng: input.longitude ?? v.lng,
      speedKmh: input.speedKnots != null ? Math.round(input.speedKnots * 1.852) : v.speedKmh,
      timestamp: input.eventTime,
      clipId: null,
      summary: `${meta.label} reportada por el equipo ${dev.terminalId} vía Traccar.`,
    };
    this.state.alerts.unshift(alert);
    if (meta.priority === 'critica') v.operationalStatus = 'alerta';
    this.persistSoon();
    return { matched: true, alertId: alert.id };
  }

  /** Returns the tenant id if it exists; never falls back to another company. */
  private requireTenant(tenantId: string): string {
    if (!this.state.tenants.some((t) => t.id === tenantId)) {
      throw new DomainError('La empresa destino no existe. Selecciona una empresa válida.');
    }
    return tenantId;
  }

  private buildGlobalTenantSummary(): Tenant {
    return {
      id: 'all',
      name: 'Todas las empresas',
      taxId: 'GLOBAL-SUPERADMIN',
      city: 'Cobertura Nacional',
      branches: Array.from(new Set(this.state.tenants.flatMap((t) => t.branches))),
      vehicleQuota: this.state.tenants.reduce((sum, t) => sum + t.vehicleQuota, 0),
      retentionDays: 90,
      planTier: 'Acceso Global',
      status: 'activo',
      // Consolidated view: amounts converted to the platform reference currency.
      currency: this.currency.platformReferenceCurrency,
      referenceCurrency: this.currency.platformReferenceCurrency,
    };
  }

  private toPublicUser(u: UserAccount): PublicUser {
    const role = u.isHiddenSuperadmin
      ? SUPERADMIN_ROLE
      : this.state.roles.find((r) => r.id === u.roleId);
    return {
      id: u.id,
      tenantId: u.tenantId,
      name: u.name,
      username: u.username,
      roleId: u.roleId,
      roleName: role?.name ?? 'Operador',
      isCompanyAdmin: u.isCompanyAdmin || Boolean(u.isHiddenSuperadmin),
      isGlobalSuperadmin: Boolean(u.isHiddenSuperadmin),
      status: u.status,
      createdAt: u.createdAt,
      ...(u.mustChangePassword ? { mustChangePassword: true } : {}),
    };
  }

  // ---- Companies (superadmin) ------------------------------------------------

  /** 14 chars, no ambiguous characters (0/O, 1/l/I), always with letters and digits: meets the password policy. */
  private generateTemporaryPassword(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const all = letters + digits;
    for (;;) {
      let out = '';
      for (let i = 0; i < 14; i++) out += all[crypto.randomInt(all.length)];
      if (/[A-Za-z]/.test(out) && /\d/.test(out)) return out;
    }
  }

  private tenantIdFor(name: string): string {
    const base = `ten-${fileSlug(name).slice(0, 40)}`;
    let id = base;
    for (let n = 2; this.state.tenants.some((t) => t.id === id); n++) id = `${base}-${n}`;
    return id;
  }

  private findTenantByTaxId(taxId: string, exceptId?: string): Tenant | undefined {
    const key = taxIdKey(taxId);
    return this.state.tenants.find((t) => t.id !== exceptId && taxIdKey(t.taxId) === key);
  }

  private usernameTaken(username: string): boolean {
    const u = username.trim().toLowerCase();
    return this.state.users.some((x) => x.username.toLowerCase() === u);
  }

  /** Live availability for the wizard (no side effects). */
  checkTenantAvailability(q: { cuit?: string; username?: string; name?: string; exceptTenantId?: string }) {
    const result: { cuit?: 'ok' | 'invalido' | 'en_uso'; username?: 'ok' | 'invalido' | 'en_uso'; name?: 'ok' | 'en_uso'; cuitMessage?: string } = {};
    if (q.cuit !== undefined) {
      const problem = cuitProblem(q.cuit);
      if (problem) {
        result.cuit = 'invalido';
        result.cuitMessage = CUIT_MESSAGES[problem];
      } else {
        result.cuit = this.findTenantByTaxId(q.cuit, q.exceptTenantId) ? 'en_uso' : 'ok';
      }
    }
    if (q.username !== undefined) {
      result.username = !/^[a-z0-9._-]{3,40}$/.test(q.username.trim().toLowerCase())
        ? 'invalido'
        : this.usernameTaken(q.username)
          ? 'en_uso'
          : 'ok';
    }
    if (q.name !== undefined) {
      const n = q.name.trim().toLowerCase();
      result.name = this.state.tenants.some((t) => t.id !== q.exceptTenantId && t.name.trim().toLowerCase() === n) ? 'en_uso' : 'ok';
    }
    return result;
  }

  listTenantSummaries(): TenantSummary[] {
    return this.state.tenants.map((t) => {
      const admin = this.state.users.find((u) => u.tenantId === t.id && u.roleId === `rol-${t.id}-admin`);
      return {
        ...t,
        vehicleCount: this.state.vehicles.filter((v) => v.tenantId === t.id).length,
        userCount: this.state.users.filter((u) => u.tenantId === t.id).length,
        adminUsername: admin?.username ?? null,
        adminName: admin?.name ?? null,
      };
    });
  }

  /**
   * Wizard: company + its 3 base roles + an admin with full access to every module
   * (temporary password, must be changed on first login) + optional starter templates.
   * Everything is validated before anything is created.
   */
  async createTenantWithAdmin(
    input: {
      company: { name: string; cuit: string; city: string; branches: string[]; contactName: string; contactEmail: string; contactPhone: string };
      service: {
        status: 'activo' | 'piloto';
        planTier: string;
        vehicleQuota: number;
        retentionDays: number;
        currency?: string | null;
        referenceCurrency?: string;
      };
      admin: { name: string; username: string };
      templates: { preventivePlans: boolean; alertRules: boolean };
    },
    actorName: string
  ): Promise<{ tenant: Tenant; admin: PublicUser; temporaryPassword: string }> {
    const problem = cuitProblem(input.company.cuit);
    if (problem) throw new DomainError(CUIT_MESSAGES[problem]);
    if (this.findTenantByTaxId(input.company.cuit)) throw new DomainError('Ya existe una empresa registrada con ese CUIT.');
    const availability = this.checkTenantAvailability({ name: input.company.name, username: input.admin.username });
    if (availability.name === 'en_uso') throw new DomainError('Ya existe una empresa con ese nombre.');
    if (availability.username === 'invalido') throw new DomainError('El usuario solo puede tener minúsculas, números, punto, guion o guion bajo (3 a 40).');
    if (availability.username === 'en_uso') throw new DomainError('Ese nombre de usuario ya está en uso.');

    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    // Re-check after the async hash: another request may have taken the CUIT or username meanwhile.
    if (this.findTenantByTaxId(input.company.cuit)) throw new DomainError('Ya existe una empresa registrada con ese CUIT.');
    if (this.usernameTaken(input.admin.username)) throw new DomainError('Ese nombre de usuario ya está en uso.');

    for (const code of [input.service.currency, input.service.referenceCurrency]) {
      if (code && !this.currency.find(code)?.enabled) throw new DomainError(`La moneda ${code} no existe o no está habilitada.`);
    }
    const now = new Date().toISOString();
    const id = this.tenantIdFor(input.company.name);
    const tenant: Tenant = {
      id,
      name: input.company.name.trim(),
      taxId: formatCuit(input.company.cuit),
      city: input.company.city.trim(),
      branches: input.company.branches.map((b) => b.trim()),
      vehicleQuota: input.service.vehicleQuota,
      retentionDays: input.service.retentionDays,
      planTier: input.service.planTier,
      status: input.service.status,
      contactName: input.company.contactName.trim(),
      contactEmail: input.company.contactEmail.trim().toLowerCase(),
      contactPhone: input.company.contactPhone.trim(),
      createdAt: now,
      currency: input.service.currency ?? null,
      referenceCurrency: input.service.referenceCurrency ?? 'USD',
    };
    const roles = buildTenantBaseRoles(id);
    const adminRole = roles.find((r) => r.isSystemAdminRole)!;
    const admin: UserAccount = {
      id: `usr-${uid()}`,
      tenantId: id,
      name: input.admin.name.trim(),
      username: input.admin.username.trim().toLowerCase(),
      passwordHash,
      roleId: adminRole.id,
      isCompanyAdmin: true,
      isHiddenSuperadmin: false,
      status: 'activo',
      createdAt: now,
      failedAttempts: 0,
      lockedUntil: null,
      mustChangePassword: true,
    };

    this.state.tenants.push(tenant);
    this.state.roles.push(...roles);
    this.state.users.push(admin);
    const created: string[] = ['3 perfiles base', `usuario admin ${admin.username}`];
    if (input.templates.preventivePlans) {
      const plans = buildDefaultPreventivePlans(id, () => now);
      this.state.preventivePlans.push(...plans);
      created.push(`${plans.length} planes preventivos`);
    }
    if (input.templates.alertRules) {
      const rules = buildDefaultAlertRules(id);
      this.state.alertRules.push(...rules);
      created.push(`${rules.length} reglas de alerta`);
    }
    for (const auditTenant of [GLOBAL_AUDIT_TENANT, id]) {
      this.addAuditLog({
        tenantId: auditTenant,
        actorName,
        actorRole: SUPERADMIN_ROLE.name,
        actorHidden: auditTenant === GLOBAL_AUDIT_TENANT,
        module: 'Empresas',
        action: 'Alta de empresa',
        targetLabel: `${tenant.name} (${tenant.taxId})`,
        detail: `Plan ${tenant.planTier} · cupo ${tenant.vehicleQuota} unidades · ${created.join(' · ')}.`,
      });
    }
    this.persist(this.state);
    return { tenant, admin: this.toPublicUser(admin), temporaryPassword };
  }

  async updateTenant(
    tenantId: string,
    patch: Partial<{
      name: string;
      cuit: string;
      city: string;
      branches: string[];
      contactName: string;
      contactEmail: string;
      contactPhone: string;
      status: TenantStatus;
      planTier: string;
      vehicleQuota: number;
      retentionDays: number;
      referenceCurrency: string;
    }>,
    actorName: string
  ): Promise<TenantSummary> {
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new DomainError('La empresa no existe.');

    // Validate everything first
    if (patch.cuit !== undefined && taxIdKey(patch.cuit) !== taxIdKey(tenant.taxId)) {
      const problem = cuitProblem(patch.cuit);
      if (problem) throw new DomainError(CUIT_MESSAGES[problem]);
      if (this.findTenantByTaxId(patch.cuit, tenantId)) throw new DomainError('Ya existe una empresa registrada con ese CUIT.');
    }
    if (patch.name !== undefined && this.checkTenantAvailability({ name: patch.name, exceptTenantId: tenantId }).name === 'en_uso') {
      throw new DomainError('Ya existe una empresa con ese nombre.');
    }
    const vehicleCount = this.state.vehicles.filter((v) => v.tenantId === tenantId).length;
    if (patch.vehicleQuota !== undefined && patch.vehicleQuota < vehicleCount) {
      throw new DomainError(`El cupo no puede ser menor que las ${vehicleCount} unidades ya registradas.`);
    }

    const changes: string[] = [];
    const set = <K extends keyof Tenant>(key: K, value: Tenant[K] | undefined, label: string) => {
      if (value === undefined || JSON.stringify(tenant[key]) === JSON.stringify(value)) return;
      tenant[key] = value;
      changes.push(label);
    };
    set('name', patch.name?.trim(), 'nombre');
    if (patch.cuit !== undefined && taxIdKey(patch.cuit) !== taxIdKey(tenant.taxId)) set('taxId', formatCuit(patch.cuit), 'CUIT');
    set('city', patch.city?.trim(), 'ciudad');
    set('branches', patch.branches?.map((b) => b.trim()), 'sucursales');
    set('contactName', patch.contactName?.trim(), 'contacto');
    set('contactEmail', patch.contactEmail?.trim().toLowerCase(), 'email de contacto');
    set('contactPhone', patch.contactPhone?.trim(), 'teléfono de contacto');
    set('planTier', patch.planTier, 'plan');
    set('vehicleQuota', patch.vehicleQuota, 'cupo');
    set('retentionDays', patch.retentionDays, 'retención de video');
    if (patch.referenceCurrency !== undefined && patch.referenceCurrency !== tenant.referenceCurrency) {
      if (!this.currency.find(patch.referenceCurrency)?.enabled) throw new DomainError('La moneda de referencia no está habilitada.');
      set('referenceCurrency', patch.referenceCurrency, 'moneda de referencia');
    }
    const previousStatus = tenant.status;
    set('status', patch.status, 'estado');

    if (changes.length === 0) return this.listTenantSummaries().find((t) => t.id === tenantId)!;

    const suspended = previousStatus !== 'suspendido' && tenant.status === 'suspendido';
    const reactivated = previousStatus === 'suspendido' && tenant.status !== 'suspendido';
    for (const auditTenant of [GLOBAL_AUDIT_TENANT, tenantId]) {
      this.addAuditLog({
        tenantId: auditTenant,
        actorName,
        actorRole: SUPERADMIN_ROLE.name,
        actorHidden: auditTenant === GLOBAL_AUDIT_TENANT,
        module: 'Empresas',
        action: suspended ? 'Suspensión de empresa' : reactivated ? 'Reactivación de empresa' : 'Edición de empresa',
        targetLabel: tenant.name,
        detail: `Cambios: ${changes.join(', ')}.`,
      });
    }
    this.persist(this.state);
    if (suspended) {
      for (const u of this.state.users.filter((x) => x.tenantId === tenantId)) await this.revokeUserSessions(u.id);
    }
    return this.listTenantSummaries().find((t) => t.id === tenantId)!;
  }

  async resetTenantAdminPassword(tenantId: string, actorName: string): Promise<{ username: string; temporaryPassword: string }> {
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new DomainError('La empresa no existe.');
    const admin = this.state.users.find((u) => u.tenantId === tenantId && u.roleId === `rol-${tenantId}-admin`);
    if (!admin) throw new DomainError('La empresa no tiene un usuario administrador.');
    const temporaryPassword = this.generateTemporaryPassword();
    admin.passwordHash = await hashPassword(temporaryPassword);
    admin.mustChangePassword = true;
    admin.failedAttempts = 0;
    admin.lockedUntil = null;
    admin.status = 'activo';
    for (const auditTenant of [GLOBAL_AUDIT_TENANT, tenantId]) {
      this.addAuditLog({
        tenantId: auditTenant,
        actorName,
        actorRole: SUPERADMIN_ROLE.name,
        actorHidden: auditTenant === GLOBAL_AUDIT_TENANT,
        module: 'Empresas',
        action: 'Restablecimiento de contraseña del admin',
        targetLabel: `${tenant.name} · ${admin.username}`,
        detail: 'Contraseña temporal generada; deberá cambiarse en el primer ingreso. Sesiones cerradas.',
      });
    }
    this.persist(this.state);
    await this.revokeUserSessions(admin.id);
    return { username: admin.username, temporaryPassword };
  }

  getTenantById(tenantId: string): Tenant | undefined {
    return this.state.tenants.find((t) => t.id === tenantId);
  }

  async authenticate(
    username: string,
    password: string,
    meta: SessionMeta = {}
  ): Promise<
    | { ok: true; token: string; tenant: Tenant; user: PublicUser; role: RoleDefinition }
    | { ok: false; error: string; status: number }
  > {
    const invalid = { ok: false as const, error: 'Credenciales inválidas o cuenta inactiva.', status: 401 };
    const normalized = username.trim().toLowerCase();
    const account = this.state.users.find((u) => u.username.toLowerCase() === normalized);

    if (!account) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return invalid;
    }
    if (account.lockedUntil && Date.parse(account.lockedUntil) > Date.now()) {
      return {
        ok: false,
        status: 423,
        error: 'Cuenta bloqueada temporalmente por intentos fallidos. Intenta de nuevo en 15 minutos.',
      };
    }

    const valid = await verifyPassword(password, account.passwordHash);
    if (!valid) {
      account.failedAttempts = (account.failedAttempts ?? 0) + 1;
      if (account.failedAttempts >= MAX_FAILED_LOGINS) {
        account.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        account.failedAttempts = 0;
        this.addAuditLog({
          tenantId: account.tenantId,
          actorName: 'Sistema',
          actorRole: 'Seguridad',
          actorHidden: Boolean(account.isHiddenSuperadmin),
          module: 'Seguridad y Usuarios',
          action: 'Bloqueo por intentos fallidos',
          targetLabel: account.username,
          detail: `Cuenta bloqueada ${LOCKOUT_MS / 60_000} minutos tras ${MAX_FAILED_LOGINS} intentos fallidos.`,
        });
      }
      this.persist(this.state);
      return invalid;
    }
    if (account.status !== 'activo') return invalid;
    if (!account.isHiddenSuperadmin && this.state.tenants.find((t) => t.id === account.tenantId)?.status === 'suspendido') {
      return {
        ok: false,
        status: 423,
        error: 'La empresa está suspendida. Contacta al administrador de la plataforma.',
      };
    }

    const isSuperadmin = Boolean(account.isHiddenSuperadmin);
    const tenant = isSuperadmin
      ? this.buildGlobalTenantSummary()
      : this.state.tenants.find((t) => t.id === account.tenantId);
    const role = isSuperadmin
      ? SUPERADMIN_ROLE
      : this.state.roles.find((r) => r.id === account.roleId && r.tenantId === account.tenantId);
    if (!tenant || !role) return invalid;

    if (account.failedAttempts || account.lockedUntil) {
      account.failedAttempts = 0;
      account.lockedUntil = null;
      this.persist(this.state);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session: ActiveSession = {
      tokenHash: hashToken(token),
      userId: account.id,
      tenantId: isSuperadmin ? 'all' : account.tenantId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_MAX_MS,
    };
    await this.repo.saveSession(session, meta);
    this.sessions.set(session.tokenHash, session);
    this.sessionTouchPersistedAt.set(session.tokenHash, now);

    return { ok: true, token, tenant, user: this.toPublicUser(account), role };
  }

  resolveSession(token: string | undefined): { session: ActiveSession; user: UserAccount; role: RoleDefinition; tenant: Tenant } | null {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return null;

    const now = Date.now();
    if (now >= session.expiresAt || now - session.lastSeenAt > SESSION_IDLE_MS) {
      void this.revokeSessionByHash(tokenHash);
      return null;
    }
    session.lastSeenAt = now;
    if (now - (this.sessionTouchPersistedAt.get(tokenHash) ?? 0) > SESSION_TOUCH_PERSIST_MS) {
      this.sessionTouchPersistedAt.set(tokenHash, now);
      this.repo.touchSession(tokenHash, now).catch((err) => console.error('[db] touchSession:', err));
    }

    const user = this.state.users.find((u) => u.id === session.userId && u.status === 'activo');
    if (!user) return null;

    if (user.isHiddenSuperadmin) {
      return {
        session,
        user,
        role: SUPERADMIN_ROLE,
        tenant: this.buildGlobalTenantSummary(),
      };
    }

    const tenant = this.state.tenants.find((t) => t.id === session.tenantId);
    const role = this.state.roles.find((r) => r.id === user.roleId && r.tenantId === session.tenantId);
    if (!tenant || !role || tenant.status === 'suspendido') return null;
    return { session, user, role, tenant };
  }

  async revokeSession(token: string): Promise<void> {
    await this.revokeSessionByHash(hashToken(token));
  }

  private async revokeSessionByHash(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
    this.sessionTouchPersistedAt.delete(tokenHash);
    await this.repo.deleteSession(tokenHash).catch((err) => console.error('[db] deleteSession:', err));
  }

  /** Revoke every session of a user (password change, deactivation), optionally keeping one. */
  private async revokeUserSessions(userId: string, keepTokenHash?: string): Promise<void> {
    for (const [hash, s] of [...this.sessions]) {
      if (s.userId === userId && hash !== keepTokenHash) await this.revokeSessionByHash(hash);
    }
  }

  async changeOwnPassword(
    userId: string,
    currentTokenHash: string,
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    const user = this.state.users.find((u) => u.id === userId && u.status === 'activo');
    if (!user) return { ok: false, error: 'Usuario no disponible.', status: 404 };
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return { ok: false, error: 'La contraseña actual no es correcta.', status: 400 };
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) return { ok: false, error: policyError, status: 400 };

    if (newPassword === currentPassword) {
      return { ok: false, error: 'La contraseña nueva debe ser distinta de la actual.', status: 400 };
    }
    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    this.addAuditLog({
      tenantId: user.tenantId,
      actorName: user.name,
      actorRole: this.toPublicUser(user).roleName,
      actorHidden: Boolean(user.isHiddenSuperadmin),
      module: 'Seguridad y Usuarios',
      action: 'Cambio de contraseña',
      targetLabel: user.username,
      detail: 'El usuario cambió su contraseña. Se cerraron sus otras sesiones.',
    });
    this.persist(this.state);
    await this.revokeUserSessions(user.id, currentTokenHash);
    return { ok: true };
  }

  getTenantBootstrap(tenantId: string, currentUserId: string, scopeTenantId?: string): TenantBootstrapResponse | null {
    const currentAccount = this.state.users.find((u) => u.id === currentUserId && u.status === 'activo');
    if (!currentAccount) return null;

    if (currentAccount.isHiddenSuperadmin) {
      const validScope =
        scopeTenantId && scopeTenantId !== 'all' && this.state.tenants.some((t) => t.id === scopeTenantId)
          ? scopeTenantId
          : 'all';
      const activeTenant =
        validScope === 'all'
          ? this.buildGlobalTenantSummary()
          : this.state.tenants.find((t) => t.id === validScope)!;

      const byScope = <T extends { tenantId: string }>(items: T[]): T[] =>
        validScope === 'all' ? items : items.filter((item) => item.tenantId === validScope);

      const scopedRoles = byScope(this.state.roles).filter((r) => r.id !== 'super_admin_internal');
      const scopedUsers = byScope(this.state.users)
        .filter((u) => !u.isHiddenSuperadmin && u.roleId !== 'super_admin_internal')
        .map((u) => this.toPublicUser(u));
      const scopedVehicles = byScope(this.state.vehicles);

      return {
        deviceConnection: this.getDeviceConnectionSettings(),
        currencies: this.currency.list(),
        exchangeRates: this.currency.ratesForClient(),
        platformReferenceCurrency: this.currency.platformReferenceCurrency,
        unmatchedDevices: [...this.unmatchedDevices.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
        tenant: activeTenant,
        availableTenants: this.state.tenants,
        activeScopeTenantId: validScope,
        currentUser: this.toPublicUser(currentAccount),
        currentRole: SUPERADMIN_ROLE,
        users: scopedUsers,
        roles: scopedRoles,
        drivers: byScope(this.state.drivers),
        vehicles: scopedVehicles,
        devices: byScope(this.state.devices),
        maintenanceRecords: byScope(this.state.maintenanceRecords),
        workOrders: sortWorkOrdersList(byScope(this.state.workOrders), scopedVehicles),
        preventivePlans: byScope(this.state.preventivePlans),
        partsInventory: byScope(this.state.partsInventory),
        checklists: byScope(this.state.checklists),
        dashcamDrivers: this.state.dashcamDrivers,
        maintenanceDashboard: this.getMaintenanceDashboardMetrics(tenantId, validScope),
        alertRules: byScope(this.state.alertRules),
        alerts: byScope(this.state.alerts),
        incidents: byScope(this.state.incidents),
        videoClips: byScope(this.state.videoClips),
        auditLogs: byScope(this.state.auditLogs),
        sizing: {
          ...this.state.sizing,
          vehiclesCount: scopedVehicles.length,
        },
      };
    }

    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant || currentAccount.tenantId !== tenantId) return null;

    const tenantRoles = this.state.roles.filter((r) => r.tenantId === tenantId && r.id !== 'super_admin_internal');
    const currentRole = tenantRoles.find((r) => r.id === currentAccount.roleId) ?? tenantRoles[0];

    // CRITICAL: Explicitly exclude any hidden superadmin user from ALL returned lists
    const publicUsers = this.state.users
      .filter((u) => u.tenantId === tenantId && !u.isHiddenSuperadmin && u.roleId !== 'super_admin_internal')
      .map((u) => this.toPublicUser(u));

    const tenantVehicles = this.state.vehicles.filter((v) => v.tenantId === tenantId);

    return {
      deviceConnection: this.getDeviceConnectionSettings(),
      currencies: this.currency.list().filter((c) => c.enabled),
      exchangeRates: this.currency.ratesForClient(),
      tenant,
      currentUser: this.toPublicUser(currentAccount),
      currentRole,
      users: publicUsers,
      roles: tenantRoles,
      drivers: this.state.drivers
        .filter((d) => d.tenantId === tenantId)
        .map((d) => (currentRole?.isSystemAdminRole ? d : DriverRegistry.redact(d))),
      vehicles: tenantVehicles,
      devices: this.state.devices.filter((d) => d.tenantId === tenantId),
      maintenanceRecords: this.state.maintenanceRecords.filter((m) => m.tenantId === tenantId),
      workOrders: sortWorkOrdersList(
        this.state.workOrders.filter((w) => w.tenantId === tenantId),
        tenantVehicles
      ),
      preventivePlans: this.state.preventivePlans.filter((p) => p.tenantId === tenantId),
      partsInventory: this.state.partsInventory.filter((p) => p.tenantId === tenantId),
      checklists: this.state.checklists.filter((c) => c.tenantId === tenantId),
      dashcamDrivers: this.state.dashcamDrivers,
      maintenanceDashboard: this.getMaintenanceDashboardMetrics(tenantId),
      alertRules: this.state.alertRules.filter((r) => r.tenantId === tenantId),
      alerts: this.state.alerts.filter((a) => a.tenantId === tenantId),
      incidents: this.state.incidents.filter((i) => i.tenantId === tenantId),
      videoClips: this.state.videoClips.filter((c) => c.tenantId === tenantId),
      auditLogs: this.state.auditLogs.filter((l) => l.tenantId === tenantId && !l.actorHidden),
      sizing: {
        ...this.state.sizing,
        vehiclesCount: tenantVehicles.length,
      },
    };
  }

  getMaintenanceDashboardMetrics(tenantId: string, scopeTenantId?: string): MaintenanceDashboardMetrics {
    const targetScope = scopeTenantId ?? tenantId;
    const isAll = targetScope === 'all';
    const vehicles = isAll
      ? this.state.vehicles
      : this.state.vehicles.filter((v) => v.tenantId === targetScope);
    const workOrders = isAll
      ? this.state.workOrders
      : this.state.workOrders.filter((w) => w.tenantId === targetScope);

    const now = new Date();
    const monthBuckets: MonthlyCostBucket[] = [];
    const monthMap = new Map<string, MonthlyCostBucket>();

    for (let offset = 5; offset >= 0; offset--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('es-MX', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      const bucket: MonthlyCostBucket = {
        monthKey: key,
        monthLabel: label,
        refacciones: 0,
        insumos: 0,
        manoObra: 0,
        total: 0,
        ordersCount: 0,
      };
      monthBuckets.push(bucket);
      monthMap.set(key, bucket);
    }

    // Consolidated view (all companies): every amount converted to the platform reference
    // currency with the rate of the order's date. Orders that can't be converted are left out
    // (and counted) instead of mixing currencies.
    const reference = this.currency.platformReferenceCurrency;
    let excludedOrders = 0;
    for (const wo of workOrders) {
      if (wo.status === 'cancelada') continue;
      const dateIso = wo.completedAt || wo.createdAt || wo.scheduledDate;
      const monthKey = dateIso.slice(0, 7);
      const bucket = monthMap.get(monthKey);
      if (!bucket) continue;
      let factor = 1;
      if (isAll) {
        const one = this.currency.convertTenantAmount(wo.tenantId, 1, reference, dateIso.length === 10 ? `${dateIso}T23:59:59Z` : dateIso);
        if (one === null) {
          excludedOrders++;
          continue;
        }
        factor = one;
      }
      let refacc = 0;
      let ins = 0;
      let extraLabor = 0;
      for (const p of wo.parts) {
        if (p.category === 'refaccion') refacc += p.subtotal * factor;
        else if (p.category === 'insumo') ins += p.subtotal * factor;
        else extraLabor += p.subtotal * factor;
      }
      const labor = wo.laborCost * factor + extraLabor;
      bucket.refacciones = Math.round(bucket.refacciones + refacc);
      bucket.insumos = Math.round(bucket.insumos + ins);
      bucket.manoObra = Math.round(bucket.manoObra + labor);
      bucket.total = Math.round(bucket.refacciones + bucket.insumos + bucket.manoObra);
      bucket.ordersCount += 1;
    }

    const corridorMap = new Map<
      string,
      {
        geofenceName: string;
        branch: string;
        unitsCount: number;
        insideCorridorCount: number;
        outsideCorridorCount: number;
        distSum: number;
        hoursSum: number;
        odoSum: number;
        overdueCount: number;
        faultUnitsCount: number;
      }
    >();

    let totalFleetOdometerKm = 0;
    let totalFleetEngineHours = 0;
    let unitsInsideCorridor = 0;
    let unitsOutsideCorridor = 0;
    let totalDistKm = 0;
    let overdueUnitsCount = 0;
    let criticalFaultUnitsCount = 0;

    for (const v of vehicles) {
      totalFleetOdometerKm += v.odometerKm;
      totalFleetEngineHours += v.engineHours;
      if (v.maintenanceStatus === 'vencido') overdueUnitsCount += 1;
      if (v.faultCodes.length > 0) criticalFaultUnitsCount += 1;

      const corridor =
        CORRIDORS.find((c) => c.branch === v.branch || c.geofence === v.geofenceName) ?? CORRIDORS[0];
      const distKm = haversineKm(v.lat, v.lng, corridor.lat, corridor.lng);
      const inside = distKm <= 25;
      totalDistKm += distKm;
      if (inside) unitsInsideCorridor += 1;
      else unitsOutsideCorridor += 1;

      const key = `${corridor.geofence}|${corridor.branch}`;
      let entry = corridorMap.get(key);
      if (!entry) {
        entry = {
          geofenceName: corridor.geofence,
          branch: corridor.branch,
          unitsCount: 0,
          insideCorridorCount: 0,
          outsideCorridorCount: 0,
          distSum: 0,
          hoursSum: 0,
          odoSum: 0,
          overdueCount: 0,
          faultUnitsCount: 0,
        };
        corridorMap.set(key, entry);
      }
      entry.unitsCount += 1;
      if (inside) entry.insideCorridorCount += 1;
      else entry.outsideCorridorCount += 1;
      entry.distSum += distKm;
      entry.hoursSum += v.engineHours;
      entry.odoSum += v.odometerKm;
      if (v.maintenanceStatus === 'vencido') entry.overdueCount += 1;
      if (v.faultCodes.length > 0) entry.faultUnitsCount += 1;
    }

    const corridorMetrics: PostGisCorridorMetric[] = Array.from(corridorMap.values()).map((c) => ({
      geofenceName: c.geofenceName,
      branch: c.branch,
      unitsCount: c.unitsCount,
      insideCorridorCount: c.insideCorridorCount,
      outsideCorridorCount: c.outsideCorridorCount,
      avgDistanceToHubKm: c.unitsCount > 0 ? Number((c.distSum / c.unitsCount).toFixed(1)) : 0,
      avgEngineHours: c.unitsCount > 0 ? Number((c.hoursSum / c.unitsCount).toFixed(1)) : 0,
      totalOdometerKm: Math.round(c.odoSum),
      overdueCount: c.overdueCount,
      faultUnitsCount: c.faultUnitsCount,
    }));

    const upcomingOrdersCount = workOrders.filter(
      (w) => w.status === 'abierta' || w.status === 'en_taller' || w.status === 'esperando_refacciones'
    ).length;
    const autoGeneratedOrdersCount = workOrders.filter(
      (w) => w.autoGenerated && w.status !== 'completada' && w.status !== 'cancelada'
    ).length;
    const inventoryList = isAll
      ? this.state.partsInventory
      : this.state.partsInventory.filter((p) => p.tenantId === targetScope);
    const lowStockPartsCount = inventoryList.filter((p) => p.stockQty <= p.minStock).length;
    const currentBucket = monthBuckets[monthBuckets.length - 1];

    return {
      generatedAt: now.toISOString(),
      engine: 'PostgreSQL 16 + PostGIS 3.4 (ST_DWithin 25 km)',
      upcomingOrdersCount,
      overdueUnitsCount,
      criticalFaultUnitsCount,
      lowStockPartsCount,
      autoGeneratedOrdersCount,
      currentMonthTotal: currentBucket?.total ?? 0,
      currency: isAll ? reference : this.currency.tenantCurrency(targetScope),
      consolidated: isAll,
      excludedOrders,
      totalFleetOdometerKm: Math.round(totalFleetOdometerKm),
      totalFleetEngineHours: Number(totalFleetEngineHours.toFixed(1)),
      unitsInsideCorridor,
      unitsOutsideCorridor,
      avgDistanceToHubKm: vehicles.length > 0 ? Number((totalDistKm / vehicles.length).toFixed(1)) : 0,
      monthlyCosts: monthBuckets,
      corridorMetrics,
    };
  }

  getPublicUsersForTenant(tenantId: string): PublicUser[] {
    return this.state.users
      .filter((u) => u.tenantId === tenantId && !u.isHiddenSuperadmin && u.roleId !== 'super_admin_internal')
      .map((u) => this.toPublicUser(u));
  }

  /** Amount of a company formatted in its currency (audit texts). */
  private money(tenantId: string, amount: number): string {
    const code = this.currency.tenantCurrency(tenantId);
    return formatMoney(amount, this.currency.find(code) ?? code, { withCode: true });
  }

  addAuditLog(entry: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const log: AuditLog = {
      ...entry,
      id: `aud-${uid()}`,
      timestamp: new Date().toISOString(),
    };
    this.state.auditLogs.unshift(log);
    if (this.state.auditLogs.length > 160) {
      this.state.auditLogs = this.state.auditLogs.slice(0, 160);
    }
    this.persist(this.state);
    return log;
  }

  createRole(
    tenantId: string,
    input: { name: string; description: string; permissions: ModulePermissions },
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): RoleDefinition {
    const resolvedTenantId = this.requireTenant(tenantId);
    const normalizedPermissions: ModulePermissions = {
      ...input.permissions,
      dashcams_config: input.permissions.dashcams_config ?? 'none',
    };
    const role: RoleDefinition = {
      id: `rol-${resolvedTenantId}-${uid()}`,
      tenantId: resolvedTenantId,
      name: input.name.trim(),
      description: input.description.trim() || 'Perfil operativo personalizado de empresa.',
      isSystemAdminRole: false,
      permissions: normalizedPermissions,
    };
    this.state.roles.push(role);
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Seguridad y Perfiles',
      action: 'Creación de perfil',
      targetLabel: role.name,
      detail: `Nuevo perfil personalizado creado para la empresa.`,
    });
    this.persist(this.state);
    return role;
  }

  updateRole(
    tenantId: string,
    roleId: string,
    patch: { name?: string; description?: string; permissions?: Partial<ModulePermissions> },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): RoleDefinition | null {
    const role = this.state.roles.find(
      (r) => r.id === roleId && (allowAllTenants || r.tenantId === tenantId)
    );
    if (!role || role.isSystemAdminRole) return null;
    if (patch.name) role.name = patch.name.trim();
    if (typeof patch.description === 'string') role.description = patch.description.trim();
    if (patch.permissions) {
      // Only known modules with a defined level; the request schema already rejects anything else.
      for (const [module, level] of Object.entries(patch.permissions)) {
        if (level && module in role.permissions) {
          role.permissions[module as keyof ModulePermissions] = level;
        }
      }
    }

    this.addAuditLog({
      tenantId: role.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Seguridad y Perfiles',
      action: 'Actualización de permisos',
      targetLabel: role.name,
      detail: 'Matriz de permisos por módulo actualizada.',
    });
    this.persist(this.state);
    return role;
  }

  async createUser(
    tenantId: string,
    input: { name: string; username: string; password: string; roleId: string },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Promise<{ user?: PublicUser; error?: string }> {
    const usernameLower = input.username.trim().toLowerCase().replace(/\s+/g, '.');
    if (!usernameLower) {
      return { error: 'El nombre de usuario es obligatorio.' };
    }
    const policyError = validatePasswordPolicy(input.password);
    if (policyError) {
      return { error: policyError };
    }
    if (this.state.users.some((u) => u.username.toLowerCase() === usernameLower)) {
      return { error: 'Ya existe un usuario registrado con ese nombre de usuario.' };
    }
    const role = this.state.roles.find(
      (r) =>
        r.id === input.roleId &&
        (allowAllTenants || r.tenantId === tenantId) &&
        r.id !== 'super_admin_internal'
    );
    if (!role) {
      return { error: 'El perfil seleccionado no pertenece a esta empresa.' };
    }

    const user: UserAccount = {
      id: `usr-${uid()}`,
      tenantId: role.tenantId,
      name: input.name.trim(),
      username: usernameLower,
      passwordHash: await hashPassword(input.password),
      roleId: role.id,
      isCompanyAdmin: Boolean(role.isSystemAdminRole),
      isHiddenSuperadmin: false,
      status: 'activo',
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockedUntil: null,
    };
    // Re-check after the async hash: another request may have taken the username meanwhile.
    if (this.state.users.some((u) => u.username.toLowerCase() === usernameLower)) {
      return { error: 'Ya existe un usuario registrado con ese nombre de usuario.' };
    }
    this.state.users.push(user);
    this.addAuditLog({
      tenantId: role.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Seguridad y Usuarios',
      action: 'Alta de usuario',
      targetLabel: `${user.name} (${user.username})`,
      detail: `Perfil asignado: ${role.name}.`,
    });
    this.persist(this.state);
    return { user: this.toPublicUser(user) };
  }

  async updateUser(
    tenantId: string,
    userId: string,
    patch: { roleId?: string; status?: 'activo' | 'inactivo'; password?: string },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Promise<PublicUser | { error: string } | null> {
    const user = this.state.users.find(
      (u) => u.id === userId && (allowAllTenants || u.tenantId === tenantId) && !u.isHiddenSuperadmin
    );
    if (!user) return null;

    let passwordReset = false;
    if (patch.password !== undefined && patch.password !== '') {
      const policyError = validatePasswordPolicy(patch.password);
      if (policyError) return { error: policyError };
      user.passwordHash = await hashPassword(patch.password);
      user.failedAttempts = 0;
      user.lockedUntil = null;
      passwordReset = true;
    }

    if (patch.roleId) {
      const role = this.state.roles.find(
        (r) => r.id === patch.roleId && r.tenantId === user.tenantId && r.id !== 'super_admin_internal'
      );
      if (role) {
        user.roleId = role.id;
        user.isCompanyAdmin = Boolean(role.isSystemAdminRole);
      }
    }
    if (patch.status) {
      user.status = patch.status;
    }

    this.addAuditLog({
      tenantId: user.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Seguridad y Usuarios',
      action: 'Actualización de usuario',
      targetLabel: user.username,
      detail:
        `Estado: ${user.status} · Perfil: ${this.toPublicUser(user).roleName}.` +
        (passwordReset ? ' Contraseña restablecida por administrador.' : ''),
    });
    this.persist(this.state);
    if (passwordReset || user.status !== 'activo') {
      await this.revokeUserSessions(user.id);
    }
    return this.toPublicUser(user);
  }

  createVehicle(
    tenantId: string,
    input: {
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
      imei: string;
      protocol: ProtocolType;
      /** obd = the tracker joins Telemetría OBD-II; smartphone = no hardware, the driver's phone reports. */
      connection?: UnitConnection;
      deviceModel: string;
      deviceCatalogId?: string;
      /** Registered driver to assign; must belong to the company and be authorized. */
      driverId?: string;
      engineHours?: number;
      odometerKm?: number;
    },
    actorName: string,
    actorRole: string
  ): { vehicle: Vehicle; device: Device | null } {
    const tenant = this.state.tenants.find((t) => t.id === this.requireTenant(tenantId))!;
    const connection: UnitConnection = input.connection ?? (input.protocol === 'Traccar' ? 'traccar' : 'dashcam');
    if (connection !== 'smartphone' && !/^\d{15}$/.test(input.imei)) {
      throw new DomainError('Ingresa el IMEI de 15 dígitos del equipo.');
    }
    if (connection === 'obd') {
      if (input.deviceCatalogId && findCatalogModel(input.deviceCatalogId)?.kind !== 'GPS + CAN') {
        throw new DomainError('Para Telemetría OBD-II elige un rastreador Teltonika (FMC003, FMC130 o FMC650).');
      }
      const clash = this.state.devices.find((d) => d.imei === input.imei || d.terminalId === input.imei);
      if (clash) throw new DomainError(`Ese IMEI ya está registrado en el equipo de la unidad ${clash.unitCode}.`);
    }
    const registered = this.state.vehicles.filter((v) => v.tenantId === tenant.id).length;
    if (registered >= tenant.vehicleQuota) {
      throw new DomainError(`Se alcanzó el cupo de ${tenant.vehicleQuota} unidades del plan de ${tenant.name}.`);
    }
    // Resolve the equipment before touching state, so a bad catalog id changes nothing.
    const catalogModel = input.deviceCatalogId ? findCatalogModel(input.deviceCatalogId) : undefined;
    if (input.deviceCatalogId && !catalogModel) {
      throw new DomainError('El modelo de equipo elegido no existe en el catálogo.');
    }
    if (catalogModel && catalogModel.protocol !== input.protocol) {
      throw new DomainError(`El equipo ${catalogModelLabel(catalogModel)} usa el protocolo ${catalogModel.protocol}, no ${input.protocol}.`);
    }
    const catalogDriver = catalogModel ? this.state.dashcamDrivers.find((d) => d.id === catalogModel.driverId) : undefined;
    const assignedDriver = input.driverId
      ? this.state.drivers.find((d) => d.id === input.driverId && d.tenantId === tenant.id)
      : undefined;
    if (input.driverId && !assignedDriver) throw new DomainError('El chofer elegido no pertenece a la empresa.');
    if (assignedDriver) {
      const auth = computeDriverAuthorization(assignedDriver);
      if (auth.state === 'no_autorizado' || auth.state === 'deshabilitado' || auth.state === 'pendiente') {
        throw new DomainError(`${assignedDriver.name} está «${AUTH_STATE_LABELS[auth.state]}» y no puede asignarse. ${auth.reasons[0] ?? ''}`.trim());
      }
    }
    const brand = input.brand?.trim() || undefined;
    const model = input.model?.trim() || undefined;
    const brandModel = brand || model ? composeBrandModel(brand ?? '', model ?? '') : input.brandModel;

    const corridor = CORRIDORS.find((c) => c.branch === input.branch) ?? CORRIDORS[0];
    const num = this.state.vehicles.length + 1;
    const vehicleId = `veh-${uid()}`;
    const deviceId = `dev-${uid()}`;
    const nowIso = new Date().toISOString();

    const engineHours = Number(input.engineHours ?? 120);
    const odometerKm = Number(input.odometerKm ?? 1200);


    const defaultPlan =
      this.state.preventivePlans.find(
        (p) => p.tenantId === tenant.id && p.active && (p.assetType === input.assetType || p.assetType === 'ambos')
      ) ?? this.state.preventivePlans.find((p) => p.tenantId === tenant.id && p.active);
    const intervalHours = defaultPlan?.intervalHours ?? 250;
    const intervalKm = defaultPlan?.intervalKm ?? 10000;

    const vehicle: Vehicle = {
      id: vehicleId,
      tenantId: tenant.id,
      branch: input.branch || tenant.branches[0],
      group: input.group || (input.assetType === 'maquinaria_pesada' ? 'Maquinaria Pesada' : 'Operación General'),
      assetType: input.assetType,
      unitCode: input.unitCode.toUpperCase(),
      plate: input.plate.toUpperCase(),
      brandModel,
      ...(brand ? { brand } : {}),
      ...(model ? { model } : {}),
      year: input.year || new Date().getFullYear(),
      driverId: assignedDriver?.id ?? '',
      driverName: assignedDriver?.name ?? 'Sin chofer asignado',
      deviceId,
      operationalStatus: 'detenido',
      ignition: false,
      speedKmh: 0,
      heading: 90,
      lat: Number((corridor.lat + seededOffset(num, UNIT_SPREAD / 2)).toFixed(5)),
      lng: Number((corridor.lng + seededOffset(num + 7, UNIT_SPREAD / 2)).toFixed(5)),
      odometerKm,
      engineHours,
      nextServiceHours: engineHours + intervalHours,
      nextServiceKm: odometerKm + intervalKm,
      nextServiceDate: computeServiceDateFromHours(engineHours, engineHours + intervalHours, 'al_dia'),
      serviceDatePinned: false,
      assignedPlanId: defaultPlan?.id,
      maintenanceStatus: 'al_dia',
      fuelLevelPct: 88,
      rpm: 0,
      coolantTempC: 34,
      faultCodes: [],
      lastReportAt: nowIso,
      geofenceName: corridor.geofence,
    };

    const devModel = catalogModel
      ? catalogModelLabel(catalogModel)
      : input.deviceModel?.trim() || (input.protocol === 'Traccar' ? 'Equipo Traccar' : 'Equipo JT/T 808 genérico');
    const matchedDriver = catalogDriver ?? matchDriverForModel(devModel, input.protocol, this.state.dashcamDrivers);
    const dashcamConfig = buildDefaultDashcamConfig(devModel, input.protocol, this.state.dashcamDrivers, actorName, matchedDriver);
    const device: Device = {
      id: deviceId,
      tenantId: tenant.id,
      vehicleId,
      unitCode: vehicle.unitCode,
      terminalId: this.state.devices.some((d) => d.terminalId === input.imei.slice(-12))
        ? input.imei
        : input.imei.slice(-12),
      uplink: catalogModel?.uplinks[0] ?? 'wifi_starlink',
      telemetrySource: 'simulada',
      imei: input.imei,
      iccid: `8952010099${Date.now().toString().slice(-8)}`,
      simCarrier: 'Telcel M2M IoT',
      model: devModel,
      ...(catalogModel ? { catalogModelId: catalogModel.id } : {}),
      protocol: input.protocol,
      firmware: matchedDriver.driverVersion,
      channels: dashcamConfig.activeChannels,
      linkStatus: 'conectado',
      hardwareValidated: true,
      lastHeartbeatAt: nowIso,
      dashcamConfig,
    };

    // One unit per driver: the driver leaves the unit they were driving.
    if (assignedDriver) {
      for (const other of this.state.vehicles) {
        if (other.driverId === assignedDriver.id) {
          other.driverId = '';
          other.driverName = 'Sin chofer asignado';
        }
      }
    }

    if (connection === 'smartphone' || connection === 'obd') {
      // No camera: either no hardware at all (the driver's phone reports) or an OBD-II tracker that the
      // Telemetría OBD-II module owns (it also serves as the unit's main device).
      vehicle.deviceId = '';
      if (connection === 'smartphone') {
        vehicle.positionSource = 'smartphone';
        vehicle.positionSourceLabel = assignedDriver ? `Celular de ${assignedDriver.name}` : 'Celular del chofer';
      }
      this.state.vehicles.unshift(vehicle);
      let obd: Device | null = null;
      if (connection === 'obd') {
        obd = this.assignObdDevice(tenant.id, vehicle.id, { imei: input.imei, catalogModelId: input.deviceCatalogId }, actorName, actorRole, true, actorRole === SUPERADMIN_ROLE.name);
        if (obd) vehicle.deviceId = obd.id;
      }
      const phoneNote = connection === 'smartphone'
        ? assignedDriver?.phoneTracker
          ? ` La posición la manda el celular de ${assignedDriver.name} (${assignedDriver.phoneTracker.identifier}).`
          : ' Falta conectar el celular del chofer en «Conexión Smartphone».'
        : '';
      this.addAuditLog({
        tenantId: tenant.id,
        actorName,
        actorRole,
        actorHidden: actorRole === SUPERADMIN_ROLE.name,
        module: 'Flotas y Maquinaria',
        action: 'Alta de activo y equipo',
        targetLabel: `${vehicle.unitCode} (${vehicle.plate})`,
        detail: `Registrado (${vehicle.assetType === 'maquinaria_pesada' ? 'Maquinaria Pesada' : 'Vehículo'}) con ${
          connection === 'obd' ? `Telemetría OBD-II (${obd?.model ?? 'Teltonika'} · IMEI ${input.imei})` : 'Conexión Smartphone (sin equipo instalado)'
        }.${phoneNote}`,
      });
      this.persist(this.state);
      return { vehicle, device: obd };
    }

    this.state.vehicles.unshift(vehicle);
    this.state.devices.unshift(device);

    this.addAuditLog({
      tenantId: tenant.id,
      actorName,
      actorRole,
      actorHidden: actorRole === SUPERADMIN_ROLE.name,
      module: 'Flotas y Maquinaria',
      action: 'Alta de activo y equipo',
      targetLabel: `${vehicle.unitCode} (${vehicle.plate})`,
      detail: `Registrado (${vehicle.assetType === 'maquinaria_pesada' ? 'Maquinaria Pesada' : 'Vehículo'}) con ${device.protocol}.`,
    });

    this.persist(this.state);
    return { vehicle, device };
  }

  addMaintenanceRecord(
    tenantId: string,
    vehicleId: string,
    input: {
      type: MaintenanceRecord['type'];
      title: string;
      workshopOrTech: string;
      cost: number;
      notes: string;
      nextServiceDate?: string;
      clearFaults?: boolean;
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { record: MaintenanceRecord; vehicle: Vehicle } | null {
    const vehicle = this.state.vehicles.find(
      (v) => v.id === vehicleId && (allowAllTenants || v.tenantId === tenantId)
    );
    if (!vehicle) return null;

    const linkedPlan = vehicle.assignedPlanId
      ? this.state.preventivePlans.find((p) => p.id === vehicle.assignedPlanId)
      : this.state.preventivePlans.find(
          (p) => p.tenantId === vehicle.tenantId && p.active && (p.assetType === vehicle.assetType || p.assetType === 'ambos')
        );
    const intervalHours = linkedPlan?.intervalHours ?? 250;
    const intervalKm = linkedPlan?.intervalKm ?? 10000;
    const targetHours = Number((vehicle.engineHours + intervalHours).toFixed(1));
    const hasCustomDate = Boolean(input.nextServiceDate && /^\d{4}-\d{2}-\d{2}$/.test(input.nextServiceDate));
    const resolvedDate = hasCustomDate
      ? input.nextServiceDate!
      : computeServiceDateFromHours(vehicle.engineHours, targetHours, 'al_dia');

    const record: MaintenanceRecord = {
      id: `mnt-${uid()}`,
      tenantId: vehicle.tenantId,
      vehicleId: vehicle.id,
      unitCode: vehicle.unitCode,
      type: input.type,
      title: input.title.trim(),
      performedAt: new Date().toISOString(),
      engineHoursAtService: vehicle.engineHours,
      odometerAtService: vehicle.odometerKm,
      nextServiceDate: resolvedDate,
      workshopOrTech: input.workshopOrTech.trim() || 'Taller Interno',
      cost: Number(input.cost || 0),
      notes: input.notes.trim(),
      status: 'completado',
    };

    const todayStr = new Date().toISOString().slice(0, 10);
    vehicle.nextServiceHours = targetHours;
    vehicle.nextServiceKm = Math.round(vehicle.odometerKm + intervalKm);
    vehicle.nextServiceDate = resolvedDate;
    vehicle.serviceDatePinned = hasCustomDate;
    vehicle.maintenanceStatus = evaluateVehicleMaintenanceStatus(vehicle, todayStr);
    if (input.clearFaults) {
      vehicle.faultCodes = [];
    }

    this.state.maintenanceRecords.unshift(record);
    this.addAuditLog({
      tenantId: vehicle.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: `Registro ${record.type}`,
      targetLabel: `${vehicle.unitCode} · ${vehicle.engineHours} h`,
      detail: `${record.title} (${record.workshopOrTech}) · Próx. servicio: ${resolvedDate}.`,
    });
    this.persist(this.state);
    return { record, vehicle };
  }

  getVehicleDossier(tenantId: string, vehicleId: string, allowAllTenants = false) {
    const vehicle = this.state.vehicles.find(
      (v) => v.id === vehicleId && (allowAllTenants || v.tenantId === tenantId)
    );
    if (!vehicle) return null;
    const device = this.state.devices.find((d) => d.id === vehicle.deviceId) ?? null;
    const maintenance = this.state.maintenanceRecords.filter(
      (m) => m.vehicleId === vehicle.id && m.tenantId === vehicle.tenantId
    );
    const alerts = this.state.alerts.filter((a) => a.vehicleId === vehicle.id && a.tenantId === vehicle.tenantId);
    const incidents = this.state.incidents.filter((i) => i.vehicleId === vehicle.id && i.tenantId === vehicle.tenantId);
    return { vehicle, device, maintenance, alerts, incidents };
  }

  validateDevice(
    tenantId: string,
    deviceId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device | null {
    const dev = this.state.devices.find(
      (d) => d.id === deviceId && (allowAllTenants || d.tenantId === tenantId)
    );
    if (!dev) return null;
    dev.hardwareValidated = true;
    dev.linkStatus = 'conectado';
    dev.lastHeartbeatAt = new Date().toISOString();
    if (dev.protocol === 'JT808/JT1078' && dev.channels.length < 2) {
      dev.channels = ['CH1 Frontal', 'CH2 Cabina'];
    }
    this.addAuditLog({
      tenantId: dev.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Dispositivos',
      action: 'Validación de hardware/firmware',
      targetLabel: `${dev.unitCode} · ${dev.imei}`,
      detail: `Protocolo ${dev.protocol} y firmware ${dev.firmware} validados correctamente.`,
    });
    this.persist(this.state);
    return dev;
  }

  /** Work order lines; a unit cost in another currency is converted to the company's. */
  private normalizeOrderParts(
    tenantId: string,
    parts: Array<{ sku: string; name: string; category: WorkOrderPart['category']; quantity: number; unitCost: number; currency?: string }>,
    dateIso: string
  ): WorkOrderPart[] {
    return parts.map((p, idx) => {
      const qty = Math.max(1, Number(p.quantity || 1));
      const cost = this.currency.toTenantAmount(tenantId, Math.max(0, Number(p.unitCost || 0)), p.currency, dateIso);
      return {
        id: `prt-${uid()}-${idx}`,
        sku: (p.sku || `REF-${100 + idx}`).trim().toUpperCase(),
        name: p.name.trim(),
        category: p.category === 'insumo' || p.category === 'mano_obra' ? p.category : 'refaccion',
        quantity: qty,
        unitCost: cost.amount,
        subtotal: Number((qty * cost.amount).toFixed(2)),
        ...(cost.original ? { original: cost.original } : {}),
      };
    });
  }

  createWorkOrder(
    tenantId: string,
    input: {
      vehicleId: string;
      planId?: string;
      type: WorkOrder['type'];
      priority: WorkOrder['priority'];
      title: string;
      workshopOrTech: string;
      scheduledDate: string;
      parts: Array<{ sku: string; name: string; category: WorkOrderPart['category']; quantity: number; unitCost: number; currency?: string }>;
      laborCost: number;
      laborCurrency?: string;
      notes: string;
      clearFaultsOnClose?: boolean;
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): WorkOrder | null {
    const vehicle = this.state.vehicles.find(
      (v) => v.id === input.vehicleId && (allowAllTenants || v.tenantId === tenantId)
    );
    if (!vehicle) return null;

    const createdAt = new Date().toISOString();
    const normalizedParts = this.normalizeOrderParts(vehicle.tenantId, input.parts || [], createdAt);
    const partsCost = Number(normalizedParts.reduce((s, p) => s + p.subtotal, 0).toFixed(2));
    const labor = this.currency.toTenantAmount(vehicle.tenantId, Math.max(0, Number(input.laborCost || 0)), input.laborCurrency, createdAt);
    const laborCost = labor.amount;
    const totalCost = Number((partsCost + laborCost).toFixed(2));
    const order: WorkOrder = {
      id: `OT-${vehicle.unitCode.split('-')[0]}-${uid()}`,
      tenantId: vehicle.tenantId,
      vehicleId: vehicle.id,
      unitCode: vehicle.unitCode,
      plate: vehicle.plate,
      assetType: vehicle.assetType,
      planId: input.planId || undefined,
      type: input.type,
      priority: input.priority,
      status: 'abierta',
      title: input.title.trim(),
      workshopOrTech: input.workshopOrTech.trim() || 'Taller Central Certificado',
      scheduledDate: input.scheduledDate || new Date().toISOString().slice(0, 10),
      engineHoursAtOrder: vehicle.engineHours,
      odometerAtOrder: vehicle.odometerKm,
      parts: normalizedParts,
      laborCost,
      ...(labor.original ? { laborOriginal: labor.original } : {}),
      partsCost,
      totalCost,
      notes: input.notes.trim(),
      clearFaultsOnClose: Boolean(input.clearFaultsOnClose ?? true),
      createdAt,
    };

    this.state.workOrders.unshift(order);
    this.addAuditLog({
      tenantId: vehicle.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'Apertura de orden de trabajo',
      targetLabel: `${order.id} · ${vehicle.unitCode}`,
      detail: `${order.title} · Costo estimado ${this.money(order.tenantId, order.totalCost)}.`,
    });
    this.persist(this.state);
    return order;
  }

  updateWorkOrder(
    tenantId: string,
    workOrderId: string,
    patch: {
      status?: WorkOrderStatus;
      priority?: WorkOrderPriority;
      workshopOrTech?: string;
      scheduledDate?: string;
      notes?: string;
      laborCost?: number;
      laborCurrency?: string;
      parts?: Array<{ sku: string; name: string; category: WorkOrderPart['category']; quantity: number; unitCost: number; currency?: string }>;
      clearFaultsOnClose?: boolean;
      nextServiceDate?: string;
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { workOrder: WorkOrder; vehicle?: Vehicle; record?: MaintenanceRecord; lowStockAlerts?: string[] } | null {
    const order = this.state.workOrders.find(
      (w) => w.id === workOrderId && (allowAllTenants || w.tenantId === tenantId)
    );
    if (!order) return null;
    const prevStatus = order.status;

    if (patch.status) order.status = patch.status;
    if (
      patch.priority === 'critica' ||
      patch.priority === 'alta' ||
      patch.priority === 'media' ||
      patch.priority === 'baja'
    ) {
      order.priority = patch.priority;
    }
    if (typeof patch.workshopOrTech === 'string' && patch.workshopOrTech.trim()) {
      order.workshopOrTech = patch.workshopOrTech.trim();
    }
    if (typeof patch.scheduledDate === 'string' && patch.scheduledDate.trim()) {
      order.scheduledDate = patch.scheduledDate.trim();
    }
    if (typeof patch.notes === 'string') order.notes = patch.notes.trim();
    if (typeof patch.clearFaultsOnClose === 'boolean') order.clearFaultsOnClose = patch.clearFaultsOnClose;
    // Amounts in another currency are converted with the rates of the order's date, so
    // editing an order doesn't make its converted amounts drift.
    if (Array.isArray(patch.parts)) {
      order.parts = this.normalizeOrderParts(order.tenantId, patch.parts, order.createdAt);
      order.partsCost = Number(order.parts.reduce((s, p) => s + p.subtotal, 0).toFixed(2));
    }
    if (typeof patch.laborCost === 'number') {
      const labor = this.currency.toTenantAmount(order.tenantId, Math.max(0, Number(patch.laborCost)), patch.laborCurrency, order.createdAt);
      order.laborCost = labor.amount;
      if (labor.original) order.laborOriginal = labor.original;
      else delete order.laborOriginal;
    }
    order.totalCost = Number((order.partsCost + order.laborCost).toFixed(2));

    let updatedVehicle: Vehicle | undefined;
    let createdRecord: MaintenanceRecord | undefined;
    const lowStockAlerts: string[] = [];

    if (order.status === 'completada' && prevStatus !== 'completada') {
      order.completedAt = new Date().toISOString();

      // Auto-deduct consumed spare parts & supplies from tenant warehouse inventory (once per WO)
      if (!order.stockDeducted && order.parts.length > 0) {
        for (const p of order.parts) {
          if (p.category === 'mano_obra') continue;
          const inv = this.state.partsInventory.find(
            (item) => item.tenantId === order.tenantId && item.sku.toUpperCase() === p.sku.toUpperCase()
          );
          if (inv) {
            inv.stockQty = Math.max(0, Number((inv.stockQty - p.quantity).toFixed(2)));
            inv.updatedAt = order.completedAt;
            if (inv.stockQty <= inv.minStock) {
              lowStockAlerts.push(`${inv.sku} (${inv.stockQty} ${inv.unit})`);
            }
          }
        }
        order.stockDeducted = true;
      }

      const veh = this.state.vehicles.find((v) => v.id === order.vehicleId && v.tenantId === order.tenantId);
      if (veh) {
        const planIdToUse = order.planId ?? veh.assignedPlanId;
        const linkedPlan = planIdToUse
          ? this.state.preventivePlans.find((p) => p.id === planIdToUse)
          : undefined;
        const intervalHours = linkedPlan?.intervalHours ?? 250;
        const intervalKm = linkedPlan?.intervalKm ?? 10000;
        const targetHours = Number((veh.engineHours + intervalHours).toFixed(1));
        const hasCustomDate = Boolean(patch.nextServiceDate && /^\d{4}-\d{2}-\d{2}$/.test(patch.nextServiceDate));
        const resolvedDate = hasCustomDate
          ? patch.nextServiceDate!
          : computeServiceDateFromHours(veh.engineHours, targetHours, 'al_dia');

        veh.nextServiceHours = targetHours;
        veh.nextServiceKm = Math.round(veh.odometerKm + intervalKm);
        veh.nextServiceDate = resolvedDate;
        veh.serviceDatePinned = hasCustomDate;
        veh.maintenanceStatus = 'al_dia';
        if (order.clearFaultsOnClose) {
          veh.faultCodes = [];
        }
        updatedVehicle = veh;

        createdRecord = {
          id: `mnt-${uid()}`,
          tenantId: veh.tenantId,
          vehicleId: veh.id,
          unitCode: veh.unitCode,
          type: order.type,
          title: `${order.id} · ${order.title}`,
          performedAt: order.completedAt,
          engineHoursAtService: veh.engineHours,
          odometerAtService: veh.odometerKm,
          nextServiceDate: resolvedDate,
          workshopOrTech: order.workshopOrTech,
          cost: order.totalCost,
          notes: order.notes || 'Orden de trabajo cerrada en taller.',
          status: 'completado',
        };
        this.state.maintenanceRecords.unshift(createdRecord);
      }

      if (lowStockAlerts.length > 0) {
        this.addAuditLog({
          tenantId: order.tenantId,
          actorName,
          actorRole,
          actorHidden,
          module: 'Almacén y Refacciones',
          action: 'Alerta de stock mínimo',
          targetLabel: `${order.id} · ${order.unitCode}`,
          detail: `Descuento automático dejó bajo mínimo: ${lowStockAlerts.join(', ')}.`,
        });
      }
    }

    this.addAuditLog({
      tenantId: order.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: `Orden ${order.status}`,
      targetLabel: `${order.id} · ${order.unitCode}`,
      detail: `Prioridad ${order.priority.toUpperCase()} · Estado ${order.status} · Total ${this.money(order.tenantId, order.totalCost)}.`,
    });
    this.persist(this.state);
    return { workOrder: order, vehicle: updatedVehicle, record: createdRecord, lowStockAlerts };
  }

  createPreventivePlan(
    tenantId: string,
    input: {
      name: string;
      assetType: PreventivePlan['assetType'];
      intervalHours: number;
      intervalKm: number;
      intervalDays: number;
      estimatedCost: number;
      checklistFocus: string;
    },
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): PreventivePlan {
    const resolvedTenantId = this.requireTenant(tenantId);
    const plan: PreventivePlan = {
      id: `pln-${resolvedTenantId}-${uid()}`,
      tenantId: resolvedTenantId,
      name: input.name.trim(),
      assetType: input.assetType,
      intervalHours: Math.max(25, Number(input.intervalHours || 250)),
      intervalKm: Math.max(500, Number(input.intervalKm || 10000)),
      intervalDays: Math.max(7, Number(input.intervalDays || 45)),
      estimatedCost: Math.max(0, Number(input.estimatedCost || 0)),
      checklistFocus: input.checklistFocus.trim(),
      active: true,
      updatedAt: new Date().toISOString(),
    };
    this.state.preventivePlans.unshift(plan);
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'Alta de plan preventivo',
      targetLabel: plan.name,
      detail: `Cada ${plan.intervalHours} h / ${plan.intervalKm.toLocaleString('es-MX')} km / ${plan.intervalDays} días.`,
    });
    this.persist(this.state);
    return plan;
  }

  togglePreventivePlan(
    tenantId: string,
    planId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): PreventivePlan | null {
    const plan = this.state.preventivePlans.find(
      (p) => p.id === planId && (allowAllTenants || p.tenantId === tenantId)
    );
    if (!plan) return null;
    plan.active = !plan.active;
    plan.updatedAt = new Date().toISOString();
    this.addAuditLog({
      tenantId: plan.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: plan.active ? 'Activación de plan preventivo' : 'Pausa de plan preventivo',
      targetLabel: plan.name,
      detail: `Umbral ${plan.intervalHours} h / ${plan.intervalDays} días.`,
    });
    this.persist(this.state);
    return plan;
  }

  private ensurePreventiveWorkOrderForVehicle(
    vehicle: Vehicle,
    actorName = 'Motor Preventivo',
    actorRole = 'Automatización Flota',
    actorHidden = true
  ): { created?: WorkOrder; escalated?: WorkOrder } {
    if (vehicle.maintenanceStatus === 'al_dia') return {};

    const activeExisting = this.state.workOrders.find(
      (w) =>
        w.vehicleId === vehicle.id &&
        w.tenantId === vehicle.tenantId &&
        w.type === 'preventivo' &&
        (w.status === 'abierta' || w.status === 'en_taller' || w.status === 'esperando_refacciones')
    );

    if (activeExisting) {
      if (vehicle.maintenanceStatus === 'vencido' && activeExisting.priority !== 'critica') {
        activeExisting.priority = 'critica';
        activeExisting.scheduledDate = new Date().toISOString().slice(0, 10);
        return { escalated: activeExisting };
      }
      return {};
    }

    const plan =
      (vehicle.assignedPlanId
        ? this.state.preventivePlans.find((p) => p.id === vehicle.assignedPlanId && p.active)
        : undefined) ??
      this.state.preventivePlans.find(
        (p) =>
          p.tenantId === vehicle.tenantId &&
          p.active &&
          (p.assetType === vehicle.assetType || p.assetType === 'ambos')
      );

    if (!plan) return {};

    const todayStr = new Date().toISOString().slice(0, 10);
    const soonDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const isOverdue = vehicle.maintenanceStatus === 'vencido';
    const remHours = Number((vehicle.nextServiceHours - vehicle.engineHours).toFixed(1));
    const remKm = Math.round(vehicle.nextServiceKm - vehicle.odometerKm);

    const invCandidates = this.state.partsInventory.filter(
      (item) =>
        item.tenantId === vehicle.tenantId &&
        (vehicle.assetType === 'maquinaria_pesada'
          ? item.sku.includes('CAT') || item.sku.includes('OIL') || item.sku.includes('FLT')
          : item.sku.includes('FLT') || item.sku.includes('OIL') || item.sku.includes('BAL'))
    );
    const selectedParts: WorkOrderPart[] = invCandidates.slice(0, 2).map((item, idx) => ({
      id: `prt-auto-${uid()}-${idx}`,
      sku: item.sku,
      name: item.name,
      category: item.category,
      quantity: 1,
      unitCost: item.unitCost,
      subtotal: item.unitCost,
    }));
    const partsCost = Number(selectedParts.reduce((s, p) => s + p.subtotal, 0).toFixed(2));
    const laborCost = Math.max(1200, Math.round(plan.estimatedCost * 0.45));

    const order: WorkOrder = {
      id: `OT-AUTO-${vehicle.unitCode.split('-')[0]}-${uid()}`,
      tenantId: vehicle.tenantId,
      vehicleId: vehicle.id,
      unitCode: vehicle.unitCode,
      plate: vehicle.plate,
      assetType: vehicle.assetType,
      planId: plan.id,
      type: 'preventivo',
      priority: isOverdue ? 'critica' : 'alta',
      status: 'abierta',
      title: `${isOverdue ? 'Preventivo Vencido' : 'Preventivo Próximo'} · ${plan.name}`,
      workshopOrTech: 'Taller Central Certificado',
      scheduledDate: isOverdue ? todayStr : soonDate,
      engineHoursAtOrder: vehicle.engineHours,
      odometerAtOrder: vehicle.odometerKm,
      parts: selectedParts,
      laborCost,
      partsCost,
      totalCost: Number((partsCost + laborCost).toFixed(2)),
      notes: `OT automática por umbral (${remHours} h / ${remKm.toLocaleString('es-MX')} km / fecha ${vehicle.nextServiceDate}). Plan: ${plan.checklistFocus}`,
      clearFaultsOnClose: true,
      autoGenerated: true,
      createdAt: new Date().toISOString(),
    };

    this.state.workOrders.unshift(order);
    this.addAuditLog({
      tenantId: vehicle.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'OT preventiva automática',
      targetLabel: `${order.id} · ${vehicle.unitCode}`,
      detail: `Umbral ${isOverdue ? 'VENCIDO' : 'PRÓXIMO'} (${remHours} h, ${remKm} km, ${vehicle.nextServiceDate}) · Prioridad ${order.priority.toUpperCase()}.`,
    });
    return { created: order };
  }

  updatePreventivePlan(
    tenantId: string,
    planId: string,
    patch: Partial<{
      name: string;
      assetType: PreventivePlan['assetType'];
      intervalHours: number;
      intervalKm: number;
      intervalDays: number;
      estimatedCost: number;
      checklistFocus: string;
      active: boolean;
    }>,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): PreventivePlan | null {
    const plan = this.state.preventivePlans.find(
      (p) => p.id === planId && (allowAllTenants || p.tenantId === tenantId)
    );
    if (!plan) return null;

    if (typeof patch.name === 'string' && patch.name.trim()) plan.name = patch.name.trim();
    if (patch.assetType === 'vehiculo' || patch.assetType === 'maquinaria_pesada' || patch.assetType === 'ambos') {
      plan.assetType = patch.assetType;
    }
    if (typeof patch.intervalHours === 'number') plan.intervalHours = Math.max(25, Number(patch.intervalHours));
    if (typeof patch.intervalKm === 'number') plan.intervalKm = Math.max(500, Number(patch.intervalKm));
    if (typeof patch.intervalDays === 'number') plan.intervalDays = Math.max(7, Number(patch.intervalDays));
    if (typeof patch.estimatedCost === 'number') {
      plan.estimatedCost = Math.max(0, Number(patch.estimatedCost));
    }
    if (typeof patch.checklistFocus === 'string') plan.checklistFocus = patch.checklistFocus.trim();
    if (typeof patch.active === 'boolean') plan.active = patch.active;
    plan.updatedAt = new Date().toISOString();

    this.addAuditLog({
      tenantId: plan.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'Edición de plan preventivo',
      targetLabel: plan.name,
      detail: `Intervalos actualizados: ${plan.intervalHours} h / ${plan.intervalKm.toLocaleString('es-MX')} km / ${plan.intervalDays} días.`,
    });
    this.persist(this.state);
    return plan;
  }

  assignPreventivePlanToVehicles(
    tenantId: string,
    planId: string,
    vehicleIds: string[],
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { plan: PreventivePlan; updatedVehicles: Vehicle[]; createdOrders: WorkOrder[] } | null {
    const plan = this.state.preventivePlans.find(
      (p) => p.id === planId && (allowAllTenants || p.tenantId === tenantId)
    );
    if (!plan) return null;

    const idSet = new Set(vehicleIds);
    const updatedVehicles: Vehicle[] = [];
    const createdOrders: WorkOrder[] = [];
    const todayStr = new Date().toISOString().slice(0, 10);

    for (const v of this.state.vehicles) {
      if (v.tenantId !== plan.tenantId || !idSet.has(v.id)) continue;
      v.assignedPlanId = plan.id;
      v.maintenanceStatus = evaluateVehicleMaintenanceStatus(v, todayStr);
      updatedVehicles.push(v);
      const res = this.ensurePreventiveWorkOrderForVehicle(v, actorName, actorRole, actorHidden);
      if (res.created) createdOrders.push(res.created);
    }

    this.addAuditLog({
      tenantId: plan.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'Asignación de plan preventivo',
      targetLabel: plan.name,
      detail: `Asignado a ${updatedVehicles.length} unidad(es)${createdOrders.length > 0 ? ` · ${createdOrders.length} OT(s) disparada(s)` : ''}.`,
    });
    this.persist(this.state);
    return { plan, updatedVehicles, createdOrders };
  }

  runPreventiveAutoDispatch(
    tenantId: string,
    scopeTenantId: string | undefined,
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): { evaluatedCount: number; createdOrders: WorkOrder[]; escalatedCount: number } {
    const targetScope = scopeTenantId ?? tenantId;
    const list =
      targetScope === 'all'
        ? this.state.vehicles
        : this.state.vehicles.filter((v) => v.tenantId === targetScope);

    const todayStr = new Date().toISOString().slice(0, 10);
    const createdOrders: WorkOrder[] = [];
    let escalatedCount = 0;

    for (const v of list) {
      v.maintenanceStatus = evaluateVehicleMaintenanceStatus(v, todayStr);
      if (!v.serviceDatePinned) {
        v.nextServiceDate = computeServiceDateFromHours(v.engineHours, v.nextServiceHours, v.maintenanceStatus);
      }
      if (v.maintenanceStatus === 'vencido' || v.maintenanceStatus === 'proximo') {
        const res = this.ensurePreventiveWorkOrderForVehicle(v, actorName, actorRole, actorHidden);
        if (res.created) createdOrders.push(res.created);
        if (res.escalated) escalatedCount += 1;
      }
    }

    this.addAuditLog({
      tenantId: targetScope === 'all' ? GLOBAL_AUDIT_TENANT : targetScope,
      actorName,
      actorRole,
      actorHidden,
      module: 'Mantenimiento',
      action: 'Evaluación tri-umbral de planes',
      targetLabel: `${list.length} unidades evaluadas`,
      detail: `${createdOrders.length} OT(s) automáticas generadas · ${escalatedCount} escalada(s) a crítica.`,
    });
    this.persist(this.state);
    return { evaluatedCount: list.length, createdOrders, escalatedCount };
  }

  upsertPartInventoryItem(
    tenantId: string,
    input: {
      sku: string;
      name: string;
      category: PartInventoryItem['category'];
      unit: string;
      stockQty: number;
      minStock: number;
      unitCost: number;
      unitCostCurrency?: string;
      warehouseLocation: string;
    },
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): PartInventoryItem {
    const resolvedTenantId = this.requireTenant(tenantId);
    const cost = this.currency.toTenantAmount(resolvedTenantId, Math.max(0, Number(input.unitCost || 0)), input.unitCostCurrency);
    const normalizedSku = input.sku.trim().toUpperCase();
    const existing = this.state.partsInventory.find(
      (i) => i.tenantId === resolvedTenantId && i.sku.toUpperCase() === normalizedSku
    );
    const nowIso = new Date().toISOString();

    if (existing) {
      existing.name = input.name.trim();
      existing.category = input.category === 'insumo' ? 'insumo' : 'refaccion';
      existing.unit = input.unit.trim() || existing.unit;
      existing.stockQty = Math.max(0, Number(input.stockQty));
      existing.minStock = Math.max(0, Number(input.minStock));
      existing.unitCost = cost.amount;
      if (cost.original) existing.unitCostOriginal = cost.original;
      else delete existing.unitCostOriginal;
      existing.warehouseLocation = input.warehouseLocation.trim() || existing.warehouseLocation;
      existing.updatedAt = nowIso;
      this.addAuditLog({
        tenantId: resolvedTenantId,
        actorName,
        actorRole,
        actorHidden,
        module: 'Almacén y Refacciones',
        action: 'Actualización de SKU',
        targetLabel: `${existing.sku} · ${existing.name}`,
        detail: `Existencia ${existing.stockQty} ${existing.unit} (mín ${existing.minStock}) · ${this.money(existing.tenantId, existing.unitCost)}.`,
      });
      this.persist(this.state);
      return existing;
    }

    const item: PartInventoryItem = {
      id: `inv-${resolvedTenantId}-${uid()}`,
      tenantId: resolvedTenantId,
      sku: normalizedSku,
      name: input.name.trim(),
      category: input.category === 'insumo' ? 'insumo' : 'refaccion',
      unit: input.unit.trim() || 'pza',
      stockQty: Math.max(0, Number(input.stockQty || 0)),
      minStock: Math.max(0, Number(input.minStock || 1)),
      unitCost: cost.amount,
      ...(cost.original ? { unitCostOriginal: cost.original } : {}),
      warehouseLocation: input.warehouseLocation.trim() || 'Almacén Central',
      updatedAt: nowIso,
    };
    this.state.partsInventory.unshift(item);
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Almacén y Refacciones',
      action: 'Alta de refacción/insumo',
      targetLabel: `${item.sku} · ${item.name}`,
      detail: `Stock inicial ${item.stockQty} ${item.unit} en ${item.warehouseLocation}.`,
    });
    this.persist(this.state);
    return item;
  }

  adjustPartInventoryStock(
    tenantId: string,
    itemId: string,
    deltaQty: number,
    reason: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): PartInventoryItem | null {
    const item = this.state.partsInventory.find(
      (i) => i.id === itemId && (allowAllTenants || i.tenantId === tenantId)
    );
    if (!item) return null;

    const prev = item.stockQty;
    item.stockQty = Math.max(0, Number((item.stockQty + Number(deltaQty || 0)).toFixed(2)));
    item.updatedAt = new Date().toISOString();

    this.addAuditLog({
      tenantId: item.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Almacén y Refacciones',
      action: deltaQty >= 0 ? 'Entrada de almacén' : 'Salida manual de almacén',
      targetLabel: `${item.sku} · ${item.name}`,
      detail: `${prev} -> ${item.stockQty} ${item.unit} (${reason || 'Ajuste de inventario'}).`,
    });
    this.persist(this.state);
    return item;
  }

  createPreOpChecklist(
    tenantId: string,
    input: {
      vehicleId: string;
      driverName: string;
      shift: PreOpChecklist['shift'];
      items: ChecklistItem[];
      summaryNote: string;
      createWorkOrderIfFailed?: boolean;
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { checklist: PreOpChecklist; workOrder?: WorkOrder } | null {
    const vehicle = this.state.vehicles.find(
      (v) => v.id === input.vehicleId && (allowAllTenants || v.tenantId === tenantId)
    );
    if (!vehicle) return null;

    const failedItems = input.items.filter((it) => it.status === 'falla');
    const result: PreOpChecklistResult =
      failedItems.length >= 2 ? 'reprobado' : failedItems.length === 1 ? 'con_observaciones' : 'aprobado';

    let linkedOrder: WorkOrder | undefined;
    if (failedItems.length > 0 && input.createWorkOrderIfFailed) {
      const created = this.createWorkOrder(
        vehicle.tenantId,
        {
          vehicleId: vehicle.id,
          type: 'correctivo',
          priority: failedItems.length >= 2 ? 'critica' : 'alta',
          title: `Correctivo pre-operativo (${failedItems.map((f) => f.label).slice(0, 2).join('; ')})`,
          workshopOrTech: 'Taller Central Certificado',
          scheduledDate: new Date().toISOString().slice(0, 10),
          parts: [],
          laborCost: 0,
          notes: input.summaryNote || `Hallazgos en checklist turno ${input.shift}.`,
          clearFaultsOnClose: false,
        },
        actorName,
        actorRole,
        true,
        actorHidden
      );
      if (created) linkedOrder = created;
    }

    const checklist: PreOpChecklist = {
      id: `CHK-${vehicle.unitCode.split('-')[0]}-${uid()}`,
      tenantId: vehicle.tenantId,
      vehicleId: vehicle.id,
      unitCode: vehicle.unitCode,
      assetType: vehicle.assetType,
      driverName: input.driverName.trim() || vehicle.driverName,
      shift: input.shift,
      engineHours: vehicle.engineHours,
      odometerKm: vehicle.odometerKm,
      result,
      items: input.items,
      summaryNote: input.summaryNote.trim() || (failedItems.length === 0 ? 'Unidad apta para operar.' : 'Requiere revisión de taller.'),
      linkedWorkOrderId: linkedOrder?.id,
      submittedAt: new Date().toISOString(),
    };

    this.state.checklists.unshift(checklist);
    this.addAuditLog({
      tenantId: vehicle.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Checklist Pre-Operativo',
      action: `Inspección ${result}`,
      targetLabel: `${checklist.id} · ${vehicle.unitCode}`,
      detail: `${failedItems.length} hallazgo(s) en turno ${checklist.shift}${linkedOrder ? ` · Generó ${linkedOrder.id}` : ''}.`,
    });
    this.persist(this.state);
    return { checklist, workOrder: linkedOrder };
  }

  /**
   * Supervisor review of a pre-op checklist. Items and result are never touched (they are the
   * inspection evidence); a new review replaces the previous one and both stay in the audit log.
   * Optionally creates the corrective work order when the checklist had failures and none was generated.
   */
  reviewPreOpChecklist(
    tenantId: string,
    checklistId: string,
    input: { decision: ChecklistReviewDecision; note: string; createWorkOrder?: boolean },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { checklist: PreOpChecklist; workOrder?: WorkOrder } | null {
    const checklist = this.state.checklists.find(
      (c) => c.id === checklistId && (allowAllTenants || c.tenantId === tenantId)
    );
    if (!checklist) return null;

    const failedItems = checklist.items.filter((it) => it.status === 'falla');
    let linkedOrder: WorkOrder | undefined;
    if (input.createWorkOrder && failedItems.length > 0 && !checklist.linkedWorkOrderId) {
      const created = this.createWorkOrder(
        checklist.tenantId,
        {
          vehicleId: checklist.vehicleId,
          type: 'correctivo',
          priority: failedItems.length >= 2 || input.decision === 'no_apto' ? 'critica' : 'alta',
          title: `Correctivo pre-operativo (${failedItems.map((f) => f.label).slice(0, 2).join('; ')})`,
          workshopOrTech: 'Taller Central Certificado',
          scheduledDate: new Date().toISOString().slice(0, 10),
          parts: [],
          laborCost: 0,
          notes: `Generada en la revisión de ${checklist.id}. ${input.note.trim()}`.trim(),
          clearFaultsOnClose: false,
        },
        actorName,
        actorRole,
        true,
        actorHidden
      );
      if (created) {
        linkedOrder = created;
        checklist.linkedWorkOrderId = created.id;
      }
    }

    const previous = checklist.review;
    checklist.review = {
      decision: input.decision,
      note: input.note.trim(),
      reviewedBy: actorName,
      reviewedAt: new Date().toISOString(),
    };
    const label = CHECKLIST_DECISION_LABELS[input.decision];
    this.addAuditLog({
      tenantId: checklist.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Checklist Pre-Operativo',
      action: previous ? 'Revisión corregida' : 'Checklist revisado',
      targetLabel: `${checklist.id} · ${checklist.unitCode}`,
      detail: `${previous ? `${CHECKLIST_DECISION_LABELS[previous.decision]} → ` : ''}${label}${
        input.note.trim() ? ` · ${input.note.trim()}` : ''
      }${linkedOrder ? ` · Generó ${linkedOrder.id}` : ''}.`,
    });
    this.persist(this.state);
    return { checklist, workOrder: linkedOrder };
  }

  createDashcamDriver(
    tenantId: string,
    input: {
      vendorFamily: DashcamDriverProfile['vendorFamily'];
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
    },
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): DashcamDriverProfile {
    const resolvedTenantId = this.requireTenant(tenantId);
    const driver: DashcamDriverProfile = {
      id: `drv-custom-${uid()}`,
      vendorFamily: input.vendorFamily,
      vendorName: input.vendorName.trim(),
      modelSeries: input.modelSeries.trim(),
      driverCode: input.driverCode.trim().toUpperCase(),
      driverVersion: input.driverVersion.trim() || '1.0.0-CUSTOM',
      protocol: input.protocol,
      defaultPort: Math.max(1024, Math.min(65535, Number(input.defaultPort || 6808))),
      maxChannels: Math.max(1, Math.min(8, Number(input.maxChannels || 4))),
      supportedResolutions: ['1080p_30fps', '720p_30fps', '720p_15fps'],
      defaultBitrateKbps: Math.max(512, Number(input.defaultBitrateKbps || 2048)),
      supportedFeatures: input.supportedFeatures,
      notes: input.notes.trim() || 'Driver personalizado de dashcam registrado en catálogo.',
      isCustom: true,
    };
    this.state.dashcamDrivers.unshift(driver);
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Drivers y Dashcams',
      action: 'Alta de driver personalizado',
      targetLabel: `${driver.vendorName} · ${driver.driverCode}`,
      detail: `Protocolo ${driver.protocol} puerto TCP ${driver.defaultPort} · ${driver.maxChannels} canales.`,
    });
    this.persist(this.state);
    return driver;
  }

  updateDeviceDashcamConfig(
    tenantId: string,
    deviceId: string,
    patch: {
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
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device | null {
    const dev = this.state.devices.find(
      (d) => d.id === deviceId && (allowAllTenants || d.tenantId === tenantId)
    );
    if (!dev) return null;
    const driver = this.state.dashcamDrivers.find((dr) => dr.id === patch.driverId);
    if (!driver) return null;

    const nowIso = new Date().toISOString();
    const channels = patch.activeChannels.length > 0 ? patch.activeChannels : ['CH1 Frontal'];

    dev.model = `${driver.vendorName} ${driver.modelSeries}`;
    dev.protocol = driver.protocol;
    dev.firmware = driver.driverVersion;
    dev.channels = channels;
    dev.hardwareValidated = true;
    dev.linkStatus = 'conectado';
    dev.lastHeartbeatAt = nowIso;
    dev.dashcamConfig = {
      driverId: driver.id,
      driverCode: driver.driverCode,
      tcpPort: Math.max(1024, Math.min(65535, Number(patch.tcpPort || driver.defaultPort))),
      activeChannels: channels,
      resolution: patch.resolution,
      bitrateKbps: Math.max(512, Number(patch.bitrateKbps || driver.defaultBitrateKbps)),
      gpsIntervalSec: Math.max(5, Math.min(300, Number(patch.gpsIntervalSec || 15))),
      preEventSec: Math.max(5, Math.min(60, Number(patch.preEventSec || 10))),
      postEventSec: Math.max(5, Math.min(120, Number(patch.postEventSec || 15))),
      gSensorThresholdG: Math.max(0.2, Math.min(2.5, Number(patch.gSensorThresholdG || 0.65))),
      features: {
        adasEnabled: Boolean(patch.features.adasEnabled && driver.supportedFeatures.adas),
        dmsEnabled: Boolean(patch.features.dmsEnabled && driver.supportedFeatures.dms),
        bsdEnabled: Boolean(patch.features.bsdEnabled && driver.supportedFeatures.bsd),
        intercomEnabled: Boolean(patch.features.intercomEnabled && driver.supportedFeatures.intercomAudio),
        loopRecordingSd: Boolean(patch.features.loopRecordingSd),
        canBusEnabled: Boolean(patch.features.canBusEnabled && driver.supportedFeatures.canJ1939),
        rs232Peripheral: driver.supportedFeatures.rs232 ? patch.features.rs232Peripheral : 'ninguno',
      },
      syncStatus: 'sincronizado',
      updatedBy: actorName,
      updatedAt: nowIso,
    };

    this.addAuditLog({
      tenantId: dev.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Drivers y Dashcams',
      action: 'Configuración de driver y prestaciones',
      targetLabel: `${dev.unitCode} · ${driver.driverCode}`,
      detail: `${channels.length} canales (${dev.dashcamConfig.resolution}) · Puerto ${dev.dashcamConfig.tcpPort} · ADAS:${dev.dashcamConfig.features.adasEnabled ? 'ON' : 'OFF'} DMS:${dev.dashcamConfig.features.dmsEnabled ? 'ON' : 'OFF'} CAN:${dev.dashcamConfig.features.canBusEnabled ? 'ON' : 'OFF'}.`,
    });
    this.persist(this.state);
    return dev;
  }

  batchUpdateDeviceDashcamConfig(
    tenantId: string,
    deviceIds: string[],
    patch: {
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
    },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Device[] | null {
    const driver = this.state.dashcamDrivers.find((dr) => dr.id === patch.driverId);
    if (!driver) return null;

    const idSet = new Set(deviceIds);
    const targets = this.state.devices.filter(
      (d) => idSet.has(d.id) && (allowAllTenants || d.tenantId === tenantId)
    );
    if (targets.length === 0) return null;

    const nowIso = new Date().toISOString();
    const rawChannels = patch.activeChannels.length > 0 ? patch.activeChannels : ['CH1 Frontal'];
    const channels = rawChannels.slice(0, driver.maxChannels);
    const resolution = driver.supportedResolutions.includes(patch.resolution)
      ? patch.resolution
      : driver.supportedResolutions[0] ?? '1080p_30fps';

    const tenantCounts = new Map<string, string[]>();
    for (const dev of targets) {
      dev.model = `${driver.vendorName} ${driver.modelSeries}`;
      dev.protocol = driver.protocol;
      dev.firmware = driver.driverVersion;
      dev.channels = channels;
      dev.hardwareValidated = true;
      dev.linkStatus = 'conectado';
      dev.lastHeartbeatAt = nowIso;
      dev.dashcamConfig = {
        driverId: driver.id,
        driverCode: driver.driverCode,
        tcpPort: Math.max(1024, Math.min(65535, Number(patch.tcpPort || driver.defaultPort))),
        activeChannels: channels,
        resolution,
        bitrateKbps: Math.max(512, Number(patch.bitrateKbps || driver.defaultBitrateKbps)),
        gpsIntervalSec: Math.max(5, Math.min(300, Number(patch.gpsIntervalSec || 15))),
        preEventSec: Math.max(5, Math.min(60, Number(patch.preEventSec || 10))),
        postEventSec: Math.max(5, Math.min(120, Number(patch.postEventSec || 15))),
        gSensorThresholdG: Math.max(0.2, Math.min(2.5, Number(patch.gSensorThresholdG || 0.65))),
        features: {
          adasEnabled: Boolean(patch.features.adasEnabled && driver.supportedFeatures.adas),
          dmsEnabled: Boolean(patch.features.dmsEnabled && driver.supportedFeatures.dms),
          bsdEnabled: Boolean(patch.features.bsdEnabled && driver.supportedFeatures.bsd),
          intercomEnabled: Boolean(patch.features.intercomEnabled && driver.supportedFeatures.intercomAudio),
          loopRecordingSd: Boolean(patch.features.loopRecordingSd),
          canBusEnabled: Boolean(patch.features.canBusEnabled && driver.supportedFeatures.canJ1939),
          rs232Peripheral: driver.supportedFeatures.rs232 ? patch.features.rs232Peripheral : 'ninguno',
        },
        syncStatus: 'sincronizado',
        updatedBy: actorName,
        updatedAt: nowIso,
      };
      const arr = tenantCounts.get(dev.tenantId) ?? [];
      arr.push(dev.unitCode);
      tenantCounts.set(dev.tenantId, arr);
    }

    for (const [tId, codes] of tenantCounts.entries()) {
      this.addAuditLog({
        tenantId: tId,
        actorName,
        actorRole,
        actorHidden,
        module: 'Drivers y Dashcams',
        action: `Configuración en lote (${codes.length} equipos)`,
        targetLabel: `${driver.driverCode} · ${codes.slice(0, 3).join(', ')}${codes.length > 3 ? '...' : ''}`,
        detail: `Aplicado a ${codes.length} unidad(es): ${channels.length}CH ${resolution} · ${patch.bitrateKbps} kbps · G-Sensor ${patch.gSensorThresholdG}G.`,
      });
    }

    this.persist(this.state);
    return targets;
  }

  acknowledgeAlert(
    tenantId: string,
    alertId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): AlertEvent | null {
    const alert = this.state.alerts.find(
      (a) => a.id === alertId && (allowAllTenants || a.tenantId === tenantId)
    );
    if (!alert) return null;
    alert.status = 'confirmada';
    const veh = this.state.vehicles.find((v) => v.id === alert.vehicleId && v.tenantId === alert.tenantId);
    if (veh && veh.operationalStatus === 'alerta') {
      veh.operationalStatus = veh.ignition ? 'en_ruta' : 'detenido';
    }
    this.addAuditLog({
      tenantId: alert.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Alertas',
      action: 'Confirmación de alerta',
      targetLabel: `${alert.id} · ${alert.unitCode}`,
      detail: `Alerta "${alert.ruleName}" confirmada por operador.`,
    });
    this.persist(this.state);
    return alert;
  }

  escalateAlert(
    tenantId: string,
    alertId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): { alert: AlertEvent; incident: Incident } | null {
    const alert = this.state.alerts.find(
      (a) => a.id === alertId && (allowAllTenants || a.tenantId === tenantId)
    );
    if (!alert) return null;
    alert.status = 'escalada';
    const nowIso = new Date().toISOString();

    const existing = this.state.incidents.find((inc) => inc.alertId === alert.id && inc.tenantId === alert.tenantId);
    if (existing) {
      this.persist(this.state);
      return { alert, incident: existing };
    }

    const incident: Incident = {
      id: `inc-${uid()}`,
      tenantId: alert.tenantId,
      alertId: alert.id,
      vehicleId: alert.vehicleId,
      unitCode: alert.unitCode,
      plate: alert.plate,
      title: alert.ruleName,
      category: 'Evento de Telemetría / Video',
      priority: alert.priority,
      status: 'abierto',
      assignee: actorName,
      createdAt: nowIso,
      updatedAt: nowIso,
      resolutionNote: alert.summary,
      clipId: alert.clipId,
    };
    this.state.incidents.unshift(incident);
    this.addAuditLog({
      tenantId: alert.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Incidentes',
      action: 'Escalamiento desde alerta',
      targetLabel: `${incident.id} · ${incident.unitCode}`,
      detail: `Se abrió incidente formal desde alerta ${alert.id}.`,
    });
    this.persist(this.state);
    return { alert, incident };
  }

  updateIncident(
    tenantId: string,
    incidentId: string,
    patch: { status?: Incident['status']; resolutionNote?: string; assignee?: string },
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): Incident | null {
    const inc = this.state.incidents.find(
      (i) => i.id === incidentId && (allowAllTenants || i.tenantId === tenantId)
    );
    if (!inc) return null;
    if (patch.status) inc.status = patch.status;
    if (typeof patch.resolutionNote === 'string') inc.resolutionNote = patch.resolutionNote;
    if (typeof patch.assignee === 'string') inc.assignee = patch.assignee;
    inc.updatedAt = new Date().toISOString();

    if (patch.status === 'resuelto') {
      const veh = this.state.vehicles.find((v) => v.id === inc.vehicleId && v.tenantId === inc.tenantId);
      if (veh && veh.operationalStatus === 'alerta') {
        veh.operationalStatus = veh.ignition ? 'en_ruta' : 'detenido';
      }
    }

    this.addAuditLog({
      tenantId: inc.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Incidentes',
      action: `Actualización a estado ${inc.status}`,
      targetLabel: `${inc.id} · ${inc.unitCode}`,
      detail: inc.resolutionNote.slice(0, 120),
    });
    this.persist(this.state);
    return inc;
  }

  toggleRule(
    tenantId: string,
    ruleId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): AlertRule | null {
    const rule = this.state.alertRules.find(
      (r) => r.id === ruleId && (allowAllTenants || r.tenantId === tenantId)
    );
    if (!rule) return null;
    rule.active = !rule.active;
    this.addAuditLog({
      tenantId: rule.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Reglas de Alerta',
      action: rule.active ? 'Activación de regla' : 'Pausa de regla',
      targetLabel: rule.name,
      detail: `Cola asociada: ${rule.notifyQueue}.`,
    });
    this.persist(this.state);
    return rule;
  }

  createRule(
    tenantId: string,
    input: Omit<AlertRule, 'id' | 'tenantId'>,
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): AlertRule {
    const resolvedTenantId = this.requireTenant(tenantId);
    const rule: AlertRule = {
      ...input,
      tenantId: resolvedTenantId,
      id: `rul-${uid()}`,
    };
    this.state.alertRules.unshift(rule);
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Reglas de Alerta',
      action: 'Nueva regla configurada',
      targetLabel: rule.name,
      detail: `Prioridad ${rule.priority} · Umbral: ${rule.thresholdLabel}.`,
    });
    this.persist(this.state);
    return rule;
  }

  requestOnDemandClip(
    tenantId: string,
    vehicleId: string,
    channel: VideoClip['channel'],
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): VideoClip | null {
    const vehicle = this.state.vehicles.find(
      (v) => v.id === vehicleId && (allowAllTenants || v.tenantId === tenantId)
    );
    if (!vehicle) return null;
    const clipId = `clp-${uid()}`;
    const isUrban = vehicle.tenantId === 'ten-urbana';
    const clip: VideoClip = {
      id: clipId,
      tenantId: vehicle.tenantId,
      vehicleId: vehicle.id,
      unitCode: vehicle.unitCode,
      plate: vehicle.plate,
      driverName: vehicle.driverName,
      triggerType: 'bajo_demanda',
      channel,
      durationSec: 30,
      sizeMb: channel === 'dual' ? 27.6 : 14.8,
      roadImageUrl: isUrban ? ROAD_URBAN_IMG : ROAD_HIGHWAY_IMG,
      cabinImageUrl: CABIN_DRIVER_IMG,
      s3Path: `s3://fleetops-evidencia/${vehicle.tenantId}/2026-11/${clipId}-${channel}.mp4`,
      recordedAt: new Date().toISOString(),
      retentionLocked: false,
      retentionDays: 30,
      speedAtEventKmh: vehicle.speedKmh,
      gForcePeak: 0.14,
    };
    this.state.videoClips.unshift(clip);
    this.addAuditLog({
      tenantId: vehicle.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Consola de Video',
      action: 'Captura bajo demanda JT1078',
      targetLabel: `${vehicle.unitCode} · ${clip.id}`,
      detail: `Flujo ${channel} archivado en ${clip.s3Path}.`,
    });
    this.persist(this.state);
    return clip;
  }

  toggleClipRetention(
    tenantId: string,
    clipId: string,
    actorName: string,
    actorRole: string,
    allowAllTenants = false,
    actorHidden = false
  ): VideoClip | null {
    const clip = this.state.videoClips.find(
      (c) => c.id === clipId && (allowAllTenants || c.tenantId === tenantId)
    );
    if (!clip) return null;
    clip.retentionLocked = !clip.retentionLocked;
    clip.retentionDays = clip.retentionLocked ? 90 : 30;
    this.addAuditLog({
      tenantId: clip.tenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Consola de Video',
      action: clip.retentionLocked ? 'Bloqueo de retención legal' : 'Liberación de retención',
      targetLabel: `${clip.id} · ${clip.unitCode}`,
      detail: `Retención configurada en ${clip.retentionDays} días en S3/MinIO.`,
    });
    this.persist(this.state);
    return clip;
  }

  tickTelemetry(tenantId: string, scopeTenantId?: string): Vehicle[] {
    const nowIso = new Date().toISOString();
    const todayStr = nowIso.slice(0, 10);
    const targetScope = scopeTenantId ?? tenantId;
    const list =
      targetScope === 'all'
        ? this.state.vehicles
        : this.state.vehicles.filter((v) => v.tenantId === targetScope);
    const simulate = process.env.SIMULATED_TELEMETRY !== 'false';
    const realDevices = new Set(
      this.state.devices.filter((d) => d.telemetrySource === 'traccar').map((d) => d.vehicleId)
    );
    // Units moved by a driver's phone in the last 10 minutes keep their real position too.
    const phoneCutoff = Date.now() - 10 * 60_000;
    for (const v of this.state.vehicles) {
      if (v.positionSource === 'smartphone' && Date.parse(v.lastReportAt) > phoneCutoff) realDevices.add(v.id);
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      // Units reporting through Traccar keep their real position; simulation only moves demo units.
      if (simulate && !realDevices.has(v.id) && (v.operationalStatus === 'en_ruta' || v.operationalStatus === 'alerta')) {
        const rad = (v.heading * Math.PI) / 180;
        const delta = v.assetType === 'maquinaria_pesada' ? 0.00025 : 0.0018;
        v.lat = Number((v.lat + Math.cos(rad) * delta).toFixed(5));
        v.lng = Number((v.lng + Math.sin(rad) * delta).toFixed(5));
        v.heading = (v.heading + ((i % 2 === 0 ? 1 : -1) * 4) + 360) % 360;
        if (v.assetType === 'vehiculo') {
          const speedJitter = (i % 5) - 2;
          v.speedKmh = Math.max(28, Math.min(110, v.speedKmh + speedJitter));
          v.odometerKm = Number((v.odometerKm + 0.4).toFixed(1));
        }
        v.engineHours = Number((v.engineHours + 0.05).toFixed(2));
        v.rpm = v.assetType === 'maquinaria_pesada' ? 1650 + (i % 140) : 1380 + (i % 190);
        if (v.faultCodes.some((f) => f.code.includes('110'))) {
          v.coolantTempC = 103 + (i % 4);
        } else {
          v.coolantTempC = 85 + (i % 6);
        }
        v.lastReportAt = nowIso;
      }

      // Evaluate tri-threshold preventive maintenance status (hours, odometer km, calendar date)
      v.maintenanceStatus = evaluateVehicleMaintenanceStatus(v, todayStr);
      if (!v.serviceDatePinned) {
        v.nextServiceDate = computeServiceDateFromHours(v.engineHours, v.nextServiceHours, v.maintenanceStatus);
      }
      if (v.maintenanceStatus === 'vencido' || v.maintenanceStatus === 'proximo') {
        this.ensurePreventiveWorkOrderForVehicle(v, 'Motor Preventivo', 'Telemetría Automática', true);
      }
    }
    this.persist(this.state);
    return list;
  }

  updateSizing(
    tenantId: string,
    patch: Partial<FleetStoreState['sizing']>,
    actorName: string,
    actorRole: string,
    actorHidden = false
  ): FleetStoreState['sizing'] {
    const resolvedTenantId = GLOBAL_AUDIT_TENANT;
    this.state.sizing = {
      ...this.state.sizing,
      ...patch,
    };
    this.addAuditLog({
      tenantId: resolvedTenantId,
      actorName,
      actorRole,
      actorHidden,
      module: 'Dimensionamiento',
      action: 'Actualización de parámetros',
      targetLabel: `${this.state.sizing.vehiclesCount} vehículos · ${this.state.sizing.videoMode}`,
      detail: `Intervalo ${this.state.sizing.gpsIntervalSec}s, retención ${this.state.sizing.retentionDays} días.`,
    });
    this.persist(this.state);
    return this.state.sizing;
  }
}

export const fleetStore = new FleetStore();
