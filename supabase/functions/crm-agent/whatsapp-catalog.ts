import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { metaMessage } from "../_shared/whatsapp-content.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const localized = (value: unknown): string => typeof value === "string" ? value : text(object(value).es || object(value).en || object(value).pt);
const amount = (value: unknown, minimum: number): number | null => {
  if ((typeof value !== "string" && typeof value !== "number") || text(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : null;
};
function publicUrl(value: unknown) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export type CatalogProduct = {
  name: string; sku: string | null; variant: string | null; imageUrl: string | null; url: string | null;
  source: "tiendanube"; matchedBy: "variant_id" | "sku"; sourceUpdatedAt: string | null;
};
type Resolution = { product: CatalogProduct | null; resolution: "matched" | "not_found" | "ambiguous" | "unavailable" };
export type CatalogSelection = {
  kind: "order" | "enquiry"; catalogId: string; text: string;
  items: Array<Resolution & { retailerId: string; quantity: number | null; unitPrice: number | null; currency: string | null; total: number | null }>;
};

export function storedCatalogSelection(row: Row): CatalogSelection | null {
  if (row.direction !== "inbound") return null;
  const original = metaMessage(row.raw_payload, row.meta_message_id);
  if (!original) return null;
  const message = original.message;
  const order = object(message.order), enquiry = object(object(message.context).referred_product);
  const isOrder = message.type === "order";
  const catalogId = text(isOrder ? order.catalog_id : enquiry.catalog_id);
  if (!catalogId || (!isOrder && !text(enquiry.product_retailer_id))) return null;
  const items = isOrder ? (Array.isArray(order.product_items) ? order.product_items : []) : [enquiry];
  return {
    kind: isOrder ? "order" : "enquiry", catalogId, text: isOrder ? text(order.text) : "",
    items: items.map(value => {
      const item = object(value), quantity = isOrder ? amount(item.quantity, Number.MIN_VALUE) : null;
      const unitPrice = isOrder ? amount(item.item_price, 0) : null;
      const total = quantity !== null && unitPrice !== null ? quantity * unitPrice : null;
      return { retailerId: text(item.product_retailer_id), quantity, unitPrice,
        currency: /^[A-Z]{3}$/.test(text(item.currency)) ? text(item.currency) : null,
        total: total !== null && Number.isFinite(total) ? total : null, product: null, resolution: "not_found" };
    }),
  };
}

async function resolveCatalogProduct(db: SupabaseClient, retailerId: string): Promise<Resolution> {
  if (!retailerId || retailerId.length > 200) return { product: null, resolution: "not_found" };
  const filters: Row[] = [{ id: retailerId }, { sku: retailerId }];
  if (/^\d+$/.test(retailerId) && Number.isSafeInteger(Number(retailerId)) && String(Number(retailerId)) === retailerId) filters.push({ id: Number(retailerId) });
  const candidates = new Map<string, CatalogProduct>();
  try {
    for (const filter of filters) {
      const { data, error } = await db.from("content_products")
        .select("id,name,variants,images,primary_image_url,product_url,source_updated_at")
        .eq("source_provider", "tiendanube").contains("variants", [filter]).order("id").limit(2);
      if (error) return { product: null, resolution: "unavailable" };
      if (data?.length === 2) return { product: null, resolution: "ambiguous" };
      for (const value of data || []) {
        const row = value as Row;
        for (const rawVariant of Array.isArray(row.variants) ? row.variants : []) {
          const variant = object(rawVariant);
          const matchedBy = text(variant.id) === retailerId ? "variant_id" : text(variant.sku) === retailerId ? "sku" : null;
          if (!matchedBy || !text(row.name)) continue;
          const images = (Array.isArray(row.images) ? row.images : []).map(object);
          const specificImage = images.find(image => text(image.id) && text(image.id) === text(variant.image_id));
          candidates.set(JSON.stringify([row.id, text(variant.id), text(variant.sku)]), {
            name: text(row.name), sku: text(variant.sku) || null,
            variant: (Array.isArray(variant.values) ? variant.values : []).map(localized).filter(Boolean).join(" / ") || null,
            imageUrl: publicUrl(specificImage?.src) || publicUrl(row.primary_image_url), url: publicUrl(row.product_url),
            source: "tiendanube", matchedBy, sourceUpdatedAt: text(row.source_updated_at) || null,
          });
        }
      }
    }
    return candidates.size === 1 ? { product: [...candidates.values()][0], resolution: "matched" }
      : { product: null, resolution: candidates.size ? "ambiguous" : "not_found" };
  } catch { return { product: null, resolution: "unavailable" }; }
}

export async function getWhatsAppCatalogSelections(db: SupabaseClient, rows: Row[]) {
  const selections = new Map<string, CatalogSelection>();
  const resolutions = new Map<string, Resolution>();
  for (const row of rows) {
    const selection = storedCatalogSelection(row);
    if (!selection) continue;
    for (const item of selection.items) {
      // Enrich the display only; never replace the customer's received quantity or price.
      if (!resolutions.has(item.retailerId)) resolutions.set(item.retailerId, await resolveCatalogProduct(db, item.retailerId));
      Object.assign(item, resolutions.get(item.retailerId));
    }
    selections.set(text(row.id), selection);
  }
  return selections;
}
