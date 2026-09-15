import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as XLSX from 'xlsx';
import { bankMoney, bankIsoDate } from '../supabase/functions/accounting-center/bank-normalizers.ts';

function functions(source, context, names) {
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const pieces = tree.statements.filter(n => ts.isFunctionDeclaration(n) && (!names || names.includes(n.name?.text)));
  const code = ts.transpileModule(pieces.map(n => n.getText(tree).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(context), `${code};return {${(names || pieces.map(n => n.name.text)).join(',')}}`)(...Object.values(context));
}
const parser = functions(await readFile('supabase/functions/accounting-center/facto-excel-parsers.ts', 'utf8'), { XLSX, money: bankMoney, isoDate: bankIsoDate });
const header = ['Nombre Titular', 'Banco', 'Numero Documento', 'Numero', 'Fecha', 'Fecha Cobro', 'Monto', 'Rut Receptor', 'Activo/Inactivo'];
const first = ['Cliente de prueba', 'Santander', '1557', '000232', '14-09-2026', '30-09-2026', 60000, '771111111', 'Activo'];
const second = [...first]; second[2] = '1558'; second[6] = 40000;
function workbook(sheets, bookType = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { bookType, type: 'buffer' });
}
const parse = (sheets, type) => parser.parseFactoExcelWorkbook(workbook(sheets, type), 'facto_checks_banco_estado');
const report = await parse({ Portada: [['Listado Facto']], Cheques: [header, first, header, second] });
assert.equal(report.rows.length, 2);
assert.equal(report.summary.amount_clp, 100000);
assert.equal(report.rows[0].data.check_number, '000232');
assert.equal(report.rows[0].data.source_sheet, 'Cheques');
assert.notEqual(report.rows[0].fingerprint, report.rows[1].fingerprint);
assert.deepEqual(report.rows.flatMap(r => r.errors), []);
const multi = await parse({ Uno: [header, first], Dos: [header, second] }, 'xls');
assert.equal(multi.rows.length, 2);
assert.notEqual(multi.rows[0].row_number, multi.rows[1].row_number);
assert.deepEqual(multi.rows.flatMap(r => r.errors), []);
const formatted = [...first]; formatted[6] = '$1.234.567'; formatted[4] = new Date('2026-09-14T00:00:00Z');
const localized = await parse({ Datos: [header, formatted] });
assert.equal(localized.summary.amount_clp, 1234567);
assert.equal(localized.rows[0].data.received_on, '2026-09-14');
assert.deepEqual(localized.rows[0].errors, []);
const repeated = await parse({ Uno: [header, first], Dos: [header, first] });
assert.match(repeated.rows[1].errors.join(' '), /repetida/);
for (const [index, value, expected] of [[0, '', /Titular/], [1, '', /Banco/], [4, '31-02-2026', /recepci/], [5, 'abc', /cobro/], [6, -100, /Monto/], [6, 'abc', /Monto/]]) {
  const invalid = [...first]; invalid[index] = value;
  assert.match((await parse({ Datos: [header, invalid] })).rows[0].errors.join(' '), expected);
}
await assert.rejects(parse({ Datos: [header] }), /no contiene cheques/);
await assert.rejects(parse({ Datos: [header, first], Rota: [second] }), /sin un encabezado/);
const noNumber = [...first]; noNumber[3] = ''; noNumber[6] = 'abc';
assert.match((await parse({ Datos: [header, noNumber] })).rows[0].errors.join(' '), /cheque faltante/);
assert.equal((await parse({ Datos: [header, first, ['Total', '', '', '', '', '', 60000]] })).rows.length, 1);

