import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';

// Render the production components against a local fixture. No CRM API writes.
const source = await readFile('src/modules/accounting/AccountingCenterPage.tsx', 'utf8');
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['FactoView', 'PayablesView', 'FactoExcelPreviewDialog', 'factoProfileLabel', 'factoPreviewColumns',
  'Table', 'Empty', 'Status', 'SearchField', 'number', 'clp', 'date', 'dateTime', 'shortDate', 'normalize', 'humanize', 'agingLabel', 'agingBucket'];
const pieces = tree.statements.filter(n => names.includes(n.name?.text) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'factoExcelProfiles')));
const code = ts.transpileModule(pieces.map(n => n.getText(tree)).join('\n'), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const fixture = `
import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Upload,Search,FileSpreadsheet,Download,AlertTriangle,ShieldCheck,X,ScanSearch,RefreshCw} from 'lucide-react';
${code}
function today(){return '2026-09-09'}
const batch={id:'batch',file_name:'documentos-impagos.xlsx',created_at:'2026-09-09T13:13:00Z',source_type:'COLLECTIONS',import_profile:'facto_unpaid_documents',status:'imported',new_count:2,duplicate_count:0,error_count:0,storage_path:'private/fixture.xlsx',summary:{coverage_to:'2026-09-09',payables_documents:2,payables_total_clp:250000}};
const base={issued_on:'2026-08-10',due_on:'2026-09-20',original_amount_clp:238000,paid_amount_clp:12000,balance_clp:226000,reported_paid_amount_clp:38000,reported_balance_clp:200000,reported_at:batch.created_at,reported_source_batch_id:'batch',status:'partial'};
const initial={sources:[],entity:{id:'fixture'},summary:{as_of:'2026-09-09'},batches:[batch],payables:[
  {...base,id:'one',document_number:'1702',supplier_name:'Proveedor Internacional de Equipamiento SPA',supplier_tax_id:'77.222.222-2'},
  {...base,id:'two',document_number:'1798',supplier_name:'Proveedor Dos',supplier_tax_id:'77.333.333-3',reported_balance_clp:50000,reported_paid_amount_clp:0,status:'pending'}
]};
const preview={profile:'facto_unpaid_documents',batch:{...batch,status:'previewed'},summary:{total:2,new:2,errors:0,duplicates:0,receivables_documents:1,receivables_total_clp:100000,payables_documents:1,payables_total_clp:200000,receivables_complete:true,payables_complete:true},warnings:[],rows:[
 {row_number:2,fingerprint:'sale',errors:[],data:{balance_kind:'receivable',document_type_label:'Factura emitida',document_number:'1557',issued_on:'2026-09-09',counterpart_name:'Cliente Uno',counterpart_tax_id:'771111111',total_clp:119000,reported_paid_clp:19000,reported_balance_clp:100000}},
 {row_number:3,fingerprint:'purchase',errors:[],data:{balance_kind:'payable',document_type_label:'Factura recibida',document_number:'1702',issued_on:'2026-08-10',counterpart_name:'Proveedor Uno',counterpart_tax_id:'772222222',total_clp:238000,reported_paid_clp:38000,reported_balance_clp:200000}}
]};
async function uploadAccountingEvidence(){return 'private/fixture.xlsx'}
async function previewAccountingFactoExcel(input){window.previewPayload=input;return preview}
async function confirmAccountingFactoExcel(){window.confirmed=true}
async function downloadAccountingEvidence(){window.downloaded=true}
function App(){const [data,setData]=useState(initial); async function runAction(key,action){await action();if(key==='confirm-facto-excel')setData({...initial,batches:[{...batch,summary:{...batch.summary,payables_total_clp:200000}}],payables:[initial.payables[0],{...initial.payables[1],reported_balance_clp:0,reported_paid_amount_clp:238000,status:'paid'}]});return true}return React.createElement(PayablesView,{data,busy:'',runAction})}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;
await mkdir('tmp/facto-payables-qa', { recursive: true });
await writeFile('tmp/facto-payables-qa/fixture.js', fixture);
await writeFile('tmp/facto-payables-qa/index.html', '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prueba local de cuentas por pagar</title><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/modules/accounting/accountingCenter.css"><body><main id="root" class="accounting-center-page" style="padding:16px;max-width:1200px;margin:auto"></main><script type="module" src="./fixture.js"></script></body></html>');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const width of [1440, 768, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5183/tmp/facto-payables-qa/index.html');
    await page.getByRole('heading', { name: 'Cuentas por pagar', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByPlaceholder('Proveedor, RUT o documento').fill('1798');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByPlaceholder('Proveedor, RUT o documento').fill('');
    await page.getByRole('combobox', { name: /^Estado/ }).selectOption('partial');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('combobox', { name: /^Estado/ }).selectOption('open');
    await page.screenshot({ path: `tmp/facto-payables-qa/${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Actualizar por cobrar y por pagar desde Excel Facto' }).click();
    const validate = page.getByRole('button', { name: 'Previsualizar y validar' });
    assert.equal(await validate.isDisabled(), true);
    await page.locator('input[type=file]').setInputFiles({ name: 'test.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('fixture') });
    await page.getByRole('checkbox').check();
    await validate.click();
    await page.getByRole('dialog', { name: 'Revisar Excel Facto' }).waitFor();
    assert.equal(await page.evaluate(() => window.previewPayload.completeReport), true);
    assert.equal(await page.getByRole('dialog').getByText('Por pagar', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('dialog').getByText('Por cobrar', { exact: true }).count(), 1);
    await page.screenshot({ path: `tmp/facto-payables-qa/${width}-preview.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Confirmar 2 registros', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.confirmed), true);
    await page.getByRole('button', { name: 'Cerrar carga de Excel', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('combobox', { name: /^Estado/ }).selectOption('paid');
    await page.getByText('Pagada en Facto', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'documentos-impagos.xlsx' }).click();
    assert.equal(await page.evaluate(() => window.downloaded), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Por pagar: 1440/768/390/360px, filtros, carga, detalle de destinos, confirmacion y respaldo verificados.');
} finally { await browser.close(); }
