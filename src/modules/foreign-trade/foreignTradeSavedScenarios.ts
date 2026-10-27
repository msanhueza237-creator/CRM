import type { ForeignTradeScenario, ForeignTradeScenarioSnapshot } from "../../types/foreignTrade";

export function scenarioSnapshot(scenario: ForeignTradeScenario, operationId: string): ForeignTradeScenarioSnapshot | null {
  const snapshot = scenario.assumptions?.snapshot;
  if (scenario.operation_id !== operationId || !snapshot || snapshot.version !== 1
    || snapshot.operation_id !== operationId || !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.costs)
    || snapshot.lines.some((line) => !line || line.operation_id !== operationId)
    || snapshot.costs.some((cost) => !cost || cost.operation_id !== operationId)) return null;
  return snapshot;
}

const number = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });
export function scenarioNumber(value: unknown, unit = "") {
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
    ? "No registrado" : `${number.format(Number(value))}${unit ? ` ${unit}` : ""}`;
}

export function scenarioComparison(scenario: ForeignTradeScenario): [string, string][] {
  const assumptions = scenario.assumptions?.costing;
  return [
    ["Tipo de cambio", scenarioNumber(scenario.exchange_rate_clp, "CLP/USD")],
    ["CIF manual", assumptions?.cif_total_original === null ? "Automático desde productos y gastos" : scenarioNumber(assumptions?.cif_total_original, "USD")],
    ["Distribución", ({ fob_value: "Valor FOB", cif_value: "Valor CIF", units: "Unidades", weight: "Peso", cbm: "CBM", combined: "Combinación", manual: "Manual" })[scenario.allocation_method] || "No registrado"],
    ["Método de precio", assumptions?.pricing_method === "margin_on_sale" ? "Margen sobre venta neta" : assumptions?.pricing_method === "markup_on_cost" ? "Markup sobre costo" : "No registrado"],
    ["Objetivo general", scenarioNumber(assumptions?.target_percent, "%")],
    ["Derecho general", scenarioNumber(assumptions?.general_duty_percent, "%")],
    ["IVA importación / venta", `${scenarioNumber(assumptions?.import_vat_percent, "%")} / ${scenarioNumber(assumptions?.sales_vat_percent, "%")}`],
    ["IVA importación recuperable", assumptions?.import_vat_recoverable === undefined ? "No registrado" : assumptions.import_vat_recoverable ? "Sí, crédito fiscal" : "No, incorporado al costo"],
    ["Costo bodega (sin IVA recuperable)", scenarioNumber(scenario.landed_total_clp, "CLP")],
    ["Gastos operativos netos", scenarioNumber(scenario.logistics_total_clp, "CLP")],
    ["Derechos", scenarioNumber(scenario.duties_total_clp, "CLP")],
    ["IVA importación", scenarioNumber(scenario.taxes_total_clp, "CLP")],
    ["Venta neta proyectada", scenarioNumber(scenario.projected_sales_clp, "CLP")],
    ["Utilidad proyectada", scenarioNumber(scenario.projected_profit_clp, "CLP")],
    ["Margen sobre venta neta", scenarioNumber(scenario.projected_margin_percent, "%")],
  ];
}
