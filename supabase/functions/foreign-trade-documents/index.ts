import { prepareExtraction, type JsonRecord } from "./extraction-logic.ts";

type RestClient = { url: string; anonKey: string; serviceRoleKey: string };
type Profile = { id: string; role: string; active: boolean };

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const requestId = req.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const rest = getRestClient();
    const route = getRoute(req.url);
    if (route === "health") return json({ ok: true, service: "foreign-trade-documents", requestId }, 200, req);

    const user = await authenticateRequest(req, rest);
    const profile = await getProfile(rest, user.id);
    if (!profile?.active) throw new HttpError(403, "Tu usuario no está activo en el CRM.");
    if (profile.role !== "administrador") throw new HttpError(403, "Solo administración puede procesar documentos privados.");

    if (route === "extract" && req.method === "POST") {
      const payload = await readJson(req);
      const documentId = requiredUuid(payload.document_id, "documento");
      return json(await extractDocument(rest, documentId, requestId), 200, req);
    }
    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Error inesperado.";
    console.error("[foreign-trade-documents] request failed", { requestId, status, message });
    return json({ error: message, requestId }, status, req);
  }
});

async function extractDocument(rest: RestClient, documentId: string, requestId: string) {
  const documents = await selectRows(rest,
    `foreign_trade_documents?select=id,operation_id,storage_bucket,storage_path,original_file_name,mime_type,file_size,parse_status&id=eq.${documentId}&limit=1`,
  );
  const document = documents[0];
  if (!document) throw new HttpError(404, "El documento no existe.");
  if (document.parse_status === "confirmed") throw new HttpError(409, "El documento ya fue confirmado.");
  const mimeType = String(document.mime_type || "").toLowerCase();
  const fileSize = Number(document.file_size || 0);
  if (!allowedMimeTypes.has(mimeType) || fileSize <= 0 || fileSize > 25 * 1024 * 1024) {
    throw new HttpError(400, "El archivo no cumple el formato o tamaño permitido.");
  }

  await setExtraction(rest, documentId, "extracting", {}, null, [], null, null, requestId);
  try {
    const bytes = await downloadPrivateFile(rest, String(document.storage_bucket), String(document.storage_path));
    if (bytes.byteLength !== fileSize) console.warn("[foreign-trade-documents] file size differs", { requestId, documentId });
    const openAiResult = await callOpenAiExtraction(
      bytes,
      String(document.original_file_name),
      mimeType,
      requestId,
    );
    const prepared = prepareExtraction(openAiResult.data);
    await setExtraction(
      rest,
      documentId,
      "review_required",
      prepared.extraction,
      prepared.confidence,
      prepared.warnings,
      null,
      openAiResult.model,
      openAiResult.requestId || requestId,
    );
    console.info("[foreign-trade-documents] extraction ready", {
      requestId,
      documentId,
      lines: prepared.extraction.lines.length,
      warnings: prepared.warnings.length,
    });
    return { documentId, status: "review_required", ...prepared, model: openAiResult.model, requestId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo analizar el documento.";
    await setExtraction(rest, documentId, "failed", {}, null, [], message, null, requestId).catch(() => undefined);
    throw error;
  }
}

async function callOpenAiExtraction(bytes: Uint8Array, filename: string, mimeType: string, requestId: string) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  const maxTokens = clampNumber(Deno.env.get("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS"), 2_000, 20_000, 12_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  console.info("[foreign-trade-documents] OpenAI extraction started", {
    requestId,
    filename,
    fileSize: bytes.byteLength,
    timeoutMs,
    model,
  });
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": requestId,
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: maxTokens,
        input: [{
          role: "user",
          content: [
            {
              type: "input_file",
              filename,
              file_data: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
              ...(mimeType === "application/pdf" ? { detail: "high" } : {}),
            },
            {
              type: "input_text",
              text: extractionPrompt,
            },
          ],
        }],
        text: { format: { type: "json_schema", name: "foreign_trade_proforma", strict: true, schema: extractionSchema } },
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) {
      const apiError = asObject(payload.error);
      throw new HttpError(response.status, String(apiError.message || "OpenAI rechazó la extracción."));
    }
    const outputText = extractOutputText(payload);
    if (!outputText) throw new HttpError(502, "OpenAI no devolvió una extracción estructurada.");
    return {
      model,
      requestId: response.headers.get("x-request-id") || String(payload.id || ""),
      data: JSON.parse(outputText) as JsonRecord,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError(504, `La extracción excedió ${Math.round(timeoutMs / 1000)} segundos. El original quedó guardado y puedes reintentar sin subirlo nuevamente.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const extractionPrompt = `Analiza esta proforma u otro documento de comercio exterior.
Extrae exclusivamente datos visibles en el archivo. Nunca inventes SKU, precios, cantidades,
pesos, dimensiones, CBM, HS Code, fechas, condiciones ni puertos. Usa null cuando falte un dato.
Los importes deben conservar la moneda del documento. Convierte fechas a YYYY-MM-DD solo cuando
sean inequívocas. Cada fila comercial debe ser una línea separada. Si una cifra es dudosa, bájale
la confianza y agrega una advertencia breve. No calcules impuestos ni costo puesto en Chile.`;

const nullableString = { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };
const warningsSchema = { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } };
const extractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["general", "lines", "document_totals", "warnings"],
  properties: {
    general: {
      type: "object",
      additionalProperties: false,
      required: ["supplier_name", "proforma_number", "document_date", "valid_until", "currency", "incoterm", "origin_port", "destination_port", "payment_terms", "production_days", "order_number", "observations", "confidence", "warnings"],
      properties: {
        supplier_name: nullableString, proforma_number: nullableString, document_date: nullableString,
        valid_until: nullableString, currency: nullableString, incoterm: nullableString,
        origin_port: nullableString, destination_port: nullableString, payment_terms: nullableString,
        production_days: nullableInteger, order_number: nullableString, observations: nullableString,
        confidence: nullableNumber, warnings: warningsSchema,
      },
    },
    lines: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_index", "supplier_sku", "sku", "product_name", "description", "model", "quantity", "quantity_per_box", "box_count", "currency", "unit_price", "total_price", "exw_total", "fob_total", "cif_total", "discount_total", "supplier_charges_total", "unit_weight_kg", "gross_weight_kg", "net_weight_kg", "box_length_cm", "box_width_cm", "box_height_cm", "cbm_per_box", "cbm_total", "country_of_origin", "hs_code", "confidence", "warnings"],
        properties: {
          source_index: { type: "integer" }, supplier_sku: nullableString, sku: nullableString,
          product_name: nullableString, description: nullableString, model: nullableString,
          quantity: nullableNumber, quantity_per_box: nullableNumber, box_count: nullableNumber,
          currency: nullableString, unit_price: nullableNumber, total_price: nullableNumber,
          exw_total: nullableNumber, fob_total: nullableNumber, cif_total: nullableNumber,
          discount_total: nullableNumber, supplier_charges_total: nullableNumber,
          unit_weight_kg: nullableNumber, gross_weight_kg: nullableNumber, net_weight_kg: nullableNumber,
          box_length_cm: nullableNumber, box_width_cm: nullableNumber, box_height_cm: nullableNumber,
          cbm_per_box: nullableNumber, cbm_total: nullableNumber, country_of_origin: nullableString,
          hs_code: nullableString, confidence: nullableNumber, warnings: warningsSchema,
        },
      },
    },
    document_totals: {
      type: "object",
      additionalProperties: false,
      required: ["subtotal", "total", "cbm_total", "gross_weight_kg", "net_weight_kg", "boxes"],
      properties: {
        subtotal: nullableNumber, total: nullableNumber, cbm_total: nullableNumber,
        gross_weight_kg: nullableNumber, net_weight_kg: nullableNumber, boxes: nullableNumber,
      },
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};

async function setExtraction(rest: RestClient, documentId: string, status: string, payload: JsonRecord, confidence: number | null, warnings: unknown[], error: string | null, model: string | null, requestId: string) {
  await rpc(rest, "set_foreign_trade_document_extraction", {
    p_document_id: documentId,
    p_status: status,
    p_payload: payload,
    p_confidence: confidence,
    p_warnings: warnings,
    p_error: error,
    p_model: model,
    p_request_id: requestId,
  });
}

async function downloadPrivateFile(rest: RestClient, bucket: string, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${rest.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, {
    headers: serviceHeaders(rest),
  });
  if (!response.ok) throw new HttpError(response.status, "No se pudo leer el archivo privado desde Storage.");
  return new Uint8Array(await response.arrayBuffer());
}

async function authenticateRequest(req: Request, rest: RestClient) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Debes iniciar sesión.");
  const response = await fetch(`${rest.url}/auth/v1/user`, { headers: { apikey: rest.anonKey, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(401, "Sesión inválida o expirada.");
  const user = await response.json() as JsonRecord;
  const id = String(user.id || "");
  if (!id) throw new HttpError(401, "Sesión sin usuario válido.");
  return { id };
}

async function getProfile(rest: RestClient, userId: string): Promise<Profile | null> {
  const rows = await selectRows(rest, `profiles?select=id,role,active&id=eq.${userId}&limit=1`);
  const row = rows[0];
  return row ? { id: String(row.id), role: String(row.role), active: row.active !== false } : null;
}

async function selectRows(rest: RestClient, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, { headers: serviceHeaders(rest) });
  if (!response.ok) throw new HttpError(response.status, `No se pudieron leer los datos privados: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as JsonRecord[];
}

async function rpc(rest: RestClient, fn: string, body: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = data && typeof data === "object" ? String((data as JsonRecord).message || "") : "";
    throw new HttpError(response.status, details || `No se pudo ejecutar ${fn}.`);
  }
  return data;
}

function getRestClient(): RestClient {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!url || !anonKey || !serviceRoleKey) throw new HttpError(500, "Faltan variables internas de Supabase.");
  return { url, anonKey, serviceRoleKey };
}

