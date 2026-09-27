type Env = (name: string) => string | undefined;
export type ModelMode = "luna_only" | "auto" | "sol_manual";
export const OPENAI_MODELS = { default: "gpt-5.6-luna", escalation: "gpt-5.6-sol" } as const;
export function modelPolicy(env: Env) {
  const number = (key: string, fallback: number, min = 0, max = Infinity) => {
    const value = Number(env(key) ?? fallback);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  const budget = (key: string) => {
    const value = env(key)?.trim();
    return value && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  };
  const mode = env("OPENAI_MODEL_MODE");
  return {
    defaultModel: env("OPENAI_DEFAULT_MODEL")?.trim() || OPENAI_MODELS.default,
    escalationModel: env("OPENAI_ESCALATION_MODEL")?.trim() || OPENAI_MODELS.escalation,
    mode: (["luna_only", "auto", "sol_manual"].includes(mode || "") ? mode : "auto") as ModelMode,
    guardEnabled: env("OPENAI_COST_GUARD_ENABLED") !== "false",
    autoEscalation: env("OPENAI_SOL_AUTO_ESCALATION") !== "false",
    economy: env("ECONOMY_MODE") !== "false",
    maxSolCalls: Math.floor(number("OPENAI_MAX_SOL_CALLS_PER_REQUEST", 1, 0, 1)),
    dailyBudgetUsd: budget("DAILY_OPENAI_BUDGET_USD"),
    solBudgetUsd: budget("DAILY_OPENAI_SOL_BUDGET_USD"),
    warningPercent: number("WARNING_OPENAI_BUDGET_PERCENT", 70, 1, 100),
    outputTokens: Math.floor(number("OPENAI_ROUTER_MAX_OUTPUT_TOKENS", 2400, 256, 8000)),
    specialistTokens: Math.floor(number("OPENAI_SPECIALIST_MAX_OUTPUT_TOKENS", 1600, 256, 4000)),
    documentTokens: Math.floor(number("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS", 12000, 2000, 20000)),
    testOutputTokens: Math.floor(number("OPENAI_TEST_MAX_OUTPUT_TOKENS", 512, 64, 1000)),
    cacheTtlMs: number("OPENAI_RESPONSE_CACHE_TTL_SECONDS", 60, 0, 120) * 1000,
    maxRequestCalls: Math.floor(number("OPENAI_MAX_MODEL_CALLS_PER_REQUEST", 32, 1, 64)),
    inputMaxBytes: Math.floor(number("OPENAI_MAX_CONTEXT_BYTES", 200000, 8000, 250000)),
    rates: {
      luna: { input: number("OPENAI_LUNA_INPUT_USD_PER_MILLION", 0.2, 0.000001), output: number("OPENAI_LUNA_OUTPUT_USD_PER_MILLION", 1.2, 0.000001) },
      sol: { input: number("OPENAI_SOL_INPUT_USD_PER_MILLION", 4, 0.000001), output: number("OPENAI_SOL_OUTPUT_USD_PER_MILLION", 20, 0.000001) },
    },
  };
}
export type ModelPolicy = ReturnType<typeof modelPolicy>;
export function effectiveMode(policy: ModelPolicy, override?: string): ModelMode {
  if (policy.mode === "luna_only") return "luna_only";
  const mode = ["luna_only", "auto", "sol_manual"].includes(override || "") ? override as ModelMode : policy.mode;
  return mode === "auto" && !policy.autoEscalation ? "sol_manual" : mode;
}
export function explicitSolRequest(message: string) {
  const text = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  // Only a command at a sentence boundary in the current user message is authority.
  if (/\b(no|nunca|sin)\s+(?:\w+\s+){0,3}sol\b/.test(text)) return false;
  return /(?:^|[.!?\n]\s*)(?:por favor[, ]+)?(?:usa(?:r)?|utiliza|analizalo con|analiza con|haz un analisis profundo con)\s+(?:el modelo\s+)?(?:gpt-5\.6-)?sol\b/.test(text);
}
