import {
  CopilotDataError,
  object,
  rows,
  type CopilotActor,
  type RestConfig,
  type Row,
} from "./contracts.ts";
import { CopilotSources } from "./sources.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { centralPromptVersion, runOrchestrator } from "./orchestrator.ts";

const uuid = (value: unknown) =>
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
    String(value),
  );
const errorText = (error: unknown) =>
  error instanceof CopilotDataError
    ? error.message
    : "No se pudo completar la consulta. Los datos del CRM no se modificaron. Revisa el identificador de seguimiento.";

export async function centralHandler(
  req: Request,
  config: RestConfig,
  actor: CopilotActor,
  traceId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const url = new URL(req.url),
    route = url.pathname.split("/").at(-1),
    source = new CopilotSources(config, actor, req.signal);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  async function conversation(id: string) {
    if (!uuid(id)) throw new CopilotDataError("Conversacion invalida.");
    const result = await source.select(
      `copilot_conversations?select=id,title,metadata&user_id=eq.${actor.id}&id=eq.${id}&limit=1`,
    );
    if (
      !result.length ||
      object(result[0].metadata).role !== actor.role ||
      object(result[0].metadata).engine !== "central"
    )
      throw new CopilotDataError(
        "Conversacion no encontrada o fuera de los permisos actuales.",
        "FORBIDDEN",
      );
    return result[0];
  }
  if (route === "conversations") {
    const data = await source.select(
      `copilot_conversations?select=id,title,updated_at&user_id=eq.${actor.id}&metadata->>engine=eq.central&metadata->>role=eq.${actor.role}&status=eq.active&order=updated_at.desc&limit=100`,
    );
    return json({ conversations: data });
  }
  if (route === "history") {
    const id = url.searchParams.get("conversationId") || "";
    await conversation(id);
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      return json({ error: "Pagina invalida." }, 400);
    const data = await source.select(
      `copilot_messages?select=id,role,content,metadata,created_at&user_id=eq.${actor.id}&conversation_id=eq.${id}&role=in.(user,assistant)&order=created_at.desc,id.desc&limit=51&offset=${offset}`,
    );
    return json({
      messages: data.slice(0, 50).reverse(),
      nextOffset: data.length > 50 ? offset + 50 : null,
    });
  }
  if (route === "export") {
    const id = url.searchParams.get("conversationId") || "",
      messageId = url.searchParams.get("messageId") || "";
    await conversation(id);
    if (!uuid(messageId)) return json({ error: "Respuesta invalida." }, 400);
    const data = await source.select(
      `copilot_messages?select=id,role,content,metadata,created_at&user_id=eq.${actor.id}&conversation_id=eq.${id}&id=eq.${messageId}&role=eq.assistant&limit=1`,
    );
    if (!data.length)
      return json(
        { error: "No se encontro una respuesta autorizada para exportar." },
        404,
      );
    return json({ message: data[0] });
  }
  if (Number(req.headers.get("content-length") || 0) > 32768)
    return json({ error: "Solicitud demasiado grande." }, 413);
  const rawPayload = await req.text();
  if (rawPayload.length > 32768)
    return json({ error: "Solicitud demasiado grande." }, 413);
  let payload: Row;
  try {
    payload = object(JSON.parse(rawPayload));
  } catch {
    return json({ error: "Solicitud JSON invalida." }, 400);
  }
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message || message.length > 6000)
    return json(
      { error: "Escribe una consulta de hasta 6000 caracteres." },
      400,
    );
  const apiKey = Deno.env.get("OPENAI_API_KEY") || "";
  if (!apiKey)
    return json({ error: "Falta configurar OpenAI en el servidor." }, 503);
  try { await source.select("copilot_messages?select=metadata&limit=0"); }
  catch { return json({ error: "No se pudo validar el respaldo del Copiloto. Revisa la migracion copilot_central.sql y la conexion del servidor." }, 503); }
  let current: Row;
  if (payload.conversationId)
    current = await conversation(String(payload.conversationId));
  else
    current = rows(
      await source.request("rest/v1/copilot_conversations", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: actor.id,
          title: message.slice(0, 90),
          metadata: { engine: "central", role: actor.role },
        }),
      }),
    )[0];
  const id = String(current.id);
  const history = await source.select(
    `copilot_messages?select=role,content&user_id=eq.${actor.id}&conversation_id=eq.${id}&role=in.(user,assistant)&order=created_at.desc,id.desc&limit=16`,
  );
  const userMessage = rows(
    await source.request("rest/v1/copilot_messages", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        conversation_id: id,
        user_id: actor.id,
        role: "user",
        content: message,
        prompt_version: centralPromptVersion,
      }),
    }),
  )[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 150000);
  async function run(emit: (event: Row) => void) {
    emit({ type: "conversation", conversationId: id });
    const start = Date.now();
    try {
      const output = await runOrchestrator({
        registry: new ToolRegistry(
          new CopilotSources(config, actor, controller.signal),
        ),
        model:
          Deno.env.get("OPENAI_COPILOT_MODEL") ||
          Deno.env.get("OPENAI_TEXT_MODEL") ||
          "gpt-4.1-mini",
        apiKey,
        message,
        history: history.reverse(),
        signal: controller.signal,
        progress: (event) => emit({ ...event }),
        onTrace: async (trace) => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(trace.result)),
          );
          const resultHash = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          await source.request("rest/v1/copilot_tool_runs", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              conversation_id: id,
              message_id: userMessage.id,
              user_id: actor.id,
              trace_id: traceId,
              tool_name: trace.toolName,
              arguments_redacted: {
                ...trace.argumentsRedacted,
                call_id: trace.callId,
                version: 1,
                started_at: trace.startedAt,
                result_hash: resultHash,
                result_status: trace.status,
              },
              ok: ["ok", "empty", "partial"].includes(trace.status),
              human_summary: trace.result.summary,
              evidence: trace.result.evidence,
              warnings: trace.result.warnings,
              risk_level: "read",
              requires_confirmation: false,
              error_code: ["unavailable", "forbidden"].includes(trace.status)
                ? trace.status
                : null,
              latency_ms: trace.durationMs,
            }),
          });
        },
      });
      const metadata = {
        engine: "central",
        traceId,
        role: actor.role,
        results: output.results,
        tools: output.traces.map((t) => ({
          name: t.toolName,
          status: t.status,
          durationMs: t.durationMs,
        })),
      };
      const stored = rows(
        await source.request("rest/v1/copilot_messages", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            conversation_id: id,
            user_id: actor.id,
            role: "assistant",
            content: output.message,
            model: output.model,
            prompt_version: centralPromptVersion,
            tokens_input: output.tokensInput,
            tokens_output: output.tokensOutput,
            latency_ms: Date.now() - start,
            metadata,
          }),
        }),
      )[0];
      await source.request(
        `rest/v1/copilot_conversations?id=eq.${id}&user_id=eq.${actor.id}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ updated_at: new Date().toISOString() }),
        },
      );
      await source.request("rest/v1/copilot_audit_events", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: actor.id,
          conversation_id: id,
          request_id: traceId,
          trace_id: traceId,
          event_type: "central_read_turn",
          model: output.model,
          prompt_version: centralPromptVersion,
          permission_decision: "role_scoped_read",
          result: "ok",
          risk_level: "read",
          affected_count: 0,
          latency_ms: Date.now() - start,
          tokens_input: output.tokensInput,
          tokens_output: output.tokensOutput,
          metadata_redacted: { tools: output.traces.length },
        }),
      });
      const response = {
        conversationId: id,
        messageId: stored.id,
        message: output.message,
        model: output.model,
        traceId,
        results: output.results,
        tools: output.traces.map((t) => ({
          ok: ["ok", "empty", "partial"].includes(t.status),
          humanSummary: t.result.summary,
          evidence: t.result.evidence,
          warnings: t.result.warnings,
        })),
        campaignDraft: null,
        reportSnapshot: null,
      };
      emit({ type: "complete", ...response });
      return response;
    } finally {
      clearTimeout(timeout);
      req.signal.removeEventListener("abort", abort);
    }
  }
  if (!req.headers.get("accept")?.includes("application/x-ndjson"))
    return json(await run(() => {}));
  const encoder = new TextEncoder();
  let open = true;
  return new Response(
    new ReadableStream({
      start(stream) {
        const emit = (event: Row) => {
          if (open)
            stream.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        run(emit)
          .catch((error) => {
            console.error("[copilot-central] turn failed", {
              traceId,
              aborted: controller.signal.aborted,
              code:
                error instanceof CopilotDataError ? error.code : "TURN_FAILED",
            });
            emit({
              type: "error",
              error: controller.signal.aborted
                ? "La consulta se interrumpio o supero el tiempo disponible. Puedes acotarla y volver a consultar."
                : errorText(error),
              traceId,
            });
          })
          .finally(() => {
            if (open) {
              open = false;
              stream.close();
            }
          });
      },
      cancel() {
        open = false;
        controller.abort();
      },
    }),
    {
      headers: {
        ...cors,
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
