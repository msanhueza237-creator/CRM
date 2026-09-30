import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { previewFactoCostReturn, costReturnKey } from '../supabase/functions/accounting-center/facto-cost-return.ts';
import { readSourceDocumentSummaries } from '../supabase/functions/accounting-center/source-document-read-model.ts';

const invoice = { id: 'invoice', entity_id: 'entity', source_type: 'FACTO', document_type: 'sales_invoice', folio: '1001', external_id: '900',
  issued_on: '2026-08-27', currency: 'CLP', net_amount: 1000000, tax_amount: 190000, total_clp: 1190000,
  counterpart_tax_id: '77777777-7', status: 'posted', data_quality: 'validated', raw_payload: { header: { taxbureau_validation_status: 3 } } };
const note = { ...invoice, id: 'note', document_type: 'sales_credit_note', external_id: '901', folio: '10', issued_on: '2026-09-11',
  net_amount: 200000, tax_amount: 38000, total_clp: 238000, raw_payload: { header: { taxbureau_validation_status: 3,
    references: [{ reference_number: 1001, reference_date: '2026-08-27', reference_type: 3, document_type_taxbureau: 33, document_id: 900 }] } } };
const accounts = ['cost_of_sales', 'inventory', 'net_sales'].map(classification => ({ id: classification, entity_id: 'entity', classification,
  account_type: classification === 'net_sales' ? 'income' : classification === 'inventory' ? 'asset' : 'cost', active: true, allows_posting: true }));
const originalEntry = { id: 'entry', entity_id: 'entity', source_document_id: 'invoice', status: 'posted', entry_date: '2026-08-27', description: 'Costo historico Facto' };
const lines = [
  { id: 'cost', account_id: 'cost_of_sales', debit_clp: 700000, credit_clp: 0, accounting_journal_entries: originalEntry },
  { id: 'inventory', account_id: 'inventory', debit_clp: 0, credit_clp: 700000, accounting_journal_entries: originalEntry },
];
const periods = [{ id: 'period', entity_id: 'entity', starts_on: '2026-09-01', ends_on: '2026-09-30', status: 'open' }];
const input = { entityId: 'entity', sourceDocumentId: 'note', amountClp: 140000, evidence: 'Fixture: Libro Diario Facto con devolucion de mercaderia al costo historico comprobado', saleableReturnConfirmed: true };
const run = (patch = {}) => previewFactoCostReturn(patch.input || input, patch.documents || [invoice, note], patch.lines || lines, patch.accounts || accounts, patch.periods || periods, patch.entries || [], '2026-09-30');

test('partial return retains invoice cost, previews only balanced cost/inventory delta', () => {
  const p = run();
  assert.equal(p.amountClp, 140000); assert.equal(p.originalCost, 700000); assert.equal(p.remainingCost, 560000);
  assert.equal(p.date, '2026-09-11'); assert.equal(p.invoiceId, 'invoice'); assert.equal(p.otherReversals, 0);
});
test('requires physical saleable return and positive whole-peso cost with evidence', () => {
  for (const change of [{ saleableReturnConfirmed: false }, { saleableReturnConfirmed: 'true' }, { amountClp: 0 }, { amountClp: -1 },
    { amountClp: 1.5 }, { amountClp: Infinity }, { amountClp: 700001 }, { evidence: 'short' }, { evidence: 'x'.repeat(501) }])
    assert.throws(() => run({ input: { ...input, ...change } }));
});
test('unaccepted, future, foreign, ambiguous or changed references cannot be posted', () => {
  for (const change of [{ currency: 'USD' }, { counterpart_tax_id: 'another' }, { entity_id: 'other' }, { data_quality: 'inconsistent' },
    { issued_on: '2026-10-01' }, { raw_payload: { header: { ...note.raw_payload.header, taxbureau_validation_status: 5 } } },
    { raw_payload: { header: { ...note.raw_payload.header, references: [] } } }]) assert.throws(() => run({ documents: [invoice, { ...note, ...change }] }));
  assert.throws(() => run({ documents: [invoice, { ...invoice, id: 'duplicate' }, note] }));
  assert.throws(() => run({ documents: [{ ...invoice, currency: 'USD' }, note] }));
});
test('closed, review, unknown periods and ambiguous accounts block preview', () => {
  for (const status of ['closed', 'review']) assert.throws(() => run({ periods: [{ ...periods[0], status }] }));
  assert.throws(() => run({ periods: [] }));
  assert.throws(() => run({ accounts: [...accounts, { ...accounts[0], id: 'duplicate-cost' }] }));
});
test('any cost under another key or state blocks same-note duplication', () => {
  for (const status of ['posted', 'reversed', 'draft', 'validated', 'voided']) {
    assert.throws(() => run({ lines: [...lines, { ...lines[0], id: 'another', accounting_journal_entries: { ...originalEntry, id: 'duplicate', status, source_document_id: 'note' } }] }));
  }
  assert.throws(() => run({ entries: [{ entity_id: 'entity', idempotency_key: 'facto-cost:note' }] }));
  assert.throws(() => run({ entries: [{ entity_id: 'entity', idempotency_key: costReturnKey('invoice') }] }));
});
test('unbalanced, estimated or reversed original costs are not usable evidence', () => {
  assert.throws(() => run({ lines: lines.slice(0, 1) }));
  for (const patch of [{ status: 'reversed' }, { status: 'draft' }, { description: 'COSTO ESTIMADO margen promedio 30%' }])
    assert.throws(() => run({ lines: lines.map(l => ({ ...l, accounting_journal_entries: { ...originalEntry, ...patch } })) }));
});
test('other-note reversals reduce remaining cost; malformed evidence cannot be ignored', () => {
  const another = { ...note, id: 'other-note', folio: '11' };
  const reverse = lines.map((l, i) => ({ ...l, id: `reverse-${i}`, debit_clp: i ? 600000 : 0, credit_clp: i ? 0 : 600000,
    accounting_journal_entries: { ...originalEntry, id: 'reverse', source_document_id: 'other-note' } }));
  assert.throws(() => run({ documents: [invoice, note, another], lines: [...lines, ...reverse] }), /excede/);
  assert.throws(() => run({ documents: [invoice, note, another], lines: [...lines, reverse[0]] }), /balanceada/);
});
test('review key changes with evidence or financial state but not sync timestamp', () => {
  const p = run();
  assert.equal(run({ documents: [invoice, { ...note, updated_at: 'later' }] }).reviewKey, p.reviewKey);
  assert.notEqual(run({ input: { ...input, amountClp: 180000 } }).reviewKey, p.reviewKey);
  assert.notEqual(run({ input: { ...input, evidence: input.evidence + ' actualizado' } }).reviewKey, p.reviewKey);
  assert.notEqual(run({ lines: lines.map(l => ({ ...l, id: l.id + '-changed' })) }).reviewKey, p.reviewKey);
});

