import { CopilotDataError, object, type Row } from "./contracts.ts";
import type { CopilotSources } from "./sources.ts";
import type { copilotConfig } from "./config.ts";
import { specialists } from "./agent-manager.ts";
import { ModelCostStore } from "./model-cost-store.ts";
import { effectiveMode } from "../_shared/openai-cost-policy.ts";

export async function agentObservability(source: CopilotSources, settings: ReturnType<typeof copilotConfig>) {
  if (source.actor.role !== "administrador") throw new CopilotDataError("Solo administracion.", "FORBIDDEN");
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const events = await source.select(`copilot_audit_events?select=created_at,model,result,latency_ms,tokens_input,tokens_output,metadata_redacted&event_type=eq.agent_read_run&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc,id.desc&limit=1001`);
  let costs: Row;
  try {
    costs = await new ModelCostStore(source.config).summary(settings.modelPolicy);
  } catch { costs = { error: "Control de gasto no disponible. Verifica la migracion openai_cost_guard.sql antes de habilitar llamadas." }; }
  return { ...aggregateAgentUsage(events, settings, since), costs, modelPolicy: {
    defaultModel: settings.modelPolicy.defaultModel, escalationModel: settings.modelPolicy.escalationModel,
    mode: effectiveMode(settings.modelPolicy, String(object(costs.policy).mode || "")),
    economy: settings.modelPolicy.economy, guardEnabled: settings.modelPolicy.guardEnabled, maxSolCalls: settings.modelPolicy.maxSolCalls,
    budget: settings.modelPolicy.dailyBudgetUsd, solBudget: settings.modelPolicy.solBudgetUsd, warningPercent: settings.modelPolicy.warningPercent,
  } };
}
export function aggregateAgentUsage(events: Row[], settings: Pick<ReturnType<typeof copilotConfig>, "inputUsdPerMillion" | "outputUsdPerMillion" | "agentManagerEnabled">, since: string) {
  const agents = [{ id: "executive", label: "Gerente" }, ...specialists].map(agent => ({
    agent: agent.id, label: agent.label, runs: 0, failed: 0, partial: 0, durationMs: 0,
    tokensInput: 0, tokensOutput: 0, modelCalls: 0, estimatedUsd: 0, lastAt: null as string | null, models: [] as string[],
  }));
  for (const event of events.slice(0, 1000)) {
    const data = object(event.metadata_redacted), agent = agents.find(a => a.agent === data.agent);
    if (!agent) continue;
    const count = (n: unknown) => Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
    agent.runs++;
    if (["error", "unavailable", "forbidden"].includes(String(event.result))) agent.failed++;
    if (event.result === "partial") agent.partial++;
    agent.durationMs += count(event.latency_ms); agent.tokensInput += count(event.tokens_input); agent.tokensOutput += count(event.tokens_output);
    agent.modelCalls += count(data.modelCalls);
    agent.models = [...new Set([...agent.models, String(event.model)])];
    if (!agent.lastAt || String(event.created_at) > agent.lastAt) agent.lastAt = String(event.created_at);
    agent.estimatedUsd += typeof data.estimatedCost === "number" ? count(data.estimatedCost)
      : (count(event.tokens_input) * settings.inputUsdPerMillion + count(event.tokens_output) * settings.outputUsdPerMillion) / 1000000;
  }
  return { enabled: settings.agentManagerEnabled, since, partial: events.length > 1000, sampledRuns: Math.min(events.length, 1000), agents,
    estimateNote: "Costo orientativo con tarifas configuradas, sin descuentos de cache. No es una factura. Incluye solo consultas interactivas; correos y tareas programadas conservan su registro en Agentes." };
}
