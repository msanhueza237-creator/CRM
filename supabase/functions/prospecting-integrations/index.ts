import { createProspectingIntegrationHandler } from "./handler.ts";

Deno.serve(createProspectingIntegrationHandler({
  supabaseUrl: (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, ""),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  encryptionSecret: Deno.env.get("PROSPECTING_SECRET_ENCRYPTION_KEY") || "",
  appOrigin: new URL(Deno.env.get("CRM_APP_URL") || "https://crm.latinchile.cl").origin,
}));
