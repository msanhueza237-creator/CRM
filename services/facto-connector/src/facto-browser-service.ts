import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { FactoConnectorConfig } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { parseFactoBrowserTable, type BrowserTableRowSnapshot } from "./normalization.ts";
import type { FactoBrowserReader, FactoBrowserReadResult } from "./types.ts";

type TableSnapshot = { headers: string[]; rows: BrowserTableRowSnapshot[] };

export class FactoBrowserService implements FactoBrowserReader {
  constructor(
    private readonly config: FactoConnectorConfig["browser"],
    private readonly logger: SafeLogger,
  ) {}

  async readUnpaidDocuments(fromDate: string, toDate: string): Promise<FactoBrowserReadResult> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: this.config.headless,
      channel: this.config.channel || undefined,
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: "es-CL",
      timezoneId: "America/Santiago",
      viewport: { width: 1440, height: 1000 },
    });
    let loginPhase = true;
    const blockedRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase();
      if (["DELETE", "PATCH", "PUT"].includes(method) || (!loginPhase && method === "POST")) {
        blockedRequests.push(`${method} ${safeUrl(route.request().url())}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    try {
      await this.login(page);
      loginPhase = false;
      await this.openUnpaidSection(page);
      const dateFiltersApplied = await this.applyDateFiltersIfPresent(page, fromDate, toDate);
      const result = await this.extractAllPages(page);
      if (blockedRequests.length) {
        throw new Error("La página intentó enviar datos durante la lectura. La solicitud fue bloqueada por seguridad.");
      }
      if (dateFiltersApplied) return result;
      return limitFactoBrowserResultToPeriod(result, fromDate, toDate);
    } catch (error) {
      const evidencePath = await this.captureFailureEvidence(page).catch(() => null);
      this.logger.error("Falló la lectura web de Facto.", error, {
        stage: "browser_read",
        evidence_path: evidencePath,
        blocked_requests: blockedRequests.slice(0, 10),
      });
      throw error;
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async login(page: Page) {
    await page.goto(this.config.loginUrl, { waitUntil: "domcontentloaded" });
    await this.detectInteractiveChallenge(page);
    const password = await firstVisible(page, [
      "input[type='password']",
      "input[name*='password' i]",
      "input[id*='password' i]",
      "input[name*='clave' i]",
    ]);
    if (!password) {
      if (await page.getByText(/documentos|facturaci[oó]n|cobranza/i).first().isVisible().catch(() => false)) return;
      throw new Error("No se encontró el formulario de acceso de Facto.");
    }
    const username = await firstVisible(page, [
      "input[type='email']",
      "input[name*='user' i]",
      "input[id*='user' i]",
      "input[name*='email' i]",
      "input[name*='rut' i]",
      "input[type='text']",
    ]);
    if (!username) throw new Error("No se encontró el campo de usuario de Facto.");
    await username.fill(this.config.username);
    await password.fill(this.config.password);
    const submit = await firstVisible(page, ["button[type='submit']", "input[type='submit']"])
      || page.getByRole("button", { name: /ingresar|iniciar sesi[oó]n|acceder/i }).first();
    if (!await submit.isVisible().catch(() => false)) throw new Error("No se encontró el botón de ingreso de Facto.");
    await submit.click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.detectInteractiveChallenge(page);
    if (await password.isVisible().catch(() => false)) {
      const errorText = await page.locator("[role='alert'], .alert-danger, .error").allTextContents().catch(() => []);
      throw new Error(errorText.join(" ").trim() || "Facto no confirmó el inicio de sesión.");
    }
    this.logger.info("Sesión web Facto iniciada en contexto efímero.", { stage: "browser_auth", authenticated: true });
  }

  private async openUnpaidSection(page: Page) {
    if (this.config.unpaidUrl) {
      await page.goto(this.config.unpaidUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
      const collections = page.getByRole("link", { name: /^cobranza$/i }).first();
      if (!await collections.isVisible().catch(() => false)) throw new Error("No se encontró el módulo Cobranza en Facto.");
      await collections.click();
      const unpaid = page.getByRole("link", { name: /documentos impagos|cuentas por cobrar|documentos pendientes/i }).first();
      if (!await unpaid.isVisible().catch(() => false)) throw new Error("No se encontró la sección Documentos Impagos en Facto.");
      await unpaid.click();
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.detectInteractiveChallenge(page);
    const headingVisible = await page.getByText(/documentos impagos|cuentas por cobrar|documentos pendientes/i).first().isVisible().catch(() => false);
    if (!headingVisible) throw new Error("Facto abrió una página distinta de Documentos Impagos.");
    this.logger.info("Sección Facto abierta.", { stage: "browser_navigation", section: "Documentos impagos" });
  }

  private async applyDateFiltersIfPresent(page: Page, fromDate: string, toDate: string) {
    const from = await dateInput(page, /desde|fecha inicial|emisi[oó]n desde/i);
    const to = await dateInput(page, /hasta|fecha final|emisi[oó]n hasta/i);
    if (!from || !to) {
      this.logger.warn("Facto no mostró filtros de fecha reconocibles; la API limitará el período y la web solo aportará saldos.", {
        stage: "browser_filters",
      });
      return false;
    }
    await from.fill(fromDate);
    await to.fill(toDate);
    const search = page.getByRole("button", { name: /buscar|filtrar|consultar/i }).first();
    if (await search.isVisible().catch(() => false)) await search.click();
    await page.waitForLoadState("networkidle", { timeout: Math.min(this.config.timeoutMs, 5_000) }).catch(async () => {
      await page.waitForTimeout(500);
    });
    return true;
  }

  private async extractAllPages(page: Page): Promise<FactoBrowserReadResult> {
    const collected: BrowserTableRowSnapshot[] = [];
    let headers: string[] = [];
    let pagesRead = 0;
    let complete = false;
    let previousSignature = "";
    let pageText = "";
    for (let pageNumber = 1; pageNumber <= this.config.maxPages; pageNumber += 1) {
      const snapshot = await bestFactoTable(page);
      if (!snapshot) throw new Error("No se encontró una tabla de documentos impagos reconocible.");
      if (!headers.length) headers = snapshot.headers;
      const signature = tableSignature(snapshot);
      if (signature === previousSignature) throw new Error("La paginación de Facto no avanzó; se abortó para evitar una lectura incompleta.");
      previousSignature = signature;
      collected.push(...snapshot.rows);
      pagesRead += 1;
      pageText = await page.locator("body").innerText().catch(() => "");
      const next = await nextPageControl(page);
      if (!next || await locatorDisabled(next)) {
        complete = true;
        break;
      }
      await next.click();
      await waitForTableChange(page, signature, this.config.timeoutMs);
    }
    const expectedRows = expectedRowCount(pageText);
    const rows = parseFactoBrowserTable(headers, collected);
    if (expectedRows !== null && rows.length < expectedRows) complete = false;
    const verifiedZero = complete && rows.length === 0 && /sin (documentos|resultados|registros)|no se encontraron|0\s+(documentos|registros)/i.test(pageText);
    return {
      section: "Documentos impagos",
      rows,
      pagesRead,
      expectedRows,
      complete,
      verifiedZero,
      warnings: complete ? [] : ["La navegación terminó sin comprobar la última página de Facto."],
    };
  }

  private async detectInteractiveChallenge(page: Page) {
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 20_000);
    if (/captcha|verifica que eres humano|c[oó]digo de verificaci[oó]n|autenticaci[oó]n de dos factores|2fa|mfa/i.test(text)) {
      throw new Error("Facto solicitó una verificación interactiva. La lectura se detuvo sin modificar información.");
    }
  }

  private async captureFailureEvidence(page: Page) {
    await mkdir(this.config.evidenceDir, { recursive: true });
    const file = path.resolve(this.config.evidenceDir, `facto-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }
}

