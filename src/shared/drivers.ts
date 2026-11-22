import { CUIT_MESSAGES, cuitProblem, normalizeCuit } from './cuit.ts';

/**
 * Driver authorization rules (Argentina, Ley 24.449 license classes) shared by the
 * server and the UI, so the wizard can preview exactly what the server will decide.
 */

export type DriverProfile = 'liviano' | 'profesional' | 'maquinaria';

export type DriverDocType =
  | 'dni'
  | 'licencia'
  | 'linti'
  | 'psicofisico'
  | 'cargas_peligrosas'
  | 'operador_maquinaria'
  | 'antecedentes'
  | 'libre_deuda'
  | 'art';

export interface DriverDocumentFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface DriverDocument {
  type: DriverDocType;
  number?: string;
  issuer?: string;
  issuedAt?: string;
  /** ISO date (YYYY-MM-DD). DNI has none. */
  expiresAt?: string;
  file?: DriverDocumentFile;
  /** Admin review of the document against its file. Missing = pending. */
  verification?: DocumentVerification;
}

export type VerificationStatus = 'pendiente' | 'verificado' | 'rechazado';

export interface DocumentVerification {
  status: VerificationStatus;
  /** Who verified or rejected it, and when. */
  by?: string;
  at?: string;
  /** Rejection reason. */
  reason?: string;
}

export const verificationStatus = (doc?: DriverDocument): VerificationStatus => doc?.verification?.status ?? 'pendiente';

export const REJECTION_REASONS = ['Ilegible', 'Datos no coinciden', 'Vencido', 'Documento incorrecto', 'Otro'] as const;

export type DriverAuthState = 'habilitado' | 'por_vencer' | 'pendiente' | 'no_autorizado' | 'deshabilitado';

export interface DriverAuthorization {
  state: DriverAuthState;
  /** Human-readable causes, most important first. */
  reasons: string[];
  /** Earliest expiry among required documents (ISO date), if any. */
  nextExpiry?: string;
  nextExpiryDoc?: DriverDocType;
  daysToExpiry?: number;
  /** Required documents that have data but no attached file. */
  missingFiles: DriverDocType[];
  /** Required documents (with complete data) still waiting for an admin review. */
  pendingVerification: DriverDocType[];
}

export const EXPIRY_WARNING_DAYS = 30;

export const DRIVER_PROFILES: Record<DriverProfile, { label: string; description: string }> = {
  liviano: { label: 'Vehículo liviano', description: 'Autos, utilitarios y camionetas (clase B).' },
  profesional: { label: 'Chofer profesional', description: 'Camiones, semirremolques o pasajeros (clases C, D o E). Exige LiNTI y psicofísico.' },
  maquinaria: { label: 'Operador de maquinaria', description: 'Maquinaria vial o agrícola (clases E.2 o G). Exige certificado de operador.' },
};

export interface DocTypeMeta {
  label: string;
  short: string;
  hasExpiry: boolean;
  numberLabel: string;
  issuerLabel?: string;
  help: string;
}

export const DOC_TYPES: Record<DriverDocType, DocTypeMeta> = {
  dni: { label: 'DNI', short: 'DNI', hasExpiry: false, numberLabel: 'Número de DNI', help: 'Frente y dorso en un solo PDF o foto.' },
  licencia: {
    label: 'Licencia de conducir',
    short: 'Licencia',
    hasExpiry: true,
    numberLabel: 'Número de licencia',
    issuerLabel: 'Municipio o jurisdicción',
    help: 'Licencia Nacional de Conducir, frente y dorso.',
  },
  linti: {
    label: 'LiNTI (CNRT)',
    short: 'LiNTI',
    hasExpiry: true,
    numberLabel: 'Número de LiNTI',
    help: 'Licencia Nacional Habilitante para transporte interjurisdiccional de cargas o pasajeros.',
  },
  psicofisico: {
    label: 'Apto psicofísico',
    short: 'Psicofísico',
    hasExpiry: true,
    numberLabel: 'Número de certificado',
    issuerLabel: 'Prestador',
    help: 'Examen psicofísico vigente para conducción profesional.',
  },
  cargas_peligrosas: {
    label: 'Curso de cargas peligrosas',
    short: 'Cargas peligrosas',
    hasExpiry: true,
    numberLabel: 'Número de certificado',
    help: 'Capacitación obligatoria para transportar mercancías peligrosas.',
  },
  operador_maquinaria: {
    label: 'Certificado de operador de maquinaria',
    short: 'Operador',
    hasExpiry: true,
    numberLabel: 'Número de certificado',
    issuerLabel: 'Entidad certificadora',
    help: 'Habilitación para operar el tipo de equipo asignado.',
  },
  antecedentes: {
    label: 'Certificado de antecedentes penales',
    short: 'Antecedentes',
    hasExpiry: true,
    numberLabel: 'Número de certificado',
    help: 'Registro Nacional de Reincidencia. Se suele pedir renovado cada año.',
  },
  libre_deuda: {
    label: 'Libre deuda de infracciones',
    short: 'Libre deuda',
    hasExpiry: true,
    numberLabel: 'Número de constancia',
    help: 'Constancia de no adeudar multas de tránsito.',
  },
  art: { label: 'Constancia de ART', short: 'ART', hasExpiry: true, numberLabel: 'Número de póliza', help: 'Cobertura de riesgos del trabajo.' },
};

