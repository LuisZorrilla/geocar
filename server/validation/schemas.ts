import { PLAN_TIERS, RETENTION_DAYS, USERNAME_PATTERN } from '../../src/shared/tenantOptions.ts';
import { z } from 'zod';

/**
 * Request body schemas for every write endpoint.
 *
 * Objects use zod's default "strip" mode: unknown keys (e.g. `id`, `tenantId`
 * on most routes, or anything an attacker adds) are silently dropped, so they
 * can never reach the store. Only `tenantId` is accepted where the superadmin
 * picks a target company; `resolveTargetTenantId` ignores it for everyone else.
 */

const text = (max = 200) => z.string().trim().max(max);
const requiredText = (max = 200) => z.string().trim().min(1, 'es obligatorio').max(max);
const id = z.string().trim().min(1).max(80);
// High ceiling: VES and CLP amounts are large numbers.
const money = z.coerce.number().finite().nonnegative().max(1_000_000_000_000);
const currencyCode = z.string().trim().regex(/^[A-Z]{3}$/, 'código de moneda inválido (ISO, 3 letras)');
const count = (max: number) => z.coerce.number().int().nonnegative().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'fecha inválida (AAAA-MM-DD)');
const targetTenant = { tenantId: id.optional() };

export const permissionLevel = z.enum(['full', 'write', 'read', 'none']);
const MODULES = [
  'administracion',
  'flotas',
  'dispositivos',
  'dashcams_config',
  'monitoreo',
  'alertas',
  'incidentes',
  'video',
  'reportes',
  'dimensionamiento',
] as const;
const modulePermissions = z.object(
  Object.fromEntries(MODULES.map((m) => [m, permissionLevel])) as Record<(typeof MODULES)[number], typeof permissionLevel>
).strict();
const modulePermissionsPatch = modulePermissions.partial();

const assetType = z.enum(['vehiculo', 'maquinaria_pesada']);
const protocol = z.enum(['JT808/JT1078', 'Traccar']);
const priority = z.enum(['critica', 'alta', 'media', 'informativa']);
const workOrderPriority = z.enum(['baja', 'media', 'alta', 'critica']);
const workOrderStatus = z.enum(['abierta', 'en_taller', 'esperando_refacciones', 'completada', 'cancelada']);
const maintenanceType = z.enum(['preventivo', 'correctivo', 'inspeccion']);
const partCategory = z.enum(['refaccion', 'insumo', 'mano_obra']);

export const idParam = id;

// ---- Auth & users -----------------------------------------------------------

export const login = z.object({ username: requiredText(80), password: z.string().min(1).max(200) });
export const changePassword = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
export const createUser = z.object({
  ...targetTenant,
  name: requiredText(120),
  username: requiredText(60),
  password: z.string().min(1, 'es obligatoria').max(200),
  roleId: id,
});
export const updateUser = z.object({
  roleId: id.optional(),
  status: z.enum(['activo', 'inactivo']).optional(),
  password: z.string().max(200).optional(),
});

export const createRole = z.object({
  ...targetTenant,
  name: requiredText(80),
  description: text(400).optional().default(''),
  permissions: modulePermissions,
});
export const updateRole = z.object({
  name: requiredText(80).optional(),
  description: text(400).optional(),
  permissions: modulePermissionsPatch.optional(),
});

// ---- Fleet ------------------------------------------------------------------

export const createVehicle = z.object({
  ...targetTenant,
  branch: text(120).optional(),
  group: text(120).optional(),
  assetType: assetType.optional(),
  unitCode: requiredText(40),
  plate: requiredText(20),
  brandModel: text(120).optional(),
  brand: text(60).optional(),
  model: text(60).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  driverName: text(120).optional(),
  /** Not needed when connection = smartphone (no hardware). */
  imei: z.string().trim().regex(/^\d{15}$/, 'debe tener exactamente 15 dígitos').optional(),
  protocol: protocol.optional(),
  connection: z.enum(['dashcam', 'traccar', 'obd', 'smartphone']).optional(),
  deviceModel: text(120).optional(),
  deviceCatalogId: text(60).optional(),
  driverId: id.optional(),
  engineHours: count(1_000_000).optional(),
  odometerKm: count(10_000_000).optional(),
});

export const addMaintenance = z.object({
  vehicleId: id,
  type: maintenanceType.optional(),
  title: requiredText(200),
  workshopOrTech: text(200).optional(),
  cost: money.optional(),
  notes: text(2000).optional(),
  nextServiceDate: isoDate.optional(),
  clearFaults: z.boolean().optional(),
});

