import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerJourneyTool, orderIdentity, orderEvent, safeReference } from "../supabase/functions/crm-copilot/customer-journey.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { specialists } from "../supabase/functions/crm-copilot/agent-manager.ts";
import { centralHandler } from "../supabase/functions/crm-copilot/central.ts";

const id = "11111111-1111-4111-8111-111111111111";
const company = { id, name: "Empresa de prueba", rut: "76.919.986-1", email: "compras@example.test", next_follow_up: "2026-10-15" };
const order = { customer: { identification: "769199861", email: company.email }, created_at: "2026-10-02T13:00:00Z", number: 12, total: "1190", currency: "CLP", status: "open", payment_status: "pending", shipping_status: "unpacked" };
const record = { external_id: "12", updated_at: "2026-10-05T10:00:00Z", payload: order };
const invoice = { id: "inv", entity_id: "entity", source_type: "FACTO", document_type: "sales_invoice", counterpart_tax_id: "76919986-1", folio: "123", issued_on: "2026-10-02", net_amount: 1000, currency: "CLP", status: "validated", data_quality: "validated" };
const quote = { id: "quote", type: "cotizacion", occurred_at: "2026-10-01T12:00:00-03:00", description: "Cotizacion Facto 200 · Difusores", related_url: "https://facto.cl/referencia", next_action: "Confirmar recepcion", result: "Registrada manualmente" };
function source({ role = "administrador", companies = [company], orders = [record], documents = [invoice], interactions = [quote], failed = "", tasks = [] } = {}) {
  const calls = [];
  return { calls, actor: { role, id }, entity: async () => "entity",
    select: async path => { calls.push(path); return [company]; },
    all: async path => { calls.push(path); if (failed && path.startsWith(failed)) throw new Error("failure");
      if (path.startsWith("companies?")) return companies;
      if (path.startsWith("interactions?")) return interactions;
      if (path.startsWith("tasks?")) return tasks;
      if (path.startsWith("accounting_source_documents?")) return documents;
      return []; },
    records: async (resource, provider) => { calls.push([resource, provider]); if (failed === "orders") throw new Error("failure"); return orders; },
    request: () => assert.fail("No writes or external requests allowed"),
  };
}
const args = { company_id: id, period: "custom", from: "2026-01-01", to: "2026-10-05" };
test("Identidad exacta por RUT normalizado; nunca por nombre o telefono", () => {
  assert.equal(orderIdentity(order, company, [company]), "RUT exacto");
  assert.equal(orderIdentity({ customer: { name: company.name, phone: "12345678" } }, company, [company]), null);
  assert.equal(orderIdentity(order, company, [company, { ...company, id: "other" }]), null);
});
test("Correo unico solo sin RUT; otro RUT o correos compartidos bloquean union", () => {
  const byEmail = { customer: { email: "COMPRAS@example.test" } };
  assert.match(orderIdentity(byEmail, company, [company]), /Correo unico/);
  assert.equal(orderIdentity(byEmail, company, [company, { id: "other", email: company.email }]), null);
  assert.equal(orderIdentity({ ...order, customer: { email: company.email, identification: "76111111-1" } }, company, [company]), null);
  assert.equal(orderIdentity({ ...order, billing_address: { identification: "76111111-1" } }, company, [company]), null);
  assert.equal(orderIdentity({ customer: { identification: "desconocido", email: company.email } }, company, [company]), null);
});
test("Pedido: monto/currency ausente siguen desconocidos, no cero ni CLP supuesto", () => {
  const e = orderEvent({ ...record, payload: { ...order, total: null, currency: null } }, "RUT exacto");
  assert.equal(e.amount, null); assert.equal(e.currency, null);
  assert.match(e.detail, /pending/); assert.equal(e.status, "open"); assert.equal(e.href, null);
  assert.equal(orderEvent({ ...record, payload: { ...order, total: "1.200.300" } }, "RUT exacto").amount, null);
});
test("Unifica evidencia sin sumar pedidos y facturas ni inventar conversion o envios", async () => {
  const s = source(), result = await customerJourneyTool(s, args);
  assert.equal(result.data.events.length, 3); assert.equal(result.data.sources.orders.count, 1);
  assert.equal(result.data.sources.documents.count, 1); assert.equal(result.data.sources.quotes.count, 1);
  assert.equal(result.data.sources.activity.count, 0); assert.equal(result.data.ownerAgent, "commercial");
  assert.equal(result.data.totalSales, undefined); assert.match(result.warnings.join(" "), /no se suman/);
  assert.match(result.data.events.find(e => e.section === "quotes").status, /manual/);
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === "orders" && c[1] === "tiendanube"));
});
test("Documentos de otra entidad, guia, compra, fuente distinta y RUT ajeno no se atribuyen", async () => {
  const result = await customerJourneyTool(source({ documents: [invoice,
    { ...invoice, id: "guide", document_type: "sales_dispatch_guide" }, { ...invoice, id: "foreign", entity_id: "other" },
    { ...invoice, id: "purchase", document_type: "purchase_invoice" }, { ...invoice, id: "manual", source_type: "MANUAL" },
    { ...invoice, id: "other", counterpart_tax_id: "76111111-1" }] }), args);
  assert.equal(result.data.sources.documents.count, 1);
});
test("Nota de credito y anulados conservan naturaleza; no se convierten en venta positiva", async () => {
  const result = await customerJourneyTool(source({ documents: [{ ...invoice, document_type: "sales_credit_note", status: "voided" }] }), args);
  const nc = result.data.events.find(e => e.section === "documents");
  assert.match(nc.title, /Nota de credito/); assert.match(nc.amountBasis, /no es venta positiva/); assert.equal(nc.status, "voided");
});
test("Fuente fallida es desconocida; otras fuentes siguen utilizables", async () => {
  const result = await customerJourneyTool(source({ failed: "orders" }), args);
  assert.equal(result.status, "partial"); assert.equal(result.data.sources.orders.count, null);
  assert.equal(result.data.sources.orders.state, "unavailable"); assert.equal(result.data.sources.documents.count, 1);
});
test("RUT ambiguo no revela facturas; actividad propia se conserva", async () => {
  const result = await customerJourneyTool(source({ companies: [company, { ...company, id: "other" }] }), args);
  assert.equal(result.data.sources.documents.state, "needs_review"); assert.equal(result.data.sources.orders.count, 0);
  assert.equal(result.data.sources.quotes.count, 1);
});
test("Vendedor y visualizador no consultan tablas financieras ni pedidos", async () => {
  for (const role of ["vendedor", "visualizador"]) {
    const s = source({ role }), result = await new ToolRegistry(s).execute("get_customer_journey", args);
    assert.equal(result.data.sources.orders.state, "forbidden"); assert.equal(result.data.sources.documents.state, "forbidden");
    assert.ok(s.calls.every(c => typeof c === "string" && !c.startsWith("accounting_source_documents?")));
    assert.equal(result.data.events.length, 1);
  }
});
test("Busqueda, periodo y paginacion se aplican antes de retornar; tareas futuras no desaparecen", async () => {
  const interactions = Array.from({ length: 26 }, (_, i) => ({ ...quote, id: `q${i}`, description: `Cotizacion Facto ${i}`, occurred_at: `2026-10-${String(i % 5 + 1).padStart(2, "0")}T12:00:00Z` }));
  const s = source({ interactions, tasks: [{ id: "task", title: "Revisar presupuesto", due_date: "2026-11-01" }] });
  const one = await new ToolRegistry(s).execute("get_customer_journey", { ...args, section: "quotes", limit: 20 });
  assert.equal(one.coverage.totalMatched, 26); assert.equal(one.coverage.nextOffset, 20);
  assert.equal(one.data.pendingTaskCount, 1);
  const two = await customerJourneyTool(s, { ...args, section: "quotes", offset: 20, limit: 20 });
  assert.equal(two.data.events.length, 6); assert.equal(two.coverage.nextOffset, undefined);
  assert.equal(new Set([...one.data.events, ...two.data.events].map(e => e.id)).size, 26);
  const found = await customerJourneyTool(s, { ...args, section: "quotes", query: "Facto 25" });
  assert.equal(found.coverage.totalMatched, 1);
});
test("Fecha no utilizable produce advertencia y cobertura parcial", async () => {
  const result = await customerJourneyTool(source({ orders: [{ ...record, payload: { ...order, created_at: null } }] }), args);
  assert.equal(result.status, "partial"); assert.match(result.warnings.join(" "), /sin fecha utilizable/);
});
test("Enlaces de referencias solo web sin credenciales", () => {
  assert.equal(safeReference("javascript:alert(1)"), null); assert.equal(safeReference("https://user:secret@example.test"), null);
  assert.equal(safeReference("https://example.test/quote/2"), "https://example.test/quote/2");
});
test("Herramienta Comercial disponible; ruta lectura no acepta escritura", async () => {
  assert.ok(specialists.find(s => s.id === "commercial").tools.includes("get_customer_journey"));
  const response = await centralHandler(new Request("https://fixture.test/company-history", { method: "POST" }), { url: "https://fixture.test", anonKey: "test", serviceRoleKey: "test" }, { id, role: "administrador", accessToken: "test" }, "trace", {});
  assert.equal(response.status, 405);
  assert.equal((await new ToolRegistry(source()).execute("get_customer_journey", { ...args, section: "invented" })).status, "needs_clarification");
});

