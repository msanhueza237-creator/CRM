import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";
import type {
  ContentBootstrap,
  ContentChannelCode,
  ContentConnectionCheck,
  ContentProduct,
  ContentPublication,
  ContentOperationMode,
} from "../types/content";

async function contentRequest<T>(
  route: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para usar el Centro de Contenido.");
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Vuelve a iniciar sesion.");

  let response: Response;
  try {
    response = await fetch(getSupabaseFunctionUrl("content-center", route), {
      method: options.method || "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error("No se pudo contactar el servicio del Centro de Contenido.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `El servicio respondio con error ${response.status}.`);
  return result as T;
}

export function getContentBootstrap() {
  return contentRequest<ContentBootstrap>("bootstrap");
}

export function getContentProducts(filters: { search?: string; category?: string; status?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return contentRequest<{ products: ContentProduct[]; total: number; categories: string[] }>(`products${query ? `?${query}` : ""}`);
}

export function syncContentCatalog() {
  return contentRequest<{ synchronized: number; incomplete: number; durationMs: number }>("sync-catalog", { method: "POST", body: {} });
}

export function checkContentConnections() {
  return contentRequest<ContentConnectionCheck>("connections");
}

export function generateSocialContent(input: {
  productId: string;
  channels: ContentChannelCode[];
  templateId?: string;
  brandProfileId?: string;
  publicationType: string;
  objective: string;
  cta: string;
  context: string;
  variants: number;
  useHashtags: boolean;
  operationMode: ContentOperationMode;
}) {
  return contentRequest<{ groupId: string; publications: ContentPublication[] }>("generate", { method: "POST", body: input });
}

export function approveContentPublication(publicationId: string) {
  return contentRequest<{ publication: ContentPublication }>("approve", { method: "POST", body: { publicationId } });
}

export function scheduleContentPublication(publicationId: string, scheduledAt: string) {
  return contentRequest<{ publication: ContentPublication }>("schedule", { method: "POST", body: { publicationId, scheduledAt } });
}

export function publishContentPublication(publicationId: string) {
  return contentRequest<{ publication: ContentPublication; worker: unknown }>("publish", { method: "POST", body: { publicationId } });
}
