import PDFDocument from 'pdfkit';
import {
  applyReportCurrency,
  columnTotal,
  defaultWidth,
  formatCell,
  formatDate,
  isStatus,
  type Column,
  type Report,
  type Section,
  type Tone,
} from './report.ts';

/**
 * Printable PDF for reading, printing or sending:
 * - first page: title, company, who/when, filters, indicator cards and a clickable table of contents;
 * - bookmarks (reader side panel) for each section;
 * - tables with the header repeated on every page, zebra rows, numbers right-aligned,
 *   statuses as colored labels that always carry their text, and a totals row;
 * - "Generado por … · Página N de M" footer on every page.
 */

const C = {
  ink: '#0F172A',
  text: '#1E293B',
  muted: '#64748B',
  line: '#E2E8F0',
  zebra: '#F8FAFC',
  card: '#F8FAFC',
  brand: '#0369A1',
  head: '#1E293B',
};
const TONE: Record<Tone, { fg: string; bg: string; bar: string }> = {
  ok: { fg: '#047857', bg: '#D1FAE5', bar: '#10B981' },
  warn: { fg: '#B45309', bg: '#FEF3C7', bar: '#F59E0B' },
  bad: { fg: '#B91C1C', bg: '#FEE2E2', bar: '#EF4444' },
  info: { fg: '#0369A1', bg: '#E0F2FE', bar: '#0EA5E9' },
  muted: { fg: '#475569', bg: '#F1F5F9', bar: '#94A3B8' },
};
const MARGIN = { top: 54, bottom: 48, left: 36, right: 36 };
const PAD = 4;