const workOrderPart = z.object({
  sku: requiredText(60),
  name: requiredText(200),
  category: partCategory,
  quantity: z.coerce.number().positive().max(100_000),
  unitCost: money,
  /** Currency of unitCost when it is not the company's (converted on the server). */
  currency: currencyCode.optional(),
});

export const createWorkOrder = z.object({
  vehicleId: id,
  planId: id.optional().or(z.literal('')),
  type: maintenanceType.optional(),
  priority: workOrderPriority.optional(),
  title: requiredText(200),
  workshopOrTech: text(200).optional(),
  scheduledDate: isoDate.optional(),
  parts: z.array(workOrderPart).max(200).optional(),
  laborCost: money.optional(),
  laborCurrency: currencyCode.optional(),
  notes: text(2000).optional(),
  clearFaultsOnClose: z.boolean().optional(),
});

export const updateWorkOrder = z.object({
  status: workOrderStatus.optional(),
  priority: workOrderPriority.optional(),
  workshopOrTech: text(200).optional(),
  scheduledDate: isoDate.optional(),
  notes: text(2000).optional(),
  laborCost: money.optional(),
  laborCurrency: currencyCode.optional(),
  parts: z.array(workOrderPart).max(200).optional(),
  clearFaultsOnClose: z.boolean().optional(),
  nextServiceDate: isoDate.optional(),
});

const planAssetType = z.enum(['vehiculo', 'maquinaria_pesada', 'ambos']);
export const createPreventivePlan = z.object({
  ...targetTenant,
  name: requiredText(200),
  assetType: planAssetType.optional(),
  intervalHours: count(100_000).optional(),
  intervalKm: count(1_000_000).optional(),
  intervalDays: count(3650).optional(),
  estimatedCost: money.optional(),
  checklistFocus: text(1000).optional(),
});
export const updatePreventivePlan = z.object({
  name: requiredText(200).optional(),
  assetType: planAssetType.optional(),
  intervalHours: count(100_000).optional(),
  intervalKm: count(1_000_000).optional(),
  intervalDays: count(3650).optional(),
  estimatedCost: money.optional(),
  checklistFocus: text(1000).optional(),
  active: z.boolean().optional(),
});
export const assignPreventivePlan = z.object({
  vehicleIds: z.array(id).min(1, 'selecciona al menos una unidad').max(500),
});

export const upsertPart = z.object({
  ...targetTenant,
  sku: requiredText(60),
  name: requiredText(200),
  category: z.enum(['refaccion', 'insumo']).optional(),
  unit: text(20).optional(),
  stockQty: z.coerce.number().nonnegative().max(1_000_000).optional(),
  minStock: z.coerce.number().nonnegative().max(1_000_000).optional(),
  unitCost: money.optional(),
  unitCostCurrency: currencyCode.optional(),
  warehouseLocation: text(120).optional(),
});
export const adjustStock = z.object({
  deltaQty: z.coerce
    .number()
    .finite()
    .refine((n) => n !== 0, 'no puede ser 0')
    .refine((n) => Math.abs(n) <= 1_000_000, 'fuera de rango'),
  reason: text(300).optional(),
});

export const reviewChecklist = z.object({
  decision: z.enum(['apto', 'apto_con_restriccion', 'no_apto']),
  note: text(1000).optional(),
  createWorkOrder: z.boolean().optional(),
}).refine((b) => b.decision === 'apto' || Boolean(b.note?.trim()), {
  message: 'explica la restricción o por qué la unidad no está apta',
  path: ['note'],
});

export const createChecklist = z.object({
  vehicleId: id,
  driverName: text(120).optional(),
  shift: z.enum(['Matutino', 'Vespertino', 'Nocturno']).optional(),
  items: z
    .array(
      z.object({
        id: id,
        label: requiredText(300),
        status: z.enum(['ok', 'falla', 'na']),
        note: text(1000).optional(),
      })
    )
    .min(1, 'agrega al menos un punto de verificación')
    .max(100),
  summaryNote: text(2000).optional(),
  createWorkOrderIfFailed: z.boolean().optional(),
});

// ---- Dashcams ---------------------------------------------------------------

