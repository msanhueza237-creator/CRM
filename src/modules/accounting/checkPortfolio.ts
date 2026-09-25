import type { AccountingBootstrap, AccountingCheck } from "../../types/accounting";

export function reportedChecks(data: Pick<AccountingBootstrap, "checks" | "checkPortfolio">) {
  const report = data.checkPortfolio;
  if (!report?.batchId) return data.checks;
  if (!report.verified) return [];
  const ids = new Set(report.checkIds);
  return data.checks.filter(check => ids.has(check.id));
}

export function checkInstrumentDate(check: AccountingCheck) {
  // Facto's Fecha is the instrument date; Fecha Cobro is not its maturity.
  return check.import_batch_id ? check.received_on : check.due_on || check.received_on;
}

export function checkInvoiceNumbers(check: AccountingCheck) {
  const allocations = check.metadata?.allocations;
  const values = Array.isArray(allocations)
    ? allocations.map(value => value && typeof value === "object" ? String(value.source_document_number || "") : "")
    : [String(check.metadata?.source_document_number || "")];
  return [...new Set(values.filter(Boolean))].join(", ");
}
