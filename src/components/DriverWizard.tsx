import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  IdCard,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { Driver, DriverListItem, Tenant, Vehicle } from '../shared/types.ts';
import { apiRequest, openWithAuth, uploadWithAuth } from '../lib/api.ts';
import { formatCuit, normalizeCuit } from '../shared/cuit.ts';
import {
  ageOn,
  AUTH_STATE_LABELS,
  classesForProfile,
  computeDriverAuthorization,
  cuilProblem,
  DOC_TYPES,
  DRIVER_FILE_MAX_BYTES,
  DRIVER_FILE_TYPES,
  DRIVER_PROFILES,
  formatDateAr,
  isValidDni,
  LICENSE_CLASSES,
  minimumAge,
  OPTIONAL_DOCS,
  requiredDocs,
  type DriverAuthState,
  type DriverDocType,
  type DocumentVerification,
  type DriverDocumentFile,
  type DriverProfile,
} from '../shared/drivers.ts';
import { Combobox, type ComboOption } from './Combobox.tsx';
import { AuthBadge } from './DriverBadges.tsx';

// ---------------------------------------------------------------- types

interface DocDraft {
  number: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  /** New file chosen in this session, uploaded after saving. */
  file?: File;
  /** File already stored on the server (edit mode). */
  existingFile?: DriverDocumentFile;
  /** The stored file must be deleted on save. */
  removeFile?: boolean;
  /** Admin review saved on the server (edit mode). */
  verification?: DocumentVerification;
}

interface Form {
  tenantId: string;
  firstName: string;
  lastName: string;
  dni: string;
  cuil: string;
  birthDate: string;
  phone: string;
  email: string;
  address: string;
  emergencyName: string;
  emergencyPhone: string;
  profile: DriverProfile;
  dangerousGoods: boolean;
  licenseClasses: string[];
  licenseJurisdiction: string;
  docs: Record<DriverDocType, DocDraft>;
  branch: string;
  employeeNumber: string;
  hireDate: string;
  vehicleId: string;
}

type FieldKey =
  | 'tenantId'
  | 'firstName'
  | 'lastName'
  | 'dni'
  | 'cuil'
  | 'birthDate'
  | 'phone'
  | 'email'
  | 'emergencyPhone'
  | 'licenseClasses'
  | 'licenseNumber'
  | 'licenseExpiry'
  | 'branch'
  | `doc-${DriverDocType}`;
type Errors = Partial<Record<FieldKey, string>>;
type Availability = 'idle' | 'checking' | 'ok' | 'invalido' | 'en_uso' | 'error';

interface UploadState {
  type: DriverDocType;
  file: File;
  progress: number;
  status: 'pendiente' | 'subiendo' | 'ok' | 'error';
  error?: string;
}

const STEPS = [
  { title: 'Datos personales', hint: 'Identidad y contacto del chofer' },
  { title: 'Perfil y licencia', hint: 'Qué conduce y con qué licencia' },
  { title: 'Documentación', hint: 'Datos, vencimientos y archivos' },
  { title: 'Asignación', hint: 'Sucursal, legajo y unidad' },
  { title: 'Revisión', hint: 'Confirma antes de registrar' },
] as const;

const STEP_FIELDS: FieldKey[][] = [
  ['tenantId', 'firstName', 'lastName', 'dni', 'cuil', 'birthDate', 'phone', 'email', 'emergencyPhone'],
  ['licenseClasses', 'licenseNumber', 'licenseExpiry'],
  [
    'doc-dni',
    'doc-licencia',
    'doc-linti',
    'doc-psicofisico',
    'doc-cargas_peligrosas',
    'doc-operador_maquinaria',
    'doc-antecedentes',
    'doc-libre_deuda',
    'doc-art',
  ],
  ['branch'],
  [],
];

const ALL_DOCS = Object.keys(DOC_TYPES) as DriverDocType[];
const emptyDoc = (): DocDraft => ({ number: '', issuer: '', issuedAt: '', expiresAt: '' });

const inputCls = (err?: string) =>
  `w-full px-3 py-2 bg-[#0B1120] border rounded-lg text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none ${
    err ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-800 focus:border-sky-500'
  }`;

const fieldDomId = (k: FieldKey) => `dw-${k}`;
const today = () => new Date();
const isoToday = () => new Date().toISOString().slice(0, 10);

function initialForm(tenant: Tenant, availableTenants: Tenant[] | undefined, driver?: DriverListItem): Form {
  const tenantId = driver?.tenantId ?? (tenant.id === 'all' ? '' : tenant.id);
  const branches = (availableTenants?.find((t) => t.id === tenantId) ?? tenant).branches;
  const docs = Object.fromEntries(ALL_DOCS.map((t) => [t, emptyDoc()])) as Record<DriverDocType, DocDraft>;
  for (const d of driver?.documents ?? []) {
    docs[d.type] = {
      number: d.number ?? '',
      issuer: d.issuer ?? '',
      issuedAt: d.issuedAt ?? '',
      expiresAt: d.expiresAt ?? '',
      existingFile: d.file,
      verification: d.verification,
    };
  }
  return {
    tenantId,
    firstName: driver?.firstName ?? '',
    lastName: driver?.lastName ?? '',
    dni: driver?.dni ?? '',
    cuil: driver?.cuil ? formatCuit(driver.cuil) : '',
    birthDate: driver?.birthDate ?? '',
    phone: driver?.phone ?? '',
    email: driver?.email ?? '',
    address: driver?.address ?? '',
    emergencyName: driver?.emergencyContact?.name ?? '',
    emergencyPhone: driver?.emergencyContact?.phone ?? '',
    profile: driver?.profile ?? 'profesional',
    dangerousGoods: driver?.dangerousGoods ?? false,
    licenseClasses: driver?.licenseClasses ?? [],
    licenseJurisdiction: driver?.licenseJurisdiction ?? 'San Juan',
    docs,
    branch: driver?.branch ?? branches[0] ?? '',
    employeeNumber: driver?.employeeNumber ?? '',
    hireDate: driver?.hireDate ?? '',
    vehicleId: driver?.assignedVehicle?.id ?? '',
  };
}

/** Documents that go to the server: required ones and any optional one with data. */
function docTypesFor(form: Form): DriverDocType[] {
  const required = requiredDocs(form.profile, form.dangerousGoods);
  const optional = OPTIONAL_DOCS.filter((t) => {
    const d = form.docs[t];
    return d.number.trim() || d.expiresAt || d.issuer.trim() || d.file || (d.existingFile && !d.removeFile);
  });
  return [...required, ...optional];
}

function buildPayload(form: Form) {
  const documents = docTypesFor(form)
    .map((type) => {
      const d = form.docs[type];
      const number = type === 'dni' ? form.dni : d.number.trim();
      const issuer = type === 'licencia' ? form.licenseJurisdiction.trim() : d.issuer.trim();
      return {
        type,
        ...(number ? { number } : {}),
        ...(issuer ? { issuer } : {}),
        ...(d.issuedAt ? { issuedAt: d.issuedAt } : {}),
        ...(DOC_TYPES[type].hasExpiry && d.expiresAt ? { expiresAt: d.expiresAt } : {}),
      };
    })
    .filter((d) => d.number || d.expiresAt);
  return {
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    dni: form.dni,
    cuil: normalizeCuit(form.cuil),
    birthDate: form.birthDate,
    phone: form.phone.trim(),
    email: form.email.trim(),
    address: form.address.trim(),
    emergencyContact: form.emergencyName.trim() ? { name: form.emergencyName.trim(), phone: form.emergencyPhone.trim() } : undefined,
    employeeNumber: form.employeeNumber.trim(),
    hireDate: form.hireDate || undefined,
    branch: form.branch,
    profile: form.profile,
    dangerousGoods: form.profile === 'profesional' && form.dangerousGoods,
    licenseClasses: form.licenseClasses,
    licenseJurisdiction: form.licenseJurisdiction.trim(),
    documents,
  };
}

