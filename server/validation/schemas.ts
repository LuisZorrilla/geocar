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
const money = z.coerce.number().finite().nonnegative().max(10_000_000);
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
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  driverName: text(120).optional(),
  imei: z.string().trim().regex(/^\d{10,20}$/, 'debe tener entre 10 y 20 dígitos'),
  protocol: protocol.optional(),
  deviceModel: text(120).optional(),
  engineHours: count(1_000_000).optional(),
  odometerKm: count(10_000_000).optional(),
});

export const addMaintenance = z.object({
  vehicleId: id,
  type: maintenanceType.optional(),
  title: requiredText(200),
  workshopOrTech: text(200).optional(),
  costMxn: money.optional(),
  notes: text(2000).optional(),
  nextServiceDate: isoDate.optional(),
  clearFaults: z.boolean().optional(),
});

const workOrderPart = z.object({
  sku: requiredText(60),
  name: requiredText(200),
  category: partCategory,
  quantity: z.coerce.number().positive().max(100_000),
  unitCostMxn: money,
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
  laborCostMxn: money.optional(),
  notes: text(2000).optional(),
  clearFaultsOnClose: z.boolean().optional(),
});

export const updateWorkOrder = z.object({
  status: workOrderStatus.optional(),
  priority: workOrderPriority.optional(),
  workshopOrTech: text(200).optional(),
  scheduledDate: isoDate.optional(),
  notes: text(2000).optional(),
  laborCostMxn: money.optional(),
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
  estimatedCostMxn: money.optional(),
  checklistFocus: text(1000).optional(),
});
export const updatePreventivePlan = z.object({
  name: requiredText(200).optional(),
  assetType: planAssetType.optional(),
  intervalHours: count(100_000).optional(),
  intervalKm: count(1_000_000).optional(),
  intervalDays: count(3650).optional(),
  estimatedCostMxn: money.optional(),
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
  unitCostMxn: money.optional(),
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
  vendorFamily: z.enum(['howen_streamax', 'jimi_concox', 'teltonika_fmc', 'hikvision_dahua']).optional(),
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
    .enum(['velocidad', 'geocerca', 'fatiga_dms', 'colision_g', 'desconexion_cam', 'panico'])
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
