import ExcelJS from 'exceljs';
import { applyReportCurrency, defaultWidth, excelDate, formatDate, isStatus, type CellValue, type Column, type Report, type Section, type Tone } from './report.ts';
import { excelMoneyFormat } from '../../src/shared/currency.ts';

/**
 * Excel workbook for working with the data:
 * - "Resumen" sheet first: who/when/filters, indicators (formulas over the data sheets) and links to each sheet.
 * - One sheet per section as an Excel Table (filter + sort buttons, banded rows, frozen header,
 *   totals row with SUBTOTAL so it follows the active filter).
 * - Real data types: dates as dates, amounts as numbers with currency format.
 * Strings are always written as text, never as formulas (no formula injection).
 */

const TONE_STYLE: Record<Tone, { font: string; fill: string }> = {
  ok: { font: 'FF047857', fill: 'FFD1FAE5' },
  warn: { font: 'FFB45309', fill: 'FFFEF3C7' },
  bad: { font: 'FFB91C1C', fill: 'FFFEE2E2' },
  info: { font: 'FF0369A1', fill: 'FFE0F2FE' },
  muted: { font: 'FF475569', fill: 'FFF1F5F9' },
};
const INK = 'FF0F172A';
const MUTED = 'FF64748B';
const BRAND = 'FF0369A1';
const HEADER_ROW = 4;

const NUM_FMT: Partial<Record<Column['kind'], string>> = {
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
  percent: '0%',
};

function numberFormat(col: Column): string | undefined {
  if (col.kind === 'money') return excelMoneyFormat(col.currency ?? null);
  if (col.kind === 'number') return col.decimals ? `#,##0.${'0'.repeat(col.decimals)}` : '#,##0';
  return NUM_FMT[col.kind];
}

function cellValue(value: CellValue, col: Column): ExcelJS.CellValue {
  if (value === null || value === undefined || value === '') return null;
  if (isStatus(value)) return value.text;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (col.kind === 'date' || col.kind === 'datetime') {
    const timed = col.kind === 'datetime' && typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value);
    return excelDate(value, timed) ?? String(value);
  }
  if (col.kind === 'percent' && typeof value === 'number') return value / 100;
  if (typeof value === 'number') return value;
  return String(value);
}

/** Sheet names: max 31 chars, no []:*?/\ and unique in the workbook. */
function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Datos';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/** Table and column names usable in structured references. */
const tableName = (id: string) => `T_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
const columnName = (label: string) => label.replace(/[[\]#'@]/g, ' ').trim();
const ref = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;
const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
/** In-workbook link as a HYPERLINK formula (works in Excel, LibreOffice and Google Sheets). */
const internalLink = (sheet: string, text: string): ExcelJS.CellValue => ({
  formula: `HYPERLINK(${quote(`#${ref(sheet)}!A1`)},${quote(text)})`,
  result: text,
});

function pageSetup(ws: ExcelJS.Worksheet, report: Report, landscape: boolean) {
  ws.pageSetup = {
    paperSize: 9,
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
  };
  ws.headerFooter.oddFooter = `&L&8GeoCar · ${report.title.replace(/&/g, '&&')} · ${report.company.replace(/&/g, '&&')}&R&8Página &P de &N`;
}

function writeSection(wb: ExcelJS.Workbook, report: Report, sec: Section, name: string) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: BRAND } } });
  ws.views = [{ state: 'frozen', ySplit: HEADER_ROW, showGridLines: false }];
  const cols = sec.columns;

  ws.getCell('A1').value = sec.title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: INK } };
  ws.getCell('A2').value = [
    `${sec.rows.length} registro${sec.rows.length === 1 ? '' : 's'}`,
    report.company,
    sec.description,
    sec.omitted ? `Se omitieron ${sec.omitted} filas por el límite del archivo` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  ws.getCell('A2').font = { size: 9, color: { argb: MUTED } };
  ws.getCell('A3').value = internalLink('Resumen', '← Volver al resumen');
  ws.getCell('A3').font = { size: 9, underline: true, color: { argb: BRAND } };

  cols.forEach((col, i) => {
    const width = Math.min(48, Math.max(columnName(col.label).length + 4, defaultWidth(col)));
    ws.getColumn(i + 1).width = width;
  });

  if (!sec.rows.length) {
    ws.getCell(`A${HEADER_ROW + 1}`).value = sec.empty;
    ws.getCell(`A${HEADER_ROW + 1}`).font = { italic: true, color: { argb: MUTED } };
    cols.forEach((col, i) => {
      const cell = ws.getCell(HEADER_ROW, i + 1);
      cell.value = columnName(col.label);
      cell.font = { bold: true, color: { argb: INK } };
    });
    pageSetup(ws, report, cols.length > 6);
    return;
  }

  // The row count is already in the sheet subtitle and the summary: Excel's totals row is for sums.
  const totalOf = (c: Column, i: number) => (i === 0 && c.total === 'count' ? undefined : c.total);
  const hasTotals = cols.some((c, i) => totalOf(c, i));
  ws.addTable({
    name: tableName(sec.id),
    ref: `A${HEADER_ROW}`,
    headerRow: true,
    totalsRow: hasTotals,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: cols.map((col, i) => ({
      name: columnName(col.label),
      filterButton: true,
      ...(totalOf(col, i) === 'sum'
        ? { totalsRowFunction: 'sum' as const }
        : totalOf(col, i) === 'count'
          ? { totalsRowFunction: 'count' as const }
          : i === 0 && hasTotals
            ? { totalsRowLabel: 'Total' }
            : {}),
    })),
    rows: sec.rows.map((row) => cols.map((col) => cellValue(row[col.key], col))),
  });

  // Number formats, wrapping and status colors (the text stays; color only reinforces it).
  const lastRow = HEADER_ROW + sec.rows.length + (hasTotals ? 1 : 0);
  cols.forEach((col, ci) => {
    const fmt = numberFormat(col);
    const wrap = defaultWidth(col) >= 30;
    for (let r = HEADER_ROW + 1; r <= lastRow; r++) {
      const cell = ws.getCell(r, ci + 1);
      if (fmt) cell.numFmt = fmt;
      if (wrap) cell.alignment = { wrapText: true, vertical: 'top' };
      const raw = sec.rows[r - HEADER_ROW - 1]?.[col.key];
      if (isStatus(raw)) {
        const s = TONE_STYLE[raw.tone];
        cell.font = { bold: true, color: { argb: s.font } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fill } };
      }
    }
  });
  pageSetup(ws, report, cols.length > 6);
  ws.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`;
}