export function limitFactoBrowserResultToPeriod(
  result: FactoBrowserReadResult,
  fromDate: string,
  toDate: string,
): FactoBrowserReadResult {
  const invalidDateRows = result.rows.filter((row) => !row.issuedOn).length;
  const periodRows = result.rows.filter((row) => row.issuedOn >= fromDate && row.issuedOn <= toDate);
  const complete = result.complete && invalidDateRows === 0;
  return {
    ...result,
    rows: periodRows,
    expectedRows: complete ? periodRows.length : null,
    complete,
    verifiedZero: complete && periodRows.length === 0,
    warnings: [
      ...result.warnings,
      "Facto no ofreció filtros de fecha; el conector leyó toda la cartera y limitó el período localmente.",
      ...(invalidDateRows > 0 ? [`${invalidDateRows} fila(s) sin fecha impidieron certificar la cobertura completa.`] : []),
    ],
  };
}

async function firstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function dateInput(page: Page, name: RegExp) {
  const labelled = page.getByLabel(name).first();
  if (await labelled.isVisible().catch(() => false)) return labelled;
  return null;
}

async function bestFactoTable(page: Page): Promise<TableSnapshot | null> {
  const snapshots = await page.locator("table").evaluateAll((tables) => tables.map((table) => {
    const headers = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim() || "");
    const rowElements = [...table.querySelectorAll("tbody tr")];
    const rows = rowElements.map((row) => {
      const link = row.querySelector("a[href]") as HTMLAnchorElement | null;
      const element = row as HTMLElement;
      return {
        cells: [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() || ""),
        externalId: element.dataset.documentId || element.dataset.id || null,
        href: link?.href || null,
      };
    });
    return { headers, rows };
  }));
  return snapshots
    .map((snapshot) => ({ snapshot, score: tableScore(snapshot.headers) }))
    .filter(({ score }) => score >= 3)
    .sort((left, right) => right.score - left.score)[0]?.snapshot || null;
}

