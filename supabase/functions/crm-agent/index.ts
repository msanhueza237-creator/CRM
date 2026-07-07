import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type ApiKeyValidation = {
  valid: boolean;
  key_id: string | null;
  key_name: string | null;
  scopes: string[] | null;
};

type RouteContext = {
  req: Request;
  url: URL;
  supabase: ReturnType<typeof createClient>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-climactiva-api-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};

const readableTables = new Set(["companies", "contacts", "interactions", "campaigns", "message_templates", "tasks", "tags"]);
const writableTables = new Set(["companies", "contacts", "interactions", "tasks"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const route = pathParts[pathParts.length - 1] ?? "";

    if (route === "health") {
      return json({ ok: true, service: "crm-agent" });
    }

    if (route === "validate") {
      const validation = await validateApiKey(req, supabase, "crm:read");
      if (!validation.valid) return unauthorized();
      return json({ valid: true, key_id: validation.key_id, key_name: validation.key_name, scopes: validation.scopes });
    }

    if (route === "whatsapp-webhook" && req.method === "GET") {
      return handleWhatsAppWebhookVerification(url);
    }

    if (route === "whatsapp-webhook" && req.method === "POST") {
      const validation = await validateMetaWebhookRequest(req.clone(), url, supabase);
      if (!validation.valid) return unauthorized("Invalid WhatsApp webhook request");
      return await handleWhatsAppWebhook({ req, url, supabase }, validation);
    }

    if (route === "gmail-webhook" && req.method === "POST") {
      const validation = await validateWebhookApiKey(req, url, supabase);
      if (!validation.valid) return unauthorized();
      return await handleGmailWebhook({ req, url, supabase }, validation);
    }

    if (route === "send-campaign" && req.method === "POST") {
      const validation = await validateApiKey(req, supabase, "crm:write");
      if (!validation.valid) return unauthorized();
      return await handleSendCampaign({ req, url, supabase }, validation);
    }

    if (readableTables.has(route) && req.method === "GET") {
      const validation = await validateApiKey(req, supabase, "crm:read");
      if (!validation.valid) return unauthorized();
      return await handleReadTable(route, { req, url, supabase });
    }

    if (writableTables.has(route) && req.method === "POST") {
      const validation = await validateApiKey(req, supabase, "crm:write");
      if (!validation.valid) return unauthorized("API key missing crm:write scope");
      return await handleInsertTable(route, { req, url, supabase }, validation);
    }

    if (writableTables.has(route) && req.method === "PATCH") {
      const validation = await validateApiKey(req, supabase, "crm:write");
      if (!validation.valid) return unauthorized("API key missing crm:write scope");
      return await handleUpdateTable(route, { req, url, supabase }, validation);
    }

    return json({ error: "Route not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json({ error: message }, 500);
  }
});

async function validateApiKey(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  requiredScope: string,
): Promise<ApiKeyValidation> {
  const apiKey = req.headers.get("x-climactiva-api-key")?.trim();
  if (!apiKey) {
    return { valid: false, key_id: null, key_name: null, scopes: null };
  }

  const { data, error } = await supabase.rpc("validate_agent_api_key", {
    p_api_key: apiKey,
    p_required_scope: requiredScope,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { valid: false, key_id: null, key_name: null, scopes: null };
  }

  return data[0] as ApiKeyValidation;
}

async function handleReadTable(table: string, context: RouteContext) {
  const { url, supabase } = context;
  const limit = clampNumber(url.searchParams.get("limit"), 1, 100, 50);
  const id = url.searchParams.get("id");
  const status = url.searchParams.get("status");
  const companyId = url.searchParams.get("company_id");
  const search = url.searchParams.get("search")?.trim();

  let query = supabase.from(table).select("*").limit(limit);

  if (id) query = query.eq("id", id);
  if (status && table === "companies") query = query.eq("status", status);
  if (companyId && ["contacts", "interactions", "tasks"].includes(table)) query = query.eq("company_id", companyId);
  if (search && table === "companies") query = query.ilike("name", `%${search}%`);

  if (["interactions", "tasks", "campaigns"].includes(table)) {
    query = query.order("created_at", { ascending: false });
  } else if (table === "contacts") {
    query = query.order("full_name", { ascending: true });
  } else {
    query = query.order("name", { ascending: true });
  }

  const { data, error } = await query;
  if (error) return json({ error: error.message }, 400);

  return json({ data, count: data?.length ?? 0 });
}

async function handleInsertTable(table: string, context: RouteContext, validation: ApiKeyValidation) {
  const payload = await readJsonObject(context.req);
  const row = sanitizePayload(table, payload);

  const { data, error } = await context.supabase.from(table).insert(row).select("*").single();
  if (error) return json({ error: error.message }, 400);

  await logAgentAction(context.supabase, validation, table, data?.id, "agent_inserted", { table });
  return json({ data }, 201);
}

async function handleUpdateTable(table: string, context: RouteContext, validation: ApiKeyValidation) {
  const id = context.url.searchParams.get("id");
  if (!id) return json({ error: "Missing id query parameter" }, 400);

  const payload = await readJsonObject(context.req);
  const row = sanitizePayload(table, payload);

  const { data, error } = await context.supabase.from(table).update(row).eq("id", id).select("*").single();
  if (error) return json({ error: error.message }, 400);

  await logAgentAction(context.supabase, validation, table, id, "agent_updated", { table });
  return json({ data });
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("JSON body must be an object");
  }
  return payload as Record<string, unknown>;
}

function sanitizePayload(table: string, payload: Record<string, unknown>) {
  const allowedFields: Record<string, string[]> = {
    companies: [
      "name",
      "legal_name",
      "description",
      "rut",
      "business_line",
      "type",
      "city",
      "region",
      "address",
      "website",
      "instagram",
      "facebook",
      "whatsapp",
      "phone",
      "email",
      "contact_name",
      "contact_role",
      "priority",
      "source",
      "notes",
      "status",
      "next_follow_up",
      "owner_id",
    ],
    contacts: ["company_id", "full_name", "role", "email", "phone", "whatsapp", "is_primary", "notes"],
    interactions: [
      "company_id",
      "contact_id",
      "type",
      "owner_id",
      "description",
      "result",
      "next_action",
      "related_url",
      "occurred_at",
    ],
    tasks: ["company_id", "owner_id", "title", "description", "due_date", "completed_at"],
  };

  const sanitized: Record<string, unknown> = {};
  for (const field of allowedFields[table] ?? []) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      sanitized[field] = payload[field];
    }
  }

  return sanitized;
}

