import { decryptApiKey, encryptApiKey, IntegrationError, limitedJson, validateApiKey, verifyDeepSeekKey } from "./deepseek.ts";

type Row = Record<string, unknown>;
type Config = { supabaseUrl: string; serviceRoleKey: string; encryptionSecret: string; appOrigin: string };
const table = "prospecting_ai_integrations";

export function createProspectingIntegrationHandler(config: Config, send: typeof fetch = fetch) {
  const ready = new TextEncoder().encode(config.encryptionSecret).length >= 32;
  async function db(path: string, method = "GET", body?: Row) {
    const response = await send(`${config.supabaseUrl}/rest/v1/${path}`, {
      method, headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new IntegrationError(503, "STORAGE_UNAVAILABLE", "La configuración de integraciones no está disponible. Revisa su instalación en el servidor.");
    return method === "GET" ? response.json() : null;
  }
  async function requireAdmin(request: Request) {
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer \S+$/i.test(authorization)) throw new IntegrationError(401, "UNAUTHORIZED", "Inicia sesión nuevamente.");
    const response = await send(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.serviceRoleKey, Authorization: authorization }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new IntegrationError(401, "UNAUTHORIZED", "Tu sesión expiró.");
    const user = await response.json();
    if (!/^[a-f0-9-]{36}$/i.test(user.id || "")) throw new IntegrationError(401, "UNAUTHORIZED", "Sesión no válida.");
    const profiles = await db(`profiles?select=id,role,active&id=eq.${user.id}&limit=1`);
    if (!profiles[0]?.active || profiles[0]?.role !== "administrador") throw new IntegrationError(403, "FORBIDDEN", "Solo un administrador puede configurar DeepSeek.");
    return user.id as string;
  }
  const publicStatus = (row: Row | undefined) => ({
    provider: "deepseek", configured: Boolean(row?.api_key_encrypted), ready,
    status: row?.status || "disconnected", models: Array.isArray(row?.models) ? row.models : [],
    lastCheckedAt: row?.last_checked_at || null, lastErrorCode: row?.last_error_code || null,
    scope: "credentials_only",
  });
  return async (request: Request) => {
    const headers = { "Access-Control-Allow-Origin": config.appOrigin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin",
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (request.headers.get("origin") && request.headers.get("origin") !== config.appOrigin) {
        throw new IntegrationError(403, "ORIGIN_REJECTED", "Origen no autorizado.");
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const userId = await requireAdmin(request);
      const route = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
      const readCurrent = async () => (await db(`${table}?select=*&provider=eq.deepseek&limit=1`))[0] as Row | undefined;
      if (route === "status" && request.method === "GET") return json(publicStatus(await readCurrent()));
      if (!["save", "verify", "disconnect"].includes(route || "") || request.method !== "POST") {
        throw new IntegrationError(404, "NOT_FOUND", "Operación no disponible.");
      }
      if (route === "disconnect") {
        const row = { provider: "deepseek", api_key_encrypted: null, status: "disconnected", models: [], last_checked_at: null,
          last_error_code: null, updated_by: userId, updated_at: new Date().toISOString() };
        await db(`${table}?on_conflict=provider`, "POST", row);
        return json(publicStatus(row));
      }
      if (!ready) throw new IntegrationError(503, "SETUP_REQUIRED", "Falta habilitar el almacenamiento seguro en el servidor.");
      let key: string;
      const current = await readCurrent();
      if (route === "save") {
        const input = await limitedJson(request);
        key = validateApiKey(input?.apiKey);
      } else {
        if (!current?.api_key_encrypted) throw new IntegrationError(409, "NOT_CONFIGURED", "Primero agrega tu clave API.");
        key = await decryptApiKey(String(current.api_key_encrypted), config.encryptionSecret);
      }
      let models: string[];
      try {
        models = await verifyDeepSeekKey(key, send);
      } catch (error) {
        if (route === "verify" && error instanceof IntegrationError) {
          await db(`${table}?provider=eq.deepseek&updated_at=eq.${encodeURIComponent(String(current?.updated_at))}`, "PATCH", {
            status: "error", last_error_code: error.code, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
        throw error;
      }
      const row = { provider: "deepseek", api_key_encrypted: route === "save" ? await encryptApiKey(key, config.encryptionSecret) : current?.api_key_encrypted,
        status: "verified", models, last_checked_at: new Date().toISOString(), last_error_code: null,
        updated_by: userId, updated_at: new Date().toISOString() };
      if (route === "verify") {
        // Do not restore an old key if another administrator disconnected/replaced it during verification.
        await db(`${table}?provider=eq.deepseek&updated_at=eq.${encodeURIComponent(String(current?.updated_at))}`, "PATCH", {
          status: row.status, models, last_checked_at: row.last_checked_at, last_error_code: null,
          updated_at: row.updated_at,
        });
        return json(publicStatus(await readCurrent()));
      }
      await db(`${table}?on_conflict=provider`, "POST", row);
      return json(publicStatus(row));
    } catch (error) {
      if (error instanceof IntegrationError) return json({ error: error.message, code: error.code }, error.status);
      // Never include provider bodies, authorization headers, ciphertext or exception details.
      return json({ error: "No se pudo completar la operación. Intenta nuevamente.", code: "INTEGRATION_ERROR" }, 503);
    }
  };
}
