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
