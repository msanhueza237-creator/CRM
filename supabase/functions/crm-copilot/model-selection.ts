import { decryptApiKey } from "../prospecting-integrations/deepseek.ts";
import { CopilotDataError, object, type Row } from "./contracts.ts";
import type { CopilotSources } from "./sources.ts";
import type { copilotConfig } from "./config.ts";
import { ModelRouter, type ModelCallContext } from "./model-router.ts";
import { ModelCostStore } from "./model-cost-store.ts";
import { DeepSeekRouter } from "./deepseek-router.ts";

type Settings = ReturnType<typeof copilotConfig>;
export type ModelEngine = Pick<ModelRouter, "policy" | "call" | "escalate" | "usage" | "notices" | "stopped" | "manualSol">;
export interface ModelChoice { id: string; provider: "deepseek" | "openai"; model: string; label: string }
const integrationPath = "prospecting_ai_integrations?select=status,models&provider=eq.deepseek&limit=1";

export async function modelCatalog(source: CopilotSources, settings: Settings) {
  const models: ModelChoice[] = [], warnings: string[] = [];
  if (settings.deepseek.encryptionSecret) {
    try {
      const integration = (await source.select(integrationPath))[0];
      if (integration?.status === "verified" && Array.isArray(integration.models)) {
        const verifiedModels = integration.models;
        for (const model of settings.deepseek.models.filter(m => verifiedModels.includes(m))) {
          models.push({ id: `deepseek:${model}`, provider: "deepseek", model, label: `DeepSeek · ${model}` });
        }
      } else warnings.push("Verifica la conexion DeepSeek en Prospeccion para habilitar sus modelos.");
    } catch { warnings.push("No se pudo comprobar la conexion DeepSeek. No se cambiara de proveedor automaticamente."); }
  }
  if (settings.apiKey) {
    models.push({ id: "openai:default", provider: "openai", model: settings.modelPolicy.defaultModel, label: `OpenAI · ${settings.modelPolicy.defaultModel}` });
    models.push({ id: "openai:auto", provider: "openai", model: settings.modelPolicy.defaultModel, label: "OpenAI · Politica automatica" });
    if (settings.modelPolicy.mode !== "luna_only" && settings.modelPolicy.maxSolCalls > 0)
      models.push({ id: "openai:review", provider: "openai", model: settings.modelPolicy.escalationModel, label: `OpenAI · ${settings.modelPolicy.escalationModel} (revision final)` });
  }
  // An explicit default never silently falls back to a different provider.
  const defaultId = settings.defaultModelChoice;
  return { models, defaultId, warnings };
}

export function chooseModel(catalog: Awaited<ReturnType<typeof modelCatalog>>, requested: unknown, saved?: unknown) {
  const id = requested === undefined ? saved ?? catalog.defaultId : requested;
  const choice = typeof id === "string" && catalog.models.find(m => m.id === id);
  if (!choice) throw new CopilotDataError("El modelo elegido no esta disponible. Revisa la conexion o selecciona otro modelo del catalogo.", "MODEL_UNAVAILABLE");
  return choice;
}

export async function selectedModelRouter(source: CopilotSources, settings: Settings, choice: ModelChoice, context: ModelCallContext, fetcher: typeof fetch = fetch): Promise<ModelEngine> {
  if (choice.provider === "openai") {
    const policy = choice.id === "openai:default" ? { ...settings.modelPolicy, mode: "luna_only" as const } : settings.modelPolicy;
    return new ModelRouter(policy, { ...context, reviewRequested: choice.id === "openai:review" }, new ModelCostStore(source.config, fetcher), settings.apiKey, fetcher);
  }
  // Decrypt only on the authenticated server path, never in a tool result or catalog.
  const integration = (await source.select("prospecting_ai_integrations?select=status,models,api_key_encrypted&provider=eq.deepseek&limit=1"))[0];
  if (integration?.status !== "verified" || !Array.isArray(integration.models) || !integration.models.includes(choice.model) || !integration.api_key_encrypted) {
    throw new CopilotDataError("La conexion DeepSeek cambio. Verificala antes de continuar.", "MODEL_UNAVAILABLE");
  }
  let key: string;
  try { key = await decryptApiKey(String(integration.api_key_encrypted), settings.deepseek.encryptionSecret); }
  catch { throw new CopilotDataError("No se pudo abrir la conexion segura DeepSeek. Revisa su configuracion en el servidor.", "MODEL_UNAVAILABLE"); }
  const audit = async (data: Row) => {
    await source.request("rest/v1/copilot_audit_events", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ user_id: context.userId, conversation_id: context.conversationId, request_id: context.requestId,
        trace_id: context.requestId, event_type: "copilot_model_call", model: choice.model, result: data.status,
        permission_decision: "role_scoped_read", risk_level: "read", affected_count: 0,
        metadata_redacted: { provider: choice.provider, ...data } }),
    });
  };
  return new DeepSeekRouter(settings.modelPolicy, choice.model, key, object(settings.deepseek.rates[choice.model]), audit, fetcher);
}
