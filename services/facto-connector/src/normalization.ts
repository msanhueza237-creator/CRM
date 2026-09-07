import { createHash } from "node:crypto";
import type {
  FactoApiDocument,
  FactoApiReadResult,
  FactoBrowserReadResult,
  FactoBrowserRow,
  FactoCanonicalReceivable,
  FactoDocumentKind,
  FactoSyncPreview,
  FactoSyncPreviewItem,
  JsonObject,
  JsonValue,
} from "./types.ts";

export interface BrowserTableRowSnapshot {
  cells: string[];
  externalId?: string | null;
  href?: string | null;
}

const supportedTypes = new Set<FactoDocumentKind>([
  "sales_invoice",
  "sales_exempt_invoice",
  "sales_receipt",
  "sales_exempt_receipt",
  "sales_export_invoice",
]);

export function normalizeFactoApiDocument(rawValue: unknown, currencyMap: Record<string, string>): FactoApiDocument {
  const raw = asJsonObject(rawValue);
  const data = asObject(raw.data);
  const document = asObject(raw.document);
  const header = { ...asObject(data.header), ...asObject(document.header), ...asObject(raw.header) };
  const totals = { ...asObject(data.totals), ...asObject(document.totals), ...asObject(raw.totals) };
  const merged = { ...raw, ...data, ...document, ...header, ...totals };
  const externalId = text(first(merged, ["document_id", "id", "external_id"]));
  const documentType = factoDocumentType(
    first(merged, ["document_type_taxbureau", "tax_document_type"]),
    first(merged, ["document_type", "document_type_name", "type"]),
  );
  const folio = normalizeDocumentNumber(first(merged, ["document_number", "folio", "number", "numero"]));
  const customerTaxId = normalizeTaxId(first(merged, ["receiver_tax_id_code", "customer_tax_id", "client_tax_id", "rut"]));
  const customerName = text(first(merged, ["receiver_legal_name", "receiver_name", "customer_name", "client_name"]));
  const issuedOn = parseFactoDate(first(merged, ["issue_date", "issued_on", "date", "fecha_emision"]));
  const currencyId = text(first(merged, ["currency_id"]));
  const receivedIssuedFlag = text(first(merged, ["received_issued_flag"]));
  const currency = (text(first(merged, ["currency", "currency_code", "moneda"])) || currencyMap[currencyId] || "").toUpperCase();
  const exchangeRate = currency === "CLP"
    ? 1
    : positiveNumber(first(merged, ["exchange_rate_value", "exchange_rate", "tipo_cambio"]));
  const netAmount = nonNegativeMoney(first(merged, ["net_amount", "net", "monto_neto"]));
  const taxAmount = nonNegativeMoney(first(merged, ["taxes_amount", "tax_amount", "vat_amount", "iva"]));
  const exemptAmount = nonNegativeMoney(first(merged, ["exempt_amount", "monto_exento"]));
  const originalAmount = nonNegativeMoney(first(merged, ["total_amount", "total", "monto_total", "amount"]));
  const validationErrors: string[] = [];
  if (!externalId) validationErrors.push("api_external_id_missing");
  if (!folio) validationErrors.push("folio_missing");
  if (!customerTaxId) validationErrors.push("customer_tax_id_missing");
  if (!customerName) validationErrors.push("customer_name_missing");
  if (!issuedOn) validationErrors.push("issued_on_missing");
  if (!currency || !/^[A-Z]{3}$/.test(currency)) validationErrors.push("currency_unknown");
  if (currency !== "CLP" && exchangeRate <= 0) validationErrors.push("exchange_rate_missing");
  if (originalAmount <= 0) validationErrors.push("original_amount_invalid");
  if (receivedIssuedFlag && receivedIssuedFlag !== "1") validationErrors.push("document_direction_not_issued");
  if (!supportedTypes.has(documentType)) validationErrors.push("document_type_requires_review");
  return {
    externalId,
    documentType,
    folio,
    customerTaxId,
    customerName,
    issuedOn,
    currency: currency || "CLP",
    exchangeRate: exchangeRate || 1,
    netAmount,
    taxAmount,
    exemptAmount,
    originalAmount,
    originalAmountClp: roundMoney(originalAmount * (exchangeRate || 1)),
    sourceCreatedAt: parseFactoDateTime(first(merged, ["created_at", "createdAt", "fecha_creacion"])),
    receivedIssuedFlag,
    raw,
    validationErrors,
  };
}