async function logAgentAction(
  supabase: ReturnType<typeof createClient>,
  validation: ApiKeyValidation,
  entityType: string,
  entityId: string | null,
  action: string,
  metadata: Record<string, unknown>,
) {
  await supabase.from("activity_logs").insert({
    entity_type: entityType,
    entity_id: entityId,
    action,
    metadata: {
      ...metadata,
      agent_key_id: validation.key_id,
      agent_key_name: validation.key_name,
    },
  });
}

async function validateWebhookApiKey(
  req: Request,
  url: URL,
  supabase: ReturnType<typeof createClient>,
): Promise<ApiKeyValidation> {
  let apiKey = req.headers.get("x-climactiva-api-key")?.trim();
  if (!apiKey) {
    apiKey = url.searchParams.get("apikey")?.trim();
  }
  
  if (!apiKey) {
    return { valid: false, key_id: null, key_name: null, scopes: null };
  }

  const { data, error } = await supabase.rpc("validate_agent_api_key", {
    p_api_key: apiKey,
    p_required_scope: "crm:write",
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { valid: false, key_id: null, key_name: null, scopes: null };
  }

  return data[0] as ApiKeyValidation;
}

async function handleWhatsAppWebhook(context: RouteContext, validation: ApiKeyValidation) {
  let sender = "";
  let message = "";
  let metaMessageId = "";
  let eventType = "message";
  let rawPayload: Record<string, unknown> = {};

  const contentType = context.req.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await context.req.formData();
    sender = formData.get("From")?.toString() || "";
    message = formData.get("Body")?.toString() || "";
    rawPayload = Object.fromEntries(formData.entries());
  } else {
    const payload = await readJsonObject(context.req);
    rawPayload = payload;
    const parsed = parseMetaWhatsAppWebhook(payload);
    sender = parsed.sender || String(payload.sender || payload.From || "");
    message = parsed.message || String(payload.message || payload.Body || "");
    metaMessageId = parsed.metaMessageId;
    eventType = parsed.eventType;
  }

  await context.supabase.from("whatsapp_webhook_events").insert({
    event_type: eventType,
    meta_message_id: metaMessageId || null,
    phone_number: sender || null,
    payload: rawPayload,
    processed: false,
  });

  if (eventType === "status" && metaMessageId) {
    await updateWhatsAppMessageStatus(context.supabase, metaMessageId, rawPayload);
    return json({ success: true, event_type: eventType, meta_message_id: metaMessageId });
  }

  if (!sender || !message) {
    return json({ error: "Missing sender or message content" }, 400);
  }

  const cleanSender = sender.replace(/\D/g, "");

  const { data: companies, error: compError } = await context.supabase
    .from("companies")
    .select("id, name, whatsapp, phone");

  if (compError) return json({ error: compError.message }, 500);

  let matchedCompanyId = "";

  for (const c of companies || []) {
    const cWhatsapp = (c.whatsapp || "").replace(/\D/g, "");
    const cPhone = (c.phone || "").replace(/\D/g, "");
    if (
      (cWhatsapp && cleanSender.endsWith(cWhatsapp)) || 
      (cPhone && cleanSender.endsWith(cPhone)) || 
      (cWhatsapp && cWhatsapp.endsWith(cleanSender)) || 
      (cPhone && cPhone.endsWith(cleanSender))
    ) {
      matchedCompanyId = c.id;
      break;
    }
  }

  if (!matchedCompanyId) {
    const { data: contacts, error: contError } = await context.supabase
      .from("contacts")
      .select("id, company_id, phone, whatsapp");
    
    if (!contError && contacts) {
      for (const ct of contacts) {
        const ctWhatsapp = (ct.whatsapp || "").replace(/\D/g, "");
        const ctPhone = (ct.phone || "").replace(/\D/g, "");
        if (
          (ctWhatsapp && cleanSender.endsWith(ctWhatsapp)) || 
          (ctPhone && cleanSender.endsWith(ctPhone)) || 
          (ctWhatsapp && ctWhatsapp.endsWith(cleanSender)) || 
          (ctPhone && ctPhone.endsWith(cleanSender))
        ) {
          matchedCompanyId = ct.company_id;
          break;
        }
      }
    }
  }

  if (!matchedCompanyId) {
    const newCompanyName = `Contacto WhatsApp (${sender})`;
    const { data: newCompany, error: createError } = await context.supabase
      .from("companies")
      .insert({
        name: newCompanyName,
        whatsapp: sender,
        status: "prospecto",
        description: "Creado automáticamente mediante webhook de WhatsApp al recibir un mensaje."
      })
      .select("id")
      .single();

    if (createError) {
      return json({ error: `Could not match nor create company: ${createError.message}` }, 500);
    }
    matchedCompanyId = newCompany.id;
  }

  const { data: interaction, error: intError } = await context.supabase
    .from("interactions")
    .insert({
      company_id: matchedCompanyId,
      type: "whatsapp",
      description: message,
      result: "Mensaje entrante del cliente",
      next_action: "Responder mensaje"
    })
    .select("*")
    .single();

  if (intError) return json({ error: intError.message }, 500);

  await context.supabase.from("whatsapp_messages").insert({
    company_id: matchedCompanyId,
    direction: "inbound",
    phone_number: sender,
    meta_message_id: metaMessageId || null,
    message_type: "text",
    body: message,
    status: "received",
    raw_payload: rawPayload,
  });

  await context.supabase
    .from("companies")
    .update({ last_whatsapp_message_at: new Date().toISOString() })
    .eq("id", matchedCompanyId);

  await logAgentAction(context.supabase, validation, "interactions", interaction.id, "webhook_received_whatsapp", { sender });

  return json({ success: true, company_id: matchedCompanyId, interaction_id: interaction.id });
}

