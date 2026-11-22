import crypto from 'crypto';
import type {
  AlertEvent,
  AuditLog,
  Driver,
  DriverCounts,
  DriverHistoryEntry,
  DriverListItem,
  DriverPage,
  FleetStoreState,
  Vehicle,
} from '../../src/shared/types.ts';
import {
  ageOn,
  AUTH_STATE_LABELS,
  computeDriverAuthorization,
  cuilProblem,
  DOC_TYPES,
  DRIVER_FILE_MAX_BYTES,
  DRIVER_PAGE_SIZES,
  foldText,
  isLicenseClass,
  minimumAge,
  OPTIONAL_DOCS,
  needsReverification,
  requiredDocs,
  verificationStatus,
  type DriverAuthState,
  type DriverDocType,
  type DriverDocument,
  type DriverProfile,
} from '../../src/shared/drivers.ts';
import type { StateRepository } from '../db/stateRepository.ts';

export class DriverError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface DriverActor {
  name: string;
  role: string;
  hidden: boolean;
}

/** Which companies a request may touch: one tenant, or every tenant (superadmin with «Todas»). */
export type DriverScope = { tenantId: string } | { all: true };

export interface DriverInput {
  firstName: string;
  lastName: string;
  dni: string;
  cuil: string;
  birthDate: string;
  phone: string;
  email?: string;
  address?: string;
  emergencyContact?: { name: string; phone: string };
  employeeNumber?: string;
  hireDate?: string;
  branch: string;
  profile: DriverProfile;
  dangerousGoods?: boolean;
  licenseClasses: string[];
  licenseJurisdiction?: string;
  documents: Array<Omit<DriverDocument, 'file'>>;
}

export interface DriverListQuery {
  page: number;
  pageSize: number;
  q?: string;
  state?: DriverAuthState;
  branch?: string;
  profile?: DriverProfile;
  sort?: 'name' | 'expiry';
}

interface RegistryContext {
  state: FleetStoreState;
  repo: StateRepository;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
}

const HISTORY_LIMIT = 40;
const uid = () => crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

/** File signatures: the declared type must match the bytes. */
function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const displayName = (firstName: string, lastName: string) => `${lastName.trim()}, ${firstName.trim()}`;

export class DriverRegistry {
  constructor(private readonly ctx: () => RegistryContext) {}

  private get state() {
    return this.ctx().state;
  }

  // ---- Reading --------------------------------------------------------------

  private inScope(d: Driver, scope: DriverScope) {
    return 'all' in scope || d.tenantId === scope.tenantId;
  }

  private find(scope: DriverScope, id: string): Driver {
    const d = this.state.drivers.find((x) => x.id === id && this.inScope(x, scope));
    if (!d) throw new DriverError('Chofer no encontrado en tu empresa.', 404);
    return d;
  }

  private vehicleOf(d: Driver): Vehicle | undefined {
    return this.state.vehicles.find((v) => v.driverId === d.id && v.tenantId === d.tenantId);
  }

  toListItem(d: Driver, today = new Date()): DriverListItem {
    const v = this.vehicleOf(d);
    return {
      ...d,
      history: d.history?.slice(0, HISTORY_LIMIT),
      authorization: computeDriverAuthorization(d, today),
      assignedVehicle: v ? { id: v.id, unitCode: v.unitCode, plate: v.plate } : undefined,
      tenantName: this.state.tenants.find((t) => t.id === d.tenantId)?.name,
    };
  }

