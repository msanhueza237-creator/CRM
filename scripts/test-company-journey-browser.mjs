import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const origin = process.env.COMPANY_QA_URL || "http://127.0.0.1:5197";
await mkdir("tmp/company-journey-qa", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const width of [1440, 768, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/functions/v1/**", () => assert.fail("La prueba no debe consultar produccion"));
    await page.goto(`${origin}/scripts/fixtures/company-journey.html`);
    await page.getByText("Factura 1500", { exact: true }).waitFor();
    assert.equal(await page.locator(".company-journey-events > li").count(), 20);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width, JSON.stringify(dimensions));
    await page.screenshot({ path: `tmp/company-journey-qa/${width}.png`, fullPage: true });
    await page.screenshot({ path: `tmp/company-journey-qa/${width}-viewport.png` });
    await page.getByRole("tab", { name: "Todo", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "Pedidos", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "Pedidos", exact: true }).click();
    await page.getByText("Pedido 12", { exact: true }).waitFor();
    assert.equal(await page.locator(".company-journey-events > li").count(), 1);
    await page.getByRole("tab", { name: "Cotizaciones", exact: true }).click();
    await page.getByRole("button", { name: "Pagina siguiente de historial" }).click();
    await page.getByText("21–23 de 23", { exact: true }).waitFor();
    assert.equal(await page.locator(".company-journey-events > li").count(), 3);
    await page.getByRole("textbox", { name: "Buscar en historial comercial" }).fill("Facto 222");
    await page.getByText("1–1 de 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Registrar cotizacion" }).click();
    assert.equal(await page.getByLabel("Resultado de prueba").textContent(), "quote");
    await page.getByRole("textbox", { name: "Buscar en historial comercial" }).fill("sin-coincidencias");
    await page.getByText("Sin coincidencias verificadas para estos filtros.", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Buscar en historial comercial" }).fill("error");
    await page.getByText("Fuente no disponible", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Ficha: 1440/768/390/360px, sin desbordes, tabs, busqueda, paginacion, referencias, vacio y error verificados con datos ficticios.");
} finally { await browser.close(); }