async function validateMetaWebhookRequest(
  req: Request,
  url: URL,
  supabase: ReturnType<typeof createClient>,
): Promise<ApiKeyValidation> {
  const appSecret = Deno.env.get("META_WHATSAPP_APP_SECRET")?.trim();

  if (appSecret) {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const rawBody = await req.text();
    const expected = await createMetaSignature(rawBody, appSecret);
    if (signature === expected) {
      return { valid: true, key_id: null, key_name: "meta-webhook", scopes: ["crm:write"] };
    }
  }

  return validateWebhookApiKey(req, url, supabase);
}

async function createMetaSignature(rawBody: string, appSecret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function parseMetaWhatsAppWebhook(payload: Record<string, unknown>) {
  const entry = Array.isArray(payload.entry) ? payload.entry[0] as Record<string, unknown> : undefined;
  const changes = Array.isArray(entry?.changes) ? entry?.changes[0] as Record<string, unknown> : undefined;
  const value = changes?.value as Record<string, unknown> | undefined;
  const messages = Array.isArray(value?.messages) ? value?.messages : [];
  const statuses = Array.isArray(value?.statuses) ? value?.statuses : [];
  const message = messages[0] as Record<string, unknown> | undefined;
  const status = statuses[0] as Record<string, unknown> | undefined;
  const text = message?.text as Record<string, unknown> | undefined;

  if (message) {
    return {
      eventType: "message",
      sender: String(message.from ?? ""),
      message: String(text?.body ?? ""),
      metaMessageId: String(message.id ?? ""),
    };
  }

  if (status) {
    return {
      eventType: "status",
      sender: String(status.recipient_id ?? ""),
      message: String(status.status ?? ""),
      metaMessageId: String(status.id ?? ""),
    };
  }

  return { eventType: "unknown", sender: "", message: "", metaMessageId: "" };
}

async function updateWhatsAppMessageStatus(
  supabase: ReturnType<typeof createClient>,
  metaMessageId: string,
  rawPayload: Record<string, unknown>,
) {
  const parsed = parseMetaWhatsAppWebhook(rawPayload);
  const status = parsed.message;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status };

  if (status === "sent") updates.sent_at = now;
  if (status === "delivered") updates.delivered_at = now;
  if (status === "read") updates.read_at = now;
  if (status === "failed") updates.failed_at = now;

  await supabase.from("whatsapp_campaign_recipients").update(updates).eq("meta_message_id", metaMessageId);
  await supabase.from("whatsapp_messages").update({ status, raw_payload: rawPayload }).eq("meta_message_id", metaMessageId);
  await supabase.from("whatsapp_webhook_events").update({ processed: true }).eq("meta_message_id", metaMessageId);
}

