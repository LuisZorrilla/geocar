import crypto from 'crypto';
import {
  BASE_CURRENCIES,
  crossFactor,
  formatMoney,
  PIVOT_CURRENCY,
  rateAt,
  roundMoney,
  type CurrencyChange,
  type CurrencyCode,
  type CurrencyDef,
  type ExchangeRate,
  type MoneySnapshot,
} from '../../src/shared/currency.ts';
import type { AuditLog, FleetStoreState } from '../../src/shared/types.ts';
import type { StateRepository } from '../db/stateRepository.ts';

export class CurrencyError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface CurrencyActor {
  name: string;
  role: string;
  hidden?: boolean;
}

interface Ctx {
  state: FleetStoreState;
  repo: StateRepository;
  audit: (entry: Omit<AuditLog, 'id' | 'timestamp'>) => void;
  persist: () => void;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

/** Rates sent to the browser: about a year back plus the latest of each currency. */
const RATE_HISTORY_DAYS = 400;

/** Legacy amount fields (all amounts used to be labelled MXN) → neutral names. */
const LEGACY_FIELDS: Record<string, string> = {
  costMxn: 'cost',
  unitCostMxn: 'unitCost',
  subtotalMxn: 'subtotal',
  laborCostMxn: 'laborCost',
  partsCostMxn: 'partsCost',
  totalCostMxn: 'totalCost',
  estimatedCostMxn: 'estimatedCost',
};

function renameLegacy(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const [oldKey, newKey] of Object.entries(LEGACY_FIELDS)) {
    if (oldKey in obj) {
      if (obj[newKey] === undefined) obj[newKey] = obj[oldKey];
      delete obj[oldKey];
      changed = true;
    }
  }
  return changed;
}

export interface CurrencyPreview {
  tenantId: string;
  from: CurrencyCode | null;
  to: CurrencyCode;
  /** definir when the company had no currency (amounts kept as they are). */
  mode: 'definir' | 'convertir';
  /** Units of `to` per 1 unit of `from`; null when a rate is missing or nothing to convert. */
  factor: number | null;
  rateIds: string[];
  rateDate: string | null;
  missingRate: boolean;
  documents: { workOrders: number; maintenanceRecords: number; preventivePlans: number; partsInventory: number };
  totals: { before: number; after: number | null };
}

/**
 * Currencies, exchange rates and the company currency. Shares the FleetStore state and persistence:
 * a company conversion mutates every amount in memory and is saved in the store's single
 * diff transaction, so it is all-or-nothing.
 */
export class CurrencyService {
  private platformReference: CurrencyCode = PIVOT_CURRENCY;

  constructor(private readonly ctx: () => Ctx) {}

  private get state() {
    return this.ctx().state;
  }

  /** Loads the platform reference currency (consolidated view of the superadmin). */
  async load(): Promise<void> {
    const saved = await this.ctx().repo.getAppSetting<{ code: string }>('platform_reference_currency');
    if (saved?.code && this.find(saved.code)) this.platformReference = saved.code;
  }

  /**
   * Collections and legacy data: base currencies present, amount fields renamed from *Mxn,
   * reference currency set on every company. Returns true when something changed.
   */
  normalize(): boolean {
    const s = this.state;
    let changed = false;
    s.currencies ??= [];
    s.exchangeRates ??= [];
    s.currencyChanges ??= [];
    for (const base of BASE_CURRENCIES) {
      if (!s.currencies.some((c) => c.code === base.code)) {
        s.currencies.push({ ...base, updatedAt: new Date().toISOString() });
        changed = true;
      }
    }
    for (const t of s.tenants) {
      if (!t.referenceCurrency) {
        t.referenceCurrency = PIVOT_CURRENCY;
        changed = true;
      }
      if (t.currency === undefined) {
        t.currency = null;
        changed = true;
      }
    }
    for (const r of s.maintenanceRecords) changed = renameLegacy(r as never) || changed;
    for (const p of s.preventivePlans) changed = renameLegacy(p as never) || changed;
    for (const p of s.partsInventory) changed = renameLegacy(p as never) || changed;
    for (const o of s.workOrders) {
      changed = renameLegacy(o as never) || changed;
      for (const part of o.parts ?? []) changed = renameLegacy(part as never) || changed;
    }
    return changed;
  }

  // ---------- Queries ----------

  list(): CurrencyDef[] {
    return [...this.state.currencies].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }

  find(code: CurrencyCode | null | undefined): CurrencyDef | undefined {
    return code ? this.state.currencies.find((c) => c.code === code) : undefined;
  }

