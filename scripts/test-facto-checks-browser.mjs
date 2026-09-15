import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

// Exercise the actual UI components with a local, explicit fake API. No CRM session or writes.
const source = await readFile('src/modules/accounting/AccountingCenterPage.tsx', 'utf8');
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['ChecksView', 'AccountingImportStatus', 'FactoView', 'FactoExcelPreviewDialog', 'factoPreviewColumns', 'factoProfileLabel', 'Table', 'Status', 'Empty', 'SearchField', 'number', 'clp', 'date', 'dateTime', 'today', 'normalize', 'humanize', 'documentTypeLabel'];
const pieces = tree.statements.filter(node => names.includes(node.name?.text) || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'factoExcelProfiles')));
const code = ts.transpileModule(pieces.map(node => node.getText(tree)).join('\n'), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const sample = { customer_name: 'Cliente de prueba', issuer_bank: 'Santander', check_number: '000232', received_on: '2026-09-14', due_on: '2026-09-30', amount_clp: 100000, source_status: 'Activo', source_document_number: '1557' };
await mkdir('tmp', { recursive: true });
await writeFile('tmp/facto-checks-browser.jsx', `
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, Search, FileSpreadsheet, Download, AlertTriangle, ShieldCheck, X, ScanSearch, RefreshCw, Plus, FileCheck2 } from 'lucide-react';
import { reportPeriod } from '/src/modules/accounting/reportNavigation.ts';
import '/src/styles.css';
import '/src/modules/accounting/accountingCenter.css';
const useSearchParams = () => [new URLSearchParams()];
const data = { sources: [], profile: { permissions: ['import'] }, batches: [
 { id: 'pending', source_type: 'CHECKS', import_profile: 'facto_checks_banco_estado', file_name: 'cheques-actualizados.xlsx', status: 'previewed', created_at: '2026-09-15T10:00:00Z', summary: {} },
 { id: 'old', source_type: 'CHECKS', import_profile: 'facto_checks_banco_estado', file_name: 'cheques-anteriores.xlsx', status: 'imported', created_at: '2026-09-09T10:00:00Z', summary: { confirmed_at: '2026-09-09T10:01:00Z' } },
], entity: { id: 'test' }, receivables: [], payables: [], checks: [], bankAccounts: [] };
const sample = ${JSON.stringify(sample)};
let confirmations = 0;
const uploadAccountingEvidence = async () => 'test/cheques.xlsx';
const previewAccountingFactoExcel = async input => {
 if(input.profile !== 'facto_checks_banco_estado') throw Error('Perfil incorrecto');
 return { profile: input.profile, batch: { id: 'test', file_name: input.fileName },
 summary: { total: 2, new: 2, duplicates: 0, errors: 0, checks_new: 1, checks_update: 1, checks_total: 2, amount_clp: 200000 },
 warnings: ['Los cheques ausentes se conservan. La carga no confirma cobros bancarios.'],
 rows: [{ row_number: 2, fingerprint: 'test1', errors: [], data: sample }, { row_number: 3, fingerprint: 'test2', errors: [], data: { ...sample, check_number: '000234' } }] };
};
const getAccountingFactoExcelPreview = async () => previewAccountingFactoExcel({ profile: 'facto_checks_banco_estado', fileName: 'cheques-actualizados.xlsx' });
const confirmAccountingFactoExcel = async () => { confirmations += 1; data.batches[0].status = 'imported'; return { imported: 2 }; };
${code}
function App() {
 const [busy, setBusy] = useState(''); const [message, setMessage] = useState('');
 const runAction = async (key, action, success) => { setBusy(key); try { await action(); setMessage(success + ' Confirmaciones: ' + confirmations); return true; } finally { setBusy(''); } };
 return <main className="accounting-center-page" style={{ padding: 16, maxWidth: 1280, margin: 'auto' }}><h1>Cheques · prueba local</h1>{message && <p role="status">{message}</p>}<AccountingImportStatus data={data} activeView="checks" busy={busy} runAction={runAction} /><ChecksView data={data} busy={busy} runAction={runAction} /></main>;
}
createRoot(document.getElementById('root')).render(<App />);
`);
await writeFile('tmp/facto-checks-browser.html', '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cheques: prueba local</title><div id="root"></div><script type="module" src="/tmp/facto-checks-browser.jsx"></script></html>');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Nombre Titular', 'Banco', 'Numero Documento', 'Numero', 'Fecha', 'Fecha Cobro', 'Monto'], ['Cliente de prueba', 'Santander', '1557', '000232', '14-09-2026', '30-09-2026', 100000]]), 'Cheques');
const file = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${process.env.CHECKS_TEST_URL || 'http://127.0.0.1:5191'}/tmp/facto-checks-browser.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.getByText('Pendiente de aplicar', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Revisar y aplicar' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.getByRole('button', { name: 'Actualizar cheques desde Excel Facto' }).click();
    assert.equal(await page.getByRole('heading', { name: 'Cargar listado de cheques Facto' }).count(), 1);
    const preview = page.getByRole('button', { name: 'Previsualizar y validar' });
    assert.ok(await preview.isDisabled());
    await page.locator('input[type=file]').setInputFiles({ name: 'invalido.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
    await preview.click();
    await page.getByText('Selecciona un Excel XLS o XLSX válido de hasta 25 MB.').waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'cheques-actualizados.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: file });
    await preview.click();
    await page.getByRole('dialog').waitFor();
    await page.getByText('Cheques a actualizar', { exact: false }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page overflow');
    await page.screenshot({ path: `tmp/cheques-preview-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await preview.click();
    await page.getByRole('button', { name: 'Confirmar y actualizar cheques' }).click();
    await page.getByRole('status').filter({ hasText: 'Confirmaciones: 1' }).waitFor();
    assert.equal(await page.getByText('Pendiente de aplicar', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.screenshot({ path: `tmp/cheques-upload-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await browser.close(); }
console.log('Cheques UI: carga, validacion, vista previa, cancelacion y confirmacion simulada verificadas a 390/1440px.');
