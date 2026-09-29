import test from "node:test";
import assert from "node:assert/strict";
import { customerProfitability } from "../supabase/functions/accounting-center/customer-profitability.ts";
import { canonicalCustomerProfitabilityMessage, customerProfitabilityTool } from "../supabase/functions/crm-copilot/customer-profitability.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { specialists } from "../supabase/functions/crm-copilot/agent-manager.ts";
import { todayChile } from "../supabase/functions/crm-copilot/dates.ts";
const accounts = [{ id: "cost", classification: "cost_of_sales" }, { id: "stock", classification: "inventory" }];
const doc = (id, net = 1000, taxId = "12345678-9", date = "2026-09-05") => ({ id, entity_id: "entity", external_id: id, source_type: "FACTO", folio: id, issued_on: date, document_type: "sales_invoice", currency: "CLP", net_amount: net, exempt_amount: 0, tax_amount: net * .19, total_clp: net * 1.19, data_quality: "validated", status: "validated", counterpart_tax_id: taxId, counterpart_name: `Cliente ${id}` });
const pair = (d, cost, date = d.issued_on, key = "cost") => [
  { account_id: "cost", debit_clp: Math.max(cost, 0), credit_clp: Math.max(-cost, 0) },
  { account_id: "stock", debit_clp: Math.max(-cost, 0), credit_clp: Math.max(cost, 0) },
].map((line, i) => ({ ...line, id: `${d.id}-${key}-${i}`, accounting_journal_entries: { id: `${d.id}-${key}`, source_document_id: d.id, status: "posted", entry_date: date } }));
const nc = (d, code = 1, net = d.net_amount) => ({ ...doc(`nc-${d.id}`, net, d.counterpart_tax_id, "2026-09-10"), document_type: "sales_credit_note", raw_payload: { references: [{ document_id: d.external_id, reference_number: d.folio, reference_date: d.issued_on, document_type_taxbureau: "33", reference_type: code }] } });
const report = (docs, lines, from = "2026-09-01", to = "2026-09-28") => customerProfitability(docs, lines, accounts, from, to);

