import { formatMoney, type CurrencyDef } from '../../src/shared/currency.ts';
/**
 * Format-neutral report model. Each export is built once as a Report and then
 * rendered as PDF (pdf.ts), Excel (xlsx.ts) or CSV (csv.ts), so the three
 * files always show the same data.
 */

export type ExportFormat = 'pdf' | 'xlsx' | 'csv';

export function parseFormat(value: unknown): ExportFormat {
  return value === 'pdf' || value === 'xlsx' ? value : 'csv';
}

/** Visual tone of a status value. The text always carries the meaning; color only reinforces it. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export interface StatusValue {
  text: string;
  tone: Tone;
}

export type CellValue = string | number | boolean | StatusValue | null | undefined;

/**
 * - text / auto: plain text (auto keeps numbers as numbers, used by key/value sections)
 * - date: ISO "YYYY-MM-DD" (or a full ISO timestamp, only the day is shown)
 * - datetime: full ISO timestamp, shown in Argentina time
 * - money: amount in the column's currency (or the report's); percent: 0–100
 */
export type ColumnKind = 'text' | 'auto' | 'number' | 'money' | 'date' | 'datetime' | 'percent' | 'status';

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Relative width (≈ characters). Defaults by kind. */
  width?: number;
  /** Decimals for number columns (default 0). */
  decimals?: number;
  /** Totals row: sum (numbers) or count of non-empty cells. */
  total?: 'sum' | 'count';
  /** money: currency of the amounts (defaults to the report's). */
  currency?: MoneyCurrency | null;
}

/** Currency of money columns and indicators (symbol, decimals, number locale). */
export type MoneyCurrency = Pick<CurrencyDef, 'code' | 'symbol' | 'decimals' | 'locale'>;

export type Row = Record<string, CellValue>;

export interface Section {
  id: string;
  title: string;
  description?: string;
  columns: Column[];
  rows: Row[];
  /** Message shown when there are no rows. */
  empty: string;
  /** Rows left out because of MAX_ROWS (the report says so instead of cutting silently). */
  omitted?: number;
}

export interface Kpi {
  label: string;
  value: number | string;
  tone?: Tone;
  /** How a numeric value is shown (default: plain number). */
  format?: 'number' | 'money';
  /** money: currency of the value (defaults to the report's). */
  currency?: MoneyCurrency | null;
  /** Excel recomputes the indicator from the data sheet: count rows of a section, optionally where column = text, or sum a column. */
  formula?: { section: string; column: string; op: 'count' | 'sum'; equals?: string };
}

export interface Report {
  title: string;
  subtitle?: string;
  company: string;
  generatedBy: string;
  generatedAt: Date;
  filters: { label: string; value: string }[];
  kpis: Kpi[];
  sections: Section[];
  orientation?: 'portrait' | 'landscape';
  /** False for single-record reports (a unit dossier), where a filter box means nothing. */
  showFilters?: boolean;
  /** Currency of every money column and indicator that doesn't name its own. */
  currency?: MoneyCurrency | null;
}

/** Gives every money column and indicator the report's currency when it has none (renderers call it). */
export function applyReportCurrency(report: Report): Report {
  if (report.currency === undefined) return report;
  for (const sec of report.sections) for (const col of sec.columns) if (col.kind === 'money' && col.currency === undefined) col.currency = report.currency;
  for (const k of report.kpis) if (k.format === 'money' && k.currency === undefined) k.currency = report.currency;
  return report;
}

export const MAX_ROWS = 20_000;

/** Applies MAX_ROWS and records how many rows were left out. */
export function section(input: Omit<Section, 'omitted'>): Section {
  if (input.rows.length <= MAX_ROWS) return input;
  return { ...input, rows: input.rows.slice(0, MAX_ROWS), omitted: input.rows.length - MAX_ROWS };
}

export const status = (text: string, tone: Tone): StatusValue => ({ text, tone });

export function isStatus(v: unknown): v is StatusValue {
  return typeof v === 'object' && v !== null && 'text' in v && 'tone' in v;
}

const TZ = 'America/Argentina/Buenos_Aires';

/** Parses "YYYY-MM-DD" or an ISO timestamp. Returns null when empty or invalid. */
export function parseDate(value: CellValue): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(d: Date, withTime = false): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(d);
}

/**
 * Wall-clock date in Argentina expressed as a UTC Date, which is what Excel stores
 * (Excel dates have no time zone). Date-only values keep their calendar day.
 */
export function excelDate(value: CellValue, withTime: boolean): Date | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const d = parseDate(value);
  if (!d) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour) % 24;
  return withTime
    ? new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute))
    : new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
}

const number = (n: number, decimals: number) =>
  n.toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Text shown for a cell in the PDF (and in CSV for dates/status). */
export function formatCell(value: CellValue, col: Column): string {
  if (value === null || value === undefined || value === '') return '';
  if (isStatus(value)) return value.text;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  switch (col.kind) {
    case 'date':
    case 'datetime': {
      const d = parseDate(value);
      return d ? formatDate(d, col.kind === 'datetime' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) : String(value);
    }
    case 'money':
      return typeof value === 'number' ? formatMoney(value, col.currency ?? null) : String(value);
    case 'percent':
      return typeof value === 'number' ? `${number(value, 0)} %` : String(value);
    case 'number':
      return typeof value === 'number' ? number(value, col.decimals ?? 0) : String(value);
    default:
      return typeof value === 'number' ? number(value, Number.isInteger(value) ? 0 : 1) : String(value);
  }
}

/** Totals for the columns that declare one (used by the PDF; Excel writes SUBTOTAL formulas). */
export function columnTotal(sec: Section, col: Column): number | null {
  if (!col.total) return null;
  if (col.total === 'count') return sec.rows.filter((r) => r[col.key] !== null && r[col.key] !== undefined && r[col.key] !== '').length;
  return sec.rows.reduce((sum, r) => sum + (typeof r[col.key] === 'number' ? (r[col.key] as number) : 0), 0);
}

export function defaultWidth(col: Column): number {
  if (col.width) return col.width;
  switch (col.kind) {
    case 'date':
      return 11;
    case 'datetime':
      return 15;
    case 'money':
      return 13;
    case 'number':
    case 'percent':
      return 10;
    case 'status':
      return 16;
    default:
      return 18;
  }
}

/** "Estado: Por vencer" style filter list, skipping empty values. */
export function filterList(entries: [string, string | undefined | null][]): Report['filters'] {
  return entries.filter(([, v]) => v).map(([label, value]) => ({ label, value: value as string }));
}