export const OPTIONAL_DOCS: DriverDocType[] = ['antecedentes', 'libre_deuda', 'art'];

export function requiredDocs(profile: DriverProfile, dangerousGoods: boolean): DriverDocType[] {
  const docs: DriverDocType[] = ['dni', 'licencia'];
  if (profile === 'profesional') docs.push('linti', 'psicofisico');
  if (profile === 'maquinaria') docs.push('operador_maquinaria');
  if (dangerousGoods) docs.push('cargas_peligrosas');
  return docs;
}

export const LICENSE_CLASSES: Array<{ code: string; description: string; professional: boolean }> = [
  { code: 'A.1', description: 'Ciclomotores', professional: false },
  { code: 'A.2', description: 'Motos hasta 300 cc', professional: false },
  { code: 'A.3', description: 'Motos de más de 300 cc', professional: false },
  { code: 'B.1', description: 'Autos y camionetas hasta 3.500 kg', professional: false },
  { code: 'B.2', description: 'B.1 con acoplado hasta 750 kg', professional: false },
  { code: 'C.1', description: 'Camiones sin acoplado hasta 12.000 kg', professional: true },
  { code: 'C.2', description: 'Camiones sin acoplado hasta 24.000 kg', professional: true },
  { code: 'C.3', description: 'Camiones sin acoplado de más de 24.000 kg', professional: true },
  { code: 'D.1', description: 'Transporte de pasajeros hasta 8 plazas', professional: true },
  { code: 'D.2', description: 'Transporte de pasajeros hasta 20 plazas', professional: true },
  { code: 'D.3', description: 'Transporte de pasajeros de más de 20 plazas', professional: true },
  { code: 'D.4', description: 'Servicios de urgencia y emergencia', professional: true },
  { code: 'E.1', description: 'Camiones articulados o con acoplado', professional: true },
  { code: 'E.2', description: 'Maquinaria especial no agrícola', professional: true },
  { code: 'E.3', description: 'Carga peligrosa', professional: true },
  { code: 'F', description: 'Vehículos adaptados', professional: false },
  { code: 'G.1', description: 'Tractores agrícolas', professional: false },
  { code: 'G.2', description: 'Maquinaria especial agrícola', professional: false },
  { code: 'G.3', description: 'Trenes agrícolas', professional: false },
];

const CLASS_CODES = new Set(LICENSE_CLASSES.map((c) => c.code));
export const isLicenseClass = (code: string) => CLASS_CODES.has(code);

/** At least one of these classes is needed for the profile. */
export function classesForProfile(profile: DriverProfile): string[] {
  if (profile === 'liviano') return ['B.1', 'B.2'];
  if (profile === 'maquinaria') return ['E.2', 'G.1', 'G.2', 'G.3'];
  return ['C.1', 'C.2', 'C.3', 'D.1', 'D.2', 'D.3', 'D.4', 'E.1', 'E.3'];
}

export const hasProfessionalClass = (classes: string[]) =>
  classes.some((c) => LICENSE_CLASSES.find((l) => l.code === c)?.professional);

/** Minimum age: 21 for professional classes, 17 otherwise. */
export const minimumAge = (classes: string[]) => (hasProfessionalClass(classes) ? 21 : 17);

export function ageOn(birthDate: string, today: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1;
  return age;
}

/** Whole days from today (local date) to an ISO date; negative when already past. */
export function daysUntil(isoDate: string, today: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - base) / 86_400_000);
}

export const formatDateAr = (isoDate: string) => {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
};

export const normalizeDni = (raw: string) => raw.replace(/\D/g, '');
export const isValidDni = (dni: string) => /^\d{7,8}$/.test(dni);

/** Returns a problem description for the CUIL, or null when valid and consistent with the DNI. */
export function cuilProblem(cuil: string, dni?: string): string | null {
  const digits = normalizeCuit(cuil);
  const base = cuitProblem(digits);
  if (base) return CUIT_MESSAGES[base].replace('CUIT', 'CUIL');
  if (!['20', '23', '24', '27'].includes(digits.slice(0, 2))) return 'El CUIL de una persona empieza con 20, 23, 24 o 27.';
  if (dni && isValidDni(dni) && digits.slice(2, 10) !== dni.padStart(8, '0')) return 'El CUIL no coincide con el DNI.';
  return null;
}

/** Subset of Driver needed to evaluate authorization. */
export interface AuthorizationInput {
  profile?: DriverProfile;
  dangerousGoods?: boolean;
  licenseClasses?: string[];
  documents?: DriverDocument[];
  enabled?: boolean;
  disabledReason?: string;
}