test("Clasifica utilidad en pesos y margen sin confundirlos con facturacion", () => {
  const a = doc("a", 1000), b = doc("b", 500, "76543210-K");
  const r = report([a, b], [...pair(a, 600), ...pair(b, 100)]);
  assert.equal(r.topProfit[0].customer, "Cliente a");
  assert.equal(r.topMargin[0].customer, "Cliente b");
  assert.equal(r.topProfit[0].grossProfit, 400);
  assert.equal(r.topMargin[0].margin, 80);
  assert.equal(r.currency, "CLP");
});
test("Deduplica evidencia y agrupa por RUT normalizado, nunca por nombre", () => {
  const a = doc("a"), b = doc("b", 500, "12.345.678-9"), c = { ...doc("c", 100, "76543210-K"), counterpart_name: a.counterpart_name };
  const lines = [...pair(a, 600), ...pair(b, 200), ...pair(c, 20)];
  const r = report([a, b, c, a], [...lines, ...lines]);
  assert.equal(r.customers, 2);
  assert.equal(r.topProfit[0].sales, 1500);
  assert.equal(r.topProfit[0].cost, 800);
  assert.equal(r.topProfit[0].documents, 2);
});
test("Costo ausente, nulo, desbalanceado, borrador o tardio no equivale a cero", () => {
  const a = doc("a");
  for (const lines of [[], pair(a, 600).slice(0, 1), pair(a, 600).map(l => ({ ...l, debit_clp: null })), pair(a, 600, "2026-10-01"), pair(a, 600).map(l => ({ ...l, accounting_journal_entries: { ...l.accounting_journal_entries, status: "draft" } })), pair(a, 0)]) {
    const r = report([a], lines);
    assert.equal(r.rankedCustomers, 0);
    assert.equal(r.pending[0].grossProfit, null);
    assert.equal(r.pending[0].cost, null);
  }
});
test("Un cliente con cobertura parcial no encabeza ranking artificialmente", () => {
  const a = doc("a", 1000000), b = doc("b");
  const r = report([a, b], pair(b, 600));
  assert.equal(r.topProfit.length, 0);
  assert.equal(r.pending[0].coverage, 50);
  assert.equal(r.pending[0].knownCost, 600);
});
test("NC anulacion total revierte costo solo con evidencia; no duplica ni reemplaza factura", () => {
  const a = doc("a"), note = nc(a), b = doc("b", 500);
  const r = report([a, note, b], [...pair(a, 600), ...pair(note, -600), ...pair(b, 300)]);
  assert.equal(r.topProfit[0].sales, 500);
  assert.equal(r.topProfit[0].cost, 300);
  assert.equal(r.topProfit[0].grossProfit, 200);
  assert.equal(report([a, note], [...pair(a, 600), ...pair(note, -600)]).rankedCustomers, 0);
  assert.equal(report([a, note, b], [...pair(a, 600), ...pair(b, 300)]).pendingCreditNotes, 1);
});
test("NC parcial de otro periodo respeta costo real, no lo prorratea por ventas", () => {
  const a = doc("a", 1000, "12345678-9", "2026-08-10"), note = nc(a, 3, 200), b = doc("b", 500);
  const r = report([a, note, b], [...pair(a, 700), ...pair(note, -80), ...pair(b, 300)]);
  assert.equal(r.topProfit[0].sales, 300);
  assert.equal(r.topProfit[0].cost, 220);
  assert.equal(r.topProfit[0].grossProfit, 80);
  assert.equal(report([a, note, b], [...pair(a, 700), ...pair(note, -80, "2026-10-01"), ...pair(b, 300)]).pendingCreditNotes, 1);
});
test("Texto monetario, NC sin referencia o con reversa excesiva requiere revision", () => {
  const a = doc("a"), text = nc(a, 2);
  assert.equal(report([a, text], pair(a, 600)).pendingCreditNotes, 1);
  const note = nc(a, 3, 200), second = { ...note, id: "nc2" };
  assert.equal(report([a, note, second], [...pair(a, 600), ...pair(note, -400), ...pair(second, -400)]).pendingCreditNotes, 2);
});
test("Sin RUT no agrupa compradores anonimos ni publica margen confirmado", () => {
  const a = doc("a", 1000, ""), b = doc("b", 1000, "");
  const r = report([a, b], [...pair(a, 600), ...pair(b, 600)]);
  assert.equal(r.customers, 2); assert.equal(r.rankedCustomers, 0); assert.equal(r.pending[0].status, "unidentified");
});
test("Excluye guias, anulados y moneda sin conversion; no mezcla entidades", () => {
  const a = doc("a"), b = { ...doc("b"), entity_id: "other" };
  const bad = [{ ...doc("guide"), document_type: "sales_dispatch_guide" }, { ...doc("void"), status: "cancelled" }, { ...doc("usd"), currency: "USD" }];
  const r = report([a, b, ...bad], [...pair(a, 600), ...pair(b, 600)]);
  assert.equal(r.customers, 2); assert.equal(r.excludedDocuments, 3);
});
test("Conversion y perdidas usan montos finitos; limites y filtro RUT/nombre", () => {
  const a = { ...doc("a", 1), currency: "USD", exchange_rate: 950, counterpart_name: "Climatización Sur" };
  const r = report([a], pair(a, 1000));
  assert.equal(r.topProfit[0].sales, 950); assert.equal(r.topProfit[0].grossProfit, -50);
  assert.equal(customerProfitability([a], pair(a, 1000), accounts, "2026-09-01", "2026-09-28", "climatizacion").customers, 1);
  assert.equal(customerProfitability([a], pair(a, 1000), accounts, "2026-09-01", "2026-09-28", "123456789").customers, 1);
});
test("Herramienta reutiliza endpoint y resultado del dashboard, con tabla y pendientes", async () => {
  const a = doc("a"), data = report([a], pair(a, 600));
  const source = { api: async (service, route) => { assert.equal(service, "accounting-center"); assert.match(route, /customer-profitability\?from=2026-09-01&to=2026-09-28&limit=10&query=Cliente/); return data; } };
  const r = await customerProfitabilityTool(source, { period: "custom", from: "2026-09-01", to: "2026-09-28", query: "Cliente", sort_by: "margin" });
  assert.deepEqual(r.table.rows, data.topMargin);
  assert.deepEqual(r.data.ranking, data.topMargin);
  const partial = await customerProfitabilityTool({ api: async () => report([a], []) }, { period: "custom", from: "2026-09-01", to: "2026-09-28" });
  assert.equal(partial.status, "partial"); assert.match(partial.summary, /No tengo informacion suficiente/);
});
test("Finanzas es el especialista; vendedor y visualizador no acceden a costos", async () => {
  assert.ok(specialists.find(s => s.id === "finance").tools.includes("get_customer_profitability"));
  for (const role of ["vendedor", "visualizador"]) {
    const registry = new ToolRegistry({ actor: { role }, signal: new AbortController().signal, api: () => { throw Error("NO READ"); } });
    assert.ok(!registry.list().some(t => t.name === "get_customer_profitability"));
    assert.equal((await registry.execute("get_customer_profitability", {})).status, "forbidden");
  }
});