  get platformReferenceCurrency(): CurrencyCode {
    return this.platformReference;
  }

  tenantCurrency(tenantId: string): CurrencyCode | null {
    return this.state.tenants.find((t) => t.id === tenantId)?.currency ?? null;
  }

  /** Rates for the browser: the latest of each currency plus the last ~year. */
  ratesForClient(): ExchangeRate[] {
    const cutoff = Date.now() - RATE_HISTORY_DAYS * 86_400_000;
    const latest = new Map<string, ExchangeRate>();
    for (const r of this.state.exchangeRates) {
      const cur = latest.get(r.currency);
      if (!cur || r.effectiveAt > cur.effectiveAt) latest.set(r.currency, r);
    }
    const keep = new Set([...latest.values()].map((r) => r.id));
    return this.state.exchangeRates
      .filter((r) => keep.has(r.id) || Date.parse(r.effectiveAt) >= cutoff)
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  }

  history(code?: string, from?: string, to?: string): ExchangeRate[] {
    return this.state.exchangeRates
      .filter((r) => (!code || r.currency === code) && (!from || r.effectiveAt >= from) && (!to || r.effectiveAt <= to))
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  }

  changesOf(tenantId?: string): CurrencyChange[] {
    return this.state.currencyChanges
      .filter((c) => !tenantId || c.tenantId === tenantId)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Companies per currency (to block disabling a currency in use). */
  usage(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.state.tenants) if (t.currency) out[t.currency] = (out[t.currency] ?? 0) + 1;
    return out;
  }

  /**
   * Converts an amount of a company to another currency with the rate of a date (consolidated
   * view). Null when the company has no currency or a rate is missing.
   */
  convertTenantAmount(tenantId: string, amount: number, to: CurrencyCode, dateIso?: string): number | null {
    const from = this.tenantCurrency(tenantId);
    if (!from) return null;
    if (from === to) return amount;
    const f = crossFactor(this.state.exchangeRates, from, to, dateIso);
    return f ? amount * f.factor : null;
  }

  /**
   * Amount loaded in `currency` → the company's currency. Same currency (or none given) passes
   * through; otherwise converts with the rate of `dateIso` and returns the original snapshot.
   */
  toTenantAmount(
    tenantId: string,
    amount: number,
    currency: CurrencyCode | undefined,
    dateIso: string = new Date().toISOString()
  ): { amount: number; original?: MoneySnapshot } {
    const target = this.tenantCurrency(tenantId);
    if (!currency || currency === target) return { amount };
    const src = this.find(currency);
    if (!src || !src.enabled) throw new CurrencyError(`La moneda ${currency} no está habilitada.`);
    if (!target) {
      throw new CurrencyError('La empresa todavía no tiene moneda definida: el superadmin debe definirla antes de cargar importes en otra moneda.');
    }
    const f = crossFactor(this.state.exchangeRates, currency, target, dateIso);
    if (!f) throw new CurrencyError(`No hay tipo de cambio vigente de ${currency} a ${target} para esa fecha. El superadmin debe cargarlo en «Monedas».`);
    return {
      amount: roundMoney(amount * f.factor, this.find(target) ?? target),
      original: { currency, amount, factor: f.factor, rateIds: f.rateIds, at: dateIso },
    };
  }

  // ---------- Superadmin actions ----------

  updateCurrency(
    code: string,
    patch: Partial<Pick<CurrencyDef, 'name' | 'symbol' | 'decimals' | 'enabled' | 'suggestSource'>>,
    actor: CurrencyActor
  ): CurrencyDef {
    const cur = this.find(code);
    if (!cur) throw new CurrencyError('La moneda no existe.', 404);
    if (patch.enabled === false) {
      if (code === PIVOT_CURRENCY) throw new CurrencyError('El dólar es la moneda de referencia de los tipos de cambio y no se puede deshabilitar.');
      const using = this.state.tenants.filter((t) => t.currency === code || t.referenceCurrency === code);
      if (using.length) throw new CurrencyError(`No se puede deshabilitar: la usan ${using.length} empresa(s) (${using.map((t) => t.name).join(', ')}).`);
      if (this.platformReference === code) throw new CurrencyError('No se puede deshabilitar la moneda del consolidado de la plataforma.');
    }
    const changes: string[] = [];
    const set = <K extends keyof CurrencyDef>(k: K, v: CurrencyDef[K] | undefined, label: string) => {
      if (v === undefined || cur[k] === v) return;
      changes.push(`${label}: ${String(cur[k])} → ${String(v)}`);
      cur[k] = v;
    };
    set('name', patch.name?.trim(), 'nombre');
    set('symbol', patch.symbol?.trim(), 'símbolo');
    set('decimals', patch.decimals, 'decimales');
    set('enabled', patch.enabled, 'habilitada');
    set('suggestSource', patch.suggestSource, 'fuente sugerida');
    if (!changes.length) return cur;
    cur.updatedAt = new Date().toISOString();
    this.ctx().audit({
      tenantId: 'global',
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module: 'Monedas',
      action: 'Moneda actualizada',
      targetLabel: `${cur.name} (${cur.code})`,
      detail: changes.join(' · '),
    });
    this.ctx().persist();
    return cur;
  }

