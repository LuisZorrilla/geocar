/**
 * Public sources for the suggested exchange rate. The suggestion is never saved by itself:
 * the superadmin sees it and confirms it (POST /api/currencies/:code/rates).
 *
 * Formats checked on 2026-11-22:
 *  - dolarapi.com/v1/dolares          [{ casa, nombre, compra, venta, fechaActualizacion }]
 *  - ve.dolarapi.com/v1/dolares       [{ fuente, nombre, promedio, fechaActualizacion }]
 *  - mindicador.cl/api/dolar          { nombre, serie: [{ fecha, valor }] }
 *  - cl.dolarapi.com/v1/cotizaciones/usd  { compra, venta, fechaActualizacion }
 * Each source is its own adapter: replacing one doesn't touch the rest.
 */

export interface RateSource {
  id: string;
  currency: string;
  label: string;
  url: string;
  /** Units of the currency per 1 USD and the date the source reports. */
  parse: (json: unknown) => { perUsd: number; at: string } | null;
}

export interface RateSuggestion {
  sourceId: string;
  label: string;
  currency: string;
  perUsd: number | null;
  at: string | null;
  url: string;
  error?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

const dolarApiAr = (casa: string, label: string): RateSource => ({
  id: `dolarapi_ar_${casa}`,
  currency: 'ARS',
  label,
  url: `https://dolarapi.com/v1/dolares/${casa}`,
  // Selling price: what it costs to buy dollars.
  parse: (json) => {
    const j = json as { venta?: unknown; fechaActualizacion?: unknown };
    const v = num(j?.venta);
    return v ? { perUsd: v, at: str(j.fechaActualizacion) ?? new Date().toISOString() } : null;
  },
});

const dolarApiVe = (fuente: string, label: string): RateSource => ({
  id: `dolarapi_ve_${fuente}`,
  currency: 'VES',
  label,
  url: `https://ve.dolarapi.com/v1/dolares/${fuente}`,
  parse: (json) => {
    const j = json as { promedio?: unknown; venta?: unknown; fechaActualizacion?: unknown };
    const v = num(j?.promedio) ?? num(j?.venta);
    return v ? { perUsd: v, at: str(j.fechaActualizacion) ?? new Date().toISOString() } : null;
  },
});

export const RATE_SOURCES: RateSource[] = [
  dolarApiAr('oficial', 'Dólar oficial (BNA, venta) · dolarapi.com'),
  dolarApiAr('bolsa', 'Dólar MEP (venta) · dolarapi.com'),
  dolarApiAr('blue', 'Dólar blue (venta) · dolarapi.com'),
  dolarApiAr('mayorista', 'Dólar mayorista (venta) · dolarapi.com'),
  dolarApiVe('oficial', 'Dólar oficial BCV · ve.dolarapi.com'),
  dolarApiVe('paralelo', 'Dólar paralelo · ve.dolarapi.com'),
  {
    id: 'mindicador_cl_dolar',
    currency: 'CLP',
    label: 'Dólar observado (Banco Central) · mindicador.cl',
    url: 'https://mindicador.cl/api/dolar',
    parse: (json) => {
      const first = (json as { serie?: Array<{ fecha?: unknown; valor?: unknown }> })?.serie?.[0];
      const v = num(first?.valor);
      return v ? { perUsd: v, at: str(first?.fecha) ?? new Date().toISOString() } : null;
    },
  },
  {
    id: 'dolarapi_cl',
    currency: 'CLP',
    label: 'Dólar (venta) · cl.dolarapi.com',
    url: 'https://cl.dolarapi.com/v1/cotizaciones/usd',
    parse: (json) => {
      const j = json as { venta?: unknown; fechaActualizacion?: unknown };
      const v = num(j?.venta);
      return v ? { perUsd: v, at: str(j.fechaActualizacion) ?? new Date().toISOString() } : null;
    },
  },
];

export const sourcesFor = (currency: string) => RATE_SOURCES.filter((s) => s.currency === currency);
export const findSource = (id: string | undefined) => RATE_SOURCES.find((s) => s.id === id);

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Queries one source (5 s timeout). Never throws: errors come back in `error`. */
export async function fetchSuggestion(source: RateSource, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<RateSuggestion> {
  const base = { sourceId: source.id, label: source.label, currency: source.currency, url: source.url };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(source.url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { ...base, perUsd: null, at: null, error: `La fuente respondió ${res.status}.` };
    const parsed = source.parse(await res.json());
    if (!parsed) return { ...base, perUsd: null, at: null, error: 'La fuente no trajo una cotización válida.' };
    return { ...base, perUsd: parsed.perUsd, at: parsed.at };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    return { ...base, perUsd: null, at: null, error: aborted ? 'La fuente no respondió a tiempo.' : 'No se pudo consultar la fuente.' };
  } finally {
    clearTimeout(timer);
  }
}
