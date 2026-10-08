import type { ProductEvidence } from "./whatsapp-automation-plan.ts";

type Env = (names: string[]) => string;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number | null => {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null;
};

// One read of an already identified product; never requests customer-supplied URLs.
export async function readLiveWhatsAppProduct(
  candidate: ProductEvidence, env: Env, fetcher: typeof fetch = fetch,
): Promise<ProductEvidence | null> {
  const storeId = env(["TIENDANUBE_STORE_ID"]).trim();
  const token = env(["TIENDANUBE_ACCESS_TOKEN"]);
  const userAgent = env(["TIENDANUBE_USER_AGENT"]).trim();
  if (!/^\d+$/.test(storeId) || !token || !userAgent || !/^\d+$/.test(candidate.productId || ""))
    throw new Error("Falta habilitar la lectura actual del catálogo en el backend.");
  try {
    const response = await fetcher(`https://api.tiendanube.com/2025-03/${storeId}/products/${candidate.productId}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authentication: `bearer ${token}`, "User-Agent": userAgent, Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json"))
      throw new Error("provider_unavailable");
    if (!response.body) throw new Error("empty_response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 256 * 1024) throw new Error("response_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const product = object(JSON.parse(new TextDecoder().decode(bytes)));
    if (String(product.id) !== candidate.productId || product.published !== true) return null;
    const variants = Array.isArray(product.variants) ? product.variants.map(object) : [];
    const matches = variants.filter(v => v.sku === candidate.sku && (!candidate.variantId || String(v.id) === candidate.variantId));
    if (matches.length !== 1) return null;
    const variant = matches[0], localized = object(product.name);
    const name = typeof product.name === "string" ? product.name : typeof localized.es === "string" ? localized.es : "";
    // False/unknown stock management never becomes a numerical availability promise.
    const stock = variant.stock_management === true ? numeric(variant.stock) : null;
    const price = variant.promotional_price != null && variant.promotional_price !== "" ? numeric(variant.promotional_price) : numeric(variant.price);
    // Only the current canonical URL returned by Tiendanube; never reuse a stale mirror link.
    const productUrl = typeof product.canonical_url === "string" ? product.canonical_url : "";
    return { ...candidate, referenceUrl: candidate.productUrl, name, productUrl, price, stock, published: true, verifiedAt: new Date().toISOString() };
  } catch {
    // Provider bodies, headers and credentials must not reach the UI or logs.
    throw new Error("No se pudo confirmar el producto en Tiendanube. Revisa la consulta antes de responder.");
  }
}
