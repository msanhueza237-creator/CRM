import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "lucide-react";

const source = await readFile("src/modules/accounting/AccountingCenterPage.tsx", "utf8");
const tree = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["FactoView", "ReceivablesView", "FactoExcelPreviewDialog"];
const pieces = tree.statements.filter((node) => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(tree) === "factoExcelProfiles")));
const code = ts.transpileModule(pieces.map((node) => node.getText(tree)).join("\n"), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const label = (value) => value || "Sin fecha";
const context = {
  React, ...Object.fromEntries(["Upload", "Search", "FileSpreadsheet", "Download", "AlertTriangle", "ShieldCheck", "X", "ScanSearch", "RefreshCw"].map((name) => [name, icons[name]])), useState: React.useState, useEffect: React.useEffect,
  today: () => "2026-09-09", normalize: (text) => String(text).toLowerCase(),
  number: (value) => Number(value || 0), clp: (value) => `$${Number(value).toLocaleString("es-CL")}`,
  date: label, shortDate: label, dateTime: label, factoProfileLabel: label, humanize: label,
  Empty: ({ text }) => React.createElement("p", null, text),
  Status: ({ value }) => React.createElement("span", null, value),
  SearchField: () => React.createElement("input", { placeholder: "Cliente, RUT o documento" }),
  Table: ({ children }) => React.createElement("table", null, React.createElement("tbody", null, children)),
  factoPreviewColumns: () => ({ headers: [], values: () => [] }),
};
const components = new Function(...Object.keys(context), `${code};return {${names.join(",")}};`)(...Object.values(context));
const data = { sources: [], batches: [], entity: { id: "test" }, receivables: [], summary: { as_of: "2026-09-09" } };
const props = { data, busy: "", runAction: async () => true };
const upload = renderToStaticMarkup(React.createElement(components.FactoView, { ...props, excelOnly: true }));
assert.match(upload, /Cargar Excel de Facto/);
assert.match(upload, /Emisión desde/);
assert.match(upload, /Emisión hasta/);
assert.match(upload, /todos los documentos impagos/);
assert.match(upload, /Archivos complementarios/);
assert.doesNotMatch(upload, /Preparar previsualización|Actualizar ahora|Documentos financieros/);
assert.match(upload, /disabled=""[^>]*>.*Previsualizar y validar/s);
const receivables = renderToStaticMarkup(React.createElement(components.ReceivablesView, props));
assert.match(receivables, /Actualizar cartera desde Excel Facto/);
assert.match(receivables, /aria-controls="receivables-excel"/);
const preview = { profile: "facto_unpaid_documents", batch: { id: "test", file_name: "test.xlsx" }, warnings: [], rows: [], summary: { total: 2, new: 1, duplicates: 0, errors: 1, receivables_total_clp: 150000, payables_total_clp: 30000 } };
const review = renderToStaticMarkup(React.createElement(components.FactoExcelPreviewDialog, { preview, busy: "", close() {}, runAction: props.runAction }));
assert.match(review, /\$150.000/);
assert.match(review, /\$30.000/);
assert.match(review, /disabled=""[^>]*>Confirmar 1 registros/);
await mkdir("tmp", { recursive: true });
await writeFile("tmp/facto-excel-ui.html", `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prueba de carga Facto</title><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/modules/accounting/accountingCenter.css"><body><main class="accounting-center-page" style="padding:16px;max-width:1200px;margin:auto">${upload}</main></body></html>`);
console.log("Excel Facto: acceso, formulario, límites de vista, totales y bloqueo de errores verificados.");
