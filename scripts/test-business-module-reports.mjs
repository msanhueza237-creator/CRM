import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBusinessModuleReport, assertModuleRequester } from '../supabase/functions/crm-agent/module-reports.ts';
import { collectModuleRows } from '../supabase/functions/crm-agent/module-pagination.ts';
import { agentReport } from '../supabase/functions/crm-copilot/agent-reports.ts';
import { runAccountingTask } from '../supabase/functions/crm-agent/accounting-task-runner.ts';

const profile = { role: 'administrador', active: true };
const types = { commercial: 'review_pipeline', marketing: 'prepare_marketing_plan', logistics: 'review_logistics', foreign_trade: 'review_import_plan', executive: 'analyze_company' };
const task = (agent) => ({ id: agent, agent_type: agent, action: types[agent], payload: { financial_snapshot: { net_sales: 99999999 }, mode: 'manual' } });
function reader() {
  const data = {
    content_role_permissions: [{ allowed: true }], foreign_trade_role_permissions: [{ allowed: true }], foreign_trade_agent_permissions: [{ allowed: true }],
    companies: Array.from({ length: 1101 }, (_, i) => ({ id: `company-${i}`, name: `Empresa ${i}`, next_follow_up: '2026-09-09', updated_at: '2026-09-01' })),
    interactions: [{ id: 'activity', company_id: 'company-1' }],
    content_products: [{ id: 'catalog', sku: 'P1', name: 'Producto', brand: 'Marca', source_status: 'active' }],
    inventory_snapshots: [{ external_id: 'P1', payload: { sku: 'P1', name: 'Producto', stock_known: true, available_units: 10 }, updated_at: '2026-09-08' }],
    product_details: [], campaigns: [{ id: 'campaign', status: 'borrador' }],
    content_publications: [{ id: 'publication', status: 'pending_approval' }], content_schedules: [],
    import_shipments: [{ id: 'op', status: 'in_transit', operation_type: 'simulation', base_currency: 'USD' }],
    foreign_trade_operation_statuses: [{ code: 'in_transit', final_state: false }],
    foreign_trade_documents: [{ id: 'doc', operation_id: 'op', parse_status: 'review_required' }],
    foreign_trade_scenarios: [{ id: 'scenario', operation_id: 'op', missing_inputs: ['freight'], landed_total_clp: null }],
    foreign_trade_cost_lines: [{ id: 'c1', currency: 'USD', amount_original: 100, source_type: 'estimated' }, { id: 'c2', currency: 'CLP', amount_original: 100, source_type: 'real' }],
    suppliers: [{ id: 'supplier', active: true }],
  };
  const calls = [];
  const api = {
    all: async (table, _select, filters) => { const key = table === 'integration_records' ? filters.resource : table; calls.push(key); assert.ok(key in data, `Unexpected source ${key}`); return data[key]; },
    accounting: async () => ({ warnings: ['Costo provisional'], evidence: [{ accounting_module_report: { module: 'accounting-center', metrics: { net_sales: 123, receivables: 42 }, source_as_of: '2026-09-08' } }] }),
  };
  return { api, data, calls };
}
for (const type of Object.keys(types)) test(`${type}: reads modules, keeps complete detail and ignores legacy payload`, async () => {
  const { api, calls } = reader();
  const result = await buildBusinessModuleReport(task(type), profile, api, '2026-09-10T01:00:00Z');
  const report = result.evidence[0].module_report;
  assert.equal(report.agent, type);
  assert.equal(report.sections.find((s) => s.key === 'products').rows[0].stock, 10);
  assert.deepEqual(result.proposals, []);
  assert.ok(!calls.includes('financial_snapshots'));
  if (['commercial', 'marketing', 'executive'].includes(type)) {
    assert.equal(result.metrics.companies, 1101);
    assert.equal(result.metrics.followups_overdue, 0, 'Use Chile date, not next UTC day');
  }
  if (['commercial', 'executive'].includes(type)) assert.equal(result.metrics.net_sales, 123);
  if (['logistics', 'foreign_trade', 'executive'].includes(type)) {
    assert.equal(report.sections.find((s) => s.key === 'costs').rows.length, 2);
    assert.equal(result.metrics.scenarios_incomplete, 1);
    assert.equal(report.sections.find((s) => s.key === 'operations').rows[0].href, '/comercio-exterior?operation=op');
  }
});
test('Revoked module or requester permissions fail closed', async () => {
  assert.throws(() => assertModuleRequester(task('marketing'), { role: 'administrador', active: false }));
  assert.throws(() => assertModuleRequester(task('commercial'), { role: 'vendedor', active: true }));
  const { api, data } = reader(); data.foreign_trade_role_permissions = [];
  await assert.rejects(buildBusinessModuleReport(task('logistics'), profile, api, '2026-09-09T14:00:00Z'), /forbidden/);
});
test('An ambiguous SKU is unknown, never zero or added together', async () => {
  const { api, data } = reader(); data.inventory_snapshots.push({ ...data.inventory_snapshots[0], external_id: 'other' });
  const result = await buildBusinessModuleReport(task('logistics'), profile, api, '2026-09-09T14:00:00Z');
  assert.equal(result.metrics.stock_unknown, 1); assert.equal(result.metrics.stockouts, 0);
});

