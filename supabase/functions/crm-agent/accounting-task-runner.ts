import { isModuleAnalysisTask } from "../_shared/agent-module-contract.ts";

type Row = Record<string, unknown>;
type Rpc = (name: string, args: Row) => PromiseLike<{ error: { message: string } | null }>;

/** Executes read-only module reports at claim time, equally for manual and scheduled tasks. */
export async function runAccountingTask(input: {
  task: Row;
  workerId: string;
  leaseToken: string;
  rpc: Rpc;
  readReport: (lease: Row) => Promise<Row>;
}) {
  if (!isModuleAnalysisTask(input.task)) return false;
  const lease = { p_task_id: input.task.id, p_worker_id: input.workerId, p_lease_token: input.leaseToken };
  const heartbeat = await input.rpc("heartbeat_business_agent_task", { ...lease, p_lease_seconds: 180 });
  if (heartbeat.error) throw new Error("accounting_agent_lease_lost");
  try {
    const report = await input.readReport({ task_id: input.task.id, worker_id: input.workerId, lease_token: input.leaseToken });
    if (typeof report.summary !== "string" || !Array.isArray(report.evidence)
        || !Array.isArray(report.proposals) || report.proposals.length !== 0) {
      throw new Error("invalid_module_report");
    }
    const completed = await input.rpc("complete_business_agent_task", { ...lease, p_result: report });
    if (completed.error) throw new Error("module_completion_failed");
  } catch (error) {
    // No legacy fallback: an unavailable module must not produce a successful stale report.
    const code = error instanceof Error && /^(module_|content_module_|foreign_trade_|accounting_module_|previous_module_|invalid_accounting_)[a-zA-Z0-9_: -]{0,100}$/.test(error.message) ? `:${error.message}` : "";
    const failed = await input.rpc("fail_business_agent_task", { ...lease, p_error: `source_module_report_failed${code}` });
    if (failed.error) throw new Error("accounting_agent_lease_lost");
  }
  return true;
}
