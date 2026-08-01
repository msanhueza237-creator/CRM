import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type ApiKeyValidation = {
  valid: boolean;
  key_id: string | null;
  key_name: string | null;
  scopes: string[] | null;
  error?: string | null;
};

type RouteContext = {
  req: Request;
  url: URL;
  supabase: ReturnType<typeof createClient>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-climactiva-api-key, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_JSON_BODY_BYTES = 1_000_000;
const MAX_EVIDENCE_PER_CANDIDATE = 100;

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
      if (!validation.valid) return unauthorized(validation.error || "Invalid WhatsApp webhook request");
      return await handleWhatsAppWebhook({ req, url, supabase }, validation);
    }

    if (route === "gmail-webhook" && req.method === "POST") {
      const validation = await validateWebhookApiKey(req, url, supabase);
      if (!validation.valid) return unauthorized();
      return await handleGmailWebhook({ req, url, supabase }, validation);
    }

    const tiendanubePrivacyRouteIndex = pathParts.lastIndexOf("tiendanube-privacy");
    if (tiendanubePrivacyRouteIndex >= 0 && req.method === "POST") {
      return await handleTiendanubePrivacyWebhook(
        { req, url, supabase },
        pathParts.slice(tiendanubePrivacyRouteIndex + 1),
      );
    }

    if (route === "send-campaign" && req.method === "POST") {
      const validation = await validateApiKey(req, supabase, "crm:write");
      if (!validation.valid) return unauthorized();
      return await handleSendCampaign({ req, url, supabase }, validation);
    }

    const prospectingRouteIndex = pathParts.lastIndexOf("prospecting-runs");
    if (prospectingRouteIndex >= 0) {
      const validation = await validateApiKey(req, supabase, "prospecting:execute");
      if (!validation.valid) return unauthorized("API key missing prospecting:execute scope");
      const prospectingPath = pathParts.slice(prospectingRouteIndex + 1);
      return await handleProspectingRoute({ req, url, supabase }, validation, prospectingPath);
    }

    const enrichmentRouteIndex = pathParts.lastIndexOf("prospecting-enrichment");
    if (enrichmentRouteIndex >= 0) {
      const validation = await validateApiKey(req, supabase, "prospecting:execute");
      if (!validation.valid) return unauthorized("API key missing prospecting:execute scope");
      return await handleProspectingEnrichmentRoute(
        { req, url, supabase },
        validation,
        pathParts.slice(enrichmentRouteIndex + 1),
      );
    }

    const integrationRouteIndex = pathParts.lastIndexOf("prospecting-integrations");
    if (integrationRouteIndex >= 0) {
      const validation = await validateApiKey(req, supabase, "prospecting:execute");
      if (!validation.valid) return unauthorized("API key missing prospecting:execute scope");
      const integrationPath = pathParts.slice(integrationRouteIndex + 1);
      return await handleProspectingIntegrationRoute(
        { req, url, supabase },
        validation,
        integrationPath,
      );
    }

    const hubRouteIndex = pathParts.lastIndexOf("hub");
    if (hubRouteIndex >= 0) {
      const validation = await validateApiKey(req, supabase, "agent-hub:execute");
      if (!validation.valid) return unauthorized("API key missing agent-hub:execute scope");
      return await handleAgentHubRoute(
        { req, url, supabase },
        validation,
        pathParts.slice(hubRouteIndex + 1),
      );
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
    const status = error instanceof PayloadTooLargeError
      ? 413
      : error instanceof RequestValidationError
      ? 400
      : 500;
    return json({ error: message }, status);
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

async function handleAgentHubRoute(
  context: RouteContext,
  validation: ApiKeyValidation,
  routeParts: string[],
) {
  if (context.req.method !== "POST" || !validation.key_id) {
    return json({ error: "Agent Hub route not found" }, 404);
  }
  const payload = await readJsonObject(context.req);
  const operation = routeParts.join("/");

  if (operation === "integrations/status") {
    return withProspectingIdempotency(
      context,
      validation,
      "hub/integrations/status",
      payload,
      async () => {
        const provider = requiredString(payload.provider, "provider", 40);
        const status = requiredString(payload.status, "status", 40);
        const message = requiredString(payload.message, "message", 500);
        if (!["facto", "tiendanube"].includes(provider)) {
          throw new RequestValidationError("Unsupported Agent Hub provider");
        }
        if (!["pending_configuration", "checking", "connected", "degraded", "error", "disabled"].includes(status)) {
          throw new RequestValidationError("Unsupported integration status");
        }
        const now = new Date().toISOString();
        const { error } = await context.supabase.from("integration_connections").upsert({
          provider,
          enabled: Boolean(payload.enabled),
          read_only: payload.read_only !== false,
          status,
          message,
          last_checked_at: now,
          last_success_at: status === "connected" ? now : undefined,
          updated_at: now,
        }, { onConflict: "provider" });
        if (error) return { body: { error: error.message }, status: 400 };
        return { body: { ok: true } };
      },
    );
  }

  if (operation === "integrations/records/batch") {
    return withProspectingIdempotency(
      context,
      validation,
      "hub/integrations/records/batch",
      payload,
      async () => {
        const provider = requiredString(payload.provider, "provider", 40);
        const resource = requiredString(payload.resource, "resource", 60);
        const allowedResources = provider === "facto"
          ? [
            "products",
            "documents",
            "purchase_documents",
            "product_details",
            "document_details",
            "purchase_document_details",
            "payments",
            "inventory_snapshots",
            "financial_snapshots",
            "customers",
            "commercial_snapshots",
          ]
          : ["products", "customers", "orders"];
        if (!["facto", "tiendanube"].includes(provider) || !allowedResources.includes(resource)) {
          throw new RequestValidationError("Unsupported read-only integration resource");
        }
        if (!Array.isArray(payload.records) || payload.records.length > 100) {
          throw new RequestValidationError("records must contain at most 100 items");
        }
        const observedAt = new Date().toISOString();
        const rows = [];
        for (const item of payload.records) {
          const record = asObject(item);
          const externalId = requiredString(record.external_id, "external_id", 200);
          const recordPayload = asObject(record.payload);
          rows.push({
            provider,
            resource,
            external_id: externalId,
            payload: recordPayload,
            payload_hash: await sha256Hex(JSON.stringify(recordPayload)),
            observed_at: observedAt,
            updated_at: observedAt,
          });
        }
        const { error } = await context.supabase.from("integration_records").upsert(rows, {
          onConflict: "provider,resource,external_id",
        });
        if (error) return { body: { error: error.message }, status: 400 };
        return { body: { ok: true, accepted: rows.length } };
      },
    );
  }

  if (operation === "executive/schedule") {
    return withProspectingIdempotency(
      context,
      validation,
      "hub/executive/schedule",
      payload,
      async () => {
        const slotKey = requiredString(payload.slot_key, "slot_key", 120);
        const slotKind = requiredString(payload.slot_kind, "slot_kind", 20);
        const scheduledFor = requiredString(payload.scheduled_for, "scheduled_for", 60);
        if (!["morning", "review"].includes(slotKind) || Number.isNaN(Date.parse(scheduledFor))) {
          throw new RequestValidationError("Invalid executive schedule slot");
        }
        const existingSlot = await context.supabase
          .from("executive_schedule_slots")
          .select("task_id")
          .eq("slot_key", slotKey)
          .maybeSingle();
        if (existingSlot.error) return rpcErrorResult(existingSlot.error);
        if (existingSlot.data?.task_id) {
          return { body: { ok: true, task_id: existingSlot.data.task_id, existing: true } };
        }
        const [brief, settingsResult] = await Promise.all([
          collectExecutiveSignals(context.supabase, slotKind),
          context.supabase
            .from("executive_agent_settings")
            .select("email_enabled,email_to,whatsapp_enabled,whatsapp_to")
            .eq("id", "default")
            .maybeSingle(),
        ]);
        if (settingsResult.error) return rpcErrorResult(settingsResult.error);
        const settings = asObject(settingsResult.data);
        const taskPayload = {
          mode: slotKind,
          generated_at: new Date().toISOString(),
          slot_key: slotKey,
          delivery: {
            auto_send: true,
            email_enabled: settings.email_enabled !== false,
            email_to: String(settings.email_to || "msanhueza237@gmail.com"),
            whatsapp_enabled: settings.whatsapp_enabled === true,
            whatsapp_to: settings.whatsapp_to || null,
          },
          context: brief.context,
          signals: brief.signals,
        };
        const { data, error } = await context.supabase.rpc("schedule_executive_agent_task", {
          p_slot_key: slotKey,
          p_scheduled_for: scheduledFor,
          p_slot_kind: slotKind,
          p_payload: taskPayload,
          p_snapshot_keys: brief.snapshot_keys,
        });
        if (error) return rpcErrorResult(error);
        return { body: { ok: true, task_id: data, relevant: brief.relevant_count } };
      },
    );
  }

  if (operation === "executive/dispatch") {
    return withProspectingIdempotency(
      context,
      validation,
      "hub/executive/dispatch",
      payload,
      async () => {
        const { data, error } = await context.supabase.rpc("claim_executive_notification");
        if (error) return rpcErrorResult(error);
        const row = Array.isArray(data) ? data[0] : data;
        if (!row?.notification || !row?.task) return { body: { ok: true, dispatched: false } };

        const notification = asObject(row.notification);
        const task = asObject(row.task);
        const notificationId = requiredString(notification.id, "notification.id", 36);
        try {
          if (notification.channel !== "email") {
            throw new Error("WhatsApp permanece deshabilitado hasta la aprobacion de Meta");
          }
          const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
          const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
          const response = await fetch(`${supabaseUrl}/functions/v1/gmail-integration/executive-brief`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              notification_id: notificationId,
              task_id: task.id,
              recipient: notification.recipient,
              task,
              result: task.result,
              payload: task.payload,
            }),
          });
          if (!response.ok) throw new Error((await response.text()).slice(0, 400));
          await context.supabase.rpc("finish_executive_notification", {
            p_notification_id: notificationId,
            p_success: true,
            p_error: null,
          });
          return { body: { ok: true, dispatched: true, notification_id: notificationId } };
        } catch (dispatchError) {
          const message = dispatchError instanceof Error ? dispatchError.message : "delivery_failed";
          await context.supabase.rpc("finish_executive_notification", {
            p_notification_id: notificationId,
            p_success: false,
            p_error: message,
          });
          return { body: { ok: false, dispatched: false, error: message }, status: 502 };
        }
      },
    );
  }

  if (operation === "tasks/claim") {
    return withProspectingIdempotency(
      context,
      validation,
      "hub/tasks/claim",
      payload,
      async () => {
        const workerId = requiredString(payload.worker_id, "worker_id", 120);
        const leaseSeconds = clampNumber(String(payload.lease_seconds ?? "120"), 30, 600, 120);
        const { data, error } = await context.supabase.rpc("claim_business_agent_task", {
          p_worker_id: workerId,
          p_lease_seconds: leaseSeconds,
        });
        if (error) return rpcErrorResult(error);
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return { body: { task: null } };
        return {
          body: {
            task: row.task,
            lease_token: row.lease_token,
            lease_expires_at: row.lease_expires_at,
          },
        };
      },
    );
  }

  if (routeParts.length !== 3 || routeParts[0] !== "tasks") {
    return json({ error: "Agent Hub route not found" }, 404);
  }
  const taskId = routeParts[1];
  const action = routeParts[2];
  if (!isUuid(taskId) || !["heartbeat", "complete", "fail"].includes(action)) {
    return json({ error: "Agent Hub route not found" }, 404);
  }

  return withProspectingIdempotency(
    context,
    validation,
    `hub/tasks/${taskId}/${action}`,
    payload,
    async () => {
      const workerId = requiredString(payload.worker_id, "worker_id", 120);
      const leaseToken = requiredString(payload.lease_token, "lease_token", 36);
      if (!isUuid(leaseToken)) throw new RequestValidationError("lease_token must be a UUID");

      if (action === "heartbeat") {
        const leaseSeconds = clampNumber(String(payload.lease_seconds ?? "120"), 30, 600, 120);
        const { data, error } = await context.supabase.rpc(
          "heartbeat_business_agent_task",
          {
            p_task_id: taskId,
            p_worker_id: workerId,
            p_lease_token: leaseToken,
            p_lease_seconds: leaseSeconds,
          },
        );
        if (error) return rpcErrorResult(error);
        return { body: { ok: true, lease_expires_at: data } };
      }

      if (action === "complete") {
        const result = asObject(payload.result);
        if (!result.summary || typeof result.summary !== "string") {
          throw new RequestValidationError("result.summary is required");
        }
        const { error } = await context.supabase.rpc("complete_business_agent_task", {
          p_task_id: taskId,
          p_worker_id: workerId,
          p_lease_token: leaseToken,
          p_result: result,
        });
        if (error) return rpcErrorResult(error);
        return { body: { ok: true } };
      }

      const errorCode = requiredString(payload.error, "error", 200);
      const { error } = await context.supabase.rpc("fail_business_agent_task", {
        p_task_id: taskId,
        p_worker_id: workerId,
        p_lease_token: leaseToken,
        p_error: errorCode,
      });
      if (error) return rpcErrorResult(error);
      return { body: { ok: true } };
    },
  );
}

