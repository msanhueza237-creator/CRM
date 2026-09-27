import type { ModelPolicy } from "../_shared/openai-cost-policy.ts";
import { limitedJson } from "../prospecting-integrations/deepseek.ts";
import { CopilotDataError, object, rows, type Row } from "./contracts.ts";
import type { ModelUsage } from "./model-router.ts";
import type { ModelEngine } from "./model-selection.ts";

// Stateless Responses keeps the existing tool loop, specialist registry and permissions.
export class DeepSeekRouter implements ModelEngine {
  readonly policy: ModelPolicy;
  readonly notices = new Set<string>();
  readonly usage: ModelUsage[] = [];
  readonly manualSol = false;
  stopped: CopilotDataError | null = null;
  private calls = 0;
  constructor(policy: ModelPolicy, private model: string, private apiKey: string, private rates: Row,
    private audit: (data: Row) => Promise<void>, private fetcher: typeof fetch = fetch) {
    this.policy = { ...policy, defaultModel: model, mode: "luna_only", autoEscalation: false };
  }
  async call(body: Row, agent: string, signal: AbortSignal): Promise<Row> {
    if (this.stopped) throw this.stopped;
    if (signal.aborted) throw new DOMException("Cancelado", "AbortError");
    if (this.calls >= this.policy.maxRequestCalls) throw new CopilotDataError("La consulta alcanzo el limite de llamadas. Acota la pregunta.", "AI_REQUEST_LIMIT");
    const request = { model: this.model, instructions: body.instructions, input: body.input,
      tools: rows(body.tools).map(({ strict: _strict, ...tool }) => tool), tool_choice: body.tool_choice,
      max_output_tokens: Math.min(Number(body.max_output_tokens) || this.policy.outputTokens, this.policy.outputTokens),
      ...(body.text ? { text: body.text } : {}),
      // Mandatory evidence tools require non-thinking mode. Keep it for the entire
      // tool loop: switching mid-turn requires reasoning history that was not generated.
      reasoning: { effort: "none" },
    };
    if (new TextEncoder().encode(JSON.stringify(request)).length > this.policy.inputMaxBytes) {
      throw new CopilotDataError("El contexto supera el limite configurado. Acota el periodo o el detalle.", "AI_CONTEXT_LIMIT");
    }
    this.calls++;
    const callId = crypto.randomUUID(), start = Date.now();
    await this.record({ callId, agent, status: "started" });
    try {
      const response = await this.fetcher("https://api.deepseek.com/responses", { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 402 ? "DEEPSEEK_BALANCE_REQUIRED" : [401, 403].includes(response.status) ? "DEEPSEEK_KEY_REJECTED" : response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_ERROR";
        throw new CopilotDataError(response.status === 402 ? "DeepSeek informa saldo insuficiente." : response.status === 429 ? "DeepSeek limito temporalmente las solicitudes. Espera antes de reintentar." : "DeepSeek no pudo completar la consulta. Revisa la conexion; no se cambio de proveedor.", code);
      }
      const payload = object(await limitedJson(response, 2097152));
      if (!["completed", "incomplete"].includes(String(payload.status)) || !Array.isArray(payload.output) || payload.error) {
        throw new CopilotDataError("DeepSeek no entrego una respuesta valida. No se repetira la llamada automaticamente.", "AI_PROVIDER_ERROR");
      }
      const usage = object(payload.usage), input = usage.input_tokens, output = usage.output_tokens;
      const known = typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0;
      const priced = known && typeof this.rates.input === "number" && typeof this.rates.output === "number";
      const estimatedCost = priced ? (Number(input) * Number(this.rates.input) + Number(output) * Number(this.rates.output)) / 1000000 : null;
      const tracked: ModelUsage = { model: this.model, tokensInput: known ? Number(input) : 0, tokensOutput: known ? Number(output) : 0,
        reasoningTokens: Number(object(usage.output_tokens_details).reasoning_tokens || 0), modelMs: Date.now() - start, estimatedCost: estimatedCost ?? 0, cached: false };
      this.usage.push(tracked);
      await this.record({ callId, agent, status: "ok", ...tracked, estimatedCost, costKnown: priced, usageKnown: known,
        toolCalls: rows(payload.output).filter(r => r.type === "function_call").length, costBasis: "configured_peak_rates_without_cache_discount" });
      if (!priced) this.notices.add("El costo de esta consulta no pudo estimarse; revisa el consumo en DeepSeek.");
      return { ...payload, model: this.model, router_usage: tracked, cost_known: priced };
    } catch (error) {
      const safe = error instanceof CopilotDataError ? error : new CopilotDataError(signal.aborted ? "Consulta cancelada." : "No se pudo conectar con DeepSeek. No se reintento ni cambio de proveedor.", signal.aborted ? "AI_CANCELLED" : "AI_NETWORK_ERROR");
      if (["DEEPSEEK_BALANCE_REQUIRED", "DEEPSEEK_KEY_REJECTED", "AI_AUDIT_UNAVAILABLE"].includes(safe.code)) this.stopped = safe;
      await this.record({ callId, agent, status: "error", errorCode: safe.code, modelMs: Date.now() - start, estimatedCost: null, usageKnown: false });
      throw safe;
    }
  }
  async escalate() { return null; }
  private async record(data: Row) {
    try { await this.audit(data); }
    catch {
      this.stopped = new CopilotDataError("No se pudo guardar la trazabilidad del modelo. Nuevas llamadas suspendidas.", "AI_AUDIT_UNAVAILABLE");
      throw this.stopped;
    }
  }
}