export const createDashcamDriver = z.object({
  ...targetTenant,
  vendorFamily: z.enum(['howen_streamax', 'jimi_concox', 'teltonika_fmc', 'hikvision_dahua', 'jt808_generico']).optional(),
  vendorName: requiredText(120),
  modelSeries: requiredText(120),
  driverCode: requiredText(80),
  driverVersion: text(40).optional(),
  protocol: protocol.optional(),
  defaultPort: z.coerce.number().int().min(1).max(65535).optional(),
  maxChannels: z.coerce.number().int().min(1).max(16).optional(),
  defaultBitrateKbps: z.coerce.number().int().min(64).max(20_000).optional(),
  supportedFeatures: z
    .object({
      adas: z.boolean().optional(),
      dms: z.boolean().optional(),
      bsd: z.boolean().optional(),
      canJ1939: z.boolean().optional(),
      rs232: z.boolean().optional(),
      intercomAudio: z.boolean().optional(),
      dualSdSsd: z.boolean().optional(),
      gSensor: z.boolean().optional(),
    })
    .optional(),
  notes: text(2000).optional(),
});

const dashcamConfig = {
  driverId: id,
  tcpPort: z.coerce.number().int().min(1).max(65535).optional(),
  activeChannels: z.array(text(40)).max(16).optional(),
  resolution: z.enum(['1080p_30fps', '720p_30fps', '720p_15fps']).optional(),
  bitrateKbps: z.coerce.number().int().min(64).max(20_000).optional(),
  gpsIntervalSec: z.coerce.number().int().min(1).max(3600).optional(),
  preEventSec: z.coerce.number().int().min(0).max(120).optional(),
  postEventSec: z.coerce.number().int().min(0).max(300).optional(),
  gSensorThresholdG: z.coerce.number().min(0.05).max(16).optional(),
  features: z
    .object({
      adasEnabled: z.boolean().optional(),
      dmsEnabled: z.boolean().optional(),
      bsdEnabled: z.boolean().optional(),
      intercomEnabled: z.boolean().optional(),
      loopRecordingSd: z.boolean().optional(),
      canBusEnabled: z.boolean().optional(),
      rs232Peripheral: z.enum(['ninguno', 'rfid_operador', 'sensor_combustible', 'dualcam_uart']).optional(),
    })
    .optional(),
};
export const updateDashcamConfig = z.object(dashcamConfig);
export const batchDashcamConfig = z.object({
  ...dashcamConfig,
  deviceIds: z.array(id).min(1, 'selecciona al menos una unidad').max(500),
});

// ---- Alerts, incidents, video ----------------------------------------------

export const updateIncident = z.object({
  status: z.enum(['abierto', 'en_investigacion', 'escalado', 'resuelto']).optional(),
  resolutionNote: text(2000).optional(),
  assignee: text(120).optional(),
});

export const createAlertRule = z.object({
  ...targetTenant,
  name: requiredText(120),
  conditionType: z
    .enum(['velocidad', 'geocerca', 'fatiga_dms', 'colision_g', 'desconexion_cam', 'panico', 'licencia_vencimiento'])
    .optional(),
  thresholdLabel: requiredText(120),
  priority: priority.optional(),
  autoCreateClip: z.boolean().optional(),
  notifyQueue: text(120).optional(),
});

export const requestStream = z.object({
  vehicleId: id,
  channel: z.enum(['ch1_frontal', 'ch2_cabina', 'dual']).optional(),
});

// ---- Sizing (global, superadmin only) ---------------------------------------

export const updateSizing = z.object({
  vehiclesCount: count(1_000_000).optional(),
  gpsIntervalSec: z.coerce.number().int().min(1).max(3600).optional(),
  videoMode: z.enum(['clips_eventos', 'bajo_demanda', 'grabacion_continua']).optional(),
  retentionDays: count(3650).optional(),
  hostingModel: z.enum(['cloud_linux', 'on_premise', 'hibrido']).optional(),
  concurrentUsers: count(100_000).optional(),
  stages: z
    .array(
      z.object({
        stage: z.coerce.number().int().min(1).max(100),
        title: requiredText(200),
        focus: text(1000),
        deliverables: z.array(text(200)).max(50),
        status: z.enum(['completada', 'en_progreso', 'pendiente']),
      })
    )
    .max(50)
    .optional(),
});

// ---- Device connection (camera → Starlink → platform) ------------------------

export const updateDeviceConnection = z.object({
  terminalId: z.string().trim().regex(/^\d{6,20}$/, 'debe tener entre 6 y 20 dígitos'),
  uplink: z.enum(['wifi_starlink', 'ethernet_starlink', 'celular']),
  wifiSsid: text(32).optional(),
});

export const assignObdDevice = z.object({
  imei: z.string().trim().regex(/^\d{15}$/, 'el IMEI tiene 15 dígitos'),
  catalogModelId: z.string().trim().max(60).optional(),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'el VIN tiene 17 caracteres (sin I, O ni Q)')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** APN of the SIM; empty clears it. */
  apn: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{0,63}$/, 'APN inválido')
    .optional(),
});

