/**
 * Currencies and exchange rates.
 *
 * Model: every rate is stored as "units of the currency per 1 USD" (USD is always 1).
 * Any cross rate is derived through USD (A→B = perUsd(B) / perUsd(A)), so the rates between
 * all currencies are consistent by construction: ARS→CLP always equals ARS→USD→CLP.
 *
 * Every stored amount of a company (work orders, parts, inventory, maintenance, plans) is in
 * the company's currency. Amounts loaded in another currency keep the original in a
 * MoneySnapshot; changing the company's currency converts all its amounts.
 */

export type CurrencyCode = string;

/** The pivot currency: its rate is always 1 and it can't be disabled. */
export const PIVOT_CURRENCY = 'USD';

export interface CurrencyDef {
  /** Same as code (ISO 4217). */
  id: CurrencyCode;
  code: CurrencyCode;
  name: string;
  symbol: string;
  decimals: number;
  /** Number formatting locale (thousands and decimal separators). */
  locale: string;
  enabled: boolean;
  sortOrder: number;
  /** Public source suggested for the automatic quote (see server/currency/sources.ts). */
  suggestSource?: string;
  updatedAt: string;
  tenantId?: null;
}

export interface ExchangeRate {
  id: string;
  currency: CurrencyCode;
  /** Units of `currency` per 1 USD. */
  perUsd: number;
  /** From when the rate applies (ISO). */
  effectiveAt: string;
  /** 'manual' or the suggestion source id. */
  source: string;
  note?: string;
  createdBy: string;
  createdAt: string;
  tenantId?: null;
}

/** Audit trail of a company's currency definitions and conversions. */
export interface CurrencyChange {
  id: string;
  tenantId: string;
  from: CurrencyCode | null;
  to: CurrencyCode;
  /** definir: first assignment, amounts kept. convertir: amounts converted. rotulo: only the label changed. */
  mode: 'definir' | 'convertir' | 'rotulo';
  /** Factor applied to the amounts (to per from); null when nothing was converted. */
  factor: number | null;
  rateIds: string[];
  documents: number;
  actorName: string;
  at: string;
}

/** Original of an amount loaded in a currency other than the company's. */
export interface MoneySnapshot {
  currency: CurrencyCode;
  amount: number;
  /** Factor applied: company currency per 1 unit of `currency`. */
  factor: number;
  rateIds: string[];
  /** Date of the rates used (ISO). */
  at: string;
}

export const BASE_CURRENCIES: Array<Omit<CurrencyDef, 'updatedAt'>> = [
  { id: 'ARS', code: 'ARS', name: 'Peso argentino', symbol: '$', decimals: 2, locale: 'es-AR', enabled: true, sortOrder: 1, suggestSource: 'dolarapi_ar_oficial' },
  { id: 'VES', code: 'VES', name: 'Bolívar venezolano', symbol: 'Bs.', decimals: 2, locale: 'es-VE', enabled: true, sortOrder: 2, suggestSource: 'dolarapi_ve_oficial' },
  { id: 'USD', code: 'USD', name: 'Dólar estadounidense', symbol: 'US$', decimals: 2, locale: 'es-AR', enabled: true, sortOrder: 3 },
  { id: 'CLP', code: 'CLP', name: 'Peso chileno', symbol: 'CLP$', decimals: 0, locale: 'es-CL', enabled: true, sortOrder: 4, suggestSource: 'mindicador_cl_dolar' },
];

const BASE_BY_CODE = new Map(BASE_CURRENCIES.map((c) => [c.code, c]));

export const isCurrencyCode = (v: unknown): v is CurrencyCode => typeof v === 'string' && /^[A-Z]{3}$/.test(v);

type CurrencyLike = Pick<CurrencyDef, 'code' | 'symbol' | 'decimals' | 'locale'>;

const resolve = (cur: CurrencyLike | CurrencyCode | null | undefined): CurrencyLike | null => {
  if (!cur) return null;
  if (typeof cur !== 'string') return cur;
  const base = BASE_BY_CODE.get(cur);
  return base ?? { code: cur, symbol: cur, decimals: 2, locale: 'es-AR' };
};