  addRate(
    code: string,
    input: { perUsd: number; effectiveAt?: string; source?: string; note?: string },
    actor: CurrencyActor
  ): ExchangeRate {
    const cur = this.find(code);
    if (!cur) throw new CurrencyError('La moneda no existe.', 404);
    if (code === PIVOT_CURRENCY) throw new CurrencyError('El dólar vale siempre 1: es la base de todos los tipos de cambio.');
    if (!(input.perUsd > 0) || !Number.isFinite(input.perUsd)) throw new CurrencyError('La cotización debe ser mayor que cero.');
    const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : new Date();
    if (Number.isNaN(effectiveAt.getTime())) throw new CurrencyError('Fecha de vigencia inválida.');
    if (effectiveAt.getTime() > Date.now() + 2 * 86_400_000) throw new CurrencyError('La vigencia no puede estar a más de 2 días en el futuro.');

    const previous = rateAt(this.state.exchangeRates, code, effectiveAt.toISOString());
    const rate: ExchangeRate = {
      id: `fx-${uid()}`,
      currency: code,
      perUsd: input.perUsd,
      effectiveAt: effectiveAt.toISOString(),
      source: input.source?.trim() || 'manual',
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      createdBy: actor.name,
      createdAt: new Date().toISOString(),
      tenantId: null,
    };
    this.state.exchangeRates.push(rate);
    const variation =
      previous && previous.perUsd > 0 ? ` (${((input.perUsd / previous.perUsd - 1) * 100).toFixed(2).replace('.', ',')} % vs. ${previous.perUsd})` : '';
    this.ctx().audit({
      tenantId: 'global',
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module: 'Monedas',
      action: 'Tipo de cambio cargado',
      targetLabel: `${cur.code} · ${rate.effectiveAt.slice(0, 10)}`,
      detail: `1 USD = ${input.perUsd} ${cur.code}${variation}. Fuente: ${rate.source}.`,
    });
    this.ctx().persist();
    return rate;
  }

  async setPlatformReference(code: string, actor: CurrencyActor): Promise<CurrencyCode> {
    const cur = this.find(code);
    if (!cur?.enabled) throw new CurrencyError('La moneda no existe o no está habilitada.');
    this.platformReference = code;
    await this.ctx().repo.setAppSetting('platform_reference_currency', { code });
    this.ctx().audit({
      tenantId: 'global',
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module: 'Monedas',
      action: 'Moneda del consolidado',
      targetLabel: cur.code,
      detail: `El consolidado de todas las empresas se muestra en ${cur.name}.`,
    });
    return code;
  }

  setReferenceCurrency(tenantId: string, code: string): void {
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new CurrencyError('La empresa no existe.', 404);
    if (!this.find(code)?.enabled) throw new CurrencyError('La moneda de referencia no está habilitada.');
    tenant.referenceCurrency = code;
  }

  private tenantDocs(tenantId: string) {
    const s = this.state;
    return {
      workOrders: s.workOrders.filter((o) => o.tenantId === tenantId),
      maintenanceRecords: s.maintenanceRecords.filter((r) => r.tenantId === tenantId),
      preventivePlans: s.preventivePlans.filter((p) => p.tenantId === tenantId),
      partsInventory: s.partsInventory.filter((p) => p.tenantId === tenantId),
    };
  }

  /** Total of the company's amounts (work orders + maintenance + inventory value), for the preview. */
  private tenantTotal(tenantId: string): number {
    const d = this.tenantDocs(tenantId);
    return (
      d.workOrders.reduce((s, o) => s + (o.totalCost || 0), 0) +
      d.maintenanceRecords.reduce((s, r) => s + (r.cost || 0), 0) +
      d.partsInventory.reduce((s, p) => s + (p.unitCost || 0) * (p.stockQty || 0), 0)
    );
  }

