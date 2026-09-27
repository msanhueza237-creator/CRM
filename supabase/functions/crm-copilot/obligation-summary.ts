import { decimalSum, numeric, object, type ReadResult, type Row } from "./contracts.ts";

const clean = (value: unknown) => String(value ?? "").replace(/[\r\n<>\[\]*`]/g, " ");
const clp = (value: unknown) => `$${Number(value).toLocaleString("es-CL", { maximumFractionDigits: 4 })} CLP`;

// Aggregate the full filtered result before pagination or specialist preview truncation.
export function summarizeObligations(result: ReadResult, records: Row[], args: Row): ReadResult {
  const data = object(result.data);
  const payable = result.toolName === "get_accounts_payable";
  const total = numeric(data.selected_total_clp);
  const state = args.state || "pending";
  const fullPortfolio = state === "pending" && !args.query && !args.due_from && !args.due_to;
  const mismatch = fullPortfolio && numeric(data.dashboard_total_clp) !== null && total !== numeric(data.dashboard_total_clp);
  const certified = ["ok", "empty"].includes(result.status) && total !== null && !mismatch;
  const groups = new Map<string, Row[]>();
  for (const [index, record] of records.entries()) {
    const rut = String(record.rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
    const key = rut || `document:${record.id ?? index}`;
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  const counterparties = certified ? [...groups.values()].map(group => ({
    name: group[0].name, rut: group[0].rut || null,
    identity_scope: group[0].rut ? "tax_id" : "document_only",
    document_count: group.length,
    balance_operational_clp: decimalSum(group.map(r => r.balance_operational_clp)),
  })).sort((a, b) => Number(b.balance_operational_clp) - Number(a.balance_operational_clp)) : [];
  const sourceCounts = records.reduce<Record<string, number>>((counts, r) => {
    const key = String(r.balance_source);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const dates = records.map(r => String(r.reported_at || r.updated_at || "")).filter(Boolean).sort();
  if (mismatch) result.warnings.push("El total de la cartera consultada difiere del dashboard; requiere revision antes de certificarlo.");
  if (!certified) result.status = "partial";
  result.data = {
    ...data,
    selected_total_clp: certified ? data.selected_total_clp : null,
    selected_total_basis: "balance_operational_clp = reported_balance_clp when present; otherwise balance_clp. Never add both balances or subtract payments again.",
    source_document_counts: sourceCounts,
    scope: { query: args.query || null, state, due_from: args.due_from || null, due_to: args.due_to || null, full_portfolio: fullPortfolio },
    top_counterparties: counterparties.slice(0, 10),
    counterparties_total: certified ? counterparties.length : null,
    counterparties_omitted: Math.max(0, counterparties.length - 10),
    source_observed_from: dates[0] || null,
    source_observed_to: dates.at(-1) || null,
    canonical_obligation_summary: true,
  };
  const scope = fullPortfolio ? "cartera pendiente completa" : `seleccion ${state === "overdue" ? "vencida" : state === "all" ? "de documentos (incluye pagados)" : "pendiente"}${args.query ? ` para ${clean(args.query)}` : ""}${args.due_from || args.due_to ? `, vencimiento ${clean(args.due_from || "sin inicio")} al ${clean(args.due_to || "sin fin")}` : ""}`;
  result.summary = [
    certified
      ? `**Por ${payable ? "pagar" : "cobrar"}: ${clp(total)}** en ${records.length} documentos de la ${scope}.`
      : "No tengo informacion suficiente para certificar el total de esta cartera. Revisa las diferencias o el respaldo parcial indicado en las fuentes.",
    `Base: saldo operativo del CRM. Se utiliza el saldo informado por Facto cuando existe y, en los otros documentos, el saldo contable del CRM. No equivale a una conciliacion bancaria; no se suman ambos saldos ni se descuentan pagos por segunda vez.`,
    ...(certified && counterparties.length ? [
      `Mayores saldos de esta seleccion, calculados sobre todos los documentos coincidentes:`,
      ...counterparties.slice(0, 5).map(c => `- ${clean(c.name || "Contraparte no identificada")}${c.rut ? ` (${clean(c.rut)})` : " (sin RUT; sin agrupar con otros documentos)"}: **${clp(c.balance_operational_clp)}**.`),
    ] : []),
    `Consulta al ${clean(data.as_of)}. Fuentes guardadas en CRM${dates.length ? `, observadas entre ${dates[0]} y ${dates.at(-1)}` : "; fecha de origen no disponible"}; no es una lectura en vivo de Facto.`,
    ...(records.some(r => !r.due_on) ? ["Hay documentos sin vencimiento informado: no se puede afirmar que esten vencidos."] : []),
    ...result.warnings.filter(w => !w.startsWith("Saldo informado")),
  ].join("\n\n");
  return result;
}

export function canonicalObligationMessage(results: ReadResult[]): string | null {
  if (results.length !== 1) return null;
  const result = results[0];
  return ["get_accounts_receivable", "get_accounts_payable"].includes(result.toolName)
    && ["ok", "empty", "partial"].includes(result.status)
    && object(result.data).canonical_obligation_summary === true ? result.summary : null;
}
