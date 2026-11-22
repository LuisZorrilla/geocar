import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  Loader2,
  Plus,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import type { PublicUser, Tenant } from '../shared/types.ts';
import { apiRequest } from '../lib/api.ts';
import { useMoney } from '../lib/money.tsx';
import { cuitProblem, CUIT_MESSAGES, formatCuit, normalizeCuit } from '../shared/cuit.ts';
import { PLAN_TIERS, RETENTION_DAYS, USERNAME_PATTERN, type PlanTier } from '../shared/tenantOptions.ts';
import { MAP_REGION } from '../shared/region.ts';

// ---------------------------------------------------------------- types & helpers

interface WizardForm {
  name: string;
  cuit: string;
  city: string;
  branches: string[];
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  status: 'activo' | 'piloto';
  planTier: PlanTier;
  vehicleQuota: number;
  retentionDays: number;
  currency: string;
  referenceCurrency: string;
  adminName: string;
  username: string;
  usernameTouched: boolean;
  preventivePlans: boolean;
  alertRules: boolean;
}

export interface TenantCreatedResult {
  tenant: Tenant;
  admin: PublicUser;
  temporaryPassword: string;
}

type FieldKey = keyof WizardForm;
type Errors = Partial<Record<FieldKey, string>>;
type Availability = 'idle' | 'checking' | 'ok' | 'invalido' | 'en_uso' | 'error';

const STEPS = [
  { title: 'Empresa', hint: 'Datos legales y de contacto' },
  { title: 'Plan y servicio', hint: 'Estado, cupo y configuración inicial' },
  { title: 'Usuario administrador', hint: 'Quién gestionará la empresa' },
  { title: 'Revisión', hint: 'Confirma antes de crear' },
] as const;

const STEP_FIELDS: FieldKey[][] = [
  ['name', 'cuit', 'city', 'branches', 'contactName', 'contactEmail', 'contactPhone'],
  ['planTier', 'vehicleQuota', 'retentionDays'],
  ['adminName', 'username'],
  [],
];

const MODULES = [
  'Administración',
  'Flotas',
  'Dispositivos',
  'Configuración de cámaras',
  'Monitoreo',
  'Alertas',
  'Incidentes',
  'Video',
  'Reportes',
  'Dimensionamiento',
];

const EMPTY: WizardForm = {
  name: '',
  cuit: '',
  city: '',
  branches: [],
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  status: 'piloto',
  planTier: 'Piloto',
  vehicleQuota: 20,
  retentionDays: 30,
  currency: 'ARS',
  referenceCurrency: 'USD',
  adminName: '',
  username: '',
  usernameTouched: false,
  preventivePlans: true,
  alertRules: true,
};

/** Formats as the user types: 20123456786 → 20-12345678-6. */
function typingCuit(raw: string): string {
  const d = normalizeCuit(raw).slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 10) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return formatCuit(d);
}

