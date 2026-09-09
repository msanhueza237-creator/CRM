import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAccountingAgentReport, isAccountingAnalysisTask, hasAccountingTaskLease } from '../supabase/functions/accounting-center/agent-report.ts';
import { runAccountingTask } from '../supabase/functions/crm-agent/accounting-task-runner.ts';

const fixture = () => ({
  entity: { id: 'entity-1' },
  summary: { as_of: '2026-09-09', receivables: 11287934, receivables_overdue: 321885, receivables_confirmed: 9000000, provisional: true },
  dashboard: { available: true, basis: 'mixed', from: '2026-01-01', to: '2026-09-09', warnings: ['Costo parcial'], current: { sales: 136494301, costs: 79339554, operatingProfit: 40578292 } },
  factoReceivables: { authoritative: true, portfolioComplete: true, asOf: '2026-09-07', mode: 'facto_excel', details: [{ document_id: '1557', observed_amount: 11287934 }] },
  receivables: [{ id: 'operational', reported_balance: 11287934 }],
  factoFreshness: { stale: true },
});

test('Finance uses module results without recomputing profit or hiding unknown fields', () => {
  const result = buildAccountingAgentReport('finance', fixture(), '2026-09-09T14:00:00Z');
  assert.equal(result.metrics.net_sales, 136494301);
  assert.equal(result.metrics.operating_profit, 40578292);
  assert.equal(result.metrics.bank_clp, null);
  assert.equal(result.metrics.operating_expenses, null);
  assert.deepEqual(result.proposals, []);
  assert.ok(result.warnings.includes('Costo parcial'));
  assert.equal(result.evidence[0].accounting_module_report.source_as_of, '2026-09-07');
});

test('Excel cartera is accepted, with separate bank and operational evidence', () => {
  const result = buildAccountingAgentReport('collections', fixture(), 'now');
  assert.equal(result.metrics.receivables, 11287934);
  assert.equal(result.metrics.bank_confirmed_receivables, 9000000);
  assert.equal(result.metrics.verified_receivables_available, true);
  const evidence = result.evidence[0].accounting_module_report;
  assert.equal(evidence.verified_documents.length, 1);
  assert.equal(evidence.operational_documents.length, 1);
  assert.deepEqual(result.proposals, []);
});

test('Partial inconsistent data does not become a verified or zero balance', () => {
  const data = fixture();
  data.summary.receivables_suppressed = true;
  data.dashboard.available = false;
  const result = buildAccountingAgentReport('finance', data, 'now');
  assert.equal(result.metrics.receivables, null);
  assert.equal(result.metrics.overdue_amount, null);
  assert.equal(result.metrics.net_sales, null);
  assert.equal(result.metrics.verified_receivables_available, false);
  assert.deepEqual(result.evidence[0].accounting_module_report.verified_documents, []);
});

test('All verified documents survive reporting, including more than 1000', () => {
  const data = fixture();
  data.factoReceivables.details = Array.from({ length: 1201 }, (_, i) => ({ document_id: String(i), observed_amount: i }));
  assert.equal(buildAccountingAgentReport('collections', data, 'now').evidence[0].accounting_module_report.verified_documents.length, 1201);
});

test('Sync and unrelated actions are never intercepted', async () => {
  for (const task of [{ agent_type: 'collections', action: 'sync_facto_receivables' }, { agent_type: 'commercial', action: 'create_quote' }]) {
    assert.equal(isAccountingAnalysisTask(task), false);
    assert.equal(await runAccountingTask({ task, rpc: () => assert.fail('Unexpected RPC'), readReport: () => assert.fail('Unexpected read') }), false);
  }
});

test('Manual and scheduled tasks ignore stale browser payloads and use the same module result', async () => {
  for (const requested_by of ['user', null]) {
    const calls = [];
    const report = buildAccountingAgentReport('collections', fixture(), 'now');
    assert.equal(await runAccountingTask({
      task: { id: 'task', agent_type: 'collections', action: 'review_aging', requested_by, payload: { overdue_amount: 999999999 } },
      workerId: 'worker', leaseToken: 'lease',
      rpc: async (name, args) => { calls.push([name, args]); return { error: null }; },
      readReport: async (lease) => { assert.deepEqual(lease, { task_id: 'task', worker_id: 'worker', lease_token: 'lease' }); return report; },
    }), true);
    assert.equal(calls[0][0], 'heartbeat_business_agent_task');
    assert.equal(calls[1][0], 'complete_business_agent_task');
    assert.equal(calls[1][1].p_result.metrics.overdue_amount, 321885);
  }
});

test('Unavailable module fails the task instead of running legacy worker', async () => {
  const calls = [];
  assert.equal(await runAccountingTask({
    task: { id: 'task', agent_type: 'finance', action: 'review_margin' }, workerId: 'worker', leaseToken: 'lease',
    rpc: async (name, args) => { calls.push([name, args]); return { error: null }; },
    readReport: async () => { throw new Error('HTTP 403'); },
  }), true);
  assert.deepEqual(calls.map(([name]) => name), ['heartbeat_business_agent_task', 'fail_business_agent_task']);
});

test('Lost lease never reads a module or completes a task', async () => {
  await assert.rejects(runAccountingTask({
    task: { id: 'task', agent_type: 'finance', action: 'review_margin' }, workerId: 'worker', leaseToken: 'lease',
    rpc: async () => ({ error: { message: 'lease_lost' } }), readReport: () => assert.fail('Unexpected read'),
  }), /lease_lost/);
});

test('Internal report rejects expired, unrelated, missing and mismatched leases', () => {
  const task = { agent_type: 'finance', action: 'review_margin', status: 'in_progress', worker_id: 'w', lease_token: 'l', lease_expires_at: '2026-09-09T14:00:00Z' };
  const input = { worker_id: 'w', lease_token: 'l' };
  const now = Date.parse('2026-09-09T13:59:00Z');
  assert.equal(hasAccountingTaskLease(task, input, now), true);
  assert.equal(hasAccountingTaskLease(undefined, input, now), false);
  assert.equal(hasAccountingTaskLease(task, {}, now), false);
  assert.equal(hasAccountingTaskLease(task, { ...input, worker_id: 'another' }, now), false);
  assert.equal(hasAccountingTaskLease(task, input, now + 60000), false);
  assert.equal(hasAccountingTaskLease({ ...task, status: 'completed' }, input, now), false);
  assert.equal(hasAccountingTaskLease({ ...task, action: 'sync_facto_receivables' }, input, now), false);
});
