import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  crossFactor,
  formatMoney,
  PIVOT_CURRENCY,
  type CurrencyCode,
  type CurrencyDef,
  type ExchangeRate,
} from '../shared/currency.ts';
import type { Tenant, TenantBootstrapResponse } from '../shared/types.ts';

interface MoneyState {
  currencies: CurrencyDef[];
  rates: ExchangeRate[];
  tenants: Tenant[];
  /** Company in scope (the "Todas las empresas" summary for the superadmin in the global view). */
  active: Tenant | null;
}

const MoneyContext = createContext<MoneyState>({ currencies: [], rates: [], tenants: [], active: null });

export function MoneyProvider({ data, children }: { data: TenantBootstrapResponse | null; children: ReactNode }) {
  const value = useMemo<MoneyState>(
    () => ({
      currencies: data?.currencies ?? [],
      rates: data?.exchangeRates ?? [],
      tenants: data?.availableTenants ?? (data?.tenant ? [data.tenant] : []),
      active: data?.tenant ?? null,
    }),
    [data?.currencies, data?.exchangeRates, data?.availableTenants, data?.tenant]
  );
  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}

export interface MoneyApi {
  currencies: CurrencyDef[];
  enabled: CurrencyDef[];
  rates: ExchangeRate[];
  find: (code: CurrencyCode | null | undefined) => CurrencyDef | null;
  /** Currency of a company (the one in scope when no id is given). */
  currencyOf: (tenantId?: string) => CurrencyDef | null;
  /** "$ 1.234,50" in the company's currency. */
  fmt: (amount: number, tenantId?: string, opts?: { withCode?: boolean; compact?: boolean }) => string;
  /** Same, in an explicit currency. */
  fmtIn: (amount: number, code: CurrencyCode | null | undefined, opts?: { withCode?: boolean; compact?: boolean }) => string;
  /** Equivalent in the company's reference currency with the rate of a date; null when it doesn't apply. */
  equivalent: (amount: number, tenantId?: string, dateIso?: string) => string | null;
  /** Factor from → to at a date (null when a rate is missing). */
  factor: (from: CurrencyCode, to: CurrencyCode, dateIso?: string) => number | null;
  /** Superadmin's global view: amounts of several companies are shown in the platform reference currency. */
  consolidated: boolean;
  /**
   * Factor from a company's currency to the currency in scope at a date: 1 for a single company,
   * the conversion in the consolidated view (null when the company has no currency or a rate is missing).
   */
  toScope: (tenantId: string, dateIso?: string) => number | null;
}

export function useMoney(): MoneyApi {
  const s = useContext(MoneyContext);
  return useMemo(() => {
    const find = (code: CurrencyCode | null | undefined) => (code ? s.currencies.find((c) => c.code === code) ?? null : null);
    const tenantOf = (tenantId?: string) =>
      !tenantId || tenantId === s.active?.id ? s.active : s.tenants.find((t) => t.id === tenantId) ?? null;
    const currencyOf = (tenantId?: string) => find(tenantOf(tenantId)?.currency ?? null);
    const factor = (from: CurrencyCode, to: CurrencyCode, dateIso?: string) => crossFactor(s.rates, from, to, dateIso)?.factor ?? null;
    return {
      currencies: s.currencies,
      enabled: s.currencies.filter((c) => c.enabled),
      rates: s.rates,
      find,
      currencyOf,
      fmt: (amount, tenantId, opts) => formatMoney(amount, currencyOf(tenantId), opts),
      fmtIn: (amount, code, opts) => formatMoney(amount, find(code) ?? code ?? null, opts),
      equivalent: (amount, tenantId, dateIso) => {
        const t = tenantOf(tenantId);
        const from = t?.currency;
        const to = t?.referenceCurrency ?? PIVOT_CURRENCY;
        if (!from || from === to || !amount) return null;
        const f = factor(from, to, dateIso);
        return f === null ? null : formatMoney(amount * f, find(to) ?? to);
      },
      factor,
      consolidated: s.active?.id === 'all',
      toScope: (tenantId, dateIso) => {
        if (s.active?.id !== 'all') return 1;
        const from = tenantOf(tenantId)?.currency;
        const to = s.active.currency;
        if (!from || !to) return null;
        return from === to ? 1 : factor(from, to, dateIso);
      },
    };
  }, [s]);
}

/**
 * Amount in the company's currency and, small, its equivalent in the reference currency
 * (with the rate of the document's date). Use it for totals and indicators, not every cell.
 */
export function Money({
  amount,
  tenantId,
  date,
  showEquivalent = false,
  compact,
  className,
}: {
  amount: number;
  tenantId?: string;
  date?: string;
  showEquivalent?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const m = useMoney();
  const eq = showEquivalent ? m.equivalent(amount, tenantId, date) : null;
  return (
    <span className={className}>
      {m.fmt(amount, tenantId, { compact })}
      {eq && (
        <span className="ml-1 text-[10px] font-normal text-slate-500" title="Equivalente con el tipo de cambio de la fecha del documento">
          ≈ {eq}
        </span>
      )}
    </span>
  );
}