function writeSummary(wb: ExcelJS.Workbook, report: Report, sheets: Map<string, string>) {
  const ws = wb.addWorksheet('Resumen', { properties: { tabColor: { argb: INK } } });
  ws.views = [{ showGridLines: false }];
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 46;

  let r = 1;
  const put = (text: string, font: Partial<ExcelJS.Font>) => {
    ws.getCell(r, 1).value = text;
    ws.getCell(r, 1).font = font;
    r++;
  };
  put(report.title, { bold: true, size: 16, color: { argb: INK } });
  if (report.subtitle) put(report.subtitle, { size: 10, color: { argb: MUTED } });
  put(`Empresa: ${report.company}`, { size: 10, color: { argb: INK } });
  put(`Generado por ${report.generatedBy} el ${formatDate(report.generatedAt, true)}`, { size: 9, color: { argb: MUTED } });
  r++;

  const heading = (text: string) => {
    ws.getCell(r, 1).value = text;
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: BRAND } };
    ws.getCell(r, 1).border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    r++;
  };

  if (report.showFilters !== false) heading('Filtros aplicados');
  if (report.showFilters === false) {
    // single-record report: no filters to show
  } else if (report.filters.length) {
    for (const f of report.filters) {
      ws.getCell(r, 1).value = f.label;
      ws.getCell(r, 1).font = { color: { argb: MUTED } };
      ws.getCell(r, 2).value = f.value;
      r++;
    }
  } else {
    ws.getCell(r++, 1).value = 'Sin filtros: incluye todos los registros.';
  }
  if (report.showFilters !== false) r++;

  if (report.kpis.length) {
    heading('Indicadores');
    for (const k of report.kpis) {
      ws.getCell(r, 1).value = k.label;
      const cell = ws.getCell(r, 2);
      const sec = k.formula && report.sections.find((s) => s.id === k.formula!.section);
      const col = sec?.columns.find((c) => c.key === k.formula!.column);
      if (k.formula && sec && col && sec.rows.length && typeof k.value === 'number') {
        const target = `${tableName(sec.id)}[${columnName(col.label)}]`;
        const formula =
          k.formula.op === 'sum'
            ? `SUM(${target})`
            : k.formula.equals !== undefined
              ? `COUNTIF(${target},${quote(k.formula.equals)})`
              : `COUNTA(${target})`;
        cell.value = { formula, result: k.value };
        if (col.kind === 'money') cell.numFmt = excelMoneyFormat(k.currency ?? col.currency ?? null);
      } else {
        cell.value = k.value;
        if (k.format === 'money') cell.numFmt = excelMoneyFormat(k.currency ?? null);
      }
      if (typeof k.value === 'number' && k.format !== 'money' && !cell.numFmt) cell.numFmt = Number.isInteger(k.value) ? '#,##0' : '#,##0.0';
      cell.font = { bold: true, size: 12, color: { argb: k.tone ? TONE_STYLE[k.tone].font : INK } };
      cell.alignment = { horizontal: 'left' };
      r++;
    }
    r++;
  }

  heading('Contenido (clic para ir a cada hoja)');
  for (const sec of report.sections) {
    const name = sheets.get(sec.id)!;
    ws.getCell(r, 1).value = internalLink(name, sec.title);
    ws.getCell(r, 1).font = { underline: true, color: { argb: BRAND } };
    ws.getCell(r, 2).value = `${sec.rows.length} registro${sec.rows.length === 1 ? '' : 's'}`;
    ws.getCell(r, 2).font = { color: { argb: MUTED } };
    if (sec.description) {
      ws.getCell(r, 3).value = sec.description;
      ws.getCell(r, 3).font = { size: 9, color: { argb: MUTED } };
    }
    r++;
  }
  pageSetup(ws, report, false);
}

export async function renderXlsx(report: Report): Promise<Buffer> {
  applyReportCurrency(report);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GeoCar';
  wb.lastModifiedBy = report.generatedBy;
  wb.title = report.title;
  wb.subject = report.subtitle ?? report.title;
  wb.company = report.company;
  wb.created = report.generatedAt;
  wb.modified = report.generatedAt;
  wb.calcProperties.fullCalcOnLoad = true;

  const used = new Set(['resumen']);
  const sheets = new Map(report.sections.map((s) => [s.id, sheetName(s.title, used)]));
  writeSummary(wb, report, sheets);
  for (const sec of report.sections) writeSection(wb, report, sec, sheets.get(sec.id)!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
