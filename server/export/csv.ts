import { applyReportCurrency, formatCell, type Report } from './report.ts';

/**
 * CSV writer for files meant to be opened with a double click in Excel.
 *
 * Defaults match Excel in Spanish (Argentina): ";" as separator, decimal comma,
 * UTF-8 BOM so accents display correctly, and CRLF line endings.
 *
 * Text cells are escaped per RFC 4180 and protected against CSV/formula
 * injection: a cell starting with = + - @ (or tab / CR) gets a leading
 * apostrophe so Excel shows it as text instead of executing it.
 */

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvOptions {
  separator?: string;
  decimalComma?: boolean;
  /** Digits for numeric cells. */
  decimals?: number;
  /** Per-column decimals, overriding `decimals`. */
  columnDecimals?: (number | undefined)[];
}

type CellOptions = Required<Omit<CsvOptions, 'columnDecimals'>>;

const FORMULA_START = /^[=+\-@\t\r]/;

function formatNumber(n: number, decimalComma: boolean, decimals: number): string {
  if (!Number.isFinite(n)) return '';
  const fixed = n.toFixed(decimals);
  return decimalComma ? fixed.replace('.', ',') : fixed;
}

export function csvCell(value: CsvValue, opts: CellOptions): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value, opts.decimalComma, opts.decimals);
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';

  let text = value;
  // A plain negative number ("-34,6") is data, not a formula.
  if (FORMULA_START.test(text) && !/^-\d+(,\d+)?$/.test(text)) text = `'${text}`;
  const needsQuotes =
    text.includes(opts.separator) || text.includes('"') || text.includes('\n') || text.includes('\r');
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvValue[][], options: CsvOptions = {}): string {
  const opts: CellOptions = {
    separator: options.separator ?? ';',
    decimalComma: options.decimalComma ?? true,
    decimals: options.decimals ?? 2,
  };
  const lines = [header, ...rows].map((row) => row.map((v, i) => csvCell(v, { ...opts, decimals: options.columnDecimals?.[i] ?? opts.decimals })).join(opts.separator));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** ASCII-only, filesystem-safe fragment for Content-Disposition file names. */
export function fileSlug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\b(s\.?a\.?)\b/gi, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export'
  );
}

/**
 * CSV of the report's main (first) section. Dates and statuses are written as the
 * same text the PDF shows; numbers keep the decimal comma.
 */
export function reportToCsv(report: Report): string {
  applyReportCurrency(report);
  const sec = report.sections[0];
  if (!sec) return toCsv([], []);
  const rows = sec.rows.map((row) =>
    sec.columns.map((col): CsvValue => {
      const v = row[col.key];
      if (typeof v === 'number' && col.kind !== 'date' && col.kind !== 'datetime') return v;
      return formatCell(v, col);
    })
  );
  const decimals = sec.columns.map((c) => (c.kind === 'money' ? (c.currency?.decimals ?? 2) : c.kind === 'number' ? (c.decimals ?? 0) : c.kind === 'percent' ? 0 : undefined));
  // "auto" columns mix integers and decimals: keep up to 2 decimals only when needed.
  const autoRows = rows.map((row) =>
    row.map((v, i) => (typeof v === 'number' && decimals[i] === undefined ? String(Number(v.toFixed(2))).replace('.', ',') : v))
  );
  return toCsv(
    sec.columns.map((c) => c.label),
    autoRows,
    { columnDecimals: decimals }
  );
}
