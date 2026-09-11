import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.DASHBOARD_UI_URL || "http://localhost:5183";
const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const url = env.match(/^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
assert.ok(url);
const origin = new URL(url).origin;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
await mkdir("outputs/dashboard", { recursive: true });
const totals = { sales: 136494301, costs: 79339554, expenses: 17000000, operatingProfit: 40154747, grossMargin: 41.87,
  purchasesDomestic: 120000000, purchasesInternational: 200000000, purchasesNet: 320000000, salesCreditNotes: 2500000, purchaseCreditNotes: 1100000 };
const summary = { bank_clp: 8209372, bank_usd_clp: 792, checks_portfolio: 1169981, payables: 12925234, receivables: 11287934, unmatched_bank: 183, as_of: "2026-09-08", bank_balance_basis: "verified_control", receivables_data_quality: "verified_full_snapshot" };
const monthly = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago"].map((label, i) => ({ ...totals, label, period: `2026-${String(i + 1).padStart(2, "0")}`,
  from: `2026-${String(i + 1).padStart(2, "0")}-01`, to: new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10),
  sales: 10000000 + i * 3000000, costs: 6000000 + i * 1000000, expenses: 1000000, operatingProfit: 3000000 + i * 2000000,
  purchasesDomestic: 3000000, purchasesInternational: 65000000, purchasesNet: 68000000, salesCreditNotes: 250000, purchaseCreditNotes: 30000 }));
monthly.push({ label: "Sep", period: "2026-09", from: "2026-09-01", to: "2026-09-09", sales: 149421,
  salesLedger: 0, salesPending: 149421, salesPendingDocuments: 1, costs: 0, expenses: 350000, operatingProfit: -200579, grossMargin: 100,
  purchasesDomestic: -50000, purchasesInternational: 250000, purchasesNet: 200000, salesCreditNotes: 500, purchaseCreditNotes: 75000 });
monthly.push(...["Oct", "Nov", "Dic"].map((label, i) => ({ label, period: `2026-${i + 10}`, from: `2026-${i + 10}-01`, to: new Date(Date.UTC(2026, i + 10, 0)).toISOString().slice(0, 10),
  sales: 0, costs: 0, expenses: 0, operatingProfit: 0, grossMargin: null, purchasesDomestic: 0, purchasesInternational: 0, purchasesNet: 0, salesCreditNotes: 0, purchaseCreditNotes: 0 })));