/** The built-in Helvetica only has the Windows-1252 characters: map the few others we may get. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPLACE: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '≥': '>=',
  '≤': '<=',
  '✓': 'OK',
  '✔': 'OK',
  '✗': 'X',
  '≈': '~',
  '−': '-',
};
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) out += ch;
    else if (ch === '\n') out += ch;
    else out += REPLACE[ch] ?? (code < 0x20 ? ' ' : '?');
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('es-AR')} ${n === 1 ? one : many}`;
const isNumeric = (col: Column) => col.kind === 'number' || col.kind === 'money' || col.kind === 'percent';

export function renderPdf(report: Report): Promise<Buffer> {
  applyReportCurrency(report);
  const doc = new PDFDocument({
    size: 'A4',
    layout: report.orientation ?? 'portrait',
    margins: MARGIN,
    bufferPages: true,
    displayTitle: true,
    lang: 'es-AR',
    info: {
      Title: pdfSafe(report.title),
      Author: 'GeoCar',
      Subject: pdfSafe(`${report.title} · ${report.company}`),
      Creator: 'GeoCar',
      Keywords: pdfSafe(report.sections.map((s) => s.title).join(', ')),
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width - MARGIN.left - MARGIN.right;
  const X = MARGIN.left;
  const bottom = () => doc.page.height - MARGIN.bottom;
  const pageIndex = () => doc.bufferedPageRange().count - 1;
  const text = (s: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfSafe(s), x, y, opts);
  let y = MARGIN.top;

  // ---- Cover block -------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.brand);
  text('GEOCAR', X, y, { characterSpacing: 1.5 });
  y += 14;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink);
  text(report.title, X, y, { width: W });
  y = doc.y + 2;
  if (report.subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor(C.muted);
    text(report.subtitle, X, y, { width: W });
    y = doc.y + 2;
  }
  doc.font('Helvetica').fontSize(9.5).fillColor(C.text);
  text(`Empresa: ${report.company}`, X, y + 4, { width: W });
  doc.fillColor(C.muted).fontSize(8.5);
  text(`Generado por ${report.generatedBy} el ${formatDate(report.generatedAt, true)}`, X, doc.y + 1, { width: W });
  y = doc.y + 10;

  // Filters
  if (report.showFilters !== false) {
    const filterText = report.filters.length
      ? report.filters.map((f) => `${f.label}: ${f.value}`).join('   ·   ')
      : 'Sin filtros: incluye todos los registros.';
    doc.font('Helvetica').fontSize(8.5);
    const fh = doc.heightOfString(pdfSafe(filterText), { width: W - 70 }) + 12;
    doc.roundedRect(X, y, W, fh, 4).fill(C.card);
    doc.font('Helvetica-Bold').fillColor(C.muted);
    text('FILTROS', X + 10, y + 6.5, { characterSpacing: 0.8 });
    doc.font('Helvetica').fillColor(C.text);
    text(filterText, X + 60, y + 6.5, { width: W - 70 });
    y += fh + 14;
  }

  // Indicator cards
  if (report.kpis.length) {
    const perRow = Math.min(report.kpis.length, report.orientation === 'landscape' ? 6 : 4);
    const gap = 8;
    const cw = (W - gap * (perRow - 1)) / perRow;
    const ch = 50;
    report.kpis.forEach((k, i) => {
      const cx = X + (i % perRow) * (cw + gap);
      const cy = y + Math.floor(i / perRow) * (ch + gap);
      doc.roundedRect(cx, cy, cw, ch, 5).fillAndStroke(C.card, C.line);
      doc.rect(cx, cy + 6, 3, ch - 12).fill(TONE[k.tone ?? 'muted'].bar);
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted);
      text(k.label, cx + 10, cy + 8, {
        width: cw - 16,
        height: 18,
        ellipsis: true,
      });
      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .fillColor(k.tone && k.tone !== 'muted' ? TONE[k.tone].fg : C.ink);
      const value =
        typeof k.value === 'number'
          ? formatCell(k.value, {
              key: '',
              label: '',
              kind: k.format ?? 'auto',
              currency: k.currency,
            })
          : k.value;
      text(value, cx + 10, cy + 26, {
        width: cw - 16,
        lineBreak: false,
        ellipsis: true,
      });
    });
    y += Math.ceil(report.kpis.length / perRow) * (ch + gap) + 8;
  }

  // Table of contents (page numbers are filled in at the end)
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink);
  text('Contenido', X, y);
  y = doc.y + 4;
  const toc: { page: number; y: number; dest: string }[] = [];
  report.sections.forEach((sec, i) => {
    const dest = `sec-${i}`;
    doc.font('Helvetica').fontSize(9.5).fillColor(C.brand);
    text(`${i + 1}. ${sec.title}`, X + 6, y, {
      width: W * 0.6,
      lineBreak: false,
      ellipsis: true,
    });
    doc.goTo(X, y - 2, W, 14, dest);
    doc.fillColor(C.muted).fontSize(8.5);
    text(plural(sec.rows.length, 'registro', 'registros'), X + W * 0.62, y + 0.5, { width: W * 0.25, lineBreak: false });
    toc.push({ page: pageIndex(), y, dest });
    doc
      .moveTo(X, y + 13)
      .lineTo(X + W, y + 13)
      .lineWidth(0.4)
      .strokeColor(C.line)
      .stroke();
    y += 17;
  });
  y += 12;

  // ---- Sections ----------------------------------------------------------
  const sectionPages: number[] = [];
  report.sections.forEach((sec, i) => {
    if (y + 110 > bottom()) {
      doc.addPage();
      y = MARGIN.top;
    }
    sectionPages.push(pageIndex());
    doc.addNamedDestination(`sec-${i}`, 'XYZ', X, doc.page.height - y + 10, null);
    doc.outline.addItem(pdfSafe(`${i + 1}. ${sec.title}`));
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink);
    text(`${i + 1}. ${sec.title}`, X, y, { width: W });
    y = doc.y + 1;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted);
    const meta = [plural(sec.rows.length, 'registro', 'registros'), sec.description].filter(Boolean).join(' · ');
    text(meta, X, y, { width: W });
    y = doc.y + 6;
    if (sec.omitted) {
      doc.fillColor(TONE.warn.fg);
      text(
        `Se omitieron ${sec.omitted.toLocaleString('es-AR')} filas por el límite del archivo. Usa Excel o CSV con filtros para verlas.`,
        X,
        y,
        { width: W },
      );
      y = doc.y + 6;
    }
    y = drawTable(sec, y) + 18;
  });

  /**
   * Proportional widths that never split a word, date, number or status label:
   * each column gets at least its longest unbreakable piece; the rest is shared by weight.
   */
  function columnWidths(sec: Section, fs: number): number[] {
    const cols = sec.columns;
    const sample = sec.rows.slice(0, 400);
    const words = (s: string) => pdfSafe(s).split(/\s+/).filter(Boolean);
    const mins = cols.map((c) => {
      doc.font('Helvetica-Bold').fontSize(fs);
      let min = Math.max(0, ...words(c.label).map((w) => doc.widthOfString(w)));
      const whole = c.kind !== 'text' && c.kind !== 'auto';
      doc.font(c.kind === 'status' ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.kind === 'status' ? fs - 0.5 : fs);
      for (const r of sample) {
        const t = formatCell(r[c.key], c);
        if (!t) continue;
        const w = whole
          ? doc.widthOfString(pdfSafe(t)) + (c.kind === 'status' ? 10 : 0)
          : Math.max(...words(t).map((x) => Math.min(doc.widthOfString(x), W * 0.25)));
        if (w > min) min = w;
      }
      return min + PAD * 2 + 1;
    });
    const weights = cols.map(defaultWidth);
    const sumW = weights.reduce((a, b) => a + b, 0);
    let widths = weights.map((w) => (w / sumW) * W);
    for (let pass = 0; pass < 6; pass++) {
      const deficit = widths.reduce((d, w, i) => d + Math.max(0, mins[i] - w), 0);
      if (deficit < 0.5) break;
      const slack = widths.map((w, i) => Math.max(0, w - mins[i]));
      const totalSlack = slack.reduce((a, b) => a + b, 0);
      if (totalSlack <= 0) break;
      const take = Math.min(deficit, totalSlack);
      widths = widths.map((w, i) => (w < mins[i] ? mins[i] : w - (slack[i] / totalSlack) * take));
    }
    const total = widths.reduce((a, b) => a + b, 0);
    return widths.map((w) => (w / total) * W);
  }

  function drawTable(sec: Section, startY: number): number {
    const cols = sec.columns;
    const fs = cols.length > 9 ? 7 : cols.length > 6 ? 7.5 : 8.5;
    const widths = columnWidths(sec, fs);
    const xs = widths.map((_, i) => X + widths.slice(0, i).reduce((a, b) => a + b, 0));
    let ty = startY;

    const header = () => {
      doc.font('Helvetica-Bold').fontSize(fs);
      const h =
        Math.max(
          ...cols.map((c, i) =>
            doc.heightOfString(pdfSafe(c.label), {
              width: widths[i] - PAD * 2,
            }),
          ),
        ) +
        PAD * 2;
      doc.rect(X, ty, W, h).fill(C.head);
      doc.fillColor('#FFFFFF');
      cols.forEach((c, i) =>
        text(c.label, xs[i] + PAD, ty + PAD, {
          width: widths[i] - PAD * 2,
          align: isNumeric(c) ? 'right' : 'left',
        }),
      );
      ty += h;
    };

    if (!sec.rows.length) {
      header();
      doc.rect(X, ty, W, 26).fill(C.zebra);
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted);
      text(sec.empty, X + 10, ty + 8.5, { width: W - 20 });
      return ty + 26;
    }

    if (ty + 40 > bottom()) {
      doc.addPage();
      ty = MARGIN.top;
    }
    header();

    const lineH = doc.font('Helvetica').fontSize(fs).currentLineHeight();
    const drawRow = (cells: string[], raw: unknown[], index: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
      const h =
        Math.max(
          lineH + 3,
          ...cells.map((s, i) => (isStatus(raw[i]) || !s ? lineH + 3 : doc.heightOfString(pdfSafe(s), { width: widths[i] - PAD * 2 }))),
        ) +
        PAD * 2 -
        2;
      if (ty + h > bottom()) {
        doc.addPage();
        ty = MARGIN.top;
        header();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
      }
      if (bold) {
        doc.rect(X, ty, W, h).fill('#EEF2F7');
        doc
          .moveTo(X, ty)
          .lineTo(X + W, ty)
          .lineWidth(1)
          .strokeColor(C.ink)
          .stroke();
      } else if (index % 2 === 1) {
        doc.rect(X, ty, W, h).fill(C.zebra);
      }
      cells.forEach((s, i) => {
        const v = raw[i];
        if (isStatus(v)) {
          const t = TONE[v.tone];
          doc.font('Helvetica-Bold').fontSize(fs - 0.5);
          const tw = Math.min(doc.widthOfString(pdfSafe(v.text)) + 10, widths[i] - PAD * 2);
          doc.roundedRect(xs[i] + PAD, ty + PAD - 1, tw, lineH + 4, 3).fill(t.bg);
          doc.fillColor(t.fg);
          text(v.text, xs[i] + PAD + 5, ty + PAD + 1.2, {
            width: tw - 8,
            lineBreak: false,
            ellipsis: true,
          });
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
          return;
        }
        doc.fillColor(C.text);
        text(s, xs[i] + PAD, ty + PAD, {
          width: widths[i] - PAD * 2,
          align: isNumeric(cols[i]) ? 'right' : 'left',
        });
      });
      if (!bold)
        doc
          .moveTo(X, ty + h)
          .lineTo(X + W, ty + h)
          .lineWidth(0.3)
          .strokeColor(C.line)
          .stroke();
      ty += h;
    };

    sec.rows.forEach((row, r) => {
      const raw = cols.map((c) => row[c.key]);
      drawRow(
        cols.map((c, i) => formatCell(raw[i], c)),
        raw,
        r,
      );
    });

    if (cols.some((c) => c.total)) {
      const cells = cols.map((c, i) => {
        const t = columnTotal(sec, c);
        if (t === null) return i === 0 ? 'Total' : '';
        const shown = c.total === 'count' ? t.toLocaleString('es-AR') : formatCell(t, c);
        return i === 0 ? `Total: ${shown}` : shown;
      });
      drawRow(
        cells,
        cols.map(() => null),
        0,
        true,
      );
    }
    return ty;
  }

  // ---- Page header/footer and TOC page numbers -------------------------
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (p > range.start) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted);
      text(`GeoCar · ${report.title} · ${report.company}`, X, 26, {
        width: W,
        lineBreak: false,
        ellipsis: true,
      });
      doc
        .moveTo(X, 38)
        .lineTo(X + W, 38)
        .lineWidth(0.4)
        .strokeColor(C.line)
        .stroke();
    }
    const fy = doc.page.height - 30;
    doc
      .moveTo(X, fy - 6)
      .lineTo(X + W, fy - 6)
      .lineWidth(0.4)
      .strokeColor(C.line)
      .stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted);
    text(`Generado por ${report.generatedBy} el ${formatDate(report.generatedAt, true)}`, X, fy, {
      width: W * 0.7,
      lineBreak: false,
      ellipsis: true,
    });
    text(`Página ${p - range.start + 1} de ${range.count}`, X + W * 0.7, fy, {
      width: W * 0.3,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = saved;
  }
  toc.forEach((entry, i) => {
    doc.switchToPage(entry.page);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted);
    text(`pág. ${sectionPages[i] - range.start + 1}`, X + W * 0.85, entry.y + 0.5, { width: W * 0.15, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  });

  doc.end();
  return done;
}
