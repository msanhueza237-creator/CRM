import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.PROSPECTING_UI_URL || "http://127.0.0.1:5190";
const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const dbUrl = env.match(/^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
assert.ok(dbUrl);
const dbOrigin = new URL(dbUrl).origin;
const fakeKey = "sk-fixture-ui-not-a-real-secret";
const initial = () => ({ provider: "deepseek", ready: true, configured: false, status: "disconnected", models: [], lastCheckedAt: null, lastErrorCode: null, scope: "search_assistance" });
await mkdir("outputs/deepseek-settings", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const role of ["administrador", "vendedor", "visualizador"]) {
    const context = await browser.newContext();
    const user = { id: "22222222-2222-4222-8222-222222222222", email: "qa@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: { full_name: "Prueba", role } };
    const payload = Buffer.from(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
    await context.addInitScript(({ user, payload, storageKey }) => localStorage.setItem(storageKey, JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`, refresh_token: "fixture", expires_at: Math.floor(Date.now() / 1000) + 86400, expires_in: 86400, token_type: "bearer", user })), { user, payload, storageKey: `sb-${new URL(dbUrl).hostname.split(".")[0]}-auth-token` });
    let state = initial(), failure = false, setupFailure = false, demo = false;
    const calls = [], mutations = [];
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== dbOrigin) return url.origin === new URL(base).origin ? route.continue() : route.abort();
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Expose-Headers": "Content-Range", "Content-Range": "0-0/0" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let body = [];
      if (url.pathname.includes("/profiles")) body = { id: user.id, role, full_name: "Prueba", active: true };
      if (url.pathname.includes("/auth/v1/user")) body = user;
      if (url.pathname.includes("/geo_regions")) body = demo ? [] : [{ code: "13", name: "Metropolitana", active: true }];
      if (url.pathname.includes("/geo_comunas")) body = demo ? [] : [{ code: "13101", region_code: "13", name: "Santiago", active: true }];
      if (request.method() !== "GET" && request.method() !== "HEAD") mutations.push(url.pathname);
      if (url.pathname.includes("/prospecting-integrations/")) {
        const action = url.pathname.split("/").at(-1); calls.push(action);
        if (setupFailure) return route.fulfill({ status: 503, headers, body: JSON.stringify({ error: "Falta habilitar el almacenamiento seguro en el servidor." }) });
        if (action === "save") {
          assert.equal(request.postDataJSON().apiKey, fakeKey);
          if (failure) return route.fulfill({ status: 422, headers, body: JSON.stringify({ error: "DeepSeek rechazó la clave. Revísala o genera una nueva." }) });
          state = { ...state, configured: true, status: "verified", models: ["model-fixture"], lastCheckedAt: "2026-09-09T17:15:00Z" };
        }
        if (action === "verify") { assert.equal(request.postData(), null); state = { ...state, status: "verified" }; }
        if (action === "disconnect") state = initial();
        body = state;
      }
      return route.fulfill({ status: 200, headers, body: request.method() === "HEAD" ? "" : JSON.stringify(body) });
    });
    const page = await context.newPage();
    const pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${base}/prospeccion`);
    await page.getByRole("tab", { name: "Base histórica" }).waitFor();
    if (role !== "administrador") {
      assert.equal(await page.getByRole("tab", { name: "DeepSeek API" }).count(), 0);
      assert.deepEqual(calls, []);
    } else {
      const open = async () => { await page.getByRole("tab", { name: "DeepSeek API" }).click(); await page.getByRole("button", { name: "Actualizar estado" }).waitFor(); };
      await open();
      const field = page.locator("#deepseek-api-key");
      await page.waitForFunction(() => !document.querySelector("#deepseek-api-key")?.disabled);
      assert.deepEqual(calls.filter(c => c !== "status"), []);
      for (const width of [1440, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `overflow ${width}`);
        const smallTargets = await page.locator(".deepseek-settings button").evaluateAll(buttons => buttons.filter(b => b.getBoundingClientRect().height < 43).length);
        assert.equal(smallTargets, 0);
        await page.screenshot({ path: `outputs/deepseek-settings/disconnected-${width}.png`, fullPage: true });
      }
      assert.equal(await field.getAttribute("type"), "password");
      await field.fill(fakeKey);
      await page.getByRole("button", { name: "Mostrar clave" }).click();
      assert.equal(await field.getAttribute("type"), "text");
      await page.getByRole("button", { name: "Ocultar clave" }).click();
      await page.getByRole("button", { name: "Guardar y verificar" }).click();
      await page.getByText("Credencial verificada. La asistencia depende de la configuración de cada campaña.", { exact: true }).waitFor();
      assert.equal(await field.inputValue(), "");
      assert.equal(await page.evaluate(key => JSON.stringify(localStorage).includes(key) || JSON.stringify(sessionStorage).includes(key), fakeKey), false);
      assert.match(await page.locator(".deepseek-details").innerText(), /Opcional por campaña/);
      await page.getByRole("button", { name: "Verificar conexión" }).click();
      await page.waitForFunction(() => !document.querySelector("#deepseek-api-key")?.disabled);
      failure = true;
      await field.fill(fakeKey); await page.getByRole("button", { name: "Guardar y verificar" }).click();
      await page.getByRole("alert").waitFor();
      assert.match(await page.locator(".deepseek-status").innerText(), /Credencial verificada/);
      assert.equal(state.configured, true);
      await page.getByRole("button", { name: "Desconectar", exact: true }).click();
      await page.getByRole("button", { name: "Cancelar eliminación" }).click();
      assert.equal(state.configured, true);
      await page.getByRole("button", { name: "Desconectar", exact: true }).click();
      await page.getByRole("button", { name: "Eliminar clave", exact: true }).click();
      await page.getByText("Clave eliminada del CRM.", { exact: true }).waitFor();
      assert.equal(state.configured, false);
      assert.equal(await field.inputValue(), "");
      state.ready = false;
      await page.getByRole("button", { name: "Actualizar estado" }).click();
      await page.getByText("Instalación pendiente", { exact: true }).waitFor();
      assert.equal(await field.isDisabled(), true);
      setupFailure = true;
      await page.getByRole("button", { name: "Actualizar estado" }).click();
      await page.getByRole("alert").waitFor();
      await page.screenshot({ path: "outputs/deepseek-settings/setup-error-360.png", fullPage: true });
      demo = true;
      await page.reload(); await open();
      assert.equal(await field.isDisabled(), true);
      assert.match(await page.locator(".deepseek-status").innerText(), /No disponible en demo/);
      assert.ok(mutations.every(path => path.includes("/prospecting-integrations/")), "no candidates, runs or campaigns mutated");
    }
    assert.deepEqual(pageErrors, []);
    console.log(`PASS ${role}: permissions, scoped settings and responsive UI`);
    await context.close();
  }
} finally { await browser.close(); }