const code = await readFile(new URL("../src/modules/companies/CompanyJourney.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {}, require = createRequire(import.meta.url);
new Function("require", "exports", "React", compiled)(name => name.startsWith(".") ? {} : require(name), exports, React);
const render = props => renderToStaticMarkup(React.createElement(exports.CompanyJourneyView, { loading: false, error: "", ...props }));
test("Vista informa fuentes y cotizacion manual, sin enlaces ejecutables ni importes inventados", async () => {
  const result = await customerJourneyTool(source({ interactions: [{ ...quote, related_url: "javascript:alert(1)", description: "<script>bad</script>" }] }), args);
  const html = render({ result });
  assert.match(html, /Referencia manual/); assert.match(html, /1\.190 CLP/); assert.match(html, /no son cobros/);
  assert.doesNotMatch(html, /href="javascript|<script>/); assert.match(html, /&lt;script&gt;/);
  assert.match(render({ loading: true }), /role="status"/); assert.match(render({ error: "Error de prueba" }), /role="alert"/);
});

test("Ruta de lectura devuelve historial sin ejecutar escrituras ni modelos", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init.method || "GET"]);
    assert.equal(init.method || "GET", "GET");
    const path = new URL(url).pathname;
    const data = path.endsWith("/companies") ? [company] : path.endsWith("/accounting_entities") ? [{ id: "entity" }]
      : path.endsWith("/interactions") ? [quote] : path.endsWith("/accounting_source_documents") ? [invoice]
      : path.endsWith("/integration_records") ? [record] : [];
    return new Response(JSON.stringify(data), { headers: { "Content-Range": `0-${Math.max(0, data.length - 1)}/${data.length}` } });
  };
  try {
    const req = new Request(`https://fixture.test/company-history?companyId=${id}&period=all`);
    const res = await centralHandler(req, { url: "https://fixture.test", anonKey: "test", serviceRoleKey: "private-test" }, { id, role: "administrador", accessToken: "session-test" }, "trace", {});
    const data = await res.json();
    assert.equal(res.status, 200); assert.equal(data.result.data.events.length, 3);
    assert.doesNotMatch(JSON.stringify(data), /private-test|session-test/);
    assert.ok(calls.every(([url]) => url.includes("/rest/v1/")));
  } finally { globalThis.fetch = original; }
});

