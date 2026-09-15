import assert from "node:assert/strict";
import test from "node:test";
import { inventoryValuation } from "../supabase/functions/crm-copilot/inventory-valuation.ts";
import { factoCurrencies } from "../supabase/functions/crm-copilot/product-prices.ts";
import { CopilotSources } from "../supabase/functions/crm-copilot/sources.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { centralHandler } from "../supabase/functions/crm-copilot/central.ts";
import { runOrchestrator } from "../supabase/functions/crm-copilot/orchestrator.ts";

const stamp = "2026-09-15T12:00:00Z";
function detail(id, stock = 2, cost = 100, currency = "39") {
  return { id: String(id), external_id: String(id), updated_at: stamp, payload: { sku: `ST-${id}`, name: `Bomba de vacio ${id}`, product_id: id,
    inventories: stock === null ? {} : { details: [{ product_location_id: 1, available_quantity: String(stock) }] },
    cost: { value: String(cost), currency_id: currency }, price: [{ product_price_list_id: "1", currency_id: "39", unit_net: "250.500000" }] } };
}
function calculate(details, { args = {}, catalog = [], snapshots = [], confirmations = {}, finance = true } = {}) {
  return inventoryValuation(snapshots, details, catalog, args, factoCurrencies(), confirmations, finance);
}
function fixture(role = "administrador", details = Array.from({ length: 52 }, (_, i) => detail(i + 1))) {
  const accesses = [];
  const fetcher = async (input, init) => {
    const url = new URL(input); accesses.push({ url: url.toString(), method: init?.method || "GET" });
    let values = [];
    if (url.pathname.endsWith("integration_records")) values = url.searchParams.get("resource") === "eq.product_details" ? details : [];
    if (url.pathname.endsWith("accounting_entities")) values = url.searchParams.has("active") ? [{ id: "entity" }] : [{ confirmations: {} }];
    const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 10000);
    return new Response(JSON.stringify(values.slice(offset, offset + limit)), { headers: { "content-range": `0-499/${values.length}`, "content-type": "application/json" } });
  };
  const config = { url: "https://fixture.invalid", anonKey: "anon", serviceRoleKey: "service" };
  const actor = { id: "actor", role, accessToken: "user" };
  return { registry: new ToolRegistry(new CopilotSources(config, actor, undefined, fetcher)), accesses, fetcher, config, actor };
}

test("Stock, costo y venta neta se calculan por SKU sin duplicar fuentes", () => {
  const computed = calculate([detail(1), detail(2, 3)], { snapshots: [{ external_id: "1", payload: { sku: "ST-1", source_product_id: 1, stock_known: true, available_units: 900 } }],
    catalog: [{ sku: "ST-1", name: "Bomba tienda", stock: 999, last_synced_at: stamp }] });
  assert.equal(computed.totals.available_units, 5);
  assert.equal(computed.totals.by_currency[0].cost_verified, 500);
  assert.equal(computed.totals.by_currency[0].net_sale_value, 1252.5);
  assert.equal(computed.records[0].net_price, 250.5, "No resta IVA una segunda vez al precio neto");
});

test("Costos sin moneda son referenciales; nunca se mezclan USD con CLP", () => {
  const computed = calculate([detail(1), detail(2, 3, 120, null), detail(3, 4, 50, "5")]);
  const clp = computed.totals.by_currency.find(c => c.currency === "CLP"), usd = computed.totals.by_currency.find(c => c.currency === "USD");
  assert.equal(clp.cost_verified, 200); assert.equal(clp.cost_conditional, 360); assert.equal(clp.cost_reference, 560);
  assert.equal(usd.cost_verified, 200); assert.equal(usd.net_sale_value, null);
  assert.equal(computed.complete, false); assert.equal(computed.totals.conditional_cost_products, 1);
  const confirmed = calculate([detail(2, 3, 120, null)], { confirmations: { "ST-2": { source_product_id: "2", recorded_unit_cost: 120, currency: "CLP", confirmed_at: stamp } } });
  assert.equal(confirmed.totals.by_currency[0].cost_verified, 360);
  assert.equal(confirmed.totals.conditional_cost_products, 0);
});

test("Datos faltantes, cero y stock negativo no se inventan ni compensan inventario disponible", () => {
  const computed = calculate([detail(1, null), detail(2, 0), detail(3, -2), detail(4, 3, 0)]);
  assert.equal(computed.totals.available_units, 3); assert.equal(computed.totals.unknown_stock_products, 1);
  assert.equal(computed.totals.negative_stock_products, 1); assert.equal(computed.totals.zero_stock_products, 1);
  assert.equal(computed.totals.missing_cost_products, 1); assert.equal(computed.totals.by_currency[0].cost_reference, null);
  assert.equal(calculate([detail(1, null)]).totals.available_units, null);
  assert.equal(calculate([detail(1)], { args: { query: "no-existe" } }).totals.available_units, 0);
  assert.throws(() => calculate([]));
});

