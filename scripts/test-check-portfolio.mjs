import assert from 'node:assert/strict';
import { buildCheckPortfolio } from '../supabase/functions/accounting-center/check-portfolio.ts';
import { reportedChecks, checkInstrumentDate, checkInvoiceNumbers } from '../src/modules/accounting/checkPortfolio.ts';

const batch = { id: 'applied', status: 'imported', error_count: 0, row_count: 6, file_name: 'active.xlsx', created_at: '2026-09-25T12:00:00Z' };
const importRows = Array.from({ length: 6 }, (_, i) => ({
  id: `row-${i}`, status: 'imported', validation_errors: [],
  normalized_data: { kind: 'check', check_number: String(100 + i), amount_clp: 100000 },
}));
const checks = importRows.map((row, i) => ({
  id: `check-${i}`, import_batch_id: batch.id, source_row_id: row.id,
  check_number: row.normalized_data.check_number, amount_clp: 100000, status: 'portfolio',
  received_on: '2026-10-24', due_on: null,
  metadata: { source_row_ids: [row.id], allocations: [{ source_document_number: String(900 + i) }] },
}));
const manual = { ...checks[0], id: 'manual', import_batch_id: null, due_on: '2026-10-24', received_on: '2026-08-28' };
const bankBox = { ...manual, id: 'bank-box', check_number: '099', amount_clp: 150000 };
const all = [...checks, manual, bankBox];
const before = JSON.stringify(all);
const report = buildCheckPortfolio(batch, importRows, all);
assert.equal(report.verified, true);
assert.equal(report.count, 6);
assert.equal(report.amountClp, 600000);
assert.equal(reportedChecks({ checks: all, checkPortfolio: report }).length, 6);
assert.equal(JSON.stringify(all), before, 'selection never closes, merges or changes old records');
assert.equal(checkInstrumentDate(checks[0]), '2026-10-24', 'future instrument dates remain visible');
assert.equal(checkInstrumentDate(manual), '2026-10-24');
assert.equal(checkInvoiceNumbers(checks[0]), '900');
assert.equal(checkInvoiceNumbers(checks[1]), '901', 'adjacent cheque numbers keep distinct invoices');
assert.equal(buildCheckPortfolio({ ...batch, status: 'previewed' }, importRows, all).verified, false);
assert.equal(buildCheckPortfolio({ ...batch, status: 'partial' }, importRows, all).amountClp, null);
assert.equal(buildCheckPortfolio(batch, importRows.slice(1), all).amountClp, null);
assert.equal(buildCheckPortfolio(batch, importRows, all.slice(1)).amountClp, null);
assert.equal(buildCheckPortfolio(batch, importRows, [...all, { ...checks[0], id: 'duplicate' }]).verified, false);
assert.equal(buildCheckPortfolio(batch, importRows, all.map(row => row.id === 'check-0' ? { ...row, amount_clp: 90000 } : row)).verified, false);
assert.equal(buildCheckPortfolio(batch, importRows.map(row => ({ ...row, status: 'new' })), all).verified, false);
assert.equal(buildCheckPortfolio(batch, importRows.map(row => ({ ...row, validation_errors: ['invalid'] })), all).verified, false);
for (const status of ['collected', 'protested', 'voided', 'deposited']) {
  assert.equal(buildCheckPortfolio(batch, importRows, all.map(row => row.id === 'check-0' ? { ...row, status } : row)).amountClp, 500000);
}
const grouped = [{ ...checks[0], amount_clp: 200000, metadata: { source_row_ids: ['row-0', 'row-1'] } }, ...checks.slice(2)];
assert.equal(buildCheckPortfolio(batch, importRows.map((row, i) => i === 1 ? { ...row, normalized_data: { ...row.normalized_data, check_number: '100' } } : row), grouped).count, 5);
const unavailable = buildCheckPortfolio(batch, [], all);
assert.equal(reportedChecks({ checks: all, checkPortfolio: unavailable }).length, 0, 'invalid reports must not silently fall back to double counted ledger rows');
assert.equal(reportedChecks({ checks: all, checkPortfolio: buildCheckPortfolio(null, [], all) }).length, all.length);
console.log('Check portfolio: confirmed scope, future dates, invoices, allocation grouping, protected states and invalid evidence passed.');
