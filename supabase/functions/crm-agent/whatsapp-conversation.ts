import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { whatsappDispatchId, buildMetaTemplateMessage, listMetaTemplates, validateWhatsAppRecipient } from "./whatsapp-meta.ts";
import { replyWindow, storedWhatsAppBody, whatsappPhone } from "../_shared/whatsapp-content.ts";
import { resolveMessageRecipient, messageFileMetadata, validateMessageFile, type MessageFile } from "../_shared/direct-message.ts";

type Row = Record<string, any>;
type Env = (names: string[]) => string;
const fields = "id,company_id,direction,phone_number,meta_message_id,message_type,template_name,body,status,occurred_at,raw_payload";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function conversationContext(db: SupabaseClient, env: Env, companyId: string, requestedPhone: string, contactId = "", ownAttempt = "") {
  if (!uuid.test(companyId)) throw new Error("Empresa no valida.");
  const config = await getWhatsAppConfig(db, env);
  const { data: company, error } = await db.from("companies").select("id,name,whatsapp_status,whatsapp_opt_in,whatsapp_number,whatsapp,phone").eq("id", companyId).maybeSingle();
  if (error || !company) throw new Error("Empresa no disponible.");
  const target = contactId ? await resolveMessageRecipient(db, companyId, contactId) : null;
  const phone = whatsappPhone(requestedPhone || target?.recipient.phone || company.whatsapp_number || company.whatsapp || company.phone);
  if (target && target.recipient.phone !== phone) throw new Error("El numero del contacto cambio. Vuelve a seleccionarlo.");
  if (phone && !/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Numero no valido.");
  let query = db.from("whatsapp_messages").select(fields).eq("company_id", companyId).eq("direction", "inbound");
  if (phone) query = query.in("phone_number", [phone, `+${phone}`]);
  const { data: incoming, error: incomingError } = await query.order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  if (incomingError) throw new Error("No se pudo consultar la respuesta del cliente.");
  const actualPhone = whatsappPhone(incoming?.phone_number) || phone;
  const knownPhones = [company.whatsapp_number, company.whatsapp, company.phone, target?.recipient.phone].map(whatsappPhone);
  if (!/^[1-9]\d{7,14}$/.test(actualPhone) || (!incoming && !knownPhones.includes(actualPhone))) throw new Error("No hay mensajes ni numero registrado para este contacto.");
  const window = replyWindow(incoming, config.phoneId);
  const blockers = [...config.blockers];
  if (["opt_out", "bloqueado", "invalido", "no_contactar"].includes(company.whatsapp_status) ||
    (incoming && /^(salir|stop|baja|no mas mensajes)$/i.test(storedWhatsAppBody(incoming).trim()))) blockers.push("Contacto marcado para no recibir mensajes.");
  const { data: pending, error: pendingError } = await db.from("whatsapp_messages").select("id")
    .eq("company_id", companyId).in("phone_number", [actualPhone, `+${actualPhone}`]).eq("direction", "outbound").eq("status", "pending").limit(2);
  if (pendingError) throw new Error("No se pudo verificar si hay envios pendientes.");
  if (pending?.some((p: Row) => p.id !== ownAttempt)) blockers.push("Hay un envio pendiente o de resultado incierto. Revisa su estado antes de enviar otro.");
  const templateReasons = [...blockers];
  try { validateWhatsAppRecipient(company, actualPhone); } catch { templateReasons.push("Este numero no tiene consentimiento vigente verificado para iniciar mensajes con plantilla."); }
  const reasons = [...blockers];
  if (!window.open) reasons.push("Ventana de 24 horas cerrada o sin fecha verificable. Espera una respuesta del cliente o usa una plantilla aprobada con consentimiento vigente.");
  return { config, company, phone: actualPhone, incoming, window, reasons, templateReasons, name: target?.recipient.name || company.name };
}

export async function getWhatsAppConversation(db: SupabaseClient, env: Env, companyId: string, phone = "", offset = 0, contactId = "") {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Pagina no valida.");
  const context = await conversationContext(db, env, companyId, phone, contactId);
  const { data, error } = await db.from("whatsapp_messages").select(fields).eq("company_id", companyId)
    .in("phone_number", [context.phone, `+${context.phone}`]).order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
  if (error) throw new Error("No se pudo recuperar el historial WhatsApp.");
  return { companyId, name: context.name, phone: context.phone, canReply: context.reasons.length === 0,
    canTemplate: context.templateReasons.length === 0, templateReasons: context.templateReasons,
    reasons: context.reasons, expiresAt: context.window.expiresAt, nextOffset: data?.length === 50 ? offset + 50 : null,
    messages: (data || []).map((row: Row) => ({ id: row.id, direction: row.direction, body: storedWhatsAppBody(row),
      type: row.message_type, status: row.status, occurredAt: row.occurred_at })).reverse() };
}

export async function sendWhatsAppReply(db: SupabaseClient, env: Env, payload: Row, userId: string, request: typeof fetch = fetch, files: MessageFile[] = []) {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const templateMode = payload.mode === "template";
  if ((!templateMode && ((!text && !files.length) || text.length > (files.length ? 1024 : 4096))) || payload.confirmSend !== true || !uuid.test(String(payload.requestId || ""))) {
    throw new Error("Confirma un mensaje de 1 a 4096 caracteres con identificador de envio valido.");
  }
  if (files.length > 1 || (templateMode && files.length)) throw new Error("Un adjunto por respuesta libre; las plantillas conservan su contenido aprobado.");
  for (const file of files) validateMessageFile({ ...file, size: file.bytes.length });
  const context = await conversationContext(db, env, String(payload.companyId || ""), String(payload.phone || ""), String(payload.contactId || ""));
  const reasons = templateMode ? context.templateReasons : context.reasons;
  if (reasons.length) throw new Error(reasons.join(" "));
  let body: Row = { messaging_product: "whatsapp", recipient_type: "individual", to: context.phone, type: "text", text: { preview_url: false, body: text } };
  let storedBody = text; let templateName: string | null = null;
  if (templateMode) {
    const template = (await listMetaTemplates(context.config, request)).find(t => t.id === payload.templateId && t.language === payload.language);
    if (!template) throw new Error("La plantilla ya no esta disponible en Meta.");
    body = buildMetaTemplateMessage(template, context.phone, payload.parameters, "");
    templateName = template.name;
    storedBody = template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name) => String(payload.parameters[template.variables.indexOf(name)] || ""));
  }
  const metadata = await messageFileMetadata(files);
  const messageType = templateMode ? "template" : files.length ? files[0].type.startsWith("image/") ? "image" : "document" : "text";
  if (files.length) storedBody = [text, `Adjunto: ${files[0].name}`].filter(Boolean).join("\n");
  const id = await whatsappDispatchId(`reply:${payload.companyId}:${payload.requestId}`, context.phone);
  const { error: reservationError } = await db.from("whatsapp_messages").insert({ id, company_id: payload.companyId,
    direction: "outbound", phone_number: context.phone, message_type: messageType, template_name: templateName, body: storedBody, status: "pending",
    raw_payload: { kind: "manual_reply", user_id: userId, contact_id: payload.contactId || null, reply_to: context.incoming?.meta_message_id || null, request_id: payload.requestId, attachments: metadata } });
  if (reservationError) throw new Error(reservationError.code === "23505" ? "Este envio ya tiene un intento registrado. Actualiza el historial; no lo repitas." : "No se pudo reservar el envio. No se contacto a Meta.");
  // Media is uploaded privately only after the user confirms this exact send.
  try {
    if (files.length) {
      const file = files[0], form = new FormData();
      form.set("messaging_product", "whatsapp"); form.set("type", file.type);
      form.set("file", new Blob([new Uint8Array(file.bytes).buffer], { type: file.type }), file.name);
      const upload = await request(`https://graph.facebook.com/${context.config.version}/${context.config.phoneId}/media`, {
        method: "POST", headers: { Authorization: `Bearer ${context.config.token}` }, body: form, signal: AbortSignal.timeout(30000),
      });
      const uploaded = await upload.json();
      if (!upload.ok || typeof uploaded.id !== "string" || !uploaded.id) throw new Error("No se pudo cargar el adjunto en Meta. No se envio el mensaje.");
      body = { messaging_product: "whatsapp", recipient_type: "individual", to: context.phone, type: messageType,
        [messageType]: { id: uploaded.id, ...(text ? { caption: text } : {}), ...(messageType === "document" ? { filename: file.name } : {}) } };
    }
    const latest = await conversationContext(db, env, String(payload.companyId), context.phone, String(payload.contactId || ""), id);
    const currentReasons = templateMode ? latest.templateReasons : latest.reasons;
    if (currentReasons.length) throw new Error(currentReasons.join(" "));
  } catch {
    const { error } = await db.from("whatsapp_messages").update({ status: "failed" }).eq("id", id);
    return { accepted: false, id, outcome: "rejected", warning: `No se envio el mensaje: fallo la carga del adjunto o cambio la disponibilidad del contacto.${error ? " El estado local requiere revision." : ""}` };
  }
  try {
    const response = await request(`https://graph.facebook.com/${context.config.version}/${context.config.phoneId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${context.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok && response.status < 500 && response.status !== 408) {
      const { error } = await db.from("whatsapp_messages").update({ status: "failed" }).eq("id", id);
      return { accepted: false, id, outcome: "rejected", warning: `Meta rechazo el mensaje (codigo ${Number(data.error?.code) || response.status}).${error ? " El estado local requiere revision." : ""}` };
    }
    if (!response.ok) throw new Error("uncertain-send");
    const messageId = data.messages?.[0]?.id;
    if (typeof messageId !== "string" || !messageId) throw new Error("missing-message-id");
    const { error } = await db.from("whatsapp_messages").update({ meta_message_id: messageId, status: "sent" }).eq("id", id);
    return { accepted: true, id, outcome: "accepted", warning: error ? "Meta acepto el mensaje; el registro local requiere revision. No reenviar." : null };
  } catch {
    return { accepted: false, id, outcome: "uncertain", warning: "Resultado incierto. Se conserva el intento para evitar duplicados. Actualiza el historial; no reenvies el mensaje." };
  }
}