function serviceHeaders(rest: RestClient) {
  return { apikey: rest.serviceRoleKey, Authorization: `Bearer ${rest.serviceRoleKey}` };
}

function getRoute(url: string) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("foreign-trade-documents");
  return index >= 0 ? parts.slice(index + 1).join("/") : parts.at(-1) || "";
}

function corsHeaders(req: Request) {
  const appOrigin = Deno.env.get("CRM_APP_URL")?.trim() || "http://localhost:5173";
  const configuredOrigin = new URL(appOrigin).origin;
  const origin = req.headers.get("origin") || "";
  const localOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": origin === configuredOrigin || localOrigin ? origin : configuredOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(data: unknown, status: number, req: Request) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(req: Request): Promise<JsonRecord> {
  const size = Number(req.headers.get("content-length") || 0);
  if (size > 100_000) throw new HttpError(413, "Solicitud demasiado grande.");
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "El cuerpo debe ser JSON.");
  return body as JsonRecord;
}

function requiredUuid(value: unknown, label: string) {
  const result = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new HttpError(400, `Identificador de ${label} inválido.`);
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function extractOutputText(payload: JsonRecord) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    const content = Array.isArray(asObject(item).content) ? asObject(item).content as unknown[] : [];
    for (const part of content) {
      const block = asObject(part);
      if (block.type === "output_text" && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
