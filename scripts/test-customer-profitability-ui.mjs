import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = await readFile(new URL("../src/modules/dashboard/CustomerProfitability.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const exports = {};
new Function("require", "exports", "React", code)(createRequire(import.meta.url), exports, React);
const loaderSource = await readFile(new URL("../src/modules/dashboard/CustomerProfitabilityOverview.tsx", import.meta.url), "utf8");
const loaderCode = ts.transpileModule(loaderSource, { compilerOptions: {
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
function loaderState(props, page, query = "") {
  const states = [query, "all", 0, page, undefined];
  let dependencies;
  const hooks = { useState: () => [states.shift(), () => {}], useEffect: (_callback, deps) => { dependencies = deps; } };
  const module = {};
  const require = name => name === "react" ? hooks : name.endsWith("CustomerProfitability") ? exports : { getCustomerProfitability() {} };
  new Function("require", "exports", "React", loaderCode)(require, module, React);
  module.CustomerProfitabilityOverview(props);
  return { offset: dependencies[4], requestKey: dependencies[5] };
}
const row = (i) => ({ customerKey: String(i), customer: `Cliente ${i}`, taxId: "12345678-9", sales: 10000 - i,
  knownCost: 600, knownSales: 10000 - i, knownDocuments: 1, cost: 600, grossProfit: 9400 - i, margin: 94,
  analysis: { status: "verified", sales: 10000 - i, cost: 600, grossProfit: 9400 - i, margin: 94 },
  documents: 1, missingCostDocuments: 0, pendingCreditNotes: 0, coverage: 100, status: "complete" });
const data = { from: "2026-01-01", to: "2026-09-30", customers: 21, offset: 0, limit: 20,
  salesCustomers: 21, rankedCustomers: 21, pendingCustomers: 0, excludedDocuments: 0,
  topSales: Array.from({ length: 20 }, (_, i) => row(i + 1)), topProfit: [row(100)], topMargin: [row(200)],
  matches: Array.from({ length: 20 }, (_, i) => row(i + 1)), pending: [], warnings: [] };
const render = (report = data, query = "", loading = false) => renderToStaticMarkup(React.createElement(exports.CustomerProfitability, {
  report, query, loading, periodLabel: "2026 acumulado", onQueryChange() {}, onPageChange() {},
}));

test("Dashboard abre con exactamente diez mayores compradores, no mayor utilidad", () => {
  const html = render();
  assert.match(html, /Top 10 clientes por ventas/);
  assert.match(html, /Cliente 10</); assert.doesNotMatch(html, /Cliente 11<|Cliente 100<|Cliente 200</);
  assert.equal((html.match(/scope="row"/g) || []).length, 10);
  assert.match(html, /Todos los clientes/);
});

test("Busqueda usa pagina de todos los clientes, con controles accesibles", () => {
  const html = render({ ...data, offset: 20, matches: [row(21)] }, "Cliente");
  assert.match(html, /Rentabilidad de todos los clientes/);
  assert.match(html, /21–21 de 21 clientes/); assert.match(html, /Página 2 de 2/);
  assert.match(html, /aria-label="Clientes anteriores"/);
  assert.match(html, /disabled=""[^>]*aria-label="Clientes siguientes"/);
  assert.doesNotMatch(html, /Ordenar rentabilidad/);
});

test("No oculta analisis provisional, pero nunca lo muestra como verificado", () => {
  const r = { ...row(1), status: "pending", cost: null, grossProfit: null, margin: null, pendingCreditNotes: 1,
    analysis: { status: "provisional", sales: 800, cost: 600, grossProfit: 200, margin: 25 } };
  const html = render({ ...data, matches: [r] }, "Cliente");
  assert.match(html, /Utilidad provisional/); assert.match(html, /Margen provisional/);
  assert.match(html, /\$200/); assert.match(html, /25%/); assert.doesNotMatch(html, /Verificado/);
});

test("Analisis parcial muestra base conocida; sin evidencia no inventa importes", () => {
  const partial = { ...row(1), status: "pending", cost: null, grossProfit: null, margin: null, missingCostDocuments: 1,
    analysis: { status: "partial", sales: 1000, cost: 600, grossProfit: 400, margin: 40 } };
  const unknown = { ...partial, customerKey: "unknown", analysis: { status: "unavailable", sales: null, cost: null, grossProfit: null, margin: null } };
  const html = render({ ...data, matches: [partial, unknown] }, "Cliente");
  assert.match(html, /Base parcial: \$1.000/); assert.match(html, /Utilidad parcial/);
  assert.match(html, /Sin evidencia suficiente/); assert.match(html, /Pendiente/);
});

test("Carga y busqueda vacia conservan mensajes explicitos", () => {
  assert.match(render(null, "", true), /aria-busy="true"/);
  assert.match(render(null, "", true), /Calculando rentabilidad/);
  assert.match(render({ ...data, matches: [], customers: 0 }, "Inexistente"), /No se encontraron documentos de venta/);
});

test("Actualizacion automatica mantiene pagina, pero periodo o busqueda nuevos la reinician", () => {
  const props = { from: "2026-01-01", to: "2026-09-30", refreshedAt: "first", periodLabel: "2026" };
  const page = { scope: JSON.stringify([props.from, props.to, "", "all"]), offset: 20 };
  const first = loaderState(props, page);
  const refreshed = loaderState({ ...props, refreshedAt: "second" }, page);
  assert.equal(first.offset, 20); assert.equal(refreshed.offset, 20);
  assert.notEqual(first.requestKey, refreshed.requestKey);
  assert.equal(loaderState({ ...props, from: "2026-09-01" }, page).offset, 0);
  assert.equal(loaderState(props, page, "MARBA").offset, 0);
});
