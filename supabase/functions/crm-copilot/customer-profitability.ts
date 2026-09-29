import { tableResult, type Row } from "./contracts.ts";
import { dateRange, todayChile } from "./dates.ts";
import type { CopilotSources } from "./sources.ts";
import type { CustomerProfitabilityReport } from "../_shared/customer-profitability-contract.ts";

export async function customerProfitabilityTool(source: CopilotSources, args: Row) {
  const range = dateRange(args);
  if (range.to > todayChile()) range.to = todayChile();
  const params = new URLSearchParams({ ...range, limit: String(args.limit || 10) });
  if (args.query) params.set("query", String(args.query));
  const report = await source.api("accounting-center", `customer-profitability?${params}`) as unknown as CustomerProfitabilityReport;
  const byMargin = args.sort_by === "margin";
  const records = byMargin ? report.topMargin : report.topProfit;
  const title = `Clientes por ${byMargin ? "margen bruto (%)" : "utilidad bruta (CLP)"} · ${range.from} a ${range.to}`;
  const result = tableResult("get_customer_profitability", "finance", title, records as unknown as Row[], [
    { key: "customer", label: "Cliente" }, { key: "taxId", label: "RUT" },
    { key: "sales", label: "Ventas netas CLP" }, { key: "cost", label: "Costo CLP" },
    { key: "grossProfit", label: "Utilidad bruta CLP" }, { key: "margin", label: "Margen %" },
    { key: "documents", label: "Documentos" },
  ], "/dashboard", { limit: args.limit || 10 }, report.warnings);
  result.data = { ...range, basis: report.basis, currency: report.currency, ranking: records,
    customers: report.customers, rankedCustomers: report.rankedCustomers, pendingCustomers: report.pendingCustomers,
    missingCostDocuments: report.missingCostDocuments, pendingCreditNotes: report.pendingCreditNotes,
    excludedDocuments: report.excludedDocuments, pending: report.pending };
  result.summary = `${title}: primeros ${records.length} de ${report.rankedCustomers} clientes comparables; ${report.pendingCustomers} pendientes fuera del ranking.`;
  result.coverage = { complete: true, totalMatched: report.rankedCustomers, returned: records.length };
  if (!records.length && report.pendingCustomers) {
    result.status = "partial";
    result.summary = "No tengo informacion suficiente para calcularlo con precision. Hay clientes con costos, reversas o identidad pendientes; no se inventan margenes.";
  }
  return result;
}
