import { factoHeader } from "./facto-document-policy.ts";
import type { ProfitabilityIssue } from "../_shared/customer-profitability-contract.ts";
type Row = Record<string, unknown>;
const obj = (x: unknown): Row => x && typeof x === "object" && !Array.isArray(x) ? x as Row : {};
export function profitabilityIssue(doc: Row, code: ProfitabilityIssue["code"], reason: string, action: string, relatedDocumentId?: string | null): ProfitabilityIssue {
  const header = factoHeader(obj(doc.raw_payload));
  // Descriptions are evidence labels, not SKU matches or historical cost estimates.
  const products = Array.isArray(header.details) ? header.details.map(x => String(obj(x).line_description || "")).filter(Boolean) : [];
  return { code, documentId: String(doc.id), folio: String(doc.folio || doc.external_id || "Sin folio"),
    issuedOn: String(doc.issued_on || ""), source: String(doc.source_type || "Desconocido"), reason, action,
    path: `/finanzas-contabilidad?view=facto&document=${encodeURIComponent(String(doc.id))}`,
    products: [...new Set(products)], relatedDocumentId };
}

// Known exclusions are not missing costs. Keep them traceable without blocking valid invoices.
export function isNonSalesEvidence(doc: Row): boolean {
  return ["cancelled", "voided"].includes(String(doc.status)) || !["sales_invoice", "sales_exempt_invoice", "sales_receipt", "sales_exempt_receipt", "sales_debit_note", "sales_credit_note"].includes(String(doc.document_type));
}
