import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';
import ExcelJS from 'exceljs';
import { WORK_ORDER_CSV_HEADER } from '../server/export/workOrders.ts';

const env = new TestEnv();
let norte: string;
let urbana: string;
let data: any;

/** Minimal RFC 4180 parser for ";"-separated CSV (handles quotes, "" and newlines in cells). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function exportCsv(token: string) {
  const res = await fetch(`${env.baseUrl}/api/work-orders/export`, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, raw: buf.toString('utf-8') };
}

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    data = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('exportar órdenes de trabajo a CSV', () => {
  test('formato Excel en español: BOM, encabezado y una fila por OT (todas las de la empresa)', async () => {
    const { res, raw } = await exportCsv(norte);
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/csv; charset=utf-8/);
    assert.match(String(res.headers.get('content-disposition')), /attachment; filename="ordenes-trabajo_translogistica-norte_\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(raw.charCodeAt(0), 0xfeff, 'empieza con BOM UTF-8');

    const rows = parseCsv(raw.slice(1));
    assert.deepEqual(rows[0], WORK_ORDER_CSV_HEADER);
    const body = rows.slice(1);
    assert.equal(body.length, data.workOrders.length);
    assert.ok(body.every((r) => r.length === WORK_ORDER_CSV_HEADER.length), 'todas las filas tienen 18 columnas');

    const estados = new Set(body.map((r) => r[7]));
    assert.ok([...estados].some((e) => e !== 'Completada' && e !== 'Cancelada'), 'incluye OT pendientes');
    assert.ok(estados.has('Completada'), 'incluye OT completadas');
  });

  test('columnas pedidas: ID del activo, prioridad, mano de obra (coma decimal) y piezas', async () => {
    const withParts = data.workOrders.find((w: any) => w.parts.length > 0 && w.laborCost > 0);
    assert.ok(withParts, 'el seed debe tener una OT con piezas y mano de obra');
    const rows = parseCsv((await exportCsv(norte)).raw.slice(1));
    const row = rows.find((r) => r[0] === withParts.id)!;
    assert.ok(row);
    assert.equal(row[2], withParts.unitCode); // ID_Activo
    assert.ok(['Crítica', 'Alta', 'Media', 'Baja'].includes(row[6])); // Prioridad
    assert.equal(row[12], withParts.laborCost.toFixed(2).replace('.', ',')); // Costo_Mano_Obra
    assert.equal(row[18], 'ARS'); // Moneda de la empresa
    assert.match(row[15], new RegExp(`^${withParts.parts[0].sku} `)); // Piezas_Consumidas
    assert.equal(row[15].split(' | ').length, withParts.parts.length);
    assert.ok(['Sí', 'No'].includes(row[17]));
  });

  test('textos con comillas, ; y fórmulas quedan escapados (sin romper columnas ni ejecutar fórmulas)', async () => {
    const v = data.vehicles[0];
    const created = await env.req('POST', '/api/work-orders', {
      token: norte,
      body: {
        vehicleId: v.id,
        title: 'Cambio de "filtro"; urgente',
        workshopOrTech: '=HYPERLINK("http://malicioso","clic")',
        laborCost: 1234.5,
        priority: 'alta',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.workOrder.id;

    const { raw } = await exportCsv(norte);
    assert.ok(raw.includes('"Cambio de ""filtro""; urgente"'), 'título entrecomillado con comillas duplicadas');
    const row = parseCsv(raw.slice(1)).find((r) => r[0] === id)!;
    assert.equal(row.length, WORK_ORDER_CSV_HEADER.length);
    assert.equal(row[8], 'Cambio de "filtro"; urgente');
    assert.equal(row[9], `'=HYPERLINK("http://malicioso","clic")`, 'la fórmula queda como texto');
    assert.equal(row[12], '1234,50');
    assert.equal(row[6], 'Alta');
  });

  test('cada empresa exporta solo sus órdenes', async () => {
    const norteRows = parseCsv((await exportCsv(norte)).raw.slice(1)).slice(1);
    const urbanaRows = parseCsv((await exportCsv(urbana)).raw.slice(1)).slice(1);
    assert.ok(norteRows.every((r) => r[2].startsWith('TLN-')));
    assert.ok(urbanaRows.every((r) => r[2].startsWith('MUE-')));
    assert.ok(urbanaRows.length > 0);
  });

  test('sin sesión → 401; perfil sin acceso a flotas → 403', async () => {
    assert.equal((await env.req('GET', '/api/work-orders/export')).status, 401);

    const permissions = Object.fromEntries(
      ['administracion', 'flotas', 'dispositivos', 'dashcams_config', 'monitoreo', 'alertas', 'incidentes', 'video', 'reportes', 'dimensionamiento'].map(
        (m) => [m, m === 'monitoreo' ? 'read' : 'none']
      )
    );
    const role = await env.req('POST', '/api/roles', { token: norte, body: { name: 'Solo mapa', permissions } });
    assert.equal(role.status, 201, JSON.stringify(role.json));
    const user = await env.req('POST', '/api/users', {
      token: norte,
      body: { name: 'Visor', username: 'visor.norte', password: 'SoloMapa2026', roleId: role.json.role.id },
    });
    assert.equal(user.status, 201, JSON.stringify(user.json));
    const visor = await env.token('visor.norte', 'SoloMapa2026');
    assert.equal((await env.req('GET', '/api/work-orders/export', { token: visor })).status, 403);
  });
});

// ---------------------------------------------------------------------------
// PDF, Excel and CSV for every export
// ---------------------------------------------------------------------------
async function download(token: string, path: string) {
  const res = await fetch(`${env.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}

async function workbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** Header labels (row 4) and data rows below it. */
function sheetRows(ws: ExcelJS.Worksheet) {
  const header = (ws.getRow(4).values as unknown[]).slice(1).map(String);
  const rows: unknown[][] = [];
  ws.eachRow((row, n) => {
    if (n > 4) rows.push((row.values as unknown[]).slice(1));
  });
  return { header, rows };
}

