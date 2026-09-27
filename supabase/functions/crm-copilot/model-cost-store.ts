import { CopilotDataError, object, type Row, type RestConfig } from "./contracts.ts";
import type { ModelPolicy } from "../_shared/openai-cost-policy.ts";

export interface CostStore {
  reserve(value: Row): Promise<Row>;
  finish(value: Row): Promise<void>;
}
export class ModelCostStore implements CostStore {
  constructor(private config: Pick<RestConfig, "url" | "serviceRoleKey">, private fetcher: typeof fetch = fetch) {}
  async rpc(name: string, payload: Row): Promise<Row> {
    try {
      const response = await this.fetcher(`${this.config.url}/rest/v1/rpc/${name}`, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { apikey: this.config.serviceRoleKey, Authorization: `Bearer ${this.config.serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p: payload }),
      });
      if (!response.ok) throw new Error("cost store unavailable");
      return object(await response.json());
    } catch {
      throw new CopilotDataError("El control de gasto de OpenAI no esta disponible. No se iniciaran nuevas llamadas hasta recuperarlo.", "AI_COST_GUARD_UNAVAILABLE");
    }
  }
  reserve(value: Row) { return this.rpc("openai_cost_reserve", value); }
  async finish(value: Row) { await this.rpc("openai_cost_finish", value); }
  summary(policy: ModelPolicy) { return this.rpc("openai_cost_summary", { budget: policy.dailyBudgetUsd, sol_budget: policy.solBudgetUsd, warning_percent: policy.warningPercent }); }
  setMode(mode: string, actor: string, hours: number) { return this.rpc("openai_cost_set_mode", { mode, actor, hours }); }
}
