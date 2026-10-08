import { metaMessage, replyWindow, whatsappPhone } from "../_shared/whatsapp-content.ts";

export type ProductEvidence = {
  source: "tiendanube";
  sku: string;
  name: string;
  currency: string;
  productUrl?: string;
  referenceUrl?: string;
  variantId?: string;
  productId?: string;
  price: number | null;
  stock: number | null;
  published: boolean;
  verifiedAt: string;
};
type Incoming = {
  direction: string; phone_number: string; meta_message_id: string;
  raw_payload: unknown;
};
export type AutomationPlan = {
  action: "ignore" | "draft" | "clarify" | "handoff";
  reason: string;
  text: string | null;
  requires: "none" | "product" | "vision" | "transcription" | "verified_order" | "facto_quote" | "seller";
  source: "tiendanube" | null;
  canSend: false;
};

export function resolveWhatsAppProductReferences(text: string, reference: string, products: ProductEvidence[]) {
  const eligible = products.filter(p => p.source === "tiendanube" && p.published && p.sku);
  const words = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().match(/[a-z0-9]+/g) || [];
  const canonicalUrl = (value: string) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return "";
      return url.origin + url.pathname.replace(/\/+$/, "");
    } catch { return ""; }
  };
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) || [];
  const links = urls.map(u => canonicalUrl(u.replace(/[),.;!?]+$/, "")));
  // Never fetch a customer's URL or infer a store from its hostname.
  if (!reference && links.some(link => !link || !eligible.some(p => [p.productUrl, p.referenceUrl].some(url => canonicalUrl(url || "") === link))))
    return { matches: [] as ProductEvidence[], unknownLink: true };
  const withoutUrls = text.replace(/https?:\/\/[^\s<>]+/gi, " ");
  const tokens = new Set(withoutUrls.toUpperCase().match(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)*/g) || []);
  const phrase = ` ${words(withoutUrls).join(" ")} `;
  const matches = eligible.filter(p => {
    if (reference) return p.sku === reference || p.variantId === reference;
    const nameWords = words(p.name);
    return tokens.has(p.sku.toUpperCase()) ||
      (links.length > 0 && [p.productUrl, p.referenceUrl].some(url => links.includes(canonicalUrl(url || "")))) ||
      (nameWords.length >= 2 && phrase.includes(` ${nameWords.join(" ")} `));
  });
  return { matches, unknownLink: false };
}

export function suggestWhatsAppProducts(text: string, products: ProductEvidence[]) {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\bcorta[ -]?tubos?\b/g, "cortatubos").replace(/\bcortador(?:es)? de tubos?\b/g, "cortatubos");
  const stop = new Set("tienes tiene tienen tendras tendran tendria tendrias tendrian hay venden vendes manejan precio precios valor cuanto cuesta cuestan vale valen stock disponibilidad disponible disponibles del para por con una uno unos unas los las un de el la me que si saber quiero necesito hola buenas puedes producto productos actual".split(" "));
  const query = [...new Set((normalize(text).match(/[a-z0-9]+/g) || []).filter(w => w.length >= 3 && !stop.has(w)))];
  if (!query.length || query.length > 6 || /https?:\/\//i.test(text)) return [];
  return products.filter(p => {
    const words = new Set(normalize(p.name).match(/[a-z0-9]+/g) || []);
    return p.published && p.source === "tiendanube" && p.sku && query.every(w => words.has(w));
  });
}

