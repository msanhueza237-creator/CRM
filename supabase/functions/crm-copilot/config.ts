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
  return {
    apiKey: (env("OPENAI_API_KEY") || "").trim(),
    model: (
      env("OPENAI_REASONING_MODEL") ||
      env("OPENAI_MODEL") ||
      env("OPENAI_COPILOT_MODEL") ||
      "gpt-5.6-sol"
    ).trim(),
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
    sourceTimeoutMs: integer("COPILOT_SOURCE_TIMEOUT_MS", 20000, 1000, 45000),
    maxOutputTokens: integer("COPILOT_MAX_OUTPUT_TOKENS", 5000, 1000, 12000),
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
