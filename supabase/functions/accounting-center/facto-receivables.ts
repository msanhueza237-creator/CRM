type JsonRecord = Record<string, unknown>;

const verifiedFactoBalanceSources = new Set([
  "facto_receivables",
  "facto_document_pdf",
  "facto_excel",
  "manual_facto_verification",
]);

export type FactoReceivablesSnapshot = {
  authoritative: boolean;
  detailsVerified: boolean;
  portfolioComplete: boolean;
  canCloseMissing: boolean;
  asOf: string | null;
  mode: string;
  amountClp: number;
  overdueClp: number;
  documentCount: number;
  details: JsonRecord[];
};

export function isVerifiedFactoReceivableBalanceSource(value: unknown) {
  return verifiedFactoBalanceSources.has(String(value || ""));
}

export function analyzeFactoReceivablesSnapshot(input: JsonRecord): FactoReceivablesSnapshot {
  const rawDetails = Array.isArray(input.documents_detail)
    ? input.documents_detail.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const mode = String(input.mode || input.source || "");
  const supportedMode = isVerifiedFactoReceivableBalanceSource(mode);
  const sourceVerified = input.authoritative === true && supportedMode;
  const explicitComplete = input.portfolio_complete === true;
  const amountClp = Math.max(0, finite(input.observed_amount));
  const documentCount = Math.max(0, Math.trunc(finite(input.documents)));
  const details = rawDetails.filter((detail) => {
    const evidence = String(detail.balance_source || mode);
    const rawAmount = detail.observed_amount;
    const amount = Number(rawAmount);
    return isVerifiedFactoReceivableBalanceSource(evidence)
      && rawAmount !== null
      && rawAmount !== undefined
      && rawAmount !== ""
      && Number.isFinite(amount)
      && amount >= 0;
  });
  const detailKeys = details.map((detail) => String(detail.document_id || "").trim() || [
    String(detail.document_type || "").trim(),
    String(detail.document_number || "").trim(),
    String(detail.tax_id || detail.customer_tax_id || "").trim(),
  ].join("|"));
  const uniqueDetailKeys = new Set(detailKeys.filter(Boolean));
  const detailsUniquelyIdentified = detailKeys.every((key) => key && key !== "||")
    && uniqueDetailKeys.size === details.length;
  const detailTotal = details.reduce((sum, detail) => sum + Number(detail.observed_amount), 0);
  const completeBreakdown = documentCount === 0
    ? details.length === 0 && amountClp <= 0.5
    : details.length === documentCount
      && detailsUniquelyIdentified
      && Math.abs(detailTotal - amountClp) <= 0.5;
  const portfolioComplete = sourceVerified && explicitComplete && completeBreakdown;

  return {
    authoritative: portfolioComplete,
    detailsVerified: sourceVerified && details.length > 0,
    portfolioComplete,
    canCloseMissing: portfolioComplete,
    asOf: isoDate(input.as_of),
    mode,
    amountClp,
    overdueClp: Math.max(0, finite(input.overdue_amount)),
    documentCount,
    details,
  };
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isoDate(value: unknown) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
