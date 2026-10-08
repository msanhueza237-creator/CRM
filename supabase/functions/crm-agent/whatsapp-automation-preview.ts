import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { messageUuid } from "../_shared/direct-message.ts";
import { metaMessage, whatsappPhone } from "../_shared/whatsapp-content.ts";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { getWhatsAppConversation } from "./whatsapp-conversation.ts";
import { planWhatsAppAutomation, resolveWhatsAppProductReferences, suggestWhatsAppProducts, type ProductEvidence } from "./whatsapp-automation-plan.ts";

import { readLiveWhatsAppProduct } from "./whatsapp-tiendanube-live.ts";

type Env = (names: string[]) => string;
type Row = Record<string, unknown>;
const number = (v: unknown): number | null => {
  if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === "") return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
};

// Reads only the existing synchronized catalog. Missing currency is not guessed.
export async function readWhatsAppProductEvidence(db: SupabaseClient, currency: string): Promise<ProductEvidence[]> {
  const products: ProductEvidence[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const { data, error } = await db.from("content_products")
      .select("name,external_id,product_url,variants,last_synced_at,source_updated_at")
      .eq("source_provider", "tiendanube").eq("source_status", "active").eq("paused", false)
      .eq("sync_status", "synced").order("id").range(offset, offset + 499);
    if (error) throw new Error("No se pudo consultar el catálogo sincronizado de Tiendanube.");
    for (const row of data || []) {
      const variants: Row[] = Array.isArray(row.variants) ? row.variants.filter((v: unknown) => v && typeof v === "object" && !Array.isArray(v)) : [];
      // Product-level minimum price/aggregate stock cannot represent a variant.
      for (const variant of variants) {
        const sku = typeof variant.sku === "string" ? variant.sku.trim() : "";
        if (!sku) continue;
        products.push({ productId: typeof row.external_id === "string" ? row.external_id : "", productUrl: typeof row.product_url === "string" ? row.product_url : "",
          variantId: typeof variant.id === "string" || typeof variant.id === "number" ? String(variant.id) : "", source: "tiendanube", sku, name: String(row.name || ""), currency,
          price: variant.promotional_price != null && variant.promotional_price !== "" ? number(variant.promotional_price) : number(variant.price),
          stock: variant.stock_management === false ? null : number(variant.stock), published: true,
          verifiedAt: typeof row.last_synced_at === "string" && typeof row.source_updated_at === "string"
            && Number.isFinite(Date.parse(row.last_synced_at)) && Number.isFinite(Date.parse(row.source_updated_at))
            ? (Date.parse(row.source_updated_at) < Date.parse(row.last_synced_at) ? row.source_updated_at : row.last_synced_at) : "" });
      }
    }
    if ((data?.length || 0) < 500) return products;
  }
  throw new Error("El catálogo excede el límite de revisión; no se seleccionará un producto de una lista incompleta.");
}

export async function previewWhatsAppAutomation(db: SupabaseClient, env: Env, query: URLSearchParams, fetcher: typeof fetch = fetch) {
  const companyId = query.get("companyId") || "", contactId = query.get("contactId") || "";
  const phone = whatsappPhone(query.get("phone"));
  if (!messageUuid.test(companyId) || (contactId && !messageUuid.test(contactId)) || !/^[1-9]\d{7,14}$/.test(phone))
    throw new Error("Selecciona una conversación vinculada válida.");
  const conversation = await getWhatsAppConversation(db, env, companyId, phone, 0, contactId);
  if (!conversation.canReply) return { messageId: null, plan: { action: "ignore", reason: "conversation_blocked", text: null, requires: "none", source: null, canSend: false } };
  const { data: incoming, error } = await db.from("whatsapp_messages")
    .select("id,direction,phone_number,meta_message_id,raw_payload,occurred_at")
    .eq("company_id", companyId).eq("direction", "inbound").in("phone_number", [phone, `+${phone}`])
    .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error || !incoming) throw new Error("No se pudo leer el último mensaje entrante.");
  if (conversation.lastOutboundAt && Date.parse(conversation.lastOutboundAt) >= Date.parse(incoming.occurred_at))
    return { messageId: incoming.id, plan: { action: "ignore", reason: "already_answered", text: null, requires: "none", source: null, canSend: false } };
  const currency = env(["WHATSAPP_STORE_CURRENCY"]).trim().toUpperCase();
  const { phoneId: configPhone } = await getWhatsAppConfig(db, env);
  const products = await readWhatsAppProductEvidence(db, currency);
  const input = { incoming, phoneNumberId: configPhone, products, optedOut: false, humanTakeover: false };
  let plan = planWhatsAppAutomation(input);
  if (env(["WHATSAPP_LIVE_CATALOG_ENABLED"]) === "true" &&
      (plan.reason === "verified_product_answer" || plan.reason === "stale_product_evidence" || plan.reason === "incomplete_product_evidence")) {
    const message = metaMessage(incoming.raw_payload, incoming.meta_message_id)?.message;
    const candidates = resolveWhatsAppProductReferences(String(message?.text?.body || ""),
      String(message?.context?.referred_product?.product_retailer_id || ""), products).matches;
    if (candidates.length === 1) {
      try {
        const live = await readLiveWhatsAppProduct(candidates[0], env, fetcher);
        plan = live ? planWhatsAppAutomation({ ...input, products: [live] }) :
          { action: "handoff", reason: "product_no_longer_available", text: null, requires: "product", source: null, canSend: false };
      } catch {
        plan = { action: "handoff", reason: "live_catalog_unavailable", text: null, requires: "product", source: null, canSend: false };
      }
    }
  }
  if (plan.action === "clarify" && ["ambiguous_product", "product_reference_needed"].includes(plan.reason)) {
    const message = metaMessage(incoming.raw_payload, incoming.meta_message_id)?.message;
    const text = String(message?.text?.body || "");
    const matches = resolveWhatsAppProductReferences(text,
      String(message?.context?.referred_product?.product_retailer_id || ""), products).matches;
    const candidates = (matches.length ? matches : suggestWhatsAppProducts(text, products)).slice(0, 3);
    if (candidates.length && env(["WHATSAPP_LIVE_CATALOG_ENABLED"]) === "true") {
      try {
        const live = (await Promise.all(candidates.map(p => readLiveWhatsAppProduct(p, env, fetcher))))
          .filter((p): p is ProductEvidence => p !== null);
        plan = planWhatsAppAutomation({ ...input, products: live });
      } catch {
        plan = { action: "handoff", reason: "live_catalog_unavailable", text: null, requires: "product", source: null, canSend: false };
      }
    } else if (candidates.length) {
      plan = planWhatsAppAutomation({ ...input, products: products.map(p => ({ ...p, productUrl: "" })) });
    }
  }
  return { messageId: incoming.id, plan };
}
