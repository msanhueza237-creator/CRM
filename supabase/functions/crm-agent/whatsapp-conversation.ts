import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getWhatsAppConfig } from "./whatsapp-dispatch.ts";
import { whatsappDispatchId, buildMetaTemplateMessage, listMetaTemplates, enrichWhatsAppTemplates, validateWhatsAppRecipient } from "./whatsapp-meta.ts";
import { storedWhatsAppBody, whatsappPhone } from "../_shared/whatsapp-content.ts";
import { WhatsAppConversationPolicyService, CLOSED_WINDOW_MESSAGE, metaFunctionalError, redactMeta } from "./whatsapp-policy.ts";
import { resolveTemplateValues } from "./whatsapp-template-model.ts";
import { resolveMessageRecipient, messageFileMetadata, validateMessageFile, type MessageFile } from "../_shared/direct-message.ts";
import { getWhatsAppCatalogSelections } from "./whatsapp-catalog.ts";
import { findWhatsAppContacts } from "./whatsapp-incoming.ts";

// Existing Supabase JSON rows are validated before a send is attempted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Env = (names: string[]) => string;
const fields = "id,company_id,direction,phone_number,meta_message_id,message_type,template_name,body,status,occurred_at,raw_payload";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function latestIncoming(db: SupabaseClient, companyId: string, phone: string, phoneId: string) {
  let latest: Row | null = null;
  for (let offset = 0; offset < 10000; offset += 100) {
    let query = db.from("whatsapp_messages").select(fields).eq("company_id", companyId).eq("direction", "inbound");
    if (phone) query = query.in("phone_number", [phone, `+${phone}`]);
    const { data, error } = await query.order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 99);
    if (error) throw new Error("No se pudo consultar la respuesta del cliente.");
    latest ||= data?.[0] || null;
    const incoming = data?.find((row: Row) => whatsappPhone(row.phone_number) === whatsappPhone(latest?.phone_number) && WhatsAppConversationPolicyService.evaluate(row, phoneId).lastInboundAt);
    if (incoming || (data?.length || 0) < 100) return { latest, incoming: incoming || null };
  }
  throw new Error("El historial no permite verificar la ventana de atención. Revisión requerida.");
}