async function collectExecutiveSignals(
  supabase: ReturnType<typeof createClient>,
  slotKind: string,
) {
  const previousResult = await supabase
    .from("executive_schedule_slots")
    .select("snapshot_keys")
    .order("scheduled_for", { ascending: false })
    .limit(1)
    .maybeSingle();
  const previous = asObject(previousResult.data?.snapshot_keys);

  const [documentsResult, inventoryResult, proposalsResult, emailRepliesResult,
    whatsappRepliesResult, tasksResult, integrationsResult, financeResult, commercialResult] = await Promise.all([
    supabase.from("integration_records").select("external_id,payload,updated_at")
      .eq("provider", "facto").eq("resource", "documents").order("updated_at", { ascending: false }).limit(80),
    supabase.from("integration_records").select("external_id,payload,updated_at")
      .eq("provider", "facto").eq("resource", "inventory_snapshots").order("updated_at", { ascending: false }).limit(500),
    supabase.from("action_proposals").select("id,kind,title,summary,risk_level,created_at")
      .eq("status", "pending").order("created_at", { ascending: false }).limit(50),
    supabase.from("email_campaign_recipients")
      .select("id,campaign_id,company_id,reply_from_email,reply_subject,reply_snippet,replied_at")
      .not("replied_at", "is", null).order("replied_at", { ascending: false }).limit(50),
    supabase.from("whatsapp_messages").select("id,company_id,from_number,body,created_at")
      .eq("direction", "incoming").order("created_at", { ascending: false }).limit(50),
    supabase.from("business_agent_tasks").select("id,agent_type,result,completed_at")
      .eq("status", "completed").neq("agent_type", "executive")
      .order("completed_at", { ascending: false }).limit(30),
    supabase.from("integration_connections").select("provider,status,message,last_checked_at")
      .in("status", ["error", "degraded"]),
    supabase.from("integration_records").select("payload,updated_at").eq("provider", "facto")
      .eq("resource", "financial_snapshots").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("integration_records").select("payload,updated_at").eq("provider", "facto")
      .eq("resource", "commercial_snapshots").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const rows = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
  const keys = (value: Record<string, unknown>[], field = "id") => value.map((item) => String(item[field] || "")).filter(Boolean);
  const unseen = (value: Record<string, unknown>[], prior: unknown[], field = "id") => {
    const seen = new Set((Array.isArray(prior) ? prior : []).map(String));
    return value.filter((item) => !seen.has(String(item[field] || "")));
  };

  const documentRows = rows(documentsResult.data);
  const currentSalesKeys = keys(documentRows, "external_id");
  const selectedSales = slotKind === "morning"
    ? documentRows
    : unseen(documentRows, previous.sales as unknown[], "external_id");
  const sales = selectedSales
    .map((record) => ({
      external_id: record.external_id,
      observed_at: record.updated_at,
      ...pickExecutiveFields(asObject(record.payload), [
        "document_id", "folio", "number", "document_number", "document_type", "date", "issued_at",
        "issue_date", "receiver_business_name", "receiver_legal_name", "recipient_business_name",
        "customer_name", "customer", "net_total", "net_amount", "total", "total_amount", "gross_total",
        "status", "document_status",
      ]),
    }))
    .slice(0, 20);
  const stockoutRows = rows(inventoryResult.data).filter((record) => {
    const data = asObject(record.payload);
    const raw = data.available_units ?? data.stock ?? data.quantity ?? data.existence;
    return raw !== null && raw !== undefined && Number(raw) <= 0;
  });
  const proposalRows = rows(proposalsResult.data);
  const emailRows = rows(emailRepliesResult.data);
  const whatsappRows = rows(whatsappRepliesResult.data);
  const replyRows = [...emailRows.map((item) => ({ ...item, channel: "email" })),
    ...whatsappRows.map((item) => ({ ...item, channel: "whatsapp" }))];
  const taskRows = rows(tasksResult.data);
  const integrationRows = rows(integrationsResult.data);
  const selectedStockouts = slotKind === "morning"
    ? stockoutRows
    : unseen(stockoutRows, previous.stockouts as unknown[], "external_id");
  const selectedProposals = slotKind === "morning"
    ? proposalRows
    : unseen(proposalRows, previous.opportunities as unknown[]);
  const selectedIntegrations = slotKind === "morning"
    ? integrationRows
    : unseen(integrationRows, previous.integration_errors as unknown[], "provider");
  const selectedReplies = slotKind === "morning"
    ? replyRows
    : unseen(replyRows, previous.campaign_replies as unknown[]);
  const selectedTasks = slotKind === "morning"
    ? taskRows
    : unseen(taskRows, previous.agent_updates as unknown[]);

  const signals = {
    sales,
    stockouts: selectedStockouts.map((record) => ({
      external_id: record.external_id,
      observed_at: record.updated_at,
      ...pickExecutiveFields(asObject(record.payload), [
        "sku", "name", "product_name", "available_units", "stock", "quantity", "existence",
        "reorder_point", "warehouse", "unit_cost", "unit_price",
      ]),
    })).slice(0, 30),
    opportunities: selectedProposals.slice(0, 20),
    campaign_replies: selectedReplies.slice(0, 20),
    agent_updates: selectedTasks.map((task) => {
      const result = asObject(task.result);
      return {
        id: task.id,
        agent_type: task.agent_type,
        completed_at: task.completed_at,
        summary: result.summary ?? null,
        metrics: result.metrics ?? {},
        warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 3) : [],
      };
    }).slice(0, 20),
    integration_errors: selectedIntegrations.slice(0, 10),
  };
  const relevantCount = Object.values(signals).reduce((total, value) => total + value.length, 0);
  return {
    context: {
      financial_snapshot: compactExecutiveSnapshot(financeResult.data?.payload, financeResult.data?.updated_at),
      commercial_snapshot: compactExecutiveSnapshot(commercialResult.data?.payload, commercialResult.data?.updated_at),
    },
    signals,
    relevant_count: slotKind === "morning" ? Math.max(1, relevantCount) : relevantCount,
    snapshot_keys: {
      sales: currentSalesKeys,
      stockouts: keys(stockoutRows, "external_id"),
      opportunities: keys(proposalRows),
      campaign_replies: keys(replyRows),
      agent_updates: keys(taskRows),
      integration_errors: keys(integrationRows, "provider"),
    },
  };
}

function pickExecutiveFields(source: Record<string, unknown>, fields: string[]) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== "") result[field] = value;
  }
  return result;
}

