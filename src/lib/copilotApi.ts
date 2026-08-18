import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";

export interface CopilotToolSummary {
  ok: boolean;
  humanSummary: string;
  warnings: string[];
  evidence: Array<{
    entityType: string;
    entityId?: string;
    label: string;
  }>;
}

export interface CopilotMessageResponse {
  conversationId: string;
  message: string;
  traceId: string;
  model: string;
  tools: CopilotToolSummary[];
}

export async function sendCopilotMessage(message: string, conversationId?: string) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para usar el copiloto OpenAI.");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Inicia sesion nuevamente.");

  const response = await fetch(getSupabaseFunctionUrl("crm-copilot", "message"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, conversationId }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(String(payload.error ?? "No se pudo contactar el copiloto."));
  }

  return payload as CopilotMessageResponse;
}
