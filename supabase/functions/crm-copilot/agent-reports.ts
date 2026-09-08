import { object, rows, type Row } from "./contracts.ts";

const reportKeys: Record<string, string> = {
  commercial: "commercial_report", marketing: "marketing_report",
  finance: "financial_report", collections: "collections_report",
  logistics: "logistics_report", foreign_trade: "foreign_trade_report",
  executive: "executive_brief",
};

// Only business evidence is exposed, never task input, credentials or executable proposals.
const blocked = /password|secret|token|authorization|api.?key|email_body|whatsapp_body|prompt|electronic_document/i;
export function agentReport(task: Row) {
  const result = object(task.result);
  const evidence = rows(result.evidence);
  const key = reportKeys[String(task.agent_type)];
  const embedded = evidence.map((e) => object(e[key])).find((e) => Object.keys(e).length);
  const report = embedded || (task.agent_type === "collections" ? evidence[0] : null) || {};
  const sections: Row = { metrics: object(result.metrics), ...report };
  delete sections.proposals;
  const metadata = {
    task_id: task.id, agent: task.agent_type, completed_at: task.completed_at,
    source_updated_at: report.generated_at ?? report.as_of ?? null,
    period_start: report.period_start ?? null, period_end: report.period_end ?? null,
    summary: String(result.summary || "Sin resumen"), warnings: result.warnings ?? [],
    classification: "Analisis historico del agente; no acredita valores actuales",
  };
  return { metadata, sections: Object.fromEntries(Object.entries(sections).filter(([k]) => !blocked.test(k))) };
}

export function agentSectionRows(value: unknown): Row[] {
  const safe = (v: unknown, depth = 0): unknown => {
    if (v == null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + " [texto abreviado]" : v;
    if (depth >= 4) return "[detalle anidado: consultar informe del agente]";
    if (Array.isArray(v)) return v.length > 20 ? { items: v.length, detail: "Consultar seccion del informe original" } : v.map((item) => safe(item, depth + 1));
    return Object.fromEntries(Object.entries(object(v)).filter(([k]) => !blocked.test(k)).map(([k, item]) => [k, safe(item, depth + 1)]));
  };
  const flatten = (v: unknown): Row => Object.fromEntries(Object.entries(object(safe(v))).map(([k, item]) => [k, item && typeof item === "object" ? JSON.stringify(item) : item]));
  if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" ? flatten(item) : { value: safe(item) });
  if (value && typeof value === "object") return Object.entries(object(value)).filter(([k]) => !blocked.test(k)).map(([field, item]) => ({ field, value: item && typeof item === "object" ? JSON.stringify(safe(item)) : safe(item) }));
  return value == null ? [] : [{ value: safe(value) }];
}