const source = await readFile('supabase/functions/accounting-center/index.ts', 'utf8');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const helpers = functions(source, { HttpError, asObject: x => x || {} }, [
  'physicalCheckBusinessKey', 'checkBusinessKey', 'normalizeText', 'normalizeDocumentNumber',
  'normalizeTaxForMatch', 'dateValue', 'findExistingFactoCheck', 'findFactoSourceDocument',
]);
const checks = [];
const writes = [];
const context = {
  ...helpers, HttpError, asObject: x => x || {}, numeric: x => Number(x || 0),
  expectedBankAccount: async () => ({ id: 'bank' }),
  selectAllRows: async () => checks,
  patchRows: async (_, table, filter, payload) => {
    assert.equal(table, 'accounting_checks');
    const row = checks.find(check => `id=eq.${check.id}` === filter);
    Object.assign(row, payload); writes.push(table); return [row];
  },
  insertRows: async (_, table, payload) => {
    assert.equal(table, 'accounting_checks');
    writes.push(table); return payload.map(row => ({ id: `check-${checks.length}`, ...row }));
  },
};
const { consolidateFactoCheckRows, existingFactoExcelDuplicates } = functions(source, context, ['consolidateFactoCheckRows', 'existingFactoExcelDuplicates']);
const rows = report.rows.map((row, i) => ({ id: `row-${i}`, normalized_data: row.data }));
const apply = (data = rows, batch = 'batch1', at = '2026-09-14T12:00:00Z') => consolidateFactoCheckRows({}, 'entity', batch, data, [], [], at);
await apply();
assert.equal(checks.length, 1);
assert.equal(checks[0].amount_clp, 100000);
assert.equal(checks[0].status, 'portfolio');
assert.equal(checks[0].facto_collected_on, null);
assert.equal(checks[0].metadata.allocations.length, 2);
checks[0].receivable_id = 'existing-opening-receivable';
assert.equal((await existingFactoExcelDuplicates({}, 'entity', report)).size, 0, 'existing cheques must be updated, not skipped');
await apply(rows.map(row => ({ ...row, id: `${row.id}-retry` })));
assert.equal(checks.length, 1);
assert.equal(checks[0].amount_clp, 100000, 'retry retains the complete multi-invoice cheque');
assert.equal(checks[0].receivable_id, 'existing-opening-receivable');
const changed = rows.map(row => ({ ...row, normalized_data: { ...row.normalized_data, source_status: 'Inactivo', due_on: '2026-10-01' } }));
await apply(changed, 'batch2', '2026-09-14T13:00:00Z');
assert.equal(checks.length, 1, 'due date changes do not create a second cheque');
assert.equal(checks[0].status, 'deposited');
assert.equal(checks[0].bank_evidence_status, 'pending');
const count = writes.length;
await assert.rejects(apply(), /despu/);
assert.equal(writes.length, count, 'stale workbook makes no changes');
for (const status of ['collected', 'protested', 'voided']) {
  checks[0].status = status;
  checks[0].notes = 'Estado manual confirmado';
  checks[0].settlement_bank_account_id = 'other-bank';
  await apply(changed, 'batch3', '2026-09-14T14:00:00Z');
  assert.equal(checks[0].status, status);
  assert.equal(checks[0].notes, 'Estado manual confirmado');
  assert.equal(checks[0].settlement_bank_account_id, 'other-bank');
}
checks[0].bank_evidence_status = 'matched';
const beforeConflict = writes.length;
await assert.rejects(apply(changed.slice(0, 1), 'batch4', '2026-09-14T15:00:00Z'), /monto distinto/);
assert.equal(writes.length, beforeConflict);
await apply(changed, 'batch4', '2026-09-14T15:00:00Z');
assert.equal(checks[0].status, 'collected');
checks.push({ id: 'absent', check_number: '999', bank_name: 'BancoEstado', amount_clp: 80000, status: 'portfolio' });
await apply(changed, 'batch5', '2026-09-14T16:00:00Z');
assert.equal(checks.find(row => row.id === 'absent').status, 'portfolio');
const stranger = { ...report.rows[0].data, customer_tax_id: '772222222', customer_name: 'Otro titular' };
assert.equal(helpers.findExistingFactoCheck(checks, stranger), undefined);
const withoutTax = { ...report.rows[0].data, customer_tax_id: '', issuer_tax_id: 'issuer-company' };
assert.notEqual(helpers.physicalCheckBusinessKey(withoutTax), helpers.physicalCheckBusinessKey({ ...withoutTax, customer_name: 'Otro titular' }), 'issuer company does not identify the cheque holder');
assert.throws(() => helpers.findExistingFactoCheck([checks[0], { ...checks[0], id: 'ambiguous' }], changed[0].normalized_data), /misma identidad/);
const contradictory = rows.map((row, i) => ({ ...row, normalized_data: { ...row.normalized_data, check_number: 'new', due_on: i ? '2026-10-01' : '2026-09-30' } }));
await assert.rejects(apply(contradictory), /contradictorias/);