async function conversationContext(db: SupabaseClient, env: Env, companyId: string, requestedPhone: string, contactId = "", ownAttempt = "") {
  if (!uuid.test(companyId)) throw new Error("Empresa no valida.");
  const config = await getWhatsAppConfig(db, env);
  const { data: company, error } = await db.from("companies").select("id,name,contact_name,whatsapp_status,whatsapp_opt_in,whatsapp_number,whatsapp,phone,whatsapp_opt_in_date,whatsapp_opt_in_source,whatsapp_opt_in_phone").eq("id", companyId).maybeSingle();
  if (error || !company) throw new Error("Empresa no disponible.");
  const target = contactId ? await resolveMessageRecipient(db, companyId, contactId) : null;
  const phone = whatsappPhone(requestedPhone || target?.recipient.phone || company.whatsapp_number || company.whatsapp || company.phone);
  if (target && target.recipient.phone !== phone) throw new Error("El numero del contacto cambio. Vuelve a seleccionarlo.");
  if (phone && !/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Numero no valido.");
  const { incoming, latest } = await latestIncoming(db, companyId, phone, config.phoneId);
  const actualPhone = whatsappPhone(latest?.phone_number) || phone;
  const knownPhones = [company.whatsapp_number, company.whatsapp, company.phone, target?.recipient.phone].map(whatsappPhone);
  if (!/^[1-9]\d{7,14}$/.test(actualPhone) || (!latest && !knownPhones.includes(actualPhone))) throw new Error("No hay mensajes ni numero registrado para este contacto.");
  const window = WhatsAppConversationPolicyService.evaluate(whatsappPhone(incoming?.phone_number) === actualPhone ? incoming : null, config.phoneId);
  let consent: Row = company;
  if (contactId) {
    const result = await db.from("contacts").select("whatsapp_opt_in,whatsapp_status,whatsapp,phone,whatsapp_opt_in_date,whatsapp_opt_in_source,whatsapp_opt_in_phone").eq("id", contactId).eq("company_id",companyId).single();
    if(result.error) throw new Error("No se pudo verificar el consentimiento del contacto.");
    consent = result.data;
  }
  const matchingContacts = await findWhatsAppContacts(db, companyId, actualPhone);
  if (!contactId && matchingContacts.length === 1 && !knownPhones.slice(0, 3).includes(actualPhone)) consent = matchingContacts[0];
  const withdrawnContact = matchingContacts.find(row => ["opt_out", "bloqueado", "invalido", "no_contactar"].includes(row.whatsapp_status));
  if (withdrawnContact) consent = withdrawnContact;
  // A newly linked contact must not bypass a withdrawal recorded for this number.
  const companyConsentPhone = whatsappPhone(company.whatsapp_opt_in_phone || company.whatsapp_number || company.whatsapp || company.phone);
  if (company.whatsapp_status === "opt_out" && companyConsentPhone === actualPhone) consent = company;
  const optedOut = consent.whatsapp_status === "opt_out" || Boolean(latest && /^(salir|stop|baja|no m[aá]s mensajes)$/i.test(storedWhatsAppBody(latest).trim()));
  const blockers = [...config.blockers];
  if (optedOut || ["bloqueado", "invalido", "no_contactar"].includes(consent.whatsapp_status)) blockers.push("No contactable por WhatsApp. El contacto tiene los envíos bloqueados.");
  const { data: pending, error: pendingError } = await db.from("whatsapp_messages").select("id")
    .eq("company_id", companyId).in("phone_number", [actualPhone, `+${actualPhone}`]).eq("direction", "outbound").eq("status", "pending").limit(2);
  if (pendingError) throw new Error("No se pudo verificar si hay envios pendientes.");
  if (pending?.some((p: Row) => p.id !== ownAttempt)) blockers.push("Hay un envio pendiente o de resultado incierto. Revisa su estado antes de enviar otro.");
  const templateReasons = [...blockers];
  try { validateWhatsAppRecipient(consent, actualPhone); } catch { templateReasons.push("Este número no tiene consentimiento vigente y trazable para iniciar mensajes con plantilla."); }
  const reasons = [...blockers];
  if (!window.open) reasons.push(CLOSED_WINDOW_MESSAGE);
  return { config, company, consent, optedOut, phone: actualPhone, incoming, window, reasons, templateReasons, name: target?.recipient.name || company.contact_name || company.name };
}

export async function getWhatsAppConversation(db: SupabaseClient, env: Env, companyId: string, phone = "", offset = 0, contactId = "") {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("Pagina no valida.");
  if (!companyId && !contactId) {
    const number = whatsappPhone(phone);
    if (!/^[1-9]\d{7,14}$/.test(number)) throw new Error("Numero no valido.");
    const { data, error } = await db.from("whatsapp_messages").select(fields).is("company_id", null)
      .in("phone_number", [number, `+${number}`, ...(number.startsWith("569") && number.length === 11 ? [number.slice(2)] : [])])
      .order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
    if (error) throw new Error("No se pudo recuperar el historial WhatsApp.");
    const catalog = await getWhatsAppCatalogSelections(db, data || []);
    const reasons = ["Conversacion sin ficha vinculada. El historial se conserva; el envio requiere un contacto registrado."];
    return { companyId: "", name: "Sin ficha vinculada", phone: number, canReply: false, canTemplate: false, templateReasons: reasons, reasons,
      expiresAt: null, nextOffset: data?.length === 50 ? offset + 50 : null,
      messages: (data || []).map((row: Row) => ({ id: row.id, direction: row.direction, body: storedWhatsAppBody(row), type: row.message_type, status: row.status, occurredAt: row.occurred_at,
        ...(catalog.has(row.id) ? { catalogSelection: catalog.get(row.id) } : {}) })).reverse() };
  }
  const context = await conversationContext(db, env, companyId, phone, contactId);
  const { data, error } = await db.from("whatsapp_messages").select(fields).eq("company_id", companyId)
    .in("phone_number", [context.phone, `+${context.phone}`]).order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
  if (error) throw new Error("No se pudo recuperar el historial WhatsApp.");
  const catalog = await getWhatsAppCatalogSelections(db, data || []);
  const { data: lastOutbound, error: outboundError } = await db.from("whatsapp_messages").select("occurred_at")
    .eq("company_id", companyId).eq("direction", "outbound").in("phone_number", [context.phone, `+${context.phone}`])
    .order("occurred_at", { ascending: false }).limit(1).maybeSingle();
  if (outboundError) throw new Error("No se pudo verificar el último mensaje enviado.");
  return { companyId, name: context.name, phone: context.phone, canReply: context.reasons.length === 0,
    policy: context.window, variableContext: { nombre_cliente: context.name, empresa: context.company.name },
    consent: { allowed: !context.optedOut && context.consent.whatsapp_opt_in === true, status: context.optedOut ? "opt_out" : context.consent.whatsapp_status || null,
      date: context.consent.whatsapp_opt_in_date || null, source: context.consent.whatsapp_opt_in_source || null },
    lastInboundAt: context.window.lastInboundAt, lastOutboundAt: lastOutbound?.occurred_at || null,
    canTemplate: context.templateReasons.length === 0, templateReasons: context.templateReasons,
    reasons: context.reasons, expiresAt: context.window.expiresAt, nextOffset: data?.length === 50 ? offset + 50 : null,
    messages: (data || []).map((row: Row) => ({ id: row.id, direction: row.direction, body: storedWhatsAppBody(row),
      type: row.message_type, status: row.status, occurredAt: row.occurred_at,
      ...(catalog.has(row.id) ? { catalogSelection: catalog.get(row.id) } : {}) })).reverse() };
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
  let body: Row = { messaging_product: "whatsapp", recipient_type: "individual", to: `+${context.phone}`, type: "text", text: { preview_url: false, body: text } };
  let storedBody = text; let templateName: string | null = null; let selectedTemplate: Row | null = null;
  if (templateMode) {
    const template = (await enrichWhatsAppTemplates(db, await listMetaTemplates(context.config, request), context.config.wabaId)).find(t => t.id === payload.templateId && t.language === payload.language);
    if (!template) throw new Error("La plantilla ya no esta disponible en Meta.");
    if (payload.templateVersion && payload.templateVersion !== template.versionKey) throw new Error("La plantilla cambió en Meta. Actualiza y revisa la vista previa antes de enviarla.");
    if (template.bindings?.length) {
      const { data: profile } = await db.from("profiles").select("full_name").eq("id",userId).maybeSingle();
      const supplied = Object.fromEntries(template.variables.map((key,i)=>[key,payload.parameters?.[i]]));
      const resolved = resolveTemplateValues(template.bindings,{nombre_cliente:context.name,empresa:context.company.name,nombre_vendedor:String(profile?.full_name || "")},supplied);
      if (JSON.stringify(resolved)!==JSON.stringify(payload.parameters)) throw new Error("Los datos del cliente o vendedor cambiaron. Revisa nuevamente la vista previa.");
    }
    body = buildMetaTemplateMessage(template, context.phone, payload.parameters, "");
    selectedTemplate = template;
    templateName = template.name;
    storedBody = template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name) => String(payload.parameters[template.variables.indexOf(name)] || ""));
  }
  const metadata = await messageFileMetadata(files);
  const messageType = templateMode ? "template" : files.length ? files[0].type.startsWith("image/") ? "image" : "document" : "text";
  if (files.length) storedBody = [text, `Adjunto: ${files[0].name}`].filter(Boolean).join("\n");
  const id = await whatsappDispatchId(`reply:${payload.companyId}:${payload.requestId}`, context.phone);
  const { error: reservationError } = await db.from("whatsapp_messages").insert({ id, company_id: payload.companyId,
    direction: "outbound", phone_number: context.phone, message_type: messageType, template_name: templateName, body: storedBody, status: "pending",
    actor_id: userId, template_meta_id: selectedTemplate?.id || null, template_language: selectedTemplate?.language || null, template_category: selectedTemplate?.category || null,
    recipient_country: context.phone.startsWith("56") ? "CL" : null,
    raw_payload: { kind: "manual_reply", user_id: userId, contact_id: payload.contactId || null, reply_to: context.incoming?.meta_message_id || null, request_id: payload.requestId, attachments: metadata,
      template_version: selectedTemplate?.versionKey || null, parameters: templateMode ? payload.parameters : null, graph_version: context.config.version, window_expires_at: context.window.expiresAt } });
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
      body = { messaging_product: "whatsapp", recipient_type: "individual", to: `+${context.phone}`, type: messageType,
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
      const { error } = await db.from("whatsapp_messages").update({ status: "failed", provider_error: redactMeta(data,[context.config.token]) }).eq("id", id);
      return { accepted: false, id, outcome: "rejected", warning: `${metaFunctionalError(data)}${error ? " El estado local requiere revision." : ""}` };
    }
    if (!response.ok) throw new Error("uncertain-send");
    const messageId = data.messages?.[0]?.id;
    if (typeof messageId !== "string" || !messageId) throw new Error("missing-message-id");
    const { error } = await db.from("whatsapp_messages").update({ meta_message_id: messageId, status: "accepted", provider_response: redactMeta(data,[context.config.token]) }).eq("id", id);
    return { accepted: true, id, outcome: "accepted", warning: error ? "Meta acepto el mensaje; el registro local requiere revision. No reenviar." : null };
  } catch {
    return { accepted: false, id, outcome: "uncertain", warning: "Resultado incierto. Se conserva el intento para evitar duplicados. Actualiza el historial; no reenvies el mensaje." };
  }
}
