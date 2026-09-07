import { getSupabaseFunctionUrl, supabase } from "./supabase";

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
}
export interface CentralMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: { results?: CopilotReadResult[]; traceId?: string };
  created_at?: string;
}
export interface CentralConversation {
  id: string;
  title: string;
  updated_at: string;
}
export interface CentralEvent {
  type: string;
  toolName?: string;
  callId?: string;
  status?: string;
  conversationId?: string;
  messageId?: string;
  message?: string;
  results?: CopilotReadResult[];
  error?: string;
  traceId?: string;
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
) {
  const capability = await fetch(getSupabaseFunctionUrl("crm-copilot", "health"), { signal, cache: "no-store" });
  const version = await capability.json().catch(() => ({}));
  if (!capability.ok || version.engine !== "central" || version.contractVersion !== 1) {
    throw new Error("El servidor aun no tiene activo el Copiloto central. Falta desplegar la nueva funcion; no se envio tu consulta al motor anterior.");
  }
  const response = await fetch(
    getSupabaseFunctionUrl("crm-copilot", "message"),
    {
      method: "POST",
      headers: { ...(await headers()), Accept: "application/x-ndjson" },
      body: JSON.stringify({ message, conversationId }),
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
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed)
    throw new Error(
      "La conexion termino antes de completar la respuesta. Puedes recuperar la conversacion desde el historial.",
    );
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
  return /^\/(?:empresas|contenido|campanas|finanzas-contabilidad|comercio-exterior|agentes|integraciones|administracion|informes|prospeccion)(?:[/?]|$)/.test(
    path,
  ) && !path.includes("\\")
    ? path
    : null;
}