test("Filtros de nombre, marca y movimiento preservan el alcance completo", () => {
  const details = [detail(1), detail(2, 0), detail(3, 4)];
  const catalog = [{ sku: "ST-1", brand: "Super Stars" }, { sku: "ST-2", brand: "Super Stars" }, { sku: "ST-3", brand: "Otra" }];
  const filtered = calculate(details, { catalog, args: { brand: "super stars", stock_filter: "available" } });
  assert.equal(filtered.totals.matched_products, 1); assert.equal(filtered.totals.available_units, 2);
  assert.equal(calculate(details, { args: { query: "ST-3" } }).totals.available_units, 4);
  assert.equal(calculate(details, { args: { stock_filter: "without_movement" } }).totals.matched_products, 0, "Sin historial no significa sin movimiento");
  const snapshots = [{ payload: { sku: "ST-3", source_product_id: 3, sales_history_available: true, units_sold_observed: 0, sales_history_start: "2026-01-01", sales_history_end: "2026-08-31" } }];
  assert.equal(calculate(details, { snapshots, args: { stock_filter: "without_movement" } }).totals.available_units, 4);
});

test("Varias listas y SKU ambiguos nunca multiplican el stock ni la valorizacion", () => {
  const row = detail(1); row.payload.price.push({ ...row.payload.price[0], product_price_list_id: "2", unit_net: "300" });
  const computed = calculate([row]);
  assert.equal(computed.totals.available_units, 2); assert.equal(computed.totals.by_currency[0].cost_verified, 200);
  assert.equal(computed.totals.by_currency[0].net_sale_value, null);
  assert.equal(calculate([row], { args: { list_id: "2" } }).totals.by_currency[0].net_sale_value, 600);
  assert.equal(calculate([row, { ...row, external_id: "other" }]).totals.available_units, null);
});

test("Cantidades fraccionarias conservan precision monetaria", () => {
  const computed = calculate([detail(1, 0.1, 0.2), detail(2, 0.2, 0.1)]);
  assert.equal(computed.totals.available_units, 0.3);
  assert.equal(computed.totals.by_currency[0].cost_reference, 0.04);
});

test("El registro entrega totales sobre 52 productos incluso con paginas de 25", async () => {
  const f = fixture();
  const first = await f.registry.execute("get_inventory_valuation", { limit: 25 });
  const last = await f.registry.execute("get_inventory_valuation", { offset: 50, limit: 25 });
  assert.equal(first.status, "ok"); assert.equal(first.data.records.length, 25); assert.equal(last.data.records.length, 2);
  assert.deepEqual(first.data.totals, last.data.totals); assert.equal(first.data.totals.available_units, 104);
  assert.equal(first.data.totals.by_currency[0].cost_verified, 10400);
  assert.equal(first.coverage.nextOffset, 25); assert.equal(last.coverage.nextOffset, undefined);
  assert.equal(first.continuation.toolName, "get_inventory_valuation");
  assert.ok(f.accesses.every(a => a.method === "GET"));
});

test("Lectura paginada del origen no trunca inventarios de mas de 500 SKU", async () => {
  const f = fixture("finanzas", Array.from({ length: 601 }, (_, i) => detail(i + 1)));
  const result = await f.registry.execute("get_inventory_valuation", {});
  assert.equal(result.data.totals.matched_products, 601); assert.equal(result.data.totals.available_units, 1202);
  assert.ok(f.accesses.some(a => a.url.includes("offset=500")));
});

test("Vendedores y visualizadores ven cantidades y venta, nunca costo ni moneda de costo", async () => {
  for (const role of ["vendedor", "visualizador"]) {
    const f = fixture(role), result = await f.registry.execute("get_inventory_valuation", {});
    assert.equal(result.data.totals.available_units, 104);
    assert.doesNotMatch(JSON.stringify(result.data), /unit_cost|cost_currency|cost_value|cost_reference|cost_verified|conditional_cost|missing_cost/);
    assert.ok(!f.accesses.some(a => a.url.includes("accounting_entities")));
    assert.equal((await f.registry.execute("get_inventory_valuation", { stock_filter: "without_cost" })).status, "forbidden");
  }
});

test("Endpoint de dashboard usa el mismo registro, sin IA, escrituras ni cache", async () => {
  const f = fixture(); const originalFetch = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    const response = await centralHandler(new Request("https://crm.test/inventory?query=ST-1&limit=25"), f.config, f.actor, "trace", {});
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).data.totals.available_units, 2);
    assert.ok(f.accesses.every(a => a.method === "GET" && a.url.startsWith("https://fixture.invalid/rest/v1/")));
    assert.equal((await centralHandler(new Request("https://crm.test/inventory?limit=invalid"), f.config, f.actor, "trace", {})).status, 400);
  } finally { globalThis.fetch = originalFetch; }
});

test("Fallos de origen no se muestran como inventario total cero", async () => {
  const source = new CopilotSources({ url: "https://bad.invalid", anonKey: "a", serviceRoleKey: "s" }, { id: "a", role: "finanzas", accessToken: "t" }, undefined, async () => new Response("error", { status: 500 }));
  const result = await new ToolRegistry(source).execute("get_inventory_valuation", {});
  assert.equal(result.status, "unavailable"); assert.equal(result.data, null);
});

test("Copiloto comunica los totales calculados y no un costo inventado por el modelo", async () => {
  let turn = 0;
  const result = await runOrchestrator({ registry: fixture().registry, model: "fixture", apiKey: "test", message: "Dame el inventario total a costo", history: [], signal: new AbortController().signal, onTrace: async () => {}, fetcher: async () => new Response(JSON.stringify({ output: turn++ ? [{ type: "message", content: [{ type: "output_text", text: "El costo es 999 millones" }] }] : [{ type: "function_call", name: "get_inventory_valuation", arguments: "{}", call_id: "inventory" }] }), { headers: { "content-type": "application/json" } }) });
  assert.match(result.message, /104 unidades/); assert.match(result.message, /10\.400/); assert.doesNotMatch(result.message, /999 millones/);
});
