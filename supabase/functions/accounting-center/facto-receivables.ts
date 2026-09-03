type JsonRecord = Record<string, unknown>;

export type FactoReceivablesSnapshot = {
  authoritative: boolean;
  canCloseMissing: boolean;
  asOf: string | null;
  mode: string;
  amountClp: number;
  overdueClp: number;
  documentCount: number;
  details: JsonRecord[];
};

export function analyzeFactoReceivablesSnapshot(input: JsonRecord): FactoReceivablesSnapshot {
  const details = Array.isArray(input.documents_detail)
    ? input.documents_detail.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const coverage = asObject(input.pdf_coverage);
  const examined = finite(coverage.documents_examined);
  const withPdf = finite(coverage.documents_with_pdf);
  const withBalance = finite(coverage.documents_with_balance);
  const percent = finite(coverage.percent);
  const authoritative = input.authoritative === true;
  const mode = String(input.mode || input.source || "");
  const explicitComplete = input.portfolio_complete === true;
  const completePdfReview = mode === "facto_document_pdf"
    && examined > 0
    && withPdf >= examined
    && percent >= 0.999
    && withBalance === details.length
    && String(input.classification_status || "") === "complete"
    && finite(input.unclassified_documents) === 0;

  return {
    authoritative,
    canCloseMissing: authoritative && (explicitComplete || completePdfReview),
    asOf: isoDate(input.as_of),
    mode,
    amountClp: Math.max(0, finite(input.observed_amount)),
    overdueClp: Math.max(0, finite(input.overdue_amount)),
    documentCount: Math.max(0, Math.trunc(finite(input.documents))),
    details,
  };
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isoDate(value: unknown) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
