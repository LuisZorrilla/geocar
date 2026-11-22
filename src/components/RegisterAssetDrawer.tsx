import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, BadgeCheck, CircleHelp, Info, Smartphone, Truck, X } from 'lucide-react';
import type { AssetType, Driver, ProtocolType, Tenant, UnitConnection, Vehicle } from '../shared/types.ts';
import { computeDriverAuthorization } from '../shared/drivers.ts';
import { Combobox, type ComboOption } from './Combobox.tsx';
import {
  COMPATIBILITY_LABELS,
  DEVICE_CATALOG,
  findCatalogModel,
  UPLINK_LABELS,
  type DeviceCatalogModel,
} from '../shared/deviceCatalog.ts';
import { brandsFor, composeBrandModel, modelsFor } from '../shared/vehicleCatalog.ts';

export interface CreateVehiclePayload {
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
  driverId?: string;
  /** Not sent for «Conexión Smartphone» (no hardware). */
  imei?: string;
  protocol: ProtocolType;
  connection: UnitConnection;
  deviceModel: string;
  deviceCatalogId?: string;
  engineHours: number;
}

const CONNECTION_OPTIONS: { value: UnitConnection; label: string }[] = [
  { value: 'dashcam', label: 'JT/T 808 + JT/T 1078 (dashcams con video)' },
  { value: 'traccar', label: 'Traccar nativo (GPS + CAN, p. ej. Teltonika)' },
  { value: 'obd', label: 'Telemetría OBD-II (rastreador Teltonika)' },
  { value: 'smartphone', label: 'Conexión Smartphone (celular del chofer)' },
];
const protocolOf = (c: UnitConnection): ProtocolType => (c === 'dashcam' ? 'JT808/JT1078' : 'Traccar');
/** OBD-II trackers, FMC003 first (the one for light vehicles). */
const OBD_CATALOG = DEVICE_CATALOG.filter((m) => m.kind === 'GPS + CAN').sort((a, b) =>
  a.id === 'teltonika-fmc003' ? -1 : b.id === 'teltonika-fmc003' ? 1 : a.model.localeCompare(b.model)
);

interface RegisterAssetDrawerProps {
  tenant: Tenant;
  availableTenants?: Tenant[];
  /** Registered drivers of the visible companies (may come without documents for non-admins). */
  drivers: Driver[];
  vehicles: Vehicle[];
  onCreateVehicle: (payload: CreateVehiclePayload) => Promise<void>;
  onClose: () => void;
}

type Field = 'unitCode' | 'plate' | 'brand' | 'model' | 'year' | 'engineHours' | 'device' | 'imei';
/** Visual order, used to focus the first field with an error. */
const FIELD_ORDER: Field[] = ['unitCode', 'plate', 'brand', 'model', 'year', 'engineHours', 'device', 'imei'];
const fieldId = (f: Field) => `asset-${f}`;

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1980;

