import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "./supabase";
import type {
  ContentBootstrap,
  ContentChannelCode,
  ContentConnectionCheck,
  ContentCreativeLayout,
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
  visualLayout?: ContentCreativeLayout;
}) {
  return contentRequest<{ groupId: string; publications: ContentPublication[] }>("generate", { method: "POST", body: input });
}

export async function fetchContentCreativeSource(publicationId: string, sourceUrl: string) {
  if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para crear la pieza visual.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesion expiro. Vuelve a iniciar sesion.");
  const params = new URLSearchParams({ publicationId, sourceUrl });
  const response = await fetch(getSupabaseFunctionUrl("content-center", `creative-source?${params}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "No se pudo leer una imagen del producto.");
  }
  return response.blob();
}

export async function uploadContentCreative(publicationId: string, blob: Blob, index: number) {
  if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para guardar la pieza visual.");
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error("Tu sesion expiro. Vuelve a iniciar sesion.");
  const path = `${userId}/${publicationId}/${Date.now()}-${index + 1}.jpg`;
  const { error } = await supabase.storage.from("content-creatives").upload(path, blob, {
    cacheControl: "31536000",
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) throw new Error(`No se pudo guardar la pieza visual: ${error.message}`);
  const { data: publicData } = supabase.storage.from("content-creatives").getPublicUrl(path);
  return { path, publicUrl: publicData.publicUrl };
}

export function attachContentCreatives(
  publicationId: string,
  designedMediaUrls: string[],
  visualLayout: ContentCreativeLayout,
) {
  return contentRequest<{ publication: ContentPublication }>("creative", {
    method: "POST",
    body: { publicationId, designedMediaUrls, visualLayout },
  });
}

export async function removeContentCreatives(paths: string[]) {
  if (!paths.length || !supabase) return;
  await supabase.storage.from("content-creatives").remove(paths);
}

export function approveContentPublication(publicationId: string) {
  return contentRequest<{ publication: ContentPublication }>("approve", { method: "POST", body: { publicationId } });
}

export function rejectContentPublication(publicationId: string, reason?: string) {
  return contentRequest<{ publication: ContentPublication }>("reject", { method: "POST", body: { publicationId, reason } });
}

export function scheduleContentPublication(publicationId: string, scheduledAt: string) {
  return contentRequest<{ publication: ContentPublication }>("schedule", { method: "POST", body: { publicationId, scheduledAt } });
}

export function publishContentPublication(publicationId: string) {
  return contentRequest<{ publication: ContentPublication; worker: unknown }>("publish", { method: "POST", body: { publicationId } });
}