  previewTenantCurrency(tenantId: string, to: string): CurrencyPreview {
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant) throw new CurrencyError('La empresa no existe.', 404);
    if (!this.find(to)?.enabled) throw new CurrencyError('La moneda no existe o no está habilitada.');
    const from = tenant.currency ?? null;
    const d = this.tenantDocs(tenantId);
    const documents = {
      workOrders: d.workOrders.length,
      maintenanceRecords: d.maintenanceRecords.length,
      preventivePlans: d.preventivePlans.length,
      partsInventory: d.partsInventory.length,
    };
    const before = this.tenantTotal(tenantId);
    if (!from) {
      return { tenantId, from, to, mode: 'definir', factor: null, rateIds: [], rateDate: null, missingRate: false, documents, totals: { before, after: before } };
    }
    const f = from === to ? { factor: 1, rateIds: [] } : crossFactor(this.state.exchangeRates, from, to);
    const dates = f?.rateIds.map((id) => this.state.exchangeRates.find((r) => r.id === id)?.effectiveAt).filter(Boolean) as string[] | undefined;
    return {
      tenantId,
      from,
      to,
      mode: 'convertir',
      factor: f?.factor ?? null,
      rateIds: f?.rateIds ?? [],
      rateDate: dates?.length ? dates.sort()[dates.length - 1] : null,
      missingRate: !f,
      documents,
      totals: { before, after: f ? roundMoney(before * f.factor, this.find(to) ?? to) : null },
    };
  }

  /**
   * Defines or changes the company's currency.
   * - No currency yet: assigns it and keeps the amounts (they were loaded in that currency).
   * - convertir: converts every amount with the current rate (and keeps the trail in currencyChanges).
   * - rotulo: only relabels; the numbers stay as they are.
   */
  setTenantCurrency(tenantId: string, to: string, mode: 'convertir' | 'rotulo', actor: CurrencyActor): { change: CurrencyChange; preview: CurrencyPreview } {
    const preview = this.previewTenantCurrency(tenantId, to);
    const tenant = this.state.tenants.find((t) => t.id === tenantId)!;
    if (preview.from === to) throw new CurrencyError(`La empresa ya usa ${to}.`);
    const effective = preview.mode === 'definir' ? 'definir' : mode;
    if (effective === 'convertir' && preview.factor === null) {
      throw new CurrencyError(`Falta el tipo de cambio de ${preview.from} o de ${to}: cárgalo en «Monedas» antes de convertir.`);
    }
    const target = this.find(to)!;
    let documents = 0;
    if (effective === 'convertir') {
      const k = preview.factor!;
      const conv = (n: number) => roundMoney((n || 0) * k, target);
      const d = this.tenantDocs(tenantId);
      for (const o of d.workOrders) {
        for (const p of o.parts) {
          p.unitCost = conv(p.unitCost);
          p.subtotal = roundMoney(p.quantity * p.unitCost, target);
        }
        o.laborCost = conv(o.laborCost);
        o.partsCost = roundMoney(o.parts.reduce((s, p) => s + p.subtotal, 0), target);
        o.totalCost = roundMoney(o.partsCost + o.laborCost, target);
        documents++;
      }
      for (const r of d.maintenanceRecords) {
        r.cost = conv(r.cost);
        documents++;
      }
      for (const p of d.preventivePlans) {
        p.estimatedCost = conv(p.estimatedCost);
        documents++;
      }
      for (const p of d.partsInventory) {
        p.unitCost = conv(p.unitCost);
        documents++;
      }
    }
    tenant.currency = to;
    const change: CurrencyChange = {
      id: `cc-${uid()}`,
      tenantId,
      from: preview.from,
      to,
      mode: effective,
      factor: effective === 'convertir' ? preview.factor : null,
      rateIds: effective === 'convertir' ? preview.rateIds : [],
      documents,
      actorName: actor.name,
      at: new Date().toISOString(),
    };
    this.state.currencyChanges.push(change);
    const detail =
      effective === 'definir'
        ? `Moneda definida: ${target.name}. Los importes existentes se conservan.`
        : effective === 'rotulo'
          ? `Moneda cambiada de ${preview.from} a ${to} sin convertir importes (solo el rótulo).`
          : `Moneda cambiada de ${preview.from} a ${to}: ${documents} documentos convertidos con 1 ${preview.from} = ${preview.factor} ${to}. Total ${formatMoney(preview.totals.before, preview.from)} → ${formatMoney(preview.totals.after ?? 0, target)}.`;
    this.ctx().audit({
      tenantId,
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module: 'Monedas',
      action: effective === 'definir' ? 'Moneda de la empresa definida' : 'Moneda de la empresa cambiada',
      targetLabel: tenant.name,
      detail,
    });
    this.ctx().persist();
    return { change, preview };
  }
}