const csvBody = (raw: string) => parseCsv(raw.slice(1));

describe('exportar en PDF, Excel y CSV', () => {
  test('flota en Excel: Resumen con fórmulas y enlaces, tabla filtrable con encabezado fijo y fechas reales', async () => {
    const { res, buf } = await download(norte, '/api/reports/export?format=xlsx');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /spreadsheetml/);
    assert.match(String(res.headers.get('content-disposition')), /filename="flota_translogistica-norte_\d{4}-\d{2}-\d{2}\.xlsx"/);
    const wb = await workbook(buf);
    assert.deepEqual(
      wb.worksheets.map((w) => w.name),
      ['Resumen', 'Unidades']
    );
    const summary = wb.getWorksheet('Resumen')!;
    const formulas: string[] = [];
    summary.eachRow((row) => row.eachCell((c) => void (c.formula && formulas.push(c.formula))));
    assert.ok(formulas.some((f) => f.startsWith('COUNTA(T_unidades[Unidad])')), formulas.join(' | '));
    assert.ok(formulas.some((f) => f.startsWith(`HYPERLINK("#'Unidades'!A1"`)), 'índice con enlace a la hoja');

    const ws = wb.getWorksheet('Unidades')!;
    assert.equal(ws.getTables().length, 1, 'los datos son una Tabla de Excel (filtros y orden)');
    assert.equal((ws.views[0] as { ySplit?: number }).ySplit, 4, 'encabezado fijo');
    const { header, rows } = sheetRows(ws);
    assert.equal(header[0], 'Unidad');
    assert.ok(header.includes('Fecha próximo servicio') && header.includes('Mantenimiento'));
    const dataRows = rows.filter((r) => r[0] !== 'Total');
    assert.equal(dataRows.length, data.vehicles.length);
    const dateCol = header.indexOf('Fecha próximo servicio');
    assert.ok(dataRows.every((r) => r[dateCol] instanceof Date), 'fechas como fecha');
    assert.ok(dataRows.some((r) => r[header.indexOf('Mantenimiento')] === 'Al día'), 'estados en español');
  });

  test('órdenes en Excel: un texto con fórmula queda como texto; totales con SUBTOTAL', async () => {
    const wb = await workbook((await download(norte, '/api/work-orders/export?format=xlsx')).buf);
    const ws = wb.getWorksheet('Órdenes de trabajo')!;
    let injected: ExcelJS.Cell | undefined;
    const totals: string[] = [];
    ws.eachRow((row) =>
      row.eachCell((c) => {
        if (c.value === '=HYPERLINK("http://malicioso","clic")') injected = c;
        if (c.formula?.startsWith('SUBTOTAL(109,')) totals.push(c.formula);
      })
    );
    assert.ok(injected, 'la celda con el texto existe');
    assert.equal(injected!.type, ExcelJS.ValueType.String);
    assert.ok(totals.includes('SUBTOTAL(109,T_ordenes[Total])'), totals.join(' | '));
    assert.ok(wb.getWorksheet('Repuestos consumidos'));
  });

  test('PDF: archivo válido, con título en los metadatos y marcadores por sección', async () => {
    const paths = ['/api/reports/export', '/api/work-orders/export', '/api/drivers/export', '/api/alerts/export', `/api/vehicles/${data.vehicles[0].id}/export`];
    for (const path of paths) {
      const { res, buf } = await download(norte, `${path}?format=pdf`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.match(String(res.headers.get('content-disposition')), /\.pdf"$/);
      assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
      const text = buf.toString('latin1');
      assert.ok(/\/Title \(/.test(text), `${path}: título`);
      assert.ok(/\/Outlines/.test(text), `${path}: marcadores`);
      assert.ok((text.match(/\/Type \/Page\b/g) ?? []).length >= 1);
    }
  });

  test('CSV de flota: formato Excel en español (BOM, «;») con encabezados legibles', async () => {
    const { res, buf } = await download(norte, '/api/reports/export');
    assert.match(String(res.headers.get('content-type')), /text\/csv/);
    const raw = buf.toString('utf-8');
    assert.equal(raw.charCodeAt(0), 0xfeff);
    const rows = csvBody(raw);
    assert.equal(rows[0][0], 'Unidad');
    assert.ok(rows[0].includes('Patente'));
    assert.equal(rows.length - 1, data.vehicles.length);
  });

  test('ficha: el JSON ya no existe (responde CSV); otra empresa → 404 en todos los formatos', async () => {
    const v = data.vehicles[0];
    const json = await download(norte, `/api/vehicles/${v.id}/export?format=json`);
    assert.match(String(json.res.headers.get('content-type')), /text\/csv/);
    assert.ok(json.buf.toString('utf-8').includes(v.unitCode));
    for (const f of ['pdf', 'xlsx', 'csv']) {
      assert.equal((await download(urbana, `/api/vehicles/${v.id}/export?format=${f}`)).res.status, 404, f);
    }
  });

  test('choferes: respeta los filtros, solo admin, y cada empresa ve los suyos', async () => {
    const page = (await env.req('GET', '/api/drivers?state=pendiente&pageSize=50', { token: norte })).json;
    const wb = await workbook((await download(norte, '/api/drivers/export?format=xlsx&state=pendiente')).buf);
    const { header, rows } = sheetRows(wb.getWorksheet('Choferes')!);
    const estado = header.indexOf('Estado');
    assert.equal(rows.length, page.total);
    assert.ok(rows.every((r) => r[estado] === 'Pendiente de verificación'));
    const summary = wb.getWorksheet('Resumen')!;
    let filterShown = false;
    summary.eachRow((row) =>
      row.eachCell((c) => {
        if (c.value === 'Pendiente de verificación') filterShown = true;
      })
    );
    assert.ok(filterShown, 'el Resumen muestra el filtro aplicado');
    assert.ok(wb.getWorksheet('Documentación'));

    const monitoreo = await env.token(...DEMO.norteMonitoreo);
    assert.equal((await download(monitoreo, '/api/drivers/export?format=pdf')).res.status, 403);

    const norteDni = new Set(
      csvBody((await download(norte, '/api/drivers/export')).buf.toString('utf-8'))
        .slice(1)
        .map((r) => r[1])
    );
    const urbanaRows = csvBody((await download(urbana, '/api/drivers/export')).buf.toString('utf-8')).slice(1);
    assert.ok(urbanaRows.length > 0);
    assert.ok(urbanaRows.every((r) => !norteDni.has(r[1])), 'sin choferes de otra empresa');
  });

  test('alertas: filtro de prioridad y aislamiento por empresa; se registra en auditoría', async () => {
    const rows = csvBody((await download(norte, '/api/alerts/export?priority=critica')).buf.toString('utf-8'));
    const prioridad = rows[0].indexOf('Prioridad');
    assert.ok(prioridad >= 0);
    const expected = data.alerts.filter((a: any) => a.priority === 'critica').length;
    assert.equal(rows.length - 1, expected);
    assert.ok(rows.slice(1).every((r) => r[prioridad] === 'Crítica'));
    const urbanaCsv = (await download(urbana, '/api/alerts/export')).buf.toString('utf-8');
    assert.ok(!urbanaCsv.includes('TLN-'));

    const logs = (await env.req('GET', '/api/bootstrap', { token: norte })).json.auditLogs;
    assert.ok(
      logs.some((l: any) => l.action === 'Exportó Alertas e incidentes (CSV)'),
      'deja constancia de la exportación'
    );
  });

  test('formato desconocido → CSV', async () => {
    const { res } = await download(norte, '/api/reports/export?format=docx');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/csv/);
  });
});
