export type AgentType = "commercial" | "marketing" | "finance" | "collections" | "logistics" | "foreign_trade" | "executive";
export type AgentTask = { id: string; agent_type: AgentType; action: string; status: string; created_at: string; error_code?: string | null; result?: { summary?: string; metrics?: Record<string, unknown>; warnings?: string[] } | null };
export type Proposal = { id: string; kind: string; title: string; summary: string; risk_level: string; status: string; created_at: string };
export type AgentActionItem = { id: string; kind: string; destination_module: string; destination_path: string; destination_record_id: string | null; title: string; summary: string | null; status: string; created_at: string };
export type RiskAlert = { id: string; sku: string; severity: string; title: string; detail: string };
export type Connection = { provider: string; status: string; message: string | null; last_success_at: string | null };
export type Delivery = { status: string; sent_at: string | null; created_at: string; error: string | null };
export const agentDefinitions = [
  { type: "executive", title: "Gerente", source: "Todos los modulos", href: "/dashboard", action: "prepare_brief", metric: "operating_profit", metricLabel: "Resultado operativo CLP", color: "green" },
  { type: "commercial", title: "Comercial", source: "Empresas y Finanzas", href: "/empresas", action: "review_pipeline", metric: "followups_overdue", metricLabel: "Seguimientos pendientes", color: "blue" },
  { type: "finance", title: "Finanzas", source: "Finanzas", href: "/finanzas-contabilidad", action: "review_margin", metric: "operating_profit", metricLabel: "Resultado operativo CLP", color: "teal" },
  { type: "collections", title: "Cobranza", source: "Cuentas por cobrar", href: "/finanzas-contabilidad?view=receivables", action: "review_aging", metric: "receivables", metricLabel: "Cartera informada CLP", color: "amber" },
  { type: "marketing", title: "Marketing", source: "Contenido y Campanas", href: "/contenido", action: "prepare_marketing_plan", metric: "pending_approval", metricLabel: "Publicaciones por aprobar", color: "rose" },
  { type: "logistics", title: "Logistica", source: "Catalogo e Importaciones", href: "/comercio-exterior", action: "review_logistics", metric: "stock_unknown", metricLabel: "SKU por verificar", color: "blue" },
  { type: "foreign_trade", title: "Comercio exterior", source: "Comercio Exterior", href: "/comercio-exterior", action: "review_import_plan", metric: "active_operations", metricLabel: "Operaciones abiertas", color: "green" },
] as const;
export const statusLabels: Record<string, string> = { completed: "Informe listo", pending: "En espera", in_progress: "Analizando", failed: "Revisar error", cancelled: "Cancelado", sent: "Enviado", sending: "Enviando", skipped: "Omitido", connected: "Conectado", degraded: "Revisar", error: "Error", pending_configuration: "Sin configurar", disabled: "Desactivado" };
export function chileDay(date: string | Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
}
export function agentActivity(tasks: AgentTask[], now = new Date()) {
  const today = chileDay(now);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 6 + i);
    const day = d.toISOString().slice(0, 10);
    const daily = tasks.filter((t) => chileDay(t.created_at) === day);
    return { day, label: new Intl.DateTimeFormat("es-CL", { weekday: "short", timeZone: "UTC" }).format(d), completed: daily.filter((t) => t.status === "completed").length, failed: daily.filter((t) => t.status === "failed").length, total: daily.length };
  });
}
export function approvedActionPath(item: AgentActionItem) {
  const destination = item.destination_path?.startsWith("/") && !item.destination_path.startsWith("//") ? item.destination_path : "/agentes";
  return item.destination_record_id && ["collections", "commercial", "executive"].includes(item.destination_module)
    ? `${destination}${destination.includes("?") ? "&" : "?"}task=${encodeURIComponent(item.destination_record_id)}#approved-task` : destination;
}
export const proposalDestinations: Record<string, string> = { campaign_draft: "Borrador en Campanas", purchase_order: "Borrador de compra para revision", collection_reminder: "Seguimiento interno de cobranza", commercial_follow_up: "Seguimiento comercial", executive_alert: "Decision gerencial" };
