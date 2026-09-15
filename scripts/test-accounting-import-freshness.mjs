import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { LatestReadQueue } from '../src/modules/accounting/latestReadQueue.ts';
import { analyzeFactoReceivablesSnapshot, isVerifiedFactoReceivableBalanceSource } from '../supabase/functions/accounting-center/facto-receivables.ts';

const source = await readFile('supabase/functions/accounting-center/index.ts', 'utf8');
function load(names, context = {}) {
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(tree)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(context), `${code};return {${names.join(',')}}`)(...Object.values(context));
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const base = { HttpError, asObject: x => x || {}, numeric: x => Number(x || 0), requiredUuid: x => x };
const helpers = load(['dateTimeValue', 'normalizeText', 'bankRealitySequence', 'isFactoSnapshotCurrent'], base);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('post-import refresh discards the in-flight old read and waits for a fresh read', async () => {
  const queue = new LatestReadQueue();
  const old = deferred(), fresh = deferred(), published = [];
  let calls = 0;
  const read = () => ++calls === 1 ? old.promise : fresh.promise;
  const first = queue.request(read, value => published.push(value));
  await Promise.resolve();
  const refresh = queue.request(read, value => published.push(value), true);
  queue.request(read, value => published.push(value), true);
  old.resolve('old');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(published, []);
  fresh.resolve('new');
  await Promise.all([first, refresh]);
  assert.deepEqual(published, ['new']);
  assert.equal(calls, 2);
});

test('a failed refresh can be retried and never claims a new value', async () => {
  const queue = new LatestReadQueue(), published = [];
  await assert.rejects(queue.request(async () => { throw Error('offline'); }, v => published.push(v)), /offline/);
  await queue.request(async () => 'new', v => published.push(v), true);
  assert.deepEqual(published, ['new']);
});

test('pending Excel previews are recovered from stored rows without uploading again', async () => {
  const batch = { id: 'pending', source_type: 'COLLECTIONS', status: 'previewed', row_count: 22, duplicate_count: 0, error_count: 0, import_profile: 'facto_unpaid_documents', summary: { receivables_documents: 16, payables_documents: 3 } };
  const rows = Array.from({ length: 22 }, (_, i) => ({ row_number: i + 1, status: 'new', fingerprint: `row-${i}`, normalized_data: { kind: 'document', amount: 100 }, validation_errors: [] }));
  const context = { ...base, selectRows: async () => [batch], selectAllRows: async () => rows };
  const { getFactoExcelPreview } = load(['getFactoExcelPreview'], context);
  const preview = await getFactoExcelPreview({}, batch.id);
  assert.equal(preview.batch.id, batch.id);
  assert.equal(preview.summary.new, 22);
  assert.equal(preview.summary.payables_documents, 3);
  assert.equal(preview.rows.length, 22);
  rows.pop();
  await assert.rejects(getFactoExcelPreview({}, batch.id), /incompleto/);
  batch.status = 'imported';
  await assert.rejects(getFactoExcelPreview({}, batch.id), /ya fue aplicado/);
});

test('legacy cheque previews classified as duplicates can still update the existing portfolio', async () => {
  const batch = { id: 'checks', entity_id: 'entity', source_type: 'CHECKS', status: 'previewed', row_count: 2, duplicate_count: 1, error_count: 0 };
  const rows = ['duplicate', 'new'].map((status, i) => ({ row_number: i + 1, status, normalized_data: { number: i + 1 } }));
  const context = { ...base, selectRows: async () => [batch],
    selectAllRows: async (_, query) => query.startsWith('accounting_checks') ? [{ number: 1 }] : rows,
    physicalCheckBusinessKey: data => String(data.number),
    findExistingFactoCheck: (checks, data) => checks.find(check => check.number === data.number),
  };
  const preview = await load(['getFactoExcelPreview'], context).getFactoExcelPreview({}, batch.id);
  assert.equal(preview.summary.new, 2);
  assert.equal(preview.summary.checks_total, 2);
  assert.equal(preview.summary.checks_update, 1);
  assert.equal(preview.summary.checks_new, 1);
});

const applied = { id: 'new-batch', entity_id: 'entity', created_at: '2026-09-15T10:00:00Z', summary: { confirmed_at: '2026-09-15T10:01:00Z', coverage_from: '2026-01-01', coverage_to: '2026-09-15', receivables_complete: true, receivables_documents: 16, payables_documents: 3 } };
test('republishing an old Excel does not make it newer than the applied portfolio', () => {
  assert.equal(helpers.isFactoSnapshotCurrent({ mode: 'facto_excel', source_batch_id: 'old', as_of: '2026-09-09', evidence_observed_at: '2026-09-16T00:00:00Z' }, applied), false);
  assert.equal(helpers.isFactoSnapshotCurrent({ mode: 'facto_excel', source_batch_id: applied.id, as_of: '2026-09-15' }, applied), true);
  assert.equal(helpers.isFactoSnapshotCurrent({ mode: 'facto_receivables', as_of: '2026-09-15' }, applied), false);
  assert.equal(helpers.isFactoSnapshotCurrent({ mode: 'facto_receivables', as_of: '2026-09-15', observed_at: '2026-09-15T12:00:00Z' }, applied), true);
});

test('older or out-of-order complete workbooks cannot overwrite newer customer/supplier balances', async () => {
  const { assertFactoPortfolioIsCurrent } = load(['assertFactoPortfolioIsCurrent'], { ...base, selectAllRows: async () => [applied] });
  await assert.rejects(assertFactoPortfolioIsCurrent({}, { ...applied, id: 'older-upload', created_at: '2026-09-15T09:00:00Z' }), /reciente/);
  await assert.rejects(assertFactoPortfolioIsCurrent({}, { ...applied, id: 'historical', created_at: '2026-09-16T10:00:00Z', summary: { ...applied.summary, coverage_to: '2026-09-09' } }), /reciente/);
  await assertFactoPortfolioIsCurrent({}, { ...applied, id: 'newer', created_at: '2026-09-15T11:00:00Z' });
  await assertFactoPortfolioIsCurrent({}, applied);
});

