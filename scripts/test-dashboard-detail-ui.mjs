import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.DASHBOARD_UI_URL || "http://localhost:5183";
const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const url = env.match(/^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
const origin = new URL(url).origin;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const user = { id: "22222222-2222-4222-8222-222222222222", email: "qa@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: { full_name: "Prueba", role: "administrador" } };
const sales = Array.from({ length: 162 }, (_, i) => ({ id: `sale-${i}`, folio: `${1400 + i}`, issuedOn: i < 3 ? "2026-09-11" : "2026-08-18", recognizedOn: i < 3 ? "2026-09-11" : "2026-08-18", posted: i >= 3, netClp: 1000, creditNote: false, exactCost: i >= 50, counterpart: `Cliente ${i}` }));
const totals = { sales: 162000, costs: 100, expenses: 50, otherResults: 0, grossProfit: 161900, operatingProfit: 161850, grossMargin: 99,
  salesLedger: 159000, salesPending: 3000, salesPendingDocuments: 3, salesCostMissingDocuments: 50, purchasesNet: 0, purchasesDomestic: 0, purchasesInternational: 0 };
const dashboard = { available: true, year: 2026, from: "2026-01-01", to: "2026-09-11", basis: "mixed", warnings: [], current: totals, monthly: [
  { ...totals, period: "2026-08", from: "2026-08-01", to: "2026-08-31", label: "Ago", salesPendingDocuments: 0, salesPending: 0, salesCostMissingDocuments: 47 },
  { ...totals, period: "2026-09", from: "2026-09-01", to: "2026-09-11", label: "Sep", salesCostMissingDocuments: 3 },
], purchaseDocuments: [], latestSales: [], costCoverage: { salesWithExactCost: 112, totalSalesDocuments: 162 }, detail: { ledgerAvailable: true, sales, ledger: [] } };
const summary = { bank_clp: 8000, bank_usd_clp: 0, checks_portfolio: 150, payables: 100, receivables: 150, unmatched_bank: 1, as_of: "2026-09-11" };
const balance = { id: "outstanding", document_number: "42", issued_on: "2025-12-01", due_on: null, original_amount_clp: 150, paid_amount_clp: 0, balance_clp: 150, status: "open", customer_name: "Cliente anterior", supplier_name: "Proveedor anterior" };
const bootstrap = { entity: { id: "entity", name: "Prueba" }, profile: { role: "administrador", permissions: [] }, accounts: [], periods: [], bankAccounts: [], bankTransactions: [], bankBalanceSnapshots: [], entries: [], receivables: [balance], payables: [balance], checks: [], paymentEvents: [], controls: [], batches: [], factoSyncRuns: [], factoReceivableSyncRuns: [], summary, dashboard, factoFreshness: { stale: false }, sources: sales.map(row => ({ id: row.id, source_type: "FACTO", document_type: "sales_invoice", folio: row.folio, issued_on: row.issuedOn, counterpart_name: row.counterpart, total_clp: row.netClp * 1.19, currency: "CLP", status: "validated", data_quality: "validated" })) };
bootstrap.sources.push({ ...bootstrap.sources[0], id: "same-folio-another-supplier", counterpart_name: "No seleccionado" });
bootstrap.checks = ["portfolio", "collected"].map(status => ({ id: status, customer_name: status, bank_name: "Banco", received_on: "2025-12-01", amount_clp: 150, status }));
bootstrap.bankTransactions = ["unmatched", "partial", "matched"].map(status => ({ id: status, description: `Transferencia ${status}`, transaction_date: "2025-12-01", reconciliation_status: status, amount_clp: 100, metadata: {} }));
const publications = ["pending_approval", "failed", "scheduled", "published", "published"].map((status, i) => ({ id: `pub-${i}`, status, body: `Publicacion ${i}`, hashtags: [], media_urls: [], created_at: "2026-09-01", published_at: i === 3 ? "2026-09-11T12:00:00Z" : i === 4 ? "2026-08-01T12:00:00Z" : null }));
const operations = ["draft", "production", "in_transit", "completed"].map(status => ({ id: status, status, title: `Operacion ${status}`, reference: status, operation_type: "import", value_usd: 1000, updated_at: "2026-09-11" }));
await mkdir("outputs/dashboard", { recursive: true });
try {
  const context = await browser.newContext();
  const payload = Buffer.from(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
  await context.addInitScript(({ key, user, payload }) => localStorage.setItem(key, JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 86400, expires_in: 86400, token_type: "bearer", user })), { key: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`, user, payload });
  const writes = [], errors = [];
  let missingDetail = false;
  await context.route("**/*", async route => {
    const request = route.request(), u = new URL(request.url());
    if (u.origin !== origin) return u.origin === new URL(base).origin ? route.continue() : route.abort();
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range", "Content-Range": "*/0" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (!["GET", "HEAD"].includes(request.method()) && !u.pathname.includes("/rpc/foreign_trade_dashboard_summary")) writes.push(u.pathname);
    let body = [];
    if (u.pathname.includes("/profiles")) body = { id: user.id, role: "administrador", full_name: "Prueba", active: true };
    if (u.pathname.endsWith("/auth/v1/user")) body = user;
    if (u.pathname.endsWith("/summary")) body = { summary, dashboard, factoFreshness: { stale: false } };
    if (u.pathname.endsWith("/bootstrap")) body = u.pathname.includes("content-center") ? { channels: [] } : { ...bootstrap, dashboard: { ...dashboard, detail: missingDetail ? undefined : dashboard.detail } };
    if (u.pathname.includes("content-center/products")) body = { products: [], categories: [] };
    if (u.pathname.endsWith("/content_publications")) body = publications;
    if (u.pathname.endsWith("/import_shipments")) body = operations;
    if (u.pathname.endsWith("/foreign_trade_operation_statuses")) body = operations.map(row => ({ code: row.status, name: row.status, active: true, final_state: row.status === "completed" }));
    if (u.pathname.endsWith("/suppliers")) body = [true, false].map(active => ({ id: String(active), name: active ? "Proveedor activo" : "Proveedor inactivo", active, usual_incoterms: [] }));
    if (u.pathname.endsWith("/foreign_trade_alerts")) {
      assert.equal(u.searchParams.get("status"), "eq.open");
      body = [{ id: "alert", operation_id: "production", title: "Revisar embarque", detail: "Dato de prueba", severity: "warning", created_at: "2026-09-11" }];
    }
    if (u.pathname.endsWith("/business_agent_tasks") || u.pathname.endsWith("/executive_agent_settings") || u.pathname.endsWith("/executive_notifications")) body = request.headers().accept?.includes("object") ? null : [];
    if (u.pathname.endsWith("/inventory_risk_alerts")) {
      assert.equal(u.searchParams.get("status"), "eq.open");
      body = [{ id: "inventory", title: "Revisar stock", sku: "FLARE 3/8", detail: "Stock bajo", severity: "warning" }];
    }
    if (u.pathname.endsWith("/action_proposals")) {
      assert.equal(u.searchParams.get("status"), "eq.pending");
      body = [{ id: "proposal", title: "Propuesta pendiente", summary: "Dato de prueba", status: "pending" }];
    }
    if (u.pathname.endsWith("/integration_connections")) body = [{ provider: "facto", status: "connected", message: "Conexion Facto" }, { provider: "tiendanube", status: "connected", message: "Conexion Tiendanube" }];
    if (u.pathname.includes("foreign_trade_dashboard_summary")) body = { active_shipments: 0, operations_in_preparation: 0, open_alerts: 0, suppliers: 0 };
    if (Array.isArray(body)) headers["Content-Range"] = body.length ? `0-${body.length - 1}/${body.length}` : "*/0";
    return route.fulfill({ status: 200, headers, body: request.method() === "HEAD" ? "" : JSON.stringify(body) });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const detail = page.locator(".accounting-dashboard-detail");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`${base}/dashboard`);
    await page.locator('.overview-sales-breakdown a[href*="sales-pending"]').waitFor();
    await page.locator('.overview-sales-breakdown a[href*="sales-pending"]').click();
    await detail.getByRole("heading", { name: "Ventas sin asiento de ingreso" }).waitFor();
    assert.equal(await detail.locator("tbody tr").count(), 3);
    assert.match(await detail.innerText(), /3 de 3/);
    await detail.getByPlaceholder("Documento, cliente o cuenta").fill("Cliente 1");
    assert.equal(await detail.locator("tbody tr").count(), 1);
    await detail.getByPlaceholder("Documento, cliente o cuenta").fill("");
    await detail.locator('a[title="Abrir este documento"]').first().click();
    await page.getByRole("heading", { name: "Documento seleccionado" }).waitFor();
    assert.equal(await page.locator(".accounting-center-page tbody tr").count(), 1);
    assert.doesNotMatch(await page.locator(".accounting-center-page").innerText(), /No seleccionado/);
    await page.goBack();
    await detail.getByRole("link", { name: "Volver al dashboard" }).click();
    await page.locator('.overview-result-row[href*="cost-missing"]').click();
    await detail.getByRole("heading", { name: "Ventas sin costo confirmado" }).waitFor();
    assert.equal(await detail.locator("tbody tr").count(), 50);
    assert.match(await detail.innerText(), /50 de 50/);
    await detail.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `detail overflow ${width}`);
    const moneyWraps = await detail.locator(".accounting-detail-money").evaluateAll(cells => cells.some(cell => cell.scrollWidth > cell.clientWidth + 2));
    assert.equal(moneyWraps, false, `amount overflow ${width}`);
    const clipped = await detail.evaluate(root => [...root.querySelectorAll("input, .accounting-filter-grid, .accounting-detail-total, td")].filter(el => {
      const bounds = el.getBoundingClientRect();
      return innerWidth <= 640 && (bounds.right > innerWidth + 1 || bounds.left < -1 || el.scrollWidth > el.clientWidth + 2);
    }).map(el => el.tagName));
    assert.deepEqual(clipped, [], `clipped detail controls ${width}`);
    await detail.getByRole("heading").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `outputs/dashboard/detail-cost-${width}.png` });
    await detail.getByRole("link", { name: "Volver al dashboard" }).click();
    await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-08");
    await page.locator('.overview-result-row[href*="cost-missing"]').click();
    await detail.locator("tbody tr").first().waitFor();
    assert.equal(await detail.locator("tbody tr").count(), 47);
    await detail.getByRole("link", { name: "Volver al dashboard" }).click();
    await page.locator(".overview-results h3").filter({ hasText: "Ago 2026" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Período financiero" }).inputValue(), "2026-08");
    await page.reload();
    await page.locator('.overview-result-row[href*="cost-missing"]').waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Período financiero" }).inputValue(), "2026-08");
    await page.goto(`${base}/finanzas-contabilidad?view=detail&metric=cost-missing&from=2026-02-01&to=2026-02-28`);
    await detail.getByText("Sin casos para este filtro y período.").waitFor();
    assert.equal(await detail.locator("tbody tr").count(), 0);
    await detail.getByLabel("Desde", { exact: true }).fill("2026-03-01");
    await detail.getByRole("alert").filter({ hasText: "Revisa las fechas" }).waitFor();
    console.log(`PASS detail ${width}: 3 pending, 50 missing costs, exact source, date filter, back/reload and empty/error states`);
  }
  for (const [view, name] of [["receivables", "Cliente anterior"], ["payables", "Proveedor anterior"]]) {
    await page.goto(`${base}/finanzas-contabilidad?view=${view}&scope=outstanding`);
    await page.locator("tbody").getByText(name, { exact: true }).waitFor();
  }
  await page.goto(`${base}/finanzas-contabilidad?view=checks&status=portfolio`);
  await page.locator("tbody").getByText("portfolio", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.goto(`${base}/finanzas-contabilidad?view=reconcile&status=unmatched`);
  await page.getByText("Transferencia unmatched", { exact: true }).waitFor();
  assert.equal(await page.locator(".accounting-transaction-list > button").count(), 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const [query, expected] of [["status=pending_approval", "Publicacion 0"], ["status=failed", "Publicacion 1"], ["publication=pub-2", "Publicacion 2"], ["status=published&from=2026-09-04T00:00:00Z", "Publicacion 3"]]) {
      await page.goto(`${base}/contenido?view=publications&${query}`);
      await page.locator("tbody").getByText(expected, { exact: true }).waitFor();
      assert.equal(await page.locator("tbody tr").count(), 1);
    }
    for (const [scope, count] of [["active-shipments", 2], ["preparation", 3]]) {
      await page.goto(`${base}/comercio-exterior?view=operations&scope=${scope}`);
      await page.getByText("Operacion production", { exact: true }).waitFor();
      assert.equal(await page.locator("tbody tr").count(), count);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    }
    await page.goto(`${base}/comercio-exterior?view=alerts&status=open`);
    await page.getByRole("heading", { name: "Revisar embarque" }).waitFor();
    await page.goto(`${base}/comercio-exterior?view=suppliers&active=true`);
    await page.getByText("Proveedor activo", { exact: true }).waitFor();
    assert.equal(await page.getByText("Proveedor inactivo", { exact: true }).count(), 0);
    for (const [query, expected] of [["focus=inventory", "Revisar stock"], ["focus=proposals", "Propuesta pendiente"], ["focus=connection&provider=facto", "Conexion Facto"]]) {
      await page.goto(`${base}/agentes?${query}`);
      await page.locator(".agents-center").getByText(expected, { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    }
    assert.equal(await page.getByText("Conexion Tiendanube", { exact: false }).count(), 0);
    console.log(`PASS filtered destinations ${width}: publications, shipments, suppliers, alerts, proposals and connections`);
  }
  missingDetail = true;
  await page.goto(`${base}/finanzas-contabilidad?view=detail&metric=cost-missing&from=2026-01-01&to=2026-09-11`);
  await detail.getByRole("alert").filter({ hasText: "No se pudo obtener" }).waitFor();
  assert.deepEqual(writes, [], "Drill-down navigation never writes or posts accounting data");
  assert.deepEqual(errors, []);
  await context.close();
} finally { await browser.close(); }