/** Whether the saved review of a document still applies (same data, same file, same classes/DNI). */
function reviewStillValid(form: Form, initial: Form | undefined, type: DriverDocType): boolean {
  const now = form.docs[type];
  const was = initial?.docs[type];
  if (!was?.verification || was.verification.status === 'pendiente') return false;
  if (now.file || now.removeFile) return false;
  if (now.number !== was.number || now.issuer !== was.issuer || now.issuedAt !== was.issuedAt || now.expiresAt !== was.expiresAt) return false;
  if (type === 'licencia') {
    if ([...form.licenseClasses].sort().join() !== [...initial!.licenseClasses].sort().join()) return false;
    if (form.licenseJurisdiction.trim() !== initial!.licenseJurisdiction.trim()) return false;
  }
  if (type === 'dni' && form.dni !== initial!.dni) return false;
  return true;
}

function previewAuthorization(form: Form, enabled: boolean, initial?: Form) {
  const payload = buildPayload(form);
  return computeDriverAuthorization(
    {
      profile: payload.profile,
      dangerousGoods: payload.dangerousGoods,
      licenseClasses: payload.licenseClasses,
      enabled,
      documents: payload.documents.map((d) => {
        const draft = form.docs[d.type];
        const hasFile = Boolean(draft.file || (draft.existingFile && !draft.removeFile));
        const verification = reviewStillValid(form, initial, d.type) ? initial!.docs[d.type].verification : { status: 'pendiente' as const };
        const withReview = { ...d, verification };
        return hasFile ? { ...withReview, file: { id: 'x', name: '', mime: '', size: 0, sha256: '', uploadedAt: '', uploadedBy: '' } } : withReview;
      }),
    },
    today()
  );
}

/** Formats the CUIL while typing: 20-12345678-9. */
function typingCuil(raw: string) {
  const d = raw.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 10) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

