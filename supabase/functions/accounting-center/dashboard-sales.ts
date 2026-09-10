type Row = Record<string, unknown>;
import { isPostableFactoDocument } from "./facto-document-policy.ts";

const salesTypes = new Set([
  "sales_invoice", "sales_exempt_invoice", "sales_receipt", "sales_exempt_receipt",
  "sales_debit_note", "sales_credit_note",
]);

export function accountingToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function dashboardDocumentSales(document: Row): number | null {
  if (!salesTypes.has(String(document.document_type)) || !isPostableFactoDocument(document)) return null;
  const amount = (value: unknown) => value === null || value === undefined || value === ""
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const rate = document.currency === "CLP" ? 1 : amount(document.exchange_rate);
  if (!rate || rate < 0) return null;
  const net = amount(document.net_amount);
  const exempt = amount(document.exempt_amount) ?? 0;
  const total = amount(document.total_clp);
  const tax = amount(document.tax_amount);
  const netClp = net !== null && net + exempt !== 0 ? (net + exempt) * rate
    : total !== null && tax !== null ? total - tax * rate : null;
  if (netClp === null || netClp < 0) return null;
  return document.document_type === "sales_credit_note" ? -netClp : netClp;
}

export function dashboardSalesEvidence(documents: Row[], lines: Row[], incomeAccountIds: Set<string>, asOf: string) {
  const postedIds = new Set<string>();
  for (const line of lines) {
    const entry = line.accounting_journal_entries as Row | null;
    if (!entry || !incomeAccountIds.has(String(line.account_id))
      || !["posted", "reversed"].includes(String(entry.status))
      || !entry.entry_date || String(entry.entry_date) > asOf) continue;
    // A cost/payment entry is not a sales posting; a reversed sale must not be re-added.
    if (entry.source_document_id) postedIds.add(String(entry.source_document_id));
  }
  const seen = new Set<string>();
  return documents.flatMap(document => {
    const id = String(document.id || "");
    const issuedOn = String(document.issued_on || "");
    const netClp = dashboardDocumentSales(document);
    if (!id || seen.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || issuedOn > asOf || netClp === null) return [];
    seen.add(id);
    return [{ id, folio: String(document.folio || document.external_id || "Sin folio"), issuedOn,
      netClp, posted: postedIds.has(id), creditNote: document.document_type === "sales_credit_note" }];
  });
}