// Confirm blocks bad/incomplete batches before reaching consolidation; retries load all rows.
let batch = { id: 'batch', entity_id: 'entity', source_type: 'CHECKS', status: 'previewed', error_count: 1, row_count: 2 };
const confirmContext = { ...context, requiredUuid: x => x, selectRows: async () => [batch],
  selectAllRows: async (_, query) => { assert.match(query, /status=in\.\(new,imported,duplicate\)/); return rows.slice(0, 1); },
};
const { confirmFactoExcel } = functions(source, confirmContext, ['confirmFactoExcel']);
await assert.rejects(confirmFactoExcel({}, {}, 'request', { batchId: 'batch' }), /contiene errores/);
batch.error_count = 0;
await assert.rejects(confirmFactoExcel({}, {}, 'request', { batchId: 'batch' }), /todas las filas/);
assert.ok(writes.every(table => table === 'accounting_checks'), 'no bank movements, payments or journals are created');
let saved = { id: 'saved', status: 'previewed', row_count: 2, new_count: 2, duplicate_count: 0, error_count: 0, summary: { checks_total: 1 } };
const previewContext = { ...context, requiredUuid: x => x, requiredText: x => x,
  downloadStorage: async () => new Uint8Array(), sha256Bytes: async () => 'hash',
  parseFactoExcelWorkbook: async () => report, selectRows: async () => [saved], selectAllRows: async () => rows,
};
const { previewFactoExcel } = functions(source, previewContext, ['previewFactoExcel']);
const resumed = await previewFactoExcel({}, {}, { entityId: 'entity', storagePath: 'test', fileName: 'test.xlsx', profile: report.profile });
assert.equal(resumed.batch.id, 'saved', 'canceled previews can be reopened without duplicate batches');
assert.equal(resumed.rows.length, 2);
saved.status = 'imported';
await assert.rejects(previewFactoExcel({}, {}, { entityId: 'entity', storagePath: 'test', fileName: 'test.xlsx', profile: report.profile }), /ya fue cargado/);
const confirmWrites = [];
batch = { ...batch, status: 'previewed', created_at: '2026-09-14T17:00:00Z', summary: {}, error_count: 0 };
const completeContext = { ...confirmContext, requestIdToUuid: x => x, consolidateFactoCheckRows,
  readSourceDocumentSummaries: async () => [],
  selectAllRows: async (_, query) => {
    if (query.startsWith('accounting_import_rows?')) { assert.match(query, /status=in\.\(new,imported,duplicate\)/); return changed; }
    if (/^accounting_(source_documents|receivables|payables)\?/.test(query)) return [];
    throw Error(query);
  },
  patchRows: async (_, table, filter, values) => { confirmWrites.push(table); if (table === 'accounting_import_batches') Object.assign(batch, values); return []; },
  insertRows: async (_, table) => { confirmWrites.push(table); return []; },
  rpc: async (_, name) => { assert.equal(name, 'accounting_refresh_controls'); return {}; },
};
const completeHandler = functions(source, completeContext, ['confirmFactoExcel']);
for (let attempt = 0; attempt < 2; attempt += 1) {
  const result = await completeHandler.confirmFactoExcel({}, { id: 'user' }, 'request', { batchId: 'batch' });
  assert.equal(result.imported, 1);
  assert.equal(checks[0].amount_clp, 100000);
}
assert.ok(confirmWrites.every(table => ['accounting_import_batches', 'accounting_import_rows', 'accounting_audit_events'].includes(table)));
console.log('Cheques Facto: XLS/XLSX, hojas, validacion, actualizaciones, reintentos, titulares, conflictos y estados protegidos OK.');
