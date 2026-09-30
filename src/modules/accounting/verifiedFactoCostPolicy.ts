import type { AccountingPeriod, AccountingSourceDocument } from "../../types/accounting";

export function eligibleForVerifiedCost(source: AccountingSourceDocument, periods: AccountingPeriod[]) {
  return source.source_type === "FACTO" && source.document_type === "sales_invoice" && source.currency === "CLP"
    && ["validated", "posted"].includes(source.status) && source.data_quality === "validated"
    && Boolean(source.issued_on && periods.some(period => period.status === "open"
      && source.issued_on! >= period.starts_on && source.issued_on! <= period.ends_on));
}

export function validVerifiedCostInput(amount: string, evidence: string, confirmed: boolean) {
  return Number.isSafeInteger(Number(amount)) && Number(amount) > 0
    && evidence.trim().length >= 20 && evidence.trim().length <= 500 && confirmed;
}
