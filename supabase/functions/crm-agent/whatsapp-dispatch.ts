import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { buildMetaTemplateMessage, listMetaTemplates, enrichWhatsAppTemplates, validateWhatsAppRecipient, whatsappDispatchId } from "./whatsapp-meta.ts";
import { metaFunctionalError, redactMeta } from "./whatsapp-policy.ts";

type Row = Record<string, unknown>;
type Env = (names: string[]) => string;
const companyFields = "id, whatsapp, whatsapp_number, phone, whatsapp_opt_in, whatsapp_status,whatsapp_opt_in_date,whatsapp_opt_in_source,whatsapp_opt_in_phone";

export async function getWhatsAppConfig(db: SupabaseClient, env: Env) {
  const { data: settings, error } = await db.from("whatsapp_settings")
    .select("phone_number_id,business_account_id,active").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("No se pudo leer la configuracion WhatsApp.");
  const token = env(["META_WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN"]);
  const envPhone = env(["META_WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PHONE_NUMBER_ID"]);
  const envWaba = env(["META_WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "META_WHATSAPP_WABA_ID"]);
  const phoneId = envPhone || String(settings?.phone_number_id || "");
  const wabaId = envWaba || String(settings?.business_account_id || "");
  if (!token || !phoneId || !wabaId) throw new Error("Falta configurar token, numero o cuenta WhatsApp en el backend.");
  if ((settings?.phone_number_id && settings.phone_number_id !== phoneId) ||
    (settings?.business_account_id && settings.business_account_id !== wabaId)) {
    throw new Error("Los identificadores del CRM y del backend no coinciden.");
  }
  const blockers: string[] = [];
  if (!settings?.active) blockers.push("La integracion WhatsApp esta desactivada en Administracion.");
  if (env(["META_WHATSAPP_PRODUCTION_APPROVED"]).toLowerCase() !== "true") blockers.push("Falta habilitar produccion en el backend.");
  if (!env(["META_WHATSAPP_APP_SECRET"])) blockers.push("Falta el secreto de firma del webhook.");
  if (!env(["META_WHATSAPP_WEBHOOK_VERIFY_TOKEN", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "META_WHATSAPP_VERIFY_TOKEN", "WEBHOOK_VERIFY_TOKEN"])) blockers.push("Falta configurar la verificacion del webhook.");
  const version = env(["META_GRAPH_API_VERSION"]);
  if (!/^v\d+\.0$/.test(version)) throw new Error("Configura META_GRAPH_API_VERSION con la versión Graph revisada por el administrador.");
  return { token, phoneId, wabaId, version, blockers };
}

export async function getWhatsAppTemplates(db: SupabaseClient, env: Env, request: typeof fetch = fetch) {
  const config = await getWhatsAppConfig(db, env);
  const templates = await enrichWhatsAppTemplates(db, await listMetaTemplates(config, request), config.wabaId);
  return { templates, ready: config.blockers.length === 0, blockers: config.blockers, phoneNumberId: config.phoneId };
}

export async function dispatchWhatsAppCampaign(db: SupabaseClient, env: Env, payload: Row, request: typeof fetch = fetch, actorId: string | null = null) {
  if (payload.confirmSend !== true) throw new Error("Confirma expresamente el envio de la campana.");
  if (payload.allowWithoutOptIn) throw new Error("No se permiten envios sin consentimiento WhatsApp.");
  const campaignId = String(payload.campaignId || "");
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) throw new Error("Guarda primero la campana en el CRM.");
  if (!Array.isArray(payload.recipients) || !payload.recipients.length || payload.recipients.length > 10) {
    throw new Error("El lote debe contener entre 1 y 10 destinatarios.");
  }
  const recipients = payload.recipients.map((value: Row) => ({
    companyId: String(value?.companyId || ""), phone: String(value?.phone || "").replace(/\D/g, ""), parameters: value?.parameters,
  }));
  if (new Set(recipients.map((r) => r.phone)).size !== recipients.length ||
    new Set(recipients.map((r) => r.companyId)).size !== recipients.length) throw new Error("El lote contiene destinatarios repetidos.");
  const config = await getWhatsAppConfig(db, env);
  if (config.blockers.length) throw new Error(config.blockers.join(" "));
  const { data: campaign, error: campaignError } = await db.from("campaigns").select("id,type,status").eq("id", campaignId).maybeSingle();
  if (campaignError || !campaign || !["whatsapp", "mixta"].includes(campaign.type) || !["borrador", "programada"].includes(campaign.status)) {
    throw new Error("La campana no esta disponible para enviar por WhatsApp.");
  }
  const templates = await enrichWhatsAppTemplates(db, await listMetaTemplates(config, request), config.wabaId);
  const template = templates.find((t) => t.id === payload.templateId && t.language === payload.language);
  if (!template) throw new Error("La plantilla o su idioma ya no estan disponibles en Meta.");
  const thumbnail = String(payload.thumbnailProductId || "").trim();
  if (thumbnail.length > 200) throw new Error("La referencia de producto es demasiado larga.");
  const { data: companies, error: companiesError } = await db.from("companies").select(companyFields).in("id", recipients.map((r) => r.companyId));
  if (companiesError) throw new Error("No se pudo verificar el consentimiento de los destinatarios.");
  // Validate the entire batch before the first external side effect.
  const prepared = recipients.map((recipient) => {
    validateWhatsAppRecipient(companies?.find((c: Row) => c.id === recipient.companyId), recipient.phone);
    return { ...recipient, body: buildMetaTemplateMessage(template, recipient.phone, recipient.parameters, thumbnail) };
  });
  const results: Array<{ companyId: string; phone: string; success: boolean; error?: string; messageId?: string }> = [];
  for (const recipient of prepared) {
    const base = { companyId: recipient.companyId, phone: recipient.phone };
    const id = await whatsappDispatchId(campaignId, recipient.phone);
    const { data: current, error: consentError } = await db.from("companies").select(companyFields).eq("id", recipient.companyId).maybeSingle();
    try {
      if (consentError) throw new Error("No se pudo revalidar el consentimiento.");
      validateWhatsAppRecipient(current || undefined, recipient.phone);
    } catch (error) {
      results.push({ ...base, success: false, error: (error as Error).message });
      continue;
    }
    // A deterministic primary key reserves a dispatch across concurrent requests and uncertain timeouts.
    const { error: reservationError } = await db.from("whatsapp_messages").insert({
      id, company_id: recipient.companyId, direction: "outbound", phone_number: recipient.phone,
      message_type: "template", template_name: template.name, status: "pending",
      body: template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match,key)=>String((recipient.parameters as string[])[template.variables.indexOf(key)] || "")),
      actor_id: actorId, template_meta_id: template.id, template_language: template.language, template_category: template.category,
      recipient_country: recipient.phone.startsWith("56") ? "CL" : null,
      raw_payload: { campaign_id: campaignId, template_id: template.id, language: template.language, confirmed: true, parameters: recipient.parameters, template_version: template.versionKey, graph_version: config.version },
    });
    if (reservationError) {
      results.push({ ...base, success: false, error: reservationError.code === "23505"
        ? "Este destinatario ya tiene un intento registrado en esta campana. Revisa su estado antes de repetir."
        : "No se pudo reservar el envio. No se contacto a Meta." });
      continue;
    }
    try {
      const response = await request(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(recipient.body), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      const messageId = typeof data.messages?.[0]?.id === "string" ? data.messages[0].id : "";
      if (!response.ok && (response.status >= 500 || response.status === 408)) throw new Error("uncertain-send");
      if (!response.ok) {
        await db.from("whatsapp_messages").update({ status: "failed", provider_error: redactMeta(data,[config.token]) }).eq("id", id);
        results.push({ ...base, success: false, error: metaFunctionalError(data) });
        continue;
      }
      if (!messageId) throw new Error("missing-message-id");
      const { error: recordError } = await db.from("whatsapp_messages").update({ meta_message_id: messageId, status: "accepted", provider_response: redactMeta(data,[config.token]) }).eq("id", id);
      results.push({ ...base, success: true, messageId, ...(recordError ? { error: "Meta acepto el mensaje; el registro local requiere revision. No reenviar." } : {}) });
      try {
        await db.from("interactions").insert({ company_id: recipient.companyId, type: "whatsapp",
          description: `Campana WhatsApp: ${template.name} (${template.language}).`, result: `Meta: ${messageId}`, next_action: "Monitorear respuesta" });
        await db.from("companies").update({ last_whatsapp_message_at: new Date().toISOString() }).eq("id", recipient.companyId);
      } catch { /* Message acceptance is authoritative even if ancillary history is unavailable. */ }
      if (recordError) break;
    } catch {
      results.push({ ...base, success: false, error: "Resultado incierto. Se conserva el intento para evitar duplicados; revisar antes de reenviar." });
      // Stop the batch: a timeout is not evidence that Meta did not deliver the message.
      break;
    }
  }
  const processed = new Set(results.map((r) => r.companyId));
  for (const r of recipients) if (!processed.has(r.companyId)) results.push({ companyId: r.companyId, phone: r.phone, success: false, error: "Sin intentar: lote detenido para revision." });
  return { success: true, results };
}