function compactExecutiveSnapshot(payload: unknown, updatedAt: unknown) {
  const source = asObject(payload);
  return {
    available: Object.keys(source).length > 0,
    updated_at: updatedAt || null,
    ...pickExecutiveFields(source, [
      "period", "period_start", "period_end", "sales_total", "net_sales", "gross_sales",
      "purchases_total", "inventory_value", "receivables", "cash_balance", "currency", "generated_at",
    ]),
  };
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

type ProspectingActionResult = {
  body: Record<string, unknown>;
  status?: number;
};

async function handleProspectingIntegrationRoute(
  context: RouteContext,
  validation: ApiKeyValidation,
  routeParts: string[],
) {
  if (context.req.method !== "POST" || !validation.key_id) {
    return json({ error: "Prospecting integration route not found" }, 404);
  }
  const payload = await readJsonObject(context.req);

  if (routeParts.join("/") === "checks/claim") {
    return withProspectingIdempotency(context, validation, "integrations/checks/claim", payload, async () => {
      const workerId = requiredString(payload.worker_id, "worker_id", 120);
      const { data, error } = await context.supabase.rpc("claim_prospecting_integration_check", {
        p_api_key_id: validation.key_id,
        p_worker_id: workerId,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (routeParts.join("/") === "status") {
    return withProspectingIdempotency(context, validation, "integrations/status", payload, async () => {
      const workerId = requiredString(payload.worker_id, "worker_id", 120);
      const checkId = requiredString(payload.check_id, "check_id", 36);
      const provider = requiredString(payload.provider, "provider", 40);
      const status = requiredString(payload.status, "status", 40);
      const message = requiredString(payload.message, "message", 500);
      if (!isUuid(checkId)) throw new RequestValidationError("check_id must be a UUID");
      if (!["google_places", "brave_search"].includes(provider)) {
        throw new RequestValidationError("Unsupported integration provider");
      }
      if (!["not_configured", "pending", "connected", "quota_exhausted", "error"].includes(status)) {
        throw new RequestValidationError("Unsupported integration status");
      }
      const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : {};
      const { data, error } = await context.supabase.rpc("report_prospecting_integration_status", {
        p_api_key_id: validation.key_id,
        p_worker_id: workerId,
        p_check_id: checkId,
        p_provider: provider,
        p_configured: Boolean(payload.configured),
        p_status: status,
        p_message: message,
        p_error_code: typeof payload.error_code === "string" ? payload.error_code.slice(0, 80) : null,
        p_metadata: metadata,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  return json({ error: "Prospecting integration route not found" }, 404);
}

async function handleProspectingEnrichmentRoute(
  context: RouteContext,
  validation: ApiKeyValidation,
  routeParts: string[],
) {
  const { req } = context;
  const jobId = routeParts[0] ?? "";
  const action = routeParts[1] ?? "";

  if (req.method === "POST" && jobId === "claim" && routeParts.length === 1) {
    const payload = await readJsonObject(req);
    return withProspectingIdempotency(context, validation, "enrichment/claim", payload, async () => {
      const workerId = requiredString(payload.worker_id, "worker_id", 120);
      const leaseSeconds = boundedInteger(payload.lease_seconds, 60, 600, 300);
      const { data, error } = await context.supabase.rpc("claim_prospect_enrichment", {
        p_api_key_id: validation.key_id,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (!isUuid(jobId) || req.method !== "POST" || !["complete", "fail"].includes(action)) {
    return json({ error: "Prospecting enrichment route not found" }, 404);
  }
  const payload = await readJsonObject(req);
  return withProspectingIdempotency(
    context,
    validation,
    `enrichment/${jobId}/${action}`,
    payload,
    async () => {
      const lease = readLeasePayload(payload);
      if (action === "complete") {
        const candidate = asObject(payload.candidate);
        if (!candidate.name || !candidate.location) {
          throw new RequestValidationError("candidate must include name and location");
        }
        // El snapshot historico no repite la evidencia de Google: esta vive en
        // prospect_source_records. La investigacion solo adjunta evidencia
        // incremental del sitio oficial/Brave, que puede ser vacia cuando el
        // agente no encuentra una fuente autorizada.
        optionalString(candidate.name, "candidate.name", 300);
        optionalString(candidate.phone, "candidate.phone", 50);
        optionalString(candidate.email, "candidate.email", 320);
        optionalString(candidate.website, "candidate.website", 2048);
        optionalString(candidate.company_summary, "candidate.company_summary", 1200);
        if (candidate.evidence !== undefined && !Array.isArray(candidate.evidence)) {
          throw new RequestValidationError("candidate.evidence must be an array");
        }
        const summary = payload.summary && typeof payload.summary === "object" && !Array.isArray(payload.summary)
          ? payload.summary as Record<string, unknown>
          : {};
        const { data, error } = await context.supabase.rpc("complete_prospect_enrichment", {
          p_job_id: jobId,
          p_api_key_id: validation.key_id,
          p_worker_id: lease.workerId,
          p_lease_token: lease.leaseToken,
          p_candidate: candidate,
          p_summary: summary,
        });
        if (error) return rpcErrorResult(error);
        return { body: asObject(data) };
      }
      const errorMessage = requiredString(payload.error, "error", 4000);
      const { data, error } = await context.supabase.rpc("fail_prospect_enrichment", {
        p_job_id: jobId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_error: errorMessage,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    },
  );
}

async function handleProspectingRoute(
  context: RouteContext,
  validation: ApiKeyValidation,
  routeParts: string[],
) {
  const { req } = context;
  const runId = routeParts[0] ?? "";
  const action = routeParts[1] ?? "";

  if (req.method === "POST" && runId === "claim" && routeParts.length === 1) {
    const payload = await readJsonObject(req);
    return withProspectingIdempotency(context, validation, "claim", payload, async () => {
      const workerId = requiredString(payload.worker_id, "worker_id", 120);
      const leaseSeconds = boundedInteger(payload.lease_seconds, 30, 300, 120);
      const { data, error } = await context.supabase.rpc("claim_prospecting_run", {
        p_api_key_id: validation.key_id,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) return rpcErrorResult(error);
      const result = asObject(data);
      if (!result.run) return { body: { run: null } };

      const run = asObject(result.run);
      const snapshot = asObject(run.snapshot);
      const { data: braveSettings } = await context.supabase
        .from("prospecting_provider_settings")
        .select("monthly_limit_usd,free_credit_usd,social_search_enabled,max_social_queries_per_campaign")
        .eq("provider", "brave_search")
        .maybeSingle();
      snapshot.brave_policy = {
        monthly_limit_usd: Number(braveSettings?.monthly_limit_usd ?? 5),
        free_credit_usd: Number(braveSettings?.free_credit_usd ?? 5),
        social_search_enabled: Boolean(braveSettings?.social_search_enabled ?? false),
        max_social_queries_per_campaign: Number(braveSettings?.max_social_queries_per_campaign ?? 6),
      };
      const campaign = asObject(snapshot.campaign);
      const maxResults = boundedInteger(campaign.max_results_per_task, 1, 20, 20);
      const territories = Array.isArray(campaign.territories) ? campaign.territories.map(asObject) : [];
      const tasks = Array.isArray(result.tasks)
        ? result.tasks.map((item) => {
          const task = asObject(item);
          const territory = territories.find((candidate) => candidate.comuna_code === task.comuna_code) ?? {};
          return {
            ...task,
            region_name: territory.region_name ?? null,
            comuna_name: territory.comuna_name ?? null,
            max_results: maxResults,
          };
        })
        : [];

      return {
        body: {
          snapshot,
          lease_token: result.lease_token,
          lease_expires_at: run.lease_expires_at,
          candidates_found: run.candidates_found ?? 0,
          tasks,
        },
      };
    });
  }

  if (!isUuid(runId)) return json({ error: "Invalid prospecting run id" }, 400);

  if (req.method === "GET" && routeParts.length === 1) {
    return handleGetProspectingRun(context, runId);
  }

  const isSimpleAction = routeParts.length === 2 && ["heartbeat", "complete", "fail"].includes(action);
  const isBatchAction = routeParts.length === 3
    && routeParts[2] === "batch"
    && ["events", "candidates"].includes(action);
  if (req.method !== "POST" || (!isSimpleAction && !isBatchAction)) {
    return json({ error: "Prospecting route not found" }, 404);
  }

  const payload = await readJsonObject(req);
  const operation = [runId, ...routeParts.slice(1)].join("/");

  if (action === "heartbeat") {
    return withProspectingIdempotency(context, validation, operation, payload, async () => {
      const lease = readLeasePayload(payload);
      const leaseSeconds = boundedInteger(payload.lease_seconds, 30, 300, 120);
      const { data, error } = await context.supabase.rpc("heartbeat_prospecting_run", {
        p_run_id: runId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_lease_seconds: leaseSeconds,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (action === "events" && routeParts[2] === "batch") {
    return withProspectingIdempotency(context, validation, operation, payload, async () => {
      const lease = readLeasePayload(payload);
      const events = requireBatch(payload.events, "events");
      validateEventBatch(events);
      const { data, error } = await context.supabase.rpc("append_prospecting_events", {
        p_run_id: runId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_events: events,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (action === "candidates" && routeParts[2] === "batch") {
    return withProspectingIdempotency(context, validation, operation, payload, async () => {
      const lease = readLeasePayload(payload);
      const candidates = requireBatch(payload.candidates, "candidates");
      validateCandidateBatch(candidates);
      const { data, error } = await context.supabase.rpc("upsert_prospect_candidates", {
        p_run_id: runId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_candidates: candidates,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (action === "complete") {
    return withProspectingIdempotency(context, validation, operation, payload, async () => {
      const lease = readLeasePayload(payload);
      const status = requiredString(payload.status, "status", 20);
      const stats = payload.stats && typeof payload.stats === "object" && !Array.isArray(payload.stats)
        ? payload.stats as Record<string, unknown>
        : {};
      const { data, error } = await context.supabase.rpc("complete_prospecting_run", {
        p_run_id: runId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_status: status,
        p_stats: stats,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  if (action === "fail") {
    return withProspectingIdempotency(context, validation, operation, payload, async () => {
      const lease = readLeasePayload(payload);
      const errorMessage = requiredString(payload.error, "error", 4000);
      const { data, error } = await context.supabase.rpc("fail_prospecting_run", {
        p_run_id: runId,
        p_api_key_id: validation.key_id,
        p_worker_id: lease.workerId,
        p_lease_token: lease.leaseToken,
        p_error: errorMessage,
      });
      if (error) return rpcErrorResult(error);
      return { body: asObject(data) };
    });
  }

  return json({ error: "Prospecting route not found" }, 404);
}

async function handleGetProspectingRun(context: RouteContext, runId: string) {
  const { data: run, error: runError } = await context.supabase
    .from("prospecting_runs")
    .select("id,campaign_id,status,snapshot,claimed_by_worker,lease_expires_at,heartbeat_at,total_tasks,completed_tasks,failed_tasks,candidates_found,progress,last_error,cancel_requested_at,started_at,completed_at,created_at,updated_at")
    .eq("id", runId)
    .maybeSingle();
  if (runError) return json({ error: runError.message }, 400);
  if (!run) return json({ error: "Prospecting run not found" }, 404);

  const [{ data: tasks, error: tasksError }, { data: events, error: eventsError }] = await Promise.all([
    context.supabase.from("prospecting_tasks").select("*").eq("run_id", runId).order("created_at"),
    context.supabase.from("prospecting_events").select("*").eq("run_id", runId).order("created_at", { ascending: false }).limit(100),
  ]);
  if (tasksError) return json({ error: tasksError.message }, 400);
  if (eventsError) return json({ error: eventsError.message }, 400);
  return json({ run, tasks: tasks ?? [], events: events ?? [] });
}

function readLeasePayload(payload: Record<string, unknown>) {
  const workerId = requiredString(payload.worker_id, "worker_id", 120);
  const leaseToken = requiredString(payload.lease_token, "lease_token", 80);
  if (!isUuid(leaseToken)) throw new RequestValidationError("lease_token must be a UUID");
  return { workerId, leaseToken };
}

async function withProspectingIdempotency(
  context: RouteContext,
  validation: ApiKeyValidation,
  operation: string,
  payload: Record<string, unknown>,
  action: () => Promise<ProspectingActionResult>,
) {
  const idempotencyKey = context.req.headers.get("idempotency-key")?.trim() ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return json({ error: "Idempotency-Key header must contain between 8 and 200 characters" }, 400);
  }
  if (!validation.key_id) return unauthorized();

  // Lease and worker identity are transport credentials, not business
  // content. A durable outbox must be able to replay the same operation after
  // reclaiming a run with a new lease without turning the retry into a 409.
  const requestHash = await sha256Hex(JSON.stringify(idempotencyBusinessPayload(payload)));
  const { data: reservationData, error: reservationError } = await context.supabase.rpc(
    "prospecting_begin_idempotent_request",
    {
      p_api_key_id: validation.key_id,
      p_operation: operation,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
    },
  );
  if (reservationError) return json({ error: reservationError.message }, 500);

  const reservation = asObject(reservationData);
  if (reservation.outcome === "conflict") {
    return json({ error: "Idempotency-Key was already used with a different payload" }, 409);
  }
  if (reservation.outcome === "in_progress") {
    return json({ error: "An identical idempotent request is still processing", retryable: true }, 425);
  }
  if (reservation.outcome === "replay") {
    return json(
      reservation.response_body ?? {},
      boundedInteger(reservation.response_status, 100, 599, 200),
    );
  }

  let result: ProspectingActionResult;
  try {
    result = await action();
  } catch (error) {
    await releaseProspectingIdempotency(context, validation.key_id, operation, idempotencyKey, requestHash);
    throw error;
  }

  const status = result.status ?? 200;
  // Un rechazo de lease no ejecuta la operacion y debe poder reintentarse con
  // el mismo mensaje durable tras un nuevo claim. No se memoriza como replay.
  if (status >= 500 || status === 403) {
    await releaseProspectingIdempotency(context, validation.key_id, operation, idempotencyKey, requestHash);
  } else {
    const { error: finishError } = await context.supabase.rpc("prospecting_finish_idempotent_request", {
      p_api_key_id: validation.key_id,
      p_operation: operation,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
      p_response_status: status,
      p_response_body: result.body,
    });
    if (finishError) return json({ error: finishError.message }, 500);
  }
  return json(result.body, status);
}

async function releaseProspectingIdempotency(
  context: RouteContext,
  apiKeyId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
) {
  await context.supabase.rpc("prospecting_release_idempotent_request", {
    p_api_key_id: apiKeyId,
    p_operation: operation,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
  });
}

function rpcErrorResult(error: { code?: string; message: string }): ProspectingActionResult {
  const status = error.code === "42501"
    ? 403
    : error.code === "P0002"
    ? 404
    : ["22023", "22P02"].includes(error.code ?? "")
    ? 400
    : ["54000", "55000", "23505"].includes(error.code ?? "")
    ? 409
    : 500;
  return { body: { error: error.message, code: error.code ?? null }, status };
}

function requiredString(value: unknown, name: string, maxLength: number) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maxLength) {
    throw new RequestValidationError(`${name} is required and must not exceed ${maxLength} characters`);
  }
  return result;
}

function requireBatch(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new RequestValidationError(`${name} must contain between 1 and 100 items`);
  }
  return value;
}

class RequestValidationError extends Error {}
class PayloadTooLargeError extends Error {}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function idempotencyBusinessPayload(payload: Record<string, unknown>) {
  const businessPayload = { ...payload };
  if ("lease_token" in businessPayload) {
    delete businessPayload.worker_id;
    delete businessPayload.lease_token;
  }
  return businessPayload;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new PayloadTooLargeError(`JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) {
    throw new PayloadTooLargeError(`JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestValidationError("JSON body must contain valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestValidationError("JSON body must be an object");
  }
  return payload as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new RequestValidationError(`${field} must be a string of at most ${maxLength} characters`);
  }
}

function validateCandidateBatch(candidates: unknown[]) {
  candidates.forEach((value, candidateIndex) => {
    const candidate = asObject(value);
    if (Object.keys(candidate).length === 0) {
      throw new RequestValidationError(`candidates[${candidateIndex}] must be an object`);
    }
    optionalString(candidate.candidate_id, `candidates[${candidateIndex}].candidate_id`, 200);
    optionalString(candidate.name, `candidates[${candidateIndex}].name`, 300);
    optionalString(candidate.trade_name, `candidates[${candidateIndex}].trade_name`, 300);
    optionalString(candidate.rut, `candidates[${candidateIndex}].rut`, 32);
    optionalString(candidate.phone, `candidates[${candidateIndex}].phone`, 50);
    optionalString(candidate.whatsapp_number, `candidates[${candidateIndex}].whatsapp_number`, 50);
    optionalString(candidate.email, `candidates[${candidateIndex}].email`, 320);
    optionalString(candidate.website, `candidates[${candidateIndex}].website`, 2048);
    optionalString(candidate.category, `candidates[${candidateIndex}].category`, 120);
    optionalString(candidate.description, `candidates[${candidateIndex}].description`, 4000);

    const providerIds = candidate.provider_ids === undefined ? {} : asObject(candidate.provider_ids);
    if (Object.keys(providerIds).length > 10) {
      throw new RequestValidationError(`candidates[${candidateIndex}].provider_ids exceeds 10 items`);
    }
    Object.entries(providerIds).forEach(([provider, id]) => {
      optionalString(provider, `candidates[${candidateIndex}].provider`, 40);
      optionalString(id, `candidates[${candidateIndex}].provider_id`, 2048);
    });

    const locations = Array.isArray(candidate.locations)
      ? candidate.locations
      : candidate.location && typeof candidate.location === "object"
      ? [candidate.location]
      : [];
    if (locations.length < 1 || locations.length > 50) {
      throw new RequestValidationError(`candidates[${candidateIndex}] must contain 1..50 locations`);
    }
    locations.forEach((locationValue, locationIndex) => {
      const location = asObject(locationValue);
      if (Object.keys(location).length === 0) {
        throw new RequestValidationError(`candidates[${candidateIndex}].locations[${locationIndex}] must be an object`);
      }
      optionalString(location.region_code, `locations[${locationIndex}].region_code`, 10);
      optionalString(location.region_name, `locations[${locationIndex}].region_name`, 120);
      optionalString(location.comuna_code, `locations[${locationIndex}].comuna_code`, 10);
      optionalString(location.comuna_name, `locations[${locationIndex}].comuna_name`, 120);
      optionalString(location.address, `locations[${locationIndex}].address`, 500);
      optionalString(location.phone, `locations[${locationIndex}].phone`, 50);
      optionalString(location.email, `locations[${locationIndex}].email`, 320);
    });

    if (!Array.isArray(candidate.evidence)
      || candidate.evidence.length < 1
      || candidate.evidence.length > MAX_EVIDENCE_PER_CANDIDATE) {
      throw new RequestValidationError(
        `candidates[${candidateIndex}].evidence must contain 1..${MAX_EVIDENCE_PER_CANDIDATE} items`,
      );
    }
    candidate.evidence.forEach((evidenceValue: unknown, evidenceIndex: number) => {
      const evidence = asObject(evidenceValue);
      if (Object.keys(evidence).length === 0) {
        throw new RequestValidationError(`evidence[${evidenceIndex}] must be an object`);
      }
      optionalString(evidence.provider, `evidence[${evidenceIndex}].provider`, 40);
      optionalString(evidence.source_url, `evidence[${evidenceIndex}].source_url`, 2048);
      optionalString(evidence.provider_record_id, `evidence[${evidenceIndex}].provider_record_id`, 2048);
      optionalString(evidence.field, `evidence[${evidenceIndex}].field`, 80);
      optionalString(evidence.value, `evidence[${evidenceIndex}].value`, 4000);
      optionalString(evidence.observed_at, `evidence[${evidenceIndex}].observed_at`, 64);
    });
  });
}

function validateEventBatch(events: unknown[]) {
  events.forEach((value, index) => {
    const event = asObject(value);
    if (Object.keys(event).length === 0) {
      throw new RequestValidationError(`events[${index}] must be an object`);
    }
    optionalString(event.event_id, `events[${index}].event_id`, 200);
    optionalString(event.task_id, `events[${index}].task_id`, 36);
    optionalString(event.stage, `events[${index}].stage`, 80);
    optionalString(event.message, `events[${index}].message`, 4000);
    optionalString(event.keyword, `events[${index}].keyword`, 200);
    if (event.metrics !== undefined && JSON.stringify(event.metrics).length > 20_000) {
      throw new RequestValidationError(`events[${index}].metrics exceeds 20000 characters`);
    }
  });
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
  let contactName = "";
  let messageType = "text";
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
    contactName = parsed.contactName;
    messageType = parsed.messageType || "text";
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

  const normalizedSender = normalizeWhatsAppPhone(sender);
  const cleanSender = normalizedSender.replace(/\D/g, "");

  const { data: companies, error: compError } = await context.supabase
    .from("companies")
    .select("id, name, whatsapp, whatsapp_number, phone");

  if (compError) return json({ error: compError.message }, 500);

  let matchedCompanyId = "";

  for (const c of companies || []) {
    const cWhatsapp = (c.whatsapp || "").replace(/\D/g, "");
    const cWhatsappNumber = (c.whatsapp_number || "").replace(/\D/g, "");
    const cPhone = (c.phone || "").replace(/\D/g, "");
    if (
      (cWhatsapp && cleanSender.endsWith(cWhatsapp)) || 
      (cWhatsappNumber && cleanSender.endsWith(cWhatsappNumber)) ||
      (cPhone && cleanSender.endsWith(cPhone)) || 
      (cWhatsapp && cWhatsapp.endsWith(cleanSender)) || 
      (cWhatsappNumber && cWhatsappNumber.endsWith(cleanSender)) ||
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
        whatsapp: normalizedSender || sender,
        whatsapp_number: normalizedSender || null,
        phone: normalizedSender || sender,
        status: "prospecto",
        source: "whatsapp_webhook",
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
      description: contactName ? `${contactName}: ${message}` : message,
      result: "Mensaje entrante del cliente",
      next_action: "Responder mensaje"
    })
    .select("*")
    .single();

  if (intError) return json({ error: intError.message }, 500);

  const { data: lastOutbound } = await context.supabase
    .from("whatsapp_messages")
    .select("id, whatsapp_campaign_id, recipient_id")
    .eq("company_id", matchedCompanyId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let alreadyStoredMessage = false;
  if (metaMessageId) {
    const { data: existingMessage } = await context.supabase
      .from("whatsapp_messages")
      .select("id")
      .eq("meta_message_id", metaMessageId)
      .maybeSingle();
    alreadyStoredMessage = Boolean(existingMessage?.id);
  }

  if (!alreadyStoredMessage) {
    await context.supabase.from("whatsapp_messages").insert({
      company_id: matchedCompanyId,
      whatsapp_campaign_id: lastOutbound?.whatsapp_campaign_id ?? null,
      recipient_id: lastOutbound?.recipient_id ?? null,
      direction: "inbound",
      phone_number: normalizedSender || sender,
      meta_message_id: metaMessageId || null,
      message_type: messageType,
      body: message,
      status: "received",
      raw_payload: rawPayload,
    });
  }

  if (lastOutbound?.recipient_id) {
    await context.supabase
      .from("whatsapp_campaign_recipients")
      .update({ replied_at: new Date().toISOString(), status: "replied" })
      .eq("id", lastOutbound.recipient_id);
  }

  const contactPhone = normalizedSender || sender;
  const { data: existingContact } = await context.supabase
    .from("contacts")
    .select("id")
    .eq("company_id", matchedCompanyId)
    .eq("whatsapp", contactPhone)
    .maybeSingle();

  if (existingContact?.id) {
    await context.supabase
      .from("contacts")
      .update({ phone: contactPhone, notes: "Detectado por respuesta entrante de WhatsApp Meta." })
      .eq("id", existingContact.id);
  } else {
    await context.supabase.from("contacts").insert({
      company_id: matchedCompanyId,
      full_name: contactName || "Contacto WhatsApp",
      phone: contactPhone,
      whatsapp: contactPhone,
      is_primary: false,
      notes: "Detectado por respuesta entrante de WhatsApp Meta.",
    });
  }

  if (metaMessageId) {
    await context.supabase
      .from("whatsapp_webhook_events")
      .update({ processed: true, company_id: matchedCompanyId })
      .eq("meta_message_id", metaMessageId);
  }

  await context.supabase
    .from("companies")
    .update({
      last_whatsapp_message_at: new Date().toISOString(),
      whatsapp: normalizedSender || sender,
      whatsapp_number: normalizedSender || null,
    })
    .eq("id", matchedCompanyId);

  await logAgentAction(context.supabase, validation, "interactions", interaction.id, "webhook_received_whatsapp", {
    sender: normalizedSender || sender,
    metaMessageId,
  });

  return json({ success: true, company_id: matchedCompanyId, interaction_id: interaction.id });
}

async function validateMetaWebhookRequest(
  req: Request,
  url: URL,
  supabase: ReturnType<typeof createClient>,
): Promise<ApiKeyValidation> {
  const appSecret = stripOptionalQuotes(Deno.env.get("META_WHATSAPP_APP_SECRET"));
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const rawBody = await req.text();

  if (appSecret) {
    const expected = await createMetaSignature(rawBody, appSecret);
    if (signature === expected) {
      return { valid: true, key_id: null, key_name: "meta-webhook", scopes: ["crm:write"] };
    }

    if (signature) {
      return { valid: false, key_id: null, key_name: null, scopes: null, error: "Invalid WhatsApp webhook signature" };
    }
  }

  const fallbackValidation = await validateMetaWebhookPayloadFallback(rawBody, supabase);
  if (fallbackValidation.valid) return fallbackValidation;

  if (!appSecret) {
    return { valid: false, key_id: null, key_name: null, scopes: null, error: "Missing META_WHATSAPP_APP_SECRET in Edge Function" };
  }

  return {
    valid: false,
    key_id: null,
    key_name: null,
    scopes: null,
    error: "Missing WhatsApp webhook signature",
  };
}

async function validateMetaWebhookPayloadFallback(
  rawBody: string,
  supabase: ReturnType<typeof createClient>,
): Promise<ApiKeyValidation> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { valid: false, key_id: null, key_name: null, scopes: null, error: "Invalid WhatsApp webhook JSON" };
  }

  if (payload.object !== "whatsapp_business_account") {
    return { valid: false, key_id: null, key_name: null, scopes: null, error: "Webhook payload is not WhatsApp Business Account" };
  }

  const entry = Array.isArray(payload.entry) ? payload.entry[0] as Record<string, unknown> : undefined;
  const changes = Array.isArray(entry?.changes) ? entry?.changes[0] as Record<string, unknown> : undefined;
  const value = changes?.value as Record<string, unknown> | undefined;
  const metadata = value?.metadata as Record<string, unknown> | undefined;
  const phoneNumberId = String(metadata?.phone_number_id ?? "");
  const businessAccountId = String(entry?.id ?? "");
  const expectedPhoneNumberId = stripOptionalQuotes(Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID"));

  if (expectedPhoneNumberId && phoneNumberId !== expectedPhoneNumberId) {
    return { valid: false, key_id: null, key_name: null, scopes: null, error: "WhatsApp Phone Number ID does not match Edge Function env" };
  }

  const { data: settings } = await supabase
    .from("whatsapp_settings")
    .select("phone_number_id,business_account_id,active")
    .eq("active", true)
    .limit(10);

  const matchesSettings = (settings ?? []).some((row) => {
    const configuredPhoneId = String(row.phone_number_id ?? "");
    const configuredBusinessId = String(row.business_account_id ?? "");
    return configuredPhoneId === phoneNumberId && (!configuredBusinessId || configuredBusinessId === businessAccountId);
  });

  if (!matchesSettings && !expectedPhoneNumberId) {
    return { valid: false, key_id: null, key_name: null, scopes: null, error: "WhatsApp webhook payload does not match active CRM settings" };
  }

  return { valid: true, key_id: null, key_name: "meta-webhook-fallback", scopes: ["crm:write"] };
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
  const contacts = Array.isArray(value?.contacts) ? value?.contacts : [];
  const message = messages[0] as Record<string, unknown> | undefined;
  const status = statuses[0] as Record<string, unknown> | undefined;
  const text = message?.text as Record<string, unknown> | undefined;
  const image = message?.image as Record<string, unknown> | undefined;
  const document = message?.document as Record<string, unknown> | undefined;
  const audio = message?.audio as Record<string, unknown> | undefined;
  const video = message?.video as Record<string, unknown> | undefined;
  const button = message?.button as Record<string, unknown> | undefined;
  const interactive = message?.interactive as Record<string, unknown> | undefined;
  const firstContact = contacts[0] as Record<string, unknown> | undefined;
  const profile = firstContact?.profile as Record<string, unknown> | undefined;
  const type = String(message?.type ?? "text");

  let body = String(text?.body ?? "");
  if (!body && button) body = String(button.text ?? button.payload ?? "");
  if (!body && interactive) body = JSON.stringify(interactive);
  if (!body && image) body = String(image.caption ?? "[imagen recibida]");
  if (!body && document) body = String(document.filename ?? document.caption ?? "[documento recibido]");
  if (!body && audio) body = "[audio recibido]";
  if (!body && video) body = String(video.caption ?? "[video recibido]");
  if (!body) body = `[mensaje ${type} recibido]`;

  if (message) {
    return {
      eventType: "message",
      sender: String(message.from ?? ""),
      message: body,
      metaMessageId: String(message.id ?? ""),
      contactName: String(profile?.name ?? ""),
      messageType: type,
    };
  }

  if (status) {
    return {
      eventType: "status",
      sender: String(status.recipient_id ?? ""),
      message: String(status.status ?? ""),
      metaMessageId: String(status.id ?? ""),
      contactName: "",
      messageType: "status",
    };
  }

  return { eventType: "unknown", sender: "", message: "", metaMessageId: "", contactName: "", messageType: "unknown" };
}

function normalizeWhatsAppPhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("569") && digits.length === 11) return `+${digits}`;
  if (digits.startsWith("9") && digits.length === 9) return `+56${digits}`;
  if (digits.startsWith("56") && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
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
  const expectedToken = firstEnvValue([
    "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "META_WHATSAPP_VERIFY_TOKEN",
    "WEBHOOK_VERIFY_TOKEN",
  ]) || "climactiva_meta_whatsapp_2026_seguro";

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

function firstEnvValue(names: string[]) {
  for (const name of names) {
    const value = stripOptionalQuotes(Deno.env.get(name));
    if (value) return value;
  }
  return "";
}

function stripOptionalQuotes(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
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
    const whatsappStatus = String(company?.whatsapp_status || (hasOptIn ? "opt_in" : "sin_consentimiento"));

    if (["opt_out", "bloqueado", "invalido", "no_contactar"].includes(whatsappStatus)) {
      results.push({ phone: recipient.phone, success: false, error: `Company WhatsApp status blocks sending: ${whatsappStatus}` });
      continue;
    }

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

async function handleTiendanubePrivacyWebhook(context: RouteContext, routePath: string[]) {
  const topic = routePath[0] || "";
  const allowedTopics = new Set(["store-redact", "customers-redact", "customers-data-request"]);

  if (!allowedTopics.has(topic)) {
    return json({ error: "Tiendanube privacy webhook route not found" }, 404);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await readJsonObject(context.req);
  } catch {
    payload = {};
  }

  await context.supabase.from("activity_logs").insert({
    entity_type: "integration",
    entity_id: null,
    action: `tiendanube_privacy_${topic.replaceAll("-", "_")}`,
    metadata: {
      provider: "tiendanube",
      topic,
      store_id: payload.store_id ?? payload.id ?? null,
      received_at: new Date().toISOString(),
    },
  });

  return json({
    ok: true,
    provider: "tiendanube",
    topic,
    message: "Privacy webhook received",
  });
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
