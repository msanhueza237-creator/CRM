import { getSupabaseFunctionUrl, supabase } from "./supabase";
export type CopilotComponent =
  | { type: "kpi"; title: string; value: number | null; unit: string; classification: "fact" | "calculation" | "estimate" }
  | { type: "chart"; chartType: "line" | "bar"; title: string; labels: string[]; series: Array<{ name: string; values: Array<number | null> }>; unit: string; classification: "fact" | "calculation" | "estimate" };
export interface CopilotTimings { modelMs: number; databaseMs: number; serviceMs: number; totalMs: number; requests: number; cacheHits: number }
export interface CopilotAgentRun { agent: string; status: string; durationMs: number; modelCalls: number; tokensInput: number; tokensOutput: number; tools: string[] }

export interface CopilotReadResult {
  toolName: string;
  domain: string;
  status: string;
  summary: string;
  data: unknown;
  warnings: string[];
  evidence: Array<{
    label: string;
    path: string;
    entityType: string;
    observedAt?: string | null;
  }>;
  coverage: {
    complete: boolean;
    totalMatched: number | null;
    returned: number;
    nextOffset?: number;
    from?: string;
    to?: string;
  };
  freshness: { fetchedAt: string; sourceObservedAt: string | null };
  table?: {
    title: string;
    columns: Array<{ key: string; label: string }>;
    rows: Record<string, unknown>[];
  };
  continuation?: { toolName: string; args: Record<string, unknown> };
  components?: CopilotComponent[];
}
export interface CompanyInsights {
  profile: CopilotReadResult; profitability: CopilotReadResult; products: CopilotReadResult; traceId: string;
}
export async function getCompanyHistory(companyId: string, period: string, section: string, query: string, offset: number, signal?: AbortSignal): Promise<CopilotReadResult> {
  const params = new URLSearchParams({ companyId, period, section, query, offset: String(offset) });
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", `company-history?${params}`), { headers: await headers(), signal, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo consultar el historial comercial.");
  return data.result;
}
export interface CustomerClassificationPreview {
  fingerprint: string; asOf: string;
  plan: Array<{ companyId: string | null; companyName: string; taxId: string; previousStatus: string | null;
    action: string; documents: string[]; firstPurchase: string; lastPurchase: string }>;
}
export async function getCompanyInsights(companyId: string, from: string, to: string, metric: string, currency: string, offset: number, signal?: AbortSignal): Promise<CompanyInsights> {
  const params = new URLSearchParams({ companyId, from, to, metric, currency, offset: String(offset) });
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", `company-insights?${params}`), { headers: await headers(), signal, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo consultar el analisis de la empresa.");
  return data;
}
export async function customerClassification(preview?: CustomerClassificationPreview, includeNew = false): Promise<CustomerClassificationPreview | { applied: string[]; created: string[]; conflicts: string[] }> {
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "customer-classification"), {
    method: preview ? "POST" : "GET", headers: await headers(), cache: "no-store",
    ...(preview ? { body: JSON.stringify({ fingerprint: preview.fingerprint, confirmed: true, includeNew }) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo completar la clasificacion. Revisa el estado antes de reintentar.");
  return data;
}
export interface CentralMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: { results?: CopilotReadResult[]; traceId?: string; inReplyTo?: string; timings?: CopilotTimings; agents?: CopilotAgentRun[]; model?: string; provider?: string; modelChoice?: string };
  created_at?: string;
}
export interface CentralConversation {
  id: string;
  title: string;
  updated_at: string;
}
export interface CentralEvent {
  model?: string;
  provider?: string;
  modelChoice?: string;
  type: string;
  toolName?: string;
  callId?: string;
  status?: string;
  conversationId?: string;
  messageId?: string;
  userMessageId?: string;
  message?: string;
  results?: CopilotReadResult[];
  error?: string;
  traceId?: string;
  timings?: CopilotTimings;
  agents?: CopilotAgentRun[];
}
export interface CopilotModelChoice { id: string; provider: "deepseek" | "openai"; model: string; label: string }
export interface CopilotModelCatalog { models: CopilotModelChoice[]; defaultId: string; warnings: string[] }
export interface CopilotVoiceProvider { id: "gemini" | "openai"; label: string; model: string; available: boolean }
export interface CopilotVoiceCatalog { defaultId: "gemini" | "openai"; providers: CopilotVoiceProvider[] }
export async function getCopilotModels(signal?: AbortSignal): Promise<CopilotModelCatalog> {
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "models"), { headers: await headers(), signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudieron cargar los modelos del Copiloto.");
  return result;
}
export class CopilotConnectionError extends Error {
  constructor(public requestStarted: boolean) {
    super(requestStarted
      ? "Se interrumpio la conexion con el Copiloto. La consulta puede haber quedado guardada; revisa el historial antes de reenviarla."
      : "No se pudo conectar con el Copiloto. No se envio la consulta; el texto sigue disponible para reintentar.");
    this.name = "CopilotConnectionError";
  }
}

async function headers() {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  if (!token)
    throw new Error("Inicia sesion para consultar las fuentes del CRM.");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}
export interface AgentUsage {
  enabled: boolean; since: string; partial: boolean; sampledRuns: number; estimateNote: string;
  agents: Array<{ agent: string; label: string; runs: number; failed: number; partial: number; durationMs: number; modelCalls: number; tokensInput: number; tokensOutput: number; estimatedUsd: number; lastAt: string | null }>;
  modelPolicy?: { defaultModel: string; escalationModel: string; mode: string; economy: boolean; guardEnabled: boolean; maxSolCalls: number; budget: number | null; solBudget: number | null; warningPercent: number };
  costs?: { error?: string; day: string; warning?: string; policy?: { quota_blocked: boolean; expires_at: string | null }; totals?: { calls: number; cost: number; uncertain: number };
    models?: Array<{ tier: string; model: string; calls: number; cost: number; tokens: number }>;
    agents?: Array<{ agent: string; calls: number; cost: number }>;
    conversations?: Array<{ conversation_id: string | null; calls: number; cost: number }>;
    errors?: Array<{ created_at: string; agent: string; model: string; error_code: string }> };
}
export async function setModelCostMode(mode: string, hours: number): Promise<AgentUsage> {
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "agent-observability"), { method: "POST", headers: await headers(), body: JSON.stringify({ mode, hours, confirmed: true }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudo cambiar la politica de modelos.");
  return result;
}
export async function getAgentUsage(signal?: AbortSignal): Promise<AgentUsage> {
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "agent-observability"), { headers: await headers(), signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudo cargar el registro de agentes.");
  return result;
}
export async function centralHistory(
  conversationId?: string,
  offset = 0,
  signal?: AbortSignal,
) {
  const route = conversationId
    ? `history?conversationId=${encodeURIComponent(conversationId)}&offset=${offset}`
    : "conversations";
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", route), {
    headers: await headers(),
    signal,
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error || "No se pudo cargar el historial.");
  return payload as {
    conversations?: CentralConversation[];
    messages?: CentralMessage[];
    nextOffset?: number | null;
    modelChoice?: string | null;
  };
}
export async function authorizedExportMessage(
  conversationId: string,
  messageId: string,
): Promise<CentralMessage> {
  const route = `export?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`;
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", route), {
    headers: await headers(),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error || "No se autorizo la descarga.");
  return payload.message;
}
export async function streamCentralMessage(
  message: string,
  conversationId: string | undefined,
  signal: AbortSignal,
  onEvent: (event: CentralEvent) => void,
  voice?: { voiceSessionId: string; delegationId: string },
  modelChoice?: string,
) {
  let requestStarted = false;
  try {
  const capability = await fetch(getSupabaseFunctionUrl("crm-copilot", "health"), { signal, cache: "no-store" });
  const version = await capability.json().catch(() => ({}));
  if (!capability.ok || version.engine !== "central" || version.contractVersion !== 1) {
    throw new Error("El servidor aun no tiene activo el Copiloto central. Falta desplegar la nueva funcion; no se envio tu consulta al motor anterior.");
  }
  const authorization = await headers();
  requestStarted = true;
  const response = await fetch(
    getSupabaseFunctionUrl("crm-copilot", "message"),
    {
      method: "POST",
      headers: { ...authorization, Accept: "application/x-ndjson" },
      body: JSON.stringify({ message, conversationId, modelChoice, ...(voice ? {channel:"voice", ...voice} : {}) }),
      signal,
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "No se pudo iniciar la consulta.");
  }
  if (!response.body) throw new Error("El servidor no entrego una respuesta.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      if (done && pending.trim()) {
        lines.push(pending);
        pending = "";
      }
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as CentralEvent;
        if (event.type === "error")
          throw new Error(
            `${event.error || "Consulta interrumpida."}${event.traceId ? ` Seguimiento: ${event.traceId}` : ""}`,
          );
        if (event.type === "complete") completed = true;
        onEvent(event);
        if (completed) return;
      }
      if (done) break;
    }
  } finally {
    if (completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed)
    throw new Error(
      "La conexion termino antes de completar la respuesta. Puedes recuperar la conversacion desde el historial.",
    );
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError) throw new CopilotConnectionError(requestStarted);
    throw error;
  }
}
export async function copilotVoiceRequest<T = Record<string, unknown>>(route: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(35000);
  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", route), {
    method: body ? "POST" : "GET", headers: await headers(), cache: "no-store",
    ...(body ? {body:JSON.stringify(body)} : {}), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "No se pudo conectar la voz. Puedes continuar por texto.");
  return result as T;
}
export function flattenResults(
  results: CopilotReadResult[],
): CopilotReadResult[] {
  return results.flatMap((result) => {
    const data = result.data as { sections?: CopilotReadResult[] } | null;
    return result.toolName === "generate_business_report" &&
      Array.isArray(data?.sections)
      ? data.sections
      : [result];
  });
}
export function safeSourcePath(path: string) {
  return /^\/(?:dashboard|empresas|contenido|campanas|finanzas-contabilidad|comercio-exterior|agentes|integraciones|administracion|informes|prospeccion)(?:[/?#]|$)/.test(
    path,
  ) && !path.includes("\\")
    ? path
    : null;
}
