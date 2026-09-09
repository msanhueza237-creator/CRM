type Row = Record<string, unknown>;
import { accountingAgents, isModuleLease } from "../_shared/agent-module-contract.ts";
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const number = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const money = (value: unknown) => number(value) === null ? "no disponible" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(value));

export function isAccountingAnalysisTask(task: Row) {
  return (task.agent_type === "finance" && task.action === "review_margin")
    || (task.agent_type === "collections" && task.action === "review_aging");
}

export function hasAccountingTaskLease(task: Row | undefined, input: Row, now: number) {
  return Boolean(task && accountingAgents.includes(String(task.agent_type)) && isModuleLease(task, input, now));
}

/** Uses the module's calculated values, never a browser snapshot or invoice totals as debt. */
export function buildAccountingAgentReport(agent: "finance" | "collections", data: Row, consultedAt: string) {
  const summary = object(data.summary);
  const dashboard = object(data.dashboard);
  const current = object(dashboard.current);
  const snapshot = object(data.factoReceivables);
  const freshness = object(data.factoFreshness);
  const available = dashboard.available === true;
  const suppressed = summary.receivables_suppressed === true;
  const verified = !suppressed && snapshot.authoritative === true && snapshot.portfolioComplete === true;
  const warnings = Array.isArray(dashboard.warnings) ? dashboard.warnings.map(String) : [];
  if (summary.provisional === true) warnings.push("El modulo mantiene el resultado provisional; no constituye un cierre contable.");
  if (freshness.stale === true) warnings.push("Hay una sincronizacion de origen pendiente de consolidar en Finanzas.");
  if (!verified) warnings.push("La cartera es operacional o incompleta; no se habilitan recordatorios automaticos.");
  if (suppressed) warnings.push("Finanzas detecto una lectura parcial inconsistente: los totales de cobranza no estan disponibles.");
  if (snapshot.asOf && String(snapshot.asOf) < String(summary.as_of || "")) warnings.push(`La cartera conserva el corte de origen ${snapshot.asOf}; no es una lectura en vivo.`);
  const metrics: Row = {
    receivables: suppressed ? null : number(summary.receivables),
    overdue_amount: suppressed ? null : number(summary.receivables_overdue),
    bank_confirmed_receivables: number(summary.receivables_confirmed),
    verified_receivables_available: verified,
  };
  if (agent === "finance") Object.assign(metrics, {
    net_sales: available ? number(current.sales) : null,
    cost_of_sales: available ? number(current.costs) : null,
    operating_expenses: available ? number(current.expenses) : null,
    gross_profit: available ? number(current.grossProfit) : null,
    operating_profit: available ? number(current.operatingProfit) : null,
    gross_margin: available ? number(current.grossMargin) : null,
    bank_clp: number(summary.bank_clp),
    payables: number(summary.payables),
    checks_portfolio: number(summary.checks_portfolio),
  });
  const report = {
    contract_version: 1,
    module: "accounting-center",
    entity: data.entity,
    consulted_at: consultedAt,
    as_of: summary.as_of,
    source_as_of: snapshot.asOf || null,
    period: { from: dashboard.from, to: dashboard.to },
    currency: "CLP",
    basis: agent === "finance" ? dashboard.basis : summary.receivables_data_quality,
    provisional: summary.provisional === true || !available || !verified,
    summary,
    metrics,
    dashboard: agent === "finance" ? dashboard : undefined,
    bankReality: agent === "finance" ? data.bankReality : undefined,
    freshness,
    // The verified breakdown and operational ledger stay separate to avoid double counting.
    verified_documents: verified && Array.isArray(snapshot.details) ? snapshot.details : [],
    operational_documents: Array.isArray(data.receivables) ? data.receivables : [],
    source_documents: Array.isArray(data.sources) ? data.sources.map((value) => {
      const row = object(value);
      return Object.fromEntries(["id", "document_type", "folio", "issued_on", "counterpart_name", "counterpart_tax_id", "currency", "net_amount", "total_amount", "status", "source_updated_at"].map((key) => [key, row[key] ?? null]));
    }) : [],
    links: [
      { label: "Cuentas por cobrar", href: "/finanzas-contabilidad?view=receivables" },
      { label: "Resumen financiero", href: "/finanzas-contabilidad?view=dashboard" },
      { label: "Informes contables", href: "/finanzas-contabilidad?view=reports" },
    ],
  };
  return {
    summary: agent === "finance"
      ? `Finanzas (${dashboard.from || "sin inicio"} al ${dashboard.to || "sin cierre"}): ventas ${money(metrics.net_sales)}, costo de ventas ${money(metrics.cost_of_sales)}, resultado operativo ${money(metrics.operating_profit)}. Cartera ${money(metrics.receivables)}. Base: ${dashboard.basis || "no disponible"}.`
      : `Cartera del modulo Finanzas: ${money(metrics.receivables)}; vencido ${money(metrics.overdue_amount)}. Corte de origen: ${snapshot.asOf || "no disponible"}. La confirmacion bancaria se presenta por separado; no se enviaron recordatorios.`,
    metrics,
    evidence: [{ accounting_module_report: report }],
    warnings: [...new Set(warnings)],
    proposals: [],
  };
}
