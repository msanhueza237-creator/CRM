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
import { centralPromptVersion, runOrchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { runAgentManager, type AgentRun } from "./agent-manager.ts";
import { agentObservability } from "./agent-observability.ts";
import { permittedDomains } from "./permissions.ts";
import { copilotConfig, reasoningFor } from "./config.ts";
import { redactSecrets, safeData, sessionExpires } from "./safety.ts";
import { createConversation, ownedConversation } from "./sessions.ts";
import { liveHandler, liveRoutes, ownedVoice, stableVoiceId } from "./live.ts";
import { chooseModel, modelCatalog, selectedModelRouter } from "./model-selection.ts";
import { ModelCostStore } from "./model-cost-store.ts";
import { readCustomerClassification, applyCustomerClassification } from "./company-evidence.ts";

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
  const settings = copilotConfig(name => typeof Deno !== "undefined" ? Deno.env.get(name) : undefined);
  const url = new URL(req.url),
    route = url.pathname.split("/").at(-1),
    source = new CopilotSources(config, actor, req.signal, fetch, settings.sourceTimeoutMs);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(safeData(data)), {
      status,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  if (route === "models") return json(await modelCatalog(source, settings));
  if (route === "company-insights") {
    if (req.method !== "GET") return json({ error: "Metodo no permitido." }, 405);
    const args: Row = { company_id: url.searchParams.get("companyId"), period: "custom", from: url.searchParams.get("from"), to: url.searchParams.get("to") };
    const registry = new ToolRegistry(source);
    const [profile, profitability, products] = await Promise.all([
      registry.execute("get_customer_profile", { company_id: args.company_id }),
      registry.execute("get_customer_profitability", { ...args, sort_by: "sales", limit: 1 }),
      registry.execute("get_customer_products", { ...args, currency: url.searchParams.get("currency") || "CLP", metric: url.searchParams.get("metric") || "units", limit: 10, offset: Number(url.searchParams.get("offset") || 0) }),
    ]);
    return json({ profile, profitability, products, traceId });
  }
  if (route === "customer-classification") {
    if (actor.role !== "administrador") return json({ error: "Solo administracion puede revisar y aplicar esta clasificacion." }, 403);
    if (req.method === "GET") return json(await readCustomerClassification(source));
    if (req.method !== "POST") return json({ error: "Metodo no permitido." }, 405);
    const raw = await req.text();
    if (raw.length > 2048) return json({ error: "Solicitud demasiado grande." }, 413);
    let body: Row;
    try { body = object(JSON.parse(raw)); } catch { return json({ error: "Solicitud invalida." }, 400); }
    if (body.confirmed !== true || !/^[a-f0-9]{64}$/.test(String(body.fingerprint))) return json({ error: "Revisa y confirma el lote de clientes facturados." }, 400);
    return json(await applyCustomerClassification(source, body.fingerprint, traceId, body.includeNew === true));
  }
  if (route === "agent-observability") {
    if (actor.role !== "administrador") return json({ error: "Solo administracion puede consultar este registro." }, 403);
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > 2048) return json({ error: "Solicitud demasiado grande." }, 413);
      let body: Row;
      try { body = object(JSON.parse(raw)); } catch { return json({ error: "Solicitud invalida." }, 400); }
      if (body.confirmed !== true || !["luna_only", "auto", "sol_manual", "resume_after_quota"].includes(String(body.mode)) || !Number.isInteger(body.hours) || Number(body.hours) < 1 || Number(body.hours) > 24)
        return json({ error: "Confirma un modo valido y su duracion entre 1 y 24 horas." }, 400);
      await new ModelCostStore(config).setMode(String(body.mode), actor.id, Number(body.hours));
      await source.request("rest/v1/copilot_audit_events", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: actor.id, trace_id: traceId, request_id: traceId, event_type: "model_cost_policy_changed", result: "ok", risk_level: "low", affected_count: 0, metadata_redacted: { mode: body.mode, hours: body.hours, confirmed: true } }) });
    }
    return json(await agentObservability(source, settings));
  }
  if (route === "inventory") {
    if (req.method !== "GET") return json({ error: "Metodo no permitido." }, 405);
    const args: Row = {};
    for (const [key, value] of url.searchParams) args[key] = ["offset", "limit", "threshold"].includes(key) ? Number(value) : value;
    const result = await new ToolRegistry(source).execute("get_inventory_valuation", args);
    return json(result, result.status === "forbidden" ? 403 : result.status === "unavailable" ? 503 : result.status === "needs_clarification" ? 400 : 200);
  }
  async function conversation(id: string) {
    return ownedConversation(source, id);
  }
  if (liveRoutes.includes(route || "")) return liveHandler(req, source, settings, traceId, cors);
  if (route === "conversations") {
    const data = await source.select(
      `copilot_conversations?select=id,title,updated_at&user_id=eq.${actor.id}&metadata->>engine=eq.central&metadata->>role=eq.${actor.role}&status=eq.active&order=updated_at.desc&limit=100`,
    );
    return json({ conversations: data });
  }
  if (route === "history") {
    const id = url.searchParams.get("conversationId") || "";
    const current = await conversation(id);
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      return json({ error: "Pagina invalida." }, 400);
    const data = await source.select(
      `copilot_messages?select=id,role,content,metadata,created_at&user_id=eq.${actor.id}&conversation_id=eq.${id}&role=in.(user,assistant)&order=created_at.desc,id.desc&limit=51&offset=${offset}`,
    );
    return json({
      modelChoice: object(current.metadata).modelChoice || null,
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
  const apiKey = settings.apiKey;
  try { await source.select("copilot_messages?select=metadata&limit=0"); }
  catch { return json({ error: "No se pudo validar el respaldo del Copiloto. Revisa la migracion copilot_central.sql y la conexion del servidor." }, 503); }
  let current: Row = {};
  if (payload.conversationId) {
    current = await conversation(String(payload.conversationId));
    if (Date.parse(sessionExpires(object(current.metadata), current.created_at, settings.sessionDays)) <= Date.now())
      return json({ error: "Esta sesion termino su periodo de contexto. Conservas el historial; inicia una nueva conversacion." }, 409);
  }
  const choice = chooseModel(await modelCatalog(source, settings), payload.modelChoice, object(current.metadata).modelChoice);
  if (!payload.conversationId) current = await createConversation(source, message, settings.sessionDays);
  const id = String(current.id);
  const channel = payload.channel === "voice" ? "voice" : "text";
  let voiceMessageId: string | undefined;
  if (channel === "voice") {
    await ownedVoice(source, payload.voiceSessionId, id);
    if (typeof payload.delegationId !== "string" || !/^[\w-]{1,200}$/.test(payload.delegationId)) return json({error:"Delegacion invalida."},400);
    const cancelled = await source.select(`copilot_audit_events?select=id&id=eq.${await stableVoiceId(`${payload.voiceSessionId}:${payload.delegationId}:cancel`)}&user_id=eq.${actor.id}&limit=1`);
    if (cancelled.length) return json({error:"Esta consulta de voz fue cancelada."},409);
    voiceMessageId = await stableVoiceId(`${payload.voiceSessionId}:${payload.delegationId}:question`);
    const prior = await source.select(`copilot_messages?select=id&id=eq.${voiceMessageId}&user_id=eq.${actor.id}&limit=1`);
    if (prior.length) return json({error:"Esta consulta de voz ya fue recibida. Revisa el historial; no se repetira automaticamente."},409);
  }
  const effort = reasoningFor(message, settings.reasoningEffort);
  const history = await source.select(
    `copilot_messages?select=role,content&user_id=eq.${actor.id}&conversation_id=eq.${id}&role=in.(user,assistant)&order=created_at.desc,id.desc&limit=${settings.historyMessages}`,
  );
  const userMessage = rows(
    await source.request("rest/v1/copilot_messages", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        ...(voiceMessageId ? { id: voiceMessageId } : {}),
        conversation_id: id,
        user_id: actor.id,
        role: "user",
        content: redactSecrets(message),
        prompt_version: centralPromptVersion,
      }),
    }),
  )[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) abort();
  const timeout = setTimeout(abort, settings.agentManagerEnabled ? settings.managerTimeoutMs : settings.timeoutMs);
  async function run(emit: (event: Row) => void) {
    emit({ type: "conversation", conversationId: id, userMessageId: userMessage.id, modelChoice: choice.id });
    const start = Date.now();
    const readSource = new CopilotSources(config, actor, controller.signal, fetch, settings.sourceTimeoutMs);
    try {
      const modelRouter = await selectedModelRouter(readSource, settings, choice, { requestId: traceId, conversationId: id, userId: actor.id, role: actor.role, message });
      const options: OrchestratorOptions = {
        modelRouter,
        registry: new ToolRegistry(readSource),
        model: choice.model,
        reasoningEffort: effort,
        maxOutputTokens: settings.maxOutputTokens,
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
                agent: trace.agent || "executive",
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
      };
      const output = settings.agentManagerEnabled ? await runAgentManager({
        ...options,
        context: { userId: actor.id, companyId: await readSource.entity().catch(() => null), sessionId: id, requestId: traceId, timestamp: new Date().toISOString(), role: actor.role, permissions: permittedDomains(actor.role), intent: String(userMessage.id) },
        specialistTimeoutMs: settings.specialistTimeoutMs,
        authorizeSpecialist: async agent => {
          if (agent !== "foreign_trade") return true;
          const permissions = await readSource.select("foreign_trade_agent_permissions?select=allowed&agent_type=eq.foreign_trade&permission=eq.foreign_trade.read&limit=1");
          return permissions[0]?.allowed === true;
        },
        onAgentRun: async run => {
          await source.request("rest/v1/copilot_audit_events", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
            user_id: actor.id, conversation_id: id, request_id: traceId, trace_id: traceId,
            event_type: "agent_read_run", channel, model: run.models?.join(",") || choice.model, prompt_version: centralPromptVersion,
            permission_decision: "role_scoped_read", result: run.status, risk_level: "read", affected_count: 0,
            latency_ms: run.durationMs, tokens_input: run.tokensInput, tokens_output: run.tokensOutput, metadata_redacted: run,
          }) });
        },
      }) : { ...await runOrchestrator(options), agentRuns: [] as AgentRun[], agentContext: null };
      const metadata = {
        engine: "central",
        modelChoice: choice.id,
        provider: choice.provider,
        model: output.model,
        inReplyTo: userMessage.id,
        traceId,
        role: actor.role,
        channel,
        ...(channel === "voice" ? {voiceSessionId:payload.voiceSessionId,delegationId:payload.delegationId} : {}),
        reasoningEffort: effort,
        agents: output.agentRuns,
        agentContext: output.agentContext,
        timings: { ...readSource.metrics, modelMs: output.modelMs, totalMs: Date.now() - start },
        results: output.results,
        tools: output.traces.map((t) => ({
          name: t.toolName,
          status: t.status,
          durationMs: t.durationMs,
          agent: t.agent,
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
            content: redactSecrets(output.message),
            model: output.model,
            prompt_version: centralPromptVersion,
            tokens_input: output.tokensInput,
            tokens_output: output.tokensOutput,
            latency_ms: Date.now() - start,
            metadata: safeData(metadata),
          }),
        }),
      )[0];
      await source.request(
        `rest/v1/copilot_conversations?id=eq.${id}&user_id=eq.${actor.id}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ updated_at: new Date().toISOString(), metadata: { ...object(current.metadata), modelChoice: choice.id } }),
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
          channel,
          model: output.model,
          prompt_version: centralPromptVersion,
          permission_decision: "role_scoped_read",
          result: "ok",
          risk_level: "read",
          affected_count: 0,
          latency_ms: Date.now() - start,
          tokens_input: output.tokensInput,
          tokens_output: output.tokensOutput,
          metadata_redacted: { tools: output.traces.length, timings: metadata.timings, questionMessageId: userMessage.id, reasoningEffort: effort, modelCalls: output.modelCalls, provider: choice.provider, modelChoice: choice.id },
        }),
      });
      const response = {
        conversationId: id,
        messageId: stored.id,
        message: redactSecrets(output.message),
        model: output.model,
        modelChoice: choice.id,
        provider: choice.provider,
        traceId,
        timings: metadata.timings,
        agents: output.agentRuns,
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
    } catch (error) {
      await source.request("rest/v1/copilot_audit_events", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: actor.id, conversation_id: id, request_id: traceId, trace_id: traceId,
          event_type: "central_read_error", channel, model: choice.model, prompt_version: centralPromptVersion,
          permission_decision: "role_scoped_read", result: "error", risk_level: "read", affected_count: 0,
          latency_ms: Date.now() - start, metadata_redacted: { questionMessageId: userMessage.id, code: error instanceof CopilotDataError ? error.code : controller.signal.aborted ? "ABORTED" : "TURN_FAILED", timings: readSource.metrics } }),
      }).catch(() => console.error("[copilot-central] audit unavailable", { traceId }));
      throw error;
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
        const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10000);
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
            clearInterval(heartbeat);
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