test('Agents share catalog stock with the Copilot, with available and unknown counts separated', async () => {
  const { api, data } = reader();
  data.content_products.push({ id: 'second', sku: 'P2', name: 'Con respaldo', stock: 8, has_stock: true, last_synced_at: '2026-08-21', variants: [{ sku: 'P2', stock_management: true, stock: 8 }] });
  data.content_products.push({ id: 'unknown', sku: 'P3', name: 'Sin dato' });
  const result = await buildBusinessModuleReport(task('logistics'), profile, api, '2026-09-09T14:00:00Z');
  assert.equal(result.metrics.stock_available, 2);
  assert.equal(result.metrics.stock_unknown, 1);
  const record = result.evidence[0].module_report.sections.find((s) => s.key === 'products').rows.find((p) => p.sku === 'P2');
  assert.equal(record.stock_source, 'tiendanube_catalog');
  assert.equal(record.source_at, '2026-08-21');
});
test('Paging handles server caps, rejects missing rows and changing totals', async () => {
  const all = Array.from({ length: 1101 }, (_, i) => ({ id: i }));
  const found = await collectModuleRows(async (offset) => ({ rows: all.slice(offset, offset + 100), total: 1101 }));
  assert.equal(found.length, 1101);
  await assert.rejects(collectModuleRows(async () => ({ rows: [], total: 10 })), /incomplete/);
  await assert.rejects(collectModuleRows(async () => ({ rows: [], total: null })), /unverified/);
  await assert.rejects(collectModuleRows(async (offset) => ({ rows: [{ id: offset }], total: offset ? 3 : 2 })), /changed/);
});
test('Executive only notifies the daily scheduled report, never legacy reviews or manual requests', async () => {
  const { api } = reader(); const input = task('executive'); input.payload.mode = 'review';
  const first = await buildBusinessModuleReport(input, profile, api, '2026-09-09T14:00:00Z');
  assert.equal(first.metrics.notification_required, false); assert.ok(first.evidence[0].executive_brief);
  api.previousExecutive = async () => ({ result: first });
  const second = await buildBusinessModuleReport(input, profile, api, '2026-09-09T15:00:00Z');
  assert.equal(second.metrics.notification_required, false);
  const manual = await buildBusinessModuleReport(task('executive'), profile, api, '2026-09-09T15:00:00Z');
  assert.equal(manual.metrics.notification_required, false);
  input.payload.mode = 'daily'; input.payload.delivery = { auto_send: true };
  const daily = await buildBusinessModuleReport(input, profile, api, '2026-09-09T15:00:00Z');
  assert.equal(daily.metrics.notification_required, true);
  assert.equal(daily.evidence[0].executive_brief.mode, 'daily');
});
test('Copilot exposes module detail and preserves consultation vs source date', async () => {
  const { api } = reader(); const result = await buildBusinessModuleReport(task('commercial'), profile, api, '2026-09-09T14:00:00Z');
  const report = agentReport({ ...task('commercial'), result });
  assert.match(report.metadata.classification, /modulos/); assert.equal(report.sections.sections.length, 3);
  assert.equal(report.metadata.consulted_at, '2026-09-09T14:00:00Z');
});
test('All five types are handled at the common claim point', async () => {
  for (const type of Object.keys(types)) {
    const { api } = reader(); const calls = [];
    await runAccountingTask({ task: task(type), workerId: 'w', leaseToken: 'l',
      rpc: async (name) => { calls.push(name); return { error: null }; },
      readReport: () => buildBusinessModuleReport(task(type), profile, api, '2026-09-09T14:00:00Z') });
    assert.deepEqual(calls, ['heartbeat_business_agent_task', 'complete_business_agent_task']);
  }
});