function suggestUsername(companyName: string): string {
  const slug = companyName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(s\.?a\.?|s\.?r\.?l\.?|s\.?a\.?s\.?)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
  return slug ? `admin.${slug}` : '';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateField(f: WizardForm, key: FieldKey): string | undefined {
  switch (key) {
    case 'name':
      return f.name.trim().length < 2 ? 'Escribe la razón social.' : undefined;
    case 'cuit': {
      if (!f.cuit.trim()) return 'Escribe el CUIT.';
      const p = cuitProblem(f.cuit);
      return p ? CUIT_MESSAGES[p] : undefined;
    }
    case 'city':
      return f.city.trim() ? undefined : 'Escribe la ciudad o provincia.';
    case 'branches':
      return f.branches.length ? undefined : 'Agrega al menos una sucursal (escríbela y presiona Enter).';
    case 'contactName':
      return f.contactName.trim() ? undefined : 'Escribe el nombre de la persona de contacto.';
    case 'contactEmail':
      return EMAIL.test(f.contactEmail.trim()) ? undefined : 'Escribe un email válido (ej. nombre@empresa.com.ar).';
    case 'contactPhone':
      return f.contactPhone.replace(/\D/g, '').length >= 6 ? undefined : 'Escribe un teléfono válido (al menos 6 dígitos).';
    case 'vehicleQuota':
      return Number.isInteger(f.vehicleQuota) && f.vehicleQuota >= 1 && f.vehicleQuota <= 5000 ? undefined : 'El cupo debe estar entre 1 y 5000 unidades.';
    case 'adminName':
      return f.adminName.trim() ? undefined : 'Escribe el nombre del administrador.';
    case 'username':
      return USERNAME_PATTERN.test(f.username.trim().toLowerCase())
        ? undefined
        : 'Usa de 3 a 40 caracteres: minúsculas, números, punto, guion o guion bajo.';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- small UI pieces

const inputCls = (err?: string) =>
  `w-full px-3 py-2 bg-[#0B1120] border rounded-lg text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none ${
    err ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-800 focus:border-sky-500'
  }`;

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
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-slate-300">
          {label}
        </label>
        {status}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[11px] text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function AvailabilityBadge({ state, okLabel = 'Disponible' }: { state: Availability; okLabel?: string }) {
  if (state === 'idle') return null;
  const map: Record<Exclude<Availability, 'idle'>, { icon: ReactNode; text: string; cls: string }> = {
    checking: { icon: <Loader2 className="w-3 h-3 animate-spin" />, text: 'Verificando…', cls: 'text-slate-400' },
    ok: { icon: <CheckCircle2 className="w-3 h-3" />, text: okLabel, cls: 'text-emerald-300' },
    en_uso: { icon: <XCircle className="w-3 h-3" />, text: 'Ya registrado', cls: 'text-rose-300' },
    invalido: { icon: <XCircle className="w-3 h-3" />, text: 'Inválido', cls: 'text-rose-300' },
    error: { icon: <XCircle className="w-3 h-3" />, text: 'No se pudo verificar', cls: 'text-amber-300' },
  };
  const m = map[state];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${m.cls}`} aria-live="polite">
      {m.icon}
      {m.text}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
      aria-label={`Copiar ${label}`}
    >
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {done ? 'Copiado' : 'Copiar'}
    </button>
  );
}

// ---------------------------------------------------------------- wizard

interface TenantWizardProps {
  onClose: () => void;
  onCreated: (result: TenantCreatedResult) => void;
  onViewTenant: (tenantId: string) => void;
}

export function TenantWizard({ onClose, onCreated, onViewTenant }: TenantWizardProps) {
  const money = useMoney();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardForm>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [branchDraft, setBranchDraft] = useState('');
  const [cuitState, setCuitState] = useState<Availability>('idle');
  const [userState, setUserState] = useState<Availability>('idle');
  const [nameState, setNameState] = useState<Availability>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<TenantCreatedResult | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(EMPTY), [form]);

  const update = <K extends FieldKey>(key: K, value: WizardForm[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Keep suggesting the username from the company name until the user edits it.
      if (key === 'name' && !f.usernameTouched) next.username = suggestUsername(String(value));
      return next;
    });
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
    if (key === 'cuit') setCuitState('idle');
    if (key === 'username' || key === 'name') setUserState('idle');
    if (key === 'name') setNameState('idle');
  };

  const blur = (key: FieldKey) => {
    const err = validateField(form, key);
    setErrors((e) => ({ ...e, [key]: err }));
    if (!err && key === 'cuit') void check({ cuit: form.cuit });
    if (!err && key === 'username') void check({ username: form.username });
    if (!err && key === 'name') void check({ name: form.name, username: form.usernameTouched ? undefined : form.username });
  };

  const check = async (q: { cuit?: string; username?: string; name?: string }) => {
    const params = new URLSearchParams();
    if (q.cuit !== undefined) {
      params.set('cuit', q.cuit);
      setCuitState('checking');
    }
    if (q.username !== undefined && q.username) {
      params.set('username', q.username);
      setUserState('checking');
    }
    if (q.name !== undefined) {
      params.set('name', q.name);
      setNameState('checking');
    }
    try {
      const r = await apiRequest<{ cuit?: Availability; username?: Availability; name?: Availability; cuitMessage?: string }>(
        `/api/tenants/availability?${params}`
      );
      if (r.cuit) {
        setCuitState(r.cuit);
        if (r.cuit === 'en_uso') setErrors((e) => ({ ...e, cuit: 'Ya existe una empresa registrada con este CUIT.' }));
        if (r.cuit === 'invalido') setErrors((e) => ({ ...e, cuit: r.cuitMessage ?? 'CUIT inválido.' }));
      }
      if (r.username) {
        setUserState(r.username);
        if (r.username === 'en_uso') setErrors((e) => ({ ...e, username: 'Ese usuario ya está en uso: elige otro.' }));
      }
      if (r.name) {
        setNameState(r.name);
        if (r.name === 'en_uso') setErrors((e) => ({ ...e, name: 'Ya existe una empresa con este nombre.' }));
      }
    } catch {
      if (q.cuit !== undefined) setCuitState('error');
      if (q.username) setUserState('error');
      if (q.name !== undefined) setNameState('error');
    }
  };

  // Focus the first field with an error (or the step's first field) when the step changes.
  const focusFirst = (keys: FieldKey[], errs: Errors) => {
    const target = keys.find((k) => errs[k]) ?? keys[0];
    if (!target) return;
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`#tw-${target}`);
      el?.focus();
    });
  };

  useEffect(() => {
    if (!result) focusFirst(STEP_FIELDS[step], {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const validateStep = (s: number): Errors => {
    const errs: Errors = {};
    for (const k of STEP_FIELDS[s]) {
      const e = validateField(form, k);
      if (e) errs[k] = e;
    }
    // Server-side checks already known to fail
    if (s === 0 && cuitState === 'en_uso') errs.cuit = 'Ya existe una empresa registrada con este CUIT.';
    if (s === 0 && nameState === 'en_uso') errs.name = 'Ya existe una empresa con este nombre.';
    if (s === 2 && userState === 'en_uso') errs.username = 'Ese usuario ya está en uso: elige otro.';
    return errs;
  };

  const goNext = () => {
    const errs = validateStep(step);
    setErrors((e) => ({ ...e, ...errs }));
    if (Object.keys(errs).length) {
      focusFirst(STEP_FIELDS[step], errs);
      return;
    }
    if (step === 0 && cuitState === 'idle') void check({ cuit: form.cuit, name: form.name });
    if (step === 2 && userState === 'idle') void check({ username: form.username });
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goTo = (s: number) => {
    setServerError(null);
    setStep(s);
  };

  const requestClose = () => {
    if (result || !dirty) onClose();
    else setConfirmDiscard(true);
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Warn before leaving the page with unsaved data.
  useEffect(() => {
    if (!dirty || result) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, result]);

  const addBranch = () => {
    const b = branchDraft.trim();
    if (!b) return;
    if (form.branches.some((x) => x.toLowerCase() === b.toLowerCase())) {
      setErrors((e) => ({ ...e, branches: `«${b}» ya está en la lista.` }));
      return;
    }
    update('branches', [...form.branches, b]);
    setBranchDraft('');
  };

  const submit = async () => {
    // Re-validate every step; jump to the first one with problems.
    for (let s = 0; s < 3; s++) {
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
    try {
      const res = await apiRequest<TenantCreatedResult>('/api/tenants', {
        method: 'POST',
        body: JSON.stringify({
          company: {
            name: form.name.trim(),
            cuit: form.cuit,
            city: form.city.trim(),
            branches: form.branches,
            contactName: form.contactName.trim(),
            contactEmail: form.contactEmail.trim(),
            contactPhone: form.contactPhone.trim(),
          },
          service: {
            status: form.status,
            planTier: form.planTier,
            vehicleQuota: form.vehicleQuota,
            retentionDays: form.retentionDays,
            currency: form.currency,
            referenceCurrency: form.referenceCurrency,
          },
          admin: { name: form.adminName.trim(), username: form.username.trim().toLowerCase() },
          templates: { preventivePlans: form.preventivePlans, alertRules: form.alertRules },
        }),
      });
      setResult(res);
      onCreated(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo crear la empresa.';
      setServerError(msg);
      // Send the user to the step that needs fixing, keeping everything typed.
      if (/CUIT/i.test(msg)) {
        setErrors((e) => ({ ...e, cuit: msg }));
        setCuitState('en_uso');
        goTo(0);
      } else if (/nombre de usuario|usuario/i.test(msg)) {
        setErrors((e) => ({ ...e, username: msg }));
        setUserState('en_uso');
        goTo(2);
      } else if (/empresa con ese nombre/i.test(msg)) {
        setErrors((e) => ({ ...e, name: msg }));
        goTo(0);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onFormKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter advances (except inside the branch input, which uses Enter to add a chip, and on buttons).
    const target = e.target as HTMLElement;
    if (e.key !== 'Enter' || target.tagName === 'BUTTON' || target.id === 'tw-branches' || target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    if (step < 3) goNext();
  };

  const panelUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const credentials = result
    ? `Empresa: ${result.tenant.name}\nPanel: ${panelUrl}\nUsuario: ${result.admin.username}\nContraseña temporal: ${result.temporaryPassword}\n(Se pide cambiarla en el primer ingreso.)`
    : '';

  // ------------------------------------------------------------ render
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="tw-title">
      <div className="w-full sm:max-w-3xl bg-[#0F172A] border border-slate-800 sm:rounded-2xl flex flex-col max-h-screen sm:max-h-[92vh]">
        {/* Header + stepper */}
        <div className="px-5 pt-4 pb-3 border-b border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-sky-400" />
              <h2 id="tw-title" className="text-base font-semibold text-slate-100">
                {result ? 'Empresa creada' : 'Registrar empresa'}
              </h2>
            </div>
            <button type="button" onClick={requestClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer" aria-label="Cerrar">
              <X className="w-4 h-4" />
            </button>
          </div>
          {!result && (
            <>
              <ol className="grid grid-cols-4 gap-2" aria-label="Pasos del registro">
                {STEPS.map((s, i) => {
                  const done = i < step;
                  const current = i === step;
                  return (
                    <li key={s.title}>
                      <button
                        type="button"
                        disabled={i > step}
                        onClick={() => i < step && goTo(i)}
                        aria-current={current ? 'step' : undefined}
                        className="w-full text-left disabled:cursor-default cursor-pointer group"
                      >
                        <div className={`h-1 rounded-full ${done || current ? 'bg-sky-500' : 'bg-slate-800'}`} />
                        <div className={`mt-1.5 text-[11px] font-medium flex items-center gap-1 ${current ? 'text-slate-100' : done ? 'text-sky-300 group-hover:underline' : 'text-slate-500'}`}>
                          {done ? <Check className="w-3 h-3" /> : <span>{i + 1}.</span>}
                          <span className="truncate">{s.title}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <p className="text-xs text-slate-400">
                Paso {step + 1} de {STEPS.length} · {STEPS[step].hint}
              </p>
            </>
          )}
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 py-4" onKeyDown={onFormKeyDown}>
          {serverError && !result && (
            <div role="alert" className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
              {serverError}
            </div>
          )}

          {result ? (
            <SuccessStep result={result} credentials={credentials} panelUrl={panelUrl} />
          ) : step === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Field id="tw-name" label="Razón social *" error={errors.name} status={<AvailabilityBadge state={nameState === 'ok' ? 'idle' : nameState} />}>
                  <input id="tw-name" className={inputCls(errors.name)} value={form.name} onChange={(e) => update('name', e.target.value)} onBlur={() => blur('name')} placeholder="Ej. Transportes Andinos S.R.L." aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'tw-name-error' : undefined} />
                </Field>
              </div>
              <Field id="tw-cuit" label="CUIT *" hint="Se completa con guiones solo. Se valida el dígito verificador." error={errors.cuit} status={<AvailabilityBadge state={cuitState} />}>
                <input id="tw-cuit" inputMode="numeric" className={`${inputCls(errors.cuit)} font-mono`} value={form.cuit} onChange={(e) => update('cuit', typingCuit(e.target.value))} onBlur={() => blur('cuit')} placeholder="30-12345678-9" aria-invalid={Boolean(errors.cuit)} aria-describedby={errors.cuit ? 'tw-cuit-error' : 'tw-cuit-hint'} />
              </Field>
              <Field id="tw-city" label="Ciudad / provincia *" error={errors.city}>
                <input id="tw-city" className={inputCls(errors.city)} value={form.city} onChange={(e) => update('city', e.target.value)} onBlur={() => blur('city')} placeholder="Ej. San Juan Capital, San Juan" aria-invalid={Boolean(errors.city)} />
              </Field>
              <div className="sm:col-span-2">
                <Field id="tw-branches" label="Sucursales *" hint="Escribe una sucursal y presiona Enter o «Agregar». Se usan al registrar unidades." error={errors.branches}>
                  <div className={`flex flex-wrap items-center gap-1.5 p-1.5 bg-[#0B1120] border rounded-lg ${errors.branches ? 'border-rose-500/70' : 'border-slate-800'}`}>
                    {form.branches.map((b) => (
                      <span key={b} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-sky-600/15 border border-sky-500/30 text-xs text-sky-200">
                        {b}
                        <button type="button" onClick={() => update('branches', form.branches.filter((x) => x !== b))} className="p-0.5 rounded hover:bg-sky-500/20 cursor-pointer" aria-label={`Quitar ${b}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      id="tw-branches"
                      list="tw-branch-suggestions"
                      className="flex-1 min-w-[10rem] bg-transparent px-1.5 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
                      value={branchDraft}
                      onChange={(e) => setBranchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addBranch();
                        } else if (e.key === 'Backspace' && !branchDraft && form.branches.length) {
                          update('branches', form.branches.slice(0, -1));
                        }
                      }}
                      onBlur={() => {
                        if (branchDraft.trim()) addBranch();
                      }}
                      placeholder={form.branches.length ? 'Agregar otra…' : 'Ej. San Juan Capital'}
                    />
                    <button type="button" onClick={addBranch} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
                      <Plus className="w-3 h-3" /> Agregar
                    </button>
                    <datalist id="tw-branch-suggestions">
                      {MAP_REGION.hubs.map((h) => (
                        <option key={h.branch} value={h.branch} />
                      ))}
                    </datalist>
                  </div>
                </Field>
              </div>
              <div className="sm:col-span-2 pt-1 text-xs font-medium text-slate-400">Persona de contacto</div>
              <Field id="tw-contactName" label="Nombre *" error={errors.contactName}>
                <input id="tw-contactName" autoComplete="name" className={inputCls(errors.contactName)} value={form.contactName} onChange={(e) => update('contactName', e.target.value)} onBlur={() => blur('contactName')} aria-invalid={Boolean(errors.contactName)} />
              </Field>
              <Field id="tw-contactEmail" label="Email *" error={errors.contactEmail}>
                <input id="tw-contactEmail" type="email" autoComplete="email" className={inputCls(errors.contactEmail)} value={form.contactEmail} onChange={(e) => update('contactEmail', e.target.value)} onBlur={() => blur('contactEmail')} placeholder="nombre@empresa.com.ar" aria-invalid={Boolean(errors.contactEmail)} />
              </Field>
              <Field id="tw-contactPhone" label="Teléfono *" error={errors.contactPhone}>
                <input id="tw-contactPhone" type="tel" autoComplete="tel" className={inputCls(errors.contactPhone)} value={form.contactPhone} onChange={(e) => update('contactPhone', e.target.value)} onBlur={() => blur('contactPhone')} placeholder="+54 264 400 0000" aria-invalid={Boolean(errors.contactPhone)} />
              </Field>
            </div>
          ) : step === 1 ? (
            <div className="space-y-5">
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-slate-300 mb-1">Estado inicial</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {(
                    [
                      { id: 'piloto', title: 'Piloto', desc: 'Período de prueba con pocas unidades. Ideal para validar cámaras y conexión.' },
                      { id: 'activo', title: 'Activo', desc: 'Servicio en producción, con la flota completa.' },
                    ] as const
                  ).map((o) => (
                    <label key={o.id} className={`p-3 rounded-xl border cursor-pointer ${form.status === o.id ? 'border-sky-500 bg-sky-600/10' : 'border-slate-800 bg-[#0B1120] hover:border-slate-700'}`}>
                      <input type="radio" name="tw-status" value={o.id} checked={form.status === o.id} onChange={() => update('status', o.id)} className="sr-only" />
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-slate-100">{o.title}</span>
                        {form.status === o.id && <CheckCircle2 className="w-4 h-4 text-sky-400" />}
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{o.desc}</p>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field id="tw-planTier" label="Plan">
                  <select id="tw-planTier" className={inputCls()} value={form.planTier} onChange={(e) => update('planTier', e.target.value as PlanTier)}>
                    {PLAN_TIERS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
                <Field id="tw-vehicleQuota" label="Cupo de unidades *" hint="Máximo de vehículos y máquinas que podrá registrar." error={errors.vehicleQuota}>
                  <div className="flex items-stretch">
                    <button type="button" onClick={() => update('vehicleQuota', Math.max(1, form.vehicleQuota - 5))} className="px-2.5 rounded-l-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer" aria-label="Restar 5">
                      −
                    </button>
                    <input id="tw-vehicleQuota" type="number" min={1} max={5000} className={`${inputCls(errors.vehicleQuota)} rounded-none text-center`} value={form.vehicleQuota} onChange={(e) => update('vehicleQuota', Number(e.target.value))} onBlur={() => blur('vehicleQuota')} />
                    <button type="button" onClick={() => update('vehicleQuota', Math.min(5000, form.vehicleQuota + 5))} className="px-2.5 rounded-r-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer" aria-label="Sumar 5">
                      +
                    </button>
                  </div>
                </Field>
                <Field id="tw-retentionDays" label="Retención de video" hint="Días que se guardan los clips. Más días = más almacenamiento.">
                  <select id="tw-retentionDays" className={inputCls()} value={form.retentionDays} onChange={(e) => update('retentionDays', Number(e.target.value))}>
                    {RETENTION_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d} días
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field id="tw-currency" label="Moneda de la empresa *" hint="Todos sus importes (órdenes, repuestos, inventario) se cargan y muestran en esta moneda.">
                  <select id="tw-currency" className={inputCls()} value={form.currency} onChange={(e) => update('currency', e.target.value)}>
                    {money.enabled.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="tw-referenceCurrency" label="Moneda de referencia" hint="Se muestra como equivalente al lado de los totales.">
                  <select id="tw-referenceCurrency" className={inputCls()} value={form.referenceCurrency} onChange={(e) => update('referenceCurrency', e.target.value)}>
                    {money.enabled.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-slate-300 mb-1">Configuración inicial (se puede modificar o borrar después)</legend>
                {(
                  [
                    { key: 'preventivePlans', title: '3 planes preventivos', desc: 'Vehículos 250 h / 10.000 km · Maquinaria pesada 250 h · Inspección trimestral de cámaras y CAN.' },
                    { key: 'alertRules', title: '4 reglas de alerta', desc: 'Exceso de velocidad (> 90 km/h) · Botón de pánico · Posible colisión (G-sensor) · Fatiga o distracción (DMS).' },
                  ] as const
                ).map((t) => (
                  <label key={t.key} className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-800 bg-[#0B1120] cursor-pointer hover:border-slate-700">
                    <input type="checkbox" className="mt-0.5 accent-sky-500 w-4 h-4" checked={form[t.key]} onChange={(e) => update(t.key, e.target.checked)} />
                    <span>
                      <span className="block text-sm text-slate-100">{t.title}</span>
                      <span className="block text-xs text-slate-400">{t.desc}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : step === 2 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field id="tw-adminName" label="Nombre completo *" error={errors.adminName}>
                  <input id="tw-adminName" className={inputCls(errors.adminName)} value={form.adminName} onChange={(e) => update('adminName', e.target.value)} onBlur={() => blur('adminName')} placeholder={form.contactName || 'Ej. María Gómez'} aria-invalid={Boolean(errors.adminName)} />
                  {!form.adminName && form.contactName && (
                    <button type="button" onClick={() => update('adminName', form.contactName)} className="text-[11px] text-sky-300 hover:underline cursor-pointer">
                      Usar la persona de contacto ({form.contactName})
                    </button>
                  )}
                </Field>
                <Field id="tw-username" label="Usuario para ingresar *" hint="Sugerido a partir del nombre de la empresa; puedes cambiarlo." error={errors.username} status={<AvailabilityBadge state={userState} />}>
                  <input
                    id="tw-username"
                    autoComplete="off"
                    spellCheck={false}
                    className={`${inputCls(errors.username)} font-mono`}
                    value={form.username}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, usernameTouched: true }));
                      update('username', e.target.value.toLowerCase().replace(/\s+/g, '.'));
                    }}
                    onBlur={() => blur('username')}
                    aria-invalid={Boolean(errors.username)}
                  />
                </Field>
              </div>
              <div className="p-3.5 rounded-xl border border-emerald-500/25 bg-emerald-500/5 space-y-2">
                <div className="flex items-center gap-2 text-sm text-emerald-200">
                  <ShieldCheck className="w-4 h-4" /> Perfil «Admin de Empresa»: acceso total a los 10 módulos
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {MODULES.map((m) => (
                    <span key={m} className="px-2 py-0.5 rounded-md text-[11px] bg-[#0B1120] border border-slate-800 text-slate-300">
                      {m}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-slate-400">Podrá crear más usuarios y perfiles para su empresa desde «Perfiles y Reportes».</p>
              </div>
              <p className="text-xs text-slate-400">
                La <b className="text-slate-200">contraseña temporal</b> se genera al crear la empresa y se muestra una sola vez. El administrador deberá
                cambiarla en su primer ingreso.
              </p>
            </div>
          ) : (
            <ReviewStep form={form} onEdit={goTo} />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-3">
          {result ? (
            <>
              <button type="button" onClick={() => { setResult(null); setForm(EMPTY); setErrors({}); setStep(0); setCuitState('idle'); setUserState('idle'); setNameState('idle'); }} className="px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                Registrar otra empresa
              </button>
              <div className="flex items-center gap-2">
                <CopyButton text={credentials} label="todas las credenciales" />
                <button type="button" onClick={() => onViewTenant(result.tenant.id)} className="px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                  Ver la empresa en el panel
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" onClick={() => (step === 0 ? requestClose() : goTo(step - 1))} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                {step === 0 ? (
                  'Cancelar'
                ) : (
                  <>
                    <ArrowLeft className="w-3.5 h-3.5" /> Atrás
                  </>
                )}
              </button>
              {step < 3 ? (
                <button type="button" onClick={goNext} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white cursor-pointer">
                  Siguiente <ArrowRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button type="button" onClick={submit} disabled={submitting} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white cursor-pointer">
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {submitting ? 'Creando empresa…' : 'Crear empresa'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {confirmDiscard && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="tw-discard-title">
          <div className="w-full max-w-sm bg-[#11192C] border border-slate-700 rounded-xl p-5 space-y-3">
            <h3 id="tw-discard-title" className="text-sm font-semibold text-slate-100">
              ¿Descartar el registro?
            </h3>
            <p className="text-xs text-slate-400">Se perderán los datos cargados en el asistente.</p>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setConfirmDiscard(false)} className="px-3 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
                Seguir editando
              </button>
              <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs bg-rose-600 hover:bg-rose-500 text-white cursor-pointer">
                Descartar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- review & success

function ReviewStep({ form, onEdit }: { form: WizardForm; onEdit: (step: number) => void }) {
  const Row = ({ k, v }: { k: string; v: ReactNode }) => (
    <div className="flex gap-3 py-1 text-xs">
      <dt className="w-36 shrink-0 text-slate-400">{k}</dt>
      <dd className="text-slate-100 min-w-0 break-words">{v}</dd>
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
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Revisa los datos. Al crear la empresa se generan sus 3 perfiles base y el usuario administrador.</p>
      <Block title="Empresa" step={0}>
        <Row k="Razón social" v={form.name} />
        <Row k="CUIT" v={<span className="font-mono">{form.cuit}</span>} />
        <Row k="Ciudad" v={form.city} />
        <Row k="Sucursales" v={form.branches.join(' · ')} />
        <Row k="Contacto" v={`${form.contactName} · ${form.contactEmail} · ${form.contactPhone}`} />
      </Block>
      <Block title="Plan y servicio" step={1}>
        <Row k="Estado" v={form.status === 'piloto' ? 'Piloto' : 'Activo'} />
        <Row k="Plan" v={form.planTier} />
        <Row k="Cupo" v={`${form.vehicleQuota} unidades`} />
        <Row k="Retención de video" v={`${form.retentionDays} días`} />
        <Row k="Moneda" v={`${form.currency} · referencia ${form.referenceCurrency}`} />
        <Row
          k="Configuración inicial"
          v={[form.preventivePlans && '3 planes preventivos', form.alertRules && '4 reglas de alerta'].filter(Boolean).join(' · ') || 'Ninguna (empresa vacía)'}
        />
      </Block>
      <Block title="Usuario administrador" step={2}>
        <Row k="Nombre" v={form.adminName} />
        <Row k="Usuario" v={<span className="font-mono">{form.username}</span>} />
        <Row k="Permisos" v="Acceso total a los 10 módulos" />
        <Row k="Contraseña" v="Temporal, generada al crear; cambio obligatorio en el primer ingreso" />
      </Block>
    </div>
  );
}

function SuccessStep({ result, credentials, panelUrl }: { result: TenantCreatedResult; credentials: string; panelUrl: string }) {
  const Item = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-800 last:border-0">
      <div className="min-w-0">
        <div className="text-[11px] text-slate-400">{label}</div>
        <div className={`text-sm text-slate-100 break-all ${mono ? 'font-mono' : ''}`}>{value}</div>
      </div>
      <CopyButton text={value} label={label} />
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
        <div>
          <p className="text-sm text-slate-100">
            <b>{result.tenant.name}</b> quedó registrada con su usuario administrador.
          </p>
          <p className="text-xs text-slate-400 mt-0.5">Entrégale estas credenciales por un canal seguro.</p>
        </div>
      </div>
      <div className="p-3.5 rounded-xl border border-slate-800 bg-[#0B1120]">
        <Item label="Panel" value={panelUrl} />
        <Item label="Usuario" value={result.admin.username} mono />
        <Item label="Contraseña temporal" value={result.temporaryPassword} mono />
      </div>
      <div role="note" className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
        <ClipboardCopy className="w-4 h-4 shrink-0" />
        <span>
          <b>Esta contraseña no se volverá a mostrar.</b> Cópiala ahora («Copiar» en el pie copia todo junto). Si se pierde, se puede generar otra desde el
          listado de empresas. El administrador deberá cambiarla en su primer ingreso.
        </span>
      </div>
      <pre className="sr-only">{credentials}</pre>
    </div>
  );
}
