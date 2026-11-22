import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledVsOverdueByAssetType, topConsumedParts } from '../src/lib/maintenancePanel.ts';
import type { PartInventoryItem, WorkOrder, WorkOrderPart } from '../src/shared/types.ts';

let seq = 0;
function order(o: Partial<WorkOrder>): WorkOrder {
  seq++;
  return {
    id: `OT-${seq}`,
    tenantId: 'ten-norte',
    vehicleId: 'v1',
    unitCode: 'TLN-1',
    plate: 'X',
    assetType: 'vehiculo',
    type: 'preventivo',
    priority: 'media',
    status: 'abierta',
    title: 't',
    workshopOrTech: 'w',
    scheduledDate: '2026-11-19',
    engineHoursAtOrder: 0,
    odometerAtOrder: 0,
    parts: [],
    laborCost: 0,
    partsCost: 0,
    totalCost: 0,
    notes: '',
    createdAt: '2026-11-01T00:00:00Z',
    ...o,
  };
}

function part(sku: string, quantity: number, unitCost: number, category: WorkOrderPart['category'] = 'refaccion'): WorkOrderPart {
  return { id: `${sku}-${quantity}`, sku, name: `Repuesto ${sku}`, category, quantity, unitCost, subtotal: quantity * unitCost };
}

const inv = (sku: string, unit: string) => ({ sku, unit }) as PartInventoryItem;

describe('panel de mantenimiento: programado vs vencido', () => {
  const today = '2026-11-19';

  test('clasifica las OT abiertas por fecha; hoy cuenta como programada', () => {
    const rows = scheduledVsOverdueByAssetType(
      [
        order({ scheduledDate: '2026-11-18' }), // vencida
        order({ scheduledDate: '2026-11-19' }), // hoy → programada
        order({ scheduledDate: '2026-12-01', status: 'en_taller' }), // programada
        order({ scheduledDate: '2026-10-01', status: 'esperando_refacciones', assetType: 'maquinaria_pesada' }), // vencida
      ],
      today
    );
    assert.deepEqual(rows, [
      { assetType: 'vehiculo', label: 'Vehículos', programado: 2, vencido: 1 },
      { assetType: 'maquinaria_pesada', label: 'Maquinaria pesada', programado: 0, vencido: 1 },
    ]);
  });

  test('excluye completadas y canceladas; ambas categorías aparecen aunque valgan 0', () => {
    const rows = scheduledVsOverdueByAssetType(
      [order({ status: 'completada', scheduledDate: '2026-01-01' }), order({ status: 'cancelada', scheduledDate: '2026-01-01' })],
      today
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.programado === 0 && r.vencido === 0));
  });
});

describe('panel de mantenimiento: repuestos más utilizados', () => {
  test('agrupa por SKU, excluye mano de obra y OT abiertas sin stock descontado', () => {
    const r = topConsumedParts(
      [
        order({ status: 'completada', parts: [part('A', 2, 100), part('MO', 1, 9999, 'mano_obra')] }),
        order({ status: 'completada', parts: [part('a', 3, 100)] }), // mismo SKU (mayúsculas/minúsculas)
        order({ status: 'abierta', parts: [part('B', 1, 5000)] }), // no consumido todavía
        order({ status: 'en_taller', stockDeducted: true, parts: [part('C', 1, 300)] }), // ya salió del almacén
      ],
      [inv('A', 'cubeta')]
    );
    assert.deepEqual(
      r.items.map((i) => [i.sku, i.value, i.quantity, i.unit]),
      [
        ['A', 500, 5, 'cubeta'],
        ['C', 300, 1, 'u.'],
      ]
    );
    assert.equal(r.total, 800);
    assert.equal(r.other, 0);
  });

  test('ordena por valor, corta en 5 y suma el resto; las participaciones suman 100 %', () => {
    const parts = [10, 60, 30, 50, 20, 40, 70].map((v, i) => part(`S${i}`, 1, v));
    const r = topConsumedParts([order({ status: 'completada', parts })], []);
    assert.deepEqual(r.items.map((i) => i.value), [70, 60, 50, 40, 30]);
    assert.equal(r.other, 30); // 20 + 10
    assert.equal(r.otherCount, 2);
    assert.equal(r.total, 280);
    const shares = r.items.reduce((s, i) => s + i.share, 0) + r.other / r.total;
    assert.ok(Math.abs(shares - 1) < 1e-9);
  });

  test('sin consumo devuelve una lista vacía', () => {
    const r = topConsumedParts([order({ status: 'abierta', parts: [part('A', 1, 10)] })], []);
    assert.deepEqual(r, { items: [], total: 0, other: 0, otherCount: 0 });
  });
});
