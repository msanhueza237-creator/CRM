import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as XLSX from 'xlsx';
import { bankMoney, bankIsoDate } from '../supabase/functions/accounting-center/bank-normalizers.ts';

function loadFunctions(source, context, names) {
  const tree = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const pieces = tree.statements.filter(n => ts.isFunctionDeclaration(n) && (!names || names.includes(n.name?.text)));
  const code = ts.transpileModule(pieces.map(n => n.getText(tree).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const exports = names || pieces.map(n => n.name.text);
  return new Function(...Object.keys(context), `${code};return {${exports.join(',')}}`)(...Object.values(context));
}
const parser = loadFunctions(await readFile('supabase/functions/accounting-center/facto-excel-parsers.ts', 'utf8'), { XLSX, money: bankMoney, isoDate: bankIsoDate });
const header = ['Tipo Documento', 'Fecha', 'Numero', 'Emisor / Receptor', 'Rut', 'Total', 'Pagado', 'Impago'];
const sale = ['Factura electronica emitida', '09-09-2026', '1557', 'Cliente Uno', '77.111.111-1', 119000, 19000, 100000];
const purchase = ['Factura electronica recibida', '08-09-2026', '1557', 'Proveedor Uno', '77.222.222-2', 238000, 38000, 200000];
function workbook(sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
}
const mixed = await parser.parseFactoExcelWorkbook(workbook({ Resumen: [['Reporte Facto']], Clientes: [header, sale], Proveedores: [header, purchase] }));
assert.equal(mixed.rows.length, 2);
assert.equal(mixed.rows[1].data.source_sheet, 'Proveedores');
assert.equal(mixed.rows[1].data.source_row, 2);
assert.equal(new Set(mixed.rows.map(r => r.row_number)).size, 2);
assert.equal(mixed.summary.receivables_total_clp, 100000);
assert.equal(mixed.summary.payables_total_clp, 200000);
assert.equal(mixed.rows.flatMap(r => r.errors).length, 0);
const credit = ['Nota de credito electronica recibida', '08-09-2026', '123', 'Proveedor Uno', '77.222.222-2', 19000, 0, 19000];
const repeated = await parser.parseFactoExcelWorkbook(workbook({ Datos: [header, sale, header, purchase, credit] }));
assert.equal(repeated.summary.payables_documents, 1);
assert.equal(repeated.summary.adjustment_documents, 1);
assert.equal(repeated.rows.flatMap(r => r.errors).length, 0);
const duplicate = await parser.parseFactoExcelWorkbook(workbook({ Una: [header, purchase], Otra: [header, purchase] }));
assert.match(duplicate.rows[1].errors.join(' '), /repetido/);
const missing = [...purchase]; missing[7] = '';
const invalid = await parser.parseFactoExcelWorkbook(workbook({ Datos: [header, missing] }));
assert.match(invalid.rows[0].errors.join(' '), /Monto faltante/);
const formatted = [...purchase]; formatted.splice(5, 3, '$1.200.000', '200.000', '1.000.000');
const localized = await parser.parseFactoExcelWorkbook(workbook({ Datos: [header, formatted] }));
assert.equal(localized.summary.payables_total_clp, 1000000);
assert.deepEqual(localized.rows[0].errors, []);
const dated = [...purchase]; dated[1] = new Date('2026-09-09T00:00:00Z');
const dateWorkbook = await parser.parseFactoExcelWorkbook(workbook({ Datos: [header, dated] }));
assert.equal(dateWorkbook.rows[0].data.issued_on, '2026-09-09');
assert.deepEqual(dateWorkbook.rows[0].errors, []);
await assert.rejects(parser.parseFactoExcelWorkbook(workbook({ Una: [header, sale], Malformada: [purchase] })), /sin un encabezado/);

const edgeSource = await readFile('supabase/functions/accounting-center/index.ts', 'utf8');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const helpers = loadFunctions(edgeSource, { HttpError }, ['findFactoSourceDocument', 'normalizeDocumentNumber', 'normalizeTaxForMatch', 'normalizeText']);
const documents = [
  { id: 'sale', folio: '1557', document_type: 'sales_invoice', counterpart_tax_id: '771111111', counterpart_name: 'Cliente Uno' },
  { id: 'purchase', folio: '1557', document_type: 'purchase_invoice', counterpart_tax_id: '772222222', counterpart_name: 'Proveedor Uno' },
  { id: 'other', folio: '1557', document_type: 'purchase_invoice', counterpart_tax_id: '773333333', counterpart_name: 'Proveedor Dos' },
];
assert.equal(helpers.findFactoSourceDocument(documents, mixed.rows[1].data).id, 'purchase');
assert.equal(helpers.findFactoSourceDocument(documents, { ...mixed.rows[1].data, counterpart_tax_id: '774444444' }), null);
assert.equal(helpers.findFactoSourceDocument(documents.slice(0, 1), mixed.rows[1].data), null);
assert.throws(() => helpers.findFactoSourceDocument([...documents, { ...documents[1], id: 'ambiguous' }], mixed.rows[1].data), /más de un documento/);
const foreignSource = { id: 'foreign', folio: '3', document_type: 'purchase_invoice', counterpart_name: 'Proveedor Exterior Ltd' };
assert.equal(helpers.findFactoSourceDocument([foreignSource], { direction: 'purchase', document_type: 'purchase_document', document_type_label: 'Invoice extranjera', document_number: '3', counterpart_name: 'Proveedor Exterior Ltd' }).id, 'foreign');

const createdSources = new Map();
const createdTargets = new Map();
const createHelpers = loadFunctions(edgeSource, { ...helpers, numeric: x => Number(x || 0),
  sha256Text: async text => text,
  upsertRowsSelected: async (_, table, rows) => {
    const map = table === 'accounting_source_documents' ? createdSources : createdTargets;
    return rows.map(row => {
      const key = row.source_key || row.source_document_id;
      const saved = { ...row, id: map.get(key)?.id || `${table}-${map.size}` };
      map.set(key, saved); return saved;
    });
  },
}, ['ensureFactoWorkbookDocument']);
const created = await createHelpers.ensureFactoWorkbookDocument({}, 'entity', { id: 'batch' }, { id: 'row1' }, mixed.rows[1].data);
await createHelpers.ensureFactoWorkbookDocument({}, 'entity', { id: 'batch2' }, { id: 'row2' }, { ...mixed.rows[1].data, reported_paid_clp: 100000 });
assert.equal(createdSources.size, 1);
assert.equal(createdTargets.size, 1);
assert.equal(created.target.paid_amount_clp, 0);
const existing = await createHelpers.ensureFactoWorkbookDocument({}, 'entity', { id: 'batch' }, { id: 'row3' }, mixed.rows[1].data, { ...documents[1], id: 'existing-source' });
assert.equal(existing.target.source_document_id, 'existing-source');
assert.equal(createdSources.size, 1);

// Exercise the real confirm handler with an in-memory REST boundary, never production.
const batch = { id: 'batch', entity_id: 'entity', source_type: 'COLLECTIONS', import_profile: 'facto_unpaid_documents', row_count: 2, error_count: 0,
  status: 'previewed', summary: { portfolio_complete: true, receivables_complete: true, payables_complete: true, coverage_to: '2026-09-09', receivables_documents: 1, payables_documents: 1, receivables_total_clp: 100000, payables_total_clp: 200000 } };
const importRows = mixed.rows.map((r, i) => ({ id: `row${i}`, normalized_data: { ...r.data }, status: 'imported' }));
const ar = [{ id: 'ar', source_document_id: 'sale', original_amount_clp: 119000, paid_amount_clp: 0, balance_clp: 119000 }];
const ap = [{ id: 'ap', source_document_id: 'purchase', original_amount_clp: 238000, paid_amount_clp: 12000, balance_clp: 226000 }];
const writes = [];
const patches = [];
const context = {
  HttpError, ...helpers,
  requiredUuid: x => x, asObject: x => x || {}, numeric: x => Number(x || 0), requestIdToUuid: x => x,
  selectRows: async () => [batch],
  selectAllRows: async (_, query) => {
    if (query.startsWith('accounting_import_rows?')) { assert.match(query, /in\.\(new,imported\)/); return importRows; }
    if (query.startsWith('accounting_source_documents?')) return documents;
    if (query.startsWith('accounting_receivables?')) return ar;
    if (query.startsWith('accounting_payables?')) return ap;
    throw new Error(query);
  },
  patchRows: async (_, table, filter, values) => {
    patches.push(table);
    const rows = table === 'accounting_receivables' ? ar : table === 'accounting_payables' ? ap : [];
    rows.forEach(row => Object.assign(row, values));
    return rows;
  },
  insertRows: async (_, table) => { writes.push(table); return []; },
  rpc: async (_, name, payload) => {
    writes.push(name);
    if (name === 'accounting_apply_facto_outstanding_snapshot') {
      assert.deepEqual(payload.p_receivable_ids, ['ar']);
      assert.deepEqual(payload.p_payable_ids, ['ap']);
    }
    return {};
  },
  publishFactoExcelReceivablesSnapshot: async () => ({ published: true }),
};
const handler = loadFunctions(edgeSource, context, ['confirmFactoExcel', 'factoOpenBalanceKind']);
const result = await handler.confirmFactoExcel({}, { id: 'admin' }, 'request', { batchId: batch.id });
assert.equal(result.portfolioSnapshot.payables_total_clp, 200000);
assert.equal(ap[0].reported_balance_clp, 200000);
assert.equal(ap[0].reported_paid_amount_clp, 38000);
assert.equal(ap[0].paid_amount_clp, 12000);
assert.equal(ap[0].balance_clp, 226000);
assert.equal(ar[0].reported_balance_clp, 100000);
await handler.confirmFactoExcel({}, { id: 'admin' }, 'retry', { batchId: batch.id });
assert.equal(ap.length, 1);
assert.equal(ap[0].paid_amount_clp, 12000);
assert.ok(!writes.some(w => /journal|bank|payment/.test(w)));
const before = patches.length;
batch.error_count = 1;
await assert.rejects(handler.confirmFactoExcel({}, { id: 'admin' }, 'invalid', { batchId: batch.id }), /contiene errores/);
assert.equal(patches.length, before);

if (process.argv[2]) {
  const actual = await parser.parseFactoExcelWorkbook(await readFile(process.argv[2]));
  assert.deepEqual(actual.rows.flatMap(r => r.errors), []);
  console.log('Excel local (solo lectura):', JSON.stringify(actual.summary));
}
console.log('Facto Excel: varias hojas, abonos, notas de credito, duplicados, RUT, confirmacion y reintento sin alterar bancos verificados.');
