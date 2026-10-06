import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { whatsappDispatchId } from "./whatsapp-meta.ts";
import { replyWindow, storedWhatsAppBody, whatsappPhone } from "../_shared/whatsapp-content.ts";

type Row = Record<string, any>;
type Env = (names: string[]) => string;
const fields = "id,company_id,direction,phone_number,meta_message_id,message_type,template_name,body,status,occurred_at,raw_payload";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function conversationContext(db: SupabaseClient, env: Env, companyId: string, requestedPhone: string) {
  if (!uuid.test(companyId)) throw new Error("Empresa no valida.");
  const config = await getWhatsAppConfig(db, env);
  const { data: company, error } = await db.from("companies").select("id,name,whatsapp_status").eq("id", companyId).maybeSingle();
  if (error || !company) throw new Error("Empresa no disponible.");
  const phone = whatsappPhone(requestedPhone);
  if (phone && !/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Numero no valido.");
  let query = db.from("whatsapp_messages").select(fields).eq("company_id", companyId).eq("direction", "inbound");
  if (phone) query = query.in("phone_number", [phone, `+${phone}`]);
  const { data: incoming, error: incomingError } = await query.order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  if (incomingError) throw new Error("No se pudo consultar la respuesta del cliente.");
  const actualPhone = whatsappPhone(incoming?.phone_number);
  if (!incoming || !/^[1-9]\d{7,14}$/.test(actualPhone)) throw new Error("No hay mensajes entrantes para este contacto.");
  const window = replyWindow(incoming, config.phoneId);
  const reasons = [...config.blockers];
  if (!window.open) reasons.push("Ventana de 24 horas cerrada o sin fecha verificable. Espera una respuesta del cliente o usa una plantilla aprobada con consentimiento vigente.");
  if (["opt_out", "bloqueado", "invalido", "no_contactar"].includes(company.whatsapp_status) ||
    /^(salir|stop|baja|no mas mensajes)$/i.test(storedWhatsAppBody(incoming).trim())) reasons.push("Contacto marcado para no recibir mensajes.");
  const { data: pending, error: pendingError } = await db.from("whatsapp_messages").select("id")
    .eq("company_id", companyId).in("phone_number", [actualPhone, `+${actualPhone}`]).eq("direction", "outbound").eq("status", "pending").limit(1).maybeSingle();
  if (pendingError) throw new Error("No se pudo verificar si hay envios pendientes.");
  if (pending) reasons.push("Hay un envio pendiente o de resultado incierto. Revisa su estado antes de enviar otro.");
  return { config, company, phone: actualPhone, incoming, window, reasons };
}

export async function getWhatsAppConversation(db: SupabaseClient, env: Env, companyId: string, phone = "", offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Pagina no valida.");
  const context = await conversationContext(db, env, companyId, phone);
  const { data, error } = await db.from("whatsapp_messages").select(fields).eq("company_id", companyId)
    .in("phone_number", [context.phone, `+${context.phone}`]).order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
  if (error) throw new Error("No se pudo recuperar el historial WhatsApp.");
  return { companyId, name: context.company.name, phone: context.phone, canReply: context.reasons.length === 0,
    reasons: context.reasons, expiresAt: context.window.expiresAt, nextOffset: data?.length === 50 ? offset + 50 : null,
    messages: (data || []).map((row: Row) => ({ id: row.id, direction: row.direction, body: storedWhatsAppBody(row),
      type: row.message_type, status: row.status, occurredAt: row.occurred_at })).reverse() };
}

export async function sendWhatsAppReply(db: SupabaseClient, env: Env, payload: Row, userId: string, request: typeof fetch = fetch) {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text || text.length > 4096 || payload.confirmSend !== true || !uuid.test(String(payload.requestId || ""))) {
    throw new Error("Confirma un mensaje de 1 a 4096 caracteres con identificador de envio valido.");
  }
  const context = await conversationContext(db, env, String(payload.companyId || ""), String(payload.phone || ""));
  if (context.reasons.length) throw new Error(context.reasons.join(" "));
  const id = await whatsappDispatchId(`reply:${payload.companyId}:${payload.requestId}`, context.phone);
  const { error: reservationError } = await db.from("whatsapp_messages").insert({ id, company_id: payload.companyId,
    direction: "outbound", phone_number: context.phone, message_type: "text", body: text, status: "pending",
    raw_payload: { kind: "manual_reply", user_id: userId, reply_to: context.incoming.meta_message_id, request_id: payload.requestId } });
  if (reservationError) throw new Error(reservationError.code === "23505" ? "Este envio ya tiene un intento registrado. Actualiza el historial; no lo repitas." : "No se pudo reservar el envio. No se contacto a Meta.");
  // Recheck the external window immediately before sending; failures keep the reservation.
  if (!replyWindow(context.incoming, context.config.phoneId).open) throw new Error("La ventana cerro antes del envio. No se contacto a Meta.");
  try {
    const response = await request(`https://graph.facebook.com/${context.config.version}/${context.config.phoneId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${context.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: context.phone,
        type: "text", text: { preview_url: false, body: text } }), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) {
      const { error } = await db.from("whatsapp_messages").update({ status: "failed" }).eq("id", id);
      return { accepted: false, id, outcome: "rejected", warning: `Meta rechazo el mensaje (codigo ${Number(data.error?.code) || response.status}).${error ? " El estado local requiere revision." : ""}` };
    }
    const messageId = data.messages?.[0]?.id;
    if (typeof messageId !== "string" || !messageId) throw new Error("missing-message-id");
    const { error } = await db.from("whatsapp_messages").update({ meta_message_id: messageId, status: "sent" }).eq("id", id);
    return { accepted: true, id, outcome: "accepted", warning: error ? "Meta acepto el mensaje; el registro local requiere revision. No reenviar." : null };
  } catch {
    return { accepted: false, id, outcome: "uncertain", warning: "Resultado incierto. Se conserva el intento para evitar duplicados. Actualiza el historial; no reenvies el mensaje." };
  }
}
