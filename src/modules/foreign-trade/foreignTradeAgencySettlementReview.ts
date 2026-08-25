import type {
  ForeignTradeAgencySettlementExtraction,
  ForeignTradeAgencySettlementLine,
  ForeignTradeCostCategory,
  ForeignTradeExpenseReconciliationLine,
  ForeignTradeReconciliationLineType,
} from "../../types/foreignTrade";
import {
  isIncludedInForeignTradeAgencyReconciliation,
  resolveForeignTradeAgencyPaymentScope,
} from "./foreignTradeAgencyPaymentScope.ts";

const lineTypes = new Set<ForeignTradeReconciliationLineType>([
  "operating_expense", "agency_fee", "customs_duty", "import_vat", "adjustment",
]);
const costCategories = new Set<ForeignTradeCostCategory>([
  "origin", "international_freight", "insurance", "chile_port", "storage",
  "customs_agency", "national_transport", "inspection", "certificate", "duties",
  "taxes", "supplier_charge", "other",
]);

export function normalizeForeignTradeAgencySettlementReview(value: unknown) {
  const source = record(value);
  const compatible = source.document_kind === "agency_settlement"
    && isRecord(source.general)
    && Array.isArray(source.lines)
    && isRecord(source.totals);
  if (!compatible) return { review: emptyReview(), isCompatible: false };

  const general = record(source.general);
  const totals = record(source.totals);
  const lines = (source.lines as unknown[]).map(normalizeLine);
  return {
    isCompatible: true,
    review: {
      extraction_version: text(source.extraction_version),
      document_kind: "agency_settlement" as const,
      identity_confirmed: source.identity_confirmed === true,
      general: {
        reference: nullableText(general.reference),
        agency_name: nullableText(general.agency_name),
        invoice_number: nullableText(general.invoice_number),
        document_date: nullableText(general.document_date),
        currency: currency(general.currency, "CLP"),
        declared_total_clp: nullableNumber(general.declared_total_clp),
        observations: nullableText(general.observations),
        confidence: confidence(general.confidence),
        warnings: stringArray(general.warnings),
      },
      lines,
      totals: {
        expenses_clp: nullableNumber(totals.expenses_clp),
        taxes_clp: nullableNumber(totals.taxes_clp),
        agency_invoice_total_clp: nullableNumber(totals.agency_invoice_total_clp),
        disbursements_total_clp: nullableNumber(totals.disbursements_total_clp),
        customs_total_clp: nullableNumber(totals.customs_total_clp),
        document_total_clp: nullableNumber(totals.document_total_clp),
        remittance_clp: nullableNumber(totals.remittance_clp),
        documentary_direct_payment_clp: nullableNumber(totals.documentary_direct_payment_clp),
        refund_due_clp: nullableNumber(totals.refund_due_clp),
        line_count: positiveInteger(totals.line_count) || lines.length,
      },
      warnings: stringArray(source.warnings),
    } satisfies ForeignTradeAgencySettlementExtraction,
  };
}

function emptyReview(): ForeignTradeAgencySettlementExtraction {
  return {
    extraction_version: "",
    document_kind: "agency_settlement",
    identity_confirmed: false,
    general: {
      reference: null,
      agency_name: null,
      invoice_number: null,
      document_date: null,
      currency: "CLP",
      declared_total_clp: null,
      observations: null,
      confidence: null,
      warnings: [],
    },
    lines: [],
    totals: {
      expenses_clp: null,
      taxes_clp: null,
      agency_invoice_total_clp: null,
      disbursements_total_clp: null,
      customs_total_clp: null,
      document_total_clp: null,
      remittance_clp: null,
      documentary_direct_payment_clp: null,
      refund_due_clp: null,
      line_count: 0,
    },
    warnings: [],
  };
}

