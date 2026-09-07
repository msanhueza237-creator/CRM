import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadFactoApiConfig, loadFactoConnectorConfig } from "./config.ts";
import { FactoApiService } from "./facto-api-service.ts";
import { FactoBrowserService } from "./facto-browser-service.ts";
import { FactoSyncService } from "./facto-sync-service.ts";
import { SafeLogger } from "./logger.ts";
import type { FactoApiReadResult, FactoSyncPreview, JsonObject, JsonValue } from "./types.ts";

const options = parseArguments(process.argv.slice(2));
const observedAt = new Date().toISOString();
const logger = new SafeLogger({
  service: "facto-phase4-diagnostic",
  mode: "dry_run",
  writes_enabled: false,
});

await run().catch(async (error) => {
  const message = safeErrorMessage(error);
  const report = {
    phase: 4,
    mode: "dry_run",
    status: "blocked",
    period: { from_date: options.fromDate, to_date: options.toDate },
    observed_at: observedAt,
    error: { code: classifyError(message), message },
    safety: zeroWrites(),
  } satisfies JsonObject;
  const reportPath = await saveReport(report, options.reportDir, observedAt);
  logger.error("La prueba controlada de Facto se detuvo sin modificar datos.", error, {
    stage: "phase4_blocked",
    report_path: reportPath,
  });
  process.exitCode = 2;
});

async function run() {
  const apiConfig = loadFactoApiConfig();
  const api = new FactoApiService(apiConfig, logger);
  if (!options.withBrowser) {
    const apiResult = await api.readIssuedDocuments(options.fromDate, options.toDate);
    const report = apiOnlyReport(apiResult);
    const reportPath = await saveReport(report, options.reportDir, observedAt);
    logger.info("Prueba API Facto terminada sin escribir en el CRM.", {
      stage: "phase4_api_complete",
      documents: apiResult.documents.length,
      complete: apiResult.complete,
      report_path: reportPath,
    });
    return;
  }

  const config = loadFactoConnectorConfig();
  const sync = new FactoSyncService(
    api,
    new FactoBrowserService(config.browser, logger),
    logger,
  );
  const preview = await sync.previewReceivables(options.fromDate, options.toDate);
  const report = fullPreviewReport(preview);
  const reportPath = await saveReport(report, options.reportDir, observedAt);
  logger.info("Prueba completa Facto terminada sin escribir en el CRM.", {
    stage: "phase4_preview_complete",
    documents: preview.items.length,
    complete: preview.coverage.complete,
    report_path: reportPath,
  });
}

function apiOnlyReport(result: FactoApiReadResult): JsonObject {
  const invalid = result.documents.filter((document) => document.validationErrors.length > 0);
  const documentTypes = countBy(result.documents.map((document) => document.documentType));
  return {
    phase: 4,
    mode: "dry_run",
    status: result.complete ? "api_verified_browser_pending" : "partial",
    period: { from_date: options.fromDate, to_date: options.toDate },
    observed_at: observedAt,
    opened: {
      source: "Facto API",
      endpoint: "/documents",
      direction_flag: result.issuedFlag,
      browser_section: "Pendiente de validar Documentos Impagos",
    },
    found: {
      documents: result.documents.length,
      page_count: result.pageCount,
      pages_read: result.pagesRead,
      total_items: result.totalItems,
      complete: result.complete,
      by_document_type: documentTypes,
      requiring_review: invalid.length,
    },
    crm_comparison: {
      performed: false,
      reason: "La comparación crear/actualizar se realiza al enviar esta lectura al staging local del CRM.",
      new_records: null,
      records_to_update: null,
      doubtful_matches: invalid.length,
      possible_duplicates: null,
    },
    sample: result.documents.slice(0, options.sampleLimit).map((document) => ({
      external_id: document.externalId,
      document_type: document.documentType,
      folio: document.folio,
      customer_tax_id: document.customerTaxId,
      customer_name: document.customerName,
      issued_on: document.issuedOn,
      currency: document.currency,
      net_amount: document.netAmount,
      tax_amount: document.taxAmount,
      total_amount: document.originalAmount,
      total_amount_clp: document.originalAmountClp,
      validation_errors: document.validationErrors,
    })),
    safety: zeroWrites(),
  };
}

