import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleForVerifiedCost, validVerifiedCostInput } from '../src/modules/accounting/verifiedFactoCostPolicy.ts';

const source = { source_type: 'FACTO', document_type: 'sales_invoice', currency: 'CLP', status: 'validated', data_quality: 'validated', issued_on: '2026-06-03' };
const periods = [{ status: 'open', starts_on: '2026-06-01', ends_on: '2026-06-30' }];

test('validated CLP sale in open period can be reviewed', () => {
  assert.equal(eligibleForVerifiedCost(source, periods), true);
  assert.equal(eligibleForVerifiedCost({ ...source, status: 'posted' }, periods), true);
});
test('reject credit notes, purchases, foreign currency and unvalidated sources', () => {
  for (const changes of [{ document_type: 'sales_credit_note' }, { document_type: 'purchase_invoice' }, { currency: 'USD' }, { source_type: 'MANUAL' }, { status: 'voided' }, { status: 'inconsistent' }, { data_quality: 'pending' }]) {
    assert.equal(eligibleForVerifiedCost({ ...source, ...changes }, periods), false);
  }
});
test('missing date, closed, review or out-of-range periods cannot be imported', () => {
  for (const period of [{ ...periods[0], status: 'closed' }, { ...periods[0], status: 'review' }, { ...periods[0], starts_on: '2026-07-01' }]) assert.equal(eligibleForVerifiedCost(source, [period]), false);
  assert.equal(eligibleForVerifiedCost({ ...source, issued_on: null }, periods), false);
  assert.equal(eligibleForVerifiedCost(source, []), false);
});
test('requires positive whole pesos, evidence and explicit verification', () => {
  const evidence = 'Libro Diario, documento, fecha y par costo/inventario verificados';
  assert.equal(validVerifiedCostInput('13761', evidence, true), true);
  for (const amount of ['', '0', '-1', 'NaN', 'Infinity', '1.5', '9007199254740992']) assert.equal(validVerifiedCostInput(amount, evidence, true), false);
  assert.equal(validVerifiedCostInput('13761', evidence, false), false);
  assert.equal(validVerifiedCostInput('13761', 'breve', true), false);
  assert.equal(validVerifiedCostInput('13761', ' '.repeat(25), true), false);
  assert.equal(validVerifiedCostInput('13761', 'a'.repeat(501), true), false);
});
