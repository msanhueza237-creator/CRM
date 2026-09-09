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
const totals = { sales: 136494301, costs: 79339554, expenses: 17000000, operatingProfit: 40154747, grossMargin: 41.87 };
const summary = { bank_clp: 8209372, bank_usd_clp: 792, checks_portfolio: 1169981, payables: 12925234, receivables: 11287934, unmatched_bank: 183, as_of: "2026-09-08", bank_balance_basis: "verified_control", receivables_data_quality: "verified_full_snapshot" };
const monthly = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago"].map((label, i) => ({ ...totals, label, period: `2026-${String(i + 1).padStart(2, "0")}`, from: "2026-01-01", to: "2026-09-08", sales: 10000000 + i * 3000000, costs: 6000000 + i * 1000000, expenses: 1000000, operatingProfit: 3000000 + i * 2000000 }));
monthly.push({ label: "Sep", period: "2026-09", from: "2026-09-01", to: "2026-09-09", sales: 149421,
  salesLedger: 0, salesPending: 149421, salesPendingDocuments: 1, costs: 0, expenses: 350000, operatingProfit: -200579, grossMargin: 100 });
try {
  for (const role of ["administrador", "vendedor", "finanzas"]) {
    const context = await browser.newContext();
    const user = { id: "22222222-2222-4222-8222-222222222222", email: "qa@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: { full_name: "Prueba", role } };
    const payload = Buffer.from(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
    await context.addInitScript(({ key, user, payload }) => localStorage.setItem(key, JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 86400, expires_in: 86400, token_type: "bearer", user })), { key: `sb-${new URL(url).hostname.split(".")[0]}-auth-token`, user, payload });
    let failed = false, suppressed = false, financeRequests = 0, tradeRequests = 0;
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
        body = { summary: { ...summary, receivables_suppressed: suppressed }, dashboard: { available: true, year: 2026, from: "2026-01-01", to: "2026-09-09", basis: "mixed", warnings: [], current: { ...totals, salesLedger: totals.sales - 149421, salesPending: 149421, salesPendingDocuments: 1 }, monthly, latestSales: [{ id: "1557", folio: "1557", issuedOn: "2026-09-08", netClp: 149421, posted: false }], costCoverage: { salesWithExactCost: 112, totalSalesDocuments: 163 } }, factoFreshness: { stale: false } };
      }
      if (u.pathname.includes("foreign_trade_dashboard_summary")) { tradeRequests++; body = { active_shipments: 2, operations_in_preparation: 4, open_alerts: 3, suppliers: 5 }; }
      if (u.pathname.includes("integration_connections")) body = [{ provider: "facto", status: "connected", last_success_at: "2026-09-08" }];
      if (route.request().method() === "HEAD") return route.fulfill({ status: 200, headers, body: "" });
      return route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    for (const width of role === "administrador" ? [1440, 1280, 768, 390, 360] : [390]) {
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
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-02");
        assert.equal(await page.locator(".overview-results h3").innerText(), "Feb 2026");
        assert.match(await page.locator(".overview-results").innerText(), /13\.000\.000/);
        const reportLink = new URL(await page.locator(".overview-result-total").getAttribute("href"), base);
        assert.equal(reportLink.searchParams.get("report"), "income");
        assert.equal(reportLink.searchParams.get("from"), monthly[1].from);
        assert.equal(reportLink.searchParams.get("to"), monthly[1].to);
        await page.locator(".overview-bars button").first().click();
        assert.equal(await page.locator(".overview-results h3").innerText(), "Ene 2026");
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("year");
        await page.getByRole("combobox", { name: "Período financiero" }).selectOption("2026-09");
        assert.match(await page.locator(".overview-results").innerText(), /149\.421/);
        assert.match(await page.locator(".overview-sales-breakdown").innerText(), /Sin asiento/);
        assert.match(await page.locator(".overview-result-total").innerText(), /base mixta/);
        assert.match(await page.locator(".overview-results").innerText(), /Por validar/);
        assert.match(await page.locator(".overview-recent-sales").innerText(), /Documento 1557/);
        assert.equal(await page.locator(".overview-recent-sales a").getAttribute("href"), "/finanzas-contabilidad?view=facto");
        assert.equal(await page.locator(".overview-bars .sales").last().evaluate(el => el.getBoundingClientRect().height >= 2), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
      }
      await page.screenshot({ path: `outputs/dashboard/${role}-${width}.png`, fullPage: true });
    }
    if (role === "vendedor") { assert.equal(financeRequests, 0); assert.equal(tradeRequests, 0); assert.equal(await page.locator(".overview-kpis").count(), 0); }
    if (role === "finanzas") assert.equal(tradeRequests, 0);
    if (role === "administrador") {
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
    console.log(`PASS ${role}: responsive layout, data, period, links and access`);
    await context.close();
  }
} finally { await browser.close(); }
