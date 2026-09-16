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
  const effort = env("OPENAI_REASONING_EFFORT") || "low";
  return {
    apiKey: (env("OPENAI_API_KEY") || "").trim(),
    model: (
      env("OPENAI_MODEL") ||
      env("OPENAI_COPILOT_MODEL") ||
      "gpt-5.6-sol"
    ).trim(),
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
      ? effort
      : "low",
    timeoutMs: integer("COPILOT_TIMEOUT_MS", 50000, 15000, 180000),
    sourceTimeoutMs: integer("COPILOT_SOURCE_TIMEOUT_MS", 20000, 1000, 45000),
    maxOutputTokens: integer("COPILOT_MAX_OUTPUT_TOKENS", 5000, 1000, 12000),
    sessionDays: integer("COPILOT_SESSION_DAYS", 30, 1, 90),
    historyMessages: integer("COPILOT_HISTORY_MESSAGES", 12, 2, 24),
  };
}
