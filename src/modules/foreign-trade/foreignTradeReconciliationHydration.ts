import type {
  ForeignTradeCostLine,
  ForeignTradeExpenseReconciliationLine,
} from "../../types/foreignTrade";
import { isIncludedInForeignTradeAgencyReconciliation } from "./foreignTradeAgencyPaymentScope.ts";

export type HydratedActualAmounts = {
  netClp: number;
  vatClp: number;
  totalClp: number;
  amountOriginal: number;
  currency: string;
  exchangeRateClp: number | null;
  sourceCostLineId: string | null;
};

export function hydrateActualAmountsFromCosts(
  line: ForeignTradeExpenseReconciliationLine,
  costs: ForeignTradeCostLine[],
): HydratedActualAmounts {
  const current = {
    netClp: finite(line.actual_net_clp),
    vatClp: finite(line.actual_vat_clp),
    totalClp: finite(line.actual_total_clp),
    amountOriginal: finite(line.actual_amount_original),
    currency: normalizeCurrency(line.actual_currency),
    exchangeRateClp: nullableFinite(line.actual_exchange_rate_clp),
    sourceCostLineId: null,
  };
  if (current.netClp > 0 || current.vatClp > 0 || current.totalClp > 0) return current;

  const source = costs.find((cost) => cost.id === line.applied_cost_line_id)
    || costs.find((cost) => String(cost.metadata?.reconciliation_line_id || "") === line.id)
    || null;
  if (!source) return current;
  if (
    isIncludedInForeignTradeAgencyReconciliation(line) &&
    !isIncludedInForeignTradeAgencyReconciliation({ notes: source.notes, metadata: source.metadata })
  ) return current;

  const metadata = source.metadata || {};
  const vatClp = nonNegative(metadata.vat_amount_clp);
  const storedAmountClp = nonNegative(source.amount_clp);
  const grossClp = nonNegative(metadata.gross_amount_clp) || storedAmountClp;
  const isGross = metadata.amount_basis === "gross";
  const netClp = isGross ? Math.max(0, grossClp - vatClp) : storedAmountClp;
  const totalClp = grossClp || roundMoney(netClp + vatClp);
  const sourceCurrency = normalizeCurrency(metadata.source_currency || source.currency);
  const amountOriginal = nonNegative(metadata.source_original_amount) || nonNegative(source.amount_original);
  const exchangeRateClp = sourceCurrency === "CLP"
    ? 1
    : nullableFinite(metadata.source_exchange_rate_clp) ?? nullableFinite(source.exchange_rate_clp);

  return {
    netClp,
    vatClp,
    totalClp,
    amountOriginal: amountOriginal || (sourceCurrency === "CLP" ? totalClp : 0),
    currency: sourceCurrency,
    exchangeRateClp,
    sourceCostLineId: source.id,
  };
}

function normalizeCurrency(value: unknown) {
  const normalized = String(value || "CLP").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "CLP";
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableFinite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  return Math.max(0, finite(value));
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