  /** Filters, counts and sorts drivers like the list screen (shared by the paged list and the export). */
  private search(scope: DriverScope, query: Omit<DriverListQuery, 'page' | 'pageSize'>, today: Date) {
    const q = foldText(query.q?.trim() ?? '');
    const qDigits = q.replace(/\D/g, '');

    const base = this.state.drivers
      .filter((d) => this.inScope(d, scope))
      .filter((d) => !query.branch || d.branch === query.branch)
      .filter((d) => !query.profile || (d.profile ?? 'liviano') === query.profile)
      .filter((d) => {
        if (!q) return true;
        const hay = foldText([d.name, d.firstName, d.lastName, d.licenseNumber, d.employeeNumber].filter(Boolean).join(' '));
        if (hay.includes(q)) return true;
        return qDigits.length >= 3 && [d.dni, d.cuil].some((x) => x?.includes(qDigits));
      })
      .map((d) => ({ d, auth: computeDriverAuthorization(d, today) }));

    // Counters ignore the state filter so each card shows how many it would list.
    const counts: DriverCounts = { total: base.length, habilitado: 0, por_vencer: 0, pendiente: 0, no_autorizado: 0, deshabilitado: 0, sinRespaldo: 0 };
    for (const { auth } of base) {
      counts[auth.state] += 1;
      if (auth.missingFiles.length && auth.state !== 'deshabilitado') counts.sinRespaldo += 1;
    }

    const filtered = query.state ? base.filter((x) => x.auth.state === query.state) : base;
    const byName = (a: Driver, b: Driver) => a.name.localeCompare(b.name, 'es');
    filtered.sort((a, b) => {
      if (query.sort === 'expiry') {
        const ea = a.auth.nextExpiry ?? '9999-12-31';
        const eb = b.auth.nextExpiry ?? '9999-12-31';
        return ea === eb ? byName(a.d, b.d) : ea.localeCompare(eb);
      }
      return byName(a.d, b.d);
    });
    return { filtered, counts };
  }