test("Top ventas selecciona antes de verificar costos: no sustituye el mayor comprador pendiente", () => {
  const docs = Array.from({ length: 12 }, (_, i) => doc(`top-${i}`, 12000 - i * 1000, `${12345670 + i}-9`));
  const r = report(docs, docs.slice(1).flatMap(d => pair(d, d.net_amount * .5)));
  assert.equal(r.topSales.length, 10);
  assert.equal(r.salesCustomers, 12);
  assert.equal(r.topSales[0].customer, "Cliente top-0");
  assert.equal(r.topSales[0].grossProfit, null);
  assert.equal(r.topSales[0].margin, null);
  assert.equal(r.topSales[0].status, "pending");
  assert.equal(r.topSales[9].customer, "Cliente top-9");
  assert.equal(r.topProfit[0].customer, "Cliente top-1");
});

test("Mayor venta, utilidad y margen son tres criterios distintos", () => {
  const a = doc("volumen", 10000), b = doc("utilidad", 5000, "76543210-K"), c = doc("margen", 1000, "11111111-1");
  const r = report([a, b, c], [...pair(a, 9900), ...pair(b, 1000), ...pair(c, 100)]);
  assert.equal(r.topSales[0].customer, "Cliente volumen");
  assert.equal(r.topProfit[0].customer, "Cliente utilidad");
  assert.equal(r.topMargin[0].customer, "Cliente margen");
});

test("Seleccion por ventas netas descuenta NC y respeta ano sin sumar ventas fuera del corte", () => {
  const a = doc("a", 10000), note = nc(a, 3, 8000), b = doc("b", 5000, "76543210-K");
  const old = doc("viejo", 999999, "99999999-9", "2025-12-31"), future = doc("futuro", 999999, "88888888-8", "2026-10-01");
  const r = report([a, note, b, old, future], [...pair(a, 6000), ...pair(note, -4800), ...pair(b, 4000), ...pair(old, 1), ...pair(future, 1)], "2026-01-01");
  assert.equal(r.topSales[0].customer, "Cliente b");
  assert.equal(r.topSales[1].sales, 2000);
  assert.equal(r.topSales[1].cost, 1200);
  assert.equal(r.salesCustomers, 2);
});

test("Cohorte de ventas excluye identidad ausente y ventas no positivas, mantiene perdidas verificadas", () => {
  const a = doc("a"), unknown = doc("sin-rut", 5000, ""), cancelled = doc("c", 500, "76543210-K"), note = nc(cancelled);
  const r = report([a, unknown, cancelled, note], [...pair(a, 1200), ...pair(unknown, 1000), ...pair(cancelled, 100), ...pair(note, -100)]);
  assert.equal(r.topSales.length, 1);
  assert.equal(r.topSales[0].grossProfit, -200);
});

test("Busqueda por alias incluye todos los documentos del RUT y su costo pendiente", () => {
  const a = { ...doc("a"), counterpart_name: "Climatización Sur" };
  const b = { ...doc("b", 2000, "12.345.678-9"), counterpart_name: "Sociedad Servicios Sur" };
  const c = { ...doc("c", 999999, "76543210-K"), counterpart_name: "Otro cliente" };
  const r = customerProfitability([a, b, c], [...pair(a, 600), ...pair(c, 10)], accounts, "2026-09-01", "2026-09-28", "climatizacion", 100);
  assert.equal(r.customers, 1);
  assert.equal(r.matches[0].sales, 3000);
  assert.equal(r.matches[0].documents, 2);
  assert.equal(r.matches[0].grossProfit, null);
  assert.equal(r.matches[0].knownCost, 600);
});