function validateField(form: Form, k: FieldKey, needsTenant: boolean): string | undefined {
  switch (k) {
    case 'tenantId':
      return needsTenant && !form.tenantId ? 'Elige la empresa del chofer.' : undefined;
    case 'firstName':
      return form.firstName.trim() ? undefined : 'Ingresa el nombre.';
    case 'lastName':
      return form.lastName.trim() ? undefined : 'Ingresa el apellido.';
    case 'dni':
      return isValidDni(form.dni) ? undefined : 'El DNI debe tener 7 u 8 dígitos.';
    case 'cuil': {
      if (!form.cuil.trim()) return 'Ingresa el CUIL.';
      return cuilProblem(form.cuil, form.dni) ?? undefined;
    }
    case 'birthDate': {
      if (!form.birthDate) return 'Ingresa la fecha de nacimiento.';
      const age = ageOn(form.birthDate, today());
      if (age === null || age < 0 || age > 100) return 'La fecha no es válida.';
      if (age < 17) return 'Debe tener al menos 17 años para conducir.';
      return undefined;
    }
    case 'phone':
      return form.phone.trim().length >= 6 ? undefined : 'Ingresa un teléfono de contacto.';
    case 'email':
      return !form.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) ? undefined : 'El email no es válido.';
    case 'emergencyPhone':
      return form.emergencyName.trim() && !form.emergencyPhone.trim() ? 'Agrega el teléfono del contacto de emergencia.' : undefined;
    case 'licenseClasses': {
      if (!form.licenseClasses.length) return 'Elige al menos una clase de licencia.';
      const age = form.birthDate ? ageOn(form.birthDate, today()) : null;
      const min = minimumAge(form.licenseClasses);
      if (age !== null && age < min) return `Para las clases elegidas la edad mínima es ${min} años (tiene ${age}).`;
      return undefined;
    }
    case 'licenseNumber':
      return form.docs.licencia.number.trim() ? undefined : 'Ingresa el número de licencia.';
    case 'licenseExpiry': {
      const d = form.docs.licencia;
      if (d.issuedAt && d.expiresAt && d.issuedAt > d.expiresAt) return 'El vencimiento es anterior a la emisión.';
      return undefined;
    }
    case 'branch':
      return form.branch ? undefined : 'Elige la sucursal.';
    default: {
      if (k.startsWith('doc-')) {
        const d = form.docs[k.slice(4) as DriverDocType];
        if (d.issuedAt && d.expiresAt && d.issuedAt > d.expiresAt) return 'El vencimiento es anterior a la emisión.';
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------- small pieces

function Field({
  id,
  label,
  hint,
  error,
  status,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <label htmlFor={id} className="text-xs text-slate-300">
          {label}
        </label>
        {status}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-[11px] text-rose-300" aria-live="polite">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function AvailabilityBadge({ state, okText }: { state: Availability; okText: string }) {
  if (state === 'checking')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Verificando…
      </span>
    );
  if (state === 'ok')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
        <Check className="w-3 h-3" aria-hidden /> {okText}
      </span>
    );
  if (state === 'en_uso')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
        <XCircle className="w-3 h-3" aria-hidden /> Ya registrado
      </span>
    );
  return null;
}

const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function fileProblem(file: File): string | null {
  if (!DRIVER_FILE_TYPES[file.type]) return 'Formato no admitido: elige un PDF, JPG o PNG.';
  if (file.size > DRIVER_FILE_MAX_BYTES) return `El archivo pesa ${formatBytes(file.size)}: el máximo es 5 MB.`;
  return null;
}

/** Drop zone + preview for one document's file. */
function FilePicker({
  docType,
  draft,
  driverId,
  onPick,
  onRemove,
  onUndoRemove,
  error,
}: {
  docType: DriverDocType;
  draft: DocDraft;
  driverId?: string;
  onPick: (file: File) => void;
  onRemove: () => void;
  onUndoRemove: () => void;
  error?: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!draft.file || !draft.file.type.startsWith('image/')) {
      setThumb(null);
      return;
    }
    const url = URL.createObjectURL(draft.file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.file]);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onPick(f);
  };
  const inputId = `dw-file-${docType}`;

  const shown = draft.file
    ? { name: draft.file.name, size: draft.file.size, isNew: true }
    : draft.existingFile && !draft.removeFile
      ? { name: draft.existingFile.name, size: draft.existingFile.size, isNew: false }
      : null;

  return (
    <div>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
      {shown ? (
        <div className="flex items-center gap-3 p-2 rounded-lg border border-slate-800 bg-[#0F172A]">
          {thumb ? (
            <img src={thumb} alt="" className="w-10 h-10 rounded object-cover border border-slate-700" />
          ) : (
            <div className="w-10 h-10 rounded bg-slate-800 flex items-center justify-center">
              <FileText className="w-5 h-5 text-slate-300" aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-100 truncate">{shown.name}</div>
            <div className="text-[11px] text-slate-400">
              {formatBytes(shown.size)} · {shown.isNew ? 'se subirá al guardar' : 'guardado'}
            </div>
          </div>
          {!shown.isNew && driverId && (
            <button
              type="button"
              onClick={() => openWithAuth(`/api/drivers/${driverId}/documents/${docType}/file`).catch((err) => window.alert(err.message))}
              className="px-2 py-1 rounded-md text-[11px] text-sky-300 hover:bg-sky-500/10 cursor-pointer"
            >
              Ver
            </button>
          )}
          <button type="button" onClick={() => inputRef.current?.click()} className="px-2 py-1 rounded-md text-[11px] text-slate-300 hover:bg-slate-800 cursor-pointer">
            Reemplazar
          </button>
          <button type="button" onClick={onRemove} className="p-1 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer" aria-label="Quitar archivo">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`flex flex-col sm:flex-row items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed text-xs text-center ${
            dragOver ? 'border-sky-400 bg-sky-500/10' : error ? 'border-rose-500/60' : 'border-slate-700'
          }`}
        >
          <Upload className="w-4 h-4 text-slate-400" aria-hidden />
          <span className="text-slate-400">Arrastra el archivo aquí o</span>
          <label htmlFor={inputId} className="text-sky-300 hover:underline cursor-pointer focus-within:underline">
            elige uno
          </label>
          <span className="text-slate-500">(PDF, JPG o PNG · máx. 5 MB)</span>
        </div>
      )}
      {draft.removeFile && draft.existingFile && !draft.file && (
        <p className="mt-1 text-[11px] text-amber-300">
          Se quitará «{draft.existingFile.name}» al guardar.{' '}
          <button type="button" onClick={onUndoRemove} className="underline cursor-pointer">
            Deshacer
          </button>
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}

function docStatus(type: DriverDocType, d: DocDraft, required: boolean): { tone: string; text: string } {
  const meta = DOC_TYPES[type];
  const hasData = Boolean(d.number.trim() || type === 'dni') && (!meta.hasExpiry || Boolean(d.expiresAt));
  if (!hasData) return required ? { tone: 'text-rose-300', text: 'Falta' } : { tone: 'text-slate-500', text: 'Opcional' };
  if (meta.hasExpiry && d.expiresAt) {
    const days = Math.round((new Date(`${d.expiresAt}T00:00:00`).getTime() - new Date(`${isoToday()}T00:00:00`).getTime()) / 86_400_000);
    if (days < 0) return { tone: 'text-rose-300', text: `Vencido hace ${-days} días` };
    if (days <= 30) return { tone: 'text-amber-300', text: `Vence en ${days} días` };
  }
  const hasFile = d.file || (d.existingFile && !d.removeFile);
  return hasFile ? { tone: 'text-emerald-300', text: 'Completo' } : { tone: 'text-amber-300', text: 'Sin archivo' };
}

// ---------------------------------------------------------------- component

interface DriverWizardProps {
  mode: 'create' | 'edit';
  driver?: DriverListItem;
  tenant: Tenant;
  availableTenants?: Tenant[];
  vehicles: Vehicle[];
  drivers: Driver[];
  onClose: () => void;
  /** Called after every successful save (list refresh); `message` is the confirmation toast. */
  onSaved: (driver: DriverListItem, message: string) => void;
  onViewDriver?: (id: string) => void;
  /** Opens the document review for a driver that was just saved. */
  onVerifyNow?: (id: string) => void;
}

export function DriverWizard({ mode, driver, tenant, availableTenants, vehicles, drivers, onClose, onSaved, onViewDriver, onVerifyNow }: DriverWizardProps) {
  const isEdit = mode === 'edit';
  const needsTenant = !isEdit && tenant.id === 'all';
  const [form, setForm] = useState<Form>(() => initialForm(tenant, availableTenants, driver));
  const initialFormRef = useRef(initialForm(tenant, availableTenants, driver));
  const initialPayload = useRef(JSON.stringify(buildPayload(initialFormRef.current)));
  const initialVehicle = useRef(driver?.assignedVehicle?.id ?? '');
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [dniState, setDniState] = useState<Availability>('idle');
  const [cuilState, setCuilState] = useState<Availability>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState<DriverListItem | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const steps = isEdit ? STEPS.slice(0, 4) : STEPS;
  const lastStep = steps.length - 1;
  const targetTenant = availableTenants?.find((t) => t.id === form.tenantId) ?? (tenant.id === 'all' ? undefined : tenant);
  const branches = targetTenant?.branches ?? [];
  const auth = useMemo(() => previewAuthorization(form, driver?.enabled !== false, isEdit ? initialFormRef.current : undefined), [form, driver?.enabled, isEdit]);
  const required = requiredDocs(form.profile, form.dangerousGoods && form.profile === 'profesional');

  const payloadNow = JSON.stringify(buildPayload(form));
  const filesChanged = ALL_DOCS.some((t) => form.docs[t].file || form.docs[t].removeFile);
  const dirty = payloadNow !== initialPayload.current || filesChanged || form.vehicleId !== initialVehicle.current;

  const update = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setServerError(null);
  };
  const updateDoc = (type: DriverDocType, patch: Partial<DocDraft>) => {
    setForm((f) => ({ ...f, docs: { ...f.docs, [type]: { ...f.docs[type], ...patch } } }));
    setErrors((e) => ({ ...e, [`doc-${type}`]: undefined }));
  };

  const blur = (k: FieldKey) => setErrors((e) => ({ ...e, [k]: validateField(form, k, needsTenant) }));

  // Live duplicate / format check against the server (DNI and CUIL are unique per company).
  const checkAvailability = async (what: 'dni' | 'cuil') => {
    const tenantId = form.tenantId || (tenant.id !== 'all' ? tenant.id : '');
    if (!tenantId) return;
    const value = what === 'dni' ? form.dni : normalizeCuit(form.cuil);
    if (what === 'dni' ? !isValidDni(value) : value.length !== 11) return;
    const setState = what === 'dni' ? setDniState : setCuilState;
    setState('checking');
    try {
      const params = new URLSearchParams({ tenantId, [what]: value, ...(what === 'cuil' ? { dni: form.dni } : {}) });
      if (driver) params.set('except', driver.id);
      const res = await apiRequest<{ dni?: Availability; cuil?: Availability }>(`/api/drivers/availability?${params}`);
      const st = res[what] ?? 'idle';
      setState(st);
      if (st === 'en_uso') {
        setErrors((e) => ({ ...e, [what]: what === 'dni' ? 'Ya hay un chofer con este DNI en la empresa.' : 'Este CUIL ya está registrado.' }));
      }
    } catch {
      setState('error');
    }
  };

  const validateStep = (s: number): Errors => {
    const errs: Errors = {};
    for (const k of STEP_FIELDS[s]) {
      const e = validateField(form, k, needsTenant);
      if (e) errs[k] = e;
    }
    if (s === 0 && dniState === 'en_uso') errs.dni = 'Ya hay un chofer con este DNI en la empresa.';
    if (s === 0 && cuilState === 'en_uso') errs.cuil = 'Este CUIL ya está registrado.';
    return errs;
  };

  const focusFirst = (keys: FieldKey[], errs: Errors) => {
    const first = keys.find((k) => errs[k]);
    if (!first) return;
    requestAnimationFrame(() => document.getElementById(fieldDomId(first))?.focus());
  };

  const goNext = () => {
    const errs = validateStep(step);
    setErrors((e) => ({ ...e, ...errs }));
    if (Object.keys(errs).length) {
      focusFirst(STEP_FIELDS[step], errs);
      return;
    }
    // Prefill the licence number with the DNI (most Argentine licences use it).
    if (step === 0 && !form.docs.licencia.number) updateDoc('licencia', { number: form.dni });
    setStep((s) => Math.min(s + 1, lastStep));
  };

  const goTo = (s: number) => {
    setServerError(null);
    setStep(s);
  };

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const requestClose = () => {
    if (saved || !dirty) onClose();
    else setConfirmDiscard(true);
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!dirty || saved) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, saved]);

  const pickFile = (type: DriverDocType, file: File) => {
    const problem = fileProblem(file);
    if (problem) {
      setErrors((e) => ({ ...e, [`doc-${type}`]: problem }));
      return;
    }
    updateDoc(type, { file, removeFile: false });
  };

  /** Uploads pending files one by one; failures stay listed with a retry button. */
  const runUploads = async (driverId: string, list: UploadState[]): Promise<DriverListItem | null> => {
    let last: DriverListItem | null = null;
    for (const u of list) {
      if (u.status === 'ok') continue;
      setUploads((all) => all.map((x) => (x.type === u.type ? { ...x, status: 'subiendo', progress: 0, error: undefined } : x)));
      try {
        const res = await uploadWithAuth<{ driver: DriverListItem }>(`/api/drivers/${driverId}/documents/${u.type}/file`, u.file, (p) =>
          setUploads((all) => all.map((x) => (x.type === u.type ? { ...x, progress: p } : x)))
        );
        last = res.driver;
        setUploads((all) => all.map((x) => (x.type === u.type ? { ...x, status: 'ok', progress: 1 } : x)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'No se pudo subir.';
        setUploads((all) => all.map((x) => (x.type === u.type ? { ...x, status: 'error', error: msg } : x)));
      }
    }
    return last;
  };

  const routeServerError = (msg: string) => {
    setServerError(msg);
    const map: Array<[RegExp, FieldKey, number]> = [
      [/DNI/i, 'dni', 0],
      [/CUIL/i, 'cuil', 0],
      [/nacimiento/i, 'birthDate', 0],
      [/edad mínima|clase/i, 'licenseClasses', 1],
      [/sucursal/i, 'branch', 3],
    ];
    const hit = map.find(([re]) => re.test(msg));
    if (hit) {
      setErrors((e) => ({ ...e, [hit[1]]: msg }));
      goTo(hit[2]);
      focusFirst([hit[1]], { [hit[1]]: msg });
    }
  };

  const submit = async () => {
    for (let s = 0; s < 4; s++) {
      const errs = validateStep(s);
      if (Object.keys(errs).length) {
        setErrors((e) => ({ ...e, ...errs }));
        setStep(s);
        focusFirst(STEP_FIELDS[s], errs);
        return;
      }
    }
    setSubmitting(true);
    setServerError(null);
    const pending: UploadState[] = ALL_DOCS.filter((t) => form.docs[t].file && docTypesFor(form).includes(t)).map((t) => ({
      type: t,
      file: form.docs[t].file!,
      progress: 0,
      status: 'pendiente',
    }));
    try {
      let result: DriverListItem;
      let message: string;
      if (!isEdit) {
        const res = await apiRequest<{ driver: DriverListItem }>('/api/drivers', {
          method: 'POST',
          body: JSON.stringify({ ...(needsTenant ? { tenantId: form.tenantId } : {}), ...buildPayload(form), ...(form.vehicleId ? { vehicleId: form.vehicleId } : {}) }),
        });
        result = res.driver;
        message = `${result.name} registrado`;
      } else {
        // Send only what changed.
        const now = buildPayload(form) as Record<string, unknown>;
        const before = JSON.parse(initialPayload.current) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(now)) if (JSON.stringify(now[k]) !== JSON.stringify(before[k])) patch[k] = now[k];
        if (form.vehicleId !== initialVehicle.current) patch.vehicleId = form.vehicleId || null;
        result = driver!;
        const notes: string[] = [];
        if (Object.keys(patch).length) {
          const res = await apiRequest<{ driver: DriverListItem; notes: string[] }>(`/api/drivers/${driver!.id}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          });
          result = res.driver;
          notes.push(...res.notes);
        }
        for (const t of ALL_DOCS) {
          if (form.docs[t].removeFile && form.docs[t].existingFile && !form.docs[t].file && docTypesFor(form).includes(t)) {
            const res = await apiRequest<{ driver: DriverListItem }>(`/api/drivers/${driver!.id}/documents/${t}/file`, { method: 'DELETE' });
            result = res.driver;
          }
        }
        message = `Cambios guardados en ${result.name}${notes.length ? ` · ${notes.join('; ')}` : ''}`;
      }
      setUploads(pending);
      const afterUploads = pending.length ? await runUploads(result.id, pending) : null;
      const final = afterUploads ?? result;
      onSaved(final, message);
      if (isEdit && !pending.length) {
        onClose();
        return;
      }
      setSaved(final);
    } catch (err) {
      routeServerError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setSubmitting(false);
    }
  };

  const retryUploads = async () => {
    if (!saved) return;
    setSubmitting(true);
    const updated = await runUploads(saved.id, uploads);
    setSubmitting(false);
    if (updated) {
      setSaved(updated);
      onSaved(updated, `Archivos de ${updated.name} actualizados`);
    }
  };

  const restart = () => {
    setForm(initialForm(tenant, availableTenants));
    initialPayload.current = JSON.stringify(buildPayload(initialForm(tenant, availableTenants)));
    initialVehicle.current = '';
    setErrors({});
    setDniState('idle');
    setCuilState('idle');
    setUploads([]);
    setSaved(null);
    setStep(0);
  };

  const onBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key !== 'Enter' || isEdit || target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA' || target.getAttribute('role') === 'combobox') return;
    e.preventDefault();
    if (step < lastStep) goNext();
  };

  // Units of the target company; the chosen driver replaces whoever drives it now.
  const vehicleOptions = useMemo<ComboOption[]>(() => {
    const tid = form.tenantId || driver?.tenantId;
    return vehicles
      .filter((v) => v.tenantId === tid)
      .sort((a, b) => a.unitCode.localeCompare(b.unitCode))
      .map((v) => {
        const current = v.driverId && v.driverId !== driver?.id ? drivers.find((d) => d.id === v.driverId)?.name : undefined;
        return {
          value: v.id,
          label: `${v.unitCode} · ${v.plate}`,
          description: `${v.brandModel}${current ? ` · hoy: ${current}` : v.driverId === driver?.id && driver ? ' · asignada a este chofer' : ' · sin chofer'}`,
        };
      });
  }, [vehicles, drivers, form.tenantId, driver]);
  const [vehicleText, setVehicleText] = useState(() => vehicleOptions.find((o) => o.value === form.vehicleId)?.label ?? '');
  const chosenVehicle = vehicles.find((v) => v.id === form.vehicleId);
  const replaces = chosenVehicle?.driverId && chosenVehicle.driverId !== driver?.id ? drivers.find((d) => d.id === chosenVehicle.driverId) : undefined;
  const cannotAssign = !isEdit || auth.state === 'no_autorizado' || auth.state === 'deshabilitado' || auth.state === 'pendiente';

  const stepError = (s: number) => STEP_FIELDS[s].some((k) => errors[k]);

  // ------------------------------------------------------------ render
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="dw-title">
      <div className="w-full sm:max-w-3xl bg-[#0F172A] border border-slate-800 sm:rounded-2xl flex flex-col max-h-screen sm:max-h-[94vh]">
        <div className="px-5 pt-4 pb-3 border-b border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <IdCard className="w-5 h-5 text-sky-400 shrink-0" />
              <h2 id="dw-title" className="text-base font-semibold text-slate-100 truncate">
                {saved && !isEdit ? 'Chofer registrado' : isEdit ? `Editar a ${driver?.name}` : 'Registrar chofer'}
              </h2>
            </div>
            <button type="button" onClick={requestClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer" aria-label="Cerrar">
              <X className="w-4 h-4" />
            </button>
          </div>
          {!saved && (
            <>
              <ol className={`grid gap-2 ${isEdit ? 'grid-cols-4' : 'grid-cols-5'}`} aria-label={isEdit ? 'Secciones' : 'Pasos del registro'}>
                {steps.map((s, i) => {
                  const done = !isEdit && i < step;
                  const current = i === step;
                  const reachable = isEdit || i < step;
                  return (
                    <li key={s.title}>
                      <button
                        type="button"
                        disabled={!reachable && !current}
                        onClick={() => reachable && goTo(i)}
                        aria-current={current ? 'step' : undefined}
                        className="w-full text-left disabled:cursor-default cursor-pointer group"
                      >
                        <div className={`h-1 rounded-full ${done || current ? 'bg-sky-500' : stepError(i) ? 'bg-rose-500/70' : 'bg-slate-800'}`} />
                        <div
                          className={`mt-1.5 text-[11px] font-medium flex items-center gap-1 ${
                            current ? 'text-slate-100' : stepError(i) ? 'text-rose-300' : done || isEdit ? 'text-sky-300 group-hover:underline' : 'text-slate-500'
                          }`}
                        >
                          {done ? <Check className="w-3 h-3" /> : <span>{i + 1}.</span>}
                          <span className="truncate">{s.title}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <p className="text-xs text-slate-400">
                {isEdit ? steps[step].hint : `Paso ${step + 1} de ${steps.length} · ${steps[step].hint}`}
              </p>
            </>
          )}
        </div>

        <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 py-4" onKeyDown={onBodyKeyDown}>
          {serverError && !saved && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
              {serverError}
            </div>
          )}

          {saved ? (
            <SavedStep driver={saved} uploads={uploads} isEdit={isEdit} />
          ) : step === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {needsTenant && (
                <div className="sm:col-span-2">
                  <Field id={fieldDomId('tenantId')} label="Empresa *" error={errors.tenantId}>
                    <select
                      id={fieldDomId('tenantId')}
                      className={inputCls(errors.tenantId)}
                      value={form.tenantId}
                      onChange={(e) => {
                        const t = availableTenants?.find((x) => x.id === e.target.value);
                        setForm((f) => ({ ...f, tenantId: e.target.value, branch: t?.branches[0] ?? '', vehicleId: '' }));
                        setVehicleText('');
                        setDniState('idle');
                        setCuilState('idle');
                      }}
                      onBlur={() => blur('tenantId')}
                    >
                      <option value="">Elige la empresa…</option>
                      {availableTenants?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
              <Field id={fieldDomId('firstName')} label="Nombre *" error={errors.firstName}>
                <input id={fieldDomId('firstName')} className={inputCls(errors.firstName)} value={form.firstName} onChange={(e) => update('firstName', e.target.value)} onBlur={() => blur('firstName')} autoComplete="off" aria-invalid={Boolean(errors.firstName)} />
              </Field>
              <Field id={fieldDomId('lastName')} label="Apellido *" error={errors.lastName}>
                <input id={fieldDomId('lastName')} className={inputCls(errors.lastName)} value={form.lastName} onChange={(e) => update('lastName', e.target.value)} onBlur={() => blur('lastName')} autoComplete="off" aria-invalid={Boolean(errors.lastName)} />
              </Field>
              <Field id={fieldDomId('dni')} label="DNI *" hint="Solo números." error={errors.dni} status={<AvailabilityBadge state={dniState} okText="Disponible" />}>
                <input
                  id={fieldDomId('dni')}
                  inputMode="numeric"
                  maxLength={8}
                  className={`${inputCls(errors.dni)} font-mono`}
                  value={form.dni}
                  onChange={(e) => {
                    const dni = e.target.value.replace(/\D/g, '').slice(0, 8);
                    setDniState('idle');
                    setForm((f) => {
                      // Suggest the CUIL middle part from the DNI while the CUIL is still empty or only a prefix.
                      const c = normalizeCuit(f.cuil);
                      const cuil = c.length <= 2 && c ? typingCuil(c + dni.padStart(8, '0')) : f.cuil;
                      return { ...f, dni, cuil };
                    });
                  }}
                  onBlur={() => {
                    blur('dni');
                    void checkAvailability('dni');
                  }}
                  placeholder="30123456"
                  aria-invalid={Boolean(errors.dni)}
                  aria-describedby={errors.dni ? `${fieldDomId('dni')}-error` : `${fieldDomId('dni')}-hint`}
                />
              </Field>
              <Field
                id={fieldDomId('cuil')}
                label="CUIL *"
                hint="Escribe 20, 23, 24 o 27 y se completa con el DNI; falta el dígito final."
                error={errors.cuil}
                status={<AvailabilityBadge state={cuilState} okText="Válido" />}
              >
                <input
                  id={fieldDomId('cuil')}
                  inputMode="numeric"
                  className={`${inputCls(errors.cuil)} font-mono`}
                  value={form.cuil}
                  onChange={(e) => {
                    setCuilState('idle');
                    const digits = e.target.value.replace(/\D/g, '');
                    const filled = digits.length === 2 && form.dni ? digits + form.dni.padStart(8, '0') : digits;
                    update('cuil', typingCuil(filled));
                  }}
                  onBlur={() => {
                    blur('cuil');
                    void checkAvailability('cuil');
                  }}
                  placeholder="20-30123456-7"
                  aria-invalid={Boolean(errors.cuil)}
                  aria-describedby={errors.cuil ? `${fieldDomId('cuil')}-error` : `${fieldDomId('cuil')}-hint`}
                />
              </Field>
              <Field
                id={fieldDomId('birthDate')}
                label="Fecha de nacimiento *"
                error={errors.birthDate}
                status={form.birthDate && ageOn(form.birthDate, today()) !== null ? <span className="text-[11px] text-slate-400">{ageOn(form.birthDate, today())} años</span> : null}
              >
                <input id={fieldDomId('birthDate')} type="date" max={isoToday()} className={inputCls(errors.birthDate)} value={form.birthDate} onChange={(e) => update('birthDate', e.target.value)} onBlur={() => blur('birthDate')} aria-invalid={Boolean(errors.birthDate)} />
              </Field>
              <Field id={fieldDomId('phone')} label="Teléfono *" error={errors.phone}>
                <input id={fieldDomId('phone')} type="tel" className={inputCls(errors.phone)} value={form.phone} onChange={(e) => update('phone', e.target.value)} onBlur={() => blur('phone')} placeholder="+54 264 555-1234" aria-invalid={Boolean(errors.phone)} />
              </Field>
              <Field id={fieldDomId('email')} label="Email" error={errors.email}>
                <input id={fieldDomId('email')} type="email" className={inputCls(errors.email)} value={form.email} onChange={(e) => update('email', e.target.value)} onBlur={() => blur('email')} aria-invalid={Boolean(errors.email)} />
              </Field>
              <Field id="dw-address" label="Domicilio">
                <input id="dw-address" className={inputCls()} value={form.address} onChange={(e) => update('address', e.target.value)} placeholder="Calle, número, localidad" />
              </Field>
              <fieldset className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 p-3 rounded-xl border border-slate-800">
                <legend className="px-1 text-xs text-slate-300">Contacto de emergencia</legend>
                <Field id="dw-emergencyName" label="Nombre y relación">
                  <input id="dw-emergencyName" className={inputCls()} value={form.emergencyName} onChange={(e) => update('emergencyName', e.target.value)} placeholder="Ej. María Gómez (esposa)" />
                </Field>
                <Field id={fieldDomId('emergencyPhone')} label="Teléfono" error={errors.emergencyPhone}>
                  <input id={fieldDomId('emergencyPhone')} type="tel" className={inputCls(errors.emergencyPhone)} value={form.emergencyPhone} onChange={(e) => update('emergencyPhone', e.target.value)} onBlur={() => blur('emergencyPhone')} aria-invalid={Boolean(errors.emergencyPhone)} />
                </Field>
              </fieldset>
            </div>
          ) : step === 1 ? (
            <div className="space-y-5">
              <fieldset>
                <legend className="text-xs text-slate-300 mb-2">Perfil del chofer *</legend>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup">
                  {(Object.keys(DRIVER_PROFILES) as DriverProfile[]).map((p) => {
                    const sel = form.profile === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => update('profile', p)}
                        className={`text-left p-3 rounded-xl border cursor-pointer ${sel ? 'border-sky-500 bg-sky-500/10' : 'border-slate-800 hover:border-slate-600'}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-100">{DRIVER_PROFILES[p].label}</span>
                          {sel && <Check className="w-4 h-4 text-sky-400" aria-hidden />}
                        </div>
                        <p className="mt-1 text-[11px] text-slate-400">{DRIVER_PROFILES[p].description}</p>
                        <p className="mt-1.5 text-[11px] text-slate-300">
                          Exige: {requiredDocs(p, false).map((t) => DOC_TYPES[t].short).join(', ')}
                        </p>
                      </button>
                    );
                  })}
                </div>
                {form.profile === 'profesional' && (
                  <label className="mt-3 flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                    <input type="checkbox" className="mt-0.5 accent-sky-500" checked={form.dangerousGoods} onChange={(e) => update('dangerousGoods', e.target.checked)} />
                    <span>
                      Transporta cargas peligrosas <span className="text-slate-500">(exige el curso específico y la clase E.3)</span>
                    </span>
                  </label>
                )}
              </fieldset>

              <fieldset>
                <legend className="text-xs text-slate-300 mb-1">Clases de licencia *</legend>
                <p className="text-[11px] text-slate-500 mb-2">
                  Para {DRIVER_PROFILES[form.profile].label.toLowerCase()} necesita al menos una de:{' '}
                  <span className="text-slate-300">{classesForProfile(form.profile).join(', ')}</span>.
                </p>
                <div id={fieldDomId('licenseClasses')} tabIndex={-1} className="flex flex-wrap gap-1.5" aria-describedby={errors.licenseClasses ? `${fieldDomId('licenseClasses')}-error` : undefined}>
                  {LICENSE_CLASSES.map((c) => {
                    const sel = form.licenseClasses.includes(c.code);
                    const relevant = classesForProfile(form.profile).includes(c.code);
                    return (
                      <button
                        key={c.code}
                        type="button"
                        aria-pressed={sel}
                        title={c.description}
                        onClick={() => {
                          const next = sel ? form.licenseClasses.filter((x) => x !== c.code) : [...form.licenseClasses, c.code];
                          update('licenseClasses', next);
                          setErrors((e) => ({ ...e, licenseClasses: undefined }));
                        }}
                        className={`px-2 py-1 rounded-md border text-xs cursor-pointer ${
                          sel ? 'bg-sky-600 border-sky-500 text-white' : relevant ? 'border-sky-500/40 text-sky-200 hover:bg-sky-500/10' : 'border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        <span className="font-mono">{c.code}</span>
                        <span className="hidden sm:inline text-[10px] opacity-80"> · {c.description}</span>
                      </button>
                    );
                  })}
                </div>
                {errors.licenseClasses && (
                  <p id={`${fieldDomId('licenseClasses')}-error`} className="mt-1 text-[11px] text-rose-300" aria-live="polite">
                    {errors.licenseClasses}
                  </p>
                )}
                {!errors.licenseClasses && form.licenseClasses.length > 0 && !form.licenseClasses.some((c) => classesForProfile(form.profile).includes(c)) && (
                  <p className="mt-1 text-[11px] text-amber-300 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" aria-hidden /> Ninguna clase elegida habilita este perfil: quedará «No autorizado».
                  </p>
                )}
              </fieldset>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field id={fieldDomId('licenseNumber')} label="Número de licencia *" error={errors.licenseNumber} hint="Suele ser el mismo DNI.">
                  <input id={fieldDomId('licenseNumber')} className={`${inputCls(errors.licenseNumber)} font-mono`} value={form.docs.licencia.number} onChange={(e) => updateDoc('licencia', { number: e.target.value })} onBlur={() => blur('licenseNumber')} aria-invalid={Boolean(errors.licenseNumber)} />
                </Field>
                <Field id="dw-jurisdiction" label="Emitida por">
                  <input id="dw-jurisdiction" className={inputCls()} value={form.licenseJurisdiction} onChange={(e) => update('licenseJurisdiction', e.target.value)} placeholder="Municipio o provincia" />
                </Field>
                <Field id={fieldDomId('licenseExpiry')} label="Vencimiento *" error={errors.licenseExpiry} hint={!form.docs.licencia.expiresAt ? 'Sin vencimiento cargado no queda autorizado.' : undefined}>
                  <input id={fieldDomId('licenseExpiry')} type="date" className={inputCls(errors.licenseExpiry)} value={form.docs.licencia.expiresAt} onChange={(e) => updateDoc('licencia', { expiresAt: e.target.value })} onBlur={() => blur('licenseExpiry')} />
                </Field>
              </div>
            </div>
          ) : step === 2 ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">
                Carga los datos y el archivo de cada documento. Puedes guardar con documentos pendientes: el chofer quedará «No autorizado» hasta completarlos.
              </p>
              {required.map((t) => (
                <DocCard
                  key={t}
                  type={t}
                  required
                  form={form}
                  driverId={driver?.id}
                  error={errors[`doc-${t}`]}
                  onChange={(p) => updateDoc(t, p)}
                  onPick={(f) => pickFile(t, f)}
                />
              ))}
              <details className="group rounded-xl border border-slate-800" open={OPTIONAL_DOCS.some((t) => form.docs[t].number || form.docs[t].existingFile)}>
                <summary className="px-3.5 py-2.5 text-sm text-slate-200 cursor-pointer select-none">
                  Documentos opcionales <span className="text-xs text-slate-500">(antecedentes, libre deuda, ART)</span>
                </summary>
                <div className="p-3 pt-0 space-y-3">
                  {OPTIONAL_DOCS.map((t) => (
                    <DocCard key={t} type={t} form={form} driverId={driver?.id} error={errors[`doc-${t}`]} onChange={(p) => updateDoc(t, p)} onPick={(f) => pickFile(t, f)} />
                  ))}
                </div>
              </details>
            </div>
          ) : step === 3 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field id={fieldDomId('branch')} label="Sucursal *" error={errors.branch}>
                <select id={fieldDomId('branch')} className={inputCls(errors.branch)} value={form.branch} onChange={(e) => update('branch', e.target.value)} onBlur={() => blur('branch')}>
                  {!branches.length && <option value="">Elige primero la empresa</option>}
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="dw-employeeNumber" label="Legajo">
                <input id="dw-employeeNumber" className={inputCls()} value={form.employeeNumber} onChange={(e) => update('employeeNumber', e.target.value)} placeholder="Ej. L-1042" />
              </Field>
              <Field id="dw-hireDate" label="Fecha de ingreso">
                <input id="dw-hireDate" type="date" max={isoToday()} className={inputCls()} value={form.hireDate} onChange={(e) => update('hireDate', e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <Field
                  id="dw-vehicle"
                  label="Unidad asignada (opcional)"
                  hint={
                    !isEdit
                      ? 'Podrás asignarle una unidad después de verificar sus documentos.'
                      : cannotAssign
                        ? `No se puede asignar: quedará «${AUTH_STATE_LABELS[auth.state]}».`
                        : 'Un chofer conduce una unidad a la vez.'
                  }
                >
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Combobox
                        id="dw-vehicle"
                        value={vehicleText}
                        options={vehicleOptions}
                        disabled={cannotAssign && !form.vehicleId}
                        placeholder={cannotAssign ? 'No disponible' : 'Buscar por código o patente…'}
                        emptyText="No hay unidades con ese código"
                        onChange={(text, option) => {
                          setVehicleText(text);
                          update('vehicleId', option?.value ?? '');
                        }}
                      />
                    </div>
                    {form.vehicleId && (
                      <button
                        type="button"
                        onClick={() => {
                          setVehicleText('');
                          update('vehicleId', '');
                        }}
                        className="px-3 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
                      >
                        Quitar
                      </button>
                    )}
                  </div>
                </Field>
                {replaces && (
                  <p className="mt-1.5 text-[11px] text-amber-300 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" aria-hidden /> {chosenVehicle?.unitCode} hoy la conduce {replaces.name}: quedará reemplazado.
                  </p>
                )}
                {cannotAssign && form.vehicleId && (
                  <p className="mt-1.5 text-[11px] text-rose-300">Con la documentación actual no se le puede asignar una unidad: quítala o completa los documentos.</p>
                )}
              </div>
            </div>
          ) : (
            <ReviewStep form={form} auth={auth} vehicleLabel={chosenVehicle ? `${chosenVehicle.unitCode} · ${chosenVehicle.plate}` : ''} tenantName={targetTenant?.name ?? ''} onEdit={goTo} />
          )}
        </div>

        {/* Live authorization preview while editing */}
        {!saved && step < 4 && (
          <div className="px-5 py-2 border-t border-slate-800 flex items-center gap-2 text-xs" aria-live="polite">
            <span className="text-slate-400">Con estos datos quedaría:</span>
            <AuthBadge state={auth.state} />
            {auth.reasons[0] && <span className="text-slate-400 truncate">{auth.reasons[0]}</span>}
          </div>
        )}

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          {saved ? (
            <>
              <div>
                {uploads.some((u) => u.status === 'error') && (
                  <button type="button" onClick={retryUploads} disabled={submitting} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-amber-200 hover:bg-amber-500/10 cursor-pointer disabled:opacity-50">
                    <RefreshCw className={`w-3.5 h-3.5 ${submitting ? 'animate-spin' : ''}`} /> Reintentar archivos
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!isEdit && (
                  <button type="button" onClick={restart} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                    Registrar otro chofer
                  </button>
                )}
                {onVerifyNow && saved.authorization.state === 'pendiente' && (
                  <button type="button" onClick={() => onVerifyNow(saved.id)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer">
                    Verificar ahora
                  </button>
                )}
                {onViewDriver && (
                  <button type="button" onClick={() => onViewDriver(saved.id)} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                    Ver ficha
                  </button>
                )}
                <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                  Listo
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => (step === 0 || isEdit ? requestClose() : goTo(step - 1))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
              >
                {step === 0 || isEdit ? (
                  'Cancelar'
                ) : (
                  <>
                    <ArrowLeft className="w-3.5 h-3.5" /> Atrás
                  </>
                )}
              </button>
              <div className="flex items-center gap-2">
                {isEdit && step < lastStep && (
                  <button type="button" onClick={() => goTo(step + 1)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                    {steps[step + 1].title} <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
                {!isEdit && step < lastStep ? (
                  <button type="button" onClick={goNext} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                    Siguiente <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitting || (isEdit && !dirty)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {submitting ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Registrar chofer'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDiscard && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="dw-discard-title">
          <div className="w-full max-w-sm bg-[#11192C] border border-slate-700 rounded-xl p-5 space-y-3">
            <h3 id="dw-discard-title" className="text-sm font-semibold text-slate-100">
              ¿Descartar {isEdit ? 'los cambios' : 'el registro'}?
            </h3>
            <p className="text-xs text-slate-400">Se perderá lo que cargaste{isEdit ? ' sin guardar' : ''}, incluidos los archivos elegidos.</p>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setConfirmDiscard(false)} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Seguir editando
              </button>
              <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white cursor-pointer">
                Descartar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step pieces

function DocCard({
  type,
  required,
  form,
  driverId,
  error,
  onChange,
  onPick,
}: {
  type: DriverDocType;
  required?: boolean;
  form: Form;
  driverId?: string;
  error?: string;
  onChange: (patch: Partial<DocDraft>) => void;
  onPick: (file: File) => void;
}) {
  const meta = DOC_TYPES[type];
  const d = form.docs[type];
  const status = docStatus(type, type === 'dni' ? { ...d, number: form.dni } : d, Boolean(required));
  const review = d.verification?.status;
  const base = `dw-doc-${type}`;
  return (
    <section id={fieldDomId(`doc-${type}`)} tabIndex={-1} className="p-3.5 rounded-xl border border-slate-800 bg-[#0B1120] space-y-3" aria-labelledby={`${base}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id={`${base}-title`} className="text-sm font-medium text-slate-100">
            {meta.label} {required && <span className="text-[10px] font-normal text-sky-300 align-middle">OBLIGATORIO</span>}
          </h3>
          <p className="text-[11px] text-slate-500">{meta.help}</p>
        </div>
        <span className={`text-[11px] whitespace-nowrap ${status.tone}`}>{status.text}</span>
      </div>
      {type === 'dni' ? (
        <p className="text-xs text-slate-300">
          Número: <span className="font-mono">{form.dni || '—'}</span> <span className="text-slate-500">(se toma de los datos personales)</span>
        </p>
      ) : type === 'licencia' ? (
        <p className="text-xs text-slate-300">
          Número <span className="font-mono">{d.number || '—'}</span> · vence {d.expiresAt ? formatDateAr(d.expiresAt) : '—'}{' '}
          <span className="text-slate-500">(se edita en «Perfil y licencia»)</span>
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field id={`${base}-number`} label={meta.numberLabel}>
            <input id={`${base}-number`} className={inputCls()} value={d.number} onChange={(e) => onChange({ number: e.target.value })} />
          </Field>
          {meta.issuerLabel ? (
            <Field id={`${base}-issuer`} label={meta.issuerLabel}>
              <input id={`${base}-issuer`} className={inputCls()} value={d.issuer} onChange={(e) => onChange({ issuer: e.target.value })} />
            </Field>
          ) : (
            <Field id={`${base}-issued`} label="Emitido el">
              <input id={`${base}-issued`} type="date" max={isoToday()} className={inputCls()} value={d.issuedAt} onChange={(e) => onChange({ issuedAt: e.target.value })} />
            </Field>
          )}
          {meta.hasExpiry && (
            <Field id={`${base}-expires`} label={`Vencimiento${required ? ' *' : ''}`}>
              <input id={`${base}-expires`} type="date" className={inputCls(error)} value={d.expiresAt} onChange={(e) => onChange({ expiresAt: e.target.value })} />
            </Field>
          )}
        </div>
      )}
      {review === 'verificado' && (
        <p className="text-[11px] text-emerald-300">
          Verificado por {d.verification?.by}. Si cambias estos datos o el archivo, volverá a quedar pendiente de verificación.
        </p>
      )}
      {review === 'rechazado' && (
        <p className="text-[11px] text-rose-300">
          Rechazado: {d.verification?.reason}. Corrige los datos o reemplaza el archivo y vuelve a verificarlo.
        </p>
      )}
      <FilePicker
        docType={type}
        draft={d}
        driverId={driverId}
        error={error}
        onPick={onPick}
        onRemove={() => onChange(d.file ? { file: undefined } : { removeFile: true })}
        onUndoRemove={() => onChange({ removeFile: false })}
      />
    </section>
  );
}

function ReviewStep({
  form,
  auth,
  vehicleLabel,
  tenantName,
  onEdit,
}: {
  form: Form;
  auth: ReturnType<typeof previewAuthorization>;
  vehicleLabel: string;
  tenantName: string;
  onEdit: (step: number) => void;
}) {
  const Row = ({ k, v }: { k: string; v: ReactNode }) => (
    <div className="flex gap-3 py-1 text-xs">
      <dt className="w-36 shrink-0 text-slate-500">{k}</dt>
      <dd className="text-slate-200 min-w-0 break-words">{v || '—'}</dd>
    </div>
  );
  const Block = ({ title, step, children }: { title: string; step: number; children: ReactNode }) => (
    <section className="p-3.5 rounded-xl border border-slate-800 bg-[#0B1120]">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <button type="button" onClick={() => onEdit(step)} className="text-xs text-sky-300 hover:underline cursor-pointer">
          Editar
        </button>
      </div>
      <dl>{children}</dl>
    </section>
  );
  const docs = docTypesFor(form);
  const toneByState: Record<DriverAuthState, string> = {
    habilitado: 'border-emerald-500/40 bg-emerald-500/10',
    por_vencer: 'border-amber-500/40 bg-amber-500/10',
    pendiente: 'border-sky-500/40 bg-sky-500/10',
    no_autorizado: 'border-rose-500/40 bg-rose-500/10',
    deshabilitado: 'border-slate-600 bg-slate-800/40',
  };
  return (
    <div className="space-y-3">
      <div className={`p-3.5 rounded-xl border ${toneByState[auth.state]}`} aria-live="polite">
        <div className="flex items-center gap-2 text-sm text-slate-100">
          Quedará <AuthBadge state={auth.state} />
        </div>
        {auth.reasons.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-xs text-slate-300 list-disc pl-5">
            {auth.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {auth.state === 'no_autorizado' && <p className="mt-1.5 text-[11px] text-slate-400">Puedes registrarlo igual y completar los documentos después.</p>}
        {auth.missingFiles.length > 0 && (
          <p className="mt-1.5 text-[11px] text-amber-300">Sin archivo: {auth.missingFiles.map((t) => DOC_TYPES[t].short).join(', ')}.</p>
        )}
      </div>
      <Block title="Datos personales" step={0}>
        {tenantName && <Row k="Empresa" v={tenantName} />}
        <Row k="Nombre" v={`${form.lastName}, ${form.firstName}`} />
        <Row k="DNI / CUIL" v={<span className="font-mono">{`${form.dni} · ${form.cuil}`}</span>} />
        <Row k="Nacimiento" v={form.birthDate ? `${formatDateAr(form.birthDate)} (${ageOn(form.birthDate, new Date())} años)` : ''} />
        <Row k="Contacto" v={[form.phone, form.email].filter(Boolean).join(' · ')} />
        <Row k="Emergencia" v={form.emergencyName ? `${form.emergencyName} · ${form.emergencyPhone}` : ''} />
      </Block>
      <Block title="Perfil y licencia" step={1}>
        <Row k="Perfil" v={`${DRIVER_PROFILES[form.profile].label}${form.profile === 'profesional' && form.dangerousGoods ? ' · cargas peligrosas' : ''}`} />
        <Row k="Clases" v={form.licenseClasses.join(', ')} />
        <Row k="Licencia" v={`${form.docs.licencia.number} · vence ${form.docs.licencia.expiresAt ? formatDateAr(form.docs.licencia.expiresAt) : 'sin dato'}`} />
      </Block>
      <Block title="Documentación" step={2}>
        {docs.map((t) => {
          const d = form.docs[t];
          const file = d.file?.name ?? (d.existingFile && !d.removeFile ? d.existingFile.name : '');
          return (
            <Row
              key={t}
              k={DOC_TYPES[t].short}
              v={[t === 'dni' ? form.dni : d.number, d.expiresAt && `vence ${formatDateAr(d.expiresAt)}`, file ? `archivo: ${file}` : 'sin archivo'].filter(Boolean).join(' · ')}
            />
          );
        })}
      </Block>
      <Block title="Asignación" step={3}>
        <Row k="Sucursal" v={form.branch} />
        <Row k="Legajo" v={form.employeeNumber} />
        <Row k="Ingreso" v={form.hireDate ? formatDateAr(form.hireDate) : ''} />
        <Row k="Unidad" v={vehicleLabel || 'Sin unidad por ahora'} />
      </Block>
    </div>
  );
}

function SavedStep({ driver, uploads, isEdit }: { driver: DriverListItem; uploads: UploadState[]; isEdit: boolean }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
        <div>
          <p className="text-sm text-slate-100">
            <b>{driver.name}</b> {isEdit ? 'quedó actualizado' : 'quedó registrado'}.
          </p>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
            Estado: <AuthBadge state={driver.authorization.state} />
          </div>
          {driver.authorization.reasons[0] && <p className="mt-1 text-xs text-slate-400">{driver.authorization.reasons.join(' ')}</p>}
        </div>
      </div>
      {uploads.length > 0 && (
        <div className="p-3.5 rounded-xl border border-slate-800 bg-[#0B1120] space-y-2">
          <h3 className="text-xs font-semibold text-slate-200">Archivos</h3>
          {uploads.map((u) => (
            <div key={u.type} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-300 truncate">
                  {DOC_TYPES[u.type].short} · {u.file.name}
                </span>
                <span
                  className={`inline-flex items-center gap-1 ${u.status === 'ok' ? 'text-emerald-300' : u.status === 'error' ? 'text-rose-300' : 'text-slate-400'}`}
                >
                  {u.status === 'ok' ? <Check className="w-3 h-3" /> : u.status === 'error' ? <XCircle className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
                  {u.status === 'ok' ? 'Subido' : u.status === 'error' ? 'Falló' : `${Math.round(u.progress * 100)} %`}
                </span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-slate-800 overflow-hidden" aria-hidden>
                <div className={`h-full ${u.status === 'error' ? 'bg-rose-500' : 'bg-sky-500'}`} style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
              {u.error && <p className="mt-0.5 text-[11px] text-rose-300">{u.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