function normalizeLine(value: unknown, index: number): ForeignTradeAgencySettlementLine {
  const source = record(value);
  const lineType = lineTypes.has(source.line_type as ForeignTradeReconciliationLineType)
    ? source.line_type as ForeignTradeReconciliationLineType
    : "operating_expense";
  const defaultCategory: ForeignTradeCostCategory = lineType === "customs_duty"
    ? "duties"
    : lineType === "import_vat"
      ? "taxes"
      : lineType === "agency_fee" ? "customs_agency" : "other";
  const costCategory = costCategories.has(source.cost_category as ForeignTradeCostCategory)
    ? source.cost_category as ForeignTradeCostCategory
    : defaultCategory;
  const originalCurrency = currency(source.currency, "CLP");
  const amountOriginal = nullableNumber(source.amount_original);
  const exchangeRate = originalCurrency === "CLP" ? 1 : nullableNumber(source.exchange_rate_clp);
  const netClp = nullableNumber(source.actual_net_clp);
  const vatClp = nullableNumber(source.actual_vat_clp);
  const statedTotal = nullableNumber(source.actual_total_clp);
  const calculatedTotal = netClp !== null || vatClp !== null
    ? roundMoney((netClp || 0) + (vatClp || 0))
    : amountOriginal !== null && exchangeRate !== null
      ? roundMoney(amountOriginal * exchangeRate)
      : null;
  const concept = text(source.concept);
  const providerName = nullableText(source.provider_name);
  const paymentScope = resolveForeignTradeAgencyPaymentScope({
    provider_name: providerName,
    concept,
    payment_scope: source.payment_scope === "direct_supplier" ? "direct_supplier" : source.payment_scope === "agency" ? "agency" : null,
  });
  const isSummary = isAgencySettlementSummaryConcept(concept);
  const warnings = stringArray(source.warnings);
  if (isSummary && !warnings.includes("Subtotal informativo; no se concilia como gasto independiente.")) {
    warnings.push("Subtotal informativo; no se concilia como gasto independiente.");
  }
  if (paymentScope === "direct_supplier" && !warnings.includes("Pago directo a AD/ADS Cargas: se incluye en el costeo, pero queda fuera de la rendición de la agencia.")) {
    warnings.push("Pago directo a AD/ADS Cargas: se incluye en el costeo, pero queda fuera de la rendición de la agencia.");
  }
  return {
    source_index: positiveInteger(source.source_index) || index + 1,
    source_page: positiveInteger(source.source_page),
    include: !isSummary && source.include !== false,
    reconciliation_line_id: nullableUuid(source.reconciliation_line_id),
    line_type: lineType,
    cost_category: lineType === "customs_duty" ? "duties" : lineType === "import_vat" ? "taxes" : costCategory,
    concept,
    provider_name: providerName,
    document_number: nullableText(source.document_number),
    document_date: nullableText(source.document_date),
    actual_net_clp: netClp,
    actual_vat_clp: vatClp,
    actual_total_clp: statedTotal ?? calculatedTotal,
    amount_original: amountOriginal ?? (originalCurrency === "CLP" ? statedTotal ?? calculatedTotal : null),
    currency: originalCurrency,
    exchange_rate_clp: exchangeRate,
    recoverable_tax: lineType === "import_vat" || source.recoverable_tax === true,
    include_in_costing: isSummary || lineType === "import_vat" ? false : source.include_in_costing !== false,
    payment_scope: paymentScope,
    confidence: confidence(source.confidence),
    warnings,
  };
}