export const phoneServerUrl = z.object({
  /** null restores the default (http://DEVICE_SERVER_HOST:5055). */
  url: z
    .string()
    .trim()
    .max(200)
    .refine((v) => {
      try {
        const u = new URL(v);
        return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname) && !u.search && !u.hash && !u.username;
      } catch {
        return false;
      }
    }, 'escribí una URL completa que empiece con http:// o https://, sin parámetros')
    .refine((v) => {
      try {
        const u = new URL(v);
        return !(u.hostname.endsWith('.devtunnels.ms') && u.port);
      } catch {
        return true;
      }
    }, 'los túneles de VS Code (devtunnels.ms) no llevan puerto al final: el puerto ya va en el nombre (…-5055.brs.devtunnels.ms)')
    .transform((v) => v.replace(/\/+$/, ''))
    .nullable(),
});

/** Host for devices that speak raw TCP (cameras, OBD-II): no http(s)://, paths, ports or HTTP-only tunnels. */
const tcpHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((v) => !/^[a-z]+:\/\//.test(v), 'el equipo usa TCP: escribí solo el host, sin http:// ni https://')
  .refine(
    (v) => !v.endsWith('.devtunnels.ms'),
    'los túneles de VS Code solo transmiten HTTP/HTTPS y el equipo usa TCP: usá la IP pública con el puerto reenviado o un túnel TCP (ngrok, playit.gg)'
  )
  .refine(
    (v) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(v),
    'host inválido: solo el nombre o la IP, sin puerto ni barras'
  );
const tcpPort = z.coerce.number().int().min(1, 'puerto inválido').max(65535, 'puerto inválido');

/** Host/port for OBD-II trackers (Teltonika protocol over TCP). */
export const obdServer = z.object({
  server: z.object({ host: tcpHost, port: tcpPort }).nullable(),
});

/** Addresses for the cameras: JT/T 808 and JT/T 1078 (video may use another host, e.g. a second TCP tunnel). */
export const cameraServer = z.object({
  server: z
    .object({
      host: tcpHost,
      jt808Port: tcpPort,
      videoHost: tcpHost.optional().or(z.literal('').transform(() => undefined)),
      jt1078Port: tcpPort,
    })
    .nullable(),
});

export const assignDriverPhone = z.object({
  platform: z.enum(['android', 'ios'], 'elegí Android o iPhone'),
  regenerate: z.boolean().optional(),
});

export const obdCommand = z.object({
  commandId: z.string().trim().min(1).max(40),
  option: z.string().trim().max(40).optional(),
});

// ---- Traccar forwarding (tolerant: only the fields we use are required) -------

const traccarDevice = z.looseObject({
  uniqueId: z.coerce.string().trim().min(1).max(64),
  name: z.string().max(200).optional(),
});

const traccarPosition = z.looseObject({
  id: z.coerce.number().int().optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  speed: z.coerce.number().min(0).max(1000).optional(),
  course: z.coerce.number().min(0).max(360).optional(),
  /** Fix accuracy in meters (Traccar Client / OsmAnd). */
  accuracy: z.coerce.number().min(0).optional(),
  fixTime: z.string().min(1),
  serverTime: z.string().optional(),
  attributes: z
    .looseObject({
      odometer: z.coerce.number().optional(),
      totalDistance: z.coerce.number().optional(),
      ignition: z.boolean().optional(),
      alarm: z.string().optional(),
    })
    .optional(),
});

export const traccarPositionForward = z.looseObject({
  position: traccarPosition,
  device: traccarDevice,
});

export const traccarEventForward = z.looseObject({
  event: z.looseObject({
    type: z.string().min(1).max(60),
    eventTime: z.string().optional(),
    attributes: z.looseObject({ alarm: z.string().optional(), result: z.coerce.string().optional() }).optional(),
  }),
  position: traccarPosition.partial().optional(),
  device: traccarDevice,
});

// ---- Companies (superadmin wizard) ---------------------------------------------


const branches = z
  .array(requiredText(80))
  .min(1, 'agrega al menos una sucursal')
  .max(20)
  .refine((list) => new Set(list.map((b) => b.toLowerCase())).size === list.length, 'hay sucursales repetidas');
const retention = z.coerce
  .number()
  .int()
  .refine((n) => (RETENTION_DAYS as readonly number[]).includes(n), 'debe ser 15, 30, 45, 60 o 90 días');

export const createTenant = z.object({
  company: z.object({
    name: z.string().trim().min(2, 'es obligatoria').max(120),
    cuit: z.string().trim().min(1, 'es obligatorio').max(20),
    city: requiredText(120),
    branches,
    contactName: requiredText(120),
    contactEmail: z.string().trim().email('email inválido').max(160),
    contactPhone: z.string().trim().min(6, 'teléfono inválido').max(40),
  }),
  service: z.object({
    status: z.enum(['activo', 'piloto']),
    planTier: z.enum(PLAN_TIERS),
    vehicleQuota: z.coerce.number().int().min(1).max(5000),
    retentionDays: retention,
    currency: currencyCode,
    referenceCurrency: currencyCode.optional(),
  }),
  admin: z.object({
    name: requiredText(120),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(USERNAME_PATTERN, 'solo minúsculas, números, punto, guion o guion bajo (3 a 40)'),
  }),
  templates: z.object({ preventivePlans: z.boolean(), alertRules: z.boolean() }),
});

export const updateTenant = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  cuit: z.string().trim().min(1).max(20).optional(),
  city: requiredText(120).optional(),
  branches: branches.optional(),
  contactName: requiredText(120).optional(),
  contactEmail: z.string().trim().email('email inválido').max(160).optional(),
  contactPhone: z.string().trim().min(6).max(40).optional(),
  status: z.enum(['activo', 'piloto', 'suspendido']).optional(),
  planTier: z.enum(PLAN_TIERS).optional(),
  vehicleQuota: z.coerce.number().int().min(1).max(5000).optional(),
  retentionDays: retention.optional(),
  /** The company currency itself changes through PUT /api/tenants/:id/currency (with conversion). */
  referenceCurrency: currencyCode.optional(),
});