export function parseFactoBrowserTable(headers: string[], rows: BrowserTableRowSnapshot[]): FactoBrowserRow[] {
  const normalizedHeaders = headers.map((header) => compactText(header));
  return rows.flatMap((row, rowIndex) => {
    if (!row.cells.some((cell) => text(cell))) return [];
    const columns = Object.fromEntries(headers.map((header, index) => [header || `columna_${index + 1}`, text(row.cells[index])]));
    const get = (...aliases: string[]) => browserColumn(normalizedHeaders, row.cells, aliases);
    const documentTypeLabel = get("tipo documento", "tipo dte", "documento tipo", "tipo");
    const documentType = factoDocumentType("", documentTypeLabel);
    const folio = normalizeDocumentNumber(get("folio", "numero documento", "n documento", "nro documento", "documento"));
    const customerTaxId = normalizeTaxId(get("rut cliente", "rut receptor", "rut", "identificador"));
    const customerName = get("razon social", "cliente", "receptor", "nombre cliente", "nombre");
    const issuedOn = parseFactoDate(get("fecha emision", "emision", "fecha documento", "fecha"));
    const dueOn = parseFactoDate(get("fecha vencimiento", "vencimiento", "vence")) || null;
    const originalRaw = get("monto original", "total documento", "monto documento", "total");
    const balanceRaw = get("saldo pendiente", "saldo impago", "saldo", "por cobrar", "monto pendiente");
    const paidRaw = get("pagado", "monto pagado", "abonos");
    const originalAmountClp = originalRaw ? parseLocalizedMoney(originalRaw) : null;
    const outstandingAmountClp = parseLocalizedMoney(balanceRaw);
    const paidAmountClp = paidRaw ? parseLocalizedMoney(paidRaw) : null;
    const currency = (get("moneda", "currency") || "CLP").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "CLP";
    const status = get("estado cobranza", "estado", "situacion") || "Pendiente";
    const daysText = get("dias atraso", "dias vencido", "mora");
    const parsedDays = daysText ? Number(daysText.replace(/[^0-9-]/g, "")) : null;
    const daysOverdue = parsedDays !== null && Number.isFinite(parsedDays)
      ? Math.max(0, Math.trunc(parsedDays))
      : dueOn
        ? daysBetween(dueOn, new Date().toISOString().slice(0, 10))
        : null;
    const validationErrors: string[] = [];
    if (!folio) validationErrors.push("folio_missing");
    if (!customerTaxId) validationErrors.push("customer_tax_id_missing");
    if (!customerName) validationErrors.push("customer_name_missing");
    if (!issuedOn) validationErrors.push("issued_on_missing");
    if (!balanceRaw) validationErrors.push("outstanding_column_missing");
    if (outstandingAmountClp < 0) validationErrors.push("outstanding_amount_invalid");
    if (!supportedTypes.has(documentType)) validationErrors.push("document_type_requires_review");
    const partialPayments = paidAmountClp && paidAmountClp > 0
      ? [{ amount_clp: roundMoney(paidAmountClp), source: "facto_unpaid_grid", bank_confirmed: false }]
      : [];
    return [{
      sourceRow: rowIndex + 1,
      externalId: text(row.externalId) || externalIdFromHref(row.href) || null,
      documentType,
      documentTypeLabel,
      folio,
      customerTaxId,
      customerName,
      issuedOn,
      dueOn,
      currency,
      originalAmountClp: originalAmountClp === null ? null : roundMoney(originalAmountClp),
      outstandingAmountClp: roundMoney(outstandingAmountClp),
      status,
      daysOverdue,
      partialPayments,
      sourceHref: safeEvidenceHref(row.href),
      validationErrors,
      rawColumns: columns,
    }];
  });
}