function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function nullableText(value: unknown) { return text(value) || null; }
function nullableUuid(value: unknown) { const result = text(value); return /^[0-9a-f-]{36}$/i.test(result) ? result : null; }
function nullableNumber(value: unknown) { if (value === null || value === undefined || value === "") return null; const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : null; }
function positiveInteger(value: unknown) { const parsed = nullableNumber(value); return parsed !== null && parsed > 0 ? Math.round(parsed) : null; }
function confidence(value: unknown) { const parsed = nullableNumber(value); return parsed === null ? null : Math.min(1, Math.max(0, parsed)); }
function currency(value: unknown, fallback: string) { const normalized = text(value).toUpperCase(); return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function roundMoney(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }

const minimumMatchScore = 50;

export function autoMatchForeignTradeAgencySettlementLines(
  lines: ForeignTradeAgencySettlementLine[],
  provisionLines: ForeignTradeExpenseReconciliationLine[],
) {
  const assignments = new Map<number, string>();
  const usedLines = new Set<number>();
  const usedProvisions = new Set<string>();

  lines.forEach((line, index) => {
    const existingId = line.reconciliation_line_id;
    if (!existingId || usedProvisions.has(existingId)) return;
    if (!provisionLines.some((candidate) => candidate.id === existingId)) return;
    assignments.set(index, existingId);
    usedLines.add(index);
    usedProvisions.add(existingId);
  });

  const candidates = lines.flatMap((line, lineIndex) => {
    if (
      usedLines.has(lineIndex) ||
      isAgencySettlementSummaryConcept(line.concept) ||
      !isIncludedInForeignTradeAgencyReconciliation(line)
    ) return [];
    return provisionLines
      .filter((candidate) => !usedProvisions.has(candidate.id))
      .map((candidate) => ({
        lineIndex,
        provisionId: candidate.id,
        score: settlementMatchScore(line, candidate),
      }));
  }).sort((first, second) => second.score - first.score);

  candidates.forEach((candidate) => {
    if (candidate.score < minimumMatchScore) return;
    if (usedLines.has(candidate.lineIndex) || usedProvisions.has(candidate.provisionId)) return;
    assignments.set(candidate.lineIndex, candidate.provisionId);
    usedLines.add(candidate.lineIndex);
    usedProvisions.add(candidate.provisionId);
  });

  return lines.map((line, index) => ({
    ...line,
    reconciliation_line_id: assignments.get(index) || null,
  }));
}

export function isAgencySettlementSummaryConcept(value: string | null | undefined) {
  const normalized = normalizeWords(value).replace(/\s/g, "");
  return /^(?:(?:total|subtotal|suma)(?:desembolsos|gastos|rendicion|facturas?|documentos|general|facturaagencia|derechosaduana|aduana)?|honorarios(?:partede)?facturaagencia|remesa|pagodirecto|totalasufavor|saldoasufavor|devolucion)$/.test(normalized);
}

export function calculateForeignTradeDocumentarySettlement(
  totals: ForeignTradeAgencySettlementExtraction["totals"],
) {
  const agencyInvoice = finite(totals.agency_invoice_total_clp);
  const disbursements = finite(totals.disbursements_total_clp);
  const customs = finite(totals.customs_total_clp);
  const documentTotal = finite(totals.document_total_clp);
  const remittance = finite(totals.remittance_clp);
  const directPayment = finite(totals.documentary_direct_payment_clp);
  const documentedRefund = finite(totals.refund_due_clp);
  const hasComponentSummary = [
    totals.agency_invoice_total_clp,
    totals.disbursements_total_clp,
    totals.customs_total_clp,
  ].every((value) => value !== null && value !== undefined);
  const hasBalanceSummary = totals.document_total_clp !== null
    && totals.remittance_clp !== null;
  const componentsTotalClp = roundMoney(agencyInvoice + disbursements + customs);
  const calculatedRefundDueClp = roundMoney(Math.max(remittance + directPayment - documentTotal, 0));
  const calculatedAdditionalPaymentClp = roundMoney(Math.max(documentTotal - remittance - directPayment, 0));
  return {
    hasComponentSummary,
    hasBalanceSummary,
    componentsTotalClp,
    componentVarianceClp: hasComponentSummary ? roundMoney(componentsTotalClp - documentTotal) : null,
    calculatedRefundDueClp,
    calculatedAdditionalPaymentClp,
    refundVarianceClp: totals.refund_due_clp !== null && hasBalanceSummary
      ? roundMoney(documentedRefund - calculatedRefundDueClp)
      : null,
    isDocumentBalanced: !hasComponentSummary || Math.abs(componentsTotalClp - documentTotal) <= 1,
    isRefundBalanced: totals.refund_due_clp === null
      || !hasBalanceSummary
      || Math.abs(documentedRefund - calculatedRefundDueClp) <= 1,
  };
}

function settlementMatchScore(
  line: ForeignTradeAgencySettlementLine,
  provision: ForeignTradeExpenseReconciliationLine,
) {
  const actualConcept = normalizeWords(line.concept);
  const provisionConcept = normalizeWords(provision.concept);
  const actualFamily = conceptFamily(actualConcept);
  const provisionFamily = conceptFamily(provisionConcept);
  let score = 0;

  if (actualConcept && actualConcept === provisionConcept) score += 160;
  if (actualFamily && provisionFamily) score += actualFamily === provisionFamily ? 90 : -90;
  score += tokenSimilarity(actualConcept, provisionConcept) * 55;

  const actualDocument = normalizeCompact(line.document_number || "");
  const provisionDocument = normalizeCompact(provision.document_number || "");
  if (actualDocument && provisionDocument && actualDocument === provisionDocument) score += 100;
  if (line.cost_category === provision.cost_category) score += 20;
  if (line.line_type === provision.line_type) score += 12;

  const actualAmount = resolvedActualAmount(line);
  const provisionAmount = finite(provision.provision_total_clp);
  if (actualAmount > 0 && provisionAmount > 0) {
    const relativeDifference = Math.abs(actualAmount - provisionAmount) / Math.max(actualAmount, provisionAmount);
    if (relativeDifference <= 0.005) score += 55;
    else if (relativeDifference <= 0.05) score += 42;
    else if (relativeDifference <= 0.15) score += 25;
    else if (relativeDifference <= 0.35) score += 10;
  }

  return score;
}

function conceptFamily(value: string) {
  if (/derech|ad valorem|arancel/.test(value)) return "customs_duty";
  if (/iva.*import|impuesto.*import/.test(value)) return "import_vat";
  if (/gate\s*in|ingreso.*contenedor/.test(value)) return "gate_in";
  if (/seguro|insurance/.test(value)) return "insurance";
  if (/honorario/.test(value)) return "agency_fee";
  if (/gasto.*despacho|despacho.*aduan/.test(value)) return "customs_dispatch";
  if (/tarifa.*seguridad|transferencia.*contenedor|movilizaci|terminal|puerto|\bsti\b/.test(value)) return "port_service";
  if (/flete|transporte|traslado.*contenedor/.test(value)) return "freight_transport";
  if (/almacen|bodega/.test(value)) return "storage";
  return null;
}

function resolvedActualAmount(line: ForeignTradeAgencySettlementLine) {
  const stated = finite(line.actual_total_clp);
  if (stated > 0) return stated;
  const components = finite(line.actual_net_clp) + finite(line.actual_vat_clp);
  if (components > 0) return components;
  const original = finite(line.amount_original);
  if (String(line.currency || "CLP").toUpperCase() === "CLP") return original;
  return original * finite(line.exchange_rate_clp);
}

function tokenSimilarity(first: string, second: string) {
  const firstTokens = new Set(first.split(" ").filter((token) => token.length >= 3));
  const secondTokens = new Set(second.split(" ").filter((token) => token.length >= 3));
  if (!firstTokens.size || !secondTokens.size) return 0;
  const intersection = [...firstTokens].filter((token) => secondTokens.has(token)).length;
  const union = new Set([...firstTokens, ...secondTokens]).size;
  return union ? intersection / union : 0;
}

function normalizeWords(value: string | null | undefined) {
  return String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCompact(value: string) {
  return normalizeWords(value).replace(/\s/g, "");
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
