import type express from 'express';
import { reportToCsv, fileSlug } from './csv.ts';
import { fleetStore } from '../store.ts';
import { renderPdf } from './pdf.ts';
import type { ExportFormat, Report } from './report.ts';
import { renderXlsx } from './xlsx.ts';

export const FORMAT_LABELS: Record<ExportFormat, string> = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV' };

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

/** "<base>_<empresa>_<AAAA-MM-DD>" — `who` is the company name or "todas". */
export function exportFileBase(base: string, who: string, day = new Date()): string {
  return `${base}_${who === 'todas' ? 'todas' : fileSlug(who)}_${day.toISOString().slice(0, 10)}`;
}

/** Renders the report in the requested format and sends it as a download. */
export async function sendReport(res: express.Response, report: Report, format: ExportFormat, fileBase: string): Promise<void> {
  const body = format === 'pdf' ? await renderPdf(report) : format === 'xlsx' ? await renderXlsx(report) : reportToCsv(report);
  res.setHeader('Content-Type', CONTENT_TYPES[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

export interface ExportActor {
  tenantId: string;
  name: string;
  role: string;
  hidden: boolean;
}

/**
 * Sends the report and leaves a trace in the audit log («Exportó … (PDF)»).
 * Rendering errors go to the API error handler instead of crashing the request.
 */
export async function respondWithReport(
  res: express.Response,
  next: express.NextFunction,
  actor: ExportActor,
  report: Report,
  format: ExportFormat,
  fileBase: string,
  module: string
): Promise<void> {
  try {
    await sendReport(res, report, format, fileBase);
    const rows = report.sections[0]?.rows.length ?? 0;
    fleetStore.addAuditLog({
      tenantId: actor.tenantId,
      actorName: actor.name,
      actorRole: actor.role,
      actorHidden: actor.hidden,
      module,
      action: `Exportó ${report.title} (${FORMAT_LABELS[format]})`,
      targetLabel: report.company,
      detail: `${rows} registro${rows === 1 ? '' : 's'}${report.filters.length ? ` · ${report.filters.map((f) => `${f.label}: ${f.value}`).join(', ')}` : ''}.`,
    });
  } catch (err) {
    next(err);
  }
}