function handleWhatsAppWebhookVerification(url: URL) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expectedToken = Deno.env.get("META_WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim();

  if (mode === "subscribe" && challenge && expectedToken && token === expectedToken) {
    return new Response(challenge, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  return json({ error: "Webhook verification failed" }, 403);
}

async function handleGmailWebhook(context: RouteContext, validation: ApiKeyValidation) {
  const payload = await readJsonObject(context.req);
  const sender = String(payload.sender || payload.from || "").trim();
  const subject = String(payload.subject || "").trim();
  const message = String(payload.message || payload.body || "").trim();

  if (!sender || !message) {
    return json({ error: "Missing sender or message content" }, 400);
  }

  const emailRegex = /<([^>]+)>/;
  const emailMatch = sender.match(emailRegex);
  const cleanEmail = (emailMatch ? emailMatch[1] : sender).toLowerCase().trim();

  const { data: companies, error: compError } = await context.supabase
    .from("companies")
    .select("id, name, email");

  if (compError) return json({ error: compError.message }, 500);

  let matchedCompanyId = "";

  for (const c of companies || []) {
    const cEmail = (c.email || "").toLowerCase().trim();
    if (cEmail && cEmail === cleanEmail) {
      matchedCompanyId = c.id;
      break;
    }
  }

  if (!matchedCompanyId) {
    const { data: contacts, error: contError } = await context.supabase
      .from("contacts")
      .select("id, company_id, email");

    if (!contError && contacts) {
      for (const ct of contacts) {
        const ctEmail = (ct.email || "").toLowerCase().trim();
        if (ctEmail && ctEmail === cleanEmail) {
          matchedCompanyId = ct.company_id;
          break;
        }
      }
    }
  }

  if (!matchedCompanyId) {
    const newCompanyName = `Contacto Email (${cleanEmail})`;
    const { data: newCompany, error: createError } = await context.supabase
      .from("companies")
      .insert({
        name: newCompanyName,
        email: cleanEmail,
        status: "prospecto",
        description: "Creado automáticamente mediante webhook de Gmail al recibir un correo."
      })
      .select("id")
      .single();

    if (createError) {
      return json({ error: `Could not match nor create company: ${createError.message}` }, 500);
    }
    matchedCompanyId = newCompany.id;
  }

  const { data: interaction, error: intError } = await context.supabase
    .from("interactions")
    .insert({
      company_id: matchedCompanyId,
      type: "correo",
      description: `Asunto: ${subject}\n\n${message}`,
      result: "Correo entrante del cliente",
      next_action: "Responder correo"
    })
    .select("*")
    .single();

  if (intError) return json({ error: intError.message }, 500);

  await logAgentAction(context.supabase, validation, "interactions", interaction.id, "webhook_received_gmail", { sender });

  return json({ success: true, company_id: matchedCompanyId, interaction_id: interaction.id });
}

async function handleSendCampaign(context: RouteContext, validation: ApiKeyValidation) {
  const payload = await readJsonObject(context.req);
  const campaignId = String(payload.campaignId || "");
  const templateName = String(payload.templateName || "").trim();
  const allowWithoutOptIn = Boolean(payload.allowWithoutOptIn);
  const adminOverrideReason = String(payload.adminOverrideReason || "").trim();
  const recipients = payload.recipients as Array<{
    phone: string;
    companyId: string;
    parameters: string[];
  }>;

  const metaAccessToken = String(Deno.env.get("META_WHATSAPP_ACCESS_TOKEN") || "").trim();
  const metaPhoneNumberId = String(Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID") || "").trim();

  if (!metaAccessToken || !metaPhoneNumberId) {
    return json({ error: "Missing META_WHATSAPP_ACCESS_TOKEN or META_WHATSAPP_PHONE_NUMBER_ID" }, 400);
  }

  if (!templateName) {
    return json({ error: "Missing templateName" }, 400);
  }

  if (allowWithoutOptIn && !adminOverrideReason) {
    return json({ error: "Missing adminOverrideReason for recipients without WhatsApp opt-in" }, 400);
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return json({ error: "Recipients must be a non-empty array" }, 400);
  }

  const companyIds = Array.from(new Set(recipients.map((recipient) => recipient.companyId).filter(Boolean)));
  const { data: companies, error: companiesError } = await context.supabase
    .from("companies")
    .select("id, whatsapp, whatsapp_number, phone, whatsapp_opt_in, whatsapp_status")
    .in("id", companyIds);

  if (companiesError) {
    return json({ error: companiesError.message }, 500);
  }

  const companiesById = new Map((companies || []).map((company) => [String(company.id), company]));

  console.log(`Starting WhatsApp campaign dispatch via Meta API for campaign ${campaignId}. Total: ${recipients.length}`);

  const results = [];

  for (const recipient of recipients) {
    const company = companiesById.get(recipient.companyId);
    const hasOptIn = Boolean(company?.whatsapp_opt_in);

    if (!hasOptIn && !allowWithoutOptIn) {
      results.push({ phone: recipient.phone, success: false, error: "Company does not have WhatsApp opt-in" });
      continue;
    }

    const phoneSource = recipient.phone || String(company?.whatsapp_number || company?.whatsapp || company?.phone || "");
    const cleanPhone = phoneSource.replace(/\D/g, "");
    if (!cleanPhone) {
      results.push({ phone: phoneSource, success: false, error: "Invalid phone format" });
      continue;
    }

    const bodyParams = (recipient.parameters || []).map((p) => ({
      type: "text",
      text: String(p)
    }));

    const metaBody = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: "es"
        },
        components: bodyParams.length > 0 ? [
          {
            type: "body",
            parameters: bodyParams
          }
        ] : []
      }
    };

    try {
      const response = await fetch(`https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${metaAccessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(metaBody)
      });

      const resData = await response.json();

      if (response.ok) {
        const metaMessageId = resData.messages?.[0]?.id || null;
        await context.supabase.from("interactions").insert({
          company_id: recipient.companyId,
          type: "whatsapp",
          description: `Campaña WhatsApp enviada vía Meta API. Plantilla: ${templateName}`,
          result: `Enviado con ID de mensaje Meta: ${metaMessageId || "unknown"}`,
          next_action: "Monitorear lectura"
        });

        await context.supabase.from("whatsapp_messages").insert({
          company_id: recipient.companyId,
          direction: "outbound",
          phone_number: cleanPhone,
          meta_message_id: metaMessageId,
          message_type: "template",
          template_name: templateName,
          status: "sent",
          raw_payload: resData,
        });

        await context.supabase
          .from("companies")
          .update({
            last_whatsapp_message_at: new Date().toISOString(),
            whatsapp_status: hasOptIn ? "opt_in" : "sin_consentimiento",
          })
          .eq("id", recipient.companyId);

        results.push({ phone: cleanPhone, success: true, messageId: metaMessageId });
      } else {
        await context.supabase.from("whatsapp_messages").insert({
          company_id: recipient.companyId,
          direction: "outbound",
          phone_number: cleanPhone,
          message_type: "template",
          template_name: templateName,
          status: "failed",
          raw_payload: resData,
        });

        results.push({ phone: cleanPhone, success: false, error: resData.error?.message || "Meta API Error" });
      }
    } catch (err) {
      results.push({ phone: cleanPhone, success: false, error: err instanceof Error ? err.message : "Network error" });
    }
  }

  await logAgentAction(context.supabase, validation, "campaigns", campaignId, "agent_dispatched_meta_campaign", {
    templateName,
    total: recipients.length,
    successCount: results.filter((r) => r.success).length,
    allowWithoutOptIn,
    adminOverrideReason: allowWithoutOptIn ? adminOverrideReason : undefined
  });

  return json({ success: true, results });
}

function clampNumber(value: string | null, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function unauthorized(message = "Invalid API key") {
  return json({ error: message }, 401);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}