const source = await readFile(new URL('../supabase/functions/accounting-center/index.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function reviewFactoCostReturn('), source.indexOf('async function postFactoCostEntry('));
const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const writes = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const deps = { requiredUuid: x => x, HttpError, accountingToday: () => '2026-09-30', previewFactoCostReturn,
    readSourceDocumentSummaries,
    selectRows: async (_, path) => {
      assert.match(path, /limit=25&offset=0&source_type=eq.FACTO/);
      return [invoice, note];
    },
    selectAllRows: async (_, path) => path.startsWith('accounting_journal_lines') ? lines
      : path.startsWith('accounting_accounts') ? accounts : path.startsWith('accounting_periods') ? periods : [],
    postFactoCostEntry: async (...args) => { writes.push(args); return { entryId: 'saved' }; } };
  const execute = new Function(...Object.keys(deps), `${compiled}; return reviewFactoCostReturn;`)(...Object.values(deps));
  return { writes, execute: patch => execute({}, { id: 'actor' }, 'request', { ...input, ...patch }) };
}
test('backend preview never writes; stale and unconfirmed requests fail closed', async () => {
  const f = fixture(); const result = await f.execute({ preview: true }); assert.equal(result.preview.amountClp, 140000); assert.equal(f.writes.length, 0);
  for (const payload of [{}, { confirmed: false, reviewKey: result.preview.reviewKey }, { confirmed: true, reviewKey: 'stale' }]) await assert.rejects(() => f.execute(payload));
  assert.equal(f.writes.length, 0);
  await f.execute({ confirmed: true, reviewKey: result.preview.reviewKey }); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][4].invoiceId, 'invoice');
});

test('return review pages documents and removes embedded files without losing references', async () => {
  const paths = [];
  const docs = await readSourceDocumentSummaries(async path => {
    paths.push(path);
    const row = { ...note, raw_payload: { ...note.raw_payload, electronic_document: { pdf: 'large-file' } } };
    return path.includes('offset=0') ? Array.from({ length: 25 }, () => row) : [row];
  }, 'entity', '9999-12-31');
  assert.equal(paths.length, 2);
  assert.equal(docs.length, 26);
  assert.match(paths[1], /limit=25&offset=25/);
  assert.ok(docs.every(d => !('electronic_document' in d.raw_payload)));
  assert.deepEqual(docs[25].raw_payload.header.references, note.raw_payload.header.references);
  assert.match(body, /readSourceDocumentSummaries/);
  assert.doesNotMatch(body, /selectAllRows\(rest, `accounting_source_documents/);
});
test('route requires posting permission, legacy rejects unreviewed notes, and invoice-wide uniqueness prevents parallel notes', async () => {
  assert.match(source, /route === "facto\/cost-return-review"[\s\S]{0,150}requirePermission\(profile, "post"\)/);
  assert.match(source, /if \(creditNote && \(!reviewedReturn/);
  assert.match(source, /reviewedReturn \? costReturnKey\(reviewedReturn.invoiceId\)/);
  const schema = await readFile(new URL('../supabase/accounting_center.sql', import.meta.url), 'utf8');
  assert.match(schema, /unique \(entity_id, idempotency_key\)/);
  const api = await readFile(new URL('../src/lib/accountingApi.ts', import.meta.url), 'utf8');
  assert.match(api, /"facto\/cost-return-review"/);
  const ui = await readFile(new URL('../src/modules/accounting/VerifiedFactoReturn.tsx', import.meta.url), 'utf8');
  assert.ok(!ui.includes('useEffect')); assert.match(ui, /running.current/); assert.match(ui, /!preview \|\| !confirmed/);
});