const storeCode = await readFile(new URL("../src/modules/companies/CompanyStore.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("store.tsx", storeCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let saveNode;
function visit(node) { if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "createInteraction") saveNode = node.initializer; ts.forEachChild(node, visit); }
visit(tree);
const saveCode = ts.transpileModule(`(${saveNode.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function storeSave(single, user = { id }, configured = true) {
  let local = [], databaseCalls = 0;
  const database = { from() { databaseCalls++; return { insert(row) { return { select() { return { single: () => single(row) }; } }; } }; } };
  const save = new Function("isSupabaseConfigured", "supabase", "user", "setInteractions", "saveInteractions", "mapInteractionToSupabase", `return ${saveCode}`)(
    configured, database, user, update => { local = update(local); }, () => {}, value => value,
  );
  return { save, local: () => local, databaseCalls: () => databaseCalls };
}
test("Guardar seguimiento espera confirmacion y no actualiza local si el servidor falla", async () => {
  let finish;
  const store = storeSave(row => new Promise(resolve => { finish = () => resolve({ data: { id: row.id }, error: null }); }));
  const pending = store.save({ companyId: id, description: "Seguimiento" });
  assert.equal(store.local().length, 0); finish(); await pending; assert.equal(store.local().length, 1);
  const denied = storeSave(() => ({ data: null, error: { message: "denied" } }));
  await assert.rejects(denied.save({ companyId: id }), /No se confirmo/); assert.equal(denied.local().length, 0);
  const noSession = storeSave(() => assert.fail("No debe escribir"), null);
  await assert.rejects(noSession.save({ companyId: id }), /Inicia sesion/); assert.equal(noSession.databaseCalls(), 0);
});
test("Guardados concurrentes conservan ambas interacciones", async () => {
  const store = storeSave(row => ({ data: { id: row.id }, error: null }));
  await Promise.all([store.save({ description: "Uno" }), store.save({ description: "Dos" })]);
  assert.deepEqual(store.local().map(r => r.description).sort(), ["Dos", "Uno"]);
});
