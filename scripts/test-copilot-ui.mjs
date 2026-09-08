import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.COPILOT_UI_URL || "http://localhost:5179";
const env = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const supabaseUrl = env.match(
  /^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m,
)?.[1];
assert.ok(
  supabaseUrl,
  "La prueba necesita VITE_SUPABASE_URL; todas sus peticiones se interceptan con fixtures.",
);
const origin = new URL(supabaseUrl).origin;
const userId = "22222222-2222-4222-8222-222222222222",
  conversationId = "33333333-3333-4333-8333-333333333333",
  messageId = "44444444-4444-4444-8444-444444444444";
const stamp = "2026-09-07T15:00:00Z";
const result = {
  toolName: "get_accounts_receivable",
  domain: "finance",
  status: "ok",
  summary: "Cartera verificada de prueba",
  data: { selected_total_clp: "11287934.0000" },
  warnings: ["Sin fecha de vencimiento no se presume mora."],
  coverage: { complete: true, totalMatched: 17, returned: 2, nextOffset: 2 },
  freshness: { fetchedAt: stamp, sourceObservedAt: stamp },
  evidence: [
    {
      label: "Cuentas por cobrar",
      path: "/finanzas-contabilidad?view=receivables",
      entityType: "finance",
    },
  ],
  table: {
    title: "Documentos pendientes",
    columns: [
      { key: "name", label: "Cliente" },
      { key: "folio", label: "Folio" },
      { key: "balance", label: "Saldo CLP" },
      { key: "source", label: "Fuente" },
    ],
    rows: [
      {
        name: "Empresa de prueba con razon social extensa",
        folio: "1547",
        balance: 123456,
        source: "Facto informado",
      },
      {
        name: "=SUM(A1:A2)",
        folio: "1546",
        balance: 78910,
        source: "CRM conciliado",
      },
    ],
  },
};
const reply = {
  id: messageId,
  role: "assistant",
  content:
    "## Cartera vigente\n\nEl saldo del respaldo es **$11.287.934 CLP**.\n\n- 17 documentos pendientes.\n- Los pagos parciales se mantienen separados.\n\n[Revisar cartera](/finanzas-contabilidad?view=receivables)\n\n[Enlace inventado](https://evil.invalid) <script>alert(1)</script>",
  metadata: { traceId: "fixture-trace", results: [result] },
  created_at: stamp,
};
const financial = {
  ...result,
  toolName: "get_financial_summary",
  summary: "Resumen fixture",
  table: undefined,
  data: {
    summary: {
      bank_clp: 8210126,
      receivables: 11287934,
      payables: 12867255.19,
    },
  },
};
reply.metadata.results.push(financial);
const priceRows = [
  { sku: "ACB-C01", name: "Soporte Muro Pequena", net: 6490, stock: 468, currency: "CLP", list_id: "1", stock_updated_at: stamp, price_updated_at: stamp },
  { sku: "ACB-C03", name: "Soporte Muro Grande", net: 7950, stock: 66, currency: "CLP", list_id: "1", stock_updated_at: stamp, price_updated_at: stamp },
  { sku: "QA-FORMULA", name: "=SUM(A1:A2)", net: 1234.56, stock: 2, currency: "CLP", list_id: "1", stock_updated_at: stamp, price_updated_at: stamp },
];
const priceResult = { ...result, toolName: "get_price_list", domain: "products", summary: "Lista de precios de origen Facto", data: { client_price_list: { complete: true, total: priceRows.length, records: priceRows } },
  coverage: { complete: true, totalMatched: 3, returned: 1, nextOffset: 1 },
  table: { title: "Precios netos y stock", columns: [{ key: "sku", label: "SKU" }, { key: "name", label: "Nombre" }, { key: "net", label: "Precio neto" }, { key: "stock", label: "Stock" }], rows: priceRows.slice(0, 1) },
};
const priceResults = process.env.COPILOT_REAL_PRICE_FIXTURE ? JSON.parse(await readFile(new URL("../test-results/copilot/client-prices-real.json", import.meta.url), "utf8")) : [priceResult];
const priceReply = { ...reply, content: "## Lista de precios\n\nPrecios netos y existencias registradas, sujetos a confirmacion.", metadata: { traceId: "price-fixture", results: [...priceResults, financial] } };
const output = new URL("../test-results/copilot/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
});
const user = {
  id: userId,
  email: "test@example.invalid",
  aud: "authenticated",
  role: "authenticated",
  user_metadata: { full_name: "Usuario de prueba", role: "administrador" },
  created_at: stamp,
};
const payload = Buffer.from(
  JSON.stringify({
    sub: userId,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 86400,
  }),
).toString("base64url");
await context.addInitScript(
  ({ key, user, payload }) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`,
        refresh_token: "fixture",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        expires_in: 86400,
        token_type: "bearer",
        user,
      }),
    );
  },
  {
    key: `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`,
    user,
    payload,
  },
);
let delayMessage = false, priceMode = false, failHealth = false, postRequests = 0,
  exportRequests = 0;
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) {
    if (url.origin !== new URL(base).origin && !url.href.startsWith("data:"))
      return route.abort();
    return route.continue();
  }
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  };
  if (route.request().method() === "OPTIONS")
    return route.fulfill({ status: 204, headers });
  let body = [];
  if (url.pathname.endsWith("/health")) {
    if (failHealth) return route.abort("failed");
    body = { ok: true, engine: "central", contractVersion: 1 };
  }
  if (url.pathname.includes("/auth/v1/user")) body = user;
  if (url.pathname.includes("/profiles"))
    body = {
      id: userId,
      full_name: "Usuario de prueba",
      role: "administrador",
      active: true,
    };
  if (url.pathname.endsWith("/conversations"))
    body = {
      conversations: [
        {
          id: conversationId,
          title: "Revision de cartera y documentos",
          updated_at: stamp,
        },
      ],
    };
  if (url.pathname.endsWith("/history"))
    body = {
      messages: [
        { id: "u1", role: "user", content: "Cuanto queda por cobrar?" },
        reply,
      ],
      nextOffset: null,
    };
  if (url.pathname.endsWith("/export")) {
    exportRequests++;
    body = { message: priceMode ? priceReply : reply };
  }
  if (url.pathname.endsWith("/message")) {
    postRequests++;
    const activeReply = priceMode ? priceReply : reply;
    if (delayMessage) await new Promise((resolve) => setTimeout(resolve, 2500));
    const events = [
      { type: "conversation", conversationId },
      { type: "tool_start", callId: "c1", toolName: "get_accounts_receivable" },
      {
        type: "tool_end",
        callId: "c1",
        toolName: "get_accounts_receivable",
        status: "ok",
      },
      {
        type: "complete",
        conversationId,
        messageId,
        message: activeReply.content,
        traceId: "fixture-trace",
        results: activeReply.metadata.results,
      },
    ];
    return route.fulfill({
      status: 200,
      headers: { ...headers, "Content-Type": "application/x-ndjson" },
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  }
  return route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/copiloto`);
  await page.getByRole("heading", { name: "Copiloto central" }).waitFor();
  await page
    .getByRole("textbox", { name: "Consulta al Copiloto" })
    .fill("Cuanto queda por cobrar?");
  await page
    .getByRole("button", { name: "Enviar consulta", exact: true })
    .click();
  await page.getByRole("heading", { name: "Cartera vigente" }).waitFor();
  assert.equal(await page.locator('a[href="https://evil.invalid"]').count(), 0);
  assert.equal(await page.locator(".cc-markdown script").count(), 0);
  assert.equal(
    await page.getByText("$11.287.934 CLP", { exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-1440.png", output)),
    fullPage: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Descargar Excel", exact: true }).click(),
  ]);
  await download.saveAs(fileURLToPath(new URL("export.xlsx", output)));
  assert.equal(exportRequests, 1);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fileURLToPath(new URL("export.xlsx", output)));
  assert.equal(workbook.getWorksheet("Datos 1").getCell("A5").value, "'=SUM(A1:A2)");
  assert.equal(workbook.getWorksheet("Datos 1").getCell("C4").value, 123456);
  for (const format of ["PDF", "CSV"]) {
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: `Descargar ${format}`, exact: true }).click()]);
    const target = new URL(`export.${format.toLowerCase()}`, output);
    await file.saveAs(fileURLToPath(target));
    const content = await readFile(target);
    if (format === "PDF") assert.equal(content.subarray(0, 5).toString(), "%PDF-");
    else assert.ok(content.toString().includes("'=SUM(A1:A2)"));
  }
  assert.equal(exportRequests, 3);
  for (const width of [1280, 390, 360]) {
    await page.setViewportSize({ width, height: width > 800 ? 900 : 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    assert.equal(overflow, false, `Desborde global a ${width}px`);
    const composer = await page.locator(".cc-composer").boundingBox(),
      main = await page.locator(".cc-main").boundingBox();
    assert.ok(
      composer.x >= main.x - 1 &&
        composer.x + composer.width <= main.x + main.width + 1,
    );
    if (width === 390) {
      await page
        .getByRole("button", { name: "Historial", exact: true })
        .click();
      await page.getByRole("button", { name: /Revision de cartera/ }).click();
      await page.getByRole("heading", { name: "Cartera vigente" }).waitFor();
    }
    await page.screenshot({
      path: fileURLToPath(new URL(`viewport-${width}.png`, output)),
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: "Nueva conversacion", exact: true })
    .click();
  failHealth = true;
  const postsBeforeFailure = postRequests;
  await page.getByRole("textbox", { name: "Consulta al Copiloto" }).fill("soporte muro");
  await page.getByRole("button", { name: "Enviar consulta", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "No se envio la consulta" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Consulta al Copiloto" }).inputValue(), "soporte muro");
  assert.equal(await page.locator(".cc-user").count(), 0);
  assert.equal(postRequests, postsBeforeFailure);
  failHealth = false; priceMode = true;
  await page.getByRole("button", { name: "Enviar consulta", exact: true }).click();
  await page.getByRole("heading", { name: "Lista de precios", exact: true }).waitFor();
  const [priceDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar lista de precios para clientes", exact: true }).click()]);
  const priceFile = new URL(process.env.COPILOT_REAL_PRICE_FIXTURE ? "CLIMACTIVA-lista-precios-real.xlsx" : "client-prices.xlsx", output);
  await priceDownload.saveAs(fileURLToPath(priceFile));
  const priceBook = new ExcelJS.Workbook(); await priceBook.xlsx.readFile(fileURLToPath(priceFile));
  const expectedPrices = priceResults.flatMap((r) => r.data.client_price_list.records);
  assert.equal(priceBook.worksheets.length, new Set(expectedPrices.map((r) => r.currency || "Por confirmar")).size);
  const priceSheet = priceBook.getWorksheet("Precios CLP");
  assert.deepEqual(priceSheet.getRow(4).values.slice(1), ["SKU", "Nombre", "Precio neto CLP", "Stock registrado"]);
  assert.equal(priceSheet.columnCount, 4);
  assert.equal(priceBook.worksheets.reduce((sum, sheet) => sum + sheet.rowCount - 4, 0), expectedPrices.length);
  let containsFormulaGuard = false;
  for (const sheet of priceBook.worksheets) for (let index = 5; index <= sheet.rowCount; index++) {
    const values = sheet.getRow(index).values.slice(1);
    const expected = expectedPrices.find((r) => r.sku === values[0]);
    assert.ok(expected);
    assert.equal(values[2], expected.net ?? "Por confirmar");
    assert.equal(values[3], expected.stock);
    assert.ok(values[3] > 0);
    if (values[1] === "'=SUM(A1:A2)") containsFormulaGuard = true;
  }
  if (!process.env.COPILOT_REAL_PRICE_FIXTURE) assert.ok(containsFormulaGuard);
  assert.ok(!JSON.stringify(priceBook.model).includes("bank_clp"));
  assert.ok(!JSON.stringify(priceBook.model).includes("11287934"));
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width > 800 ? 1000 : 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: fileURLToPath(new URL(`prices-${width}.png`, output)), fullPage: true });
  }
  await page.getByRole("button", { name: "Nueva conversacion", exact: true }).click();
  delayMessage = true;
  await page
    .getByRole("textbox", { name: "Consulta al Copiloto" })
    .fill("Consulta demorada");
  await page
    .getByRole("button", { name: "Enviar consulta", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Detener consulta", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Consulta detenida" })
    .waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "UI Copiloto: escritorio 1440/1280, celular 390/360, Markdown seguro, historial, descarga autorizada y cancelacion verificados con fixtures.",
  );
} finally {
  await context.close();
  await browser.close();
}