function fullPreviewReport(preview: FactoSyncPreview): JsonObject {
  const doubtful = preview.items.filter((item) => item.validation_errors.length > 0);
  const possibleDuplicates = preview.items.filter((item) => item.validation_errors.some((error) => /multiple|duplicate|conflicting/.test(error)));
  return {
    phase: 4,
    mode: "dry_run",
    status: preview.coverage.complete && doubtful.length === 0 ? "preview_ready" : "review_required",
    period: { from_date: options.fromDate, to_date: options.toDate },
    observed_at: observedAt,
    opened: {
      source: "Facto API + navegador de solo lectura",
      browser_section: preview.coverage.section,
    },
    found: {
      api_documents: preview.apiDocuments,
      browser_rows: preview.browserRows,
      preview_items: preview.items.length,
      overdue_documents: preview.overdueDocuments,
      partial_payment_documents: preview.partialPaymentDocuments,
      coverage: preview.coverage,
    },
    crm_comparison: {
      performed: false,
      reason: "Las acciones crear/actualizar se calculan en staging; este comando no se conecta a Supabase.",
      new_records: null,
      records_to_update: null,
      doubtful_matches: doubtful.length,
      possible_duplicates: possibleDuplicates.length,
    },
    sample: preview.items.slice(0, options.sampleLimit).map((item) => ({
      canonical_key: item.canonical_key,
      document_type: item.normalized.document_type,
      folio: item.normalized.folio,
      customer_tax_id: item.normalized.customer_tax_id,
      customer_name: item.normalized.customer_name,
      issued_on: item.normalized.issued_on,
      due_on: item.normalized.due_on,
      original_amount_clp: item.normalized.original_amount_clp,
      outstanding_amount_clp: item.normalized.outstanding_amount_clp,
      reported_paid_amount_clp: item.normalized.reported_paid_amount_clp,
      status: item.normalized.status,
      api_verified: item.normalized.api_verified,
      browser_verified: item.normalized.browser_verified,
      closure_evidence: item.normalized.closure_evidence,
      validation_errors: item.validation_errors,
    })),
    warnings: preview.warnings,
    safety: zeroWrites(),
  };
}

function parseArguments(args: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Argumento no reconocido: ${argument}`);
    if (argument === "--with-browser") {
      values.set(argument, "true");
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Falta un valor para ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const fromDate = values.get("--from") || `${today.slice(0, 4)}-01-01`;
  const toDate = values.get("--to") || today;
  validateDateRange(fromDate, toDate, today);
  const rawLimit = Number(values.get("--sample") || 25);
  return {
    fromDate,
    toDate,
    withBrowser: values.get("--with-browser") === "true",
    sampleLimit: Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25,
    reportDir: values.get("--report-dir") || process.env.FACTO_EVIDENCE_DIR?.trim() || ".facto-evidence",
  };
}

function validateDateRange(fromDate: string, toDate: string, today: string) {
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(fromDate) || !valid.test(toDate)) throw new Error("Las fechas deben usar el formato AAAA-MM-DD.");
  if (fromDate > toDate) throw new Error("La fecha inicial no puede ser posterior a la fecha final.");
  if (toDate > today) throw new Error("La prueba no puede consultar un período futuro.");
}

function countBy(values: string[]): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const value of values) result[value] = Number(result[value] || 0) + 1;
  return result;
}

async function saveReport(report: JsonObject, directory: string, timestamp: string) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const suffix = timestamp.replace(/[:.]/g, "-");
  const target = path.join(targetDirectory, `facto-phase4-dry-run-${suffix}.json`);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return target;
}

function zeroWrites(): JsonObject {
  return {
    facto_mutations: 0,
    crm_records_created: 0,
    crm_records_updated: 0,
    bank_transactions_created: 0,
    reconciliations_created: 0,
    journal_entries_created: 0,
  };
}

function classifyError(message: string) {
  const normalized = message.toLowerCase();
  if (/\(429\)|\(502\)|\(503\)|\(504\)|bad gateway|temporar/.test(normalized)) return "FACTO_TEMPORARILY_UNAVAILABLE";
  if (/autenticaci[oó]n|token/.test(normalized)) return "FACTO_AUTH_FAILED";
  if (/captcha|dos factores|2fa|mfa/.test(normalized)) return "FACTO_INTERACTIVE_CHALLENGE";
  if (/tabla|secci[oó]n|paginaci[oó]n|p[aá]gina distinta/.test(normalized)) return "FACTO_UI_CHANGED";
  return "FACTO_PHASE4_FAILED";
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 800);
}