const purchaseDocuments = [
  { id: "prior", folio: "PRIOR", issuedOn: "2025-12-31", netClp: 100, kind: "domestic", counterpart: "Prior year", sourceType: "FACTO" },
  { id: "jan", folio: "JAN-01", issuedOn: "2026-01-01", netClp: 1000, kind: "domestic", counterpart: "Proveedor nacional", sourceType: "FACTO" },
  { id: "feb-import", folio: "IMP/2026 & A+B#1", issuedOn: "2026-02-01", netClp: 65000000, kind: "international", counterpart: "ProveedorInternacionalConNombreExtensoSinEspacios".repeat(3), sourceType: "COMERCIO_EXTERIOR" },
  { id: "feb-local", folio: "FEB-28", issuedOn: "2026-02-28", netClp: 3030000, kind: "domestic", counterpart: "Proveedor nacional", sourceType: "FACTO" },
  { id: "feb-credit", folio: "NC-28", issuedOn: "2026-02-28", netClp: -30000, kind: "domestic", counterpart: "Proveedor nacional", sourceType: "FACTO" },
  { id: "sep-start", folio: "SEP-01", issuedOn: "2026-09-01", netClp: -50000, kind: "domestic", counterpart: "Proveedor nacional", sourceType: "FACTO" },
  { id: "sep-end", folio: "SEP-09", issuedOn: "2026-09-09", netClp: 250000, kind: "international", counterpart: "Proveedor exterior" },
  { id: "after-cutoff", folio: "SEP-10", issuedOn: "2026-09-10", netClp: 500, kind: "domestic", counterpart: "After cutoff", sourceType: "FACTO" },
];
const optionalFields = ["purchasesDomestic", "purchasesInternational", "purchasesNet", "salesCreditNotes", "purchaseCreditNotes"];
const clp = value => value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const financialRow = (page, label, section = ".overview-results") => page.locator(`${section} .overview-result-row`).filter({ has: page.locator("span").filter({ hasText: new RegExp(`^${label}`) }) });
async function assertValue(page, label, value, section) {
  assert.equal(await financialRow(page, label, section).locator("strong").innerText(), clp(value));
}
async function assertDetailLink(link, from, to, metric) {
  const target = new URL(await link.getAttribute("href"), base);
  assert.equal(target.pathname, "/finanzas-contabilidad");
  assert.equal(target.searchParams.get("view"), "detail");
  assert.equal(target.searchParams.get("metric"), metric);
  assert.equal(target.searchParams.get("from"), from);
  assert.equal(target.searchParams.get("to"), to);
}
async function assertDocumentLink(link, id, issuedOn) {
  const target = new URL(await link.getAttribute("href"), base);
  assert.equal(target.searchParams.get("view"), "facto");
  assert.equal(target.searchParams.get("document"), id);
  assert.equal(target.searchParams.get("from"), issuedOn);
  assert.equal(target.searchParams.get("to"), issuedOn);
}
async function assertLayout(page, label) {
  const issues = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 2) problems.push("page overflow");
    const intersect = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    for (const selector of [".overview-chart-legend", ".overview-bar-group", ".overview-result-row", ".overview-result-total", ".overview-purchase-documents[open] li > a"]) {
      document.querySelectorAll(selector).forEach(parent => {
        const rectangles = [...parent.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width && rect.height);
        rectangles.forEach((rect, index) => rectangles.slice(index + 1).forEach(other => {
          if (intersect(rect, other)) problems.push(`overlap ${selector}`);
        }));
      });
    }
    document.querySelectorAll(".overview-purchase-documents[open] li strong, .overview-purchase-documents[open] li small, .overview-result-row > span, .overview-result-row > strong").forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2) problems.push(`text overflow ${el.textContent}`);
    });
    return problems;
  });
  assert.deepEqual(issues, [], label);
}
try {
  for (const role of ["administrador", "vendedor", "finanzas"]) {
    const context = await browser.newContext();
    const user = { id: "22222222-2222-4222-8222-222222222222", email: "qa@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: { full_name: "Prueba", role } };
    const payload = Buffer.from(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
    await context.addInitScript(({ key, user, payload }) => localStorage.setItem(key, JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 86400, expires_in: 86400, token_type: "bearer", user })), { key: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`, user, payload });
    let failed = false, suppressed = false, financeRequests = 0, tradeRequests = 0, fixtureMode = "complete";
    const fixtureTotals = value => {
      const fixture = { ...value };
      if (fixtureMode === "legacy") optionalFields.forEach(key => delete fixture[key]);
      if (fixtureMode === "net-only") { delete fixture.purchasesDomestic; delete fixture.purchasesInternational; }
      if (fixtureMode === "partial") { delete fixture.purchasesInternational; delete fixture.purchasesNet; }
      if (fixtureMode === "split-only") delete fixture.purchasesNet;
      return fixture;
    };
    await context.route("**/*", async route => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) return u.origin === new URL(base).origin ? route.continue() : route.abort();
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range", "Content-Range": "0-9/10" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let body = [];
      if (u.pathname.includes("/profiles")) body = { id: user.id, role, full_name: "Prueba", active: true };
      if (u.pathname.includes("/auth/v1/user")) body = user;
      if (u.pathname.endsWith("/summary")) {
        financeRequests++;
        if (failed) return route.fulfill({ status: 503, headers, body: '{"error":"Unavailable"}' });
        body = { summary: { ...summary, receivables_suppressed: suppressed }, dashboard: { available: true, year: 2026, from: "2026-01-01", to: "2026-09-09", basis: "mixed", warnings: [], current: fixtureTotals({ ...totals, salesLedger: totals.sales - 149421, salesPending: 149421, salesPendingDocuments: 1 }), monthly: monthly.map(fixtureTotals), purchaseDocuments: fixtureMode === "legacy" ? undefined : fixtureMode === "empty" ? [] : purchaseDocuments, latestSales: [{ id: "1557", folio: "1557", issuedOn: "2026-09-08", netClp: 149421, posted: false }], costCoverage: { salesWithExactCost: 112, totalSalesDocuments: 163 } }, factoFreshness: { stale: false } };
        if (fixtureMode === "complete") body.dashboard.salesAdjustments = [{ id: "nc72", folio: "72", issuedOn: "2026-01-20", recognizedOn: "2026-09-09", netClp: -310640 }];
        if (fixtureMode === "september-adjustments") {
          Object.assign(body.dashboard.monthly[8], { sales: -1782466, salesLedger: -1782466, salesPending: 0, salesPendingDocuments: 0,
            salesIssued: 149421, salesIssuedDocuments: 1, salesIssuedCreditNotes: 0, salesPeriodNet: 149421,
            salesPriorCreditAdjustments: -1938305, salesOtherAdjustments: 6418, salesCostMissingDocuments: 1,
            operatingProfit: -2132466, salesCreditNotes: 1938305 });
          body.dashboard.latestSales[0].posted = true;
        }
      }
      if (u.pathname.includes("foreign_trade_dashboard_summary")) { tradeRequests++; body = { active_shipments: 2, operations_in_preparation: 4, open_alerts: 3, suppliers: 5 }; }
      if (u.pathname.includes("integration_connections")) body = [{ provider: "facto", status: "connected", last_success_at: "2026-09-08" }];
      if (route.request().method() === "HEAD") return route.fulfill({ status: 200, headers, body: "" });
      return route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    for (const width of role === "administrador" ? [1440, 1280, 768, 390, 360, 320] : [390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.goto(`${base}/dashboard`);
      await page.getByRole("button", { name: "Actualizar panorama" }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Actualizar panorama"]')?.disabled);
      assert.equal(await page.locator(".overview-page h1").innerText(), "Panorama del negocio");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
      assert.equal(overflow, false, `overflow ${width} ${role}`);
      const bad = await page.locator(".overview-page a").evaluateAll(links => links.filter(a => !a.getAttribute("href") || a.getAttribute("href") === "#").length);
      assert.equal(bad, 0);
      if (role !== "vendedor") {
        assert.match(await page.locator(".overview-kpis").innerText(), /11\.287\.934/);
        await assertValue(page, "Ventas netas", totals.sales);
        await assertValue(page, "Costo de ventas", totals.costs);
        await assertValue(page, "Notas de crédito de venta", -totals.salesCreditNotes);
        await assertValue(page, "Compras netas", totals.purchasesNet, ".overview-purchases");
        await assertValue(page, "Compras nacionales", totals.purchasesDomestic, ".overview-purchases");
        await assertValue(page, "Compras internacionales", totals.purchasesInternational, ".overview-purchases");
        await assertValue(page, "Notas de crédito de compra", -totals.purchaseCreditNotes, ".overview-purchases");
        assert.equal(await page.locator(".overview-result-total strong").innerText(), clp(totals.operatingProfit));
        assert.match(await financialRow(page, "Margen bruto").innerText(), /41,9%/);
        assert.equal(await page.locator(".overview-bars .purchases").count(), 12);
        assert.equal(await page.locator(".overview-bars .purchases-domestic").count(), 12);
        assert.equal(await page.locator(".overview-bars .purchases-international").count(), 12);
        assert.match(await page.locator(".overview-chart-legend").innerText(), /Compras nacionales[\s\S]*Compras internacionales/);
        const details = page.locator(".overview-purchases .overview-purchase-documents");
        assert.equal(await details.getAttribute("open"), null);
        await details.locator("summary").focus();
        await page.keyboard.press("Enter");
        assert.notEqual(await details.getAttribute("open"), null);
        assert.equal(await details.locator("li").count(), 6);
        await assertDetailLink(details.locator(".overview-chart-link"), "2026-01-01", "2026-09-09", "purchases");
        await assertLayout(page, `annual ${width} ${role}`);
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-02");
        assert.equal(await page.locator(".overview-results h3").innerText(), "Feb 2026");
        assert.match(await page.locator(".overview-results").innerText(), /13\.000\.000/);
        const reportLink = new URL(await page.locator(".overview-result-total").getAttribute("href"), base);
        assert.equal(reportLink.searchParams.get("metric"), "operating-profit");
        assert.equal(reportLink.searchParams.get("from"), monthly[1].from);
        assert.equal(reportLink.searchParams.get("to"), monthly[1].to);
        await assertValue(page, "Compras netas", 68000000, ".overview-purchases");
        await assertValue(page, "Compras nacionales", 3000000, ".overview-purchases");
        await assertValue(page, "Compras internacionales", 65000000, ".overview-purchases");
        await assertValue(page, "Notas de crédito de venta", -250000);
        await assertValue(page, "Notas de crédito de compra", -30000, ".overview-purchases");
        assert.equal(await page.locator(".overview-result-total strong").innerText(), clp(monthly[1].operatingProfit));
        assert.equal(await details.locator("li").count(), 3);
        assert.match(await details.innerText(), /Nacional/);
        assert.match(await details.innerText(), /Internacional/);
        assert.ok((await details.innerText()).includes(clp(-30000)));
        await assertDocumentLink(details.getByRole("link").filter({ hasText: "IMP/2026 & A+B#1" }), "feb-import", "2026-02-01");
        await assertDocumentLink(details.getByRole("link").filter({ hasText: "FEB-28" }), "feb-local", "2026-02-28");
        await assertDetailLink(financialRow(page, "Compras nacionales", ".overview-purchases"), "2026-02-01", "2026-02-28", "domestic");
        await assertDetailLink(financialRow(page, "Compras internacionales", ".overview-purchases"), "2026-02-01", "2026-02-28", "international");
        await assertDetailLink(financialRow(page, "Notas de crédito de venta"), "2026-02-01", "2026-02-28", "sales-credit");
        await assertDetailLink(financialRow(page, "Notas de crédito de compra", ".overview-purchases"), "2026-02-01", "2026-02-28", "purchase-credit");
        const bars = await page.locator(".overview-bars button").nth(1).evaluate(button => {
          const height = selector => button.querySelector(selector).getBoundingClientRect().height;
          return { group: height(".overview-bar-group"), sales: height(".sales"), costs: height(".costs"), purchases: height(".purchases"), domestic: height(".purchases-domestic"), international: height(".purchases-international") };
        });
        assert.ok(Math.abs(bars.group - bars.purchases) < 1, "Shared scale includes the larger purchases stack");
        assert.ok(Math.abs(bars.domestic + bars.international - bars.purchases) < 1);
        assert.ok(Math.abs(bars.sales / bars.purchases - 13000000 / 68000000) < 0.01);
        assert.ok(Math.abs(bars.costs / bars.purchases - 8000000 / 68000000) < 0.01);
        assert.ok(Math.abs(bars.domestic / bars.purchases - 3000000 / 68000000) < 0.01);
        await assertLayout(page, `February expanded ${width} ${role}`);
        await page.screenshot({ path: `outputs/dashboard/${role}-${width}-purchases.png`, fullPage: true });
        await details.locator("summary").click();
        assert.equal(await details.getAttribute("open"), null);
        await details.locator("summary").click();
        await page.locator(".overview-bars button").first().click();
        assert.equal(await page.locator(".overview-results h3").innerText(), "Ene 2026");
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("year");
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-09");
        assert.match(await page.locator(".overview-results").innerText(), /149\.421/);
        assert.match(await page.locator(".overview-sales-breakdown").innerText(), /Sin asiento/);
        assert.match(await page.locator(".overview-result-total").innerText(), /base mixta/);
        assert.match(await page.locator(".overview-results").innerText(), /Por validar/);
        assert.match(await page.locator(".overview-recent-sales").innerText(), /Documento 1557/);
        await assertDocumentLink(page.locator(".overview-recent-sales a"), "1557", "2026-09-08");
        await assertValue(page, "Compras netas", 200000, ".overview-purchases");
        const adjustments = page.locator(".overview-sales-adjustments");
        await adjustments.locator("summary").click();
        assert.match(await adjustments.innerText(), /Nota de crédito 72/);
        await assertDocumentLink(adjustments.locator("li a"), "nc72", "2026-01-20");
        assert.ok((await adjustments.innerText()).includes(clp(-310640)));
        await assertValue(page, "Compras nacionales", -50000, ".overview-purchases");
        await assertValue(page, "Notas de crédito de compra", -75000, ".overview-purchases");
        assert.equal(await page.locator(".overview-result-total strong").innerText(), clp(-200579));
        assert.equal(await details.locator("li").count(), 2);
        await assertDocumentLink(details.getByRole("link").filter({ hasText: "SEP-09" }), "sep-end", "2026-09-09");
        assert.equal(await page.locator(".overview-bars .sales").nth(8).evaluate(el => el.getBoundingClientRect().height >= 2), true);
        assert.equal(await page.locator(".overview-bars button").nth(8).locator(".purchases-domestic").evaluate(el => el.getBoundingClientRect().height), 0);
        await assertLayout(page, `September ${width} ${role}`);
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-10");
        await assertValue(page, "Compras netas", 0, ".overview-purchases");
        await assertValue(page, "Notas de crédito de venta", 0);
        assert.equal(await details.locator("li").count(), 0);
        assert.match(await details.innerText(), /Sin documentos de compras en este período/);
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-09");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
      }
      await page.screenshot({ path: `outputs/dashboard/${role}-${width}.png`, fullPage: true });
    }
    if (role === "vendedor") { assert.equal(financeRequests, 0); assert.equal(tradeRequests, 0); assert.equal(await page.locator(".overview-kpis").count(), 0); assert.equal(await page.locator(".overview-purchases").count(), 0); }
    if (role === "finanzas") assert.equal(tradeRequests, 0);
    if (role === "administrador") {
      fixtureMode = "september-adjustments";
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        await page.getByRole("button", { name: "Actualizar panorama" }).click();
        await page.waitForFunction(() => !document.querySelector('[aria-label="Actualizar panorama"]')?.disabled);
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-09");
        await assertValue(page, "Ventas emitidas en el período", 149421);
        await assertValue(page, "Notas emitidas en el período", 0);
        await assertValue(page, "Notas de crédito de otros períodos", -1938305);
        await assertValue(page, "Otras regularizaciones de ventas", 6418);
        await assertValue(page, "Ventas netas en resultado", -1782466);
        assert.match(await financialRow(page, "Ventas emitidas en el período").innerText(), /1 documento/);
        assert.match(await financialRow(page, "Costo de ventas").innerText(), /1 documento\(s\) sin costo confirmado/);
        assert.match(await financialRow(page, "Margen bruto").innerText(), /Por validar/);
        assert.match(await page.locator(".overview-result-total").innerText(), /Resultado operativo contable/);
        assert.equal(await page.locator(".overview-result-total strong").innerText(), clp(-2132466));
        await assertLayout(page, `September adjustments ${width}`);
        await page.screenshot({ path: `outputs/dashboard/september-adjustments-${width}.png`, fullPage: true });
      }
      for (const mode of ["legacy", "net-only", "partial", "split-only", "empty"]) {
        fixtureMode = mode;
        await page.getByRole("button", { name: "Actualizar panorama" }).click();
        await page.waitForFunction(() => !document.querySelector('[aria-label="Actualizar panorama"]')?.disabled);
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("year");
        await assertValue(page, "Ventas netas", totals.sales);
        assert.equal(await page.locator(".overview-result-total strong").innerText(), clp(totals.operatingProfit));
        if (["legacy", "partial"].includes(mode)) {
          assert.equal(await financialRow(page, "Compras netas", ".overview-purchases").locator("strong").innerText(), "No disponible");
          assert.equal(await page.locator(".overview-bars .purchases.unavailable").count(), 12);
        } else await assertValue(page, "Compras netas", totals.purchasesNet, ".overview-purchases");
        if (mode === "legacy") {
          assert.equal(await financialRow(page, "Notas de crédito de venta").locator("strong").innerText(), "No disponible");
          assert.match(await page.locator(".overview-purchase-documents").innerText(), /Detalle de documentos de compras no disponible/);
        }
        if (mode === "net-only") {
          assert.equal(await page.locator(".overview-bars .purchases.unsplit").count(), 12);
          assert.match(await page.locator(".overview-chart-legend").innerText(), /Compras sin desglose/);
          assert.equal(await financialRow(page, "Compras nacionales", ".overview-purchases").locator("strong").innerText(), "No disponible");
        }
        if (mode === "partial") await assertValue(page, "Compras nacionales", totals.purchasesDomestic, ".overview-purchases");
        if (mode === "split-only") assert.equal(await page.locator(".overview-bars .purchases-domestic").count(), 12);
        if (mode === "empty") assert.match(await page.locator(".overview-purchase-documents").innerText(), /Sin documentos de compras en este período/);
        await assertLayout(page, mode);
      }
      suppressed = true; await page.getByRole("button", { name: "Actualizar panorama" }).click();
      await page.getByText("En revisión", { exact: true }).waitFor();
      failed = true; await page.getByRole("button", { name: "Actualizar panorama" }).click();
      await page.getByText("Lectura parcial", { exact: true }).waitFor();
      assert.doesNotMatch(await page.locator(".overview-kpis").innerText(), /11\.287\.934/);
      assert.match(await page.locator(".overview-kpis").innerText(), /No disponible/);
      await page.locator('.overview-modules a[href="/copiloto"]').click();
      assert.equal(new URL(page.url()).pathname, "/copiloto");
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${role}: responsive layout, purchases stacks, credit notes, period documents, source links, unchanged results, optional fields and access`);
    await context.close();
  }
} finally { await browser.close(); }