/** Rounds to the currency's decimals (CLP has none). */
export function roundMoney(amount: number, cur: CurrencyLike | CurrencyCode | null | undefined): number {
  const decimals = resolve(cur)?.decimals ?? 2;
  const f = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * f) / f;
}

/**
 * "$ 1.234,50", "US$ 99,00", "CLP$ 15.300", "Bs. 4.210,00". Without a currency (company not
 * yet defined) the amount is shown with 2 decimals and no symbol.
 */
export function formatMoney(
  amount: number,
  cur: CurrencyLike | CurrencyCode | null | undefined,
  opts: { withCode?: boolean; compact?: boolean } = {}
): string {
  const c = resolve(cur);
  const value = Number.isFinite(amount) ? amount : 0;
  if (!c) return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  if (opts.compact && Math.abs(value) >= 10_000) {
    const k = new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(value / 1000);
    return `${c.symbol} ${k}k${opts.withCode ? ` ${c.code}` : ''}`;
  }
  const n = new Intl.NumberFormat(c.locale, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }).format(value);
  return `${c.symbol} ${n}${opts.withCode ? ` ${c.code}` : ''}`;
}

/** Number format for Excel cells, e.g. `"US$" #,##0.00`. */
export function excelMoneyFormat(cur: CurrencyLike | CurrencyCode | null | undefined): string {
  const c = resolve(cur);
  const decimals = c?.decimals ?? 2;
  const pattern = decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0';
  return c ? `"${c.symbol.replace(/"/g, '')}" ${pattern}` : pattern;
}

/** Rate of `code` in force at `dateIso` (the latest with effectiveAt <= date). USD is always 1. */
export function rateAt(
  rates: ExchangeRate[],
  code: CurrencyCode,
  dateIso: string = new Date().toISOString()
): { perUsd: number; rate: ExchangeRate | null } | null {
  if (code === PIVOT_CURRENCY) return { perUsd: 1, rate: null };
  const at = Date.parse(dateIso);
  let best: ExchangeRate | null = null;
  for (const r of rates) {
    if (r.currency !== code || !(r.perUsd > 0)) continue;
    const t = Date.parse(r.effectiveAt);
    if (!Number.isFinite(t) || t > at) continue;
    if (!best || t > Date.parse(best.effectiveAt) || (t === Date.parse(best.effectiveAt) && r.createdAt > best.createdAt)) best = r;
  }
  return best ? { perUsd: best.perUsd, rate: best } : null;
}

/**
 * Factor to convert from → to at a date (units of `to` per 1 unit of `from`), through USD.
 * Null when a rate is missing.
 */
export function crossFactor(
  rates: ExchangeRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  dateIso?: string
): { factor: number; rateIds: string[] } | null {
  if (from === to) return { factor: 1, rateIds: [] };
  const a = rateAt(rates, from, dateIso);
  const b = rateAt(rates, to, dateIso);
  if (!a || !b) return null;
  return { factor: b.perUsd / a.perUsd, rateIds: [a.rate?.id, b.rate?.id].filter((x): x is string => Boolean(x)) };
}

/** Converts an amount through USD and rounds it to the target's decimals. Null when a rate is missing. */
export function convert(
  amount: number,
  from: CurrencyCode,
  to: CurrencyLike | CurrencyCode,
  rates: ExchangeRate[],
  dateIso?: string
): number | null {
  const target = resolve(to)!;
  const f = crossFactor(rates, from, target.code, dateIso);
  return f ? roundMoney(amount * f.factor, target) : null;
}

/** Days since the rate was set (for "stale quote" warnings). */
export const rateAgeDays = (rate: ExchangeRate, now = Date.now()) => Math.floor((now - Date.parse(rate.effectiveAt)) / 86_400_000);

/** VES moves daily; the rest are considered stale after a week. */
export const staleAfterDays = (code: CurrencyCode) => (code === 'VES' ? 1 : 7);

export const currencyLabel = (c: Pick<CurrencyDef, 'code' | 'name'> | null | undefined) => (c ? `${c.name} (${c.code})` : 'Sin moneda definida');
