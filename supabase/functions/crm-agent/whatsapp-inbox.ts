import { messageUuid } from "../_shared/direct-message.ts";
import { whatsappPhone } from "../_shared/whatsapp-content.ts";

export async function getWhatsAppInbox(db: any, userId: string, query: URLSearchParams) {
  const offset = Number(query.get("offset") || 0), limit = Number(query.get("limit") ?? 30);
  const filter = query.get("filter") || "all", search = (query.get("search") || "").trim();
  if (!messageUuid.test(userId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 0 || limit > 50 || !["all", "unread", "new"].includes(filter) || search.length > 160) throw new Error("Filtro de mensajes no valido.");
  const { data, error } = await db.rpc("crm_whatsapp_inbox", { p_user_id: userId, p_search: search, p_filter: filter, p_offset: offset, p_limit: limit });
  if (error || !data || !Array.isArray(data.conversations) || !data.summary) throw new Error("No se pudo cargar la bandeja de mensajes. Actualiza para reintentar.");
  return data;
}

export async function setWhatsAppRead(db: any, userId: string, payload: Record<string, unknown>) {
  const companyId = payload.companyId || null, phone = whatsappPhone(payload.phone);
  const ids = payload.messageIds;
  if (!messageUuid.test(userId) || (companyId !== null && (typeof companyId !== "string" || !messageUuid.test(companyId))) ||
    !/^[1-9]\d{7,14}$/.test(phone) || typeof payload.read !== "boolean" || !Array.isArray(ids) || !ids.length || ids.length > 50 ||
    ids.some(id => typeof id !== "string" || !messageUuid.test(id)) || new Set(ids).size !== ids.length) throw new Error("Lectura de mensajes no valida.");
  const { data, error } = await db.rpc("crm_whatsapp_set_read", { p_user_id: userId, p_company_id: companyId, p_phone: phone, p_message_ids: ids, p_read: payload.read });
  if (error || data !== ids.length) throw new Error("No se pudo guardar el estado de lectura.");
  return { updated: data };
}
