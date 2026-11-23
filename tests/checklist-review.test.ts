import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

describe('revisión de checklists pre-operativos', () => {
  const env = new TestEnv();
  let norte = '';
  let monitoreo = '';
  let urbana = '';
  let vehicleId = '';

  before(async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    urbana = await env.token(...DEMO.urbana);
    const boot = await env.req('GET', '/api/bootstrap', { token: norte });
    vehicleId = boot.json.vehicles[0].id;
  });
  after(() => env.close());

  const items = [
    { id: 'it-0', label: 'Frenos', status: 'falla', note: 'Pedal esponjoso' },
    { id: 'it-1', label: 'Luces', status: 'falla' },
    { id: 'it-2', label: 'Neumáticos', status: 'ok' },
  ];

  // The monitoring operator can register checklists (monitoreo: full) but can't review them (flotas: read).
  const createFailed = async () => {
    const res = await env.req('POST', '/api/checklists', {
      token: monitoreo,
      body: { vehicleId, driverName: 'Prueba', shift: 'Matutino', items, summaryNote: 'Fallas', createWorkOrderIfFailed: false },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.checklist.result, 'reprobado');
    assert.equal(res.json.checklist.linkedWorkOrderId, undefined);
    assert.equal(res.json.checklist.items[0].note, 'Pedal esponjoso');
    return res.json.checklist.id as string;
  };

  test('revisar y generar la OT después; la inspección no cambia', async () => {
    const id = await createFailed();
    const res = await env.req('PATCH', `/api/checklists/${id}/review`, {
      token: norte,
      body: { decision: 'no_apto', note: 'No operar hasta reparar frenos', createWorkOrder: true },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const chk = res.json.checklist;
    assert.equal(chk.review.decision, 'no_apto');
    assert.equal(chk.review.note, 'No operar hasta reparar frenos');
    assert.ok(chk.review.reviewedBy);
    assert.ok(res.json.workOrder?.id);
    assert.equal(chk.linkedWorkOrderId, res.json.workOrder.id);
    assert.equal(res.json.workOrder.priority, 'critica');
    assert.equal(res.json.workOrder.laborCost, 0);
    assert.ok(res.json.workOrders.some((w: { id: string }) => w.id === chk.linkedWorkOrderId));
    // Evidence untouched.
    assert.equal(chk.result, 'reprobado');
    assert.deepEqual(
      chk.items.map((i: { status: string }) => i.status),
      ['falla', 'falla', 'ok']
    );

    // Correcting the review: no second work order, and both reviews are audited.
    const again = await env.req('PATCH', `/api/checklists/${id}/review`, {
      token: norte,
      body: { decision: 'apto_con_restriccion', note: 'Frenos reparados, falta luces: solo de día', createWorkOrder: true },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.workOrder, undefined);
    assert.equal(again.json.checklist.linkedWorkOrderId, chk.linkedWorkOrderId);
    assert.equal(again.json.checklist.review.decision, 'apto_con_restriccion');
    const audits = again.json.auditLogs.filter((a: { targetLabel: string }) => a.targetLabel.startsWith(id));
    assert.ok(audits.some((a: { action: string }) => a.action === 'Checklist revisado'));
    assert.ok(audits.some((a: { action: string; detail: string }) => a.action === 'Revisión corregida' && a.detail.includes('No apto → Apto con restricción')));

    // Persisted: the bootstrap brings the review.
    const boot = await env.req('GET', '/api/bootstrap', { token: norte });
    const stored = boot.json.checklists.find((c: { id: string }) => c.id === id);
    assert.equal(stored.review.decision, 'apto_con_restriccion');
  });

  test('una restricción o "no apto" exige nota', async () => {
    const id = await createFailed();
    const res = await env.req('PATCH', `/api/checklists/${id}/review`, { token: norte, body: { decision: 'no_apto', note: '  ' } });
    assert.equal(res.status, 400);
    const ok = await env.req('PATCH', `/api/checklists/${id}/review`, { token: norte, body: { decision: 'apto' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.workOrder, undefined);
  });

  test('un perfil sin escritura en flotas recibe 403', async () => {
    const id = await createFailed();
    const res = await env.req('PATCH', `/api/checklists/${id}/review`, { token: monitoreo, body: { decision: 'apto' } });
    assert.equal(res.status, 403);
  });

  test('otra empresa recibe 404', async () => {
    const id = await createFailed();
    const res = await env.req('PATCH', `/api/checklists/${id}/review`, { token: urbana, body: { decision: 'apto' } });
    assert.equal(res.status, 404);
    const boot = await env.req('GET', '/api/bootstrap', { token: norte });
    assert.equal(boot.json.checklists.find((c: { id: string }) => c.id === id).review, undefined);
  });
});
