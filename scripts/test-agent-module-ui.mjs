import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAccountingAgentReport } from '../supabase/functions/accounting-center/agent-report.ts';

const source = await readFile('src/modules/agents/AgentDashboardPage.tsx', 'utf8');
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find((node) => node.name?.text === 'AccountingAgentReport');
const code = ts.transpileModule(component.getText(tree), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const Link = ({ to, children }) => React.createElement('a', { href: to }, children);
const Report = new Function('React', 'Link', 'formatCurrency', `${code};return AccountingAgentReport;`)(React, Link, new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }));
const result = buildAccountingAgentReport('collections', {
  summary: { as_of: '2026-09-09', receivables: 11287934, receivables_overdue: 321885 },
  factoReceivables: { authoritative: true, portfolioComplete: true, asOf: '2026-09-07', details: [{ document_id: '1557', document_number: '1557', customer: 'Climatiza MYM SPA', tax_id: '77.956.938-1', observed_amount: 177811 }] },
}, '2026-09-09T14:30:00Z');
const tasks = [{ id: 'pending', status: 'pending' }, { id: 'done', status: 'completed', result }];
const html = renderToStaticMarkup(React.createElement(Report, { tasks }));
assert.match(html, /11\.287\.934/);
assert.match(html, /177\.811/);
assert.match(html, /Climatiza MYM SPA/);
assert.match(html, /2026-09-07/);
assert.match(html, /ultimo analisis completado/);
assert.match(html, /No disponible/);
assert.match(html, /href="\/finanzas-contabilidad\?view=receivables"/);
const empty = renderToStaticMarkup(React.createElement(Report, { tasks: [] }));
assert.match(empty, /Aun no hay un analisis completado/);
assert.doesNotMatch(empty, /\$0/);
await mkdir('tmp', { recursive: true });
await writeFile('tmp/agent-module-ui.html', `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analisis de agentes</title><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/modules/agents/moduleReport.css"><body><main style="padding:16px;max-width:1100px;margin:auto">${html}</main></body></html>`);
console.log('Informe de agente: montos, fechas, estado pendiente, documentos y enlaces verificados.');
