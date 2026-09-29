import { CopilotDataError, object, tableResult, type ReadResult, type Row } from "./contracts.ts";
import { dateRange, todayChile } from "./dates.ts";
import type { CopilotSources } from "./sources.ts";
import type { CustomerProfitabilityReport } from "../_shared/customer-profitability-contract.ts";

export async function customerProfitabilityTool(source: CopilotSources, args: Row) {
  const range = dateRange(args);
  if (range.to > todayChile()) range.to = todayChile();
  const params = new URLSearchParams({ ...range, limit: String(args.limit || 10) });
  if (args.query) params.set("query", String(args.query));
  const report = await source.api("accounting-center", `customer-profitability?${params}`) as unknown as CustomerProfitabilityReport;
  const bySales = args.sort_by === "sales";
  const byMargin = args.sort_by === "margin";
  if (bySales && (!Array.isArray(report.topSales) || !Number.isFinite(report.salesCustomers)))
    throw new CopilotDataError("El servicio de rentabilidad no dispone del ranking por ventas. No se sustituira por otro ranking.", "SOURCE_UNAVAILABLE");
  const records = bySales ? report.topSales : byMargin ? report.topMargin : report.topProfit;
  const selectedPending = records.filter(row => row.status !== "complete").length;
  const totalMatched = bySales ? report.salesCustomers : report.rankedCustomers;
  const sortBy = bySales ? "sales" : byMargin ? "margin" : "gross_profit";
  const title = `${bySales ? "Rentabilidad de clientes con mayores ventas netas" : `Clientes por ${byMargin ? "margen bruto (%)" : "utilidad bruta (CLP)"}`} · ${range.from} a ${range.to}`;
  const warnings = [...report.warnings];
  if (bySales) warnings.push(
    "Seleccion por ventas netas sin IVA, descontando notas de credito, no por utilidad. No se reemplazan clientes del top por tener costos pendientes. Solo empresas identificadas y con ventas netas positivas.",
    "Cobertura de costo es el porcentaje de documentos con evidencia, no el porcentaje del monto vendido. El margen historico no es un descuento autorizado ni garantiza el margen de una nueva cotizacion.");
  const tableRows = bySales ? records.map((row, index) => ({ ...row, salesRank: index + 1,
    costStatus: row.status === "complete" ? "Verificado" : "Costos/reversas pendientes" })) : records;
  const result = tableResult("get_customer_profitability", "finance", title, tableRows as unknown as Row[], [
    ...(bySales ? [{ key: "salesRank", label: "Posicion por ventas" }] : []),
    { key: "customer", label: "Cliente" }, { key: "taxId", label: "RUT" },
    { key: "sales", label: "Ventas netas CLP" }, { key: "cost", label: "Costo CLP" },
    { key: "grossProfit", label: "Utilidad bruta CLP" }, { key: "margin", label: "Margen %" },
    { key: "documents", label: "Documentos" },
    ...(bySales ? [{ key: "coverage", label: "Cobertura costo %" }, { key: "costStatus", label: "Estado del costo" }] : []),
  ], "/dashboard", { limit: args.limit || 10 }, warnings);
  const sum = (key: "sales" | "knownCost" | "cost" | "grossProfit") => Math.round(records.reduce((n, row) => n + (row[key] || 0), 0) * 10000) / 10000;
  const completeSelection = records.length > 0 && selectedPending === 0;
  const selectionSales = sum("sales"), selectionProfit = completeSelection ? sum("grossProfit") : null;
  const pendingSales = Math.round(records.filter(row => row.status !== "complete").reduce((n, row) => n + row.sales, 0) * 10000) / 10000;
  result.data = { ...range, basis: report.basis, currency: report.currency, sortBy, ranking: records,
    selection: { customers: records.length, completeCustomers: records.length - selectedPending, pendingCustomers: selectedPending,
      sales: selectionSales, pendingCostSales: pendingSales, completeCostSales: Math.round((selectionSales - pendingSales) * 10000) / 10000,
      knownCost: sum("knownCost"), cost: completeSelection ? sum("cost") : null,
      grossProfit: selectionProfit, margin: selectionProfit !== null && selectionSales > 0 ? Math.round(1000000 * selectionProfit / selectionSales) / 10000 : null },
    customers: report.customers, rankedCustomers: report.rankedCustomers, pendingCustomers: report.pendingCustomers,
    missingCostDocuments: report.missingCostDocuments, pendingCreditNotes: report.pendingCreditNotes,
    excludedDocuments: report.excludedDocuments, pending: report.pending };
  result.summary = bySales
    ? `${title}: primeros ${records.length} de ${totalMatched} clientes identificados con ventas netas positivas; ${selectedPending} de los seleccionados tienen utilidad y margen pendientes. No se sustituyeron por clientes de menor venta.`
    : `${title}: primeros ${records.length} de ${report.rankedCustomers} clientes comparables; ${report.pendingCustomers} pendientes fuera del ranking.`;
  result.coverage = { complete: true, totalMatched, returned: records.length };
  if (bySales && selectedPending) {
    result.status = "partial";
    result.summary += " No tengo informacion suficiente para calcularlo con precision para esos clientes: faltan costos o reversas verificadas. La utilidad y el margen global del top quedan pendientes.";
  } else if (!records.length && report.pendingCustomers) {
    result.status = "partial";
    result.summary = "No tengo informacion suficiente para calcularlo con precision. Hay clientes con costos, reversas o identidad pendientes; no se inventan margenes.";
  }
  if (bySales) {
    const clp = (value: number) => `$${value.toLocaleString("es-CL", { maximumFractionDigits: 0 })}`;
    const clean = (value: string) => value.replace(/[\r\n<>\[\]*`|]/g, " ");
    const percent = (value: number) => `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;
    const verified = records.filter(row => row.status === "complete");
    result.summary = [
      `**Rentabilidad de los ${records.length} mayores compradores por ventas netas.** Periodo ${range.from} a ${range.to}, CLP sin IVA y notas de credito descontadas.`,
      records.length ? `Ventas netas del grupo: **${clp(selectionSales)}**. ${verified.length} clientes tienen costos completos; ${selectedPending} tienen costos o reversas pendientes, con ventas netas por **${clp(pendingSales)}**. No se sustituyeron por clientes de menor venta.`
        : "No se encontraron clientes identificados con ventas netas positivas en el periodo y filtro consultados. Esto no confirma ausencia de ventas fuera de la evidencia disponible.",
      ...verified.map(row => `- ${clean(row.customer)}: ventas ${clp(row.sales)}, costo ${clp(row.cost!)}, utilidad bruta **${clp(row.grossProfit!)}**, margen **${percent(row.margin!)}**.`),
      selectedPending ? "No tengo informacion suficiente para calcularlo con precision: la utilidad y el margen del grupo quedan pendientes hasta completar costos y reversas. Pendiente no significa cero. El detalle de cada cliente queda en la tabla."
        : completeSelection ? `Utilidad bruta del grupo: **${clp(selectionProfit!)}**. Margen ponderado: **${percent(100 * selectionProfit! / selectionSales)}**.` : "",
      "Para negociar: el margen bruto historico no es un descuento autorizado ni garantiza el margen de una nueva venta. Hay que revisar productos, costos actuales, gastos y politica comercial; este analisis no modifica precios ni descuentos.",
    ].filter(Boolean).join("\n\n");
    result.data = { ...object(result.data), canonical_customer_profitability_summary: true };
  }
  return result;
}

// Reuse the manager's canonical-summary pattern for a single financial selection.
export function canonicalCustomerProfitabilityMessage(results: ReadResult[]): string | null {
  if (results.length !== 1) return null;
  const result = results[0];
  return result.toolName === "get_customer_profitability" && ["ok", "empty", "partial"].includes(result.status)
    && object(result.data).canonical_customer_profitability_summary === true ? result.summary : null;
}
