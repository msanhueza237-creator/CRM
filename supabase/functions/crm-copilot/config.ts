import { modelPolicy } from "../_shared/openai-cost-policy.ts";
import { geminiConfig } from "./gemini.ts";
type Env = (name: string) => string | undefined;

export function copilotConfig(env: Env) {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = Number(env(name) || fallback);
    return Number.isInteger(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  };
  const effort = env("OPENAI_REASONING_EFFORT") || "auto";
  const rate = (name: string, fallback: number) => {
    const value = Number(env(name) ?? fallback);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const policy = modelPolicy(env);
  const deepseekModels = (env("COPILOT_DEEPSEEK_MODELS") || "deepseek-v4-pro,deepseek-flash")
    .split(",").map(m => m.trim()).filter(m => /^[a-zA-Z0-9._-]{1,100}$/.test(m));
  let deepseekRates: Record<string, { input: number; output: number }> = {
    "deepseek-v4-pro": { input: 1.32, output: 3.96 },
    "deepseek-flash": { input: 0.3, output: 1.2 },
  };
  try {
    const custom = JSON.parse(env("COPILOT_DEEPSEEK_RATES_JSON") || "{}");
    for (const [model, entry] of Object.entries(custom)) {
      const rate = entry as { input?: unknown; output?: unknown };
      if (rate && typeof rate.input === "number" && rate.input > 0 && typeof rate.output === "number" && rate.output > 0)
        deepseekRates[model] = { input: rate.input, output: rate.output };
    }
  } catch { deepseekRates = {}; }
  return {
    defaultModelChoice: env("COPILOT_DEFAULT_MODEL_CHOICE")?.trim() || (env("PROSPECTING_SECRET_ENCRYPTION_KEY") ? "deepseek:deepseek-v4-pro" : "openai:auto"),
    deepseek: { models: [...new Set(deepseekModels)], rates: deepseekRates, encryptionSecret: env("PROSPECTING_SECRET_ENCRYPTION_KEY") || "" },
    modelPolicy: policy,
    apiKey: (env("OPENAI_API_KEY") || "").trim(),
    gemini: geminiConfig(env),
    defaultVoiceProvider: env("COPILOT_DEFAULT_VOICE_PROVIDER") === "openai" ? "openai" : "gemini",
    model: policy.defaultModel,
    liveModel: (env("OPENAI_LIVE_MODEL") || "gpt-live-1").trim(),
    liveVoice: (env("OPENAI_LIVE_VOICE") || "marin").trim(),
    liveEnabled: env("COPILOT_LIVE_ENABLED") !== "false",
    liveUsdPerMinute: rate("OPENAI_LIVE_USD_PER_MINUTE", 0.05),
    inputUsdPerMillion: rate("OPENAI_INPUT_USD_PER_MILLION", 4),
    outputUsdPerMillion: rate("OPENAI_OUTPUT_USD_PER_MILLION", 20),
    reasoningEffort: ["auto", "none", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
      ? effort
      : "auto",
    timeoutMs: integer("COPILOT_TIMEOUT_MS", 50000, 15000, 180000),
    agentManagerEnabled: env("COPILOT_AGENT_MANAGER_ENABLED") !== "false",
    managerTimeoutMs: integer("COPILOT_MANAGER_TIMEOUT_MS", 150000, 30000, 180000),
    specialistTimeoutMs: integer("COPILOT_SPECIALIST_TIMEOUT_MS", 75000, 1000, 120000),
    sourceTimeoutMs: integer("COPILOT_SOURCE_TIMEOUT_MS", 20000, 1000, 45000),
    maxOutputTokens: Math.min(integer("COPILOT_MAX_OUTPUT_TOKENS", policy.outputTokens, 256, 8000), policy.outputTokens),
    sessionDays: integer("COPILOT_SESSION_DAYS", 30, 1, 90),
    historyMessages: integer("COPILOT_HISTORY_MESSAGES", 12, 2, 24),
  };
}

export function reasoningFor(message: string, configured = "auto"): string {
  if (configured !== "auto") return configured;
  const text = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/informe|por que|causa|proyecci|rentabilidad.*import|cruza|estrateg/.test(text)) return "high";
  if (/compara|versus|variaci|tendencia|analiza|margen/.test(text)) return "medium";
  return "low";
}