test('an old automatic snapshot makes no writes after a newer Excel was applied', async () => {
  const context = { ...base, ...helpers,
    selectRows: async () => [{ updated_at: '2026-09-16T10:00:00Z', payload: { collections: { mode: 'facto_excel', as_of: '2026-09-09', source_batch_id: 'old' } } }],
    latestAppliedReceivablesBatch: async () => applied,
    selectAllRows: async () => { throw Error('should not load or change portfolio'); },
  };
  const result = await load(['syncFactoReportedBalances'], context).syncFactoReportedBalances({}, {}, 'request', 'entity', '2026-01-01', '2026-09-16');
  assert.equal(result.updated, 0); assert.equal(result.cleared, 0);
});

test('snapshot closure respects its coverage date and preserves a more recent row', async () => {
  const queries = [], writes = [];
  const context = { ...base, ...helpers, analyzeFactoReceivablesSnapshot, isVerifiedFactoReceivableBalanceSource,
    latestAppliedReceivablesBatch: async () => null,
    selectRows: async () => [{ updated_at: '2026-09-14T10:00:00Z', payload: { collections: { mode: 'facto_receivables', authoritative: true, portfolio_complete: true, as_of: '2026-09-14', documents: 0, observed_amount: 0, documents_detail: [] } } }],
    selectAllRows: async (_, query) => { queries.push(query); return query.startsWith('accounting_source_documents') ? [{ id: 'doc', document_type: 'sales_invoice' }] : [{ id: 'ar', source_document_id: 'doc', original_amount_clp: 100, reported_at: '2026-09-15T11:00:00Z' }]; },
    patchRows: async (...args) => { writes.push(args); },
  };
  await load(['syncFactoReportedBalances'], context).syncFactoReportedBalances({}, {}, 'request', 'entity', '2026-01-01', '2026-09-16');
  assert.match(queries[0], /issued_on=lte\.2026-09-14/);
  assert.deepEqual(writes, []);
});

test('duplicate-only bank imports retain the latest balance evidence without posting again', async () => {
  const batch = { id: 'bank-file', entity_id: 'entity', source_type: 'BANCO_ESTADO', status: 'previewed', row_count: 2, error_count: 0, duplicate_count: 2, file_name: 'latest.xlsx', summary: { currency: 'CLP', account_hint: '123' } };
  const rows = [1, 2].map(n => ({ id: `r${n}`, row_number: n, status: 'duplicate', normalized_data: { transaction_date: '2026-09-15', balance: n * 100, currency: 'CLP', amount: 100 } }));
  const writes = [];
  const context = { ...base, selectRows: async () => [batch], selectAllRows: async () => rows,
    bankAccountForBatch: async () => ({ id: 'account' }), existingBankDuplicateRows: async () => new Set(),
    upsertRows: async (_, table, data) => { assert.deepEqual(data, []); return []; },
    patchRows: async (_, table, filter, data) => { if (table === 'accounting_import_batches') Object.assign(batch, data); writes.push(table); return []; },
    postImportedBankFlow: async (_, profile, entity, created) => { assert.deepEqual(created, []); return {}; },
    rpc: async (_, name) => { assert.equal(name, 'accounting_refresh_controls'); return {}; },
    insertRows: async (_, table) => { writes.push(table); return []; },
  };
  await load(['confirmImport'], context).confirmImport({}, { id: 'user' }, { batchId: batch.id });
  assert.equal(batch.summary.statement_balance.balance, 200);
  assert.equal(batch.summary.bank_account_id, 'account');
  assert.ok(batch.summary.confirmed_at);
  assert.ok(writes.every(table => ['accounting_import_batches', 'accounting_audit_events'].includes(table)));
});

test('bank display uses new statement balance, including duplicate-only files, over an older same-day snapshot', async () => {
  const old = { id: 'tx', bank_account_id: 'account', transaction_date: '2026-09-15', created_at: '2026-09-15T08:00:00Z', balance: 100, currency: 'CLP', exchange_rate: 1 };
  const batch = { id: 'new', created_at: '2026-09-15T11:00:00Z', file_name: 'new.xlsx', summary: { bank_account_id: 'account', statement_balance: { transaction_date: '2026-09-15', balance: 200, currency: 'CLP', exchange_rate: 1, row_number: 2 } } };
  const context = { ...base, ...helpers, selectAllRows: async (_, query) => query.startsWith('accounting_import_batches') ? [batch] : query.startsWith('accounting_bank_transactions') ? [old] : [] };
  const accounts = [{ id: 'account', ledger_account_id: 'ledger', institution: 'BancoEstado', currency: 'CLP', account_number_masked: '123' }];
  const snapshots = [{ bank_account_id: 'account', as_of_date: '2026-09-15', created_at: '2026-09-15T10:00:00Z', balance: 150, balance_clp: 150 }];
  const { buildBankReality } = load(['buildBankReality'], context);
  const result = await buildBankReality({}, 'entity', accounts, [old], snapshots);
  assert.equal(result.availableClp, 200);
  assert.equal(result.accounts[0].statementFileName, 'new.xlsx');
  assert.equal(result.accounts[0].basis, 'statement');
  snapshots[0].created_at = '2026-09-15T12:00:00Z';
  assert.equal((await buildBankReality({}, 'entity', accounts, [old], snapshots)).availableClp, 150);
});
