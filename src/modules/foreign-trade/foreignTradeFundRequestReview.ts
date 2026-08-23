import type {
  ForeignTradeCostCategory,
  ForeignTradeFundRequestExtraction,
  ForeignTradeFundRequestLine,
  ForeignTradeReconciliationLineType,
} from "../../types/foreignTrade";

const lineTypes = new Set<ForeignTradeReconciliationLineType>([
  "operating_expense",
  "agency_fee",
  "customs_duty",
  "import_vat",
  "adjustment",
]);

const costCategories = new Set<ForeignTradeCostCategory>([
  "origin",
  "international_freight",
  "insurance",
  "chile_port",
  "storage",
  "customs_agency",
  "national_transport",
  "inspection",
  "certificate",
  "duties",
  "taxes",
  "supplier_charge",
  "other",
]);

export type NormalizedFundRequestReview = {
  review: ForeignTradeFundRequestExtraction;
  isCompatible: boolean;
};

export function normalizeForeignTradeFundRequestReview(value: unknown): NormalizedFundRequestReview {
  const source = record(value);
  const compatible = source.document_kind === "fund_request"
    && isRecord(source.general)
    && Array.isArray(source.lines)
    && isRecord(source.totals);

  if (!compatible) return { review: emptyFundRequestReview(), isCompatible: false };

  const general = record(source.general);
  const totals = record(source.totals);
  const lines = (source.lines as unknown[]).map(normalizeLine);

  return {
    isCompatible: true,
    review: {
      extraction_version: text(source.extraction_version) || "",
      document_kind: "fund_request",
      general: {
        reference: nullableText(general.reference),
        agency_name: nullableText(general.agency_name),
        document_date: nullableText(general.document_date),
        currency: currency(general.currency, "CLP"),
        declared_total_clp: nullableNumber(general.declared_total_clp),
        remittance_amount_clp: nullableNumber(general.remittance_amount_clp),
        observations: nullableText(general.observations),
        confidence: confidence(general.confidence),
        warnings: stringArray(general.warnings),
      },
      lines,
      totals: {
        expenses_clp: nullableNumber(totals.expenses_clp),
        taxes_clp: nullableNumber(totals.taxes_clp),
        document_total_clp: nullableNumber(totals.document_total_clp),
        line_count: positiveInteger(totals.line_count) || lines.length,
      },
      warnings: stringArray(source.warnings),
    },
  };
}

function emptyFundRequestReview(): ForeignTradeFundRequestExtraction {
  return {
    extraction_version: "",
    document_kind: "fund_request",
    general: {
      reference: null,
      agency_name: null,
      document_date: null,
      currency: "CLP",
      declared_total_clp: null,
      remittance_amount_clp: null,
      observations: null,
      confidence: null,
      warnings: [],
    },
    lines: [],
    totals: {
      expenses_clp: null,
      taxes_clp: null,
      document_total_clp: null,
      line_count: 0,
    },
    warnings: [],
  };
}

function normalizeLine(value: unknown, index: number): ForeignTradeFundRequestLine {
  const source = record(value);
  const lineType = lineTypes.has(source.line_type as ForeignTradeReconciliationLineType)
    ? source.line_type as ForeignTradeReconciliationLineType
    : "operating_expense";
  const defaultCategory: ForeignTradeCostCategory = lineType === "customs_duty"
    ? "duties"
    : lineType === "import_vat"
      ? "taxes"
      : lineType === "agency_fee"
        ? "customs_agency"
        : "other";
  const costCategory = costCategories.has(source.cost_category as ForeignTradeCostCategory)
    ? source.cost_category as ForeignTradeCostCategory
    : defaultCategory;
  const originalCurrency = currency(source.currency, "CLP");
  const amountOriginal = nullableNumber(source.amount_original);
  const exchangeRate = originalCurrency === "CLP" ? 1 : nullableNumber(source.exchange_rate_clp);
  const netClp = nullableNumber(source.provision_net_clp);
  const vatClp = nullableNumber(source.provision_vat_clp);
  const statedTotal = nullableNumber(source.provision_total_clp);
  const calculatedTotal = netClp !== null || vatClp !== null
    ? roundMoney((netClp || 0) + (vatClp || 0))
    : amountOriginal !== null && exchangeRate !== null
      ? roundMoney(amountOriginal * exchangeRate)
      : null;

  return {
    source_index: positiveInteger(source.source_index) || index + 1,
    source_page: positiveInteger(source.source_page),
    include: source.include !== false,
    line_type: lineType,
    cost_category: lineType === "customs_duty" ? "duties" : lineType === "import_vat" ? "taxes" : costCategory,
    concept: text(source.concept),
    provider_name: nullableText(source.provider_name),
    document_number: nullableText(source.document_number),
    document_date: nullableText(source.document_date),
    provision_net_clp: netClp,
    provision_vat_clp: vatClp,
    provision_total_clp: statedTotal ?? calculatedTotal,
    amount_original: amountOriginal ?? (originalCurrency === "CLP" ? statedTotal ?? calculatedTotal : null),
    currency: originalCurrency,
    exchange_rate_clp: exchangeRate,
    recoverable_tax: lineType === "import_vat" || source.recoverable_tax === true,
    include_in_costing: lineType === "import_vat" ? false : source.include_in_costing !== false,
    confidence: confidence(source.confidence),
    warnings: stringArray(source.warnings),
  };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  return text(value) || null;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown) {
  const parsed = nullableNumber(value);
  return parsed !== null && parsed > 0 ? Math.round(parsed) : null;
}

function confidence(value: unknown) {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.min(1, Math.max(0, parsed));
}

function currency(value: unknown, fallback: string) {
  const normalized = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
