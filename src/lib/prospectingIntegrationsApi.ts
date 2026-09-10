import { getSupabaseAnonKey, getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";

export interface DeepSeekStatus {
  provider: "deepseek";
  configured: boolean;
  ready: boolean;
  status: "verified" | "error" | "disconnected";
  models: string[];
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  scope: "credentials_only";
}

export async function requestDeepSeekSettings(
  action: "status" | "save" | "verify" | "disconnect",
  apiKey?: string,
  signal?: AbortSignal,
): Promise<DeepSeekStatus> {
  if (!isSupabaseConfigured || !supabase) throw new Error("La conexión no está disponible en modo demo.");
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Inicia sesión nuevamente.");
  let response: Response;
  try {
    response = await fetch(getSupabaseFunctionUrl("prospecting-integrations", action), {
      method: action === "status" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: getSupabaseAnonKey(), "Content-Type": "application/json" },
      body: action === "save" ? JSON.stringify({ apiKey }) : undefined,
      cache: "no-store", signal: signal ?? AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error("No se pudo contactar con la configuración de DeepSeek. Revisa la conexión e intenta nuevamente.");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) throw new Error("La integración DeepSeek todavía no está instalada en el servidor.");
    throw new Error(result?.error || "No se pudo consultar la configuración de DeepSeek.");
  }
  if (result?.provider !== "deepseek" || result?.scope !== "credentials_only" || typeof result.ready !== "boolean") {
    throw new Error("El servidor devolvió una configuración no válida.");
  }
  return result;
}
