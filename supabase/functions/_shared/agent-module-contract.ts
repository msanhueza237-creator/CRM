export type AgentRow = Record<string, unknown>;
export const moduleActions: Record<string, readonly string[]> = {
  commercial: ["review_pipeline", "review_customer_portfolio", "automatic_customer_product_opportunity_scan"],
  marketing: ["prepare_marketing_plan"],
  finance: ["review_margin"],
  collections: ["review_aging"],
  logistics: ["review_logistics"],
  foreign_trade: ["review_import_plan"],
  executive: ["prepare_brief", "analyze_company"],
};
export const accountingAgents = ["finance", "collections", "commercial", "executive"];
export function isModuleAnalysisTask(task: AgentRow) {
  return moduleActions[String(task.agent_type)]?.includes(String(task.action)) === true;
}
export function isModuleLease(task: AgentRow | undefined, input: AgentRow, now: number) {
  return Boolean(task && isModuleAnalysisTask(task) && task.status === "in_progress"
    && typeof input.worker_id === "string" && input.worker_id.length > 0
    && typeof input.lease_token === "string" && input.lease_token.length > 0
    && task.worker_id === input.worker_id && task.lease_token === input.lease_token
    && Date.parse(String(task.lease_expires_at)) > now);
}