export function buildFactoSyncPreview(
  api: FactoApiReadResult,
  browser: FactoBrowserReadResult,
  observedAt = new Date().toISOString(),
): FactoSyncPreview {
  const warnings = [...browser.warnings];
  const apiByExternal = new Map(api.documents.filter((document) => document.externalId).map((document) => [document.externalId, document]));
  const apiByComposite = groupBy(api.documents, apiCompositeKey);
  const apiByFolioTaxId = groupBy(api.documents, (document) => `${document.folio}|${document.customerTaxId}`);
  const matchedApiDocuments = new Set<FactoApiDocument>();
  const previewByCanonical = new Map<string, FactoSyncPreviewItem>();

  for (const browserRow of browser.rows) {
    const match = matchBrowserToApi(browserRow, apiByExternal, apiByComposite, apiByFolioTaxId);
    const apiDocument = match.matches.length === 1 ? match.matches[0] : null;
    const canonicalKey = apiDocument
      ? canonicalDocumentKey(apiDocument)
      : `facto:sale:unverified:${browserRow.documentType}:${browserRow.folio}:${browserRow.customerTaxId}`;
    const validationErrors = unique([
      ...browserRow.validationErrors,
      ...(apiDocument?.validationErrors || []),
      ...(match.matches.length > 1 ? ["multiple_api_documents_match"] : []),
      ...(!apiDocument ? ["api_document_not_found"] : []),
      ...(apiDocument && browserRow.originalAmountClp !== null && Math.abs(apiDocument.originalAmountClp - browserRow.originalAmountClp) > 0.5
        ? ["browser_original_amount_conflict"] : []),
    ]);
    const normalized = canonicalFromMatch(apiDocument, browserRow, observedAt, false);
    const item = previewItem(canonicalKey, normalized, validationErrors, {
      api: apiDocument ? apiEvidence(apiDocument) : { verified: false },
      browser: browserEvidence(browserRow),
      matching: { strategy: match.strategy, candidates: match.matches.length },
    });
    if (apiDocument) matchedApiDocuments.add(apiDocument);
    const duplicate = previewByCanonical.get(canonicalKey);
    if (!duplicate) previewByCanonical.set(canonicalKey, item);
    else if (Math.abs(duplicate.normalized.outstanding_amount_clp - item.normalized.outstanding_amount_clp) <= 0.5) {
      warnings.push(`Facto repitió el documento ${browserRow.folio}; se conservó una sola fila idéntica.`);
    } else {
      duplicate.validation_errors = unique([...duplicate.validation_errors, "conflicting_browser_rows"]);
      duplicate.evidence.matching = { ...duplicate.evidence.matching, conflicting_source_rows: true };
    }
  }

  if (browser.complete && api.complete) {
    let excludedUnsupportedDocuments = 0;
    let excludedAnonymousReceipts = 0;
    for (const apiDocument of api.documents) {
      if (matchedApiDocuments.has(apiDocument)) continue;
      if (!supportedTypes.has(apiDocument.documentType)) {
        excludedUnsupportedDocuments += 1;
        continue;
      }
      if (isAnonymousReceipt(apiDocument)) {
        excludedAnonymousReceipts += 1;
        continue;
      }
      const normalized = canonicalFromMatch(apiDocument, null, observedAt, true);
      previewByCanonical.set(canonicalDocumentKey(apiDocument), previewItem(
        canonicalDocumentKey(apiDocument),
        normalized,
        apiDocument.validationErrors,
        {
          api: apiEvidence(apiDocument),
          browser: { verified: false, absent_from_complete_unpaid_portfolio: true },
          matching: { strategy: "complete_portfolio_absence", candidates: 1 },
        },
      ));
    }
    if (excludedUnsupportedDocuments > 0) {
      warnings.push(`${excludedUnsupportedDocuments} documento(s) tributario(s) no cobrables se excluyeron de la cartera; no se modificaron automáticamente.`);
    }
    if (excludedAnonymousReceipts > 0) {
      warnings.push(`${excludedAnonymousReceipts} boleta(s) sin cliente identificado y ausentes de Documentos Impagos se excluyeron de la cartera.`);
    }
  } else if (!browser.complete) {
    warnings.push("La cartera web no tuvo cobertura completa; no se proponen cierres por ausencia.");
  } else {
    warnings.push("La API de Facto no tuvo cobertura completa; no se proponen cierres por ausencia.");
  }

  const items = [...previewByCanonical.values()].sort((left, right) => `${left.normalized.issued_on}|${left.normalized.folio}`.localeCompare(`${right.normalized.issued_on}|${right.normalized.folio}`));
  return {
    items,
    sourceAsOf: observedAt,
    apiDocuments: api.documents.length,
    browserRows: browser.rows.length,
    overdueDocuments: items.filter((item) => item.normalized.outstanding_amount_clp > 0 && (item.normalized.days_overdue || 0) > 0).length,
    partialPaymentDocuments: items.filter((item) => item.normalized.outstanding_amount_clp > 0 && item.normalized.reported_paid_amount_clp > 0).length,
    coverage: {
      complete: browser.complete && api.complete,
      verified_zero: browser.verifiedZero,
      section: browser.section,
      pages_read: browser.pagesRead,
      expected_rows: browser.expectedRows,
      extracted_rows: browser.rows.length,
      api_pages_read: api.pagesRead,
      api_page_count: api.pageCount,
      api_total_items: api.totalItems,
      api_complete: api.complete,
    },
    warnings: unique(warnings),
  };
}