test("Busqueda incluye cualquier empresa fuera del top diez, RUT, anulacion neta y sin coincidencias", () => {
  const docs = Array.from({ length: 12 }, (_, i) => doc(`empresa-${i}`, 12000 - i * 1000, `${12345670 + i}-9`));
  const lines = docs.flatMap(d => pair(d, d.net_amount * .5));
  const r = customerProfitability(docs, lines, accounts, "2026-09-01", "2026-09-28", "empresa-11", 100);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].grossProfit, 500);
  const tax = customerProfitability(docs, lines, accounts, "2026-09-01", "2026-09-28", "12.345.681-9", 100);
  assert.equal(tax.matches[0].customer, "Cliente empresa-11");
  assert.equal(customerProfitability(docs, lines, accounts, "2026-09-01", "2026-09-28", "no-existe", 100).matches.length, 0);
  const d = docs[0], note = nc(d);
  const zero = customerProfitability([d, note], [...pair(d, 500), ...pair(note, -500)], accounts, "2026-09-01", "2026-09-28", d.counterpart_tax_id);
  assert.equal(zero.matches[0].status, "no_positive_sales");
  assert.equal(zero.matches[0].sales, 0);
  assert.equal(zero.matches[0].margin, null);
});

test("Herramienta top ventas anual conserva cohorte y declara totales incompletos", async () => {
  const a = doc("a", 10000), b = doc("b", 5000, "76543210-K");
  const data = report([a, b], pair(b, 2000));
  let route;
  const r = await customerProfitabilityTool({ api: async (_, path) => { route = path; return data; } }, { period: "this_year", sort_by: "sales", query: null, limit: 10 });
  const today = todayChile();
  const params = new URLSearchParams(route.split("?")[1]);
  assert.equal(params.get("from"), `${today.slice(0, 4)}-01-01`);
  assert.equal(params.get("to"), today);
  assert.equal(params.get("limit"), "10");
  assert.equal(params.has("query"), false);
  assert.equal(r.data.sortBy, "sales");
  assert.equal(r.data.ranking[0].customer, "Cliente a");
  assert.equal(r.table.rows[0].costStatus, "Costos/reversas pendientes");
  assert.equal(r.table.rows[0].salesRank, 1);
  assert.equal(r.status, "partial");
  assert.equal(r.coverage.totalMatched, 2);
  assert.equal(r.data.selection.sales, 15000);
  assert.equal(r.data.selection.pendingCostSales, 10000);
  assert.equal(r.data.selection.completeCostSales, 5000);
  assert.equal(r.data.selection.pendingCustomers, 1);
  assert.equal(r.data.selection.cost, null);
  assert.equal(r.data.selection.grossProfit, null);
  assert.equal(r.data.selection.margin, null);
  assert.match(r.summary, /No se sustituyeron/);
  assert.match(r.summary, /\$10\.000/);
  assert.equal(r.data.canonical_customer_profitability_summary, true);
  assert.match(r.warnings.join(" "), /no es un descuento autorizado/);
});

test("Margen total del grupo es ponderado por ventas, no promedio simple", async () => {
  const a = doc("a", 9000), b = doc("b", 1000, "76543210-K");
  const r = await customerProfitabilityTool({ api: async () => report([a, b], [...pair(a, 8100), ...pair(b, 100)]) }, { period: "custom", from: "2026-09-01", to: "2026-09-28", sort_by: "sales" });
  assert.equal(r.data.selection.cost, 8200);
  assert.equal(r.data.selection.grossProfit, 1800);
  assert.equal(r.data.selection.margin, 18);
  assert.equal(r.status, "ok");
});

test("Despliegue mixto no sustituye silenciosamente top ventas por otro ranking", async () => {
  await assert.rejects(customerProfitabilityTool({ api: async () => ({ topProfit: [], topMargin: [] }) }, { period: "this_year", sort_by: "sales" }), /no dispone del ranking por ventas/);
  const registry = new ToolRegistry({ actor: { role: "finanzas" }, signal: new AbortController().signal });
  const schema = registry.list().find(t => t.name === "get_customer_profitability").parameters;
  assert.match(JSON.stringify(schema.properties.sort_by), /sales/);
});

test("Resumen canonico no oculta otras fuentes, fallos ni consultas de otro tipo", async () => {
  const a = doc("a");
  const r = await customerProfitabilityTool({ api: async () => report([a], pair(a, 600)) }, { period: "custom", from: "2026-09-01", to: "2026-09-28", sort_by: "sales" });
  assert.equal(canonicalCustomerProfitabilityMessage([r]), r.summary);
  assert.equal(canonicalCustomerProfitabilityMessage([r, { toolName: "get_sales_summary", status: "unavailable" }]), null);
  assert.equal(canonicalCustomerProfitabilityMessage([{ ...r, status: "forbidden" }]), null);
  assert.equal(canonicalCustomerProfitabilityMessage([{ ...r, data: {} }]), null);
});
