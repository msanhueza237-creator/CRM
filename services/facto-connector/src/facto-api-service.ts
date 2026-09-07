import type { FactoConnectorConfig } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { normalizeFactoApiDocument } from "./normalization.ts";
import type { FactoApiDocument, FactoApiReadResult, FactoApiReader } from "./types.ts";

export class FactoApiService implements FactoApiReader {
  private accessToken = "";

  constructor(
    private readonly config: FactoConnectorConfig["api"],
    private readonly logger: SafeLogger,
  ) {}

  async readIssuedDocuments(fromDate: string, toDate: string): Promise<FactoApiReadResult> {
    const documents: FactoApiDocument[] = [];
    let page = 1;
    let pagesRead = 0;
    let pageCount = 1;
    let totalItems = 0;
    let rawDocumentsRead = 0;
    let missingIssueDates = 0;
    let prematurelyEmpty = false;
    do {
      const result = await this.getDocumentsPage(fromDate, toDate, page);
      pagesRead += 1;
      pageCount = Math.max(1, integer(result.page_count, page));
      totalItems = Math.max(totalItems, integer(result.total_items, 0));
      const rawDocuments = documentsFromResponse(result);
      const normalizedDocuments = rawDocuments.map((document) => normalizeFactoApiDocument(document, this.config.currencyMap));
      rawDocumentsRead += rawDocuments.length;
      missingIssueDates += normalizedDocuments.filter((document) => !document.issuedOn).length;
      documents.push(...normalizedDocuments.filter((document) => document.issuedOn >= fromDate && document.issuedOn <= toDate));
      this.logger.info("Página API Facto leída.", {
        stage: "api_documents",
        page,
        page_count: pageCount,
        documents: rawDocuments.length,
      });
      if (!rawDocuments.length) {
        prematurelyEmpty = page < pageCount;
        break;
      }
      if (page >= pageCount) break;
      page += 1;
      if (page > 500) throw new Error("Facto API superó el límite seguro de 500 páginas.");
    } while (true);
    return {
      documents,
      pageCount,
      pagesRead,
      totalItems: totalItems || documents.length,
      issuedFlag: this.config.issuedFlag,
      complete: !prematurelyEmpty
        && pagesRead >= pageCount
        && (totalItems <= 0 || rawDocumentsRead >= totalItems)
        && missingIssueDates === 0,
    };
  }

  private async getDocumentsPage(fromDate: string, toDate: string, page: number) {
    if (!this.accessToken) await this.authenticate();
    const url = new URL(`${this.config.baseUrl}/documents`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    url.searchParams.set("issue_date_from", fromDate);
    url.searchParams.set("issue_date_to", toDate);
    url.searchParams.set("received_issued_flag", this.config.issuedFlag);
    url.searchParams.set("order_by", "asc");
    let response = await this.fetch(url, { method: "GET", headers: this.apiHeaders() });
    if (response.status === 401) {
      this.accessToken = "";
      await this.authenticate();
      response = await this.fetch(url, { method: "GET", headers: this.apiHeaders() });
    }
    if (!response.ok) throw new Error(`Facto API rechazó la lectura de documentos (${response.status}).`);
    return await response.json() as Record<string, unknown>;
  }

  private async authenticate() {
    const response = await this.fetch(new URL(`${this.config.baseUrl}/auth`), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "password",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        username: this.config.resourceOwnerName,
        password: this.config.resourceOwnerPassword,
      }),
    });
    if (!response.ok) throw new Error(`Facto API rechazó la autenticación (${response.status}).`);
    const payload = await response.json() as Record<string, unknown>;
    const token = String(payload.access_token || "").trim();
    if (!token) throw new Error("Facto API no entregó un token de acceso.");
    this.accessToken = token;
    this.logger.info("Autenticación API Facto confirmada.", { stage: "api_auth", authenticated: true });
  }

  private apiHeaders() {
    return { Accept: "application/json", Authorization: `Bearer ${this.accessToken}` };
  }

  private async fetch(url: URL, init: RequestInit) {
    const maxRetries = this.config.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await globalThis.fetch(url, { ...init, redirect: "error", signal: controller.signal });
        if (!isTransientStatus(response.status) || attempt >= maxRetries) return response;
        const waitMs = retryDelayMs(
          response.headers.get("retry-after"),
          attempt,
          this.config.retryBaseMs ?? 1_000,
          this.config.maxRetryDelayMs ?? 60_000,
        );
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn("Facto API respondió con un error temporal; se reintentará la lectura.", {
          stage: "api_retry",
          status: response.status,
          attempt: attempt + 1,
          max_retries: maxRetries,
          wait_ms: waitMs,
        });
        await delay(waitMs);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (attempt >= maxRetries) throw new Error("Facto API agotó el tiempo de espera.");
          const waitMs = retryDelayMs(null, attempt, this.config.retryBaseMs ?? 1_000, this.config.maxRetryDelayMs ?? 60_000);
          this.logger.warn("Facto API agotó el tiempo de espera; se reintentará la lectura.", {
            stage: "api_retry",
            attempt: attempt + 1,
            max_retries: maxRetries,
            wait_ms: waitMs,
          });
          await delay(waitMs);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Facto API no respondió después de los reintentos configurados.");
  }
}

function integer(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function documentsFromResponse(result: Record<string, unknown>) {
  if (Array.isArray(result.documents)) return result.documents;
  const embedded = objectValue(result._embedded);
  if (Array.isArray(embedded.documents)) return embedded.documents;
  if (Array.isArray(result.data)) return result.data;
  const data = objectValue(result.data);
  return Array.isArray(data.documents) ? data.documents : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isTransientStatus(status: number) {
  return [429, 502, 503, 504].includes(status);
}

function retryDelayMs(header: string | null, attempt: number, baseMs: number, maximumMs: number) {
  const retryAfter = retryAfterMs(header);
  if (retryAfter !== null) return Math.min(Math.max(retryAfter, 0), maximumMs);
  return Math.min(baseMs * (2 ** attempt), maximumMs);
}

function retryAfterMs(value: string | null) {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