function isAnonymousReceipt(document: FactoApiDocument) {
  return ["sales_receipt", "sales_exempt_receipt"].includes(document.documentType)
    && (!document.customerTaxId || !document.customerName);
}

export function canonicalDocumentKey(document: Pick<FactoApiDocument, "externalId" | "documentType" | "folio" | "customerTaxId">) {
  return document.externalId
    ? `facto:sale:${document.externalId}`
    : `facto:sale:${document.documentType}:${document.folio}:${document.customerTaxId}`;
}

export function normalizeTaxId(value: unknown) {
  return text(value).toUpperCase().replace(/[^0-9K]/g, "");
}

export function normalizeDocumentNumber(value: unknown) {
  return text(value).replace(/[^0-9A-Za-z-]/g, "").replace(/^0+(?=\d)/, "");
}

export function parseFactoDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso && validDate(`${iso[1]}-${iso[2]}-${iso[3]}`)) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s|$)/);
  if (!local) return "";
  const result = `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  return validDate(result) ? result : "";
}

export function parseLocalizedMoney(value: unknown) {
  let raw = text(value).replace(/[^0-9,.-]/g, "");
  if (!raw) return 0;
  const negative = raw.startsWith("-");
  raw = raw.replace(/-/g, "");
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? comma : dot;
    const fraction = raw.slice(decimal + 1);
    raw = fraction.length <= 2
      ? `${raw.slice(0, decimal).replace(/[.,]/g, "")}.${fraction}`
      : raw.replace(/[.,]/g, "");
  } else if (comma >= 0) {
    const parts = raw.split(",");
    raw = parts.length === 2 && parts[1].length <= 2 ? `${parts[0].replace(/\./g, "")}.${parts[1]}` : raw.replace(/,/g, "");
  } else if (dot >= 0) {
    const parts = raw.split(".");
    raw = parts.length > 2 || (parts.length === 2 && parts[1].length === 3) ? raw.replace(/\./g, "") : raw;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? roundMoney((negative ? -1 : 1) * parsed) : 0;
}

function canonicalFromMatch(
  api: FactoApiDocument | null,
  browser: FactoBrowserRow | null,
  observedAt: string,
  closureEvidence: boolean,
): FactoCanonicalReceivable {
  const originalClp = api?.originalAmountClp ?? browser?.originalAmountClp ?? 0;
  const outstanding = closureEvidence ? 0 : browser?.outstandingAmountClp ?? originalClp;
  return {
    external_id: api?.externalId || browser?.externalId || "",
    document_type: api?.documentType || browser?.documentType || "sales_other",
    folio: api?.folio || browser?.folio || "",
    customer_tax_id: api?.customerTaxId || browser?.customerTaxId || "",
    customer_name: api?.customerName || browser?.customerName || "",
    issued_on: api?.issuedOn || browser?.issuedOn || "",
    due_on: browser?.dueOn || null,
    currency: api?.currency || browser?.currency || "CLP",
    exchange_rate: api?.exchangeRate || 1,
    net_amount: api?.netAmount || 0,
    tax_amount: api?.taxAmount || 0,
    exempt_amount: api?.exemptAmount || 0,
    original_amount: api?.originalAmount || originalClp,
    original_amount_clp: roundMoney(originalClp),
    outstanding_amount_clp: roundMoney(outstanding),
    reported_paid_amount_clp: roundMoney(Math.max(originalClp - outstanding, 0)),
    status: closureEvidence ? "paid_or_absent_from_unpaid_portfolio" : browser?.status || "pending",
    days_overdue: browser?.daysOverdue ?? null,
    partial_payments: browser?.partialPayments || [],
    api_verified: Boolean(api),
    browser_verified: Boolean(browser),
    closure_evidence: closureEvidence,
    observed_at: observedAt,
    source_created_at: api?.sourceCreatedAt || null,
  };
}

function previewItem(
  canonicalKey: string,
  normalized: FactoCanonicalReceivable,
  validationErrors: string[],
  evidence: FactoSyncPreviewItem["evidence"],
): FactoSyncPreviewItem {
  return {
    canonical_key: canonicalKey,
    normalized,
    validation_errors: unique(validationErrors),
    raw_payload_hash: sha256(stableStringify({ normalized, evidence } as unknown as JsonValue)),
    evidence,
  };
}

function matchBrowserToApi(
  browser: FactoBrowserRow,
  byExternal: Map<string, FactoApiDocument>,
  byComposite: Map<string, FactoApiDocument[]>,
  byFolioTax: Map<string, FactoApiDocument[]>,
) {
  const external = browser.externalId ? byExternal.get(browser.externalId) : null;
  if (external) return { strategy: "external_id", matches: [external] };
  const composite = byComposite.get(`${browser.documentType}|${browser.folio}|${browser.customerTaxId}`) || [];
  if (composite.length) return { strategy: "type_folio_tax_id", matches: composite };
  const folioTax = byFolioTax.get(`${browser.folio}|${browser.customerTaxId}`) || [];
  return { strategy: folioTax.length ? "folio_tax_id" : "none", matches: folioTax };
}

function apiCompositeKey(document: FactoApiDocument) {
  return `${document.documentType}|${document.folio}|${document.customerTaxId}`;
}

function apiEvidence(document: FactoApiDocument): JsonObject {
  return {
    verified: true,
    source_payload_hash: sha256(stableStringify(document.raw)),
    external_id: document.externalId,
    document_type: document.documentType,
    folio: document.folio,
    customer_tax_id: document.customerTaxId,
    issue_date: document.issuedOn,
    received_issued_flag: document.receivedIssuedFlag,
    total_clp: document.originalAmountClp,
  };
}

function browserEvidence(row: FactoBrowserRow): JsonObject {
  return {
    verified: row.validationErrors.length === 0,
    source_row: row.sourceRow,
    section: "Documentos impagos",
    source_href: row.sourceHref,
    due_on: row.dueOn,
    outstanding_amount_clp: row.outstandingAmountClp,
    status: row.status,
    days_overdue: row.daysOverdue,
    raw_columns: row.rawColumns,
  };
}

function factoDocumentType(taxCodeValue: unknown, labelValue: unknown): FactoDocumentKind {
  const taxCode = text(taxCodeValue).replace(/^0+/, "");
  const byTaxCode: Record<string, FactoDocumentKind> = {
    "33": "sales_invoice",
    "34": "sales_exempt_invoice",
    "39": "sales_receipt",
    "41": "sales_exempt_receipt",
    "56": "sales_debit_note",
    "61": "sales_credit_note",
    "110": "sales_export_invoice",
    "111": "sales_export_debit_note",
    "112": "sales_export_credit_note",
  };
  if (byTaxCode[taxCode]) return byTaxCode[taxCode];
  const label = compactText(labelValue);
  if (label.includes("nota") && label.includes("credito")) return "sales_credit_note";
  if (label.includes("nota") && label.includes("debito")) return "sales_debit_note";
  if (label.includes("factura") && label.includes("export")) return "sales_export_invoice";
  if (label.includes("boleta") && label.includes("exenta")) return "sales_exempt_receipt";
  if (label.includes("boleta")) return "sales_receipt";
  if (label.includes("factura") && label.includes("exenta")) return "sales_exempt_invoice";
  if (label.includes("factura")) return "sales_invoice";
  return "sales_other";
}

function browserColumn(headers: string[], cells: string[], aliases: string[]) {
  const normalizedAliases = aliases.map(compactText);
  let index = headers.findIndex((header) => normalizedAliases.includes(header));
  if (index < 0) index = headers.findIndex((header) => normalizedAliases.some((alias) => header.includes(alias)));
  return index >= 0 ? text(cells[index]) : "";
}

function externalIdFromHref(value: string | null | undefined) {
  const href = text(value);
  if (!href) return "";
  const patterns = [/[?&](?:document_id|id)=([a-zA-Z0-9-]+)/i, /\/documents?\/([a-zA-Z0-9-]+)/i, /\/FactRegistrarDocDetForm\/([a-zA-Z0-9-]+)/i];
  return patterns.map((pattern) => href.match(pattern)?.[1] || "").find(Boolean) || "";
}

function safeEvidenceHref(value: string | null | undefined) {
  const href = text(value);
  if (!href) return null;
  try {
    const url = new URL(href, "https://minegocio.facto.cl");
    url.username = "";
    url.password = "";
    url.search = "";
    return `${url.origin}${url.pathname}${url.hash.replace(/[?&].*$/, "")}`.slice(0, 500);
  } catch {
    return null;
  }
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const result = new Map<string, T[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) || []), value]);
  return result;
}

function first(object: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = object[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(asObject(value))) as JsonObject;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compactText(value: unknown) {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nonNegativeMoney(value: unknown) {
  return Math.max(0, parseLocalizedMoney(value));
}

function positiveNumber(value: unknown) {
  const result = parseLocalizedMoney(value);
  return result > 0 ? result : 0;
}

function parseFactoDateTime(value: unknown) {
  const raw = text(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function validDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string) {
  return Math.max(0, Math.floor((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000));
}

function roundMoney(value: number) {
  return Math.round(value * 10000) / 10000;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
