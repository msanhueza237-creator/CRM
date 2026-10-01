import { dashboardDocumentSales } from "../accounting-center/dashboard-sales.ts";
import { isNonSalesEvidence } from "../accounting-center/profitability-issues.ts";
import { salesDocuments } from "./business-analytics.ts";
import { readResult, type ReadResult, type Row } from "./contracts.ts";
import { todayChile } from "./dates.ts";
import type { CopilotSources } from "./sources.ts";

// Sensitivity scenarios, not a fitted forecast or a statistical confidence interval.
export function monthlySalesScenario(documents: Row[], today: string, observedAt: string | null, now = Date.now()) {
  const [year, month, day] = today.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate(), elapsed = day - 1;
  const from = `${today.slice(0, 7)}-01`, through = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
  const horizon = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const cohort = [...new Map(documents.map(d => [String(d.id), d])).values()].filter(d => String(d.issued_on) >= from && String(d.issued_on) <= through);
  const relevant = cohort.filter(d => !isNonSalesEvidence(d));
  const values = relevant.map(d => dashboardDocumentSales(d));
  const excluded = values.filter(v => v === null).length;
  const sales = Math.round(values.reduce<number>((sum, v) => sum + (v ?? 0), 0) * 10000) / 10000;
  const stamp = Date.parse(observedAt || "");
  const freshness = !Number.isFinite(stamp) || stamp > now ? "unknown" : now - stamp > 86400000 ? "old" : "recent";
  const blocked = elapsed < 3 ? "Menos de tres días completos: no se extrapola el inicio del mes." : !relevant.length ? "Sin documentos: ausencia de evidencia no equivale a cero ventas." : excluded ? "Hay ventas con importe/validación pendiente; revisar antes de extrapolar el total." : sales <= 0 ? "Base neta no positiva: no es defendible extrapolar crecimiento." : freshness === "old" ? "Fuente antigua: actualizar/verificar antes de proyectar el cierre actual." : null;
  const rate = !blocked ? sales / elapsed : null;
  const scenarios = rate === null ? [] : [
    { name: "Conservador", remainingRateFactor: .75 }, { name: "Base", remainingRateFactor: 1 }, { name: "Optimista", remainingRateFactor: 1.25 },
  ].map(s => ({ ...s, sales: Math.round(sales + rate * (days - elapsed) * s.remainingRateFactor) }));
  return { from, through, horizon, observedAt, generatedAt: new Date(now).toISOString(), freshness, elapsedDays: elapsed,
    documents: relevant.length, excludedByPolicy: cohort.length - relevant.length, excludedDocuments: excluded, actualKnownNetSales: relevant.length ? sales : null,
    scenarios, blocked, confidence: scenarios.length ? elapsed < 7 || freshness !== "recent" ? "muy baja" : "baja" : "no estimable",
    method: "Ventas netas emitidas sin IVA, NC descontadas una vez; ritmo por día calendario completo. Hoy se excluye por estar incompleto. Escenarios varían solo el ritmo restante -25%, 0%, +25%: supuestos de sensibilidad, no probabilidades ni intervalo estadístico.",
    assumptions: ["No modela estacionalidad, días hábiles, cartera de pedidos ni nuevas importaciones.", "Supone que el ritmo observado puede continuar; cambios de mezcla o ventas excepcionales lo invalidan.", "No representa utilidad, caja disponible ni cobros asegurados."],
    margin: null, marginReason: "Este escenario solo proyecta ventas. Revisar rentabilidad y cobertura de costos antes de construir un escenario de margen.",
    action: { label: "Revisar costos y documentos pendientes en Rentabilidad", path: "/dashboard" } };
}

export async function salesProjectionTool(source: CopilotSources, now = new Date()) {
  const today = todayChile(now), from = `${today.slice(0, 7)}-01`;
  const through = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const documents = through < from ? [] : await salesDocuments(source, { from, to: through });
  const connections = await source.all("integration_connections?select=last_success_at&provider=eq.facto&limit=1");
  const observedAt = typeof connections[0]?.last_success_at === "string" ? connections[0].last_success_at : null;
  const data = monthlySalesScenario(documents, today, observedAt, now.getTime());
  const summary = data.blocked || `Escenarios condicionales de ventas al ${data.horizon}: ${data.scenarios.map(s => `${s.name} $${s.sales.toLocaleString("es-CL")} CLP`).join("; ")}. Confianza ${data.confidence}. No son promesas ni caja.`;
  const result = readResult("get_sales_projection", "finance", `${summary} Base ${data.from} a ${data.through}, ${data.elapsedDays} días completos. ${data.method} Fuente: ${data.observedAt || "fecha no confirmada"}; frescura ${data.freshness}. ${data.assumptions.join(" ")} ${data.marginReason} Siguiente paso: revisar Rentabilidad en Dashboard.`, data,
    [{ label: "Ventas documentales y pendientes de rentabilidad", path: "/dashboard", entityType: "finance", observedAt }],
    { status: "partial", warnings: [...data.assumptions, ...(data.freshness === "unknown" ? ["Frescura desconocida: escenario condicional sobre la evidencia disponible, no cierre actualizado."] : [])], coverage: { complete: !data.excludedDocuments && data.documents > 0, totalMatched: data.documents, returned: data.documents } });
  result.table = { title: "Escenarios de sensibilidad — estimaciones, no hechos", columns: [{ key: "name", label: "Escenario" }, { key: "sales", label: "Ventas netas estimadas CLP" }, { key: "remainingRateFactor", label: "Factor de ritmo restante" }], rows: data.scenarios };
  return result;
}

// Preserve numeric assumptions and uncertainty when the manager answers this one tool.
export function canonicalSalesProjectionMessage(results: ReadResult[]): string | null {
  return results.length === 1 && results[0].toolName === "get_sales_projection" && results[0].status === "partial" ? results[0].summary : null;
}
