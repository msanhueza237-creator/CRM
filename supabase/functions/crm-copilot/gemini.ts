import { CopilotDataError, object, rows, type Row } from "./contracts.ts";
import { redactSecrets } from "./safety.ts";

export function geminiConfig(env: (name: string) => string | undefined) {
  const seconds = Number(env("GEMINI_LIVE_SESSION_SECONDS") || 900);
  return {
    apiKey: (env("GEMINI_API_KEY") || "").trim(),
    enabled: env("COPILOT_GEMINI_LIVE_ENABLED") !== "false",
    model: (env("GEMINI_LIVE_MODEL") || "gemini-3.8-live").trim(),
    voice: (env("GEMINI_LIVE_VOICE") || "Kore").trim(),
    maxSeconds: Number.isInteger(seconds) ? Math.max(60, Math.min(1800, seconds)) : 900,
  };
}
type GeminiSettings = ReturnType<typeof geminiConfig>;

export function geminiSetup(settings: GeminiSettings, instructions: string) {
  return {
    model: `models/${settings.model.replace(/^models\//, "")}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
    },
    systemInstruction: { parts: [{ text: instructions + "\nPara consultar el CRM llama ask_manager con la pregunta completa. No inventes cifras. Una sola solicitud consolidada por turno. Conserva las referencias a la conversacion previa. Solo el resultado de ask_manager permite dar cifras empresariales. No hay herramientas de escritura." }] },
    tools: [{ functionDeclarations: [{
      name: "ask_manager",
      description: "Consulta al Gerente del CRM y sus especialistas. Obligatoria para datos, analisis, informes y seguimientos empresariales; solo lectura.",
      parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "Pregunta completa del usuario, con referencias al contexto cuando corresponda." } }, required: ["question"] },
    }] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: false, prefixPaddingMs: 100, silenceDurationMs: 650 },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    },
  };
}

export function geminiHistory(history: Row[]) {
  return history.slice(-12).map(h => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: redactSecrets(String(h.content || "")).slice(0, 1600) }],
  }));
}

export async function createGeminiSession(settings: GeminiSettings, instructions: string, signal: AbortSignal, fetcher = fetch) {
  if (!settings.apiKey || !settings.enabled)
    throw new CopilotDataError("Gemini Live no esta configurado en el backend. Puedes elegir OpenAI Live.", "GEMINI_DISABLED");
  const expiresAt = new Date(Date.now() + settings.maxSeconds * 1000).toISOString();
  // Lock the entire setup server-side; the browser cannot substitute tools/model/instructions.
  const response = await fetcher("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ uses: 1, expireTime: expiresAt, newSessionExpireTime: new Date(Date.now() + 60000).toISOString(), bidiGenerateContentSetup: geminiSetup(settings, instructions) }),
  });
  if (!response.ok) {
    const code = response.status === 429 ? "GEMINI_QUOTA" : "GEMINI_SESSION_FAILED";
    throw new CopilotDataError(response.status === 429
      ? "Gemini alcanzo su cuota. Revisa la cuenta de Google o elige OpenAI Live."
      : "Google no pudo iniciar la voz. Revisa la clave, el modelo y los permisos de Gemini Live.", code);
  }
  const result = object(await response.json());
  if (typeof result.name !== "string" || !/^auth_tokens\/[A-Za-z0-9._~-]+$/.test(result.name))
    throw new CopilotDataError("Google no entrego una sesion temporal valida.", "GEMINI_INVALID_SESSION");
  return { credential: result.name, expiresAt, model: settings.model.replace(/^models\//, ""), maxSeconds: settings.maxSeconds };
}

export function geminiUsage(value: unknown) {
  const usage = object(value);
  const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : 0;
  const details = (v: unknown) => rows(v).filter(r => ["TEXT", "AUDIO"].includes(String(r.modality))).map(r => ({ modality: r.modality, tokenCount: count(r.tokenCount) }));
  return {
    promptTokenCount: count(usage.promptTokenCount), responseTokenCount: count(usage.responseTokenCount),
    totalTokenCount: count(usage.totalTokenCount), promptTokensDetails: details(usage.promptTokensDetails), responseTokensDetails: details(usage.responseTokensDetails),
  };
}