  list(scope: DriverScope, query: DriverListQuery): DriverPage {
    const today = new Date();
    const pageSize = (DRIVER_PAGE_SIZES as readonly number[]).includes(query.pageSize) ? query.pageSize : DRIVER_PAGE_SIZES[0];
    const { filtered, counts } = this.search(scope, query, today);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, Math.floor(query.page) || 1), totalPages);
    const items = filtered.slice((page - 1) * pageSize, page * pageSize).map(({ d }) => this.toListItem(d, today));
    return { items, total: filtered.length, page, pageSize, counts };
  }

  /** Every driver matching the list filters (no paging), for exports. */
  listAll(scope: DriverScope, query: Omit<DriverListQuery, 'page' | 'pageSize'>): DriverListItem[] {
    const today = new Date();
    return this.search(scope, query, today).filtered.map(({ d }) => this.toListItem(d, today));
  }

  get(scope: DriverScope, id: string): DriverListItem {
    return this.toListItem(this.find(scope, id));
  }

  availability(tenantId: string, input: { dni?: string; cuil?: string; except?: string }) {
    const others = this.state.drivers.filter((d) => d.tenantId === tenantId && d.id !== input.except);
    const dni = input.dni?.replace(/\D/g, '');
    const cuil = input.cuil?.replace(/\D/g, '');
    return {
      dni: !dni ? undefined : !/^\d{7,8}$/.test(dni) ? 'invalido' : others.some((d) => d.dni === dni) ? 'en_uso' : 'ok',
      cuil: !cuil
        ? undefined
        : cuilProblem(cuil, dni)
          ? 'invalido'
          : others.some((d) => d.cuil === cuil)
            ? 'en_uso'
            : 'ok',
    };
  }

  /** Bootstrap copy for users who are not driver administrators: no personal data or documents. */
  static redact(d: Driver): Driver {
    return {
      id: d.id,
      tenantId: d.tenantId,
      branch: d.branch,
      name: d.name,
      licenseNumber: d.licenseNumber,
      phone: d.phone,
      status: d.status,
      profile: d.profile,
      licenseClasses: d.licenseClasses,
      enabled: d.enabled,
      lastAuthState: d.lastAuthState,
    };
  }

  // ---- Validation -----------------------------------------------------------

  private validate(tenantId: string, input: DriverInput, exceptId?: string) {
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new DriverError('La empresa destino no existe.');
    if (!tenant.branches.includes(input.branch)) throw new DriverError(`La sucursal «${input.branch}» no pertenece a ${tenant.name}.`);

    const avail = this.availability(tenantId, { dni: input.dni, cuil: input.cuil, except: exceptId });
    if (avail.dni === 'en_uso') throw new DriverError(`Ya hay un chofer con DNI ${input.dni} en ${tenant.name}.`);
    const cuilErr = cuilProblem(input.cuil, input.dni);
    if (cuilErr) throw new DriverError(cuilErr);
    if (avail.cuil === 'en_uso') throw new DriverError('Ese CUIL ya está registrado en otro chofer.');

    const today = new Date();
    const age = ageOn(input.birthDate, today);
    if (age === null || age < 0 || age > 100) throw new DriverError('La fecha de nacimiento no es válida.');
    const bad = input.licenseClasses.find((c) => !isLicenseClass(c));
    if (bad) throw new DriverError(`La clase de licencia «${bad}» no existe.`);
    const minAge = minimumAge(input.licenseClasses);
    if (age < minAge) throw new DriverError(`Para las clases elegidas la edad mínima es ${minAge} años (tiene ${age}).`);

    const types = input.documents.map((d) => d.type);
    if (new Set(types).size !== types.length) throw new DriverError('Hay documentos repetidos.');
    const allowed = new Set<DriverDocType>([...requiredDocs(input.profile, Boolean(input.dangerousGoods)), ...OPTIONAL_DOCS]);
    const extra = types.find((t) => !allowed.has(t));
    if (extra) throw new DriverError(`El documento «${DOC_TYPES[extra].label}» no corresponde al perfil elegido.`);
    for (const doc of input.documents) {
      if (doc.issuedAt && doc.expiresAt && doc.issuedAt > doc.expiresAt) {
        throw new DriverError(`${DOC_TYPES[doc.type].label}: la fecha de emisión es posterior al vencimiento.`);
      }
    }
  }

  private vehicleForAssignment(tenantId: string, vehicleId: string): Vehicle {
    const v = this.state.vehicles.find((x) => x.id === vehicleId && x.tenantId === tenantId);
    if (!v) throw new DriverError('La unidad elegida no pertenece a la empresa del chofer.');
    return v;
  }

  // ---- Changes --------------------------------------------------------------

  private record(d: Driver, actor: DriverActor, action: string, detail: string) {
    const entry: DriverHistoryEntry = { at: nowIso(), actor: actor.hidden ? 'Superadmin' : actor.name, action, detail };
    d.history = [entry, ...(d.history ?? [])].slice(0, HISTORY_LIMIT);
    d.updatedAt = entry.at;
    this.ctx().audit({
      tenantId: d.tenantId,
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module: 'Choferes',
      action,
      targetLabel: d.name,
      detail,
    });
  }

  /** Assigns (or clears with null) the driver's unit: one unit per driver, one driver per unit. */
  private assign(d: Driver, vehicleId: string | null, actor: DriverActor): string[] {
    const notes: string[] = [];
    const current = this.vehicleOf(d);
    if (current && current.id !== vehicleId) {
      current.driverId = '';
      current.driverName = 'Sin chofer asignado';
      notes.push(`${current.unitCode} quedó sin chofer`);
    }
    if (vehicleId && current?.id !== vehicleId) {
      const v = this.vehicleForAssignment(d.tenantId, vehicleId);
      const auth = computeDriverAuthorization(d);
      if (auth.state === 'no_autorizado' || auth.state === 'deshabilitado' || auth.state === 'pendiente') {
        throw new DriverError(`No se puede asignar una unidad: el chofer está «${AUTH_STATE_LABELS[auth.state]}». ${auth.reasons[0] ?? ''}`.trim());
      }
      const previous = v.driverId ? this.state.drivers.find((x) => x.id === v.driverId) : undefined;
      if (previous && previous.id !== d.id) notes.push(`reemplaza a ${previous.name} en ${v.unitCode}`);
      v.driverId = d.id;
      v.driverName = d.name;
      notes.push(`asignado a ${v.unitCode}`);
    }
    if (notes.length) this.record(d, actor, 'Asignación de unidad', notes.join('; ') + '.');
    return notes;
  }

  create(tenantId: string, input: DriverInput & { vehicleId?: string }, actor: DriverActor): DriverListItem {
    this.validate(tenantId, input);
    if (input.vehicleId) this.vehicleForAssignment(tenantId, input.vehicleId);
    const at = nowIso();
    const licence = input.documents.find((d) => d.type === 'licencia');
    const d: Driver = {
      id: `chf-${uid()}`,
      tenantId,
      branch: input.branch,
      name: displayName(input.firstName, input.lastName),
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      dni: input.dni,
      cuil: input.cuil,
      birthDate: input.birthDate,
      phone: input.phone,
      email: input.email || undefined,
      address: input.address || undefined,
      emergencyContact: input.emergencyContact?.name ? input.emergencyContact : undefined,
      employeeNumber: input.employeeNumber || undefined,
      hireDate: input.hireDate,
      profile: input.profile,
      dangerousGoods: Boolean(input.dangerousGoods),
      licenseClasses: [...new Set(input.licenseClasses)],
      licenseJurisdiction: input.licenseJurisdiction || undefined,
      licenseNumber: licence?.number || input.dni,
      documents: input.documents.map((doc) => ({ ...doc, verification: { status: 'pendiente' as const } })),
      status: 'activo',
      enabled: true,
      createdAt: at,
      updatedAt: at,
    };
    d.lastAuthState = computeDriverAuthorization(d).state;
    if (input.vehicleId) {
      const auth = computeDriverAuthorization(d);
      if (auth.state === 'no_autorizado' || auth.state === 'pendiente') {
        throw new DriverError(
          auth.state === 'pendiente'
            ? 'Podrás asignarle una unidad después de verificar sus documentos.'
            : `No se puede asignar una unidad a un chofer no autorizado. ${auth.reasons[0] ?? ''}`.trim()
        );
      }
    }
    this.state.drivers.unshift(d);
    this.record(d, actor, 'Alta de chofer', `Registrado como ${AUTH_STATE_LABELS[d.lastAuthState].toLowerCase()}.`);
    if (input.vehicleId) this.assign(d, input.vehicleId, actor);
    this.ctx().persist();
    return this.toListItem(d);
  }

  update(scope: DriverScope, id: string, patch: Partial<DriverInput> & { vehicleId?: string | null }, actor: DriverActor) {
    const d = this.find(scope, id);
    const merged: DriverInput = {
      firstName: patch.firstName ?? d.firstName ?? d.name,
      lastName: patch.lastName ?? d.lastName ?? '',
      dni: patch.dni ?? d.dni ?? '',
      cuil: patch.cuil ?? d.cuil ?? '',
      birthDate: patch.birthDate ?? d.birthDate ?? '',
      phone: patch.phone ?? d.phone,
      email: patch.email ?? d.email,
      address: patch.address ?? d.address,
      emergencyContact: patch.emergencyContact ?? d.emergencyContact,
      employeeNumber: patch.employeeNumber ?? d.employeeNumber,
      hireDate: patch.hireDate ?? d.hireDate,
      branch: patch.branch ?? d.branch,
      profile: patch.profile ?? d.profile ?? 'liviano',
      dangerousGoods: patch.dangerousGoods ?? d.dangerousGoods,
      licenseClasses: patch.licenseClasses ?? d.licenseClasses ?? [],
      licenseJurisdiction: patch.licenseJurisdiction ?? d.licenseJurisdiction,
      documents: patch.documents ?? (d.documents ?? []).map(({ file: _f, ...rest }) => rest),
    };
    this.validate(d.tenantId, merged, d.id);

    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter(
      (k) => k !== 'vehicleId' && JSON.stringify(patch[k]) !== JSON.stringify((d as unknown as Record<string, unknown>)[k])
    );
    const before = computeDriverAuthorization(d).state;
    const oldDocs = new Map((d.documents ?? []).map((doc) => [doc.type, { ...doc }]));
    const oldClasses = JSON.stringify([...(d.licenseClasses ?? [])].sort());
    const oldJurisdiction = d.licenseJurisdiction ?? '';
    const oldDni = d.dni ?? '';

    // Documents keep their files and review when the type stays; removed types lose their files.
    const removedFiles: DriverDocType[] = [];
    if (patch.documents) {
      const old = new Map((d.documents ?? []).map((doc) => [doc.type, doc]));
      const next = patch.documents.map((doc) => ({ ...doc, file: old.get(doc.type)?.file, verification: old.get(doc.type)?.verification }));
      for (const [type, doc] of old) if (doc.file && !next.some((n) => n.type === type)) removedFiles.push(type);
      d.documents = next.map((doc) => (doc.file ? doc : (({ file: _f, ...r }) => r)(doc)));
    }
    Object.assign(d, {
      firstName: merged.firstName.trim(),
      lastName: merged.lastName.trim(),
      name: displayName(merged.firstName, merged.lastName),
      dni: merged.dni,
      cuil: merged.cuil,
      birthDate: merged.birthDate,
      phone: merged.phone,
      email: merged.email || undefined,
      address: merged.address || undefined,
      emergencyContact: merged.emergencyContact?.name ? merged.emergencyContact : undefined,
      employeeNumber: merged.employeeNumber || undefined,
      hireDate: merged.hireDate,
      branch: merged.branch,
      profile: merged.profile,
      dangerousGoods: Boolean(merged.dangerousGoods),
      licenseClasses: [...new Set(merged.licenseClasses)],
      licenseJurisdiction: merged.licenseJurisdiction || undefined,
      licenseNumber: d.documents?.find((x) => x.type === 'licencia')?.number || merged.dni,
    });
    const v = this.vehicleOf(d);
    if (v) v.driverName = d.name;

    // A reviewed document goes back to review when what the reviewer confirmed changes.
    const reverify: string[] = [];
    for (const doc of d.documents ?? []) {
      const prev = oldDocs.get(doc.type);
      if (!prev) {
        doc.verification = { status: 'pendiente' };
        continue;
      }
      const why = needsReverification({ ...prev, fileId: prev.file?.id }, { ...doc, fileId: doc.file?.id });
      if (doc.type === 'licencia' && JSON.stringify([...(d.licenseClasses ?? [])].sort()) !== oldClasses) why.push('clases');
      if (doc.type === 'licencia' && (d.licenseJurisdiction ?? '') !== oldJurisdiction) why.push('jurisdicción');
      if (doc.type === 'dni' && (d.dni ?? '') !== oldDni) why.push('DNI');
      if (why.length && verificationStatus(doc) !== 'pendiente') {
        doc.verification = { status: 'pendiente' };
        reverify.push(`${DOC_TYPES[doc.type].short} (${[...new Set(why)].join(', ')})`);
      }
    }

    const after = computeDriverAuthorization(d).state;
    if (changed.length) {
      const labels = changed.map((k) => FIELD_LABELS[k as string] ?? String(k));
      const stateNote = before !== after ? ` Estado: ${AUTH_STATE_LABELS[before]} → ${AUTH_STATE_LABELS[after]}.` : '';
      this.record(d, actor, 'Edición de chofer', `Cambios en: ${labels.join(', ')}.${stateNote}`);
    }
    if (reverify.length) {
      this.record(d, actor, 'Vuelve a verificación', `Por cambios en sus datos quedan pendientes de verificación: ${reverify.join('; ')}.`);
    }
    const notes = patch.vehicleId !== undefined ? this.assign(d, patch.vehicleId, actor) : [];
    d.lastAuthState = after;
    this.ctx().persist();
    for (const type of removedFiles) {
      this.ctx()
        .repo.deleteDriverFile(d.tenantId, d.id, type)
        .catch((err) => console.error('[choferes] No se pudo borrar el archivo:', err));
    }
    return { driver: this.toListItem(d), notes };
  }

  disable(scope: DriverScope, id: string, input: { reason: string; note?: string }, actor: DriverActor) {
    const d = this.find(scope, id);
    if (d.enabled === false) throw new DriverError('El chofer ya está deshabilitado.');
    d.enabled = false;
    d.status = 'suspendido';
    d.disabledReason = input.reason;
    d.disabledNote = input.note || undefined;
    d.disabledAt = nowIso();
    d.disabledBy = actor.hidden ? 'Superadmin' : actor.name;
    this.record(d, actor, 'Deshabilitación', `Motivo: ${input.reason}${input.note ? ` (${input.note})` : ''}.`);
    const notes = this.assign(d, null, actor);
    d.lastAuthState = 'deshabilitado';
    this.ctx().persist();
    return { driver: this.toListItem(d), notes };
  }

  enable(scope: DriverScope, id: string, actor: DriverActor) {
    const d = this.find(scope, id);
    if (d.enabled !== false) throw new DriverError('El chofer ya está habilitado.');
    d.enabled = true;
    d.status = 'activo';
    delete d.disabledReason;
    delete d.disabledNote;
    delete d.disabledAt;
    delete d.disabledBy;
    const auth = computeDriverAuthorization(d);
    d.lastAuthState = auth.state;
    this.record(d, actor, 'Rehabilitación', `Queda ${AUTH_STATE_LABELS[auth.state].toLowerCase()}.`);
    this.ctx().persist();
    return { driver: this.toListItem(d), notes: auth.state === 'no_autorizado' || auth.state === 'pendiente' ? auth.reasons : [] };
  }

  // ---- Files ----------------------------------------------------------------

  async setFile(scope: DriverScope, id: string, type: DriverDocType, body: Buffer, fileName: string, actor: DriverActor) {
    const d = this.find(scope, id);
    const doc = d.documents?.find((x) => x.type === type);
    if (!doc) throw new DriverError(`Primero carga los datos del documento «${DOC_TYPES[type].label}».`);
    if (!body.length) throw new DriverError('El archivo está vacío.');
    if (body.length > DRIVER_FILE_MAX_BYTES) throw new DriverError('El archivo supera los 5 MB.', 413);
    const mime = sniffMime(body);
    if (!mime) throw new DriverError('Formato no admitido: sube un PDF, JPG o PNG.', 415);
    const file = {
      id: `dfl-${uid()}`,
      name: fileName.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || `${type}.${mime.split('/')[1]}`,
      mime,
      size: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      uploadedAt: nowIso(),
      uploadedBy: actor.hidden ? 'Superadmin' : actor.name,
    };
    await this.ctx().repo.saveDriverFile({ ...file, tenantId: d.tenantId, driverId: d.id, docType: type, data: body, uploadedBy: file.uploadedBy });
    const replaced = Boolean(doc.file);
    const wasReviewed = verificationStatus(doc) !== 'pendiente';
    doc.file = file;
    doc.verification = { status: 'pendiente' };
    this.record(
      d,
      actor,
      replaced ? 'Reemplazo de archivo' : 'Archivo adjunto',
      `${DOC_TYPES[type].label}: ${file.name}.${wasReviewed ? ' Vuelve a quedar pendiente de verificación.' : ''}`
    );
    d.lastAuthState = computeDriverAuthorization(d).state;
    this.ctx().persist();
    return this.toListItem(d);
  }

  async getFile(scope: DriverScope, id: string, type: DriverDocType) {
    const d = this.find(scope, id);
    const doc = d.documents?.find((x) => x.type === type);
    if (!doc?.file) throw new DriverError('Ese documento no tiene archivo.', 404);
    const file = await this.ctx().repo.getDriverFile(d.tenantId, d.id, type);
    if (!file) throw new DriverError('Ese documento no tiene archivo.', 404);
    return file;
  }

  async deleteFile(scope: DriverScope, id: string, type: DriverDocType, actor: DriverActor) {
    const d = this.find(scope, id);
    const doc = d.documents?.find((x) => x.type === type);
    if (!doc?.file) throw new DriverError('Ese documento no tiene archivo.', 404);
    await this.ctx().repo.deleteDriverFile(d.tenantId, d.id, type);
    delete doc.file;
    doc.verification = { status: 'pendiente' };
    this.record(d, actor, 'Archivo quitado', `${DOC_TYPES[type].label}. Queda pendiente de verificación.`);
    d.lastAuthState = computeDriverAuthorization(d).state;
    this.ctx().persist();
    return this.toListItem(d);
  }

  // ---- Review ---------------------------------------------------------------

  /** An admin confirms (or rejects) a document after comparing its data with the attached file. */
  verifyDocument(
    scope: DriverScope,
    id: string,
    type: DriverDocType,
    input: { decision: 'verificado' | 'rechazado'; reason?: string },
    actor: DriverActor
  ) {
    const d = this.find(scope, id);
    const doc = d.documents?.find((x) => x.type === type);
    const meta = DOC_TYPES[type];
    if (!doc) throw new DriverError(`El chofer no tiene cargado el documento «${meta.label}».`);
    if (input.decision === 'verificado') {
      if (!doc.number?.trim() || (meta.hasExpiry && !doc.expiresAt)) {
        throw new DriverError(`Completa el número${meta.hasExpiry ? ' y el vencimiento' : ''} de «${meta.label}» antes de verificarlo.`);
      }
      if (!doc.file) throw new DriverError(`Adjunta el archivo de «${meta.label}» para poder verificarlo.`);
    } else if (!input.reason?.trim()) {
      throw new DriverError('Indica el motivo del rechazo.');
    }
    const before = computeDriverAuthorization(d).state;
    const at = nowIso();
    const by = actor.hidden ? 'Superadmin' : actor.name;
    doc.verification =
      input.decision === 'verificado' ? { status: 'verificado', by, at } : { status: 'rechazado', by, at, reason: input.reason!.trim() };
    const after = computeDriverAuthorization(d).state;
    const stateNote = before !== after ? ` Estado: ${AUTH_STATE_LABELS[before]} → ${AUTH_STATE_LABELS[after]}.` : '';
    this.record(
      d,
      actor,
      input.decision === 'verificado' ? 'Documento verificado' : 'Documento rechazado',
      `${meta.label}${input.decision === 'rechazado' ? `: ${input.reason!.trim()}` : ''}.${stateNote}`
    );
    d.lastAuthState = after;
    this.ctx().persist();
    return this.toListItem(d);
  }

  /**
   * Documents saved before the review step existed start as pending. Drivers keep their units
   * and no alert is raised (their last state is updated here, so the sweep sees no transition).
   */
  normalizeVerification(): boolean {
    let changed = false;
    for (const d of this.state.drivers) {
      let touched = false;
      for (const doc of d.documents ?? []) {
        if (!doc.verification) {
          doc.verification = { status: 'pendiente' };
          touched = true;
        }
      }
      if (touched) {
        d.lastAuthState = computeDriverAuthorization(d).state;
        changed = true;
      }
    }
    return changed;
  }

  // ---- Expiry sweep ---------------------------------------------------------

  /**
   * Re-evaluates every driver. A driver that becomes «No autorizado» while assigned to a
   * unit raises one alert on that unit (once per transition). Returns the alerts created.
   */
  sweep(today = new Date()): number {
    let alerts = 0;
    let changed = false;
    for (const d of this.state.drivers) {
      const auth = computeDriverAuthorization(d, today);
      if (d.lastAuthState === auth.state) continue;
      const v = this.vehicleOf(d);
      if (auth.state === 'no_autorizado' && d.lastAuthState && d.lastAuthState !== 'no_autorizado' && v) {
        const alert: AlertEvent = {
          id: `alr-${uid()}`,
          tenantId: d.tenantId,
          vehicleId: v.id,
          unitCode: v.unitCode,
          plate: v.plate,
          driverName: d.name,
          ruleId: 'driver-authorization',
          ruleName: 'Chofer no autorizado',
          priority: 'alta',
          status: 'pendiente',
          lat: v.lat,
          lng: v.lng,
          speedKmh: v.speedKmh,
          timestamp: today.toISOString(),
          clipId: null,
          summary: `${d.name} no está autorizado para conducir: ${auth.reasons[0] ?? 'documentación vencida'}`,
        };
        this.state.alerts.unshift(alert);
        alerts += 1;
      }
      d.lastAuthState = auth.state;
      changed = true;
    }
    if (changed) this.ctx().persist();
    return alerts;
  }

  // ---- Migration of drivers created before the registry --------------------

  /**
   * Completes legacy drivers (name/licence only). Demo data gets plausible documents with
   * spread expiries so the registry looks realistic. Returns true if anything changed.
   */
  normalizeLegacy(): boolean {
    let changed = false;
    const today = new Date();
    this.state.drivers.forEach((d, i) => {
      if (d.profile) return;
      const v = this.vehicleOf(d);
      const machine = v?.assetType === 'maquinaria_pesada';
      const parts = d.name.trim().split(/\s+/);
      const firstName = parts.slice(0, -1).join(' ') || parts[0];
      const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
      const seed = [...d.id].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
      // Distinct per driver (104729 is prime, so i * 104729 mod 15M does not repeat for the demo sizes).
      const dni = String(22_000_000 + ((i * 104_729) % 15_000_000));
      const cuil = cuilFor(dni, i % 2 ? '27' : '20');
      const plus = (days: number) => {
        const t = new Date(today);
        t.setDate(t.getDate() + days);
        return t.toISOString().slice(0, 10);
      };
      // Mostly valid; every 9th expiring soon, every 13th already expired.
      const licenceDays = i % 13 === 5 ? -6 : i % 9 === 4 ? 18 : 300 + (seed % 900);
      const profile: DriverProfile = machine ? 'maquinaria' : 'profesional';
      const documents: DriverDocument[] = [
        { type: 'dni', number: dni },
        { type: 'licencia', number: d.licenseNumber || dni, issuer: 'San Juan', expiresAt: plus(licenceDays) },
      ];
      if (profile === 'profesional') {
        documents.push({ type: 'linti', number: `LNT-${seed % 900000}`, expiresAt: plus(200 + (seed % 500)) });
        documents.push({ type: 'psicofisico', number: `PSI-${seed % 90000}`, issuer: 'CNRT', expiresAt: plus(150 + (seed % 400)) });
      } else {
        documents.push({ type: 'operador_maquinaria', number: `OPM-${seed % 90000}`, issuer: 'Cámara Argentina de la Construcción', expiresAt: plus(250 + (seed % 600)) });
      }
      Object.assign(d, {
        firstName,
        lastName,
        name: lastName ? displayName(firstName, lastName) : d.name,
        dni,
        cuil,
        birthDate: `${1970 + (seed % 30)}-${String(1 + (seed % 12)).padStart(2, '0')}-${String(1 + (seed % 28)).padStart(2, '0')}`,
        profile,
        dangerousGoods: false,
        licenseClasses: machine ? ['B.1', 'E.2'] : ['B.1', 'C.2', 'E.1'],
        licenseJurisdiction: 'San Juan',
        documents,
        enabled: d.status !== 'suspendido',
        employeeNumber: `L-${String(1000 + i)}`,
        createdAt: d.createdAt ?? today.toISOString(),
        updatedAt: today.toISOString(),
      } satisfies Partial<Driver>);
      if (d.phone.startsWith('+52')) d.phone = `+54 264 ${d.phone.replace(/\D/g, '').slice(-7, -4)}-${d.phone.replace(/\D/g, '').slice(-4)}`;
      if (v) v.driverName = d.name;
      d.lastAuthState = computeDriverAuthorization(d, today).state;
      changed = true;
    });
    return changed;
  }
}

const FIELD_LABELS: Record<string, string> = {
  firstName: 'nombre',
  lastName: 'apellido',
  dni: 'DNI',
  cuil: 'CUIL',
  birthDate: 'fecha de nacimiento',
  phone: 'teléfono',
  email: 'email',
  address: 'domicilio',
  emergencyContact: 'contacto de emergencia',
  employeeNumber: 'legajo',
  hireDate: 'fecha de ingreso',
  branch: 'sucursal',
  profile: 'perfil',
  dangerousGoods: 'cargas peligrosas',
  licenseClasses: 'clases de licencia',
  licenseJurisdiction: 'jurisdicción',
  documents: 'documentación',
};

/** Builds a valid CUIL for a DNI, falling back to the 23/24 prefixes when the check digit would be 10. */
function cuilFor(dni: string, preferred: '20' | '27'): string {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (const prefix of [preferred, '23', '24']) {
    const base = `${prefix}${dni.padStart(8, '0')}`;
    const sum = weights.reduce((acc, w, i) => acc + w * Number(base[i]), 0);
    const r = 11 - (sum % 11);
    if (r === 10) continue;
    return `${base}${r === 11 ? 0 : r}`;
  }
  throw new Error(`No se pudo calcular un CUIL para ${dni}`);
}
