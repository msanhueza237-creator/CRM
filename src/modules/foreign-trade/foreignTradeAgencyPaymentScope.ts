export type ForeignTradeAgencyPaymentScope = "agency" | "direct_supplier";

type PaymentScopeSource = {
  provider_name?: string | null;
  concept?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  payment_scope?: ForeignTradeAgencyPaymentScope | null;
};

export function resolveForeignTradeAgencyPaymentScope(
  source: PaymentScopeSource,
): ForeignTradeAgencyPaymentScope {
  if (source.payment_scope === "direct_supplier") return "direct_supplier";
  if (source.payment_scope === "agency") return "agency";

  const metadata = source.metadata || {};
  if (
    metadata.payment_scope === "direct_supplier" ||
    metadata.exclude_from_agency_reconciliation === true
  ) return "direct_supplier";
  if (metadata.payment_scope === "agency") return "agency";

  return isAdCargasInternationales([
    source.provider_name,
    source.concept,
    source.notes,
  ].filter(Boolean).join(" "))
    ? "direct_supplier"
    : "agency";
}

export function isIncludedInForeignTradeAgencyReconciliation(source: PaymentScopeSource) {
  return resolveForeignTradeAgencyPaymentScope(source) === "agency";
}

export function withForeignTradeAgencyPaymentScope(
  metadata: Record<string, unknown> | null | undefined,
  paymentScope: ForeignTradeAgencyPaymentScope,
) {
  return {
    ...(metadata || {}),
    payment_scope: paymentScope,
    exclude_from_agency_reconciliation: paymentScope === "direct_supplier",
  };
}

export function isAdCargasInternationales(value: string | null | undefined) {
  const normalized = normalize(value);
  if (!normalized) return false;
  if (/^ads?$/.test(normalized)) return true;

  const hasProviderPrefix = /(^|\s)ads?(\s|$)/.test(normalized);
  const hasCargoIdentity = /\b(carga|cargas|cargo|internacional|internacionales)\b/.test(normalized);
  return hasProviderPrefix && hasCargoIdentity;
}

function normalize(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