function storeProductLink(product: ProductEvidence): string {
  try {
    const url = new URL(product.productUrl || "");
    if (url.protocol !== "https:" || url.username || url.password ||
      !["www.climactiva.cl"].includes(url.hostname) ||
      !url.pathname.startsWith("/productos/") || url.port) return "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

export function purchaseQuantityContext(text: string, previousOffer = "") {
  const question = previousOffer.match(/^Elegiste .+ \(código ([^\n]+)\)\. ¿Cuántas unidades quieres\?$/);
  const quantity = text.trim().toLowerCase().match(/^(?:(?:quiero|necesito|dame)\s+)?([1-9]\d{0,3})(?:\s+(?:unidades?|piezas?))?[.!?\s]*$/);
  return question && quantity ? { sku: question[1], quantity: Number(quantity[1]) } : null;
}

// Preparation only. This module cannot call Meta, a model, or any database.
// Evidence is supplied by a trusted backend reader, never by the customer.
export function planWhatsAppAutomation(input: {
  incoming: Incoming;
  phoneNumberId: string;
  products: ProductEvidence[];
  optedOut: boolean;
  humanTakeover: boolean;
  previousOffer?: string;
  now?: number;
}): AutomationPlan {
  const plan = (action: AutomationPlan["action"], reason: string, text: string | null = null,
    requires: AutomationPlan["requires"] = "none", source: AutomationPlan["source"] = null): AutomationPlan =>
    ({ action, reason, text, requires, source, canSend: false });
  if (input.optedOut) return plan("ignore", "opted_out");
  if (input.humanTakeover) return plan("ignore", "human_takeover");
  const now = input.now ?? Date.now();
  const original = metaMessage(input.incoming.raw_payload, input.incoming.meta_message_id);
  if (!original || !replyWindow(input.incoming, input.phoneNumberId, now).open)
    return plan("ignore", "invalid_or_closed_window");
  if (whatsappPhone(original.message.from) !== whatsappPhone(input.incoming.phone_number))
    return plan("ignore", "sender_mismatch");
  const message = original.message;
  if (message.type === "audio") return plan("handoff", "transcription_required", null, "transcription");
  if (message.type === "image") return plan("handoff", "visual_identification_required", null, "vision");
  if (message.type !== "text") return plan("handoff", "unsupported_message", null, "seller");
  const text = String(message.text?.body || "").trim();
  if (!text || text.length > 4096) return plan("handoff", "invalid_text", null, "seller");
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(salir|stop|baja)\b|no mas mensajes/.test(normalized)) return plan("ignore", "withdrawal_request");
  if (/\b(vendedor|persona|humano|reclamo|devolucion|descuento)\b/.test(normalized))
    return plan("handoff", "seller_requested_or_exception", null, "seller");
  if (/\b(cotizacion|cotizar|presupuesto)\b/.test(normalized))
    return plan("handoff", "formal_quote_required", null, "facto_quote");
  if (/\b(seguimiento|tracking|pedido|despacho|envio|entrega)\b/.test(normalized))
    return plan("handoff", "verified_order_or_shipping_policy_required", null, "verified_order");
  if (/^(hola|buenos dias|buenas tardes|buenas noches)[!.\s]*$/.test(normalized))
    return plan("draft", "greeting", "Hola, soy el asistente de Clima Activa. ¿Qué producto o código necesitas consultar?");
  const purchase = purchaseQuantityContext(text, input.previousOffer);
  if (purchase) {
    const matches = input.products.filter(p => p.published && p.source === "tiendanube" && p.sku === purchase.sku);
    if (matches.length !== 1) return plan("clarify", "purchase_product_missing", "¿Puedes confirmar el código del producto?", "product");
    const p = matches[0];
    if (!Number.isFinite(Date.parse(p.verifiedAt)) || Date.parse(p.verifiedAt) > now || now - Date.parse(p.verifiedAt) > 900000 ||
      p.currency !== "CLP" || p.price === null || !Number.isFinite(p.price) || p.price < 0 || p.stock === null || !Number.isSafeInteger(p.stock))
      return plan("handoff", "purchase_data_required", null, "product");
    if (p.stock < purchase.quantity)
      return plan("draft", "purchase_insufficient_stock", `La tienda registra ${p.stock} unidades de ${p.name} (${p.sku}); no alcanza para las ${purchase.quantity} que necesitas. ¿Quieres consultar otra cantidad o un modelo alternativo?`, "none", "tiendanube");
    const total = p.price * purchase.quantity;
    const link = storeProductLink(p);
    if (!Number.isFinite(total) || !link) return plan("handoff", "purchase_data_required", null, "product");
    return plan("draft", "purchase_summary", `Para ${purchase.quantity} unidades de ${p.name} (${p.sku}), el subtotal es $${total.toLocaleString("es-CL")} CLP, sin incluir despacho.\n\nPuedes continuar la compra en la tienda, seleccionar ${purchase.quantity} unidades y agregarlas al carrito:\n${link}\n\nEl stock y el total final se confirman en la tienda.`, "none", "tiendanube");
  }
  const selection = normalized.match(/\b(?:numero|opcion|modelo|producto)\s*(?:n[°º.]?\s*)?(\d{1,2})\b/) || normalized.match(/^\s*(\d{1,2})[.!?\s]*$/);
  if (selection && input.previousOffer && /Encontré estos modelos en el catálogo:/.test(input.previousOffer)) {
    const choices = [...input.previousOffer.matchAll(/(?:^|\n)(\d+)\. ([^\n]+)\nCódigo: ([^\n]+)/g)]
      .filter(m => m[1] === String(Number(selection[1])));
    const products = choices.length === 1 ? input.products.filter(p => p.published && p.source === "tiendanube" && p.sku === choices[0][3].trim()) : [];
    if (products.length === 1) {
      if (/\b\d+\s*(unidades?|piezas?)\b/.test(normalized))
        return plan("handoff", "cart_integration_required", null, "seller");
      return plan("draft", "purchase_quantity_required", `Elegiste ${products[0].name} (código ${products[0].sku}). ¿Cuántas unidades quieres?`, "none", "tiendanube");
    }
    return plan("clarify", "invalid_offer_selection", "¿Puedes indicar el código del producto que quieres y cuántas unidades necesitas?", "product");
  }
  const asksPrice = /\b(precio|precios|valor|cuesta|cuestan|vale|valen)\b/.test(normalized);
  const asksStock = /\b(stock|disponibilidad|disponible|disponibles|tienes|tiene|tienen|tendras|tendran|tendria|tendrias|tendrian|venden|vendes|manejan|hay)\b/.test(normalized);
  if (!asksPrice && !asksStock) return plan("handoff", "complex_question", null, "seller");
  const reference = String(message.context?.referred_product?.product_retailer_id || "").trim();
  const { matches, unknownLink } = resolveWhatsAppProductReferences(text, reference, input.products);
  if (unknownLink) return plan("clarify", "unrecognized_product_link", "¿Puedes indicar el código o modelo exacto del producto?", "product");
  if (matches.length !== 1) {
    const candidates = matches.length ? matches : suggestWhatsAppProducts(text, input.products);
    const options = candidates.slice(0, 3).map((p, i) => {
      const link = storeProductLink(p);
      return `${i + 1}. ${p.name}\nCódigo: ${p.sku}${link ? `\nVer producto y comprar: ${link}` : ""}`;
    }).join("\n\n");
    return plan("clarify", matches.length ? "ambiguous_product" : "product_reference_needed",
      options ? `Encontré estos modelos en el catálogo:\n\n${options}\n\n${candidates.length > 3 ? "Hay más opciones. " : ""}¿Cuál quieres consultar? Puedes indicarme su código.` :
        "¿Puedes indicar el código o modelo exacto del producto?", "product");
  }
  const p = matches[0], verifiedAt = Date.parse(p.verifiedAt);
  // Fixed pilot limit. A later production reader must refresh the source first.
  if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > 15 * 60 * 1000)
    return plan("handoff", "stale_product_evidence", null, "product");
  if (!p.name || !/^[A-Z]{3}$/.test(p.currency) ||
    (asksPrice && (p.price === null || !Number.isFinite(p.price) || p.price < 0)) ||
    (asksStock && (p.stock === null || !Number.isSafeInteger(p.stock) || p.stock < 0)))
    return plan("handoff", "incomplete_product_evidence", null, "product");
  const parts = [`${p.name} (${p.sku}).`];
  if (asksPrice) parts.push(`Precio registrado en la tienda: ${p.price!.toLocaleString("es-CL", { maximumFractionDigits: 4 })} ${p.currency}.`);
  if (asksStock) parts.push(p.stock! > 0 ? "La tienda registra disponibilidad; se confirma al realizar el pedido." : "La tienda registra este producto sin stock.");
  const link = storeProductLink(p);
  if (link) parts.push(`Ver producto y comprar: ${link}`);
  return plan("draft", "verified_product_answer", parts.join("\n\n"), "none", "tiendanube");
}
