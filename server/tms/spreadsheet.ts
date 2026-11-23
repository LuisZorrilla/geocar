import ExcelJS from 'exceljs';

/** Max rows read from an imported statement. */
export const IMPORT_MAX_ROWS = 5000;

/** Splits one CSV line honoring quotes ("a;b" stays together, "" is an escaped quote). */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  // Argentine exports usually use ";" (the comma is the decimal separator).
  const header = lines[0];
  const sep = (header.match(/;/g)?.length ?? 0) >= (header.match(/,/g)?.length ?? 0) ? ';' : header.includes('\t') ? '\t' : ',';
  const cols = splitCsvLine(header, sep);
  return lines.slice(1, IMPORT_MAX_ROWS + 1).map((l) => {
    const cells = splitCsvLine(l, sep);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

async function parseXlsx(data: Buffer): Promise<Array<Record<string, unknown>>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  // The header is the first row with at least 3 non-empty cells (statements often have a title on top).
  let headerRow = 1;
  for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
    const filled = (ws.getRow(r).values as unknown[]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;
    if (filled >= 3) {
      headerRow = r;
      break;
    }
  }
  const headers = (ws.getRow(headerRow).values as unknown[]).map((v) => (v == null ? '' : String(typeof v === 'object' && v && 'text' in v ? (v as { text: string }).text : v).trim()));
  const rows: Array<Record<string, unknown>> = [];
  for (let r = headerRow + 1; r <= ws.rowCount && rows.length < IMPORT_MAX_ROWS; r++) {
    const values = ws.getRow(r).values as unknown[];
    if (!values || values.every((v) => v == null || String(v).trim() === '')) continue;
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      let v = values[i];
      if (v && typeof v === 'object' && !(v instanceof Date)) v = 'result' in v ? (v as { result: unknown }).result : 'text' in v ? (v as { text: unknown }).text : String(v);
      rec[h] = v;
    });
    rows.push(rec);
  }
  return rows;
}

/** Rows of a CSV or XLSX statement as header → value records. */
export async function readSpreadsheet(data: Buffer, fileName: string): Promise<Array<Record<string, unknown>>> {
  const isXlsx = /\.xlsx$/i.test(fileName) || (data.length > 4 && data.readUInt32BE(0) === 0x504b0304);
  if (isXlsx) return parseXlsx(data);
  return parseCsv(data.toString('utf8'));
}
