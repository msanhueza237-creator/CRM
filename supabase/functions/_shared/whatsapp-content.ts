type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export function whatsappPhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^9\d{8}$/.test(digits) ? `56${digits}` : digits;
}

export function whatsappMessageBody(message: Row): string {
  if (message.type === "order") {
    const order = object(message.order);
    const items = Array.isArray(order.product_items) ? order.product_items : [];
    return ["Pedido del catalogo", String(order.text || ""), ...items.map((item: Row) => {
      const quantity = item.quantity == null || item.quantity === "" ? NaN : Number(item.quantity);
      const price = item.item_price == null || item.item_price === "" ? NaN : Number(item.item_price);
      const money = Number.isFinite(price) ? price.toLocaleString("es-CL", { maximumFractionDigits: 4 }) : "Por verificar";
      const total = Number.isFinite(price) && Number.isFinite(quantity) ? (price * quantity).toLocaleString("es-CL", { maximumFractionDigits: 4 }) : "Por verificar";
      return `Producto ${String(item.product_retailer_id || "sin referencia")}: ${item.quantity ?? "?"} unidad(es) x ${money} ${String(item.currency || "")} = ${total} ${String(item.currency || "")}`;
    }), "Pedido recibido; no confirma venta ni pago."].filter(Boolean).join("\n");
  }
  const interactive = object(message.interactive);
  return String(message.text?.body || message.button?.text || message.button?.payload ||
    interactive.button_reply?.title || interactive.list_reply?.title || message.image?.caption ||
    message.document?.caption || message.document?.filename || message.video?.caption ||
    ({ image: "[Imagen recibida]", audio: "[Audio recibido]", video: "[Video recibido]", document: "[Documento recibido]", location: "[Ubicacion recibida]", contacts: "[Contacto recibido]" } as Row)[message.type] || `[Mensaje ${message.type || "desconocido"} recibido]`);
}

export function metaMessage(payload: unknown, id: unknown) {
  for (const entry of object(payload).entry || []) for (const change of entry.changes || []) {
    const value = object(change.value);
    for (const message of value.messages || []) if (message.id === id) {
      return { message, phoneId: String(value.metadata?.phone_number_id || "") };
    }
  }
  return null;
}

export function storedWhatsAppBody(row: Row) {
  const original = metaMessage(row.raw_payload, row.meta_message_id);
  return original ? whatsappMessageBody(original.message) : String(row.body || (row.template_name ? `Plantilla: ${row.template_name}` : "Mensaje sin texto disponible"));
}

export function replyWindow(row: Row | null, phoneId: string, now = Date.now()) {
  const original = row && metaMessage(row.raw_payload, row.meta_message_id);
  const timestamp = Number(original?.message.timestamp) * 1000;
  const valid = row?.direction === "inbound" && original?.phoneId === phoneId &&
    whatsappPhone(original?.message.from) === whatsappPhone(row.phone_number) &&
    Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now;
  const expiresAt = valid ? new Date(timestamp + 24 * 60 * 60 * 1000).toISOString() : null;
  return { expiresAt, open: Boolean(expiresAt && Date.parse(expiresAt) > now) };
}

export function splitWhatsAppEvents(payload: Row) {
  const events: Row[] = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value = object(change.value);
    for (const key of ["messages", "statuses"]) for (const item of value[key] || []) {
      events.push({ ...payload, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [], statuses: [], [key]: [item] } }] }] });
    }
  }
  return events;
}
