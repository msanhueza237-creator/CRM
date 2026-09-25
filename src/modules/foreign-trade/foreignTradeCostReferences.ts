import type { ForeignTradeCostLine } from "../../types/foreignTrade";

export function hasSimulatedCosts(costs: ForeignTradeCostLine[]) {
  return costs.some((cost) => cost.source_type === "simulated" && !cost.metadata?.excluded_from_costing);
}

export function referenceCostEditValues(cost: ForeignTradeCostLine | null, defaultRate: number | null) {
  const metadata = cost?.metadata || {};
  const net = Number(cost?.amount_clp || 0);
  const gross = Number(metadata.gross_amount_clp || 0);
  const vat = Number(metadata.vat_amount_clp || 0);
  const original = Number(cost?.amount_original || 0);
  const reference = Boolean(metadata.simulation_reference);
  const rate = cost?.currency === "CLP" ? 1 : cost?.exchange_rate_clp;
  const converted = original * Number(rate || 0);
  // Reconciliations can retain a gross original amount alongside a net CLP cost.
  const grossOriginal = reference && gross > net && vat > 0
    && (Math.abs(converted - gross) < 2 || (!rate && original > 0));
  return {
    amountBasis: grossOriginal ? "gross" as const : metadata.amount_basis || "net" as const,
    vatRatePercent: reference && vat > 0 && net > 0 ? vat / net * 100 : Number(metadata.vat_rate_percent || 0),
    exchangeRateClp: rate || (reference && original > 0 && net > 0
      ? (grossOriginal ? gross : net) / original : defaultRate),
  };
}