function tableScore(headers: string[]) {
  const value = headers.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return ["folio", "saldo", "cliente", "rut", "vencimiento", "monto"].reduce((score, token) => score + Number(value.includes(token)), 0);
}

async function nextPageControl(page: Page) {
  const controls = [
    page.getByRole("button", { name: /siguiente|next/i }).last(),
    page.getByRole("link", { name: /siguiente|next/i }).last(),
    page.locator(".pagination .next, [aria-label*='siguiente' i], [aria-label*='next' i]").last(),
  ];
  for (const control of controls) if (await control.isVisible().catch(() => false)) return control;
  return null;
}

async function locatorDisabled(locator: Locator) {
  if (await locator.isDisabled().catch(() => false)) return true;
  const ariaDisabled = await locator.getAttribute("aria-disabled").catch(() => null);
  const className = await locator.getAttribute("class").catch(() => "");
  return ariaDisabled === "true" || /disabled/.test(className || "");
}

async function waitForTableChange(page: Page, previousSignature: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250);
    const next = await bestFactoTable(page);
    if (next && tableSignature(next) !== previousSignature) return;
  }
  throw new Error("Facto no confirmó el cambio de página dentro del tiempo permitido.");
}

function tableSignature(snapshot: TableSnapshot) {
  return JSON.stringify(snapshot.rows.slice(0, 3).map((row) => row.cells));
}

function expectedRowCount(text: string) {
  const patterns = [
    /mostrando\s+\d+\s+(?:a|-)\s+\d+\s+de\s+([\d.]+)/i,
    /(?:total|registros|documentos)\s*:?\s*([\d.]+)/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.replace(/\./g, "");
    if (value && Number.isInteger(Number(value))) return Number(value);
  }
  return null;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "URL no disponible";
  }
}