const COMPAT_STYLE: Record<DeviceCatalogModel['compatibility'], { cls: string; icon: ReactNode }> = {
  alta: { cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300', icon: <BadgeCheck className="w-3.5 h-3.5" aria-hidden /> },
  media: { cls: 'bg-sky-500/10 border-sky-500/30 text-sky-300', icon: <CircleHelp className="w-3.5 h-3.5" aria-hidden /> },
  baja: { cls: 'bg-amber-500/10 border-amber-500/30 text-amber-300', icon: <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> },
};

const inputCls = (invalid?: boolean) =>
  `w-full px-3 py-2 bg-[#0B1120] border rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none ${
    invalid ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-800 focus:border-sky-500'
  }`;

function FieldError({ field, errors }: { field: Field; errors: Partial<Record<Field, string>> }) {
  const msg = errors[field];
  if (!msg) return null;
  return (
    <p id={`${fieldId(field)}-error`} className="mt-1 text-[11px] text-rose-300" aria-live="polite">
      {msg}
    </p>
  );
}

/** Slide-over form to register a vehicle or machine together with its GPS / dashcam. */
export function RegisterAssetDrawer({ tenant, availableTenants, drivers, vehicles, onCreateVehicle, onClose }: RegisterAssetDrawerProps) {
  const initialTenantId = tenant.id === 'all' ? (availableTenants?.[0]?.id ?? tenant.id) : tenant.id;
  const branchesOf = (id: string) => (availableTenants?.find((t) => t.id === id) ?? tenant).branches;

  const [form, setForm] = useState({
    tenantId: initialTenantId,
    branch: branchesOf(initialTenantId)[0] ?? '',
    assetType: 'vehiculo' as AssetType,
    unitCode: '',
    plate: '',
    brand: '',
    model: '',
    year: String(CURRENT_YEAR),
    engineHours: '0',
    driverId: '',
    driverText: '',
    connection: 'dashcam' as UnitConnection,
    deviceText: '',
    deviceCatalogId: null as string | null,
    imei: '',
  });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((p) => ({ ...p, [key]: value }));
  const touch = (f: Field) => setTouched((t) => ({ ...t, [f]: true }));

  const brandOptions = useMemo<ComboOption[]>(
    () => brandsFor(form.assetType).map((b) => ({ value: b, label: b })),
    [form.assetType]
  );
  const modelOptions = useMemo<ComboOption[]>(
    () => modelsFor(form.assetType, form.brand).map((m) => ({ value: m, label: m })),
    [form.assetType, form.brand]
  );
  const deviceOptions = useMemo<ComboOption[]>(
    () =>
      (form.connection === 'obd' ? OBD_CATALOG : DEVICE_CATALOG.filter((m) => m.protocol === protocolOf(form.connection))).map((m) => ({
        value: m.id,
        label: `${m.vendor} ${m.model}`,
        description: `${m.kind} · ${m.channels} · ${COMPATIBILITY_LABELS[m.compatibility]}`,
        group: m.vendor,
      })),
    [form.connection]
  );
  const isPhone = form.connection === 'smartphone';
  const catalogModel = findCatalogModel(form.deviceCatalogId ?? undefined);

  const errors = useMemo(() => {
    const e: Partial<Record<Field, string>> = {};
    if (!form.unitCode.trim()) e.unitCode = 'Ingresa el código interno de la unidad.';
    if (!form.plate.trim()) e.plate = form.assetType === 'vehiculo' ? 'Ingresa la patente.' : 'Ingresa el número de serie.';
    if (!form.brand.trim()) e.brand = 'Elige o escribe la marca.';
    if (!form.model.trim()) e.model = form.brand.trim() ? 'Elige o escribe el modelo.' : 'Primero elige la marca.';
    const year = Number(form.year);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > CURRENT_YEAR + 1) e.year = `Entre ${MIN_YEAR} y ${CURRENT_YEAR + 1}.`;
    const hours = Number(form.engineHours);
    if (form.engineHours.trim() === '' || !Number.isFinite(hours) || hours < 0) e.engineHours = 'Número igual o mayor a 0.';
    if (form.connection !== 'smartphone' && !form.deviceText.trim()) e.device = 'Elige el modelo de equipo instalado.';
    if (form.connection !== 'smartphone' && !/^\d{15}$/.test(form.imei)) e.imei = form.imei ? `Debe tener 15 dígitos (tiene ${form.imei.length}).` : 'Ingresa el IMEI de la etiqueta del equipo.';
    return e;
  }, [form]);
  /** Errors only show after the field is left or after trying to save. */
  const shown = useMemo(() => {
    const out: Partial<Record<Field, string>> = {};
    for (const f of FIELD_ORDER) if (errors[f] && (submitted || touched[f])) out[f] = errors[f];
    return out;
  }, [errors, submitted, touched]);

  const describedBy = (f: Field, extra?: string) => [shown[f] ? `${fieldId(f)}-error` : '', extra ?? ''].filter(Boolean).join(' ') || undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (first) {
      document.getElementById(fieldId(first))?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const brand = form.brand.trim();
      const model = form.model.trim();
      await onCreateVehicle({
        ...(tenant.id === 'all' ? { tenantId: form.tenantId } : {}),
        branch: form.branch,
        group: '',
        assetType: form.assetType,
        unitCode: form.unitCode.trim(),
        plate: form.plate.trim(),
        brandModel: composeBrandModel(brand, model),
        brand,
        model,
        year: Number(form.year),
        driverName: '',
        ...(form.driverId ? { driverId: form.driverId } : {}),
        ...(isPhone ? {} : { imei: form.imei }),
        protocol: protocolOf(form.connection),
        connection: form.connection,
        deviceModel: isPhone ? '' : form.deviceText.trim(),
        ...(!isPhone && form.deviceCatalogId ? { deviceCatalogId: form.deviceCatalogId } : {}),
        engineHours: Number(form.engineHours),
      });
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'No fue posible registrar la unidad.');
      setSubmitting(false);
    }
  };

  const isMachine = form.assetType === 'maquinaria_pesada';

  // Authorized drivers of the target company. Admins get documents (computed here); others get the server's last state.
  const targetTenantId = tenant.id === 'all' ? form.tenantId : tenant.id;
  const driverOptions = useMemo<ComboOption[]>(() => {
    return drivers
      .filter((d) => d.tenantId === targetTenantId)
      .map((d) => ({ d, state: d.documents ? computeDriverAuthorization(d).state : (d.lastAuthState ?? 'habilitado') }))
      .filter(({ state }) => state === 'habilitado' || state === 'por_vencer')
      .sort((a, b) => a.d.name.localeCompare(b.d.name, 'es'))
      .map(({ d, state }) => {
        const unit = vehicles.find((v) => v.driverId === d.id)?.unitCode;
        return {
          value: d.id,
          label: d.name,
          description: [
            d.licenseClasses?.length ? `Clases ${d.licenseClasses.join(', ')}` : '',
            state === 'por_vencer' ? 'documentos por vencer' : '',
            unit ? `hoy en ${unit}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        };
      });
  }, [drivers, vehicles, targetTenantId]);
  const chosenDriver = drivers.find((d) => d.id === form.driverId);
  const chosenDriverUnit = chosenDriver ? vehicles.find((v) => v.driverId === chosenDriver.id)?.unitCode : undefined;
  const classMismatch = useMemo(() => {
    const classes = chosenDriver?.licenseClasses;
    if (!classes?.length) return null;
    const machineClasses = ['E.2', 'G.1', 'G.2', 'G.3'];
    if (isMachine && !classes.some((c) => machineClasses.includes(c))) return 'Su licencia no tiene clase para maquinaria (E.2 o G).';
    if (!isMachine && !classes.some((c) => /^(B|C|D|E\.1|E\.3)/.test(c))) return 'Su licencia no tiene clase para vehículos (B, C, D o E.1).';
    return null;
  }, [chosenDriver, isMachine]);
  const dirty = Boolean(form.unitCode || form.plate || form.brand || form.model || form.deviceText || form.imei || form.driverId);
  const requestClose = () => {
    if (submitting) return;
    if (dirty && !window.confirm('¿Descartar los datos cargados de este activo?')) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs" onKeyDown={(e) => e.key === 'Escape' && requestClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-drawer-title"
        className="w-full max-w-md bg-[#0F172A] border-l border-slate-800 h-full overflow-y-auto p-6"
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-sky-400" />
              <h3 id="asset-drawer-title" className="text-base font-semibold text-slate-100">
                Registrar vehículo o maquinaria
              </h3>
            </div>
            <button type="button" onClick={requestClose} aria-label="Cerrar" className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          {serverError && (
            <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              {serverError}
            </div>
          )}
          {submitted && Object.keys(errors).length > 0 && (
            <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
              Revisa los {Object.keys(errors).length === 1 ? 'campo marcado' : `${Object.keys(errors).length} campos marcados`} en rojo.
            </div>
          )}

          <div className="space-y-3 text-xs">
            {availableTenants && tenant.id === 'all' && (
              <div>
                <label htmlFor="asset-tenant" className="block text-slate-300 mb-1">
                  Empresa destino
                </label>
                <select
                  id="asset-tenant"
                  value={form.tenantId}
                  onChange={(e) => setForm((p) => ({ ...p, tenantId: e.target.value, branch: branchesOf(e.target.value)[0] ?? '', driverId: '', driverText: '' }))}
                  className={inputCls()}
                >
                  {availableTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="asset-type" className="block text-slate-300 mb-1">
                  Tipo de activo
                </label>
                <select
                  id="asset-type"
                  value={form.assetType}
                  onChange={(e) => setForm((p) => ({ ...p, assetType: e.target.value as AssetType, brand: '', model: '' }))}
                  className={inputCls()}
                >
                  <option value="vehiculo">Vehículo / Transporte</option>
                  <option value="maquinaria_pesada">Maquinaria Pesada</option>
                </select>
              </div>
              <div>
                <label htmlFor="asset-branch" className="block text-slate-300 mb-1">
                  Sucursal
                </label>
                <select id="asset-branch" value={form.branch} onChange={(e) => set('branch', e.target.value)} className={inputCls()}>
                  {branchesOf(form.tenantId).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={fieldId('unitCode')} className="block text-slate-300 mb-1">
                  Código de unidad
                </label>
                <input
                  id={fieldId('unitCode')}
                  type="text"
                  placeholder={isMachine ? 'Ej. MQ-210' : 'Ej. CAM-101'}
                  value={form.unitCode}
                  onChange={(e) => set('unitCode', e.target.value)}
                  onBlur={() => touch('unitCode')}
                  aria-invalid={Boolean(shown.unitCode) || undefined}
                  aria-describedby={describedBy('unitCode')}
                  className={inputCls(Boolean(shown.unitCode))}
                />
                <FieldError field="unitCode" errors={shown} />
              </div>
              <div>
                <label htmlFor={fieldId('plate')} className="block text-slate-300 mb-1">
                  {isMachine ? 'N° de serie' : 'Patente'}
                </label>
                <input
                  id={fieldId('plate')}
                  type="text"
                  placeholder={isMachine ? 'Ej. CAT0320GC1234' : 'Ej. AB123CD'}
                  value={form.plate}
                  onChange={(e) => set('plate', e.target.value)}
                  onBlur={() => touch('plate')}
                  aria-invalid={Boolean(shown.plate) || undefined}
                  aria-describedby={describedBy('plate')}
                  className={inputCls(Boolean(shown.plate))}
                />
                <FieldError field="plate" errors={shown} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={fieldId('brand')} className="block text-slate-300 mb-1">
                  Marca
                </label>
                <Combobox
                  id={fieldId('brand')}
                  value={form.brand}
                  options={brandOptions}
                  allowCustom
                  placeholder="Buscar marca…"
                  invalid={Boolean(shown.brand)}
                  describedBy={describedBy('brand')}
                  onBlur={() => touch('brand')}
                  onChange={(text, option) =>
                    setForm((p) => {
                      const brand = option?.label ?? text;
                      // A different brand invalidates the chosen model.
                      return brand.trim().toLowerCase() === p.brand.trim().toLowerCase() ? { ...p, brand } : { ...p, brand, model: '' };
                    })
                  }
                />
                <FieldError field="brand" errors={shown} />
              </div>
              <div>
                <label htmlFor={fieldId('model')} className="block text-slate-300 mb-1">
                  Modelo
                </label>
                <Combobox
                  id={fieldId('model')}
                  value={form.model}
                  options={modelOptions}
                  allowCustom
                  disabled={!form.brand.trim()}
                  placeholder={form.brand.trim() ? 'Buscar modelo…' : 'Elige la marca'}
                  emptyText="Sin modelos cargados: escribe el modelo"
                  invalid={Boolean(shown.model)}
                  describedBy={describedBy('model')}
                  onBlur={() => touch('model')}
                  onChange={(text, option) => set('model', option?.label ?? text)}
                />
                <FieldError field="model" errors={shown} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={fieldId('year')} className="block text-slate-300 mb-1">
                  Año
                </label>
                <input
                  id={fieldId('year')}
                  type="number"
                  inputMode="numeric"
                  min={MIN_YEAR}
                  max={CURRENT_YEAR + 1}
                  value={form.year}
                  onChange={(e) => set('year', e.target.value)}
                  onBlur={() => touch('year')}
                  aria-invalid={Boolean(shown.year) || undefined}
                  aria-describedby={describedBy('year')}
                  className={`${inputCls(Boolean(shown.year))} font-mono`}
                />
                <FieldError field="year" errors={shown} />
              </div>
              <div>
                <label htmlFor={fieldId('engineHours')} className="block text-slate-300 mb-1">
                  Horómetro actual (h)
                </label>
                <input
                  id={fieldId('engineHours')}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={form.engineHours}
                  onChange={(e) => set('engineHours', e.target.value)}
                  onBlur={() => touch('engineHours')}
                  aria-invalid={Boolean(shown.engineHours) || undefined}
                  aria-describedby={describedBy('engineHours')}
                  className={`${inputCls(Boolean(shown.engineHours))} font-mono`}
                />
                <FieldError field="engineHours" errors={shown} />
              </div>
            </div>

            <div>
              <label htmlFor="asset-driver" className="block text-slate-300 mb-1">
                Chofer asignado <span className="text-slate-500">(opcional)</span>
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Combobox
                    id="asset-driver"
                    value={form.driverText}
                    options={driverOptions}
                    placeholder={driverOptions.length ? 'Buscar chofer autorizado…' : 'No hay choferes autorizados'}
                    emptyText="Ningún chofer autorizado coincide"
                    describedBy="asset-driver-hint"
                    onChange={(text, option) => setForm((p) => ({ ...p, driverText: text, driverId: option?.value ?? '' }))}
                  />
                </div>
                {form.driverId && (
                  <button type="button" onClick={() => setForm((p) => ({ ...p, driverText: '', driverId: '' }))} className="px-3 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer">
                    Quitar
                  </button>
                )}
              </div>
              <p id="asset-driver-hint" className="mt-1 text-[11px] text-slate-500">
                Solo aparecen choferes con documentos verificados y vigentes. ¿No está? Regístralo en el menú «Choferes». Sin chofer, la unidad queda «Sin chofer asignado».
              </p>
              {classMismatch && (
                <p className="mt-1 text-[11px] text-amber-300 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" aria-hidden /> {classMismatch}
                </p>
              )}
              {chosenDriverUnit && (
                <p className="mt-1 text-[11px] text-amber-300">Hoy conduce {chosenDriverUnit}: esa unidad quedará sin chofer.</p>
              )}
            </div>

            <div className="pt-3 border-t border-slate-800 space-y-3">
              <div className="text-slate-200 font-medium">Equipo GPS / Dashcam</div>
              <div>
                <label htmlFor="asset-protocol" className="block text-slate-300 mb-1">
                  Protocolo
                </label>
                <select
                  id="asset-protocol"
                  value={form.connection}
                  onChange={(e) => {
                    const connection = e.target.value as UnitConnection;
                    // OBD-II: preselect the usual tracker (FMC003 for vehicles, FMC650 for machinery).
                    const preset =
                      connection === 'obd' ? findCatalogModel(form.assetType === 'maquinaria_pesada' ? 'teltonika-fmc650' : 'teltonika-fmc003') : undefined;
                    setForm((p) => ({
                      ...p,
                      connection,
                      deviceText: preset ? `${preset.vendor} ${preset.model}` : '',
                      deviceCatalogId: preset?.id ?? null,
                    }));
                  }}
                  className={inputCls()}
                >
                  {CONNECTION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {form.connection === 'obd' && (
                  <p className="mt-1 text-[11px] text-slate-400">
                    El equipo queda en «Telemetría OBD-II» y se da de alta solo en Traccar. Después, desde ahí, se le manda el SMS de configuración.
                  </p>
                )}
              </div>
              {isPhone ? (
                <div id="asset-phone-card" className="p-3 rounded-lg bg-[#0B1120] border border-slate-800 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-slate-200">
                    <Smartphone className="w-3.5 h-3.5 text-sky-400" aria-hidden /> Sin equipo instalado
                  </div>
                  <p className="text-slate-400">
                    La posición de la unidad la manda el celular del chofer asignado (Traccar Client). No hace falta modelo ni IMEI.
                  </p>
                  {chosenDriver?.phoneTracker ? (
                    <p className="text-emerald-300">
                      {chosenDriver.name} ya tiene el celular {chosenDriver.phoneTracker.identifier} conectado: la unidad se rastrea desde el alta.
                    </p>
                  ) : (
                    <p className="text-amber-300">
                      {chosenDriver ? `${chosenDriver.name} todavía no tiene celular conectado.` : 'Asigna un chofer para rastrear la unidad.'} Conéctalo en
                      Configuración de Cámaras → Conexión Smartphone.
                    </p>
                  )}
                </div>
              ) : (
              <>
              <div>
                <label htmlFor={fieldId('device')} className="block text-slate-300 mb-1">
                  Modelo de equipo
                </label>
                <Combobox
                  id={fieldId('device')}
                  value={form.deviceText}
                  options={deviceOptions}
                  allowCustom
                  placeholder="Buscar por marca o modelo (ej. JC181)…"
                  invalid={Boolean(shown.device)}
                  describedBy={describedBy('device', 'asset-device-card')}
                  onBlur={() => touch('device')}
                  onChange={(text, option) => setForm((p) => ({ ...p, deviceText: text, deviceCatalogId: option?.value ?? null }))}
                />
                <FieldError field="device" errors={shown} />

                {catalogModel ? (
                  <div id="asset-device-card" className="mt-2 p-3 rounded-lg bg-[#0B1120] border border-slate-800 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] ${COMPAT_STYLE[catalogModel.compatibility].cls}`}
                      >
                        {COMPAT_STYLE[catalogModel.compatibility].icon}
                        {COMPATIBILITY_LABELS[catalogModel.compatibility]}
                      </span>
                      <span className="text-slate-400">{catalogModel.kind}</span>
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt className="text-slate-500">Cámaras</dt>
                      <dd className="text-slate-200">{catalogModel.channels}</dd>
                      <dt className="text-slate-500">Sale por</dt>
                      <dd className="text-slate-200">{catalogModel.uplinks.map((u) => UPLINK_LABELS[u]).join(' o ')}</dd>
                    </dl>
                    <p className={catalogModel.compatibility === 'baja' ? 'text-amber-300' : 'text-slate-400'}>{catalogModel.note}</p>
                    {catalogModel.compatibility === 'baja' && (
                      <p className="text-amber-300">No se conectará a Traccar por JT/T 808: conviene elegir otro equipo.</p>
                    )}
                  </div>
                ) : (
                  form.deviceText.trim() && (
                    <p id="asset-device-card" className="mt-2 flex items-start gap-1.5 text-slate-400">
                      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sky-400" aria-hidden />
                      Modelo fuera del catálogo: se usará el perfil{' '}
                      {form.connection === 'dashcam' ? 'JT/T 808 genérico' : 'Traccar estándar'}. Puedes ajustarlo después en Configuración de
                      Cámaras.
                    </p>
                  )
                )}
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor={fieldId('imei')} className="text-slate-300">
                    IMEI del equipo
                  </label>
                  <span className={`font-mono text-[11px] ${form.imei.length === 15 ? 'text-emerald-300' : 'text-slate-500'}`} aria-hidden>
                    {form.imei.length}/15
                  </span>
                </div>
                <input
                  id={fieldId('imei')}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={15}
                  placeholder="15 dígitos, en la etiqueta del equipo"
                  value={form.imei}
                  onChange={(e) => set('imei', e.target.value.replace(/\D/g, '').slice(0, 15))}
                  onBlur={() => touch('imei')}
                  aria-invalid={Boolean(shown.imei) || undefined}
                  aria-describedby={describedBy('imei')}
                  className={`${inputCls(Boolean(shown.imei))} font-mono`}
                />
                <FieldError field="imei" errors={shown} />
              </div>
              </>
              )}
            </div>
          </div>

          <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-800">
            <button type="button" onClick={requestClose} className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Guardando…' : 'Guardar activo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