// ---- Drivers (registry) -------------------------------------------------------

const strictDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (AAAA-MM-DD)');
const driverDocType = z.enum(['dni', 'licencia', 'linti', 'psicofisico', 'cargas_peligrosas', 'operador_maquinaria', 'antecedentes', 'libre_deuda', 'art']);
const driverDocument = z.object({
  type: driverDocType,
  number: text(60).optional(),
  issuer: text(120).optional(),
  issuedAt: strictDate.optional(),
  expiresAt: strictDate.optional(),
});
const driverFields = {
  firstName: requiredText(60),
  lastName: requiredText(60),
  dni: z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{7,8}$/, 'debe tener 7 u 8 dígitos')),
  cuil: z.string().trim().transform((v) => v.replace(/\D/g, '')).pipe(z.string().regex(/^\d{11}$/, 'debe tener 11 dígitos')),
  birthDate: strictDate,
  phone: requiredText(40),
  email: z.union([z.literal(''), z.string().trim().email('email inválido').max(120)]).optional(),
  address: text(200).optional(),
  emergencyContact: z.object({ name: text(120), phone: text(40) }).optional(),
  employeeNumber: text(40).optional(),
  hireDate: strictDate.optional(),
  branch: requiredText(120),
  profile: z.enum(['liviano', 'profesional', 'maquinaria']),
  dangerousGoods: z.boolean().optional(),
  licenseClasses: z.array(z.string().trim().max(4)).min(1, 'elige al menos una clase').max(19),
  licenseJurisdiction: text(120).optional(),
  documents: z.array(driverDocument).max(9),
};

export const createDriver = z.object({
  ...targetTenant,
  ...driverFields,
  vehicleId: id.optional(),
});

export const updateDriver = z
  .object(driverFields)
  .partial()
  .extend({ vehicleId: id.nullable().optional() });

export const verifyDriverDocument = z.object({
  decision: z.enum(['verificado', 'rechazado']),
  reason: text(200).optional(),
});

export const disableDriver = z.object({
  reason: requiredText(60),
  note: text(400).optional(),
});


// ---------- Currencies (superadmin) ----------

export const updateCurrency = z.object({
  name: requiredText(60).optional(),
  symbol: requiredText(8).optional(),
  decimals: z.coerce.number().int().min(0).max(4).optional(),
  enabled: z.boolean().optional(),
  suggestSource: text(60).optional(),
});

export const addExchangeRate = z.object({
  perUsd: z.coerce.number().finite().positive().max(1_000_000_000),
  effectiveAt: z.string().trim().max(40).optional(),
  source: text(60).optional(),
  note: text(300).optional(),
});

export const setTenantCurrency = z.object({
  currency: currencyCode,
  /** convertir: converts every amount; rotulo: only relabels. Ignored the first time (amounts kept). */
  mode: z.enum(['convertir', 'rotulo']).default('convertir'),
});

export const platformReferenceCurrency = z.object({ currency: currencyCode });