export function computeDriverAuthorization(driver: AuthorizationInput, today: Date = new Date()): DriverAuthorization {
  const profile = driver.profile ?? 'liviano';
  const required = requiredDocs(profile, Boolean(driver.dangerousGoods));
  const docs = new Map((driver.documents ?? []).map((d) => [d.type, d]));
  const blocking: string[] = [];
  const warnings: string[] = [];
  const missingFiles: DriverDocType[] = [];
  const pendingVerification: DriverDocType[] = [];
  const pendingNotes: string[] = [];
  let nextExpiry: string | undefined;
  let nextExpiryDoc: DriverDocType | undefined;

  for (const type of required) {
    const meta = DOC_TYPES[type];
    const doc = docs.get(type);
    if (!doc || !doc.number?.trim() || (meta.hasExpiry && !doc.expiresAt)) {
      blocking.push(`Falta ${meta.label.toLowerCase().startsWith('dni') ? 'el DNI' : meta.label}.`);
      continue;
    }
    if (!doc.file) missingFiles.push(type);
    const review = verificationStatus(doc);
    if (review === 'rechazado') {
      blocking.push(`${meta.label}: documento rechazado${doc.verification?.reason ? ` (${doc.verification.reason})` : ''}.`);
    } else if (review === 'pendiente') {
      pendingVerification.push(type);
    }
    if (meta.hasExpiry && doc.expiresAt) {
      const days = daysUntil(doc.expiresAt, today);
      if (days < 0) blocking.push(`${meta.label} vencida el ${formatDateAr(doc.expiresAt)}.`);
      else if (days <= EXPIRY_WARNING_DAYS) warnings.push(`${meta.label} vence el ${formatDateAr(doc.expiresAt)}.`);
      if (!nextExpiry || doc.expiresAt < nextExpiry) {
        nextExpiry = doc.expiresAt;
        nextExpiryDoc = type;
      }
    }
  }

  const classes = driver.licenseClasses ?? [];
  const needed = classesForProfile(profile);
  if (!classes.some((c) => needed.includes(c))) {
    blocking.push(`La licencia no tiene una clase para ${DRIVER_PROFILES[profile].label.toLowerCase()} (${needed.join(', ')}).`);
  }
  if (driver.dangerousGoods && profile === 'profesional' && !classes.includes('E.3')) {
    blocking.push('Para cargas peligrosas la licencia debe incluir la clase E.3.');
  }

  if (pendingVerification.length) {
    pendingNotes.push(
      `Falta verificar: ${pendingVerification.map((t) => DOC_TYPES[t].short).join(', ')}${missingFiles.some((t) => pendingVerification.includes(t)) ? ' (adjunta el archivo para poder verificar)' : ''}.`
    );
  }

  const daysToExpiry = nextExpiry ? daysUntil(nextExpiry, today) : undefined;
  const base = { nextExpiry, nextExpiryDoc, daysToExpiry, missingFiles, pendingVerification };

  if (driver.enabled === false) {
    return { state: 'deshabilitado', reasons: [`Deshabilitado${driver.disabledReason ? `: ${driver.disabledReason}` : ''}.`, ...blocking], ...base };
  }
  if (blocking.length) return { state: 'no_autorizado', reasons: blocking, ...base };
  if (pendingNotes.length) return { state: 'pendiente', reasons: [...pendingNotes, ...warnings], ...base };
  if (warnings.length) return { state: 'por_vencer', reasons: warnings, ...base };
  return { state: 'habilitado', reasons: [], ...base };
}

export const AUTH_STATE_LABELS: Record<DriverAuthState, string> = {
  habilitado: 'Habilitado',
  por_vencer: 'Por vencer',
  pendiente: 'Pendiente de verificación',
  no_autorizado: 'No autorizado',
  deshabilitado: 'Deshabilitado',
};

export const DISABLE_REASONS = ['Baja laboral', 'Suspensión', 'Licencia médica', 'Vacaciones prolongadas', 'Otro'] as const;

/** Accent/case-insensitive text key for search. */
export const foldText = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export const DRIVER_PAGE_SIZES = [10, 25, 50] as const;
export const DRIVER_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const DRIVER_FILE_TYPES: Record<string, string> = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' };

/**
 * Whether a document change must send it back to review: any of its data or its file,
 * plus the licence classes/jurisdiction for the licence and the DNI for the DNI document.
 */
export function needsReverification(
  before: Pick<DriverDocument, 'number' | 'issuer' | 'issuedAt' | 'expiresAt'> & { fileId?: string },
  after: Pick<DriverDocument, 'number' | 'issuer' | 'issuedAt' | 'expiresAt'> & { fileId?: string }
): string[] {
  const changed: string[] = [];
  if ((before.number ?? '') !== (after.number ?? '')) changed.push('número');
  if ((before.issuer ?? '') !== (after.issuer ?? '')) changed.push('emisor');
  if ((before.issuedAt ?? '') !== (after.issuedAt ?? '')) changed.push('fecha de emisión');
  if ((before.expiresAt ?? '') !== (after.expiresAt ?? '')) changed.push('vencimiento');
  if ((before.fileId ?? '') !== (after.fileId ?? '')) changed.push('archivo');
  return changed;
}

