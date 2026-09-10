import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.PROSPECTING_UI_URL || "http://127.0.0.1:5190";
const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const dbUrl = env.match(/^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
assert.ok(dbUrl);
const dbOrigin = new URL(dbUrl).origin;
const cid = "11111111-1111-4111-8111-111111111111", rid = "33333333-3333-4333-8333-333333333333";
await mkdir("outputs/prospecting-assistance", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const role of ["administrador", "vendedor", "visualizador"]) {
    const context = await browser.newContext();
    const user = { id: "22222222-2222-4222-8222-222222222222", email: "qa@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: { full_name: "Prueba", role } };
    const payload = Buffer.from(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
    await context.addInitScript(({ user, payload, storageKey }) => localStorage.setItem(storageKey, JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 86400, token_type: "bearer", user })), { user, payload, storageKey: `sb-${new URL(dbUrl).hostname.split(".")[0]}-auth-token` });
    let campaign = { id: cid, name: "Climatización Santiago", status: "active", description: "Servicio técnico", keywords: ["climatizacion"], sources: ["brave_search", "official_website"], region_codes: ["13"], comuna_codes: ["13101"], target_types: ["tecnico"], version: 1, candidate_limit: 20, result_limit_per_query: 5, created_by: user.id, updated_at: "2026-09-10T10:00:00Z", deepseek_enabled: false };
    const second = { ...campaign, id: "44444444-4444-4444-8444-444444444444", name: "Refrigeración Valdivia", keywords: ["refrigeracion"], status: "draft", updated_at: "2026-09-09T10:00:00Z" };
    const run = { id: rid, campaign_id: cid, status: "completed", created_at: "2026-09-10T10:00:00Z", total_tasks: 1, completed_tasks: 1, candidates_found: 0,
      snapshot: { deepseek_enabled: true, campaign: { crm_campaign_id: cid, name: campaign.name, keywords: campaign.keywords, sources: campaign.sources, target_types: ["tecnico"], territories: [{ region_code: "13", region_name: "Metropolitana", comuna_code: "13101", comuna_name: "Santiago" }] } },
      search_assistance: { status: "applied", mode: "web_discovery_v1", model: "deepseek-v4-flash", discovered_websites: 10, web_requests: 2, completed_at: "2026-09-10T10:00:03Z", queries: ["empresas climatizacion Santiago"], discoveries: [{ name: "Clima Andes", website: "https://climaandes.cl/" }] } };
    const mutations = [], external = [];
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== dbOrigin) {
        if (url.origin === new URL(base).origin) return route.continue();
        external.push(url.origin); return route.abort();
      }
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range", "Content-Range": "0-0/0" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let body = [];
      if (url.pathname.includes("/profiles")) body = { id: user.id, role, full_name: "Prueba", active: true };
      if (url.pathname.includes("/auth/v1/user")) body = user;
      if (url.pathname.includes("/geo_regions")) body = [{ code: "13", name: "Metropolitana", active: true }];
      if (url.pathname.includes("/geo_comunas")) body = [{ code: "13101", region_code: "13", name: "Santiago", active: true }];
      if (url.pathname.includes("/prospecting_campaigns")) {
        if (request.method() === "PATCH") { campaign = { ...campaign, ...request.postDataJSON(), version: 2 }; body = campaign; }
        else body = [campaign, second];
      }
      if (url.pathname.includes("/prospecting_runs")) body = [run];
      if (url.pathname.includes("/crm-copilot/")) body = { conversations: [] };
      if (!["GET", "HEAD"].includes(request.method())) mutations.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 200, headers, body: request.method() === "HEAD" ? "" : JSON.stringify(body) });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/prospeccion`);
    await page.getByRole("tab", { name: "Base histórica" }).waitFor();
    await page.getByPlaceholder("Nombre, término o comuna").fill("climatizacion");
    assert.equal(await page.locator(".prospecting-campaign-card").count(), 1);
    await page.getByPlaceholder("Nombre, término o comuna").fill("sin coincidencias");
    await page.getByText("Sin coincidencias", { exact: true }).waitFor();
    await page.getByPlaceholder("Nombre, término o comuna").fill("");
    await page.getByLabel("Estado", { exact: true }).selectOption("draft");
    assert.equal(await page.locator(".prospecting-campaign-card").count(), 1);
    await page.getByLabel("Estado", { exact: true }).selectOption("all");
    await page.getByLabel("Orden", { exact: true }).selectOption("name");
    assert.match(await page.locator(".prospecting-campaign-card").first().innerText(), /Climatización/);
    if (role === "administrador") {
      for (const width of [1440, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `campaign overflow ${width}`);
        await page.screenshot({ path: `outputs/prospecting-assistance/campaigns-${width}.png`, fullPage: true });
      }
      await page.getByRole("button", { name: "Editar definición" }).click();
      await page.getByRole("checkbox", { name: /DeepSeek Web/ }).check();
      await page.getByRole("checkbox", { name: /DeepSeek Web/ }).scrollIntoViewIfNeeded();
      const checkbox = await page.getByRole("checkbox", { name: /DeepSeek Web/ }).boundingBox();
      assert.ok(checkbox.width <= 24 && checkbox.height <= 24, "checkbox must retain compact stable dimensions");
      await page.screenshot({ path: "outputs/prospecting-assistance/edit-mobile.png" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, "form overflow");
      await page.getByRole("button", { name: "Guardar nueva versión" }).click();
      await page.waitForFunction(() => !document.querySelector(".prospecting-ai-option"));
      assert.equal(campaign.deepseek_enabled, true);
      assert.deepEqual(campaign.keywords, ["climatizacion"]);
      assert.equal(mutations.length, 1); assert.equal(mutations[0].path, "/rest/v1/prospecting_campaigns");
    }
    if (role === "visualizador") assert.equal(await page.getByRole("button", { name: "Editar definición" }).count(), 0);
    await page.goto(`${base}/prospeccion?view=operation&run=${rid}`);
    await page.getByRole("heading", { name: "DeepSeek Web · búsqueda realizada" }).waitFor();
    await page.getByText("Sitios descubiertos", { exact: true }).waitFor();
    await page.getByText("Consultas realizadas", { exact: true }).click();
    await page.getByText("empresas climatizacion Santiago", { exact: true }).waitFor();
    await page.getByText("Origen de los hallazgos · no acredita aprobación", { exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "Clima Andes", exact: true }).getAttribute("href"), "https://climaandes.cl/");
    if (role === "administrador") {
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `operation overflow ${width}`);
        await page.locator(".prospecting-assistance").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `outputs/prospecting-assistance/operation-${width}.png` });
      }
      await page.getByRole("link", { name: "Analizar en Copiloto" }).click();
      await page.getByPlaceholder("Pregunta sobre tu negocio...").waitFor();
      assert.match(await page.getByPlaceholder("Pregunta sobre tu negocio...").inputValue(), new RegExp(rid));
      assert.equal(mutations.length, 1, "Copilot link must only prepare a draft, never execute");
    }
    assert.deepEqual(errors, []); assert.ok(!external.includes("https://api.deepseek.com"));
    console.log(`PASS ${role}: filters, opt-in, run evidence, mobile layout and Copilot handoff`);
    await context.close();
  }
} finally { await browser.close(); }
